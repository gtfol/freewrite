"use client";

import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef, useState } from "react";

import { MarkdownPreview } from "@/components/markdown-preview";
import { SplitPreviewHint } from "@/components/preview-hint";
import { useSlashMenu } from "@/components/slash-menu";
import { fontById } from "@/lib/fonts";
import { blankSketch, isBlank, paperFor, sketchRef } from "@/lib/sketch";
import { currentEntry, usePrefs, useWriter } from "@/lib/store";

// The board and drawesome's stylesheet only load once someone asks to draw —
// nothing about opening the app to write should pay for it.
const DrawOverlay = dynamic(
  () => import("@/components/draw-overlay").then((m) => m.DrawOverlay),
  { ssr: false }
);

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
  const setSketch = useWriter((s) => s.setSketch);
  const dropSketch = useWriter((s) => s.dropSketch);
  const fontId = usePrefs((s) => s.fontId);
  const fontSize = usePrefs((s) => s.fontSize);
  const backspaceDisabled = usePrefs((s) => s.backspaceDisabled);
  const previewMode = usePrefs((s) => s.previewMode);

  const { resolvedTheme } = useTheme();

  const ref = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // The drawing the board is open on, if it is.
  const [drawing, setDrawing] = useState<string | null>(null);
  const slash = useSlashMenu(ref, { onDraw: setDrawing });

  // Closing the board with nothing on it takes the reference back out again, so
  // opening it and changing your mind — or rubbing out everything you drew —
  // leaves the entry exactly as it was.
  const closeDrawing = useCallback(() => {
    const id = drawing;
    setDrawing(null);
    if (!id) return;
    const open = currentEntry(useWriter.getState());
    if (!open) return;
    const sketch = open.sketches?.find((s) => s.id === id);
    if (sketch && !isBlank(sketch)) return;
    if (sketch) dropSketch(id);
    const ref = sketchRef(id);
    setContent(open.content.replace(`${ref} `, "").replace(ref, ""));
  }, [drawing, dropSketch, setContent]);

  useEffect(() => {
    if (previewMode !== "full" && !drawing) ref.current?.focus();
  }, [entry?.id, previewMode, drawing]);

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
      // The / menu gets first refusal on Enter, Tab and Escape while it's open.
      if (slash.handleKeyDown(event)) return;
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
    [backspaceDisabled, applyPlan, slash]
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
      onChange={(e) => {
        setContent(e.target.value);
        slash.sync();
      }}
      onKeyDown={onKeyDown}
      onBlur={slash.close}
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

  // Both the menu and the board are fixed-position, so they ride along with the
  // textarea in either layout without caring where in the tree they sit. The
  // board is only in the tree while it's open, which is what keeps drawesome's
  // single-key shortcuts away from the writing.
  // A new sheet is the colour of the app you asked for it from; an existing one
  // keeps the paper it was drawn on, whichever theme you open it in.
  const open = drawing
    ? (entry.sketches?.find((s) => s.id === drawing) ??
      blankSketch(drawing, paperFor(resolvedTheme === "dark")))
    : null;
  const board = open && (
    <DrawOverlay
      sketch={open}
      onChange={(strokes) => setSketch({ ...open, strokes })}
      onClose={closeDrawing}
    />
  );

  const writing = (
    <>
      {textarea}
      {slash.node}
      {board}
    </>
  );

  if (previewMode === "off") return writing;

  const preview = (
    <MarkdownPreview
      content={entry.content}
      fontFamily={font.stack}
      fontSize={fontSize}
      sketches={entry.sketches}
      onEditSketch={setDrawing}
    />
  );

  if (previewMode === "full") {
    return (
      <>
        <div className="no-scrollbar h-full overflow-y-auto">{preview}</div>
        {board}
      </>
    );
  }

  return (
    <div className="flex h-full">
      <div className="h-full min-w-0 flex-1">{writing}</div>
      <div className="relative hidden h-full min-w-0 flex-1 border-l md:block">
        <div ref={previewRef} className="no-scrollbar h-full overflow-y-auto">
          {preview}
        </div>
        <SplitPreviewHint />
      </div>
    </div>
  );
}
