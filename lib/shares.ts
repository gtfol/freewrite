// Management capabilities stay in this browser. Public links contain only the
// id. Clearing browser data loses ownership, so permanent links need an explicit
// Delete link action and storage failures must never be silently ignored.

export interface ShareRecord {
  id: string;
  token: string;
  sharedAt: number;
  expiresAt: number | null;
  entryUpdatedAt: number;
}

const STORAGE_KEY = "freewrite:shares";
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/;
const pending = new Map<string, ShareRecord>();
const mutations = new Map<string, Promise<void>>();

export function beginEntryShareMutation(entryId: string): () => void {
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => { finish = resolve; });
  mutations.set(entryId, completion);
  return () => {
    if (mutations.get(entryId) === completion) mutations.delete(entryId);
    finish();
  };
}

function validRecord(value: unknown): value is ShareRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as ShareRecord;
  return CAPABILITY.test(record.id) && CAPABILITY.test(record.token)
    && Number.isFinite(record.sharedAt) && Number.isFinite(record.entryUpdatedAt)
    && (record.expiresAt === null || (typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)));
}

function readAll(strict = false): Record<string, ShareRecord> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    if (strict && !Object.values(parsed).every(validRecord)) throw new Error();
    return Object.fromEntries(Object.entries(parsed).filter(([, record]) => validRecord(record)));
  } catch {
    if (strict) throw new Error("This browser couldn't read your share links. Try again before changing them.");
    return {};
  }
}

function writeAll(records: Record<string, ShareRecord>): void {
  try {
    const value = JSON.stringify(records);
    localStorage.setItem(STORAGE_KEY, value);
    if (localStorage.getItem(STORAGE_KEY) !== value) throw new Error();
  } catch {
    throw new Error("This browser couldn't save the link controls. Keep this tab open and retry saving, or delete the link.");
  }
}

export function assertShareStorage(): void {
  try {
    writeAll(readAll(true));
  } catch {
    throw new Error("This browser couldn't store link controls. Allow browser storage before creating a share link.");
  }
}

export function hasPendingShareRecords(): boolean {
  return pending.size > 0;
}

export function getShareRecord(entryId: string, strict = false): ShareRecord | null {
  const record = pending.get(entryId) ?? readAll(strict)[entryId];
  if (!record || (record.expiresAt !== null && record.expiresAt <= Date.now())) return null;
  return record;
}

export function shareRecordIsSaved(entryId: string): boolean {
  return !pending.has(entryId);
}

export function setShareRecord(entryId: string, record: ShareRecord): void {
  if (!validRecord(record)) throw new Error("The share link couldn't be read. Try again.");
  // Keep the capability available for retry / revoke even if durable storage
  // fails after the server has already created or changed the link.
  pending.set(entryId, record);
  writeAll({ ...readAll(true), ...Object.fromEntries(pending) });
  pending.clear();
}

export function clearShareRecord(entryId: string): void {
  const records = readAll(true);
  delete records[entryId];
  writeAll(records);
  pending.delete(entryId);
}

export function shareUrl(id: string): string {
  return `${window.location.origin}/share/${id}`;
}

export function expiresLabel(expiresAt: number | null): string {
  if (expiresAt === null) return "Never";
  const days = Math.max(1, Math.ceil((expiresAt - Date.now()) / 86_400_000));
  return days === 1 ? "1 day" : `${days} days`;
}

export async function revokeEntryShare(entryId: string): Promise<void> {
  // A user can open History while publication is still in flight. Wait for
  // its token to be saved before revoking / removing the underlying entry.
  await mutations.get(entryId);
  const share = getShareRecord(entryId, true);
  if (!share) return;
  let response: Response;
  try {
    response = await fetch(`/api/share/entry/${share.id}`, {
      method: "DELETE",
      headers: { "x-share-token": share.token },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Couldn't delete the share link. Check your connection and try again.");
  }
  if (!response.ok && response.status !== 410) {
    throw new Error("Couldn't delete the share link. Try again before deleting this entry.");
  }
  clearShareRecord(entryId);
}
