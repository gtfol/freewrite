// Text-quote anchoring for reader highlights, the way Medium does it: a
// highlight stores the exact quoted text plus a little surrounding context,
// and is re-anchored against the rendered article every time it's shown.
// Anchors survive re-renders and trims that keep the passage; a quote whose
// text is gone simply stops rendering until the text returns (e.g. Restore
// original). Matching runs over whitespace-collapsed text so HTML source
// formatting never breaks an anchor.

import type { Highlight } from "@/lib/types";

export interface QuoteAnchor {
  text: string;
  prefix: string;
  suffix: string;
}

const CONTEXT_CHARS = 32;
// Server-side sync validation caps quotes at 4000; staying well under it
// keeps a huge accidental select-all from wedging the record.
export const MAX_QUOTE_CHARS = 2000;
const MAX_CANDIDATES = 50;

// Subtrees that never take part in anchoring: KaTeX rewrites .math carriers
// after mount, and note chips are injected UI with no article text.
const OPAQUE = ".math, [data-hl-chip]";

interface IndexedNode {
  node: Text;
  start: number;
}

interface TextIndex {
  nodes: IndexedNode[];
  raw: string;
  norm: string;
  // norm position -> raw position of the char that produced it.
  normToRaw: number[];
  // raw position -> norm position where that char lands (or would land).
  rawToNorm: number[];
}

export function buildTextIndex(root: HTMLElement): TextIndex {
  const nodes: IndexedNode[] = [];
  let raw = "";

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node as Text).parentElement?.closest(OPAQUE)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: raw.length });
    raw += (n as Text).data;
  }

  let norm = "";
  const normToRaw: number[] = [];
  const rawToNorm: number[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    rawToNorm[i] = norm.length;
    if (/\s/.test(raw[i])) {
      if (norm.length === 0 || norm.endsWith(" ")) continue;
      norm += " ";
    } else {
      norm += raw[i];
    }
    normToRaw.push(i);
  }

  return { nodes, raw, norm, normToRaw, rawToNorm };
}

// Resolves a range boundary to an offset in the index's raw text. Element
// containers (triple-click, select-all) snap to the nearest indexed text on
// the chosen side.
function rawPoint(
  index: TextIndex,
  container: Node,
  offset: number,
  side: "start" | "end"
): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const entry = index.nodes.find((n) => n.node === container);
    if (!entry) return null;
    return entry.start + Math.min(offset, entry.node.data.length);
  }

  const probe = document.createRange();
  try {
    probe.setStart(container, offset);
  } catch {
    return null;
  }
  probe.collapse(true);

  if (side === "start") {
    for (const { node, start } of index.nodes) {
      if (probe.comparePoint(node, node.data.length) > 0) return start;
    }
    return null;
  }
  let result: number | null = null;
  for (const { node, start } of index.nodes) {
    if (probe.comparePoint(node, 0) < 0) result = start + node.data.length;
    else break;
  }
  return result;
}

export function anchorFromRange(
  root: HTMLElement,
  range: Range
): QuoteAnchor | null {
  if (!root.contains(range.commonAncestorContainer)) return null;
  const index = buildTextIndex(root);

  const rawStart = rawPoint(index, range.startContainer, range.startOffset, "start");
  const rawEnd = rawPoint(index, range.endContainer, range.endOffset, "end");
  if (rawStart === null || rawEnd === null || rawEnd <= rawStart) return null;

  const { norm, rawToNorm } = index;
  let ns = rawStart >= index.raw.length ? norm.length : rawToNorm[rawStart];
  let ne = rawEnd >= index.raw.length ? norm.length : rawToNorm[rawEnd];
  while (ns < ne && norm[ns] === " ") ns++;
  while (ne > ns && norm[ne - 1] === " ") ne--;

  const text = norm.slice(ns, ne);
  if (!text || text.length > MAX_QUOTE_CHARS) return null;

  return {
    text,
    prefix: norm.slice(Math.max(0, ns - CONTEXT_CHARS), ns),
    suffix: norm.slice(ne, ne + CONTEXT_CHARS),
  };
}

// Where several occurrences of the quote exist, the one whose surroundings
// agree most with the stored context wins.
function findAnchor(
  index: TextIndex,
  anchor: QuoteAnchor
): { start: number; end: number } | null {
  const { norm } = index;
  const candidates: number[] = [];
  for (
    let at = norm.indexOf(anchor.text);
    at !== -1 && candidates.length < MAX_CANDIDATES;
    at = norm.indexOf(anchor.text, at + 1)
  ) {
    candidates.push(at);
  }
  if (candidates.length === 0) return null;

  const score = (at: number) => {
    const before = norm.slice(Math.max(0, at - anchor.prefix.length), at);
    const after = norm.slice(
      at + anchor.text.length,
      at + anchor.text.length + anchor.suffix.length
    );
    let s = 0;
    while (
      s < anchor.prefix.length &&
      s < before.length &&
      anchor.prefix[anchor.prefix.length - 1 - s] === before[before.length - 1 - s]
    ) {
      s++;
    }
    let t = 0;
    while (
      t < anchor.suffix.length &&
      t < after.length &&
      anchor.suffix[t] === after[t]
    ) {
      t++;
    }
    return s + t;
  };

  let best = candidates[0];
  let bestScore = -1;
  for (const at of candidates) {
    const s = score(at);
    if (s > bestScore) {
      best = at;
      bestScore = s;
    }
  }

  return {
    start: index.normToRaw[best],
    end: index.normToRaw[best + anchor.text.length - 1] + 1,
  };
}

// lucide message-circle, inlined — the chip lives in injected DOM, not JSX.
const CHIP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';

function paint(index: TextIndex, hl: Highlight, start: number, end: number) {
  const segments: { node: Text; s: number; e: number }[] = [];
  for (const { node, start: at } of index.nodes) {
    const s = Math.max(0, start - at);
    const e = Math.min(node.data.length, end - at);
    if (s < e) segments.push({ node, s, e });
  }

  // Reverse document order: wrapping splits the touched text node, which
  // would invalidate the cached offsets of anything after it.
  for (let i = segments.length - 1; i >= 0; i--) {
    const { node, s, e } = segments[i];
    if (segments.length > 1 && !node.data.slice(s, e).trim()) continue;
    const range = document.createRange();
    range.setStart(node, s);
    range.setEnd(node, e);
    const mark = document.createElement("mark");
    mark.dataset.hl = hl.id;
    range.surroundContents(mark);

    if (hl.note && i === segments.length - 1) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.dataset.hlChip = hl.id;
      chip.setAttribute("aria-label", "View comment");
      chip.innerHTML = CHIP_SVG;
      mark.after(chip);
    }
  }
}

export function clearHighlights(root: HTMLElement) {
  for (const chip of root.querySelectorAll("[data-hl-chip]")) chip.remove();
  for (const mark of root.querySelectorAll("mark[data-hl]")) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
  }
  root.normalize();
}

// Painting splits text nodes, so each highlight anchors against a fresh
// index. Articles and highlight counts are small enough that the re-scans
// don't matter.
export function applyHighlights(root: HTMLElement, highlights: Highlight[]) {
  clearHighlights(root);
  for (const hl of highlights) {
    const index = buildTextIndex(root);
    const found = findAnchor(index, hl);
    if (found) paint(index, hl, found.start, found.end);
  }
}
