import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

// Serve only PDF.js's packaged worker and character/font maps. This endpoint
// has no document-upload method and never accepts a URL or arbitrary path.
export async function GET(_request: Request, { params }: { params: Promise<{ kind: string; name: string }> }) {
  const { kind, name } = await params;
  const valid = (kind === "build" && name === "pdf.worker.min.mjs") ||
    (kind === "cmaps" && /^[\w-]+\.bcmap$/.test(name)) ||
    (kind === "standard_fonts" && /^[\w-]+\.(?:pfb|ttf)$/.test(name));
  if (!valid) return new Response("Not found", { status: 404 });
  try {
    const bytes = await readFile(path.join(process.cwd(), "node_modules", "pdfjs-dist", kind, name));
    return new Response(bytes, { headers: {
      "content-type": kind === "build" ? "text/javascript; charset=utf-8" : "application/octet-stream",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
