// Check event gating and the read-only observer boundary, not whether a
// particular timbre or volume sounds right. Listening remains the user's test.
import { strict as assert } from "node:assert";
import { SoundObserver } from "../src/audio/soundObserver";
import { BallLevel } from "../src/level/ballLevel";
import { Vec2 } from "../src/engine/vec2";
import { emptyFrameInput } from "../src/input/frameInput";
import { StaticBody2D } from "../src/engine/body";
import { RopeContact, RopeWrap } from "../src/lib/ropeContact";
import { WrapDirection } from "../src/lib/types";

const dt = 1 / 60;
const level = new BallLevel({ player: { x: 0, y: 0, radius: 8 }, bodies: [] });
const observer = new SoundObserver();
assert.equal(observer.observe(level, dt).deploy.speed, 0, "no deployment at startup");
let flightFrames = 0;
for (let frame = 0; frame < 24; frame++) {
  const input = emptyFrameInput();
  input.mouseWorldPosition = level.ball.globalPosition.add(new Vec2(2, 0));
  input.fire = { held: true, pressed: frame === 0, released: false };
  level.physicsProcess(input, dt);
  const before = level.bodies.map(b => [b.globalPosition.x, b.globalPosition.y, b.globalRotation, b.linearVelocity.x, b.linearVelocity.y]);
  const sound = observer.observe(level, dt);
  assert.deepEqual(level.bodies.map(b => [b.globalPosition.x, b.globalPosition.y, b.globalRotation, b.linearVelocity.x, b.linearVelocity.y]), before,
    "reading audio must not move a body or change its velocity");
  if (level.ball.hookInFlight) {
    flightFrames++;
    assert.ok(sound.deploy.speed > 0, "payout rattles throughout flight");
    assert.equal(sound.slack.speed, 0, "no slack loop layered over flight");
    assert.equal(sound.creak.speed, 0, "no loaded creak during deployment");
  } else {
    assert.equal(sound.deploy.speed, 0, "payout stops on the exact step flight ends");
  }
}
assert.ok(flightFrames > 1, "real throw ran for several steps");
assert.equal(observer.observe(level, dt).deploy.speed, 0, "deployment stops after the throw");
assert.ok(level.ball.chain && level.ball.chainSlack);
const chain = level.ball.chain;
chain.maxRopeLength = chain.getCurrentLength() + 1;
let nodes = [new Vec2(0, 0), new Vec2(0.4, 0.2), new Vec2(0.8, 0.2), new Vec2(1.2, 0)];
level.ball.chainSlack.nodePositions = () => nodes;
assert.equal(observer.observe(level, dt).slack.speed, 0, "new drape has no motion baseline");
nodes = nodes.map((p, i) => i === 1 ? p.add(new Vec2(0, 0.02)) : p);
assert.ok(observer.observe(level, dt).slack.speed > 0, "airborne loose links rattle without ground contacts");
assert.equal(observer.observe(level, dt).slack.speed, 0, "stationary slack is silent");
nodes = nodes.map(p => p.add(new Vec2(0.03, 0)));
assert.ok(observer.observe(level, dt).slack.speed > 0, "dragging a slack chain rattles");
chain.maxRopeLength = chain.getCurrentLength();
nodes = nodes.map(p => p.add(new Vec2(0.03, 0)));
const caught = observer.observe(level, dt);
assert.equal(caught.slack.speed, 0, "a moving taut chain has no slack rattle");
assert.ok(caught.taut && caught.taut.speed > 0, "taking up moving slack gives one catch cue");
assert.equal(observer.observe(level, dt).taut, null, "remaining taut does not repeat the catch cue");
chain.maxRopeLength = chain.getCurrentLength() + 0.02;
observer.observe(level, dt);
chain.maxRopeLength = chain.getCurrentLength();
assert.equal(observer.observe(level, dt).taut, null, "tiny slack fluctuations do not rearm the catch");
chain.maxRopeLength = chain.getCurrentLength() + 1;
level.ball.chainStowed = true;
assert.equal(observer.observe(level, dt).slack.speed, 0, "stowed chain is silent");
level.ball.chainStowed = false;
const fresh = new SoundObserver();
assert.equal(fresh.observe(level, dt).deploy.speed, 0, "existing spawn chain does not count as a new throw");
chain.maxRopeLength = chain.getCurrentLength();
level.chainTension = level.ball.mass * 9.81;
let angle = 0;
chain.startPull = () => new Vec2(Math.cos(angle), Math.sin(angle));
observer.observe(level, dt);
angle += 0.02;
assert.ok(observer.observe(level, dt).creak.speed > 0, "loaded taut chain creaks as its direction changes");
angle += 0.02;
assert.equal(observer.observe(level, dt).creaks.length, 1, "actual angular travel triggers a short onset phrase");
assert.equal(observer.observe(level, dt).creaks.length, 0, "a stationary frame cannot retrigger a phrase");
let phrases = 0;
for (let i = 0; i < 60; i++) {
  angle += dt;
  phrases += observer.observe(level, dt).creaks.length;
}
assert.ok(phrases >= 2 && phrases <= 4, "continued motion emits spaced phrases, not one per frame");
assert.equal(observer.observe(level, dt).creak.speed, 0, "a still loaded chain does not keep squeaking");
level.chainTension = 0;
angle += 0.02;
assert.equal(observer.observe(level, dt).creak.speed, 0, "motion without chain load does not creak");
level.chainTension = level.ball.mass * 9.81;
chain.maxRopeLength = chain.getCurrentLength() + 1;
angle += 0.02;
assert.equal(observer.observe(level, dt).creak.speed, 0, "loose links use slack rattle, not the taut creak");
chain.maxRopeLength = chain.getCurrentLength();
level.ball.chainStowed = true;
angle += 0.02;
assert.equal(observer.observe(level, dt).creak.speed, 0, "a stowed chain does not creak");
level.ball.chainStowed = false;
observer.observe(level, dt);
const corner = new StaticBody2D();
corner.globalPosition = level.ball.globalPosition.add(new Vec2(0.7, 0.4));
corner.setShape({ kind: "rect", w: 0.2, h: 0.2 });
corner.primaryShape().material = "stone";
const wrapAt = (offset: number) => new RopeWrap(new RopeContact(corner, new Vec2(offset, -0.1)), WrapDirection.Clockwise);
chain.wraps = [wrapAt(0.1)];
chain.maxRopeLength = chain.getCurrentLength();
const wrapped = observer.observe(level, dt);
assert.equal(wrapped.wraps.length, 1, "a new taut loaded scenery contact makes a sound");
assert.equal(wrapped.wraps[0]!.surface, "stone", "wrap cue carries contact material");
assert.equal(wrapped.wraps[0]!.x, chain.wraps[0]!.contact.globalPosition.x, "sound is placed at the corner");
assert.equal(wrapped.wraps[0]!.y, chain.wraps[0]!.contact.globalPosition.y, "wrap elevation comes from its actual contact");
for (let i = 0; i < 15; i++) {
  chain.wraps = [wrapAt(0.1)];
  assert.equal(observer.observe(level, dt).wraps.length, 0, "regenerated nodes at a stationary wrap do not retrigger");
}
chain.wraps = [];
observer.observe(level, dt);
chain.wraps = [wrapAt(0.1)];
assert.equal(observer.observe(level, dt).wraps.length, 0, "one-frame topology flicker is not a fresh impact");
for (let i = 0; i < 12; i++) observer.observe(level, dt);
chain.wraps = [wrapAt(0.18)];
chain.maxRopeLength = chain.getCurrentLength();
const feeding = observer.observe(level, dt).wraps;
assert.equal(feeding.length, 1, "rapid link crossings group into one crisp contact gesture");
assert.ok(feeding[0]!.at! >= 0 && feeding[0]!.at! <= 1, "contact gesture is scheduled inside the step");
for (let i = 1; i <= 2; i++) {
  chain.wraps = [wrapAt(0.18 + i * 0.08)];
  chain.maxRopeLength = chain.getCurrentLength();
  assert.equal(observer.observe(level, dt).wraps.length, 0, "fast feeding cannot buzz several times per frame or during cooldown");
}
assert.equal(observer.observe(level, dt).wraps.length, 0, "there is no queued impact backlog after travel stops");
const contactPoint = chain.wraps[0]!.contact.globalPosition;
const endBody = chain.end.contact.obj;
const endOffset = chain.end.contact.globalPosition.sub(endBody.globalPosition);
for (let i = 0; i < 20; i++) {
  const theta = i * 0.12;
  endBody.globalPosition = contactPoint.add(new Vec2(Math.cos(theta), Math.sin(theta)).mul(1.2)).sub(endOffset);
  chain.maxRopeLength = chain.getCurrentLength();
  assert.equal(observer.observe(level, dt).wraps.length, 0, "changing only bend angle does not emit link impacts");
}
chain.maxRopeLength = chain.getCurrentLength() + 1;
chain.wraps = [wrapAt(0.26)];
assert.equal(observer.observe(level, dt).wraps.length, 0, "a slack geometry contact does not emit taut friction");
chain.wraps = [new RopeWrap(new RopeContact(level.ball, new Vec2(0.08, 0)), WrapDirection.Clockwise)];
chain.maxRopeLength = chain.getCurrentLength();
assert.equal(observer.observe(level, dt).wraps.length, 0, "self-coiling is not scenery contact");
level.ball.chain = null;
assert.equal(observer.observe(level, dt).slack.speed, 0, "removed chain is silent");
console.log("PASS: deploy/slack/taut; movement-triggered creak phrases; geometry contact/slide/material/pan; topology flicker suppression; read-only bodies");

// Actual contact telemetry: each physical node arrival is a small clink,
// independent of a full-chain landing latch or fixed rattle loop.
const { ChainSurfaceAudio } = await import("../src/audio/chainSurfaceAudio");
const { ChainArticulationAudio } = await import("../src/audio/chainArticulationAudio");
const surfaces = new ChainSurfaceAudio();
const floor = new StaticBody2D();
floor.setShape({ kind: "rect", size: new Vec2(10, 0.2) });
floor.primaryShape().material = "stone";
const excluded = level.ball;
const hit = (node: number, x: number, normalSpeed = 1, slideSpeed = 0) => ({
  node, shape: floor.primaryShape(), point: new Vec2(x, -0.109), normal: Vec2.UP, normalSpeed, slideSpeed,
});
surfaces.observe([], dt, excluded, 0);
let probe = surfaces.observe([hit(1, 0), hit(1, 0), hit(2, 0.03)], dt, excluded, 0);
assert.equal(probe.impacts.length, 1, "adjacent arrivals group; duplicate solver reports never double-trigger");
assert.ok(probe.impacts[0]!.speed > 1, "neighbouring arrivals contribute bounded energy");
assert.equal(probe.impacts[0]!.surface, "stone");
assert.equal(probe.impacts[0]!.y, -0.109, "impact retains its world height for camera-relative audio");
for (let i = 0; i < 30; i++) {
  probe = surfaces.observe([hit(1, 0), hit(2, 0.03)], dt, excluded, 0);
  assert.equal(probe.impacts.length, 0, "persistent contact is silent even if telemetry reports inward velocity");
}
probe = surfaces.observe([hit(1, 0), hit(2, 0.03), hit(3, 0.3)], dt, excluded, 0);
assert.equal(probe.impacts.length, 1, "later links make their own small contact, without a whole-drop recording");
probe = surfaces.observe([hit(1, 0, 0, 1)], dt, excluded, 0);
assert.ok(probe.drag, "surface sliding is independent of impact arrival");
probe = surfaces.observe([hit(1, 0, 0, 0)], dt, excluded, 0);
assert.equal(probe.drag, null, "resting contacts never scrape");
probe = surfaces.observe([hit(5, 0.8, 3, 1)], dt, excluded, 1);
assert.equal(probe.drag, null);
assert.equal(probe.impacts.length, 0, "full submersion suppresses dry sounds");
surfaces.reset();
assert.equal(surfaces.observe([hit(1, 0)], dt, excluded, 0).impacts.length, 0, "initial contacts establish a silent baseline");
surfaces.observe([], dt, excluded, 0);
for (let i = 0; i < 5; i++) surfaces.observe([], dt, excluded, 0);
assert.equal(surfaces.observe([hit(1, 0)], dt, excluded, 0).impacts.length, 1, "a genuinely separated node can land again");
console.log("PASS: contact-driven clinks, duplicate/settled suppression, spatial grouping, slide and rearming");

const articulation = new ChainArticulationAudio();
const drapeAt = (x: number, y: number) => [new Vec2(-1 + x, 0), new Vec2(x, y), new Vec2(1 + x, 0)];
assert.equal(articulation.observe(drapeAt(0, 0), dt, 0).length, 0);
assert.equal(articulation.observe(drapeAt(0.03, 0), dt, 0).length, 0, "rigid translation never invents link collisions");
assert.equal(articulation.observe(drapeAt(0.03, 0.2), dt, 0).length, 1, "local bending creates one gesture");
for (let i = 0; i < 10; i++) assert.equal(articulation.observe(drapeAt(0.03, 0.2), dt, 0).length, 0, "stationary curvature is silent without queued jingles");
assert.equal(articulation.observe(drapeAt(0.03, 0.4), dt, 1).length, 0, "underwater articulation is silent");
console.log("PASS: articulation follows local motion, not rigid translation or an autonomous loop");

// Hook scrape uses tangential speed even when taut, in either direction;
// strike arrival suppression must not also suppress continuing friction.
const hookObserver = new SoundObserver();
level.ball.chainStowed = false;
level.ball.chain = chain;
chain.maxRopeLength = chain.getCurrentLength();
hookObserver.observe(level, dt);
for (const sign of [1, -1]) {
  level.soundEvents.length = 0;
  level.soundEvents.push({ kind: "bounce", source: 10000, body: floor, piece: floor.primaryShape(),
    point: new Vec2(0, 0), normal: new Vec2(-1, 0), vel: new Vec2(0, sign * 2), fromFlight: false });
  const cue = hookObserver.observe(level, dt);
  assert.equal(cue.hookDrag?.speed, 2, "downward and upward slides have the same scrape intensity on a taut chain");
}
level.soundEvents.length = 0;
assert.equal(hookObserver.observe(level, dt).hookDrag, undefined, "losing contact stops hook scraping");
console.log("PASS: independent hook scraping on both pull directions and contact loss");

// session-604f: cosmetic interior corrections must not keep a motionless
// taut chain scraping after the actual material and its ends stop travelling.
const actualSnapshot = level.ball.chainSlack!.contactSnapshot.bind(level.ball.chainSlack);
level.ball.chainSlack!.contactSnapshot = () => [hit(1, 0, 0, 1)];
chain.maxRopeLength = chain.getCurrentLength();
const stillTaut = new SoundObserver();
stillTaut.observe(level, dt);
for (let i = 0; i < 30; i++) {
  assert.equal(stillTaut.observe(level, dt).drag, null, "stationary taut ends suppress interior solver shuffle");
}
nodes = nodes.map(p => p.add(new Vec2(0.03, 0)));
assert.ok(stillTaut.observe(level, dt).drag, "genuine taut-chain travel still scrapes");
assert.equal(stillTaut.observe(level, dt).drag, null, "scraping stops on the first motionless step");
level.ball.chainSlack!.contactSnapshot = actualSnapshot;
console.log("PASS: taut solver jitter cannot sustain scraping; real travel starts and stops it");
