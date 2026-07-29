import assert from "node:assert/strict";
import test from "node:test";

import { planSpeech, scalesFor, type ChunkRole } from "./prosody.ts";
import type { WordSpan } from "./types.ts";

// The segmenter hands prosody words in document coordinates; these fixtures
// build them the same way so the tests exercise the offset arithmetic rather
// than working around it.
function words(text: string, normStart = 0): WordSpan[] {
  const out: WordSpan[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}']+/gu)) {
    out.push({
      start: normStart + match.index,
      end: normStart + match.index + match[0].length,
    });
  }
  return out;
}

function plan(
  text: string,
  options: { role?: ChunkRole; emphasis?: string; normStart?: number } = {}
) {
  const normStart = options.normStart ?? 0;
  const at = options.emphasis ? text.indexOf(options.emphasis) : -1;
  assert.ok(!options.emphasis || at !== -1, "emphasis must occur in the text");

  return planSpeech({
    text,
    words: words(text, normStart),
    normStart,
    role: options.role ?? "body",
    emphasis:
      at === -1
        ? []
        : [
            {
              start: normStart + at,
              end: normStart + at + (options.emphasis as string).length,
            },
          ],
  });
}

// Every word the plan reports has to name the same word in the spoken line
// that it named in the displayed one — that mapping is what keeps the
// read-along highlight on the word being said.
function spoken(text: string, result: ReturnType<typeof plan>): string[] {
  return result.words.map((word) => result.text.slice(word.start, word.end));
}

test("leaves a well-formed sentence alone", () => {
  const result = plan("It was the only way.");
  assert.equal(result.text, "It was the only way.");
});

test("terminates a clause that stops without one", () => {
  assert.equal(plan("A Heading With No Stop").text, "A Heading With No Stop.");
  assert.equal(plan("Buy milk").text, "Buy milk.");
});

test("leaves existing terminators of every kind alone", () => {
  for (const text of [
    "Was it?",
    "Stop!",
    "Consider the following:",
    "He said “hello.”",
    "It trails off…",
  ]) {
    assert.equal(plan(text).text, text);
  }
});

test("isolates an emphasized phrase with commas", () => {
  const result = plan("It was really the only way.", { emphasis: "really" });
  assert.equal(result.text, "It was, really, the only way.");
});

test("keeps every word addressable after isolating emphasis", () => {
  const result = plan("It was really the only way.", { emphasis: "really" });
  assert.deepEqual(spoken("It was really the only way.", result), [
    "It",
    "was",
    "really",
    "the",
    "only",
    "way",
  ]);
});

test("maps words out of document coordinates into the spoken line", () => {
  const text = "It was really the only way.";
  const result = plan(text, { emphasis: "really", normStart: 5000 });
  assert.deepEqual(spoken(text, result), [
    "It",
    "was",
    "really",
    "the",
    "only",
    "way",
  ]);
});

test("declines emphasis with no sentence around it", () => {
  // At the start there is no word to hang the opening comma on.
  assert.equal(
    plan("Really the only way was this.", { emphasis: "Really" }).text,
    "Really the only way was this."
  );
  // At the end the sentence break already provides the pause.
  assert.equal(
    plan("The only way was really.", { emphasis: "really" }).text,
    "The only way was really."
  );
});

test("declines emphasis the author already punctuated", () => {
  const text = "It was the only way, really, in the end.";
  assert.equal(plan(text, { emphasis: "really" }).text, text);
});

test("declines emphasis too short to be worth a pause", () => {
  const text = "It was in the end the only way.";
  assert.equal(plan(text, { emphasis: "in" }).text, text);
});

test("isolates one phrase per sentence, the longest", () => {
  const text = "The report was late and the numbers were wrong here.";
  const result = planSpeech({
    text,
    words: words(text),
    normStart: 0,
    role: "body",
    emphasis: [
      { start: text.indexOf("late"), end: text.indexOf("late") + 4 },
      {
        start: text.indexOf("the numbers"),
        end: text.indexOf("the numbers") + "the numbers".length,
      },
    ],
  });
  assert.equal(
    result.text,
    "The report was late and, the numbers, were wrong here."
  );
  assert.deepEqual(spoken(text, result), [
    "The",
    "report",
    "was",
    "late",
    "and",
    "the",
    "numbers",
    "were",
    "wrong",
    "here",
  ]);
});

test("terminates and isolates in the same pass", () => {
  const result = plan("Why the numbers were wrong", { emphasis: "numbers" });
  assert.equal(result.text, "Why the, numbers, were wrong.");
});

test("plans the same sentence the same way every time", () => {
  const once = scalesFor("body", "The report was late.");
  const again = scalesFor("body", "The report was late.");
  assert.deepEqual(once, again);
});

test("gives neighbouring sentences different tempos", () => {
  const lines = [
    "The report was late.",
    "The numbers were wrong.",
    "Nobody said anything.",
    "That was the whole problem.",
  ].map((line) => scalesFor("body", line).length);
  assert.equal(new Set(lines).size, lines.length);
});

test("keeps the variation small enough to stay in character", () => {
  for (const role of ["body", "heading", "quote", "list", "clause"] as const) {
    for (let i = 0; i < 500; i++) {
      const { length, noise, noiseW } = scalesFor(role, `sentence number ${i}.`);
      assert.ok(length >= 0.85 && length <= 1.25, `length ${length}`);
      assert.ok(noise >= 0.85 && noise <= 1.2, `noise ${noise}`);
      assert.ok(noiseW >= 0.8 && noiseW <= 1.3, `noiseW ${noiseW}`);
    }
  }
});

test("announces a heading more slowly than it reads a line of body", () => {
  const line = "What The Numbers Say";
  assert.ok(scalesFor("heading", line).length > scalesFor("body", line).length);
  assert.ok(scalesFor("heading", line).noiseW > scalesFor("body", line).noiseW);
});

test("does not restart a sentence that was only divided", () => {
  const line = "and the numbers were wrong all along.";
  assert.ok(scalesFor("clause", line).length < scalesFor("body", line).length);
});

test("keeps the tempo of a sentence when emphasis is added to it", () => {
  const text = "It was really the only way.";
  assert.deepEqual(
    plan(text, { emphasis: "really" }).scales,
    plan(text).scales
  );
});
