// A loop painted ON THE FACES of the scene's models, and the part of those
// faces it covers: what the `+ Mushrooms` tool turns into the triangle soup the
// mushroom patch generator grows on (plans/visuals-workspace.md, "The mushroom
// tool and panel").
//
// Ported from the fork (karin_website, rope/src/editor/surfacePatch.ts):
// `frameOf` and `collect` are its arithmetic unchanged, kept pure so the
// `generator:` cases can run them on a box in bun. What is new here is the
// retry that cannot spin (the fork's grew the subdivision step for ever when
// the loop covered more whole faces than the cap), and the patch object's frame
// (`patchMatrix`), which the loop is stored in and the soup is sent in.
//
// Everything is in three's WORLD frame (x right, y up, z toward the camera,
// metres) unless it says otherwise. Editor-only: nothing here reaches the sim.
//
// The loop is a run of points on a curved surface, so "inside" is judged on its
// plane of best fit: each candidate face is projected along that plane's normal
// and kept where it lands inside the loop, faces toward the patch (so the back
// of a rock is not taken with its front), is no steeper than the patch's
// `maxSlope` (mushrooms grow up, so one under a ledge grows into it), and lies
// within a band of the plane (so a far wall seen through the loop is not taken
// either). Faces are subdivided first, down to a step that scales with the
// loop, so a big low-poly facet is cut to the painted edge rather than taken
// whole.

import * as THREE from "three";

export interface SurfacePoint {
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
}

export interface SurfaceSelection {
  // Triangle soup, 9 floats per triangle, in the frame the meshes were read in.
  positions: Float32Array;
  triangles: number;
  area: number; // m^2
}

// The loop's plane of best fit and the loop drawn on it.
export interface SurfaceFrame {
  origin: THREE.Vector3;
  // The plane's normal, toward the side the loop was painted on, and two axes
  // in it.
  n: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  // The loop in (u, v), metres from `origin`, and its box.
  loop: [number, number][];
  min: [number, number];
  max: [number, number];
  // How far off the plane a face may lie and still be taken (m): the loop's own
  // deviation from flat plus a third of its size, so a boss on the rock inside
  // the loop is taken and a wall a metre behind it is not.
  band: number;
  // The longest edge a taken face is cut down to (m): a 48th of the loop's
  // size, between 1 cm and 10 cm.
  step: number;
}

// Band beyond the loop's own deviation: at least this (m), else this share of
// the loop's diameter (dimensionless). The fork's values.
const BAND_FLOOR = 0.05;
const BAND_SHARE = 0.35;
// The subdivision step: the loop's diameter over this (dimensionless), held to
// [STEP_MIN, STEP_MAX] metres.
const STEP_DIVISIONS = 48;
const STEP_MIN = 0.01;
const STEP_MAX = 0.1;
// A loop smaller than this across (m) is a slip of the hand, not a patch.
const MIN_DIAMETER = 1e-3;
// A face must face the patch at least this much (the cosine of its normal on
// the plane's, dimensionless) to be taken: a sliver seen edge-on through the
// loop is the rock's side, not its top.
const MIN_FACING = 0.15;
// How deep one face may be cut (halvings), and how much the step grows (ratio)
// each time the cut soup is over the triangle cap.
const MAX_SUBDIVISION = 8;
const STEP_GROWTH = 1.5;

// The loop's plane of best fit (Newell's method), oriented to agree with the
// faces it was clicked on, and the 2D loop on it. Null for fewer than three
// points or a loop with no extent.
export function frameOf(outline: readonly SurfacePoint[]): SurfaceFrame | null {
  if (outline.length < 3) return null;
  const origin = new THREE.Vector3();
  const facing = new THREE.Vector3();
  for (const p of outline) {
    origin.add(p.point);
    facing.add(p.normal);
  }
  origin.divideScalar(outline.length);
  const n = new THREE.Vector3();
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!.point;
    const b = outline[(i + 1) % outline.length]!.point;
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  if (n.lengthSq() < 1e-12) n.copy(facing);
  if (n.lengthSq() < 1e-12) return null;
  n.normalize();
  if (n.dot(facing) < 0) n.negate();
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(n.dot(u)) > 0.9) u.set(0, 1, 0);
  u.sub(n.clone().multiplyScalar(n.dot(u))).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  const loop: [number, number][] = [];
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  let dev = 0;
  const d = new THREE.Vector3();
  for (const p of outline) {
    d.subVectors(p.point, origin);
    const q: [number, number] = [d.dot(u), d.dot(v)];
    loop.push(q);
    min[0] = Math.min(min[0], q[0]);
    min[1] = Math.min(min[1], q[1]);
    max[0] = Math.max(max[0], q[0]);
    max[1] = Math.max(max[1], q[1]);
    dev = Math.max(dev, Math.abs(d.dot(n)));
  }
  const diameter = Math.hypot(max[0] - min[0], max[1] - min[1]);
  if (diameter < MIN_DIAMETER) return null;
  return {
    origin,
    n,
    u,
    v,
    loop,
    min,
    max,
    band: dev + Math.max(BAND_FLOOR, diameter * BAND_SHARE),
    step: Math.min(STEP_MAX, Math.max(STEP_MIN, diameter / STEP_DIVISIONS)),
  };
}

function insideLoop(loop: readonly [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i]!;
    const [xj, yj] = loop[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The lowest `normal.y` a face may have and still be taken, from the steepest
// slope in degrees from level ground (0 = only flat tops, 90 = walls too).
export function minUpOf(maxSlopeDeg: number): number {
  return Math.cos(THREE.MathUtils.degToRad(Math.min(90, Math.max(0, maxSlopeDeg))));
}

// The faces of `meshes` the frame's loop covers, cut to it at `step`, in world
// space. Null when the cut soup would pass `maxTriangles` (try a coarser step);
// a selection of no triangles when nothing faces the loop at this slope.
export function collect(
  meshes: readonly THREE.Mesh[],
  f: SurfaceFrame,
  step: number,
  minUp: number,
  maxTriangles: number,
): SurfaceSelection | null {
  return cutFaces(meshes, f, step, minUp, maxTriangles).selection;
}

// `collect`, saying also whether any face was cut: a soup over the cap with
// nothing cut cannot be made smaller by a coarser step.
function cutFaces(
  meshes: readonly THREE.Mesh[],
  f: SurfaceFrame,
  step: number,
  minUp: number,
  maxTriangles: number,
): { selection: SurfaceSelection | null; cut: boolean } {
  let cut = false;
  const soup: number[] = [];
  let area = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const coord = (p: THREE.Vector3): [number, number, number] => {
    tmp.subVectors(p, f.origin);
    return [tmp.dot(f.u), tmp.dot(f.v), tmp.dot(f.n)];
  };
  const step2 = step * step;
  let overflow = false;

  const emit = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, depth: number): void => {
    if (overflow) return;
    const longest = Math.max(p.distanceToSquared(q), q.distanceToSquared(r), r.distanceToSquared(p));
    if (longest > step2 && depth < MAX_SUBDIVISION) {
      cut = true;
      const pq = p.clone().add(q).multiplyScalar(0.5);
      const qr = q.clone().add(r).multiplyScalar(0.5);
      const rp = r.clone().add(p).multiplyScalar(0.5);
      emit(p, pq, rp, depth + 1);
      emit(pq, q, qr, depth + 1);
      emit(rp, qr, r, depth + 1);
      emit(pq, qr, rp, depth + 1);
      return;
    }
    const m = p.clone().add(q).add(r).divideScalar(3);
    const [x, y, z] = coord(m);
    if (Math.abs(z) > f.band || !insideLoop(f.loop, x, y)) return;
    if (soup.length >= maxTriangles * 9) {
      overflow = true;
      return;
    }
    soup.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
    e1.subVectors(q, p);
    e2.subVectors(r, p);
    area += nrm.crossVectors(e1, e2).length() / 2;
  };

  for (const mesh of meshes) {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    mesh.updateWorldMatrix(true, false);
    const world = mesh.matrixWorld;
    const mirrored = world.determinant() < 0;
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, ia).applyMatrix4(world);
      b.fromBufferAttribute(pos, ib).applyMatrix4(world);
      c.fromBufferAttribute(pos, ic).applyMatrix4(world);
      const ca = coord(a), cb = coord(b), cc = coord(c);
      // Wholly to one side of the loop's box or the band: nothing of it is in.
      if (
        (ca[0] < f.min[0] && cb[0] < f.min[0] && cc[0] < f.min[0]) ||
        (ca[0] > f.max[0] && cb[0] > f.max[0] && cc[0] > f.max[0]) ||
        (ca[1] < f.min[1] && cb[1] < f.min[1] && cc[1] < f.min[1]) ||
        (ca[1] > f.max[1] && cb[1] > f.max[1] && cc[1] > f.max[1]) ||
        (ca[2] < -f.band && cb[2] < -f.band && cc[2] < -f.band) ||
        (ca[2] > f.band && cb[2] > f.band && cc[2] > f.band)
      ) continue;
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      nrm.crossVectors(e1, e2);
      if (nrm.lengthSq() < 1e-14) continue;
      nrm.normalize();
      if (mirrored) nrm.negate();
      // Toward the patch, and not steeper than asked (up is +y).
      if (nrm.dot(f.n) < MIN_FACING || nrm.y < minUp - 1e-6) continue;
      emit(a.clone(), b.clone(), c.clone(), 0);
      if (overflow) return { selection: null, cut };
    }
  }
  return { selection: { positions: new Float32Array(soup), triangles: soup.length / 9, area }, cut };
}

export type SelectResult =
  | { ok: true; selection: SurfaceSelection }
  | { ok: false; reason: "loop" | "empty" | "overflow" };

// The faces of `meshes` the loop covers, cut as finely as the triangle cap
// allows: the loop's own step first, coarser by half again each time the soup
// is over the cap. Once the step is past the loop's size nothing is cut any
// more, so a loop over more whole faces than the cap is an overflow rather
// than a search that never ends.
export function selectSurface(
  meshes: readonly THREE.Mesh[],
  outline: readonly SurfacePoint[],
  opts: { maxSlopeDeg: number; maxTriangles: number },
): SelectResult {
  const f = frameOf(outline);
  if (!f) return { ok: false, reason: "loop" };
  const minUp = minUpOf(opts.maxSlopeDeg);
  for (let step = f.step; ; step *= STEP_GROWTH) {
    const { selection, cut } = cutFaces(meshes, f, step, minUp, opts.maxTriangles);
    if (selection) return selection.triangles ? { ok: true, selection } : { ok: false, reason: "empty" };
    // Over the cap with nothing cut: every face was already whole, and a
    // coarser step cannot take fewer.
    if (!cut) return { ok: false, reason: "overflow" };
  }
}

// --- the patch object's frame ----------------------------------------------

// Where a geometry object is drawn, as `mountVisual` places it: at (x, y) in the
// sim's world (y down) and `z` toward the camera, turned `rot` in the plane
// (the sim's sense), tipped by `rotX` and `rotY` about its own origin, and
// scaled. The patch's loop is stored in this frame and its soup is sent in it,
// so the mesh the generator makes lands where the loop was painted however the
// object has been placed since.
export interface ObjectPose {
  x: number;
  y: number;
  z: number;
  rot: number;
  rotX: number;
  rotY: number;
  scale: number;
}

// The object's frame to three's world: the piece's placement and turn, then the
// holder's depth, tilt and scale, composed as `BodyVisual.piece` and
// `mountVisual` compose them (Rz then Rx then Ry, the 'ZXY' order the drop and
// the gizmo use).
export function patchMatrix(p: ObjectPose): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rotX, p.rotY, -p.rot, "ZXY"));
  return new THREE.Matrix4().compose(
    new THREE.Vector3(p.x, -p.y, p.z),
    q,
    new THREE.Vector3(p.scale, p.scale, p.scale),
  );
}

// A loop point stored in the patch's frame (y DOWN, as the model stores every
// point) to three's world, and back.
export function loopPointToWorld(m: THREE.Matrix4, p: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(p.x, -p.y, p.z).applyMatrix4(m);
}
export function worldToLoopPoint(inverse: THREE.Matrix4, w: THREE.Vector3): { x: number; y: number; z: number } {
  const l = w.clone().applyMatrix4(inverse);
  return { x: l.x, y: -l.y, z: l.z };
}

// A world soup in the patch's own frame, three's axes (y up), at the key's
// resolution (a tenth of a millimetre): what the generator is handed and grows
// the mesh in, so the GLB placed by the object's pose lands on the surface.
export const SOUP_RESOLUTION = 1e4; // steps per metre
export function soupInFrame(positions: Float32Array, inverse: THREE.Matrix4): number[] {
  const out = new Array<number>(positions.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    v.set(positions[i]!, positions[i + 1]!, positions[i + 2]!).applyMatrix4(inverse);
    out[i] = Math.round(v.x * SOUP_RESOLUTION) / SOUP_RESOLUTION;
    out[i + 1] = Math.round(v.y * SOUP_RESOLUTION) / SOUP_RESOLUTION;
    out[i + 2] = Math.round(v.z * SOUP_RESOLUTION) / SOUP_RESOLUTION;
  }
  return out;
}
