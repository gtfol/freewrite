import { entryShareTtlSeconds, type EntryShareExpiry } from "./share-expiry.ts";

// Management capabilities stay in this browser. Public links contain only the
// id. Clearing browser data loses ownership, so permanent links need an explicit
// Delete link action and storage failures must never be silently ignored.

export interface ShareRecord {
  id: string;
  token: string;
  sharedAt: number;
  expiresAt: number | null;
  entryUpdatedAt: number;
  pendingCreate?: boolean;
  requestedExpiry?: EntryShareExpiry;
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

export async function withShareLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof window === "undefined") return operation();
  if (!navigator.locks) throw new Error("Your browser can't safely manage share links. Update it and try again.");
  return navigator.locks.request(STORAGE_KEY, operation);
}

export function prepareShareRecord(entryId: string, entryUpdatedAt: number, expiry: EntryShareExpiry): ShareRecord {
  const existing = getShareRecord(entryId, true);
  if (existing) return existing;
  const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const ttl = entryShareTtlSeconds(expiry);
  const record: ShareRecord = {
    id: random(), token: random(), sharedAt: Date.now(),
    expiresAt: ttl === null ? null : Date.now() + ttl * 1000,
    entryUpdatedAt, pendingCreate: true, requestedExpiry: expiry,
  };
  setShareRecord(entryId, record);
  return record;
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
  // Cached dates may be stale after a lost expiry-change response. Only the
  // server can confirm that a link is gone; never discard its token by date.
  return record ?? null;
}

export function canDiscardUnsharedEntry(entryId: string): boolean {
  try { return getShareRecord(entryId, true) === null; }
  catch { return false; }
}

export function shareRecordIsSaved(entryId: string): boolean {
  return !pending.has(entryId);
}

export function setShareRecord(entryId: string, record: ShareRecord): void {
  if (!validRecord(record)) throw new Error("The share link couldn't be read. Try again.");
  const records = readAll(true);
  const existing = records[entryId];
  if (existing && (existing.id !== record.id || existing.token !== record.token)) throw new Error("This entry already has a share link. Check its controls before creating another.");
  // Keep the capability available for retry / revoke even if durable storage
  // fails after the server has already created or changed the link.
  pending.set(entryId, record);
  writeAll({ ...records, [entryId]: record });
  pending.delete(entryId);
}

export function clearShareRecord(entryId: string, expectedId?: string): void {
  const records = readAll(true);
  if (expectedId && records[entryId] && records[entryId].id !== expectedId) {
    // An unpublished local reservation can lose a race to another tab after
    // storage failed. Retire only that reservation, keeping the durable link.
    if (pending.get(entryId)?.id === expectedId) pending.delete(entryId);
    return;
  }
  if (expectedId && pending.has(entryId) && pending.get(entryId)!.id !== expectedId) return;
  delete records[entryId];
  writeAll(records);
  pending.delete(entryId);
}

export function shareUrl(id: string): string {
  return `${window.location.origin}/share/${id}`;
}

export function expiresLabel(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return "Never";
  if (expiresAt <= now) return "Expired";
  const days = Math.max(1, Math.ceil((expiresAt - now) / 86_400_000));
  return days === 1 ? "1 day" : `${days} days`;
}

async function revokeEntryShareUnlocked(entryId: string, expectedId?: string): Promise<void> {
  const share = getShareRecord(entryId, true);
  if (!share) return;
  if (expectedId && share.id !== expectedId) throw new Error("This entry's share link changed. Check its controls and try again.");
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
  clearShareRecord(entryId, share.id);
}

export async function revokeEntryShare(entryId: string, expectedId?: string): Promise<void> {
  await mutations.get(entryId);
  return withShareLock(() => revokeEntryShareUnlocked(entryId, expectedId));
}

export async function deleteSharedEntry(entryId: string, deleteLocal: () => Promise<void>): Promise<void> {
  await mutations.get(entryId);
  return withShareLock(async () => {
    await revokeEntryShareUnlocked(entryId);
    // Publication checks durable entry existence under this same lock, so no
    // other tab can insert a new link between revocation and local deletion.
    await deleteLocal();
  });
}

/** Revoke under the publication lock; keep controls on any failure. */
export async function revokeAllSharesAnd<T>(operation: () => Promise<T>): Promise<T> {
  await Promise.all([...mutations.values()]);
  return withShareLock(async () => {
    for (const [entryId, share] of Object.entries(readAll(true))) {
      await revokeEntryShareUnlocked(entryId, share.id);
    }
    return operation();
  });
}
