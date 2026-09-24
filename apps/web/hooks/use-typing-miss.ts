"use client";

import { useEffect, useState } from "react";

const HOLD_MS = 2000;

// Keys that mean "I'm trying to write here" — a bare character, a newline,
// or a delete. Shortcuts (⌘K and friends) are not typing.
function isTyping(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return (
    event.key.length === 1 ||
    event.key === "Enter" ||
    event.key === "Backspace" ||
    event.key === "Delete"
  );
}

// Typing into a real field — the editor itself, chat, rename, search — is
// going somewhere, so it is not a miss.
function inField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName);
}

// True for a couple of seconds after a keystroke lands nowhere: the writer
// aimed at something that cannot take text. Goes quiet again on its own, and
// whenever the caller stops watching.
export function useTypingMiss(active: boolean): boolean {
  const [missed, setMissed] = useState(false);

  useEffect(() => {
    if (!active) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTyping(event) || inField(event.target)) return;
      setMissed(true);
      clearTimeout(timeout);
      timeout = setTimeout(() => setMissed(false), HOLD_MS);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      clearTimeout(timeout);
      // Leaving the mode drops the hint, so coming back starts quiet.
      setMissed(false);
    };
  }, [active]);

  return active && missed;
}
