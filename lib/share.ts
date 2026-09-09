import { createHash, randomBytes, timingSafeEqual } from "crypto";

import { ALL_FONTS, DEFAULT_FONT_ID, DEFAULT_FONT_SIZE } from "./fonts.ts";
import { parseSketches } from "./sketch.ts";
import type { Sketch } from "./types.ts";
import { entryShareTtlSeconds, type EntryShareExpiry } from "./share-expiry.ts";

// Ephemeral article snapshots for the reader's chat link-out, stored in
// Upstash Redis / Vercel KV via its REST API (plain fetch, no client dep).
// A 128-bit random id is the capability; the store's TTL is the expiry —
// content is physically gone once it lapses. Without the env vars the
// feature reports itself disabled and the chat flow falls back to link-out.

const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_SHARES_PER_IP_PER_HOUR = 60;

export const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function shareTtlSeconds(): number {
  const raw = Number(process.env.SHARE_TTL_SECONDS);
  return Number.isFinite(raw) && raw >= 60 && raw <= 24 * 60 * 60
    ? Math.floor(raw)
    : DEFAULT_TTL_SECONDS;
}

function kvEnv(): { url: string; token: string } | null {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export function shareEnabled(): boolean {
  return kvEnv() !== null;
}

async function redis(command: (string | number)[]): Promise<unknown> {
  const env = kvEnv();
  if (!env) throw new Error("Share store is not configured");
  const res = await fetch(env.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Share store responded with ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (body.error) throw new Error(body.error);
  return body.result;
}

export async function putShare(
  payload: string
): Promise<{ id: string; ttlSeconds: number }> {
  const id = randomBytes(16).toString("base64url");
  const ttl = shareTtlSeconds();
  await redis(["SET", `share:${id}`, payload, "EX", ttl]);
  return { id, ttlSeconds: ttl };
}

export async function getShare(id: string): Promise<string | null> {
  if (!SHARE_ID_PATTERN.test(id)) return null;
  const result = await redis(["GET", `share:${id}`]);
  return typeof result === "string" ? result : null;
}

export async function allowShare(ip: string): Promise<boolean> {
  const key = `share-rl:${ip}`;
  const count = await redis(["INCR", key]);
  if (count === 1) await redis(["EXPIRE", key, 3600]);
  return typeof count === "number" && count <= MAX_SHARES_PER_IP_PER_HOUR;
}

// --- Entry shares -------------------------------------------------------
// A written entry published as a read-only page at /share/:id. Creating a
// link returns the id plus a secret token that stays in the author's
// browser; the token is what authorizes updating or deleting the link
// later. Snapshots live in the same KV store under their own, much longer
// lifetime. Timed links use Redis expiry; Never links remain until revoked.

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

function entryKey(id: string): string {
  return `share:entry:${id}`;
}

async function readEntryShare(
  id: string
): Promise<(EntryShareSnapshot & { token: string }) | null> {
  if (!SHARE_ID_PATTERN.test(id)) return null;
  const result = await redis(["GET", entryKey(id)]);
  if (typeof result !== "string") return null;
  try {
    const parsed = JSON.parse(result) as Partial<
      EntryShareSnapshot & { token: string }
    >;
    if (typeof parsed.content !== "string" || !parsed.content.trim()) {
      return null;
    }
    if (typeof parsed.token !== "string") return null;
    // Re-validated on the way out as well as in: the snapshot is only as
    // trustworthy as the store it came from, and its
    // drawings end up as markup on a public page.
    const sketches = parseSketches(parsed.sketches);
    return {
      content: parsed.content,
      fontId:
        typeof parsed.fontId === "string" ? parsed.fontId : DEFAULT_FONT_ID,
      fontSize:
        typeof parsed.fontSize === "number"
          ? parsed.fontSize
          : DEFAULT_FONT_SIZE,
      ...(sketches !== null && sketches !== false && { sketches }),
      createdAt:
        typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      sharedAt:
        typeof parsed.sharedAt === "number" ? parsed.sharedAt : Date.now(),
      token: parsed.token,
    };
  } catch {
    return null;
  }
}

export interface EntryShareCapability { id: string; token: string }

export class EntryShareCreateError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const CREATE_ENTRY_SCRIPT = `
local owner = redis.call('GET', KEYS[2])
local raw = redis.call('GET', KEYS[1])
if owner then
  if owner ~= ARGV[1] then return 'denied' end
  if not raw then return 'retired' end
  return 'existing'
end
if raw then return 'denied' end
redis.call('SET', KEYS[2], ARGV[1])
if ARGV[3] == '-1' then redis.call('SET', KEYS[1], ARGV[2])
else redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) end
return 'created'
`;

function ownerKey(id: string): string { return `share:entry-owner:${id}`; }
function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

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
  const expiresAt = ttlSeconds === null ? null : Date.now() + ttlSeconds * 1000;
  const result = await redis([
    "EVAL", CREATE_ENTRY_SCRIPT, 2, entryKey(id), ownerKey(id), tokenHash(token),
    JSON.stringify({ ...snapshot, token, expiresAt }), ttlSeconds ?? -1,
  ]);
  if (result === "denied") throw new EntryShareCreateError(403, "Not allowed");
  if (result === "retired") throw new EntryShareCreateError(410, "This link expired or was deleted. Create a new link.");
  if (result === "existing") {
    // A retry after a lost response returns the same link, preserving the first
    // published snapshot and expiry rather than republishing current edits.
    const status = await getEntryShareStatus(id, token);
    if (status.result === "missing") throw new EntryShareCreateError(410, "This link expired or was deleted. Create a new link.");
    if (status.result !== "ok") throw new EntryShareCreateError(status.result === "denied" ? 403 : 409, "This link changed. Check it and try again.");
    return { id, token, expiresAt: status.expiresAt,
      ttlSeconds: status.expiresAt === null ? null : Math.max(0, Math.ceil((status.expiresAt - Date.now()) / 1000)) };
  }
  if (result !== "created") throw new Error("Invalid share store response");
  return { id, token, ttlSeconds, expiresAt };
}

export async function getEntryShare(
  id: string
): Promise<EntryShareSnapshot | null> {
  const stored = await readEntryShare(id);
  if (!stored) return null;
  // Management tokens never reach the public page.
  const { content, fontId, fontSize, createdAt, sharedAt, sketches } = stored;
  return { content, fontId, fontSize, createdAt, sharedAt, ...(sketches && { sketches }) };
}

export type EntryShareMutation = "ok" | "missing" | "denied" | "conflict" | "limited";

// Atomically compare the capability-verified record before mutating. In particular,
// an update that races with a deletion can never recreate the deleted link.
// An omitted expiry keeps the exact remaining TTL, including old records that
// predate expiresAt. Explicit Never uses SET without EX, removing any old TTL.
const MUTATE_ENTRY_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return { 'missing' } end
if raw ~= ARGV[1] then return { 'conflict' } end
if ARGV[2] == 'delete' then
  redis.call('SET', KEYS[2], ARGV[5])
  redis.call('DEL', KEYS[1])
  return { 'ok' }
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -2 or ttl == 0 then
  redis.call('DEL', KEYS[1])
  return { 'missing' }
end
if ARGV[4] ~= 'keep' then ttl = tonumber(ARGV[4]) end
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
if ARGV[2] == 'status' then
  if ttl < 0 then return { 'ok', -1 } end
  return { 'ok', nowMs + ttl }
end
-- Add one top-level metadata field without round-tripping the content through
-- Lua cjson, which turns empty drawing arrays into objects.
local base = string.sub(ARGV[3], 1, -2)
if ttl < 0 then
  redis.call('SET', KEYS[1], base .. ',"expiresAt":null}')
  return { 'ok', -1 }
end
local expiresAt = nowMs + ttl
redis.call('SET', KEYS[1], base .. ',"expiresAt":' .. string.format('%.0f', expiresAt) .. '}', 'PX', ttl)
return { 'ok', expiresAt }
`;

async function mutateEntryShare(
  id: string,
  token: string,
  action: "update" | "expiry" | "delete" | "status",
  snapshot?: EntryShareSnapshot,
  expiry?: EntryShareExpiry,
  ip = "unknown"
): Promise<{ result: EntryShareMutation; expiresAt: number | null }> {
  if (!SHARE_ID_PATTERN.test(id)) return { result: "missing", expiresAt: null };
  if (!SHARE_ID_PATTERN.test(token)) return { result: "denied", expiresAt: null };
  const raw = await redis(["GET", entryKey(id)]);
  if (typeof raw !== "string") {
    if (action === "delete") {
      const result = await redis([
        "EVAL",
        `local owner = redis.call('GET', KEYS[2])
if owner and owner ~= ARGV[1] then return 'denied' end
if redis.call('EXISTS', KEYS[1]) == 1 then return 'conflict' end
if not owner then
  local count = redis.call('INCR', KEYS[3])
  if count == 1 then redis.call('EXPIRE', KEYS[3], 3600) end
  if count > tonumber(ARGV[2]) then return 'limited' end
end
redis.call('SET', KEYS[2], ARGV[1])
return 'missing'`,
        3, entryKey(id), ownerKey(id), `share-rl:${ip}`, tokenHash(token), MAX_SHARES_PER_IP_PER_HOUR,
      ]);
      if (result === "denied" || result === "conflict" || result === "limited") return { result, expiresAt: null };
    }
    return { result: "missing", expiresAt: null };
  }
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(raw);
    if (!stored || typeof stored !== "object" || typeof stored.token !== "string") throw new Error();
  } catch {
    return { result: "missing", expiresAt: null };
  }
  const expected = Buffer.from(stored.token as string);
  const given = Buffer.from(token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { result: "denied", expiresAt: null };
  }
  // Remove old expiry metadata before the script writes the new value. Using
  // the original JSON fields for expiry-only changes preserves the snapshot.
  const next = snapshot ? { ...snapshot, token: stored.token } : { ...stored };
  if ("expiresAt" in next) delete next.expiresAt;
  const seconds = expiry === undefined ? undefined : entryShareTtlSeconds(expiry);
  const response = await redis([
    "EVAL", MUTATE_ENTRY_SCRIPT, 2, entryKey(id), ownerKey(id), raw, action,
    JSON.stringify(next),
    seconds === undefined ? "keep" : seconds === null ? -1 : seconds * 1000,
    tokenHash(token),
  ]);
  if (!Array.isArray(response) || !["ok", "missing", "denied", "conflict"].includes(response[0])) {
    throw new Error("Invalid share store response");
  }
  return {
    result: response[0] as EntryShareMutation,
    expiresAt: typeof response[1] === "number" && response[1] >= 0 ? response[1] : null,
  };
}

export async function updateEntryShare(
  id: string,
  token: string,
  snapshot: EntryShareSnapshot,
  expiry?: EntryShareExpiry
): Promise<{ result: EntryShareMutation; expiresAt: number | null }> {
  return mutateEntryShare(id, token, "update", snapshot, expiry);
}

export async function changeEntryShareExpiry(
  id: string,
  token: string,
  expiry: EntryShareExpiry
): Promise<{ result: EntryShareMutation; expiresAt: number | null }> {
  return mutateEntryShare(id, token, "expiry", undefined, expiry);
}

export async function getEntryShareStatus(id: string, token: string) {
  return mutateEntryShare(id, token, "status");
}

export async function deleteEntryShare(
  id: string,
  token: string,
  ip = "unknown"
): Promise<EntryShareMutation> {
  return (await mutateEntryShare(id, token, "delete", undefined, undefined, ip)).result;
}
