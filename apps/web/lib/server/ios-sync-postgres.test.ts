import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { createIOSAuth } from "./ios-auth.ts";
import { pushEntry } from "./entry-sync.ts";
import type { Entry } from "../types.ts";

const dirs = existsSync("/usr/lib/postgresql") ? readdirSync("/usr/lib/postgresql").reverse().map(v => `/usr/lib/postgresql/${v}/bin`) : [];
const bin = [process.env.PG_BIN, ...dirs].find(dir => dir && existsSync(join(dir, "initdb")));
const available = process.getuid?.() !== 0 && (bin || spawnSync("initdb", ["--version"]).status === 0);
const tool = (name: string) => bin ? join(bin, name) : name;
const hash = (e: Entry) => createHash("sha256").update(JSON.stringify([e.content, e.deletedAt ? 1 : 0])).digest("hex");

test("native and web entry sync share revisions, conflicts, deletions and account boundaries", { skip: !available && !process.env.CI }, async () => {
  assert.ok(available, "Postgres binaries are required in CI");
  const directory = mkdtempSync(join(tmpdir(), "fw-ios-sync-"));
  const data = join(directory, "data");
  let started = false;
  const pool = new Pool({ host: directory, user: "freewrite", database: "postgres" });
  const run = (name: string, args: string[]) => {
    const result = spawnSync(tool(name), args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    run("initdb", ["-D", data, "-U", "freewrite", "--auth=trust", "-E", "UTF8", "--no-sync"]);
    run("pg_ctl", ["-D", data, "-l", join(directory, "postgres.log"), "-o", `-k ${directory} -c listen_addresses='' -c fsync=off`, "-w", "start"]);
    started = true;
    await pool.query(readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8"));
    const tokens = { alice: `freewrite_${"a".repeat(43)}`, bob: `freewrite_${"b".repeat(43)}` };
    for (const [id, token] of Object.entries(tokens)) {
      await pool.query('insert into "user"(id,name,email) values ($1,$1,$2)', [id, `${id}@example.test`]);
      await pool.query('insert into "session"(id,"userId",token,"expiresAt") values ($1,$1,$2,now()+interval \'1 day\')', [id, `ios:${createHash("sha256").update(token).digest("hex")}`]);
    }
    const handler = createIOSAuth(pool, async () => null);
    const sync = (owner: "alice" | "bob", since: number, changes: unknown[] = []) => handler(new Request("https://freewrite.gtfol.dev/api/ios/sync", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens[owner]}` }, body: JSON.stringify({ since, changes }),
    }), "sync");
    const client = await pool.connect();
    const entries: Entry[] = Array.from({ length: 12 }, (_, i) => ({ id: randomUUID(), content: `archived writing ${i}`, createdAt: 1700000000000 + i, updatedAt: 1700000000000 + i, deletedAt: null }));
    try {
      for (const record of entries) await pushEntry(client, "alice", { record, baseRev: 0, hash: hash(record) });
      const first = await (await sync("alice", 0)).json();
      assert.equal(first.rows.length, 10); assert.equal(first.hasMore, true);
      assert.deepEqual(first.rows[0].record, entries[0]);
      const second = await (await sync("alice", first.cursor)).json();
      assert.equal(second.rows.length, 2); assert.equal(second.hasMore, false);
      assert.deepEqual((await (await sync("bob", 0)).json()).rows, []);
      const phoneEdit = { ...entries[0], content: "phone says 👋 / 中文\nsecond line", updatedAt: 1800000000000 };
      const uploaded = await (await sync("alice", second.cursor, [{ record: phoneEdit, baseRev: first.rows[0].rev }])).json();
      assert.equal(uploaded.results[0].status, "ok");
      assert.equal(uploaded.results[0].hash, hash(phoneEdit));
      assert.equal((await pool.query("select content from entries where id=$1", [phoneEdit.id])).rows[0].content, phoneEdit.content);
      const webEdit = { ...phoneEdit, content: "new web edit" };
      const webResult = await pushEntry(client, "alice", { record: webEdit, baseRev: uploaded.results[0].rev, hash: hash(webEdit) });
      assert.equal(webResult.status, "ok");
      const conflict = await (await sync("alice", uploaded.cursor, [{ record: { ...phoneEdit, content: "offline phone edit" }, baseRev: uploaded.results[0].rev }])).json();
      assert.equal(conflict.results[0].status, "conflict");
      assert.equal(conflict.results[0].server.record.content, "new web edit");
      const deleted = { ...webEdit, content: "", deletedAt: 1800000000100 };
      const removed = await (await sync("alice", conflict.cursor, [{ record: deleted, baseRev: conflict.results[0].server.rev }])).json();
      assert.equal(removed.results[0].hash, hash(deleted));
      assert.equal(removed.rows[0].record.deletedAt, deleted.deletedAt);
      const replay = await (await sync("alice", removed.cursor, [{ record: deleted, baseRev: conflict.results[0].server.rev }])).json();
      assert.equal(replay.results[0].rev, removed.results[0].rev);
      const collision = await (await sync("bob", 0, [{ record: { ...phoneEdit, content: "wrong account" }, baseRev: 0 }])).json();
      assert.deepEqual(collision.rows, []);
      assert.equal((await pool.query("select content from entries where id=$1", [phoneEdit.id])).rows[0].content, "");
      // Escaped text grows in JSON: page by bytes as well as record count.
      for (let i = 0; i < 5; i++) {
        const record: Entry = { id: randomUUID(), content: "\n".repeat(500_000), createdAt: i, updatedAt: i, deletedAt: null };
        await pushEntry(client, "bob", { record, baseRev: 0, hash: hash(record) });
      }
      const largeResponse = await sync("bob", 0);
      const largeText = await largeResponse.text();
      assert.ok(Buffer.byteLength(largeText) < 4_000_000);
      const largePage = JSON.parse(largeText);
      assert.equal(largePage.rows.length, 3); assert.equal(largePage.hasMore, true);
      const remaining = await (await sync("bob", largePage.cursor)).json();
      assert.equal(remaining.rows.length, 2); assert.equal(remaining.hasMore, false);
      await pool.query('update "session" set "expiresAt"=now()-interval \'1 second\' where id=\'alice\'');
      assert.equal((await sync("alice", 0)).status, 401);
    } finally { client.release(); }
  } finally {
    await pool.end();
    if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(directory, { recursive: true, force: true });
  }
});
