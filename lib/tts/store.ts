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
import { audioSizes, bookBytes, type AudioSizes } from "@/lib/tts/size";
import type { AudioRecord, Audiobook } from "@/lib/tts/types";
import { VOICE_CACHE_DIR } from "@/lib/tts/voices";

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

// Manifest writes are serialized per article. Switching voice disposes the old
// generator and opens a new one against the same key, and both write; without
// ordering, the disposing generator's write can land last and reinstate the
// voice the reader just left.
const manifestWrites = new Map<string, Promise<unknown>>();

export function putAudiobook(book: Audiobook): Promise<void> {
  const id = book.articleId;
  const pending = (manifestWrites.get(id) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => localPut<Audiobook>(AUDIOBOOKS, book));

  manifestWrites.set(id, pending);
  void pending.catch(() => undefined).then(() => {
    if (manifestWrites.get(id) === pending) manifestWrites.delete(id);
  });
  return pending;
}

export const getChunk = (key: string) => localGet<AudioRecord>(AUDIO, key);

export const putChunk = (record: AudioRecord) =>
  localPut<AudioRecord>(AUDIO, record);

export async function deleteAudiobook(articleId: string): Promise<void> {
  await localDeleteMany(AUDIOBOOKS, [articleId]);
  await collectGarbage();
}

async function estimate(): Promise<{ usage: number; quota: number }> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return { usage: 0, quota: 0 };
  }
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

async function budget(): Promise<number> {
  const { usage, quota } = await estimate();
  // No estimate means no basis to shrink the budget — fall back to it whole
  // rather than to the zero the failed estimate would imply.
  if (quota === 0) return BUDGET_BYTES;
  const free = Math.max(0, quota - usage);
  return Math.max(0, Math.min(BUDGET_BYTES, free * QUOTA_SHARE));
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

export interface StorageReport extends AudioSizes {
  // Voice models live in OPFS rather than IndexedDB and are shared by every
  // article, so they are counted apart from audio: a ~60MB model is the usual
  // answer to "why is this site using 200MB".
  voiceBytes: number;
  // What the origin is using in total, and what it is allowed. Both are
  // browser estimates, deliberately fuzzed to resist fingerprinting, and the
  // quota is a shared ceiling rather than reserved space — the panel says so
  // rather than dressing them up as disk figures.
  usageBytes: number;
  quotaBytes: number;
}

// Measured by walking the directory rather than by asking which voices the
// catalog knows about, so the figure covers a model left behind by a voice
// since removed from the list. That also keeps it honest about the clear
// below, which takes the whole directory.
//
// The engine can't be asked instead: it holds the model sizes, but importing
// it would pull onnxruntime into the page that only wants to print a number.
async function voiceBytes(): Promise<number> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    return 0;
  }
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(VOICE_CACHE_DIR);
    let total = 0;
    for await (const handle of dir.values()) {
      // `kind` doesn't narrow: FileSystemHandle is a base interface rather
      // than a discriminated union of the two handle types.
      if (handle.kind !== "file") continue;
      total += (await (handle as FileSystemFileHandle).getFile()).size;
    }
    return total;
  } catch {
    // No directory yet, or the browser has no OPFS.
    return 0;
  }
}

async function removeVoices(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    return;
  }
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(VOICE_CACHE_DIR, { recursive: true });
  } catch {
    // Nothing there to remove.
  }
}

export async function storageReport(): Promise<StorageReport> {
  const books = await localGetAll<Audiobook>(AUDIOBOOKS);
  const { usage, quota } = await estimate();
  return {
    ...audioSizes(books),
    voiceBytes: await voiceBytes(),
    usageBytes: usage,
    quotaBytes: quota,
  };
}

// Clearing the cache never touches a download. Dropping the unpinned
// manifests is most of it — the chunk sweep below reclaims whatever they were
// the last reference to, and a sentence a downloaded article still points at
// survives. The voice models go with them: they are a cache by the same
// definition, re-fetched on demand and owned by no article, and a Clear that
// left the largest item on the panel behind would not be one.
export async function clearCache(): Promise<void> {
  const books = await localGetAll<Audiobook>(AUDIOBOOKS);
  const unpinned = books
    .filter((book) => !book.pinned)
    .map((book) => book.articleId);
  if (unpinned.length > 0) await localDeleteMany(AUDIOBOOKS, unpinned);
  await collectGarbage();
  await removeVoices();
}

// Deletes rather than unpins: someone reaching for this wants the space back,
// and audio that lingered until the collector next felt pressure would not be
// that.
export async function removeAllDownloads(): Promise<void> {
  const books = await localGetAll<Audiobook>(AUDIOBOOKS);
  const pinned = books
    .filter((book) => book.pinned)
    .map((book) => book.articleId);
  if (pinned.length > 0) await localDeleteMany(AUDIOBOOKS, pinned);
  await collectGarbage();
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
