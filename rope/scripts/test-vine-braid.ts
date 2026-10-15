import { strict as assert } from "node:assert";
import * as THREE from "three";
import { Vec2 } from "../src/engine/vec2";
import { PX, PIXELS_PER_METER } from "../src/engine/units";
import { forEachBraidSegment, forEachBraidPoint } from "../src/render/vineBraid";
import { sampleVineCurve, vineMaterial } from "../src/render/vineCurve";
import { VineTwist } from "../src/render/vineTwist";
import { forEachVineLeaf } from "../src/render/vineLeaves";
import { vineNodeCount, vineNodeFraction } from "../src/render/vineGrowth";
import { VineLeafLag } from "../src/render3d/vineLeafLag";
import { VINE_VISUAL_RADIUS } from "../src/level/vines";
import { VineLayer } from "../src/render3d/vineVisual";
import type { VineTube } from "../src/render3d/vineTube";
import { modelFromDisk, modelToDisk, cloneVine, ED_LAYERS } from "../src/editor/model";
import { Guides } from "../src/editor/visuals/guides";
import { scaleLevelData, type RawLevelData } from "../src/level/levelFormat";
import { Level } from "../src/level/level";
import { emptyFrameInput } from "../src/input/frameInput";
import ball from "../levels/ball.json";

const path = [new Vec2(3, 2), new Vec2(3, 6)];
// Differential strain must not move a node onto a different physical link.
const materialPath = [new Vec2(0, 0), new Vec2(0, 1), new Vec2(0, 2), new Vec2(0, 3), new Vec2(0, 4)];
const unevenPath = [new Vec2(0, 0), new Vec2(0, 1.2), new Vec2(0, 2.2), new Vec2(0, 3.2), new Vec2(0, 4.2)];
const restCurve = sampleVineCurve(materialPath, [], [], 4), unevenCurve = sampleVineCurve(unevenPath, [], [], 4);
const restLeaves: number[][] = [], unevenLeaves: number[][] = [];
forEachVineLeaf(materialPath, 1701, (...leaf) => restLeaves.push(leaf), restCurve, 4);
forEachVineLeaf(unevenPath, 1701, (...leaf) => unevenLeaves.push(leaf), unevenCurve, 4);
restLeaves.forEach((leaf, i) => {
  const other = unevenLeaves[i]!;
  assert.equal(other[9], leaf[9], "nodes retain their material identity under uneven strain");
  if (leaf[9]! * 4 > 2) assert.ok(Math.abs(other[1]! - leaf[1]! - .2) < 1e-9,
    "stretch in an earlier link translates later leaves without sliding them on their own links");
});
const materialTwist = new VineTwist();
materialTwist.update(unevenCurve, 0, true);
let largestTwist = 0;
for (let frame = 1; frame <= 120; frame++) {
  materialTwist.update(unevenCurve, frame / 60, true);
  assert.equal(unevenCurve[0]!.twist, 0, "first tied end resists axial rotation");
  assert.equal(unevenCurve.at(-1)!.twist, 0, "second tied end resists axial rotation");
  assert.ok(unevenCurve.every(p => Number.isFinite(p.twist) && Math.abs(p.twist!) <= .45), "torsion stays finite and restrained");
  largestTwist = Math.max(largestTwist, ...unevenCurve.map(p => Math.abs(p.twist!)));
}
assert.ok(largestTwist > .01, "differential extension produces a torsional response between tied ends");
const pausedTwist = unevenCurve.map(p => p.twist);
materialTwist.update(unevenCurve, 2, true);
assert.deepEqual(unevenCurve.map(p => p.twist), pausedTwist, "pause freezes torsion exactly");
for (let frame = 121; frame <= 720; frame++) materialTwist.update(restCurve, frame / 60, true);
assert.ok(Math.max(...restCurve.map(p => Math.abs(p.twist!))) < .001, "release dissipates torsional waves and returns to the rest braid");
materialTwist.update(unevenCurve, 0, true);
assert.ok(unevenCurve.every(p => p.twist === 0), "seeking clears prior torsional history");
// Uniform tension with two rotationally fixed ends cannot unwind the whole span.
for (const p of restCurve) p.stretch = 1.1;
for (let frame = 1; frame <= 120; frame++) materialTwist.update(restCurve, frame / 60, true);
assert.ok(restCurve.every(p => Math.abs(p.twist!) < 1e-10), "uniform strain does not make fixed attachments swivel");
const tiedSections: number[][] = [];
forEachBraidPoint(restCurve, 1798, (i, ...p) => { if (i === restCurve.length - 1) tiedSections.push(p); }, 4, true);
assert.ok(tiedSections.every(p => p[4]! > .5), "second attached end retains its bundle thickness");
assert.equal(vineMaterial(restCurve.at(-1)!), 4, "rest coordinates are independent of current length");
const tinyCurve = sampleVineCurve([new Vec2(0, 0), new Vec2(0, .00001)], [], [], .00001);
materialTwist.update(tinyCurve, 3, true);
assert.ok(tinyCurve.every(p => p.twist === 0), "near-coincident attachments have no unresolved torsional animation");
const newLengthCurve = sampleVineCurve([new Vec2(0, 0), new Vec2(0, 1.2)], [], [], 1);
materialTwist.update(newLengthCurve, 3.01, true);
assert.ok(newLengthCurve.every(p => p.twist === 0), "a changed material length starts with clean angular history");
const segments: number[][] = [];
forEachBraidSegment(path, 1701, (...segment) => segments.push(segment));
assert.deepEqual(new Set(segments.map(s => s[6])), new Set([0, 1, 2]), "three strands are restored");
assert.ok(segments.every(s => s.every(Number.isFinite)), "no invalid transforms");
assert.ok(segments.some(s => Math.abs(s[2]!) > .005), "strands actually turn in depth");
assert.ok(segments.at(-1)![7]! < segments[0]![7]! * .1, "free end tapers to a point");
const repeat: number[][] = [];
forEachBraidSegment(path, 1701, (...s) => repeat.push(s));
assert.deepEqual(repeat, segments, "seed reproduces the braid");
const roots: number[][] = [];
forEachBraidPoint(sampleVineCurve(path), 1701, (i, ...p) => { if (!i) roots.push(p); });
assert.ok(roots[0]![4]! > roots[1]![4]! && roots[1]![4]! > roots[2]![4]!, "growth has three unequal gauges");
for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
  const distance = Math.hypot(roots[a]![0]! - roots[b]![0]!, roots[a]![1]! - roots[b]![1]!, roots[a]![2]! - roots[b]![2]!);
  assert.ok(Math.abs(distance - (roots[a]![4]! + roots[b]![4]!) * VINE_VISUAL_RADIUS * .52) < 1e-10, "unequal stems meet at their surfaces");
}
const straightCurve = sampleVineCurve(path), crossSections: number[][][] = [];
forEachBraidPoint(straightCurve, 1701, (i, ...p) => (crossSections[i] ??= []).push(p));
const twistRates: number[] = [];
let lastAngle = 0;
crossSections.forEach((strands, i) => {
  const angle = Math.atan2(strands[1]![2]! - strands[0]![2]!, strands[0]![0]! - strands[1]![0]!);
  if (i) {
    let turn = angle - lastAngle;
    if (turn < -Math.PI) turn += Math.PI * 2;
    if (turn > Math.PI) turn -= Math.PI * 2;
    twistRates.push(turn / (straightCurve[i]!.distance - straightCurve[i - 1]!.distance));
  }
  lastAngle = angle;
});
assert.ok(Math.min(...twistRates) > 0, "tight and loose sections do not reverse or kink");
assert.ok(Math.max(...twistRates) / Math.min(...twistRates) > 2, "braid pitch varies noticeably along the cord");
const leafLayout: number[][] = [], stretchedLayout: number[][] = [];
forEachVineLeaf(path, 1701, (...p) => leafLayout.push(p));
const leafRepeat: number[][] = [];
forEachVineLeaf(path, 1701, (...p) => leafRepeat.push(p));
assert.deepEqual(leafRepeat, leafLayout, "natural growth remains reproducible from its seed");
const lengths = leafLayout.map(leaf => leaf[3]!);
assert.ok(Math.max(...lengths) / Math.min(...lengths) > 1.8, "small young leaves contrast with mature leaves");
const nodeFractions = Array.from({ length: vineNodeCount(4) }, (_, node) => vineNodeFraction(1701, node, vineNodeCount(4)));
const growthFractions = [0, ...nodeFractions, 1];
const gaps = growthFractions.slice(1).map((fraction, i) => fraction - growthFractions[i]!);
assert.ok(Math.max(...gaps) / Math.min(...gaps) > 2, "nodes form clusters and bare stretches instead of equal spacing");
const stretchedPath = [new Vec2(3, 2), new Vec2(3, 6.8)];
forEachVineLeaf(stretchedPath, 1701, (...p) => stretchedLayout.push(p), sampleVineCurve(stretchedPath), 4);
assert.equal(stretchedLayout.length, leafLayout.length, "stretching preserves the number and identities of leaves");
leafLayout.forEach((leaf, i) => assert.ok(Math.abs((leaf[1]! - 2) / 4 - (stretchedLayout[i]![1]! - 2) / 4.8) < 1e-9,
  "leaves stay at the same growth fraction under stretch"));

// The live tube is continuous through joints, posed on its first frame. It is
// built once in its rest pose and bent on the GPU, so every measurement of the
// RENDERED braid goes through `deformedGeometry`, the shader's CPU mirror.
// Translation must move every rendered vertex while uploading only the pose.
function posedBraid(target: THREE.Scene): THREE.BufferGeometry {
  return ((target.getObjectByName("vine-braid-tube") as THREE.Mesh).userData.tube as VineTube).deformedGeometry();
}
const scene = new THREE.Scene(), layer = new VineLayer(scene);
const cord = { color: null, braidSeed: 1701, path: (_alpha: number, out: Vec2[]) => {
  out.length = 0; out.push(...path);
} };
layer.sync([cord], 1);
const braid = scene.getObjectByName("vine-braid-tube") as THREE.Mesh;
assert.ok(braid?.isMesh && !(braid as THREE.InstancedMesh).isInstancedMesh, "a continuous tube replaces separate capsules");
const tube = braid.userData.tube as VineTube;
const geometry = braid.geometry, rest = geometry.getAttribute("position") as THREE.BufferAttribute;
const posed = posedBraid(scene), positions = posed.getAttribute("position");
const original = Float32Array.from(positions.array), indices = geometry.index!;
assert.ok(positions.getX(0) > 2.9, "first-frame geometry is posed");
const used = new Set(Array.from(indices.array));
for (const i of used) {
  assert.ok(i < positions.count && [positions.getX(i), positions.getY(i), positions.getZ(i)].every(Number.isFinite));
  const n = posed.getAttribute("normal");
  assert.ok(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 1e-6, "unit smooth normals");
}
const restVersion = rest.version, poseVersion = tube.poseVersion;
const paint = geometry.getAttribute("color");
assert.ok(new Set(Array.from(used).map(i => paint.getY(i).toFixed(4))).size > 8, "paint varies over the stems");
assert.ok(Array.from(paint.array).every(Number.isFinite), "paint buffers stay finite");
layer.sync([cord], 1);
assert.equal(tube.poseVersion, poseVersion, "stationary tubes skip uploads");
path[0] = path[0]!.add(new Vec2(2, -1)); path[1] = path[1]!.add(new Vec2(2, -1));
layer.sync([cord], 1);
assert.equal(braid.geometry, geometry, "moving tubes reuse their buffers");
assert.equal(rest.version, restVersion, "a moving tube never re-uploads its vertices");
assert.ok(tube.poseVersion > poseVersion, "a moving tube uploads its new pose");
const moved = posedBraid(scene).getAttribute("position");
for (const i of used) {
  assert.ok(Math.abs(moved.getX(i) - original[i * 3]! - 2) < 1e-5);
  assert.ok(Math.abs(moved.getY(i) - original[i * 3 + 1]! - 1) < 1e-5);
}
const leaves = scene.getObjectByName("vine-leaves") as THREE.InstancedMesh;
assert.equal(scene.children.filter(n => (n as THREE.InstancedMesh).isInstancedMesh).length, 2,
  "only plain cords and blades are instanced; there is no leaf-stalk mesh");
// Measure rendered blade origins against the rendered tube triangles, rather
// than asserting the attachment helper against its own formula.
function assertLeafRootsTouchBraid(target: THREE.Scene): void {
  const tube = posedBraid(target);
  const blades = target.getObjectByName("vine-leaves") as THREE.InstancedMesh;
  const vertices = tube.getAttribute("position"), index = tube.index!;
  const matrix = new THREE.Matrix4(), root = new THREE.Vector3(), nearest = new THREE.Vector3();
  const triangle = new THREE.Triangle();
  for (let leaf = 0; leaf < blades.count; leaf++) {
    blades.getMatrixAt(leaf, matrix); root.setFromMatrixPosition(matrix);
    let distance = Infinity;
    for (let i = 0; i < index.count; i += 3) {
      triangle.a.fromBufferAttribute(vertices, index.getX(i));
      triangle.b.fromBufferAttribute(vertices, index.getX(i + 1));
      triangle.c.fromBufferAttribute(vertices, index.getX(i + 2));
      triangle.closestPointToPoint(root, nearest);
      distance = Math.min(distance, root.distanceTo(nearest));
    }
    assert.ok(distance < .003, `leaf ${leaf} grows directly from the braid (surface distance ${distance} m)`);
  }
}
function inspectLeafPenetration(target: THREE.Scene): { count: number; depth: number; samples: string[] } {
  const braid = posedBraid(target);
  braid.computeBoundingSphere();
  const probeMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const probe = new THREE.Mesh(braid, probeMaterial);
  const blades = target.getObjectByName("vine-leaves") as THREE.InstancedMesh;
  const vertices = blades.geometry.getAttribute("position"), uv = blades.geometry.getAttribute("uv");
  const shape = blades.geometry.getAttribute("leafShape");
  const matrix = new THREE.Matrix4(), point = new THREE.Vector3();
  const ray = new THREE.Raycaster(), direction = new THREE.Vector3(.937, .213, .276).normalize();
  let count = 0, depth = 0;
  const samples: string[] = [];
  for (let leaf = 0; leaf < blades.count; leaf++) {
    blades.getMatrixAt(leaf, matrix);
    for (let i = 0; i < vertices.count; i++) {
      const t = uv.getY(i);
      if (t === 0) continue; // Surface contact at the attachment is intentional.
      point.fromBufferAttribute(vertices, i);
      // `botanicalBasePosition`, line for line: shape, the wrap round the stem
      // where the blade is pressed or the ring is threaded over it, the bends.
      const wrapA = blades.geometry.getAttribute("leafWrap"), ringA = blades.geometry.getAttribute("leafRing");
      const smooth = (e0: number, e1: number, v: number): number => {
        const q = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return q * q * (3 - 2 * q);
      };
      const y0 = point.y;
      const wrap = ringA.getY(leaf) > 0
        ? Math.max(wrapA.getX(leaf), 1 - smooth(ringA.getY(leaf), ringA.getY(leaf) * 4, Math.abs(y0 - ringA.getX(leaf))))
        : wrapA.getX(leaf);
      point.x += shape.getX(leaf) * Math.sin(Math.PI * t) + shape.getZ(leaf) * t * t;
      point.z += shape.getY(leaf) * t * t * t + shape.getW(leaf) * t * t;
      if (wrap > 0) {
        const r = Math.abs(wrapA.getY(leaf)) + ringA.getZ(leaf) * Math.max(y0, 0), phi = point.x * wrapA.getZ(leaf) / r;
        point.x += (r * Math.sin(phi) / wrapA.getZ(leaf) - point.x) * wrap;
        point.z += (-Math.sign(wrapA.getY(leaf)) * r * (1 - Math.cos(phi)) - point.z) * wrap;
      }
      point.x += ringA.getW(leaf) * t * t;
      point.z += wrapA.getW(leaf) * t * t;
      const u = Math.max(0, Math.min(1, (t - .10) / .35));
      const angle = blades.geometry.getAttribute("leafFaceTurn").getX(leaf) * u * u * (3 - 2 * u);
      const x = point.x, z = point.z;
      point.x = Math.cos(angle) * x + Math.sin(angle) * z;
      point.z = -Math.sin(angle) * x + Math.cos(angle) * z;
      point.applyMatrix4(matrix);
      ray.set(point, direction);
      const hit = ray.intersectObject(probe, false)[0];
      if (hit && hit.distance > 1e-6 && hit.face!.normal.dot(direction) > 0) {
        count++; depth = Math.max(depth, hit.distance);
        if (samples.length < 4) samples.push(`leaf ${leaf}, t ${t.toFixed(3)}, u ${uv.getX(i).toFixed(3)}, depth ${hit.distance.toFixed(4)} m`);
      }
    }
  }
  probeMaterial.dispose();
  return { count, depth, samples };
}
function assertLeafBladesClear(target: THREE.Scene, label = "straight"): void {
  const penetration = inspectLeafPenetration(target);
  assert.equal(penetration.count, 0, `${label}: leaf blades stay outside the braid (${penetration.count} buried vertices, up to ${penetration.depth} m; ${penetration.samples.join("; ")})`);
}
assertLeafBladesClear(scene);
assertLeafRootsTouchBraid(scene);
leaves.geometry.computeBoundingBox();
assert.ok(leaves.geometry.boundingBox!.max.z - leaves.geometry.boundingBox!.min.z > .1, "blades have real curvature and droop");
const leafA = new THREE.Matrix4(), leafB = new THREE.Matrix4();
leaves.getMatrixAt(0, leafA); leaves.getMatrixAt(1, leafB);
assert.notDeepEqual(leafA.elements.slice(0, 12), leafB.elements.slice(0, 12), "seeded leaves have varied orientations");
assert.ok(leaves.geometry.getAttribute("uv"), "midrib and vein coordinates travel with the blade");
assert.ok(leaves.customDepthMaterial && leaves.customDistanceMaterial, "deformed leaves have matching directional and point-shadow materials");
layer.clear(); assert.ok(!braid.visible && scene.children.filter(n => (n as THREE.InstancedMesh).isInstancedMesh).every(n => (n as THREE.InstancedMesh).count === 0));
layer.sync([cord], 1); assert.ok(braid.visible, "cleared tubes can be shown again");
layer.sync([], 1); assert.equal(scene.getObjectByName("vine-braid-tube"), undefined, "removed vines release their tubes");
layer.dispose(); assert.equal(scene.children.length, 0);

const bent = [new Vec2(0, 0), new Vec2(0, .3), new Vec2(.3, .6), new Vec2(.3, .6), new Vec2(.7, .7)];
const curve = sampleVineCurve(bent);
assert.deepEqual([curve[0]!.x, curve[0]!.y, curve.at(-1)!.x, curve.at(-1)!.y], [0, 0, .7, .7], "anchors and tip stay exact");
assert.ok(curve.every(p => [p.x, p.y, p.tx, p.ty, p.distance].every(Number.isFinite)), "duplicate links do not create invalid curves");
const joint = curve.findIndex(p => Math.abs(p.y - .3) < 1e-8 && Math.abs(p.x) < 1e-8);
assert.ok(curve[joint - 1]!.tx * curve[joint + 1]!.tx + curve[joint - 1]!.ty * curve[joint + 1]!.ty > .98, "link joints have smooth tangents");
assert.deepEqual(sampleVineCurve([new Vec2(0, 0), new Vec2(0, 0)]), [], "collapsed vines are omitted safely");
const bentScene = new THREE.Scene(), bentLayer = new VineLayer(bentScene);
const bentCord = { ...cord, path: (_alpha: number, out: Vec2[]) => { out.length = 0; out.push(...bent); } };
bentLayer.sync([bentCord], 1);
const bentNormals = posedBraid(bentScene).getAttribute("normal");
assert.ok(Array.from(bentNormals.array).every(Number.isFinite), "bending tubes have finite normals");
assertLeafRootsTouchBraid(bentScene);
assertLeafBladesClear(bentScene, "bent");
bentLayer.dispose();
for (const seed of [0, 1798]) {
  const seededScene = new THREE.Scene(), seededLayer = new VineLayer(seededScene);
  seededLayer.sync([{ ...cord, braidSeed: seed }], 1);
  assertLeafRootsTouchBraid(seededScene); assertLeafBladesClear(seededScene, `seed ${seed}`);
  seededLayer.dispose();
}

const lag = new VineLeafLag(), root = new THREE.Vector3();
lag.update(root, 0, .2);
root.x += .02; lag.update(root, 1 / 60, .2);
assert.ok(lag.offset.x < 0 && lag.offset.length() <= .2 * .18, "leaf tip lags behind a moving attachment within its bound");
const frozen = lag.offset.clone(); lag.update(root, 1 / 60, .2);
assert.deepEqual(lag.offset, frozen, "pause freezes secondary motion");
for (let frame = 2; frame <= 180; frame++) lag.update(root, frame / 60, .2);
assert.ok(lag.offset.length() < 1e-7, "leaf settles after motion ends");
root.x += 10; lag.update(root, 181 / 60, .2); assert.equal(lag.offset.length(), 0, "teleports reset secondary motion");
lag.update(root, 0, .2); assert.equal(lag.offset.length(), 0, "replay seeks reset secondary motion");

const model = modelFromDisk(ball);
// The shipped level includes a huge scene object; Visuals must frame its
// vines without trying to allocate millions of grid lines.
const guides = new Guides();
guides.sync({ model, rev: 0, selectedIds: new Set(), selectedBodyIds: new Set(),
  selectedVerts: new Set(), visibleLayers: new Set(ED_LAYERS), lockedLayers: new Set() });
let gridLines = 0;
guides.group.traverse(node => {
  if (node.name.startsWith("grid-") && (node as THREE.LineSegments).isLineSegments)
    gridLines += (node as THREE.LineSegments).geometry.getAttribute("position").count / 2;
});
assert.ok(gridLines > 0 && gridLines <= 6002, "Visuals grid remains bounded");
guides.dispose();
model.vines[0]!.braidSeed = 0;
model.vines[1]!.braidSeed = 1701;
const saved = modelToDisk(model), loaded = modelFromDisk(saved);
assert.equal(loaded.vines[0]!.braidSeed, 0, "zero is a valid seed and survives a save");
assert.equal(loaded.vines[1]!.braidSeed, 1701, "a second braid survives a reload");
const scaled = scaleLevelData(scaleLevelData(saved, PX), PIXELS_PER_METER);
assert.deepEqual(scaled.vines?.map(v => v.braidSeed), saved.vines?.map(v => v.braidSeed), "seeds are not lengths");
const cloned = cloneVine(loaded.vines[0]!); cloned.braidSeed = 99;
assert.equal(loaded.vines[0]!.braidSeed, 0, "copy and undo snapshots own their seed");

const raw: RawLevelData = { player: { x: -100, y: 100, radius: 12 }, bodies: [
  { kind: "static", x: 0, y: 300, rot: 0, objects: [{ type: "collision", shape: { kind: "rect", w: 1000, h: 30 } }] },
  { kind: "static", x: 0, y: -150, rot: 0, swingAmp: .7, swingPeriod: 3, objects: [
    { type: "collision", shape: { kind: "rect", w: 180, h: 20 } }, { type: "anchor", id: 1, x: 70, y: 10 }
  ] }
], vines: [{ anchor: 1, length: 300 }] };
const plain = new Level(raw), braided = new Level({ ...raw, vines: [{ ...raw.vines![0]!, braidSeed: 1701 }] });
const movingScene = new THREE.Scene(), movingLayer = new VineLayer(movingScene);
const movingPath: Vec2[] = []; braided.vines[0]!.path(1, movingPath);
const firstRoot = movingPath[0]!; let anchorMotion = 0, tipLag = 0;
for (let frame = 0; frame < 120; frame++) {
  plain.physicsProcess(emptyFrameInput(), 1 / 60); braided.physicsProcess(emptyFrameInput(), 1 / 60);
  movingLayer.sync(braided.vines, .5, frame / 60);
  if (frame === 0 || frame === 60 || frame === 119) {
    assertLeafRootsTouchBraid(movingScene); assertLeafBladesClear(movingScene, `swing frame ${frame}`);
  }
  braided.vines[0]!.path(1, movingPath); anchorMotion = Math.max(anchorMotion, firstRoot.distanceTo(movingPath[0]!));
  const bladeShape = (movingScene.getObjectByName("vine-leaves") as THREE.Mesh).geometry.getAttribute("leafShape");
  for (let i = 0; i < bladeShape.count; i++) tipLag = Math.max(tipLag, Math.hypot(bladeShape.getZ(i), bladeShape.getW(i)));
  assert.deepEqual(braided.vines[0]!.links.map(link => link.globalPosition), plain.vines[0]!.links.map(link => link.globalPosition),
    "braiding never changes the moving vine's simulation");
}
assert.ok(anchorMotion > .01, "the comparison exercises an actually moving anchor");
assert.ok(tipLag > .0001 && tipLag <= .18 + 1e-6, "actual swinging physics drives finite bounded tip deformation");
movingLayer.dispose();

// A real two-ended span grabbed by the player: both load paths are active,
// while leaves and the braid remain purely visual through the loaded bend.
const spanRaw: RawLevelData = { player: { x: 200, y: -250, radius: 12 }, bodies: [
  { kind: "static", x: 0, y: 600, rot: 0, objects: [{ type: "collision", shape: { kind: "rect", w: 3000, h: 40 } }] },
  { kind: "static", x: 0, y: -500, rot: 0, objects: [
    { type: "collision", shape: { kind: "rect", w: 600, h: 40 } }, { type: "anchor", id: 1, x: 0, y: 20 }
  ] },
  { kind: "static", x: 400, y: -500, rot: 0, objects: [
    { type: "collision", shape: { kind: "rect", w: 200, h: 40 } }, { type: "anchor", id: 2, x: 0, y: 20 }
  ] }
], vines: [{ anchor: 1, anchor2: 2, length: 500 }] };
const plainSpan = new Level(spanRaw), braidedSpan = new Level({ ...spanRaw, vines: [{ ...spanRaw.vines![0]!, braidSeed: 1798 }] });
const spanScene = new THREE.Scene(), spanLayer = new VineLayer(spanScene);
for (let frame = 0; frame < 30; frame++) {
  plainSpan.physicsProcess(emptyFrameInput(), 1 / 60); braidedSpan.physicsProcess(emptyFrameInput(), 1 / 60);
}
const spanVine = braidedSpan.vines[0]!, spanAim = spanVine.links[Math.floor(spanVine.links.length / 2)]!.globalPosition;
let spanHeld = false, spanTwist = 0;
const spanTwistProbe = new VineTwist(), spanPath: Vec2[] = [];
for (let frame = 0; frame < 180; frame++) {
  const input = emptyFrameInput();
  input.mouseWorldPosition = spanAim; input.fire = { held: true, pressed: frame === 0, released: false };
  input.retract.held = true;
  plainSpan.physicsProcess(input, 1 / 60); braidedSpan.physicsProcess(input, 1 / 60);
  spanLayer.sync(braidedSpan.vines, 1, (frame + 30) / 60);
  spanVine.path(1, spanPath);
  const loadedCurve = sampleVineCurve(spanPath, [], [], spanVine.restLength);
  spanTwistProbe.update(loadedCurve, (frame + 30) / 60, true);
  spanTwist = Math.max(spanTwist, ...loadedCurve.map(p => Math.abs(p.twist!)));
  spanHeld ||= spanVine.lra !== null && spanVine.lra2 !== null;
  if (frame === 0 || frame === 90 || frame === 179) {
    assertLeafRootsTouchBraid(spanScene); assertLeafBladesClear(spanScene, `span frame ${frame}`);
  }
  assert.deepEqual(spanVine.links.map(link => link.globalPosition), plainSpan.vines[0]!.links.map(link => link.globalPosition),
    "surface attachments never change a grabbed two-ended span's physics");
}
assert.ok(spanHeld, "the span test actually engages the player's load path to both anchors");
assert.ok(spanTwist > .00001, "actual player loading drives a small strain-based twist, not a preset animation");
for (let frame = 0; frame < 120; frame++) {
  const input = emptyFrameInput(); input.fire.released = frame === 0;
  plainSpan.physicsProcess(input, 1 / 60); braidedSpan.physicsProcess(input, 1 / 60);
  spanLayer.sync(braidedSpan.vines, 1, (frame + 210) / 60);
  assert.equal(spanVine.lra, null, "release removes first load path");
  assert.equal(spanVine.lra2, null, "release removes second load path");
  if (frame === 0 || frame === 60 || frame === 119) {
    assertLeafRootsTouchBraid(spanScene); assertLeafBladesClear(spanScene, `released span frame ${frame}`);
  }
  assert.deepEqual(spanVine.links.map(link => link.globalPosition), plainSpan.vines[0]!.links.map(link => link.globalPosition),
    "braid relaxation never alters the released span's physics");
}
spanLayer.dispose();
console.log(`PASS vine braid: material nodes under uneven strain, pinned-end damped torsion, irregular touching stems, zero buried blade vertices in straight/bent/swinging/pulled/released spans, botanical shadows, bounded lag, cleanup, save/load and identical physics (anchor motion ${anchorMotion.toFixed(3)} m, tip deformation ${tipLag.toFixed(3)}, loaded-span twist ${spanTwist.toFixed(5)} rad)`);
