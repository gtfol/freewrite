import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import sanitizeHtml from "sanitize-html";

import type { ExtractedArticle, ExtractSource } from "@/lib/types";

export class ExtractError extends Error {}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function normalizeUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) throw new ExtractError("No URL provided");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ExtractError("That doesn't look like a valid URL");
  }
  assertPublicHost(url);
  return url;
}

function assertPublicHost(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExtractError("Only http(s) URLs are supported");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.includes(":")
  ) {
    throw new ExtractError("That host can't be fetched");
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const isPrivate =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224;
    if (isPrivate) throw new ExtractError("That host can't be fetched");
  }
}

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new ExtractError("Couldn't reach that page");
  }
  if (!res.ok) {
    throw new ExtractError(`The page responded with ${res.status}`);
  }
  assertPublicHost(new URL(res.url));

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType && !/text\/html|application\/xhtml/.test(contentType)) {
    throw new ExtractError("That URL isn't an HTML page");
  }

  const html = await res.text();
  if (html.length > MAX_HTML_BYTES) {
    throw new ExtractError("That page is too large to parse");
  }
  return { html, finalUrl: res.url };
}

function absolutize(value: string | undefined, base: string): string | null {
  if (!value) return null;
  try {
    const resolved = new URL(value, base);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.href
      : null;
  } catch {
    return null;
  }
}

function sanitizeContent(html: string, baseUrl: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "a", "ul", "ol", "li", "blockquote",
      "pre", "code", "em", "strong", "b", "i", "u", "s",
      "br", "hr", "img", "figure", "figcaption",
      "table", "thead", "tbody", "tr", "th", "td",
      "sup", "sub", "mark", "cite", "aside", "div", "span",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      th: ["colspan", "rowspan"],
      td: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https"],
    transformTags: {
      a: (tagName, attribs) => {
        const href = absolutize(attribs.href, baseUrl);
        return {
          tagName,
          attribs: {
            ...(href ? { href } : {}),
            ...(attribs.title ? { title: attribs.title } : {}),
            target: "_blank",
            rel: "noreferrer noopener",
          },
        };
      },
      img: (tagName, attribs) => {
        const src = absolutize(attribs.src, baseUrl);
        return {
          tagName,
          attribs: {
            ...(src ? { src } : {}),
            ...(attribs.alt ? { alt: attribs.alt } : {}),
            loading: "lazy",
          },
        };
      },
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });
}

function countWords(html: string): number {
  return visibleText(html).split(/\s+/).filter(Boolean).length;
}

function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .trim();
}

function looksLikeJsShell(html: string): boolean {
  return (
    visibleText(html).length < 500 &&
    (html.match(/<script/gi)?.length ?? 0) > 0
  );
}

function parseReadable(
  html: string,
  sourceUrl: string,
  canonicalUrl: string
): ExtractedArticle {
  const { document } = parseHTML(html);
  const reader = new Readability(document as unknown as Document, {
    charThreshold: 100,
  });
  const result = reader.parse();

  if (!result?.content) {
    if (looksLikeJsShell(html)) {
      throw new ExtractError(
        "That page is a JavaScript app — it has no static text to pull. The rendered copy usually works."
      );
    }
    throw new ExtractError("Couldn't find readable content on that page");
  }

  const content = sanitizeContent(result.content, sourceUrl);
  return {
    url: canonicalUrl,
    title: result.title?.trim() || new URL(canonicalUrl).hostname,
    byline: result.byline?.trim() || null,
    siteName: result.siteName?.trim() || null,
    excerpt: result.excerpt?.trim() || null,
    content,
    wordCount: countWords(content),
  };
}

const TWEET_PATTERN =
  /^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[^/]+\/status\/\d+/i;

async function extractTweet(url: URL): Promise<ExtractedArticle> {
  const canonical = url.href.split("?")[0];
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(
    canonical
  )}&omit_script=true&dnt=true&hide_thread=false`;

  let res: Response;
  try {
    res = await fetch(oembedUrl, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new ExtractError("Couldn't reach X");
  }
  if (!res.ok) {
    throw new ExtractError("Couldn't load that post — it may be private or deleted");
  }

  const oembed = (await res.json()) as {
    html?: string;
    author_name?: string;
    url?: string;
  };
  if (!oembed.html) {
    throw new ExtractError("Couldn't load that post");
  }

  const { document } = parseHTML(oembed.html);
  const body = document.querySelector("blockquote p")?.innerHTML;
  if (!body) {
    throw new ExtractError("Couldn't parse that post");
  }

  const content = sanitizeContent(
    `<p>${body.replace(/<br\s*\/?>/gi, "</p><p>")}</p>`,
    canonical
  );
  const author = oembed.author_name?.trim() || null;

  return {
    url: oembed.url ?? canonical,
    title: author ? `${author} on X` : "Post on X",
    byline: author,
    siteName: "X",
    excerpt: null,
    content,
    wordCount: countWords(content),
  };
}

const ARXIV_PATTERN =
  /arxiv\.org\/(?:abs|pdf|html)\/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/[0-9]{7})/i;

async function extractArxiv(url: URL, id: string): Promise<ExtractedArticle> {
  const cleanId = id.replace(/\.pdf$/i, "");
  const absUrl = `https://arxiv.org/abs/${cleanId}`;

  try {
    const { html, finalUrl } = await fetchHtml(`https://arxiv.org/html/${cleanId}`);
    const article = parseReadable(html, finalUrl, absUrl);
    if (article.wordCount > 300) {
      return { ...article, siteName: article.siteName ?? "arXiv" };
    }
  } catch {
    // fall through to the abstract page
  }

  const { html, finalUrl } = await fetchHtml(absUrl);
  const article = parseReadable(html, finalUrl, absUrl);
  return { ...article, siteName: article.siteName ?? "arXiv" };
}

async function extractRendered(url: URL): Promise<ExtractedArticle> {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    "x-return-format": "html",
  };
  if (process.env.JINA_API_KEY) {
    headers.authorization = `Bearer ${process.env.JINA_API_KEY}`;
  }

  let res: Response;
  try {
    res = await fetch(`https://r.jina.ai/${url.href}`, {
      headers,
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new ExtractError("The rendering service didn't respond in time");
  }
  if (res.status === 429) {
    throw new ExtractError(
      "The rendering service is rate-limited right now — wait a minute and try again"
    );
  }
  if (!res.ok) {
    throw new ExtractError(`The rendering service responded with ${res.status}`);
  }

  const html = await res.text();
  if (html.length > MAX_HTML_BYTES) {
    throw new ExtractError("That page is too large to parse");
  }
  return parseReadable(html, url.href, url.href);
}

export async function extract(
  rawUrl: string,
  source: ExtractSource
): Promise<ExtractedArticle> {
  const url = normalizeUrl(rawUrl);

  if (source === "archive") {
    const { html, finalUrl } = await fetchHtml(
      `https://archive.ph/newest/${url.href}`
    );
    return parseReadable(html, finalUrl, url.href);
  }

  if (source === "render") {
    return extractRendered(url);
  }

  if (TWEET_PATTERN.test(url.href)) {
    return extractTweet(url);
  }

  const arxivMatch = url.href.match(ARXIV_PATTERN);
  if (arxivMatch) {
    return extractArxiv(url, arxivMatch[1]);
  }

  const { html, finalUrl } = await fetchHtml(url.href);
  return parseReadable(html, finalUrl, url.href);
}
