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
// Playfield in metres (9ft table): 2.24 x 1.12. Origin at the cloth corner.
export const TABLE = { w: 2.24, h: 1.12 };
export const R = 0.028575; // ball radius (57.15mm diameter)
export const POCKET_R = 0.05; // capture radius

// Pocket centres: 4 corners + 2 sides.
export const POCKETS: Vec[] = [
  { x: 0, y: 0 },
  { x: TABLE.w / 2, y: 0 },
  { x: TABLE.w, y: 0 },
  { x: 0, y: TABLE.h },
  { x: TABLE.w / 2, y: TABLE.h },
  { x: TABLE.w, y: TABLE.h },
];

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
type RailName = "xmin" | "xmax" | "ymin" | "ymax";

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

/** Cushion rebound: reflect the normal, apply capped Coulomb friction from spin. */
function resolveCushion(
  b: Ball,
  rail: RailName,
  eCushion: number,
  muCushion: number,
  events: ShotEvent[],
) {
  const xRail = rail === "xmin" || rail === "xmax";
  const vn = Math.abs(xRail ? b.v.x : b.v.y); // incoming normal speed
  if (xRail) b.v.x = -b.v.x * eCushion;
  else b.v.y = -b.v.y * eCushion;

  // spinSign makes (spinSign * R * wz) the spin's tangential surface velocity.
  const spinSign =
    rail === "xmin" ? -1 : rail === "xmax" ? 1 : rail === "ymin" ? 1 : -1;
  const tang = xRail ? b.v.y : b.v.x;
  const jn = (1 + eCushion) * vn;
  const cap = muCushion * jn;
  // /3.5 = 7/2 sphere factor so the coupled linear+spin response can't overshoot.
  const jt = Math.max(-cap, Math.min(cap, -(tang + spinSign * R * b.w.z) / 3.5));
  if (xRail) b.v.y += jt;
  else b.v.x += jt;
  b.w.z += spinSign * (2.5 / R) * jt;
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
    let hitRail: [Ball, RailName] | null = null;

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
          hitRail = null;
        }
      }
    }

    // Earliest ball-cushion impact (skip near a pocket mouth so balls fall in).
    for (const b of balls) {
      if (b.potted) continue;
      const tryRail = (t: number, rail: RailName) => {
        if (t < 0 || t >= best) return;
        if (nearPocket({ x: b.p.x + b.v.x * t, y: b.p.y + b.v.y * t })) return;
        best = t;
        hitRail = [b, rail];
        hitBall = null;
      };
      if (b.v.x < 0) tryRail((R - b.p.x) / b.v.x, "xmin");
      else if (b.v.x > 0) tryRail((TABLE.w - R - b.p.x) / b.v.x, "xmax");
      if (b.v.y < 0) tryRail((R - b.p.y) / b.v.y, "ymin");
      else if (b.v.y > 0) tryRail((TABLE.h - R - b.p.y) / b.v.y, "ymax");
    }

    // Advance every active ball to the earliest contact instant.
    for (const b of balls) {
      if (b.potted) continue;
      b.p.x += b.v.x * best;
      b.p.y += b.v.y * best;
    }
    remaining -= best;

    if (hitBall) resolveBallBall(hitBall[0], hitBall[1], eBall, muBall, events);
    else if (hitRail)
      resolveCushion(hitRail[0], hitRail[1], eCushion, muCushion, events);
    else break; // no contact this interval — the full remaining time elapsed
  }

  // Safety net: keep any ball that slipped outside (not into a pocket) on the
  // cloth. Continuous detection makes this rare, but floating point isn't exact.
  for (const b of balls) {
    if (b.potted || nearPocket(b.p)) continue;
    b.p.x = Math.max(R, Math.min(TABLE.w - R, b.p.x));
    b.p.y = Math.max(R, Math.min(TABLE.h - R, b.p.y));
  }

  // 5. Pockets.
  for (const b of balls) {
    if (b.potted) continue;
    for (const pk of POCKETS) {
      if (len(b.p.x - pk.x, b.p.y - pk.y) < POCKET_R) {
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
/** Point along segment p0->p1 where the cue centre is first 2R from centre c. */
function contactPoint(p0: Vec, p1: Vec, c: Vec): Vec {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const fx = p0.x - c.x;
  const fy = p0.y - c.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - (2 * R) * (2 * R);
  const disc = b * b - 4 * a * cc;
  if (a < 1e-12 || disc < 0) return { ...p1 };
  const t = Math.max(0, Math.min(1, (-b - Math.sqrt(disc)) / (2 * a)));
  return { x: p0.x + dx * t, y: p0.y + dy * t };
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
        ghost = ob ? contactPoint(prev, cue.p, ob) : { ...cue.p };
        stop = true;
        break;
      }
      if (
        (e.type === "cushion" && e.ball === 0) ||
        (e.type === "pot" && e.ball === 0)
      ) {
        ghost = { ...cue.p };
        if (e.type === "pot") cuePotted = true;
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

/** A ball whose centre is near a pocket mouth should not bounce off the rail. */
function nearPocket(p: Vec): boolean {
  for (const pk of POCKETS) {
    if (len(p.x - pk.x, p.y - pk.y) < POCKET_R * 1.6) return true;
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
