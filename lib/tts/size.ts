// Sizing and unit formatting for the storage line.
//
// Separate from store.ts because this is the half of the cache that can be
// measured without touching IndexedDB at all: manifests mirror each chunk's
// `bytes`, so an audiobook is sized without reading a single Opus payload
// back out.

import type { Audiobook } from "@/lib/tts/types";

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

export interface AudioSizes {
  audioBytes: number;
  // What a cache clear would actually reclaim. Downloads are pinned and never
  // counted: clearing the cache must not cost someone the article they saved
  // for a flight.
  clearableBytes: number;
  books: number;
  pinned: number;
}

export function bookBytes(book: Audiobook): number {
  return book.chunks.reduce((sum, chunk) => sum + (chunk.bytes ?? 0), 0);
}

export function audioSizes(books: Audiobook[]): AudioSizes {
  const sizes: AudioSizes = {
    audioBytes: 0,
    clearableBytes: 0,
    books: books.length,
    pinned: 0,
  };
  for (const book of books) {
    const bytes = bookBytes(book);
    sizes.audioBytes += bytes;
    if (book.pinned) sizes.pinned += 1;
    else sizes.clearableBytes += bytes;
  }
  return sizes;
}

// One unit, no decimals below a gigabyte. This is a number someone glances at
// to decide whether to press Clear, not an accounting figure.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  // Anything actually stored rounds up rather than away — "0 KB" beside a
  // Clear button reads as a bug rather than as a small cache.
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / KB))} KB`;
  const mb = Math.round(bytes / MB);
  // Rounding can land on 1024 just under the boundary, and "1024 MB" is a
  // worse thing to print than "1.0 GB".
  if (mb < 1024) return `${mb} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}
