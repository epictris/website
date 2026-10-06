// Flowing water and its fall: Tris's river study ported (see docs/water.md,
// "Drawing a body of water" and "A fall"). A channel is the companion of the
// pool (stillWater.ts) in the same formulation, and a channel with a `spill`
// pours off its downstream end as a fall built into the same mesh under the
// same shader, so the two are seamless by construction.
//
// THE STUDY is cave-river-waterfall-v14.html ("Flowing water v14", 2026-10-05):
// a closed swept volume carrying one material coordinate from the source over
// the lip into the plunge pool; the river shaded with the pool's own wave
// spectrum read in the current's frame (soft light bands, a crest, colour
// drifting down the channel, a pale milky wash streaming along the flow and
// opaque at the banks and the brink); the falling sheet drawn out into long
// ribbons under gravity; and at the landing a frothing crown, plumes, splash
// ribbons, spray and a whitewater footprint with broken rings on the water it
// lands in. The port is shader for shader, with the study's numbers, in study
// metres (STUDY_SCALE, see waterLook.ts); what had to change is listed in the
// docs and at each site.
//
// Driven by the WALL CLOCK handed in by `Scene3D` (`updateWater`), so the
// fixed-step sim never sees any of it and a pinned-clock headless grab is the
// same picture twice. Nothing here is a stored asset: the ripples are the
// generated spectrum the pool reads.

import * as THREE from "three";
import { WaterArea } from "../engine/body";
import type { LevelBodyData } from "../level/levelFormat";
import { FRONT_INSET, poolGeometry, stillWaterMaterial, type StillSurface } from "./stillWater";
import {
  DEPTH_STRETCH,
  fmt,
  freeImpactSlot,
  IMPACT_GLSL,
  impactAt,
  impactHow,
  impactUniforms,
  LIGHT_FALLOFF,
  ORGANIC_GLSL,
  STUDY_SCALE,
  studyPalette,
  takeImpactSlot,
  waterSurfaceMap,
  waterTime,
} from "./waterLook";

export { waterTime } from "./waterLook";

// ---------------------------------------------------------------------------
// The study's settings
// ---------------------------------------------------------------------------

// Tris's v14 defaults, in the study's own units (study metres; the shaders
// work in them and scale the result by STUDY_SCALE). Named as the study's
// sliders are.
const S = STUDY_SCALE;
// The pattern: the pool's patch size and "brush scale", "painterly light"
// (contrast), "macro light" (how far the long swell tilts the bands), "paint
// strength", "strokes" and the churn (the chop's own clock).
const PATCH_SIZE = 0.82;
const BRUSH_SCALE = 1.5;
const CONTRAST = 0.6;
const MACRO_LIGHT = 0.6;
const PAINT_STRENGTH = 1.0;
const STROKES = 1.0;
const CHURN = 1.0;
// The travelling waves' amplitude (study metres): the long swell whose slope
// tilts the light bands (the river's geometry is the painted channel's, see
// PAINTED_HARMONICS). And how far the falling sheet's edges wander (study
// metres).
const WAVE_AMPLITUDE = 0.085;
const EDGE_MOTION = 0.026;
// The wash: the river's (the study's default 1.32 is its unit here) and the
// fall's whitewater.
const RIVER_FOAM = 1.0;
const FALL_FOAM = 1.0;
// The crown's relief and foam amount. Froth strength is derived separately
// from the actual landing speed.
const FOAM_HEIGHT = 1.15;
const IMPACT_FOAM = 1.0;
// The study's river ran across its world at z -5.7, a fixed share of the way
// from its far wall to its camera, and paled its light bands by that share.
const FOREGROUND = 0.43;

// ---------------------------------------------------------------------------
// The game's adaptations
// ---------------------------------------------------------------------------

// Where the water sits through z, in metres - EXACTLY the extruder's own
// convention (see extrude.ts): `depth` is centred on the gameplay plane, and
// the body's `waterZ` shifts the whole slab, positive toward the camera. `z`
// absent and `z: 0` mean the same slab, since the editor omits defaults on
// save. The default keeps the front past the ball (radius 0.12), so a
// submerged ball reads as IN the water.
const DEFAULT_WATER_DEPTH = 1.12;
// The cross-section: the study's is a rounded rectangle whose sides are whole
// semicircles (radius half its depth), which its banks hid. The game looks at
// a channel's front, and keeps the painted channel's slab: a flat front under
// a flat top, its corners all but square (metres). Rounded 6 cm, as first
// ported, was rejected beside it (Tris, 2026-10-06).
const SECTION_CORNER = 0.005;
// Vertices round the section: across the top (the waves need them), round
// each corner, down the front and the back, and along each half of the bed.
const TOP_SEGS = 24;
const CORNER_SEGS = 4;
const FRONT_SEGS = 8;
const BACK_SEGS = 2;
const BED_SEGS = 2;
// Station spacing down the run, metres. The finest wave is 17.3 rad/m (0.36 m)
// and the fall's folding finer still; 0.025 m gives either six samples or
// more, which is where a sum of sines stops looking sampled.
const RIVER_STEP = 0.025;
// The DRAWDOWN. Water approaching a brink speeds up and its surface dips
// into the drop: over the last DRAWDOWN_REACH metres before the lip (the
// study's 1.9 m acceleration zone) the current eases to the lip's speed and
// the surface lowers by DRAWDOWN of the half depth; the bed stays put.
const DRAWDOWN = 0.3;
const DRAWDOWN_REACH = 0.95;
// The fall: samples along the arc, uniform in time (packed into the brow,
// spread down the drop), and how far past the drop the tube carries on.
const FALL_STEPS = 64;
const FALL_GRAVITY = 9.81;
const FALL_OVERSHOOT = 0.2;
// How far under the water it lands in the falling sheet is still drawn,
// metres (that surface waves by ~4 cm).
const FALL_SINK = 0.06;
// THE RIVER'S GEOMETRY is the painted channel's wave train (its WAVE_*
// constants before the port), chosen over the study's relief by A/B on
// 2026-10-06 (Tris): gentle rolling crests rather than the study's tighter,
// sharper ones. Four harmonics riding the current: rad/m along the flow,
// amplitude (of the height), churn rad/s, rad/m across. The waves die out
// over END_TAPER before either end of a run and wave only within
// FRONT_FALLOFF of the top down the front.
const PAINTED_HARMONICS: readonly (readonly [number, number, number, number])[] = [
  [1.8, 0.45, 0.7, 0.7],
  [4.1, 0.3, -1.3, -1.9],
  [9.7, 0.18, 2.4, 4.2],
  [17.3, 0.09, -3.8, -7.3],
];
const PAINTED_WAVE_HEIGHT = 0.05;
const PAINTED_END_TAPER = 0.5;
const PAINTED_FRONT_FALLOFF = 0.22;
// How far down a channel's front the wash and the waterline rim reach,
// metres: the study's banks hid its sides, and a front painted as a bank
// read as white from the waterline to the bed.
const BANK_DOWN = 0.05;
const RIM_DOWN = 0.03;
// The front sheet's opacity, waterline to bed: murky glass, so the submerged
// ball stays a silhouette (the pool's numbers). The top and the fall are
// opaque, as the study's water is.
const ALPHA_FRONT_TOP = 0.94;
const ALPHA_FRONT_BED = 0.8;
// Separate compact splashes from the much softer, longer-lived mist.
const PLUMES = 40;
const MISTS = 48;
const BUBBLES = 100;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// One vertex of the cross-section, about the run's top centre: z across
// (metres, + toward the camera), h below the waterline (metres, <= 0), the
// section's outward normal (nz, ny), and the perimeter from the top centre
// (metres, signed: + toward the front).
interface RingPoint {
  z: number;
  h: number;
  nz: number;
  ny: number;
  ell: number;
}

// The section, walked from the middle of the bed round the back, over the
// top, down the front and back to the middle of the bed: an open strip whose
// first and last points coincide, so its seam lies under the water where no
// one sees it and the perimeter coordinate runs unbroken over every face
// that shows.
function sectionRing(width: number, depth: number): RingPoint[] {
  const b = width / 2;
  const r = Math.min(SECTION_CORNER, depth / 2, b);
  const out: RingPoint[] = [];
  let ell = 0;
  const push = (z: number, h: number, nz: number, ny: number): void => {
    const last = out[out.length - 1];
    if (last) ell += Math.hypot(z - last.z, h - last.h);
    out.push({ z, h, nz, ny, ell });
  };
  const line = (z0: number, h0: number, z1: number, h1: number, nz: number, ny: number, n: number): void => {
    for (let i = out.length ? 1 : 0; i <= n; i++) push(z0 + ((z1 - z0) * i) / n, h0 + ((h1 - h0) * i) / n, nz, ny);
  };
  const arc = (cz: number, ch: number, a0: number, a1: number): void => {
    for (let i = 1; i <= CORNER_SEGS; i++) {
      const a = a0 + ((a1 - a0) * i) / CORNER_SEGS;
      push(cz + r * Math.cos(a), ch + r * Math.sin(a), Math.cos(a), Math.sin(a));
    }
  };
  const H = Math.PI / 2;
  line(0, -depth, -b + r, -depth, 0, -1, BED_SEGS);
  arc(-b + r, -depth + r, -H, -2 * H);
  line(-b, -depth + r, -b, -r, -1, 0, BACK_SEGS);
  arc(-b + r, -r, 2 * H, H);
  line(-b + r, 0, b - r, 0, 0, 1, TOP_SEGS);
  arc(b - r, -r, H, 0);
  line(b, -r, b, -depth + r, 1, 0, FRONT_SEGS);
  arc(b - r, -depth + r, 0, -H);
  line(b - r, -depth, 0, -depth, 0, -1, BED_SEGS);
  // The top centre is the perimeter's zero (TOP_SEGS is even, so a vertex
  // sits on it).
  const top = out[BED_SEGS + 2 * CORNER_SEGS + BACK_SEGS + TOP_SEGS / 2]!;
  for (const p of out) p.ell -= top.ell;
  return out;
}

// A station down the run: where the top centre of its section is (local x
// along the flow axis, y), the travel direction T and the displacement
// direction N (perpendicular to T, up and out), how deep its slice is, and
// the study's coordinates there - metres travelled (study metres), the travel
// time from the source (seconds), how far down the fall (a fraction of the
// drop) and the speed (m/s).
interface Station {
  x: number;
  y: number;
  tx: number;
  ty: number;
  depth: number;
  s: number;
  tau: number;
  drop: number;
  speed: number;
}

export interface SpillSpec {
  side: number;
  v0: number;
  drop: number;
}

interface CurrentGeometry {
  geometry: THREE.BufferGeometry;
  // The fall's lip and its slice, in the body's frame, or null without one.
  lip: { x: number; y: number; depth: number; s: number } | null;
}

const smooth = (t: number): number => {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
};

// The run and its fall as one closed tube, in the body's local frame (three's
// y-up: local +x the flow axis, +z toward the camera). The river's stations
// carry the section from the upstream end to the lip; the fall's carry the
// lip's section along the arc a thrown thing follows, as VERTICAL SLICES: every
// layer of the slab leaving the lip follows the same parabola from its own
// height, so a slice at time t is the lip's carried along the arc unturned.
// That is the physics - the sheet's perpendicular thickness thins by exactly
// v0/v - and it is what keeps a slab thicker than the brow's radius of
// curvature (v0^2/g, 10 cm at 1 m/s) from folding under the lip, which the
// study's sections perpendicular to the travel would (its 2.2 m/s lip had the
// room; the game's do not).
// Attributes beyond position and normal:
//   aFlow    - metres travelled (study), across the top (study, stretched along
//              the depth as the pool's pattern is), travel time (s), drop
//              (fraction of the spill; 0 on the river)
//   aUnroll  - the across coordinate continued round the section's perimeter
//              (study metres, unstretched past the top), so a pattern painted
//              by it runs down the front face rather than smearing into bars
//   aTangent - T, local
//   aDisp    - N, local: the waves displace along it
//   aProfile - the section's normal (z, up), the slice's depth (study
//              metres), the top's half width (in aFlow's across units)
//   aSkin    - surface weight (1 at the waterline, 0 at the bed), the offset
//              from the slice's middle along N (study metres, for the fall's
//              thickness ridges), the speed (m/s), the depth below the
//              waterline down the face (metres)
function currentGeometry(
  halfX: number,
  halfY: number,
  frontZ: number,
  backZ: number,
  flow: number,
  spill: SpillSpec | null,
): CurrentGeometry {
  const width = frontZ - backZ;
  const zMid = (frontZ + backZ) / 2;
  const side = spill ? spill.side : flow < 0 ? -1 : 1;
  const runSpeed = Math.max(Math.abs(flow), 0.05);
  const length = halfX * 2;
  const upstream = -side * halfX;
  // The surface and the speed down the run, s metres from the upstream end:
  // the drawdown and the acceleration into the lip.
  const brink = (s: number): number => (spill ? smooth(1 - (length - s) / DRAWDOWN_REACH) : 0);
  const topAt = (s: number): number => halfY - DRAWDOWN * halfY * brink(s);
  const speedAt = (s: number): number => (spill ? runSpeed + (spill.v0 - runSpeed) * brink(s) : runSpeed);

  const stations: Station[] = [];
  const steps = Math.max(2, Math.ceil(length / RIVER_STEP));
  for (let i = 0; i <= steps; i++) {
    const s = (length * i) / steps;
    const y = topAt(s);
    const prev = stations[i - 1];
    const ds = prev ? Math.hypot(length / steps, y - prev.y) : 0;
    const speed = speedAt(s);
    stations.push({
      x: upstream + side * s,
      y,
      tx: side,
      ty: 0,
      depth: y + halfY,
      s: prev ? prev.s + ds / S : 0,
      tau: prev ? prev.tau + (ds * 0.5 * (1 / prev.speed + 1 / speed)) : 0,
      drop: 0,
      speed,
    });
  }
  // The river's tangent follows its surface (the drawdown's dip), and is level
  // again at the lip, where the fall's begins.
  for (let i = 0; i < stations.length; i++) {
    const a = stations[Math.max(0, i - 1)]!;
    const b = stations[Math.min(stations.length - 1, i + 1)]!;
    const tl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    stations[i]!.tx = (b.x - a.x) / tl;
    stations[i]!.ty = (b.y - a.y) / tl;
  }
  let lip: CurrentGeometry["lip"] = null;
  if (spill) {
    const l = stations[stations.length - 1]!;
    lip = { x: l.x, y: l.y, depth: l.depth, s: l.s };
    const reach = spill.drop + l.depth + FALL_OVERSHOOT;
    const tEnd = Math.sqrt((2 * reach) / FALL_GRAVITY);
    for (let i = 1; i <= FALL_STEPS; i++) {
      const t = (tEnd * i) / FALL_STEPS;
      const prev = stations[stations.length - 1]!;
      const x = l.x + side * spill.v0 * t;
      const y = l.y - 0.5 * FALL_GRAVITY * t * t;
      const vx = side * spill.v0;
      const vy = -FALL_GRAVITY * t;
      const speed = Math.hypot(vx, vy);
      stations.push({
        x,
        y,
        tx: vx / speed,
        ty: vy / speed,
        depth: l.depth,
        s: prev.s + Math.hypot(x - prev.x, y - prev.y) / S,
        tau: l.tau + t,
        drop: (l.y - y) / spill.drop,
        speed,
      });
    }
  }

  const pos: number[] = [];
  const flowA: number[] = [];
  const unroll: number[] = [];
  const tangent: number[] = [];
  const disp: number[] = [];
  const profile: number[] = [];
  const skin: number[] = [];
  const index: number[] = [];
  const halfWidth = width / 2 / (S * DEPTH_STRETCH);
  const topFlat = (b: number, r: number): number => b - r;
  const vertex = (st: Station, p: RingPoint, r: number): void => {
    // N: T turned a right angle toward up and out.
    const nx = -side * st.ty;
    const ny = side * st.tx;
    // A vertical slice (see the header): the section hangs straight down from
    // its station, whatever way the water is travelling.
    pos.push(st.x, st.y + p.h, zMid + p.z);
    const below = -p.h;
    const flat = topFlat(width / 2, r);
    const e = Math.abs(p.ell);
    const u = e <= flat ? e / (S * DEPTH_STRETCH) : flat / (S * DEPTH_STRETCH) + (e - flat) / S;
    flowA.push(st.s, p.z / (S * DEPTH_STRETCH), st.tau, st.drop);
    unroll.push(Math.sign(p.ell) * u);
    tangent.push(st.tx, st.ty, 0);
    disp.push(nx, ny, 0);
    profile.push(p.nz, p.ny, st.depth / S, halfWidth);
    skin.push(
      Math.max(0, Math.min(1, 1 - below / Math.min(LIGHT_FALLOFF, st.depth))),
      ((p.h + st.depth / 2) * ny) / S,
      st.speed,
      below,
    );
  };
  let ringSize = 0;
  for (const st of stations) {
    const ring = sectionRing(width, st.depth);
    const r = Math.min(SECTION_CORNER, st.depth / 2, width / 2);
    ringSize = ring.length;
    for (const p of ring) vertex(st, p, r);
  }
  // The skin, wound outward: checked against the section's own normal at a
  // top vertex of the first quad, since the sweep's direction (the side the
  // water leaves by) mirrors the winding.
  const P = (i: number): THREE.Vector3 => new THREE.Vector3(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
  const topJ = Math.floor(ringSize / 2);
  const face = P(ringSize + topJ).sub(P(topJ)).cross(P(topJ + 1).sub(P(topJ)));
  const flip = face.y < 0;
  for (let i = 0; i < stations.length - 1; i++) {
    for (let j = 0; j < ringSize - 1; j++) {
      const a = i * ringSize + j;
      const c = a + ringSize;
      if (flip) index.push(a, a + 1, c, a + 1, c + 1, c);
      else index.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  // The caps: both ends of the tube (the fall's end is under the water it
  // lands in, but the volume stays closed for any view). Their vertices are
  // their own, so the cap shades flat while carrying the ring's coordinates.
  const cap = (i: number, outward: number): void => {
    const st = stations[i]!;
    const ring = sectionRing(width, st.depth);
    const r = Math.min(SECTION_CORNER, st.depth / 2, width / 2);
    const base = pos.length / 3;
    for (const p of ring) vertex(st, p, r);
    vertex(st, { z: 0, h: -st.depth / 2, nz: 0, ny: 0, ell: 0 }, r);
    const centre = base + ring.length;
    // Wound so the face points along the tangent times `outward`.
    const n = P(base + 1).sub(P(centre)).cross(P(base).sub(P(centre)));
    const t = new THREE.Vector3(st.tx, st.ty, 0).multiplyScalar(outward);
    const ccw = n.dot(t) > 0;
    for (let j = 0; j < ring.length - 1; j++) {
      if (ccw) index.push(centre, base + j + 1, base + j);
      else index.push(centre, base + j, base + j + 1);
    }
  };
  cap(0, -1);
  cap(stations.length - 1, 1);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("aFlow", new THREE.Float32BufferAttribute(flowA, 4));
  geometry.setAttribute("aUnroll", new THREE.Float32BufferAttribute(unroll, 1));
  geometry.setAttribute("aTangent", new THREE.Float32BufferAttribute(tangent, 3));
  geometry.setAttribute("aDisp", new THREE.Float32BufferAttribute(disp, 3));
  geometry.setAttribute("aProfile", new THREE.Float32BufferAttribute(profile, 4));
  geometry.setAttribute("aSkin", new THREE.Float32BufferAttribute(skin, 4));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  // The waves lift the surface a few centimetres past the authored box.
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius += 0.2;
  return { geometry, lip };
}

// ---------------------------------------------------------------------------
// The material
// ---------------------------------------------------------------------------

// After the study's `waveGLSL`, shared by both stages: the material
// coordinate (a parcel's across and its Lagrangian travel, study metres), the
// swell whose slope lights the bands, and what the vertex stage displaces by
// - the painted channel's waves on the river (chosen over the study's relief,
// see PAINTED_HARMONICS), the study's folding and thickness ridges down the
// fall.
const WAVE_GLSL = `
  uniform float uTime;
  uniform float uRefSpeed;
  uniform float uLip;
  uniform float uSide;
  uniform float uRunEnd;
  float wnHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wn(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return mix(mix(wnHash(i), wnHash(i + vec2(1, 0)), f.x), mix(wnHash(i + vec2(0, 1)), wnHash(i + 1.0), f.x), f.y);
  }
  float wfb(vec2 p) { return 0.60 * wn(p) + 0.28 * wn(p * 2.03 + 13.7) + 0.12 * wn(p * 4.07 - 8.1); }
  // Across, and the travel: where this parcel was at the clock's zero, at the
  // run's own speed, so the pattern rides the current at exactly its speed.
  vec2 parcelAt(float across, float tau) { return vec2(across, uRefSpeed * (tau - uTime)); }
  vec2 parcel(vec4 f) { return parcelAt(f.y, f.z); }
  // The slope of the study's two longest travelling waves: the swell that
  // tilts the light bands (shading only; the study's waves no longer move
  // the surface), without the short ridges that read as corduroy.
  vec2 swellSlope(vec2 p) {
    float t = uTime * ${fmt(CHURN)};
    float bend = 0.34 * sin(p.x * 0.85 + p.y * 0.44 - t * 0.19) + 0.16 * sin(p.x * 1.74 - p.y * 0.60 + t * 0.23);
    float ph0 = p.y * 2.36 + p.x * 0.57 + bend - t * 0.34;
    float ph1 = p.y * 4.83 - p.x * 1.39 + bend * 0.7 + t * 0.57 + 1.30;
    float envelope = 0.80 + 0.20 * sin(p.x * 1.21 - p.y * 0.38 + t * 0.11);
    return envelope * (0.48 * cos(ph0) * vec2(0.57, 2.36) + 0.27 * cos(ph1) * vec2(-1.39, 4.83)) * ${fmt(WAVE_AMPLITUDE)};
  }
  // The river's own geometry: the painted channel's wave train (see
  // PAINTED_HARMONICS), riding the current, glassy before either end of the
  // run, waving only near the top of the front, gone over the brow. Metres,
  // returned in study metres.
  float riverWaves(vec4 f, float below) {
    float along = uSide * parcel(f).y * ${fmt(S)};
    float across = f.y * ${fmt(S * DEPTH_STRETCH)};
    float w = ${PAINTED_HARMONICS.map(
      ([k, a, c, x]) => `sin(along * ${fmt(k)} + across * ${fmt(x)} + uTime * ${fmt(c)}) * ${fmt(a)}`,
    ).join(" + ")};
    w = sign(w) * pow(abs(w), 0.75);
    float taper = smoothstep(0.0, ${fmt(PAINTED_END_TAPER / S)}, min(f.x, uRunEnd - f.x));
    float front = pow(max(0.0, 1.0 - below / ${fmt(PAINTED_FRONT_FALLOFF)}), 2.0);
    return w * ${fmt(PAINTED_WAVE_HEIGHT / S)} * taper * front * (1.0 - smoothstep(0.0, 0.05, f.w));
  }
  // The cascade's folding (the study's), study metres.
  float cascadeFolds(vec4 f) {
    vec2 p = parcel(f);
    float folded = 0.105 * sin(p.x * 3.35 + p.y * 0.36) + 0.050 * sin(p.x * 6.2 - p.y * 0.67);
    folded += 0.055 * (pow(0.5 + 0.5 * sin(p.x * 9.4 + p.y * 0.46), 2.0) - 0.375);
    return folded * smoothstep(0.0, 0.46, f.w);
  }
  float thicknessField(vec4 f) {
    vec2 p = parcel(f);
    float fall = smoothstep(0.0, 0.32, f.w);
    float ridges = pow(0.5 + 0.5 * cos(p.x * 5.1 + 0.22 * sin(p.x * 1.2 + p.y * 0.75)), 3.0);
    float thickness = (0.43 + 2.10 * ridges) / 1.08625;
    return mix(1.0, thickness, fall) * (1.0 + 0.13 * fall * sin(p.y * 3.1 + p.x * 2.5));
  }
  // The displacement along N, study metres: the river's waves, and down the
  // fall the study's folding and the sheet's thickness ridges about its
  // middle.
  float skinHeight(vec4 f, float mid, float below) {
    return riverWaves(f, below) + cascadeFolds(f) + mid * (thicknessField(f) - 1.0);
  }
`;

// The study's `riverPaintGLSL` and `cascadeLook`, then its main(): the river
// in the pool's formulation, the cascade, and the blend between them down the
// brow. Into a MeshBasicMaterial's color_fragment (see `currentMaterial`).
const PAINT_GLSL = `
  uniform sampler2D uSurfaceMap;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uLight;
  uniform float uLipSpeed;
  uniform float uSpilling;
  uniform float uFloor;
  varying vec3 vWorld;
  varying vec3 vBaseNormal;
  varying vec3 vMacroNormal;
  varying vec4 vFlow;
  varying float vUnroll;
  varying float vSurfaceWeight;
  varying float vHalfWidth;
  varying float vBelow;
  varying float vUp;
  varying float vDepth;
  // Three drifting layers of the pool's spectrum, read in parcel space
  // (across, along), stretched along the flow so the bands lengthen with the
  // current; the second and third turned (90 and ~40 degrees) so the
  // spectrum's own diagonal never lines up across all three. The slope in the
  // surface's own frame: x across (world z), y along the travel.
  vec2 riverSlope(vec2 matp, float stretch, float churn, out vec4 a, out vec4 b, out vec4 c) {
    vec2 q = vec2(matp.x, matp.y / stretch) / ${fmt(PATCH_SIZE * Math.max(0.5, BRUSH_SCALE))};
    float t = uTime * ${fmt(CHURN)} * churn;
    vec2 q2 = vec2(q.y, -q.x);
    mat2 r3 = mat2(0.77, 0.64, -0.64, 0.77);
    vec2 q3 = r3 * q;
    a = texture2D(uSurfaceMap, q * vec2(0.048, 0.064) + vec2(0.011, -0.014) * t);
    b = texture2D(uSurfaceMap, q2 * vec2(0.067, 0.086) + vec2(-0.009, 0.010) * t + vec2(0.31, 0.57));
    c = texture2D(uSurfaceMap, q3 * vec2(0.11, 0.14) + vec2(0.016, 0.005) * t + 0.73);
    float fine = 1.0 - smoothstep(0.14, 0.8, length(fwidth(q)));
    vec2 sb = (b.rg * 2.0 - 1.0) * vec2(0.085, 0.14);
    sb = vec2(-sb.y, sb.x);
    vec2 sc = (c.rg * 2.0 - 1.0) * vec2(0.035, 0.045) * fine;
    sc = sc * r3;
    vec2 s = (a.rg * 2.0 - 1.0) * vec2(0.11, 0.17) + sb + sc;
    s.y /= stretch;
    return s;
  }
  // The wash field shared by the river and the falling sheet, in parcel units,
  // so a streak born on the river runs on over the brink and down the fall.
  float washStreak(vec2 mp) {
    float t = uTime * ${fmt(CHURN)};
    vec2 sq = vec2(mp.x * 1.7, mp.y * 0.17);
    return wfb(sq) * 0.58 + 0.27 * wn(sq * 2.1 + vec2(t * 0.28, -t * 0.18)) + 0.15 * wn(sq * 4.7 + vec2(-t * 0.14, t * 0.33));
  }
  // Long, broken strokes carried by the parcel coordinates. Small lateral
  // wandering stays attached to the current instead of boiling in place.
  float currentStreak(vec2 mp) {
    vec2 sq = vec2(mp.x * 2.0 + 0.12 * sin(mp.y * 0.55), mp.y * 0.28);
    return wfb(sq) * 0.78 + 0.22 * wn(sq * vec2(1.8, 1.4) + 7.3);
  }
  // How close to the bank (or the sheet's edge) a point is, with a reach that
  // wanders along the channel so the inner edge is a torn line. Down the
  // front (see BANK_DOWN) it gives out.
  float washBank(vec2 mp, float across) {
    float reach = abs(across) + 0.5 * (wfb(vec2(mp.y * 0.45, mp.x * 0.9) + (across > 0.0 ? 3.0 : 17.0)) - 0.5);
    return smoothstep(vHalfWidth - 0.50, vHalfWidth - 0.06, reach) * (1.0 - smoothstep(0.0, ${fmt(BANK_DOWN)}, vBelow));
  }
  vec3 paintedRiver(out float foam) {
    // Across (continued down the faces), Lagrangian travel.
    vec2 matp = parcelAt(vUnroll, vFlow.z);
    vec4 a, b, c;
    vec2 s = riverSlope(matp, 1.8, 0.25, a, b, c);
    // A current is not a mirror: a fine chop that churns in its own time, on
    // top of the carried pattern, breaks the glassy finish.
    {
      float t = uTime * ${fmt(CHURN)} * 0.25;
      vec2 q = matp / ${fmt(PATCH_SIZE * Math.max(0.5, BRUSH_SCALE))};
      vec4 d = texture2D(uSurfaceMap, q * vec2(0.21, 0.27) + vec2(0.05, -0.07) * t + 0.17);
      vec4 e = texture2D(uSurfaceMap, q * vec2(0.33, 0.41) + vec2(-0.08, 0.05) * t + 0.61);
      float fine = 1.0 - smoothstep(0.14, 0.8, length(fwidth(q)));
      s += ((d.rg * 2.0 - 1.0) * vec2(0.06, 0.08) + (e.rg * 2.0 - 1.0) * vec2(0.035, 0.045)) * fine * ${fmt(CHURN)} * 0.3;
    }
    // Surface frame to world: across is +z, along the travel is uSide x.
    vec2 ripple = vec2(uSide * s.y, s.x);
    // The long swell tilts the same bands, as the pool's long waves do.
    vec2 sw = swellSlope(matp);
    vec2 slope = ripple + vec2(uSide * sw.y, sw.x) * ${fmt(MACRO_LIGHT)};
    // Where a fall lands on this run, its boil and rings (waterLook.ts).
    slope += impactSlope(vWorld) * step(0.5, vUp);
    vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
    vec3 V = normalize(cameraPosition - vWorld);
    // The pool's teal pigment, with restrained variations travelling downstream.
    vec3 base;
    {
      vec2 mq = vec2(matp.x * 0.38, matp.y * 0.13);
      float tone = wfb(mq);
      base = mix(uDeep, uShallow, 0.72 + 0.16 * smoothstep(0.3, 0.72, tone));
    }
    // Wide, soft light bands follow the changing wave slopes.
    float facing = slope.y + slope.x * 0.24;
    float broadLight = smoothstep(0.012, 0.052, facing);
    float crest = smoothstep(0.078, 0.125, facing) * smoothstep(0.28, 0.65, b.b);
    float shade = smoothstep(0.015, 0.14, -facing);
    base *= 1.0 - shade * 0.22 * ${fmt(PAINT_STRENGTH)};
    base = mix(base, uLight, broadLight * ${fmt(CONTRAST)} * ${fmt(0.22 + FOREGROUND * 0.3)} * ${fmt(PAINT_STRENGTH)});
    vec3 col = base;
    vec3 L = normalize(vec3(-0.36, 0.78, -0.43));
    float specular = pow(max(0.0, dot(n, normalize(V + L))), 100.0);
    col += uLight * specular * 0.06;
    col += uLight * crest * ${fmt(CONTRAST * 0.16 * STROKES)};
    // Turquoise travelling strokes become pale only at the disturbed lip.
    // Slab edges are not evidence of a rock bank: do not outline them in foam.
    float lip = exp(-pow((uLip - vFlow.x - 0.3) / 1.0, 2.0)) * uSpilling;
    float contact = clamp(lip * 0.65, 0.0, 1.0) * ${fmt(RIVER_FOAM)};
    float light = 0.84 + 0.16 * max(0.0, dot(n, L));
    {
      // Match the cascade's parcel wash before the shared tube turns down.
      float brink = smoothstep(0.0, ${fmt(DRAWDOWN_REACH / S)}, vFlow.x - uLip + ${fmt(DRAWDOWN_REACH / S)}) * uSpilling;
      float streak = mix(currentStreak(matp), washStreak(matp), brink);
      float threshold = mix(0.68, 0.52, contact);
      // A crisp edge: the streak is translucent through its opacity, not blurred.
      float aa = max(0.012, fwidth(streak) * 0.8);
      float wash = smoothstep(threshold - aa, threshold + aa, streak);
      // Thinner streaks inside: a second cut a little higher draws a brighter core.
      float core = smoothstep(threshold + 0.07 - aa, threshold + 0.07 + aa, streak);
      float opacity = mix(0.15, 0.55, contact);
      vec3 milk = mix(uLight, vec3(0.88, 0.94, 0.95), contact * 0.8);
      col = mix(col, milk * light, wash * opacity * ${fmt(STROKES)});
      col = mix(col, mix(milk, vec3(0.92, 0.96, 0.96), contact * 0.5) * light, core * opacity * 0.35 * ${fmt(STROKES)});
      // A broken teal glint, not a continuous white bank border.
      float rim = smoothstep(vHalfWidth - 0.16, vHalfWidth - 0.03, abs(vFlow.y))
        * smoothstep(0.58, 0.78, wn(vec2(matp.y * 1.3, matp.x * 3.0)))
        * (1.0 - smoothstep(0.0, ${fmt(RIM_DOWN)}, vBelow));
      col = mix(col, uLight * light, rim * 0.18);
      foam = clamp(wash * opacity * contact, 0.0, 1.0) * mix(0.09, 1.0, vSurfaceWeight);
    }
    // A fall's whitewater footprint and broken rings, on the top only.
    float span = impactSpan(vWorld);
    if (vUp > 0.5) col = impactPaint(vWorld, col, base, uLight, span);
    // Down the submerged face the same pigment fades to deep.
    col = mix(col, uDeep * 0.57, (1.0 - vSurfaceWeight) * 0.58);
    return col;
  }
  vec3 cascadeLook(out float white) {
    float fall = smoothstep(0.0, 0.80, vFlow.w);
    // Metres on the sheet at the lip's speed, moving with the water: a
    // parcel's label is its travel time, so what was a metre at the brink is
    // drawn out as the water accelerates.
    vec2 pm = vec2(vUnroll, (vFlow.z - uTime) * uLipSpeed);
    // Slopes in the sheet's own frame: T down the flow, B across it. The
    // per-ring normal is softened toward the smooth sheet normal: at full
    // strength its ring-to-ring wiggle hatched every band edge.
    vec3 geoRaw = normalize(vMacroNormal);
    vec3 baseN = normalize(vBaseNormal);
    vec3 geo = normalize(mix(baseN, geoRaw, 0.45));
    vec3 B = vec3(0.0, 0.0, 1.0);
    vec3 rawT = cross(B, baseN);
    vec3 T = length(rawT) > 0.01 ? normalize(rawT) : vec3(uSide, 0.0, 0.0);
    vec4 a, b, c;
    vec2 s = riverSlope(pm, mix(1.6, 3.5, fall), 1.0, a, b, c);
    vec3 N = normalize(geo - T * s.y * ${fmt(MACRO_LIGHT)} - B * s.x);
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 L = normalize(vec3(-0.36, 0.78, -0.43));
    float NoV = max(0.025, abs(dot(N, V)));
    float fresnel = 0.0204 + 0.9796 * pow(1.0 - NoV, 5.0);
    // The pool's bands: how far the ripples tilt the sheet toward the opening.
    vec3 Lband = vec3(-0.24, 0.0, -1.0);
    float facing = dot(N, Lband) - dot(geo, Lband) + (dot(geo, Lband) - dot(baseN, Lband)) * 0.5;
    float broadLight = smoothstep(0.012, 0.052, facing);
    float crest = smoothstep(0.078, 0.125, facing) * smoothstep(0.28, 0.65, b.b);
    float shade = smoothstep(0.015, 0.14, -facing);
    float sun = max(0.0, dot(N, L));
    vec3 base = mix(uDeep, uShallow, 0.62);
    base *= (0.90 + 0.10 * sun) * (1.0 - shade * 0.10 * ${fmt(PAINT_STRENGTH)});
    base = mix(base, uLight, broadLight * ${fmt(CONTRAST * 0.48 * PAINT_STRENGTH)});
    // Reflected light is a pale palette tone only, never the dark cave below:
    // a fold whose normal dipped reflected near-black and read as a dark column.
    vec3 R = reflect(-V, N);
    vec3 reflected = mix(mix(uDeep, uShallow, 0.7), uLight, smoothstep(-0.3, 0.7, R.y));
    vec3 col = mix(base, reflected, fresnel * 0.5);
    float spec = pow(max(dot(N, normalize(V + L)), 0.0), 100.0);
    col += uLight * spec * 0.16;
    col += uLight * crest * ${fmt(CONTRAST * 0.16 * STROKES)};
    // Whitewater: the river's own wash carried over the brink, in the same
    // travel coordinate, so nothing ends at the lip; down the sheet it fills
    // in, brightens toward white and is cut by finer lanes as the water
    // accelerates, and the sheet's edges stay milky like the banks.
    vec2 mp = parcelAt(vUnroll, vFlow.z);
    float streak = washStreak(mp);
    streak += ((wn(vec2(pm.x * 14.0 + 5.0, pm.y * 0.15)) - 0.5) * 0.30 + (wn(vec2(pm.x * 26.0 + 9.0, pm.y * 0.3)) - 0.5) * 0.14) * fall;
    float bankF = washBank(mp, vFlow.y) * ${fmt(RIVER_FOAM)};
    float threshold = mix(0.645, 0.575, pow(fall, 1.2) * ${fmt(FALL_FOAM)}) - 0.08 * bankF;
    float aa = max(0.012, fwidth(streak) * 0.8);
    float ribbons = smoothstep(threshold - aa, threshold + aa, streak);
    // A streak that would run wide down the sheet thins to a wash in its middle.
    ribbons *= mix(1.0, 0.5, smoothstep(threshold + 0.08, threshold + 0.2, streak) * fall);
    float core = smoothstep(threshold + 0.07 - aa, threshold + 0.07 + aa, streak);
    float opacity = mix(0.30, 0.9, smoothstep(0.0, 0.7, fall)) + 0.2 * bankF;
    opacity = min(opacity, 1.0) * mix(0.08, 1.0, vSurfaceWeight);
    vec3 milk = mix(uLight, vec3(0.88, 0.94, 0.95), mix(0.5, 0.9, max(fall, bankF)));
    float foamLight = 0.84 + 0.16 * max(0.0, dot(geo, L));
    col = mix(col, milk * foamLight, ribbons * opacity);
    col = mix(col, mix(milk, vec3(0.92, 0.96, 0.96), 0.5) * foamLight, core * opacity * 0.5);
    white = ribbons * opacity;
    col = mix(col, uDeep * 0.57, (1.0 - vSurfaceWeight) * 0.58 * (1.0 - fall));
    return col;
  }
`;

// What shapes a current's material: its colour, the direction it runs (world
// x), its speed and its lip's, where along the run the lip is (study metres)
// and how far the fall drops.
interface CurrentLook {
  color: string | undefined;
  side: number;
  runSpeed: number;
  lipSpeed: number;
  lipS: number | null;
  drop: number;
  // Where the run ends (its lip, or its downstream cap), study metres.
  runEnd: number;
  // World y under which the falling sheet is not drawn: the water it lands
  // in (set every frame by `updateWater`).
  floor: { value: number };
}

// Unlit (the water's colour is the study's, not the cave lights') and not tone
// mapped, as the pool is; unfogged, as the pool is (the level's haze greyed a
// teal into a blue-grey sheet). Writes depth, as the pool does, so the depth
// of field blurs it like the rock around it. Translucent only down the
// channel's front: the tube is closed and its back faces culled, so what shows
// through is the ball and the rock behind, never the water's own far side.
function currentMaterial(look: CurrentLook): THREE.MeshBasicMaterial {
  const { deep, shallow, light } = studyPalette(look.color);
  const mat = new THREE.MeshBasicMaterial({
    color: shallow,
    transparent: true,
    depthWrite: true,
    side: THREE.FrontSide,
    toneMapped: false,
    fog: false,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, impactUniforms);
    shader.uniforms.uTime = waterTime;
    shader.uniforms.uSurfaceMap = { value: waterSurfaceMap() };
    shader.uniforms.uDeep = { value: deep };
    shader.uniforms.uShallow = { value: shallow };
    shader.uniforms.uLight = { value: light };
    shader.uniforms.uSide = { value: look.side };
    // The parcel's travel at the run's speed, and the cascade's at the lip's:
    // study metres per second.
    shader.uniforms.uRefSpeed = { value: look.runSpeed / S };
    shader.uniforms.uLipSpeed = { value: look.lipSpeed / S };
    shader.uniforms.uLip = { value: look.lipS ?? 1e6 };
    shader.uniforms.uSpilling = { value: look.lipS === null ? 0 : 1 };
    shader.uniforms.uSpill = { value: Math.max(look.drop, 1e-3) };
    shader.uniforms.uRunEnd = { value: look.runEnd };
    shader.uniforms.uFloor = look.floor;

    shader.vertexShader = `
      ${WAVE_GLSL}
      uniform float uSpill;
      attribute vec4 aFlow;
      attribute float aUnroll;
      attribute vec3 aTangent;
      attribute vec3 aDisp;
      attribute vec4 aProfile;
      attribute vec4 aSkin;
      varying vec3 vWorld;
      varying vec3 vBaseNormal;
      varying vec3 vMacroNormal;
      varying vec4 vFlow;
      varying float vUnroll;
      varying float vSurfaceWeight;
      varying float vHalfWidth;
      varying float vBelow;
      varying float vUp;
      varying float vDepth;
    ${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      // The study's flow vertex stage: the skin displaced along N by the
      // waves (and down the fall by the sheet's thickness ridges), its normal
      // tilted by their slopes measured either way, and the falling sheet's
      // edges wandering a little.
      {
        vec3 T = normalize(aTangent);
        vec3 N = normalize(aDisp);
        float fall = smoothstep(0.0, 0.36, aFlow.w);
        float speed = max(aSkin.z, 0.1);
        float h = skinHeight(aFlow, aSkin.y, aSkin.w);
        float ds = 0.015;
        vec4 stepS = vec4(ds, 0.0, ds * ${fmt(S)} / speed, aFlow.w > 0.0 ? -T.y * ds * ${fmt(S)} / uSpill : 0.0);
        float slopeS = (skinHeight(aFlow + stepS, aSkin.y, aSkin.w) - skinHeight(aFlow - stepS, aSkin.y, aSkin.w)) / (2.0 * ds);
        // Across is stretched along the depth (see aFlow), so its slope is
        // that much gentler in metres.
        float slopeA = (skinHeight(aFlow + vec4(0.0, ds, 0.0, 0.0), aSkin.y, aSkin.w)
          - skinHeight(aFlow - vec4(0.0, ds, 0.0, 0.0), aSkin.y, aSkin.w)) / (2.0 * ds * ${fmt(DEPTH_STRETCH)});
        vec2 q = parcel(aFlow);
        transformed += N * h * ${fmt(S)};
        float left = 0.65 * sin(q.y * 2.4 + 0.6) + 0.35 * sin(q.y * 5.6 + 1.3);
        float right = 0.62 * sin(q.y * 2.1 + 3.1) + 0.38 * sin(q.y * 4.8 - 0.8);
        transformed.z += ${fmt(EDGE_MOTION * S)} * fall * mix(left, right, clamp(aFlow.y / (aProfile.w * 2.0) + 0.5, 0.0, 1.0));
        vec3 tilted = normalize(normal - T * slopeS * aProfile.y - vec3(0.0, 0.0, 1.0) * slopeA * aProfile.y);
        vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vBaseNormal = mat3(modelMatrix) * normal;
        vMacroNormal = mat3(modelMatrix) * tilted;
        vFlow = aFlow;
        vUnroll = aUnroll;
        vSurfaceWeight = aSkin.x;
        vHalfWidth = aProfile.w;
        vBelow = aSkin.w;
        vUp = max(aProfile.y, 0.0);
        vDepth = aProfile.z * ${fmt(S)};
      }`,
    );

    shader.fragmentShader = `
      ${WAVE_GLSL}
      ${IMPACT_GLSL}
      ${PAINT_GLSL}
    ${shader.fragmentShader}`.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      // The falling sheet goes under the water it lands in.
      if (vFlow.w > 0.0 && vWorld.y < uFloor) discard;
      // The river, the cascade, and between them down the brow.
      float cascade = smoothstep(0.0, 0.23, vFlow.w);
      float foam = 0.0;
      vec3 col = vec3(0.0);
      if (cascade < 1.0) col = paintedRiver(foam);
      if (cascade > 0.0) {
        float cf;
        vec3 cc = cascadeLook(cf);
        col = mix(col, cc, cascade);
      }
      diffuseColor.rgb = max(col, vec3(0.0));
      // Opaque on the top and down the fall; murky glass down the channel's
      // front, so the ball stays a silhouette in it.
      float front = mix(${fmt(ALPHA_FRONT_TOP)}, ${fmt(ALPHA_FRONT_BED)}, clamp(vBelow / max(vDepth, 1e-3), 0.0, 1.0));
      diffuseColor.a = mix(front, 1.0, max(smoothstep(0.2, 0.8, vUp), cascade));`,
    );
  };
  mat.customProgramCacheKey = () => "flowing-water";
  return mat;
}

// ---------------------------------------------------------------------------
// The landing
// ---------------------------------------------------------------------------

// Where a fall meets the water, a compact crown, soft plumes, side bubbles
// and a separate mist veil. Each is drawn in study metres in a frame
// whose x is turned so the sheet travels toward -x (the study's), about the
// impact, then scaled into the body's frame at STUDY_SCALE. Every particle is a pure
// function of the clock and its instance, so a pinned clock draws the same
// landing twice.
interface Landing {
  impact: THREE.Vector3;
  side: number;
  // The sheet's half width, study metres (physical, not stretched).
  halfWidth: number;
  // The top of the water it lands in, in the body's frame (min x, max x,
  // min z, max z): the crown froths on that water and nowhere past its ends.
  clip: THREE.Vector4;
  palette: ReturnType<typeof studyPalette>;
  strength: { value: number };
  // Half the sheet's actual contact span along x, in study metres.
  contactHalfSpan: { value: number };
}

// Uniforms every landing program shares.
function landingUniforms(l: Landing): Record<string, THREE.IUniform> {
  return {
    uTime: waterTime,
    uImpact: { value: l.impact },
    uSide: { value: l.side },
    uHalfWidth: { value: l.halfWidth },
    uClip: { value: l.clip },
    uStrength: l.strength,
    uContactHalfSpan: l.contactHalfSpan,
    uFoamShade: { value: l.palette.shallow.clone().lerp(l.palette.light, 0.25) },
    uFoamLight: { value: l.palette.light.clone().lerp(new THREE.Color(0.90, 0.97, 0.98), 0.65) },
    uMistColor: { value: l.palette.light.clone().lerp(new THREE.Color(0.80, 0.94, 0.95), 0.48) },
  };
}

const LANDING_PRELUDE = `
  uniform float uTime;
  uniform vec3 uImpact;
  uniform float uSide;
  uniform float uHalfWidth;
  uniform float uStrength;
  uniform float uContactHalfSpan;
  // A point of the landing in study metres (sheet toward -x) to the body's
  // frame.
  vec3 toBody(vec3 p) { return uImpact + vec3(-uSide * p.x, p.y, p.z) * ${fmt(S)}; }
  // The camera's right and up in the body's frame.
  vec3 viewRight() { return vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0]); }
  vec3 viewUp() { return vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]); }
  float rnd(float x) { return fract(sin(x * 127.1 + 311.7) * 43758.5453); }
  // A bowed path from the upstream contact edge, round either side of the
  // sheet, into downstream foam. Positive z faces the gameplay camera.
  vec3 rimPoint(float along, float edge) {
    float angle = along * 3.14159265;
    return vec3((uContactHalfSpan + 0.24) * cos(angle) - 0.12, 0.04,
      edge * (uHalfWidth - 0.04 + 0.34 * sin(angle)));
  }
`;

function landingMaterial(l: Landing, vertex: string, fragment: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: landingUniforms(l),
    vertexShader: `${LANDING_PRELUDE}\n${vertex}`,
    fragmentShader: `
      #include <common>
      uniform float uTime;
      uniform vec3 uFoamShade;
      uniform vec3 uFoamLight;
      uniform vec3 uMistColor;
      ${fragment}`,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

// The colours are the study's, linear, out through the canvas's encoding.
const LANDING_OUT = `
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
`;

// One continuous frothing contact surface, not a row of spheres or a torus:
// a heightfield over a capsule footprint the width of the sheet.
function crownMesh(l: Landing): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(2, 2, 36, 96);
  geometry.rotateX(-Math.PI / 2);
  const material = landingMaterial(
    l,
    `
    varying vec3 vNormal;
    varying vec2 vLocal;
    varying vec2 vBody;
    ${ORGANIC_GLSL}
    float crownHeight(vec2 p) {
      float nx = p.x / 0.80, nz = p.y / (uHalfWidth + 0.45);
      float body = max(0.0, 1.0 - pow(abs(nx), 2.3) - pow(abs(nz), 6.0));
      float folds = paintNoise(vec2(p.y * 3.25 + uTime * 0.88, p.x * 4.6 - uTime * 1.26));
      float h = (0.045 + 0.20 * folds + 0.025 * sin(p.y * 9.0 + uTime * 4.0)) * pow(body, 0.8);
      return 0.022 + h * uStrength * ${fmt(FOAM_HEIGHT * Math.min(1, IMPACT_FOAM))};
    }
    void main() {
      vec2 p = position.xz * vec2(0.80, uHalfWidth + 0.45);
      float edgeEnv = pow(abs(p.x) / 0.80, 2.0);
      p.x += (0.055 * sin(p.y * 7.0 - uTime * 4.0) + 0.03 * sin(p.y * 14.0 + uTime * 2.7)) * edgeEnv;
      float y = crownHeight(p);
      vec2 d = vec2(crownHeight(p + vec2(0.015, 0.0)) - y, crownHeight(p + vec2(0.0, 0.015)) - y) / 0.015;
      vLocal = p;
      vNormal = normalize(vec3(uSide * d.x, 1.0, -d.y));
      vec3 at = toBody(vec3(p.x - 0.08, y, p.y));
      vBody = at.xz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(at, 1.0);
    }`,
    `
    uniform float uHalfWidth;
    uniform vec4 uClip;
    varying vec3 vNormal;
    varying vec2 vLocal;
    varying vec2 vBody;
    ${ORGANIC_GLSL}
    void main() {
      if (vBody.x < uClip.x || vBody.x > uClip.y || vBody.y < uClip.z || vBody.y > uClip.w) discard;
      float r = length(vec2(vLocal.x + 0.10 * sin(vLocal.y * 2.8 - uTime * 1.7), max(abs(vLocal.y) - uHalfWidth * 0.82, 0.0)));
      float breakup = paintNoise(vec2(vLocal.y * 4.0 - uTime * 1.05, vLocal.x * 5.4 + uTime * 1.34));
      float mask = 1.0 - smoothstep(0.35, 0.73, r + (breakup - 0.5) * 0.32 + 0.06 * sin(vLocal.y * 6.0 + uTime * 1.9));
      float fold = paintNoise(vec2(vLocal.y * 5.0 + uTime * 0.80, vLocal.x * 6.0 - uTime * 1.65));
      float core = 1.0 - smoothstep(0.16, 0.42, r);
      float holes = smoothstep(0.50, 0.73, breakup) * (1.0 - core);
      vec3 col = mix(uFoamShade, uFoamLight, 0.36 + 0.45 * smoothstep(0.19, 0.69, fold));
      col = mix(col, vec3(0.93, 0.98, 0.99), core * 0.65);
      float lit = dot(normalize(vNormal), normalize(vec3(-0.45, 0.85, 0.2)));
      col *= 0.86 + 0.14 * smoothstep(-0.6, 0.75, lit);
      float alpha = mask * mix(0.52, 0.94, core) * (1.0 - holes * 0.75) * ${fmt(Math.min(1, IMPACT_FOAM))};
      if (alpha < 0.008) discard;
      ${LANDING_OUT}
    }`,
  );
  return new THREE.Mesh(geometry, material);
}

// A quad instanced `count` times; the programs place each by gl_InstanceID.
function instancedQuads(count: number): THREE.InstancedBufferGeometry {
  const plane = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", plane.getAttribute("position"));
  geometry.setAttribute("uv", plane.getAttribute("uv"));
  geometry.setIndex(plane.getIndex());
  geometry.instanceCount = count;
  plane.dispose();
  return geometry;
}

// Low, short-lived water lobes around the contact. Mist is a separate layer.
function plumeMesh(l: Landing): THREE.Mesh {
  const material = landingMaterial(
    l,
    `
    varying vec2 vUV;
    varying float vLife;
    varying float vSeed;
    varying float vPuff;
    void main() {
      float id = float(gl_InstanceID), r = rnd(id + 33.0), s = rnd(id + 71.0), b = rnd(id + 19.0);
      float life = 0.54 + r * 0.48;
      float phase = fract(uTime / life + rnd(id + 9.0));
      float cycle = floor(uTime / life + rnd(id + 9.0));
      float age = phase * life;
      float theta = 6.28318 * rnd(id + cycle * 17.0 + 40.0);
      vec3 vel = vec3(cos(theta) * (0.42 + r * 0.55) - 0.22, 0.85 + s * 0.65, sin(theta) * (0.30 + r * 0.35)) * uStrength;
      vec3 center = vec3(-0.03, 0.05, (s * 2.0 - 1.0) * uHalfWidth * 0.9);
      float sideFoam = step(0.62, rnd(id + 122.0));
      float edge = mod(id, 2.0) * 2.0 - 1.0;
      center = mix(center, rimPoint(rnd(id + cycle * 17.0 + 170.0), edge), sideFoam);
      vel = mix(vel, vec3(-0.22 - r * 0.25, 0.60 + s * 0.44, edge * 0.12) * uStrength, sideFoam);
      center += vec3(vel.x * age, vel.y * age - 4.905 * age * age, vel.z * age);
      float size = (0.20 + r * 0.22) * (0.70 + 0.30 * sin(phase * 3.14159)) * mix(1.0, 0.70, sideFoam);
      vec2 rot = vec2(cos(b * 6.3), sin(b * 6.3));
      vec2 p = vec2(position.x * rot.x - position.y * rot.y, position.x * rot.y + position.y * rot.x);
      vec3 at = toBody(center) + (viewRight() * p.x * size * 1.28 + viewUp() * p.y * size) * ${fmt(S)};
      vUV = uv;
      vSeed = id + cycle * 13.0;
      vPuff = phase;
      vLife = smoothstep(0.0, 0.1, phase) * (1.0 - smoothstep(0.45, 0.98, phase)) * smoothstep(-0.18, 0.06, center.y) * ${fmt(Math.min(1, IMPACT_FOAM))};
      gl_Position = projectionMatrix * modelViewMatrix * vec4(at, 1.0);
    }`,
    `
    varying vec2 vUV;
    varying float vLife;
    varying float vSeed;
    varying float vPuff;
    ${ORGANIC_GLSL}
    void main() {
      vec2 q = vUV * 2.0 - 1.0;
      float a = atan(q.y, q.x);
      float n = paintNoise(q * 3.2 + vec2(vSeed * 0.71, -vPuff * 1.8));
      float r = length(q) + 0.10 * sin(a * 5.0 + vSeed) + 0.065 * sin(a * 9.0 - vPuff * 4.0);
      float mask = 1.0 - smoothstep(0.50, 0.98, r + (n - 0.5) * 0.23);
      float alpha = mask * vLife * 0.30;
      if (alpha < 0.008) discard;
      vec3 col = mix(uFoamShade, uFoamLight, 0.45 + 0.55 * n);
      ${LANDING_OUT}
    }`,
  );
  return new THREE.Mesh(instancedQuads(PLUMES), material);
}

// A separate low-opacity veil: slow expansion and lift, never ballistic
// white splashes. Rounded noisy edges and a surface fade keep the water visible.
function mistMesh(l: Landing): THREE.Mesh {
  const material = landingMaterial(
    l,
    `
    varying vec2 vUV;
    varying float vLife;
    varying float vSeed;
    varying float vHeight;
    void main() {
      float id = float(gl_InstanceID), r = rnd(id + 204.0), s = rnd(id + 302.0);
      float life = 1.9 + r * 1.7;
      float clock = uTime / life + rnd(id + 416.0);
      float phase = fract(clock), cycle = floor(clock);
      float drift = rnd(id + cycle * 19.0 + 500.0);
      float sideMist = step(0.35, rnd(id + 290.0));
      float edge = mod(id, 2.0) * 2.0 - 1.0;
      vec3 rim = rimPoint(0.08 + drift * 0.84, edge);
      vec3 center = vec3(-0.08 - phase * (0.45 + drift * 0.55),
        0.08 + phase * (0.45 + r * 0.42) * uStrength,
        (s * 2.0 - 1.0) * uHalfWidth * 0.90 + (s * 2.0 - 1.0) * phase * 0.28);
      vec3 wrapped = rim + vec3(0.10 - phase * (0.14 + drift * 0.20),
        0.06 + phase * (0.48 + r * 0.44) * uStrength,
        edge * (0.03 + phase * 0.16) + (rnd(id + cycle * 11.0 + 535.0) - 0.5) * 0.13);
      center = mix(center, wrapped, sideMist);
      center.x += 0.10 * sin(phase * 4.0 + id);
      float size = (0.48 + r * 0.46) * (0.65 + phase * 0.85) * mix(1.0, 0.82, sideMist);
      vec3 at = toBody(center) + (viewRight() * position.x * size * 1.65 + viewUp() * position.y * size) * ${fmt(S)};
      vUV = uv;
      vSeed = id + cycle * 7.0;
      vHeight = center.y + position.y * size;
      vLife = smoothstep(0.0, 0.18, phase) * (1.0 - smoothstep(0.54, 1.0, phase)) * mix(1.0, 1.42, sideMist);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(at, 1.0);
    }`,
    `
    varying vec2 vUV;
    varying float vLife;
    varying float vSeed;
    varying float vHeight;
    ${ORGANIC_GLSL}
    void main() {
      vec2 q = vUV * 2.0 - 1.0;
      float n = paintNoise(q * 2.6 + vec2(vSeed * 1.31, uTime * 0.16));
      float radius = length(q) + (n - 0.5) * 0.25;
      float soft = 1.0 - smoothstep(0.18, 1.0, radius);
      float alpha = soft * (0.42 + 0.58 * n) * vLife * 0.135
        * smoothstep(0.01, 0.16, vHeight);
      if (alpha < 0.002) discard;
      vec3 col = uMistColor;
      ${LANDING_OUT}
    }`,
  );
  return new THREE.Mesh(instancedQuads(MISTS), material);
}

// Small pearly foam bubbles drift round the sheet's sides and out onto the
// receiving water. Crescents catch the light; only a few briefly sparkle.
function bubbleMesh(l: Landing): THREE.Mesh {
  const material = landingMaterial(
    l,
    `
    varying vec2 vUV;
    varying vec2 vBody;
    varying float vLife;
    varying float vGlint;
    varying float vSeed;
    void main() {
      float id = float(gl_InstanceID), r = rnd(id + 710.0);
      float life = 1.05 + r * 1.40 + rnd(id + 720.0) * 0.70;
      float clock = uTime / life + rnd(id + 721.0);
      float phase = fract(clock), seed = id + floor(clock) * 37.0;
      float edge = mod(id, 2.0) * 2.0 - 1.0;
      float along = rnd(seed + 742.0);
      vec3 center = rimPoint(along, edge);
      center.x -= phase * (0.14 + pow(rnd(seed + 752.0), 0.65) * 0.75);
      center.x += (rnd(seed + 759.0) - 0.5) * 0.18 + 0.04 * sin(phase * 4.0 + seed);
      center.z += edge * (0.02 + phase * 0.18) + (rnd(seed + 763.0) - 0.5) * 0.24
        + 0.035 * sin(phase * (3.8 + r * 2.0) + seed);
      center.y += 0.014 + 0.021 * sin(phase * 3.14159) + 0.014 * rnd(seed + 770.0);
      float shape = rnd(seed + 796.0);
      float clustered = step(0.90, shape);
      float size = (0.072 + pow(rnd(seed + 780.0), 1.2) * 0.12 + clustered * 0.035)
        * (0.72 + 0.28 * sin(phase * 3.14159));
      vec2 aspect = vec2(0.98 + rnd(seed + 785.0) * 0.42, 0.84 + rnd(seed + 789.0) * 0.28);
      vec3 at = toBody(center) + (viewRight() * position.x * size * aspect.x
        + viewUp() * position.y * size * aspect.y) * ${fmt(S)};
      vUV = uv;
      vBody = at.xz;
      vSeed = shape;
      vGlint = step(0.85, rnd(id + 805.0)) * pow(max(0.0, sin(uTime * (2.8 + r * 1.6) + seed)), 14.0);
      vLife = smoothstep(0.0, 0.10 + r * 0.08, phase) * (1.0 - smoothstep(0.56 + r * 0.16, 1.0, phase));
      gl_Position = projectionMatrix * modelViewMatrix * vec4(at, 1.0);
    }`,
    `
    uniform vec4 uClip;
    varying vec2 vUV;
    varying vec2 vBody;
    varying float vLife;
    varying float vGlint;
    varying float vSeed;
    void main() {
      if (vBody.x < uClip.x || vBody.x > uClip.y || vBody.y < uClip.z || vBody.y > uClip.w) discard;
      vec2 q = vUV * 2.0 - 1.0;
      float angle = atan(q.y, q.x);
      float radius = length(q) + 0.025 * sin(angle * 3.0 + vSeed * 6.28318);
      float paired = min(length(q - vec2(0.24, 0.03)) * 1.28, length(q + vec2(0.26, 0.02)) * 1.34);
      radius = mix(radius, paired, step(0.90, vSeed));
      float aa = max(0.025, fwidth(radius));
      float mask = 1.0 - smoothstep(0.82 - aa, 0.96 + aa, radius);
      float rim = smoothstep(mix(0.36, 0.49, vSeed), mix(0.72, 0.82, vSeed), radius) * mask;
      float crescent = rim * smoothstep(-0.1, 0.65, q.y - q.x);
      vec2 gleam = (q - vec2(-0.28, 0.34)) * 5.0;
      float pinpoint = exp(-dot(gleam, gleam)) * vGlint;
      float alpha = (mask * 0.42 + rim * 0.25 + pinpoint * 0.55) * vLife * ${fmt(Math.min(1, IMPACT_FOAM))};
      if (alpha < 0.008) discard;
      vec3 col = mix(uFoamShade, uFoamLight, 0.18 + 0.22 * vSeed + crescent * 0.70);
      col = mix(col, vec3(0.98, 1.0, 1.0), pinpoint);
      ${LANDING_OUT}
    }`,
  );
  return new THREE.Mesh(instancedQuads(BUBBLES), material);
}

// ---------------------------------------------------------------------------
// Where a fall lands
// ---------------------------------------------------------------------------

// A fall pours `spill` metres as authored, but the water it lands in is
// wherever the level put it: the landing goes where the sheet first meets the
// top of another water body under it (and the sheet is not drawn below that),
// or at the authored drop when nothing is there. Every water body's top and
// every fall are registered here when built, and the landings are found
// again every frame (a few dozen points; the bodies may yet move).
interface FallRecord {
  root: THREE.Object3D;
  xLip: number;
  yLip: number;
  side: number;
  v0: number;
  depth: number;
  drop: number;
  zMid: number;
  halfW: number;
  slot: number;
  impact: THREE.Vector3;
  floor: { value: number };
  clip: THREE.Vector4;
  strength: { value: number };
  contactHalfSpan: { value: number };
}

interface SurfaceRecord {
  root: THREE.Object3D;
  halfX: number;
  top: number;
  backZ: number;
  frontZ: number;
}

const falls = new Set<FallRecord>();
const surfaces = new Set<SurfaceRecord>();
// Samples down the arc when looking for the water it meets.
const LANDING_SAMPLES = 64;
const scratchInverse = new THREE.Matrix4();
const scratchToSurface = new THREE.Matrix4();
const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
const scratchWorld = new THREE.Vector3();

function arcPoint(f: FallRecord, t: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(f.xLip + f.side * f.v0 * t, f.yLip - 0.5 * FALL_GRAVITY * t * t, f.zMid);
}

function land(f: FallRecord): void {
  f.root.updateWorldMatrix(true, false);
  const tMax = Math.sqrt((2 * (f.drop + f.depth + FALL_OVERSHOOT)) / FALL_GRAVITY);
  let tHit = Infinity;
  let hit: SurfaceRecord | null = null;
  for (const s of surfaces) {
    if (s.root === f.root) continue;
    s.root.updateWorldMatrix(true, false);
    scratchToSurface.multiplyMatrices(scratchInverse.copy(s.root.matrixWorld).invert(), f.root.matrixWorld);
    const a = arcPoint(f, 0, scratchA).applyMatrix4(scratchToSurface);
    if (a.y <= s.top) continue;
    for (let i = 1; i <= LANDING_SAMPLES; i++) {
      const t = (tMax * i) / LANDING_SAMPLES;
      const b = arcPoint(f, t, scratchB).applyMatrix4(scratchToSurface);
      if (b.y <= s.top) {
        const k = (a.y - s.top) / (a.y - b.y);
        const tc = t - (tMax / LANDING_SAMPLES) * (1 - k);
        const x = a.x + (b.x - a.x) * k;
        const z = a.z + (b.z - a.z) * k;
        if (tc < tHit && Math.abs(x) <= s.halfX && z >= s.backZ && z <= s.frontZ) {
          tHit = tc;
          hit = s;
        }
        break;
      }
      a.copy(b);
    }
  }
  const t = hit ? tHit : Math.sqrt((2 * f.drop) / FALL_GRAVITY);
  // Visual intensity follows the actual landing, rather than the authored
  // spill past it. Reference: BALL's ~0.9 m lower drop at a 1.45 m/s lip.
  f.strength.value = THREE.MathUtils.clamp(Math.hypot(f.v0, FALL_GRAVITY * t) / 4.45, 0.7, 1.4);
  // The sheet crosses the surface over a span of x - its bottom first, a
  // slice depth above its top - and the landing is the middle of it.
  const tBottom = Math.sqrt(Math.max(0, t * t - (2 * f.depth) / FALL_GRAVITY));
  f.contactHalfSpan.value = f.v0 * (t - tBottom) / (2 * S);
  f.impact.set(f.xLip + f.side * f.v0 * (t + tBottom) / 2, f.yLip - 0.5 * FALL_GRAVITY * t * t, f.zMid);
  if (hit) {
    f.floor.value = scratchWorld.set(0, hit.top, 0).applyMatrix4(hit.root.matrixWorld).y - FALL_SINK;
    // The water's top in this body's frame, for the crown.
    scratchInverse.copy(f.root.matrixWorld).invert();
    const p = scratchA.set(-hit.halfX, hit.top, hit.backZ).applyMatrix4(hit.root.matrixWorld).applyMatrix4(scratchInverse);
    const q = scratchB.set(hit.halfX, hit.top, hit.frontZ).applyMatrix4(hit.root.matrixWorld).applyMatrix4(scratchInverse);
    f.clip.set(Math.min(p.x, q.x), Math.max(p.x, q.x), Math.min(p.z, q.z), Math.max(p.z, q.z));
  } else {
    f.floor.value = -1e9;
    f.clip.set(-1e9, 1e9, -1e9, 1e9);
  }
  if (f.slot >= 0) {
    scratchWorld.copy(f.impact).applyMatrix4(f.root.matrixWorld);
    impactAt.value[f.slot]!.set(scratchWorld.x, scratchWorld.y, scratchWorld.z, 1);
    const dir = scratchA.set(f.side, 0, 0).transformDirection(f.root.matrixWorld);
    impactHow.value[f.slot]!.set(f.halfW / S, Math.sign(dir.x) || 1, 0, 0);
  }
}

// ---------------------------------------------------------------------------
// Time and textures
// ---------------------------------------------------------------------------

// The textures the water shaders sample, for the prewarm (see
// `Scene3D.prewarm`): they ride the materials as uniforms rather than as map
// slots, so a sweep of the scene's materials cannot see them.
export function waterTextures(): THREE.Texture[] {
  return [waterSurfaceMap()];
}

// Once per drawn frame: the clock, and where every fall lands.
export function updateWater(seconds: number): void {
  waterTime.value = seconds;
  for (const f of falls) land(f);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface WaterBuild {
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  // A pool's surface, for the splash (stillWater.ts); null for a current.
  still: StillSurface | null;
  // Forget this water's registrations (its top, its fall): call at dispose.
  release: () => void;
}

// Build a water body's look under `root` (the BodyVisual's group, which carries
// the body's pose). Rects only - every authored water body is one, and the 2D
// overlay's streak glyphs remain the fallback for anything else.
//
// Everything it reads is on the body: the physics (flow, drag), the SPILL
// (`spill`, the drop off the downstream end, and `spillSpeed`, the lip speed),
// the slab through z (`waterZ`, `waterDepth`) and the tint (`color`). Water is
// drawn by the game rather than by the level's Blender scene, because the
// current moves its surface every frame (plans/blender-owns-appearance.md).
export function buildWater(root: THREE.Group, body: WaterArea, data: LevelBodyData): WaterBuild {
  const shape = body.primaryShape();
  const s = shape.shape;
  if (s.kind !== "circle" && s.kind !== "rect") {
    return { geometries: [], materials: [], still: null, release: () => {} };
  }
  const halfX = s.kind === "rect" ? s.size.x / 2 : s.radius;
  const halfY = s.kind === "rect" ? s.size.y / 2 : s.radius;
  // The slab through z, in the extruder's convention: depth centred on the
  // plane, shifted by `z`.
  const depth = data.waterDepth ?? DEFAULT_WATER_DEPTH;
  const frontZ = (data.waterZ ?? 0) + depth / 2;
  const backZ = frontZ - depth;
  // The spill: off the end the flow points at, at the flow's own speed unless
  // told otherwise. A run with no current spills off its +x end.
  const drop = data.spill ?? 0;
  const spill: SpillSpec | null =
    drop > 0
      ? {
          side: body.flow < 0 ? -1 : 1,
          v0: Math.max(data.spillSpeed ?? Math.abs(body.flow), 0.3),
          drop,
        }
      : null;
  const color = body.fillColor ?? undefined;
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const surface: SurfaceRecord = { root, halfX, top: halfY, backZ, frontZ };
  surfaces.add(surface);

  // Water with no current and nothing pouring off it is a POOL, and a pool is
  // drawn as the cave-pool study (stillWater.ts) rather than as a current.
  if (body.flow === 0 && !spill) {
    const geometry = poolGeometry(halfX, halfY, frontZ, backZ);
    const pool = stillWaterMaterial(color, backZ, frontZ);
    const mesh = new THREE.Mesh(geometry, pool.material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // Transparent, so drawn after the opaque scene; the high renderOrder keeps
    // it after other transparent scenery it might share pixels with.
    mesh.renderOrder = 10;
    root.add(mesh);
    return {
      geometries: [geometry],
      materials: [pool.material],
      still: {
        body,
        halfX,
        halfY,
        backZ,
        frontZ,
        mesh,
        reflect: pool.reflect,
        openBehind: pool.openBehind,
        footprint: pool.footprint,
        color,
        scenery: [],
      },
      release: () => surfaces.delete(surface),
    };
  }

  const front = frontZ - FRONT_INSET;
  const built = currentGeometry(halfX, halfY, front, backZ, body.flow, spill);
  const floor = { value: -1e9 };
  const look: CurrentLook = {
    color,
    side: spill ? spill.side : body.flow < 0 ? -1 : 1,
    runSpeed: Math.max(Math.abs(body.flow), 0.05),
    lipSpeed: spill ? spill.v0 : Math.abs(body.flow),
    lipS: built.lip ? built.lip.s : null,
    runEnd: built.lip ? built.lip.s : (halfX * 2) / S,
    drop: spill ? spill.drop : 0,
    floor,
  };
  const mat = currentMaterial(look);
  const mesh = new THREE.Mesh(built.geometry, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 10;
  root.add(mesh);
  geometries.push(built.geometry);
  materials.push(mat);

  let fall: FallRecord | null = null;
  if (spill && built.lip) {
    fall = {
      root,
      xLip: built.lip.x,
      yLip: built.lip.y,
      side: spill.side,
      v0: spill.v0,
      depth: built.lip.depth,
      drop: spill.drop,
      zMid: (front + backZ) / 2,
      halfW: (front - backZ) / 2,
      slot: takeImpactSlot(),
      impact: new THREE.Vector3(),
      floor,
      clip: new THREE.Vector4(),
      strength: { value: 1 },
      contactHalfSpan: { value: 0 },
    };
    falls.add(fall);
    land(fall);
    const landing: Landing = {
      impact: fall.impact, side: spill.side, halfWidth: fall.halfW / S,
      clip: fall.clip, palette: studyPalette(color), strength: fall.strength,
      contactHalfSpan: fall.contactHalfSpan,
    };
    // Drawn after the water: mist, the low crown, soft froth and side bubbles.
    // Always in the scene and never culled (each is placed in its vertex
    // shader), so the prewarm compiles all four.
    [mistMesh(landing), crownMesh(landing), plumeMesh(landing), bubbleMesh(landing)].forEach((m, i) => {
      m.frustumCulled = false;
      m.renderOrder = 11 + i;
      root.add(m);
      geometries.push(m.geometry);
      materials.push(m.material as THREE.Material);
    });
  }
  return {
    geometries,
    materials,
    still: null,
    release: () => {
      surfaces.delete(surface);
      if (fall) {
        falls.delete(fall);
        freeImpactSlot(fall.slot);
      }
    },
  };
}
