"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { caretPoint } from "@/lib/caret";
import { trackMarkdown } from "@/lib/spotify";
import { useSpotify } from "@/lib/spotify-connect";
import { useWriter } from "@/lib/store";
import { useSync } from "@/lib/sync";

// Type "/" and the day's song is a keystroke away. One command, so there is no
// list to navigate: arrows move the caret and close the menu, the way they
// would if it weren't there.

const MENU_WIDTH = 288;
// Enough to decide whether the menu fits below the caret before it renders.
const MENU_HEIGHT = 76;

const LABEL = "Song of the day";
const KEYWORDS = ["song", "spotify", "music", "track", "day", "listening"];

function matchesQuery(query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return LABEL.toLowerCase().includes(q) || KEYWORDS.some((k) => k.startsWith(q));
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

export function useSlashMenu(ref: React.RefObject<HTMLTextAreaElement | null>) {
  const configured = useSync((s) => s.providers.spotify);
  const signedIn = Boolean(useSync((s) => s.user));
  const linked = useSpotify((s) => s.linked);
  const song = useSpotify((s) => s.song);
  const loading = useSpotify((s) => s.loading);
  const refreshLink = useSpotify((s) => s.refresh);
  const loadSong = useSpotify((s) => s.loadSong);
  const connect = useSpotify((s) => s.connect);
  const setContent = useWriter((s) => s.setContent);

  // The "/" offset, mirrored in a ref because the input and keydown handlers
  // read it in the same tick they set it.
  const atRef = useRef<number | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [point, setPoint] = useState<Point | null>(null);

  // Measured here rather than in an effect: the handlers that move the menu
  // run after the DOM already holds the new text, so this is the moment the
  // caret's position is knowable, and it saves a render to find out.
  const place = useCallback(
    (index: number | null) => {
      const el = ref.current;
      if (el === null || index === null) {
        setPoint(null);
        return;
      }
      const caret = caretPoint(el, index);
      if (!caret) return;
      const rect = el.getBoundingClientRect();
      const below = rect.top + caret.top + caret.lineHeight;
      // Writing near the bottom of the window puts the menu above the caret
      // instead, where there's room for it.
      const flip = below + MENU_HEIGHT > window.innerHeight;
      setPoint({
        top: flip ? rect.top + caret.top - MENU_HEIGHT : below,
        left: Math.min(
          rect.left + caret.left,
          window.innerWidth - MENU_WIDTH - 12
        ),
      });
    },
    [ref]
  );

  const move = useCallback(
    (index: number | null) => {
      atRef.current = index;
      setAt(index);
      place(index);
    },
    [place]
  );

  const close = useCallback(() => {
    move(null);
    setQuery("");
    setNote(null);
  }, [move]);

  // Re-derives the menu from wherever the caret actually is. Called on every
  // edit, so a paste or a backspace over the "/" closes it just as reliably as
  // typing does.
  const sync = useCallback(() => {
    const el = ref.current;
    if (!el || !configured) return;
    const caret = el.selectionStart;
    const start = atRef.current;

    if (start === null) {
      if (caret > 0 && opensAt(el.value, caret - 1)) {
        setQuery("");
        setNote(null);
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
    // Typing can rewrap the line the "/" sits on and move it.
    place(start);
  }, [ref, configured, move, close, place]);

  const showing = at !== null && matchesQuery(query);

  // Look up the connection once the menu is actually in use, and warm the
  // song so Enter doesn't wait on a round trip.
  useEffect(() => {
    if (!showing || !signedIn) return;
    if (linked === null) void refreshLink();
    else if (linked) void loadSong();
  }, [showing, signedIn, linked, refreshLink, loadSong]);

  // The caret can move under the menu without the text changing at all.
  useEffect(() => {
    if (!showing) return;
    const reposition = () => place(atRef.current);
    const el = ref.current;
    el?.addEventListener("scroll", reposition);
    window.addEventListener("resize", reposition);
    return () => {
      el?.removeEventListener("scroll", reposition);
      window.removeEventListener("resize", reposition);
    };
  }, [showing, ref, place]);

  const insert = useCallback(
    (text: string) => {
      const el = ref.current;
      const start = atRef.current;
      if (!el || start === null) return;
      const end = el.selectionStart;
      el.focus();
      // Replaces the "/song" you typed — the command, not your writing, which
      // is why this runs even with backspace turned off.
      el.setSelectionRange(start, end);
      let applied = false;
      try {
        // execCommand keeps the browser's undo stack intact and fires the
        // input event, so the debounced save runs — the same reason the list
        // edits in editor.tsx go through it.
        applied = document.execCommand("insertText", false, text);
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

  const run = useCallback(async () => {
    if (!signedIn) {
      setNote("Sign in first — the cloud at the bottom right.");
      return;
    }
    if (linked === false) {
      // Leaves for Spotify and comes back to this page.
      await connect();
      return;
    }
    await loadSong();
    const current = useSpotify.getState().song;
    if (!current) return;
    switch (current.state) {
      case "ok":
        insert(`${trackMarkdown(current.song.track)} `);
        return;
      case "empty":
        setNote("Nothing played yet today.");
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
  }, [signedIn, linked, connect, loadSong, insert]);

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
        void run();
        return true;
      }
      // Moving the caret means you're writing, not picking.
      if (event.key.startsWith("Arrow")) close();
      return false;
    },
    [showing, close, run]
  );

  // What the row says depends on how far along the connection is.
  let label = LABEL;
  let hint = "most played since midnight";
  if (!signedIn) {
    hint = "sign in to connect Spotify";
  } else if (linked === false) {
    label = "Connect Spotify";
    hint = "once, then / finds today's song";
  } else if (loading) {
    hint = "asking Spotify…";
  } else if (song?.state === "ok") {
    const { track, plays } = song.song;
    hint = `${track.name} · ${track.artist}${plays > 1 ? ` · ${plays} plays` : ""}`;
  } else if (song?.state === "empty") {
    hint = "nothing played yet today";
  } else if (song?.state === "reconnect") {
    label = "Reconnect Spotify";
    hint = "access expired";
  }

  const node =
    showing && point ? (
      <div
        role="listbox"
        aria-label="Insert"
        style={{ top: point.top, left: point.left, width: MENU_WIDTH }}
        className="fixed z-50 overflow-hidden rounded-md border bg-popover p-1 font-sans shadow-md"
      >
        <button
          type="button"
          role="option"
          aria-selected="true"
          // Keeps the caret where it is instead of blurring on the way in.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void run()}
          className="flex w-full flex-col items-start gap-0.5 rounded-md bg-accent px-3 py-2 text-left transition-colors"
        >
          <span className="text-sm text-foreground">{label}</span>
          <span className="w-full truncate text-xs text-muted-foreground">
            {note ?? hint}
          </span>
        </button>
      </div>
    ) : null;

  return { node, handleKeyDown, sync, close };
}
