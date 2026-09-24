// Reading a failure out of a wasm engine, which is not reliably an Error and
// is sometimes not even a string.
//
//   npm test

import assert from "node:assert/strict";
import { test } from "node:test";

import { describeThrown, isOutOfMemory } from "./errors.ts";

test("a wasm exception pointer never reaches a reader as a number", () => {
  // The value that was rendered as the status of an article. Emscripten's
  // `___cxa_throw` ends in `throw exceptionLast`, an integer, and stringifying
  // that put it in the transport where a sentence belonged.
  const described = describeThrown(4190029960);

  assert.ok(!/^\d+$/.test(described), "not a bare number");
  assert.match(described, /wasm exception/);
  // Hex, since the only use for one of these is comparing it to a layout.
  assert.match(described, /0xf9bec888/);
});

test("Errors keep their own message", () => {
  assert.equal(describeThrown(new Error("no PCM data")), "no PCM data");
});

test("anything else is named rather than printed", () => {
  assert.match(describeThrown(null), /null/);
  assert.match(describeThrown(undefined), /undefined/);
  assert.match(describeThrown({ code: 7 }), /Object/);
  assert.match(describeThrown("plain string"), /string/);
  // Descriptions are sentences, not values: none of them leak the payload.
  assert.ok(!describeThrown({ code: 7 }).includes("7"));
});

test("memory failures are recognized however they are phrased", () => {
  for (const message of [
    "Can't create a session. failed to allocate a buffer of size 63201294.",
    "Aborted(OOM)",
    "Out of memory",
    "Cannot enlarge memory arrays",
    "memory access out of bounds",
  ]) {
    assert.ok(isOutOfMemory(message), message);
  }
});

test("a refused sentence is not mistaken for a memory failure", () => {
  // The distinction the whole recovery path turns on: this one is about the
  // text, so it is divided rather than answered with a new worker.
  assert.equal(
    isOutOfMemory("Aborted(). Build with -sASSERTIONS for more info."),
    false
  );
  assert.equal(isOutOfMemory(describeThrown(4190029960)), false);
  assert.equal(isOutOfMemory("the phonemizer failed: it produced no output"), false);
});
