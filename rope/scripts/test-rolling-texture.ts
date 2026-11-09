import { strict as assert } from "node:assert";
import { RollingTexture } from "../src/audio/rollingTexture";

const sr = 12000, n = sr * 2;
let seed = 19;
const source = Float32Array.from({ length: n }, (_, i) => {
  seed = Math.imul(seed, 1664525) + 1013904223 | 0;
  const noise = (seed >>> 0) / 2147483648 - 1;
  return noise * .1 * (1.1 + Math.sin(2 * Math.PI * i / n));
});
const render = (seed: number) => {
  const engine = new RollingTexture([source, source], sr, seed);
  const output = [new Float32Array(sr * 10), new Float32Array(sr * 10)];
  for (let i = 0; i < output[0]!.length; i += 128) engine.process(output, Math.min(128, output[0]!.length - i), 1, 1, i);
  return output;
};
const [a, stereo] = render(23);
assert.deepEqual(a, stereo, "all channels use the same grain positions and gains");
assert.deepEqual(a, render(23)[0], "fixed seed reproduces the texture");
assert.notDeepEqual(a, render(24)[0], "different voices do not repeat the same grain sequence");
assert.ok(a!.every(Number.isFinite));
let cross = 0, powerA = 0, powerB = 0;
for (let i = sr; i < a!.length - n; i++) {
  cross += a![i]! * a![i + n]!; powerA += a![i]! ** 2; powerB += a![i + n]! ** 2;
}
const correlation = cross / Math.sqrt(powerA * powerB);
assert.ok(Math.abs(correlation) < .1, `source-length recurrence removed: ${correlation}`);
const rms: number[] = [];
for (let i = sr; i + sr / 4 <= a!.length; i += sr / 4) {
  let energy = 0;
  for (let j = i; j < i + sr / 4; j++) energy += a![j]! ** 2;
  rms.push(Math.sqrt(energy / (sr / 4)));
}
const spanDb = 20 * Math.log10(Math.max(...rms) / Math.min(...rms));
assert.ok(spanDb < 6, `source performance envelope flattened: ${spanDb} dB`);
const clipped = new RollingTexture([new Float32Array(100).fill(99).map((v, i) => i >= 25 && i < 75 ? .1 : v)], sr);
clipped.setWindow(25, 75);
const windowed = [new Float32Array(sr)]; clipped.process(windowed, sr, 1, 1);
assert.ok(windowed[0]!.every(v => Number.isFinite(v) && Math.abs(v) < .15), "only the selected clip window is read");
console.log(`PASS: nonperiodic rolling texture, controlled envelope (${spanDb.toFixed(2)} dB), stereo coherence, seeds, clip bounds`);
