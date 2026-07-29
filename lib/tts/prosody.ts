// What Piper is given, and how it is asked to say it.
//
// SSML is not available here, and not for want of the code being present:
// espeak-ng is compiled with its SSML tag table in the wasm, but the entry
// point Piper phonemizes through never turns SSML parsing on. A tag arrives as
// text and is read out loud —
//
//   It was <emphasis level="strong">the only</emphasis> way.
//   ɛ m f ɐ s ˈɪ s   l ˈɛ v ə l   ˈiː k w ə l z …
//
// Capitals are not a lever either: "THE ONLY" and "the only" phonemize
// identically, so there is no shouting a word into prominence.
//
// Two things do reach the model. Punctuation becomes real tokens in the
// phoneme stream — `,` `;` `.` `?` — and espeak re-assigns pitch accent around
// them: "It was, really, the only way" carries a stress mark on "was" that "It
// was really the only way" does not. And the three VITS inference scales are
// per-call inputs rather than properties of the voice, so each sentence can be
// asked for at its own rate and its own degree of variation.
//
// So emphasis is compiled rather than marked up, and the difference between a
// reading and a recital comes from the scales.

import type { Scales, WordSpan } from "./types.ts";

// What a chunk is, as far as delivery is concerned.
export type ChunkRole = "body" | "heading" | "quote" | "list" | "clause";

// Multipliers on the voice's own scales rather than absolute values, so a
// voice tuned slower or breathier than its neighbours keeps its character and
// only ever moves relative to itself.
const ROLE: Record<ChunkRole, Scales> = {
  body: { length: 1, noise: 1, noiseW: 1 },
  // A heading is announced, not read. Slower, and given room to move.
  heading: { length: 1.08, noise: 1.02, noiseW: 1.12 },
  quote: { length: 1.05, noise: 1.04, noiseW: 1.05 },
  list: { length: 0.98, noise: 1, noiseW: 1 },
  // The tail of a sentence that was too long to synthesize whole. It is not a
  // new sentence and must not be delivered as one.
  clause: { length: 0.98, noise: 1, noiseW: 0.95 },
};

// Every sentence asked for at exactly the same rate is most of what "reads
// like a machine" means: real speech varies a few percent either side of its
// own average and never lands twice on the same tempo. These are deliberately
// small — large enough to break the metronome, too small to be heard as a
// sentence that sped up.
const LENGTH_JITTER = 0.035;
// Variation in the duration predictor: how evenly phonemes are timed within
// the sentence. This is the one that reads as flat when it stays put.
const NOISE_W_JITTER = 0.09;

// The shortest emphasis worth isolating. Below this the commas cost more than
// the stress they buy.
const MIN_EMPHASIS_CHARS = 4;
// Sentence needed either side of it. Emphasis at the very start has no word to
// hang the opening comma on, and emphasis at the very end would only duplicate
// the pause the sentence break already provides.
const MIN_CONTEXT_CHARS = 6;

// Ends on something a listener can hear as an ending — allowing for closing
// quotes and brackets after it.
const TERMINATED = /[.!?…:;,—–][\s"'”’)\]]*$/;

// Bumped when the shape of the rise changes, since that changes the audio
// without changing anything else about the plan. Only chunks that carry a rise
// are keyed on it, so a correction here costs the sentences with lists in them
// rather than every sentence anyone has ever generated — which matters most to
// the reader who downloaded an article to listen to somewhere with no network.
//
// 2: the rise was being placed by loudness, which put it over the fricative an
//    item ends on. WSOLA has no pitch periods to splice on there, so it came
//    out as a short metallic burst. Now placed by periodicity. See pitch.ts.
export const RISE_REVISION = 2;

// A coordinated series needs at least this many items before the rise is worth
// having. Two items joined by "and" usually carry no comma at all.
const MIN_SERIES_ITEMS = 3;
// Items in a series are short. The cap is what keeps a sentence that merely
// has commas in it — subordinate clauses, a parenthetical aside — from being
// read as a list.
const MAX_ITEM_CHARS = 60;
// The coordinator before the final item is the thing that makes a series a
// series. An appositive ("My brother, a doctor, arrived late") has none, which
// is exactly why it must not get list intonation.
const COORDINATOR = /(^|[\s(])(and|or|nor|plus)([\s,)]|$)/i;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// Three decimals, because the value goes into the chunk key: a scale that
// serialized as 1.0800000000000001 on one engine and 1.08 on another would
// re-synthesize an article that is already on disk.
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A number in [-1, 1) derived from the sentence itself. Deterministic on
// purpose: chunks are content-addressed, so the same sentence has to plan the
// same way every time or a cached audiobook stops matching its manifest — and
// the variation still reads as variation, since it is uncorrelated between
// neighbours.
function wobble(text: string, salt: string): number {
  return (hash32(salt + text) / 0x100000000) * 2 - 1;
}

export function scalesFor(role: ChunkRole, text: string): Scales {
  const base = ROLE[role];
  return {
    length: round(clamp(base.length + wobble(text, "L") * LENGTH_JITTER, 0.85, 1.25)),
    noise: round(clamp(base.noise, 0.85, 1.2)),
    noiseW: round(clamp(base.noiseW + wobble(text, "W") * NOISE_W_JITTER, 0.8, 1.3)),
  };
}

interface Insert {
  at: number;
  text: string;
}

// The items of a coordinated series — "toast, eggs, bacon, and milk" — as the
// index of the last word of every item but the final one. Those are the words
// that take a continuation rise; the last item is the only one that falls, and
// falling is already all the model does.
//
// Returns nothing unless the sentence really is a series. A false positive
// here is cheap by construction: the commas that survive the length cap and
// sit before a coordinator are, near enough always, boundaries English would
// have risen on anyway — the tail of a subordinate clause, or one of a pair of
// coordinated clauses. A false negative is just the reading we have today.
export function seriesRises(text: string, words: WordSpan[]): number[] {
  const commas: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ",") commas.push(i);
  }
  if (commas.length < MIN_SERIES_ITEMS - 1) return [];

  const cuts = [-1, ...commas, text.length];
  const items: string[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    items.push(text.slice(cuts[i] + 1, cuts[i + 1]).trim());
  }
  if (items.some((item) => item.length > MAX_ITEM_CHARS)) return [];
  if (!COORDINATOR.test(items[items.length - 1])) return [];

  // Word indices rather than offsets, so this survives the comma inserts that
  // emphasis would otherwise shift everything by.
  const rises: number[] = [];
  for (const at of commas) {
    let last = -1;
    for (let i = 0; i < words.length; i++) {
      if (words[i].end <= at) last = i;
    }
    // Never the final word: there is nothing after it to continue into.
    if (last >= 0 && last < words.length - 1 && !rises.includes(last)) {
      rises.push(last);
    }
  }
  return rises;
}

function trimSpan(text: string, span: WordSpan): WordSpan {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}

// Commas around the emphasized phrase, or nothing.
//
// One phrase per sentence, always the longest: a sentence with three bolded
// words in it turns into a stutter if all three are isolated, and the sentence
// that needed the help is usually the one with a single phrase carrying it.
function emphasisInserts(text: string, spans: WordSpan[]): Insert[] {
  let best: WordSpan | null = null;

  for (const raw of spans) {
    const span = trimSpan(text, raw);
    const width = span.end - span.start;
    if (width < MIN_EMPHASIS_CHARS) continue;
    if (span.start < MIN_CONTEXT_CHARS) continue;
    if (text.length - span.end < MIN_CONTEXT_CHARS) continue;
    // Already its own prosodic unit — the author punctuated it themselves.
    if (/[,;:—–([]\s*$/.test(text.slice(0, span.start))) continue;
    if (/^\s*[,;:—–)\]]/.test(text.slice(span.end))) continue;
    if (!best || width > best.end - best.start) best = span;
  }
  if (!best) return [];

  // The opening comma belongs to the end of the word before it, not to the
  // space: "It was, really" rather than "It was ,really".
  let open = best.start;
  while (open > 0 && /\s/.test(text[open - 1])) open--;
  if (open === 0) return [];

  return [
    { at: open, text: "," },
    { at: best.end, text: "," },
  ];
}

function applyInserts(text: string, inserts: Insert[]): string {
  let out = "";
  let at = 0;
  for (const insert of inserts) {
    out += text.slice(at, insert.at) + insert.text;
    at = insert.at;
  }
  return out + text.slice(at);
}

// How far a position moves once the inserts are applied. A word's start counts
// an insert sitting exactly on it and its end does not, so the comma that
// closes an emphasis lands outside the word it follows rather than inside it.
function shift(inserts: Insert[], at: number, isStart: boolean): number {
  let delta = 0;
  for (const insert of inserts) {
    if (isStart ? insert.at <= at : insert.at < at) delta += insert.text.length;
  }
  return delta;
}

export interface SpeechInput {
  // The chunk as it appears on screen, already trimmed.
  text: string;
  // Words in document-normalized coordinates, as the segmenter produced them.
  words: WordSpan[];
  normStart: number;
  role: ChunkRole;
  // Author emphasis intersecting this chunk, clamped to it, in the same
  // document coordinates as `words`.
  emphasis: WordSpan[];
}

export interface SpeechPlan {
  // What the phonemizer is handed. Differs from the displayed text by
  // punctuation only — never by a word — which is what lets word timing
  // measured against this line be reported against the line on screen.
  text: string;
  // The same words, in the same order, as offsets into `text`.
  words: WordSpan[];
  scales: Scales;
  // Words that end an item of a coordinated series, by index into `words`.
  // The engine gives every one of them a terminal fall; lib/tts/pitch.ts puts
  // the rise back afterwards.
  rises: number[];
}

export function planSpeech(input: SpeechInput): SpeechPlan {
  const { text, normStart } = input;
  const local = (span: WordSpan): WordSpan => ({
    start: span.start - normStart,
    end: span.end - normStart,
  });

  const words = input.words.map(local);
  const rises = seriesRises(text, words);
  // A series is already punctuated into units, and isolating one of its items
  // between two more commas would only single out a member of a list for no
  // reason. The rise is the whole intervention here.
  const inserts = rises.length > 0 ? [] : emphasisInserts(text, input.emphasis.map(local));
  let speech = applyInserts(text, inserts);

  // An unterminated clause is delivered as one: the voice reaches the last
  // word and simply stops, with no final fall. Headings, list items and table
  // cells almost never carry a stop of their own, and they are exactly the
  // lines a listener needs to hear land.
  if (!TERMINATED.test(speech)) speech += ".";

  return {
    text: speech,
    words: words.map((word) => ({
      start: word.start + shift(inserts, word.start, true),
      end: word.end + shift(inserts, word.end, false),
    })),
    // Keyed off the displayed text rather than the speech text, so adding an
    // emphasis to a sentence doesn't also change its tempo.
    scales: scalesFor(input.role, text),
    rises,
  };
}
