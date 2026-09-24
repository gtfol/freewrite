// Getting a sentence out of an engine that refuses it.
//
// A sentence the phonemizer aborts on is a sentence lost, and asking again
// gets the same abort — the input hasn't changed. But the input is ours to
// change: half a sentence is a different input, and almost always a working
// one, because what the engine refuses is usually one fragment rather than the
// whole. So a refusal is divided and retried, each half on its own terms, and
// whatever comes back is stitched into a single waveform. The manifest still
// sees one chunk with one duration and one set of word times; nothing
// downstream needs to know a sentence was ever difficult.
//
// Only the last fragment standing is given up on, and only its words go
// missing. Word timing across the sentence drifts a little when that happens,
// since the audio no longer covers every word it was measured against — a poor
// trade against a whole sentence, a good one against losing it.
//
// Relative imports with extensions, so this runs under `npm test` without a
// bundler. See recover.test.ts.

import { trimSilence } from "./timing.ts";
import { isOutOfMemory } from "./errors.ts";

export interface Waveform {
  audio: Float32Array;
  sampleRate: number;
}

// The shortest fragment worth handing back to the engine. Below this, a
// failure is about the characters themselves rather than what surrounds them,
// and dividing further only produces smaller versions of the same refusal.
export const MIN_FRAGMENT_CHARS = 24;

// The break nearest the middle, so the halves stay balanced. Clause boundaries
// first and word boundaries after — the same preference the segmenter uses,
// for the same reason: a break the reader would have paused at anyway is the
// one least likely to be heard. -1 when there is nowhere to cut.
export function splitPoint(text: string): number {
  const mid = text.length / 2;
  let best = -1;

  const scan = (pattern: RegExp) => {
    for (let i = MIN_FRAGMENT_CHARS; i < text.length - MIN_FRAGMENT_CHARS; i++) {
      if (!pattern.test(text[i])) continue;
      if (best === -1 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
    }
  };

  scan(/[,;:—–]/);
  if (best === -1) scan(/\s/);
  return best === -1 ? -1 : best + 1;
}

export function join(parts: Waveform[]): Waveform {
  if (parts.length === 1) return parts[0];

  const audio = new Float32Array(
    parts.reduce((total, part) => total + part.audio.length, 0)
  );
  let at = 0;
  for (const part of parts) {
    audio.set(part.audio, at);
    at += part.audio.length;
  }
  return { audio, sampleRate: parts[0].sampleRate };
}

// One sentence, however many engine calls it takes.
//
// Memory failures are excluded deliberately: those are not about the text, so
// dividing it only spends more of a heap that has already run out. They go
// back to the generator, which answers them by replacing the worker.
export async function synthesizeWithRecovery(
  synth: (text: string) => Promise<Waveform>,
  text: string
): Promise<Waveform> {
  try {
    const raw = await synth(text);
    // Trimmed per fragment rather than after the join, or the model's own head
    // and tail silence would land inside the sentence as a stutter.
    return {
      audio: trimSilence(raw.audio, raw.sampleRate),
      sampleRate: raw.sampleRate,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isOutOfMemory(message) || text.length <= MIN_FRAGMENT_CHARS) throw error;

    const cut = splitPoint(text);
    if (cut === -1) throw error;

    const parts: Waveform[] = [];
    for (const half of [text.slice(0, cut), text.slice(cut)]) {
      const fragment = half.trim();
      if (!fragment) continue;
      try {
        parts.push(await synthesizeWithRecovery(synth, fragment));
      } catch {
        // This fragment is the unsayable one. The rest of the sentence still
        // reads, which is the whole point of having divided it.
      }
    }

    // Nothing survived: report the original refusal rather than the last one,
    // since that is the one that describes the sentence.
    if (parts.length === 0) throw error;
    return join(parts);
  }
}
