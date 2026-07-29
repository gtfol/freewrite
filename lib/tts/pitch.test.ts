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

// Deterministic noise, standing in for a fricative: loud, and with no period
// for WSOLA to splice on. This is the content that has to be left alone.
function fricative(seconds: number, sampleRate = RATE): Float32Array {
  const audio = new Float32Array(Math.round(seconds * sampleRate));
  let seed = 0x2f6e2b1;
  for (let i = 0; i < audio.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    audio[i] = (seed / 0x100000000) * 1.2 - 0.6;
  }
  return audio;
}

// A voiced fricative — the /z/ of "eyes". The folds are vibrating and the
// constriction is hissing at the same time, so it is periodic and noisy at
// once, and the periodicity alone will vouch for it.
function voicedFricative(
  f0: number,
  seconds: number,
  sampleRate = RATE
): Float32Array {
  const tone = voiced(f0, seconds, sampleRate);
  const hiss = fricative(seconds, sampleRate);
  const audio = new Float32Array(tone.length);
  for (let i = 0; i < audio.length; i++) audio[i] = tone[i] * 0.5 + hiss[i] * 0.7;
  return audio;
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
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

// The regression: "toast" is a voiced diphthong followed by /st/, and a
// fricative is loud enough to pass any level test. WSOLA has no pitch periods
// to splice on in there, so anything it does to it comes out metallic.
test("never touches the fricative an item ends on", () => {
  const voice = voiced(120, 0.3);
  const hiss = fricative(0.12);
  const audio = concat(voice, hiss);

  const raised = applyRises(audio, RATE, [{ from: 0, to: 0.42 }]);

  for (let i = voice.length; i < audio.length; i++) {
    assert.equal(raised[i], audio[i], `sample ${i} of the fricative moved`);
  }
});

test("still lifts the vowel before that fricative", () => {
  const voice = voiced(120, 0.3);
  const audio = concat(voice, fricative(0.12));
  const raised = applyRises(audio, RATE, [{ from: 0, to: 0.42 }]);

  const top = pitchAt(raised, Math.round(0.235 * RATE), Math.round(0.29 * RATE));
  assert.ok(
    Math.abs(semitonesBetween(120, top) - RISE_SEMITONES) < 0.8,
    `expected the rise on the vowel, got ${semitonesBetween(120, top).toFixed(2)} semitones`
  );
});

// "electric eyes": the /z/ is voiced, so periodicity vouches for it, and
// decimating for the correlation is exactly what hides the hiss that should
// have disqualified it.
test("never touches a voiced fricative either", () => {
  const vowel = voiced(120, 0.28);
  const buzz = voicedFricative(120, 0.12);
  const audio = concat(vowel, buzz);

  const raised = applyRises(audio, RATE, [{ from: 0, to: 0.4 }]);
  for (let i = vowel.length; i < audio.length; i++) {
    assert.equal(raised[i], audio[i], `sample ${i} of the voiced fricative moved`);
  }
});

test("still lifts the diphthong before a voiced fricative", () => {
  const audio = concat(voiced(120, 0.28), voicedFricative(120, 0.12));
  const raised = applyRises(audio, RATE, [{ from: 0, to: 0.4 }]);

  const top = pitchAt(raised, Math.round(0.215 * RATE), Math.round(0.27 * RATE));
  assert.ok(
    Math.abs(semitonesBetween(120, top) - RISE_SEMITONES) < 0.9,
    `expected the rise on the vowel, got ${semitonesBetween(120, top).toFixed(2)} semitones`
  );
});

// "gas": a short, fully voiced vowel running straight into /s/. Leaving even
// ten milliseconds of it un-raised means the voice climbs a tone and steps
// back down before the consonant, which is audible on a vowel in a way it
// isn't inside the /z/ of "eyes".
test("leaves no un-raised vowel between the rise and the consonant", () => {
  for (const ms of [100, 140, 200, 260]) {
    const vowel = voiced(120, ms / 1000);
    const audio = concat(vowel, fricative(0.12));
    const raised = applyRises(audio, RATE, [{ from: 0, to: (ms + 120) / 1000 }]);

    let last = -1;
    for (let i = 0; i < audio.length; i++) if (raised[i] !== audio[i]) last = i;
    assert.notEqual(last, -1, `no rise applied to a ${ms}ms vowel`);

    // Under half a period at 120Hz, so there is no pitch to step back down to.
    const leftover = ((vowel.length - 1 - last) / RATE) * 1000;
    assert.ok(
      leftover >= 0 && leftover < 4,
      `${leftover.toFixed(1)}ms of un-raised vowel after a ${ms}ms vowel`
    );
  }
});

test("declines an item that is all fricative", () => {
  const audio = concat(voiced(120, 0.1), fricative(0.3));
  const raised = applyRises(audio, RATE, [{ from: 0.1, to: 0.4 }]);
  assert.deepEqual(Array.from(raised), Array.from(audio));
});

test("takes the last voiced run, not the first", () => {
  // A stop in the middle of a word: "bacon" is [beɪ] k [ən].
  const audio = concat(
    voiced(120, 0.14),
    fricative(0.05),
    voiced(120, 0.16),
    new Float32Array(Math.round(0.08 * RATE))
  );
  const raised = applyRises(audio, RATE, [{ from: 0, to: 0.43 }]);

  // The first run keeps the pitch it had.
  const early = pitchAt(raised, Math.round(0.06 * RATE), Math.round(0.12 * RATE));
  assert.ok(
    Math.abs(semitonesBetween(120, early)) < 0.5,
    `the earlier syllable moved to ${early.toFixed(1)}Hz`
  );
  // The last one carries the tone.
  const late = pitchAt(raised, Math.round(0.29 * RATE), Math.round(0.345 * RATE));
  assert.ok(
    Math.abs(semitonesBetween(120, late) - RISE_SEMITONES) < 0.9,
    `expected the rise on the final syllable, got ${semitonesBetween(120, late).toFixed(2)} semitones`
  );
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
