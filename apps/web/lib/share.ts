import { createHash, randomBytes } from "crypto";

import { ALL_FONTS, DEFAULT_FONT_ID, DEFAULT_FONT_SIZE } from "./fonts.ts";
import { dbConfigured, getPool } from "./server/db.ts";
import { parseSketches } from "./sketch.ts";
import type { Sketch } from "./types.ts";
import { entryShareTtlSeconds, type EntryShareExpiry } from "./share-expiry.ts";

// Share links live in the app's Postgres database (db/migrations/0007). Two
// kinds: the reader's temporary chat snapshots and published entries. A
// 128-bit random id is the capability to read either one. Lapsed rows stop
// being served the moment they expire; /api/cron/shares removes their content.
// Without DATABASE_URL the feature reports itself disabled and the reader's
// chat flow falls back to link-out.

const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_SHARES_PER_IP_PER_HOUR = 60;

export const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function shareTtlSeconds(): number {
  const raw = Number(process.env.SHARE_TTL_SECONDS);
  return Number.isFinite(raw) && raw >= 60 && raw <= 24 * 60 * 60
    ? Math.floor(raw)
    : DEFAULT_TTL_SECONDS;
}

export function shareEnabled(): boolean {
  return dbConfigured();
}

export async function putShare(
  payload: string
): Promise<{ id: string; ttlSeconds: number }> {
  const id = randomBytes(16).toString("base64url");
  const ttl = shareTtlSeconds();
  await getPool().query(
    "insert into reader_shares (id, payload, expires_at) values ($1, $2, now() + $3::int * interval '1 second')",
    [id, payload, ttl]
  );
  return { id, ttlSeconds: ttl };
}

export async function getShare(id: string): Promise<string | null> {
  if (!SHARE_ID_PATTERN.test(id)) return null;
  const { rows } = await getPool().query(
    "select payload from reader_shares where id = $1 and expires_at > now()",
    [id]
  );
  return rows[0]?.payload ?? null;
}

// A fixed one-hour window per address, counted atomically in one statement.
async function countShare(ip: string): Promise<number> {
  const { rows } = await getPool().query(
    `insert into share_rate_limits as limits (ip, window_start, count) values ($1, now(), 1)
     on conflict (ip) do update set
       count = case when limits.window_start <= now() - interval '1 hour' then 1 else limits.count + 1 end,
       window_start = case when limits.window_start <= now() - interval '1 hour' then now() else limits.window_start end
     returning count`,
    [ip]
  );
  return rows[0].count;
}

export async function allowShare(ip: string): Promise<boolean> {
  return (await countShare(ip)) <= MAX_SHARES_PER_IP_PER_HOUR;
}

// --- Entry shares -------------------------------------------------------
// A written entry published as a read-only page at /share/:id. The id and a
// secret token are created in the author's browser before publishing; only a
// hash of the token is stored, and it is what authorizes updating, re-timing
// or deleting the link later. Timed links carry expires_at; Never links have
// none and remain until revoked. Revoking or expiring clears the snapshot but
// keeps the row, so a delayed request can't recreate a retired id.

export interface EntryShareSnapshot {
  content: string;
  fontId: string;
  fontSize: number;
  // The drawings the content references, so a shared entry shows its
  // whiteboards rather than a row of empty frames.
  sketches?: Sketch[];
  createdAt: number;
  sharedAt: number;
}

const MAX_ENTRY_CHARS = 200_000;
const MIN_FONT_SIZE = 14;
const MAX_FONT_SIZE = 32;

// Shared by the create and update routes: turn an untrusted request body
// into a snapshot, or a ready-to-send error.
export function entrySnapshotFromBody(body: {
  content?: unknown;
  fontId?: unknown;
  fontSize?: unknown;
  sketches?: unknown;
  createdAt?: unknown;
}): EntryShareSnapshot | { error: string; status: number } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request", status: 400 };
  }
  const content = typeof body.content === "string" ? body.content : "";
  if (!content.trim()) {
    return { error: "Nothing to share", status: 400 };
  }
  if (content.length > MAX_ENTRY_CHARS) {
    return { error: "That entry is too large to share", status: 413 };
  }

  // The snapshot is public and its drawings are injected into the page as SVG,
  // so what a reader gets is whatever survives the same validator sync uses.
  const sketches = parseSketches(body.sketches);
  if (sketches === false) {
    return { error: "That entry's drawings couldn't be read", status: 400 };
  }

  const fontId = ALL_FONTS.some((f) => f.id === body.fontId)
    ? (body.fontId as string)
    : DEFAULT_FONT_ID;
  const fontSize =
    typeof body.fontSize === "number" && Number.isFinite(body.fontSize)
      ? Math.min(
          MAX_FONT_SIZE,
          Math.max(MIN_FONT_SIZE, Math.round(body.fontSize))
        )
      : DEFAULT_FONT_SIZE;
  const createdAt =
    typeof body.createdAt === "number" && Number.isFinite(body.createdAt)
      ? body.createdAt
      : Date.now();

  return {
    content,
    fontId,
    fontSize,
    ...(sketches !== null && { sketches }),
    createdAt,
    sharedAt: Date.now(),
  };
}

// Re-validated on the way out as well as in: the snapshot is only as
// trustworthy as the store it came from, and its drawings end up as markup
// on a public page.
function publicSnapshot(stored: unknown): EntryShareSnapshot | null {
  if (!stored || typeof stored !== "object") return null;
  const parsed = stored as Partial<EntryShareSnapshot>;
  if (typeof parsed.content !== "string" || !parsed.content.trim()) return null;
  const sketches = parseSketches(parsed.sketches);
  return {
    content: parsed.content,
    fontId: typeof parsed.fontId === "string" ? parsed.fontId : DEFAULT_FONT_ID,
    fontSize: typeof parsed.fontSize === "number" ? parsed.fontSize : DEFAULT_FONT_SIZE,
    ...(sketches !== null && sketches !== false && { sketches }),
    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
    sharedAt: typeof parsed.sharedAt === "number" ? parsed.sharedAt : Date.now(),
  };
}

export interface EntryShareCapability { id: string; token: string }

export class EntryShareCreateError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }

const LIVE = "snapshot is not null and (expires_at is null or expires_at > now())";
const EXPIRES_AT = "(extract(epoch from expires_at) * 1000)::bigint as expires_at";

function epochMs(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

export async function putEntryShare(
  snapshot: EntryShareSnapshot,
  expiry: EntryShareExpiry = "7d",
  capability?: EntryShareCapability
): Promise<{ id: string; token: string; ttlSeconds: number | null; expiresAt: number | null }> {
  const id = capability?.id ?? randomBytes(16).toString("base64url");
  const token = capability?.token ?? randomBytes(16).toString("base64url");
  if (!SHARE_ID_PATTERN.test(id) || !SHARE_ID_PATTERN.test(token)) {
    throw new EntryShareCreateError(400, "Invalid link controls");
  }
  const ttlSeconds = entryShareTtlSeconds(expiry);
  const pool = getPool();
  const created = await pool.query(
    `insert into entry_shares (id, token_hash, snapshot, expires_at)
     values ($1, $2, $3::jsonb, now() + $4::int * interval '1 second')
     on conflict (id) do nothing
     returning ${EXPIRES_AT}`,
    [id, tokenHash(token), JSON.stringify(snapshot), ttlSeconds]
  );
  if (created.rows[0]) return { id, token, ttlSeconds, expiresAt: epochMs(created.rows[0].expires_at) };

  // A retry after a lost response returns the same link, preserving the first
  // published snapshot and expiry rather than republishing current edits.
  const { rows } = await pool.query(
    `select token_hash = $2 as owner, ${LIVE} as live, ${EXPIRES_AT} from entry_shares where id = $1`,
    [id, tokenHash(token)]
  );
  if (!rows[0]?.owner) throw new EntryShareCreateError(403, "Not allowed");
  if (!rows[0].live) throw new EntryShareCreateError(410, "This link expired or was deleted. Create a new link.");
  const expiresAt = epochMs(rows[0].expires_at);
  return { id, token, expiresAt,
    ttlSeconds: expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) };
}

export async function getEntryShare(
  id: string
): Promise<EntryShareSnapshot | null> {
  if (!SHARE_ID_PATTERN.test(id)) return null;
  const { rows } = await getPool().query(
    `select snapshot from entry_shares where id = $1 and ${LIVE}`,
    [id]
  );
  return rows[0] ? publicSnapshot(rows[0].snapshot) : null;
}

export type EntryShareMutation = "ok" | "missing" | "denied" | "limited";

const OWNED_LIVE = `id = $1 and token_hash = $2 and ${LIVE}`;

// Each change is one conditional statement on a live row owned by the token,
// so a change that races with a deletion or expiry can never resurrect it.
// `statement` matches on OWNED_LIVE and yields the row's expires_at.
async function onLiveEntry(
  id: string,
  token: string,
  statement: string,
  values: unknown[] = []
): Promise<{ result: EntryShareMutation; expiresAt: number | null }> {
  if (!SHARE_ID_PATTERN.test(id)) return { result: "missing", expiresAt: null };
  if (!SHARE_ID_PATTERN.test(token)) return { result: "denied", expiresAt: null };
  const hash = tokenHash(token);
  const { rows } = await getPool().query(statement, [id, hash, ...values]);
  if (rows[0]) return { result: "ok", expiresAt: epochMs(rows[0].expires_at) };
  const owner = await getPool().query(
    "select token_hash = $2 as owner from entry_shares where id = $1",
    [id, hash]
  );
  return { result: owner.rows[0] && !owner.rows[0].owner ? "denied" : "missing", expiresAt: null };
}

// An omitted expiry keeps the remaining lifetime; an explicit one restarts it
// from now, and Never clears it.
export async function updateEntryShare(
  id: string,
  token: string,
  snapshot: EntryShareSnapshot,
  expiry?: EntryShareExpiry
): Promise<{ result: EntryShareMutation; expiresAt: number | null }> {
  return onLiveEntry(id, token,
    `update entry_shares set snapshot = $3::jsonb,
       expires_at = case when $4::boolean then now() + $5::int * interval '1 second' else expires_at end
     where ${OWNED_LIVE} returning ${EXPIRES_AT}`,
    [JSON.stringify(snapshot), expiry !== undefined, expiry === undefined ? null : entryShareTtlSeconds(expiry)]);
}

// Expiry changes do not touch the published snapshot.
export async function changeEntryShareExpiry(
  id: string,
  token: string,
  expiry: EntryShareExpiry
): Promise<{ result: EntryShareMutation; expiresAt: number | null }> {
  return onLiveEntry(id, token,
    `update entry_shares set expires_at = now() + $3::int * interval '1 second'
     where ${OWNED_LIVE} returning ${EXPIRES_AT}`,
    [entryShareTtlSeconds(expiry)]);
}

export async function getEntryShareStatus(id: string, token: string) {
  return onLiveEntry(id, token, `select ${EXPIRES_AT} from entry_shares where ${OWNED_LIVE}`);
}

export async function deleteEntryShare(
  id: string,
  token: string,
  ip = "unknown"
): Promise<EntryShareMutation> {
  if (!SHARE_ID_PATTERN.test(id)) return "missing";
  if (!SHARE_ID_PATTERN.test(token)) return "denied";
  const pool = getPool();
  // Clear this token's snapshot even if it already lapsed; report whether the
  // link was still live.
  const { rows } = await pool.query(
    `with link as (select id, ${LIVE} as live from entry_shares where id = $1 and token_hash = $2 for update)
     update entry_shares set snapshot = null from link where entry_shares.id = link.id returning link.live`,
    [id, tokenHash(token)]
  );
  if (rows[0]) return rows[0].live ? "ok" : "missing";
  const existing = await pool.query("select 1 from entry_shares where id = $1", [id]);
  if (existing.rows[0]) return "denied";
  // An id nobody has published yet may belong to a create still in flight.
  // Retire it under this token so that late request can't publish it; new
  // retirements count toward the same per-address limit as new links.
  if (!(await allowShare(ip))) return "limited";
  const retired = await pool.query(
    "insert into entry_shares (id, token_hash) values ($1, $2) on conflict (id) do nothing returning id",
    [id, tokenHash(token)]
  );
  // Lost a race with that create: revoke what it just published.
  return retired.rows[0] ? "missing" : deleteEntryShare(id, token, ip);
}

// Scheduled by /api/cron/shares. Lapsed entry links keep their id and owner
// hash, retired as above; everything else about expired shares is removed.
export async function purgeExpiredShares(): Promise<{ entries: number; snapshots: number }> {
  const pool = getPool();
  const entries = await pool.query(
    "update entry_shares set snapshot = null where snapshot is not null and expires_at <= now()"
  );
  const snapshots = await pool.query("delete from reader_shares where expires_at <= now()");
  await pool.query("delete from share_rate_limits where window_start <= now() - interval '1 hour'");
  return { entries: entries.rowCount ?? 0, snapshots: snapshots.rowCount ?? 0 };
}
