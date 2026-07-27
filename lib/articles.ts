import type { Article, ExtractedArticle } from "@/lib/types";

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

export function toArticle(
  data: ExtractedArticle,
  via: "archive" | null
): Article {
  return {
    id: crypto.randomUUID(),
    ...data,
    savedAt: Date.now(),
    readAt: null,
    via,
  };
}

export async function requestExtract(
  url: string,
  archive: boolean
): Promise<ExtractedArticle> {
  const res = await fetch("/api/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, archive }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? "Couldn't parse that page");
  }
  return body as ExtractedArticle;
}
