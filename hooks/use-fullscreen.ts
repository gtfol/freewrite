"use client";

import { useCallback, useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  document.addEventListener("fullscreenchange", callback);
  return () => document.removeEventListener("fullscreenchange", callback);
}

export function useFullscreen() {
  const active = useSyncExternalStore(
    subscribe,
    () => document.fullscreenElement !== null,
    () => false
  );
  const supported = useSyncExternalStore(
    subscribe,
    () => document.fullscreenEnabled ?? false,
    () => false
  );

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  return { active, supported, toggle };
}
