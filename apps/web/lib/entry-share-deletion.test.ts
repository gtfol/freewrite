import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteEntry, getEntry, getEntryRaw, putEntry } from "./db.ts";
import { deleteSharedEntry } from "./shares.ts";
import type { Entry } from "./types.ts";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
test("shared-entry deletion covers the durable tombstone, which blocks stale editor publication", async () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
  try {
    const entry: Entry = { id: "deleted-share-source", content: "Original", createdAt: 1, updatedAt: 1, deletedAt: null };
    await putEntry(entry);
    await deleteSharedEntry(entry.id, () => deleteEntry(entry.id));
    assert.equal(await getEntry(entry.id), undefined);
    assert.ok((await getEntryRaw(entry.id))!.deletedAt);
    // A save queued by another tab before the deletion must not revive it.
    await putEntry({ ...entry, content: "Stale tab edit", updatedAt: Date.now() });
    assert.equal(await getEntry(entry.id), undefined);
    assert.equal((await getEntryRaw(entry.id))!.content, "");
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
