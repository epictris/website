import { strict as assert } from "node:assert";
import { strikeLevel, loopGainFollow, scheduleShotEnvelope } from "../src/audio/playbackLevel";
import { resolveSlot, type SoundBank } from "../src/audio/slots";
import { CHAIN_LINK_LEN } from "../src/render/chainMetrics";

for (const family of ["wind", "wrap"] as const) {
  // At full intensity, doubling link density must not double the total power.
  for (const duration of [0.07, 0.116, 0.3]) {
    const power = (speed: number) => strikeLevel(family, speed, 3, duration) ** 2 * speed / CHAIN_LINK_LEN;
    assert.ok(Math.abs(power(3) - power(6)) < 1e-9);
    assert.ok(Math.abs(power(6) - power(12)) < 1e-9);
  }
  assert.ok(strikeLevel(family, 0.1, 3, 0.1) < strikeLevel(family, 1, 3, 0.1), "slow links fade down");
  assert.equal(strikeLevel(family, 0, 3, 0.1), 0);
}
assert.equal(strikeLevel("land", 8, 8, 0.15), 1, "isolated impact keeps its reference level");
// Creeping winding contacts must be much quieter than the old linear curve;
// normal winding retains its level and other link contacts retain their curve.
for (const speed of [0.03, 0.1, 0.3, 0.75]) {
  const oldLevel = strikeLevel("wrap", speed, 3, 0.14);
  const reductionDb = 20 * Math.log10(strikeLevel("wind", speed, 3, 0.14) / oldLevel);
  assert.ok(reductionDb <= -12, "slow winding is at least 12 dB quieter than a linear response");
}
for (const speed of [3, 6, 12]) {
  assert.equal(strikeLevel("wind", speed, 3, 0.14), strikeLevel("wrap", speed, 3, 0.14),
    "normal/fast winding retains its established density-limited level");
}
assert.equal(strikeLevel("attach", 24, 12, 0.5), 2, "isolated impacts retain their dynamic range");
for (const speed of [NaN, Infinity, -1]) assert.equal(strikeLevel("wind", speed, 3, 0.1), 0);
console.log("PASS: link density preserves power, slow-motion fade, isolated impact dynamics, invalid speeds");

// A 3-frame loss of rim contact in session-109f must fade immediately without
// nearly muting the rolling bed; sustained flight must still reach silence.
const residual = (frames: number) => Math.exp(-frames / 60 / loopGainFollow("roll"));
assert.ok(residual(1) < 1, "contact loss starts the fade immediately");
assert.ok(residual(3) > 0.4, "a brief hop does not chop the rolling bed off");
assert.ok(residual(18) < 0.01, "sustained flight fades below one percent");
assert.equal(loopGainFollow("whoosh"), 1 / 60, "other loop envelopes keep their timing");
const loopBank: SoundBank = { slots: {
  "loop-hit": { sounds: ["loop"], volume: -40 },
  "land-light": { sounds: ["ball"], volume: 0 },
} };
assert.equal(resolveSlot(loopBank, "loop-hit", "stone")!.params.volume, -40, "loop volume is independent of ball landing volume");
assert.equal(resolveSlot({ slots: { "land-light": { sounds: ["ball"] } } }, "loop-hit", "stone"), null, "unassigned loop has no ball landing fallback");
console.log("PASS: short-hop roll envelope, airborne fade, independent loop impact volume and silence");

assert.ok(Math.exp(-0.007 / loopGainFollow("deploy")) < 0.001, "deployment reaches silence within 7 ms of attachment");

// Actual automation commands reach zero exactly when the pitched window ends.
for (const seconds of [0.001, 0.01, 0.04, 0.136, 0.85]) {
  const commands: { value: number; time: number }[] = [];
  const capture = (value: number, time: number) => { commands.push({ value, time }); return {} as AudioParam; };
  scheduleShotEnvelope({ setValueAtTime: capture, linearRampToValueAtTime: capture }, 0.3, 2, seconds);
  assert.deepEqual(commands[0], { value: 0, time: 2 });
  assert.deepEqual(commands.at(-1), { value: 0, time: 2 + seconds });
  assert.ok(commands.every((c, i) => i === 0 || c.time >= commands[i - 1]!.time), "short windows never reverse envelope time");
  assert.ok(commands.every(c => c.value >= 0 && c.value <= 0.3));
}
console.log("PASS: cropped one-shots have bounded onset/release fades and end at silence");
for (const family of ["chain-drag", "hook-drag"] as const) {
  assert.ok(Math.exp(-0.035 / loopGainFollow(family)) < 0.001, "scrapes reach near-silence within 35 ms of stopping");
}
