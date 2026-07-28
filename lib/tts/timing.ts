// Waveform post-processing: silence trimming and word timing.
//
// Neither Kokoro nor Piper exposes the duration-predictor output that would
// give phoneme-level truth, so word times are derived. The chunk's measured
// duration is exact; within it, words are placed by weighted interpolation and
// then snapped to the nearest trough in the energy envelope, which recovers
// most of the error around commas and natural breaths.

import type { StoredChunk, WordSpan } from "@/lib/tts/types";

const FRAME_SECONDS = 0.01;
// Below 2% of chunk peak counts as silence. Relative rather than absolute
// because the two engines differ by several dB in output level.
const SILENCE_RATIO = 0.02;
// Kept either side of the speech so trimming never clips a plosive attack or
// swallows a trailing fricative.
const GUARD_SECONDS = 0.02;
// How far a boundary may move to find a trough.
const SNAP_SECONDS = 0.09;
const MIN_WORD_SECONDS = 0.04;
// Characters per second of speech, for chunks that haven't been generated yet.
// Only affects the progress bar and time labels, which settle as real
// durations arrive.
const CHARS_PER_SECOND = 14.5;
// Read-along that lands exactly on a word's acoustic onset reads as late: the
// eye needs time to find the word before it is spoken. Leading slightly is
// what makes the highlight feel locked to the voice instead of chasing it.
// Applied at read time rather than baked into the stored word times, so it
// stays tunable without regenerating a single chunk.
const WORD_LEAD_SECONDS = 0.06;

// Extra weight, in syllable-equivalents, bought by punctuation following a
// word. A comma really does cost about a syllable and a half of time.
function pauseWeight(gap: string): number {
  if (/[;:—–]/.test(gap)) return 2;
  if (/,/.test(gap)) return 1.5;
  if (/[.!?]/.test(gap)) return 1;
  return 0;
}

// Speech duration tracks syllables far more closely than characters, which is
// what made the first version drift: "through" is seven characters and one
// syllable, "idea" is four characters and two. Vowel-group counting is crude
// but its errors are small and unbiased, where character counting is biased by
// spelling — consonant clusters run long, vowel-heavy short words run short,
// and within a sentence that bias accumulates.
//
// Known limit: vowels adjacent across a syllable boundary count once, so
// "audiobook" reads as three. Splitting those pairs was tried and rejected —
// it breaks every "-tion" word, where "tio" really is one syllable, and a
// systematic error on common words is worse than an occasional one on rare
// ones. What remains is small enough for trough-snapping to absorb.
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 1;

  const groups = w.match(/[aeiouy]+/g);
  let count = groups?.length ?? 1;

  // Silent terminal "e" (time, make) — but not when it carries the only vowel
  // group (the, be), follows another vowel (see, blue), or forms the syllable
  // in a consonant + "le" ending (table, little).
  if (
    count > 1 &&
    w.length > 2 &&
    w.endsWith("e") &&
    !/[aeiouy]e$/.test(w) &&
    !/[^aeiouy]le$/.test(w)
  ) {
    count--;
  }
  return Math.max(1, count);
}

export function rmsEnvelope(audio: Float32Array, sampleRate: number): Float32Array {
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const count = Math.ceil(audio.length / frame);
  const envelope = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    const start = f * frame;
    const end = Math.min(audio.length, start + frame);
    let sum = 0;
    for (let i = start; i < end; i++) sum += audio[i] * audio[i];
    envelope[f] = Math.sqrt(sum / Math.max(1, end - start));
  }
  return envelope;
}

// The trick that makes gaps feel even: strip the model's own variable
// head/tail silence so the scheduler owns 100% of the inter-sentence timing.
export function trimSilence(audio: Float32Array, sampleRate: number): Float32Array {
  const envelope = rmsEnvelope(audio, sampleRate);
  let peak = 0;
  for (const v of envelope) peak = Math.max(peak, v);
  if (peak === 0) return audio.slice(0, 0);

  const threshold = Math.max(peak * SILENCE_RATIO, 1e-4);
  let first = 0;
  let last = envelope.length - 1;
  while (first < envelope.length && envelope[first] < threshold) first++;
  while (last > first && envelope[last] < threshold) last--;
  if (first > last) return audio.slice(0, 0);

  const frame = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const guard = Math.round(sampleRate * GUARD_SECONDS);
  const start = Math.max(0, first * frame - guard);
  const end = Math.min(audio.length, (last + 1) * frame + guard);
  return audio.slice(start, end);
}

function interpolate(
  text: string,
  words: WordSpan[],
  normStart: number,
  duration: number
): number[] {
  const weights = words.map((word, i) => {
    const spoken = text.slice(word.start - normStart, word.end - normStart);
    const next = words[i + 1];
    const gap = next
      ? text.slice(word.end - normStart, next.start - normStart)
      : text.slice(word.end - normStart);
    return syllables(spoken) + pauseWeight(gap);
  });

  const total = weights.reduce((sum, w) => sum + w, 0) || 1;
  const times: number[] = [];
  let cumulative = 0;
  for (const weight of weights) {
    times.push((cumulative / total) * duration);
    cumulative += weight;
  }
  return times;
}

// Nudges each interior boundary to the quietest frame nearby, without letting
// it pass its neighbours or leave a word shorter than MIN_WORD_SECONDS.
function snapToTroughs(
  times: number[],
  envelope: Float32Array,
  duration: number
): number[] {
  if (times.length < 2 || envelope.length === 0) return times;

  const frameAt = (t: number) =>
    Math.min(envelope.length - 1, Math.max(0, Math.round(t / FRAME_SECONDS)));
  const snapped = times.slice();

  for (let i = 1; i < snapped.length; i++) {
    const lower = Math.max(snapped[i - 1] + MIN_WORD_SECONDS, times[i] - SNAP_SECONDS);
    const upper = Math.min(
      (times[i + 1] ?? duration) - MIN_WORD_SECONDS,
      times[i] + SNAP_SECONDS
    );
    if (upper <= lower) continue;

    let bestFrame = frameAt(times[i]);
    let bestEnergy = envelope[bestFrame];
    for (let f = frameAt(lower); f <= frameAt(upper); f++) {
      if (envelope[f] < bestEnergy) {
        bestEnergy = envelope[f];
        bestFrame = f;
      }
    }
    snapped[i] = Math.min(upper, Math.max(lower, bestFrame * FRAME_SECONDS));
  }
  return snapped;
}

export function wordTimes(
  text: string,
  words: WordSpan[],
  normStart: number,
  audio: Float32Array,
  sampleRate: number
): number[] {
  const duration = audio.length / sampleRate;
  if (words.length === 0) return [];
  const linear = interpolate(text, words, normStart, duration);
  return snapToTroughs(linear, rmsEnvelope(audio, sampleRate), duration);
}

// Which word is being spoken at `inChunk` seconds, or -1 before the first.
export function wordIndexAt(times: number[] | null, inChunk: number): number {
  if (!times || times.length === 0) return -1;
  const cue = inChunk + WORD_LEAD_SECONDS;
  let index = -1;
  for (let i = 0; i < times.length; i++) {
    if (times[i] <= cue) index = i;
    else break;
  }
  return index;
}

export function estimateDuration(chunk: StoredChunk): number {
  return chunk.duration ?? Math.max(0.3, chunk.text.length / CHARS_PER_SECOND);
}

// Content-time starts for every chunk, gaps included, always at 1x. Used for
// the scrubber and for turning a click into a position.
export function buildTimeline(chunks: StoredChunk[]): {
  starts: number[];
  total: number;
} {
  const starts: number[] = [];
  let at = 0;
  for (const chunk of chunks) {
    starts.push(at);
    at += estimateDuration(chunk) + chunk.gapAfter / 1000;
  }
  return { starts, total: at };
}
