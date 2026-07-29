// Word timing is derived, not measured — neither engine exposes phoneme
// durations — so it is the part of the reader most able to drift without
// anything visibly breaking. These run on Node's built-in test runner; both
// modules under test import only types, so they need no DOM and no bundler.
//
//   npm test

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTimeline,
  syllables,
  trimSilence,
  wordIndexAt,
  wordTimes,
} from "./timing.ts";
import type { StoredChunk, WordSpan } from "./types.ts";

test("syllables counts vowel groups", () => {
  assert.equal(syllables("a"), 1);
  assert.equal(syllables("cat"), 1);
  assert.equal(syllables("idea"), 2);
  assert.equal(syllables("reader"), 2);
  assert.equal(syllables("sentence"), 2);
  assert.equal(syllables("paragraph"), 3);
});

// Documents the heuristic's known blind spot rather than pretending it away:
// vowels adjacent across a syllable boundary count once. Splitting them would
// break "-tion" words, which are far more common than these.
test("syllables undercounts hiatus pairs, by design", () => {
  assert.equal(syllables("audiobook"), 3); // au-di-o-book is really four
  assert.equal(syllables("nation"), 2); // and this one is correct at two
  assert.equal(syllables("station"), 2);
});

test("syllables drops a silent terminal e, but not a spoken one", () => {
  assert.equal(syllables("time"), 1);
  assert.equal(syllables("make"), 1);
  // "le" endings carry their own syllable.
  assert.equal(syllables("table"), 2);
  assert.equal(syllables("little"), 2);
  // A lone vowel group must survive.
  assert.equal(syllables("the"), 1);
  assert.equal(syllables("be"), 1);
  // A vowel before the e is spoken.
  assert.equal(syllables("see"), 1);
});

test("syllables never returns zero, whatever it is handed", () => {
  assert.equal(syllables(""), 1);
  assert.equal(syllables("—"), 1);
  assert.equal(syllables("42"), 1);
  assert.equal(syllables("rhythm"), 1);
});

// The regression this weighting exists to prevent: character counting is
// biased by spelling, so a sentence mixing long one-syllable words with short
// multi-syllable ones accumulates error across its length.
test("weighting follows syllables rather than spelling", () => {
  const text = "Strengths through thoughts, idea idea idea idea.";
  const words = spans(text);
  const audio = tone(2, 24000);
  const times = wordTimes(text, words, 0, audio, 24000);

  const first = times[1] - times[0]; // "Strengths": 9 chars, 1 syllable
  const last = times[6] - times[5]; // "idea": 4 chars, 2 syllables
  assert.ok(
    last > first,
    `two-syllable "idea" (${last.toFixed(3)}s) should outlast one-syllable "Strengths" (${first.toFixed(3)}s)`
  );
});

test("word times stay ordered and inside the chunk", () => {
  const text = "Alpha one is the first sentence, and it runs on a little.";
  const words = spans(text);
  const sampleRate = 24000;
  const audio = tone(2, sampleRate);
  const times = wordTimes(text, words, 0, audio, sampleRate);

  assert.equal(times.length, words.length);
  assert.equal(times[0], 0);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1], `time ${i} must advance`);
  }
  assert.ok(times[times.length - 1] < audio.length / sampleRate);
});

test("word times survive a chunk with a single word", () => {
  const audio = tone(1, 24000);
  const times = wordTimes("Yes", [{ start: 0, end: 3 }], 0, audio, 24000);
  assert.deepEqual(times, [0]);
});

test("punctuation buys time before the next word", () => {
  const sampleRate = 24000;
  const audio = tone(2, sampleRate);
  const plain = "cat cat cat cat";
  const comma = "cat, cat cat cat";

  const gapPlain = wordTimes(plain, spans(plain), 0, audio, sampleRate)[1];
  const gapComma = wordTimes(comma, spans(comma), 0, audio, sampleRate)[1];
  assert.ok(gapComma > gapPlain, "a comma should lengthen the first word's slot");
});

test("trimSilence strips head and tail but keeps the speech", () => {
  const sampleRate = 24000;
  const audio = new Float32Array(sampleRate * 2);
  for (let i = 0; i < audio.length; i++) {
    const t = i / sampleRate;
    audio[i] = t > 0.4 && t < 1.6 ? Math.sin(i * 0.05) * 0.5 : 0;
  }
  const trimmed = trimSilence(audio, sampleRate);
  const seconds = trimmed.length / sampleRate;
  assert.ok(seconds > 1.1 && seconds < 1.3, `expected ~1.2s, got ${seconds}`);
});

test("trimSilence returns empty for pure silence rather than throwing", () => {
  assert.equal(trimSilence(new Float32Array(2400), 24000).length, 0);
});

test("wordIndexAt leads the voice slightly", () => {
  const times = [0, 1, 2];
  // Just before word 1's onset, the lead should already have selected it.
  assert.equal(wordIndexAt(times, 0.95), 1);
  // Well before, it should not.
  assert.equal(wordIndexAt(times, 0.5), 0);
  assert.equal(wordIndexAt(times, 2.5), 2);
});

test("wordIndexAt handles chunks with no timing yet", () => {
  assert.equal(wordIndexAt(null, 1), -1);
  assert.equal(wordIndexAt([], 1), -1);
});

test("buildTimeline accumulates durations and gaps", () => {
  const chunks: StoredChunk[] = [
    chunk({ duration: 2, gapAfter: 700 }),
    chunk({ duration: 3, gapAfter: 260 }),
    chunk({ duration: 1, gapAfter: 0 }),
  ];
  const { starts, total } = buildTimeline(chunks);
  assert.deepEqual(starts, [0, 2.7, 5.96]);
  assert.equal(total, 6.96);
});

test("buildTimeline estimates chunks that aren't generated yet", () => {
  const { total } = buildTimeline([chunk({ duration: null, gapAfter: 0 })]);
  assert.ok(total > 0, "an ungenerated chunk still needs a length");
});

// Word spans over a plain ASCII sentence, matching what Intl.Segmenter
// produces for the cases here without needing it in Node.
function spans(text: string): WordSpan[] {
  const out: WordSpan[] = [];
  const re = /[A-Za-z']+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function tone(seconds: number, sampleRate: number): Float32Array {
  const audio = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < audio.length; i++) audio[i] = Math.sin(i * 0.05) * 0.5;
  return audio;
}

function chunk(over: Partial<StoredChunk>): StoredChunk {
  return {
    key: "k",
    text: "some words here",
    normStart: 0,
    normEnd: 15,
    words: [],
    speech: "some words here.",
    speechWords: [],
    scales: { length: 1, noise: 1, noiseW: 1 },
    gapAfter: 0,
    duration: 1,
    wordTimes: [],
    bytes: 0,
    ...over,
  };
}
