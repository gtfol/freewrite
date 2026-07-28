// Main-thread half of synthesis: owns the worker, the generation queue, and
// the manifest.
//
// Work is ordered from the playhead outwards rather than front-to-back, so
// streaming stays ahead of playback and a seek re-points the queue instead of
// waiting out the chunks nobody is about to hear.

import { decodeAudio } from "@/lib/tts/codec";
import { getAudiobook, getChunk, putAudiobook, putChunk } from "@/lib/tts/store";
import { findVoice } from "@/lib/tts/voices";
import type {
  Audiobook,
  Chunk,
  EngineId,
  GenerationState,
  StoredChunk,
} from "@/lib/tts/types";
import type { WorkerRequest, WorkerResponse } from "@/lib/tts/worker";

// Manifest writes are small but frequent; batching keeps a 300-sentence
// article from doing 300 serialisations of the same growing object.
const PERSIST_DEBOUNCE_MS = 1500;

export interface EngineStatus {
  engine: EngineId;
}

export interface GeneratorEvents {
  onState?: (state: GenerationState) => void;
  onChunk?: (index: number) => void;
}

function blankChunk(chunk: Chunk): StoredChunk {
  return { ...chunk, duration: null, wordTimes: null, bytes: null };
}

export class AudiobookGenerator {
  private worker: Worker | null = null;
  private starting: Promise<EngineStatus> | null = null;
  private status: EngineStatus | null = null;
  private waiting = new Map<string, (response: WorkerResponse) => void>();
  private running = false;
  private stopped = false;
  private cursor = 0;
  private wantAll = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private book: Audiobook;

  constructor(
    private articleId: string,
    private voiceId: string,
    chunks: Chunk[],
    private contentHash: string,
    private events: GeneratorEvents = {}
  ) {
    const voice = findVoice(voiceId);
    this.book = {
      articleId,
      contentHash,
      voiceId,
      // Provisional until the worker reports back — the manifest records what
      // actually produced the audio, not what we hoped would.
      engine: voice?.engine ?? "piper",
      model: voice?.model ?? "",
      chunks: chunks.map(blankChunk),
      pinned: false,
      createdAt: Date.now(),
      lastPlayedAt: Date.now(),
    };
  }

  // Adopts a cached manifest when it still describes this article, this voice
  // and this text. Anything else — a trim, a Restore, a voice switch — starts
  // clean, and the collector reclaims whatever the old manifest held.
  async open(): Promise<void> {
    const cached = await getAudiobook(this.articleId);
    // `model` belongs in this check as much as the voice does: chunk keys are
    // hash(model, voice, text), so adopting a manifest built against an older
    // model would keep playing audio the current keys no longer point at.
    if (
      cached &&
      cached.contentHash === this.contentHash &&
      cached.voiceId === this.voiceId &&
      cached.model === this.book.model &&
      cached.chunks.length === this.book.chunks.length
    ) {
      this.book = { ...cached, lastPlayedAt: Date.now() };
    }
    await putAudiobook(this.book);
  }

  get chunks(): StoredChunk[] {
    return this.book.chunks;
  }

  get pinned(): boolean {
    return this.book.pinned;
  }

  isReady(index: number): boolean {
    return this.book.chunks[index]?.duration !== null;
  }

  get readyCount(): number {
    return this.book.chunks.filter((chunk) => chunk.duration !== null).length;
  }

  // Decoded samples for a generated chunk, or null if it isn't ready yet.
  async audio(index: number) {
    const chunk = this.book.chunks[index];
    if (!chunk || chunk.duration === null) return null;
    const record = await getChunk(chunk.key);
    if (!record) return null;
    return decodeAudio(record);
  }

  private emitState(state: GenerationState) {
    this.events.onState?.(state);
  }

  private async ensureWorker(): Promise<EngineStatus> {
    if (this.status) return this.status;
    if (this.starting) return this.starting;

    this.starting = new Promise<EngineStatus>((resolve, reject) => {
      const worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      });
      this.worker = worker;

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (message.type === "progress") {
          const ratio = message.total > 0 ? message.loaded / message.total : 0;
          this.emitState({
            status: "loading-model",
            progress: Math.min(1, Math.max(0, ratio)),
          });
          return;
        }
        if (message.type === "ready") {
          this.status = { engine: message.engine };
          this.book.engine = message.engine;
          resolve(this.status);
          return;
        }
        if (message.type === "chunk" || message.type === "error") {
          if (message.type === "error" && !message.key) {
            reject(new Error(message.message));
            return;
          }
          const key = message.key;
          if (key) this.waiting.get(key)?.(message);
        }
      };
      worker.onerror = (event) =>
        reject(new Error(event.message || "synthesis worker failed"));

      const init: WorkerRequest = { type: "init", voiceId: this.voiceId };
      worker.postMessage(init);
    });

    this.starting.catch(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private send(chunk: StoredChunk): Promise<WorkerResponse> {
    return new Promise((resolve) => {
      this.waiting.set(chunk.key, (response) => {
        this.waiting.delete(chunk.key);
        resolve(response);
      });
      const request: WorkerRequest = {
        type: "synth",
        key: chunk.key,
        text: chunk.text,
        normStart: chunk.normStart,
        words: chunk.words,
      };
      this.worker?.postMessage(request);
    });
  }

  // The chunk nearest ahead of the playhead wins; only once everything from
  // the cursor forward is done do we fill in behind it, which matters when a
  // listener seeks backwards or asks for the whole article.
  private next(): number {
    const chunks = this.book.chunks;
    for (let i = this.cursor; i < chunks.length; i++) {
      if (chunks[i].duration === null) return i;
    }
    if (!this.wantAll) return -1;
    for (let i = 0; i < this.cursor; i++) {
      if (chunks[i].duration === null) return i;
    }
    return -1;
  }

  private schedulePersist(force = false) {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (force) {
      void putAudiobook(this.book);
      return;
    }
    this.persistTimer = setTimeout(() => {
      void putAudiobook(this.book);
    }, PERSIST_DEBOUNCE_MS);
  }

  private async drain() {
    if (this.running) return;
    this.running = true;

    try {
      await this.ensureWorker();

      for (let index = this.next(); index !== -1; index = this.next()) {
        if (this.stopped) break;
        const chunk = this.book.chunks[index];

        // A cache hit from another article (or an earlier session) skips the
        // model entirely — the whole point of content-addressed chunks.
        const cached = await getChunk(chunk.key);
        if (cached) {
          chunk.duration = cached.duration;
          chunk.bytes = cached.bytes;
          chunk.wordTimes ??= [];
        } else {
          const response = await this.send(chunk);
          if (this.stopped) break;
          if (response.type === "error") {
            this.emitState({ status: "error", message: response.message });
            break;
          }
          if (response.type !== "chunk") break;

          await putChunk({
            key: response.key,
            format: response.format,
            data: response.data,
            sampleRate: response.sampleRate,
            duration: response.duration,
            bytes: response.bytes,
            createdAt: Date.now(),
          });
          chunk.duration = response.duration;
          chunk.wordTimes = response.wordTimes;
          chunk.bytes = response.bytes;
        }

        this.schedulePersist();
        this.events.onChunk?.(index);
        this.emitState(
          this.readyCount === this.book.chunks.length
            ? { status: "ready" }
            : {
                status: "generating",
                done: this.readyCount,
                total: this.book.chunks.length,
              }
        );
      }
      this.schedulePersist(true);
    } catch (error) {
      this.emitState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  // Point generation at a new position (a seek, or playback advancing) and
  // make sure the queue is moving.
  prioritize(index: number) {
    this.cursor = Math.max(0, Math.min(index, this.book.chunks.length - 1));
    void this.drain();
  }

  generateAll() {
    this.wantAll = true;
    void this.drain();
  }

  // A download is a promise the audio will still be there later, so pinning
  // exempts it from eviction.
  async pin(): Promise<void> {
    this.book.pinned = true;
    this.wantAll = true;
    await putAudiobook(this.book);
    void this.drain();
  }

  async unpin(): Promise<void> {
    this.book.pinned = false;
    await putAudiobook(this.book);
  }

  dispose() {
    this.stopped = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    void putAudiobook(this.book);
    this.worker?.terminate();
    this.worker = null;
    this.starting = null;
  }
}
