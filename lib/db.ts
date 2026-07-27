import type { Article, Entry } from "@/lib/types";

const DB_NAME = "freewrite";
const DB_VERSION = 1;

const ENTRIES = "entries";
const ARTICLES = "articles";

let dbPromise: Promise<IDBDatabase> | null = null;

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

async function remove(store: string, id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  await requestToPromise(tx.objectStore(store).delete(id));
}

export async function listEntries(): Promise<Entry[]> {
  const entries = await getAll<Entry>(ENTRIES);
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

export const getEntry = (id: string) => get<Entry>(ENTRIES, id);
export const putEntry = (entry: Entry) => put(ENTRIES, entry);
export const deleteEntry = (id: string) => remove(ENTRIES, id);

export async function listArticles(): Promise<Article[]> {
  const articles = await getAll<Article>(ARTICLES);
  return articles.sort((a, b) => b.savedAt - a.savedAt);
}

export const getArticle = (id: string) => get<Article>(ARTICLES, id);
export const putArticle = (article: Article) => put(ARTICLES, article);
export const deleteArticle = (id: string) => remove(ARTICLES, id);
