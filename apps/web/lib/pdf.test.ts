import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPdfFile, MAX_PDF_BYTES, MAX_PDF_TEXT_CHARS, pdfArticle, pdfPageText, pdfTitle, type PdfDraft } from "./pdf.ts";
import { asArticle } from "./article-validation.ts";

const draft = (text: string): PdfDraft => ({ title: "Document", text, pageCount: 2, emptyPages: 0 });
const item = (str: string, x: number, y: number, width: number, hasEOL = false) => ({ str, transform: [10, 0, 0, 10, x, y], width, height: 10, hasEOL });

test("PDF selection accepts typed or named PDFs and rejects empty/oversized/non-PDF files", () => {
  assert.doesNotThrow(() => checkPdfFile({ name: "article.PDF", type: "", size: MAX_PDF_BYTES }));
  assert.doesNotThrow(() => checkPdfFile({ name: "download", type: "application/pdf", size: 12 }));
  assert.throws(() => checkPdfFile({ name: "a.png", type: "image/png", size: 12 }), /Choose a PDF/);
  assert.throws(() => checkPdfFile({ name: "a.pdf", type: "", size: 0 }), /empty/);
  assert.throws(() => checkPdfFile({ name: "a.pdf", type: "", size: MAX_PDF_BYTES + 1 }), /20 MB/);
});

test("PDF fragment extraction restores spaces, lines, and paragraph gaps", () => {
  assert.equal(pdfPageText([
    item("Hel", 0, 100, 15), item("lo", 15, 100, 10), item("world", 29, 100, 25, true),
    item("Second line", 0, 88, 55, true), item("New paragraph", 0, 64, 65),
    { type: "beginMarkedContent" },
  ]), "Hello world\nSecond line\n\nNew paragraph");
  assert.equal(pdfPageText([]), "");
});

test("PDF content is escaped safe HTML and remains compatible with article sync", () => {
  const extracted = pdfArticle(draft("One & two\nwrapped line.\n\n<script>alert(1)</script>"), "  A local PDF  ");
  assert.equal(extracted.content, "<p>One &amp; two wrapped line.</p>\n<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(extracted.url, "");
  assert.equal(extracted.title, "A local PDF");
  const record = { ...extracted, id: "pdf-1", savedAt: 1, readAt: null, updatedAt: 1, deletedAt: null, via: "pdf" };
  assert.deepEqual(asArticle(JSON.parse(JSON.stringify(record))), record);
});

test("PDF title fallbacks and text limits are enforced before saving", () => {
  assert.equal(pdfTitle("My Paper.PDF", "Untitled"), "My Paper");
  assert.equal(pdfTitle("file.pdf", "  Actual title  "), "Actual title");
  assert.equal(pdfTitle("file.pdf", {}), "file");
  assert.throws(() => pdfArticle(draft(" \n "), "Title"), /no text/);
  assert.throws(() => pdfArticle(draft("x".repeat(MAX_PDF_TEXT_CHARS + 1)), "Title"), /too much text/);
  assert.doesNotThrow(() => pdfArticle(draft("&".repeat(MAX_PDF_TEXT_CHARS)), "Title"));
});
