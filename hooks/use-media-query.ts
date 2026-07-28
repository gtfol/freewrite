"use client";

import { useCallback, useSyncExternalStore } from "react";

// Server render and first paint report false, so a layout that depends on this
// must be correct without it — callers use it to choose behaviour, not to gate
// what renders.
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (callback: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", callback);
      return () => list.removeEventListener("change", callback);
    },
    [query]
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  );
}
