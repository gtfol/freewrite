"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Check, Pencil, X } from "lucide-react";

import { cn } from "@/lib/utils";

// Shared by the heading and the editor inside it so the text keeps its size
// and place when the two swap.
const titleClass = "text-[1.75rem] leading-tight font-semibold";

// Nudged down to sit centred on the editor's first line rather than on its
// ascender.
const editorButtonClass =
  "mt-[0.1em] inline-flex shrink-0 items-center rounded-sm p-1.5 transition-[color,opacity]";

// The reader's h1, renamed where it lives instead of back on the list. Long
// titles — a PDF filename, a percent-encoded slug — wrap onto as many lines
// as they need rather than running off the edge.
//
// The pencil sits inline after the last word, revealed on hover. Touch has no
// hover to reveal it with, so there it stays visible: @media (hover: none)
// asks exactly that question, and answers it before paint, unlike a
// matchMedia read that would pop the button in after hydration.
export function ArticleTitle({
  title,
  onRename,
}: {
  title: string;
  onRename: (title: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const discardRef = useRef(false);
  const editing = draft !== null;

  // Grow the box to fit its text — one line or six.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }, [draft]);

  // Open with the caret after the last character rather than before the
  // first. Keyed to the editor opening, not to every keystroke, which would
  // drag the caret back to the end mid-edit.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!editing || !area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }, [editing]);

  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next && next !== title) onRename(next);
  };

  const discard = () => {
    discardRef.current = false;
    setDraft(null);
  };

  // Clicking either button would otherwise blur the editor first, and blur
  // saves — which would make ✗ save the very edit it's there to throw away.
  // Holding focus in the textarea is the fix; the flag is the backstop for
  // any browser that moves focus anyway, so ✗ can only ever discard.
  const holdFocusToDiscard = (event: React.MouseEvent) => {
    discardRef.current = true;
    event.preventDefault();
  };

  const holdFocusToSave = (event: React.MouseEvent) => {
    discardRef.current = false;
    event.preventDefault();
  };

  return (
    <h1 className={cn(titleClass, "group break-words text-pretty")}>
      {draft === null ? (
        <>
          {title}
          <button
            type="button"
            onClick={() => setDraft(title)}
            title="Rename"
            aria-label="Rename"
            className="ml-1.5 inline-flex -translate-y-[0.1em] items-center rounded-sm p-1.5 align-middle text-muted-foreground opacity-0 transition-[color,opacity] group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Pencil className="size-4" />
          </button>
        </>
      ) : (
        <span className="flex items-start gap-1">
          <textarea
            ref={areaRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
              if (e.key === "Escape") discard();
            }}
            onBlur={() => (discardRef.current ? discard() : commit())}
            aria-label="Title"
            className={cn(
              titleClass,
              "block min-w-0 flex-1 resize-none overflow-hidden bg-transparent p-0 font-[inherit] text-foreground outline-none"
            )}
          />
          {/* Enter and Escape do the same two things, but neither is on a
              phone's keyboard — and blur-to-save is invisible everywhere. */}
          <button
            type="button"
            onMouseDown={holdFocusToDiscard}
            onClick={discard}
            title="Discard"
            aria-label="Discard"
            className={cn(editorButtonClass, "text-muted-foreground hover:text-foreground")}
          >
            <X className="size-4" />
          </button>
          <button
            type="button"
            onMouseDown={holdFocusToSave}
            onClick={commit}
            title="Save"
            aria-label="Save"
            className={cn(editorButtonClass, "text-foreground hover:opacity-70")}
          >
            <Check className="size-4" />
          </button>
        </span>
      )}
    </h1>
  );
}
