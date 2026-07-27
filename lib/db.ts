import type { Article, Entry } from "@/lib/types";

const DB_NAME = "freewrite";
const DB_VERSION = 2;

const ENTRIES = "entries";
const ARTICLES = "articles";
const OUTBOX = "outbox";

const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000;

export type Collection = "entries" | "articles";

export interface OutboxItem {
  key: string;
  collection: Collection;
  id: string;
  addedAt: number;
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
      if (!db.objectStoreNames.contains(OUTBOX)) {
        db.createObjectStore(OUTBOX, { keyPath: "key" });
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

export async function putEntry(entry: Entry): Promise<void> {
  await put(ENTRIES, entry);
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
  await put(ARTICLES, article);
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

export async function getEntryRaw(id: string): Promise<Entry | undefined> {
  const entry = await get<Entry>(ENTRIES, id);
  return entry ? normalizeEntry(entry) : undefined;
}

export async function getArticleRaw(id: string): Promise<Article | undefined> {
  const article = await get<Article>(ARTICLES, id);
  return article ? normalizeArticle(article) : undefined;
}

export const applyRemoteEntry = (entry: Entry) => put(ENTRIES, entry);
export const applyRemoteArticle = (article: Article) => put(ARTICLES, article);

export const listOutbox = () => getAll<OutboxItem>(OUTBOX);
export const clearOutboxItem = (key: string) => hardDelete(OUTBOX, key);

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
}
