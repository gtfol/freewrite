// Piper (VITS) synthesis, owned rather than borrowed.
//
// This was `@diffusionstudio/vits-web`'s `predict()`, which builds an ONNX
// InferenceSession — a ~60MB copy of the voice — on every call and never
// releases it. One session per sentence, and the sessions are all still alive,
// so the wasm heap climbs by the size of the model per sentence until an
// allocation can't be satisfied. The one that fails is the next copy of the
// model, which is why the message names the model's exact size:
//
//   Can't create a session. failed to allocate a buffer of size 63201294.
//
// The session belongs to the voice, not the sentence: it is built once and
// every chunk runs through it. That also removes most of the per-sentence
// latency, which was a 60MB read plus a graph build before any inference.
//
// vits-web is gone with it — what remains of it here is the voice repository
// and the OPFS cache layout, both kept identical so a reader who has already
// downloaded a voice doesn't download it again.

import createPiperPhonemize from "@diffusionstudio/piper-wasm/build/piper_phonemize.js";
import * as ort from "onnxruntime-web";

import { describeThrown } from "@/lib/tts/errors";
import { VOICE_CACHE_DIR } from "@/lib/tts/voices";

const HF_BASE =
  "https://huggingface.co/diffusionstudio/piper-voices/resolve/main";
// Both of these are version-pinned CDN paths for packages in package.json, and
// have to move when those pins do: they serve the .wasm binaries belonging to
// exactly these builds, and a mismatch fails at instantiation.
const ORT_BASE =
  "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/";
const PHONEMIZE_BASE =
  "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";

export type ProgressCallback = (loaded: number, total: number) => void;

export interface Synthesis {
  audio: Float32Array;
  sampleRate: number;
}

export interface PiperEngine {
  synth(text: string): Promise<Synthesis>;
  release(): Promise<void>;
}

// The sidecar Piper ships next to every voice. Only the fields inference needs.
interface VoiceConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  speaker_id_map: Record<string, number>;
}

// Voice ids are `lang-speaker-quality` and the repository lays them out by
// language family, so the path is derivable rather than table-driven. A voice
// that doesn't follow the convention fails at download with a 404, which the
// UI already reports as a failed voice download.
function modelPath(voiceId: string): string {
  const parts = voiceId.split("-");
  const lang = parts[0];
  const quality = parts[parts.length - 1];
  const speaker = parts.slice(1, -1).join("-");
  return `${lang.split("_")[0]}/${lang}/${speaker}/${quality}/${voiceId}.onnx`;
}

async function cacheDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(VOICE_CACHE_DIR, { create: true });
  } catch {
    // No OPFS, or storage denied. Synthesis still works, it just re-downloads.
    return null;
  }
}

async function readCache(name: string): Promise<Blob | null> {
  const dir = await cacheDir();
  if (!dir) return null;
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    // A zero-length file is an interrupted write, not a cached voice.
    return file.size > 0 ? file : null;
  } catch {
    return null;
  }
}

async function writeCache(name: string, blob: Blob): Promise<void> {
  const dir = await cacheDir();
  if (!dir) return;
  try {
    const writable = await (
      await dir.getFileHandle(name, { create: true })
    ).createWritable();
    await writable.write(blob);
    await writable.close();
  } catch {
    // Out of quota, most likely. The cost is a download next time.
  }
}

// Streamed so the caller can show progress on the one file big enough to need
// it. Collected as a Blob rather than one growing buffer: the browser is free
// to spill it, which matters when the thing being downloaded is 60MB.
async function download(url: string, onProgress?: ProgressCallback): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to download voice (${response.status})`);
  }

  const reader = response.body?.getReader();
  if (!reader) return response.blob();

  const total = Number(response.headers.get("Content-Length") ?? 0);
  const parts: BlobPart[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  return new Blob(parts);
}

async function voiceFile(
  name: string,
  url: string,
  onProgress?: ProgressCallback
): Promise<Blob> {
  const cached = await readCache(name);
  if (cached) return cached;

  const blob = await download(url, onProgress);
  await writeCache(name, blob);
  return blob;
}

// Text to phoneme ids, through the espeak-ng build Piper was trained against.
//
// One module per call, which is what vits-web did. Re-entering an Emscripten
// `main()` isn't something this build promises, and the instance is small,
// self-contained and collectable — unlike the ONNX session above, which shares
// one heap with every other session and so had to be the thing that got fixed.
async function phonemize(espeakVoice: string, text: string): Promise<number[]> {
  const input = JSON.stringify([{ text: text.trim() }]);

  return new Promise<number[]>((resolve, reject) => {
    let settled = false;
    // espeak-ng talks on stderr about things it recovered from as well as
    // things it didn't, so a line here isn't a failure by itself. They're kept
    // to explain one if it comes.
    const complaints: string[] = [];

    // What espeak-ng said on its way down is the only account of why it went.
    // An uncaught C++ exception arrives in JS as a bare pointer — Emscripten's
    // `___cxa_throw` ends in `throw exceptionLast`, an integer — so the throw
    // itself carries nothing, and these lines are the whole diagnosis. They go
    // on every failure, not just the ones they obviously explain.
    const fail = (reason: string) => {
      settled = true;
      const said = complaints.join("; ").slice(0, 200);
      reject(
        new Error(
          said
            ? `the phonemizer failed: ${reason} — it said: ${said}`
            : `the phonemizer failed: ${reason}, and said nothing`
        )
      );
    };

    void createPiperPhonemize({
      // Phoneme ids arrive as a line of JSON on stdout. Anything else on the
      // way is not ours to interpret.
      print: (line) => {
        try {
          const ids: unknown = JSON.parse(line).phoneme_ids;
          if (!Array.isArray(ids)) return;
          settled = true;
          resolve(ids as number[]);
        } catch {
          complaints.push(line);
        }
      },
      printErr: (line) => complaints.push(line),
      // The binaries are fetched rather than bundled: the espeak-ng data alone
      // is 18MB, which has no business in an app bundle.
      locateFile: (file) =>
        file.endsWith(".wasm")
          ? `${PHONEMIZE_BASE}.wasm`
          : file.endsWith(".data")
            ? `${PHONEMIZE_BASE}.data`
            : file,
    })
      .then((module) => {
        module.callMain([
          "-l",
          espeakVoice,
          "--input",
          input,
          "--espeak_data",
          "/espeak-ng-data",
        ]);
        // main() returned without ever printing phonemes. Reject rather than
        // leave the generator waiting on a promise that can't settle.
        if (!settled) fail("it produced no output");
      })
      // Emscripten reports a native abort as a bare `Aborted()`, and an
      // uncaught C++ exception as a bare integer. Neither names the module or
      // the sentence, which is the difference between a reader seeing
      // something actionable and seeing a pointer.
      .catch((error: unknown) => {
        console.error("[tts] phonemizer threw", error, { text, complaints });
        fail(describeThrown(error));
      });
  });
}

export async function createPiper(
  voiceId: string,
  onProgress?: ProgressCallback
): Promise<PiperEngine> {
  ort.env.wasm.wasmPaths = ORT_BASE;
  // Threads need SharedArrayBuffer, which needs COOP/COEP headers this app
  // doesn't send; ORT would fall back to one thread anyway. Saying so keeps it
  // from reserving pthread stacks it can't use.
  ort.env.wasm.numThreads = 1;

  const path = modelPath(voiceId);
  const name = `${voiceId}.onnx`;

  const config = JSON.parse(
    await (await voiceFile(`${name}.json`, `${HF_BASE}/${path}.json`)).text()
  ) as VoiceConfig;

  const model = await voiceFile(name, `${HF_BASE}/${path}`, onProgress);
  const session = await ort.InferenceSession.create(
    new Uint8Array(await model.arrayBuffer())
  );

  // Fixed for the life of the session, so they're built once too.
  const scales = [
    config.inference.noise_scale,
    config.inference.length_scale,
    config.inference.noise_w,
  ];
  const multiSpeaker = Object.keys(config.speaker_id_map ?? {}).length > 0;

  return {
    async synth(text) {
      const ids = await phonemize(config.espeak.voice, text);

      const feeds: Record<string, ort.Tensor> = {
        input: new ort.Tensor("int64", ids, [1, ids.length]),
        input_lengths: new ort.Tensor("int64", [ids.length]),
        scales: new ort.Tensor("float32", scales),
      };
      // Single-speaker voices have no `sid` input and reject one.
      if (multiSpeaker) feeds.sid = new ort.Tensor("int64", [0]);

      const audio = (await session.run(feeds)).output?.data;
      if (!(audio instanceof Float32Array)) {
        throw new Error("unexpected model output");
      }
      return { audio, sampleRate: config.audio.sample_rate };
    },

    async release() {
      await session.release();
    },
  };
}
