// What the glass ball's broken pieces land on in 3D: the solid things the 3D
// scene draws, as triangles (Tris, 2026-10-16: "the shards shouldn't just
// bounce around on the 2D plane. They should have 3D physics").
//
// The sim's collision is outlines in the gameplay plane, and the pieces used
// to collide with those outlines extruded 2 m through it - a slab with flat
// walls and flat tops, held to the depth they broke at so they could not fall
// off its ends. What the player sees is the Blender scene: rock that rises and
// falls across its depth, ledges that run back into the cave, gaps between
// stones. So the pieces collide with THAT, and move freely in all three
// dimensions: a shard thrown toward the camera lands on the rock in front of
// the plane, or falls past it, as one would.
//
// Two kinds of mesh are handed over (`ShardCollision`):
//
//   SCENERY - the scene's static meshes, at Blender's world poses (the
//             `scenery` group of `SceneDressing`), in three's world frame.
//   BODIES  - what a level body draws (its bound scene nodes, its props, its
//             debug solid while shown), in the body's own frame, which the
//             pieces' world moves with the body (a mover's platform).
//
// Only SOLID meshes (`solidMesh`): not leaves (ferns, ivy - alpha-cut cards),
// not a shadow decal, not water, not a see-through surface, not the depth
// prepass's stand-ins (each a second copy of its mesh's triangles). Printed
// moss is alpha-cut too, but it is a cushion on the rock, and a shard lands on
// it. Scenery wholly further than `SCENERY_REACH` from the plane is left out:
// the far backdrop of a cave, which no shard can reach.

import * as THREE from "three";
import { isDepthStandIn } from "./depthPrepass";

// Metres either side of the gameplay plane a scenery mesh must reach into to
// be collided with. A break throws pieces a metre or two at most before they
// fade (render/glassShardsSim.ts `FADE_START`).
const SCENERY_REACH = 6;

// A mesh's triangles: three floats a vertex, three indices a triangle.
export interface CollisionMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export interface ShardCollision<Body> {
  // The scene's static meshes, under a key naming the scene (null: none).
  readonly scenery: { readonly key: string; readonly meshes: readonly CollisionMesh[] } | null;
  // What a body draws that is solid, in its own frame (`bodyTriangles`).
  bodyMeshes(body: Body): readonly CollisionMesh[];
}

// Where the pieces' world gets it from (`Scene3D`): `version` changes whenever
// what it would hand over does (a level set, a scene file landing), and
// `collision` is null while it is not ready, when the pieces fall back on the
// sim's outlines.
export interface ShardCollisionSource<Body> {
  collisionVersion(): number;
  shardCollision(): ShardCollision<Body> | null;
}

// Blender names a mesh answers to: its own and its ancestors' (GLTFLoader keeps
// the original, dotted name in `userData.name`; an unnamed node the optimiser
// made is known by the named one above it).
function namesOf(o: THREE.Object3D): string[] {
  const out: string[] = [];
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    const n = typeof p.userData.name === "string" ? p.userData.name : p.name;
    if (n) out.push(n);
  }
  return out;
}

// Whether a mesh is something a piece of glass lands on (see the header).
export function solidMesh(o: THREE.Object3D): o is THREE.Mesh {
  const mesh = o as THREE.Mesh;
  if (!mesh.isMesh || isDepthStandIn(mesh)) return false;
  if ((mesh as unknown as THREE.InstancedMesh).isInstancedMesh || (mesh as unknown as THREE.BatchedMesh).isBatchedMesh) return false;
  if ((mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh) return false;
  const position = mesh.geometry?.getAttribute("position");
  if (!position) return false;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of materials) {
    if (!m) return false;
    if (m.transparent || !m.depthWrite) return false;
    if (m.userData.ivyLeaves) return false;
    if (/^Foliage(\.\d+)?$/.test(m.name)) return false;
    if (m.alphaTest > 0 && !m.userData.mossMound) return false;
  }
  for (const n of namesOf(mesh)) {
    if (/\.(ivy|moss)\.shadow$/.test(n) || /\.ivy$/.test(n) || n === "backdrop pool") return false;
  }
  return true;
}

const box = new THREE.Box3();
const local = new THREE.Matrix4();
const v = new THREE.Vector3();

// `mesh`'s triangles carried by `toFrame` (the mesh's world matrix into the
// frame wanted). Read through the attribute, which undoes a quantized
// position's normalisation.
export function trianglesOf(mesh: THREE.Mesh, toFrame: THREE.Matrix4): CollisionMesh | null {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const count = position.count;
  if (count < 3) return null;
  local.multiplyMatrices(toFrame, mesh.matrixWorld);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(position, i).applyMatrix4(local);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
  }
  const index = geometry.getIndex();
  let indices: Uint32Array;
  if (index) {
    indices = new Uint32Array(index.count);
    for (let i = 0; i < index.count; i++) indices[i] = index.getX(i);
  } else {
    indices = Uint32Array.from({ length: count - (count % 3) }, (_, i) => i);
  }
  // A mirroring transform turns every triangle inside out.
  if (local.determinant() < 0) {
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const t = indices[i + 1]!;
      indices[i + 1] = indices[i + 2]!;
      indices[i + 2] = t;
    }
  }
  return indices.length >= 3 ? { positions, indices } : null;
}

// The scenery's solid meshes under `root`, in the world's frame.
export function sceneryTriangles(root: THREE.Object3D): CollisionMesh[] {
  root.updateWorldMatrix(true, true);
  const out: CollisionMesh[] = [];
  const world = new THREE.Matrix4();
  root.traverse((o) => {
    if (!solidMesh(o)) return;
    const mesh = o;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    box.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    if (box.max.z < -SCENERY_REACH || box.min.z > SCENERY_REACH) return;
    const t = trianglesOf(mesh, world);
    if (t) out.push(t);
  });
  return out;
}

// What a body's root draws that is solid and shown, in the body's own frame:
// its position in the plane and its turn about z (the frame the pieces' world
// gives the body, render/glassShardsSim.ts).
export function bodyTriangles(root: THREE.Object3D): CollisionMesh[] {
  root.updateWorldMatrix(true, true);
  const frame = new THREE.Matrix4().makeRotationZ(root.rotation.z).setPosition(root.position.x, root.position.y, 0);
  if (root.parent) frame.premultiply(root.parent.matrixWorld);
  const toBody = frame.invert();
  const out: CollisionMesh[] = [];
  root.traverseVisible((o) => {
    if (!solidMesh(o)) return;
    const t = trianglesOf(o, toBody);
    if (t) out.push(t);
  });
  return out;
}
