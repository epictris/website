// A ROOT as the game draws it: one generated mesh per branch, grown from the
// curve the branch collides as (docs/roots.md).
//
// A root is the one piece of level geometry whose look the level states rather
// than its Blender scene, for the reason a belt's band is: it is GENERATED from
// what the author draws - a branch at a time, each tapering from its base to
// its tip - and a sprung root moves with the sim, so a mesh modelled by hand
// would have to be modelled again for every curve the author pulls about.
//
// What it is made of, per branch:
//
// - the CENTRELINE, sampled every `RING_STEP`, rounded across sharp authoring
//   corners and gently meandering within its girth (render-side only);
// - a RING of `SIDES` points about it, in the plane across the curve that holds
//   the depth axis - a root drawn in the gameplay plane is round through z, so
//   the frame never twists and needs no transport;
// - the RADIUS, the collision's own linear taper (`taperedHalfWidths`) with
//   a trunk flare or a buried branch shoulder, slow swelling, and unequal
//   longitudinal flutes, all seeded so a branch keeps its look across edits;
// - rounded CAPS at both ends, so a tip ends in a point rather than a cut and a
//   branch's base, buried in its parent, never shows an open tube;
// - BARK, layered colour, relief and roughness (`rootBark.ts`), following the
//   grain with broad painted washes and smoother skin on thin growing ends.
//
// Built in each branch's own frame. BodyVisual transforms the sweeps into the
// body frame and fuses branched roots with rootFork; the body carries the result.

import * as THREE from "three";

import { Vec2 } from "../engine/vec2";
import { flattenPath, pathNodesOf } from "../lib/path";
import { MIN_TAPER_TIP } from "../lib/stroke";
import type { CurveVertData } from "../level/levelFormat";
import { threeY } from "./space";
export { rootBarkMaterial } from "./rootBark";

// Metres of centreline between rings, fine enough for the bark's silhouette.
const RING_STEP = 0.012;

// Enough samples for the broad woody flutes, including in a close editor view.
const SIDES = 40;

// Rings in each rounded cap.
const CAP_RINGS = 5;

// How deep a branch's base cap is, as a fraction of its radius (a trunk's is a
// full hemisphere). See where the caps are built.
const BRANCH_CAP_DEPTH = 0.25;

// Metres of root per repeat of the bark along it. Around it the bark wraps
// once whatever the girth, so a thin branch shows finer fissures than a trunk,
// which is what bark does.
const BARK_TILE = 0.65;

// Trunk flare as a fraction of base radius, fading over one base width.
// Branches instead have a shoulder AHEAD of their base, never a wider base cap
// that would poke back through the far side of the parent.
const TRUNK_FLARE = 0.45;
const TRUNK_FLARE_REACH = 1.0;

// Slow swelling (fraction of radius), wavelength in metres, maximum flute depth.
const SWELL = 0.24;
const SWELL_WAVELENGTH = 0.48;
const LOBE = 0.24;

export interface RootShape {
  verts: readonly CurveVertData[];
  width: number;
  tip?: number;
}

// One branch's mesh in the branch's own frame (the collision object's), the
// tube centred on z = 0. `trunk` is whether it grows out of the ground rather
// than out of another branch, which sets its flare; `seed` picks its swelling
// and lobes. Null for a curve with no length.
export function rootGeometry(
  shape: RootShape,
  opts: { trunk: boolean; seed: number },
): THREE.BufferGeometry | null {
  const line = rootCenterline(shape, opts.seed);
  if (line.length < 2) return null;
  const along: number[] = [0];
  for (let i = 1; i < line.length; i++) along.push(along[i - 1]! + line[i]!.distanceTo(line[i - 1]!));
  const total = along[along.length - 1]!;
  if (!(total > 0)) return null;

  const base = Math.max(shape.width, 0) * 0.5;
  const end = Math.max(shape.tip ?? shape.width, MIN_TAPER_TIP) * 0.5;
  const flare = opts.trunk ? TRUNK_FLARE : 0;
  const flareReach = Math.max(1e-3, TRUNK_FLARE_REACH * base * 2);
  const swell = valueNoise1(opts.seed * 7.31 + 0.5);
  const twist = valueNoise1(opts.seed * 3.17 + 11.25);
  const radiusAt = (s: number): number => {
    const t = Math.min(1, Math.max(0, s / total));
    const taper = base + (end - base) * t;
    const station = Math.max(0, s) / Math.max(base, 1e-3);
    const shoulder = opts.trunk ? 0 : 0.32 * (1 - Math.exp(-station / 0.45)) * Math.exp(-station / 2);
    return taper * (1 + flare * Math.exp(-Math.max(0, s) / flareReach) + shoulder)
      * (1 + SWELL * (swell(s / SWELL_WAVELENGTH) * 2 - 1));
  };
  const tangentAt = (i: number): Vec2 => {
    const a = line[Math.max(0, i - 1)]!;
    const b = line[Math.min(line.length - 1, i + 1)]!;
    const d = b.sub(a);
    return d.lengthSquared() > 0 ? d.normalized() : Vec2.RIGHT;
  };

  // The rings, start cap to end cap: each is a centre, the unit tangent, a
  // radius, how fast the radius is changing along the tangent (for the
  // normal), and the arc length the bark is laid along.
  interface Ring {
    c: Vec2;
    t: Vec2;
    r: number;
    dr: number;
    s: number;
    phase: number;
  }
  const rings: Ring[] = [];
  const t0 = tangentAt(0);
  const r0 = radiusAt(0);
  // Wood follows the root's length. A small meander, never the rotating lobes
  // of a twisted cord. Keep the dominant flute on the same side at a bend.
  const phaseAt = (s: number): number => opts.seed * 2.39996 + (twist(s / 1.8) - 0.5) * 0.45;
  // The base cap, closing the tube behind the first node: a hemisphere on a
  // trunk, and a shallow dome on a branch. A branch's first node is on its
  // parent's centreline, so a full hemisphere reaches back out through the far
  // side of the parent and shows there as a knob; a dome a quarter as deep
  // stays inside it while still closing the tube.
  const baseDepth = opts.trunk ? 1 : BRANCH_CAP_DEPTH;
  for (let k = CAP_RINGS; k >= 1; k--) {
    const a = (k / CAP_RINGS) * (Math.PI / 2);
    rings.push({
      c: line[0]!.sub(t0.mul(r0 * baseDepth * Math.sin(a))),
      t: t0,
      r: r0 * Math.cos(a),
      dr: Math.tan(a) / baseDepth,
      s: -r0 * baseDepth * Math.sin(a),
      phase: phaseAt(0),
    });
  }
  for (let i = 0; i < line.length; i++) {
    const s = along[i]!;
    const h = Math.min(RING_STEP, total) * 0.5;
    rings.push({
      c: line[i]!,
      t: tangentAt(i),
      r: radiusAt(s),
      dr: (radiusAt(s + h) - radiusAt(s - h)) / (2 * h),
      s,
      phase: phaseAt(s),
    });
  }
  const tn = tangentAt(line.length - 1);
  const rn = radiusAt(total);
  // The tip cap: the same hemisphere ahead of the last node.
  for (let k = 1; k <= CAP_RINGS; k++) {
    const a = (k / CAP_RINGS) * (Math.PI / 2);
    rings.push({
      c: line[line.length - 1]!.add(tn.mul(rn * Math.sin(a))),
      t: tn,
      r: rn * Math.cos(a),
      dr: -Math.tan(a),
      s: total + rn * Math.sin(a),
      phase: phaseAt(total),
    });
  }

  const stride = SIDES + 1; // the seam is duplicated so the bark wraps cleanly
  const positions = new Float32Array(rings.length * stride * 3);
  const normals = new Float32Array(rings.length * stride * 3);
  const uvs = new Float32Array(rings.length * stride * 2);
  const colors = new Float32Array(rings.length * stride * 3);
  const ages = new Float32Array(rings.length * stride);
  const radial = new THREE.Vector3();
  const around = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  rings.forEach((ring, j) => {
    // Across the curve in the plane, as three.js sees it (y up), and the depth
    // axis: the ring's two axes.
    const ax = -ring.t.y;
    const ay = threeY(ring.t.x);
    tangent.set(ring.t.x, threeY(ring.t.y), 0);
    for (let k = 0; k <= SIDES; k++) {
      const theta = (k / SIDES) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      // Unequal flutes, broad rather than rope-like. The thin growing end is
      // rounder; the older wood has an oval section and secondary ridges.
      const age = THREE.MathUtils.smoothstep(radiusAt(Math.max(0, Math.min(total, ring.s))), 0.005, 0.04);
      const lobe = 1 + LOBE * age * (0.55 * Math.cos(2 * theta + ring.phase)
        + 0.32 * Math.cos(3 * theta - ring.phase * 0.7)
        + 0.13 * Math.cos(5 * theta + ring.phase * 1.3));
      const lobeSlope = -LOBE * age * (1.10 * Math.sin(2 * theta + ring.phase)
        + 0.96 * Math.sin(3 * theta - ring.phase * 0.7)
        + 0.65 * Math.sin(5 * theta + ring.phase * 1.3));
      const r = ring.r * lobe;
      radial.set(ax * cos, ay * cos, sin);
      const o = (j * stride + k) * 3;
      positions[o] = ring.c.x + radial.x * r;
      positions[o + 1] = threeY(ring.c.y) + radial.y * r;
      positions[o + 2] = radial.z * r;
      // A surface of revolution's normal: the radial direction leaned back
      // against the way the radius grows along the tangent.
      around.set(-ax * sin, -ay * sin, cos);
      normal.copy(radial).addScaledVector(tangent, -ring.dr * lobe)
        .addScaledVector(around, -lobeSlope / lobe).normalize();
      normals[o] = normal.x;
      normals[o + 1] = normal.y;
      normals[o + 2] = normal.z;
      const u = (j * stride + k) * 2;
      uvs[u] = k / SIDES + hash(opts.seed * 17.3);
      uvs[u + 1] = ring.s / BARK_TILE + hash(opts.seed * 31.7);
      // Broad washes, fixed to the wood, complement the texture's small
      // brush marks. Linear-space multipliers preserve authored body tint.
      const wash = Math.sin(theta * 2 + ring.phase + ring.s * 1.3) * 0.055;
      const aged = 0.94 + 0.06 * swell(ring.s / 0.7);
      colors[o] = aged + wash + (1 - age) * 0.14;
      colors[o + 1] = aged + wash * 0.65 + (1 - age) * 0.07;
      colors[o + 2] = aged - wash * 0.2;
      ages[j * stride + k] = age;
    }
  });
  const index: number[] = [];
  for (let j = 0; j + 1 < rings.length; j++) {
    for (let k = 0; k < SIDES; k++) {
      const a = j * stride + k;
      const b = a + stride;
      // Wound so the outside faces out: round the ring is from the in-plane
      // axis toward +z, which crossed with the tangent points inward.
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("rootAge", new THREE.BufferAttribute(ages, 1));
  geometry.setAttribute("rootJoin", new THREE.BufferAttribute(new Float32Array(ages.length), 1));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

// Round the authoring polyline in arc-length space. A compact kernel cannot
// overshoot as an interpolating spline can. Endpoints stay fixed, and the
// support is proportional to girth: thick wood bends broadly, fine tips curl.
// This is dressing only; neither collision nor the editor's handles are edited.
export function rootCenterline(shape: RootShape, seed: number): Vec2[] {
  const raw = resample(flattenPath(pathNodesOf(shape.verts), RING_STEP / 2), RING_STEP);
  const count = raw.length;
  if (count < 3) return raw;
  const wander = valueNoise1(seed * 9.3 + 4.7);
  return raw.map((p, i) => {
    const f = i / (count - 1);
    const radius = (shape.width + ((shape.tip ?? shape.width) - shape.width) * f) / 2;
    const support = Math.max(2, radius * 6 / RING_STEP);
    const reach = Math.ceil(support);
    let x = 0, y = 0, weight = 0;
    for (let j = -reach; j <= reach; j++) {
      const w = Math.pow(Math.max(0, 1 - Math.abs(j) / (support + 1)), 2);
      // Linear extension keeps the first and last tangent from pulling inward.
      const k = i + j;
      const q = k < 0 ? raw[0]!.add(raw[1]!.sub(raw[0]!).mul(k))
        : k >= count ? raw[count - 1]!.add(raw[count - 1]!.sub(raw[count - 2]!).mul(k - count + 1)) : raw[k]!;
      x += q.x * w; y += q.y * w; weight += w;
    }
    const fade = Math.min(1, i / reach, (count - 1 - i) / reach);
    const tangent = raw[Math.min(count - 1, i + reach)]!.sub(raw[Math.max(0, i - reach)]!).normalized();
    const wiggle = radius * 0.48 * (wander(i * RING_STEP / 0.24) * 2 - 1) * fade;
    return new Vec2(p.x + (x / weight - p.x) * fade - tangent.y * wiggle,
      p.y + (y / weight - p.y) * fade + tangent.x * wiggle);
  });
}

// A polyline resampled every `step` of arc length, both ends kept.
function resample(points: readonly Vec2[], step: number): Vec2[] {
  const pts: Vec2[] = [];
  for (const p of points) if (!pts.length || pts[pts.length - 1]!.distanceSquaredTo(p) > 1e-18) pts.push(p);
  if (pts.length < 2) return pts;
  const out: Vec2[] = [pts[0]!];
  let carried = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const l = a.distanceTo(b);
    let at = step - carried;
    while (at < l) {
      out.push(a.add(b.sub(a).mul(at / l)));
      at += step;
    }
    carried = l - (at - step);
  }
  const last = pts[pts.length - 1]!;
  if (out[out.length - 1]!.distanceTo(last) < step * 0.3 && out.length > 1) out.pop();
  out.push(last);
  return out;
}

// Smooth 1D value noise in [0, 1], one stream per seed.
function valueNoise1(seed: number): (x: number) => number {
  return (x: number): number => {
    const i = Math.floor(x);
    const f = x - i;
    const a = hash(i + seed * 101.3);
    const b = hash(i + 1 + seed * 101.3);
    const w = f * f * (3 - 2 * f);
    return a + (b - a) * w;
  };
}

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
