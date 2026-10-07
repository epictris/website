import assert from "node:assert/strict";
import * as THREE from "three";
import {
  DEFAULT_HANGING_VINE_SETTINGS,
  generateHangingVine,
  VineSurface,
  type HangingVineRecipe,
} from "../src/render3d/hangingVine";

const box = new THREE.BoxGeometry(2, 2, 2).toNonIndexed().getAttribute("position").array as Float32Array;
const round = new THREE.SphereGeometry(1, 32, 20).toNonIndexed().getAttribute("position").array as Float32Array;

function recipe(length: number, seed = 41): HangingVineRecipe {
  return {
    version: 1,
    start: [0, 1, 0.66],
    normal: [0, 1, 0],
    direction: [0, 0, 1],
    settings: { ...DEFAULT_HANGING_VINE_SETTINGS, length, seed, cling: 0.12, leafSpacing: 0.13 },
  };
}

function arcLength(points: THREE.Vector3[]): number {
  return points.slice(1).reduce((sum, point, i) => sum + point.distanceTo(points[i]), 0);
}

function finiteGeometry(group: THREE.Group): void {
  let meshes = 0;
  group.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    meshes++;
    const positions = object.geometry.getAttribute("position");
    assert.ok(positions.count > 0, `${object.name} has vertices`);
    for (const value of positions.array) assert.ok(Number.isFinite(value), `${object.name} has finite vertices`);
    const indices = object.geometry.getIndex();
    assert.ok(indices?.count, `${object.name} has triangles`);
    for (const index of indices.array) assert.ok(index < positions.count, `${object.name} indices are in range`);
  });
  assert.ok(meshes >= 2, "stem and foliage are present");
}

function nearestPathDistance(point: THREE.Vector3, path: THREE.Vector3[]): number {
  let best = Infinity;
  const closest = new THREE.Vector3();
  for (let i = 1; i < path.length; i++) {
    new THREE.Line3(path[i - 1], path[i]).closestPointToPoint(point, true, closest);
    best = Math.min(best, point.distanceTo(closest));
  }
  return best;
}

function checkPath(positions: Float32Array, input: HangingVineRecipe): void {
  const result = generateHangingVine(positions, input);
  const surface = new VineSurface(positions);
  const clearance = input.settings.radius + 0.002;
  assert.ok(result.points.length > 2, "vine has a grown path");
  assert.equal(result.points.length, result.normals.length);
  assert.equal(result.points.length, result.supported.length);
  assert.ok(Math.abs(arcLength(result.points) - input.settings.length) < 0.001,
    "short and long vines match their requested arc length");
  assert.ok(Math.abs(result.length - input.settings.length) < 0.001);
  assert.ok(surface.nearest(result.points[0])!.distance <= clearance + 0.001,
    "the root touches the selected rock surface");
  for (let i = 1; i < result.points.length; i++) {
    assert.ok(surface.clear(result.points[i - 1], result.points[i], clearance * 0.9),
      `stem segment ${i} clears the rock`);
  }
  assert.ok(result.leafCount > 0, "the grown vine has leaves");
  finiteGeometry(result.group);
  const stalks = result.group.getObjectByName("Leaf stalks") as THREE.Mesh;
  assert.ok(stalks, "leaves have petioles");
  const stalkPositions = stalks.geometry.getAttribute("position");
  assert.equal(stalkPositions.count, result.leafCount * 27, "one three-ring petiole per leaf");
  for (let leaf = 0; leaf < result.leafCount; leaf++) {
    const root = new THREE.Vector3();
    for (let j = 0; j < 8; j++) root.add(new THREE.Vector3().fromBufferAttribute(stalkPositions, leaf * 27 + j));
    root.divideScalar(8);
    assert.ok(nearestPathDistance(root, result.points) < 0.002, `leaf ${leaf} attaches to the stem`);
  }
}

checkPath(box, recipe(0.22));
checkPath(box, recipe(2.2));
const boxLong = generateHangingVine(box, recipe(2.2));
assert.ok(boxLong.releaseIndex > 0, "a vine growing over the box lip releases");
assert.ok(boxLong.points.at(-1)!.y < boxLong.points[boxLong.releaseIndex].y - 0.3,
  "the released tip descends below the lip");

const roundRecipe: HangingVineRecipe = {
  ...recipe(1.8), start: [0, 0.995, 0], direction: [0, 0, 1],
};
checkPath(round, roundRecipe);

const repeated = generateHangingVine(box, recipe(1.6, 25));
const repeatedAgain = generateHangingVine(box, recipe(1.6, 25));
assert.deepEqual(repeated.points.map(p => p.toArray()), repeatedAgain.points.map(p => p.toArray()),
  "same seed regenerates the same path");
const otherSeed = generateHangingVine(box, recipe(1.6, 26));
assert.ok(repeated.points.some((p, i) => p.distanceTo(otherSeed.points[i] ?? p) > 0.00001),
  "different seeds vary the path");

assert.throws(() => generateHangingVine(box, { ...recipe(1), start: [5, 5, 5] }), /root/i);
assert.throws(() => generateHangingVine(box, { ...recipe(1), settings: { ...recipe(1).settings, length: NaN } }), /length/i);
assert.throws(() => new VineSurface([0, 0, 0, 0, 0, 0, 0, 0, 0]), /usable faces/i);

console.log("Hanging vine geometry tests passed: box, rounded rock, length, clearance, release, leaves, seeds, invalid input.");
