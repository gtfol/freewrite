import assert from "node:assert/strict";
import test from "node:test";

import { applyRises, RISE_SEMITONES } from "./pitch.ts";

const RATE = 24000;

// A voiced sound: a fundamental with a couple of harmonics on it, which is
// enough structure for autocorrelation to find a period the way it would in
// speech, and enough for WSOLA to have something to match against.
function voiced(f0: number, seconds: number, sampleRate = RATE): Float32Array {
  const audio = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < audio.length; i++) {
    const t = i / sampleRate;
    audio[i] =
      0.5 * Math.sin(2 * Math.PI * f0 * t) +
      0.25 * Math.sin(4 * Math.PI * f0 * t) +
      0.12 * Math.sin(6 * Math.PI * f0 * t);
  }
  return audio;
}

// Autocorrelation over one window, searching the range a speaking voice lives
// in. Parabolic interpolation on the winning lag, or the estimate quantizes to
// whole samples and a few percent at these frequencies.
function pitchAt(
  audio: Float32Array,
  from: number,
  to: number,
  sampleRate = RATE
): number {
  const lowLag = Math.floor(sampleRate / 400);
  const highLag = Math.min(Math.ceil(sampleRate / 60), Math.floor((to - from) / 2));

  const correlate = (lag: number) => {
    let sum = 0;
    for (let i = from; i + lag < to; i++) sum += audio[i] * audio[i + lag];
    return sum;
  };

  let best = lowLag;
  let bestScore = -Infinity;
  for (let lag = lowLag; lag <= highLag; lag++) {
    const score = correlate(lag);
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }

  const before = correlate(best - 1);
  const after = correlate(best + 1);
  const denominator = 2 * (2 * bestScore - before - after);
  const offset = denominator === 0 ? 0 : (after - before) / denominator;
  return sampleRate / (best + offset);
}

const semitonesBetween = (low: number, high: number) =>
  12 * Math.log2(high / low);

test("returns the audio untouched when there is nothing to lift", () => {
  const audio = voiced(120, 0.4);
  assert.equal(applyRises(audio, RATE, []), audio);
});

test("leaves the length alone, so word times still describe the audio", () => {
  const audio = voiced(120, 0.5);
  const raised = applyRises(audio, RATE, [{ from: 0.2, to: 0.5 }]);
  assert.equal(raised.length, audio.length);
});

test("lifts the end of the span and not the start", () => {
  const audio = voiced(120, 0.5);
  const raised = applyRises(audio, RATE, [{ from: 0.2, to: 0.5 }]);

  const opens = pitchAt(raised, Math.round(0.2 * RATE), Math.round(0.26 * RATE));
  const closes = pitchAt(raised, Math.round(0.44 * RATE), Math.round(0.5 * RATE));

  assert.ok(
    Math.abs(semitonesBetween(120, opens)) < 0.5,
    `the rise should begin where the voice already was, got ${opens.toFixed(1)}Hz`
  );
  assert.ok(
    Math.abs(semitonesBetween(120, closes) - RISE_SEMITONES) < 0.6,
    `expected about ${RISE_SEMITONES} semitones, got ${semitonesBetween(120, closes).toFixed(2)}`
  );
});

test("moves the tone monotonically through the span", () => {
  const audio = voiced(120, 0.5);
  const raised = applyRises(audio, RATE, [{ from: 0.2, to: 0.5 }]);

  const readings = [0.21, 0.29, 0.37, 0.44].map((at) =>
    pitchAt(raised, Math.round(at * RATE), Math.round((at + 0.055) * RATE))
  );
  for (let i = 1; i < readings.length; i++) {
    assert.ok(
      readings[i] > readings[i - 1],
      `pitch fell between readings: ${readings.map((r) => r.toFixed(1)).join(", ")}`
    );
  }
});

test("asks for more tone when told to", () => {
  const audio = voiced(120, 0.5);
  const window = (raised: Float32Array) =>
    pitchAt(raised, Math.round(0.44 * RATE), Math.round(0.5 * RATE));

  const small = window(applyRises(audio, RATE, [{ from: 0.2, to: 0.5 }], 2));
  const large = window(applyRises(audio, RATE, [{ from: 0.2, to: 0.5 }], 5));
  assert.ok(large > small + 5, `${small.toFixed(1)}Hz vs ${large.toFixed(1)}Hz`);
});

test("leaves everything outside the span exactly as it was", () => {
  const audio = voiced(120, 0.6);
  const raised = applyRises(audio, RATE, [{ from: 0.3, to: 0.6 }]);
  // The span is capped at its last 300ms, so nothing before 0.3s may move.
  for (let i = 0; i < Math.round(0.3 * RATE); i++) {
    assert.equal(raised[i], audio[i], `sample ${i} moved`);
  }
});

test("lifts each item of a list independently", () => {
  const audio = voiced(120, 0.9);
  const raised = applyRises(audio, RATE, [
    { from: 0.0, to: 0.3 },
    { from: 0.3, to: 0.6 },
    { from: 0.6, to: 0.9 },
  ]);

  for (const at of [0.24, 0.54, 0.84]) {
    const top = pitchAt(raised, Math.round(at * RATE), Math.round((at + 0.055) * RATE));
    assert.ok(
      Math.abs(semitonesBetween(120, top) - RISE_SEMITONES) < 0.8,
      `item ending at ${at}s reached ${semitonesBetween(120, top).toFixed(2)} semitones`
    );
  }
  // And each one comes back down for the next, rather than stacking.
  const restart = pitchAt(raised, Math.round(0.31 * RATE), Math.round(0.365 * RATE));
  assert.ok(
    Math.abs(semitonesBetween(120, restart)) < 0.8,
    `the next item should start where the voice was, got ${restart.toFixed(1)}Hz`
  );
});

test("declines a span too short to hear a movement in", () => {
  const audio = voiced(120, 0.4);
  const raised = applyRises(audio, RATE, [{ from: 0.35, to: 0.4 }]);
  assert.deepEqual(Array.from(raised), Array.from(audio));
});

test("declines a span that is all pause", () => {
  const audio = voiced(120, 0.6);
  const silent = new Float32Array(audio.length);
  silent.set(audio.subarray(0, Math.round(0.3 * RATE)));
  const raised = applyRises(silent, RATE, [{ from: 0.35, to: 0.6 }]);
  assert.deepEqual(Array.from(raised), Array.from(silent));
});

test("puts the movement on the speech when the span ends in a pause", () => {
  // What the worker actually hands over: the item, then the comma's silence.
  const audio = new Float32Array(Math.round(0.6 * RATE));
  audio.set(voiced(120, 0.4));

  const raised = applyRises(audio, RATE, [{ from: 0.1, to: 0.6 }]);
  const top = pitchAt(raised, Math.round(0.34 * RATE), Math.round(0.395 * RATE));
  assert.ok(
    Math.abs(semitonesBetween(120, top) - RISE_SEMITONES) < 0.8,
    `expected the rise to land before the pause, got ${semitonesBetween(120, top).toFixed(2)} semitones`
  );
});
