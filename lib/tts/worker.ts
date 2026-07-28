/// <reference lib="webworker" />

// Synthesis worker.
//
// Engines live behind one `Engine` shape. Only Piper ships today — Kokoro was
// tried and dropped, since its quantized builds sound metallic and the fp32
// build that doesn't is a ~326MB download that still runs slower on CPU. The
// indirection stays because it is what made that swap a small change.
//
// The worker also trims silence, derives word times, and encodes to Opus, so
// the main thread gets a finished chunk and never sees a raw waveform.

import { encodeAudio } from "@/lib/tts/codec";
import { trimSilence, wordTimes } from "@/lib/tts/timing";
import { engineVoiceId, findVoice } from "@/lib/tts/voices";
import type { EngineId, WordSpan } from "@/lib/tts/types";

interface Engine {
  synth(text: string): Promise<{ audio: Float32Array; sampleRate: number }>;
}

export type WorkerRequest =
  | { type: "init"; voiceId: string }
  | {
      type: "synth";
      key: string;
      text: string;
      normStart: number;
      words: WordSpan[];
    };

export type WorkerResponse =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; engine: EngineId }
  | {
      type: "chunk";
      key: string;
      format: "opus" | "pcm";
      data: ArrayBuffer;
      sampleRate: number;
      duration: number;
      wordTimes: number[];
      bytes: number;
    }
  | { type: "error"; key?: string; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let engine: Engine | null = null;

function post(message: WorkerResponse, transfer?: Transferable[]) {
  scope.postMessage(message, transfer ?? []);
}

// Piper hands back a WAV blob rather than samples.
function parseWav(buffer: ArrayBuffer): {
  audio: Float32Array;
  sampleRate: number;
} {
  const view = new DataView(buffer);
  let sampleRate = 22050;
  let bits = 16;
  let at = 12;

  while (at + 8 <= buffer.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(at),
      view.getUint8(at + 1),
      view.getUint8(at + 2),
      view.getUint8(at + 3)
    );
    const size = view.getUint32(at + 4, true);
    const body = at + 8;

    if (id === "fmt ") {
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      const count = size / (bits / 8);
      const audio = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        audio[i] =
          bits === 16
            ? view.getInt16(body + i * 2, true) / 0x8000
            : view.getFloat32(body + i * 4, true);
      }
      return { audio, sampleRate };
    }
    at = body + size + (size % 2);
  }
  throw new Error("no PCM data in engine output");
}

async function loadPiper(voice: string): Promise<Engine> {
  const vits = await import("@diffusionstudio/vits-web");
  type VoiceId = Parameters<typeof vits.predict>[0]["voiceId"];
  const voiceId = voice as VoiceId;

  await vits.download(voiceId, (progress) => {
    post({ type: "progress", loaded: progress.loaded, total: progress.total });
  });

  return {
    async synth(text) {
      const blob = await vits.predict({ text, voiceId });
      return parseWav(await blob.arrayBuffer());
    },
  };
}

async function init(voiceId: string) {
  const voice = findVoice(voiceId);
  if (!voice) throw new Error(`unknown voice ${voiceId}`);

  engine = await loadPiper(engineVoiceId(voice));
  post({ type: "ready", engine: voice.engine });
}

async function synth(request: Extract<WorkerRequest, { type: "synth" }>) {
  if (!engine) throw new Error("engine not initialized");

  const raw = await engine.synth(request.text);
  // Trim before measuring: the scheduler owns every millisecond of silence
  // between chunks, so the model's own variable head and tail must go.
  const audio = trimSilence(raw.audio, raw.sampleRate);
  const times = wordTimes(
    request.text,
    request.words,
    request.normStart,
    audio,
    raw.sampleRate
  );
  const encoded = await encodeAudio(audio, raw.sampleRate);

  post(
    {
      type: "chunk",
      key: request.key,
      format: encoded.format,
      data: encoded.data,
      sampleRate: encoded.sampleRate,
      duration: encoded.duration,
      wordTimes: times,
      bytes: encoded.data.byteLength,
    },
    [encoded.data]
  );
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const run = request.type === "init" ? init(request.voiceId) : synth(request);
  void run.catch((error: unknown) => {
    post({
      type: "error",
      key: request.type === "synth" ? request.key : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  });
};
