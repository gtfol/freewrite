import type { Article, Highlight } from "./types.ts";

const MAX_ARTICLE_CHARS = 2_000_000;
const MAX_HIGHLIGHTS = 500;
const MAX_HIGHLIGHT_TEXT = 4_000;
const MAX_HIGHLIGHT_CONTEXT = 200;
const MAX_HIGHLIGHT_NOTE = 8_000;

const isId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 64;
const isStamp = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const isStampOrNull = (v: unknown): v is number | null =>
  v === null || v === undefined || isStamp(v);
const asText = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length <= max ? v : null;
const asOptText = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length <= max ? v : null;

// Absent/empty → null; malformed → false. Malformed highlights must reject
// the whole change (not be dropped): the client's hash covers them, and
// storing that hash over different content would wedge reconciliation.
function asHighlights(v: unknown): Highlight[] | null | false {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > MAX_HIGHLIGHTS) return false;
  const out: Highlight[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) return false;
    const h = item as Record<string, unknown>;
    const text = asText(h.text, MAX_HIGHLIGHT_TEXT);
    const context = (c: unknown): c is string =>
      typeof c === "string" && c.length <= MAX_HIGHLIGHT_CONTEXT;
    if (
      !isId(h.id) ||
      !text ||
      !context(h.prefix) ||
      !context(h.suffix) ||
      !isStamp(h.createdAt) ||
      !isStamp(h.updatedAt)
    ) {
      return false;
    }
    const note =
      h.note === null || h.note === undefined
        ? null
        : asText(h.note, MAX_HIGHLIGHT_NOTE);
    if (h.note != null && note === null) return false;
    out.push({
      id: h.id,
      text,
      prefix: h.prefix,
      suffix: h.suffix,
      note,
      createdAt: h.createdAt,
      updatedAt: h.updatedAt,
    });
  }
  return out.length ? out : null;
}

export function asArticle(v: unknown): Article | null {
  if (typeof v !== "object" || v === null) return null;
  const a = v as Record<string, unknown>;
  const content = asText(a.content, MAX_ARTICLE_CHARS);
  // Locally imported PDFs have no public URL; the empty string is valid.
  const url = asText(a.url, 2048);
  const title = asText(a.title, 1024);
  const highlights = asHighlights(a.highlights);
  if (highlights === false) return null;
  if (
    !isId(a.id) ||
    content === null ||
    url === null ||
    title === null ||
    !isStamp(a.savedAt) ||
    !isStamp(a.updatedAt) ||
    !isStampOrNull(a.readAt) ||
    !isStampOrNull(a.deletedAt) ||
    typeof a.wordCount !== "number"
  ) {
    return null;
  }
  const contentOriginal = asOptText(a.contentOriginal, MAX_ARTICLE_CHARS);
  return {
    id: a.id,
    url,
    title,
    byline: asOptText(a.byline, 512),
    siteName: asOptText(a.siteName, 512),
    excerpt: asOptText(a.excerpt, 4096),
    content,
    ...(contentOriginal !== null && { contentOriginal }),
    ...(highlights !== null && { highlights }),
    wordCount: Math.max(0, Math.floor(a.wordCount)),
    savedAt: a.savedAt,
    readAt: (a.readAt as number | null | undefined) ?? null,
    via:
      a.via === "archive" ||
      a.via === "render" ||
      a.via === "paste" ||
      a.via === "freedium" ||
      a.via === "pdf"
        ? a.via
        : null,
    updatedAt: a.updatedAt,
    deletedAt: (a.deletedAt as number | null | undefined) ?? null,
  };
}
