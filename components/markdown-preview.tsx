"use client";

import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { useCallback, useMemo, useState } from "react";

import { JsonTree } from "@/components/json-tree";
import { Lightbox, type LightboxMedia } from "@/components/lightbox";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");

type Media =
  | { tag: "image" | "video"; src: string }
  | { tag: "youtube"; id: string };

// Direct media file links plus YouTube pages; anything else stays a link.
// http(s) only — no javascript:/data: URLs sneaking into src attributes.
function mediaFor(href: string): Media | null {
  if (!/^https?:\/\//i.test(href)) return null;
  const path = href.split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|svg|bmp)$/.test(path))
    return { tag: "image", src: href };
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(path))
    return { tag: "video", src: href };
  const yt = href.match(
    /^https?:\/\/(?:www\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?[^#]*?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i
  );
  if (yt) return { tag: "youtube", id: yt[1] };
  return null;
}

// Everything embeds as a modest thumbnail that opens the lightbox on click —
// media stays a reference alongside the writing rather than taking the page
// over. Video renders its own first frame; YouTube uses its poster image, so
// no third-party frame loads until the writer actually asks for it.
function thumb(kind: Media["tag"], src: string, inner: string): string {
  return (
    `<span class="media-thumb" data-media="${kind}" data-src="${escapeAttr(src)}"` +
    ` role="button" tabindex="0" title="Click to expand">${inner}` +
    `<span class="media-play" aria-hidden="true"></span></span>`
  );
}

function mediaHtml(media: Media): string {
  switch (media.tag) {
    case "image":
      return `<img src="${escapeAttr(media.src)}" alt="" loading="lazy" title="Click to expand" />`;
    case "video":
      return thumb(
        "video",
        media.src,
        `<video src="${escapeAttr(media.src)}" preload="metadata" muted playsinline></video>`
      );
    case "youtube":
      // mqdefault is the true 16:9 frame; hqdefault is a 4:3 image with
      // black bars baked around widescreen video.
      return thumb(
        "youtube",
        media.id,
        `<img src="https://i.ytimg.com/vi/${media.id}/mqdefault.jpg" alt="" loading="lazy" />`
      );
  }
}

const marked = new Marked({
  gfm: true,
  // Freewriting treats a single newline as a line break, so the preview
  // should too — otherwise consecutive lines silently merge.
  breaks: true,
  renderer: {
    // Raw HTML typed into an entry shows as literal text; the preview never
    // injects it into the DOM.
    html({ text }) {
      return escapeHtml(text);
    },
    code({ text, lang }) {
      const language = lang?.split(/\s/)[0];
      const known = language && hljs.getLanguage(language) ? language : null;
      const body = known
        ? hljs.highlight(text, { language: known }).value
        : escapeHtml(text);
      return `<pre><code class="hljs${known ? ` language-${known}` : ""}">${body}</code></pre>\n`;
    },
    // A pasted bare URL (text === href) to an image, video file, or YouTube
    // page embeds the media itself; a deliberately labeled link stays a link.
    link({ href, text }) {
      if (text !== href) return false;
      const media = mediaFor(href);
      return media ? mediaHtml(media) : false;
    },
    // ![](movie.mp4) — image syntax pointing at a video renders a player.
    image({ href }) {
      const media = mediaFor(href);
      return media && media.tag !== "image" ? mediaHtml(media) : false;
    },
  },
});

type Segment =
  | { kind: "md"; text: string }
  | { kind: "json"; value: unknown };

// Index of the close bracket matching the open bracket at `start`, string-
// and escape-aware, or -1 when the brackets never balance out.
function matchBracket(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

// A candidate only counts as pasted JSON when it parses AND is a non-empty
// object/array — bare "{}" in prose isn't worth a tree.
function parseJson(slice: string): unknown {
  try {
    const value: unknown = JSON.parse(slice);
    const nonEmpty = Array.isArray(value)
      ? value.length > 0
      : value !== null && typeof value === "object" && Object.keys(value).length > 0;
    return nonEmpty ? value : undefined;
  } catch {
    return undefined;
  }
}

// In running prose, "[3]" is far more likely a citation (or "array[3]" an
// index) than pasted JSON — only arrays with real structure count there.
function plausibleInProse(value: unknown): boolean {
  if (!Array.isArray(value)) return true;
  return value.length > 1 || typeof value[0] === "object" || typeof value[0] === "string";
}

// Splits prose around any embedded parsable JSON (inline code spans are left
// alone — backticks mean "show as code").
function proseSegments(text: string): Segment[] {
  const codeSpans: [number, number][] = [];
  for (const m of text.matchAll(/`[^`\n]*`/g)) {
    codeSpans.push([m.index, m.index + m[0].length]);
  }
  const inCodeSpan = (i: number) => codeSpans.some(([a, b]) => i >= a && i < b);

  const out: Segment[] = [];
  let pos = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const boundary = i === 0 || /[\s([{:,>=-]/.test(text[i - 1]);
    if ((ch === "{" || ch === "[") && boundary && !inCodeSpan(i)) {
      const end = matchBracket(text, i);
      if (end !== -1) {
        const value = parseJson(text.slice(i, end + 1));
        if (value !== undefined && plausibleInProse(value)) {
          if (text.slice(pos, i).trim()) {
            out.push({ kind: "md", text: text.slice(pos, i) });
          }
          out.push({ kind: "json", value });
          pos = i = end + 1;
          continue;
        }
      }
    }
    i++;
  }
  if (text.slice(pos).trim()) out.push({ kind: "md", text: text.slice(pos) });
  return out;
}

// A ```json fence (or a bare ``` fence) whose body parses becomes a tree;
// any other fence stays markdown and gets highlighted by the code renderer.
function fenceSegment(fence: string): Segment {
  const lines = fence.split("\n");
  const info = lines[0].slice(3).trim().toLowerCase();
  const closed = lines.length > 1 && /^(```|~~~)\s*$/.test(lines[lines.length - 1]);
  const body = lines.slice(1, closed ? -1 : undefined).join("\n");
  if (info === "" || info === "json") {
    const value = parseJson(body.trim());
    if (value !== undefined) return { kind: "json", value };
  }
  return { kind: "md", text: fence };
}

function segment(content: string): Segment[] {
  return content
    .split(/(```[\s\S]*?(?:\n```|$)|~~~[\s\S]*?(?:\n~~~|$))/)
    .flatMap((part, i) => {
      if (!part.trim()) return [];
      return i % 2 === 1 ? [fenceSegment(part)] : proseSegments(part);
    });
}

export function MarkdownPreview({
  content,
  fontFamily,
  fontSize,
  className = "mx-auto max-w-[650px] space-y-5 px-6 pt-14 pb-28",
}: {
  content: string;
  fontFamily: string;
  fontSize: number;
  // The writer's side-by-side pane owns its own padding; a shared entry sits
  // under its meta line and needs a different one.
  className?: string;
}) {
  const segments = useMemo(() => segment(content), [content]);
  const [zoomed, setZoomed] = useState<LightboxMedia | null>(null);

  // The rendered markdown is injected HTML, so media clicks are caught by
  // delegation rather than per-element handlers.
  const openFrom = useCallback((target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    const media = target.closest<HTMLElement>("[data-media]");
    if (media?.dataset.media && media.dataset.src) {
      setZoomed({
        kind: media.dataset.media as LightboxMedia["kind"],
        src: media.dataset.src,
      });
      return true;
    }
    const image = target.closest("img");
    if (image) {
      setZoomed({ kind: "image", src: image.src });
      return true;
    }
    return false;
  }, []);

  return (
    <>
      <div
        onClick={(e) => {
          if (openFrom(e.target)) e.preventDefault();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          if (openFrom(e.target)) e.preventDefault();
        }}
        className={className}
      >
        {segments.length === 0 && (
          <p
            className="text-muted-foreground/50"
            style={{ fontFamily, fontSize: `${fontSize}px`, lineHeight: 1.7 }}
          >
            Preview
          </p>
        )}
        {segments.map((seg, i) =>
          seg.kind === "md" ? (
            <div
              key={i}
              className="reader preview break-words"
              style={{ fontFamily, fontSize: `${fontSize}px`, lineHeight: 1.7 }}
              dangerouslySetInnerHTML={{
                __html: marked.parse(seg.text, { async: false }),
              }}
            />
          ) : (
            <JsonTree key={i} value={seg.value} />
          )
        )}
      </div>
      {zoomed && (
        <Lightbox media={zoomed} onClose={() => setZoomed(null)} />
      )}
    </>
  );
}
