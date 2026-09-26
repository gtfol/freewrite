import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import {
  allowShare,
  changeEntryShareExpiry,
  deleteEntryShare,
  entrySnapshotFromBody,
  getEntryShare,
  getEntryShareStatus,
  getShare,
  purgeExpiredShares,
  putEntryShare,
  putShare,
  updateEntryShare,
  type EntryShareSnapshot,
} from "./share.ts";
import { entryShareTtlSeconds, parseEntryShareExpiry } from "./share-expiry.ts";
import { getPool } from "./server/db.ts";
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

// Exercise the real SQL against a throwaway Postgres cluster when its binaries
// are installed (initdb refuses to run as root). No application database,
// network service, or deployment credentials are used.
function postgresBin(): string | null {
  const versions = existsSync("/usr/lib/postgresql")
    ? readdirSync("/usr/lib/postgresql").sort((a, b) => Number(b) - Number(a)).map((v) => `/usr/lib/postgresql/${v}/bin`)
    : [];
  for (const dir of [process.env.PG_BIN, ...versions]) {
    if (dir && existsSync(join(dir, "initdb"))) return dir;
  }
  return spawnSync("initdb", ["--version"]).status === 0 ? "" : null;
}
const bin = process.getuid?.() === 0 ? null : postgresBin();
const available = bin !== null;
const integration = available ? test : test.skip;
const tool = (name: string) => (bin ? join(bin, name) : name);
let directory: string;
let server: ChildProcess | undefined;
const originalUrl = process.env.DATABASE_URL;
const query = (sql: string, values: unknown[] = []) => getPool().query(sql, values);
async function row(id: string) {
  return (await query("select snapshot, token_hash, (extract(epoch from expires_at) * 1000)::bigint as expires_at from entry_shares where id = $1", [id])).rows[0];
}
async function secondsLeft(id: string): Promise<number | null> {
  const { rows } = await query("select extract(epoch from expires_at - now())::int as left from entry_shares where id = $1", [id]);
  return rows[0].left;
}
async function lapse(id: string) {
  await query("update entry_shares set expires_at = now() - interval '1 second' where id = $1", [id]);
}
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
before(async () => {
  if (!available) {
    // CI installs Postgres for these tests; never let them skip silently there.
    if (process.env.CI) throw new Error("Postgres binaries are required for the share tests in CI");
    return;
  }
  directory = mkdtempSync(join(tmpdir(), "freewrite-share-test-"));
  const data = join(directory, "data");
  const init = spawnSync(tool("initdb"), ["-D", data, "-U", "freewrite", "--auth=trust", "-E", "UTF8", "--no-sync"], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const port = await freePort();
  server = spawn(tool("postgres"), ["-D", data, "-p", String(port), "-k", directory, "-c", "listen_addresses=127.0.0.1", "-c", "fsync=off"], { stdio: "ignore" });
  for (let count = 0; count < 200; count++) {
    if (spawnSync(tool("pg_isready"), ["-h", "127.0.0.1", "-p", String(port)]).status === 0) break;
    await pause(25);
  }
  process.env.DATABASE_URL = `postgres://freewrite@127.0.0.1:${port}/postgres`;
  await query(readFileSync(new URL("../db/migrations/0007_shares.sql", import.meta.url), "utf8"));
});
after(async () => {
  if (!server) return;
  await getPool().end();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
  const done = new Promise((resolve) => server!.once("exit", resolve));
  server.kill("SIGINT");
  await done;
  rmSync(directory, { recursive: true, force: true });
});

integration("default create expires in seven days and keeps the token off the public snapshot", async () => {
  const link = await putEntryShare(snapshot);
  assert.equal(link.ttlSeconds, 7 * DAY);
  assert.ok(Math.abs(link.expiresAt! - (Date.now() + 7 * DAY * 1000)) < 5000);
  assert.equal((await row(link.id)).expires_at, String(link.expiresAt));
  assert.notEqual((await row(link.id)).token_hash, link.token);
  assert.deepEqual(await getEntryShare(link.id), snapshot);
  assert.ok(!("token" in (await getEntryShare(link.id))!));
});

integration("Never is null in records and never expires", async () => {
  const link = await putEntryShare(snapshot, "never");
  assert.equal(link.expiresAt, null);
  assert.equal(link.ttlSeconds, null);
  assert.equal((await row(link.id)).expires_at, null);
  assert.deepEqual(await getEntryShareStatus(link.id, link.token), { result: "ok", expiresAt: null });
  assert.equal(await deleteEntryShare(link.id, link.token), "ok");
  assert.equal(await getEntryShare(link.id), null);
});

integration("expiry changes preserve the snapshot, including empty drawing arrays", async () => {
  const withDrawing = { ...snapshot, sketches: [blankSketch("aaaa11")] };
  const link = await putEntryShare(withDrawing, "30d");
  const publicBefore = await getEntryShare(link.id);
  assert.deepEqual(await changeEntryShareExpiry(link.id, link.token, "never"), { result: "ok", expiresAt: null });
  assert.equal((await row(link.id)).expires_at, null);
  assert.deepEqual(await getEntryShare(link.id), publicBefore);
  assert.deepEqual((await row(link.id)).snapshot.sketches, withDrawing.sketches);
  const timed = await changeEntryShareExpiry(link.id, link.token, "7d");
  assert.equal(timed.result, "ok");
  assert.ok(Math.abs(timed.expiresAt! - (Date.now() + 7 * DAY * 1000)) < 5000);
  assert.ok(Math.abs((await secondsLeft(link.id))! - 7 * DAY) <= 5);
});

integration("updating an entry preserves its remaining lifetime instead of restarting it", async () => {
  const link = await putEntryShare(snapshot, "30d");
  await query("update entry_shares set expires_at = now() + interval '300 seconds' where id = $1", [link.id]);
  const next = { ...snapshot, content: "Updated", sharedAt: 3000 };
  const result = await updateEntryShare(link.id, link.token, next);
  assert.equal(result.result, "ok");
  assert.ok(result.expiresAt! <= Date.now() + 300_000);
  assert.ok((await secondsLeft(link.id))! <= 300);
  assert.deepEqual(await getEntryShare(link.id), next);
});

integration("updating a Never entry keeps it permanent", async () => {
  const link = await putEntryShare(snapshot, "never");
  const result = await updateEntryShare(link.id, link.token, { ...snapshot, content: "Updated" });
  assert.deepEqual(result, { result: "ok", expiresAt: null });
  assert.equal((await row(link.id)).expires_at, null);
});

integration("unauthorized tokens cannot check, update, change expiry, or revoke", async () => {
  const link = await putEntryShare(snapshot);
  const wrong = "xxxxxxxxxxxxxxxxxxxxxx";
  assert.equal((await getEntryShareStatus(link.id, wrong)).result, "denied");
  assert.equal((await updateEntryShare(link.id, wrong, snapshot)).result, "denied");
  assert.equal((await changeEntryShareExpiry(link.id, wrong, "never")).result, "denied");
  assert.equal(await deleteEntryShare(link.id, wrong), "denied");
  assert.equal(await deleteEntryShare(link.id, "bad"), "denied");
  assert.deepEqual(await getEntryShare(link.id), snapshot);
});

integration("expired or deleted links cannot be renewed or recreated", async () => {
  for (const mode of ["delete", "expiry"] as const) {
    const link = await putEntryShare(snapshot, "never");
    if (mode === "delete") assert.equal(await deleteEntryShare(link.id, link.token), "ok");
    else await lapse(link.id);
    assert.equal(await getEntryShare(link.id), null);
    assert.equal((await getEntryShareStatus(link.id, link.token)).result, "missing");
    assert.equal((await updateEntryShare(link.id, link.token, snapshot, "never")).result, "missing");
    assert.equal((await changeEntryShareExpiry(link.id, link.token, "never")).result, "missing");
    assert.equal(await deleteEntryShare(link.id, link.token), "missing");
    await assert.rejects(putEntryShare(snapshot, "never", link), { status: 410 });
    assert.equal(await getEntryShare(link.id), null);
    assert.equal((await row(link.id)).snapshot, null);
  }
});

integration("a lost create response can be retried with the durable capability", async () => {
  const capability = { id: randomBytes(16).toString("base64url"), token: randomBytes(16).toString("base64url") };
  const first = await putEntryShare(snapshot, "never", capability);
  const recovered = await putEntryShare({ ...snapshot, content: "New local edits" }, "7d", capability);
  assert.deepEqual(recovered, first);
  assert.deepEqual(await getEntryShare(first.id), snapshot);
  await assert.rejects(putEntryShare(snapshot, "never", { ...capability, token: "xxxxxxxxxxxxxxxxxxxxxx" }), { status: 403 });
});

integration("revoking an unconfirmed create prevents a late first POST", async () => {
  const capability = { id: randomBytes(16).toString("base64url"), token: randomBytes(16).toString("base64url") };
  assert.equal(await deleteEntryShare(capability.id, capability.token), "missing");
  await assert.rejects(putEntryShare(snapshot, "never", capability), { status: 410 });
  assert.equal(await deleteEntryShare(capability.id, "xxxxxxxxxxxxxxxxxxxxxx"), "denied");
  assert.equal(await getEntryShare(capability.id), null);
});

integration("status recovers an uncertain expiry change without publishing edits", async () => {
  const link = await putEntryShare(snapshot, "7d");
  await changeEntryShareExpiry(link.id, link.token, "never");
  assert.deepEqual(await getEntryShareStatus(link.id, link.token), { result: "ok", expiresAt: null });
  assert.deepEqual(await getEntryShare(link.id), snapshot);
});

integration("new links are limited per address per hour, and the window resets", async () => {
  const ip = "rate-limit-test";
  for (let count = 0; count < 60; count++) assert.equal(await allowShare(ip), true);
  assert.equal(await allowShare(ip), false);
  await query("update share_rate_limits set window_start = now() - interval '61 minutes' where ip = $1", [ip]);
  assert.equal(await allowShare(ip), true);
});

integration("unknown-id retirement is rate limited without blocking existing-link revocation", async () => {
  const ip = "tombstone-limit-test";
  await query("insert into share_rate_limits (ip, window_start, count) values ($1, now(), 60)", [ip]);
  const unknown = { id: randomBytes(16).toString("base64url"), token: randomBytes(16).toString("base64url") };
  assert.equal(await deleteEntryShare(unknown.id, unknown.token, ip), "limited");
  assert.equal(await row(unknown.id), undefined);
  const link = await putEntryShare(snapshot, "never");
  assert.equal(await deleteEntryShare(link.id, link.token, ip), "ok");
  assert.equal(await deleteEntryShare(link.id, link.token, ip), "missing");
});

integration("temporary reader snapshots expire after thirty minutes by default", async () => {
  const original = process.env.SHARE_TTL_SECONDS;
  delete process.env.SHARE_TTL_SECONDS;
  try {
    const link = await putShare("Reader article");
    assert.equal(link.ttlSeconds, 1800);
    assert.equal(await getShare(link.id), "Reader article");
    const { rows } = await query("select extract(epoch from expires_at - now())::int as left from reader_shares where id = $1", [link.id]);
    assert.ok(rows[0].left > 1790 && rows[0].left <= 1800);
    await query("update reader_shares set expires_at = now() - interval '1 second' where id = $1", [link.id]);
    assert.equal(await getShare(link.id), null);
  } finally {
    if (original !== undefined) process.env.SHARE_TTL_SECONDS = original;
  }
});

integration("the sweep removes lapsed content but keeps entry ids retired", async () => {
  const timed = await putEntryShare(snapshot, "7d");
  const live = await putEntryShare(snapshot, "never");
  await lapse(timed.id);
  const reader = await putShare("Reader article");
  await query("update reader_shares set expires_at = now() - interval '1 second' where id = $1", [reader.id]);
  await query("insert into share_rate_limits (ip, window_start, count) values ('sweep-test', now() - interval '2 hours', 5)");

  const swept = await purgeExpiredShares();
  assert.ok(swept.entries >= 1 && swept.snapshots >= 1);
  assert.equal((await row(timed.id)).snapshot, null);
  assert.deepEqual(await getEntryShare(live.id), snapshot);
  assert.equal((await query("select 1 from reader_shares where id = $1", [reader.id])).rowCount, 0);
  assert.equal((await query("select 1 from share_rate_limits where ip = 'sweep-test'")).rowCount, 0);
  await assert.rejects(putEntryShare(snapshot, "7d", timed), { status: 410 });
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

integration("a Never link can be checked, updated, re-timed and revoked through the link controls", async () => {
  const { link, body } = await createLink("never");
  assert.deepEqual(body, { ...link, ttlSeconds: null, expiresAt: null });

  // Check link, then again as after a reload: both confirm Never.
  for (let check = 0; check < 2; check++) {
    assert.deepEqual(await linkRequest("GET", link), { status: 200, body: { expiresAt: null } });
  }
  const shared = await getEntryShare(link.id);
  assert.equal(shared!.content, entryBody.content);
  assert.ok(!("token" in shared!));

  assert.deepEqual(await linkRequest("PUT", link, { ...entryBody, content: "Updated" }), { status: 200, body: { expiresAt: null } });
  assert.equal((await getEntryShare(link.id))!.content, "Updated");

  const timed = await linkRequest("PATCH", link, { expiresIn: "7d" });
  assert.equal(timed.status, 200);
  assert.ok(Math.abs(timed.body.expiresAt - (Date.now() + 7 * DAY * 1000)) < 5000);
  const checked = await linkRequest("GET", link);
  assert.equal(checked.status, 200);
  assert.ok(Math.abs(checked.body.expiresAt - timed.body.expiresAt) < 1000);

  assert.deepEqual(await linkRequest("PATCH", link, { expiresIn: "never" }), { status: 200, body: { expiresAt: null } });
  assert.equal((await row(link.id)).expires_at, null);

  assert.deepEqual(await linkRequest("DELETE", link), { status: 200, body: { ok: true } });
  assert.equal((await linkRequest("GET", link)).status, 410);
  assert.equal(await getEntryShare(link.id), null);
});

integration("database failures answer 502 and log the reason", async () => {
  const { link } = await createLink("never");
  const logged = mock.method(console, "error", () => {});
  const failing = mock.method(getPool(), "query", async () => { throw new Error("simulated database failure"); });
  try {
    for (const method of ["GET", "PUT", "PATCH", "DELETE"] as const) {
      const response = await linkRequest(method, link, method === "PUT" ? entryBody : method === "PATCH" ? { expiresIn: "never" } : undefined);
      assert.equal(response.status, 502);
      assert.ok(!JSON.stringify(response.body).includes("simulated"));
    }
    const { POST } = await import("../app/api/share/entry/route.ts");
    const created = await POST(new Request("http://share.test/api/share/entry", { method: "POST", headers: client, body: JSON.stringify(entryBody) }));
    assert.equal(created.status, 502);
  } finally {
    failing.mock.restore();
    logged.mock.restore();
  }
  assert.equal(logged.mock.callCount(), 5);
  for (const call of logged.mock.calls) {
    assert.match(String(call.arguments[1]), /simulated database failure/);
    assert.ok(!call.arguments.map(String).join(" ").includes(link.token));
  }
  assert.deepEqual(await linkRequest("GET", link), { status: 200, body: { expiresAt: null } });
});

integration("the sweep runs only for Vercel Cron's secret", async () => {
  const { GET } = await import("../app/api/cron/shares/route.ts");
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-cron-secret";
  try {
    assert.equal((await GET(new Request("http://share.test/api/cron/shares"))).status, 401);
    const swept = await GET(new Request("http://share.test/api/cron/shares", { headers: { authorization: "Bearer test-cron-secret" } }));
    assert.equal(swept.status, 200);
    assert.deepEqual(Object.keys(await swept.json()).sort(), ["entries", "snapshots"]);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});
