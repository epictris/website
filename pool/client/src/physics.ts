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

export type Ball = {
  id: number; // 0 = cue, 1..7 solids, 8 = eight, 9..15 stripes
  p: Vec;
  v: Vec;
  w: Spin;
  potted: boolean;
};

export type World = {
  balls: Ball[];
};

// --- Table geometry ---------------------------------------------------------
// Arcade / bar-box table: a compact 7ft-ish playfield (2.0 x 1.0 m) with big,
// forgiving pockets. Origin at the cloth corner.
export const TABLE = { w: 2.0, h: 1.0 };
export const R = 0.028575; // 2.25" pool ball (57.15mm diameter)
// Every cushion face is pulled this far into the felt (≈1 ball diameter). The
// pocket holes follow the rails inward by the same amount (see POCKET_LIST) so
// they stay reachable.
export const RAIL_INSET = 0.040;

// Pocket centres: 4 corners + 2 sides.
export const POCKETS: Vec[] = [
  { x: 0, y: 0 },
  { x: TABLE.w / 2, y: 0 },
  { x: TABLE.w, y: 0 },
  { x: 0, y: TABLE.h },
  { x: TABLE.w / 2, y: TABLE.h },
  { x: TABLE.w, y: TABLE.h },
];

// The pocket hole is ONE circle used for both the pot test and the drawn hole,
// so the visual always matches the collision. Centre is pushed out into the
// corner/rail; a ball drops once its centre is inside the circle (i.e. at least
// half over the hole's edge). The push keeps a rail-hugger (whose centre sits R
// off the rail) outside the circle, so side pockets don't vacuum it.
export type Pocket = { center: Vec; hole: number };
export const POCKET_LIST: Pocket[] = POCKETS.map((pk) => {
  const ox = pk.x === 0 ? -1 : pk.x >= TABLE.w - 1e-6 ? 1 : 0;
  const oy = pk.y === 0 ? -1 : pk.y >= TABLE.h - 1e-6 ? 1 : 0;
  // Side pockets sit mid-rail (ox === 0); corners recede along both axes.
  const isSide = ox === 0;
  const push = isSide ? 0.055 : 0.02; // recede the hole from the (inset) felt edge
  const hole = 0.06;
  const shift = push - RAIL_INSET; // follow the rails inward so pockets stay reachable
  return { center: { x: pk.x + ox * shift, y: pk.y + oy * shift }, hole };
});
// Hard outer walls sit this far beyond the felt edge — a ball that enters a
// mouth but misses the hole rattles back instead of escaping off the table.
export const POCKET_DEPTH = 0.055;

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
  x: number;
  y: number;
  n1x: number;
  n1y: number;
  n2x: number;
  n2y: number;
  lone: boolean; // exposed tip (one adjoining face) vs 2-face convex corner
};

// The cushion outline is traced from the table PHOTO. These are the felt
// contact-surface vertices (world units) for the TOP-LEFT quadrant — the top
// rail's left half, its corner facing, one side-pocket facing, and the left
// rail. The other three quadrants are generated by mirroring across the table
// mid-lines. Collision then insets each felt segment by R (a ball touches the
// felt when its centre is R away), so the drawn cushions == the physics.
const LC = 0.105; // long-rail nose start, measured in from the corner (x)
const SC = 0.105; // short-rail nose start, measured in from the corner (y)
const SIDE_HALF = 0.048; // side-pocket mouth half-width (nose ends at w/2 ± this)
const SIDE_LIP = { x: 0.965, depth: -0.06 }; // side-pocket facing lip, depth into felt from the rail
// Corner-pocket jaw: the two inset noses turn toward the hole and end in a
// funnel. The throat sits JAW_DEPTH along the corner diagonal, JAW_THROAT wide;
// smaller THROAT / larger DEPTH = tighter, deeper jaws. Tune with debug-table.
const JAW_DEPTH = 0.02;
const JAW_THROAT = 0.07;

function buildCushionSegs(): CushionSeg[] {
  const w = TABLE.w;
  const h = TABLE.h;
  const P = (x: number, y: number): Vec => ({ x, y });
  const I = RAIL_INSET;
  // Corner-jaw throat tips, symmetric across the corner diagonal (x = y). The
  // top-rail nose ends at the first tip, the left-rail nose at its mirror.
  const dc = JAW_DEPTH * Math.SQRT1_2;
  const to = (JAW_THROAT / 2) * Math.SQRT1_2;
  const jawTop = P(dc + to, dc - to);
  const jawLeft = P(dc - to, dc + to);
  // Interior reference for the corner jaws: the mouth centre between the two
  // nose ends. A jaw wall runs ALONG the corner diagonal, so the table-centre
  // heuristic is degenerate for it; pointing both jaw normals at this shared
  // point makes them face EACH OTHER across the throat.
  const cornerMouth = P((LC + I) / 2, (I + SC) / 2);

  // Top-left quadrant felt segments (contact surface, world coords), all pulled
  // in by RAIL_INSET. Each corner gets a jaw that funnels the nose into the hole.
  // `ref` overrides the inward-normal direction (defaults to the table centre).
  type Seg = { a: Vec; b: Vec; ref?: Vec };
  const base: Seg[] = [
    { a: P(LC, I), b: P(w / 2 - SIDE_HALF, I) }, // top nose: jaw -> side pocket
    { a: P(w / 2 - SIDE_HALF, I), b: P(SIDE_LIP.x, I + SIDE_LIP.depth) }, // side-pocket facing
    { a: P(LC, I), b: jawTop, ref: cornerMouth }, // top-rail corner jaw
    { a: P(I, SC), b: P(I, h - SC) }, // left nose (full height, no side pocket)
    { a: P(I, SC), b: jawLeft, ref: cornerMouth }, // left-rail corner jaw
  ];
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

  // Orient each felt segment's inward normal toward the playfield. No inset and
  // no miter: the faces stay on the true felt surface (so debug == physics), and
  // collision insets by R on the fly. Convex corners are closed by CUSHION_VERTS
  // (point-circle rounding), not by extending the flat faces into each other.
  return felt.map(({ a, b, ref }) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    const tx = dx / len;
    const ty = dy / len;
    let nx = -ty;
    let ny = tx;
    // Point the normal toward the interior reference (a jaw's throat centre, or
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
}
export const CUSHION_SEGS: CushionSeg[] = buildCushionSegs();

// Collect the convex corners of the cushion polygon. A ball's centre rounds
// these as circles of radius R, which is what lets it rebound off a nose/jaw tip
// at any incoming angle. Two kinds: exposed TIPS (one adjoining face — the free
// end of a nose/jaw/facing at a pocket mouth) and 2-face CONVEX corners (two
// faces meeting so the cushion protrudes into the playfield). Concave junctions
// and straight rail splits are skipped: there the flat faces already meet the
// ball first, and a vertex circle would fire spuriously.
function buildCushionVerts(segs: CushionSeg[]): CushionVert[] {
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
    if (edges.length === 1) {
      const e = edges[0];
      verts.push({ x: v.x, y: v.y, n1x: e.nx, n1y: e.ny, n2x: e.nx, n2y: e.ny, lone: true });
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
        verts.push({ x: v.x, y: v.y, n1x: e1.nx, n1y: e1.ny, n2x: e2.nx, n2y: e2.ny, lone: false });
      }
    }
    // >2 faces (T-junction): leave to the flat faces.
  }
  return verts;
}
function unit(x: number, y: number): Vec {
  const l = Math.hypot(x, y) || 1e-9;
  return { x: x / l, y: y / l };
}
export const CUSHION_VERTS: CushionVert[] = buildCushionVerts(CUSHION_SEGS);

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
const G = 9.8;
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

export const DEFAULT_CONFIG: PhysicsConfig = {
  clothFriction: 0.2, // measured ball–baize sliding friction (~0.18–0.22)
  rollingResistance: 0.01, // snooker fast cloth (~0.005–0.015)
  cushionFriction: 0.2, // ball on cushion rubber (~0.14–0.25)
  cushionRestitution: 0.8, // snooker cushion COR (~0.75–0.9)
  ballFriction: 0.06, // ball–ball friction (~0.03–0.08)
  ballRestitution: 0.95, // snooker ball COR (~0.92–0.96)
};

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
const SLIP_EPS = 1e-3; // below this the ball is "rolling"
export const FIXED_DT = 1 / 240; // physics timestep (seconds)
const REST_V = 5e-3; // linear speed below which a ball is at rest
const REST_W = 0.15; // angular speed below which spin is ignored

// --- Small vector helpers ---------------------------------------------------
const len = (x: number, y: number) => Math.hypot(x, y);

export type ShotEvent =
  | { type: "cushion"; ball: number }
  | { type: "ball"; a: number; b: number }
  | { type: "pot"; ball: number };

/** Standard 8-ball rack: apex on the foot spot, 8 in the centre. */
export function rackWorld(): World {
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
  const d = 2 * R + 0.0002; // touching spacing with a hair of clearance
  const dx = d * Math.sin(Math.PI / 3);

  // Rack order: corners must be one of each group, 8 in the middle (row 2).
  const order = [1, 9, 2, 8, 10, 3, 11, 4, 12, 13, 5, 14, 6, 15, 7];
  let k = 0;
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i <= row; i++) {
      const x = footX + row * dx;
      const y = cy + (i - row / 2) * d;
      balls.push(mk(order[k++], { x, y }));
    }
  }
  return { balls };
}

export type Shot = {
  angle: number; // radians, direction the cue ball travels
  power: number; // 0..1 (mapped to launch speed)
  follow: number; // -1..1 : draw(-) / follow(+) along travel
  side: number; // -1..1 : left/right English
  elevation: number; // radians, cue raised off the table (0 = level)
};

export const MAX_SPEED = 9.5; // m/s at power = 1
export const MAX_ELEVATION = (80 * Math.PI) / 180; // steepest cue we allow

/** Apply a shot's impulse + spin to the cue ball. */
export function applyShot(world: World, shot: Shot) {
  const cue = world.balls[0];
  if (cue.potted) return;
  const V = shot.power * MAX_SPEED;
  const el = shot.elevation ?? 0; // cue elevation (radians)
  const cE = Math.cos(el);
  const sE = Math.sin(el);
  const dx = Math.cos(shot.angle);
  const dy = Math.sin(shot.angle);

  // Only the horizontal component of the strike drives the ball forward, so a
  // jacked-up cue trades forward momentum for spin.
  const Vf = V * cE;
  cue.v = { x: Vf * dx, y: Vf * dy };

  // Spin magnitude uses the *full* tip speed (independent of elevation) — that
  // is why a high angle + big backspin gives lots of spin but little travel.
  const spin = (2.5 * V) / R;
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
  events.push({ type: "ball", a: a.id, b: b.id });
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
        const C = fx * fx + fy * fy - R * R;
        const disc = B * B - A * C;
        if (disc < 0) continue;
        const t = (-B - Math.sqrt(disc)) / A;
        if (t < 0 || t >= best) continue;
        const nx = (fx + b.v.x * t) / R; // unit contact normal (vertex -> ball)
        const ny = (fy + b.v.y * t) / R;
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
    const C = fx * fx + fy * fy - R * R;
    const disc = B * B - A * C;
    if (disc < 0) continue;
    const t = (-B - Math.sqrt(disc)) / A;
    if (t < 0 || t >= best) continue;
    const nx = (fx + v.x * t) / R;
    const ny = (fy + v.y * t) / R;
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

/**
 * Point where a cue centre leaving p0 with velocity v first reaches 2R from a
 * struck centre c. Ray-based (not chord-based): the fixed step resolves the hit
 * and advances into the rebound, so p0->cue.p bends at contact and a chord solve
 * jitters. The incoming leg is straight along v, so this pins the true tangent.
 */
function ballContactPoint(p0: Vec, v: Vec, c: Vec): Vec | null {
  const fx = p0.x - c.x;
  const fy = p0.y - c.y;
  const a = v.x * v.x + v.y * v.y;
  const b = 2 * (fx * v.x + fy * v.y);
  const cc = fx * fx + fy * fy - (2 * R) * (2 * R);
  const disc = b * b - 4 * a * cc;
  if (a < 1e-12 || disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0) return null;
  return { x: p0.x + v.x * t, y: p0.y + v.y * t };
}

export function predictPaths(
  world: World,
  shot: Shot,
  cfg: PhysicsConfig = DEFAULT_CONFIG,
  maxTime = 1.2,
): Prediction {
  const w = cloneWorld(world);
  applyShot(w, shot);
  const cue = w.balls[0];

  const cuePath: Vec[] = [{ ...cue.p }];
  let ghost: Vec | null = null;
  let cuePotted = false;

  const events: ShotEvent[] = [];
  const steps = Math.round(maxTime / FIXED_DT);
  const sampleEvery = 2;
  let stop = false;

  for (let i = 0; i < steps && !stop; i++) {
    const prev = { ...cue.p }; // cue position before this step
    const prevV = { ...cue.v }; // cue velocity before this step (incoming dir)
    // Struck-ball centres before this step (resolution moves them; we need the
    // pre-contact position to locate the exact tangent point).
    const prevCentres = w.balls.map((b) => ({ id: b.id, x: b.p.x, y: b.p.y }));
    const mark = events.length;
    stepFixed(w, events, cfg);

    // Stop the instant the cue ball is involved in any contact.
    for (let k = mark; k < events.length; k++) {
      const e = events[k];
      if (e.type === "ball" && (e.a === 0 || e.b === 0)) {
        // Refine to the exact tangent point: the physics step only detects the
        // hit once the balls overlap, which lands on a coarse grid and makes
        // the ghost jump. Solve where the cue centre first reaches 2R from the
        // struck ball along this step's segment so it slides smoothly.
        const objId = e.a === 0 ? e.b : e.a;
        const ob = prevCentres.find((b) => b.id === objId);
        ghost = (ob && ballContactPoint(prev, prevV, ob)) || { ...cue.p };
        stop = true;
        break;
      }
      if (e.type === "cushion" && e.ball === 0) {
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

    if (stop) cuePath.push(ghost ?? { ...cue.p });
    else if (i % sampleEvery === 0) cuePath.push({ ...cue.p });
    if (atRest(w)) break;
  }

  return { cue: cuePath, ghost, cuePotted };
}

/** A ball near a pocket mouth is heading in — don't clamp it back onto the cloth. */
function nearPocket(p: Vec): boolean {
  for (const pk of POCKETS) {
    if (len(p.x - pk.x, p.y - pk.y) < 0.13) return true;
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
