"use client";

import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { JsonTree } from "@/components/json-tree";
import { Lightbox, type LightboxMedia } from "@/components/lightbox";
import { BOARD, sketchIdFrom } from "@/lib/sketch";
import { sketchDataUri, sketchSvg } from "@/lib/sketch-svg";
import { embedUrl, splitLabel, trackIdFrom } from "@/lib/spotify";
import type { Sketch } from "@/lib/types";

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

// A Spotify track link shows as a small card carrying the title and artist the
// link is already labeled with, and loads Spotify's player only once clicked —
// the same bargain as the YouTube poster above. There is no artwork to show
// until then: the entry text holds a title and an artist, and fetching the
// cover would be the third-party request the card exists to avoid.
function spotifyChip(id: string, text: string): string {
  const { title, sub } = splitLabel(text);
  return (
    `<span class="spotify-chip" data-spotify="${escapeAttr(id)}"` +
    ` role="button" tabindex="0" title="Click to play">` +
    `<span class="spotify-glyph" aria-hidden="true"></span>` +
    `<span class="spotify-text">` +
    `<span class="spotify-title">${escapeHtml(title)}</span>` +
    `<span class="spotify-sub">${escapeHtml(sub)}</span>` +
    `</span></span>`
  );
}

// A drawing is an empty frame until the effect below fills it: the strokes live
// on the entry record, not in the markdown, and this renderer only ever sees
// the reference. Sized from the board so the column doesn't reflow once the
// picture arrives.
function sketchFrame(id: string, ratio: number): string {
  return (
    `<span class="sketch-figure" data-sketch="${escapeAttr(id)}"` +
    ` style="aspect-ratio:${ratio}" role="button" tabindex="0"></span>`
  );
}

// The compact player. Once it's in, it stays in.
function spotifyEmbed(id: string): string {
  return (
    `<span class="spotify-embed">` +
    `<iframe src="${escapeAttr(embedUrl(id))}" height="152" loading="lazy"` +
    ` frameborder="0" title="Spotify player"` +
    ` allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"` +
    `></iframe></span>`
  );
}

// Tracks whose player has been asked for. Module-level, so it outlives the
// preview being toggled off and back on — clicking play is a decision about
// the song, not about the pane. Deliberately not persisted: on a fresh visit
// every song is a card again, which is the whole point of the card.
const played = new Set<string>();

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
    //
    // Spotify tracks are the exception on purpose: the / command writes a
    // labeled link precisely so the raw text stays readable while you write,
    // so a label can't be what disqualifies it from embedding.
    link({ href, text }) {
      const sketch = sketchIdFrom(href);
      if (sketch) return sketchFrame(sketch, BOARD.w / BOARD.h);
      const track = trackIdFrom(href);
      if (track) return spotifyChip(track, text === href ? "" : text);
      if (text !== href) return false;
      const media = mediaFor(href);
      return media ? mediaHtml(media) : false;
    },
    // ![](movie.mp4) — image syntax pointing at a video renders a player, and
    // ![sketch](sketch:a3f1) — what the / command writes — renders a drawing.
    image({ href }) {
      const sketch = sketchIdFrom(href);
      if (sketch) return sketchFrame(sketch, BOARD.w / BOARD.h);
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
  sketches,
  onEditSketch,
  className = "mx-auto max-w-[650px] space-y-5 px-6 pt-14 pb-28",
}: {
  content: string;
  fontFamily: string;
  fontSize: number;
  // The drawings the content references. A reader on a shared page gets them
  // too, which is why they arrive as a prop rather than off the store.
  sketches?: Sketch[];
  // Set in the writer, where clicking a drawing reopens the board. A shared
  // page leaves it out and clicking zooms instead — there is nothing to edit.
  onEditSketch?: (id: string) => void;
  // The writer's side-by-side pane owns its own padding; a shared entry sits
  // under its meta line and needs a different one.
  className?: string;
}) {
  const segments = useMemo(() => segment(content), [content]);
  const [zoomed, setZoomed] = useState<LightboxMedia | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // Serializing is the expensive part, so it happens once per change to the
  // drawings rather than once per keystroke in the side-by-side pane.
  const svgById = useMemo(() => {
    const map = new Map<string, { svg: string; ratio: number }>();
    for (const s of sketches ?? []) {
      map.set(s.id, { svg: sketchSvg(s), ratio: s.w / s.h });
    }
    return map;
  }, [sketches]);

  const filledFrom = useRef<typeof svgById | null>(null);

  // Editing the entry re-injects the markdown and takes the drawings with it,
  // so the frames are refilled after every render — the same arrangement the
  // player swap below uses. Skipped when neither the nodes nor the drawings are
  // new, which is most renders.
  useEffect(() => {
    const nodes = root.current?.querySelectorAll<HTMLElement>("[data-sketch]");
    for (const node of nodes ?? []) {
      if (filledFrom.current === svgById && node.firstElementChild) continue;
      const drawing = svgById.get(node.dataset.sketch ?? "");
      // The strokes are numbers, an enum and hex colours — nothing free-form
      // reaches this markup, which is what makes serialized SVG safe to inject.
      node.innerHTML = drawing?.svg ?? "";
      if (drawing) node.style.aspectRatio = String(drawing.ratio);
      // A reference whose drawing is missing says so rather than sitting as a
      // blank gap: it means the strokes haven't synced down yet, or won't.
      node.classList.toggle("sketch-missing", !drawing);
    }
    filledFrom.current = svgById;
  });

  // Editing the entry re-injects the markdown and takes any open player with
  // it, so the swap is re-applied after every render. What a player can't
  // survive is the writing beside it changing: that rebuilds the frame, and a
  // rebuilt frame starts over. True while typing in the side-by-side pane;
  // not an issue in the full-width preview or on a shared page, where the
  // text is standing still.
  useEffect(() => {
    if (played.size === 0) return;
    const nodes = root.current?.querySelectorAll<HTMLElement>("[data-spotify]");
    for (const node of nodes ?? []) {
      const id = node.dataset.spotify;
      if (id && played.has(id)) node.outerHTML = spotifyEmbed(id);
    }
  });

  const playFrom = useCallback((target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    const chip = target.closest<HTMLElement>("[data-spotify]");
    const id = chip?.dataset.spotify;
    if (!chip || !id) return false;
    played.add(id);
    chip.outerHTML = spotifyEmbed(id);
    return true;
  }, []);

  // Clicking a drawing reopens the board in the writer. On a shared page there
  // is nothing to reopen, so it zooms like any other picture.
  const drawFrom = useCallback(
    (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      const id = target.closest<HTMLElement>("[data-sketch]")?.dataset.sketch;
      const drawing = sketches?.find((s) => s.id === id);
      if (!id || !drawing) return false;
      if (onEditSketch) onEditSketch(id);
      else setZoomed({ kind: "image", src: sketchDataUri(drawing) });
      return true;
    },
    [sketches, onEditSketch]
  );

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
        ref={root}
        onClick={(e) => {
          if (drawFrom(e.target) || playFrom(e.target) || openFrom(e.target)) {
            e.preventDefault();
          }
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          if (drawFrom(e.target) || playFrom(e.target) || openFrom(e.target)) {
            e.preventDefault();
          }
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
