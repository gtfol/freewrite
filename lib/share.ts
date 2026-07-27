import { randomBytes } from "crypto";

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
