import { htmlToMarkdown } from "@/lib/markdown";
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

function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function articleText(article: Article): string {
  return htmlText(article.content);
}

export function articleMarkdown(article: Article): string {
  return htmlToMarkdown(article.content);
}

export function htmlWordCount(html: string): number {
  const text = htmlText(html);
  return text ? text.split(" ").length : 0;
}

// Splits article HTML into trimmable blocks. Bare <div>s are unwrapped —
// after sanitization they are pure containers (select-all pastes arrive as
// one page-sized div), and trimming needs the paragraphs inside them.
export function splitBlocks(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks: string[] = [];

  const walk = (nodes: Iterable<ChildNode>) => {
    for (const node of nodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (el.tagName === "DIV") {
          walk(Array.from(el.childNodes));
        } else if (
          el.textContent?.trim() ||
          el.tagName === "HR" ||
          el.tagName === "IMG" ||
          el.querySelector("img")
        ) {
          blocks.push(el.outerHTML);
        }
      } else if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
        const p = doc.createElement("p");
        p.textContent = node.textContent.trim();
        blocks.push(p.outerHTML);
      }
    }
  };

  walk(Array.from(doc.body.childNodes));
  return blocks;
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
