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
import { describeThrown } from "@/lib/tts/errors";
import { createPiper, type Synthesis } from "@/lib/tts/piper";
import { applyRises } from "@/lib/tts/pitch";
import { synthesizeWithRecovery } from "@/lib/tts/recover";
import { wordTimes } from "@/lib/tts/timing";
import { engineVoiceId, findVoice } from "@/lib/tts/voices";
import type { EngineId, Scales, WordSpan } from "@/lib/tts/types";

interface Engine {
  synth(text: string, scales?: Scales): Promise<Synthesis>;
}

export type WorkerRequest =
  | { type: "init"; voiceId: string }
  | {
      type: "synth";
      key: string;
      // The chunk as the engine hears it, and its words in the same
      // coordinates. The displayed text never reaches the worker: what has to
      // be measured is the line that was actually spoken.
      speech: string;
      speechWords: WordSpan[];
      scales: Scales;
      // Word indices that end an item of a coordinated series.
      rises: number[];
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
    (text) => ready.synth(text, request.scales),
    request.speech
  );
  // Measured against the spoken line, including the punctuation prosody
  // planning added: the pause weights are what place a word inside the chunk,
  // and a comma the model observed but the weights didn't would put every word
  // after it early. The times come back indexed by word, and the words are the
  // same words in the same order as the ones on screen.
  const times = wordTimes(request.speech, request.speechWords, 0, audio, sampleRate);

  // Each rise runs from the item's last word to wherever the next one starts,
  // which is the movement plus the comma's pause; pitch.ts trims the pause off
  // for itself. Applied after timing and before encoding — it hands back the
  // same number of samples, so `times` still describes the audio.
  const duration = audio.length / sampleRate;
  const raised = applyRises(
    audio,
    sampleRate,
    request.rises
      .filter((word) => word < times.length)
      .map((word) => ({ from: times[word], to: times[word + 1] ?? duration }))
  );
  const encoded = await encodeAudio(raised, sampleRate);

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
    // Logged before it is described, because describing it is lossy and this
    // is the last place the thrown value exists.
    console.error("[tts] synthesis failed", error);
    post({
      type: "error",
      key: request.type === "synth" ? request.key : undefined,
      message: describeThrown(error),
    });
  });
};
