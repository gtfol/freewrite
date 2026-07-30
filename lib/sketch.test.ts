// The sketch record and the reference that points at it. All pure, and all
// places where being subtly wrong is invisible: a reference that doesn't parse
// silently loses a drawing, an unstable quantizer silently re-pushes an entry
// forever, and a validator that accepts too much silently stores something the
// preview will inject into the DOM.
//
//   npm test

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOARD,
  MAX_SKETCHES,
  PAPER,
  PAPER_DARK,
  blankSketch,
  inkBounds,
  isDarkPaper,
  paperFor,
  parseSketch,
  parseSketches,
  quantize,
  referencedIds,
  sketchBefore,
  sketchFields,
  sketchIdFrom,
  sketchRef,
  sweepSketches,
} from "./sketch.ts";
import type { Sketch } from "./types.ts";

function stroke(overrides: Partial<Sketch["strokes"][number]> = {}) {
  return {
    id: 1,
    pen: "pen" as const,
    color: "#111111",
    size: 6,
    opacity: 1,
    points: [
      [10, 20, 0.5],
      [11, 21, 0.5],
    ] as Sketch["strokes"][number]["points"],
    ...overrides,
  };
}

function sketch(overrides: Partial<Sketch> = {}): Sketch {
  return { ...blankSketch("a3f1x0"), strokes: [stroke()], ...overrides };
}

test("a reference round-trips through the text", () => {
  const ref = sketchRef("a3f1x0");
  assert.equal(ref, "![sketch](sketch:a3f1x0)");
  assert.equal(sketchIdFrom("sketch:a3f1x0"), "a3f1x0");
  assert.deepEqual([...referencedIds(`before ${ref} after`)], ["a3f1x0"]);
});

test("sketchIdFrom rejects anything that isn't a sketch href", () => {
  assert.equal(sketchIdFrom("https://example.com/a.png"), null);
  assert.equal(sketchIdFrom("sketch:"), null);
  // Ids are the alphabet the command writes, so nothing arbitrary can ride in
  // on an href and come back out as a lookup key.
  assert.equal(sketchIdFrom("sketch:../../etc"), null);
  assert.equal(sketchIdFrom("sketch:AAAA"), null);
});

test("referencedIds finds the link form and ignores other media", () => {
  const content = [
    "![sketch](sketch:aaaa11)",
    "[my drawing](sketch:bbbb22)",
    "![photo](https://example.com/a.png)",
    "[a link](https://example.com)",
  ].join("\n");
  assert.deepEqual([...referencedIds(content)].sort(), ["aaaa11", "bbbb22"]);
});

test("sketchBefore finds the drawing a / is being typed against", () => {
  // The command has already been typed, so the caret sits past the reference —
  // which is why this looks behind the "/" and not at the caret.
  const text = `${sketchRef("aaaa11")} /`;
  assert.equal(sketchBefore(text, text.length - 1), "aaaa11");

  const nextLine = `${sketchRef("aaaa11")}\n/`;
  assert.equal(sketchBefore(nextLine, nextLine.length - 1), "aaaa11");
});

test("sketchBefore stops at prose, a blank line, and the start of the entry", () => {
  const prose = `${sketchRef("aaaa11")} and then I wrote /`;
  assert.equal(sketchBefore(prose, prose.length - 1), null);

  // A blank line is a new thought, not a note on the drawing above it.
  const gap = `${sketchRef("aaaa11")}\n\n/`;
  assert.equal(sketchBefore(gap, gap.length - 1), null);

  assert.equal(sketchBefore("/", 0), null);
});

const DAY = 24 * 60 * 60 * 1000;

test("sweepSketches doesn't touch a drawing a text still points at", () => {
  const drawing = sketch({ id: "aaaa11" });
  const sweep = sweepSketches([drawing], [`prose ${sketchRef("aaaa11")} prose`]);
  assert.deepEqual(sweep, { orphaned: [], revived: [], collect: [] });
});

test("sweepSketches notes an unclaimed drawing rather than collecting it", () => {
  // This is the bug the per-entry model had: deleting the reference while
  // rewriting the paragraph around it took the drawing with it, for good.
  const drawing = sketch({ id: "aaaa11" });
  const sweep = sweepSketches([drawing], ["the reference is gone for now"]);
  assert.deepEqual(sweep.collect, []);
  assert.deepEqual(sweep.orphaned.map((s) => s.id), ["aaaa11"]);
});

test("sweepSketches gives a drawing back when its reference returns", () => {
  const orphaned = sketch({ id: "aaaa11", orphanedAt: Date.now() - 5 * DAY });
  const sweep = sweepSketches([orphaned], [sketchRef("aaaa11")]);
  assert.deepEqual(sweep.revived.map((s) => s.id), ["aaaa11"]);
  assert.deepEqual(sweep.collect, []);
});

test("sweepSketches waits out the grace period before collecting", () => {
  const now = Date.now();
  const young = sketch({ id: "aaaa11", orphanedAt: now - 29 * DAY });
  const old = sketch({ id: "bbbb22", orphanedAt: now - 31 * DAY });
  const sweep = sweepSketches([young, old], ["no references here"], now);
  assert.deepEqual(sweep.collect, ["bbbb22"]);
  // Already noted, so it isn't re-stamped — that would restart the clock and
  // the drawing would never be collected at all.
  assert.deepEqual(sweep.orphaned, []);
});

test("sweepSketches reads every text, not just the one being edited", () => {
  // A drawing referenced from any entry is in use, which is what makes it
  // possible to paste one somewhere else and keep both.
  const drawing = sketch({ id: "aaaa11" });
  const sweep = sweepSketches(
    [drawing],
    ["an entry with no drawings", `another one, with ${sketchRef("aaaa11")}`]
  );
  assert.deepEqual(sweep, { orphaned: [], revived: [], collect: [] });
});

test("sweepSketches leaves tombstones alone", () => {
  const gone = sketch({ id: "aaaa11", deletedAt: Date.now() - 40 * DAY });
  const sweep = sweepSketches([gone], ["nothing points at it"]);
  assert.deepEqual(sweep, { orphaned: [], revived: [], collect: [] });
});

test("quantize rounds coordinates and is idempotent", () => {
  const raw = [
    stroke({
      size: 6.000000001,
      opacity: 0.8999999,
      points: [
        [123.45833333333333, 456.72916666666674, 0.5],
        [-0.04, 2.06, 0.33333],
      ] as Sketch["strokes"][number]["points"],
      shape: { nibAngle: 41.000004, taper: 0.5, simulatePressure: true },
    }),
  ];
  const once = quantize(raw);
  assert.deepEqual(once[0].points, [
    [123.5, 456.7, 0.5],
    [-0, 2.1, 0.33],
  ]);
  assert.equal(once[0].size, 6);
  assert.equal(once[0].opacity, 0.9);
  assert.equal(once[0].shape?.nibAngle, 41);
  assert.equal(once[0].shape?.simulatePressure, true);

  // Re-quantizing has to be a no-op: the hash is taken over these numbers, and
  // a value that drifts on every save re-pushes the entry forever.
  assert.deepEqual(quantize(once), once);
  assert.equal(JSON.stringify(quantize(once)), JSON.stringify(once));
});

test("sketchFields is positional, so key order can't change the hash", () => {
  const flat = sketchFields(sketch());
  assert.deepEqual(flat.slice(0, 4), ["a3f1x0", BOARD.w, BOARD.h, PAPER]);
  // Nothing in the hash input is an object: jsonb reorders keys, arrays keep
  // their order, and a record has to hash the same after a round trip.
  const json = JSON.stringify(flat);
  assert.ok(!json.includes("{"), `hash input carries an object: ${json}`);
});

test("paper and pen are decided together, so ink is never lost on the sheet", () => {
  // The bug this guards: drawesome takes its starting ink from the theme it is
  // handed, so a dark-themed board on white paper draws near-white on white.
  assert.equal(paperFor(false), PAPER);
  assert.equal(paperFor(true), PAPER_DARK);
  assert.equal(isDarkPaper(PAPER), false);
  assert.equal(isDarkPaper(PAPER_DARK), true);

  // A new sheet takes the paper it's given; the default stays light.
  assert.equal(blankSketch("aaaa11").bg, PAPER);
  assert.equal(blankSketch("aaaa11", PAPER_DARK).bg, PAPER_DARK);
});

test("isDarkPaper judges by luminance, not by a list", () => {
  assert.equal(isDarkPaper("#000"), true);
  assert.equal(isDarkPaper("#fff"), false);
  assert.equal(isDarkPaper("#222222"), true);
  assert.equal(isDarkPaper("#eeeeee"), false);
  // Yellow is bright despite being saturated; navy is not.
  assert.equal(isDarkPaper("#ffee00"), false);
  assert.equal(isDarkPaper("#001b44"), true);
  // 8-digit hex carries an alpha the paper decision doesn't depend on.
  assert.equal(isDarkPaper("#131315ff"), true);
});

test("inkBounds frames the ink rather than the whole board", () => {
  const box = inkBounds(
    sketch({
      strokes: [
        stroke({
          size: 0,
          points: [
            [500, 300, 0.5],
            [1100, 700, 0.5],
          ] as Sketch["strokes"][number]["points"],
        }),
      ],
    })
  );
  // 32 of padding on each side of a 600×400 mark, and none of the board's
  // 1600×1000 of mostly-empty sheet.
  assert.deepEqual(box, { x: 468, y: 268, w: 664, h: 464 });
});

test("inkBounds keeps a small mark from filling the column", () => {
  const box = inkBounds(
    sketch({
      strokes: [
        stroke({ size: 0, points: [[800, 500, 0.5]] as Sketch["strokes"][number]["points"] }),
      ],
    })
  );
  // A single dot would otherwise be magnified past all sense.
  assert.equal(box.w, 160);
  assert.equal(box.h, 160);
  assert.equal(box.x + box.w / 2, 800);
});

test("inkBounds leaves a real drawing its own proportions", () => {
  // The floor is only for tiny marks: a sketch with any size to it must not be
  // padded out into a square, which is the composition changing under you.
  const box = inkBounds(
    sketch({
      strokes: [
        stroke({
          size: 0,
          points: [
            [700, 400, 0.5],
            [900, 550, 0.5],
          ] as Sketch["strokes"][number]["points"],
        }),
      ],
    })
  );
  assert.deepEqual(box, { x: 668, y: 368, w: 264, h: 214 });
});

test("inkBounds stays on the board when the ink runs to an edge", () => {
  const box = inkBounds(
    sketch({
      strokes: [
        stroke({ size: 0, points: [[0, 0, 0.5], [40, 40, 0.5]] as Sketch["strokes"][number]["points"] }),
      ],
    })
  );
  assert.equal(box.x, 0);
  assert.equal(box.y, 0);
  assert.ok(box.x + box.w <= BOARD.w, "window hangs off the right");
  assert.ok(box.y + box.h <= BOARD.h, "window hangs off the bottom");
});

test("inkBounds counts stroke width, and ignores erasing", () => {
  const wide = inkBounds(
    sketch({
      strokes: [
        stroke({ size: 100, points: [[800, 500, 0.5]] as Sketch["strokes"][number]["points"] }),
      ],
    })
  );
  // A 100-wide nib puts ink 50 either side of the point it was sampled at,
  // which with padding clears the floor on its own.
  assert.equal(wide.w, 164);

  // The same drawing with an eraser pass swept across the far corner: erasing
  // takes ink away, so it can't be what makes the figure big.
  const erased = inkBounds(
    sketch({
      strokes: [
        stroke({ size: 100, points: [[800, 500, 0.5]] as Sketch["strokes"][number]["points"] }),
        stroke({ id: 2, erase: true, size: 40, points: [[20, 20, 0.5]] as Sketch["strokes"][number]["points"] }),
      ],
    })
  );
  assert.deepEqual(erased, wide);
});

test("inkBounds falls back to the sheet when there is nothing drawn", () => {
  assert.deepEqual(inkBounds(sketch({ strokes: [] })), {
    x: 0,
    y: 0,
    w: BOARD.w,
    h: BOARD.h,
  });
});

test("parseSketches accepts a well-formed drawing", () => {
  const parsed = parseSketches([sketch()]);
  assert.ok(parsed);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].strokes[0].points.length, 2);
});

test("parseSketch takes one record, and insists on its stamp", () => {
  // The sync route hands them over one at a time, and updatedAt is what the
  // mid-flight check compares — a record without one can't be tracked.
  const parsed = parseSketch(sketch({ id: "aaaa11" }));
  assert.equal(parsed?.id, "aaaa11");
  assert.equal(parsed?.deletedAt, null);

  const stampless: Record<string, unknown> = { ...sketch() };
  delete stampless.updatedAt;
  assert.equal(parseSketch(stampless), null);
  assert.equal(parseSketch(sketch({ updatedAt: -1 })), null);
  assert.equal(parseSketch(sketch({ deletedAt: "soon" as never })), null);

  // A tombstone: no strokes left, and that's valid.
  const tomb = parseSketch(sketch({ strokes: [], deletedAt: 123 }));
  assert.equal(tomb?.strokes.length, 0);
  assert.equal(tomb?.deletedAt, 123);
});

test("parseSketches treats absent and empty as nothing to store", () => {
  assert.equal(parseSketches(undefined), null);
  assert.equal(parseSketches(null), null);
  assert.equal(parseSketches([]), null);
});

test("parseSketches rejects rather than drops malformed drawings", () => {
  // Dropping one would store a hash the data no longer matches, and sync would
  // never settle. Every one of these has to fail the whole change.
  const bad: [string, unknown][] = [
    ["not an array", {}],
    ["too many sketches", Array.from({ length: MAX_SKETCHES + 1 }, () => sketch())],
    ["duplicate ids", [sketch({ id: "aaaa11" }), sketch({ id: "aaaa11" })]],
    ["bad id", [sketch({ id: "no" })]],
    ["id with punctuation", [sketch({ id: "a-b-c1" })]],
    ["zero board", [sketch({ w: 0 })]],
    ["huge board", [sketch({ h: 99999 })]],
    ["non-hex paper", [sketch({ bg: "url(#x)" })]],
    ["non-hex ink", [sketch({ strokes: [stroke({ color: "red" })] })]],
    ["unknown pen", [sketch({ strokes: [stroke({ pen: "crayon" as never })] })]],
    ["infinite size", [sketch({ strokes: [stroke({ size: Infinity })] })]],
    ["short point", [sketch({ strokes: [stroke({ points: [[1, 2]] as never })] })]],
    ["non-numeric point", [sketch({ strokes: [stroke({ points: [["1", 2, 3]] as never })] })]],
    ["points not an array", [sketch({ strokes: [stroke({ points: 5 as never })] })]],
  ];
  for (const [what, value] of bad) {
    assert.equal(parseSketches(value), false, `accepted ${what}`);
  }
});

test("parseSketches keeps a colour out that the preview would inject", () => {
  // The preview drops the serialized SVG into the DOM, so the one free-form
  // string in a stroke is the one thing worth being strict about.
  const attack = [sketch({ strokes: [stroke({ color: '#fff" onload="x' })] })];
  assert.equal(parseSketches(attack), false);
});

test("parseSketches enforces one shared point budget across sketches", () => {
  const fat = () =>
    sketch({
      id: Math.random().toString(36).slice(2, 8).padEnd(6, "0"),
      strokes: [
        stroke({
          points: Array.from({ length: 60_000 }, () => [1, 2, 0.5]) as Sketch["strokes"][number]["points"],
        }),
      ],
    });
  // Four of these clear the per-sketch ceilings but not the total.
  assert.equal(parseSketches([fat(), fat(), fat(), fat()]), false);
});

test("parseSketches normalizes what it keeps", () => {
  const parsed = parseSketches([
    sketch({ strokes: [{ ...stroke(), erase: 1 as never, extra: "x" } as never] }),
  ]);
  assert.ok(parsed);
  assert.equal(parsed[0].strokes[0].erase, true);
  assert.ok(!("extra" in parsed[0].strokes[0]));
});
