import { strict as assert } from "node:assert";
import { WindMotion } from "../src/audio/windMotion";
import { windLevel } from "../src/audio/playbackLevel";
import { SoundObserver } from "../src/audio/soundObserver";
import { BallLevel } from "../src/level/ballLevel";
import { Vec2 } from "../src/engine/vec2";
import { SOUND_BANK, resolveSlot } from "../src/audio/slots";
import { SOUND_ASSETS } from "../src/audio/library";

const dt = 1 / 60;
const motion = new WindMotion();
assert.equal(motion.observe(12, dt, 0).acceleration, 0, "spawning at speed cannot manufacture an acceleration burst");
motion.reset();
motion.observe(0, dt, 0);
let ramp = { speed: 0, acceleration: 0 };
for (let frame = 1; frame <= 120; frame++) ramp = motion.observe(frame * 6 * dt, dt, 0);
assert.ok(ramp.acceleration > 5.8 && ramp.acceleration <= 6.01, "gaining speed builds a bounded, responsive swell");
assert.ok(windLevel(10, ramp.acceleration, 12) > windLevel(10, 0, 12), "acceleration increases volume at the same speed");
const boost = ramp.acceleration;
const coast = motion.observe(12, dt, 0);
assert.ok(coast.acceleration < boost && coast.acceleration > 0, "coasting releases the swell smoothly");
let held = coast;
for (let i = 0; i < 120; i++) held = motion.observe(12, dt, 0);
assert.ok(held.acceleration < 1e-5, "constant speed retains the wind bed without sustained acceleration boost");
for (const speed of [0, 1, 2, 3]) assert.equal(windLevel(speed, 30, 12), 0, "walking never produces a wind rush");
assert.ok(windLevel(12, 0, 12) > windLevel(8, 0, 12));
assert.ok(windLevel(8, 0, 12) > windLevel(5, 0, 12));
assert.ok(windLevel(100, 100, 12) <= 2.2, "extreme speeds/acceleration cannot create unbounded gain");
assert.equal(windLevel(10, -10, 12), windLevel(10, 0, 12), "deceleration never adds a boost");
assert.deepEqual(motion.observe(14, dt, 1), { speed: 0, acceleration: 0 }, "fully submerged motion produces no dry wind");
for (let i = 0; i < 120; i++) motion.observe(14, dt, 1);
assert.ok(motion.observe(14, dt, 0).acceleration < 1e-5, "leaving water at unchanged speed creates no fake acceleration");

// Follow the observer's actual velocity path: changing direction alone is
// centripetal acceleration, not a gain in speed.
const level = new BallLevel({ player: { x: 0, y: 0, radius: 8 }, bodies: [] });
const observer = new SoundObserver();
for (let i = 0; i < 60; i++) {
  level.ball.linearVelocity = new Vec2(Math.cos(i / 10), Math.sin(i / 10)).mul(10);
  const air = observer.observe(level, dt).air;
  assert.ok(Math.abs(air.speed - 10) < 1e-10);
  assert.ok((air.acceleration ?? 0) < 1e-8, "constant-speed swing direction changes do not boost wind");
}
level.ball.linearVelocity = new Vec2(12, 0);
const accelerating = observer.observe(level, dt).air;
assert.ok(accelerating.acceleration! > 0, "speed gain flows through SoundStep to wind playback");
assert.equal(accelerating.x, level.ball.globalPosition.x);
assert.equal(accelerating.y, level.ball.globalPosition.y);
const slot = resolveSlot(SOUND_BANK, "whoosh", null)!;
assert.ok(slot && slot.params.sounds.length === 1 && SOUND_ASSETS[slot.params.sounds[0]!]);
assert.equal(slot.params.pitchFollow, 0, "source pitch stays stable while speed changes level");
assert.equal(slot.params.paceFollow, 0, "motion controls the swell instead of stretching the gust");
console.log("PASS: high-speed wind bed, acceleration swell/release, constant-speed swing, water suppression, gain bounds and assigned native-pitch source");
