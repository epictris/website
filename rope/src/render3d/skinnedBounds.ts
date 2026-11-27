import * as THREE from "three";

// A skinned mesh's posed bounds without skinning a vertex.
//
// three's `SkinnedMesh.computeBoundingBox` skins EVERY vertex on the CPU, and
// the sun's shadow fit asked for it on every bending root every frame: the
// relief bark is tens of thousands of vertices, and on the BALL level that was
// 3.7 ms of a 9.8 ms frame (trace 2026-11-27), the largest single cost of the
// main thread.
//
// What it costs here is a box per bone, gathered once: the bind-space box of
// every vertex the bone has a weight on. A skinned vertex is
//
//   bindMatrixInverse * sum_i w_i * (B_i * bindMatrix * v),  B_i = bone_i.matrixWorld * boneInverse_i
//
// and with weights that are non-negative and sum to one that is a convex
// combination of points each inside its bone's box carried by B_i, so it lies
// inside the union of those carried boxes. Each frame is then 8 corners a bone.
// The bound is conservative - a carried box is boxed again - never short.
//
// A geometry the argument does not hold for (morph targets, a negative weight,
// weights that do not sum to one) falls back to three's exact walk, so the
// answer is never wrong, only sometimes slow.

interface BoneBoxes {
  geometry: THREE.BufferGeometry;
  versions: string;
  bind: THREE.Matrix4;
  // One per bone; null for a bone no vertex leans on.
  boxes: (THREE.Box3 | null)[] | null;
}

const cache = new WeakMap<THREE.SkinnedMesh, BoneBoxes>();
const bone = new THREE.Matrix4();
const carried = new THREE.Box3();
const vertex = new THREE.Vector3();
const WEIGHT_SUM_TOLERANCE = 1e-3;

export function skinnedBoundingBox(mesh: THREE.SkinnedMesh, target: THREE.Box3): THREE.Box3 {
  const boxes = boneBoxesOf(mesh);
  if (!boxes) {
    mesh.computeBoundingBox();
    return target.copy(mesh.boundingBox!);
  }
  target.makeEmpty();
  const { bones, boneInverses } = mesh.skeleton;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (!box) continue;
    bone.multiplyMatrices(bones[i]!.matrixWorld, boneInverses[i]!).premultiply(mesh.bindMatrixInverse);
    target.union(carried.copy(box).applyMatrix4(bone));
  }
  return target;
}

function boneBoxesOf(mesh: THREE.SkinnedMesh): (THREE.Box3 | null)[] | null {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const skinIndex = geometry.getAttribute("skinIndex");
  const skinWeight = geometry.getAttribute("skinWeight");
  const versions = `${versionOf(position)}|${versionOf(skinIndex)}|${versionOf(skinWeight)}|${mesh.skeleton.bones.length}`;
  const cached = cache.get(mesh);
  if (cached && cached.geometry === geometry && cached.versions === versions && cached.bind.equals(mesh.bindMatrix)) return cached.boxes;

  const entry: BoneBoxes = { geometry, versions, bind: mesh.bindMatrix.clone(), boxes: null };
  cache.set(mesh, entry);
  if (!position || !skinIndex || !skinWeight) return null;
  if (geometry.morphAttributes.position?.length) return null;

  const boxes: (THREE.Box3 | null)[] = mesh.skeleton.bones.map(() => null);
  for (let v = 0; v < position.count; v++) {
    vertex.fromBufferAttribute(position, v).applyMatrix4(mesh.bindMatrix);
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(v, k);
      if (w < 0) return null;
      if (w === 0) continue;
      sum += w;
      const b = skinIndex.getComponent(v, k);
      if (b < 0 || b >= boxes.length) return null;
      (boxes[b] ??= new THREE.Box3()).expandByPoint(vertex);
    }
    if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) return null;
  }
  entry.boxes = boxes;
  return boxes;
}

const versionOf = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined): number =>
  a === undefined ? -1 : "version" in a ? a.version : a.data.version;
