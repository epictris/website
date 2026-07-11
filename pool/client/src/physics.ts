// Deterministic 2D pool physics.
//
// The engine is intentionally deterministic: fixed timestep, no Math.random,
// fixed iteration order. Given the same starting state and the same shot, both
// players (and a replay) reach byte-for-byte identical rest positions. That is
// what lets us sync multiplayer by only sending shot parameters, and lets a
// replay be nothing more than a rack + an ordered list of shots.
//
// Physics model (SI units, metres / seconds):
//  - Each ball has linear velocity v and angular velocity w = (x, y, z).
//    w.x / w.y are horizontal spin axes -> rolling, follow, draw.
//    w.z is the vertical axis -> side spin ("English").
//  - The contact patch where the ball meets the cloth has a slip velocity
//    u = v + w x r  (r points straight down). While |u| > 0 the ball SLIDES and
//    kinetic friction acts on both v and w, which is exactly what turns a
//    struck ball into a rolling one and produces draw / follow / stun.
//  - Once |u| ~ 0 the ball ROLLS and only rolling resistance slows it.
//  - Side spin does NOT curve a ball on a level table (u is independent of w.z),
//    which is physically correct: English only shows up on cushion and ball
//    contact. That is modelled in the collision code below.

export type Vec = { x: number; y: number };
export type Spin = { x: number; y: number; z: number };

// Row-major 3x3 orientation matrix (world = M · body). Purely cosmetic — it
// tracks how far a ball has physically rolled/spun so the renderer can draw its
// surface markings turning. It is NOT part of the synced/deterministic state
// (positions are), so it may be absent; treat a missing `o` as the identity.
export type Mat3 = [number, number, number, number, number, number, number, number, number];
export const IDENT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export type Ball = {
  id: number; // 0 = cue, 1..7 solids, 8 = eight, 9..15 stripes
  p: Vec;
  v: Vec;
  w: Spin;
  potted: boolean;
  o?: Mat3; // surface orientation (cosmetic; identity if absent)
  dropV?: Vec; // velocity the instant it was potted (cosmetic; drives the sink anim)
};

export type World = {
  balls: Ball[];
};

// --- Cross-engine determinism ----------------------------------------------
// IEEE-754 mandates correctly-rounded results ONLY for + - * / and sqrt, so
// those are bit-for-bit identical on every JS engine. The libm transcendentals
// (Math.sin / Math.cos / Math.hypot / …) are NOT specified to the last bit and
// diverge between V8 (Android/Chrome) and JavaScriptCore (iOS/Safari). A single
// such call feeding the synced state drifts the two clients apart over a shot,
// which compounds into a visible desync. So every trig / magnitude value on the
// deterministic path below is built from ONLY the correctly-rounded ops.

const TWO_PI = 6.283185307179586; // 2π  (nearest double)
const HALF_PI = 1.5707963267948966; // π/2
const SQRT3_2 = Math.sqrt(3) / 2; // sin(π/3) via deterministic sqrt

/** √(x²+y²) without Math.hypot (which is implementation-defined). */
const hyp = (x: number, y: number) => Math.sqrt(x * x + y * y);

// sin / cos on [0, π/2] via a fixed Taylor series — pure +,-,*, so bit-identical
// across engines. 6 terms => error < 1e-7 over the range, far under any
// gameplay tolerance.
function sinCore(x: number): number {
  const x2 = x * x;
  return (
    x *
    (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 - (x2 * 1) / 39916800)))))
  );
}
function cosCore(x: number): number {
  const x2 = x * x;
  return 1 + x2 * (-1 / 2 + x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320 - (x2 * 1) / 3628800))));
}
/**
 * Deterministic { sin, cos } of any angle. Range-reduce to a quadrant, evaluate
 * the [0, π/2] cores, then fix the sign/swap. Drop-in for Math.sin/Math.cos on
 * the synced path so both clients agree to the bit.
 */
function dsincos(a: number): { s: number; c: number } {
  a = a - TWO_PI * Math.floor(a / TWO_PI); // -> [0, 2π)
  const q = Math.floor(a / HALF_PI) & 3; // quadrant 0..3
  const r = a - q * HALF_PI; // -> [0, π/2)
  const s = sinCore(r);
  const c = cosCore(r);
  if (q === 0) return { s, c };
  if (q === 1) return { s: c, c: -s };
  if (q === 2) return { s: -s, c: -c };
  return { s: -c, c: s };
}

// --- Table geometry ---------------------------------------------------------
// The WORLD UNIT IS THE MILLIMETRE. Every length/position/velocity below is in
// mm (or mm/s, mm/s²). feltWidth/feltHeight are the real playing-surface sizes of
// each table (7ft bar-box pool, 12ft snooker), so a ball, a pocket, and the felt
// are all their true physical size. Origin at the cloth corner. Overwritten per
// variant by setVariant(); defaults are pool.
export const TABLE = { w: 1981, h: 991 };
// Ball radius (world mm). Pool uses a 2.25" bar-box ball; snooker balls are
// smaller relative to the (much bigger) 12ft bed, matching a real snooker table.
// It's a live binding, not a const, so both clients pick the SAME value from the
// shared variant before any shot — determinism holds. CUSHION_SEGS / POCKET_LIST
// don't embed R (the cushion inset + ball-ball test read it at runtime), so
// switching it needs no geometry rebuild. Call setVariant(variant) at startup.
export let R = 28.575; // 2.25" pool ball (57.15mm diameter)

// Per-variant table + pocket geometry — the WHOLE collision table is derived from
// these few numbers. The cushion noses sit on the felt-box edge, so the playfield
// simply IS feltWidth × feltHeight (no separate rail inset). Each pocket is given
// only its mouth: throat width (between the two jaw tips), throat depth, and pot-
// circle radius — separately for corners and sides — plus one shared jaw fillet
// radius and the sink-funnel segment counts.
//
// Everything else the old struct spelled out is SOLVED here, not stored:
//   • each jaw is a circular arc of radius `cornerRadius` tangent to its rail and
//     passing through its throat tip — the tangency point IS the nose start (the
//     old LC / SC / sideHalf), so the mouth blends smoothly into the rail;
//   • each pot circle is receded until it passes through that pocket's two jaw
//     tips, so a ball squeezing the throat is exactly at the drop threshold (the
//     old cornerPush / sidePush).
// All lengths in world MILLIMETRES.
type CushionGeo = {
  feltWidth: number; // playfield (cushion-nose rectangle) width, mm — real table size
  feltHeight: number; // playfield height, mm
  cornerThroat: number; // corner mouth width, between the two jaw NOSES (the front, across the corner)
  cornerThroatTaper: number; // -1..1 wall splay: 0 = parallel walls (snooker), >0 = mouth wider than the back (pool), <0 = pinched
  cornerDepth: number; // corner throat depth, along the corner diagonal
  cornerRadius: number; // fillet radius rounding where each throat wall meets the rail (nose)
  cornerHole: number; // corner pot-circle radius
  cornerSegs: number; // segments the corner nose fillet is sampled into
  sideThroat: number; // side mouth width, between the two jaw NOSES (the front, along the rail)
  sideThroatTaper: number; // -1..1 wall splay (0 = parallel)
  sideDepth: number; // side throat depth, perpendicular into the felt
  sideHole: number; // side pot-circle radius
  sideSegs: number; // segments the side nose fillet is sampled into
};
const GEO: Record<"pool" | "snooker", CushionGeo> = {
  // 7ft bar-box pool: 78" × 39" playing surface = 1981 × 991 mm. Pool throats
  // taper — the walls splay open toward the mouth.
  pool: {
    feltWidth: 1981, feltHeight: 991,
    cornerThroat: 88, cornerThroatTaper: 0.1, cornerDepth: 20, cornerRadius: 5, cornerHole: 59.4, cornerSegs: 4,
    sideThroat: 95, sideThroatTaper: 0.3, sideDepth: 50, sideHole: 59.4, sideSegs: 4,
  },
  // 12ft full-size snooker: 3569 × 1778 mm playing surface. Snooker throats are
  // parallel-walled — taper 0.
  snooker: {
    feltWidth: 3569, feltHeight: 1778,
    cornerThroat: 89.2, cornerThroatTaper: 0, cornerDepth: 70, cornerRadius: 57.1, cornerHole: 89.2, cornerSegs: 6,
    sideThroat: 108, sideThroatTaper: 0, sideDepth: 55, sideHole: 53.5, sideSegs: 6,
  },
};
let geo: CushionGeo = GEO.pool;

// The live per-variant geometry, so render-side helpers (e.g. the sink-hole
// polygon) can derive their shapes from the SAME numbers the collision uses,
// rather than hard-coding points that drift when the params are tuned.
export function currentGeo(): CushionGeo {
  return geo;
}

// The geometry for a specific variant (not necessarily the active one) — the
// renderer uses feltWidth/feltHeight to derive that photo's felt pixel box from
// its mm-per-pixel scale.
export function geoFor(variant: "pool" | "snooker"): CushionGeo {
  return GEO[variant];
}

// Select ball size + table/pocket geometry for a variant. A live binding, not a
// const, so both clients pick the SAME geometry from the shared variant before any
// shot — determinism holds. Rebuilds the felt box, cushion polygon + pocket list.
export function setVariant(variant: "pool" | "snooker") {
  geo = GEO[variant];
  TABLE.w = geo.feltWidth;
  TABLE.h = geo.feltHeight;
  // Real ball radii (mm): snooker 52.5 mm diameter (26.25 mm), pool 2.25"
  // (57.15 mm diameter, 28.575 mm) — their true sizes on the real-sized beds.
  R = variant === "snooker" ? 26.25 : 28.575;
  POCKETS = buildPockets(geo);
  POCKET_LIST = buildPocketList(geo);
  const c = buildCushionSegs(geo);
  CUSHION_SEGS = c.segs;
  CUSHION_VERTS = buildCushionVerts(c.segs, c.arcs, c.skip);
}

// The cushion noses sit ON the felt-box edge — the playfield is exactly
// feltWidth × feltHeight, so there is no inset knob. Kept as an export (== 0) for
// call-sites that clamp a ball onto the cloth (its centre stays R off the nose).
export let RAIL_INSET = 0;

// Pocket centres: 4 corners + 2 sides (mid-rail), at the felt-box corners/edges.
function buildPockets(g: CushionGeo): Vec[] {
  const w = g.feltWidth;
  const h = g.feltHeight;
  return [
    { x: 0, y: 0 }, { x: w / 2, y: 0 }, { x: w, y: 0 },
    { x: 0, y: h }, { x: w / 2, y: h }, { x: w, y: h },
  ];
}
export let POCKETS: Vec[] = buildPockets(geo);

// The pocket hole is ONE circle used for both the pot test and the drawn hole, so
// the visual always matches the collision. Radius = cornerHole/sideHole; how far
// its centre sits past the mouth is set by the DEPTH param alone (cornerDepth for
// corners, sideDepth for sides) — INDEPENDENT of throat width and hole radius, so
// tuning a throat or a hole size never moves the hole centre.
export type Pocket = { center: Vec; hole: number };
function buildPocketList(g: CushionGeo): Pocket[] {
  const w = g.feltWidth;
  const h = g.feltHeight;
  return buildPockets(g).map((pk) => {
    const ox = pk.x === 0 ? -1 : pk.x >= w - 1e-6 ? 1 : 0;
    const oy = pk.y === 0 ? -1 : pk.y >= h - 1e-6 ? 1 : 0;
    if (ox === 0) {
      // Side pocket: centre sits sideDepth straight out through the rail (oy = ±1).
      return { center: { x: pk.x, y: pk.y + oy * g.sideDepth }, hole: g.sideHole };
    }
    // Corner pocket: centre sits cornerDepth out along the diagonal past the corner.
    const d = g.cornerDepth * Math.SQRT1_2;
    return { center: { x: pk.x + ox * d, y: pk.y + oy * d }, hole: g.cornerHole };
  });
}
export let POCKET_LIST: Pocket[] = buildPocketList(geo);
// Hard outer walls sit this far beyond the felt edge — a ball that enters a
// mouth but misses the hole rattles back instead of escaping off the table.
export const POCKET_DEPTH = 55;

// One straight run of the cushion polygon on the FELT contact surface, with its
// inward unit normal (toward the playfield) and unit tangent. Collision insets
// the face by R on the fly (a ball touches the felt when its centre is R away),
// so these are the drawn cushions too — debug view == physics, exactly.
export type CushionSeg = {
  a: Vec; // felt endpoint (world units)
  b: Vec;
  nx: number; // inward unit normal
  ny: number;
  tx: number; // unit tangent (a -> b)
  ty: number;
  len: number;
};

// A convex corner of the cushion polygon (a nose/jaw tip, or the mouth corner
// where two faces meet pointing into the playfield). The swept collision rounds
// it: the ball rebounds off the vertex as a point-circle of radius R, so it
// deflects off the corner at whatever angle it arrives — not off a fudged flat
// miter. `n1`/`n2` bound the playfield-facing arc of valid contact normals (the
// two adjacent faces' inward normals); a `lone` tip accepts the whole front
// half-plane. Contacts outside the arc are handled by the flat faces instead.
export type CushionVert = {
  x: number; // circle centre (a plain tip/corner is a point: r = 0)
  y: number;
  n1x: number;
  n1y: number;
  n2x: number;
  n2y: number;
  lone: boolean; // exposed tip (one adjoining face) vs 2-face convex corner
  r: number; // collider radius: 0 = point vertex; > 0 = a fillet ARC of this radius
};

// A fillet arc: a circular collider of radius `r` centred at (cx,cy), spanning
// from tangent (ax,ay) on the rail to (bx,by) on the wall. The ball rebounds off
// its convex (playfield) side — a TRUE arc, not sampled into flats. Stored as a
// CushionVert with r > 0 (the swept vertex test rides a circle of radius r + R).
type CushionArc = { cx: number; cy: number; r: number; ax: number; ay: number; bx: number; by: number };

// The cushion outline for the TOP-LEFT quadrant — the top rail's left half, its
// corner throat, one side-pocket facing, and the left rail — mirrored across both
// mid-lines into all four quadrants. Faces are the felt contact surface (a nose
// sits on the felt-box edge; collision insets by R on the fly, so drawn ==
// physics). Each pocket throat is two STRAIGHT walls running from the jaw tips out
// to the rails, splayed by `*ThroatTaper` (0 = parallel), with a `cornerRadius`
// fillet rounding each nose — so the whole mouth is derived from throat / taper /
// depth / radius, nothing is hand-placed.
function buildCushionSegs(
  g: CushionGeo,
): { segs: CushionSeg[]; arcs: CushionArc[]; skip: Set<string> } {
  const w = g.feltWidth;
  const h = g.feltHeight;
  const P = (x: number, y: number): Vec => ({ x, y });
  const RR = g.cornerRadius;

  const clampT = (t: number) => Math.max(-1, Math.min(1, t));
  // Trim a wall N->T at the pot circle (centre C, radius r): if the wall crosses
  // into the circle, return the entry point (a ball past it is already potted, so
  // the collider — and its debug line — stops at the circle); else return T.
  const clipToCircle = (N: Vec, T: Vec, C: Vec, r: number): Vec => {
    const dx = T.x - N.x;
    const dy = T.y - N.y;
    const a = dx * dx + dy * dy;
    if (a < 1e-12) return T;
    const fx = N.x - C.x;
    const fy = N.y - C.y;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return T;
    const t = (-b - Math.sqrt(disc)) / (2 * a); // near (entering) intersection
    return t > 0 && t < 1 ? { x: N.x + dx * t, y: N.y + dy * t } : T;
  };

  // --- Corner (top-left): throat = the gap between the jaw NOSES (the mouth/front),
  // measured across the corner; the tips (deep end) derive from depth + taper. ---
  const aN = g.cornerThroat * Math.SQRT1_2; // nose in-distance along each rail (noses cornerThroat apart across the mouth)
  const N_top = P(aN, 0); // top-rail nose (mouth front)
  const N_left = P(0, aN); // left-rail nose
  // Tip: run cornerDepth into the pocket along the diagonal (∥ the walls at taper 0),
  // then shift toward the diagonal to narrow the BACK — taper 0 = parallel walls,
  // >0 = mouth wider than the throat (pool), <0 = pinched. |taper| 1 ≈ 45° walls.
  // Finally trim the tip to the pot circle so the wall never runs on past the hole.
  const axd = g.cornerDepth * Math.SQRT1_2; // per-axis diagonal run to the throat
  const cShift = clampT(g.cornerThroatTaper) * axd * Math.SQRT1_2; // perp shift toward the diagonal
  const cCenter = P(-axd, -axd); // corner pot-circle centre (cornerDepth out along the diagonal)
  const T_top = clipToCircle(N_top, P(aN - axd - cShift, -axd + cShift), cCenter, g.cornerHole);
  const T_left = P(T_top.y, T_top.x); // corner is symmetric across x = y
  // Interior reference for the corner walls: the mouth centre between the two
  // noses. A wall runs toward the corner diagonal, so the table-centre heuristic
  // is degenerate; pointing both wall normals here makes them face EACH OTHER.
  const cornerMouth = P(aN / 2, aN / 2);

  // --- Side (top rail centre, x = w/2): throat = the gap between the jaw NOSES on
  // the rail; the tips (deep end) derive from sideDepth + taper. ---
  const sHalf = g.sideThroat / 2;
  const N_sL = P(w / 2 - sHalf, 0); // left nose (mouth front)
  // Parallel wall is vertical (tip directly below the nose); taper slides the TIP
  // inward (toward the mouth centre) to narrow the back. |taper| 1 ≈ a 45° wall.
  // Trimmed to the pot circle so the wall stops at the hole, not past it.
  const T_sL = clipToCircle(
    N_sL,
    P(N_sL.x + clampT(g.sideThroatTaper) * g.sideDepth, -g.sideDepth),
    P(w / 2, -g.sideDepth),
    g.sideHole,
  );

  type Seg = { a: Vec; b: Vec; ref?: Vec };
  // A straight throat facing from the nose N (on a rail) out to the jaw tip T,
  // plus a cornerRadius fillet ARC rounding the nose where the wall meets the
  // rail. `railOut` is the unit rail direction AWAY from the pocket (the plain
  // rail continues that way); `into` is a playfield-side point that picks the
  // material side for the fillet centre. Returns the wall segment, the point the
  // plain rail should stop at (`railEnd`, the fillet's rail tangent), and the
  // fillet arc — a TRUE circular collider, not sampled. The tip T stays a sharp
  // vert (rounded by R). `ref` orients the wall's inward normal.
  const throatWall = (
    T: Vec, N: Vec, railOut: Vec, into: Vec, ref?: Vec,
  ): { seg: Seg; railEnd: Vec; arc: CushionArc | null } => {
    let wx = T.x - N.x;
    let wy = T.y - N.y;
    const wl = hyp(wx, wy) || 1e-9;
    wx /= wl;
    wy /= wl; // unit nose -> tip
    const dot = Math.max(-1, Math.min(1, railOut.x * wx + railOut.y * wy));
    const theta = Math.acos(dot); // interior angle at the nose (rail vs wall)
    if (RR > 1e-6 && theta > 1e-3 && theta < Math.PI - 1e-3) {
      // Tangent distance from the nose along each edge. If the full-radius fillet
      // would overrun the (short) wall, SHRINK the radius so it still fits AND
      // stays tangent — clamping `d` alone would leave the radius too big for that
      // distance, tilting the tangent off the rail (a kink + preview jump at the
      // arc↔rail handoff).
      const tan2 = Math.tan(theta / 2);
      let rad = RR;
      let d = rad / tan2;
      const dmax = wl * 0.9;
      if (d > dmax) {
        d = dmax;
        rad = d * tan2;
      }
      const A = P(N.x + railOut.x * d, N.y + railOut.y * d); // rail tangent
      const B = P(N.x + wx * d, N.y + wy * d); // wall tangent
      // Fillet centre: along the nose bisector, rad/sin(θ/2) from N, on the MATERIAL
      // side (opposite `into`), so the arc bulges toward the playfield.
      let bx = railOut.x + wx;
      let by = railOut.y + wy;
      const bl = hyp(bx, by) || 1e-9;
      bx /= bl;
      by /= bl;
      const m = rad / Math.sin(theta / 2);
      const sgn = (into.x - N.x) * bx + (into.y - N.y) * by > 0 ? -1 : 1;
      const C = P(N.x + sgn * m * bx, N.y + sgn * m * by);
      return {
        seg: { a: B, b: T, ref },
        railEnd: A,
        arc: { cx: C.x, cy: C.y, r: rad, ax: A.x, ay: A.y, bx: B.x, by: B.y },
      };
    }
    return { seg: { a: N, b: T, ref }, railEnd: N, arc: null }; // no fillet (sharp nose)
  };

  // Top-left quadrant felt segments (contact surface, world coords). Each pocket
  // gets two straight throat walls, each rounded at the nose by a fillet arc.
  const topW = throatWall(T_top, N_top, P(1, 0), cornerMouth, cornerMouth);
  const leftW = throatWall(T_left, N_left, P(0, 1), cornerMouth, cornerMouth);
  const sideW = throatWall(T_sL, N_sL, P(-1, 0), P(w / 2, h / 2));
  const base: Seg[] = [
    { a: topW.railEnd, b: sideW.railEnd }, // top rail: corner nose -> side-pocket nose
    sideW.seg, // side-pocket left facing
    topW.seg, // top-rail corner facing
    { a: leftW.railEnd, b: P(0, h - leftW.railEnd.y) }, // left rail (full height, mirrored)
    leftW.seg, // left-rail corner facing
  ];
  const baseArcs = [topW.arc, leftW.arc, sideW.arc].filter((a): a is CushionArc => a !== null);

  const mref = (r: Vec | undefined, fx: (v: Vec) => Vec) => (r ? fx(r) : undefined);
  const mx = (s: Seg): Seg => {
    const f = (v: Vec) => P(w - v.x, v.y);
    return { a: f(s.a), b: f(s.b), ref: mref(s.ref, f) };
  };
  const my = (s: Seg): Seg => {
    const f = (v: Vec) => P(v.x, h - v.y);
    return { a: f(s.a), b: f(s.b), ref: mref(s.ref, f) };
  };
  // Mirror the quadrant into all four; dedupe the segments that lie on a mid-line.
  const felt: Seg[] = [];
  const seen = new Set<string>();
  const add = (s: Seg) => {
    // Canonical (order-independent) key: a full-height rail crosses the mid-line,
    // so its mirror is the SAME face with endpoints reversed. Dedupe it, else the
    // duplicate turns each corner into a 3-way junction the miter below skips.
    const [p, q] = [s.a, s.b].sort((u, v) => u.x - v.x || u.y - v.y);
    const k = [p.x, p.y, q.x, q.y].map((n) => n.toFixed(4)).join();
    if (!seen.has(k)) (seen.add(k), felt.push(s));
  };
  for (const s of base) [s, mx(s), my(s), mx(my(s))].forEach(add);

  // Mirror the fillet arcs the same way (no dedupe — none lie on a mid-line).
  const mxA = (a: CushionArc): CushionArc => ({ cx: w - a.cx, cy: a.cy, r: a.r, ax: w - a.ax, ay: a.ay, bx: w - a.bx, by: a.by });
  const myA = (a: CushionArc): CushionArc => ({ cx: a.cx, cy: h - a.cy, r: a.r, ax: a.ax, ay: h - a.ay, bx: a.bx, by: h - a.by });
  const arcs: CushionArc[] = [];
  for (const a of baseArcs) [a, mxA(a), myA(a), mxA(myA(a))].forEach((x) => arcs.push(x));
  // Each arc's rail/wall tangents are covered by the arc, so they must NOT also
  // spawn a point-vert (that would put a spurious R-bump at the fillet's ends).
  const skip = new Set<string>();
  for (const a of arcs) {
    skip.add(`${a.ax.toFixed(4)},${a.ay.toFixed(4)}`);
    skip.add(`${a.bx.toFixed(4)},${a.by.toFixed(4)}`);
  }

  // Orient each felt segment's inward normal toward the playfield. No inset and
  // no miter: the faces stay on the true felt surface (so debug == physics), and
  // collision insets by R on the fly. Convex corners are closed by CUSHION_VERTS
  // (point-circles for tips, fillet arcs at the noses).
  const segs = felt.map(({ a, b, ref }) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = hyp(dx, dy) || 1e-9;
    const tx = dx / len;
    const ty = dy / len;
    let nx = -ty;
    let ny = tx;
    // Point the normal toward the interior reference (a wall's throat centre, or
    // the table centre for a plain rail) so it faces the playfield.
    const rx = ref ? ref.x : w / 2;
    const ry = ref ? ref.y : h / 2;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (nx * (rx - mid.x) + ny * (ry - mid.y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { a, b, nx, ny, tx, ty, len };
  });
  return { segs, arcs, skip };
}
const _cushion = buildCushionSegs(geo);
export let CUSHION_SEGS: CushionSeg[] = _cushion.segs;

// Collect the convex corners of the cushion polygon. A ball's centre rounds
// these as circles of radius R, which is what lets it rebound off a nose/jaw tip
// at any incoming angle. Two kinds: exposed TIPS (one adjoining face — the free
// end of a nose/jaw/facing at a pocket mouth) and 2-face CONVEX corners (two
// faces meeting so the cushion protrudes into the playfield). Concave junctions
// and straight rail splits are skipped: there the flat faces already meet the
// ball first, and a vertex circle would fire spuriously.
function buildCushionVerts(
  segs: CushionSeg[],
  arcs: CushionArc[],
  skip: Set<string>,
): CushionVert[] {
  const key = (x: number, y: number) => `${x.toFixed(4)},${y.toFixed(4)}`;
  type Edge = { far: Vec; nx: number; ny: number };
  const at = new Map<string, { v: Vec; edges: Edge[] }>();
  for (const s of segs) {
    for (const [end, far] of [
      [s.a, s.b],
      [s.b, s.a],
    ] as const) {
      const k = key(end.x, end.y);
      let e = at.get(k);
      if (!e) at.set(k, (e = { v: end, edges: [] }));
      e.edges.push({ far, nx: s.nx, ny: s.ny });
    }
  }

  const verts: CushionVert[] = [];
  for (const { v, edges } of at.values()) {
    // A fillet arc's rail/wall tangents are covered by the arc — skip them, else
    // a spurious point-circle bumps out of the fillet ends.
    if (skip.has(key(v.x, v.y))) continue;
    if (edges.length === 1) {
      const e = edges[0];
      verts.push({ x: v.x, y: v.y, n1x: e.nx, n1y: e.ny, n2x: e.nx, n2y: e.ny, lone: true, r: 0 });
    } else if (edges.length === 2) {
      const [e1, e2] = edges;
      // Convex if the average inward normal points OPPOSITE the wedge between the
      // two faces (the cushion material is behind the vertex, playfield in front).
      const gx = e1.nx + e2.nx;
      const gy = e1.ny + e2.ny;
      const u = unit(e1.far.x - v.x, e1.far.y - v.y);
      const wv = unit(e2.far.x - v.x, e2.far.y - v.y);
      const mxx = u.x + wv.x;
      const myy = u.y + wv.y;
      if (gx * mxx + gy * myy < -1e-9) {
        verts.push({ x: v.x, y: v.y, n1x: e1.nx, n1y: e1.ny, n2x: e2.nx, n2y: e2.ny, lone: false, r: 0 });
      }
    }
    // >2 faces (T-junction): leave to the flat faces.
  }

  // The fillet arcs: each is a fat vertex — a circle of radius r whose wedge is
  // bounded by the two tangent normals (rail-facing n1, wall-facing n2). The
  // swept vertex test rides a circle of radius r + R off the centre.
  for (const a of arcs) {
    const n1 = unit(a.ax - a.cx, a.ay - a.cy);
    const n2 = unit(a.bx - a.cx, a.by - a.cy);
    verts.push({ x: a.cx, y: a.cy, n1x: n1.x, n1y: n1.y, n2x: n2.x, n2y: n2.y, lone: false, r: a.r });
  }
  return verts;
}
function unit(x: number, y: number): Vec {
  const l = hyp(x, y) || 1e-9;
  return { x: x / l, y: y / l };
}
export let CUSHION_VERTS: CushionVert[] = buildCushionVerts(_cushion.segs, _cushion.arcs, _cushion.skip);

// Is a contact normal `(dx,dy)` (vertex -> ball) inside a corner's playfield arc?
// For a lone tip, the whole front half-plane. For a 2-face corner, the wedge
// between the two faces' inward normals — anything outside it belongs to a flat
// face, which resolves it instead.
function vertNormalOk(dx: number, dy: number, vt: CushionVert): boolean {
  if (vt.lone) return dx * vt.n1x + dy * vt.n1y > 0;
  const c = vt.n1x * vt.n2y - vt.n1y * vt.n2x; // cross(n1, n2)
  if (Math.abs(c) < 1e-9) return dx * vt.n1x + dy * vt.n1y > 0;
  const c1 = vt.n1x * dy - vt.n1y * dx; // cross(n1, d)
  const c2 = dx * vt.n2y - dy * vt.n2x; // cross(d, n2)
  return c1 * c >= 0 && c2 * c >= 0;
}


// --- Physical constants -----------------------------------------------------
const G = 9800; // gravity, mm/s² (world unit is the millimetre)
// ---- Configurable physics -------------------------------------------------
// Each parameter is one distinct, real, separately-measurable physical
// coefficient — no two unrelated mechanisms share a knob. Defaults are measured
// snooker values (Marlow, "The Physics of Pocket Billiards"; Alciatore,
// billiards.colostate.edu; snooker-cloth/ball measurements), not tuned numbers.
export type PhysicsConfig = {
  clothFriction: number; // ball–cloth kinetic (sliding) friction   μ_s
  rollingResistance: number; // cloth hysteresis / rolling resistance   μ_r
  cushionFriction: number; // ball–rail (rubber) friction             μ_c
  cushionRestitution: number; // rail coefficient of restitution        e_c
  ballFriction: number; // ball–ball sliding friction (throw)      μ_bb
  ballRestitution: number; // ball–ball coefficient of restitution    e_b
};

// The one DERIVED quantity (not a free number): vertical-axis "drilling"
// friction that decays side spin. It is not a separate coefficient — it is the
// SAME cloth friction μ_s acting over the ball's contact patch, so it equals
// μ_s scaled by a fixed contact-patch geometry factor (~ a/R for a soft cloth).
const CONTACT_PATCH = 0.11; // contact-patch geometry factor (dimensionless)

// Pool: worsted (napless) cloth like Simonis — slick, so a low rolling
// resistance and a long roll — with lively K-66 pool-rail rubber and Aramith
// phenolic balls.
export const DEFAULT_CONFIG: PhysicsConfig = {
  clothFriction: 0.2, // ball–cloth sliding friction (~0.18–0.22)
  rollingResistance: 0.006, // slick worsted cloth rolls far (~0.005–0.008)
  cushionFriction: 0.2, // ball on cushion rubber (~0.14–0.25)
  cushionRestitution: 0.85, // lively pool cushion COR (~0.8–0.9)
  ballFriction: 0.06, // ball–ball friction (~0.03–0.08)
  ballRestitution: 0.95, // Aramith pool ball COR (~0.92–0.96)
};

// Snooker: napped wool baize (Strachan/Hainsworth) plays "heavier" — the nap
// adds rolling drag and a grippier slide — with snooker L-cushions that rebound
// noticeably deader than pool rails, and lighter phenolic snooker balls.
export const SNOOKER_CONFIG: PhysicsConfig = {
  clothFriction: 0.22, // napped baize grips the slide a touch more
  rollingResistance: 0.014, // the nap drags a rolling ball — a slower bed
  cushionFriction: 0.22,
  cushionRestitution: 0.72, // snooker cushions are deader (~0.7–0.8)
  ballFriction: 0.05,
  ballRestitution: 0.94, // phenolic snooker ball COR (~0.92–0.96)
};

/** The measured cloth/cushion/ball constants for a variant. */
export function configFor(variant: "pool" | "snooker"): PhysicsConfig {
  return variant === "snooker" ? { ...SNOOKER_CONFIG } : { ...DEFAULT_CONFIG };
}

// Slider metadata for the UI: label, range, step per configurable parameter.
export const PARAMS: {
  key: keyof PhysicsConfig;
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: "clothFriction", label: "cloth friction μs", min: 0.02, max: 0.5, step: 0.005 },
  { key: "rollingResistance", label: "rolling resistance μr", min: 0.001, max: 0.04, step: 0.001 },
  { key: "cushionFriction", label: "cushion friction μc", min: 0.02, max: 0.5, step: 0.005 },
  { key: "cushionRestitution", label: "cushion bounce ec", min: 0.3, max: 1, step: 0.01 },
  { key: "ballFriction", label: "ball friction μbb", min: 0.0, max: 0.3, step: 0.005 },
  { key: "ballRestitution", label: "ball bounce eb", min: 0.5, max: 1, step: 0.01 },
];
const SLIP_EPS = 1; // below this (mm/s) the ball is "rolling"
export const FIXED_DT = 1 / 240; // physics timestep (seconds)
const REST_V = 5; // linear speed (mm/s) below which a ball is at rest
const REST_W = 0.15; // angular speed below which spin is ignored

// --- Small vector helpers ---------------------------------------------------
const len = (x: number, y: number) => hyp(x, y);

export type ShotEvent =
  | { type: "cushion"; ball: number }
  // ax/ay, bx/by: the two ball centres at the exact swept time-of-impact, so a
  // preview can pin its ghost to the true contact instead of re-deriving it.
  // avx/avy, bvx/bvy: each ball's velocity immediately after the impulse (throw
  // included), so a preview can show the true launch direction before any later
  // same-step bounce alters it.
  | {
      type: "ball";
      a: number;
      b: number;
      ax: number;
      ay: number;
      bx: number;
      by: number;
      avx: number;
      avy: number;
      bvx: number;
      bvy: number;
    }
  | { type: "pot"; ball: number };

// Seeded PRNG (mulberry32) + string hash (FNV-1a). ENTIRELY integer/bitwise:
// +,|0,^,>>>, and Math.imul (spec'd to the low 32 bits) — NO floating point,
// NO Math.random, NO libm. So it is bit-identical on every JS engine, V8
// (Android/Chrome) and JavaScriptCore (iOS) alike — the same reason the physics
// stays in sync. Returns a raw uint32; the shuffle reduces it with integer
// modulo, so not a single float rounding is involved anywhere on this path.
// Both clients seed the rack from the shared room id, so a "random" mix still
// lands on the same rack on every table.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Deterministic uint32 hash of a string (e.g. a room id) for seeding. */
export function rackSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffle<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng() % (i + 1); // integer modulo of a uint32 — no float rounding
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/**
 * Legal 8-ball rack, randomised by `seed`:
 *  - the 8 sits dead centre of the third row,
 *  - the two back-row corners are one solid + one stripe,
 *  - the apex and every other slot are a seeded random mix.
 * Same seed -> same rack, so both clients (seeded off the room id) agree.
 */
export function rackWorld(seed = 0): World {
  const balls: Ball[] = [];
  const mk = (id: number, p: Vec): Ball => ({
    id,
    p,
    v: { x: 0, y: 0 },
    w: { x: 0, y: 0, z: 0 },
    potted: false,
  });

  // Cue ball on the head spot (left quarter, on the long axis).
  balls.push(mk(0, { x: TABLE.w * 0.25, y: TABLE.h / 2 }));

  // Triangle rack near the foot spot (right quarter). Rows fan out in +x.
  const footX = TABLE.w * 0.72;
  const cy = TABLE.h / 2;
  const d = 2 * R + 0.2; // touching spacing with a hair of clearance (mm)
  const dx = d * SQRT3_2; // d·sin(π/3), deterministic

  const rng = mulberry32(seed);
  const solids = [1, 2, 3, 4, 5, 6, 7];
  const stripes = [9, 10, 11, 12, 13, 14, 15];
  shuffle(solids, rng);
  shuffle(stripes, rng);

  // Slots in row-major order (apex first). Special slots by linear index:
  //   k=0  apex (row 0)         — any ball (part of the random fill)
  //   k=4  centre of 3rd row    — the 8
  //   k=10 back corner (top)    — a solid
  //   k=14 back corner (bottom) — a stripe
  const id: number[] = new Array(15);
  id[4] = 8;
  id[10] = solids.pop()!;
  id[14] = stripes.pop()!;
  const pool = [...solids, ...stripes];
  shuffle(pool, rng);
  for (let s = 0; s < 15; s++) if (id[s] === undefined) id[s] = pool.pop()!;

  let k = 0;
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i <= row; i++) {
      const x = footX + row * dx;
      const y = cy + (i - row / 2) * d;
      balls.push(mk(id[k++], { x, y }));
    }
  }
  return { balls };
}

// --- Snooker -----------------------------------------------------------------
// Ball ids: 0 = cue (white), 1..15 = reds, 16..21 = the colours in ascending
// value (yellow=2 … black=7). value(id) below turns an id into its point value.
export const SNOOKER_COLOURS = [16, 17, 18, 19, 20, 21] as const; // low → high
export function isRed(id: number): boolean {
  return id >= 1 && id <= 15;
}
export function isColour(id: number): boolean {
  return id >= 16 && id <= 21;
}
/** Point value of a ball: red=1, yellow=2, green=3, brown=4, blue=5, pink=6, black=7. */
export function ballValue(id: number): number {
  return id === 0 ? 0 : id <= 15 ? 1 : id - 14;
}

// The six colour spots + the cue's break position, in world mm, laid out to the
// REAL 12ft snooker table (3569 × 1778 mm). Pinned to the snooker felt dims — NOT
// the live TABLE binding, which is pool-sized when this module loads. Standard
// marks: baulk line 29" from the baulk cushion, the D (11.5" radius) with the
// three baulk colours across it, blue at centre, pink midway to the top cushion,
// black 12.75" from it. Reds triangle just behind the pink.
const SNK_LEN = GEO.snooker.feltWidth; // 3569 mm (length, long axis)
const SNK_WID = GEO.snooker.feltHeight; // 1778 mm (width)
const BAULK_X = 737; // baulk line, 29" from the baulk cushion
const D_R = 292; // radius of the D, 11.5" (yellow/green offset off centre)
export const SNOOKER_SPOTS: Record<number, Vec> = {
  16: { x: BAULK_X, y: SNK_WID / 2 - D_R }, // yellow (right corner of the D)
  17: { x: BAULK_X, y: SNK_WID / 2 + D_R }, // green (left corner of the D)
  18: { x: BAULK_X, y: SNK_WID / 2 }, // brown (baulk-line centre)
  19: { x: SNK_LEN / 2, y: SNK_WID / 2 }, // blue (centre spot)
  20: { x: (SNK_LEN / 2 + SNK_LEN) / 2, y: SNK_WID / 2 }, // pink (midway centre → top cushion)
  21: { x: SNK_LEN - 324, y: SNK_WID / 2 }, // black (12.75" from the top cushion)
};
// Cue ball breaks from inside the D (bulging toward the baulk cushion, −x).
export const SNOOKER_CUE_SPOT: Vec = { x: BAULK_X - D_R * 0.45, y: SNK_WID / 2 - D_R * 0.5 };
// The D: a semicircle of radius `r` centred on the baulk line at (x, y), bulging
// toward the baulk cushion (−x). The cue-ball in-hand region + a drawn table mark.
export const SNOOKER_D = { x: BAULK_X, y: SNK_WID / 2, r: D_R };

/** Snooker rack: 15 reds in a triangle behind the pink, six colours on spots,
 *  cue in the D. Layout is fixed (no seed), but the arg keeps parity with
 *  rackWorld so both clients build the same table. */
export function rackSnooker(_seed = 0): World {
  const balls: Ball[] = [];
  const mk = (id: number, p: Vec): Ball => ({
    id,
    p: { ...p },
    v: { x: 0, y: 0 },
    w: { x: 0, y: 0, z: 0 },
    potted: false,
  });

  balls.push(mk(0, SNOOKER_CUE_SPOT));
  for (const id of SNOOKER_COLOURS) balls.push(mk(id, SNOOKER_SPOTS[id]));

  // Reds: a 5-row triangle, apex touching the pink, fanning out toward the black.
  const d = 2 * R + 0.2; // touching spacing with a hair of clearance (mm)
  const dx = d * SQRT3_2;
  const apexX = SNOOKER_SPOTS[20].x + d + 2; // just behind the pink (mm)
  const cy = TABLE.h / 2;
  let redId = 1;
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i <= row; i++) {
      balls.push(mk(redId++, { x: apexX + row * dx, y: cy + (i - row / 2) * d }));
    }
  }
  return { balls };
}

/** Where a potted colour goes back on: its own spot, or (if occupied) the
 *  highest free spot, or (all full) nudged off its spot toward the top cushion —
 *  the standard snooker respot priority. */
export function respotPosition(world: World, id: number): Vec {
  const occupied = (p: Vec) =>
    world.balls.some(
      (b) => !b.potted && b.id !== id && len(b.p.x - p.x, b.p.y - p.y) < 2 * R - 0.1,
    );
  // NB: always return a FRESH Vec, never a SNOOKER_SPOTS entry by reference — the
  // caller assigns it to ball.p, which the sim then mutates in place; handing back
  // the shared spot object would corrupt the spot to wherever the ball later rolls.
  const own = SNOOKER_SPOTS[id];
  if (own && !occupied(own)) return { ...own };
  for (let k = SNOOKER_COLOURS.length - 1; k >= 0; k--) {
    const s = SNOOKER_SPOTS[SNOOKER_COLOURS[k]];
    if (!occupied(s)) return { ...s };
  }
  const step = 2 * R;
  const base = own ?? SNOOKER_SPOTS[19];
  for (let dd = step; dd < TABLE.w; dd += step) {
    const up = { x: base.x + dd, y: base.y };
    if (up.x < TABLE.w - R && !occupied(up)) return up;
    const dn = { x: base.x - dd, y: base.y };
    if (dn.x > R && !occupied(dn)) return dn;
  }
  return { ...base };
}

export type Shot = {
  angle: number; // radians, direction the cue ball travels
  power: number; // 0..1 (mapped to launch speed)
  follow: number; // -1..1 : draw(-) / follow(+) along travel
  side: number; // -1..1 : left/right English
  elevation: number; // radians, cue raised off the table (0 = level)
};

export const MAX_SPEED = 7600; // mm/s at power = 1 (7.6 m/s; 80% of the former 9.5 cap)
export const MAX_ELEVATION = (80 * Math.PI) / 180; // steepest cue we allow

/** Apply a shot's impulse + spin to the cue ball. */
export function applyShot(world: World, shot: Shot) {
  const cue = world.balls[0];
  if (cue.potted) return;
  // Power ramps up faster as the draw grows: a blend of linear + quadratic so
  // the first half of the pull gives ~a third of full speed (fine control near,
  // big hits far). Full draw (power 1) is still MAX_SPEED.
  const p = shot.power;
  const V = (p / 3 + (2 / 3) * p * p) * MAX_SPEED;
  const el = shot.elevation ?? 0; // cue elevation (radians)
  const e = dsincos(el);
  const cE = e.c;
  const sE = e.s;
  const d = dsincos(shot.angle);
  const dx = d.c;
  const dy = d.s;

  // Only the horizontal component of the strike drives the ball forward, so a
  // jacked-up cue trades forward momentum for spin.
  const Vf = V * cE;
  cue.v = { x: Vf * dx, y: Vf * dy };

  // Spin magnitude uses the *full* tip speed (independent of elevation) — that
  // is why a high angle + big backspin gives lots of spin but little travel.
  // The coefficient is the tip-offset limit: ω = (5/2)(b/R)(V/R). A real chalked
  // tip miscues past b = R/2, so a full slider (follow/side = ±1) maps to that
  // miscue offset — coefficient (5/2)·(1/2) = 1.25, NOT 2.5 (which is a
  // physically impossible edge strike, b = R).
  const spin = (1.25 * V) / R;
  const wf = spin * shot.follow; // draw(-) / follow(+) about the roll axis
  // Side English. Negated because the world is screen-handed (y points down):
  // left-of-shot English (side < 0) must give wz > 0 so the ball curves and
  // deflects to the shooter's left, not the right.
  const ws = -spin * shot.side;

  // Roll axis = perpendicular to travel (horizontal). Motion +x rolls about +y.
  const perpx = -dy;
  const perpy = dx;
  // Elevation tilts the side-spin axis from vertical toward the travel axis;
  // that travel-axis component curves the path on the cloth => masse / swerve.
  const wMasse = ws * sE;
  cue.w = {
    x: perpx * wf + dx * wMasse,
    y: perpy * wf + dy * wMasse,
    z: ws * cE,
  };
}

/**
 * Advance the world one fixed timestep, mutating it in place. Any contacts /
 * pots that happen are pushed onto `events` (order preserved) for the rules
 * layer. Deterministic: same input -> same output.
 */
/** Elastic normal impulse + friction throw for two touching balls (equal mass). */
function resolveBallBall(
  a: Ball,
  b: Ball,
  eBall: number,
  muBall: number,
  events: ShotEvent[],
) {
  const dx = b.p.x - a.p.x;
  const dy = b.p.y - a.p.y;
  const dist = len(dx, dy) || 1e-9;
  const nx = dx / dist;
  const ny = dy / dist;
  const vn = (b.v.x - a.v.x) * nx + (b.v.y - a.v.y) * ny;
  if (vn >= 0) return; // separating (shouldn't happen at a TOI contact)

  const jn = (-(1 + eBall) * vn) / 2;
  a.v.x -= jn * nx;
  a.v.y -= jn * ny;
  b.v.x += jn * nx;
  b.v.y += jn * ny;

  // Collision-induced throw from the tangential surface speeds (incl. English).
  const tx = -ny;
  const ty = nx;
  const surfA = a.v.x * tx + a.v.y * ty + R * a.w.z;
  const surfB = b.v.x * tx + b.v.y * ty - R * b.w.z;
  const vt = surfB - surfA;
  if (Math.abs(vt) > 1e-6) {
    const jt = Math.max(-muBall * jn, Math.min(muBall * jn, -vt / 2));
    a.v.x -= jt * tx;
    a.v.y -= jt * ty;
    b.v.x += jt * tx;
    b.v.y += jt * ty;
    a.w.z -= (2.5 / R) * jt;
    b.w.z -= (2.5 / R) * jt;
  }
  // a.p/b.p are at the exact contact instant here (stepFixed advanced both to
  // the swept TOI before resolving), so record them as the true contact centres.
  events.push({
    type: "ball",
    a: a.id,
    b: b.id,
    ax: a.p.x,
    ay: a.p.y,
    bx: b.p.x,
    by: b.p.y,
    avx: a.v.x,
    avy: a.v.y,
    bvx: b.v.x,
    bvy: b.v.y,
  });
}

/**
 * Cushion rebound off a face with inward normal (nx,ny) and unit tangent
 * (tx,ty): reflect the normal velocity with restitution, apply capped Coulomb
 * friction from the tangential surface speed (which includes side spin). Shared
 * by flat faces and rounded corners so English throws consistently off both.
 */
function bounce(
  b: Ball,
  nx: number,
  ny: number,
  tx: number,
  ty: number,
  eCushion: number,
  muCushion: number,
  events: ShotEvent[],
) {
  const vn = b.v.x * nx + b.v.y * ny; // < 0 while approaching the face
  const jn = -(1 + eCushion) * vn; // normal impulse magnitude (>= 0)
  b.v.x += jn * nx;
  b.v.y += jn * ny;

  // Handedness of the (normal, tangent) pair sets the sign of the spin's
  // tangential surface velocity, R*wz, so English throws the correct way.
  const h = ny * tx - nx * ty; // ±1
  const cap = muCushion * jn;
  // /3.5 = 7/2 sphere factor so the coupled linear+spin response can't overshoot.
  const surf = b.v.x * tx + b.v.y * ty + R * b.w.z * h;
  const jt = Math.max(-cap, Math.min(cap, -surf / 3.5));
  b.v.x += jt * tx;
  b.v.y += jt * ty;
  b.w.z += (2.5 / R) * h * jt;
  events.push({ type: "cushion", ball: b.id });
}

/** Rebound off a flat cushion face. Byte-identical to the old per-rail code. */
function resolveSeg(
  b: Ball,
  s: CushionSeg,
  eCushion: number,
  muCushion: number,
  events: ShotEvent[],
) {
  bounce(b, s.nx, s.ny, s.tx, s.ty, eCushion, muCushion, events);
}

/**
 * Rebound off a rounded corner. The contact normal (nx,ny) is the vertex->ball
 * direction, so a ball clipping the tip deflects along it — realistic corner
 * behaviour for any incoming angle. Tangent is the normal rotated 90°.
 */
function resolveVert(
  b: Ball,
  nx: number,
  ny: number,
  eCushion: number,
  muCushion: number,
  events: ShotEvent[],
) {
  bounce(b, nx, ny, -ny, nx, eCushion, muCushion, events);
}

/** Reflect off a hard outer pocket wall (contains balls that miss the hole). */
function resolveWall(b: Ball, axis: "x" | "y", e: number, events: ShotEvent[]) {
  if (axis === "x") b.v.x = -b.v.x * e;
  else b.v.y = -b.v.y * e;
  events.push({ type: "cushion", ball: b.id });
}

export function stepFixed(
  world: World,
  events: ShotEvent[],
  cfg: PhysicsConfig = DEFAULT_CONFIG,
) {
  const dt = FIXED_DT;
  const balls = world.balls;

  // Each coefficient is its own configured mechanism; only the vertical-spin
  // "drilling" friction is derived, because it is the same cloth friction μ_s
  // acting over the contact patch.
  const muSlide = cfg.clothFriction;
  const muRoll = cfg.rollingResistance;
  const muSpin = cfg.clothFriction * CONTACT_PATCH;
  const eBall = cfg.ballRestitution;
  const muBall = cfg.ballFriction;
  const eCushion = cfg.cushionRestitution;
  const muCushion = cfg.cushionFriction;

  // 1. Cloth friction: slide or roll each ball, decay side spin.
  for (const b of balls) {
    if (b.potted) continue;
    // Slip velocity of the contact patch: u = v + w x r, r = (0,0,-R).
    // w x (0,0,-R) = (-R*w.y, R*w.x, 0).
    const ux = b.v.x - R * b.w.y;
    const uy = b.v.y + R * b.w.x;
    const uMag = len(ux, uy);

    if (uMag > SLIP_EPS) {
      // Sliding: kinetic friction opposes the slip direction.
      const a = muSlide * G; // linear deceleration magnitude
      // For a sphere the contact-slip speed decays at 7/2 * a (linear + the
      // angular reaction). Clamp this step so slip can't overshoot zero and
      // start oscillating — that overshoot was corrupting every spin shot.
      const duPerStep = 3.5 * a * dt;
      const frac = uMag > duPerStep ? 1 : uMag / duPerStep;
      const nx = ux / uMag;
      const ny = uy / uMag;
      const ddvx = -a * nx * dt * frac;
      const ddvy = -a * ny * dt * frac;
      // Angular reaction: dw = (5 / (2R)) * (a_lin_y, -a_lin_x) about x,y.
      b.w.x += (2.5 / R) * ddvy;
      b.w.y += -(2.5 / R) * ddvx;
      b.v.x += ddvx;
      b.v.y += ddvy;
      if (frac < 1) {
        // Slip has just reached zero: pin onto the pure-rolling constraint.
        b.w.x = -b.v.y / R;
        b.w.y = b.v.x / R;
      }
    } else {
      // Rolling: pin the spin to the roll constraint, apply rolling resistance.
      const speed = len(b.v.x, b.v.y);
      if (speed > 1e-6) {
        const dec = muRoll * G * dt;
        const f = Math.max(0, speed - dec) / speed;
        b.v.x *= f;
        b.v.y *= f;
      }
      // u = 0 -> w.y = v.x/R, w.x = -v.y/R.
      b.w.x = -b.v.y / R;
      b.w.y = b.v.x / R;
    }

    // Vertical-axis spin (English) always bleeds off.
    if (b.w.z !== 0) {
      const dec = (2.5 * muSpin * G) / R * dt;
      if (Math.abs(b.w.z) <= dec) b.w.z = 0;
      else b.w.z -= Math.sign(b.w.z) * dec;
    }
  }

  // 2. Advance with swept (continuous) collision detection. Each iteration
  //    finds the earliest time-of-impact among all ball-ball pairs and every
  //    ball-cushion approach, advances every ball to exactly that instant, and
  //    resolves that one contact. This never tunnels (however fast the balls)
  //    and always resolves at the true touch point, not after overlap.
  const D2 = 2 * R;
  let remaining = dt;
  for (let iter = 0; iter < 32 && remaining > 1e-9; iter++) {
    let best = remaining;
    let hitBall: [Ball, Ball] | null = null;
    let hitSeg: [Ball, CushionSeg] | null = null;
    let hitVert: [Ball, number, number] | null = null; // ball + contact normal
    let hitWall: [Ball, "x" | "y"] | null = null;

    // Earliest ball-ball impact: solve |d + vr*t| = 2R for the first root.
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (a.potted) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (b.potted) continue;
        const dx = b.p.x - a.p.x;
        const dy = b.p.y - a.p.y;
        const rvx = b.v.x - a.v.x;
        const rvy = b.v.y - a.v.y;
        const A = rvx * rvx + rvy * rvy;
        if (A < 1e-12) continue;
        const B = dx * rvx + dy * rvy; // half of the usual b coefficient
        if (B >= 0) continue; // not approaching
        const C = dx * dx + dy * dy - D2 * D2;
        const disc = B * B - A * C;
        if (disc < 0) continue;
        const t = (-B - Math.sqrt(disc)) / A;
        if (t < best) {
          best = Math.max(0, t);
          hitBall = [a, b];
          hitSeg = null;
          hitVert = null;
          hitWall = null;
        }
      }
    }

    // Earliest ball-cushion impact: swept point (ball centre) against every
    // cushion polygon segment. A segment's finite span keeps the pocket mouths
    // genuine gaps, and the angled jaws close the old bare-line ends.
    for (const b of balls) {
      if (b.potted) continue;
      for (const s of CUSHION_SEGS) {
        const vn = b.v.x * s.nx + b.v.y * s.ny;
        if (vn >= 0) continue; // moving along or away from the front face
        const d0 = (b.p.x - s.a.x) * s.nx + (b.p.y - s.a.y) * s.ny;
        // Contact when the centre is R in front of the felt face (d0 -> R).
        const t = (R - d0) / vn;
        if (t < 0 || t >= best) continue;
        // The contact point must fall within the segment, not its extension —
        // beyond an end, the corner vertex (below) rounds it instead.
        const cx = b.p.x + b.v.x * t;
        const cy = b.p.y + b.v.y * t;
        const proj = (cx - s.a.x) * s.tx + (cy - s.a.y) * s.ty;
        if (proj < 0 || proj > s.len) continue;
        best = t;
        hitSeg = [b, s];
        hitBall = null;
        hitVert = null;
        hitWall = null;
      }
      // Rounded convex corners: swept ball centre vs a circle of radius R at the
      // vertex. Solving |p + v t - V| = R gives the instant it touches the tip;
      // the rebound normal is (contact - V), so it deflects off the corner at
      // whatever angle it arrived. Accept only normals in the corner's arc.
      for (const vt of CUSHION_VERTS) {
        const fx = b.p.x - vt.x;
        const fy = b.p.y - vt.y;
        const A = b.v.x * b.v.x + b.v.y * b.v.y;
        if (A < 1e-12) continue;
        const B = fx * b.v.x + fy * b.v.y; // half the usual b
        if (B >= 0) continue; // moving away from the vertex
        // Ball centre rides a circle of radius r + R off the collider centre: r = 0
        // for a point tip, r = fillet radius for an arc.
        const Reff = vt.r + R;
        const C = fx * fx + fy * fy - Reff * Reff;
        const disc = B * B - A * C;
        if (disc < 0) continue;
        const t = (-B - Math.sqrt(disc)) / A;
        if (t < 0 || t >= best) continue;
        const nx = (fx + b.v.x * t) / Reff; // unit contact normal (centre -> ball)
        const ny = (fy + b.v.y * t) / Reff;
        if (b.v.x * nx + b.v.y * ny >= 0) continue; // not closing on the corner
        if (!vertNormalOk(nx, ny, vt)) continue; // belongs to a flat face
        best = t;
        hitVert = [b, nx, ny];
        hitBall = null;
        hitSeg = null;
        hitWall = null;
      }
      // Outer pocket walls (full extent, only reachable through a mouth gap).
      const OW = POCKET_DEPTH;
      const tryWall = (t: number, axis: "x" | "y") => {
        if (t < 0 || t >= best) return;
        best = t;
        hitWall = [b, axis];
        hitBall = null;
        hitSeg = null;
        hitVert = null;
      };
      if (b.v.x < 0) tryWall((-OW - b.p.x) / b.v.x, "x");
      else if (b.v.x > 0) tryWall((TABLE.w + OW - b.p.x) / b.v.x, "x");
      if (b.v.y < 0) tryWall((-OW - b.p.y) / b.v.y, "y");
      else if (b.v.y > 0) tryWall((TABLE.h + OW - b.p.y) / b.v.y, "y");
    }

    // Advance every active ball to the earliest contact instant.
    for (const b of balls) {
      if (b.potted) continue;
      b.p.x += b.v.x * best;
      b.p.y += b.v.y * best;
    }
    remaining -= best;

    if (hitBall) resolveBallBall(hitBall[0], hitBall[1], eBall, muBall, events);
    else if (hitSeg)
      resolveSeg(hitSeg[0], hitSeg[1], eCushion, muCushion, events);
    else if (hitVert)
      resolveVert(hitVert[0], hitVert[1], hitVert[2], eCushion, muCushion, events);
    else if (hitWall) resolveWall(hitWall[0], hitWall[1], 0.5, events);
    else break; // no contact this interval — the full remaining time elapsed
  }

  // Safety net: keep any ball that slipped outside (not into a pocket) on the
  // cloth. Continuous detection makes this rare, but floating point isn't exact.
  for (const b of balls) {
    if (b.potted || nearPocket(b.p)) continue;
    b.p.x = Math.max(R, Math.min(TABLE.w - R, b.p.x));
    b.p.y = Math.max(R, Math.min(TABLE.h - R, b.p.y));
  }

  // 5. Pockets — a ball drops once its centre is inside a pocket hole circle.
  for (const b of balls) {
    if (b.potted) continue;
    for (const pk of POCKET_LIST) {
      if (len(b.p.x - pk.center.x, b.p.y - pk.center.y) < pk.hole) {
        b.potted = true;
        b.dropV = { x: b.v.x, y: b.v.y }; // keep the impact speed for the sink anim
        b.v = { x: 0, y: 0 };
        b.w = { x: 0, y: 0, z: 0 };
        events.push({ type: "pot", ball: b.id });
        break;
      }
    }
  }
}

export type Prediction = {
  cue: Vec[]; // cue-ball path up to its first contact
  ghost: Vec | null; // cue position at that first contact
  cuePotted: boolean; // first "contact" was falling into a pocket
  object?: Vec[]; // first few frames of the struck ball's travel (if it hits one)
  objectId?: number; // which ball was struck (for colouring the preview)
};

/**
 * Preview the cue ball's path for a shot, running the real engine forward on a
 * throwaway clone (so the curve accounts for spin / masse). Traces only up to
 * the cue ball's FIRST contact with anything — another ball, a cushion, or a
 * pocket — then stops. No rebounds, no object-ball projection.
 */
/**
 * Point where a cue centre leaving p0 with velocity v first meets a cushion
 * (or an outer pocket wall). Mirrors the swept test in stepFixed. Used to pin
 * the preview's ghost to the true contact, not the post-rebound position the
 * fixed step leaks a few cm into (which otherwise jitters as you scan a face).
 */
function railContactPoint(p0: Vec, v: Vec): Vec | null {
  let best = Infinity;
  for (const s of CUSHION_SEGS) {
    const vn = v.x * s.nx + v.y * s.ny;
    if (vn >= 0) continue; // moving along or away from the front face
    const d0 = (p0.x - s.a.x) * s.nx + (p0.y - s.a.y) * s.ny;
    const t = (R - d0) / vn; // centre reaches R in front of the felt face
    if (t < 0 || t >= best) continue;
    const cx = p0.x + v.x * t;
    const cy = p0.y + v.y * t;
    const proj = (cx - s.a.x) * s.tx + (cy - s.a.y) * s.ty;
    if (proj < 0 || proj > s.len) continue;
    best = t;
  }
  // Rounded convex corners (mirror of stepFixed's vertex sweep).
  for (const vt of CUSHION_VERTS) {
    const fx = p0.x - vt.x;
    const fy = p0.y - vt.y;
    const A = v.x * v.x + v.y * v.y;
    if (A < 1e-12) continue;
    const B = fx * v.x + fy * v.y;
    if (B >= 0) continue;
    const Reff = vt.r + R;
    const C = fx * fx + fy * fy - Reff * Reff;
    const disc = B * B - A * C;
    if (disc < 0) continue;
    const t = (-B - Math.sqrt(disc)) / A;
    if (t < 0 || t >= best) continue;
    const nx = (fx + v.x * t) / Reff;
    const ny = (fy + v.y * t) / Reff;
    if (v.x * nx + v.y * ny >= 0) continue;
    if (!vertNormalOk(nx, ny, vt)) continue;
    best = t;
  }
  // Outer pocket walls (rattle backstop), same extents as stepFixed.
  const OW = POCKET_DEPTH;
  const tryWall = (t: number) => {
    if (t >= 0 && t < best) best = t;
  };
  if (v.x < 0) tryWall((-OW - p0.x) / v.x);
  else if (v.x > 0) tryWall((TABLE.w + OW - p0.x) / v.x);
  if (v.y < 0) tryWall((-OW - p0.y) / v.y);
  else if (v.y > 0) tryWall((TABLE.h + OW - p0.y) / v.y);

  if (!Number.isFinite(best)) return null;
  return { x: p0.x + v.x * best, y: p0.y + v.y * best };
}

export function predictPaths(
  world: World,
  shot: Shot,
  cfg: PhysicsConfig = DEFAULT_CONFIG,
  maxTime = 1.2,
  // When false, keep tracing the cue ball through cushion rebounds and only
  // stop at a ball collision / pot / rest (full-path preview).
  stopOnCushion = true,
): Prediction {
  const w = cloneWorld(world);
  applyShot(w, shot);
  const cue = w.balls[0];

  const cuePath: Vec[] = [{ ...cue.p }];
  let ghost: Vec | null = null;
  let cuePotted = false;
  // When the cue strikes an object ball, hint which way it heads off with a
  // short straight ray from the exact contact. The ray LENGTH encodes how full
  // the hit is: the dot of the struck ball's heading with the cue's incoming
  // heading. Head-on -> 1 -> full length; grazing -> ~0 -> the ray vanishes.
  let objId: number | null = null;
  const objPath: Vec[] = [];
  const OBJ_MAX_LEN = 150; // ray length (mm) at a dead-centre (head-on) hit

  const events: ShotEvent[] = [];
  const steps = Math.round(maxTime / FIXED_DT);
  const sampleEvery = 2;
  let stop = false;

  for (let i = 0; i < steps && !stop; i++) {
    const prev = { ...cue.p }; // cue position before this step
    const prevV = { ...cue.v }; // cue velocity before this step (incoming dir)
    const mark = events.length;
    stepFixed(w, events, cfg);

    // Watch for the cue ball's first contact.
    for (let k = mark; k < events.length; k++) {
      const e = events[k];
      if (e.type === "ball" && (e.a === 0 || e.b === 0)) {
        // Use the exact contact centres the swept step recorded at the true
        // time-of-impact. Re-deriving them here (straight ray from the step
        // start) disagreed with the swept solver at grazing aims and on curved
        // shots, so the ghost — and the drawn line length — jumped as you
        // scanned across a ball. Reading the real contact makes it slide.
        objId = e.a === 0 ? e.b : e.a;
        const cueC = e.a === 0 ? { x: e.ax, y: e.ay } : { x: e.bx, y: e.by };
        const objC = e.a === 0 ? { x: e.bx, y: e.by } : { x: e.ax, y: e.ay };
        ghost = cueC;
        // Struck-ball hint: one straight ray along the ball's launch velocity
        // (throw included), the instant after the impulse. Use the velocity the
        // event recorded at the resolve — NOT a later read of the world, which
        // could already reflect a same-step rail bounce (a ball frozen on a rail
        // should still show as struck INTO the rail, not the rebound). No
        // multi-frame trace, so nothing sawtooths as you scan.
        const ovx = e.a === 0 ? e.bvx : e.avx;
        const ovy = e.a === 0 ? e.bvy : e.avy;
        const spd = hyp(ovx, ovy);
        let dx = ovx;
        let dy = ovy;
        if (spd > 1e-6) {
          dx /= spd;
          dy /= spd;
        } else {
          // Dead graze (zero launch speed): point along the line of centres.
          dx = objC.x - cueC.x;
          dy = objC.y - cueC.y;
          const dl = hyp(dx, dy) || 1;
          dx /= dl;
          dy /= dl;
        }
        // Fullness of the hit: dot of the struck ball's heading with the cue's
        // incoming heading (prevV, the velocity going into this step). Head-on
        // -> 1 -> full length; grazing -> 0 -> the ray shrinks to nothing.
        const cl = hyp(prevV.x, prevV.y) || 1;
        const dot = Math.max(0, dx * (prevV.x / cl) + dy * (prevV.y / cl));
        const L = OBJ_MAX_LEN * dot;
        // Start at the ball's leading edge (centre + R along the heading), not
        // its centre, and run the length out from there.
        const ex = objC.x + dx * R;
        const ey = objC.y + dy * R;
        objPath.push({ x: ex, y: ey }, { x: ex + dx * L, y: ey + dy * L });
        stop = true;
        break;
      }
      if (stopOnCushion && e.type === "cushion" && e.ball === 0) {
        // Refine to the exact rail contact: the fixed step resolves the bounce
        // and advances a few cm into the rebound, which jitters on the step
        // grid as you scan a face. Solve the true first-contact point instead.
        ghost = railContactPoint(prev, prevV) ?? { ...cue.p };
        stop = true;
        break;
      }
      if (e.type === "pot" && e.ball === 0) {
        ghost = { ...cue.p };
        cuePotted = true;
        stop = true;
        break;
      }
    }

    // End the cue-ball line at the contact/rail point; otherwise sample it.
    if (stop || objId !== null) cuePath.push(ghost ?? { ...cue.p });
    else if (i % sampleEvery === 0) cuePath.push({ ...cue.p });
    if (atRest(w)) break;
  }

  // No collision/pot along the way → the cue ball simply rolled to a stop; mark
  // its resting place with the ghost so the preview shows where it ends up.
  if (!ghost && !cuePotted) {
    ghost = { ...cue.p };
    cuePath.push({ ...cue.p });
  }

  return {
    cue: cuePath,
    ghost,
    cuePotted,
    object: objPath.length ? objPath : undefined,
    objectId: objId ?? undefined,
  };
}

/** A ball near a pocket mouth is heading in — don't clamp it back onto the cloth. */
function nearPocket(p: Vec): boolean {
  for (const pk of POCKETS) {
    if (len(p.x - pk.x, p.y - pk.y) < 130) return true;
  }
  return false;
}

/** True once every ball is effectively at rest. */
export function atRest(world: World): boolean {
  for (const b of world.balls) {
    if (b.potted) continue;
    if (len(b.v.x, b.v.y) > REST_V) return false;
    if (Math.abs(b.w.z) > REST_W) return false;
    // A ball translating slowly can still hold huge horizontal spin (a heavy
    // draw at the top of its arc). Test the contact slip: while the patch is
    // sliding, friction will keep accelerating the ball, so it is NOT at rest.
    const ux = b.v.x - R * b.w.y;
    const uy = b.v.y + R * b.w.x;
    if (len(ux, uy) > REST_V) return false;
  }
  return true;
}

// --- Surface orientation (cosmetic spin visualisation) ----------------------
/** A · B for two row-major 3x3 matrices. */
function mul3(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

/**
 * Advance each ball's surface orientation by its angular velocity over `dt`.
 * Rotation is applied in the WORLD frame (w is a world-frame angular velocity),
 * so M_new = Rodrigues(w, |w|·dt) · M_old. Exact axis-angle (not small-angle):
 * a hard shot spins several radians per fixed step. Cosmetic only — call it
 * alongside stepFixed to keep the drawn markings turning; it never touches
 * positions/velocities and so can't affect the deterministic simulation.
 */
export function integrateSpin(world: World, dt: number) {
  for (const b of world.balls) {
    if (b.potted) continue;
    const wm = Math.hypot(b.w.x, b.w.y, b.w.z);
    if (wm < 1e-9) continue;
    const ang = wm * dt;
    const kx = b.w.x / wm;
    const ky = b.w.y / wm;
    const kz = b.w.z / wm;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const t = 1 - c;
    const rot: Mat3 = [
      t * kx * kx + c, t * kx * ky - s * kz, t * kx * kz + s * ky,
      t * kx * ky + s * kz, t * ky * ky + c, t * ky * kz - s * kx,
      t * kx * kz - s * ky, t * ky * kz + s * kx, t * kz * kz + c,
    ];
    b.o = mul3(rot, b.o ?? IDENT3);
  }
}

/** Snap tiny residual motion to zero so rest state is exactly reproducible. */
export function freeze(world: World) {
  for (const b of world.balls) {
    b.v = { x: 0, y: 0 };
    b.w = { x: 0, y: 0, z: 0 };
  }
}

/** Deep clone (structuredClone is deterministic and dependency-free). */
export function cloneWorld(world: World): World {
  return { balls: world.balls.map((b) => ({ ...b, p: { ...b.p }, v: { ...b.v }, w: { ...b.w } })) };
}

/**
 * Run a shot to completion synchronously (used by replays / rules preview).
 * Returns the ordered event log. Caps steps so a pathological shot can't hang.
 */
export function simulateToRest(
  world: World,
  events: ShotEvent[] = [],
  cfg: PhysicsConfig = DEFAULT_CONFIG,
): ShotEvent[] {
  applyStepsUntilRest(world, events, cfg);
  return events;
}

function applyStepsUntilRest(
  world: World,
  events: ShotEvent[],
  cfg: PhysicsConfig,
) {
  const MAX_STEPS = 240 * 60; // 60s of table time, hard safety cap
  let n = 0;
  while (!atRest(world) && n < MAX_STEPS) {
    stepFixed(world, events, cfg);
    n++;
  }
  freeze(world);
}
