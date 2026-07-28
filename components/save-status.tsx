"use client";

import { useWriter } from "@/lib/store";
import { cn } from "@/lib/utils";

const LABELS = {
  saving: "Saving…",
  saved: "Saved",
  error: "Not saved — changes stay in this tab",
  idle: "",
} as const;

// Notion-style reassurance: writing saves itself, so the indicator only
// speaks up around a save and then fades back out of the way.
export function SaveStatus() {
  const saveState = useWriter((s) => s.saveState);
  const visible = saveState !== "idle";

  return (
    <p
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed top-4 right-5 z-30 text-xs transition-opacity duration-500",
        visible ? "opacity-100" : "opacity-0",
        saveState === "error" ? "text-destructive" : "text-muted-foreground/70"
      )}
    >
      {LABELS[saveState]}
    </p>
  );
}
