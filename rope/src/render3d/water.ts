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
// ribbons under gravity; and at the landing plumes thrown up at the curtain's
// foot over foam lying flat on the water it lands in, whole at the plunge and
// breaking into rings that drift out and thin. The port is shader for shader, with the study's numbers, in study
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
import {
  BALL_FOAM_GLSL,
  ballFoamUniforms,
  FRONT_INSET,
  poolGeometry,
  stillWaterMaterial,
  type FoamSurface,
  type StillSurface,
} from "./stillWater";
import {
  BOIL_REACH,
  DEPTH_STRETCH,
  fmt,
  freeImpactSlot,
  IMPACT_GLSL,
  impactAt,
  impactBend,
  impactHow,
  impactUniforms,
  LIGHT_FALLOFF,
  ORGANIC_GLSL,
  STUDY_SCALE,
  foamColor,
  studyPalette,
  takeImpactSlot,
  waterSurfaceMap,
  waterTime,
} from "./waterLook";

export { waterTime } from "./waterLook";

// TEMPORARY (Tris, 2026-10-06, an A/B): how much of the ripples' light bands
// (broad light, shade, crests) the river and the falls draw; `?shimmer=0`
// turns them off (main.ts). Remove once compared.
export const waterShimmer = { value: 1 };

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
// The river's wash (the study's default 1.32 is its unit here). The curtain
// draws none (Tris, 2026-10-07).
const RIVER_FOAM = 1.0;
// The running surface's look (after karin-lu's PR #2, Tris 2026-10-07): its
// ripples churn at RUNNING_CHURN of the cascade's rate with RUNNING_CHOP of
// its fine chop, stretched RUNNING_STRETCH along the current, and its wash is
// broken turquoise strokes rather than the study's milky streaks. Over the
// last BRINK_HANDOVER metres before a lip it hands over to the look the
// cascade continues (the study's 1.9 m acceleration zone), reached by the
// lip, and the strokes give out, so nothing ends at the brow.
const RUNNING_CHURN = 0.25;
const RUNNING_CHOP = 0.3;
const RUNNING_STRETCH = 1.8;
const BRINK_HANDOVER = 0.95;
// How far down a channel's front the running surface's edge glint reaches,
// metres.
const RIM_DOWN = 0.03;
// The landing's shapes: how high the plumes are thrown (in boil units, see
// BOIL_REACH), and how much of them.
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
// THE BRINK (a free overfall, the textbook case). A current U deep H carries
// q = U H per metre of width, and pouring off an edge it runs down through
// critical depth y_c = (q^2 / g)^(1/3) to the BRINK DEPTH at the edge itself:
// 0.715 y_c for a current slower than its wave speed (Froude U / sqrt(g H)
// under 1; Rouse's measurement, BRINK_DEPTH), H Fr^2 / (Fr^2 + 0.4) for a
// faster one (Rajaratnam's, which meets the first at Fr = 1). Continuity
// speeds the water up to q / y_b at the lip. BALL's 1.2 m/s, 0.4 m deep lower
// channel leaves at 2.3 m/s, 21 cm deep.
//
// THE DRAWDOWN. Over the bed the water is held up: only its surface comes
// down, gently, and the slab is not falling yet. A subcritical current passes
// critical depth CRITICAL_REACH y_c before the lip (Rouse measured 3 to 4 y_c)
// and keeps drawing down, steepening, to y_b at the edge. The surface is one
// parabola through those two depths with its vertex upstream, where the drop
// begins; a current at or over its wave speed has no critical section to pass
// and starts CRITICAL_REACH y_c out, which is where the first case lands as Fr
// reaches 1. At the lip its slope is a few degrees (5 on BALL's falls), and
// the sheet leaves along it: the lower face leaves the level bed level, and
// only past the edge does GRAVITY take the water, so the fall's curve is g/v^2
// from the lip down - faster water, a gentler brow (Tris, 2026-10-06: "faster
// flowing water should result in a more gradual curve").
//
// Before this (2026-10-06 to 2026-10-07) the surface was one ballistic arc
// from where it started to drop, as if the whole slab were in free fall over
// the bed: it reached the lip already falling at 44 degrees (2.55 m/s on
// BALL's upper fall) and threw the sheet 1.9 m out of a 4 m drop - "I would
// expect less of an arc" (Tris, 2026-10-07). Rand's measured throw for a
// straight drop, L = 4.30 D^0.27 h with D = q^2 / (g h^3), puts that one at
// 2.5 m; leaving at 5 degrees it throws 2.4 m. Before THAT the lip speed was
// authored (`spillSpeed`, retired), 1 m/s on every level, slower than the
// currents feeding it: the water braked into the brink, levelled out on a
// smoothstep drawdown, and turned down a 10 cm radius whatever the current
// did.
const BRINK_DEPTH = 0.715;
const CRITICAL_REACH = 3.5;
const FALL_GRAVITY = 9.81;

interface Brink {
  // Depth at the lip (m), the horizontal speed there (m/s), how far upstream
  // of the lip the surface starts to drop (m), and how fast it is already
  // falling at the lip (m/s, downward).
  depth: number;
  speed: number;
  reach: number;
  dive: number;
}

export function brinkOf(runSpeed: number, depth: number, runLength: number): Brink {
  const fr2 = (runSpeed * runSpeed) / (FALL_GRAVITY * depth);
  const share = fr2 < 1 ? BRINK_DEPTH * Math.cbrt(fr2) : fr2 / (fr2 + 0.4);
  const yb = depth * share;
  const speed = (runSpeed * depth) / yb;
  const yc = Math.cbrt((runSpeed * runSpeed * depth * depth) / FALL_GRAVITY);
  // The parabola's vertex: at the lip it is y_b down, CRITICAL_REACH y_c
  // before it y_c down, so (1 - CRITICAL_REACH y_c / L)^2 = (H - y_c) / (H - y_b).
  const passing = fr2 < 1 ? Math.sqrt((depth - yc) / (depth - yb)) : 0;
  // A run shorter than that starts drawing down at its upstream end.
  const reach = Math.min((CRITICAL_REACH * yc) / (1 - passing), runLength);
  return { depth: yb, speed, reach, dive: (speed * 2 * (depth - yb)) / reach };
}

// Seconds for the arc leaving the lip at `dive` m/s downward to fall `dy` m.
function fallTime(dive: number, dy: number): number {
  return (-dive + Math.sqrt(dive * dive + 2 * FALL_GRAVITY * Math.max(0, dy))) / FALL_GRAVITY;
}
// The fall: samples along the arc, uniform in time (packed into the brow,
// spread down the drop), and how far past the drop the tube carries on.
const FALL_STEPS = 64;
const FALL_OVERSHOOT = 0.2;
// THE SHEET'S PLAN. The banks drag on the water beside them, so a channel's
// edges leave the lip slower than its middle and fall closer to it: a slice's
// launch speed is the lip's times 1 - EDGE_LAG (z/b)^2, b the half width, so
// the falling sheet bows out in the middle. The study's thickness ridges are
// kept at RIDGE_SHARE of their contrast.
//
// NOTHING ELSE SHAPES THE EDGES (Tris, 2026-10-06: no shaping that is not
// physically accurate). A channel's surface is level across it, so its depth
// at the banks is its depth in the middle: an edge thinning (EDGE_THIN, 0.6
// then 0.15) was tried and removed - the game sees a fall from the side, which
// is its edge, and with continuity's own thinning on top it drew a 4 cm
// ribbon. The study's ridges and folding faded toward the edges for a while
// (FOLD_EDGE), to keep its fixed-across-the-width ridges from puffing BALL's
// edges out; removed with it.
const EDGE_LAG = 0.25;
const RIDGE_SHARE = 0.5;
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
// The front sheet's opacity, waterline to bed: murky glass, so the submerged
// ball stays a silhouette (the pool's numbers). The top and the fall are
// opaque, as the study's water is.
const ALPHA_FRONT_TOP = 0.94;
const ALPHA_FRONT_BED = 0.8;
// THE LANDING'S SCALE, from the fall's own physics (Tris, 2026-10-06: the
// churn should fit the height and the water). The sheet strikes at
// v_i = sqrt(v_lip^2 + 2 g drop), carrying q m^2/s per metre of width.
// - The BOIL (the foam on the water below and the plumes) is the bubbles the
//   sheet drives down coming back up: its size is the one length the sheet's
//   momentum per width q v_i and gravity make, l = sqrt(q v_i / g), and its
//   foam reaches l (waterLook.ts, BOIL_REACH). Its shapes are drawn in units
//   of l / BOIL_REACH, on a clock run by the square root of that unit
//   (Froude: the same gravity at any size). BALL: 0.33 m on the lower fall,
//   0.66 m on the upper.
// - Nothing is THROWN: loose drops read as a sprinkler and splash ribbons
//   arcing out were not liked either (Tris, 2026-10-06), so both are gone.
// - HOW MUCH: a plunging sheet entrains air in proportion to q (v_i - v_e),
//   v_e ~1 m/s the speed below which it takes in none (ENTRAIN_ONSET); times
//   the width, that sets how many plumes are out, at PLUMES_PER per unit (the
//   lower fall's 2.6 units keep the 72 it had), up to PLUMES_MAX.
const ENTRAIN_ONSET = 1.0;
const PLUMES_PER = 28;
const PLUMES_MAX = 256;

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
  // sits on it). Read out as a number first: subtracting a point's own field
  // zeroes it partway through the loop, and every point after the centre was
  // then left unshifted - the pattern coordinate jumped by the whole back half
  // across one cell of the top, and drew a seam down the middle of the
  // channel and its fall.
  const zero = out[BED_SEGS + 2 * CORNER_SEGS + BACK_SEGS + TOP_SEGS / 2]!.ell;
  for (const p of out) p.ell -= zero;
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
  // Seconds since the lip on the fall; -1 on the river.
  age: number;
}

export interface SpillSpec {
  side: number;
  drop: number;
}

interface CurrentGeometry {
  geometry: THREE.BufferGeometry;
  // The fall's lip and its slice, in the body's frame, with the speed it
  // leaves at and how fast it is already falling (see `brinkOf`), or null
  // without one.
  lip: { x: number; y: number; depth: number; s: number; speed: number; dive: number } | null;
}

// The run and its fall as one closed tube, in the body's local frame (three's
// y-up: local +x the flow axis, +z toward the camera). The river's stations
// carry the section from the upstream end to the lip; the fall's carry the
// lip's section along the arc a thrown thing follows, as VERTICAL SLICES: every
// layer of the slab leaving the lip follows the same parabola from its own
// height, so a slice at time t is the lip's carried along the arc unturned.
// That is the physics - continuity thins the sheet's perpendicular thickness
// by exactly v0/v, which a constant vertical depth is - and it is what keeps
// a slab thicker than the brow's radius of curvature from folding under the
// lip, which the study's sections perpendicular to the travel did on BALL's
// tight brows (before the brink, see BRINK_DEPTH).
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
  // level until the drawdown starts, then down its parabola into the lip, the
  // water speeding up by continuity as it thins over the level bed.
  const brink = spill ? brinkOf(runSpeed, halfY * 2, length) : null;
  const arcFrom = brink ? length - brink.reach : length;
  const topAt = (s: number): number =>
    brink && s > arcFrom ? halfY - (halfY * 2 - brink.depth) * ((s - arcFrom) / brink.reach) ** 2 : halfY;
  const speedAt = (s: number): number => (runSpeed * halfY * 2) / (topAt(s) + halfY);

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
      age: -1,
    });
  }
  // The river's tangent follows its surface (the drawdown), and meets the
  // fall's at the lip, which leaves along it.
  for (let i = 0; i < stations.length; i++) {
    const a = stations[Math.max(0, i - 1)]!;
    const b = stations[Math.min(stations.length - 1, i + 1)]!;
    const tl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    stations[i]!.tx = (b.x - a.x) / tl;
    stations[i]!.ty = (b.y - a.y) / tl;
  }
  let lip: CurrentGeometry["lip"] = null;
  if (spill && brink) {
    const l = stations[stations.length - 1]!;
    lip = { x: l.x, y: l.y, depth: l.depth, s: l.s, speed: brink.speed, dive: brink.dive };
    const tEnd = fallTime(brink.dive, spill.drop + l.depth + FALL_OVERSHOOT);
    for (let i = 1; i <= FALL_STEPS; i++) {
      const t = (tEnd * i) / FALL_STEPS;
      const prev = stations[stations.length - 1]!;
      const x = l.x + side * brink.speed * t;
      const y = l.y - brink.dive * t - 0.5 * FALL_GRAVITY * t * t;
      const vx = side * brink.speed;
      const vy = -brink.dive - FALL_GRAVITY * t;
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
        age: t,
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
    // Down the fall each column of the slice leaves the lip at its own speed
    // (see EDGE_LAG): its own x along the arc, and its own travel direction.
    // Its whole velocity scales, so it leaves on the river's own slope and
    // only curves the tighter for being slower.
    let x = st.x;
    let y = st.y;
    let drop = st.drop;
    let tx = st.tx;
    let ty = st.ty;
    let speed = st.speed;
    if (spill && lip && st.age >= 0) {
      const across = p.z / (width / 2);
      const k = 1 - EDGE_LAG * across * across;
      const vx = side * lip.speed * k;
      const vy = -lip.dive * k - FALL_GRAVITY * st.age;
      speed = Math.hypot(vx, vy);
      x = lip.x + vx * st.age;
      y = lip.y - lip.dive * k * st.age - 0.5 * FALL_GRAVITY * st.age * st.age;
      drop = (lip.y - y) / spill.drop;
      tx = vx / speed;
      ty = vy / speed;
    }
    // N: T turned a right angle toward up and out.
    const nx = -side * ty;
    const ny = side * tx;
    // A vertical slice (see the header): the section hangs straight down from
    // its station, whatever way the water is travelling.
    pos.push(x, y + p.h, zMid + p.z);
    const below = -p.h;
    const flat = topFlat(width / 2, r);
    const e = Math.abs(p.ell);
    const u = e <= flat ? e / (S * DEPTH_STRETCH) : flat / (S * DEPTH_STRETCH) + (e - flat) / S;
    flowA.push(st.s, p.z / (S * DEPTH_STRETCH), st.tau, drop);
    unroll.push(Math.sign(p.ell) * u);
    tangent.push(tx, ty, 0);
    disp.push(nx, ny, 0);
    profile.push(p.nz, p.ny, st.depth / S, halfWidth);
    skin.push(
      Math.max(0, Math.min(1, 1 - below / Math.min(LIGHT_FALLOFF, st.depth))),
      ((p.h + st.depth / 2) * ny) / S,
      speed,
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
  // The sheet's thickness about its middle: the study's ridges at RIDGE_SHARE
  // of their contrast.
  float thicknessField(vec4 f) {
    vec2 p = parcel(f);
    float fall = smoothstep(0.0, 0.32, f.w);
    float ridges = pow(0.5 + 0.5 * cos(p.x * 5.1 + 0.22 * sin(p.x * 1.2 + p.y * 0.75)), 3.0);
    float thickness = mix(1.0, (0.43 + 2.10 * ridges) / 1.08625, ${fmt(RIDGE_SHARE)});
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
  uniform float uSpilling;
  uniform float uFloor;
  uniform float uShimmer;
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
  varying float vSpeed;
  // How far the water here has been DRAWN OUT along its flow since the river:
  // its speed over the run's. A parcel keeps its label (parcelAt) as it
  // speeds into the brink and down the fall, so a metre of river surface
  // becomes v / U metres, and a ripple carried on it keeps its slope across
  // the flow but loses that share of its slope along it. So the bands the
  // river's crossing crests draw fade over the brink while the slanting ones
  // are pulled into streaks down the sheet - the physics, rather than a
  // pattern of its own for the fall.
  float drawnOut() { return max(1.0, vSpeed / (uRefSpeed * ${fmt(S)})); }
  // Three drifting layers of the pool's spectrum, read in parcel space
  // (across, along), stretched along the flow so the bands lengthen with the
  // current; the second and third turned (90 and ~40 degrees) so the
  // spectrum's own diagonal never lines up across all three. The slope in
  // the surface's own frame: x across (world z), y along the travel, per
  // metre of the river's own surface (see drawnOut).
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
  // The running surface's wash field: long, broken strokes carried by the
  // parcel coordinates, a little lateral wander that stays attached to the
  // current instead of boiling in place.
  float currentStreak(vec2 mp) {
    vec2 sq = vec2(mp.x * 2.0 + 0.12 * sin(mp.y * 0.55), mp.y * 0.28);
    return wfb(sq) * 0.78 + 0.22 * wn(sq * vec2(1.8, 1.4) + 7.3);
  }
  // The river's ripples (riverSlope) and, on top, a fine chop that churns in
  // its own time: a current is not a mirror. \`churn\` is the share of CHURN
  // both move at, \`chop\` the share of the chop.
  vec2 riverRipples(vec2 matp, float stretch, float churn, float chop, out vec4 b) {
    vec4 a, c;
    vec2 s = riverSlope(matp, stretch, churn, a, b, c);
    float t = uTime * ${fmt(CHURN)} * churn;
    vec2 q = matp / ${fmt(PATCH_SIZE * Math.max(0.5, BRUSH_SCALE))};
    vec4 d = texture2D(uSurfaceMap, q * vec2(0.21, 0.27) + vec2(0.05, -0.07) * t + 0.17);
    vec4 e = texture2D(uSurfaceMap, q * vec2(0.33, 0.41) + vec2(-0.08, 0.05) * t + 0.61);
    float fine = 1.0 - smoothstep(0.14, 0.8, length(fwidth(q)));
    return s + ((d.rg * 2.0 - 1.0) * vec2(0.06, 0.08) + (e.rg * 2.0 - 1.0) * vec2(0.035, 0.045)) * fine * ${fmt(CHURN)} * chop;
  }
  vec3 paintedRiver(out float foam) {
    // Across (continued down the faces), Lagrangian travel.
    vec2 matp = parcelAt(vUnroll, vFlow.z);
    // 0 on the running surface, 1 by the lip: the look the cascade carries on
    // (see BRINK_HANDOVER). Every term below is the running surface's mixed
    // toward the brink's by it.
    float brink = uSpilling * smoothstep(uLip - ${fmt(BRINK_HANDOVER / S)}, uLip, vFlow.x);
    vec4 b;
    vec2 s = riverRipples(matp, ${fmt(RUNNING_STRETCH)}, ${fmt(RUNNING_CHURN)}, ${fmt(RUNNING_CHOP)}, b);
    // Uniform control flow, so the derivatives in riverRipples stay defined.
    if (uSpilling > 0.5) {
      vec4 bb;
      vec2 sb = riverRipples(matp, 1.15, 1.0, 1.0, bb);
      s = mix(s, sb, brink);
      b = mix(b, bb, brink);
    }
    // Drawn out into the brink (see drawnOut).
    s.y /= drawnOut();
    // Surface frame to world: across is +z, along the travel is uSide x.
    vec2 ripple = vec2(uSide * s.y, s.x);
    // The long swell tilts the same bands, as the pool's long waves do.
    vec2 sw = swellSlope(matp);
    vec2 slope = ripple + vec2(uSide * sw.y, sw.x) * ${fmt(MACRO_LIGHT)};
    // Where a fall lands on this run, its boil and rings (waterLook.ts).
    slope += impactSlope(vWorld) * step(0.5, vUp);
    vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
    vec3 V = normalize(cameraPosition - vWorld);
    // The running surface is the pool's teal, restrained deep-to-shallow
    // patches riding the current. Into the brink its colour drifts: patches
    // lean deep, shallow or toward the light tone, and a little greener here
    // and there.
    vec3 base;
    {
      vec2 mq = vec2(matp.x * 0.38, matp.y * 0.13);
      base = mix(uDeep, uShallow, 0.72 + 0.16 * smoothstep(0.3, 0.72, wfb(mq)));
      if (brink > 0.0) {
        float t = uTime * ${fmt(CHURN)};
        float tone = wfb(mq + vec2(t * 0.03, -t * 0.02));
        float tone2 = wfb(mq * 1.9 + vec2(5.0, 2.0) + vec2(-t * 0.04, t * 0.015));
        vec3 drift = mix(uDeep, uShallow, 0.45 + 0.5 * smoothstep(0.3, 0.72, tone));
        drift = mix(drift, uLight * 0.92, 0.3 * smoothstep(0.55, 0.85, tone2));
        drift *= mix(vec3(1.0), vec3(0.94, 1.04, 0.97), smoothstep(0.4, 0.7, wfb(mq * 0.8 + vec2(11.0, 7.0))));
        base = mix(base, drift, brink);
      }
    }
    // Wide, soft light bands follow the changing wave slopes.
    float facing = slope.y + slope.x * 0.24;
    float broadLight = smoothstep(0.012, 0.052, facing);
    float crest = smoothstep(0.078, 0.125, facing) * smoothstep(0.28, 0.65, b.b);
    float shade = smoothstep(0.015, 0.14, -facing);
    broadLight *= uShimmer;
    crest *= uShimmer;
    shade *= uShimmer;
    base *= 1.0 - shade * 0.22 * ${fmt(PAINT_STRENGTH)};
    base = mix(base, uLight, broadLight * ${fmt(CONTRAST)} * ${fmt(0.22 + FOREGROUND * 0.3)} * ${fmt(PAINT_STRENGTH)});
    vec3 col = base;
    vec3 L = normalize(vec3(-0.36, 0.78, -0.43));
    float specular = pow(max(0.0, dot(n, normalize(V + L))), 100.0);
    col += uLight * specular * 0.06;
    col += uLight * crest * ${fmt(CONTRAST * 0.16 * STROKES)};
    // The wash: broken turquoise strokes, faint in mid-channel and paling
    // toward the lip, then giving out over the brink (the curtain draws
    // none). Cut clean at their edges. (The study also drew it opaque along
    // the banks, with a rim at the waterline: extra foam down the water's
    // sides, dropped, Tris 2026-10-06.)
    float lip = exp(-pow((uLip - vFlow.x - 0.3) / 1.0, 2.0)) * uSpilling;
    float contact = clamp(0.65 * lip, 0.0, 1.0) * ${fmt(RIVER_FOAM)};
    float light = 0.84 + 0.16 * max(0.0, dot(n, L));
    {
      float streak = currentStreak(matp);
      float threshold = mix(0.68, 0.52, contact);
      // A crisp edge, cut to the pixel: the streak is translucent through its
      // opacity, never feathered.
      float aa = 0.5 * fwidth(streak);
      float wash = smoothstep(threshold - aa, threshold + aa, streak);
      // Thinner streaks inside: a second cut a little higher draws a brighter core.
      float core = smoothstep(threshold + 0.07 - aa, threshold + 0.07 + aa, streak);
      float opacity = mix(0.15, 0.55, contact) * (1.0 - brink);
      vec3 milk = mix(uLight, vec3(0.88, 0.94, 0.95), contact * 0.8);
      col = mix(col, milk * light, wash * opacity * ${fmt(STROKES)});
      col = mix(col, mix(milk, vec3(0.92, 0.96, 0.96), contact * 0.5) * light, core * opacity * 0.35 * ${fmt(STROKES)});
      // A broken teal glint at the waterline, not a white border: a slab's
      // edge is no evidence of rock there.
      float rim = smoothstep(vHalfWidth - 0.16, vHalfWidth - 0.03, abs(vFlow.y))
        * smoothstep(0.58, 0.78, wn(vec2(matp.y * 1.3, matp.x * 3.0)))
        * (1.0 - smoothstep(0.0, ${fmt(RIM_DOWN)}, vBelow));
      col = mix(col, uLight * light, rim * 0.18 * (1.0 - brink));
      foam = clamp(wash * opacity, 0.0, 1.0) * mix(0.09, 1.0, vSurfaceWeight);
    }
    // A fall's foam and the milky water under it, on the top only.
    vec4 pixel = impactPixel(vWorld);
    if (vUp > 0.5) col = impactPaint(vWorld, col, uLight, pixel);
    // Down the submerged face the same pigment fades to deep.
    col = mix(col, uDeep * 0.57, (1.0 - vSurfaceWeight) * 0.58);
    return col;
  }
  vec3 cascadeLook() {
    float fall = smoothstep(0.0, 0.80, vFlow.w);
    // The river's own ripples, carried over the brink at the river's labels
    // and drawn out as the water accelerates (see drawnOut). The cascade once
    // read its own pattern, drawn out by a factor of the study's and then
    // turned to run down the sheet: its crests across the sheet drew long
    // horizontal shimmers (Tris, 2026-10-06), which the physics fades.
    vec2 matp = parcelAt(vUnroll, vFlow.z);
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
    vec2 s = riverSlope(matp, 1.15, 1.0, a, b, c);
    s.y /= drawnOut();
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
    broadLight *= uShimmer;
    crest *= uShimmer;
    shade *= uShimmer;
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
    // No whitewater down the curtain: the milky streaks the study drew here
    // (the river's wash carried over the brink, filling in toward white down
    // the sheet) were removed, Tris 2026-10-07. The river's own strokes give
    // out before the lip (see BRINK_HANDOVER), so none ends at the brow.
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
  lipS: number | null;
  drop: number;
  // Where the run ends (its lip, or its downstream cap), study metres.
  runEnd: number;
  // The run's upstream end and its top, in the body's frame (metres), for
  // the frame the ball's foam is kept in (see `vFoam`).
  upstream: number;
  top: number;
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
    shader.uniforms.uShimmer = waterShimmer;
    shader.uniforms.uSurfaceMap = { value: waterSurfaceMap() };
    shader.uniforms.uDeep = { value: deep };
    shader.uniforms.uShallow = { value: shallow };
    shader.uniforms.uLight = { value: light };
    shader.uniforms.uSide = { value: look.side };
    // The parcel's travel at the run's speed, study metres per second.
    shader.uniforms.uRefSpeed = { value: look.runSpeed / S };
    shader.uniforms.uLip = { value: look.lipS ?? 1e6 };
    shader.uniforms.uSpilling = { value: look.lipS === null ? 0 : 1 };
    shader.uniforms.uSpill = { value: Math.max(look.drop, 1e-3) };
    shader.uniforms.uRunEnd = { value: look.runEnd };
    shader.uniforms.uFloor = look.floor;
    Object.assign(shader.uniforms, ballFoamUniforms);
    shader.uniforms.uUpstream = { value: look.upstream };
    shader.uniforms.uTop = { value: look.top };
    shader.uniforms.uDrift = { value: look.side * look.runSpeed };

    shader.vertexShader = `
      ${WAVE_GLSL}
      uniform float uSpill;
      uniform float uUpstream;
      uniform float uTop;
      varying vec3 vFoam;
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
      varying float vSpeed;
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
        vSpeed = aSkin.z;
        // The ball's foam is kept in the water's own frame (stillWater.ts,
        // wakeSpotDrift): where the water here was at the clock's zero, had
        // the run carried it level at its own speed - its parcel's label, so
        // the foam rides the current at exactly its speed, and over the brink
        // and down the fall is drawn out as the water is. On the run's top,
        // across at the vertex's own z.
        vFoam = (modelMatrix * vec4(uUpstream + uSide * uRefSpeed * ${fmt(S)} * (aFlow.z - uTime), uTop, position.z, 1.0)).xyz;
      }`,
    );

    shader.fragmentShader = `
      ${WAVE_GLSL}
      ${IMPACT_GLSL}
      ${BALL_FOAM_GLSL}
      ${PAINT_GLSL}
      uniform float uDrift;
      varying vec3 vFoam;
    ${shader.fragmentShader}`.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      // The falling sheet goes under the water it lands in.
      if (vFlow.w > 0.0 && vWorld.y < uFloor) discard;
      // The ball's wake and splash (stillWater.ts), here in uniform control
      // flow, which its derivatives need.
      float ballFoamHere = ballFoam(vFoam, uDrift);
      // The river, the cascade, and between them down the brow.
      float cascade = smoothstep(0.0, 0.23, vFlow.w);
      float foam = 0.0;
      vec3 col = vec3(0.0);
      if (cascade < 1.0) col = paintedRiver(foam);
      if (cascade > 0.0) {
        col = mix(col, cascadeLook(), cascade);
      }
      // The ball's foam, the fall's tone, on the top face as a pool's is.
      col = mix(col, foamTone(uLight), ballFoamHere * vUp);
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

// Where a fall meets the water: the plumes thrown up at the curtain's foot,
// over the foam the water it lands in draws on itself (waterLook.ts,
// impactPaint), scaled by the fall's own physics (see BOIL_REACH). The boil
// is drawn in boil units in a frame whose x is turned so the sheet travels
// toward -x, about the impact, on the landing's own clock. Every piece is a
// pure function of the clock and its instance, so a pinned clock draws the
// same landing twice.
//
// CLEAN EDGES: every piece is opaque and cut to the pixel, and comes and goes
// by growing and shrinking rather than fading (Tris, 2026-10-06: the soft
// translucent puffs read as a blurry mist over the stylised scene).
//
// There is no standing mound of foam: clean water's bubbles burst as they
// surface, so its foam lies flat on the water. A frothing crown stood here
// until 2026-10-06 (noise folds, then bubble caps that read as a bubble bath;
// Tris), replaced by the foam on the surface after his reference.
interface Landing {
  impact: THREE.Vector3;
  side: number;
  // The top of the water it lands in, in the body's frame (min x, max x,
  // min z, max z): the plumes come out of that water and nowhere past its
  // ends.
  clip: THREE.Vector4;
  // The foam's flat tone, the water's (waterLook.ts, foamColor).
  foam: THREE.Color;
  // Set every frame by `land`: metres per boil unit and the boil's clock;
  // and the sheet's half width (metres).
  unit: { value: number };
  clock: { value: number };
  halfWidth: { value: number };
  // How far upstream the sheet's edges strike of its middle, boil units (see
  // impactBend).
  bend: { value: number };
}

// Uniforms every landing program shares.
function landingUniforms(l: Landing): Record<string, THREE.IUniform> {
  return {
    uTime: waterTime,
    uClock: l.clock,
    uImpact: { value: l.impact },
    uSide: { value: l.side },
    uUnit: l.unit,
    uHalfWidthM: l.halfWidth,
    uBend: l.bend,
    uClip: { value: l.clip },
    uFoam: { value: l.foam },
  };
}

const LANDING_PRELUDE = `
  uniform float uTime;
  uniform float uClock;
  uniform vec3 uImpact;
  uniform float uSide;
  uniform float uUnit;
  uniform float uHalfWidthM;
  uniform float uBend;
  // The sheet's half width in boil units.
  float halfWidth() { return uHalfWidthM / uUnit; }
  // How far upstream (+x) of the middle's the sheet strikes at z across it
  // (boil units), held at the edges' past them.
  float strikeShift(float z) { float a = clamp(z / halfWidth(), -1.0, 1.0); return uBend * a * a; }
  // A point in boil units (sheet toward -x) to the body's frame.
  vec3 toBody(vec3 p) { return uImpact + vec3(-uSide * p.x, p.y, p.z) * uUnit; }
  // The camera's right and up in the body's frame.
  vec3 viewRight() { return vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0]); }
  vec3 viewUp() { return vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]); }
  float rnd(float x) { return fract(sin(x * 127.1 + 311.7) * 43758.5453); }
`;

// Opaque cut-outs: they write depth like the water around them, so they sort
// among themselves and the depth of field sees them where they are.
function landingMaterial(l: Landing, vertex: string, fragment: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: landingUniforms(l),
    vertexShader: `${LANDING_PRELUDE}\n${vertex}`,
    fragmentShader: `
      #include <common>
      uniform float uTime;
      uniform float uClock;
      // Inside where f is under the cut, to the pixel.
      float cut(float f, float at) { float aa = 0.5 * fwidth(f); return 1.0 - smoothstep(at - aa, at + aa, f); }
      ${fragment}`,
    transparent: true,
    depthWrite: true,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

// The colours, linear, out through the canvas's encoding. Opaque but for the
// one-pixel cut; what falls under half of it is not drawn at all.
const LANDING_OUT = `
  if (alpha < 0.5) discard;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
`;

// A quad instanced up to `count` times; the programs place each by
// gl_InstanceID, and `land` sets how many are out.
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

// Lumps of the boil thrown up along the line the sheet strikes: broad in the
// middle, small at the outside, the low splash at the curtain's foot. Each
// starts wholly under the water, so it comes out of the surface by its own
// motion (they once started inside the old crown and flashed out of it for a
// few frames, Tris 2026-10-06), and flies one ballistic flight (9.81 boil
// units/s^2, which the boil's clock makes real gravity) until it is wholly
// back under, the water hiding it as it goes in; then a pause before the
// next (they once shrank away mid-air). Drawn in the foam's flat tone, and
// only over the water they come out of.
function plumeMesh(l: Landing): THREE.Mesh {
  const material = landingMaterial(
    l,
    `
    varying vec2 vUV;
    varying float vSeed;
    varying float vPuff;
    varying vec2 vBody;
    ${ORGANIC_GLSL}
    void main() {
      float id = float(gl_InstanceID), r = rnd(id + 33.0), s = rnd(id + 71.0), b = rnd(id + 19.0);
      float theta = 6.28318 * b;
      vec3 vel = vec3(cos(theta) * (0.55 + r * 0.70) - 0.35, (1.05 + s * 0.80) * ${fmt(FOAM_HEIGHT)}, sin(theta) * (0.38 + r * 0.48));
      float size = (0.32 + r * 0.32) * ${fmt(Math.min(1, IMPACT_FOAM))};
      float z = (s * 2.0 - 1.0) * halfWidth();
      // Up from wholly under the water and back down until wholly under it.
      float sink = size * 0.5;
      float flight = 2.0 * vel.y / 9.81;
      float cycle = flight * (1.12 + 0.35 * rnd(id + 5.0));
      float age = fract(uClock / cycle + rnd(id + 9.0)) * cycle;
      vec3 center = vec3(-0.06 + strikeShift(z), -sink, z) + vec3(vel.x * age, vel.y * age - 4.905 * age * age, vel.z * age);
      float grow = step(age, flight);
      vec2 rot = vec2(cos(b * 6.3), sin(b * 6.3));
      vec2 p = vec2(position.x * rot.x - position.y * rot.y, position.x * rot.y + position.y * rot.x);
      vec3 at = toBody(center) + (viewRight() * p.x * 1.28 + viewUp() * p.y) * size * grow * uUnit;
      vUV = uv;
      vSeed = id;
      vPuff = age / flight;
      // Where the lump is, whole, for the clip.
      vBody = toBody(center).xz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(at, 1.0);
    }`,
    `
    uniform vec4 uClip;
    uniform vec3 uFoam;
    varying vec2 vUV;
    varying float vSeed;
    varying float vPuff;
    varying vec2 vBody;
    ${ORGANIC_GLSL}
    void main() {
      if (vBody.x < uClip.x || vBody.x > uClip.y || vBody.y < uClip.z || vBody.y > uClip.w) discard;
      vec2 q = vUV * 2.0 - 1.0;
      float a = atan(q.y, q.x);
      float n = paintNoise(q * 3.2 + vec2(vSeed * 0.71, -vPuff * 1.8));
      float r = length(q) + 0.10 * sin(a * 5.0 + vSeed) + 0.065 * sin(a * 9.0 - vPuff * 4.0);
      float alpha = cut(r + (n - 0.5) * 0.23, 0.74);
      vec3 col = uFoam;
      ${LANDING_OUT}
    }`,
  );
  return new THREE.Mesh(instancedQuads(PLUMES_MAX), material);
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
  // The lip's horizontal speed and how fast it is already falling there (m/s).
  v0: number;
  dive: number;
  depth: number;
  drop: number;
  zMid: number;
  halfW: number;
  slot: number;
  impact: THREE.Vector3;
  floor: { value: number };
  clip: THREE.Vector4;
  // The landing's scale (see BOIL_REACH), set by `land`, and its plumes,
  // whose count it sets.
  unit: { value: number };
  clock: { value: number };
  bend: { value: number };
  plumes: THREE.InstancedBufferGeometry | null;
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
  return out.set(f.xLip + f.side * f.v0 * t, f.yLip - arcDrop(f, t), f.zMid);
}

// How far the arc has fallen below the lip at time t.
function arcDrop(f: FallRecord, t: number): number {
  return f.dive * t + 0.5 * FALL_GRAVITY * t * t;
}

function land(f: FallRecord): void {
  f.root.updateWorldMatrix(true, false);
  const tMax = fallTime(f.dive, f.drop + f.depth + FALL_OVERSHOOT);
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
  const t = hit ? tHit : fallTime(f.dive, f.drop);
  // The sheet crosses the surface over a span of x - its bottom first, a
  // slice depth above its top - and the landing is the middle of it.
  const tBottom = fallTime(f.dive, arcDrop(f, t) - f.depth);
  f.impact.set(f.xLip + f.side * f.v0 * (t + tBottom) / 2, f.yLip - arcDrop(f, t), f.zMid);
  // The landing's scale (see BOIL_REACH): the impact speed, the boil's
  // length from the sheet's momentum per width, and how much air it takes in.
  const drop = f.yLip - f.impact.y;
  const vi = Math.sqrt(f.v0 * f.v0 + f.dive * f.dive + 2 * FALL_GRAVITY * Math.max(0, drop));
  const q = f.v0 * f.depth;
  const boil = Math.sqrt((q * vi) / FALL_GRAVITY);
  f.unit.value = boil / BOIL_REACH;
  f.clock.value = waterTime.value / Math.sqrt(f.unit.value);
  // Where a column leaving at k of the lip's velocity crosses the surface,
  // metres from the lip: the middle of where its slice's bottom and top go
  // in. The edges (k = 1 - EDGE_LAG) strike that much nearer the lip.
  const strike = (k: number): number => {
    const top = (-f.dive * k + Math.sqrt(f.dive * f.dive * k * k + 2 * FALL_GRAVITY * Math.max(0, drop))) / FALL_GRAVITY;
    const bottom = (-f.dive * k + Math.sqrt(f.dive * f.dive * k * k + 2 * FALL_GRAVITY * Math.max(0, drop - f.depth))) / FALL_GRAVITY;
    return (f.v0 * k * (top + bottom)) / 2;
  };
  f.bend.value = (strike(1) - strike(1 - EDGE_LAG)) / f.unit.value;
  const entrained = 2 * f.halfW * q * Math.max(0, vi - ENTRAIN_ONSET);
  if (f.plumes) f.plumes.instanceCount = Math.min(PLUMES_MAX, Math.round(PLUMES_PER * entrained));
  if (hit) {
    f.floor.value = scratchWorld.set(0, hit.top, 0).applyMatrix4(hit.root.matrixWorld).y - FALL_SINK;
    // The water's top in this body's frame, for the plumes.
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
    impactHow.value[f.slot]!.set(f.halfW / f.unit.value, Math.sign(dir.x) || 1, f.unit.value, 1 / Math.sqrt(f.unit.value));
    impactBend.value[f.slot] = f.bend.value;
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
  // Everything drawn: the surface, and a fall's plumes. For hiding the water
  // whole (the editor's "water" toggle, `BodyVisual.setWaterShown`).
  objects: THREE.Object3D[];
  // A pool's surface, for its mirror; null for a current.
  still: StillSurface | null;
  // The surface the ball's splash and wake are drawn on (stillWater.ts),
  // pool or current; null for a shape the look is not built for, and for a
  // turned current (its foam is kept drifting along the world's x).
  foam: FoamSurface | null;
  // Forget this water's registrations (its top, its fall): call at dispose.
  release: () => void;
}

// Build a water body's look under `root` (the BodyVisual's group, which carries
// the body's pose). Rects only - every authored water body is one, and the 2D
// overlay's streak glyphs remain the fallback for anything else.
//
// Everything it reads is on the body: the physics (flow, drag), the SPILL
// (`spill`, the drop off the downstream end; how fast it leaves the lip
// follows from the current, see `brinkOf`),
// the slab through z (`waterZ`, `waterDepth`) and the tint (`color`). Water is
// drawn by the game rather than by the level's Blender scene, because the
// current moves its surface every frame (plans/blender-owns-appearance.md).
export function buildWater(root: THREE.Group, body: WaterArea, data: LevelBodyData): WaterBuild {
  const shape = body.primaryShape();
  const s = shape.shape;
  if (s.kind !== "circle" && s.kind !== "rect") {
    return { geometries: [], materials: [], objects: [], still: null, foam: null, release: () => {} };
  }
  const halfX = s.kind === "rect" ? s.size.x / 2 : s.radius;
  const halfY = s.kind === "rect" ? s.size.y / 2 : s.radius;
  // The slab through z, in the extruder's convention: depth centred on the
  // plane, shifted by `z`.
  const depth = data.waterDepth ?? DEFAULT_WATER_DEPTH;
  const frontZ = (data.waterZ ?? 0) + depth / 2;
  const backZ = frontZ - depth;
  // The spill: off the end the flow points at. A run with no current spills
  // off its +x end.
  const drop = data.spill ?? 0;
  const spill: SpillSpec | null =
    drop > 0
      ? {
          side: body.flow < 0 ? -1 : 1,
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
    const still: StillSurface = {
      body,
      halfX,
      halfY,
      backZ,
      frontZ,
      drift: 0,
      mesh,
      reflect: pool.reflect,
      openBehind: pool.openBehind,
      footprint: pool.footprint,
      color,
      scenery: [],
    };
    return {
      geometries: [geometry],
      materials: [pool.material],
      objects: [mesh],
      still,
      foam: still,
      release: () => surfaces.delete(surface),
    };
  }

  const front = frontZ - FRONT_INSET;
  const built = currentGeometry(halfX, halfY, front, backZ, body.flow, spill);
  const floor = { value: -1e9 };
  // As `currentGeometry` reads them.
  const side = spill ? spill.side : body.flow < 0 ? -1 : 1;
  const look: CurrentLook = {
    color,
    side,
    runSpeed: Math.max(Math.abs(body.flow), 0.05),
    lipS: built.lip ? built.lip.s : null,
    runEnd: built.lip ? built.lip.s : (halfX * 2) / S,
    drop: spill ? spill.drop : 0,
    floor,
    upstream: -side * halfX,
    top: halfY,
  };
  const mat = currentMaterial(look);
  const mesh = new THREE.Mesh(built.geometry, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 10;
  root.add(mesh);
  geometries.push(built.geometry);
  materials.push(mat);
  const objects: THREE.Object3D[] = [mesh];

  let fall: FallRecord | null = null;
  if (spill && built.lip) {
    fall = {
      root,
      xLip: built.lip.x,
      yLip: built.lip.y,
      side: spill.side,
      v0: built.lip.speed,
      dive: built.lip.dive,
      depth: built.lip.depth,
      drop: spill.drop,
      zMid: (front + backZ) / 2,
      halfW: (front - backZ) / 2,
      slot: takeImpactSlot(),
      impact: new THREE.Vector3(),
      floor,
      clip: new THREE.Vector4(),
      unit: { value: S },
      clock: { value: 0 },
      bend: { value: 0 },
      plumes: null,
    };
    falls.add(fall);
    land(fall);
    const landing: Landing = {
      impact: fall.impact,
      side: spill.side,
      clip: fall.clip,
      foam: foamColor(studyPalette(color).light),
      unit: fall.unit,
      clock: fall.clock,
      halfWidth: { value: fall.halfW },
      bend: fall.bend,
    };
    // Drawn after the water. Always in the scene and never culled (each is
    // placed in its vertex shader), so the prewarm compiles it.
    const plumes = plumeMesh(landing);
    fall.plumes = plumes.geometry as THREE.InstancedBufferGeometry;
    land(fall);
    plumes.frustumCulled = false;
    plumes.renderOrder = 11;
    root.add(plumes);
    geometries.push(plumes.geometry);
    materials.push(plumes.material as THREE.Material);
    objects.push(plumes);
  }
  return {
    geometries,
    materials,
    objects,
    still: null,
    // Drifting at the shader's own speed (see `vFoam`). A turned current
    // would carry its foam off the world's x, which the foam's frame cannot
    // hold; no level has one.
    foam:
      body.globalRotation === 0
        ? { body, halfX, halfY, backZ, frontZ, drift: look.side * look.runSpeed }
        : null,
    release: () => {
      surfaces.delete(surface);
      if (fall) {
        falls.delete(fall);
        freeImpactSlot(fall.slot);
      }
    },
  };
}
