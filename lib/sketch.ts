// The whiteboard: everything about a sketch that is pure data. No DOM, no
// React, no drawesome runtime — the sync route, the share route, the preview
// renderer and the tests all read from here.
//
// A sketch lives on the entry record rather than in its text, and the text
// carries a reference to it: ![sketch](sketch:a3f1). Drawesome samples a point
// roughly every 1.1px and stores it unrounded, so a real drawing is tens of
// kilobytes of coordinates — five orders of magnitude past the Spotify link,
// and not something to leave sitting in the middle of a paragraph you are
// still writing. The reference is what gives the drawing its place in the
// prose; the strokes ride along beside it.

import type { Stroke } from "drawesome";

import type { Sketch } from "@/lib/types";

// One board size for every sketch, letterboxed into whatever room the screen
// has. Fixed rather than fitted to the viewport because a stroke means nothing
// without the board it was drawn on, and a drawing made on a phone should be
// the same drawing on a laptop.
export const BOARD = { w: 1600, h: 1000 };

// The paper a drawing is made on, kept with it rather than read off the app's
// theme at render time. Drawesome picks its starting ink from the theme it is
// given, so paper and ink have to be decided together or you get near-white
// ink on a white sheet: invisible while you draw, and invisible again as a
// figure. Storing the paper means a drawing carries both, and looks the same
// wherever it is later rendered — the preview, a share link, the downloaded
// file — instead of changing under whoever is reading it.
//
// PAPER_DARK is the app's own dark background, so a drawing made in dark mode
// reads as ink on the page rather than a panel sitting on it.
export const PAPER = "#ffffff";
export const PAPER_DARK = "#131315";

export function paperFor(dark: boolean): string {
  return dark ? PAPER_DARK : PAPER;
}

/**
 * Whether a sheet is dark enough to want light ink on it. Relative luminance
 * rather than a list of known papers, so a drawing made on any paper — now, or
 * on one chosen by hand later — still gets a pen that shows up on it.
 */
export function isDarkPaper(bg: string): boolean {
  const hex = bg.replace("#", "");
  const full =
    hex.length === 3
      ? [...hex].map((c) => c + c).join("")
      : hex.slice(0, 6).padEnd(6, "0");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

// Ceilings, shared by the writer and the two routes that accept sketches from
// a client. Generous enough that nobody draws into them by hand.
export const MAX_SKETCHES = 24;
export const MAX_STROKES = 4_000;
export const MAX_POINTS = 200_000;
const MAX_BOARD = 8_192;

const ID = /^[a-z0-9]{4,12}$/;
// Drawesome's swatches and its hex field are both hex, and keeping it that way
// means nothing free-form ever reaches the SVG the preview injects.
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
// Drawesome's own default ink, and the fallback for a colour that isn't hex.
const DEFAULT_INK = "#111111";

const PENS: ReadonlySet<string> = new Set([
  "pencil",
  "pen",
  "fineliner",
  "marker",
  "highlighter",
  "brush",
  "fountain",
]);

export function newSketchId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

export function blankSketch(id = newSketchId(), bg = PAPER): Sketch {
  return { id, w: BOARD.w, h: BOARD.h, bg, strokes: [] };
}

export function isBlank(sketch: Sketch): boolean {
  return sketch.strokes.length === 0;
}

// What the / command types for you. Image syntax rather than a link so that a
// markdown reader that knows nothing about sketches still shows it as a figure
// slot rather than as clickable text.
export function sketchRef(id: string): string {
  return `![sketch](sketch:${id})`;
}

export function sketchIdFrom(href: string): string | null {
  const id = href.startsWith("sketch:") ? href.slice(7) : null;
  return id && ID.test(id) ? id : null;
}

// Both syntaxes count as a reference: the command writes the image form, but a
// writer who turns it into a link shouldn't lose the drawing for it.
const REF = /!?\[[^\]\n]*\]\(sketch:([a-z0-9]{4,12})\)/g;

export function referencedIds(content: string): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(REF)) out.add(m[1]);
  return out;
}

// The sketch a "/" at `index` is being typed against: the one whose reference
// ends right before it. Typing the command moves the caret off the reference,
// so this looks behind the "/" rather than at the caret — and the menu only
// opens where a word could start, so there is always whitespace to skip.
const REF_BEFORE = /!?\[[^\]\n]*\]\(sketch:([a-z0-9]{4,12})\)[^\S\n]*\n?[^\S\n]*$/;

export function sketchBefore(value: string, index: number): string | null {
  const m = REF_BEFORE.exec(value.slice(0, index));
  return m ? m[1] : null;
}

export function putSketch(
  sketches: Sketch[] | undefined,
  sketch: Sketch
): Sketch[] {
  const list = sketches ?? [];
  return list.some((s) => s.id === sketch.id)
    ? list.map((s) => (s.id === sketch.id ? sketch : s))
    : [...list, sketch];
}

/**
 * Picks up drawings a text points at that the entry doesn't carry, from
 * wherever else they're kept. Copying a reference into another entry copies the
 * drawing with it, which is what makes paste do what paste looks like it does.
 *
 * The copy belongs to the entry it lands in, so drawing on it later doesn't
 * reach back into the entry it came from. Nothing here mutates a sketch — an
 * edit replaces the whole record — so the two entries can share the object
 * until one of them is drawn on.
 *
 * Returns `own` itself when there is nothing to pick up, so a keystroke that
 * changes no drawings can't dirty the record.
 */
export function adoptSketches(
  content: string,
  own: Sketch[] | undefined,
  elsewhere: Iterable<Sketch>
): Sketch[] | undefined {
  // Almost every keystroke lands here, and almost none of them are a paste.
  if (!content.includes("sketch:")) return own;

  const missing = referencedIds(content);
  for (const s of own ?? []) missing.delete(s.id);
  if (missing.size === 0) return own;

  // Never past the ceiling: a record the validator rejects is one that stops
  // syncing without saying so.
  let room = MAX_SKETCHES - (own?.length ?? 0);
  if (room <= 0) return own;

  const found: Sketch[] = [];
  for (const s of elsewhere) {
    if (!missing.delete(s.id)) continue;
    found.push(s);
    if (--room === 0 || missing.size === 0) break;
  }
  return found.length ? [...(own ?? []), ...found] : own;
}

// Drops drawings the text no longer points at. Called when the writer leaves
// the entry rather than on every keystroke: cutting a reference to paste it
// somewhere else is a normal edit, and it shouldn't take the drawing with it.
export function pruneSketches(
  content: string,
  sketches: Sketch[] | undefined
): Sketch[] | undefined {
  if (!sketches?.length) return undefined;
  const live = referencedIds(content);
  const kept = sketches.filter((s) => live.has(s.id));
  if (kept.length === sketches.length) return sketches;
  return kept.length ? kept : undefined;
}

// How much white to leave around the ink when a drawing is shown as a figure,
// and the smallest window onto the board that figure is allowed to be — so a
// single dot doesn't fill the column at forty times its size.
const CROP_PAD = 32;
// Small enough that a real drawing keeps its own proportions — raise it and a
// modest sketch gets padded out into a square — and only wide enough to stop a
// lone dot being blown up to fill the column.
const CROP_MIN = 160;

// Grows [lo, hi] by the padding, up to the minimum, and slides it back onto
// the board rather than letting it hang off the edge.
function window1d(lo: number, hi: number, limit: number): [number, number] {
  let a = lo - CROP_PAD;
  let b = hi + CROP_PAD;
  const short = CROP_MIN - (b - a);
  if (short > 0) {
    a -= short / 2;
    b += short / 2;
  }
  if (a < 0) {
    b -= a;
    a = 0;
  }
  if (b > limit) {
    a -= b - limit;
    b = limit;
  }
  return [Math.max(0, Math.round(a)), Math.min(limit, Math.round(b))];
}

/**
 * The part of the board worth showing: the box the ink occupies, padded. A
 * figure in the prose should be as big as what was drawn, not as big as the
 * board it was drawn on — most of a 1600×1000 sheet is usually empty.
 *
 * Only ever used for display. The strokes keep their board coordinates, so
 * reopening the drawing gives back the whole sheet with the marks where they
 * were left.
 */
export function inkBounds(sketch: Sketch): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of sketch.strokes) {
    // An eraser pass takes ink away, so it can't be what makes a drawing big.
    if (s.erase) continue;
    const r = s.size / 2;
    for (const [x, y] of s.points) {
      if (x - r < minX) minX = x - r;
      if (y - r < minY) minY = y - r;
      if (x + r > maxX) maxX = x + r;
      if (y + r > maxY) maxY = y + r;
    }
  }
  // Nothing drawn, or nothing but erasing: show the sheet.
  if (minX === Infinity) return { x: 0, y: 0, w: sketch.w, h: sketch.h };

  const [x0, x1] = window1d(minX, maxX, sketch.w);
  const [y0, y1] = window1d(minY, maxY, sketch.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

// Coordinates come off the pointer unrounded — 123.45833333333333 for a point
// sampled no finer than 1.1px. Rounding at the moment a stroke is stored keeps
// the record a third of the size and, more importantly, keeps it stable: the
// hash is computed over these numbers, and they have to survive a round trip
// through postgres and back to hash the same on another device.
export function quantize(strokes: Stroke[]): Stroke[] {
  return strokes.map((s) => ({
    ...s,
    // Every colour drawesome can produce is hex today — its swatches, its hex
    // field and the eyedropper's sRGBHex all are. Pinning that here anyway,
    // because the alternative failure is silent: a colour the record validator
    // rejects would make the whole entry stop syncing without saying so.
    color: COLOR.test(s.color) ? s.color : DEFAULT_INK,
    size: round(s.size, 2),
    opacity: round(s.opacity, 2),
    points: s.points.map(
      ([x, y, p]) =>
        [round(x, 1), round(y, 1), round(p, 2)] as Stroke["points"][number]
    ),
    ...(s.shape && {
      shape: {
        ...s.shape,
        ...(s.shape.nibAngle !== undefined && {
          nibAngle: round(s.shape.nibAngle, 2),
        }),
        ...(s.shape.taper !== undefined && { taper: round(s.shape.taper, 2) }),
      },
    }),
  }));
}

// Hash input, positional on purpose. Postgres jsonb does not preserve key
// order, so hashing the objects themselves would let a record come back from
// sync hashing differently than it went in — and a record whose hash keeps
// changing under it never stops pushing. Arrays keep their order, so this
// survives the trip. (The same reason articleHash flattens highlights.)
export function sketchFields(s: Sketch): unknown[] {
  return [
    s.id,
    s.w,
    s.h,
    s.bg,
    s.strokes.map((k) => [
      k.id,
      k.pen,
      k.color,
      k.size,
      k.opacity,
      k.points,
      k.erase ? 1 : 0,
      k.shape
        ? [
            k.shape.nibAngle ?? null,
            k.shape.taper ?? null,
            k.shape.simulatePressure ? 1 : 0,
          ]
        : null,
    ]),
  ];
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const board = (v: unknown): v is number =>
  finite(v) && v > 0 && v <= MAX_BOARD;

function parseStroke(v: unknown, budget: { points: number }): Stroke | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (
    !finite(s.id) ||
    typeof s.pen !== "string" ||
    !PENS.has(s.pen) ||
    typeof s.color !== "string" ||
    !COLOR.test(s.color) ||
    !finite(s.size) ||
    !finite(s.opacity) ||
    !Array.isArray(s.points)
  ) {
    return null;
  }
  budget.points -= s.points.length;
  if (budget.points < 0) return null;

  const points: Stroke["points"] = [];
  for (const p of s.points) {
    if (!Array.isArray(p) || p.length !== 3 || !p.every(finite)) return null;
    points.push([p[0], p[1], p[2]]);
  }

  let shape: Stroke["shape"];
  if (s.shape !== undefined && s.shape !== null) {
    if (typeof s.shape !== "object") return null;
    const sh = s.shape as Record<string, unknown>;
    for (const key of ["nibAngle", "taper"] as const) {
      if (sh[key] !== undefined && !finite(sh[key])) return null;
    }
    shape = {
      ...(finite(sh.nibAngle) && { nibAngle: sh.nibAngle }),
      ...(finite(sh.taper) && { taper: sh.taper }),
      ...(sh.simulatePressure !== undefined && {
        simulatePressure: Boolean(sh.simulatePressure),
      }),
    };
  }

  return {
    id: s.id,
    pen: s.pen as Stroke["pen"],
    color: s.color,
    size: s.size,
    opacity: s.opacity,
    points,
    ...(shape && { shape }),
    ...(s.erase !== undefined && { erase: Boolean(s.erase) }),
  };
}

// Absent/empty → null; malformed → false. Malformed sketches must reject the
// whole change rather than be dropped: the client's hash covers them, and
// storing that hash over different data would wedge reconciliation.
export function parseSketches(v: unknown): Sketch[] | null | false {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > MAX_SKETCHES) return false;
  const budget = { points: MAX_POINTS };
  const out: Sketch[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "object" || item === null) return false;
    const s = item as Record<string, unknown>;
    if (
      typeof s.id !== "string" ||
      !ID.test(s.id) ||
      seen.has(s.id) ||
      !board(s.w) ||
      !board(s.h) ||
      typeof s.bg !== "string" ||
      !COLOR.test(s.bg) ||
      !Array.isArray(s.strokes) ||
      s.strokes.length > MAX_STROKES
    ) {
      return false;
    }
    seen.add(s.id);
    const strokes: Stroke[] = [];
    for (const raw of s.strokes) {
      const stroke = parseStroke(raw, budget);
      if (!stroke) return false;
      strokes.push(stroke);
    }
    out.push({ id: s.id, w: s.w, h: s.h, bg: s.bg, strokes });
  }
  return out.length ? out : null;
}
