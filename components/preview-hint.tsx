"use client";

import { useTypingMiss } from "@/hooks/use-typing-miss";
import { usePrefs } from "@/lib/store";
import { cn } from "@/lib/utils";

// The pill stays mounted so it can fade out; the announcement only exists
// while the hint is up, so a screen reader reads it when it happens.
function Pill({ showing, text }: { showing: boolean; text: string }) {
  return (
    <>
      <p
        aria-hidden="true"
        className={cn(
          "rounded-full bg-foreground/90 px-5 py-2.5 text-center text-sm text-background backdrop-blur-sm transition-all duration-300",
          showing ? "scale-100 opacity-100" : "scale-95 opacity-0"
        )}
      >
        {text}
      </p>
      <p role="status" className="sr-only">
        {showing ? text : ""}
      </p>
    </>
  );
}

// Full preview has no caret at all, so a keystroke lands nowhere on the page.
export function PreviewHint() {
  const previewMode = usePrefs((s) => s.previewMode);
  const showing = useTypingMiss(previewMode === "full");

  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center">
      <Pill showing={showing} text="Preview only — click Preview again to write" />
    </div>
  );
}

// Split preview does have a caret — it is just on the other side. This one
// sits over the preview pane, where the writer was aiming.
export function SplitPreviewHint() {
  const previewMode = usePrefs((s) => s.previewMode);
  const showing = useTypingMiss(previewMode === "split");

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center px-6">
      <Pill showing={showing} text="This side is the preview — write on the left" />
    </div>
  );
}
