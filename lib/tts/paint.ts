// Painting the spoken word.
//
// Uses the CSS Custom Highlight API, which takes plain Ranges and mutates no
// DOM. That matters here specifically: lib/highlights.ts paints annotations by
// wrapping text in <mark> via surroundContents, and a second DOM-mutating
// highlighter repainting several times a second would corrupt both. Ranges and
// marks coexist because they never touch the same tree.
//
// Where the API is missing, the component falls back to overlay rectangles
// built from the same Ranges — still no mutation.

import type { TextIndex } from "@/lib/highlights";

interface HighlightLike {
  readonly size?: number;
}
type HighlightCtor = new (...ranges: Range[]) => HighlightLike;
type HighlightRegistry = {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): void;
};

export const WORD_HIGHLIGHT = "tts-word";
export const SENTENCE_HIGHLIGHT = "tts-sentence";

function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights ?? null;
}

function highlightCtor(): HighlightCtor | null {
  return (globalThis as { Highlight?: HighlightCtor }).Highlight ?? null;
}

export function highlightApiSupported(): boolean {
  return !!registry() && !!highlightCtor();
}

// Which indexed text node covers a raw offset, and where inside it.
function locate(
  index: TextIndex,
  rawPos: number
): { node: Text; offset: number } | null {
  const { nodes } = index;
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = nodes[mid];
    const length = entry.node.data.length;
    if (rawPos < entry.start) hi = mid - 1;
    else if (rawPos > entry.start + length) lo = mid + 1;
    else return { node: entry.node, offset: rawPos - entry.start };
  }
  return null;
}

// A span in normalized coordinates becomes a live DOM Range. Same coordinate
// space the segmenter, the player and click-to-seek all speak.
export function rangeForSpan(
  index: TextIndex,
  normStart: number,
  normEnd: number
): Range | null {
  if (normEnd <= normStart) return null;
  const { normToRaw } = index;
  if (normStart >= normToRaw.length) return null;

  const rawStart = normToRaw[normStart];
  const rawEnd = normToRaw[Math.min(normEnd, normToRaw.length) - 1] + 1;

  const from = locate(index, rawStart);
  const to = locate(index, rawEnd);
  if (!from || !to) return null;

  try {
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  } catch {
    return null;
  }
}

export function setHighlight(name: string, ranges: Range[]): void {
  const store = registry();
  const Ctor = highlightCtor();
  if (!store || !Ctor) return;
  if (ranges.length === 0) {
    store.delete(name);
    return;
  }
  store.set(name, new Ctor(...ranges));
}

export function clearHighlight(name: string): void {
  registry()?.delete(name);
}

const OVERLAY_ATTR = "data-tts-overlay";

// Fallback painter for browsers without the Highlight API: the same Range,
// drawn as rectangles behind the text. Still no mutation of the article —
// the rects live in their own layer inside the wrapper, which is also why
// this is imperative rather than a React subtree repainting at 60fps.
export function paintOverlay(wrap: HTMLElement, range: Range | null): void {
  const existing = wrap.querySelector<HTMLElement>(`[${OVERLAY_ATTR}]`);
  if (!range) {
    existing?.remove();
    return;
  }

  const host = existing ?? document.createElement("div");
  if (!existing) {
    host.setAttribute(OVERLAY_ATTR, "");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:-1";
    wrap.appendChild(host);
  }

  const origin = wrap.getBoundingClientRect();
  host.replaceChildren(
    ...Array.from(range.getClientRects()).map((rect) => {
      const span = document.createElement("span");
      span.style.cssText = [
        "position:absolute",
        `left:${rect.left - origin.left}px`,
        `top:${rect.top - origin.top}px`,
        `width:${rect.width}px`,
        `height:${rect.height}px`,
        "background:var(--read-word)",
        "border-radius:2px",
      ].join(";");
      return span;
    })
  );
}

export function clearOverlay(wrap: HTMLElement): void {
  wrap.querySelector(`[${OVERLAY_ATTR}]`)?.remove();
}

// The inverse map, for click-to-seek: a point in the document becomes an
// offset in normalized text.
export function normOffsetAtPoint(
  index: TextIndex,
  x: number,
  y: number
): number | null {
  const node = caretNodeAtPoint(x, y);
  if (!node) return null;

  const entry = index.nodes.find((candidate) => candidate.node === node.text);
  if (!entry) return null;

  const raw = entry.start + Math.min(node.offset, node.text.data.length);
  if (raw >= index.rawToNorm.length) return index.norm.length;
  return index.rawToNorm[raw];
}

interface CaretHit {
  text: Text;
  offset: number;
}

// caretPositionFromPoint is the standard; caretRangeFromPoint is the WebKit
// spelling that predates it.
function caretNodeAtPoint(x: number, y: number): CaretHit | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  const position = doc.caretPositionFromPoint?.(x, y);
  if (position && position.offsetNode.nodeType === Node.TEXT_NODE) {
    return { text: position.offsetNode as Text, offset: position.offset };
  }

  const range = doc.caretRangeFromPoint?.(x, y);
  if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
    return { text: range.startContainer as Text, offset: range.startOffset };
  }
  return null;
}
