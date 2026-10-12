import assert from "node:assert/strict";
import { BallLevel } from "../src/level/ballLevel";
import { BallHook } from "../src/classes/ballHook";
import { Vec2 } from "../src/engine/vec2";
import { LAYER_HOOK } from "../src/engine/body";
import { button, emptyFrameInput } from "../src/input/frameInput";
import { cloneVine, modelFromDisk, modelToDisk } from "../src/editor/model";
import { scaleLevelData, type RawLevelData } from "../src/level/levelFormat";
import { restStarberries, starberrySettings } from "../src/level/starberry";
import { addBerry, berryPositionAt, berrySides, moveBerry, removeBerry } from "../src/editor/berryEditing";
import { leafDepth, starberryLeaves, type LeafFootprint } from "../src/render/starberryArt";
import { checkBallInvariants, worldDigestBall } from "../src/sim/trace";
import rawJson from "../levels/starberry-test.json";

const raw = rawJson as RawLevelData;
const scaled = scaleLevelData(raw, 0.01);
assert.equal(scaled.vines![0]!.starberry!.radius, 0.25);
const rounded = (value: unknown) => JSON.parse(JSON.stringify(value,
  (_key, v) => typeof v === "number" ? Math.round(v * 1e9) / 1e9 : v));
assert.deepEqual(rounded(scaleLevelData(scaled, 100).vines), raw.vines);
const model = modelFromDisk(raw);
assert.deepEqual(rounded(modelToDisk(model).vines!.map(v => v.starberry)), rounded(raw.vines!.map(v => v.starberry)));
const clone = cloneVine(model.vines[0]!);
clone.starberry!.positions[0] = 0.5;
assert.equal(model.vines[0]!.starberry!.positions[0], 0.3);
assert.deepEqual(starberrySettings({ positions: [NaN, 0.3, 0.3, 2], radius: NaN }).positions, [0.3, 1]);
console.log("PASS save/load, unit conversion, clone isolation, and setting validation");
const roundRaw = structuredClone(raw);
roundRaw.vines![0]!.starberry!.appearance = "round";
assert.equal(modelToDisk(modelFromDisk(roundRaw)).vines![0]!.starberry!.appearance, "round");
assert.equal(starberrySettings({ appearance: "round" }).appearance, "round");
assert.equal(starberrySettings().appearance, undefined, "legacy plants keep their stars");

const setup = structuredClone(raw);
setup.player.x = -140; setup.player.y = -130; setup.bodies![0]!.y = 600;
function exercise(round = false): string[] {
  const data = structuredClone(setup);
  if (round) data.vines![0]!.starberry!.appearance = "round";
  const level = new BallLevel(data), vine = level.vines[0]!;
  const fruit = vine.berries[1]!.fruit;
  assert(vine.links.every(l => (l.primaryShape().mask & LAYER_HOOK) === 0));
  assert(vine.berries.every(b => (b.joint.primaryShape().mask & LAYER_HOOK) === 0));
  assert(vine.berries.every(b => (b.fruit.primaryShape().mask & LAYER_HOOK) !== 0));
  const digests: string[] = [];
  let prev = emptyFrameInput(), caught = false;
  for (let f = 0; f < 420; f++) {
    const input = { ...emptyFrameInput(), fire: button(f >= 10 && f < 300, prev.fire),
      mouseWorldPosition: fruit.globalPosition };
    prev = input; level.physicsProcess(input, 1 / 60);
    caught ||= level.ball.chain?.end.contact.obj === fruit;
    assert.deepEqual(checkBallInvariants(level).filter(v => v.kind.startsWith("starberry-")), []);
    const digest = worldDigestBall(level);
    assert(digest.bodies.some(b => b.id === fruit.buildIndex), "berries must appear in replay digests");
    digests.push(JSON.stringify(digest));
  }
  assert(caught, "the moving berry must catch the real ball hook");
  assert.equal(vine.lra, null); assert.equal(vine.heldBerry, null);
  return digests;
}
assert.deepEqual(exercise(), exercise());
assert.deepEqual(exercise(true), exercise(), "round appearance must preserve every physics frame");
console.log("PASS round-berry save/load and identical star/round swinging physics");
console.log("PASS berry catch, branch bounds, release cleanup, full-world deterministic replay");

// Actual fast swept hooks pass through a stem and catch a berry, including asleep plants.
for (const target of ["stem", "berry"] as const) {
  const level = new BallLevel(raw), vine = level.vines[0]!;
  const destination = target === "stem" ? vine.links[1]! : vine.berries[0]!.fruit;
  const hook = new BallHook(); hook.globalPosition = destination.globalPosition.add(new Vec2(-0.35, 0));
  hook.linearVelocity = new Vec2(12, 0); hook.globalRotation = Math.PI;
  level.world.add(hook);
  let attached: unknown = null;
  hook.registerAttachmentCallback((body) => { attached = body; });
  for (let f = 0; f < 4; f++) hook.physicsStep(1 / 60);
  if (target === "stem") assert.notEqual(attached, destination);
  else assert.equal(attached, destination);
}
console.log("PASS fast hook ignores main stem and catches a sleeping berry");

// Check silhouettes throughout a real swing, including a neighbouring plant.
const foliageLevel = new BallLevel(setup);
let foliageInput = emptyFrameInput(), checkedLeaves = 0;
for (let frame = 0; frame < 240; frame++) {
  const fruit = foliageLevel.vines[0]!.berries[1]!.fruit;
  foliageInput = { ...emptyFrameInput(), fire: button(frame >= 10, foliageInput.fire),
    mouseWorldPosition: fruit.globalPosition };
  foliageLevel.physicsProcess(foliageInput, 1 / 60);
  const occupied: LeafFootprint[] = [];
  for (const vine of foliageLevel.vines) {
    if (!vine.starberry) continue;
    const path: Vec2[] = []; vine.path(1, path);
    const berries = vine.berryPoses(1);
    const leaves = starberryLeaves(path, vine.starberry, berries, occupied);
    checkedLeaves += leaves.length;
    for (const leaf of leaves) {
      for (const berry of berries) assert(leaf.center.distanceTo(berry.fruit)
        >= leaf.radius + vine.starberry.radius * 1.06 + 0.045 - 1e-9);
    }
    // The blade's complete rotation/fold envelope is less than its size * 0.4.
    for (const ballRadius of [0.12, 0.22, 0.6]) for (const leaf of leaves) {
      assert(leafDepth(ballRadius, vine.starberry.radius) + leaf.size * 0.4 < -ballRadius);
    }
  }
  for (let i = 0; i < occupied.length; i++) for (let j = i + 1; j < occupied.length; j++) {
    const a = occupied[i]!, b = occupied[j]!;
    assert(a.center.distanceTo(b.center) >= a.radius + b.radius + 0.035 - 1e-9);
  }
}
assert(checkedLeaves > 0, "clearance checks must include visible foliage");
console.log("PASS leaf spacing, berry clearance, and player depth during a real swing");

// Editing one berry must not shuffle the other fruit, even across another branch.
const placed = starberrySettings({ appearance: "round" });
const line = [new Vec2(0, 0), new Vec2(0, 4)];
const originalPoses = restStarberries(line, placed);
moveBerry(placed, 0, 0.95);
assert.deepEqual(restStarberries(line, placed).slice(1), originalPoses.slice(1));
berrySides(placed)[0] = 1;
addBerry(placed);
const beforeRemoval = restStarberries(line, placed);
removeBerry(placed, 1);
assert.deepEqual(restStarberries(line, placed), [beforeRemoval[0], beforeRemoval[2], beforeRemoval[3]]);
assert.deepEqual(starberrySettings(placed), placed, "play normalisation preserves authored order and sides");
const placementRaw = structuredClone(raw);
placementRaw.vines![0]!.starberry = { ...placed, radius: placed.radius * 100, stemLength: placed.stemLength * 100 };
const savedPlacement = modelToDisk(modelFromDisk(placementRaw));
assert.deepEqual(savedPlacement.vines![0]!.starberry, placementRaw.vines![0]!.starberry);
const copiedPlacement = scaleLevelData(placementRaw, 0.01);
copiedPlacement.vines![0]!.starberry!.sides![0] = -1;
assert.equal(placementRaw.vines![0]!.starberry!.sides![0], 1, "unit conversion isolates branch sides");
const placementLevel = new BallLevel(placementRaw), placedVine = placementLevel.vines[0]!;
assert.equal(placedVine.berries.length, placed.positions.length);
for (const [i, berry] of placedVine.berries.entries()) {
  const offset = berry.fruit.globalPosition.x - placedVine.links[berry.parentIndex]!.globalPosition.x;
  assert.equal(Math.sign(offset), placed.sides![i], "play builds each branch on its authored side");
}
assert.equal(berryPositionAt(line, new Vec2(2, 3)), 0.75);
assert.equal(berryPositionAt([new Vec2(0, 0), new Vec2(2, 2), new Vec2(4, 0)], new Vec2(3, 1)), 0.75);
while (placed.positions.length) removeBerry(placed, 0);
addBerry(placed); assert.equal(placed.positions.length, 1);
console.log("PASS independent berry placement, sides, removal, add-back, save/load, and span dragging");
