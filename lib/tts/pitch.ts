// The continuation rise: the tone English puts on an item when more items are
// still coming.
//
// "Toast, eggs, bacon, and milk" is four pitch movements and only the last one
// falls. Piper has no idea. It sees four comma-terminated clauses and gives
// each the same small terminal fall, which is why a list read aloud sounds
// like four short statements that happen to be adjacent — the single most
// recital-like thing left in the reading.
//
// It cannot be asked for. There is no SSML here (see lib/tts/prosody.ts), and
// the one lever that reaches prosody is punctuation, which is what produced
// the falls in the first place. Swapping the separators for semicolons or
// colons does reach the model — the phonemizer emits a distinct token for each
// — but what a VITS voice learned to do with them is not knowable without
// listening to every voice, and a list is too common a thing to leave on a
// guess. So the rise is put on the waveform afterwards, where it is exactly as
// large as it was asked to be.
//
// Pitch moves without anything else moving by resampling and then undoing the
// duration change: reading the segment with a read pointer that accelerates
// raises every frequency in it and shortens it, and WSOLA — already here for
// playback speed, see lib/tts/stretch.ts — puts the duration back without
// touching pitch. The acceleration ramps rather than steps, because what a
// listener hears as "more is coming" is the movement, not the height.
//
// Relative imports with extensions, so this runs under `npm test` without a
// bundler. See pitch.test.ts.

import { timeStretch } from "./stretch.ts";

// How far the tone travels. Three semitones is the middle of the range a
// speaker uses for this; past about five it stops reading as a list and starts
// reading as a question.
export const RISE_SEMITONES = 3;

// A movement shorter than this is not heard as a movement, and is also too
// short for WSOLA to have anything to splice.
const MIN_RISE_SECONDS = 0.09;
// The rise belongs to the item's last syllable or so. Given more than this it
// starts lifting the whole item, which sounds like excitement rather than
// continuation.
const MAX_RISE_SECONDS = 0.3;

// Crossfade at each edge of a treated segment. Long enough to hide a WSOLA
// seam, short enough not to eat into the movement itself.
const EDGE_SECONDS = 0.004;

const FRAME_SECONDS = 0.01;
// Relative to the span's own peak, so this tracks the speaker rather than an
// absolute level the two engines would disagree about.
const SILENCE_RATIO = 0.08;

// A stretch of audio to lift, in seconds from the start of the chunk.
export interface RiseSpan {
  from: number;
  to: number;
}

// Where the item stops sounding. The span handed in runs to the start of the
// next word, so it carries the comma's pause on the end; ramping through that
// spends most of the movement somewhere nothing can be heard.
function voicedEnd(
  audio: Float32Array,
  from: number,
  to: number,
  sampleRate: number
): number {
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const levels: number[] = [];
  let peak = 0;

  for (let at = from; at < to; at += frame) {
    const end = Math.min(to, at + frame);
    let sum = 0;
    for (let i = at; i < end; i++) sum += audio[i] * audio[i];
    const level = Math.sqrt(sum / Math.max(1, end - at));
    levels.push(level);
    peak = Math.max(peak, level);
  }
  if (peak === 0) return from;

  const floor = peak * SILENCE_RATIO;
  let last = levels.length - 1;
  while (last > 0 && levels[last] < floor) last--;
  return Math.min(to, from + (last + 1) * frame);
}

// One segment, lifted, at exactly the length it arrived.
function raise(
  segment: Float32Array,
  sampleRate: number,
  semitones: number
): Float32Array {
  const n = segment.length;
  const top = Math.pow(2, semitones / 12);

  // Read faster and faster. The result is pitched up by the read rate and
  // shorter by it, and never longer than the input since the rate never drops
  // below 1.
  const warped = new Float32Array(n);
  let phase = 0;
  let count = 0;
  while (phase < n - 1 && count < n) {
    // Raised cosine rather than linear: the rate starts at exactly the pitch
    // the sentence was already at, so there is no step where the rise begins.
    const p = phase / (n - 1);
    const rate = 1 + (top - 1) * 0.5 * (1 - Math.cos(Math.PI * p));
    const i = Math.floor(phase);
    warped[count++] = segment[i] + (segment[i + 1] - segment[i]) * (phase - i);
    phase += rate;
  }
  if (count < 2) return segment.slice();

  const restored = timeStretch(warped.subarray(0, count), sampleRate, count / n);

  // The caller gets back exactly the samples it gave up. WSOLA rounds, and on
  // the rounding that comes up short the original audio is what fills the tail
  // — never silence, which would be audible where a rounding error is not.
  const out = new Float32Array(n);
  out.set(segment);
  out.set(restored.subarray(0, Math.min(n, restored.length)));
  return out;
}

function blend(
  out: Float32Array,
  raised: Float32Array,
  from: number,
  sampleRate: number
): void {
  const edge = Math.max(1, Math.round(sampleRate * EDGE_SECONDS));
  const n = raised.length;
  for (let i = 0; i < n; i++) {
    const weight = Math.min(1, i / edge, (n - 1 - i) / edge);
    out[from + i] = out[from + i] * (1 - weight) + raised[i] * weight;
  }
}

// Lifts the end of each span. Returns new audio of exactly the input length,
// so word times measured before this still describe it afterwards.
export function applyRises(
  audio: Float32Array,
  sampleRate: number,
  spans: RiseSpan[],
  semitones: number = RISE_SEMITONES
): Float32Array {
  if (spans.length === 0 || audio.length === 0) return audio;

  const out = new Float32Array(audio.length);
  out.set(audio);
  const shortest = Math.round(MIN_RISE_SECONDS * sampleRate);

  for (const span of spans) {
    const limit = Math.min(audio.length, Math.round(span.to * sampleRate));
    // Long items get the rise on their last syllable rather than all the way
    // back to the start of the word.
    const opens = Math.max(
      0,
      Math.round(span.from * sampleRate),
      limit - Math.round(MAX_RISE_SECONDS * sampleRate)
    );
    if (limit - opens < shortest) continue;

    const closes = voicedEnd(out, opens, limit, sampleRate);
    if (closes - opens < shortest) continue;

    blend(out, raise(out.subarray(opens, closes), sampleRate, semitones), opens, sampleRate);
  }
  return out;
}
