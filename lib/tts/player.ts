// Gap-aware playback.
//
// Chunks are scheduled through Web Audio rather than handed to an <audio>
// element, for two reasons: playback can start on chunk one while the rest is
// still being generated, and AudioContext.currentTime is a sample-accurate
// clock, which is what word highlighting needs.
//
// Silence between chunks lives here and nowhere else. The audio itself is
// trimmed clean, so every pause in the reading is one this scheduler placed.

import { buildTimeline, wordIndexAt } from "@/lib/tts/timing";
import type { Samples } from "@/lib/tts/codec";
import type { StoredChunk } from "@/lib/tts/types";

const LOOKAHEAD = 3;
const PREROLL_SECONDS = 0.08;
const BUFFER_CACHE = 16;
// Pauses shrink more slowly than speech does. At 2x, halving them too would
// collapse paragraph structure into a wall of words; this keeps the beats
// audible while still feeling faster.
const GAP_SPEED_EXPONENT = 0.6;

export type PlayerState = "idle" | "playing" | "paused" | "buffering" | "ended";

export interface Position {
  chunkIndex: number;
  wordIndex: number;
  time: number;
  total: number;
}

export interface PlayerCallbacks {
  onPosition?: (position: Position) => void;
  onState?: (state: PlayerState) => void;
  // Asks the generator to move the queue here — a seek into ungenerated text
  // should not wait behind chunks nobody is about to hear.
  onNeed?: (index: number) => void;
}

type FetchAudio = (
  index: number
) => Promise<{ audio: Samples; sampleRate: number } | null>;

interface Scheduled {
  index: number;
  start: number;
  end: number;
  offset: number;
  source: AudioBufferSourceNode;
}

export class AudiobookPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private chunks: StoredChunk[] = [];
  private scheduled: Scheduled[] = [];
  private buffers = new Map<number, AudioBuffer>();
  private state: PlayerState = "idle";
  private speed = 1;
  private nextIndex = 0;
  private nextTime = 0;
  private nextOffset = 0;
  private pumping = false;
  private frame = 0;
  private resumeAt: { index: number; offset: number } = { index: 0, offset: 0 };

  constructor(
    private fetchAudio: FetchAudio,
    private callbacks: PlayerCallbacks = {}
  ) {}

  // Rebuilt on demand rather than every frame: the position callback runs at
  // 60fps and the article can be hundreds of sentences long.
  private timeline: { starts: number[]; total: number } | null = null;

  setChunks(chunks: StoredChunk[]) {
    this.chunks = chunks;
    this.timeline = null;
  }

  private currentTimeline() {
    if (!this.timeline) this.timeline = buildTimeline(this.chunks);
    return this.timeline;
  }

  getState(): PlayerState {
    return this.state;
  }

  getSpeed(): number {
    return this.speed;
  }

  private setState(state: PlayerState) {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onState?.(state);
  }

  private gapSeconds(index: number): number {
    const gap = (this.chunks[index]?.gapAfter ?? 0) / 1000;
    return gap / Math.pow(this.speed, GAP_SPEED_EXPONENT);
  }

  private audioContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private async buffer(index: number): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(index);
    if (cached) return cached;

    const decoded = await this.fetchAudio(index);
    if (!decoded) return null;

    const ctx = this.audioContext();
    const buffer = ctx.createBuffer(
      1,
      Math.max(1, decoded.audio.length),
      decoded.sampleRate
    );
    buffer.copyToChannel(decoded.audio, 0);

    if (this.buffers.size >= BUFFER_CACHE) {
      const oldest = this.buffers.keys().next().value;
      if (oldest !== undefined) this.buffers.delete(oldest);
    }
    this.buffers.set(index, buffer);
    return buffer;
  }

  // A method rather than an inline comparison: playback can be paused during
  // an await inside pump(), and narrowing on this.state would hide that.
  private halted(): boolean {
    return this.state === "paused" || this.state === "idle";
  }

  private async pump() {
    if (this.pumping || this.halted()) return;
    this.pumping = true;

    try {
      const ctx = this.audioContext();
      while (
        this.scheduled.length < LOOKAHEAD &&
        this.nextIndex < this.chunks.length
      ) {
        const index = this.nextIndex;
        const buffer = await this.buffer(index);

        if (!buffer) {
          // Underrun: hold position and wait to be nudged rather than
          // skipping the sentence or glitching through it.
          this.setState("buffering");
          this.callbacks.onNeed?.(index);
          return;
        }
        if (this.halted()) return;

        const offset = this.nextOffset;
        const start = Math.max(this.nextTime, ctx.currentTime + 0.01);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = this.speed;
        source.connect(this.gain ?? ctx.destination);
        source.start(start, Math.min(offset, buffer.duration));

        const end = start + (buffer.duration - offset) / this.speed;
        this.scheduled.push({ index, start, end, offset, source });

        this.nextTime = end + this.gapSeconds(index);
        this.nextOffset = 0;
        this.nextIndex = index + 1;
        this.setState("playing");
      }
    } finally {
      this.pumping = false;
    }
  }

  private tick = () => {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;

    // Keep the most recently finished entry so a gap still reports a
    // position — the last word stays lit rather than blinking off.
    while (this.scheduled.length > 1 && this.scheduled[1].start <= now) {
      this.scheduled.shift();
    }

    const active = this.scheduled.find(
      (entry) => now >= entry.start && now < entry.end
    );
    const current = active ?? this.scheduled[0];

    if (current) {
      // Before the first chunk starts, sit at its offset; inside one, track
      // it; past its end we're in a gap, so hold at the chunk's full length
      // and the last word stays lit like a held breath.
      const inGap = !active && now >= current.end;
      const inChunk = active
        ? (now - current.start) * this.speed + current.offset
        : now < current.start
          ? current.offset
          : (current.end - current.start) * this.speed + current.offset;

      // Resuming from a pause taken during a gap should pick up the next
      // chunk, not restart at the end of the finished one and sit through the
      // same silence twice.
      this.resumeAt = inGap
        ? { index: Math.min(current.index + 1, this.chunks.length - 1), offset: 0 }
        : { index: current.index, offset: inChunk };

      this.report(current.index, inChunk);
    }

    if (
      this.state === "playing" &&
      this.nextIndex >= this.chunks.length &&
      this.scheduled.length > 0 &&
      now >= this.scheduled[this.scheduled.length - 1].end
    ) {
      this.setState("ended");
      this.resumeAt = { index: 0, offset: 0 };
      this.stopSources();
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      return;
    }

    void this.pump();
    this.frame = requestAnimationFrame(this.tick);
  };

  private report(chunkIndex: number, inChunk: number) {
    const chunk = this.chunks[chunkIndex];
    if (!chunk) return;

    const wordIndex = wordIndexAt(chunk.wordTimes, inChunk);
    const { starts, total } = this.currentTimeline();
    this.callbacks.onPosition?.({
      chunkIndex,
      wordIndex,
      time: (starts[chunkIndex] ?? 0) + inChunk,
      total,
    });
  }

  private stopSources() {
    for (const entry of this.scheduled) {
      try {
        entry.source.onended = null;
        entry.source.stop();
      } catch {
        // Already finished; nothing to stop.
      }
    }
    this.scheduled = [];
  }

  private startFrom(index: number, offset: number) {
    const ctx = this.audioContext();
    void ctx.resume();

    this.stopSources();
    this.nextIndex = Math.max(0, Math.min(index, this.chunks.length - 1));
    this.nextOffset = Math.max(0, offset);
    this.nextTime = ctx.currentTime + PREROLL_SECONDS;
    this.resumeAt = { index: this.nextIndex, offset: this.nextOffset };

    this.setState("buffering");
    this.callbacks.onNeed?.(this.nextIndex);
    void this.pump();

    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  play() {
    this.startFrom(this.resumeAt.index, this.resumeAt.offset);
  }

  pause() {
    this.stopSources();
    this.setState("paused");
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  toggle() {
    if (this.state === "playing" || this.state === "buffering") this.pause();
    else this.play();
  }

  // Seeking while paused stages the position without starting sound, so
  // clicking text to set a starting point doesn't force playback.
  seekToChunk(index: number, offset = 0) {
    const wasIdle = this.state === "paused" || this.state === "idle";
    this.resumeAt = { index, offset };
    if (wasIdle) {
      this.report(index, offset);
      this.callbacks.onNeed?.(index);
      return;
    }
    this.startFrom(index, offset);
  }

  seekToTime(time: number) {
    const { starts } = this.currentTimeline();
    let index = 0;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] <= time) index = i;
      else break;
    }
    this.seekToChunk(index, Math.max(0, time - starts[index]));
  }

  setSpeed(speed: number) {
    if (speed === this.speed) return;
    const { index, offset } = this.resumeAt;
    this.speed = speed;
    if (this.state === "playing" || this.state === "buffering") {
      this.startFrom(index, offset);
    }
  }

  // Called when a chunk finishes generating — the way out of an underrun.
  notifyChunkReady(index: number) {
    if (this.state === "buffering" && index === this.nextIndex) {
      void this.pump();
      if (!this.frame) this.frame = requestAnimationFrame(this.tick);
    }
  }

  dispose() {
    this.stopSources();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.buffers.clear();
    void this.ctx?.close();
    this.ctx = null;
    this.gain = null;
    this.setState("idle");
  }
}
