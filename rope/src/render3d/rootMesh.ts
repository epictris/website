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
// - the CENTRELINE, the authored cubic sampled every `RING_STEP` of arc length
//   - finer than the collision line (`lib/stroke.ts`, which keeps within a
//   centimetre of the same cubic), so the two agree to the width of a pencil
//   line while the drawn one is smooth;
// - a RING of `SIDES` points about it, in the plane across the curve that holds
//   the depth axis - a root drawn in the gameplay plane is round through z, so
//   the frame never twists and needs no transport;
// - the RADIUS, the collision's own linear taper (`taperedHalfWidths`) with
//   three things over it that collision does not care about: the flare where a
//   trunk leaves the ground, a slow swelling along
//   it, and a lobed cross-section, all seeded so a branch keeps its look across
//   edits;
// - rounded CAPS at both ends, so a tip ends in a point rather than a cut and a
//   branch's base, buried in its parent, never shows an open tube;
// - BARK, a generated texture whose fissures run along the root
//   (`rootBarkMaterial`), tinted by the body's colour.
//
// Built once per branch at build time, in the branch's own frame; the body
// group carries it from there, so a sprung root swings it for nothing.

import * as THREE from "three";

import { Vec2 } from "../engine/vec2";
import { flattenPath, pathNodesOf } from "../lib/path";
import { MIN_TAPER_TIP } from "../lib/stroke";
import type { CurveVertData } from "../level/levelFormat";
import { threeY } from "./space";

// Metres of centreline between rings. Two centimetres is under a pixel of
// curvature error at play distance on the tightest bend an author draws.
const RING_STEP = 0.02;

// Points round each ring. Fourteen keeps a 30 cm trunk round in silhouette;
// the lobes below are three per turn, so the count is not a multiple of them
// that would line every lobe up with a vertex.
const SIDES = 14;

// Rings in each rounded cap.
const CAP_RINGS = 5;

// How deep a branch's base cap is, as a fraction of its radius (a trunk's is a
// full hemisphere). See where the caps are built.
const BRANCH_CAP_DEPTH = 0.25;

// Metres of root per repeat of the bark along it. Around it the bark wraps
// once whatever the girth, so a thin branch shows finer fissures than a trunk,
// which is what bark does.
const BARK_TILE = 0.6;

// How much a TRUNK swells where it leaves the ground (a fraction of its base
// radius), and over how many base widths that swelling dies away. A BRANCH has
// none: its base is on its parent's centreline, where a collar is hidden, and
// one that made the base wider than the parent there broke out through the
// parent's far side as a ridge.
const TRUNK_FLARE = 0.45;
const TRUNK_FLARE_REACH = 1.0;

// The slow swelling along a branch (fraction of the radius) and its wavelength
// in metres; and the depth of the cross-section's three lobes.
const SWELL = 0.08;
const SWELL_WAVELENGTH = 0.22;
const LOBE = 0.07;

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
  const line = resample(flattenPath(pathNodesOf(shape.verts), RING_STEP / 2), RING_STEP);
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
    return taper * (1 + flare * Math.exp(-Math.max(0, s) / flareReach)) * (1 + SWELL * (swell(s / SWELL_WAVELENGTH) * 2 - 1));
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
  const phaseAt = (s: number): number => twist(s / (SWELL_WAVELENGTH * 3)) * Math.PI * 2;
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
  const radial = new THREE.Vector3();
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
      const lobe = 1 + LOBE * Math.cos(3 * theta + ring.phase);
      const r = ring.r * lobe;
      radial.set(ax * cos, ay * cos, sin);
      const o = (j * stride + k) * 3;
      positions[o] = ring.c.x + radial.x * r;
      positions[o + 1] = threeY(ring.c.y) + radial.y * r;
      positions[o + 2] = radial.z * r;
      // A surface of revolution's normal: the radial direction leaned back
      // against the way the radius grows along the tangent.
      normal.copy(radial).addScaledVector(tangent, -ring.dr * lobe).normalize();
      normals[o] = normal.x;
      normals[o + 1] = normal.y;
      normals[o + 2] = normal.z;
      const u = (j * stride + k) * 2;
      uvs[u] = k / SIDES;
      uvs[u + 1] = ring.s / BARK_TILE;
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
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
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

// ---------------------------------------------------------------------------
// Bark
// ---------------------------------------------------------------------------

// The bark texture's size: round the root, and along it. Fissures run along,
// so the long axis has the detail.
const BARK_U = 128;
const BARK_V = 256;

let barkMaps: { map: THREE.DataTexture; normalMap: THREE.DataTexture } | null = null;
const barkMaterials = new Map<string, THREE.MeshStandardMaterial>();

// The bark a root of body colour `color` wears: one material per colour,
// shared by every branch that asks, over one generated pair of maps.
// Materials are shared and cached like every surface (see assets.ts), so a
// visual never disposes one.
export function rootBarkMaterial(color: string): THREE.MeshStandardMaterial {
  let m = barkMaterials.get(color);
  if (m) return m;
  barkMaps ??= buildBarkMaps();
  m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    map: barkMaps.map,
    normalMap: barkMaps.normalMap,
    normalScale: new THREE.Vector2(1.4, 1.4),
    roughness: 0.92,
    metalness: 0,
  });
  barkMaterials.set(color, m);
  return m;
}

// Bark as a height field: ridged noise stretched along the root, so the
// fissures run lengthwise and break every so often, over a finer grain. The
// albedo darkens into the fissures; the normal map is the field's gradient.
// Periodic in both directions, so the root wraps it without a seam.
function buildBarkMaps(): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const h = new Float32Array(BARK_U * BARK_V);
  for (let y = 0; y < BARK_V; y++) {
    for (let x = 0; x < BARK_U; x++) {
      const u = x / BARK_U;
      const v = y / BARK_V;
      const ridge = 1 - Math.abs(2 * periodicNoise(u * 9, v * 3, 9, 3, 1) - 1);
      const plates = periodicNoise(u * 5, v * 2, 5, 2, 2);
      const grain = periodicNoise(u * 24, v * 10, 24, 10, 3);
      h[y * BARK_U + x] = 0.55 * ridge * ridge + 0.3 * plates + 0.15 * grain;
    }
  }
  const at = (x: number, y: number): number =>
    h[((y + BARK_V) % BARK_V) * BARK_U + ((x + BARK_U) % BARK_U)]!;
  const albedo = new Uint8Array(BARK_U * BARK_V * 4);
  const normal = new Uint8Array(BARK_U * BARK_V * 4);
  for (let y = 0; y < BARK_V; y++) {
    for (let x = 0; x < BARK_U; x++) {
      const i = (y * BARK_U + x) * 4;
      const v = at(x, y);
      const tone = Math.round(255 * Math.min(1, 0.32 + 0.78 * v));
      albedo[i] = tone;
      albedo[i + 1] = tone;
      albedo[i + 2] = tone;
      albedo[i + 3] = 255;
      const dx = (at(x + 1, y) - at(x - 1, y)) * 3;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 3;
      const len = Math.hypot(dx, dy, 1);
      normal[i] = Math.round(255 * (0.5 - (0.5 * dx) / len));
      normal[i + 1] = Math.round(255 * (0.5 - (0.5 * dy) / len));
      normal[i + 2] = Math.round(255 * (0.5 + 0.5 / len));
      normal[i + 3] = 255;
    }
  }
  const texture = (data: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, BARK_U, BARK_V, THREE.RGBAFormat);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: texture(albedo, true), normalMap: texture(normal, false) };
}

// 2D value noise in [0, 1] that repeats every `px` by `py` lattice cells.
function periodicNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const cell = (cx: number, cy: number): number => {
    const wx = ((cx % px) + px) % px;
    const wy = ((cy % py) + py) % py;
    return hash(wx * 57.31 + wy * 113.7 + seed * 19.19);
  };
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = cell(ix, iy);
  const b = cell(ix + 1, iy);
  const c = cell(ix, iy + 1);
  const d = cell(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
