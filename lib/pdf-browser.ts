import { checkPdfFile, MAX_PDF_PAGES, MAX_PDF_TEXT_CHARS, PdfImportError, pdfPageText, pdfTitle, type PdfDraft } from "./pdf";

export async function extractPdf(
  file: File,
  { signal, onProgress }: { signal: AbortSignal; onProgress: (page: number, pages: number) => void },
): Promise<PdfDraft> {
  checkPdfFile(file);
  signal.throwIfAborted();
  const data = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  if (!new TextDecoder().decode(data.subarray(0, 1024)).includes("%PDF-")) {
    throw new PdfImportError("That file is not a readable PDF.");
  }
  // Only imported after a file is chosen. Bytes stay in this browser; the
  // same-origin assets endpoint serves PDF.js code/fonts, never document data.
  const pdfjs = await import("pdfjs-dist");
  signal.throwIfAborted();
  pdfjs.GlobalWorkerOptions.workerSrc = `/api/pdf-assets/build/pdf.worker.min.mjs?v=${pdfjs.version}`;
  const task = pdfjs.getDocument({
    data,
    cMapUrl: "/api/pdf-assets/cmaps/", cMapPacked: true,
    standardFontDataUrl: "/api/pdf-assets/standard_fonts/",
    useWasm: false,
  });
  const cancel = () => { void task.destroy().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const document = await task.promise;
    signal.throwIfAborted();
    if (document.numPages > MAX_PDF_PAGES) throw new PdfImportError("Choose a PDF with 300 pages or fewer.");
    const metadata = await document.getMetadata().catch(() => null);
    const title = pdfTitle(file.name, (metadata?.info as { Title?: unknown } | undefined)?.Title);
    const pages: string[] = [];
    let length = 0;
    let emptyPages = 0;
    onProgress(0, document.numPages);
    for (let number = 1; number <= document.numPages; number++) {
      signal.throwIfAborted();
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      signal.throwIfAborted();
      const text = pdfPageText(content.items);
      page.cleanup();
      length += text.length + 2;
      if (length > MAX_PDF_TEXT_CHARS) throw new PdfImportError("That PDF contains too much text. Choose a shorter document.");
      if (!text) emptyPages++;
      else pages.push(text);
      onProgress(number, document.numPages);
    }
    if (!pages.length) {
      throw new PdfImportError("This PDF has no selectable text. It may be scanned. Export a searchable PDF with text recognition, then try again.");
    }
    return { title, text: pages.join("\n\n"), pageCount: document.numPages, emptyPages };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof PdfImportError) throw error;
    if (error instanceof Error && error.name === "PasswordException") {
      throw new PdfImportError("This PDF is password-protected. Save an unlocked copy, then choose it here.");
    }
    throw new PdfImportError("Couldn't read that PDF. Try exporting a new copy and importing it again.");
  } finally {
    signal.removeEventListener("abort", cancel);
    await task.destroy().catch(() => {});
  }
}
