import type { Article, Entry, Sketch } from "@/lib/types";

const DB_NAME = "freewrite";
const DB_VERSION = 5;

const ENTRIES = "entries";
const ARTICLES = "articles";
const SKETCHES = "sketches";
const OUTBOX = "outbox";
const SYNCMETA = "syncmeta";

// Device-local stores: generated audio and its manifests. Nothing here ever
// calls markDirty, so none of it reaches the outbox, the manifest, or the
// digest — an audiobook is a cache, not a record, and re-deriving it on
// another device is cheaper than shipping megabytes of Opus around.
export const AUDIO = "audio";
export const AUDIOBOOKS = "audiobooks";
export type LocalStore = typeof AUDIO | typeof AUDIOBOOKS;

const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000;

export type Collection = "entries" | "articles" | "sketches";

export interface OutboxItem {
  key: string;
  collection: Collection;
  id: string;
  addedAt: number;
}

// Last server-confirmed state per record: revision + content hash.
export interface SyncMeta {
  key: string;
  rev: number;
  hash: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let onLocalChange: (() => void) | null = null;

export function setOnLocalChange(fn: (() => void) | null) {
  onLocalChange = fn;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ENTRIES)) {
        db.createObjectStore(ENTRIES, { keyPath: "id" }).createIndex(
          "createdAt",
          "createdAt"
        );
      }
      if (!db.objectStoreNames.contains(ARTICLES)) {
        db.createObjectStore(ARTICLES, { keyPath: "id" }).createIndex(
          "savedAt",
          "savedAt"
        );
      }
      // v5. Drawings used to hang off the entry record; they are their own
      // record now, resolved by the reference in a text rather than owned by
      // one entry. Nothing migrates: an entry carrying the old field keeps it
      // as dead weight until its next write, and the drawing is re-adopted
      // from it on load.
      if (!db.objectStoreNames.contains(SKETCHES)) {
        db.createObjectStore(SKETCHES, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(OUTBOX)) {
        db.createObjectStore(OUTBOX, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(SYNCMETA)) {
        db.createObjectStore(SYNCMETA, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(AUDIO)) {
        db.createObjectStore(AUDIO, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(AUDIOBOOKS)) {
        db.createObjectStore(AUDIOBOOKS, { keyPath: "articleId" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });

  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  return requestToPromise(tx.objectStore(store).getAll() as IDBRequest<T[]>);
}

async function get<T>(store: string, id: string): Promise<T | undefined> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  return requestToPromise(
    tx.objectStore(store).get(id) as IDBRequest<T | undefined>
  );
}

async function put<T>(store: string, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  await requestToPromise(tx.objectStore(store).put(value));
}

async function hardDelete(store: string, id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  await requestToPromise(tx.objectStore(store).delete(id));
}

function normalizeEntry(e: Entry): Entry {
  return { ...e, deletedAt: e.deletedAt ?? null };
}

function normalizeArticle(a: Article): Article {
  return {
    ...a,
    updatedAt: a.updatedAt ?? a.savedAt,
    deletedAt: a.deletedAt ?? null,
  };
}

async function markDirty(collection: Collection, id: string): Promise<void> {
  await put<OutboxItem>(OUTBOX, {
    key: `${collection}:${id}`,
    collection,
    id,
    addedAt: Date.now(),
  });
  onLocalChange?.();
}

export async function listEntries(): Promise<Entry[]> {
  const entries = await getAll<Entry>(ENTRIES);
  return entries
    .map(normalizeEntry)
    .filter((e) => !e.deletedAt)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getEntry(id: string): Promise<Entry | undefined> {
  const entry = await get<Entry>(ENTRIES, id);
  if (!entry) return undefined;
  const normalized = normalizeEntry(entry);
  return normalized.deletedAt ? undefined : normalized;
}

// Stamping here (not at call sites) guarantees every local mutation registers
// as a change — a call site that forgets updatedAt can't silently break sync.
export async function putEntry(entry: Entry): Promise<void> {
  await put(ENTRIES, { ...entry, updatedAt: Date.now() });
  await markDirty("entries", entry.id);
}

export async function deleteEntry(id: string): Promise<void> {
  const current = await get<Entry>(ENTRIES, id);
  if (!current || current.deletedAt) return;
  const now = Date.now();
  await put(ENTRIES, { ...current, content: "", updatedAt: now, deletedAt: now });
  await markDirty("entries", id);
}

export async function listArticles(): Promise<Article[]> {
  const articles = await getAll<Article>(ARTICLES);
  return articles
    .map(normalizeArticle)
    .filter((a) => !a.deletedAt)
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function getArticle(id: string): Promise<Article | undefined> {
  const article = await get<Article>(ARTICLES, id);
  if (!article) return undefined;
  const normalized = normalizeArticle(article);
  return normalized.deletedAt ? undefined : normalized;
}

export async function putArticle(article: Article): Promise<void> {
  await put(ARTICLES, { ...article, updatedAt: Date.now() });
  await markDirty("articles", article.id);
}

export async function deleteArticle(id: string): Promise<void> {
  const current = await get<Article>(ARTICLES, id);
  if (!current || current.deletedAt) return;
  const now = Date.now();
  await put(ARTICLES, {
    ...normalizeArticle(current),
    content: "",
    updatedAt: now,
    deletedAt: now,
  });
  await markDirty("articles", id);
}

function normalizeSketch(s: Sketch): Sketch {
  return { ...s, deletedAt: s.deletedAt ?? null };
}

export async function listSketches(): Promise<Sketch[]> {
  const sketches = await getAll<Sketch>(SKETCHES);
  return sketches.map(normalizeSketch).filter((s) => !s.deletedAt);
}

export async function putSketch(sketch: Sketch): Promise<void> {
  await put(SKETCHES, { ...sketch, updatedAt: Date.now() });
  await markDirty("sketches", sketch.id);
}

export async function deleteSketch(id: string): Promise<void> {
  const current = await get<Sketch>(SKETCHES, id);
  if (!current || current.deletedAt) return;
  const now = Date.now();
  // The strokes go with the tombstone: they are the whole weight of the record,
  // and nothing reads a deleted drawing.
  await put(SKETCHES, {
    ...normalizeSketch(current),
    strokes: [],
    updatedAt: now,
    deletedAt: now,
  });
  await markDirty("sketches", id);
}

export async function getSketchRaw(id: string): Promise<Sketch | undefined> {
  const sketch = await get<Sketch>(SKETCHES, id);
  return sketch ? normalizeSketch(sketch) : undefined;
}

export async function listSketchesRaw(): Promise<Sketch[]> {
  return (await getAll<Sketch>(SKETCHES)).map(normalizeSketch);
}

export async function getEntryRaw(id: string): Promise<Entry | undefined> {
  const entry = await get<Entry>(ENTRIES, id);
  return entry ? normalizeEntry(entry) : undefined;
}

export async function getArticleRaw(id: string): Promise<Article | undefined> {
  const article = await get<Article>(ARTICLES, id);
  return article ? normalizeArticle(article) : undefined;
}

export async function listEntriesRaw(): Promise<Entry[]> {
  return (await getAll<Entry>(ENTRIES)).map(normalizeEntry);
}

export async function listArticlesRaw(): Promise<Article[]> {
  return (await getAll<Article>(ARTICLES)).map(normalizeArticle);
}

export const applyRemoteEntry = (entry: Entry) => put(ENTRIES, entry);
export const applyRemoteArticle = (article: Article) => put(ARTICLES, article);
export const applyRemoteSketch = (sketch: Sketch) => put(SKETCHES, sketch);

export const listOutbox = () => getAll<OutboxItem>(OUTBOX);
export const clearOutboxItem = (key: string) => hardDelete(OUTBOX, key);
export const enqueueOutbox = (collection: Collection, id: string) =>
  markDirty(collection, id);

export const getSyncMeta = (key: string) => get<SyncMeta>(SYNCMETA, key);
export const putSyncMeta = (meta: SyncMeta) => put(SYNCMETA, meta);
export const listSyncMeta = () => getAll<SyncMeta>(SYNCMETA);

// Raw access to the device-local stores, for lib/tts. Deliberately separate
// from the record helpers above: those stamp updatedAt and mark dirty, and
// audio must do neither.
export const localGet = <T>(store: LocalStore, key: string) => get<T>(store, key);
export const localGetAll = <T>(store: LocalStore) => getAll<T>(store);
export const localPut = <T>(store: LocalStore, value: T) => put(store, value);

export async function localKeys(store: LocalStore): Promise<string[]> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  const keys = await requestToPromise(tx.objectStore(store).getAllKeys());
  return keys.map(String);
}

// One transaction for the whole sweep — GC can touch hundreds of chunks.
export async function localDeleteMany(
  store: LocalStore,
  keys: string[]
): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const objectStore = tx.objectStore(store);
  for (const key of keys) objectStore.delete(key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function purgeTombstones(): Promise<void> {
  const cutoff = Date.now() - TOMBSTONE_TTL;
  const dirty = new Set((await listOutbox()).map((o) => o.key));

  for (const e of await getAll<Entry>(ENTRIES)) {
    if (e.deletedAt && e.deletedAt < cutoff && !dirty.has(`entries:${e.id}`)) {
      await hardDelete(ENTRIES, e.id);
    }
  }
  for (const a of await getAll<Article>(ARTICLES)) {
    if (a.deletedAt && a.deletedAt < cutoff && !dirty.has(`articles:${a.id}`)) {
      await hardDelete(ARTICLES, a.id);
    }
  }
  for (const s of await getAll<Sketch>(SKETCHES)) {
    if (s.deletedAt && s.deletedAt < cutoff && !dirty.has(`sketches:${s.id}`)) {
      await hardDelete(SKETCHES, s.id);
    }
  }
}
