// Which entries this browser has published, and the secrets that manage
// them. Kept in localStorage — like everything else, share ownership never
// leaves your machine; losing the record just means the link expires on
// its own instead of being deletable.

export interface ShareRecord {
  id: string;
  token: string;
  sharedAt: number;
  expiresAt: number;
  // entry.updatedAt captured when the snapshot was pushed — a newer value
  // on the entry means the public page is stale.
  entryUpdatedAt: number;
}

const STORAGE_KEY = "freewrite:shares";

function readAll(): Record<string, ShareRecord> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, ShareRecord>)
      : {};
  } catch {
    return {};
  }
}

function writeAll(records: Record<string, ShareRecord>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Storage full or unavailable — the link still works, it just can't be
    // managed from this browser later.
  }
}

// A pure read — callers may use it during render, so an expired record is
// just reported as absent, not deleted; it gets overwritten on the next
// share anyway.
export function getShareRecord(entryId: string): ShareRecord | null {
  const record = readAll()[entryId];
  if (!record || record.expiresAt <= Date.now()) return null;
  return record;
}

export function setShareRecord(entryId: string, record: ShareRecord): void {
  const records = readAll();
  records[entryId] = record;
  writeAll(records);
}

export function clearShareRecord(entryId: string): void {
  const records = readAll();
  if (!(entryId in records)) return;
  delete records[entryId];
  writeAll(records);
}

export function shareUrl(id: string): string {
  return `${window.location.origin}/share/${id}`;
}

export function expiresLabel(expiresAt: number): string {
  const days = Math.max(1, Math.round((expiresAt - Date.now()) / 86_400_000));
  return days === 1 ? "1 day" : `${days} days`;
}
