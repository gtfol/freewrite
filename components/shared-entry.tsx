"use client";

import Link from "next/link";
import { useState } from "react";

import { MarkdownPreview } from "@/components/markdown-preview";
import { fontById } from "@/lib/fonts";
import { cn } from "@/lib/utils";

// The read-only page behind a share link. Readers get the same Preview toggle
// the writer has — the raw text as it was typed, or the rendered markdown —
// except here it swaps the single column rather than splitting the screen.
export function SharedEntry({
  content,
  fontId,
  fontSize,
  meta,
}: {
  content: string;
  fontId: string;
  fontSize: number;
  meta: string;
}) {
  const [preview, setPreview] = useState(false);
  const font = fontById(fontId);
  const bodyClass = "mx-auto max-w-[650px] px-6 pt-10 pb-32";

  return (
    <main className="min-h-dvh">
      <div className="mx-auto max-w-[650px] px-6 pt-14">
        <p className="font-sans text-xs text-muted-foreground">{meta}</p>
      </div>

      {preview ? (
        <MarkdownPreview
          content={content}
          fontFamily={font.stack}
          fontSize={fontSize}
          className={`${bodyClass} space-y-5`}
        />
      ) : (
        <div
          className={`${bodyClass} break-words whitespace-pre-wrap`}
          style={{
            fontFamily: font.stack,
            fontSize: `${fontSize}px`,
            lineHeight: 1.7,
          }}
        >
          {content}
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-40 bg-background">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-6 py-4 text-[13px]">
          <span className="text-muted-foreground/70 select-none">
            Written with freewrite
          </span>
          <span className="text-muted-foreground/40 select-none">•</span>
          <button
            type="button"
            onClick={() => setPreview(!preview)}
            title="Render this entry as markdown"
            className={cn(
              "transition-colors hover:text-foreground",
              preview ? "text-foreground" : "text-muted-foreground"
            )}
          >
            Preview
          </button>
          <span className="text-muted-foreground/40 select-none">•</span>
          <Link
            href="/"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Start writing
          </Link>
        </div>
      </nav>
    </main>
  );
}
