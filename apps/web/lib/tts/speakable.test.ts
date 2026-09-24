import assert from "node:assert/strict";
import test from "node:test";

import { speakable, unspeakableSpans } from "./speakable.ts";

function stripped(text: string): string {
  const spans = unspeakableSpans(text);
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start);
    at = span.end;
  }
  return out + text.slice(at);
}

// The formula that started this: KaTeX left behind as plain text, and rendered
// twice over the way it usually is.
const FORMULA =
  "∇θJOPD(θ)=Ex, y^∼πθ(⋅∣x) ⁣[∑t(log⁡πT(y^t∣y^<t)−log⁡πθ(y^t∣y^<t)) ∇θlog⁡πθ(y^t∣y^<t)]∇θJOPD(θ)=Ex,y^∼πθ(⋅∣x)[t∑(logπT(y^t∣y^<t)−logπθ(y^t∣y^<t))∇θlogπθ(y^t∣y^<t)]";

test("drops a rendered formula whole", () => {
  assert.equal(speakable(FORMULA), false);
});

test("drops the things that are not sentences", () => {
  for (const text of [
    "www.dennissylvesterhurd.com/blog/softrain.htm 2/5",
    "2/5",
    "https://example.com/a/b/c",
    "37.7749, -122.4194",
    "d41d8cd98f00b204e9800998ecf8427e",
    "550e8400-e29b-41d4-a716-446655440000",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    "+1-555-0142-9987",
    "/usr/local/share/piper/voices",
    "— — —",
    "[1] [2] [3]",
  ]) {
    assert.equal(speakable(text), false, `should have been dropped: ${text}`);
  }
});

test("keeps sentences that merely look technical", () => {
  for (const text of [
    "The value of π is about 3.14159.",
    "α, β, and γ are the three angles.",
    "Einstein wrote E = mc² on the board.",
    "She published it in 2019, then again in 2024.",
    "It cost $4.50, which felt steep.",
    "Figure 3 shows the same effect.",
    "The rate rose from 12% to 18% in a year.",
    "He scored 7-3 in the second half.",
    "Chapter 11 covers the rest of it.",
    "Temperatures reached 41°C that afternoon.",
    "The answer, unsurprisingly, was no.",
  ]) {
    assert.equal(speakable(text), true, `should have been kept: ${text}`);
  }
});

test("cuts a URL out of the sentence around it", () => {
  assert.equal(
    stripped("See https://example.com/a/b for details."),
    "See for details."
  );
  assert.equal(
    stripped("Read it at www.example.com/post and tell me."),
    "Read it at and tell me."
  );
  assert.equal(speakable("See https://example.com/a/b for details."), true);
});

test("takes the brackets with the link", () => {
  assert.equal(stripped("The source (https://example.com/x) says so."), "The source says so.");
});

test("cuts a hash out without cutting the sentence", () => {
  assert.equal(
    stripped("The commit d41d8cd98f00b204e9800998ecf8427e broke it."),
    "The commit broke it."
  );
});

test("leaves ordinary words alone", () => {
  for (const text of [
    "The answer was no.",
    "Mr. Smith arrived at half past four.",
    "She said e.g. this one.",
    "It cost $4.50.",
    "Rhythms and strengths are still words.",
    "NASA and the BBC both reported it.",
  ]) {
    assert.equal(stripped(text), text, `should have been untouched: ${text}`);
  }
});

test("does not mistake a decimal or a date for an identifier", () => {
  for (const text of ["3.14159", "2024-07-29", "1,250,000"]) {
    assert.equal(stripped(`It was ${text} exactly.`), `It was ${text} exactly.`);
  }
});

test("drops a chunk that is only a link", () => {
  assert.equal(speakable("https://example.com/a/b"), false);
  assert.equal(speakable("www.example.com/post"), false);
});

test("keeps a sentence whose only oddity is one long word", () => {
  assert.equal(speakable("Antidisestablishmentarianism is the usual example."), true);
});

test("survives text with nothing in it", () => {
  assert.equal(speakable(""), false);
  assert.equal(speakable("   "), false);
  assert.deepEqual(unspeakableSpans(""), []);
});

test("returns spans in order and inside the text", () => {
  const text = "See https://a.com/x and http://b.org/y for more.";
  const spans = unspeakableSpans(text);
  assert.equal(spans.length, 2);
  for (const span of spans) {
    assert.ok(span.start >= 0 && span.end <= text.length && span.start < span.end);
  }
  assert.ok(spans[0].end <= spans[1].start, "spans must not overlap");
});
