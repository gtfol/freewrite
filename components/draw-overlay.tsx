"use client";

import { Draw, type DrawHandle } from "drawesome";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isDarkPaper, quantize } from "@/lib/sketch";
import type { Sketch } from "@/lib/types";

import "drawesome/styles.css";

// The board takes the whole window. Writing and drawing are different states of
// mind, not two panes to glance between, and the app already works this way —
// the timer, fullscreen, the history sidebar. It also gives drawesome's toolbar
// the room it was designed for, and it puts the textarea out of reach, which
// matters because the pens answer to single keys: with the board up, "p" is a
// pencil, and there is nowhere for it to land as text.
//
// Everything autosaves, one save per finished stroke, so closing is never a
// decision about the drawing — there is no Done, only a way out.

// Below this the toolbar is stood up on its side: the bar is as wide as what's
// in it, and a phone has more height than width.
const NARROW = 640;

const NARROW_TOOLS = ["pencil", "pen", "marker", "highlighter", "brush"] as const;

export function DrawOverlay({
  sketch,
  onChange,
  onClose,
}: {
  sketch: Sketch;
  onChange: (strokes: Sketch["strokes"]) => void;
  onClose: () => void;
}) {
  const handle = useRef<DrawHandle>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const measure = () => setNarrow(window.innerWidth < NARROW);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    // Capture phase, so Escape closes the board before drawesome's own window
    // listener can read it, and focus goes back to the caret on the way out.
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Whiteboard"
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      <div className="flex items-center justify-between px-4 py-3 font-sans text-[13px]">
        <span className="text-muted-foreground/70 select-none">
          {narrow ? "Saved as you draw" : "Saved as you draw — Esc to go back"}
        </span>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          title="Back to writing (Esc)"
          aria-label="Back to writing"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* The board is a fixed size and letterboxes inside whatever room is
          left, so the same strokes are the same drawing on every screen. */}
      <div className="min-h-0 flex-1 px-4 pb-4">
        <Draw
          ref={handle}
          board={{ w: sketch.w, h: sketch.h }}
          background={sketch.bg}
          initialStrokes={sketch.strokes}
          onChange={(strokes) => onChange(quantize(strokes))}
          // Taken from the paper rather than from the app, because this prop is
          // what drawesome picks its starting ink from: a dark theme hands you
          // near-white ink, which on a white sheet you can barely see while you
          // draw and can't see at all as a figure. Reading it off the drawing
          // keeps the pen and the paper in agreement — including when a sheet
          // made in one theme is reopened in the other.
          theme={isDarkPaper(sketch.bg) ? "dark" : "light"}
          placement={narrow ? "left" : "bottom"}
          tools={narrow ? [...NARROW_TOOLS] : undefined}
          controls={
            narrow ? { opacity: false, custom: false, minimize: false } : undefined
          }
          className="h-full w-full"
        />
      </div>
    </div>
  );
}
