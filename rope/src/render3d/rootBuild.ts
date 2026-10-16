// A body's ROOTS as the meshes the game draws (docs/roots.md#the-look): each
// branch grown (`rootMesh.ts`), a branched tree fused at its forks
// (`rootFork.ts`), and every mesh then simplified to what can be seen.
//
// Built in the WORLD frame, from the level data alone, so the same body grows
// the same meshes wherever it is built - in the game, in the editor, and by
// `bun run roots:bake`, which writes them to a file the game loads instead of
// growing them (`rootBake.ts`). That is also why a body is known by a KEY
// (`rootKey.ts`): a hash of exactly what the meshes are grown from, which the
// bake files its meshes under and a level's body looks itself up by. A change
// here that changes what is built bumps `ROOT_MESH_VERSION` there.

import * as THREE from "three";
import { MeshoptSimplifier } from "meshoptimizer/simplifier";

import { worldPlacement } from "../level/buildBodies";
import { isCollisionObject, type LevelBodyData } from "../level/levelFormat";
import { fuseRootForks } from "./rootFork";
import { rootGeometry } from "./rootMesh";

// How far, in metres, the simplified surface may stray from the grown one
// (meshoptimizer's absolute error). Tuned on ball.json (2026-10-16) at zoom 5,
// 1080p: 2 mm visibly blunts the thin tips into facets and polygonises the
// bends, 1 mm is all but indistinguishable from the grown mesh magnified 4x,
// and half a millimetre (an eighth of a pixel there, far less at the game's
// zoom of 2) is kept for the editor's closer views. It keeps 22% of the
// triangles: ball.json's roots go from 142k to 31k.
export const ROOT_SIMPLIFY_ERROR = 0.0005;

// How much a vertex's normal and bark coordinates hold it in place against a
// collapse, beside its position: the normals keep the flutes' shading, the
// coordinates the painted grain through a fork.
const NORMAL_WEIGHT = 0.02;
const UV_WEIGHT = 0.005;

// The simplifier is WebAssembly and starts asynchronously; nothing here is
// built before it is ready.
export const rootBuildReady: Promise<void> = MeshoptSimplifier.ready;
let ready = false;
void rootBuildReady.then(() => {
  ready = true;
});

export function rootBuildIsReady(): boolean {
  return ready;
}

// Every root piece of the body as its mesh, by object index, in world metres
// with the gameplay plane at z = 0. Must not be called before
// `rootBuildReady` has resolved.
export function buildRootMeshes(data: LevelBodyData): Map<number, THREE.BufferGeometry> {
  if (!ready) throw new Error("buildRootMeshes before rootBuildReady");
  const grown = new Map<number, THREE.BufferGeometry>();
  const parents = new Map<number, number>();
  data.objects.forEach((o, i) => {
    if (!isCollisionObject(o) || !o.root || o.shape.kind !== "curve") return;
    const geometry = rootGeometry(o.shape, { trunk: o.root.parent === undefined, seed: i });
    if (!geometry) return;
    const world = worldPlacement(data, o);
    geometry.rotateZ(-world.rot);
    geometry.translate(world.pos.x, -world.pos.y, 0);
    grown.set(i, geometry);
    if (o.root.parent !== undefined) parents.set(i, o.root.parent);
  });
  const out = new Map<number, THREE.BufferGeometry>();
  if (!grown.size) return out;
  // A tree fused at its forks is one mesh per branch, cut where one branch's
  // wood meets another's; those cuts are open edges, which the simplifier
  // keeps exactly so that neighbours still meet. A single branch is closed,
  // and its bark's wrap is a seam the simplifier keeps whole on its own.
  const fused = grown.size > 1;
  for (const [i, geometry] of fuseRootForks(grown, parents)) {
    out.set(i, simplifyRoot(geometry, fused));
    geometry.dispose();
  }
  return out;
}

// The mesh with as few triangles as stay within `ROOT_SIMPLIFY_ERROR` of it,
// every kept vertex exactly as it was (the simplifier only chooses which to
// keep), unreferenced vertices dropped.
export function simplifyRoot(geometry: THREE.BufferGeometry, lockBorder: boolean): THREE.BufferGeometry {
  const positions = geometry.getAttribute("position").array as Float32Array;
  const normals = geometry.getAttribute("normal").array as Float32Array;
  const uvs = geometry.getAttribute("uv").array as Float32Array;
  const count = positions.length / 3;
  const attributes = new Float32Array(count * 5);
  for (let v = 0; v < count; v++) {
    attributes[v * 5] = normals[v * 3]!;
    attributes[v * 5 + 1] = normals[v * 3 + 1]!;
    attributes[v * 5 + 2] = normals[v * 3 + 2]!;
    attributes[v * 5 + 3] = uvs[v * 2]!;
    attributes[v * 5 + 4] = uvs[v * 2 + 1]!;
  }
  const source = geometry.getIndex();
  const indices = source ? new Uint32Array(source.array) : Uint32Array.from({ length: count }, (_, v) => v);
  const [kept] = MeshoptSimplifier.simplifyWithAttributes(
    indices, positions, 3, attributes, 5,
    [NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT, UV_WEIGHT, UV_WEIGHT],
    null, 0, ROOT_SIMPLIFY_ERROR,
    lockBorder ? ["ErrorAbsolute", "LockBorder"] : ["ErrorAbsolute"],
  );
  // Renumbered in first-use order, which is also the order the GPU will
  // fetch them in.
  const [remap, unique] = MeshoptSimplifier.compactMesh(kept);
  const out = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const size = attribute.itemSize;
    const from = attribute.array as Float32Array;
    const to = new Float32Array(unique * size);
    for (let v = 0; v < count; v++) {
      const at = remap[v]!;
      if (at === 0xffffffff) continue;
      for (let c = 0; c < size; c++) to[at * size + c] = from[v * size + c]!;
    }
    out.setAttribute(name, new THREE.BufferAttribute(to, size));
  }
  out.setIndex(new THREE.BufferAttribute(unique > 65535 ? kept : new Uint16Array(kept), 1));
  out.computeBoundingSphere();
  return out;
}
