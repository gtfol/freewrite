"use client";

import { create } from "zustand";

import { authClient } from "@/lib/auth-client";
import {
  applyRemoteArticle,
  applyRemoteEntry,
  clearOutboxItem,
  enqueueOutbox,
  getArticleRaw,
  getEntryRaw,
  getSyncMeta,
  listArticlesRaw,
  listEntriesRaw,
  listOutbox,
  listSyncMeta,
  putEntry,
  putSyncMeta,
  setOnLocalChange,
  type Collection,
} from "@/lib/db";
import { createEntry, WELCOME_CONTENT } from "@/lib/entries";
import { articleHash, entryHash, rootDigest } from "@/lib/hash";
import { useWriter } from "@/lib/store";
import type {
  Article,
  Entry,
  ManifestItem,
  SyncChange,
  SyncDigest,
  SyncManifest,
  SyncResponse,
  SyncRow,
} from "@/lib/types";

const CURSORS_KEY = "freewrite:sync-cursors";
const LAST_USER_KEY = "freewrite:sync:last-user";
const RECONCILED_KEY = "freewrite:sync:reconciled:";
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PUSH_BATCH = 100;
const FETCH_BATCH = 200;
const DEBOUNCE_MS = 3_000;
const INTERVAL_MS = 60_000;
const MAX_ROUNDS = 20;

export const SYNC_APPLIED_EVENT = "freewrite:sync-applied";

interface Cursors {
  entries: number;
  articles: number;
}

function loadCursors(userId: string): Cursors {
  try {
    const stored = JSON.parse(localStorage.getItem(CURSORS_KEY) ?? "");
    if (stored?.userId === userId) {
      return { entries: stored.entries ?? 0, articles: stored.articles ?? 0 };
    }
  } catch {
    // fresh cursors
  }
  return { entries: 0, articles: 0 };
}

function saveCursors(userId: string, cursors: Cursors) {
  localStorage.setItem(CURSORS_KEY, JSON.stringify({ userId, ...cursors }));
}

// Entries that have never reached the server and carry nothing worth syncing:
// the pristine welcome guide (each device seeds its own) and empty entries
// (each visit creates one). Once edited — or once synced — they're content.
function isJunkEntry(entry: Entry): boolean {
  return (
    !entry.deletedAt &&
    (entry.content === WELCOME_CONTENT || !entry.content.trim())
  );
}

const conflictStamp = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export type SyncStatus =
  | "loading"
  | "disabled"
  | "signed-out"
  | "idle"
  | "syncing"
  | "error";

interface SyncUser {
  id: string;
  email: string;
}

interface SyncState {
  status: SyncStatus;
  providers: { google: boolean; email: boolean };
  user: SyncUser | null;
  lastSyncAt: number | null;
  error: string | null;
  init: () => Promise<void>;
  refreshSession: () => Promise<void>;
  syncNow: () => Promise<void>;
  signOut: () => Promise<void>;
}

let started = false;
let inFlight = false;
let queued = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

async function recordHash(
  collection: Collection,
  record: Entry | Article
): Promise<string> {
  return collection === "entries"
    ? entryHash(record as Entry)
    : articleHash(record as Article);
}

async function getRaw(
  collection: Collection,
  id: string
): Promise<Entry | Article | undefined> {
  return collection === "entries" ? getEntryRaw(id) : getArticleRaw(id);
}

async function applyRemote(collection: Collection, record: Entry | Article) {
  if (collection === "entries") await applyRemoteEntry(record as Entry);
  else await applyRemoteArticle(record as Article);
}

// Server rows are authoritative for records with no local edits in flight.
// Dirty records keep their local state AND their old base revision — touching
// the meta here would make the next push claim the server's rev as its base,
// silently overwriting the concurrent change instead of surfacing a conflict.
async function applyPulledRow(
  collection: Collection,
  row: SyncRow<Entry> | SyncRow<Article>,
  dirtyKeys: Set<string>
): Promise<boolean> {
  const key = `${collection}:${row.record.id}`;
  const local = await getRaw(collection, row.record.id);

  if (!local) {
    await applyRemote(collection, row.record);
    await putSyncMeta({ key, rev: row.rev, hash: row.hash });
    return true;
  }

  const localHash = await recordHash(collection, local);
  if (localHash === row.hash) {
    await putSyncMeta({ key, rev: row.rev, hash: row.hash });
    return false;
  }
  if (dirtyKeys.has(key)) return false;

  await applyRemote(collection, row.record);
  await putSyncMeta({ key, rev: row.rev, hash: row.hash });
  return true;
}

interface PushItem<T> {
  key: string;
  change: SyncChange<T>;
  snapshotUpdatedAt: number;
}

async function buildPushBatch<T extends Entry | Article>(
  collection: Collection,
  outboxKeys: string[]
): Promise<PushItem<T>[]> {
  const items: PushItem<T>[] = [];
  for (const key of outboxKeys) {
    if (items.length >= PUSH_BATCH) break;
    const id = key.slice(key.indexOf(":") + 1);
    const record = await getRaw(collection, id);
    if (!record) {
      await clearOutboxItem(key);
      continue;
    }
    const meta = await getSyncMeta(key);
    if (collection === "entries" && !meta && isJunkEntry(record as Entry)) {
      await clearOutboxItem(key);
      continue;
    }
    const hash = await recordHash(collection, record);
    if (meta && meta.hash === hash) {
      await clearOutboxItem(key);
      continue;
    }
    items.push({
      key,
      change: { record: record as T, baseRev: meta?.rev ?? 0, hash },
      snapshotUpdatedAt: record.updatedAt,
    });
  }
  return items;
}

async function handleResults<T extends Entry | Article>(
  collection: Collection,
  items: PushItem<T>[],
  results: SyncResponse["entries"]["results"] | SyncResponse["articles"]["results"]
): Promise<boolean> {
  let applied = false;
  const byId = new Map(items.map((i) => [i.change.record.id, i]));

  for (const outcome of results) {
    const item = byId.get(outcome.id);
    if (!item) continue;

    const current = await getRaw(collection, outcome.id);
    const editedMidFlight =
      !current || current.updatedAt !== item.snapshotUpdatedAt;

    if (outcome.status === "ok") {
      await putSyncMeta({
        key: item.key,
        rev: outcome.rev,
        hash: item.change.hash,
      });
      if (!editedMidFlight) await clearOutboxItem(item.key);
      continue;
    }

    // Conflict. If the record changed again mid-flight, leave it queued and
    // resolve on the next round against its newest state.
    if (editedMidFlight) continue;

    if (collection === "entries") {
      const local = current as Entry;
      const server = outcome.server.record as Entry;
      if (!local.deletedAt && local.content.trim() && local.content !== server.content) {
        const copy = createEntry(
          `conflicted copy · ${conflictStamp.format(new Date())}\n\n${local.content}`
        );
        await putEntry(copy);
      }
    }
    await applyRemote(collection, outcome.server.record);
    await putSyncMeta({
      key: item.key,
      rev: outcome.server.rev,
      hash: outcome.server.hash,
    });
    await clearOutboxItem(item.key);
    applied = true;
  }
  return applied;
}

async function fetchRows(ids: {
  entries: string[];
  articles: string[];
}): Promise<{ entries: SyncRow<Entry>[]; articles: SyncRow<Article>[] }> {
  const out = { entries: [] as SyncRow<Entry>[], articles: [] as SyncRow<Article>[] };
  let e = 0;
  let a = 0;
  while (e < ids.entries.length || a < ids.articles.length) {
    const res = await fetch("/api/sync/manifest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: ids.entries.slice(e, e + FETCH_BATCH),
        articles: ids.articles.slice(a, a + FETCH_BATCH),
      }),
    });
    if (!res.ok) throw new Error(`Sync failed (${res.status})`);
    const body = await res.json();
    out.entries.push(...body.entries);
    out.articles.push(...body.articles);
    e += FETCH_BATCH;
    a += FETCH_BATCH;
  }
  return out;
}

// Compares the full local state against the server and heals every kind of
// drift: records that predate sync, lost outbox items, anything missing on
// either side. Root digests make the aligned case a single cheap request.
async function reconcile(user: SyncUser): Promise<boolean> {
  const lastUser = localStorage.getItem(LAST_USER_KEY);
  const pullOnly = Boolean(lastUser && lastUser !== user.id);

  const metaMap = new Map((await listSyncMeta()).map((m) => [m.key, m]));
  const outboxKeys = new Set((await listOutbox()).map((o) => o.key));

  async function localPairs<T extends Entry | Article>(
    collection: Collection,
    records: T[]
  ): Promise<Map<string, { record: T; hash: string }>> {
    const map = new Map<string, { record: T; hash: string }>();
    for (const record of records) {
      const key = `${collection}:${record.id}`;
      if (
        collection === "entries" &&
        !metaMap.has(key) &&
        isJunkEntry(record as Entry)
      ) {
        continue;
      }
      map.set(record.id, { record, hash: await recordHash(collection, record) });
    }
    return map;
  }

  const local = {
    entries: await localPairs("entries", await listEntriesRaw()),
    articles: await localPairs("articles", await listArticlesRaw()),
  };

  const digestRes = await fetch("/api/sync/manifest");
  if (!digestRes.ok) throw new Error(`Sync failed (${digestRes.status})`);
  const digests: SyncDigest = await digestRes.json();

  const localDigest = async (map: Map<string, { hash: string }>) =>
    rootDigest([...map.entries()].map(([id, v]) => ({ id, hash: v.hash })));

  if (
    (await localDigest(local.entries)) === digests.entries.digest &&
    (await localDigest(local.articles)) === digests.articles.digest
  ) {
    return false;
  }

  const manifestRes = await fetch("/api/sync/manifest?full=1");
  if (!manifestRes.ok) throw new Error(`Sync failed (${manifestRes.status})`);
  const manifest: SyncManifest = await manifestRes.json();

  const need = { entries: [] as string[], articles: [] as string[] };
  let applied = false;

  for (const collection of ["entries", "articles"] as const) {
    const serverItems = new Map<string, ManifestItem>(
      manifest[collection].map((m) => [m.id, m])
    );
    const localMap = local[collection];

    for (const [id, s] of serverItems) {
      const key = `${collection}:${id}`;
      const l = localMap.get(id);
      if (!l) {
        need[collection].push(id);
        continue;
      }
      if (l.hash === s.hash) {
        const meta = metaMap.get(key);
        if (!meta || meta.rev !== s.rev || meta.hash !== s.hash) {
          await putSyncMeta({ key, rev: s.rev, hash: s.hash });
        }
        continue;
      }
      if (outboxKeys.has(key)) continue;
      const meta = metaMap.get(key);
      if (meta && meta.rev === s.rev) {
        // Local content moved without an outbox trace (the pre-hash trim bug,
        // storage loss, …) — queue it; the push CAS takes it from here.
        await enqueueOutbox(collection, id);
        continue;
      }
      need[collection].push(id);
    }

    if (!pullOnly) {
      for (const [id] of localMap) {
        if (!serverItems.has(id)) await enqueueOutbox(collection, id);
      }
    }
  }

  if (need.entries.length || need.articles.length) {
    const rows = await fetchRows(need);
    for (const row of rows.entries) {
      if (await applyPulledRow("entries", row, outboxKeys)) applied = true;
    }
    for (const row of rows.articles) {
      if (await applyPulledRow("articles", row, outboxKeys)) applied = true;
    }
  }

  if (!pullOnly) localStorage.setItem(LAST_USER_KEY, user.id);
  return applied;
}

async function ensureReconciled(user: SyncUser): Promise<boolean> {
  const key = RECONCILED_KEY + user.id;
  const last = Number(localStorage.getItem(key) ?? 0);
  if (Date.now() - last < RECONCILE_INTERVAL_MS) return false;
  const applied = await reconcile(user);
  localStorage.setItem(key, String(Date.now()));
  return applied;
}

export const useSync = create<SyncState>()((set, get) => ({
  status: "loading",
  providers: { google: false, email: false },
  user: null,
  lastSyncAt: null,
  error: null,

  init: async () => {
    if (started) return;
    started = true;

    try {
      const res = await fetch("/api/sync/status");
      const status = await res.json();
      if (!status.enabled) {
        set({ status: "disabled" });
        return;
      }
      set({ providers: status.providers });
    } catch {
      set({ status: "disabled" });
      return;
    }

    setOnLocalChange(() => {
      if (!get().user) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void get().syncNow(), DEBOUNCE_MS);
    });
    window.addEventListener("online", () => void get().syncNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void get().syncNow();
    });
    setInterval(() => {
      if (document.visibilityState === "visible") void get().syncNow();
    }, INTERVAL_MS);

    await get().refreshSession();
  },

  refreshSession: async () => {
    try {
      const { data } = await authClient.getSession();
      if (data?.user) {
        set({
          user: { id: data.user.id, email: data.user.email },
          status: "idle",
          error: null,
        });
        void get().syncNow();
      } else {
        set({ user: null, status: "signed-out" });
      }
    } catch {
      set({ user: null, status: "signed-out" });
    }
  },

  syncNow: async () => {
    const { user, status } = get();
    if (!user || status === "disabled" || !navigator.onLine) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    set({ status: "syncing" });

    try {
      let applied = await ensureReconciled(user);
      let cursors = loadCursors(user.id);

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const outbox = await listOutbox();
        const entryItems = await buildPushBatch<Entry>(
          "entries",
          outbox.filter((o) => o.collection === "entries").map((o) => o.key)
        );
        const articleItems = await buildPushBatch<Article>(
          "articles",
          outbox.filter((o) => o.collection === "articles").map((o) => o.key)
        );

        const res = await fetch("/api/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            entries: {
              since: cursors.entries,
              changes: entryItems.map((i) => i.change),
            },
            articles: {
              since: cursors.articles,
              changes: articleItems.map((i) => i.change),
            },
          }),
        });
        if (res.status === 401) {
          set({ user: null, status: "signed-out" });
          return;
        }
        if (!res.ok) throw new Error(`Sync failed (${res.status})`);
        const data: SyncResponse = await res.json();

        if (await handleResults("entries", entryItems, data.entries.results)) {
          applied = true;
        }
        if (await handleResults("articles", articleItems, data.articles.results)) {
          applied = true;
        }

        const dirtyKeys = new Set((await listOutbox()).map((o) => o.key));
        for (const row of data.entries.rows) {
          if (await applyPulledRow("entries", row, dirtyKeys)) applied = true;
        }
        for (const row of data.articles.rows) {
          if (await applyPulledRow("articles", row, dirtyKeys)) applied = true;
        }

        cursors = { entries: data.entries.cursor, articles: data.articles.cursor };
        saveCursors(user.id, cursors);

        const outboxDrained = (await listOutbox()).length === 0;
        if (!data.entries.hasMore && !data.articles.hasMore && outboxDrained) {
          break;
        }
      }

      if (applied) {
        await useWriter.getState().reload();
        window.dispatchEvent(new CustomEvent(SYNC_APPLIED_EVENT));
      }

      set({ status: "idle", lastSyncAt: Date.now(), error: null });
    } catch (error) {
      set({
        status: "error",
        error: error instanceof Error ? error.message : "Sync failed",
      });
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void get().syncNow();
      }
    }
  },

  signOut: async () => {
    await authClient.signOut();
    set({ user: null, status: "signed-out", lastSyncAt: null });
  },
}));
