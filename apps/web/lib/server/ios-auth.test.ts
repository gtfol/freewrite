import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { createIOSAuth, iosAuthorization, iosTokenHash } from "./ios-auth.ts";

const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const state = "s".repeat(43);
const code = "c".repeat(43);
const token = `freewrite_${"t".repeat(43)}`;
const user = { id: "alice", name: "Alice", email: "alice@example.test" };
const request = (operation: string, body?: object, headers: Record<string, string> = {}, method = "POST") => new Request(`https://freewrite.gtfol.dev/api/ios/${operation}`, {
  method, headers: { "content-type": "application/json", ...headers }, ...(body && { body: JSON.stringify(body) }),
});
function fixture() {
  const queries: { sql: string; values?: unknown[] }[] = [];
  let grant: string | null = JSON.stringify({ userId: user.id, sessionId: "web-session", challenge });
  let parent = true; let active = true; let released = 0;
  const query = async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    if (sql.startsWith('select id,value')) return { rows: grant ? [{ id: "grant-id", value: grant }] : [] };
    if (sql.startsWith('select u.id,u.name,u.email from')) return { rows: parent ? [user] : [] };
    if (sql.startsWith('select u.id,u.name,u.email,s.id')) return { rows: active ? [{ ...user, sessionId: "ios-session", expiresAt: new Date("2027-01-01") }] : [] };
    if (sql.startsWith('delete from "verification" where id=')) grant = null;
    return { rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release: () => { released++; } }) } as unknown as Pool;
  return { pool, queries, handler: createIOSAuth(pool, async () => ({ user, session: { id: "web-session" } })),
    revokeParent: () => { parent = false; }, expire: () => { active = false; }, released: () => released };
}

test("authorization accepts only opaque S256 challenge/state and no callback override", () => {
  assert.deepEqual(iosAuthorization({ code_challenge: challenge, state }), { code_challenge: challenge, state });
  assert.equal(iosAuthorization({ code_challenge: [challenge], state }), null);
  assert.equal(iosAuthorization({ code_challenge: challenge, state, redirect_uri: "https://evil.test" }), null);
  assert.equal(iosAuthorization({ code_challenge: "plain", state }), null);
  assert.equal(iosAuthorization({ code_challenge: challenge + "\n", state }), null);
});
test("browser authorization requires same origin, signed-in account, and explicit account match", async () => {
  const f = fixture();
  const values = { code_challenge: challenge, state, expectedUserId: "alice" };
  assert.equal((await f.handler(request("authorize", values), "authorize")).status, 403);
  assert.equal((await f.handler(request("authorize", values, { origin: "https://evil.test" }), "authorize")).status, 403);
  assert.equal((await f.handler(request("authorize", { ...values, expectedUserId: "bob" }, { origin: "https://freewrite.gtfol.dev" }), "authorize")).status, 409);
  assert.equal(f.queries.length, 0);
  const unauthorized = createIOSAuth(f.pool, async () => null);
  assert.equal((await unauthorized(request("authorize", values, { origin: "https://freewrite.gtfol.dev" }), "authorize")).status, 401);
  const response = await f.handler(request("authorize", values, { origin: "https://freewrite.gtfol.dev" }), "authorize");
  const callback = new URL((await response.json()).callbackURL);
  assert.equal(callback.protocol, "dev.gtfol.freewrite:"); assert.equal(callback.host, "auth");
  assert.equal(callback.searchParams.get("state"), state);
  assert.equal(callback.searchParams.has("token"), false);
  const inserted = f.queries.find(q => q.sql.startsWith('insert into "verification"'))!;
  assert.equal(inserted.values![1], `freewrite-ios:${createHash("sha256").update(callback.searchParams.get("code")!).digest("hex")}`);
  assert.ok(!JSON.stringify(inserted.values).includes(callback.searchParams.get("code")!));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
test("exchange verifies PKCE before issuing a hashed credential and consumes the code once", async () => {
  const f = fixture();
  assert.equal((await f.handler(request("exchange", { code, code_verifier: "x".repeat(43) }), "exchange")).status, 400);
  assert.ok(!f.queries.some(q => q.sql.startsWith('insert into "session"')));
  const response = await f.handler(request("exchange", { code, code_verifier: verifier }), "exchange");
  assert.equal(response.status, 200);
  const login = await response.json();
  assert.match(login.token, /^freewrite_[A-Za-z0-9_-]{43}$/); assert.deepEqual(login.user, user);
  const stored = f.queries.find(q => q.sql.startsWith('insert into "session"'))!;
  assert.equal(stored.values![1], `ios:${createHash("sha256").update(login.token).digest("hex")}`);
  assert.ok(!JSON.stringify(f.queries).includes(login.token));
  assert.equal((await f.handler(request("exchange", { code, code_verifier: verifier }), "exchange")).status, 400);
  assert.equal(f.released(), 3);
});
test("revoked browser session cannot be exchanged; browser-origin exchanges are rejected", async () => {
  const f = fixture(); f.revokeParent();
  assert.equal((await f.handler(request("exchange", { code, code_verifier: verifier }), "exchange")).status, 400);
  assert.ok(!f.queries.some(q => q.sql.startsWith('insert into "session"')));
  assert.equal((await f.handler(request("exchange", { code, code_verifier: verifier }, { origin: "https://freewrite.gtfol.dev" }), "exchange")).status, 403);
});
test("native session requires its own bearer credential and rejects expired sessions", async () => {
  const f = fixture();
  assert.equal((await f.handler(request("session", undefined, { cookie: "session=web" }, "GET"), "session")).status, 401);
  assert.throws(() => iosTokenHash(request("session", undefined, { authorization: "Bearer ordinary-web-token" }, "GET")));
  const headers = { authorization: `Bearer ${token}` };
  assert.equal((await f.handler(request("session", undefined, headers, "GET"), "session")).status, 200);
  assert.equal((await f.handler(request("session", undefined, { ...headers, origin: "https://evil.test" }, "GET"), "session")).status, 403);
  f.expire(); assert.equal((await f.handler(request("session", undefined, headers, "GET"), "session")).status, 401);
});
test("sign-out revokes only the presented native session; deletion binds confirmation to the user", async () => {
  const f = fixture(); const headers = { authorization: `Bearer ${token}` };
  assert.equal((await f.handler(request("session", undefined, headers, "DELETE"), "session")).status, 200);
  const removed = f.queries.find(q => q.sql.startsWith('delete from "session"'))!;
  assert.deepEqual(removed.values, ["ios-session", `ios:${createHash("sha256").update(token).digest("hex")}`, "alice"]);
  assert.equal((await f.handler(request("account", { confirmation: "DELETE", expectedUserId: "bob" }, headers, "DELETE"), "account")).status, 409);
  assert.ok(!f.queries.some(q => q.sql.startsWith('delete from "user"')));
  assert.equal((await f.handler(request("account", { confirmation: "DELETE", expectedUserId: "alice" }, headers, "DELETE"), "account")).status, 200);
  assert.deepEqual(f.queries.find(q => q.sql.startsWith('delete from "user"'))!.values, ["alice"]);
});
test("oversized streamed exchange bodies fail before opening a database transaction", async () => {
  const f = fixture();
  assert.equal((await f.handler(request("exchange", { code: "x".repeat(5000), code_verifier: verifier }), "exchange")).status, 413);
  assert.equal(f.queries.length, 0);
});
