import { strict as assert } from "node:assert";
import { landingMix, type SoundBank } from "../src/audio/slots";

const bank: SoundBank = { slots: {
  "land-light": { sounds: ["dull-metal"] },
  "land-medium": { sounds: ["stone-light-4"] },
  "land-heavy": { sounds: ["stone-9"] },
  "land-medium.metal": { sounds: ["medium-metal"] },
} };
for (const [speed, key] of [[0.8, "land-light"], [3.5, "land-medium"], [8, "land-heavy"]] as const) {
  const mix = landingMix(bank, "stone", speed);
  assert.equal(mix.length, 1);
  assert.equal(mix[0]!.key, key, "strength chooses a different recording family");
  assert.equal(mix[0]!.weight, 1);
}
for (const speed of [1.21, 1.8, 2.39, 4.51, 5.5, 6.49]) {
  const mix = landingMix(bank, "stone", speed);
  assert.equal(mix.length, 2, "transition blends only neighboring strengths");
  assert.ok(Math.abs(mix.reduce((sum, layer) => sum + layer.weight ** 2, 0) - 1) < 1e-12, "crossfade preserves total weight power");
}
assert.equal(landingMix(bank, "metal", 3.5)[0]!.key, "land-medium.metal", "material override is resolved within the selected strength");
assert.equal(landingMix(bank, "metal", 8)[0]!.key, "land-heavy", "another strength falls back to its own default");
const legacy: SoundBank = { slots: { land: { sounds: ["old-landing"] } } };
for (const speed of [0.8, 1.8, 3.5, 5.5, 8]) {
  const mix = landingMix(legacy, "stone", speed);
  assert.equal(mix.length, 1, "legacy fallback does not double-play the same slot in a crossfade");
  assert.equal(mix[0]!.key, "land");
  assert.ok(Math.abs(mix[0]!.weight - 1) < 1e-12);
}
for (const speed of [0, -1, Infinity, NaN]) assert.equal(landingMix(bank, "stone", speed).length, 0);
console.log("PASS: light/medium/heavy selection, adjacent crossfades, surface overrides, legacy fallback, invalid speeds");

// A landing requires force-bearing contact and a break in support, not a new
// piece of the same floor appearing in the speculative contact manifold.
const { SoundObserver } = await import('../src/audio/soundObserver');
const { BallLevel } = await import('../src/level/ballLevel');
const { StaticBody2D } = await import('../src/engine/body');
const { Vec2 } = await import('../src/engine/vec2');
const level = new BallLevel({ player: { x: 0, y: 0, radius: 8 }, bodies: [] });
const observer = new SoundObserver();
const pieces = Array.from({ length: 3 }, () => {
  const body = new StaticBody2D(); body.setShape({ kind: 'rect', w: 1, h: 0.1 }); return body;
});
type Contact = typeof level.world.frameContacts[number];
const contact = (index: number, normal = new Vec2(0, -1), impulse = 1): Contact => ({
  a: level.ball, b: pieces[index]!, shapeA: 0, shapeB: 0,
  point: Vec2.ZERO, normal, depth: 0, normalImpulse: impulse, maxNormalImpulse: impulse,
} as Contact);
const read = (contacts: Contact[], velocity = new Vec2(1, 0)) => {
  level.ball.linearVelocity = velocity;
  level.world.frameContacts = contacts;
  return observer.observe(level, 1 / 60).strikes.filter(c => c.family === 'land');
};
read([], new Vec2(0, 1));
assert.equal(read([contact(0)]).length, 1, 'initial real landing is audible');
assert.equal(read([contact(0), contact(1, new Vec2(-0.3, -Math.sqrt(0.91)), 0)]).length, 0, 'speculative neighbor is not a landing');
assert.equal(read([contact(1, new Vec2(-0.3, -Math.sqrt(0.91)))]).length, 0, 'support transfer across floor facets is rolling');
assert.equal(read([contact(1), contact(2, new Vec2(-1, 0))]).length, 1, 'a wall impact remains audible while grounded');
for (let i = 0; i < 4; i++) read([], new Vec2(0, 1));
assert.equal(read([contact(1)]).length, 1, 'genuine airborne return rearms landing');
console.log('PASS: speculative contact rejection, seam continuity, wall strikes, airborne rearming');

// The rim staying grounded must not mask the mounting ring's first strike.
const loopLevel = new BallLevel({ player: { x: 0, y: 0, radius: 8 }, bodies: [] });
const loopObserver = new SoundObserver();
const floor = new StaticBody2D(); floor.setShape({ kind: 'rect', w: 2, h: 0.1 });
const loopContact = (shape: number, impulse = 1): Contact => ({
  a: loopLevel.ball, b: floor, shapeA: shape, shapeB: 0,
  point: loopLevel.ball.globalPosition.add(new Vec2(0.1, 0.1)),
  normal: new Vec2(0, -1), depth: 0, normalImpulse: impulse, maxNormalImpulse: impulse,
} as Contact);
const observeLoop = (contacts: Contact[]) => {
  loopLevel.world.frameContacts = contacts;
  loopLevel.ball.linearVelocity = Vec2.ZERO;
  loopLevel.ball.angularVelocity = 5;
  return loopObserver.observe(loopLevel, 1 / 60).strikes;
};
observeLoop([loopContact(0)]);
assert.equal(observeLoop([loopContact(0), loopContact(1, 0)]).length, 0, 'speculative loop is silent');
const loopHit = observeLoop([loopContact(0), loopContact(1)]);
assert.equal(loopHit.length, 1, 'loop can strike the same ground while rim remains supported');
assert.equal(loopHit[0]!.source, 'loop');
assert.equal(loopHit[0]!.family, 'loop-hit', 'loop uses its own volume/recording slot rather than ball landing strengths');
assert.ok(loopHit[0]!.speed > 0.5, 'loop strike includes rotational point speed, not only centre speed');
for (let i = 0; i < 8; i++) assert.equal(observeLoop([loopContact(0), loopContact(1)]).length, 0, 'resting/riding loop does not chatter');
for (let i = 0; i < 4; i++) observeLoop([loopContact(0)]);
assert.equal(observeLoop([loopContact(0), loopContact(1)]).length, 1, 'loop lifting clear rearms another genuine strike');
console.log('PASS: independent loop strike, rotational approach speed, persistent-contact silence, loop rearming');

// Both circles can roll; speed follows geometric contact travel, not the
// avatar centre or the zero material-point velocity of no-slip rolling.
const rolling = (contacts: Contact[]) => {
  loopLevel.world.frameContacts = contacts;
  loopLevel.ball.linearVelocity = new Vec2(1, 0);
  return loopObserver.observe(loopLevel, 1 / 60).roll;
};
assert.equal(rolling([loopContact(0)]).size, 1, 'moving rim contact rolls');
assert.equal(rolling([loopContact(0), loopContact(1)]).size, 1, 'rim and loop together still roll');
assert.equal(rolling([loopContact(1)]).size, 1, 'loop-only support can produce rolling');
assert.equal(rolling([loopContact(0, 0), loopContact(1)]).size, 1, 'real loop contact counts even without rim support');
const reversed = loopContact(1);
assert.equal(rolling([{ ...reversed, a: reversed.b, b: reversed.a, shapeA: 0, shapeB: 1, normal: reversed.normal.neg() }]).size, 1, 'loop contact counts with ball on either side');
assert.equal(rolling([]).size, 0, 'airborne ball has no rolling cue');
assert.equal(rolling([loopContact(0)]).size, 1, 'rim touching down resumes rolling');
assert.equal(rolling([loopContact(0, 0), loopContact(1, 0)]).size, 0, 'speculative contacts alone are silent');

const speedOf = (shape: number, normal = new Vec2(0, -1)) => {
  loopLevel.world.frameContacts = [{ ...loopContact(shape), normal }];
  return [...loopObserver.observe(loopLevel, 1 / 60).roll.values()][0]!.speed;
};
rolling([]);
loopLevel.ball.angularVelocity = 0;
speedOf(1);
loopLevel.ball.globalPosition = loopLevel.ball.globalPosition.add(new Vec2(.001, 0));
assert.ok(Math.abs(speedOf(1) - .06) < 1e-6, 'loop patch moving 1 mm per step measures .06 m/s regardless of centre velocity');
assert.ok(speedOf(1) < 1e-8, 'fixed contact patch is silent even if stored centre velocity is nonzero');
// Carry the supporting floor and avatar together: no relative patch travel.
floor.globalPosition = floor.globalPosition.add(new Vec2(.02, 0));
loopLevel.ball.globalPosition = loopLevel.ball.globalPosition.add(new Vec2(.02, 0));
assert.ok(speedOf(1) < 1e-6, 'translating platform is removed from patch travel');
// Rotate the entire arrangement rigidly with the supporting body.
const angle = .2;
const before = loopLevel.ball.globalPosition.sub(floor.globalPosition);
floor.globalRotation += angle;
loopLevel.ball.globalPosition = floor.globalPosition.add(before.rotated(angle));
loopLevel.ball.globalRotation += angle;
assert.ok(speedOf(1, new Vec2(0, -1).rotated(angle)) < 1e-5, 'rotating platform is removed from patch travel');
console.log('PASS: sphere and loop patch migration, stationary patch, moving/rotating supports, speculative silence and flight');

const settleLevel = new BallLevel({ player: { x: 0, y: 0, radius: 8 }, bodies: [] });
const settleObserver = new SoundObserver();
const settleContact = (shape: number): Contact => ({ ...contact(0), a: settleLevel.ball, shapeA: shape });
const settleStep = (shapes: number[], velocity = Vec2.ZERO) => {
  settleLevel.world.frameContacts = shapes.map(settleContact);
  settleLevel.ball.linearVelocity = velocity;
  return settleObserver.observe(settleLevel, 1 / 60).strikes;
};
settleStep([0]);
settleStep([1]);
const returnTap = settleStep([0]);
assert.equal(returnTap.length, 1, 'return from loop-only support gets one cue despite recent ball support');
assert.equal(returnTap[0]!.family, 'ball-settle', 'return uses its quiet independent slot');
assert.equal(settleStep([0]).length, 0, 'continued sphere support does not repeat the return tap');
settleStep([1]);
for (let i = 0; i < 16; i++) settleStep([]);
assert.equal(settleStep([0])[0]!.family, 'land', 'long airborne return remains a normal landing');
settleStep([1], new Vec2(0, 5));
assert.equal(settleStep([0])[0]!.family, 'land', 'hard impact after the loop still uses the normal landing mix');
console.log('PASS: quiet sphere-return cue, single emission, expired support and hard-landing fallback');

// session-460f: adjacent pieces of one body intermittently share support.
// Their different normals are different patches, not metres of rolling travel.
const seamLevel = new BallLevel({ player: { x: 0, y: 0, radius: 8 }, bodies: [] });
const seamObserver = new SoundObserver();
const compound = new StaticBody2D();
compound.setShape({ kind: 'rect', w: 1, h: .1 });
compound.addShape({ kind: 'rect', w: 1, h: .1 });
for (let i = 0; i < 12; i++) {
  seamLevel.ball.linearVelocity = Vec2.ZERO;
  seamLevel.ball.angularVelocity = 0;
  seamLevel.world.frameContacts = [0, 1].filter(shape => shape === 1 || i % 3 === 0).map(shape => ({
    ...contact(0), a: seamLevel.ball, b: compound, shapeB: shape,
    normal: shape === 0 ? new Vec2(.213167, -.977016).normalized() : new Vec2(-.0759703, -.997110).normalized(),
  }));
  const speeds = [...seamObserver.observe(seamLevel, 1 / 60).roll.values()].map(s => s.speed);
  assert.ok(speeds.every(speed => speed < 1e-6), `stationary compound seam must not roll at frame ${i}: ${speeds}`);
}
console.log('PASS: stationary compound support cannot manufacture rolling motion');
