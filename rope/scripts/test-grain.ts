// The pace-and-pitch loop player (src/audio/grainCore.ts) does what it says:
// at pace = pitch it is the file resampled, sample for sample; apart, the pitch
// is the file's at the pitch asked and the file's time runs at the pace asked;
// it reads only the window it is given; and its grains add up in step (a sine
// comes out a sine of steady amplitude, not beating).
//
// These are the arithmetic, not the sound: whether a roll sounds right is for
// playing it (docs/sound.md#what-green-cannot-see).

import { strict as assert } from "node:assert";
import { WsolaLoop } from "../src/audio/grainCore";

const SR = 48000;

function run(x: Float32Array, seconds: number, pace: number, pitch: number, at = 0): Float32Array {
  const loop = new WsolaLoop([x], SR);
  loop.seek(at);
  const out = new Float32Array(Math.round(seconds * SR));
  // In render quanta, as the worklet calls it.
  for (let i = 0; i < out.length; i += 128) {
    const n = Math.min(128, out.length - i);
    loop.process([out], n, pace, pitch, i);
  }
  return out;
}

// Seeded noise, so a failure is the same failure every run.
function noise(n: number): Float32Array {
  let s = 0x2545f491;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = ((s >>> 0) / 0xffffffff) * 2 - 1;
  }
  return out;
}

function lerp(x: Float32Array, pos: number): number {
  const k = Math.floor(pos);
  const f = pos - k;
  return x[k % x.length]! * (1 - f) + x[(k + 1) % x.length]! * f;
}

// The frequency of `y` around `t` seconds, from its upward zero crossings
// over `span` seconds (interpolated between samples).
function frequencyAt(y: Float32Array, t: number, span = 0.04): number {
  const a = Math.round((t - span / 2) * SR);
  const b = Math.round((t + span / 2) * SR);
  const crossings: number[] = [];
  for (let i = a; i < b; i++) {
    if (y[i]! <= 0 && y[i + 1]! > 0) crossings.push(i + y[i]! / (y[i]! - y[i + 1]!));
  }
  assert.ok(crossings.length >= 3, `no tone at ${t}s`);
  return ((crossings.length - 1) * SR) / (crossings[crossings.length - 1]! - crossings[0]!);
}

const hop = new WsolaLoop([new Float32Array(SR)], SR).hop;

// 1. Pace = pitch: the file resampled, exactly, once the first grain has faded
//    in. This is what keeps a loop that does not ask for the difference (the
//    whoosh, the wade) sounding as the tape-speed loop did.
const x = noise(2 * SR);
for (const rate of [1, 2, 0.7, 1.37]) {
  const y = run(x, 0.6, rate, rate);
  let worst = 0;
  for (let j = hop; j < y.length; j++) worst = Math.max(worst, Math.abs(y[j]! - lerp(x, j * rate)));
  assert.ok(worst < 2e-4, `pace = pitch = ${rate} is the file resampled (worst sample off by ${worst})`);
}

// 2. Apart: a chirp, 200 Hz to 2 kHz over 4 s, says both at once - its
//    frequency at an output time is the pitch times the chirp's frequency
//    where the pace has got to in the file.
const T = 4;
const chirp = new Float32Array(T * SR);
for (let i = 0; i < chirp.length; i++) {
  const t = i / SR;
  chirp[i] = Math.sin(2 * Math.PI * (200 * t + ((2000 - 200) * t * t) / (2 * T)));
}
const chirpHz = (t: number): number => 200 + ((2000 - 200) * t) / T;
for (const [pace, pitch, tOut] of [
  [2, 1, 1],
  [0.5, 1, 2],
  [1, 1.5, 1],
  [1.6, 0.75, 1.5],
] as const) {
  const y = run(chirp, tOut + 0.1, pace, pitch);
  const heard = frequencyAt(y, tOut);
  const expected = pitch * chirpHz(pace * tOut);
  assert.ok(
    Math.abs(heard / expected - 1) < 0.02,
    `pace ${pace} pitch ${pitch} at ${tOut}s: ${heard.toFixed(1)} Hz, expected ${expected.toFixed(1)}`,
  );
}

// 3. Only the window plays, wrapping at its end: ones inside two windows and
//    zeros everywhere else come out as ones, whatever the pace and pitch, and
//    after the window changes - including to one shorter than a grain.
const dc = new Float32Array(SR);
dc.fill(1, 10000, 20000);
dc.fill(1, 30000, 30500);
{
  const loop = new WsolaLoop([dc], SR);
  loop.setWindow(10000, 20000);
  loop.seek(15000);
  const out = new Float32Array(SR);
  for (let i = 0; i < out.length; i += 128) {
    if (i === SR / 2) loop.setWindow(30000, 30500);
    loop.process([out], 128, 1.7, 0.6, i);
  }
  // The first grain fades in from silence, as does the first after a window
  // change (its position is new, so there is nothing to continue).
  let worst = 0;
  for (let j = hop; j < out.length; j++) worst = Math.max(worst, Math.abs(out[j]! - 1));
  assert.ok(worst < 1e-5, `reads only its window (worst ${worst})`);
}

// 4. Grains in step: a 440 Hz sine at pace 1.6, pitch 1, is a 440 Hz sine of
//    steady amplitude. Without the similarity search the overlapping halves
//    meet at random phases and the level beats at the hop rate.
{
  const sine = new Float32Array(2 * SR);
  for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
  const y = run(sine, 1, 1.6, 1);
  let lo = Infinity;
  let hi = 0;
  const period = Math.round(SR / 440);
  for (let a = hop; a + period < y.length; a += period) {
    let peak = 0;
    for (let j = a; j < a + period; j++) peak = Math.max(peak, Math.abs(y[j]!));
    lo = Math.min(lo, peak);
    hi = Math.max(hi, peak);
  }
  assert.ok(lo > 0.97 && hi < 1.03, `a sine stays a steady sine (cycle peaks ${lo.toFixed(3)}..${hi.toFixed(3)})`);
  const hz = frequencyAt(y, 0.5, 0.2);
  assert.ok(Math.abs(hz - 440) < 2, `at its own pitch (${hz.toFixed(1)} Hz)`);
}

// What it costs, for the record: the audio thread runs one per loop playing.
const t0 = performance.now();
run(noise(4 * SR), 10, 1.3, 1);
const realtime = 10000 / (performance.now() - t0);

console.log(
  `PASS grain: pace = pitch is the file resampled, pace and pitch set apart, window-bound, grains in step (${realtime.toFixed(0)}x realtime per loop)`,
);
