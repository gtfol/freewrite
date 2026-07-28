"use client";

import { useCallback, useEffect, useRef } from "react";

import { MarkdownPreview } from "@/components/markdown-preview";
import { fontById } from "@/lib/fonts";
import { currentEntry, usePrefs, useWriter } from "@/lib/store";
import { cn } from "@/lib/utils";

// indent, bullet | number+punct, spacing, optional checkbox, content.
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/;

interface EditPlan {
  start: number;
  end: number;
  insert: string;
  caret: number;
}

function lineStartAt(value: string, caret: number): number {
  return caret === 0 ? 0 : value.lastIndexOf("\n", caret - 1) + 1;
}

// GitHub-style list continuation: Enter inside a list item starts the next
// one (same indent, next number, fresh unchecked box); Enter on an empty
// item clears the marker and exits the list.
function planEnter(value: string, caret: number): EditPlan | null {
  const lineStart = lineStartAt(value, caret);
  const nl = value.indexOf("\n", caret);
  const lineEnd = nl === -1 ? value.length : nl;
  const m = LIST_ITEM.exec(value.slice(lineStart, caret));
  if (!m) return null;
  const [, indent, bullet, num, numPunct, spacing, checkbox, rest] = m;
  if (!rest && !value.slice(caret, lineEnd)) {
    return { start: lineStart, end: lineEnd, insert: "", caret: lineStart };
  }
  const marker = bullet ?? `${Number(num) + 1}${numPunct}`;
  const prefix = `${indent}${marker}${spacing}${checkbox ? "[ ] " : ""}`;
  return {
    start: caret,
    end: caret,
    insert: `\n${prefix}`,
    caret: caret + 1 + prefix.length,
  };
}

// Tab / Shift+Tab (re)indents the list item the caret is on.
function planTab(value: string, caret: number, dedent: boolean): EditPlan | null {
  const lineStart = lineStartAt(value, caret);
  const nl = value.indexOf("\n", lineStart);
  const lineEnd = nl === -1 ? value.length : nl;
  const m = LIST_ITEM.exec(value.slice(lineStart, lineEnd));
  if (!m) return null;
  if (!dedent) {
    return { start: lineStart, end: lineStart, insert: "  ", caret: caret + 2 };
  }
  const indent = m[1];
  const remove = indent.startsWith("\t") ? 1 : Math.min(2, indent.length);
  if (remove === 0) return null;
  return {
    start: lineStart,
    end: lineStart + remove,
    insert: "",
    caret: Math.max(lineStart, caret - remove),
  };
}

export function Editor() {
  const entry = useWriter(currentEntry);
  const placeholder = useWriter((s) => s.placeholder);
  const setContent = useWriter((s) => s.setContent);
  const fontId = usePrefs((s) => s.fontId);
  const fontSize = usePrefs((s) => s.fontSize);
  const backspaceDisabled = usePrefs((s) => s.backspaceDisabled);
  const previewMode = usePrefs((s) => s.previewMode);

  const ref = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A hidden textarea can't take focus, and stealing it back on the way out
    // of full preview is what restores the caret.
    if (previewMode !== "full") ref.current?.focus();
  }, [entry?.id, previewMode]);

  const applyPlan = useCallback(
    (el: HTMLTextAreaElement, plan: EditPlan) => {
      el.setSelectionRange(plan.start, plan.end);
      let applied = false;
      try {
        // execCommand keeps the browser's undo stack intact and fires the
        // input event, so React's onChange (and the debounced save) run.
        applied = plan.insert
          ? document.execCommand("insertText", false, plan.insert)
          : document.execCommand("delete");
      } catch {
        applied = false;
      }
      if (!applied) {
        const next =
          el.value.slice(0, plan.start) + plan.insert + el.value.slice(plan.end);
        setContent(next);
      }
      el.setSelectionRange(plan.caret, plan.caret);
    },
    [setContent]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        backspaceDisabled &&
        (event.key === "Backspace" || event.key === "Delete")
      ) {
        event.preventDefault();
        return;
      }
      if (event.nativeEvent.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const el = event.currentTarget;
      if (el.selectionStart !== el.selectionEnd) return;

      const plan =
        event.key === "Enter"
          ? planEnter(el.value, el.selectionStart)
          : event.key === "Tab"
            ? planTab(el.value, el.selectionStart, event.shiftKey)
            : null;
      if (!plan) return;
      // Plans that delete text stay off while backspace is off.
      if (plan.end > plan.start && backspaceDisabled) return;
      event.preventDefault();
      applyPlan(el, plan);
    },
    [backspaceDisabled, applyPlan]
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
      onScroll={previewMode === "split" ? onScroll : undefined}
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

  // One tree for all three modes, so the textarea is never unmounted: React
  // would otherwise remount it on every toggle and drop the caret and scroll
  // position with it. Full preview hides it rather than removing it.
  return (
    <div className="flex h-full">
      <div
        className={cn(
          "h-full min-w-0 flex-1",
          previewMode === "full" && "hidden"
        )}
      >
        {textarea}
      </div>
      {previewMode !== "off" && (
        <div
          ref={previewRef}
          className={cn(
            "no-scrollbar h-full min-w-0 flex-1 overflow-y-auto",
            // Side by side needs the divider and only exists once there's room
            // for two columns; full preview always shows, at any width.
            previewMode === "split" ? "hidden border-l md:block" : "block"
          )}
        >
          <MarkdownPreview
            content={entry.content}
            fontFamily={font.stack}
            fontSize={fontSize}
          />
        </div>
      )}
    </div>
  );
}
