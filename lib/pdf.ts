import type { ExtractedArticle } from "./types.ts";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 300;
export const MAX_PDF_TEXT_CHARS = 250_000;
export const MAX_PDF_HTML_CHARS = 1_500_000;

export interface PdfDraft {
  title: string;
  text: string;
  pageCount: number;
  emptyPages: number;
}

export class PdfImportError extends Error {}

export function checkPdfFile(file: { name: string; size: number; type: string }): void {
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    throw new PdfImportError("Choose a PDF file.");
  }
  if (!file.size) throw new PdfImportError("That PDF is empty.");
  if (file.size > MAX_PDF_BYTES) throw new PdfImportError("Choose a PDF smaller than 20 MB.");
}

export function pdfTitle(filename: string, metadataTitle?: unknown): string {
  const title = typeof metadataTitle === "string" ? metadataTitle.trim() : "";
  return (title && !/^untitled$/i.test(title) ? title : filename.replace(/\.pdf$/i, "")).slice(0, 500) || "Untitled PDF";
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

// PDF text items are fragments positioned on a page, not paragraphs. Keep
// their order, join adjacent fragments, and retain line/paragraph boundaries.
// The import preview is deliberately text: columns and tables can need review.
export function pdfPageText(items: unknown[]): string {
  let result = "";
  let previous: TextItem | null = null;
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || !("str" in raw)) continue;
    const item = raw as TextItem;
    if (typeof item.str !== "string" || !Array.isArray(item.transform)) continue;
    const text = item.str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
    if (previous && text) {
      const height = Math.max(Math.abs(previous.height), Math.abs(item.height), 1);
      const deltaY = Math.abs(item.transform[5] - previous.transform[5]);
      if (deltaY > height * 1.7) result = result.trimEnd() + "\n\n";
      else if (deltaY > height * 0.4 && !result.endsWith("\n")) result += "\n";
      else if (!/\s$/.test(result) && !/^\s/.test(text)) {
        const gap = item.transform[4] - previous.transform[4] - previous.width;
        if (gap > height * 0.12) result += " ";
      }
    }
    result += text;
    if (item.hasEOL && !result.endsWith("\n")) result += "\n";
    previous = item;
  }
  return result.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function pdfArticle(draft: PdfDraft, title: string): ExtractedArticle {
  const text = draft.text.trim();
  if (!text) throw new PdfImportError("There is no text to save.");
  if (text.length > MAX_PDF_TEXT_CHARS) throw new PdfImportError("That PDF contains too much text. Choose a shorter document.");
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const content = text.split(/\n\s*\n/).map((paragraph) => `<p>${escape(paragraph.replace(/\s+/g, " ").trim())}</p>`).join("\n");
  if (content.length > MAX_PDF_HTML_CHARS) throw new PdfImportError("That PDF contains too much text. Choose a shorter document.");
  return {
    url: "", title: title.trim().slice(0, 500) || draft.title,
    byline: null, siteName: null, excerpt: text.replace(/\s+/g, " ").slice(0, 280),
    content, wordCount: text.split(/\s+/).length,
  };
}
