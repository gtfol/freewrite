// The engine can't be run here — it needs a browser, a wasm runtime and a
// 60MB model — so recovery is tested against a stand-in that refuses whatever
// it is told to refuse. What's being checked is the part that is ours: that a
// refusal is divided rather than surrendered to, that a sentence with one bad
// fragment in it still mostly reads, and that none of it loops.
//
//   npm test

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  join,
  MIN_FRAGMENT_CHARS,
  splitPoint,
  synthesizeWithRecovery,
  type Waveform,
} from "./recover.ts";

const RATE = 22050;

// A tone rather than silence: trimSilence drops anything below 2% of peak, and
// a fragment trimmed to nothing would hide the very thing being counted.
function tone(seconds: number): Float32Array {
  const audio = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < audio.length; i++) audio[i] = Math.sin(i / 8) * 0.5;
  return audio;
}

// Stands in for the engine: refuses any text matching `refuse`, and otherwise
// returns audio proportional to the length of what it was given, so the
// recovered waveform says how much of the sentence survived.
function engine(refuse: RegExp, error = new Error("Aborted().")) {
  const seen: string[] = [];
  const synth = async (text: string): Promise<Waveform> => {
    seen.push(text);
    if (refuse.test(text)) throw error;
    return { audio: tone(text.length / 100), sampleRate: RATE };
  };
  return { synth, seen };
}

const sentence =
  "The first clause runs along quietly, the second clause carries the difficult part, and the third clause finishes the thought.";

test("a sentence that synthesizes is left alone", async () => {
  const { synth, seen } = engine(/never/);
  const result = await synthesizeWithRecovery(synth, sentence);

  assert.equal(seen.length, 1, "one call for a sentence that works");
  assert.ok(result.audio.length > 0);
  assert.equal(result.sampleRate, RATE);
});

test("a refused sentence is divided and mostly recovered", async () => {
  // Only the whole sentence is refused; either half is fine. This is the
  // common case, where the refusal is about how much was asked for.
  const { synth, seen } = engine(new RegExp(`^${escape(sentence)}$`));
  const result = await synthesizeWithRecovery(synth, sentence);

  assert.ok(seen.length > 1, "the refusal was retried in pieces");
  assert.ok(result.audio.length > 0, "audio came back");
  // Both halves survived, so the recovered length is the whole sentence.
  const whole = tone(sentence.length / 100).length;
  assert.ok(
    result.audio.length > whole * 0.9,
    `expected most of the sentence, got ${result.audio.length} of ${whole}`
  );
});

test("only the unsayable fragment is lost", async () => {
  // "difficult" survives every division, so whichever fragment carries it
  // keeps failing while its neighbours succeed.
  const { synth } = engine(/difficult/);
  const result = await synthesizeWithRecovery(synth, sentence);

  const whole = tone(sentence.length / 100).length;
  assert.ok(result.audio.length > 0, "the rest of the sentence still reads");
  assert.ok(result.audio.length < whole, "the bad fragment did not come back");
  assert.ok(
    result.audio.length > whole * 0.4,
    `expected most of the sentence to survive, got ${result.audio.length} of ${whole}`
  );
});

test("a sentence refused whatever the size reports the original refusal", async () => {
  const error = new Error("Aborted(). Build with -sASSERTIONS for more info.");
  const { synth } = engine(/./, error);

  await assert.rejects(
    () => synthesizeWithRecovery(synth, sentence),
    (thrown: Error) => thrown === error
  );
});

test("memory failures are not divided — they go back for a new worker", async () => {
  const oom = new Error(
    "Can't create a session. failed to allocate a buffer of size 63201294."
  );
  const { synth, seen } = engine(/./, oom);

  await assert.rejects(() => synthesizeWithRecovery(synth, sentence));
  assert.equal(seen.length, 1, "asked once, then handed back");
});

test("division terminates on text with nowhere good to cut", async () => {
  const runOn = "x".repeat(400);
  const { synth, seen } = engine(new RegExp(`^x{400}$`));

  // No clause or word boundary anywhere, so there is no cut to make and the
  // refusal stands rather than recursing.
  await assert.rejects(() => synthesizeWithRecovery(synth, runOn));
  assert.equal(seen.length, 1);
});

test("division bottoms out rather than recursing forever", async () => {
  // Distinct words, so two fragments being equal would mean the same work was
  // done twice rather than the text simply repeating itself.
  const spaced = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
  const { synth, seen } = engine(/./);

  await assert.rejects(() => synthesizeWithRecovery(synth, spaced));
  // A binary division down to the floor: bounded by the length of the text,
  // and no fragment revisited on the way down.
  assert.ok(seen.length < spaced.length / 10, "bounded number of attempts");
  assert.equal(new Set(seen).size, seen.length, "no fragment tried twice");
  assert.ok(
    seen.every((text) => text.length > 0),
    "no empty fragment handed to the engine"
  );
});

test("splitPoint prefers clauses, then words, then gives up", () => {
  const clause = `${"a".repeat(40)}, ${"b".repeat(40)}`;
  assert.equal(clause[splitPoint(clause) - 1], ",");

  const words = `${"a".repeat(40)} ${"b".repeat(40)}`;
  assert.equal(words[splitPoint(words) - 1], " ");

  assert.equal(splitPoint("z".repeat(80)), -1);
  // Nothing to cut inside the floor at either end.
  assert.equal(splitPoint("a b"), -1);
  assert.equal(splitPoint(`${"a".repeat(MIN_FRAGMENT_CHARS)} b`), -1);
});

test("join concatenates in order and keeps the rate", () => {
  const first = { audio: Float32Array.from([1, 2]), sampleRate: RATE };
  const second = { audio: Float32Array.from([3]), sampleRate: RATE };

  assert.deepEqual(
    Array.from(join([first, second]).audio),
    [1, 2, 3]
  );
  assert.equal(join([first, second]).sampleRate, RATE);
  assert.equal(join([first]), first, "a single part is passed through");
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
