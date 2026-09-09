"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_PDF_TEXT_CHARS, pdfArticle, type PdfDraft } from "@/lib/pdf";
import type { ExtractedArticle } from "@/lib/types";

const actionClass = "text-[13px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";

export function PdfImporter({ disabled, onActiveChange, onSave }: {
  disabled: boolean;
  onActiveChange: (active: boolean) => void;
  onSave: (data: ExtractedArticle, original: File) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const operation = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ page: number; pages: number } | null>(null);
  const [preview, setPreview] = useState<{ draft: PdfDraft; file: File } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => () => { operation.current?.abort(); }, []);

  const cancel = () => {
    operation.current?.abort();
    operation.current = null;
    setBusy(false);
    setPreview(null);
    setProgress(null);
    setError(null);
    onActiveChange(false);
  };

  const choose = async (file: File) => {
    if (disabled || saving.current) return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setError(null);
    setPreview(null);
    setBusy(true);
    setProgress(null);
    onActiveChange(true);
    try {
      const { extractPdf } = await import("@/lib/pdf-browser");
      const draft = await extractPdf(file, {
        signal: controller.signal,
        onProgress: (page, pages) => {
          if (operation.current === controller) setProgress({ page, pages });
        },
      });
      if (operation.current !== controller || controller.signal.aborted) return;
      setPreview({ draft, file });
    } catch (failure) {
      if (operation.current !== controller || controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : "Couldn't read that PDF.");
      onActiveChange(false);
    } finally {
      if (operation.current === controller) setBusy(false);
    }
  };

  const save = async () => {
    if (!preview || saving.current) return;
    const controller = operation.current;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSave(pdfArticle(preview.draft, preview.draft.title), preview.file);
      if (operation.current === controller) cancel();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save this PDF. Free some browser storage and try again.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Import a PDF"
      className={`mt-3 rounded-sm transition-colors ${dragging ? "outline outline-1 outline-dashed outline-muted-foreground outline-offset-8" : ""}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        if (!disabled && !busy) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (disabled || busy) return;
        if (event.dataTransfer.files.length !== 1) { setError("Choose one PDF at a time."); return; }
        void choose(event.dataTransfer.files[0]);
      }}
    >
      <input ref={input} type="file" accept="application/pdf,.pdf" className="sr-only" tabIndex={-1}
        aria-label="Choose PDF file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void choose(file);
        }} />
      {!preview && !busy && (
        <div className="flex items-center gap-2 py-2 text-[13px]">
          <button type="button" className={actionClass} disabled={disabled} onClick={() => input.current?.click()}>Choose PDF</button>
          <span className="text-muted-foreground/60">or drop one here</span>
        </div>
      )}
      {busy && !preview && (
        <div className="flex items-center gap-4 py-2 text-[13px]">
          <span role="status" className="text-muted-foreground">{progress ? `Reading page ${progress.page} of ${progress.pages}…` : "Opening PDF…"}</span>
          <button type="button" className={actionClass} onClick={cancel}>Cancel</button>
        </div>
      )}
      {preview && (
        <div className="mt-5 space-y-4 text-[13px]">
          <div>
            <label htmlFor="pdf-title" className="text-muted-foreground">Title</label>
            <input id="pdf-title" value={preview.draft.title} maxLength={500} disabled={busy}
              onChange={(event) => setPreview({ ...preview, draft: { ...preview.draft, title: event.target.value } })}
              className="mt-1 w-full border-0 border-b border-border bg-transparent py-2 outline-none focus:border-foreground/40" />
          </div>
          <div>
            <label htmlFor="pdf-text" className="text-muted-foreground">Text preview · {preview.draft.pageCount} pages</label>
            <textarea id="pdf-text" value={preview.draft.text} maxLength={MAX_PDF_TEXT_CHARS} disabled={busy}
              onChange={(event) => setPreview({ ...preview, draft: { ...preview.draft, text: event.target.value } })}
              className="mt-2 h-64 w-full resize-y rounded-sm border border-border bg-transparent p-3 leading-relaxed outline-none focus:border-foreground/40" />
          </div>
          {preview.draft.emptyPages > 0 && <p className="text-muted-foreground">{preview.draft.emptyPages} {preview.draft.emptyPages === 1 ? "page has" : "pages have"} no selectable text and {preview.draft.emptyPages === 1 ? "is" : "are"} absent from this preview.</p>}
          <p className="text-xs leading-relaxed text-muted-foreground">The PDF stays in this browser. If sync is on, the saved text syncs across devices.</p>
          <div className="flex gap-4">
            <button type="button" className={actionClass} disabled={busy || !preview.draft.title.trim() || !preview.draft.text.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
            <button type="button" className={actionClass} disabled={busy} onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{error}</p>}
    </section>
  );
}
