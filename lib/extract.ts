import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

import type { ExtractedArticle, ExtractSource } from "@/lib/types";

export class ExtractError extends Error {}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function parseUrl(raw: string): URL {
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
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExtractError("Only http(s) URLs are supported");
  }
  return url;
}

export function normalizeUrl(raw: string): URL {
  const url = parseUrl(raw);
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

async function fetchRaw(url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept:
          "text/html,application/xhtml+xml,text/markdown;q=0.9,text/plain;q=0.8,*/*;q=0.5",
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
  return res;
}

async function readBody(res: Response): Promise<string> {
  const body = await res.text();
  if (body.length > MAX_HTML_BYTES) {
    throw new ExtractError("That page is too large to parse");
  }
  return body;
}

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string }> {
  const res = await fetchRaw(url);
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType && !/text\/html|application\/xhtml/.test(contentType)) {
    throw new ExtractError("That URL isn't an HTML page");
  }
  return { html: await readBody(res), finalUrl: res.url };
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

// Pasted pages arrive with app chrome around the text; these tags (and
// their text) are noise there, whereas Readability output never has them.
const CHROME_TAGS = [
  "script", "style", "noscript", "textarea", "option", "select",
  "button", "nav", "form", "dialog", "svg", "canvas", "iframe",
  "audio", "video",
];

function sanitizeContent(
  html: string,
  baseUrl: string,
  { discardChrome = false } = {}
): string {
  return sanitizeHtml(html, {
    ...(discardChrome ? { nonTextTags: CHROME_TAGS } : {}),
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
    // TeX carriers rendered client-side by KaTeX on the article page.
    allowedClasses: { span: ["math", "math-display"] },
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
        "That page is a JavaScript app — it has no static text to pull. Try the rendered copy, or open it in your browser, copy everything, and paste it in."
      );
    }
    throw new ExtractError("Couldn't find readable content on that page");
  }

  const content = sanitizeContent(normalizeMathHtml(result.content), sourceUrl);
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
    throw new ExtractError("Couldn't reach Twitter");
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
    title: author ? `${author} on Twitter` : "Post on Twitter",
    byline: author,
    siteName: "Twitter",
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

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// TeX survives storage as <span class="math">…</span> (display variant for
// block math); the article page renders those with KaTeX. Shielding happens
// BEFORE marked runs, because markdown rules chew raw TeX (x_i + y_j turns
// into emphasis). Code fences/spans are left alone, and single-$ pairs only
// count as math when the body looks like TeX — "$5 and $10" stays currency.
function renderMarkdown(md: string): string {
  const stash: { tex: string; display: boolean }[] = [];
  const token = (tex: string, display: boolean) => {
    stash.push({ tex: tex.trim(), display });
    return `%%%MATH${stash.length - 1}%%%`;
  };

  const shielded = md
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/)
    .map((segment, i) => {
      if (i % 2 === 1) return segment;
      return segment
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => token(tex, true))
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => token(tex, true))
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => token(tex, false))
        .replace(/(?<![\w$\\])\$([^$\n]+?)\$(?![\w$])/g, (match, tex) =>
          /[\\^_{]/.test(tex) ? token(tex, false) : match
        );
    })
    .join("");

  const html = marked.parse(shielded, { async: false });
  return html.replace(/%%%MATH(\d+)%%%/g, (_, i) => {
    const m = stash[Number(i)];
    if (!m) return "";
    return `<span class="math${m.display ? " math-display" : ""}">${escapeText(m.tex)}</span>`;
  });
}

// Recovers TeX from math markup before sanitization flattens it: LaTeXML /
// Wikipedia MathML (alttext or annotation), KaTeX clipboard copies, and
// MathJax containers. Where no TeX survives, the visual/assistive duplicate
// still collapses to a single plain-text copy.
function normalizeMathHtml(html: string): string {
  if (!/<math|<mjx-|class="katex|class='katex/i.test(html)) return html;
  try {
    const { document } = parseHTML(`<html><body>${html}</body></html>`);

    const texOf = (scope: Element): string | null =>
      scope
        .querySelector('annotation[encoding="application/x-tex"]')
        ?.textContent?.trim() ||
      scope.getAttribute("alttext")?.trim() ||
      scope.querySelector("math")?.getAttribute("alttext")?.trim() ||
      null;

    const replaceWithSpan = (el: Element, tex: string, display: boolean) => {
      const span = document.createElement("span");
      span.setAttribute("class", display ? "math math-display" : "math");
      span.textContent = tex;
      el.replaceWith(span);
    };

    for (const el of Array.from(
      document.querySelectorAll(".katex, mjx-container")
    )) {
      if (!document.contains(el)) continue;
      const target = el.closest(".katex-display") ?? el;
      const display =
        el.tagName.toLowerCase() === "mjx-container"
          ? el.getAttribute("display") === "true"
          : target !== el;
      const tex = texOf(el);
      if (tex) {
        replaceWithSpan(target, tex, display);
      } else {
        const plain = el.querySelector("math")?.textContent?.trim();
        if (plain) target.replaceWith(document.createTextNode(plain));
      }
    }

    for (const m of Array.from(document.querySelectorAll("math"))) {
      if (!document.contains(m)) continue;
      const tex = texOf(m);
      if (tex) replaceWithSpan(m, tex, m.getAttribute("display") === "block");
    }

    return document.body.innerHTML;
  } catch {
    return html;
  }
}

function extractFromMarkdown(
  md: string,
  sourceUrl: string,
  canonicalUrl: string,
  meta?: { title?: string | null; excerpt?: string | null }
): ExtractedArticle {
  const content = sanitizeContent(renderMarkdown(md), sourceUrl);
  const wordCount = countWords(content);
  if (wordCount === 0) {
    throw new ExtractError("Couldn't find readable content in that file");
  }

  const { document } = parseHTML(`<article>${content}</article>`);
  const heading = document.querySelector("h1, h2")?.textContent?.trim();
  const canonical = new URL(canonicalUrl);
  const filename = canonical.pathname
    .split("/")
    .pop()
    ?.replace(/\.(md|markdown|txt)$/i, "");

  return {
    url: canonicalUrl,
    title:
      meta?.title?.trim() ||
      heading?.slice(0, 160) ||
      filename ||
      canonical.hostname.replace(/^www\./, ""),
    byline: null,
    siteName: null,
    excerpt: meta?.excerpt?.trim() || null,
    content,
    wordCount,
  };
}

// Rendered copy via r.jina.ai: a real browser fetch on their side, markdown
// back on ours. Covers PDFs and JS-rendered pages; bot-walled hosts (e.g.
// Cloudflare-challenged ones) still fail here — that's what paste is for.
// JINA_API_KEY (optional) raises the service's rate limits; JINA_BASE_URL
// overrides the endpoint for tests or self-hosted readers.
async function extractRendered(url: URL): Promise<ExtractedArticle> {
  const base = process.env.JINA_BASE_URL ?? "https://r.jina.ai";
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.JINA_API_KEY) {
    headers.authorization = `Bearer ${process.env.JINA_API_KEY}`;
  }

  let res: Response;
  try {
    res = await fetch(`${base}/${url.href}`, {
      headers,
      signal: AbortSignal.timeout(50_000),
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

  const body = (await res.json().catch(() => null)) as {
    data?: { title?: string; description?: string; content?: string };
  } | null;
  const md = body?.data?.content;
  if (!md?.trim()) {
    throw new ExtractError("The rendering service returned nothing readable");
  }
  if (md.length > MAX_HTML_BYTES) {
    throw new ExtractError("That page is too large to parse");
  }

  return extractFromMarkdown(md, url.href, url.href, {
    title: body?.data?.title,
    excerpt: body?.data?.description,
  });
}

export interface PastedPayload {
  html?: string;
  text?: string;
}

function looksLikeMarkdown(text: string): boolean {
  const sample = text.slice(0, 10_000);
  let strong = 0;
  let weak = 0;
  if (/^#{1,6}\s+\S/m.test(sample)) strong++;
  if (/^```/m.test(sample)) strong++;
  if (/^\|.+\|\s*$/m.test(sample) && /^\|[\s:|-]+\|\s*$/m.test(sample)) strong++;
  if (/\[[^\]\n]+\]\([^)\s]+\)/.test(sample)) strong++;
  if ((sample.match(/^[-*+]\s+\S/gm)?.length ?? 0) >= 2) weak++;
  if ((sample.match(/^\d+[.)]\s+\S/gm)?.length ?? 0) >= 2) weak++;
  if (/^>\s?\S/m.test(sample)) weak++;
  if (/\*\*[^*\n]+\*\*|__[^_\n]+__/.test(sample)) weak++;
  if (/`[^`\n]+`/.test(sample)) weak++;
  return strong >= 1 || weak >= 2;
}

// Rich pastes that add no block structure beyond paragraphs are usually an
// editor's syntax-highlighted wrapper around source text, not a rendered page.
function hasBlockStructure(sanitizedHtml: string): boolean {
  return /<(h[1-6]|ul|ol|table|blockquote)\b/i.test(sanitizedHtml);
}

function plainTextAsHtml(text: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escape(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// Content the user copied out of their own browser tab — the one path that
// works for pages a server can never fetch (logins, paywalls, JS-only apps).
// Nothing is fetched, so private hosts are fine and Readability is skipped:
// the user already chose what to copy.
function extractPasted(paste: PastedPayload, rawUrl: string): ExtractedArticle {
  const url = parseUrl(rawUrl);
  const html = paste.html?.trim() ? paste.html : null;
  const text = paste.text?.trim() ? paste.text : null;
  if ((html?.length ?? 0) > MAX_HTML_BYTES || (text?.length ?? 0) > MAX_HTML_BYTES) {
    throw new ExtractError("That paste is too large to save");
  }

  const fromHtml = html
    ? sanitizeContent(normalizeMathHtml(html), url.href, { discardChrome: true })
    : null;

  let content: string;
  if (text && looksLikeMarkdown(text) && (!fromHtml || !hasBlockStructure(fromHtml))) {
    content = sanitizeContent(renderMarkdown(text), url.href);
  } else if (fromHtml) {
    content = fromHtml;
  } else if (text) {
    content = sanitizeContent(plainTextAsHtml(text), url.href);
  } else {
    throw new ExtractError("Nothing was pasted");
  }

  const wordCount = countWords(content);
  if (wordCount === 0) {
    throw new ExtractError("That paste didn't contain any readable text");
  }

  const { document } = parseHTML(`<article>${content}</article>`);
  const heading = document.querySelector("h1, h2")?.textContent?.trim();

  return {
    url: url.href,
    title: heading?.slice(0, 160) || url.hostname.replace(/^www\./, ""),
    byline: null,
    siteName: null,
    excerpt: null,
    content,
    wordCount,
  };
}

const MARKDOWN_EXT = /\.(md|markdown|txt)$/i;

export async function extract(
  rawUrl: string,
  source: ExtractSource,
  paste?: PastedPayload
): Promise<ExtractedArticle> {
  if (source === "paste") {
    return extractPasted(paste ?? {}, rawUrl);
  }

  const url = normalizeUrl(rawUrl);

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

  // PDFs can't be parsed here; the render service reads them natively, so
  // route them there without a wasted download.
  if (url.pathname.toLowerCase().endsWith(".pdf")) {
    return extractRendered(url);
  }

  const res = await fetchRaw(url.href);
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const finalUrl = res.url;
  const finalPath = new URL(finalUrl).pathname.toLowerCase();

  if (contentType.includes("application/pdf") || finalPath.endsWith(".pdf")) {
    await res.body?.cancel();
    return extractRendered(url);
  }

  if (
    contentType.includes("text/markdown") ||
    contentType.includes("text/plain") ||
    (!contentType.includes("html") &&
      (MARKDOWN_EXT.test(finalPath) || MARKDOWN_EXT.test(url.pathname)))
  ) {
    return extractFromMarkdown(await readBody(res), finalUrl, url.href);
  }

  if (
    !contentType ||
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml")
  ) {
    return parseReadable(await readBody(res), finalUrl, url.href);
  }

  throw new ExtractError(
    "That link isn't a format the reader can parse — try the rendered copy"
  );
}
