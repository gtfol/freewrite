import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import {
  changeEntryShareExpiry,
  deleteEntryShare,
  entrySnapshotFromBody,
  getEntryShare,
  getEntryShareStatus,
  putEntryShare,
  putShare,
  updateEntryShare,
  type EntryShareSnapshot,
} from "./share.ts";
import { entryShareTtlSeconds, parseEntryShareExpiry } from "./share-expiry.ts";
import { blankSketch } from "./sketch.ts";

// The link-control route handlers import "@/…" and "next/server"; resolve them
// the way Next does so tests can send the browser's requests to the handlers.
register("data:text/javascript," + encodeURIComponent(`
export function resolve(specifier, context, next) {
  if (specifier === "next/server") return next("next/server.js", context);
  if (specifier.startsWith("@/")) return next(new URL(specifier.slice(2) + ".ts", ${JSON.stringify(new URL("../", import.meta.url).href)}).href, context);
  return next(specifier, context);
}`));

const DAY = 86_400;
const snapshot: EntryShareSnapshot = {
  content: "An entry", fontId: "lato", fontSize: 18,
  createdAt: 1000, sharedAt: 2000,
};

test("new entry links default to seven days and only accept the advertised options", () => {
  assert.equal(entryShareTtlSeconds(), 7 * DAY);
  assert.equal(entryShareTtlSeconds("30d"), 30 * DAY);
  assert.equal(entryShareTtlSeconds("never"), null);
  assert.equal(parseEntryShareExpiry(undefined), undefined);
  for (const choice of ["7d", "30d", "never"] as const) assert.equal(parseEntryShareExpiry(choice), choice);
  for (const value of [null, 0, -1, 604800, "7", "Never", true, [], {}]) assert.equal(parseEntryShareExpiry(value), false);
});

test("malformed entry requests fail validation without throwing", () => {
  for (const body of [null, [], false, "text", {}]) {
    assert.ok("error" in entrySnapshotFromBody(body as Parameters<typeof entrySnapshotFromBody>[0]));
  }
});

// Exercise the actual Lua commands against isolated local Redis when installed.
// No application database, network service, or deployment credentials are used.
const available = spawnSync("redis-server", ["--version"]).status === 0
  && spawnSync("redis-cli", ["--version"]).status === 0;
const integration = available ? test : test.skip;
let directory: string;
let socket: string;
let replicaSocket: string;
let servers: ChildProcess[] = [];
let beforeEval: (() => void) | null = null;
// Deployed-store (Upstash REST) rules that plain local Redis doesn't enforce:
// rejected commands answer HTTP 400 with {error}; scripts must be deterministic,
// taking values from KEYS, ARGV or data they read rather than the clock, so a
// TIME call fails the script here; and plain reads may be served by a replica
// that hasn't received recent writes, while scripts run on the primary. While
// laggingReplica is set, plain GETs see such a replica.
let laggingReplica = false;
let storeError: string | null = null;
const DETERMINISTIC_SCRIPT = `local store = redis
local function deterministic(command)
  if string.upper(command) == 'TIME' then error('scripts must not read the store clock') end
end
local redis = setmetatable({
  call = function(command, ...) deterministic(command) return store.call(command, ...) end,
  pcall = function(command, ...) deterministic(command) return store.pcall(command, ...) end,
}, { __index = store })
`;
const originalFetch = globalThis.fetch;
const originalUrl = process.env.KV_REST_API_URL;
const originalToken = process.env.KV_REST_API_TOKEN;
function reply(parts: (string | number)[], target = socket): { result: unknown } | { error: string } {
  const output = execFileSync("redis-cli", ["-s", target, "--json", ...parts.map(String)], { encoding: "utf8" }).trim();
  // redis-cli prints error replies as `error:"…"` rather than JSON.
  return output.startsWith("error:") ? { error: JSON.parse(output.slice(6)) } : { result: JSON.parse(output) };
}
function command(parts: (string | number)[]): unknown {
  const answer = reply(parts);
  if ("error" in answer) throw new Error(answer.error);
  return answer.result;
}
function stored(id: string): Record<string, unknown> {
  return JSON.parse(command(["GET", `share:entry:${id}`]) as string);
}
async function startRedis(path: string): Promise<void> {
  servers.push(spawn("redis-server", ["--port", "0", "--unixsocket", path, "--save", "", "--appendonly", "no"], { stdio: "ignore" }));
  for (let count = 0; count < 100; count++) {
    const ping = spawnSync("redis-cli", ["-s", path, "PING"], { encoding: "utf8" });
    if (ping.status === 0) return;
    await pause(20);
  }
}
before(async () => {
  if (!available) return;
  directory = mkdtempSync(join(tmpdir(), "freewrite-share-test-"));
  socket = join(directory, "redis.sock");
  replicaSocket = join(directory, "replica.sock");
  await Promise.all([startRedis(socket), startRedis(replicaSocket)]);
  assert.equal(command(["PING"]), "PONG");
  assert.deepEqual(reply(["PING"], replicaSocket), { result: "PONG" });
  process.env.KV_REST_API_URL = "http://freewrite-redis.invalid";
  process.env.KV_REST_API_TOKEN = "test-only-token";
  globalThis.fetch = async (_url, init) => {
    const parts = JSON.parse(String(init?.body));
    if (parts[0] === "EVAL") {
      if (beforeEval) {
        const callback = beforeEval;
        beforeEval = null;
        callback();
      }
      if (storeError) return Response.json({ error: storeError }, { status: 400 });
      parts[1] = DETERMINISTIC_SCRIPT + parts[1];
    }
    const answer = reply(parts, parts[0] === "GET" && laggingReplica ? replicaSocket : socket);
    return Response.json(answer, { status: "error" in answer ? 400 : 200 });
  };
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.KV_REST_API_URL;
  else process.env.KV_REST_API_URL = originalUrl;
  if (originalToken === undefined) delete process.env.KV_REST_API_TOKEN;
  else process.env.KV_REST_API_TOKEN = originalToken;
  await Promise.all(servers.map((server) => {
    const done = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    return done;
  }));
  servers = [];
  if (directory) rmSync(directory, { recursive: true, force: true });
});

integration("default create has seven-day TTL and authoritative expiry metadata", async () => {
  const link = await putEntryShare(snapshot);
  assert.equal(link.ttlSeconds, 7 * DAY);
  assert.ok(link.expiresAt! > Date.now() + 7 * DAY * 1000 - 5000);
  assert.equal(command(["TTL", `share:entry:${link.id}`]), 7 * DAY);
  assert.equal(stored(link.id).expiresAt, link.expiresAt);
  assert.deepEqual(await getEntryShare(link.id), snapshot);
  assert.ok(!("token" in (await getEntryShare(link.id))!));
});

integration("Never is null in records and uses no Redis TTL", async () => {
  const link = await putEntryShare(snapshot, "never");
  assert.equal(link.expiresAt, null);
  assert.equal(link.ttlSeconds, null);
  assert.equal(stored(link.id).expiresAt, null);
  assert.equal(command(["TTL", `share:entry:${link.id}`]), -1);
  assert.equal(await deleteEntryShare(link.id, link.token), "ok");
  assert.equal(await getEntryShare(link.id), null);
});

integration("expiry changes preserve snapshot, including empty drawing arrays", async () => {
  const withDrawing = { ...snapshot, sketches: [blankSketch("aaaa11")] };
  const link = await putEntryShare(withDrawing, "30d");
  const publicBefore = await getEntryShare(link.id);
  const result = await changeEntryShareExpiry(link.id, link.token, "never");
  assert.deepEqual(result, { result: "ok", expiresAt: null });
  assert.equal(command(["TTL", `share:entry:${link.id}`]), -1);
  assert.equal(stored(link.id).expiresAt, null);
  assert.deepEqual(await getEntryShare(link.id), publicBefore);
  assert.deepEqual(stored(link.id).sketches, withDrawing.sketches);
  const timed = await changeEntryShareExpiry(link.id, link.token, "7d");
  assert.equal(timed.result, "ok");
  assert.ok(timed.expiresAt! > Date.now());
  assert.equal(command(["TTL", `share:entry:${link.id}`]), 7 * DAY);
});

integration("updating an entry preserves its remaining lifetime instead of restarting it", async () => {
  const link = await putEntryShare(snapshot, "30d");
  command(["PEXPIRE", `share:entry:${link.id}`, 300_000]);
  const next = { ...snapshot, content: "Updated", sharedAt: 3000 };
  const result = await updateEntryShare(link.id, link.token, next);
  assert.equal(result.result, "ok");
  const ttl = command(["PTTL", `share:entry:${link.id}`]) as number;
  assert.ok(ttl > 290_000 && ttl <= 300_000);
  assert.deepEqual(await getEntryShare(link.id), next);
});

integration("updating a Never entry keeps it permanent", async () => {
  const link = await putEntryShare(snapshot, "never");
  const result = await updateEntryShare(link.id, link.token, { ...snapshot, content: "Updated" });
  assert.equal(result.expiresAt, null);
  assert.equal(command(["TTL", `share:entry:${link.id}`]), -1);
});

integration("old records preserve their actual TTL, then support explicit Never", async () => {
  const id = "aaaaaaaaaaaaaaaaaaaaaa";
  const token = "bbbbbbbbbbbbbbbbbbbbbb";
  command(["SET", `share:entry:${id}`, JSON.stringify({ ...snapshot, token }), "EX", 500]);
  assert.deepEqual(await getEntryShare(id), snapshot);
  const updated = await updateEntryShare(id, token, snapshot);
  assert.equal(updated.result, "ok");
  assert.ok((command(["TTL", `share:entry:${id}`]) as number) <= 500);
  assert.ok(updated.expiresAt! < Date.now() + 501_000);
  await changeEntryShareExpiry(id, token, "never");
  assert.equal(command(["TTL", `share:entry:${id}`]), -1);
});

integration("unauthorized tokens cannot update, change expiry, or revoke", async () => {
  const link = await putEntryShare(snapshot);
  const wrong = "xxxxxxxxxxxxxxxxxxxxxx";
  assert.equal((await updateEntryShare(link.id, wrong, snapshot)).result, "denied");
  assert.equal((await changeEntryShareExpiry(link.id, wrong, "never")).result, "denied");
  assert.equal(await deleteEntryShare(link.id, wrong), "denied");
  assert.equal(await deleteEntryShare(link.id, "bad"), "denied");
  assert.deepEqual(await getEntryShare(link.id), snapshot);
});

integration("expired or deleted links cannot be renewed or recreated", async () => {
  const link = await putEntryShare(snapshot);
  command(["PEXPIRE", `share:entry:${link.id}`, 1]);
  await pause(10);
  assert.equal(await getEntryShare(link.id), null);
  assert.equal((await updateEntryShare(link.id, link.token, snapshot, "never")).result, "missing");
  assert.equal((await changeEntryShareExpiry(link.id, link.token, "never")).result, "missing");
  assert.equal(await deleteEntryShare(link.id, link.token), "missing");
});

integration("a delete between authorization and update cannot be resurrected", async () => {
  const link = await putEntryShare(snapshot, "never");
  beforeEval = () => { command(["DEL", `share:entry:${link.id}`]); };
  assert.equal((await updateEntryShare(link.id, link.token, snapshot)).result, "missing");
  assert.equal(await getEntryShare(link.id), null);
});

integration("a concurrent mutation is reported instead of overwriting newer content", async () => {
  const link = await putEntryShare(snapshot, "never");
  beforeEval = () => {
    command(["SET", `share:entry:${link.id}`, JSON.stringify({ ...snapshot, content: "Changed elsewhere", token: link.token, expiresAt: null })]);
  };
  assert.equal((await changeEntryShareExpiry(link.id, link.token, "7d")).result, "conflict");
  assert.equal((await getEntryShare(link.id))!.content, "Changed elsewhere");
  assert.equal(command(["TTL", `share:entry:${link.id}`]), -1);
});

integration("temporary reader snapshots retain their thirty-minute default", async () => {
  const original = process.env.SHARE_TTL_SECONDS;
  delete process.env.SHARE_TTL_SECONDS;
  try {
    const link = await putShare("Reader article");
    assert.equal(link.ttlSeconds, 1800);
    assert.equal(command(["TTL", `share:${link.id}`]), 1800);
  } finally {
    if (original !== undefined) process.env.SHARE_TTL_SECONDS = original;
  }
});


integration("a lost create response can be retried with the durable capability", async () => {
  const capability = { id: "cccccccccccccccccccccc", token: "dddddddddddddddddddddd" };
  const first = await putEntryShare(snapshot, "never", capability);
  const recovered = await putEntryShare({ ...snapshot, content: "New local edits" }, "7d", capability);
  assert.equal(recovered.id, first.id);
  assert.equal(recovered.token, first.token);
  assert.equal(recovered.expiresAt, null);
  assert.deepEqual(await getEntryShare(first.id), snapshot);
  await assert.rejects(putEntryShare(snapshot, "never", { ...capability, token: "xxxxxxxxxxxxxxxxxxxxxx" }), { status: 403 });
});

integration("deleted and expired ids cannot be recreated by delayed POST retries", async () => {
  for (const mode of ["delete", "expiry"] as const) {
    const link = await putEntryShare(snapshot, "never");
    if (mode === "delete") await deleteEntryShare(link.id, link.token);
    else { command(["PEXPIRE", `share:entry:${link.id}`, 1]); await pause(10); }
    await assert.rejects(putEntryShare(snapshot, "never", link), { status: 410 });
    assert.equal(await getEntryShare(link.id), null);
  }
});

integration("revoking an unconfirmed create prevents a late first POST", async () => {
  const capability = { id: "eeeeeeeeeeeeeeeeeeeeee", token: "ffffffffffffffffffffff" };
  assert.equal(await deleteEntryShare(capability.id, capability.token), "missing");
  await assert.rejects(putEntryShare(snapshot, "never", capability), { status: 410 });
  assert.equal(await getEntryShare(capability.id), null);
});

integration("metadata recovers an uncertain expiry change without publishing edits", async () => {
  const link = await putEntryShare(snapshot, "7d");
  await changeEntryShareExpiry(link.id, link.token, "never");
  assert.deepEqual(await getEntryShareStatus(link.id, link.token), { result: "ok", expiresAt: null });
  assert.equal((await getEntryShareStatus(link.id, "xxxxxxxxxxxxxxxxxxxxxx")).result, "denied");
  assert.deepEqual(await getEntryShare(link.id), snapshot);
});

integration("unknown-id retirement is rate limited without blocking existing-link revocation", async () => {
  const ip = "tombstone-limit-test";
  command(["SET", `share-rl:${ip}`, 60, "EX", 3600]);
  const unknown = { id: "gggggggggggggggggggggg", token: "hhhhhhhhhhhhhhhhhhhhhh" };
  assert.equal(await deleteEntryShare(unknown.id, unknown.token, ip), "limited");
  assert.equal(command(["EXISTS", `share:entry-owner:${unknown.id}`]), 0);
  const link = await putEntryShare(snapshot, "never");
  assert.equal(await deleteEntryShare(link.id, link.token, ip), "ok");
  assert.equal(await deleteEntryShare(link.id, link.token, ip), "missing");
});

// --- Link-control requests, as the Share popover sends them ---------------

const entryBody = { content: "An entry", fontId: "lato", fontSize: 18, createdAt: 1000 };
const client = { "content-type": "application/json", "x-forwarded-for": "link-control-test" };

async function createLink(expiresIn: string) {
  const { POST } = await import("../app/api/share/entry/route.ts");
  const link = { id: randomBytes(16).toString("base64url"), token: randomBytes(16).toString("base64url") };
  const response = await POST(new Request("http://share.test/api/share/entry", {
    method: "POST", headers: client, body: JSON.stringify({ ...entryBody, expiresIn, ...link }),
  }));
  assert.equal(response.status, 200);
  return { link, body: await response.json() };
}

async function linkRequest(method: "GET" | "PUT" | "PATCH" | "DELETE", link: { id: string; token: string }, body?: unknown) {
  const handlers = await import("../app/api/share/entry/[id]/route.ts");
  const request = new Request(`http://share.test/api/share/entry/${link.id}`, {
    method, headers: { ...client, "x-share-token": link.token },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const response = await handlers[method](request, { params: Promise.resolve({ id: link.id }) });
  return { status: response.status, body: await response.json() };
}

integration("a Never link can be checked, updated, re-timed and revoked under deployed-store rules", async () => {
  const { link, body } = await createLink("never");
  assert.deepEqual(body, { ...link, ttlSeconds: null, expiresAt: null });
  assert.equal(command(["TTL", `share:entry:${link.id}`]), -1);

  // Check link, then again as after a reload: both confirm Never.
  for (let check = 0; check < 2; check++) {
    assert.deepEqual(await linkRequest("GET", link), { status: 200, body: { expiresAt: null } });
  }
  const shared = await getEntryShare(link.id);
  assert.equal(shared!.content, entryBody.content);
  assert.ok(!("token" in shared!));

  assert.deepEqual(await linkRequest("PUT", link, { ...entryBody, content: "Updated" }), { status: 200, body: { expiresAt: null } });
  assert.equal(command(["TTL", `share:entry:${link.id}`]), -1);
  assert.equal((await getEntryShare(link.id))!.content, "Updated");

  const timed = await linkRequest("PATCH", link, { expiresIn: "7d" });
  assert.equal(timed.status, 200);
  assert.ok(timed.body.expiresAt > Date.now() + 7 * DAY * 1000 - 5000);
  assert.equal(stored(link.id).expiresAt, timed.body.expiresAt);
  assert.equal(command(["TTL", `share:entry:${link.id}`]), 7 * DAY);
  const checked = await linkRequest("GET", link);
  assert.equal(checked.status, 200);
  assert.ok(Math.abs(checked.body.expiresAt - timed.body.expiresAt) < 1000);

  assert.deepEqual(await linkRequest("PATCH", link, { expiresIn: "never" }), { status: 200, body: { expiresAt: null } });
  assert.equal(command(["TTL", `share:entry:${link.id}`]), -1);
  assert.equal(stored(link.id).expiresAt, null);

  assert.deepEqual(await linkRequest("DELETE", link), { status: 200, body: { ok: true } });
  assert.equal((await linkRequest("GET", link)).status, 410);
  assert.equal(await getEntryShare(link.id), null);
});

integration("a status check that reaches a lagging replica keeps a live Never link", async () => {
  const { link } = await createLink("never");
  laggingReplica = true;
  try {
    // A 410 here makes the browser discard the only controls of a link that
    // never expires. The primary still has it, so the answer must be Never.
    assert.deepEqual(await linkRequest("GET", link), { status: 200, body: { expiresAt: null } });
    assert.deepEqual(await linkRequest("PATCH", link, { expiresIn: "never" }), { status: 200, body: { expiresAt: null } });
    assert.deepEqual(await linkRequest("DELETE", link), { status: 200, body: { ok: true } });
  } finally {
    laggingReplica = false;
  }
  assert.equal(await getEntryShare(link.id), null);
});

integration("store failures still answer 502 and log the store's reason", async () => {
  const { link } = await createLink("never");
  const logged = mock.method(console, "error", () => {});
  storeError = "ERR simulated store failure";
  try {
    for (const method of ["GET", "PUT", "PATCH", "DELETE"] as const) {
      const response = await linkRequest(method, link, method === "PUT" ? entryBody : method === "PATCH" ? { expiresIn: "never" } : undefined);
      assert.equal(response.status, 502);
      assert.ok(!JSON.stringify(response.body).includes("simulated"));
    }
  } finally {
    storeError = null;
    logged.mock.restore();
  }
  assert.equal(logged.mock.callCount(), 4);
  for (const call of logged.mock.calls) {
    assert.match(String(call.arguments[1]), /Share store responded with 400: ERR simulated store failure/);
    assert.ok(!call.arguments.map(String).join(" ").includes(link.token));
  }
  assert.deepEqual(await linkRequest("GET", link), { status: 200, body: { expiresAt: null } });
});
