"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";

export interface LightboxMedia {
  kind: "image" | "video" | "youtube";
  // Image/video source URL, or the video id for YouTube.
  src: string;
}

export function Lightbox({
  media,
  onClose,
}: {
  media: LightboxMedia;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Restore focus to whatever was open when the overlay closes, so the
    // preview pane doesn't lose the caret's place.
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
      aria-label="Media preview"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close"
        className="absolute top-4 right-4 rounded-md p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      >
        <X className="size-5" />
      </button>

      {/* Clicks on the media itself shouldn't dismiss — only the backdrop. */}
      <div onClick={(e) => e.stopPropagation()} className="contents">
        {media.kind === "image" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={media.src}
            alt=""
            className="max-h-full max-w-full rounded object-contain"
          />
        )}
        {media.kind === "video" && (
          <video
            src={media.src}
            controls
            autoPlay
            playsInline
            className="max-h-full max-w-full rounded"
          />
        )}
        {media.kind === "youtube" && (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${media.src}?autoplay=1`}
            title="YouTube video"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            className="aspect-video max-h-full w-full max-w-4xl rounded border-0"
          />
        )}
      </div>
    </div>
  );
}
