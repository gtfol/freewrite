"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { caretPoint } from "@/lib/caret";
import { isToday, shortDate } from "@/lib/entries";
import { newSketchId, sketchBefore, sketchRef } from "@/lib/sketch";
import { dayOf, trackMarkdown } from "@/lib/spotify";
import { useSpotify } from "@/lib/spotify-connect";
import { currentEntry, useWriter } from "@/lib/store";
import { useSync } from "@/lib/sync";

// Type "/" and the two things you can drop into an entry are a keystroke away:
// the song you played most the day the entry was written, and a whiteboard.

const MENU_WIDTH = 288;
// Enough to decide whether the menu fits below the caret before it renders.
const ROW_HEIGHT = 60;
const MENU_PADDING = 16;

const SONG_KEYWORDS = ["song", "spotify", "music", "track", "day", "listening"];
const DRAW_KEYWORDS = [
  "draw",
  "drawing",
  "whiteboard",
  "sketch",
  "canvas",
  "board",
  "doodle",
];

// Rows are plain data and the key says which command they are, rather than
// each carrying its own callback: what a row does depends on the textarea, and
// a list of closures over that ref isn't something to be building during a
// render.
interface Item {
  key: "song" | "draw";
  label: string;
  hint: string;
  keywords: string[];
}

function matchesQuery(item: Item, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    item.label.toLowerCase().includes(q) ||
    item.keywords.some((k) => k.startsWith(q))
  );
}

// "/" only opens the menu where a word could start, so "and/or" and the
// slashes in a pasted URL are left alone.
function opensAt(value: string, index: number): boolean {
  if (value[index] !== "/") return false;
  const before = value[index - 1];
  return before === undefined || /\s/.test(before);
}

interface Point {
  top: number;
  left: number;
}

export function useSlashMenu(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  { onDraw }: { onDraw: (sketchId: string) => void }
) {
  const configured = useSync((s) => s.providers.spotify);
  const signedIn = Boolean(useSync((s) => s.user));
  const linked = useSpotify((s) => s.linked);
  const song = useSpotify((s) => s.song);
  const loading = useSpotify((s) => s.loading);
  const refreshLink = useSpotify((s) => s.refresh);
  const loadSong = useSpotify((s) => s.loadSong);
  const connect = useSpotify((s) => s.connect);
  const setContent = useWriter((s) => s.setContent);
  // The song belongs to the day the entry was written, not to the clock: an
  // entry opened from last Tuesday asks about last Tuesday. Selected down to
  // the timestamp so switching entries within a day doesn't churn.
  const writtenAt = useWriter((s) => currentEntry(s)?.createdAt ?? null);

  const day = useMemo(
    () => (writtenAt === null ? null : dayOf(writtenAt)),
    [writtenAt]
  );
  // How the menu names that day. "today" for an entry started today, so the
  // common case reads the way it always did.
  const when =
    writtenAt !== null && !isToday(writtenAt)
      ? `on ${shortDate(writtenAt)}`
      : "today";

  // The "/" offset, mirrored in a ref because the input and keydown handlers
  // read it in the same tick they set it.
  const atRef = useRef<number | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [point, setPoint] = useState<Point | null>(null);
  const [cursor, setCursor] = useState(0);
  // The drawing this "/" was typed against, if it followed one.
  const [editing, setEditing] = useState<string | null>(null);

  // Measured here rather than in an effect: the handlers that move the menu
  // run after the DOM already holds the new text, so this is the moment the
  // caret's position is knowable, and it saves a render to find out.
  const place = useCallback(
    (index: number | null, rows: number) => {
      const el = ref.current;
      if (el === null || index === null) {
        setPoint(null);
        return;
      }
      const caret = caretPoint(el, index);
      if (!caret) return;
      const rect = el.getBoundingClientRect();
      const height = rows * ROW_HEIGHT + MENU_PADDING;
      const below = rect.top + caret.top + caret.lineHeight;
      // Writing near the bottom of the window puts the menu above the caret
      // instead, where there's room for it.
      const flip = below + height > window.innerHeight;
      setPoint({
        top: flip ? rect.top + caret.top - height : below,
        left: Math.min(
          rect.left + caret.left,
          window.innerWidth - MENU_WIDTH - 12
        ),
      });
    },
    [ref]
  );

  // Both commands are offered unless Spotify is switched off on the
  // deployment, in which case the song simply isn't one of them.
  const rowCount = configured ? 2 : 1;

  const move = useCallback(
    (index: number | null) => {
      atRef.current = index;
      setAt(index);
      place(index, rowCount);
    },
    [place, rowCount]
  );

  const close = useCallback(() => {
    move(null);
    setQuery("");
    setNote(null);
    setCursor(0);
    setEditing(null);
  }, [move]);

  // Re-derives the menu from wherever the caret actually is. Called on every
  // edit, so a paste or a backspace over the "/" closes it just as reliably as
  // typing does.
  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart;
    const start = atRef.current;

    if (start === null) {
      if (caret > 0 && opensAt(el.value, caret - 1)) {
        setQuery("");
        setNote(null);
        setCursor(0);
        setEditing(sketchBefore(el.value, caret - 1));
        move(caret - 1);
      }
      return;
    }
    if (caret <= start || el.value[start] !== "/") {
      close();
      return;
    }
    const next = el.value.slice(start + 1, caret);
    // A space means it was prose after all.
    if (/\s/.test(next)) {
      close();
      return;
    }
    setQuery(next);
    // Narrowing the list changes how tall the menu is, and a new query starts
    // from the top of what's left.
    setCursor(0);
    // Typing can rewrap the line the "/" sits on and move it.
    place(start, rowCount);
  }, [ref, move, close, place, rowCount]);

  // Replaces the "/song" you typed — the command, not your writing, which is
  // why this runs even with backspace turned off.
  const replaceCommand = useCallback(
    (text: string) => {
      const el = ref.current;
      const start = atRef.current;
      if (!el || start === null) return;
      const end = el.selectionStart;
      el.focus();
      el.setSelectionRange(start, end);
      let applied = false;
      try {
        // execCommand keeps the browser's undo stack intact and fires the
        // input event, so the debounced save runs — the same reason the list
        // edits in editor.tsx go through it.
        applied = text
          ? document.execCommand("insertText", false, text)
          : document.execCommand("delete");
      } catch {
        applied = false;
      }
      if (!applied) {
        const caret = start + text.length;
        setContent(el.value.slice(0, start) + text + el.value.slice(end));
        el.setSelectionRange(caret, caret);
      }
      close();
    },
    [ref, setContent, close]
  );

  const runSong = useCallback(async () => {
    if (!signedIn) {
      setNote("Sign in first — the cloud at the bottom right.");
      return;
    }
    if (linked === false) {
      // Leaves for Spotify and comes back to this page.
      await connect();
      return;
    }
    if (!day) return;
    await loadSong(day);
    const current = useSpotify.getState().song;
    if (!current) return;
    switch (current.state) {
      case "ok":
        replaceCommand(`${trackMarkdown(current.song.track)} `);
        return;
      case "empty":
        setNote(`Nothing played ${when}.`);
        return;
      case "out-of-reach":
        // Nothing to offer and nothing to fix. The record only starts when
        // Spotify was connected, and this entry's day is older than that.
        setNote("That day is from before your listening was being recorded.");
        return;
      case "unlinked":
        setNote("Connect Spotify to use this.");
        return;
      case "reconnect":
        setNote("Spotify access expired — connect again.");
        return;
      case "error":
        setNote(current.message);
        return;
    }
  }, [signedIn, linked, connect, day, when, loadSong, replaceCommand]);

  const runDraw = useCallback(() => {
    if (editing) {
      // The reference is already in the text; the command just goes away.
      replaceCommand("");
      onDraw(editing);
      return;
    }
    const id = newSketchId();
    // The reference lands now rather than on the first stroke: it keeps the
    // insertion on the browser's undo stack, and it means a drawing can't be
    // orphaned by a tab that closes mid-stroke. Close the board without
    // drawing anything and the editor takes it back out again.
    replaceCommand(`${sketchRef(id)} `);
    onDraw(id);
  }, [editing, replaceCommand, onDraw]);

  // What the song row says depends on how far along the connection is — and,
  // once it works, on which day is being asked about.
  let songLabel = "Song of the day";
  let songHint = `most played ${when}`;
  if (!signedIn) {
    songHint = "sign in to connect Spotify";
  } else if (linked === false) {
    songLabel = "Connect Spotify";
    songHint = "once, then / finds the entry's song";
  } else if (loading) {
    songHint = "asking Spotify…";
  } else if (song?.state === "ok") {
    const { track, plays } = song.song;
    songHint = `${track.name} · ${track.artist}${plays > 1 ? ` · ${plays} plays` : ""}`;
  } else if (song?.state === "empty") {
    songHint = `nothing played ${when}`;
  } else if (song?.state === "out-of-reach") {
    songHint = "from before your listening was recorded";
  } else if (song?.state === "reconnect") {
    songLabel = "Reconnect Spotify";
    songHint = "access expired";
  }

  const songItem: Item = {
    key: "song",
    label: songLabel,
    hint: note ?? songHint,
    keywords: SONG_KEYWORDS,
  };
  const drawItem: Item = {
    key: "draw",
    label: editing ? "Edit whiteboard" : "Whiteboard",
    hint: editing ? "reopen the drawing above" : "draw, and it lands here",
    keywords: DRAW_KEYWORDS,
  };
  const items = configured ? [songItem, drawItem] : [drawItem];

  const visible = items.filter((item) => matchesQuery(item, query));
  const selected = Math.min(cursor, Math.max(0, visible.length - 1));
  const showing = at !== null && visible.length > 0;
  const songShowing = showing && visible.some((item) => item.key === "song");

  // Look up the connection once the song is actually on offer, and warm it so
  // Enter doesn't wait on a round trip. Re-runs when the entry's day changes,
  // which is what keeps the hint describing the entry actually open.
  useEffect(() => {
    if (!songShowing || !signedIn) return;
    if (linked === null) void refreshLink();
    else if (linked && day) void loadSong(day);
  }, [songShowing, signedIn, linked, day, refreshLink, loadSong]);

  // The caret can move under the menu without the text changing at all.
  useEffect(() => {
    if (!showing) return;
    const reposition = () => place(atRef.current, rowCount);
    const el = ref.current;
    el?.addEventListener("scroll", reposition);
    window.addEventListener("resize", reposition);
    return () => {
      el?.removeEventListener("scroll", reposition);
      window.removeEventListener("resize", reposition);
    };
  }, [showing, ref, place, rowCount]);

  const run = useCallback(
    (key: Item["key"]) => {
      if (key === "song") void runSong();
      else runDraw();
    },
    [runSong, runDraw]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showing) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const key = visible[selected]?.key;
        if (key) run(key);
        return true;
      }
      // Up and down pick, but only when there is something to pick between.
      // Narrowed to one command they go back to being caret keys, which is
      // what they are when the menu isn't there.
      if (
        (event.key === "ArrowDown" || event.key === "ArrowUp") &&
        visible.length > 1
      ) {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : visible.length - 1;
        setCursor((c) => (Math.min(c, visible.length - 1) + step) % visible.length);
        return true;
      }
      // Moving the caret means you're writing, not picking.
      if (event.key.startsWith("Arrow")) close();
      return false;
    },
    [showing, close, visible, selected, run]
  );

  const node =
    showing && point ? (
      <div
        role="listbox"
        aria-label="Insert"
        style={{ top: point.top, left: point.left, width: MENU_WIDTH }}
        className="fixed z-50 overflow-hidden rounded-md border bg-popover p-1 font-sans shadow-md"
      >
        {visible.map((item, i) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={i === selected}
            // Keeps the caret where it is instead of blurring on the way in.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setCursor(i)}
            onClick={() => run(item.key)}
            className={`flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left transition-colors ${
              i === selected ? "bg-accent" : ""
            }`}
          >
            <span className="text-sm text-foreground">{item.label}</span>
            <span className="w-full truncate text-xs text-muted-foreground">
              {item.hint}
            </span>
          </button>
        ))}
      </div>
    ) : null;

  return { node, handleKeyDown, sync, close };
}
