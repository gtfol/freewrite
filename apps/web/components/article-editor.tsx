"use client";

import { useLayoutEffect, useImperativeHandle, useRef, type Ref } from "react";

export interface ArticleEditorHandle {
  content: () => string;
  undo: () => void;
  restore: (html: string) => void;
}

// Keep the DOM uncontrolled while typing so rerenders never reset the selection,
// IME composition, or the browser's native undo history.
export function ArticleEditor({ initial, editorRef, onChange, disabled }: {
  initial: string;
  editorRef: Ref<ArticleEditorHandle>;
  onChange: (state: { changed: boolean; canUndo: boolean }) => void;
  disabled: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const initialDOM = useRef("");
  const restored = useRef<{ html: string; dom: string } | null>(null);

  // Populate before paint so the page never collapses to an empty editor,
  // and focus without pulling the reader back to the start of the article.
  useLayoutEffect(() => {
    const editor = element.current!;
    editor.innerHTML = initial;
    initialDOM.current = editor.innerHTML;
    editor.focus({ preventScroll: true });
  }, [initial]);

  function report() {
    onChange({ changed: element.current!.innerHTML !== initialDOM.current,
      canUndo: document.queryCommandEnabled("undo") });
  }

  useImperativeHandle(editorRef, () => ({
    content: () => {
      const html = element.current!.innerHTML;
      if (html === initialDOM.current) return initial;
      return html === restored.current?.dom ? restored.current.html : html;
    },
    undo: () => { element.current!.focus(); document.execCommand("undo"); report(); },
    restore: (html) => {
      const editor = element.current!;
      editor.focus();
      const range = document.createRange(); range.selectNodeContents(editor);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      // A single native edit makes restoring the import undoable too.
      if (document.execCommand("insertHTML", false, `<div>${html}</div>`)) {
        restored.current = { html, dom: editor.innerHTML };
      }
      report();
    },
  }));

  return <div
    ref={element}
    role="textbox"
    aria-label="Article content"
    aria-multiline="true"
    aria-readonly={disabled}
    contentEditable={!disabled}
    suppressContentEditableWarning
    className="reader mt-10 min-h-[40vh] cursor-text outline-none empty:before:text-muted-foreground empty:before:content-['Start_typing…']"
    onInput={report}
    onClick={(event) => {
      if ((event.target as Element).closest("a")) event.preventDefault();
    }}
    onPaste={(event) => {
      // Paste text, never executable clipboard HTML, hidden page chrome, or widgets.
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
      report();
    }}
    onDrop={(event) => event.preventDefault()}
  />;
}
