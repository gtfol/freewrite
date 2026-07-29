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
// It only ever runs on voiced audio, and that restriction is load bearing
// rather than tidy. WSOLA hides its splices by landing them on pitch-period
// boundaries; noise has no periods, so on a fricative the similarity search
// picks an arbitrary offset and overlap-adds noise onto itself, which comes
// out as a short metallic buzz. Choosing the segment by loudness put /s/ and
// /t/ inside it — a fricative is among the loudest things in a sentence — and
// produced exactly that, rarely, on whichever items happened to end unvoiced.
// Periodicity is the test that tells them apart, and it agrees with the
// linguistics: the tone of "toast" is carried by the diphthong, and the /st/
// after it has no pitch to move in the first place.
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

// Crossfade where the lifted segment meets the audio around it.
//
// Asymmetric, because the two edges are not the same problem. At the head the
// ramp is still at rate 1 and WSOLA's first window is unmoved, so the lifted
// audio and the original are the same samples and a long fade blends identical
// content. At the tail they have drifted out of phase, and fading between two
// phase-shifted copies of a periodic signal is comb filtering — audible as a
// hollowness that gets worse the longer it runs. So: fade in gently, cut away
// quickly.
const HEAD_SECONDS = 0.006;
const TAIL_SECONDS = 0.002;

// Voicing detection. The window has to hold two periods of a low voice (85Hz
// is ~12ms each) for autocorrelation to find one.
const VOICING_WINDOW = 0.025;
const VOICING_HOP = 0.01;
// The correlation only needs the voice band, so it runs on audio decimated by
// this much — 6kHz of bandwidth for a search that tops out at 400Hz.
const DECIMATION = 4;
const MIN_F0 = 60;
const MAX_F0 = 400;
// Normalized autocorrelation at the best lag. Voiced speech sits well above
// this; a fricative, which is noise with a spectral tilt, sits well below it
// however loud it happens to be.
const VOICED_CORRELATION = 0.4;
// Zero crossings per sample, measured on the full-band audio.
//
// Periodicity alone is not enough, because a voiced fricative has both: the
// folds are vibrating and the constriction is hissing. Decimating for the
// correlation low-passes the hiss away and leaves a convincingly periodic
// murmur, so the /z/ of "eyes" passes a periodicity test and is then spliced on
// the full-band signal, where the noise is what dominates — the same buzz as
// the /s/ of "gas", arrived at from the opposite direction. Crossing rate is
// the measurement the low-pass hasn't touched: a vowel crosses at roughly
// twice its first formant, a sibilant at several times that, whether or not it
// is voiced.
const MAX_ZERO_CROSSING_RATE = 0.12;

// The 25ms window that makes the periodicity test trustworthy is too long to
// place a boundary with: it stops calling a frame voiced while a fifth of it is
// still vowel. That left ten to twenty milliseconds of un-raised vowel after
// the rise, so the voice climbed a tone, stepped back down for a syllable's
// tail, and then hit the consonant. In "eyes" the leftover lands inside the
// /z/, where there is nothing much to hear it in; in "gas" it is the last of a
// short, fully voiced vowel, which is why one sounded fixed and the other
// still sounded wrong.
//
// So the coarse pass finds the run and a short window walks its end forward to
// where voicing actually stops. Crossing rate alone here: 4ms is far too short
// to measure a period in, and the only question left at the boundary is
// whether the consonant has started. The window looks forward from the point
// being judged, so the error is one-sided — it stops a few milliseconds early
// rather than a few late, and early is the harmless direction.
const EDGE_WINDOW = 0.004;
const EDGE_STEP = 0.001;
// Relative to the span's own peak, so this tracks the speaker rather than an
// absolute level the two engines would disagree about.
const VOICED_LEVEL_RATIO = 0.06;

// A stretch of audio to lift, in seconds from the start of the chunk.
export interface RiseSpan {
  from: number;
  to: number;
}

// How loud one window is, and how periodic.
//
// Decimated by a box filter before the correlation rather than by picking
// every fourth sample: taking every fourth sample folds the energy of a
// fricative straight down into the band being searched, where it can look
// convincingly periodic. Averaging first is a crude low-pass, and crude is
// enough — the question is only voiced or not.
function examine(
  audio: Float32Array,
  at: number,
  window: number,
  sampleRate: number
): { level: number; periodic: number; crossings: number } {
  let energy = 0;
  let crossings = 0;
  for (let i = 0; i < window; i++) {
    const sample = audio[at + i];
    energy += sample * sample;
    if (i > 0 && sample < 0 !== audio[at + i - 1] < 0) crossings++;
  }
  const level = Math.sqrt(energy / window);

  const count = Math.floor(window / DECIMATION);
  const band = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let d = 0; d < DECIMATION; d++) sum += audio[at + i * DECIMATION + d];
    band[i] = sum / DECIMATION;
  }

  const rate = sampleRate / DECIMATION;
  const lowLag = Math.max(2, Math.floor(rate / MAX_F0));
  const highLag = Math.min(count - 2, Math.ceil(rate / MIN_F0));

  let best = 0;
  for (let lag = lowLag; lag <= highLag; lag++) {
    let dot = 0;
    let here = 0;
    let there = 0;
    for (let i = 0; i + lag < count; i++) {
      dot += band[i] * band[i + lag];
      here += band[i] * band[i];
      there += band[i + lag] * band[i + lag];
    }
    const norm = Math.sqrt(here * there);
    if (norm > 1e-12) best = Math.max(best, dot / norm);
  }
  return { level, periodic: best, crossings: crossings / window };
}

// Walks forward from a point known to be voiced to the last one that still is.
// `floor` is not a refinement: silence crosses zero no times at all, so crossing
// rate on its own calls a pause the most voiced thing in the chunk and walks
// straight through it to the end of the span.
function voicingEnds(
  audio: Float32Array,
  from: number,
  limit: number,
  sampleRate: number,
  floor: number
): number {
  const window = Math.max(2, Math.round(sampleRate * EDGE_WINDOW));
  const step = Math.max(1, Math.round(sampleRate * EDGE_STEP));

  let end = from;
  for (let at = from; at + window <= limit; at += step) {
    let crossings = 0;
    let energy = 0;
    for (let i = 0; i < window; i++) {
      const sample = audio[at + i];
      energy += sample * sample;
      if (i > 0 && sample < 0 !== audio[at + i - 1] < 0) crossings++;
    }
    if (Math.sqrt(energy / window) < floor) break;
    if (crossings / (window - 1) > MAX_ZERO_CROSSING_RATE) break;
    end = at + step;
  }
  return Math.min(limit, end);
}

// The last stretch of voiced audio in the span — which is both where the rise
// belongs and the only place it can safely be put.
//
// Belongs, because an English continuation rise is carried by the voiced
// nucleus: the tone of "toast" lives in the diphthong, and the /st/ after it
// has no pitch to move. Safely, because WSOLA restores duration by splicing at
// pitch-period boundaries, and a fricative has none — the similarity search
// picks an arbitrary offset and overlap-adds noise onto itself, which is heard
// as a short metallic buzz. Loudness cannot tell the two apart, since /s/ is
// among the loudest things in a sentence. Periodicity can.
function voicedRun(
  audio: Float32Array,
  from: number,
  to: number,
  sampleRate: number
): { start: number; end: number } | null {
  const window = Math.max(2, Math.round(sampleRate * VOICING_WINDOW));
  const hop = Math.max(1, Math.round(sampleRate * VOICING_HOP));
  if (to - from < window) return null;

  const frames: {
    at: number;
    level: number;
    periodic: number;
    crossings: number;
  }[] = [];
  let peak = 0;
  for (let at = from; at + window <= to; at += hop) {
    const frame = examine(audio, at, window, sampleRate);
    frames.push({ at, ...frame });
    peak = Math.max(peak, frame.level);
  }
  if (frames.length === 0 || peak === 0) return null;

  const floor = peak * VOICED_LEVEL_RATIO;
  const voiced = frames.map(
    (frame) =>
      frame.level >= floor &&
      frame.periodic >= VOICED_CORRELATION &&
      frame.crossings <= MAX_ZERO_CROSSING_RATE
  );

  let end = -1;
  for (let i = voiced.length - 1; i >= 0; i--) {
    if (voiced[i]) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  let start = end;
  while (start > 0 && voiced[start - 1]) start--;

  // A frame is a verdict on a whole window, so voicing ends somewhere inside
  // the last one rather than at the far side of it. This point is still inside
  // it and therefore still voiced, which is what `voicingEnds` needs to start
  // from; it then walks the rest of the way at a resolution the coarse pass
  // cannot offer.
  const inside = Math.min(
    to,
    frames[end].at + (end + 1 < frames.length ? hop : window)
  );

  return {
    start: frames[start].at,
    end: voicingEnds(audio, inside, to, sampleRate, floor),
  };
}

// One segment, lifted, at exactly the length it arrived.
function raise(
  segment: Float32Array,
  sampleRate: number,
  semitones: number
): Float32Array | null {
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
  if (count < 2) return null;

  const restored = timeStretch(warped.subarray(0, count), sampleRate, count / n);
  // Anything but the exact length back would have to be padded or spliced, and
  // both are audible where no rise at all is not. WSOLA returns the length it
  // was asked for, so this is a guard rather than a case.
  return restored.length === n ? restored : null;
}

function blend(
  out: Float32Array,
  raised: Float32Array,
  from: number,
  sampleRate: number
): void {
  const head = Math.max(1, Math.round(sampleRate * HEAD_SECONDS));
  const tail = Math.max(1, Math.round(sampleRate * TAIL_SECONDS));
  const n = raised.length;
  for (let i = 0; i < n; i++) {
    const weight = Math.min(1, i / head, (n - 1 - i) / tail);
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
    const from = Math.max(0, Math.round(span.from * sampleRate));
    if (limit - from < shortest) continue;

    const run = voicedRun(out, from, limit, sampleRate);
    if (!run) continue;

    // Long items take the rise on their last syllable rather than all the way
    // back to the start of the word.
    const opens = Math.max(
      run.start,
      run.end - Math.round(MAX_RISE_SECONDS * sampleRate)
    );
    // A voiced run too short to move the tone through is left alone. Missing
    // the rise on one item of a list is a reading; a fifty-millisecond burst
    // of something else is not.
    if (run.end - opens < shortest) continue;

    const raised = raise(out.subarray(opens, run.end), sampleRate, semitones);
    if (raised) blend(out, raised, opens, sampleRate);
  }
  return out;
}
