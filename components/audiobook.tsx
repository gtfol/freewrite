"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { TextIndex } from "@/lib/highlights";
import { AudiobookGenerator } from "@/lib/tts/client";
import {
  clearHighlight,
  clearOverlay,
  highlightApiSupported,
  normOffsetAtPoint,
  paintOverlay,
  rangeForSpan,
  SENTENCE_HIGHLIGHT,
  setHighlight,
  WORD_HIGHLIGHT,
} from "@/lib/tts/paint";
import {
  AudiobookPlayer,
  type PlayerState,
  type Position,
} from "@/lib/tts/player";
import { buildTimeline } from "@/lib/tts/timing";
import { contentHash, segmentArticle } from "@/lib/tts/segment";
import { collectGarbage, requestPersistence } from "@/lib/tts/store";
import { DEFAULT_VOICE, findVoice, VOICES } from "@/lib/tts/voices";
import type { Article } from "@/lib/types";
import type { GenerationState, StoredChunk } from "@/lib/tts/types";

const VOICE_KEY = "freewrite:tts-voice";
const SPEED_KEY = "freewrite:tts-speed";
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
// The scrubber and time label don't need 60fps; the highlight does, and it
// repaints imperatively rather than through React.
const UI_THROTTLE_MS = 250;

const itemClass =
  "text-muted-foreground transition-colors hover:text-foreground";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

// A stored choice only counts if it still exists — voices removed from the
// catalog fall back rather than wedging the transport.
function preferredVoice(): string {
  const stored =
    typeof localStorage !== "undefined" ? localStorage.getItem(VOICE_KEY) : null;
  return stored && findVoice(stored) ? stored : DEFAULT_VOICE;
}

export function Audiobook({
  article,
  contentRef,
  wrapRef,
}: {
  article: Article;
  contentRef: React.RefObject<HTMLDivElement | null>;
  wrapRef: React.RefObject<HTMLDivElement | null>;
}) {
  // Both read once at mount. The transport only exists after a click, so
  // neither runs during a server render.
  const [voiceId, setVoiceId] = useState<string>(preferredVoice);
  const [speed, setSpeed] = useState(() => {
    if (typeof localStorage === "undefined") return 1;
    const stored = Number(localStorage.getItem(SPEED_KEY));
    return SPEEDS.includes(stored) ? stored : 1;
  });
  const [generation, setGeneration] = useState<GenerationState>({ status: "idle" });
  const [playerState, setPlayerState] = useState<PlayerState>("idle");
  const [display, setDisplay] = useState({ time: 0, total: 0 });
  const [pinned, setPinned] = useState(false);

  const generatorRef = useRef<AudiobookGenerator | null>(null);
  const playerRef = useRef<AudiobookPlayer | null>(null);
  const indexRef = useRef<TextIndex | null>(null);
  const chunksRef = useRef<StoredChunk[]>([]);
  const paintedRef = useRef("");
  const lastUiRef = useRef(0);
  const nativePaint = useRef(false);

  useEffect(() => {
    void requestPersistence();
  }, []);

  const paint = useCallback(
    (chunkIndex: number, wordIndex: number) => {
      const index = indexRef.current;
      const chunk = chunksRef.current[chunkIndex];
      if (!index || !chunk) return;

      const signature = `${chunkIndex}:${wordIndex}`;
      if (paintedRef.current === signature) return;
      paintedRef.current = signature;

      const word = wordIndex >= 0 ? chunk.words[wordIndex] : undefined;
      const wordRange = word ? rangeForSpan(index, word.start, word.end) : null;
      const sentenceRange = rangeForSpan(index, chunk.normStart, chunk.normEnd);

      if (nativePaint.current) {
        setHighlight(SENTENCE_HIGHLIGHT, sentenceRange ? [sentenceRange] : []);
        setHighlight(WORD_HIGHLIGHT, wordRange ? [wordRange] : []);
      } else if (wrapRef.current) {
        paintOverlay(wrapRef.current, wordRange);
      }

      // Follow the reading, but only when it has left the viewport entirely —
      // yanking the page while someone is reading ahead is worse than a
      // highlight they have to scroll to find.
      if (sentenceRange) {
        const rect = sentenceRange.getBoundingClientRect();
        const offscreen =
          rect.bottom < 80 || rect.top > window.innerHeight - 140;
        if (offscreen && rect.height > 0) {
          window.scrollBy({
            top: rect.top - window.innerHeight * 0.4,
            behavior: "smooth",
          });
        }
      }
    },
    [wrapRef]
  );

  const onPosition = useCallback(
    (position: Position) => {
      paint(position.chunkIndex, position.wordIndex);
      const now = performance.now();
      if (now - lastUiRef.current < UI_THROTTLE_MS) return;
      lastUiRef.current = now;
      setDisplay({ time: position.time, total: position.total });
    },
    [paint]
  );

  // Build everything once the voice is known. Re-runs on a voice change,
  // which is a full rebuild by design: mixing engines mid-article would
  // change narrator between paragraphs.
  useEffect(() => {
    if (!voiceId) return;
    const root = contentRef.current;
    if (!root) return;

    // Captured for cleanup: the ref may already be detached by teardown.
    const wrap = wrapRef.current;
    let disposed = false;
    nativePaint.current = highlightApiSupported();

    void (async () => {
      const voice = findVoice(voiceId);
      if (!voice) return;

      const { index, chunks } = await segmentArticle(root, voiceId, voice.model);
      if (disposed) return;
      if (chunks.length === 0) {
        setGeneration({ status: "error", message: "Nothing here to read aloud." });
        return;
      }

      const hash = await contentHash(chunks);
      if (disposed) return;

      const generator = new AudiobookGenerator(article.id, voiceId, chunks, hash, {
        onState: setGeneration,
        onChunk: (chunkIndex) => {
          playerRef.current?.setChunks(generator.chunks);
          playerRef.current?.notifyChunkReady(chunkIndex);
        },
      });
      await generator.open();
      if (disposed) {
        generator.dispose();
        return;
      }

      const player = new AudiobookPlayer((i) => generator.audio(i), {
        onPosition,
        onState: setPlayerState,
        onNeed: (i) => generator.prioritize(i),
      });
      player.setChunks(generator.chunks);
      player.setSpeed(speed);

      indexRef.current = index;
      chunksRef.current = generator.chunks;
      generatorRef.current = generator;
      playerRef.current = player;
      setPinned(generator.pinned);
      setDisplay({ time: 0, total: buildTimeline(generator.chunks).total });
      setGeneration(
        generator.readyCount === generator.chunks.length
          ? { status: "ready" }
          : { status: "idle" }
      );
    })();

    return () => {
      disposed = true;
      playerRef.current?.dispose();
      generatorRef.current?.dispose();
      playerRef.current = null;
      generatorRef.current = null;
      clearHighlight(WORD_HIGHLIGHT);
      clearHighlight(SENTENCE_HIGHLIGHT);
      if (wrap) clearOverlay(wrap);
      paintedRef.current = "";
      void collectGarbage();
    };
    // `speed` is applied imperatively below; re-running here would rebuild the
    // whole audiobook every time someone nudged the speed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceId, article.id, contentRef, onPosition]);

  // Click-to-seek. Guarded on a collapsed selection so it never steals the
  // mouseup that ends a highlight drag, and skipped for links and note chips
  // which have their own behaviour.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;

    const onClick = (event: MouseEvent) => {
      const player = playerRef.current;
      const index = indexRef.current;
      if (!player || !index) return;
      if (player.getState() === "idle") return;

      const target = event.target as HTMLElement | null;
      if (target?.closest("a, [data-hl-chip], button")) return;
      if (!window.getSelection()?.isCollapsed) return;

      const offset = normOffsetAtPoint(index, event.clientX, event.clientY);
      if (offset === null) return;

      const chunks = chunksRef.current;
      let chunkIndex = -1;
      for (let i = 0; i < chunks.length; i++) {
        if (offset < chunks[i].normEnd) {
          chunkIndex = i;
          break;
        }
      }
      if (chunkIndex === -1) return;

      // Land on the clicked word when its timing is known, so clicking deep
      // into a long sentence doesn't restart the whole sentence.
      const chunk = chunks[chunkIndex];
      let into = 0;
      if (chunk.wordTimes) {
        for (let w = 0; w < chunk.words.length; w++) {
          if (chunk.words[w].start <= offset) into = chunk.wordTimes[w] ?? 0;
          else break;
        }
      }
      player.seekToChunk(chunkIndex, into);
    };

    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [contentRef]);

  const playing = playerState === "playing" || playerState === "buffering";

  const toggle = () => {
    // play() already points the generator at the resume position through
    // onNeed. Prioritising anything here would override that and send
    // synthesis back to the top of the article after a seek.
    playerRef.current?.toggle();
  };

  const changeSpeed = (next: number) => {
    setSpeed(next);
    localStorage.setItem(SPEED_KEY, String(next));
    playerRef.current?.setSpeed(next);
  };

  const changeVoice = (next: string) => {
    localStorage.setItem(VOICE_KEY, next);
    setVoiceId(next);
    setPlayerState("idle");
    setGeneration({ status: "idle" });
  };

  // Removing a download is a storage decision, not a reading one, so it lives
  // in the storage panel on /read rather than in the transport.
  const download = () => {
    void generatorRef.current?.pin().then(() => setPinned(true));
  };

  const scrub = (event: React.MouseEvent<HTMLDivElement>) => {
    const player = playerRef.current;
    if (!player || display.total <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    player.seekToTime(Math.max(0, Math.min(1, ratio)) * display.total);
  };

  const voice = voiceId ? findVoice(voiceId) : undefined;
  const progress = display.total > 0 ? display.time / display.total : 0;

  const status = (() => {
    if (generation.status === "error") {
      // Voices are fetched on first use, so the common failure is the network
      // rather than anything the raw message would help with. Nothing else is
      // fit to show either: the engine is Emscripten output and throws raw
      // pointers, so an unrecognized message is as likely to be an integer as
      // a sentence. The worker logs the original object for whoever is
      // debugging it.
      return /fetch|network|load|http/i.test(generation.message)
        ? "Couldn't download the voice — check your connection."
        : "Couldn't read this one aloud.";
    }
    if (generation.status === "loading-model") {
      return `Downloading voice… ${Math.round(generation.progress * 100)}%`;
    }
    if (playerState === "buffering") return "Buffering…";
    if (generation.status === "generating") {
      return `Generating ${generation.done}/${generation.total}`;
    }
    return null;
  })();

  return (
    <div className="border-t border-border/60">
      <div className="mx-auto flex max-w-[650px] flex-col gap-2 px-6 pt-3">
        <div
          onClick={scrub}
          className="group h-1 w-full cursor-pointer rounded-full bg-border"
        >
          <div
            className="h-full rounded-full bg-foreground/60 transition-[width] duration-200"
            style={{ width: `${Math.min(100, progress * 100)}%` }}
          />
        </div>

        <div className="flex items-center gap-3 text-[13px]">
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? "Pause" : "Play"}
            className="flex items-center text-foreground transition-opacity hover:opacity-70"
          >
            {playerState === "buffering" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : playing ? (
              <Pause className="size-4" />
            ) : (
              <Play className="size-4" />
            )}
          </button>

          <span className="tabular-nums text-muted-foreground">
            {formatTime(display.time)} / {formatTime(display.total)}
          </span>

          <Popover>
            <PopoverTrigger className={itemClass}>{speed}×</PopoverTrigger>
            <PopoverContent side="top" align="center" className="w-24 p-1">
              {SPEEDS.map((option) => (
                <button
                  key={option}
                  onClick={() => changeSpeed(option)}
                  className={`w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent ${
                    option === speed ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {option}×
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger className={itemClass}>
              {voice?.name ?? "Voice"}
            </PopoverTrigger>
            <PopoverContent side="top" align="center" className="w-60 p-1">
              {VOICES.map((option) => (
                <button
                  key={option.id}
                  onClick={() => changeVoice(option.id)}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                    option.id === voiceId ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {option.name}
                  <span className="block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <button
            type="button"
            onClick={download}
            disabled={pinned}
            className={`${itemClass} disabled:opacity-40`}
          >
            {pinned ? "Downloaded" : "Download"}
          </button>

          {status && (
            <span className="ml-auto truncate text-xs text-muted-foreground">
              {status}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
