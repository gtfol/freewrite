import { randomBytes, timingSafeEqual } from "crypto";

import { ALL_FONTS, DEFAULT_FONT_ID, DEFAULT_FONT_SIZE } from "@/lib/fonts";

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
// TTL, refreshed whenever the author pushes an update.

const DEFAULT_ENTRY_TTL_SECONDS = 30 * 24 * 60 * 60;

export function entryShareTtlSeconds(): number {
  const raw = Number(process.env.SHARE_ENTRY_TTL_SECONDS);
  return Number.isFinite(raw) && raw >= 3600 && raw <= 365 * 24 * 60 * 60
    ? Math.floor(raw)
    : DEFAULT_ENTRY_TTL_SECONDS;
}

export interface EntryShareSnapshot {
  content: string;
  fontId: string;
  fontSize: number;
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
  createdAt?: unknown;
}): EntryShareSnapshot | { error: string; status: number } {
  const content = typeof body.content === "string" ? body.content : "";
  if (!content.trim()) {
    return { error: "Nothing to share", status: 400 };
  }
  if (content.length > MAX_ENTRY_CHARS) {
    return { error: "That entry is too large to share", status: 413 };
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

  return { content, fontId, fontSize, createdAt, sharedAt: Date.now() };
}

function entryKey(id: string): string {
  return `share:entry:${id}`;
}

function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
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
    return {
      content: parsed.content,
      fontId:
        typeof parsed.fontId === "string" ? parsed.fontId : DEFAULT_FONT_ID,
      fontSize:
        typeof parsed.fontSize === "number"
          ? parsed.fontSize
          : DEFAULT_FONT_SIZE,
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

export async function putEntryShare(
  snapshot: EntryShareSnapshot
): Promise<{ id: string; token: string; ttlSeconds: number }> {
  const id = randomBytes(16).toString("base64url");
  const token = randomBytes(16).toString("base64url");
  const ttl = entryShareTtlSeconds();
  await redis([
    "SET",
    entryKey(id),
    JSON.stringify({ ...snapshot, token }),
    "EX",
    ttl,
  ]);
  return { id, token, ttlSeconds: ttl };
}

export async function getEntryShare(
  id: string
): Promise<EntryShareSnapshot | null> {
  const stored = await readEntryShare(id);
  if (!stored) return null;
  const { content, fontId, fontSize, createdAt, sharedAt } = stored;
  return { content, fontId, fontSize, createdAt, sharedAt };
}

export type EntryShareMutation = "ok" | "missing" | "denied";

export async function updateEntryShare(
  id: string,
  token: string,
  snapshot: EntryShareSnapshot
): Promise<{ result: EntryShareMutation; ttlSeconds: number }> {
  const ttl = entryShareTtlSeconds();
  const stored = await readEntryShare(id);
  if (!stored) return { result: "missing", ttlSeconds: ttl };
  if (!tokenMatches(stored.token, token)) {
    return { result: "denied", ttlSeconds: ttl };
  }
  await redis([
    "SET",
    entryKey(id),
    JSON.stringify({ ...snapshot, token: stored.token }),
    "EX",
    ttl,
  ]);
  return { result: "ok", ttlSeconds: ttl };
}

export async function deleteEntryShare(
  id: string,
  token: string
): Promise<EntryShareMutation> {
  const stored = await readEntryShare(id);
  if (!stored) return "missing";
  if (!tokenMatches(stored.token, token)) return "denied";
  await redis(["DEL", entryKey(id)]);
  return "ok";
}
