"use client";

import { useCallback, useEffect, useRef } from "react";

import { fontById } from "@/lib/fonts";
import { currentEntry, usePrefs, useWriter } from "@/lib/store";

export function Editor() {
  const entry = useWriter(currentEntry);
  const placeholder = useWriter((s) => s.placeholder);
  const setContent = useWriter((s) => s.setContent);
  const fontId = usePrefs((s) => s.fontId);
  const fontSize = usePrefs((s) => s.fontSize);
  const backspaceDisabled = usePrefs((s) => s.backspaceDisabled);

  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [entry?.id]);

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

  if (!entry) return null;

  return (
    <textarea
      ref={ref}
      value={entry.content}
      onChange={(e) => setContent(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      className="no-scrollbar mx-auto block h-full w-full max-w-[650px] resize-none bg-transparent px-6 pt-14 pb-28 outline-none placeholder:text-muted-foreground/50"
      style={{
        fontFamily: fontById(fontId).stack,
        fontSize: `${fontSize}px`,
        lineHeight: 1.7,
      }}
    />
  );
}
