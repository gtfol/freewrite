"use client";

import { useEffect, useState } from "react";

import { usePrefs } from "@/lib/store";
import { cn } from "@/lib/utils";

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

// Typing into a real field — chat, rename, search — is going somewhere.
function inField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName);
}

// Full preview has no caret, so keystrokes land nowhere. Rather than eat
// them in silence, the hint says why and how to get back — then fades out
// the way the save indicator does.
export function PreviewHint() {
  const previewMode = usePrefs((s) => s.previewMode);
  const [visible, setVisible] = useState(false);

  const full = previewMode === "full";

  useEffect(() => {
    if (!full) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTyping(event) || inField(event.target)) return;
      setVisible(true);
      clearTimeout(timeout);
      timeout = setTimeout(() => setVisible(false), 2000);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      clearTimeout(timeout);
      // Leaving full preview drops the hint, so returning starts quiet.
      setVisible(false);
    };
  }, [full]);

  return (
    <p
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed top-4 left-1/2 z-30 -translate-x-1/2 text-xs text-muted-foreground/70 transition-opacity duration-500",
        full && visible ? "opacity-100" : "opacity-0"
      )}
    >
      Preview only — click Preview to write
    </p>
  );
}
