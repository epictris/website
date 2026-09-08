// Rail cases: hand-built scenes with the answer written down, run by
// `cli rails`.
//
// A rail is a thin bar the manacle clamps around and slides along
// (`lib/rail.ts`), and what makes it worth a suite of its own is that its
// behaviour has a CLOSED FORM: a massless ring on a frictionless bar keeps the
// chain plumb and the ball coasting, one with friction `mu` trails the chain at
// `atan(mu)` and decelerates the ball at `mu·g`, and a ring inside the static
// cone does not move at all. Every one of those is a number, so every one is
// asserted here rather than eyeballed in the browser - and, like every other
// case suite, it exists because a clamp reaches no invariant: a build that
// quietly stopped sliding, or stopped stopping at the lid, renders a level that
// looks identical and plays differently.
//
// Every assertion is a BOUND, never an exact number, with the geometry cases
// as the exception: a centreline is arithmetic and is held to a micron.
//
// What is deliberately NOT asserted is the friction coefficients' feel. The two
// constants are guesses to be played, and a case pinning the deceleration to
// `0.3·g` would be a case rewritten on the next tuning pass; what is pinned is
// the SHAPE - stuck inside the cone, sliding outside it, slower than the
// frictionless run, and no faster than the coefficient allows.

import { Vec2 } from "../engine/vec2";
import { dmath } from "../engine/dmath";
import { RigidBody2D, type PhysicsBody2D } from "../engine/body";
import { circleShape, rectShape, type Shape } from "../engine/shapes";
import { GRAVITY, World } from "../engine/world";
import { buildLevelBodies } from "../level/buildBodies";
import { scaleLevelData, type RawLevelData, type LevelBodyData } from "../level/levelFormat";
import { BallLevel } from "../level/ballLevel";
import { BallHook } from "../classes/ballHook";
import { BallPlayer } from "../classes/ballPlayer";
import { button, emptyFrameInput, type FrameInput } from "../input/frameInput";
import {
  railCentreline,
  RopeClamp,
  slideStep,
  RAIL_KINETIC_FRICTION,
  RAIL_STATIC_FRICTION,
} from "../lib/rail";
import { MANACLE_DISC } from "../lib/manacle";
import { PX } from "../engine/units";
import { modelFromDisk, modelToDisk } from "../editor/model";
import { isCollisionObject } from "../level/levelFormat";
import { checkBallInvariants, TunnelMonitor, type Violation } from "./trace";

const DT = 1 / 60;
const G = GRAVITY.y;

export interface RailResult {
  name: string;
  passed: boolean;
  details: string[];
  expectedFail?: true;
}

function ok(name: string, passed: boolean, details: string[]): RailResult {
  return { name, passed, details };
}

// A claim list with one verdict, the pattern the other suites use.
function claims(): { check: (claim: string, got: boolean) => void; details: string[]; passed: () => boolean } {
  const details: string[] = [];
  let passed = true;
  return {
    details,
    check: (claim, got) => {
      if (!got) passed = false;
      details.push(`${got ? "ok  " : "BAD "} ${claim}`);
    },
    passed: () => passed,
  };
}

// ---------------------------------------------------------------------------
// The rig: the ball hanging from a rail directly above it, driven through the
// real deploy wiring, with the aim held on the anchor once it has one so the
// chain always leaves the loop radially and nothing winds.
// ---------------------------------------------------------------------------

// A level authored in pixels, as every level is, around the ball at the origin.
// `bodies` are pixel-authored `LevelBodyData`.
function level(bodies: LevelBodyData[], playerX = 0): BallLevel {
  return new BallLevel({
    player: { x: playerX, y: 0, radius: 8 },
    bodies,
  } as RawLevelData);
}

// A static rail bar, `w` px long and 3 px thick, centred at (`x`, `y`) px,
// turned by `rot` radians, with the body's authored friction.
function bar(
  x: number,
  y: number,
  w: number,
  friction: number,
  rot = 0,
  extra: Partial<LevelBodyData> = {},
): LevelBodyData {
  return {
    kind: "static",
    x,
    y,
    rot,
    friction,
    objects: [{ type: "collision", shape: { kind: "rect", w, h: 3 }, rail: true }],
    ...extra,
  } as LevelBodyData;
}

class Rig {
  readonly level: BallLevel;
  private prev: FrameInput = emptyFrameInput();
  readonly violations: Violation[] = [];
  private tunnel = new TunnelMonitor();

  constructor(bodies: LevelBodyData[], playerX = 0) {
    this.level = level(bodies, playerX);
  }

  get ball(): BallPlayer {
    return this.level.ball;
  }

  get clamp(): RopeClamp | null {
    const end = this.level.ball.chain?.end;
    return end instanceof RopeClamp ? end : null;
  }

  // One frame with the deploy held and the aim at `aim` (metres, world).
  step(aim: Vec2): void {
    const input: FrameInput = {
      ...emptyFrameInput(),
      fire: button(true, this.prev.fire),
      mouseWorldPosition: aim,
    };
    this.prev = input;
    this.level.physicsProcess(input, DT);
    this.violations.push(...checkBallInvariants(this.level));
    const tunnel = this.tunnel.push(this.level);
    if (tunnel) this.violations.push(tunnel);
  }

  // The aim once clamped: at the anchor, so the chain leaves the loop radially.
  // Before that, straight up from the ball, which is where the rail is.
  aimAtAnchor(): Vec2 {
    const clamp = this.clamp;
    return clamp ? clamp.contact.globalPosition : this.ball.globalPosition.add(new Vec2(0, -1.2));
  }

  // Throw straight up and hang until the ball has settled under the clamp.
  hang(frames = 180): void {
    for (let f = 0; f < frames; f++) this.step(this.aimAtAnchor());
  }

  // Run `frames` more, calling `each` after every one.
  run(frames: number, each?: (f: number) => void): void {
    for (let f = 0; f < frames; f++) {
      this.step(this.aimAtAnchor());
      each?.(f);
    }
  }

  // The chain's angle off the plumb, degrees, positive when the ball is to the
  // +x side of its anchor.
  lean(): number {
    const clamp = this.clamp;
    if (!clamp) return 0;
    const d = this.ball.globalPosition.sub(clamp.contact.globalPosition);
    return (dmath.atan2(d.x, d.y) * 180) / Math.PI;
  }
}

// ---------------------------------------------------------------------------
// centreline - the arithmetic every clamp stands on.
// ---------------------------------------------------------------------------
function caseCentreline(): RailResult {
  const c = claims();
  const near = (a: Vec2, b: Vec2, tol = 1e-9): boolean => a.distanceTo(b) <= tol;

  const rect = railCentreline(rectShape(1, 0.04));
  c.check(
    `a 1 m × 4 cm rect's centreline is its medial axis, 2 cm in from each end (got ${rect.a.x.toFixed(3)}..${rect.b.x.toFixed(3)})`,
    near(rect.a, new Vec2(-0.48, 0)) && near(rect.b, new Vec2(0.48, 0)) && rect.halfWidth === 0.02,
  );
  const tall = railCentreline(rectShape(0.04, 1));
  c.check(
    "a tall rect's runs along y",
    near(tall.a, new Vec2(0, -0.48)) && near(tall.b, new Vec2(0, 0.48)),
  );
  const square = railCentreline(rectShape(0.1, 0.1));
  c.check("a square is a peg: a centreline of no length", near(square.a, square.b));
  const circle = railCentreline(circleShape(0.05));
  c.check("a circle is a peg at its centre", near(circle.a, Vec2.ZERO) && near(circle.b, Vec2.ZERO));

  // A 1 m × 4 cm bar authored as a polygon, turned 30°: the principal axis is
  // the bar's own, and the medial shortening is the same 2 cm.
  const angle = Math.PI / 6;
  const along = new Vec2(dmath.cos(angle), dmath.sin(angle));
  const across = along.orthogonal();
  const verts = [
    along.mul(-0.5).add(across.mul(0.02)),
    along.mul(-0.5).sub(across.mul(0.02)),
    along.mul(0.5).sub(across.mul(0.02)),
    along.mul(0.5).add(across.mul(0.02)),
  ];
  const poly = railCentreline({ kind: "poly", verts });
  const len = poly.b.sub(poly.a).length();
  const dir = poly.b.sub(poly.a).normalized();
  const tilt = Math.abs(Math.abs(dir.dot(along)) - 1);
  c.check(
    `a polygon bar at 30° gets the bar's own axis (off by ${tilt.toExponential(1)}) at 0.96 m (got ${len.toFixed(4)})`,
    tilt < 1e-9 && Math.abs(len - 0.96) < 1e-6 && Math.abs(poly.halfWidth - 0.02) < 1e-9,
  );
  // Mitred: the same bar with one end cut at 45°. The axis is still the
  // bar's, and the clip lands inside the outline.
  const mitred = railCentreline({
    kind: "poly",
    verts: [
      new Vec2(-0.5, 0.02),
      new Vec2(-0.5, -0.02),
      new Vec2(0.5, -0.02),
      new Vec2(0.46, 0.02),
    ],
  });
  c.check(
    `a mitred bar keeps its axis (a.y=${mitred.a.y.toFixed(4)}, b.y=${mitred.b.y.toFixed(4)}) and stays inside the cut end (b.x=${mitred.b.x.toFixed(3)} < 0.48)`,
    Math.abs(mitred.a.y) < 0.002 && Math.abs(mitred.b.y) < 0.002 && mitred.b.x < 0.48 && mitred.b.x > 0.44,
  );
  return ok("rail-centreline — a rect's medial axis, a polygon's principal axis, a circle's centre", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// slide-step - the cone arithmetic.
// ---------------------------------------------------------------------------
function caseSlideStep(): RailResult {
  const c = claims();
  const t = Vec2.RIGHT;
  const mus = 0.4;
  const muk = 0.3;
  // A pull 1 m long at 10° off the plumb (across = cos, along = sin): inside a
  // 21.8° static cone, so a stuck ring stays stuck.
  const pull = (deg: number): Vec2 => {
    const r = (deg * Math.PI) / 180;
    return new Vec2(dmath.sin(r), -dmath.cos(r));
  };
  c.check("a pull 10° off the plumb leaves a stuck ring stuck (static cone 21.8°)", slideStep(pull(10), t, false, mus, muk) === 0);
  c.check("...and a RUNNING ring inside the kinetic cone (16.7°) stops", slideStep(pull(10), t, true, mus, muk) === 0);
  const ds = slideStep(pull(30), t, false, mus, muk);
  // The ring runs toward the ball's plumb until the pull meets the kinetic
  // cone: along − muk·across = sin30 − 0.3·cos30.
  const want = dmath.sin(Math.PI / 6) - muk * dmath.cos(Math.PI / 6);
  c.check(`a pull 30° off runs the ring ${want.toFixed(4)} m toward the ball's side (got ${ds.toFixed(4)})`, Math.abs(ds - want) < 1e-12);
  c.check("...and the other way for a ball on the other side", Math.abs(slideStep(pull(-30), t, false, mus, muk) + want) < 1e-12);
  c.check("a running ring at 20° (inside static, outside kinetic) keeps running", slideStep(pull(20), t, true, mus, muk) > 0);
  c.check("a stuck ring at 20° stays stuck", slideStep(pull(20), t, false, mus, muk) === 0);
  c.check("frictionless, the ring goes to the plumb", Math.abs(slideStep(pull(30), t, false, 0, 0) - dmath.sin(Math.PI / 6)) < 1e-12);
  return ok("rail-slide-step — stuck inside the cone, run to the kinetic edge outside it", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// clamp - a thrown hook clamps the bar on its centreline, and the hook body is
// gone; a peg holds the ring at its centre.
// ---------------------------------------------------------------------------
function caseClamp(): RailResult {
  const c = claims();
  const rig = new Rig([bar(0, -120, 1000, 1)]);
  rig.hang(60);
  const clamp = rig.clamp;
  c.check("a hook thrown at a rail comes back as a clamp", clamp !== null);
  if (clamp) {
    const at = clamp.contact.globalPosition;
    c.check(`the anchor is ON the centreline (y=${at.y.toFixed(5)}, want -1.2)`, Math.abs(at.y + 1.2) < 1e-9);
    c.check(`...within the bar (x=${at.x.toFixed(3)})`, Math.abs(at.x) < 0.1);
    c.check("the cuff's axis is the rail's tangent", rig.ball.manacleOnRail && Math.abs(Math.abs(rig.ball.manacleFacing(1)?.x ?? 0) - 1) < 1e-9);
    c.check("the range is the whole bar", clamp.range.min === 0 && Math.abs(clamp.range.max - (10 - 0.03)) < 1e-9);
  }
  c.check("the hook body is out of the world", !rig.level.world.bodies.some((b) => b instanceof BallHook));
  c.check(`no invariant fired while it hung (${rig.violations.length})`, rig.violations.length === 0);

  // A peg: a circle rail. The ring hangs on it and pivots, and does not slide.
  const peg = new Rig([
    {
      kind: "static",
      x: 0,
      y: -120,
      rot: 0,
      friction: 1,
      objects: [{ type: "collision", shape: { kind: "circle", r: 3 }, rail: true }],
    } as LevelBodyData,
  ]);
  peg.hang(120);
  const pc = peg.clamp;
  c.check("a peg is clamped too", pc !== null);
  if (pc) {
    c.check(`...at its centre (${pc.contact.globalPosition.x.toFixed(4)}, ${pc.contact.globalPosition.y.toFixed(4)})`, pc.contact.globalPosition.distanceTo(new Vec2(0, -1.2)) < 1e-9);
    c.check("...with no tangent to slide along", pc.tangent() === null);
    peg.ball.linearVelocity = new Vec2(1, 0);
    let maxLean = 0;
    peg.run(120, () => {
      maxLean = Math.max(maxLean, Math.abs(peg.lean()));
    });
    c.check(`kicked, the ball swings on it (${maxLean.toFixed(1)}°)`, maxLean > 10);
    c.check("...and the anchor never leaves the centre", pc.contact.globalPosition.distanceTo(new Vec2(0, -1.2)) < 1e-9 && pc.s === 0);
  }
  return ok("rail-clamp — the hook clamps a bar on its centreline, and a peg holds the ring at its centre", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// stick - a pull inside the static cone moves the ring by nothing.
// ---------------------------------------------------------------------------
function caseStick(): RailResult {
  const c = claims();
  const rig = new Rig([bar(0, -120, 1000, 1)]);
  rig.hang();
  const clamp = rig.clamp;
  c.check("clamped", clamp !== null);
  if (!clamp) return ok("rail-stick", false, c.details);
  const s0 = clamp.s;
  // A nudge worth an 8° swing on a 1.25 m chain, against a static cone of
  // atan(0.35) = 19.3°: the ring must not move at all.
  rig.ball.linearVelocity = new Vec2(0.5, 0);
  let maxLean = 0;
  let moved = 0;
  rig.run(240, () => {
    maxLean = Math.max(maxLean, Math.abs(rig.lean()));
    moved = Math.max(moved, Math.abs(clamp.s - s0));
  });
  const cone = (dmath.atan(RAIL_STATIC_FRICTION) * 180) / Math.PI;
  c.check(`the ball swings (${maxLean.toFixed(1)}°) inside the static cone (${cone.toFixed(1)}°)`, maxLean > 5 && maxLean < cone);
  c.check(`the ring moved by ${moved.toExponential(2)} m (want 0)`, moved === 0);
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);
  return ok("rail-stick — a pull inside the static cone moves the ring by nothing", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// zipline - frictionless, the ring keeps the chain plumb and the ball coasts.
// ---------------------------------------------------------------------------
function caseZipline(): RailResult {
  const c = claims();
  const rig = new Rig([bar(0, -120, 1200, 0)]);
  rig.hang();
  const clamp = rig.clamp;
  c.check("clamped", clamp !== null);
  if (!clamp) return ok("rail-zipline", false, c.details);
  const v = 3;
  rig.ball.linearVelocity = new Vec2(v, 0);
  const s0 = clamp.s;
  let minVx = Infinity;
  let maxVx = -Infinity;
  let maxLean = 0;
  rig.run(60, () => {
    minVx = Math.min(minVx, rig.ball.linearVelocity.x);
    maxVx = Math.max(maxVx, rig.ball.linearVelocity.x);
    maxLean = Math.max(maxLean, Math.abs(rig.lean()));
  });
  c.check(`the ball coasts: vx stays within 5% of ${v} m/s (${minVx.toFixed(3)}..${maxVx.toFixed(3)})`, minVx > v * 0.95 && maxVx < v * 1.05);
  c.check(`the chain stays plumb (worst lean ${maxLean.toFixed(2)}°)`, maxLean < 2);
  c.check(`the ring travelled with it (${(clamp.s - s0).toFixed(2)} m of ${(v * 1).toFixed(2)})`, clamp.s - s0 > v * 0.9);
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);
  return ok("rail-zipline — frictionless, the ring keeps the chain plumb and the ball coasts", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// friction - a rail with grip lets the ring go past the static cone and then
// brakes the ball, slower than frictionless and no harder than mu_k·g.
// ---------------------------------------------------------------------------
function caseFriction(): RailResult {
  const c = claims();
  const V = 4;
  // The bar's authored friction is chosen so the effective static cone sits at
  // 19°: gentle enough that a 4 m/s ball releases early and settles into a
  // steady slide the closed forms describe, and under 1 so the case also
  // exercises the scaling. At the full coefficients the same kick swings the
  // ball to 45° before the cuff gives way, and the release then frees 30 cm of
  // chain - the ball flies, lands and swings, which is the design (see
  // `RopeClamp.slide`) but is not a steady slide to measure a law against.
  const GRIP = 0.35 / RAIL_STATIC_FRICTION;
  const run = (
    friction: number,
  ): { travel: number; slid: number; maxLean: number; midLean: number; violations: number } => {
    // Thirty metres of bar, so neither run reaches an end.
    const rig = new Rig([bar(0, -120, 3000, friction)]);
    rig.hang();
    const clamp = rig.clamp!;
    rig.ball.linearVelocity = new Vec2(V, 0);
    const s0 = clamp.s;
    let maxLean = 0;
    let travel = 0;
    let midLean = 0;
    rig.run(150, (f) => {
      maxLean = Math.max(maxLean, Math.abs(rig.lean()));
      travel = Math.max(travel, rig.ball.globalPosition.x);
      if (f === 30) midLean = rig.lean();
    });
    return { travel, slid: clamp.s - s0, maxLean, midLean, violations: rig.violations.length };
  };
  const free = run(0);
  const gripped = run(GRIP);
  const muk = RAIL_KINETIC_FRICTION * GRIP;
  const mus = RAIL_STATIC_FRICTION * GRIP;
  const deg = (mu: number): number => (dmath.atan(mu) * 180) / Math.PI;
  // Coulomb's closed form, written against the coefficient rather than a
  // number so the case follows a re-tuned constant: a ball braked at mu_k·g
  // from V stops after V²/(2·mu_k·g).
  const stop = (V * V) / (2 * muk * G);
  c.check(`the ring ran (${gripped.slid.toFixed(2)} m)`, gripped.slid > 1);
  c.check(
    `the ball was braked: ${gripped.travel.toFixed(2)} m of travel against ${free.travel.toFixed(2)} frictionless`,
    gripped.travel < free.travel - 1,
  );
  c.check(
    `...at about mu_k·g: within 0.8..1.25 of Coulomb's ${stop.toFixed(2)} m`,
    gripped.travel > 0.8 * stop && gripped.travel < 1.25 * stop,
  );
  c.check(
    `while running the chain trails at atan(mu_k) = ${deg(muk).toFixed(1)}° (f30: ${gripped.midLean.toFixed(1)}°)`,
    Math.abs(gripped.midLean - deg(muk)) < 1.5,
  );
  c.check(
    `the ring broke away at the static cone, ${deg(mus).toFixed(1)}° (worst lean ${gripped.maxLean.toFixed(1)}°)`,
    gripped.maxLean > deg(mus) && gripped.maxLean < deg(mus) + 6,
  );
  c.check(`no invariant fired (${gripped.violations} + ${free.violations})`, gripped.violations === 0 && free.violations === 0);
  return ok("rail-friction — grip brakes the ball at mu_k·g with the chain trailing at atan(mu_k)", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// range - the lantern: the ring stops where its disc meets the lid, the lid
// itself bounces the hook, and the handle still clamps beside it.
// ---------------------------------------------------------------------------
function lantern(friction: number): LevelBodyData {
  // A 60 cm handle from x = -30 to +30 px, and a 20 cm hook-proof lid from
  // x = 30 to 50, abutting it, both in ONE body.
  return {
    kind: "static",
    x: 0,
    y: -120,
    rot: 0,
    friction,
    objects: [
      { type: "collision", x: 0, y: 0, shape: { kind: "rect", w: 60, h: 2 }, rail: true },
      { type: "collision", x: 40, y: 0, shape: { kind: "rect", w: 20, h: 20 }, impermeable: true },
    ],
  } as LevelBodyData;
}

function caseRange(): RailResult {
  const c = claims();
  const rig = new Rig([lantern(0)]);
  rig.hang();
  const clamp = rig.clamp;
  c.check("the handle clamps", clamp !== null);
  if (!clamp) return ok("rail-range", false, c.details);
  // The medial axis runs x = -0.29..0.29; the cuff's disc meets the lid's face
  // at x = 0.3 when its centre is at 0.3 - MANACLE_DISC.
  const wantMax = 0.3 - MANACLE_DISC + 0.29;
  c.check(`the range is clipped where the cuff meets the lid (max=${clamp.range.max.toFixed(4)}, want ${wantMax.toFixed(4)})`, Math.abs(clamp.range.max - wantMax) < 1e-6);
  c.check("...and open at the far end", clamp.range.min === 0);
  rig.ball.linearVelocity = new Vec2(2, 0);
  let maxS = -Infinity;
  let stillClamped = true;
  rig.run(120, () => {
    maxS = Math.max(maxS, clamp.s);
    if (rig.clamp !== clamp) stillClamped = false;
  });
  c.check(`the ring reached the lid (max s=${maxS.toFixed(4)})`, Math.abs(maxS - clamp.range.max) < 1e-9);
  c.check("...and never past it", maxS <= clamp.range.max + 1e-12);
  c.check("...and is still clamped", stillClamped);
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);

  // The lid itself: a hook thrown straight at it bounces and clamps nothing.
  const lid = new Rig([lantern(0)], 40);
  lid.hang(60);
  const end = lid.ball.chain?.end;
  c.check("a hook thrown at the hook-proof lid does not anchor", lid.ball.chain === null || end?.contact.obj instanceof BallHook);
  return ok("rail-range — the ring stops where its disc meets the lid, which the hook itself bounces off", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// joint - the ring crosses from one rail piece onto the next.
// ---------------------------------------------------------------------------
function caseJoint(): RailResult {
  const c = claims();
  // A: level, x = -200..3 px at y = -120. B: rising 15° to the right from A's
  // end, 207 px long, its centre a metre right and up the slope.
  const rise = Math.PI / 12;
  const bLen = 200 / dmath.cos(rise);
  const body: LevelBodyData = {
    kind: "static",
    x: 0,
    y: -120,
    rot: 0,
    friction: 0,
    objects: [
      { type: "collision", x: -98.5, y: 0, shape: { kind: "rect", w: 203, h: 3 }, rail: true },
      {
        type: "collision",
        x: 100,
        y: -100 * dmath.tan(rise),
        rot: -rise,
        shape: { kind: "rect", w: bLen, h: 3 },
        rail: true,
      },
    ],
  } as LevelBodyData;
  const rig = new Rig([body], -150);
  rig.hang();
  const clamp = rig.clamp;
  c.check("clamped on the level bar", clamp !== null && clamp.contact.shapeIndex === 0);
  if (!clamp) return ok("rail-joint", false, c.details);
  rig.ball.linearVelocity = new Vec2(2.5, 0);
  let crossedAt = -1;
  rig.run(90, (f) => {
    if (crossedAt < 0 && clamp.contact.shapeIndex === 1) crossedAt = f;
  });
  c.check(`the ring crossed the joint onto the rising bar (at f${crossedAt})`, crossedAt >= 0);
  c.check("...and is still on it", rig.clamp === clamp && clamp.contact.shapeIndex === 1);
  c.check(`the ball went up the slope (x=${rig.ball.globalPosition.x.toFixed(2)})`, rig.ball.globalPosition.x > 0.5);
  const anchor = clamp.contact.globalPosition;
  const expectedY = -1.2 - anchor.x * dmath.tan(rise);
  c.check(`the anchor is on B's centreline (y=${anchor.y.toFixed(4)}, want ${expectedY.toFixed(4)})`, Math.abs(anchor.y - expectedY) < 2e-3);
  c.check(`no invariant fired (${rig.violations.length})`, rig.violations.length === 0);
  return ok("rail-joint — the ring runs off one bar's end onto the next", c.passed(), c.details);
}

// ---------------------------------------------------------------------------
// format - the flag survives every gate a level passes through, and hook-proof
// wins over it.
// ---------------------------------------------------------------------------
function caseFormat(): RailResult {
  const c = claims();
  const raw = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        objects: [
          { type: "collision", x: 0, y: 0, shape: { kind: "rect", w: 100, h: 4 }, rail: true },
          { type: "collision", x: 100, y: 0, shape: { kind: "rect", w: 20, h: 20 } },
          { type: "collision", x: 200, y: 0, shape: { kind: "rect", w: 100, h: 4 }, rail: true, impermeable: true },
        ],
      },
    ],
  } as RawLevelData;
  const data = scaleLevelData(raw, PX);
  const objs = data.bodies[0]!.objects.filter(isCollisionObject);
  c.check("scaleLevelData carries `rail` through px -> m", objs[0]!.rail === true && objs[1]!.rail === undefined && objs[2]!.rail === true);
  const world = new World();
  const built = buildLevelBodies(world, data, () => {});
  const shapes = built.bodies[0]!.body!.getShapes();
  c.check("the build sets `rail` on exactly the pieces that authored it", shapes[0]!.rail && !shapes[1]!.rail && shapes[2]!.rail);
  // Hook-proof wins: a hook thrown at the third piece is deflected, never clamped.
  const hook = new BallHook();
  hook.globalPosition = new Vec2(2, 0.5);
  hook.linearVelocity = new Vec2(0, -BallPlayer.HOOK_SPEED);
  let attached = false;
  hook.registerAttachmentCallback(() => {
    attached = true;
  });
  world.add(hook);
  for (let f = 0; f < 30 && !attached; f++) {
    hook.physicsStep(DT);
    if (attached) break;
    world.integrate(DT);
    hook.physicsStep(DT);
  }
  c.check("a hook-proof rail deflects the hook (hook-proof wins)", !attached);
  // The editor's round trip.
  const rt = modelToDisk(modelFromDisk(raw));
  const rtObjs = rt.bodies[0]!.objects.filter(isCollisionObject);
  c.check("the editor's modelFromDisk/modelToDisk keeps the flag", rtObjs[0]!.rail === true && rtObjs[1]!.rail === undefined);
  return ok("rail-format — the flag survives the format, the build and the editor, and hook-proof wins", c.passed(), c.details);
}

export function runRailCases(): RailResult[] {
  return [
    caseCentreline(),
    caseSlideStep(),
    caseClamp(),
    caseStick(),
    caseZipline(),
    caseFriction(),
    caseRange(),
    caseJoint(),
    caseFormat(),
  ];
}

// Referenced so a future case can reach for them without re-importing; the
// suite's rig is the ball level and these are what a bare-world case needs.
export type { PhysicsBody2D, RigidBody2D, Shape };
