// Main-thread half of synthesis: owns the worker, the generation queue, and
// the manifest.
//
// Work is ordered from the playhead outwards rather than front-to-back, so
// streaming stays ahead of playback and a seek re-points the queue instead of
// waiting out the chunks nobody is about to hear.

import { decodeAudio } from "@/lib/tts/codec";
import { isOutOfMemory } from "@/lib/tts/errors";
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

// A worker can also just die — the browser kills the thread outright under
// memory pressure, and there is no message to read afterwards. It looks like
// silence, so it has to be turned back into an answer or the queue waits on a
// reply that can never arrive.
const WORKER_DIED = "the synthesis engine stopped unexpectedly";

function recoverable(message: string): boolean {
  return isOutOfMemory(message) || message === WORKER_DIED;
}

// Consecutive failures are their own claim: that says the engine is gone, not
// that three sentences in a row are unsayable.
const MAX_CONSECUTIVE_FAILURES = 3;

// How many times one sentence is worth attempting across the life of an
// audiobook. Only memory failures get the second attempt — the worker has
// already divided and retried anything else before reporting it, so a repeat
// would be the same work for the same answer.
const MAX_ATTEMPTS = 2;

// A budget for the whole audiobook rather than per chunk. With the session
// hoisted out of the per-chunk path this should never be spent; if something
// is still leaking, two restarts is enough to prove it and stop, instead of
// restarting the engine between every sentence for the rest of the article.
const MAX_RESTARTS = 2;

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
  private restarts = 0;
  // Sentences the engine wouldn't produce, and how many times it was asked.
  // Held in memory and never written to the manifest: the failure is about
  // this engine on this run, and a reload deserves a clean attempt rather than
  // inheriting a verdict.
  private attempts = new Map<string, number>();
  // The subset that won't be asked again — either because the answer can't
  // change, or because it has been asked enough.
  private givenUp = new Set<string>();
  private failures = 0;
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
    if (!chunk) return null;
    if (chunk.duration === null) {
      // Never attempted: not ready, and the player should wait for it.
      if (!this.attempts.has(chunk.key)) return null;
      // Attempted and not there. Silence rather than nothing — nothing reads
      // as an underrun and the reading would sit waiting for audio that isn't
      // coming, where this pauses over the sentence and moves on, keeping the
      // beat that follows it. Not a verdict: a later pass that succeeds gives
      // the sentence back, and the next play gets the audio.
      return { audio: new Float32Array(0), sampleRate: 24000 };
    }
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
      worker.onerror = (event) => {
        const message = event.message || WORKER_DIED;
        // A no-op once the engine is up; from then on the chunks in flight are
        // what needs answering.
        reject(new Error(message));
        this.failWaiting(message);
      };

      const init: WorkerRequest = { type: "init", voiceId: this.voiceId };
      worker.postMessage(init);
    });

    this.starting.catch(() => {
      this.starting = null;
    });
    return this.starting;
  }

  // Settles every chunk still waiting on the worker. Called when the worker
  // goes away, which is the one case where no reply is ever coming.
  private failWaiting(message: string) {
    const pending = [...this.waiting.values()];
    this.waiting.clear();
    for (const settle of pending) settle({ type: "error", message });
  }

  // Trades the worker for a new one. The wasm heap belongs to the thread, so a
  // fresh thread is the only way to get a fresh heap — and the voice is on
  // disk by now, so the restart costs a model load rather than a download.
  private async restart(): Promise<void> {
    this.restarts++;
    this.worker?.terminate();
    this.worker = null;
    this.status = null;
    this.starting = null;
    this.waiting.clear();
    await this.ensureWorker();
  }

  private async startEngine(): Promise<void> {
    try {
      await this.ensureWorker();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!recoverable(message) || this.restarts >= MAX_RESTARTS) throw error;
      // Loading the model was itself what ran out of room: another tab, or an
      // earlier engine in this one, is holding memory it may since have given
      // back. Worth one clean attempt before giving up on the article.
      await this.restart();
    }
  }

  // Synthesis with one recovery attempt. The retry runs against a new worker,
  // so the chunk that failed is retried with the whole heap to itself.
  private async synthesize(chunk: StoredChunk): Promise<WorkerResponse> {
    const response = await this.send(chunk);
    if (response.type !== "error" || !recoverable(response.message)) {
      return response;
    }
    if (this.stopped || this.restarts >= MAX_RESTARTS) return response;

    await this.restart();
    if (this.stopped) return response;
    return this.send(chunk);
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
        speech: chunk.speech,
        speechWords: chunk.speechWords,
        scales: chunk.scales,
      };
      this.worker?.postMessage(request);
    });
  }

  // Still worth generating: not done, and not given up on.
  private pending(chunk: StoredChunk): boolean {
    return chunk.duration === null && !this.givenUp.has(chunk.key);
  }

  // The chunk nearest ahead of the playhead wins; only once everything from
  // the cursor forward is done do we fill in behind it, which matters when a
  // listener seeks backwards or asks for the whole article.
  private scan(match: (chunk: StoredChunk) => boolean): number {
    const chunks = this.book.chunks;
    for (let i = this.cursor; i < chunks.length; i++) {
      if (match(chunks[i])) return i;
    }
    if (!this.wantAll) return -1;
    for (let i = 0; i < this.cursor; i++) {
      if (match(chunks[i])) return i;
    }
    return -1;
  }

  private next(): number {
    const fresh = this.scan(
      (chunk) => this.pending(chunk) && !this.attempts.has(chunk.key)
    );
    if (fresh !== -1) return fresh;

    // Then the failures still worth another attempt. Left until last on
    // purpose: generating the rest of the article is time for whatever caused
    // them to pass, which is the only thing that makes asking again different
    // from asking again immediately.
    return this.scan((chunk) => this.pending(chunk));
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
      await this.startEngine();

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
          this.failures = 0;
        } else {
          const response = await this.synthesize(chunk);
          if (this.stopped) break;

          if (response.type === "chunk") {
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
            this.failures = 0;
          } else {
            // A sentence the engine won't say is a hole in the reading. An
            // article that stops reading at that sentence is a broken feature,
            // and worse, the player asks for the missing chunk again the
            // moment it reaches it, so failing here used to mean retrying the
            // same sentence for as long as the page stayed open.
            const message =
              response.type === "error" ? response.message : "synthesis failed";
            const tries = (this.attempts.get(chunk.key) ?? 0) + 1;
            this.attempts.set(chunk.key, tries);
            // Memory pressure is a fact about the tab, not about the sentence,
            // so it earns another attempt once the rest of the article is
            // done. Anything else has already been divided and retried inside
            // the worker, and asking again is the same work for the same
            // answer.
            if (!isOutOfMemory(message) || tries >= MAX_ATTEMPTS) {
              this.givenUp.add(chunk.key);
            }

            this.failures++;
            if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
              this.emitState({ status: "error", message });
              break;
            }
          }
        }

        this.schedulePersist();
        this.events.onChunk?.(index);
        // Skipped sentences count as settled, or the article would sit at
        // "generating" forever waiting on work that will never be scheduled.
        this.emitState(
          !this.book.chunks.some((entry) => this.pending(entry))
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
    this.status = null;
    this.starting = null;
    this.failWaiting("generation stopped");
  }
}
