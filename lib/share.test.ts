import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
let server: ChildProcess;
let beforeEval: (() => void) | null = null;
const originalFetch = globalThis.fetch;
const originalUrl = process.env.KV_REST_API_URL;
const originalToken = process.env.KV_REST_API_TOKEN;
function command(parts: (string | number)[]): unknown {
  return JSON.parse(execFileSync("redis-cli", ["-s", socket, "--json", ...parts.map(String)], { encoding: "utf8" }));
}
function stored(id: string): Record<string, unknown> {
  return JSON.parse(command(["GET", `share:entry:${id}`]) as string);
}
before(async () => {
  if (!available) return;
  directory = mkdtempSync(join(tmpdir(), "freewrite-share-test-"));
  socket = join(directory, "redis.sock");
  server = spawn("redis-server", ["--port", "0", "--unixsocket", socket, "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  for (let count = 0; count < 100; count++) {
    const ping = spawnSync("redis-cli", ["-s", socket, "PING"], { encoding: "utf8" });
    if (ping.status === 0) break;
    await pause(20);
  }
  assert.equal(command(["PING"]), "PONG");
  process.env.KV_REST_API_URL = "http://freewrite-redis.invalid";
  process.env.KV_REST_API_TOKEN = "test-only-token";
  globalThis.fetch = async (_url, init) => {
    const parts = JSON.parse(String(init?.body));
    if (parts[0] === "EVAL" && beforeEval) {
      const callback = beforeEval;
      beforeEval = null;
      callback();
    }
    return Response.json({ result: command(parts) });
  };
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.KV_REST_API_URL;
  else process.env.KV_REST_API_URL = originalUrl;
  if (originalToken === undefined) delete process.env.KV_REST_API_TOKEN;
  else process.env.KV_REST_API_TOKEN = originalToken;
  if (server) {
    const done = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    await done;
  }
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
