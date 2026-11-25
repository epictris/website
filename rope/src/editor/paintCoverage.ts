// What a painted decoration (moss, ivy) will cover, drawn as the Blender
// brush draws it: a field of dots over the rock where the paint reaches the
// grower's threshold, not the stamps themselves.
//
// A port of the stamp brush's coverage preview (tools/blender/stampbrush:
// `Coverage` in brush.py, `composite` in geometry.py): points sampled over the
// rock's surface at an even spacing, the stamps composited onto them in
// painting order exactly as the build composites them onto its vertices, and
// the points at or over the threshold drawn as small dots, depth tested and
// lifted off the rock so it does not hide them. So the region on screen is the
// region that grows, erasing included, rather than a pile of the brush's discs.
//
// Everything is in the formation's frame, the frame the strokes are kept in.

import * as THREE from "three";
import type { PaintStamp } from "../level/levelFormat";

// The brush's own numbers (stampbrush/brush.py): metres between samples, the
// cap that coarsens the spacing on a big rock, the dots' colour and size.
const SPACING = 0.012;
const MAX_POINTS = 400_000;
const COLOR = new THREE.Color(0.45, 0.75, 0.25);
const OPACITY = 0.85;
const DOT_PX = 3;
// Off the rock, so the depth test does not eat them.
const LIFT = 0.003;
// The grower's default coverage threshold (moss and ivy both, settings.py and
// ivy/build.py); a decoration's own `threshold` setting overrides it.
export const DEFAULT_THRESHOLD = 0.35;

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// A small seeded generator, so the same rock samples the same points.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Points sampled evenly over a rock's surface, each with its face's normal,
// sorted by x so a stamp visits only the points within its radius in x. Kept
// per rock (a decoded rock is one object until it is regenerated), shared by
// the coverage and the brush's cursor, so hovering a rock samples it once.
export class RockSamples {
  readonly points: Float32Array;
  readonly normals: Float32Array;
  private readonly order: Uint32Array;
  private readonly xs: Float32Array;

  // `rock` is the formation's drawn rock, its world frame the formation's.
  constructor(rock: THREE.Object3D) {
    rock.updateMatrixWorld(true);
    const tris: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    rock.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.getAttribute("position");
      if (!pos) return;
      const index = mesh.geometry.getIndex();
      const n = index ? index.count : pos.count;
      for (let i = 0; i + 2 < n; i += 3) {
        const ia = index ? index.getX(i) : i;
        const ib = index ? index.getX(i + 1) : i + 1;
        const ic = index ? index.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, ia).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(pos, ib).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(pos, ic).applyMatrix4(mesh.matrixWorld);
        tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
    });
    const count = tris.length / 9;
    const areas = new Float64Array(count);
    let total = 0;
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const cross = new THREE.Vector3();
    for (let t = 0; t < count; t++) {
      ab.set(tris[t * 9 + 3]! - tris[t * 9]!, tris[t * 9 + 4]! - tris[t * 9 + 1]!, tris[t * 9 + 5]! - tris[t * 9 + 2]!);
      ac.set(tris[t * 9 + 6]! - tris[t * 9]!, tris[t * 9 + 7]! - tris[t * 9 + 1]!, tris[t * 9 + 8]! - tris[t * 9 + 2]!);
      areas[t] = 0.5 * cross.crossVectors(ab, ac).length();
      total += areas[t]!;
    }
    const spacing = Math.max(SPACING, Math.sqrt(total / MAX_POINTS));
    const rng = mulberry32(0);
    // Each triangle's share of points, rounded stochastically so a field of
    // small triangles still gets its due.
    const counts = new Uint32Array(count);
    let points = 0;
    for (let t = 0; t < count; t++) {
      counts[t] = Math.floor(areas[t]! / (spacing * spacing) + rng());
      points += counts[t]!;
    }
    this.points = new Float32Array(points * 3);
    this.normals = new Float32Array(points * 3);
    let k = 0;
    for (let t = 0; t < count; t++) {
      if (!counts[t]) continue;
      const o = t * 9;
      ab.set(tris[o + 3]! - tris[o]!, tris[o + 4]! - tris[o + 1]!, tris[o + 5]! - tris[o + 2]!);
      ac.set(tris[o + 6]! - tris[o]!, tris[o + 7]! - tris[o + 1]!, tris[o + 8]! - tris[o + 2]!);
      cross.crossVectors(ab, ac).normalize();
      for (let j = 0; j < counts[t]!; j++) {
        let u = rng();
        let v = rng();
        if (u + v > 1) {
          u = 1 - u;
          v = 1 - v;
        }
        for (let axis = 0; axis < 3; axis++) {
          this.points[k * 3 + axis] = tris[o + axis]! + ab.getComponent(axis) * u + ac.getComponent(axis) * v + cross.getComponent(axis) * LIFT;
          this.normals[k * 3 + axis] = cross.getComponent(axis);
        }
        k++;
      }
    }
    const order = Array.from({ length: points }, (_, i) => i).sort((i, j) => this.points[i * 3]! - this.points[j * 3]!);
    this.order = Uint32Array.from(order);
    this.xs = Float32Array.from(order, (i) => this.points[i * 3]!);
  }

  get count(): number {
    return this.xs.length;
  }

  // Every point a stamp reaches, with the weight it lays there before its
  // strength (`composite` in stampbrush/geometry.py): a smooth falloff to
  // its rim, and nothing on a face turned away from the stamp's normal.
  reach(s: Pick<PaintStamp, "p" | "n" | "r">, visit: (i: number, w: number) => void): void {
    const [cx, cy, cz] = s.p;
    const r = s.r;
    const nl = Math.hypot(s.n[0], s.n[1], s.n[2]) || 1;
    const nx = s.n[0] / nl;
    const ny = s.n[1] / nl;
    const nz = s.n[2] / nl;
    let lo = lowerBound(this.xs, cx - r);
    const hi = upperBound(this.xs, cx + r);
    for (; lo < hi; lo++) {
      const i = this.order[lo]!;
      const dx = this.points[i * 3]! - cx;
      const dy = this.points[i * 3 + 1]! - cy;
      const dz = this.points[i * 3 + 2]! - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= r) continue;
      let w = smoothstep(0, 1, 1 - d / r);
      // A stamp on a ledge's top does not paint the ledge's underside.
      w *= smoothstep(-0.2, 0.35, this.normals[i * 3]! * nx + this.normals[i * 3 + 1]! * ny + this.normals[i * 3 + 2]! * nz);
      if (w > 0) visit(i, w);
    }
  }
}

const sampled = new WeakMap<THREE.Object3D, RockSamples>();
export function samplesOf(rock: THREE.Object3D): RockSamples {
  let s = sampled.get(rock);
  if (!s) sampled.set(rock, (s = new RockSamples(rock)));
  return s;
}

export class PaintCoverage {
  private readonly samples: RockSamples;
  // The paint at each point, 0 to 1.
  private readonly m: Float32Array;
  // Stamps composited so far, and the threshold last drawn at.
  private done = 0;
  private threshold = DEFAULT_THRESHOLD;
  readonly object: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();

  constructor(rock: THREE.Object3D) {
    this.samples = samplesOf(rock);
    this.m = new Float32Array(this.samples.count);
    this.object = new THREE.Points(
      this.geometry,
      new THREE.PointsMaterial({ color: COLOR, size: DOT_PX, sizeAttenuation: false, transparent: true, opacity: OPACITY, depthTest: true, depthWrite: false }),
    );
    this.object.name = "paint-coverage";
    this.object.raycast = () => {};
  }

  get sampleCount(): number {
    return this.m.length;
  }

  // Composite the stamps not yet seen and redraw the covered points. False
  // when the paint was not appended to (erased whole, undone): the caller
  // starts a new coverage, as the brush does.
  update(stamps: readonly PaintStamp[], threshold: number): boolean {
    if (stamps.length < this.done) return false;
    // Nothing new to composite and the same threshold: what is drawn stands.
    // (A threshold changed with no new stamp redraws: before 2026-11-25 it
    // returned here, and the dots kept the old threshold's region.)
    if (stamps.length === this.done && threshold === this.threshold && this.geometry.getAttribute("position")) return true;
    for (let i = this.done; i < stamps.length; i++) this.composite(stamps[i]!);
    this.done = stamps.length;
    this.threshold = threshold;
    const points = this.samples.points;
    const covered: number[] = [];
    for (let i = 0; i < this.m.length; i++) {
      if (this.m[i]! >= threshold) covered.push(points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!);
    }
    this.geometry.setAttribute("position", new THREE.Float32BufferAttribute(covered, 3));
    this.geometry.computeBoundingSphere();
    return true;
  }

  // Whether a stamp would reach paint of this coverage: any point it lays
  // weight on that is covered (at the threshold last drawn at). So a dab at
  // the edge of a patch touches it, and one where it was erased does not.
  touches(s: Pick<PaintStamp, "p" | "n" | "r">): boolean {
    let hit = false;
    this.samples.reach(s, (i) => {
      if (this.m[i]! >= this.threshold) hit = true;
    });
    return hit;
  }

  // How many points are covered at `threshold` (for the cases).
  coveredCount(threshold: number): number {
    let n = 0;
    for (const v of this.m) if (v >= threshold) n++;
    return n;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }

  // One stamp onto the coverage, as `composite` in stampbrush/geometry.py.
  private composite(s: PaintStamp): void {
    const m = this.m;
    this.samples.reach(s, (i, w) => {
      const aw = Math.abs(s.s) * w;
      if (s.s >= 0) m[i] = m[i]! + (1 - m[i]!) * aw;
      else m[i] = m[i]! * (1 - aw);
    });
  }
}

function lowerBound(xs: Float32Array, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(xs: Float32Array, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
