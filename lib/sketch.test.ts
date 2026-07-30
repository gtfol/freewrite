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
  adoptSketches,
  blankSketch,
  inkBounds,
  isDarkPaper,
  paperFor,
  parseSketches,
  pruneSketches,
  putSketch,
  quantize,
  referencedIds,
  sketchBefore,
  sketchFields,
  sketchIdFrom,
  sketchRef,
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

test("putSketch replaces by id rather than appending a second copy", () => {
  const first = sketch({ id: "aaaa11" });
  const second = sketch({ id: "bbbb22" });
  assert.deepEqual(putSketch(undefined, first), [first]);

  const both = putSketch([first], second);
  assert.deepEqual(both.map((s) => s.id), ["aaaa11", "bbbb22"]);

  const edited = { ...first, strokes: [stroke(), stroke({ id: 2 })] };
  const after = putSketch(both, edited);
  assert.equal(after.length, 2);
  assert.equal(after[0].strokes.length, 2);
});

test("adoptSketches copies a pasted drawing into the entry it landed in", () => {
  const source = sketch({ id: "aaaa11" });
  const pasted = `look at this ${sketchRef("aaaa11")}`;

  const adopted = adoptSketches(pasted, undefined, [source]);
  assert.deepEqual(adopted?.map((s) => s.id), ["aaaa11"]);
  // The entry keeps what it already had, and gains the pasted one.
  const both = adoptSketches(pasted, [sketch({ id: "bbbb22" })], [source]);
  assert.deepEqual(both?.map((s) => s.id), ["bbbb22", "aaaa11"]);
});

test("adoptSketches leaves the list alone when there is nothing to pick up", () => {
  const own = [sketch({ id: "aaaa11" })];
  const elsewhere = [sketch({ id: "bbbb22" })];

  // Identity, not just equality: a keystroke that changes no drawings must not
  // dirty the record and push it again.
  assert.equal(adoptSketches("plain prose", own, elsewhere), own);
  assert.equal(adoptSketches(sketchRef("aaaa11"), own, elsewhere), own);
  // Referenced but nowhere to be found — a drawing that hasn't synced down, or
  // whose entry is gone. The figure says so rather than being invented.
  assert.equal(adoptSketches(sketchRef("cccc33"), own, elsewhere), own);
  assert.equal(adoptSketches("plain prose", undefined, elsewhere), undefined);
});

test("adoptSketches stops reading once it has what the text asked for", () => {
  let read = 0;
  function* elsewhere() {
    for (const id of ["aaaa11", "bbbb22", "cccc33"]) {
      read++;
      yield sketch({ id });
    }
  }
  adoptSketches(sketchRef("aaaa11"), undefined, elsewhere());
  assert.equal(read, 1, "walked past the drawing it was looking for");
});

test("adoptSketches won't push an entry past the sketch ceiling", () => {
  // Over the ceiling the record fails validation, and an entry that fails
  // validation stops syncing without saying so.
  const own = Array.from({ length: MAX_SKETCHES }, (_, i) =>
    sketch({ id: `own${String(i).padStart(3, "0")}` })
  );
  const content = `${sketchRef("aaaa11")} ${sketchRef("bbbb22")}`;
  assert.equal(
    adoptSketches(content, own, [sketch({ id: "aaaa11" })]),
    own
  );

  const nearly = own.slice(0, MAX_SKETCHES - 1);
  const adopted = adoptSketches(content, nearly, [
    sketch({ id: "aaaa11" }),
    sketch({ id: "bbbb22" }),
  ]);
  assert.equal(adopted?.length, MAX_SKETCHES);
});

test("pruneSketches drops drawings the text no longer points at", () => {
  const kept = sketch({ id: "aaaa11" });
  const orphan = sketch({ id: "bbbb22" });
  const content = `words ${sketchRef("aaaa11")} more words`;

  assert.deepEqual(pruneSketches(content, [kept, orphan]), [kept]);
  // Nothing referenced at all: the field goes away rather than becoming [].
  assert.equal(pruneSketches("just words", [orphan]), undefined);
  // Untouched lists come back identical, so pruning can't dirty a record.
  const all = [kept];
  assert.equal(pruneSketches(content, all), all);
  assert.equal(pruneSketches(content, undefined), undefined);
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
