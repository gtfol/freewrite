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
  blankSketch,
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
