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

// Soft ceiling for generated audio. At ~3KB/s of Opus this is many hours of
// listening, and eviction is by least-recently-played so the articles you
// actually return to survive.
const BUDGET_BYTES = 400 * 1024 * 1024;
// Never claim more than this share of what the origin still has available,
// whatever the budget says — the writing side of the app must never fail to
// save an entry because the reader filled the disk.
const QUOTA_SHARE = 0.5;
// Where @diffusionstudio/vits-web keeps the voice models, as one flat OPFS
// directory of `<voiceId>.onnx` and `<voiceId>.onnx.json`.
const VOICE_DIR = "piper";

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

export interface StorageReport extends AudioSizes {
  // Voice models live in OPFS rather than IndexedDB, are shared by every
  // article, and are deliberately outside the audio GC. Reported apart from
  // audio because a ~60MB model is the usual answer to "why is this site
  // using 200MB", and because clearing the cache never touches one.
  voiceBytes: number;
}

// vits-web says which voices are stored but not what they cost, and asking
// huggingface for the sizes would be a network round trip to render a number.
// The models are plain files, so measure them where they sit.
async function voiceBytes(): Promise<number> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    return 0;
  }
  try {
    const vits = await import("@diffusionstudio/vits-web");
    const stored = await vits.stored();
    if (stored.length === 0) return 0;

    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(VOICE_DIR);
    const sizes = await Promise.all(
      stored
        .flatMap((id) => [`${id}.onnx`, `${id}.onnx.json`])
        .map(async (name) => {
          try {
            return (await (await dir.getFileHandle(name)).getFile()).size;
          } catch {
            return 0;
          }
        })
    );
    return sizes.reduce((sum, size) => sum + size, 0);
  } catch {
    // Nothing has been downloaded yet, or the browser has no OPFS.
    return 0;
  }
}

export async function storageReport(): Promise<StorageReport> {
  const books = await localGetAll<Audiobook>(AUDIOBOOKS);
  return { ...audioSizes(books), voiceBytes: await voiceBytes() };
}

// Clearing the cache never touches a download. Dropping the unpinned
// manifests is the whole operation — the chunk sweep below reclaims whatever
// they were the last reference to, and a sentence a downloaded article still
// points at survives it.
export async function clearAudioCache(): Promise<void> {
  const books = await localGetAll<Audiobook>(AUDIOBOOKS);
  const unpinned = books
    .filter((book) => !book.pinned)
    .map((book) => book.articleId);
  if (unpinned.length > 0) await localDeleteMany(AUDIOBOOKS, unpinned);
  await collectGarbage();
}

// Voice models are shared by every article and sit outside the collector, so
// they only ever go on an explicit ask. The next listen downloads them again.
export async function removeVoices(): Promise<void> {
  const vits = await import("@diffusionstudio/vits-web");
  await vits.flush();
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
