/// <reference lib="webworker" />

// Synthesis worker. Both engines live behind one `Engine` shape, so the rest
// of the app never learns which one is running — only the manifest records it,
// because an audiobook that switched engines halfway would change narrator
// between paragraphs.
//
// The worker also trims silence, derives word times, and encodes to Opus, so
// the main thread gets a finished chunk and never sees a raw waveform.

import { encodeAudio } from "@/lib/tts/codec";
import { trimSilence, wordTimes } from "@/lib/tts/timing";
import { engineVoiceId, findVoice, KOKORO_MODEL } from "@/lib/tts/voices";
import type { EngineId, WordSpan } from "@/lib/tts/types";

interface Engine {
  synth(text: string): Promise<{ audio: Float32Array; sampleRate: number }>;
}

// Structural, so the app doesn't take a dependency on @webgpu/types just to
// ask whether an adapter exists.
type GpuLike = { requestAdapter(): Promise<unknown> };

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
  | { type: "ready"; engine: EngineId; accelerated: boolean }
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

// `navigator.gpu` existing is not enough — a blocklisted driver still hands
// back a null adapter, and that is the case we must not mistake for support.
async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function loadKokoro(voice: string, accelerated: boolean): Promise<Engine> {
  const { KokoroTTS } = await import("kokoro-js");

  // fp16 on WebGPU is the quality/size compromise: fp32 is the upstream
  // recommendation but a ~300MB download, and q8 exists for the CPU path
  // where memory bandwidth, not fidelity, is the limit.
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype: accelerated ? "fp16" : "q8",
    device: accelerated ? "webgpu" : "wasm",
    progress_callback: (progress) => {
      const item = progress as { loaded?: number; total?: number };
      if (typeof item.loaded === "number" && typeof item.total === "number") {
        post({ type: "progress", loaded: item.loaded, total: item.total });
      }
    },
  });

  return {
    async synth(text) {
      // Voices are validated against our own catalog at init, so the cast
      // past kokoro-js's literal union is safe.
      const options = { voice } as Parameters<typeof tts.generate>[1];
      const raw = await tts.generate(text, options);
      return { audio: raw.audio, sampleRate: raw.sampling_rate };
    },
  };
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

  const bare = engineVoiceId(voice);
  const accelerated = voice.engine === "kokoro" ? await hasWebGPU() : false;
  engine =
    voice.engine === "kokoro"
      ? await loadKokoro(bare, accelerated)
      : await loadPiper(bare);

  post({ type: "ready", engine: voice.engine, accelerated });
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
