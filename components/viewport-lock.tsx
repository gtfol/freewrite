"use client";

import { useEffect } from "react";

// Zoom on a phone is almost always an accident. Two taps aimed at two
// sentences are a double-tap; a phone turned landscape and back leaves WebKit
// holding the scale it fitted the wider layout to, so the article returns
// zoomed in and stays there — nothing on screen says how to undo it.
//
// So the viewport is locked at scale 1 and unlocked the moment a pinch
// actually starts, which is the one zoom someone meant. Rewriting the meta is
// also the only thing that makes WebKit re-fit a rotated page: it ignores
// maximum-scale on its own (deliberately, since iOS 10), but it does re-read
// the tag when the value changes. That is what puts a rotated article back.
const LOCKED = "width=device-width, initial-scale=1, maximum-scale=1";
const FREE = "width=device-width, initial-scale=1, maximum-scale=5";

// Rotation is animated, and a re-fit asked for mid-animation is applied to the
// layout being rotated away from.
const SETTLE_MS = 400;

export function ViewportLock() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="viewport"]'
    );
    if (!meta) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    // `gesturestart` is WebKit's two-finger pinch — the only signal that tells
    // a zoom someone asked for from one the browser decided on.
    const free = () => {
      if (timer) clearTimeout(timer);
      meta.content = FREE;
    };

    const relock = () => {
      if (timer) clearTimeout(timer);
      // The re-fit rides on the value changing, so the tag is bounced rather
      // than assigned what it already holds.
      meta.content = FREE;
      timer = setTimeout(() => {
        meta.content = LOCKED;
      }, SETTLE_MS);
    };

    document.addEventListener("gesturestart", free);
    window.addEventListener("orientationchange", relock);
    screen.orientation?.addEventListener("change", relock);

    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("gesturestart", free);
      window.removeEventListener("orientationchange", relock);
      screen.orientation?.removeEventListener("change", relock);
    };
  }, []);

  return null;
}
