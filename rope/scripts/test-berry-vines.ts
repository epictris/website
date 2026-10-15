// Berry vines (`level/starberry.ts`, docs/vines.md "Berry vines"): the format
// round trip and the fold of the retired arc fractions, that only a berry
// catches the hook, that the berry and nothing else on the vine meets the ball
// and the chain, the stalk bounds and replay identity, that a berry is built
// where it was placed, and the editor's berry placement. Ported from
// karin-lu's `add-boulder-and-root-generation` branch, with the berry-only,
// collision and explicit-placement checks added.
//
// Nothing here pins how a berry vine FEELS (its sway, its swing): those are
// played before they are written down (see the project's CLAUDE.md).

import assert from "node:assert/strict";
import { BallLevel } from "../src/level/ballLevel";
import { BallHook } from "../src/classes/ballHook";
import { Vec2 } from "../src/engine/vec2";
import { LAYER_HOOK, LAYER_PLAYER, LAYER_ROPE, VineLink } from "../src/engine/body";
import { button, emptyFrameInput } from "../src/input/frameInput";
import { cloneVine, modelFromDisk, modelToDisk, vineRestPath } from "../src/editor/model";
import { scaleLevelData, type RawLevelData } from "../src/level/levelFormat";
import {
  MAX_BERRY_RADIUS,
  MAX_STALK,
  MIN_BERRY_ALONG,
  MIN_STALK,
  berryOffset,
  berryRadius,
  minBerryVineLength,
  pointAlong,
  restStarberries,
  starberrySettings,
  DEFAULT_BERRY_DENSITY,
  DEFAULT_STALK_DENSITY,
  MIN_STALK_DENSITY,
  DEFAULT_STALK_STRETCH,
  MAX_STALK_STRETCH,
  berryMass,
  stalkCap,
  stalkMass,
  stalkReach,
} from "../src/level/starberry";
import { berryAlongAt, berryOffsets, growBerry, moveBerry, placeBerry, removeBerry, sizeBerry } from "../src/editor/berryEditing";
import { stemFraction } from "../src/render/starberryArt";
import { checkBallInvariants, worldDigestBall } from "../src/sim/trace";
import rawJson from "../levels/berry-test.json";

const raw = rawJson as RawLevelData;
const rounded = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "number" ? Math.round(v * 1e9) / 1e9 : v)));

// A copy of the garden whose first plant's berries are placed explicitly, in
// the file's pixels: one hanging left, one out to the right and up, one low.
const placedRaw = structuredClone(raw);
placedRaw.vines![0]!.starberry!.offsets = [
  { x: -45, y: 20 },
  { x: 40, y: -10 },
  { x: -10, y: 50 },
];
// ...each its own size.
placedRaw.vines![0]!.starberry!.radii = [12, 30, 20];
// The same garden in the current form: the berry vines' roots as lengths down
// the vine (pixels) rather than the retired arc fractions the file is in.
const inAlong = (data: RawLevelData): RawLevelData => {
  const out = structuredClone(data);
  for (const v of out.vines ?? []) {
    if (!v.starberry) continue;
    v.starberry.along = v.starberry.positions!.map((f) => f * v.length);
    delete v.starberry.positions;
  }
  return out;
};
const placedAlong = inAlong(placedRaw);

// --- the format ---------------------------------------------------------------

{
  const scaled = scaleLevelData(placedRaw, 0.01);
  assert.equal(scaled.vines![0]!.starberry!.radius, 0.15);
  assert.deepEqual(rounded(scaled.vines![0]!.starberry!.offsets), [
    { x: -0.45, y: 0.2 },
    { x: 0.4, y: -0.1 },
    { x: -0.1, y: 0.5 },
  ]);
  assert.deepEqual(rounded(scaled.vines![0]!.starberry!.radii), [0.12, 0.3, 0.2]);
  // The retired arc fractions fold into lengths down the vine, against the
  // length the file states (340 px), and are gone.
  assert.deepEqual(rounded(scaled.vines![0]!.starberry!.along), [1.02, 2.006, 2.958]);
  assert(!("positions" in scaled.vines![0]!.starberry!), "the fractions are folded away");
  assert.deepEqual(rounded(scaleLevelData(scaled, 100).vines), rounded(placedAlong.vines));
  assert.deepEqual(rounded(scaleLevelData(scaleLevelData(placedAlong, 0.01), 100).vines), rounded(placedAlong.vines));
  // A file naming no roots at all gets karin's three.
  const bare = structuredClone(placedRaw);
  delete bare.vines![0]!.starberry!.positions;
  assert.deepEqual(rounded(scaleLevelData(bare, 0.01).vines![0]!.starberry!.along), [0.952, 1.972, 2.992]);
  const model = modelFromDisk(placedRaw);
  assert.deepEqual(
    rounded(modelToDisk(model).vines!.map((v) => v.starberry)),
    rounded(placedAlong.vines!.map((v) => v.starberry)),
  );
  const clone = cloneVine(model.vines[0]!);
  clone.starberry!.offsets![0]!.x = 1;
  clone.starberry!.along[0] = 0.5;
  assert.equal(Math.round(model.vines[0]!.starberry!.along[0]! * 1e9) / 1e9, 1.02, "a cloned vine owns its berries");
  assert.equal(model.vines[0]!.starberry!.offsets![0]!.x, -0.45, "...and their offsets");
  // Settings: non-finite roots dropped and the rest kept in order, each with
  // its own offset, held on the vine and clear of its anchor; a stalk held to
  // its range in its own direction.
  const s = starberrySettings(
    {
      along: [NaN, 0.3, 0.01, 5],
      offsets: [{ x: 9, y: 9 }, { x: 0.3, y: 0 }, { x: 0, y: 5 }, { x: 0.01, y: 0 }],
      radius: NaN,
    },
    2,
  );
  assert.deepEqual(s.along, [0.3, MIN_BERRY_ALONG, 2]);
  assert.deepEqual(rounded(s.offsets), [{ x: 0.3, y: 0 }, { x: 0, y: MAX_STALK }, { x: MIN_STALK, y: 0 }]);
  // The masses are kept only where authored (a file without them round-trips
  // unchanged, above), and held to their range.
  assert(!("berryDensity" in s) && !("stalkDensity" in s) && !("stretch" in s), "unauthored densities and stretch stay absent");
  const heavy = starberrySettings({ along: [1], berryDensity: 3000, stalkDensity: 0.01, stretch: 7 }, 2);
  assert.equal(heavy.berryDensity, 3000);
  assert.equal(heavy.stalkDensity, MIN_STALK_DENSITY);
  assert.equal(heavy.stretch, MAX_STALK_STRETCH);
  // A berry vine is never shorter than its lowest root.
  assert.equal(minBerryVineLength(s, 0.1), 2);
  assert.equal(minBerryVineLength(undefined, 0.1), 0.1);
}
console.log("PASS save/load, unit conversion, the fractions' fold, clone isolation, setting validation");

// --- only the berries are targets ---------------------------------------------

{
  const level = new BallLevel(raw);
  for (const vine of level.vines) {
    if (!vine.starberry) {
      assert(vine.links.every((l) => (l.primaryShape().mask & LAYER_HOOK) !== 0), "a plain vine is still a target");
      continue;
    }
    assert(vine.links.every((l) => (l.primaryShape().mask & LAYER_HOOK) === 0), "the cord is no target");
    assert(vine.berries.every((b) => (b.joint.primaryShape().mask & LAYER_HOOK) === 0), "the stalk is no target");
    assert(vine.berries.every((b) => (b.fruit.primaryShape().mask & LAYER_HOOK) !== 0), "the berry is a target");
    assert(vine.links.every((l) => !l.isSolid && l.passable), "the cord passes through everything");
    assert(vine.berries.every((b) => !b.joint.isSolid && b.joint.passable), "...and so does the stalk");
    assert(
      vine.berries.every(
        (b) => b.fruit.isSolid && !b.fruit.passable && b.fruit.primaryShape().mask === (LAYER_PLAYER | LAYER_HOOK | LAYER_ROPE),
      ),
      "the berry is solid to the ball, the hook and the chain alone",
    );
  }
}
// A real fast hook flies through the cord and catches a berry - a sleeping one.
for (const target of ["cord", "berry"] as const) {
  const level = new BallLevel(raw);
  const vine = level.vines[0]!;
  const destination = target === "cord" ? vine.links[1]! : vine.berries[0]!.fruit;
  const hook = new BallHook();
  hook.globalPosition = destination.globalPosition.add(new Vec2(-0.35, 0));
  hook.linearVelocity = new Vec2(12, 0);
  hook.globalRotation = Math.PI;
  level.world.add(hook);
  let attached: unknown = null;
  hook.registerAttachmentCallback((body) => {
    attached = body;
  });
  for (let f = 0; f < 4; f++) hook.physicsStep(1 / 60);
  if (target === "cord") assert.notEqual(attached, destination, "the hook passes through the cord");
  else assert.equal(attached, destination, "the hook catches a sleeping berry");
}
console.log("PASS only the berries catch the hook");

// --- the masses an author sets ------------------------------------------------

{
  // A berry weighs its density times its drawn sphere: the default density
  // puts the default 0.15 m berry at 9 kg, and a berry twice the radius at
  // eight times that.
  assert(Math.abs(berryMass(0.15, {}) - 9) < 0.06, `a default berry weighs 9 kg (${berryMass(0.15, {}).toFixed(2)})`);
  assert(Math.abs(berryMass(0.3, {}) / berryMass(0.15, {}) - 8) < 1e-9, "weight goes as the cube of the radius");
  // A stem weighs the stalk's density times its reach: the default stalk
  // (0.38 m, in the plane as drawn) is 3.2 kg.
  assert.equal(stalkReach(0.38), 0.38, "the reach is the drawn length, in the plane");
  assert.equal(stalkReach(0.01), MIN_STALK, "...and no shorter than the shortest stalk");
  assert(Math.abs(stalkMass(stalkReach(0.38), {}) - 3.15) < 0.06, `a default stem weighs 3.2 kg (${stalkMass(stalkReach(0.38), {}).toFixed(2)})`);
  assert(Math.abs(stalkMass(1, {}) / stalkMass(0.5, {}) - 2) < 1e-9, "weight goes with the reach");
  const level = new BallLevel(raw);
  for (const vine of level.vines) {
    for (const berry of vine.berries) {
      assert.equal(berry.fruit.mass, berryMass(berry.radius, {}), "a plant that does not say builds at the default density");
      assert.equal(berry.joint.mass, stalkMass(berry.reach, {}), "...and the default stalk density");
    }
  }
  const heavy = structuredClone(placedRaw);
  heavy.vines![0]!.starberry!.berryDensity = 2000;
  heavy.vines![0]!.starberry!.stalkDensity = 20;
  const built = new BallLevel(heavy);
  const radii = built.vines[0]!.berries.map((b) => b.radius);
  assert(new Set(radii).size === 3, "the placed plant's berries are three sizes");
  assert(new Set(built.vines[0]!.berries.map((b) => b.reach)).size === 3, "...on three lengths of stalk");
  for (const berry of built.vines[0]!.berries) {
    assert.equal(berry.fruit.mass, 2000 * ((4 / 3) * Math.PI * berry.radius * berry.radius * berry.radius), "an authored density is built, per berry's own size");
    assert.equal(berry.joint.mass, 20 * berry.reach, "...and the stem's, per stalk's own reach");
    assert(berry.fruit.inertia > 0, "the berry's inertia follows its mass");
  }
  for (const berry of built.vines[1]!.berries) assert.equal(berry.fruit.mass, berryMass(berry.radius, {}), "the other plant is untouched");
  // The numbers survive the editor's round trip, scaled by nothing.
  const model = modelFromDisk(heavy);
  assert.equal(model.vines[0]!.starberry!.berryDensity, 2000);
  assert.equal(modelToDisk(model).vines![0]!.starberry!.berryDensity, 2000);
  assert.equal(modelToDisk(model).vines![0]!.starberry!.stalkDensity, 20);
  assert.equal(DEFAULT_BERRY_DENSITY, 640);
  assert.equal(DEFAULT_STALK_DENSITY, 8.3);
}
console.log("PASS berry and stem masses: defaults, authored, built, round-tripped");

// --- the stalk's stretch -------------------------------------------------------

// A stalk's ropes stand the plant's `stretch` of its reach over it, so a pull
// along the stalk is the clamp's spring up to the cap and a rope only past
// it. The cap is what the build hands its ropes and what the invariant holds
// a stalk to; the reach is still the stalk's own length (where it is drawn,
// what its stem weighs).
{
  const stretched = structuredClone(placedRaw);
  stretched.vines![0]!.starberry!.stretch = 0.25;
  const level = new BallLevel(stretched);
  for (const berry of level.vines[0]!.berries) {
    assert(Math.abs(berry.cap - berry.reach * 1.25) < 1e-12, "an authored stretch caps the stalk at its reach plus that fraction");
    assert.equal(berry.cap, stalkCap(berry.reach, { stretch: 0.25 }));
    assert.equal(berry.joint.mass, stalkMass(berry.reach, {}), "the stem weighs its reach, not its cap");
  }
  for (const berry of level.vines[1]!.berries) {
    assert.equal(berry.cap, stalkCap(berry.reach, {}), "a plant that does not say caps at the default");
    assert(Math.abs(berry.cap - berry.reach * (1 + DEFAULT_STALK_STRETCH)) < 1e-12);
  }
  // A berry drawn straight out to its cap by hand is within the invariant's
  // bar; one past it is the stretch the invariant reports.
  const vine = level.vines[0]!;
  const berry = vine.berries[0]!;
  const root = vine.links[berry.parentIndex]!.globalPosition;
  const out = berry.fruit.globalPosition.sub(root).normalized();
  const was = berry.fruit.globalPosition;
  berry.fruit.globalPosition = root.add(out.mul(berry.cap + 0.04));
  assert(!checkBallInvariants(level).some((v) => v.kind === "starberry-stretch"), "a stalk at its cap is no stretch");
  berry.fruit.globalPosition = root.add(out.mul(berry.cap + 0.06));
  assert(checkBallInvariants(level).some((v) => v.kind === "starberry-stretch"), "...past it is");
  berry.fruit.globalPosition = was;
  // The fraction survives the editor's round trip, scaled by nothing, and a
  // file that never said it stays without it.
  const model = modelFromDisk(stretched);
  assert.equal(model.vines[0]!.starberry!.stretch, 0.25);
  assert.equal(modelToDisk(model).vines![0]!.starberry!.stretch, 0.25);
  assert(!("stretch" in modelToDisk(modelFromDisk(structuredClone(placedRaw))).vines![0]!.starberry!), "unauthored stretch stays absent");
  assert.equal(DEFAULT_STALK_STRETCH, 0.5);
}
console.log("PASS the stalk's stretch: capped at reach plus the fraction, invariant follows, round-tripped");

// --- built where it was placed -------------------------------------------------

// Each berry stands, once its vine has settled, where the editor drew it: on
// the vine's rest path at its root, plus its offset. Its weight bends the
// plant, and the build aims each stalk to take that up (`aimBerries`); what is
// left over is the sway the plant fell asleep with.
for (const data of [raw, placedRaw]) {
  const level = new BallLevel(structuredClone(data));
  const model = modelFromDisk(structuredClone(data));
  for (const [vi, vine] of level.vines.entries()) {
    if (!vine.starberry) continue;
    const path = vineRestPath(model, model.vines[vi]!)!;
    const settings = starberrySettings(model.vines[vi]!.starberry, model.vines[vi]!.length);
    for (const [i, berry] of vine.berries.entries()) {
      const placed = pointAlong(path, settings.along[i]!).add(berryOffset(i, settings));
      const off = berry.fruit.globalPosition.distanceTo(placed);
      assert(off < 0.01, `vine ${vi} berry ${i} hangs ${(off * 1000).toFixed(1)} mm from where it was placed`);
      // ...and its stalk is drawn leaving the cord where the editor draws it:
      // its authored length down the settled cord, not the link it is tied to.
      const rootOff = vine.berryPoses!(1)[i]!.root.distanceTo(pointAlong(path, settings.along[i]!));
      // Within a centimetre for a berry of the default weight. The cord's
      // own give under a berry is not aimed (see docs/vines.md), so a heavy
      // one stretches the cord above its root: the placed plant's 0.30 m
      // berry weighs 72 kg at the default density and leaves its root 16 mm
      // down the settled cord.
      const rootBar = berry.fruit.mass > 10 ? 0.02 : 0.01;
      assert(
        rootOff < rootBar,
        `vine ${vi} berry ${i}'s stalk leaves the cord ${(rootOff * 1000).toFixed(1)} mm from where it was placed (${berry.fruit.mass.toFixed(1)} kg, bar ${rootBar * 1000})`,
      );
      // ...at its own size, which is the hook's target too.
      assert.equal(berry.radius, berryRadius(i, settings));
      const target = berry.fruit.primaryShape().shape;
      assert(target.kind === "circle" && Math.abs(target.radius - berry.radius * 0.95) < 1e-12);
    }
  }
}
console.log("PASS each berry is built where it was placed");

// --- the stalk's stiffness is internal to the plant ----------------------------

// A stalk's stiffness bends the plant and cannot push it. Held by a constraint
// whose root end was immovable - a clamp toward a WORLD direction - a berry
// dragged off its rest by the chain was pushed back with nothing pushing the
// cord the other way: session-97f, the ball hooked a berry standing out right
// of the cord from below-left, and the plant and the ball gained 220 kg·m/s
// rightward in ten frames, the whole vine swinging away from the pull. So: one
// pass of the stalk's constraints from a dragged pose moves the plant's mass
// (Σ m·x, the momentum a position solve pays out) by nothing, and turning the
// whole plant rigidly about its anchor changes nothing they ask for - they
// hold the stalk to the cord, not to the world.
{
  const level = new BallLevel(structuredClone(raw));
  const vine = level.vines[0]!;
  const stalkBends = (plant: typeof vine) =>
    plant.bends.filter((bend) => {
      let holds = false;
      bend.eachBody((body) => (holds ||= plant.berries.some((b) => b.joint === body || b.fruit === body)));
      return holds;
    });
  const bends = stalkBends(vine);
  assert(bends.length > 0, "a stalk has stiffness");
  const mass = (): Vec2 => vine.allLinks.reduce((sum, link) => sum.add(link.globalPosition.mul(link.mass)), Vec2.ZERO);
  const berry = vine.berries[1]!;
  berry.fruit.globalPosition = berry.fruit.globalPosition.add(new Vec2(-0.2, 0.1));
  const before = mass();
  for (const bend of bends) {
    bend.beginFrame(1 / 60);
    bend.solve(1 / 60);
  }
  const pushed = mass().sub(before);
  assert(pushed.length() < 1e-9, `the stalk's stiffness moves the plant by ${pushed.length().toFixed(4)} kg·m`);

  const plant = new BallLevel(structuredClone(raw)).vines[0]!;
  const asked = () => stalkBends(plant).map((bend) => (bend.beginFrame(1 / 60), bend.residual));
  const upright = asked();
  const pivot = plant.anchorContact.globalPosition;
  for (const link of plant.allLinks) link.globalPosition = pivot.add(link.globalPosition.sub(pivot).rotated(0.4));
  const change = Math.max(...asked().map((r, i) => Math.abs(r - upright[i]!)));
  assert(change < 1e-9, `a rigidly turned plant asks its stalks for ${(change * 1000).toFixed(1)} mm more`);
}
console.log("PASS a stalk's stiffness bends the plant and cannot push it");

// --- a real throw: catch, swing, release ---------------------------------------

const setup = structuredClone(raw);
setup.player.x = -140;
setup.player.y = -130;
setup.bodies![0]!.y = 600;
function exercise(): string[] {
  const level = new BallLevel(structuredClone(setup));
  const vine = level.vines[0]!;
  const fruit = vine.berries[1]!.fruit;
  const digests: string[] = [];
  let prev = emptyFrameInput();
  let caught = false;
  for (let f = 0; f < 420; f++) {
    const input = {
      ...emptyFrameInput(),
      fire: button(f >= 10 && f < 300, prev.fire),
      mouseWorldPosition: fruit.globalPosition,
    };
    prev = input;
    level.physicsProcess(input, 1 / 60);
    const chain = level.ball.chain;
    if (chain?.end.contact.obj === fruit) {
      caught = true;
      // A cuff bolted to a berry is in the way of what the berry is, and of
      // nothing else.
      for (const piece of fruit.getShapes().slice(1)) {
        assert.equal(piece.mask, LAYER_PLAYER | LAYER_HOOK, "the cuff on a berry meets the ball and the hook alone");
      }
    }
    // The chain wraps no cord or stalk...
    for (const wrap of chain?.wraps ?? []) {
      const obj = wrap.contact.obj;
      assert(!(obj instanceof VineLink) || obj.solid, "the chain wraps no cord or stalk");
    }
    // ...and the ball meets a vine only at a berry.
    for (const contact of level.world.frameContacts) {
      for (const [side, other] of [[contact.a, contact.b], [contact.b, contact.a]] as const) {
        if (!(side instanceof VineLink)) continue;
        assert(side.solid && (other === level.ball || other instanceof BallHook), "only the ball and its hook meet a vine, and only at a berry");
      }
    }
    assert.deepEqual(checkBallInvariants(level).filter((v) => v.kind.startsWith("starberry-")), []);
    const digest = worldDigestBall(level);
    assert(digest.bodies.some((b) => b.id === fruit.buildIndex), "berries are in the replay digest");
    digests.push(JSON.stringify(digest));
  }
  assert(caught, "the thrown hook catches the berry");
  assert.equal(vine.lra, null);
  assert.equal(vine.heldBerry, null);
  return digests;
}
assert.deepEqual(exercise(), exercise(), "a berry vine replays bit-identical");
console.log("PASS berry catch, stalk bounds, release, collision only at the berry, deterministic replay");

// The ball dropped onto a sleeping berry a little off its centre lands on it -
// it is not let through - wakes its vine and knocks the berry aside, and rolls
// off it. Dropped onto the cord or a stalk, it falls as if they were not there.
{
  const probe = new BallLevel(structuredClone(setup));
  const at = probe.vines[0]!.berries[1]!.fruit.globalPosition;
  const data = structuredClone(setup);
  data.player.x = at.x * 100 + 6;
  data.player.y = at.y * 100 - 45;
  const level = new BallLevel(data);
  const vine = level.vines[0]!;
  const fruit = vine.berries[1]!.fruit;
  const rest = fruit.globalPosition;
  assert(vine.asleep, "the vine is asleep before the ball arrives");
  const reach = level.ball.primaryShape().shape;
  const berryShape = fruit.primaryShape().shape;
  assert(reach.kind === "circle" && berryShape.kind === "circle");
  let met = false;
  let deepest = 0;
  let knocked = 0;
  for (let f = 0; f < 45; f++) {
    level.physicsProcess(emptyFrameInput(), 1 / 60);
    met ||= level.world.frameContacts.some((c) => (c.a === fruit && c.b === level.ball) || (c.b === fruit && c.a === level.ball));
    const gap = level.ball.globalPosition.distanceTo(fruit.globalPosition) - reach.radius - berryShape.radius;
    deepest = Math.min(deepest, gap);
    knocked = Math.max(knocked, fruit.globalPosition.distanceTo(rest));
    assert.deepEqual(checkBallInvariants(level).filter((v) => v.kind.startsWith("starberry-")), []);
  }
  assert(met, "the ball meets the berry");
  assert(deepest > -0.02, `the ball does not sink into the berry (${(deepest * 1000).toFixed(1)} mm)`);
  assert(knocked > 0.03, `the berry is knocked from where it hung (${(knocked * 1000).toFixed(1)} mm)`);
  assert(!vine.asleep, "...which woke its vine");
  // Which side it rolls off is the stalk's to say, not the drop's: the berry
  // gives along its stalk as well as across it (`growBerries`), so it slides
  // out from under a ball that lands just off its centre.
  assert(level.ball.globalPosition.y > fruit.globalPosition.y, "the ball rolls off it");
}
{
  const probe = new BallLevel(structuredClone(setup));
  const cord = probe.vines[0]!.links[3]!.globalPosition;
  const data = structuredClone(setup);
  data.player.x = cord.x * 100;
  data.player.y = cord.y * 100 - 20;
  const level = new BallLevel(data);
  const start = level.ball.globalPosition;
  for (let f = 0; f < 20; f++) {
    level.physicsProcess(emptyFrameInput(), 1 / 60);
    for (const c of level.world.frameContacts) {
      for (const side of [c.a, c.b]) assert(!(side instanceof VineLink) || side.solid, "the ball meets no cord or stalk");
    }
  }
  assert(level.vines[0]!.links.every((l) => l.isSolid === false));
  assert(level.ball.globalPosition.y - start.y > 0.4, "the ball falls through the cord unslowed");
}
console.log("PASS the ball lands on a berry and passes through the cord");

// Thrown up past the first plant's lowest berry, the hook bites the berry
// above it, and the ball's swing lays the chain over the one it passed - a
// berry it does not hold: the chain wraps it, and no invariant of any kind is
// broken while it does.
{
  const level = new BallLevel(structuredClone(setup));
  let prev = emptyFrameInput();
  let wrapped = 0;
  for (let f = 0; f < 240; f++) {
    const input = {
      ...emptyFrameInput(),
      fire: button(f >= 5 && f < 220, prev.fire),
      mouseWorldPosition: new Vec2(2.6, -3.6),
    };
    prev = input;
    level.physicsProcess(input, 1 / 60);
    const chain = level.ball.chain;
    const held = chain?.end.contact.obj;
    const wraps = chain?.wraps ?? [];
    if (wraps.some((w) => w.contact.obj instanceof VineLink && w.contact.obj.solid && w.contact.obj !== held)) wrapped++;
    assert.deepEqual(checkBallInvariants(level), [], `frame ${f}`);
  }
  assert(wrapped > 60, `the chain wraps a berry it does not hold (${wrapped} frames)`);
}
console.log("PASS the chain wraps a berry");

// --- the editor's berry placement ---------------------------------------------

{
  const line = [new Vec2(0, 0), new Vec2(0, 4)];
  // A plain vine becomes a berry vine by growing one, exactly where it was
  // dragged to.
  const first = growBerry(undefined, 2, new Vec2(0.4, 0.1), 4)!;
  assert.equal(first.index, 0);
  const settings = first.settings;
  assert.deepEqual(rounded(restStarberries(line, settings)[0]!.fruit), { x: 0.4, y: 2.1 });
  growBerry(settings, 1, new Vec2(-0.3, 0.2), 4);
  growBerry(settings, 3, new Vec2(0.2, 0.3), 4);
  const before = restStarberries(line, settings);
  // Moving one berry, sliding its root, or removing one leaves the others.
  placeBerry(settings, 0, new Vec2(0.1, -0.5));
  assert.deepEqual(rounded(restStarberries(line, settings)[0]!.fruit), { x: 0.1, y: 1.5 });
  assert.deepEqual(restStarberries(line, settings).slice(1), before.slice(1));
  moveBerry(settings, 1, 2, 4);
  assert.deepEqual(rounded(restStarberries(line, settings)[1]!.fruit), { x: -0.3, y: 2.2 }, "a slid root keeps its offset");
  const beforeRemoval = restStarberries(line, settings);
  removeBerry(settings, 0);
  assert.deepEqual(restStarberries(line, settings), beforeRemoval.slice(1));
  // Sizing one berry leaves the others; a new berry starts at the vine's size.
  const sizes = restStarberries(line, settings).map((b) => b.radius);
  sizeBerry(settings, 0, 0.3);
  assert.deepEqual(restStarberries(line, settings).map((b) => b.radius), [0.3, ...sizes.slice(1)]);
  sizeBerry(settings, 1, 5);
  assert.equal(berryRadius(1, settings), MAX_BERRY_RADIUS);
  // A stalk too short or too long is held to its range.
  placeBerry(settings, 0, new Vec2(0.01, 0));
  assert.equal(Math.round(berryOffset(0, settings).length() * 1e9) / 1e9, MIN_STALK);
  // An older plant (shared stalk length, sides) keeps its berries where they
  // were when its offsets are first made explicit.
  const older = starberrySettings({ along: [1.2, 2.4], sides: [1, 1], stemLength: 0.5 }, 4);
  const olderPoses = restStarberries(line, older);
  berryOffsets(older);
  assert.deepEqual(rounded(restStarberries(line, older)), rounded(olderPoses));
  growBerry(older, 3.6, new Vec2(0, 0.3), 4);
  assert.deepEqual(rounded(restStarberries(line, older).slice(0, 2)), rounded(olderPoses));
  // The stalk is drawn from its root on a two-point rest path too (the
  // editor's hanging vine), not from the nearer of its ends.
  assert.equal(stemFraction(line, new Vec2(0.3, 2)), 0.5);
  assert.equal(berryAlongAt(line, new Vec2(2, 3)), 3);
  assert.equal(
    Math.round(berryAlongAt([new Vec2(0, 0), new Vec2(2, 2), new Vec2(4, 0)], new Vec2(3, 1)) * 1e9) / 1e9,
    Math.round(3 * Math.SQRT2 * 1e9) / 1e9,
  );
  // Lengthening the vine leaves every berry where it was: a root is a length
  // down the vine, and the vine only grows below it.
  const longer = [new Vec2(0, 0), new Vec2(0, 6)];
  assert.deepEqual(rounded(restStarberries(longer, settings)), rounded(restStarberries(line, settings)));
}
console.log("PASS growing, placing, sliding and removing berries in the editor");

// --- the ball's weight stays on the berry while it winds -----------------------
//
// plans/berry-whip.md. A berry is a free holder the ball hangs from, and the
// chain phase's spin rollback used to treat it as a pass-through link: rolled
// back on every winding frame and winched against, so the berry stood at the
// plant's UNLOADED rest while the 52 kg ball hung from it and wound
// (`session-501f`, "the berry seems to move around quite unnaturally while I'm
// hanging off it"), and a ball whipped round a swinging berry was hauled after
// a point that never answered (`session-221f`, 3.1 to 9.5 m/s for +2.4 kJ).
// This is `cli spring` `winch-anchor-load-hung`'s statement - winding may not
// load the anchor less than hanging does - made about a berry, in the plant's
// own terms: the berry's sag below where the plant rests with nothing on it.
// Measured on BALL's three berries: hanging sags them 83, 94 and 197 mm and a
// slow wind holds 75, 90 and 182 of it; rolled back, the same wind let them
// spring to 7, 15 and 37 mm ABOVE the unloaded rest.

import ballJson from "../levels/ball.json";

// BALL is authored live, and since 2026-10-12 a plain vine hangs 0.6 m under
// its first plant's first berry, so a hook thrown from 0.95 m below catches
// that vine's link instead; the legs are berries with a clear line of fire.
const BALL_LEGS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [1, 1],
];

// BALL with the ball placed `below` metres under one of its berries, and a
// feed that holds fire with the aim wherever it is told.
function underBerry(plant: number, which: number, below: number) {
  const level = new BallLevel(structuredClone(ballJson) as RawLevelData);
  const berry = level.vines.filter((v) => v.starberry)[plant]!.berries[which]!;
  const rest = berry.fruit.globalPosition;
  level.ball.globalPosition = rest.add(new Vec2(0, below));
  let prev = emptyFrameInput();
  const feed = (aim: Vec2): void => {
    const input = { ...emptyFrameInput(), fire: button(true, prev.fire), mouseWorldPosition: aim };
    prev = input;
    level.physicsProcess(input, 1 / 60);
  };
  // The aim circled round the ball, `period` frames a revolution, from where
  // the loop points now.
  const whirl = (period: number, frames: number, each: (f: number) => void): void => {
    const start = level.ball.loopDirection.angle();
    for (let f = 0; f < frames; f++) {
      const angle = start + (f / period) * Math.PI * 2;
      feed(level.ball.globalPosition.add(new Vec2(Math.cos(angle), Math.sin(angle)).mul(2)));
      each(f);
    }
  };
  return { level, berry, fruit: berry.fruit, rest, feed, whirl };
}

for (const [plant, which] of BALL_LEGS) {
  const { level, fruit, rest, feed, whirl } = underBerry(plant, which, 0.95);
  // Hang from the berry on about 0.65 m of chain (session-221f's) and settle.
  for (let f = 0; f < 300; f++) feed(fruit.globalPosition);
  assert.equal(level.ball.chain?.end.contact.obj, fruit, `plant ${plant} berry ${which}: the hook catches the berry`);
  const hangSag = fruit.globalPosition.y - rest.y;
  assert(hangSag > 0.02, `plant ${plant} berry ${which}: the hanging ball loads the berry (sag ${(hangSag * 1000).toFixed(0)} mm)`);
  // A slow wind, a turn per 4 s, over the half-turn that winds.
  let minSag = Infinity;
  let berryPeak = 0;
  let ballPeak = 0;
  whirl(240, 200, () => {
    minSag = Math.min(minSag, fruit.globalPosition.y - rest.y);
    berryPeak = Math.max(berryPeak, fruit.linearVelocity.length());
    ballPeak = Math.max(ballPeak, level.ball.linearVelocity.length());
  });
  assert.equal(level.ball.chain?.end.contact.obj, fruit, `plant ${plant} berry ${which}: still held after the wind`);
  assert(
    minSag >= 0.5 * hangSag,
    `plant ${plant} berry ${which}: winding keeps the ball's weight on the berry (sag ${(minSag * 1000).toFixed(0)} mm through the wind against ${(hangSag * 1000).toFixed(0)} hanging)`,
  );
  assert(berryPeak < 3 && ballPeak < 3, `plant ${plant} berry ${which}: a slow wind is slow (berry ${berryPeak.toFixed(2)}, ball ${ballPeak.toFixed(2)} m/s)`);
}
console.log("PASS a wind-up keeps bearing down on the berry it hangs from");

// --- a berry cannot be whipped into a slingshot --------------------------------
//
// `cli contacts` `hung-anchor`'s rig on a berry: wound up to it, then the aim
// circled round the ball for 10 s. At a hand's pace (a turn per 0.8 s) the
// bars are `hung-anchor`'s, 5 m/s; at a frantic one (a turn per 0.4 s) the
// bars are loose and the statement is the berry's SPIN: a vine link does not
// turn (`VineLink.inverseInertia`). Spun to -10.5 rad/s by the pair push-out,
// a berry carried the chain's cuff round at 2 m/s and wound 10 cm of coil a
// frame onto a ball whose aim had stalled, and the stall lease paid it out
// until a 30 cm chain flew a 2.7 m path at 46 m/s (plans/berry-whip.md). The
// lease bar is the other half of that: 2.4 m then, under 12 cm now.
for (const [period, ballBar, berryBar] of [
  [48, 5, 5],
  [24, 8, 8],
] as const) {
  for (const [plant, which] of BALL_LEGS) {
    const { level, berry, fruit, feed, whirl } = underBerry(plant, which, 0.6);
    for (let f = 0; f < 240; f++) feed(fruit.globalPosition);
    const leg = `@${period} plant ${plant} berry ${which}`;
    assert.equal(level.ball.chain?.end.contact.obj, fruit, `${leg}: the hook catches the berry`);
    const anchoredAt = level.ball.chain!.maxRopeLength;
    let ballPeak = 0;
    let berryPeak = 0;
    let lease = 0;
    let grew = 0;
    whirl(period, 600, () => {
      ballPeak = Math.max(ballPeak, level.ball.linearVelocity.length());
      berryPeak = Math.max(berryPeak, fruit.linearVelocity.length());
      assert.equal(fruit.angularVelocity, 0, `${leg}: a berry does not spin`);
      assert.equal(berry.joint.angularVelocity, 0, `${leg}: a stalk joint does not spin`);
      const chain = level.ball.chain;
      if (chain) {
        lease = Math.max(lease, chain.blockedSlack);
        grew = Math.max(grew, chain.maxRopeLength - anchoredAt);
      }
    });
    assert.equal(level.ball.chain?.end.contact.obj, fruit, `${leg}: still held after 10 s of whipping`);
    assert(ballPeak < ballBar, `${leg}: the ball is never slung (peak ${ballPeak.toFixed(2)} m/s, bar ${ballBar})`);
    assert(berryPeak < berryBar, `${leg}: the berry is never flung (peak ${berryPeak.toFixed(2)} m/s, bar ${berryBar})`);
    assert(lease < 0.3, `${leg}: the stall lease stays a lease (peak ${(lease * 1000).toFixed(0)} mm, bar 300)`);
    assert(grew < 0.01, `${leg}: the chain never grows (${(grew * 1000).toFixed(1)} mm past its anchored length)`);
  }
}
console.log("PASS a berry cannot be whipped into a slingshot, and never spins");

// --- a held plant is the island's -----------------------------------------------

// The stalk's spring bounces the ball, and solved positionally at the frame's
// step (XPBD, implicit Euler for its force) it damped a third of a bounce per
// half-period: a 0.5 m drop onto a BALL berry returned 44% of its energy at
// 60 Hz, 65% with the same solve at 120 and 83% at 240. So the plant the ball
// hangs from is a unit of the island solver while it hangs (`PlantUnit`,
// substepped with the ball's chain row), and back in the chain sweep the
// frame the chain lets go. Measured 2026-10-12 on BALL's clear berries at
// sway 0.5, berry 300 kg/m³, stem 1 kg/m, the aim following the berry: 68%
// and 78% as undamped rows against 51% and 53% in the sweep, and 57% and 57%
// with the rows damped enough for a hanging plant to settle
// (`PlantTuning.springDamping`, the trade `session-846f` asked for). The bar
// is the mechanism, not the feel: as rows the drop returns at least half.
// What the rows buy beside the return is the catch: a 3.5 m/s catch left the
// sweep's cord 7 to 14 cm shorter for a second, and the rows' within 16 mm.
{
  const flags = BallLevel as unknown as { PLANT_ROWS: boolean };
  const measure = (plant: number, which: number, rows: boolean): { back: number; unit: boolean; after: boolean } => {
    const was = flags.PLANT_ROWS;
    flags.PLANT_ROWS = rows;
    try {
      const data = structuredClone(ballJson) as RawLevelData;
      for (const v of data.vines ?? []) {
        if (!v.starberry) continue;
        v.starberry.sway = 0.5;
        v.starberry.berryDensity = 300;
        v.starberry.stalkDensity = 1;
      }
      const level = new BallLevel(data);
      const vine = level.vines.filter((v) => v.starberry)[plant]!;
      const fruit = vine.berries[which]!.fruit;
      level.ball.globalPosition = fruit.globalPosition.add(new Vec2(0, 0.95));
      let prev = emptyFrameInput();
      const feed = (fire: boolean): void => {
        const input = { ...emptyFrameInput(), fire: button(fire, prev.fire), mouseWorldPosition: fruit.globalPosition };
        prev = input;
        level.physicsProcess(input, 1 / 60);
      };
      for (let f = 0; f < 300; f++) feed(true);
      assert.equal(level.ball.chain?.end.contact.obj, fruit, `plant ${plant} berry ${which}: caught`);
      const unit = vine.unit !== null;
      // Lift the ball half a metre on a slack chain and let it fall.
      level.ball.globalPosition = level.ball.globalPosition.add(new Vec2(0, -0.5));
      level.ball.linearVelocity = Vec2.ZERO;
      let down = 0;
      let up = 0;
      let caught = false;
      for (let f = 0; f < 120; f++) {
        feed(true);
        const vy = level.ball.linearVelocity.y;
        if (!caught) {
          if (vy > down) down = vy;
          else if (vy < down - 0.05) caught = true;
        } else if (-vy > up) up = -vy;
      }
      assert(caught, `plant ${plant} berry ${which}: the chain catches the drop`);
      // Let go: the plant is nobody's unit the frame after.
      feed(false);
      feed(false);
      return { back: (up * up) / (down * down), unit, after: vine.unit !== null };
    } finally {
      flags.PLANT_ROWS = was;
    }
  };
  for (const [plant, which] of [[0, 1], [1, 0]] as const) {
    const rows = measure(plant, which, true);
    const sweep = measure(plant, which, false);
    assert(rows.unit, `plant ${plant} berry ${which}: held, the plant is an island unit`);
    assert(!rows.after, `plant ${plant} berry ${which}: let go, it is not`);
    assert(!sweep.unit, `plant ${plant} berry ${which}: with the switch off it never is`);
    // Measured here (this rig's aim follows the berry and its hang is shorter
    // than the drop rig's): 50% as rows against 24% in the sweep on plant 0's
    // second berry.
    assert(
      rows.back > 0.4,
      `plant ${plant} berry ${which}: as rows the drop returns ${(rows.back * 100).toFixed(0)}% (bar 40; the sweep ${(sweep.back * 100).toFixed(0)}%)`,
    );
  }
}
console.log("PASS a held plant is the island's: the drop comes back, and the plant is released with the berry");
