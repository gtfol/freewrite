/// <reference lib="webworker" />

// Synthesis worker.
//
// Engines live behind one `Engine` shape. Only Piper ships today — Kokoro was
// tried and dropped, since its quantized builds sound metallic and the fp32
// build that doesn't is a ~326MB download that still runs slower on CPU. The
// indirection stays because it is what made that swap a small change.
//
// The engine is built once and lives as long as the worker does. That is load
// bearing rather than tidy — see lib/tts/piper.ts.
//
// The worker also trims silence, derives word times, and encodes to Opus, so
// the main thread gets a finished chunk and never sees a raw waveform.

import { encodeAudio } from "@/lib/tts/codec";
import { createPiper, type Synthesis } from "@/lib/tts/piper";
import { synthesizeWithRecovery } from "@/lib/tts/recover";
import { wordTimes } from "@/lib/tts/timing";
import { engineVoiceId, findVoice } from "@/lib/tts/voices";
import type { EngineId, WordSpan } from "@/lib/tts/types";

interface Engine {
  synth(text: string): Promise<Synthesis>;
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

async function init(voiceId: string) {
  const voice = findVoice(voiceId);
  if (!voice) throw new Error(`unknown voice ${voiceId}`);

  engine = await createPiper(engineVoiceId(voice), (loaded, total) => {
    post({ type: "progress", loaded, total });
  });
  post({ type: "ready", engine: voice.engine });
}

async function synth(request: Extract<WorkerRequest, { type: "synth" }>) {
  const ready = engine;
  if (!ready) throw new Error("engine not initialized");

  // Comes back trimmed: the scheduler owns every millisecond of silence
  // between chunks, so the model's own variable head and tail must go. It may
  // also come back as several engine calls stitched together — see recover.ts.
  const { audio, sampleRate } = await synthesizeWithRecovery(
    (text) => ready.synth(text),
    request.text
  );
  const times = wordTimes(
    request.text,
    request.words,
    request.normStart,
    audio,
    sampleRate
  );
  const encoded = await encodeAudio(audio, sampleRate);

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
