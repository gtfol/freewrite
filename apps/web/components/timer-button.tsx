"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import { useTimer } from "@/lib/store";

function format(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function TimerButton() {
  const remainingMs = useTimer((s) => s.remainingMs);
  const running = useTimer((s) => s.running);
  const toggle = useTimer((s) => s.toggle);
  const reset = useTimer((s) => s.reset);
  const adjust = useTimer((s) => s.adjust);
  const tick = useTimer((s) => s.tick);

  const ref = useRef<HTMLButtonElement>(null);
  const clickTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [running, tick]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.deltaY === 0) return;
      adjust(event.deltaY > 0 ? -1 : 1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [adjust]);

  const onClick = () => {
    if (clickTimeout.current) return;
    clickTimeout.current = setTimeout(() => {
      clickTimeout.current = null;
      toggle();
    }, 250);
  };

  const onDoubleClick = () => {
    if (clickTimeout.current) {
      clearTimeout(clickTimeout.current);
      clickTimeout.current = null;
    }
    reset();
  };

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title="Click to start · double-click to reset · scroll to adjust"
      className={cn(
        "tabular-nums transition-colors",
        running
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {format(remainingMs)}
    </button>
  );
}
