import type { EngineId, Voice } from "@/lib/tts/types";

export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
// Piper voices are versioned by the pack rather than a single model file;
// the constant only has to change when a voice's audio would change, since
// it is part of every chunk key.
export const PIPER_MODEL = "piper-voices-1.0";

// Deliberately short. The full Kokoro set is 28 voices and Piper ships 900+,
// which is a worse decision to hand someone than a curated half-dozen.
export const VOICES: Voice[] = [
  {
    id: "kokoro:af_heart",
    engine: "kokoro",
    model: KOKORO_MODEL,
    name: "Heart",
    description: "American, warm",
  },
  {
    id: "kokoro:af_bella",
    engine: "kokoro",
    model: KOKORO_MODEL,
    name: "Bella",
    description: "American, bright",
  },
  {
    id: "kokoro:am_michael",
    engine: "kokoro",
    model: KOKORO_MODEL,
    name: "Michael",
    description: "American, low",
  },
  {
    id: "kokoro:bf_emma",
    engine: "kokoro",
    model: KOKORO_MODEL,
    name: "Emma",
    description: "British, even",
  },
  {
    id: "kokoro:bm_george",
    engine: "kokoro",
    model: KOKORO_MODEL,
    name: "George",
    description: "British, dry",
  },
  {
    id: "piper:en_US-hfc_female-medium",
    engine: "piper",
    model: PIPER_MODEL,
    name: "Faye",
    description: "American, light — runs anywhere",
  },
  {
    id: "piper:en_US-ryan-medium",
    engine: "piper",
    model: PIPER_MODEL,
    name: "Ryan",
    description: "American, light — runs anywhere",
  },
  {
    id: "piper:en_GB-alba-medium",
    engine: "piper",
    model: PIPER_MODEL,
    name: "Alba",
    description: "Scottish, light — runs anywhere",
  },
];

export const DEFAULT_VOICE: Record<EngineId, string> = {
  kokoro: "kokoro:af_heart",
  piper: "piper:en_US-hfc_female-medium",
};

export function findVoice(id: string): Voice | undefined {
  return VOICES.find((voice) => voice.id === id);
}

// The bare id the engine itself expects, without our engine prefix.
export function engineVoiceId(voice: Voice): string {
  return voice.id.slice(voice.id.indexOf(":") + 1);
}
