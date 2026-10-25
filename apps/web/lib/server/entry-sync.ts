import type { PoolClient } from "pg";
import type { Entry, SyncRow, SyncChange, PushOutcome } from "../types.ts";

const MAX_ENTRY_CHARS = 500_000;
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;
const isStamp = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isStampOrNull = (v: unknown): v is number | null => v === null || v === undefined || isStamp(v);
const asText = (v: unknown, max: number): string | null => typeof v === "string" && v.length <= max ? v : null;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => v === null ? null : Number(v);
export const ENTRY_COLS = "id, content, created_at, updated_at, deleted_at, seq, hash";

export function asEntry(v: unknown): Entry | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  const content = asText(e.content, MAX_ENTRY_CHARS);
  if (
    !isId(e.id) ||
    content === null ||
    !isStamp(e.createdAt) ||
    !isStamp(e.updatedAt) ||
    !isStampOrNull(e.deletedAt)
  ) {
    return null;
  }
  return {
    id: e.id,
    content,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    deletedAt: (e.deletedAt as number | null | undefined) ?? null,
  };
}


interface EntryRowShape {
  id: string;
  content: string;
  created_at: unknown;
  updated_at: unknown;
  deleted_at: unknown;
  seq: unknown;
  hash: string;
}

export function entryRow(r: EntryRowShape): SyncRow<Entry> {
  return {
    record: {
      id: r.id,
      content: r.content,
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
      deletedAt: numOrNull(r.deleted_at),
    },
    rev: num(r.seq),
    hash: r.hash,
  };
}


export async function pushEntry(
  client: PoolClient,
  uid: string,
  change: SyncChange<Entry>
): Promise<PushOutcome<Entry>> {
  const e = change.record;

  const inserted = await client.query(
    `insert into entries (id, user_id, content, created_at, updated_at, deleted_at, hash)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do nothing
     returning seq`,
    [e.id, uid, e.content, e.createdAt, e.updatedAt, e.deletedAt, change.hash]
  );
  if (inserted.rowCount) {
    return { id: e.id, status: "ok", rev: num(inserted.rows[0].seq), hash: change.hash };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const { rows } = await client.query(
      `select ${ENTRY_COLS} from entries where id = $1 and user_id = $2`,
      [e.id, uid]
    );
    if (!rows.length) {
      // Same id under another account — cryptographically negligible; report
      // the client's own state so it stops retrying, write nothing.
      return { id: e.id, status: "ok", rev: change.baseRev, hash: change.hash };
    }
    const current = rows[0] as EntryRowShape;
    if (current.hash === change.hash) {
      return { id: e.id, status: "ok", rev: num(current.seq), hash: current.hash };
    }
    if (num(current.seq) === change.baseRev || current.hash === "") {
      const updated = await client.query(
        `update entries set content = $3, updated_at = $4, deleted_at = $5,
           hash = $6, seq = nextval('sync_seq')
         where id = $1 and user_id = $2 and seq = $7
         returning seq`,
        [e.id, uid, e.content, e.updatedAt, e.deletedAt, change.hash, current.seq]
      );
      if (updated.rowCount) {
        return { id: e.id, status: "ok", rev: num(updated.rows[0].seq), hash: change.hash };
      }
      continue; // raced with another device — re-read and re-decide once
    }
    return { id: e.id, status: "conflict", server: entryRow(current) };
  }

  const { rows } = await client.query(
    `select ${ENTRY_COLS} from entries where id = $1 and user_id = $2`,
    [e.id, uid]
  );
  return { id: e.id, status: "conflict", server: entryRow(rows[0] as EntryRowShape) };
}

