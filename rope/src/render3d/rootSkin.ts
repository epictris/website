// A BENDING root drawn bending (docs/roots.md, "Bending roots"): the root's
// meshes are grown as they always are, from the authored curves in the
// authored pose (`rootBuild.ts`, the bake), and then SKINNED to the bodies
// that hold the stretches of each branch - the root's own body and its
// segments (`RootBending`) - so a branch bends where its hinges turn and the
// bake is the same bake whether a root bends or not.
//
// One bone per body. A vertex is weighted by where it projects along its
// branch's centreline: wholly the body of the stretch it is on, and across a
// window either side of each bend, eased from the body before to the body
// after, so the bend is drawn as a curve through the hinge rather than a
// crease the two tubes meet at.
//
// The meshes stay where they always were in the scene graph, under the root's
// own body (`BodyVisual`), so a bone is the motion of its body RELATIVE to the
// root's own: the root's bone is the identity, and a segment's is its pose now
// against its pose as built, read in the root's frame. Render-side only.

import * as THREE from "three";
import { Vec2 } from "../engine/vec2";
import type { RootBending } from "../level/buildBodies";
import { buildPolylineIndex, projectOntoPolyline } from "../lib/path";
import { threeRotation, threeY } from "./space";

// How far either side of a bend the drawn branch eases from one body to the
// next, metres along it. A guess to be looked at: wide enough that a bend of
// a few tens of degrees draws as a curve, narrow enough that the stretch
// either side stays straight.
export const ROOT_BEND_BLEND = 0.08;

// How far out of its crease a branch eases into its bend, in its base
// half-widths: wood flexes over a run, so a branch bending at its fork curves
// out of it rather than turning a corner at the seam. One half-width drew a
// notch under the fork at 30° (`session-55f`); two curve. Not wider: a long
// ease is the stub that never bends (`session-52f`) by degrees.
export const ROOT_CREASE_EASE = 2;

// The geometry of one branch, skinned: a copy of the grown geometry (shared in
// the cache, so never written to) in the world as authored, with each vertex's
// bones and weights. Bone `0` is the root's own body, bone `1 + j` segment `j`.
export function skinRootGeometry(
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4 | null,
  branch: {
    readonly line: readonly Vec2[];
    readonly cuts: readonly number[];
    readonly bodies: readonly number[];
    // Hinged where it grows: `cuts[0]` is its first node, `bodies[0]` the
    // parent's stretch it grows from.
    readonly hingedAtBase?: boolean;
    readonly baseHalfWidth?: number;
  },
  // The parent's mesh as drawn, when the branch is fused into it: the
  // vertices the two share are the crease's.
  parent: { readonly geometry: THREE.BufferGeometry; readonly matrix: THREE.Matrix4 | null } | null = null,
): THREE.BufferGeometry {
  const geo = expanded(geometry, matrix);
  const position = geo.getAttribute("position");
  const n = position.count;
  const index = new Uint16Array(n * 4);
  const weight = new Float32Array(n * 4);
  const line = buildPolylineIndex(branch.line);
  const bone = (k: number): number => (branch.bodies[k] ?? -1) + 1;
  // The body the branch's own wood is fused into its parent's with: the one
  // its first stretch hangs from (for a branch hinged where it grows, the
  // parent's stretch, prepended to `bodies`).
  const rooted = bone(0);
  // The CREASE: the branch's vertices that are also its parent's. The
  // parent's mesh moves with the parent, so these stay with the rooted body
  // or the surface tears open at the fork (`session-82f`, Tris: "the bending
  // joint rips the geometry apart"), and the branch eases into its own bend
  // over one base half-width beyond them. Only the seam itself is held: a
  // girth-wide band about the parent held once, and left a stub of branch
  // standing straight out of the parent past a hinge at the fork while the
  // rest swung (`session-52f`, Tris: "it's like there's a 'knub' that never
  // gets bent").
  const crease = parent ? sharedVertices(position, expanded(parent.geometry, parent.matrix).getAttribute("position")) : [];
  const creaseBlend = Math.max((branch.baseHalfWidth ?? 0) * ROOT_CREASE_EASE, 1e-3);
  // How far either side of bend `j` it is drawn easing between its two
  // bodies: `ROOT_BEND_BLEND`, or half the way to the next bend either side
  // if that is nearer. Two windows that overlapped would hand a vertex from
  // one bend's pair of bodies to the next's mid-ease, and crack the bark
  // between them; a branch flexing over a run of close bends is how a fork
  // that bends a long way is drawn (docs/roots.md, "Bending roots").
  const windowOf = (j: number): number => {
    const c = branch.cuts[j]!;
    const before = branch.cuts[j - 1];
    const after = branch.cuts[j + 1];
    return Math.min(
      ROOT_BEND_BLEND,
      before === undefined ? Infinity : (c - before) / 2,
      after === undefined ? Infinity : (after - c) / 2,
    );
  };
  const p3 = new THREE.Vector3();
  for (let v = 0; v < n; v++) {
    const p = new Vec2(position.getX(v), -position.getY(v));
    const s = projectOntoPolyline(line, p).s;
    let free = 1;
    if (crease.length) {
      p3.fromBufferAttribute(position, v);
      let nearest = Infinity;
      for (const q of crease) nearest = Math.min(nearest, p3.distanceToSquared(q));
      free = smoothstep(Math.sqrt(nearest) / creaseBlend);
    }
    let k = 0;
    while (k < branch.cuts.length && branch.cuts[k]! < s) k++;
    // A branch hinged where it grows is the outboard body's from its first
    // node on, everything the parent does not cover of it: the crease is its
    // whole easing, and no window either side of the hinge carries part of
    // the parent's pose out into the branch.
    if (branch.hingedAtBase) k = Math.max(k, 1);
    // The nearer bend, either side, and how far into its window this vertex is.
    let near = -1;
    let d = Infinity;
    for (const j of [k - 1, k]) {
      const c = branch.cuts[j];
      if (c === undefined || (branch.hingedAtBase && j === 0)) continue;
      if (Math.abs(s - c) < Math.abs(d)) {
        d = s - c;
        near = j;
      }
    }
    // The bend's own weights, two bones at most...
    let a = bone(k);
    let b = a;
    let t = 0;
    const window = near >= 0 ? windowOf(near) : 0;
    if (near >= 0 && Math.abs(d) < window) {
      a = bone(near);
      b = bone(near + 1);
      t = smoothstep((d + window) / (2 * window));
    }
    // ...and what of them is not free of the parent goes to the rooted body.
    const weights = new Map<number, number>();
    const add = (bn: number, w: number): void => {
      if (w > 0) weights.set(bn, (weights.get(bn) ?? 0) + w);
    };
    add(a, (1 - t) * free);
    add(b, t * free);
    add(rooted, 1 - free);
    let slot = 0;
    for (const [bn, w] of weights) {
      if (slot >= 4) break;
      index[v * 4 + slot] = bn;
      weight[v * 4 + slot] = w;
      slot++;
    }
  }
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(index, 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weight, 4));
  return geo;
}

// A geometry held wholly by one bone: a stretch of a branch's DEBUG geometry,
// which is the collision it draws and so moves rigidly with the one body that
// collides as it (`BodyVisual.mountDebug`) - no blend across the bend, which
// the collision does not have either. Written onto `geometry` itself, which is
// the visual's own.
export function skinToBone(geometry: THREE.BufferGeometry, bone: number): THREE.BufferGeometry {
  const n = geometry.getAttribute("position").count;
  const index = new Uint16Array(n * 4);
  const weight = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    index[v * 4] = bone;
    weight[v * 4] = 1;
  }
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(index, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weight, 4));
  return geometry;
}

// A copy of a grown or baked geometry where it is drawn, in floats. A BAKED
// geometry (`rootBake.ts`) is quantized - positions in 16-bit normalized
// integers, normals in 12 - with the node's matrix as the dequantization.
// Written back into those buffers, world coordinates overflow them: the first
// skinned bark read from the bake stood up to 22 m from where it was baked.
// So the attributes the matrix moves are expanded to floats first, read
// through the attribute's own decoding.
function expanded(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4 | null): THREE.BufferGeometry {
  const geo = geometry.clone();
  if (!matrix) return geo;
  for (const name of ["position", "normal", "tangent"]) {
    const a = geo.getAttribute(name);
    if (a) geo.setAttribute(name, floatCopy(a));
  }
  return geo.applyMatrix4(matrix);
}

// How near two meshes' vertices must be to be the same vertex: each bake
// node is quantized to 16 bits over its own bounds, a few hundredths of a
// millimetre over a root's metre or two, so a vertex two pieces share lands
// a little apart in each.
const SHARED_TOLERANCE = 2e-4;

// The positions of `own` that `other` has too, within `SHARED_TOLERANCE`.
function sharedVertices(
  own: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  other: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): THREE.Vector3[] {
  const cell = (x: number): number => Math.floor(x / SHARED_TOLERANCE);
  const grid = new Map<string, THREE.Vector3[]>();
  for (let i = 0; i < other.count; i++) {
    const q = new THREE.Vector3(other.getX(i), other.getY(i), other.getZ(i));
    const key = `${cell(q.x)},${cell(q.y)},${cell(q.z)}`;
    const list = grid.get(key);
    if (list) list.push(q);
    else grid.set(key, [q]);
  }
  const out: THREE.Vector3[] = [];
  const p = new THREE.Vector3();
  const near = (): boolean => {
    const x = cell(p.x), y = cell(p.y), z = cell(p.z);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const q of grid.get(`${x + dx},${y + dy},${z + dz}`) ?? []) if (q.distanceToSquared(p) <= SHARED_TOLERANCE * SHARED_TOLERANCE) return true;
    }
    return false;
  };
  for (let i = 0; i < own.count; i++) {
    p.set(own.getX(i), own.getY(i), own.getZ(i));
    if (near()) out.push(p.clone());
  }
  return out;
}

// An attribute as plain floats, every component read through its own
// decoding (normalized integers, an interleaved buffer).
function floatCopy(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const out = new Float32Array(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) {
    for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
  }
  return new THREE.Float32BufferAttribute(out, a.itemSize);
}

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

// The bones of one bending root: the root's own body's and one per segment,
// out of the scene graph and written each frame (`update`).
export class RootSkeleton {
  readonly skeleton: THREE.Skeleton;
  private readonly bones: THREE.Bone[];

  constructor(segments: number) {
    this.bones = Array.from({ length: segments + 1 }, () => {
      const b = new THREE.Bone();
      b.matrixAutoUpdate = false;
      b.matrixWorldAutoUpdate = false;
      return b;
    });
    this.skeleton = new THREE.Skeleton(this.bones, this.bones.map(() => new THREE.Matrix4()));
  }

  // Each segment's pose now against its pose as built, in the root's frame:
  // `rest_root ∘ now_root⁻¹ ∘ now_seg ∘ rest_seg⁻¹`, a rigid motion of the
  // plane, written as the three.js matrix it is in that space.
  update(
    rootRest: { pos: Vec2; rot: number },
    rootNow: { pos: Vec2; rot: number },
    bending: RootBending,
    segmentsNow: readonly { pos: Vec2; rot: number }[],
  ): void {
    this.bones[0]!.matrixWorld.identity();
    for (let j = 0; j < segmentsNow.length; j++) {
      const rest = bending.segmentRest[j]!;
      const now = segmentsNow[j]!;
      const map = (p: Vec2): Vec2 => {
        const inSeg = p.sub(rest.pos).rotated(-rest.rot);
        const world = inSeg.rotated(now.rot).add(now.pos);
        const inRoot = world.sub(rootNow.pos).rotated(-rootNow.rot);
        return inRoot.rotated(rootRest.rot).add(rootRest.pos);
      };
      const rot = rootRest.rot - rootNow.rot + now.rot - rest.rot;
      const t = map(Vec2.ZERO);
      const m = this.bones[j + 1]!.matrixWorld;
      m.makeRotationZ(threeRotation(rot));
      m.setPosition(t.x, threeY(t.y), 0);
    }
  }
}
