import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  assertShareStorage, beginEntryShareMutation, canDiscardUnsharedEntry, clearShareRecord, expiresLabel, getShareRecord,
  hasPendingShareRecords, prepareShareRecord, revokeEntryShare, setShareRecord, shareRecordIsSaved,
  type ShareRecord,
} from "./shares.ts";

const key = "freewrite:shares";
const values = new Map<string, string>();
let failRead = false;
let failWrite = false;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalFetch = globalThis.fetch;
const record: ShareRecord = {
  id: "aaaaaaaaaaaaaaaaaaaaaa", token: "bbbbbbbbbbbbbbbbbbbbbb",
  sharedAt: 1000, expiresAt: null, entryUpdatedAt: 1000,
};
beforeEach(() => {
  values.clear();
  failRead = false;
  failWrite = false;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (name: string) => {
        if (failRead) throw new Error("blocked");
        return values.get(name) ?? null;
      },
      setItem: (name: string, value: string) => {
        if (failWrite) throw new Error("quota");
        values.set(name, value);
      },
    },
  });
});
afterEach(() => {
  failRead = false;
  failWrite = false;
  clearShareRecord("entry");
  clearShareRecord("other");
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  globalThis.fetch = originalFetch;
});

test("Never records survive reads, reload-shaped storage and expiry labels", () => {
  setShareRecord("entry", record);
  assert.deepEqual(getShareRecord("entry"), record);
  assert.equal(JSON.parse(values.get(key)!).entry.expiresAt, null);
  assert.equal(expiresLabel(null), "Never");
  assert.equal(hasPendingShareRecords(), false);
});

test("old timed ownership records retain their expiry", () => {
  const legacy = { ...record, expiresAt: Date.now() + 86_400_000 };
  values.set(key, JSON.stringify({ entry: legacy }));
  assert.deepEqual(getShareRecord("entry"), legacy);
  values.set(key, JSON.stringify({ entry: { ...record, expiresAt: Date.now() - 1 } }));
  assert.equal(getShareRecord("entry")!.id, record.id);
});

test("storage preflight fails before publication and never erases existing controls", () => {
  setShareRecord("other", record);
  const original = values.get(key);
  failWrite = true;
  assert.throws(() => assertShareStorage(), /Allow browser storage/);
  assert.equal(values.get(key), original);
  failWrite = false;
  failRead = true;
  assert.throws(() => assertShareStorage(), /Allow browser storage/);
  assert.equal(values.get(key), original);
});

test("a failed save retains the token for retry and revocation", () => {
  failWrite = true;
  assert.throws(() => setShareRecord("entry", record), /Keep this tab open/);
  assert.deepEqual(getShareRecord("entry"), record);
  assert.equal(shareRecordIsSaved("entry"), false);
  assert.equal(hasPendingShareRecords(), true);
  failWrite = false;
  setShareRecord("entry", record);
  assert.equal(shareRecordIsSaved("entry"), true);
  assert.equal(hasPendingShareRecords(), false);
  assert.deepEqual(JSON.parse(values.get(key)!).entry, record);
});

test("malformed expiry is never interpreted as a permanent record", () => {
  values.set(key, JSON.stringify({ entry: { ...record, expiresAt: undefined } }));
  assert.equal(getShareRecord("entry"), null);
  values.clear();
});

test("revocation failure preserves the entry's management capability", async () => {
  setShareRecord("entry", record);
  globalThis.fetch = async () => Response.json({}, { status: 502 });
  await assert.rejects(revokeEntryShare("entry"), /before deleting this entry/);
  assert.deepEqual(getShareRecord("entry"), record);
  globalThis.fetch = async () => { throw new Error("offline"); };
  await assert.rejects(revokeEntryShare("entry"), /Check your connection/);
  assert.deepEqual(getShareRecord("entry"), record);
});

test("successful or already-expired revocation clears ownership only afterwards", async () => {
  for (const status of [200, 410]) {
    setShareRecord("entry", record);
    globalThis.fetch = async (_url, init) => {
      assert.deepEqual(getShareRecord("entry"), record);
      assert.equal(init!.method, "DELETE");
      assert.equal((init!.headers as Record<string, string>)["x-share-token"], record.token);
      return Response.json({}, { status });
    };
    await revokeEntryShare("entry");
    assert.equal(getShareRecord("entry"), null);
  }
});


test("entry deletion waits for an in-flight publication and then revokes it", async () => {
  const complete = beginEntryShareMutation("entry");
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return Response.json({});
  };
  const revoked = revokeEntryShare("entry");
  await Promise.resolve();
  assert.equal(fetched, false);
  setShareRecord("entry", record);
  complete();
  await revoked;
  assert.equal(fetched, true);
  assert.equal(getShareRecord("entry"), null);
});


test("controls are durable before publication and retries reuse the same capability", () => {
  const prepared = prepareShareRecord("entry", 2000, "never");
  assert.equal(prepared.pendingCreate, true);
  assert.equal(prepared.expiresAt, null);
  assert.deepEqual(JSON.parse(values.get(key)!).entry, prepared);
  assert.deepEqual(prepareShareRecord("entry", 3000, "7d"), prepared);
});

test("an elapsed cached date after an uncertain Never change does not skip revocation", async () => {
  const elapsed = { ...record, expiresAt: Date.now() - 1000 };
  setShareRecord("entry", elapsed);
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return Response.json({}); };
  await revokeEntryShare("entry");
  assert.equal(fetched, true);
});

test("a stale delete cannot remove a newer capability's controls", () => {
  setShareRecord("entry", record);
  clearShareRecord("entry", "xxxxxxxxxxxxxxxxxxxxxx");
  assert.deepEqual(getShareRecord("entry"), record);
  assert.throws(() => setShareRecord("entry", { ...record, id: "xxxxxxxxxxxxxxxxxxxxxx" }), /already has a share link/);
  assert.deepEqual(getShareRecord("entry"), record);
});

test("an elapsed ownership record is never overwritten by another create attempt", () => {
  const elapsed = { ...record, expiresAt: Date.now() - 1000 };
  setShareRecord("entry", elapsed);
  assert.deepEqual(prepareShareRecord("entry", 3000, "never"), elapsed);
});


test("a failed local reservation cannot overwrite another tab's durable link", () => {
  failWrite = true;
  assert.throws(() => setShareRecord("entry", record));
  const newer = { ...record, id: "xxxxxxxxxxxxxxxxxxxxxx", token: "yyyyyyyyyyyyyyyyyyyyyy" };
  values.set(key, JSON.stringify({ entry: newer }));
  failWrite = false;
  assert.throws(() => setShareRecord("entry", record), /already has a share link/);
  clearShareRecord("entry", record.id);
  assert.deepEqual(getShareRecord("entry"), newer);
  assert.equal(hasPendingShareRecords(), false);
});


test("saving another entry neither flushes nor loses unrelated pending controls", () => {
  failWrite = true;
  assert.throws(() => setShareRecord("entry", record));
  const newer = { ...record, id: "xxxxxxxxxxxxxxxxxxxxxx", token: "yyyyyyyyyyyyyyyyyyyyyy" };
  values.set(key, JSON.stringify({ entry: newer }));
  failWrite = false;
  setShareRecord("other", record);
  assert.deepEqual(JSON.parse(values.get(key)!).entry, newer);
  assert.equal(shareRecordIsSaved("entry"), false);
  clearShareRecord("entry", record.id);
  assert.deepEqual(getShareRecord("entry"), newer);
});


test("automatic empty-entry cleanup retains shared entries and fails closed on unreadable controls", () => {
  assert.equal(canDiscardUnsharedEntry("entry"), true);
  setShareRecord("entry", { ...record, expiresAt: Date.now() - 1000 });
  assert.equal(canDiscardUnsharedEntry("entry"), false);
  failRead = true;
  assert.equal(canDiscardUnsharedEntry("other"), false);
});
