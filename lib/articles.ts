import type {
  Article,
  ArticleVia,
  ExtractedArticle,
  ExtractSource,
} from "@/lib/types";

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export function articleDate(article: Article): string {
  return dateFormat.format(new Date(article.savedAt));
}

export function readingTime(wordCount: number): string {
  return `${Math.max(1, Math.round(wordCount / 220))} min`;
}

export function articleSite(article: Article): string {
  if (article.siteName) return article.siteName;
  try {
    return new URL(article.url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function sourceToVia(source: ExtractSource): ArticleVia {
  return source === "direct" ? null : source;
}

export function viaLabel(via: ArticleVia): string | null {
  if (via === "archive") return "via archive.ph";
  if (via === "render") return "via r.jina.ai";
  if (via === "paste") return "pasted";
  return null;
}

export function toArticle(data: ExtractedArticle, via: ArticleVia): Article {
  return {
    id: crypto.randomUUID(),
    ...data,
    savedAt: Date.now(),
    readAt: null,
    via,
  };
}

export function articleText(article: Article): string {
  const doc = new DOMParser().parseFromString(article.content, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function plainTextToHtml(text: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escape(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export async function requestExtract(
  url: string,
  source: ExtractSource,
  html?: string
): Promise<ExtractedArticle> {
  const res = await fetch("/api/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, source, html }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? "Couldn't parse that page");
  }
  return body as ExtractedArticle;
}
