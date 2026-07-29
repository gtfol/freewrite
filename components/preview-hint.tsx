"use client";

import { useEffect, useState } from "react";

import { usePrefs } from "@/lib/store";
import { cn } from "@/lib/utils";

const HINT = "Preview only — click Preview to write";

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

  const showing = full && visible;

  return (
    <>
      <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center">
        <p
          aria-hidden="true"
          className={cn(
            "rounded-full bg-foreground/90 px-5 py-2.5 text-sm text-background backdrop-blur-sm transition-all duration-300",
            showing ? "scale-100 opacity-100" : "scale-95 opacity-0"
          )}
        >
          {HINT}
        </p>
      </div>
      {/* The pill stays mounted so it can fade out; the announcement only
          exists while the hint is up, so it is read when it happens. */}
      <p role="status" className="sr-only">
        {showing ? HINT : ""}
      </p>
    </>
  );
}
