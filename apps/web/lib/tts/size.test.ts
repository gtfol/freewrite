// The storage line is only worth showing if its numbers are right, and both
// halves of it are pure: sizing reads manifests, formatting reads bytes. Same
// runner as timing.test.ts — the module under test imports only types.
//
//   npm test

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  audioSizes,
  bookBytes,
  formatBytes,
  sliceWidths,
  storageSlices,
} from "./size.ts";
import type { Audiobook, StoredChunk } from "./types.ts";

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

test("bookBytes sums the manifest rather than the audio store", () => {
  assert.equal(bookBytes(book({ bytes: [1000, 2000, 3000] })), 6000);
});

// Chunks generated before their encode lands carry a null size. Counting them
// as NaN would poison the whole report.
test("bookBytes treats an unsized chunk as nothing yet", () => {
  assert.equal(bookBytes(book({ bytes: [1000, null, 3000] })), 4000);
  assert.equal(bookBytes(book({ bytes: [] })), 0);
});

test("audioSizes totals every book but only offers the unpinned ones", () => {
  const sizes = audioSizes([
    book({ bytes: [1000], pinned: true }),
    book({ bytes: [2000] }),
    book({ bytes: [4000] }),
  ]);
  assert.equal(sizes.audioBytes, 7000);
  assert.equal(sizes.clearableBytes, 6000);
  assert.equal(sizes.books, 3);
  assert.equal(sizes.pinned, 1);
});

// The distinction the whole UI rests on: a cache clear reclaims nothing when
// every audiobook is a download, and the button says so by staying disabled.
test("audioSizes has nothing to clear when everything is downloaded", () => {
  const sizes = audioSizes([
    book({ bytes: [1000], pinned: true }),
    book({ bytes: [2000], pinned: true }),
  ]);
  assert.equal(sizes.audioBytes, 3000);
  assert.equal(sizes.clearableBytes, 0);
  assert.equal(sizes.pinned, 2);
});

test("audioSizes handles an empty cache", () => {
  assert.deepEqual(audioSizes([]), {
    audioBytes: 0,
    clearableBytes: 0,
    books: 0,
    pinned: 0,
  });
});

test("storageSlices splits audio into what was kept and what wasn't", () => {
  const slices = storageSlices({
    audioBytes: 100 * MB,
    clearableBytes: 40 * MB,
    voiceBytes: 63 * MB,
    usageBytes: 175 * MB,
  });
  assert.deepEqual(
    slices.map((slice) => [slice.key, slice.bytes / MB]),
    [
      ["voices", 63],
      ["downloads", 60],
      ["cache", 40],
      ["other", 12],
    ]
  );
});

// usage is the browser's rounded estimate of the whole origin while our sizes
// are exact, so the subtraction can go negative — and a negative slice would
// render as a bar segment pointing the wrong way.
test("storageSlices never reports a negative remainder", () => {
  const slices = storageSlices({
    audioBytes: 100 * MB,
    clearableBytes: 40 * MB,
    voiceBytes: 63 * MB,
    usageBytes: 4 * MB,
  });
  assert.equal(slices.find((slice) => slice.key === "other")?.bytes, 0);
});

test("storageSlices survives an origin storing nothing at all", () => {
  const slices = storageSlices({
    audioBytes: 0,
    clearableBytes: 0,
    voiceBytes: 0,
    usageBytes: 0,
  });
  assert.deepEqual(slices.map((slice) => slice.bytes), [0, 0, 0, 0]);
});

// The regression this exists to prevent: 61MB stored against a 2GB quota is a
// nearly empty bar. Divided by what is stored rather than what could be, it is
// a full one, which reads as a device out of space next to a line saying 1.9GB
// is free.
test("sliceWidths measures against the quota, not against itself", () => {
  const slices = storageSlices({
    audioBytes: 1 * MB,
    clearableBytes: 1 * MB,
    voiceBytes: 60 * MB,
    usageBytes: 61 * MB,
  });
  const widths = sliceWidths(slices, 2 * GB);
  const filled = widths.reduce((sum, width) => sum + width, 0);
  assert.ok(filled > 2.9 && filled < 3.0, `expected ~2.98%, got ${filled}`);
  assert.ok(widths[0] > widths[2], "voices dominate what little is filled");
});

test("sliceWidths falls back to the composition with no quota to divide by", () => {
  const slices = storageSlices({
    audioBytes: 40 * MB,
    clearableBytes: 40 * MB,
    voiceBytes: 60 * MB,
    usageBytes: 100 * MB,
  });
  const filled = sliceWidths(slices, 0).reduce((sum, w) => sum + w, 0);
  assert.ok(Math.abs(filled - 100) < 0.001, `expected 100%, got ${filled}`);
});

test("sliceWidths returns zeros rather than NaN for an empty origin", () => {
  const slices = storageSlices({
    audioBytes: 0,
    clearableBytes: 0,
    voiceBytes: 0,
    usageBytes: 0,
  });
  assert.deepEqual(sliceWidths(slices, 0), [0, 0, 0, 0]);
});

test("formatBytes picks one unit and no decimals below a gigabyte", () => {
  assert.equal(formatBytes(4 * KB), "4 KB");
  assert.equal(formatBytes(63 * MB), "63 MB");
  assert.equal(formatBytes(124 * MB), "124 MB");
  assert.equal(formatBytes(2 * GB), "2.0 GB");
});

test("formatBytes crosses units on the boundary, not near it", () => {
  assert.equal(formatBytes(MB - 1), "1024 KB");
  assert.equal(formatBytes(MB), "1 MB");
  // Rounding to megabytes lands on 1024 just under the boundary; "1024 MB" is
  // a worse thing to print than "1.0 GB".
  assert.equal(formatBytes(GB - 1), "1.0 GB");
  assert.equal(formatBytes(GB), "1.0 GB");
});

// A few hundred bytes is still something stored, and "0 KB" beside a Clear
// button reads as a bug rather than as a small cache.
test("formatBytes never rounds a non-empty cache away to nothing", () => {
  assert.equal(formatBytes(1), "1 KB");
  assert.equal(formatBytes(400), "1 KB");
  assert.equal(formatBytes(0), "0 KB");
});

test("formatBytes survives a number it should never be handed", () => {
  assert.equal(formatBytes(-1), "0 KB");
  assert.equal(formatBytes(Number.NaN), "0 KB");
});

function book(over: { bytes: (number | null)[]; pinned?: boolean }): Audiobook {
  const chunks: StoredChunk[] = over.bytes.map((bytes, i) => ({
    key: `k${i}`,
    text: "some words here",
    normStart: 0,
    normEnd: 15,
    words: [],
    speech: "some words here.",
    speechWords: [],
    scales: { length: 1, noise: 1, noiseW: 1 },
    rises: [],
    gapAfter: 0,
    duration: 1,
    wordTimes: [],
    bytes,
  }));
  return {
    articleId: "a",
    contentHash: "h",
    voiceId: "piper:en_US-hfc_female-medium",
    engine: "piper",
    model: "piper-voices-1.0",
    chunks,
    pinned: over.pinned ?? false,
    createdAt: 0,
    lastPlayedAt: 0,
  };
}
