// Device-local audio cache.
//
// Chunks are content-addressed, so the unit of storage is a sentence rather
// than an article: trimming a paragraph invalidates only the sentences it
// contained, a Restore re-hits the originals instantly, and a sentence that
// appears in two articles is stored once.
//
// Nothing in here touches the sync outbox. See lib/db.ts.

import {
  AUDIO,
  AUDIOBOOKS,
  listArticlesRaw,
  localDeleteMany,
  localGet,
  localGetAll,
  localKeys,
  localPut,
} from "@/lib/db";
import type { AudioRecord, Audiobook } from "@/lib/tts/types";

// Soft ceiling for generated audio. At ~3KB/s of Opus this is many hours of
// listening, and eviction is by least-recently-played so the articles you
// actually return to survive.
const BUDGET_BYTES = 400 * 1024 * 1024;
// Never claim more than this share of what the origin still has available,
// whatever the budget says — the writing side of the app must never fail to
// save an entry because the reader filled the disk.
const QUOTA_SHARE = 0.5;

export const getAudiobook = (articleId: string) =>
  localGet<Audiobook>(AUDIOBOOKS, articleId);

export const putAudiobook = (book: Audiobook) =>
  localPut<Audiobook>(AUDIOBOOKS, book);

export const getChunk = (key: string) => localGet<AudioRecord>(AUDIO, key);

export const putChunk = (record: AudioRecord) =>
  localPut<AudioRecord>(AUDIO, record);

export async function deleteAudiobook(articleId: string): Promise<void> {
  await localDeleteMany(AUDIOBOOKS, [articleId]);
  await collectGarbage();
}

// Which of these chunks are already synthesized — the resume path after a
// reload, and what lets a re-listen start instantly.
export async function cachedKeys(keys: string[]): Promise<Set<string>> {
  const present = new Set(await localKeys(AUDIO));
  return new Set(keys.filter((key) => present.has(key)));
}

function bookBytes(book: Audiobook): number {
  return book.chunks.reduce((sum, chunk) => sum + (chunk.bytes ?? 0), 0);
}

async function budget(): Promise<number> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return BUDGET_BYTES;
  }
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    const free = Math.max(0, quota - usage);
    return Math.max(0, Math.min(BUDGET_BYTES, free * QUOTA_SHARE));
  } catch {
    return BUDGET_BYTES;
  }
}

// Asks the browser not to evict us under storage pressure. Best-effort: the
// answer depends on engagement heuristics we don't control, and a "no" only
// means the cache is ordinary rather than durable.
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export interface StorageReport {
  bytes: number;
  books: number;
  pinned: number;
}

export async function storageReport(): Promise<StorageReport> {
  const books = await localGetAll<Audiobook>(AUDIOBOOKS);
  return {
    bytes: books.reduce((sum, book) => sum + bookBytes(book), 0),
    books: books.length,
    pinned: books.filter((book) => book.pinned).length,
  };
}

// Three passes, cheapest first:
//   1. manifests whose article is gone
//   2. chunks no manifest still points at (covers trims and voice switches)
//   3. least-recently-played unpinned manifests, until under budget
//
// Sizing reads only manifests — chunk payloads are never loaded back out.
export async function collectGarbage(): Promise<void> {
  const books = await localGetAll<Audiobook>(AUDIOBOOKS);
  const articles = await listArticlesRaw();
  const alive = new Set(
    articles.filter((article) => !article.deletedAt).map((article) => article.id)
  );

  const orphanedBooks = books.filter((book) => !alive.has(book.articleId));
  let kept = books.filter((book) => alive.has(book.articleId));

  const limit = await budget();
  let total = kept.reduce((sum, book) => sum + bookBytes(book), 0);

  if (total > limit) {
    // A download is a promise that the audio will be there later, so pinned
    // books are never evicted — only explicit deletion removes them.
    const evictable = kept
      .filter((book) => !book.pinned)
      .sort((a, b) => a.lastPlayedAt - b.lastPlayedAt);

    const evicted = new Set<string>();
    for (const book of evictable) {
      if (total <= limit) break;
      evicted.add(book.articleId);
      total -= bookBytes(book);
    }
    if (evicted.size > 0) {
      orphanedBooks.push(...kept.filter((book) => evicted.has(book.articleId)));
      kept = kept.filter((book) => !evicted.has(book.articleId));
    }
  }

  if (orphanedBooks.length > 0) {
    await localDeleteMany(
      AUDIOBOOKS,
      orphanedBooks.map((book) => book.articleId)
    );
  }

  const reachable = new Set(kept.flatMap((book) => book.chunks.map((c) => c.key)));
  const stored = await localKeys(AUDIO);
  const unreachable = stored.filter((key) => !reachable.has(key));
  if (unreachable.length > 0) await localDeleteMany(AUDIO, unreachable);
}
