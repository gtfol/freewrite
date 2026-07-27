"use client";

import { useCallback, useEffect, useRef } from "react";

import { MarkdownPreview } from "@/components/markdown-preview";
import { fontById } from "@/lib/fonts";
import { currentEntry, usePrefs, useWriter } from "@/lib/store";

export function Editor() {
  const entry = useWriter(currentEntry);
  const placeholder = useWriter((s) => s.placeholder);
  const setContent = useWriter((s) => s.setContent);
  const fontId = usePrefs((s) => s.fontId);
  const fontSize = usePrefs((s) => s.fontSize);
  const backspaceDisabled = usePrefs((s) => s.backspaceDisabled);
  const markdownPreview = usePrefs((s) => s.markdownPreview);

  const ref = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [entry?.id, markdownPreview]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        backspaceDisabled &&
        (event.key === "Backspace" || event.key === "Delete")
      ) {
        event.preventDefault();
      }
    },
    [backspaceDisabled]
  );

  // Keep the preview roughly in step with where the writer is in the text.
  const onScroll = useCallback((event: React.UIEvent<HTMLTextAreaElement>) => {
    const pane = previewRef.current;
    if (!pane) return;
    const el = event.currentTarget;
    const max = el.scrollHeight - el.clientHeight;
    const ratio = max > 0 ? el.scrollTop / max : 0;
    pane.scrollTop = ratio * (pane.scrollHeight - pane.clientHeight);
  }, []);

  if (!entry) return null;

  const font = fontById(fontId);
  const textarea = (
    <textarea
      ref={ref}
      value={entry.content}
      onChange={(e) => setContent(e.target.value)}
      onKeyDown={onKeyDown}
      onScroll={markdownPreview ? onScroll : undefined}
      placeholder={placeholder}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      className="no-scrollbar mx-auto block h-full w-full max-w-[650px] resize-none bg-transparent px-6 pt-14 pb-28 outline-none placeholder:text-muted-foreground/50"
      style={{
        fontFamily: font.stack,
        fontSize: `${fontSize}px`,
        lineHeight: 1.7,
      }}
    />
  );

  if (!markdownPreview) return textarea;

  return (
    <div className="flex h-full">
      <div className="h-full min-w-0 flex-1">{textarea}</div>
      <div
        ref={previewRef}
        className="no-scrollbar hidden h-full min-w-0 flex-1 overflow-y-auto border-l md:block"
      >
        <MarkdownPreview
          content={entry.content}
          fontFamily={font.stack}
          fontSize={fontSize}
        />
      </div>
    </div>
  );
}
