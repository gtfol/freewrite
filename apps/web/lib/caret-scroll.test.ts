import assert from "node:assert/strict";
import { test } from "node:test";
import { caretScrollDelta } from "./caret-scroll.ts";

test("a new line below the usable bottom scrolls into view", () => {
  assert.equal(caretScrollDelta(610, 30, 56, 608), 32);
});

test("a partially obscured wrapped line is fully revealed", () => {
  assert.equal(caretScrollDelta(590, 30, 56, 608), 12);
});

test("editing a visible line does not jump to the entry's end", () => {
  assert.equal(caretScrollDelta(200, 30, 56, 608), 0);
  assert.equal(caretScrollDelta(578, 30, 56, 608), 0);
});

test("editing above the viewport scrolls upward only enough to reveal the line", () => {
  assert.equal(caretScrollDelta(20, 30, 56, 608), -36);
});

test("a keyboard-reduced viewport still accommodates a full line", () => {
  assert.equal(caretScrollDelta(300, 30, 56, 280), 50);
  assert.equal(caretScrollDelta(56, 40, 56, 70), 0);
});
