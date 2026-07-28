import type { Voice } from "@/lib/tts/types";

// Piper voices are versioned by the pack rather than a single model file; the
// constant only has to change when a voice's audio would change, since it is
// part of every chunk key.
export const PIPER_MODEL = "piper-voices-1.0";

// Piper ships 900+ voices, which is a worse decision to hand someone than a
// curated handful. These are the English ones worth listening to for an hour.
export const VOICES: Voice[] = [
  {
    id: "piper:en_US-hfc_female-medium",
    engine: "piper",
    model: PIPER_MODEL,
    name: "Faye",
    description: "American, clear",
  },
  {
    id: "piper:en_US-ryan-medium",
    engine: "piper",
    model: PIPER_MODEL,
    name: "Ryan",
    description: "American, low",
  },
  {
    id: "piper:en_US-lessac-medium",
    engine: "piper",
    model: PIPER_MODEL,
    name: "Lessac",
    description: "American, even",
  },
  {
    id: "piper:en_US-amy-medium",
    engine: "piper",
    model: PIPER_MODEL,
    name: "Amy",
    description: "American, bright",
  },
  {
    id: "piper:en_GB-alan-medium",
    engine: "piper",
    model: PIPER_MODEL,
    name: "Alan",
    description: "British, dry",
  },
  {
    id: "piper:en_GB-alba-medium",
    engine: "piper",
    model: PIPER_MODEL,
    name: "Alba",
    description: "Scottish",
  },
];

export const DEFAULT_VOICE = "piper:en_US-hfc_female-medium";

export function findVoice(id: string): Voice | undefined {
  return VOICES.find((voice) => voice.id === id);
}

// The bare id the engine itself expects, without our engine prefix.
export function engineVoiceId(voice: Voice): string {
  return voice.id.slice(voice.id.indexOf(":") + 1);
}
