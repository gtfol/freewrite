// The whole point of the stretcher is that duration moves and pitch doesn't,
// and neither half is visible from the outside — a regression here sounds like
// a slightly odd voice, not like a broken build. So both are asserted directly:
// length against the requested speed, pitch against a synthetic tone whose
// frequency is known exactly.
//
//   npm test

import assert from "node:assert/strict";
import { test } from "node:test";

import { timeStretch } from "./stretch.ts";

const RATE = 24000;

function tone(seconds: number, frequency: number, rate = RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.5 * Math.sin((2 * Math.PI * frequency * i) / rate);
  }
  return out;
}

// Dominant frequency by autocorrelation, searched over the range a speaking
// voice occupies. Zero-crossing counting was tried first and is too easy to
// fool: an overlap-add seam adds crossings without changing the pitch.
function pitch(audio: Float32Array, rate = RATE): number {
  const min = Math.floor(rate / 500);
  const max = Math.floor(rate / 60);
  let bestLag = min;
  let best = -Infinity;
  for (let lag = min; lag <= max; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < audio.length; i++) sum += audio[i] * audio[i + lag];
    const score = sum / (audio.length - lag);
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  return rate / bestLag;
}

test("pitch survives the stretch", () => {
  const source = tone(1, 220);
  for (const speed of [0.75, 1.25, 1.5, 2]) {
    const stretched = timeStretch(source, RATE, speed);
    // Autocorrelation resolves to whole samples, so 220Hz can only land within
    // a couple of Hz however clean the stretch is; resampling at these speeds
    // would move it to 165-440Hz, which is nowhere near this tolerance.
    assert.ok(
      Math.abs(pitch(stretched) - 220) < 4,
      `speed ${speed} moved the pitch to ${pitch(stretched).toFixed(1)}Hz`
    );
  }
});

test("duration tracks the requested speed", () => {
  const source = tone(2, 180);
  for (const speed of [0.75, 1.25, 1.5, 1.75, 2]) {
    const stretched = timeStretch(source, RATE, speed);
    assert.equal(stretched.length, Math.round(source.length / speed));
  }
});

test("the stretch holds its level, start to end", () => {
  const stretched = timeStretch(tone(1, 200), RATE, 1.5);
  const window = Math.round(RATE * 0.05);
  const peakOver = (from: number) => {
    let peak = 0;
    for (let i = from; i < Math.min(stretched.length, from + window); i++) {
      peak = Math.max(peak, Math.abs(stretched[i]));
    }
    return peak;
  };

  // Including the very first and very last window, where only one Hann window
  // lands and an un-normalised overlap-add would fade the voice in and out.
  assert.ok(peakOver(0) > 0.4, `quiet head: ${peakOver(0).toFixed(3)}`);
  assert.ok(
    peakOver(stretched.length - window) > 0.4,
    `quiet tail: ${peakOver(stretched.length - window).toFixed(3)}`
  );
  for (let at = 0; at < stretched.length; at += window) {
    assert.ok(peakOver(at) <= 0.55, `overshoot at ${at}: ${peakOver(at)}`);
  }
});

test("1x is a passthrough, and returns a copy", () => {
  const source = tone(0.2, 200);
  const same = timeStretch(source, RATE, 1);
  assert.deepEqual(Array.from(same), Array.from(source));
  same[0] = 1;
  assert.notEqual(source[0], 1);
});

test("fragments too short to splice come back unharmed", () => {
  for (const length of [0, 1, 64, Math.round(RATE * 0.02)]) {
    const source = tone(length / RATE, 200);
    const stretched = timeStretch(source, RATE, 2);
    assert.equal(stretched.length, source.length);
  }
});

test("a nonsense speed is treated as 1x rather than producing nonsense", () => {
  const source = tone(0.3, 200);
  for (const speed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(timeStretch(source, RATE, speed).length, source.length);
  }
});

test("silence stretches to silence, not to a divide by zero", () => {
  const silence = new Float32Array(RATE);
  const stretched = timeStretch(silence, RATE, 1.5);
  assert.equal(stretched.length, Math.round(RATE / 1.5));
  assert.ok(stretched.every((sample) => Number.isFinite(sample) && sample === 0));
});
