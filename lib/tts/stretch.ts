// Speed without chipmunks.
//
// AudioBufferSourceNode.playbackRate is a resampler: at 1.5x it plays the same
// samples off a faster clock, so every frequency in the signal — including the
// speaker's pitch — moves up by the same factor. Right for a record player,
// wrong for a voice, and Web Audio has no preservesPitch to ask for the other
// behaviour.
//
// So the waveform is stretched here instead, by WSOLA (waveform similarity
// overlap-add): the audio is cut into overlapping windows that are laid back
// down at a different spacing, which changes duration and leaves the sample
// rate — and therefore the pitch — untouched. The "similarity" is the part that
// matters. Repeating or dropping a window at an arbitrary point puts two
// mismatched waveforms on top of each other and you hear it as a warble, so
// each window's read position is searched a few milliseconds either side of the
// nominal one for the spot where the waveform best continues what was just
// written. On voiced speech that search lands on a pitch-period boundary,
// which is why the seams disappear.

import type { Samples } from "@/lib/tts/codec";

// Long enough to hold a pitch period of a low voice (85Hz is ~12ms), short
// enough not to smear plosives.
const FRAME_SECONDS = 0.045;
// How far the splice point may travel to find a better match — a bit over one
// period of the lowest speech pitch, which is all the search needs.
const SEARCH_SECONDS = 0.008;
// Only the head of the overlap is correlated; matching further ahead costs
// time and tells us nothing the first few milliseconds didn't.
const CORRELATION_SECONDS = 0.015;
// The search runs coarse-then-fine, and subsamples the correlation itself, to
// keep a chunk's stretch in the low tens of milliseconds. Speech is heavily
// oversampled at 24-48kHz; a peak this finds at stride 4 is the same peak.
const COARSE_STEP = 4;
const COARSE_STRIDE = 4;
const FINE_STRIDE = 2;

function copyOf(audio: Float32Array): Samples {
  const out = new Float32Array(audio.length);
  out.set(audio);
  return out;
}

function hann(length: number): Float32Array {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / length));
  }
  return window;
}

// Cross-correlation normalised by the candidate's own energy: without that the
// search just walks toward the loudest few milliseconds in range instead of the
// best-matching shape.
function score(
  audio: Float32Array,
  reference: number,
  candidate: number,
  length: number,
  stride: number
): number {
  let dot = 0;
  let energy = 0;
  for (let i = 0; i < length; i += stride) {
    const sample = audio[candidate + i];
    dot += audio[reference + i] * sample;
    energy += sample * sample;
  }
  return dot / Math.sqrt(energy + 1e-9);
}

// Where to read the next window: near `nominal`, but preferring the offset
// whose waveform continues `reference` — the samples that would have followed
// the window just written if we had kept reading straight on.
function bestMatch(
  audio: Float32Array,
  reference: number,
  nominal: number,
  search: number,
  length: number
): number {
  const last = audio.length - length;
  // Too close to the end to correlate anything; take the nominal position.
  if (last <= 0 || reference + length > audio.length) {
    return Math.max(0, Math.min(nominal, Math.max(0, audio.length - 1)));
  }

  const low = Math.max(0, Math.min(nominal - search, last));
  const high = Math.max(0, Math.min(nominal + search, last));
  if (high <= low) return low;

  let best = low;
  let bestScore = -Infinity;
  for (let at = low; at <= high; at += COARSE_STEP) {
    const value = score(audio, reference, at, length, COARSE_STRIDE);
    if (value > bestScore) {
      bestScore = value;
      best = at;
    }
  }

  const fineLow = Math.max(low, best - COARSE_STEP);
  const fineHigh = Math.min(high, best + COARSE_STEP);
  let refined = best;
  bestScore = -Infinity;
  for (let at = fineLow; at <= fineHigh; at++) {
    const value = score(audio, reference, at, length, FINE_STRIDE);
    if (value > bestScore) {
      bestScore = value;
      refined = at;
    }
  }
  return refined;
}

// Returns audio of length ≈ audio.length / speed at the same sample rate, so
// the words come faster or slower and the voice stays where it was.
export function timeStretch(
  audio: Float32Array,
  sampleRate: number,
  speed: number
): Samples {
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  if (rate === 1 || audio.length === 0) return copyOf(audio);

  // Even, so the hop is exactly half and Hann windows sum back to unity.
  const frame = Math.max(2, Math.round(sampleRate * FRAME_SECONDS) & ~1);
  const hop = frame / 2;
  // Nothing to splice — a fragment shorter than a window and a half has no
  // repeated waveform to work with, so it keeps its natural length. At tens of
  // milliseconds the timing this leaves on the table is inaudible.
  if (audio.length < frame + hop) return copyOf(audio);

  const outLength = Math.max(1, Math.round(audio.length / rate));
  const out = new Float32Array(outLength);
  const norm = new Float32Array(outLength);
  const window = hann(frame);
  const search = Math.max(1, Math.round(sampleRate * SEARCH_SECONDS));
  const correlation = Math.min(hop, Math.round(sampleRate * CORRELATION_SECONDS));
  const analysisHop = hop * rate;

  let read = 0;
  let write = 0;
  // The ideal read position, accumulated separately from `read` so that the
  // per-window search adjustments don't compound into a drifting duration.
  let target = 0;

  while (write < outLength) {
    const take = Math.min(frame, audio.length - read, outLength - write);
    if (take <= 0) break;
    for (let i = 0; i < take; i++) {
      out[write + i] += audio[read + i] * window[i];
      norm[write + i] += window[i];
    }

    const reference = read + hop;
    write += hop;
    target += analysisHop;
    read = bestMatch(audio, reference, Math.round(target), search, correlation);
  }

  // Hann at 50% overlap already sums to 1 across the interior; dividing by the
  // window sum that actually landed is what keeps the first and last few
  // milliseconds from fading in and out, where only one window covers them.
  for (let i = 0; i < outLength; i++) {
    if (norm[i] > 1e-3) out[i] /= norm[i];
  }
  return out;
}
