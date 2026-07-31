// Rigid-body contact cases: hand-built scenes with the answer written down, run
// by `cli contacts`.
//
// These are the scenarios every resting-contact and pair-solver fix has been
// validated against. They used to live in a scratch directory and be re-derived
// by hand each time, which means the baseline was recorded in a chat log rather
// than in the repo. They are pure physics - a `World`, some geometry and a fixed
// number of steps - so they need no level, no input trace and no bundle, and a
// regression shows up here as a number rather than as a rope in a wall four
// hundred frames into a recording.
//
// Every assertion is a BOUND, never an exact number. The sim is deterministic,
// so exact values would pass trivially and then fail on any change that is
// physically fine; what these cases are for is "does a box hold a 20 degree ramp
// and slide off a 40 degree one", which is a statement about bounds.

import { Vec2 } from "../engine/vec2";
import { wrapAngle } from "../engine/mathf";
import {
  ForceArea,
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
  type CollisionObject2D,
} from "../engine/body";
import { circleOverlap } from "../engine/collision";
import { shapeContacts } from "../engine/manifold";
import { circleShape, polyShapeCentred, rectShape, type Shape } from "../engine/shapes";
import { ContactAudit, World } from "../engine/world";
import { MATERIALS, ShapeGeometry } from "../lib/shapeGeometry";
import { BallPlayer } from "../classes/ballPlayer";
import { BallHook } from "../classes/ballHook";
import { Hook } from "../classes/hook";
import { buildLevelBodies, RIGID_KINETIC_FRICTION, RIGID_STATIC_FRICTION } from "../level/buildBodies";
import { backgroundTransform, buildSceneBackgrounds } from "../level/backgrounds";
import {
  scaleLevelData,
  type BackgroundData,
  type LevelBodyData,
  type LevelData,
} from "../level/levelFormat";
import { SceneChain, stepSceneChains } from "../level/chains";
import { RopeContact } from "../lib/ropeContact";

const DT = 1 / 60;
const DEG = Math.PI / 180;
// Standing overlap the scenes are allowed to leave. The polygon corpus sits at
// or under this, and `penetration` is what keeps it there when momentum transfer
// starts shoving bodies into each other harder.
const MAX_PENETRATION = 0.005;

export interface ContactResult {
  name: string;
  passed: boolean;
  details: string[];
  // A case that is red ON PURPOSE - a known gap with the diagnosis written down
  // above it, not a regression. The runner counts it as a pass so the exit code
  // can gate a change, and FAILS if it ever passes: a stale marker is a lie
  // about coverage, and the fix that closes the gap has to remove the marker in
  // the same change.
  expectedFail?: true;
}

// A scene under test: a world, the bodies in it, and the deepest standing
// overlap seen at the end of any frame. Penetration is tracked here rather than
// per case because it is an invariant of ALL of them (see `penetration`), and a
// case that asserts a body settles while standing 2 cm inside the floor has not
// shown what it claims to.
class Sim {
  readonly world = new World();
  // Deepest overlap once the scene has stopped landing, and the deepest at any
  // point including the impact frames. Only the first is asserted on: what
  // `penetration` is about is STANDING overlap, and a pile of four boxes dropped
  // onto each other is briefly deep inside itself on the frames it lands, which
  // is the positional sweep having work to do rather than a body left embedded.
  // The transient is reported anyway, because a change that starts slamming
  // bodies 20 cm into each other is worth seeing even when it recovers.
  maxPenetration = 0;
  maxPenetrationFrame = 0;
  peakPenetration = 0;
  private frame = 0;

  // `standingFrom` is the frame this scene is expected to have finished landing
  // by; overlap before it counts as transient.
  constructor(
    readonly label: string,
    private readonly standingFrom = 0,
  ) {}

  addStatic(shape: Shape, pos: Vec2, rot = 0, friction = 1): StaticBody2D {
    const b = new StaticBody2D();
    b.globalPosition = pos;
    b.globalRotation = rot;
    b.setShape(shape);
    b.surfaceFriction = friction;
    this.world.add(b);
    return b;
  }

  // A rigid body carrying the coefficients an authored `rigid` level body gets
  // (see buildBodies.ts). The class defaults are 0 and must stay 0 for recorded
  // replays, so a case built on the raw defaults would be testing a frictionless
  // world no level contains.
  addRigid(shape: Shape, pos: Vec2, rot = 0): RigidBody2D {
    const b = new RigidBody2D();
    b.globalPosition = pos;
    b.globalRotation = rot;
    b.setShape(shape);
    b.mass = ShapeGeometry.computeMass(b.primaryShape());
    b.inertia = ShapeGeometry.computeMomentOfInertia(b.primaryShape(), b.mass);
    b.contactFriction = RIGID_KINETIC_FRICTION;
    b.staticFriction = RIGID_STATIC_FRICTION;
    this.world.add(b);
    return b;
  }

  // As `addRigid`, but for an authored vertex loop: the loop is re-centred on its
  // area centroid and the removed offset is added back to the position, exactly
  // as the level loader does it, so the body's origin is its centre of mass (which
  // every lever arm in the engine assumes) and the geometry still lands where it
  // was written.
  addRigidPoly(verts: Vec2[], pos: Vec2, rot = 0): RigidBody2D {
    const made = polyShapeCentred(verts);
    return this.addRigid(made.shape, pos.add(made.offset.rotated(rot)), rot);
  }

  step(frames: number, onFrame?: (n: number) => void): void {
    for (let i = 0; i < frames; i++) {
      this.world.integrate(DT);
      this.frame++;
      const deepest = deepestOverlap(this.world);
      this.peakPenetration = Math.max(this.peakPenetration, deepest);
      if (this.frame > this.standingFrom && deepest > this.maxPenetration) {
        this.maxPenetration = deepest;
        this.maxPenetrationFrame = this.frame;
      }
      onFrame?.(i + 1);
    }
  }
}

// The deepest overlap anywhere in the scene, measured at the end of a frame -
// after `resolveDynamicCollisions` has run its positional recovery sweep, so this
// is standing penetration and not the mid-step overlap the solve exists to
// remove.
function deepestOverlap(world: World): number {
  let max = 0;
  for (const body of world.bodies) {
    if (!(body instanceof RigidBody2D) || body.removed) continue;
    for (const bs of body.getShapes()) {
      for (const other of world.bodies) {
        if (other === body || other.removed) continue;
        if (!(other instanceof StaticBody2D || other instanceof RigidBody2D)) continue;
        for (const os of other.getShapes()) {
          if (bs.shape.kind === "circle") {
            const ov = circleOverlap(bs.globalPosition, bs.shape.radius, os);
            if (ov) max = Math.max(max, ov.depth);
          } else {
            for (const c of shapeContacts(bs, os)) max = Math.max(max, c.depth);
          }
        }
      }
    }
  }
  return max;
}

// A floor wide enough that nothing in these scenes runs off the end of it.
function floor(sim: Sim): StaticBody2D {
  return sim.addStatic(rectShape(40, 1), Vec2.ZERO);
}

// Peak-to-trough spread of a rotation history, taken through `wrapAngle` so a
// body sitting on ±π reads as still rather than as having spun a full turn.
function rotationSpan(history: number[]): number {
  const base = history[0] ?? 0;
  let lo = 0;
  let hi = 0;
  for (const r of history) {
    const d = wrapAngle(r - base);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return hi - lo;
}

function ok(name: string, passed: boolean, details: string[]): ContactResult {
  return { name, passed, details };
}

// As `ok`, for a case whose failure is a known gap rather than a regression.
// No case carries this today - `rigid-ramp-hold` was the last one, and the
// relative position pin closed it. It stays because the rule it encodes is what
// makes marking the next gap safe: the runner counts an expected failure as a
// pass and FAILS on one that passes, so a marker cannot outlive the gap it
// documents.
function expectedFail(name: string, passed: boolean, details: string[]): ContactResult {
  return { name, passed, details, expectedFail: true };
}

// ---------------------------------------------------------------------------
// settle: four awkward convex shapes dropped on a floor must come to rest.
//
// Awkward on purpose - a triangle, a five-sided blob, a thin sliver and a
// trapezoid, each dropped at its own angle. A box landing flat on a floor is the
// easy case; what has repeatedly failed is a shape that lands on a corner, has
// to turn onto a face, and must then stop turning.
// ---------------------------------------------------------------------------
function caseSettle(sims: Sim[]): ContactResult {
  const sim = new Sim("settle", 480);
  sims.push(sim);
  floor(sim);
  const bodies = [
    sim.addRigidPoly(
      [new Vec2(-0.5, 0.35), new Vec2(0.55, 0.4), new Vec2(0, -0.45)],
      new Vec2(-6, -2),
      0.3,
    ),
    sim.addRigidPoly(
      [
        new Vec2(-0.4, 0.3),
        new Vec2(-0.5, -0.1),
        new Vec2(0, -0.45),
        new Vec2(0.5, -0.05),
        new Vec2(0.35, 0.35),
      ],
      new Vec2(-2, -2),
      -0.7,
    ),
    sim.addRigid(rectShape(1.4, 0.12), new Vec2(2, -2), 0.5),
    sim.addRigidPoly(
      [new Vec2(-0.6, 0.3), new Vec2(0.6, 0.3), new Vec2(0.35, -0.3), new Vec2(-0.3, -0.3)],
      new Vec2(6, -2),
      1.2,
    ),
  ];

  // 900 frames, measured over the last 120: the residual these bodies leave is a
  // slow limit cycle rather than a decaying transient, so a window taken while
  // they are still coming to rest reads a slice of the settling instead of the
  // amplitude that is actually there for good.
  const history = bodies.map<number[]>(() => []);
  sim.step(900, (n) => {
    if (n > 780) bodies.forEach((b, i) => history[i]!.push(b.globalRotation));
  });

  const details: string[] = [];
  let passed = true;
  bodies.forEach((b, i) => {
    const span = rotationSpan(history[i]!) / DEG;
    const w = Math.abs(b.angularVelocity);
    const good = w < 0.01 && span < 0.2;
    passed &&= good;
    details.push(`${good ? "ok  " : "BAD "} body${i}: |w|=${w.toFixed(4)} span=${span.toFixed(3)}deg`);
  });
  return ok("settle — four awkward polygons come to rest on a floor", passed, details);
}

// ---------------------------------------------------------------------------
// stack: four boxes dropped into a pile must settle ON EACH OTHER.
//
// The rigid-vs-rigid case of `settle`, and the one momentum transfer is most
// likely to destabilise: a pile that currently sits still because nothing drives
// it may start moving once the contacts actually exchange impulses.
//
// The pile has to be asserted as a PILE, not merely as four settled bodies.
// Checking |w| and the rotation span alone passes vacuously if the stack blows
// apart and the pieces come to rest side by side on the floor, which is exactly
// what a cold-started solver does with it: the boxes shot sideways between f60
// and f120 and finished spread across a metre and a half of floor, every one of
// them perfectly still and perfectly level.
// ---------------------------------------------------------------------------
function caseStack(sims: Sim[]): ContactResult {
  const sim = new Sim("stack", 480);
  sims.push(sim);
  floor(sim);
  // 0.51 apart against a 0.5 height: 1 cm of drop each, so the pile lands rather
  // than starting in contact.
  const bodies = [-0.76, -1.27, -1.78, -2.29].map((y) =>
    sim.addRigid(rectShape(0.9, 0.5), new Vec2(0, y)),
  );
  // Where each box belongs once the pile has landed: the floor's top face is at
  // -0.5 and the boxes are 0.5 tall, so they stack at -0.75, -1.25, -1.75, -2.25.
  const restY = [-0.75, -1.25, -1.75, -2.25];

  const history = bodies.map<number[]>(() => []);
  sim.step(900, (n) => {
    if (n > 780) bodies.forEach((b, i) => history[i]!.push(b.globalRotation));
  });

  const details: string[] = [];
  let passed = true;
  bodies.forEach((b, i) => {
    const span = rotationSpan(history[i]!) / DEG;
    const w = Math.abs(b.angularVelocity);
    const dx = Math.abs(b.globalPosition.x);
    const dy = Math.abs(b.globalPosition.y - restY[i]!);
    const held = dx < 0.15 && dy < 0.05;
    const good = held && w < 0.01 && span < 0.2;
    passed &&= good;
    details.push(
      `${good ? "ok  " : "BAD "} box${i}: |w|=${w.toFixed(4)} span=${span.toFixed(3)}deg ` +
        `${held ? "held" : "SLID"} off=(${dx.toFixed(2)},${dy.toFixed(2)})m`,
    );
  });
  return ok("stack — a four-box pile settles on itself", passed, details);
}

// A box resting exactly on the surface of a ramp inclined by `deg`. The ramp's
// top face is its local y = -h/2, so the box centre is that point pushed out
// along the face normal by its own half-height.
function rampScene(sims: Sim[], deg: number): { sim: Sim; box: RigidBody2D } {
  const sim = new Sim(`ramp ${deg}deg`, 120);
  sims.push(sim);
  const th = deg * DEG;
  sim.addStatic(rectShape(40, 1), Vec2.ZERO, th);
  const box = sim.addRigid(rectShape(0.8, 0.5), new Vec2(0, -0.75).rotated(th), th);
  return { sim, box };
}

// ---------------------------------------------------------------------------
// ramp-hold: a box on a ramp gentler than its breakaway angle must stay put.
//
// The breakaway angle is atan(mu_s) ~ 35 degrees, so 5, 20 and 30 all hold. What
// this catches is the creep that kinetic friction alone cannot stop: Coulomb
// friction is capped at mu times the frame's normal impulse, which on a resting
// body is one frame of gravity, so it cancels the velocity gravity adds and never
// the step the integrator already took with it. Held only that way, a box on a
// 5 degree ramp walked 21 cm in fifteen seconds and was not slowing.
// ---------------------------------------------------------------------------
function caseRampHold(sims: Sim[]): ContactResult {
  const details: string[] = [];
  let passed = true;
  for (const deg of [5, 20, 30]) {
    const { sim, box } = rampScene(sims, deg);
    const start = box.globalPosition;
    sim.step(900); // 15 s
    const drift = box.globalPosition.distanceTo(start);
    const good = drift < 0.1;
    passed &&= good;
    details.push(`${good ? "ok  " : "BAD "} ${deg}deg: drift=${(drift * 100).toFixed(1)}cm in 15s`);
  }
  return ok("ramp-hold — a box holds 5, 20 and 30 degree ramps", passed, details);
}

// ---------------------------------------------------------------------------
// ramp-break: past the breakaway angle the same box must let go.
//
// The other half of `ramp-hold`, and the reason the grip may not simply be made
// stronger: a grip that holds everything is a weld, and a body welded to the
// ground is immovable by anything that lands on it.
// ---------------------------------------------------------------------------
function caseRampBreak(sims: Sim[]): ContactResult {
  const { sim, box } = rampScene(sims, 40);
  const start = box.globalPosition;
  sim.step(300); // 5 s
  const slide = box.globalPosition.distanceTo(start);
  const good = slide > 0.5;
  return ok("ramp-break — a box slides on a 40 degree ramp", good, [
    `${good ? "ok  " : "BAD "} 40deg: slid=${(slide * 100).toFixed(1)}cm in 5s (want >50cm)`,
  ]);
}

// ---------------------------------------------------------------------------
// topple: a box dropped tilted must land and rock flat.
//
// Both angles are inside the box's own balance point (a 1.0 x 0.6 box tips past
// its corner at about 59 degrees), so both must end lying flat rather than
// stalling part-way over. Stalling is what a pose lock looks like: freezing a
// gripped body's spin holds its orientation by fiat, and gravity gets no say.
// ---------------------------------------------------------------------------
function caseTopple(sims: Sim[]): ContactResult {
  const details: string[] = [];
  let passed = true;
  for (const deg of [20, 40]) {
    const sim = new Sim(`topple ${deg}deg`, 300);
    sims.push(sim);
    floor(sim);
    const box = sim.addRigid(rectShape(1, 0.6), new Vec2(0, -1.5), deg * DEG);
    sim.step(600);
    const rot = Math.abs(wrapAngle(box.globalRotation)) / DEG;
    const good = rot < 1;
    passed &&= good;
    details.push(`${good ? "ok  " : "BAD "} dropped at ${deg}deg: settled at ${rot.toFixed(2)}deg`);
  }
  return ok("topple — a box dropped tilted settles flat", passed, details);
}

// ---------------------------------------------------------------------------
// pivot: a tall slab tipped past balance must actually fall over.
//
// The opposite failure to `topple`. A slab standing at 20 degrees is well past
// its 7 degree balance point and has a whole metre of lever to fall through, so
// it should whip round; energy says the peak is about 3.5 rad/s. Anything that
// damps a gripped body's spin turns this into a slow creep instead.
// ---------------------------------------------------------------------------
function casePivot(sims: Sim[]): ContactResult {
  const sim = new Sim("pivot", 200);
  sims.push(sim);
  floor(sim);
  const slab = sim.addRigid(rectShape(0.25, 2), new Vec2(0, -1.5), 20 * DEG);
  let peak = 0;
  sim.step(300, () => {
    peak = Math.max(peak, Math.abs(slab.angularVelocity));
  });
  const good = peak > 2;
  return ok("pivot — a slab tipped past balance falls over", good, [
    `${good ? "ok  " : "BAD "} peak |w|=${peak.toFixed(2)} rad/s (want >2)`,
  ]);
}

// ---------------------------------------------------------------------------
// impact-transfer: the case this whole exercise exists for.
//
// A slab balanced on a narrow fulcrum, struck off-centre by a falling box. The
// impact must SPIN the slab, and spin it the way the blow points: the box lands
// left of the pivot, so the torque about the slab's centre is negative.
//
// The fulcrum is what makes the answer unambiguous. A slab lying on the floor
// cannot rotate into the floor, so a floor-resting target confounds "the impact
// drove nothing" with "the geometry refused"; balanced on a 20 cm support the
// slab is free to turn either way and the only thing that can turn it is the
// blow.
//
// The defect this catches is that two independent one-sided solves are not an
// impulse pair: each body cancels its own approach at the shared contact and
// neither drives the other, so a body landing on another STOPS it instead of
// knocking it round (session-120f).
// ---------------------------------------------------------------------------
function caseImpactTransfer(sims: Sim[]): ContactResult {
  const sim = new Sim("impact-transfer", 120);
  sims.push(sim);
  floor(sim);
  sim.addStatic(rectShape(0.2, 0.4), new Vec2(0, -0.7));
  const slab = sim.addRigid(rectShape(2, 0.2), new Vec2(0, -1));
  sim.addRigid(rectShape(0.5, 0.5), new Vec2(-0.8, -3));

  // Let the balanced slab settle before the box reaches it, then watch the strike.
  let peak = 0;
  sim.step(240, () => {
    if (Math.abs(slab.angularVelocity) > Math.abs(peak)) peak = slab.angularVelocity;
  });

  // Right sign (the blow lands left of the pivot, so the torque is negative) and
  // a magnitude in the range an inelastic strike at that lever gives - about
  // 4 rad/s, so a band of 0.5 to 20 asserts "really driven" without pinning the
  // solver to a number.
  const good = peak < -0.5 && peak > -20;
  return ok("impact-transfer — a dropped body spins the body it lands on", good, [
    `${good ? "ok  " : "BAD "} struck slab peak w=${peak.toFixed(3)} rad/s (want -20 < w < -0.5)`,
  ]);
}

// ---------------------------------------------------------------------------
// momentum: the invariant a pair solver gives that no one-sided solve can.
//
// Two boxes colliding in free space. Whatever the contact does, it is internal
// to the pair, so across every frame of the impact the pair's total linear
// momentum may change by exactly gravity's impulse and by nothing else.
//
// Free space rather than the `impact-transfer` scene on purpose: a struck body
// resting on the floor is exchanging momentum with the whole planet through that
// contact, so the pair's total is not conserved there and the check would be
// measuring the floor. Here the two bodies touch nothing but each other.
//
// `contactDamp` is switched off for the same reason. It is a nonphysical
// per-frame drag kept because its default is replay-locked (see the deliberate
// deviations in docs/pair-solver-plan.md), and it destroys momentum by
// construction - which says nothing about whether the contact impulse is a pair.
// ---------------------------------------------------------------------------
function caseMomentum(sims: Sim[]): ContactResult {
  const sim = new Sim("momentum", 30);
  sims.push(sim);
  const a = sim.addRigid(rectShape(0.6, 0.6), new Vec2(0, -5));
  const b = sim.addRigid(rectShape(0.6, 0.6), new Vec2(0.05, -3));
  a.contactDamp = 1;
  b.contactDamp = 1;
  a.linearVelocity = new Vec2(0, 8); // y is down: a catches b from above

  const totalMass = a.mass + b.mass;
  const gravityStep = 9.8 * totalMass * DT;
  const momentum = (): Vec2 => a.linearVelocity.mul(a.mass).add(b.linearVelocity.mul(b.mass));

  let prev = momentum();
  let scale = prev.length();
  let worst = 0;
  let worstFrame = 0;
  sim.step(120, (n) => {
    const now = momentum();
    // Gravity is the only external impulse, and it is straight down.
    const err = now.sub(prev).sub(new Vec2(0, gravityStep)).length();
    if (err > worst) {
      worst = err;
      worstFrame = n;
    }
    scale = Math.max(scale, now.length());
    prev = now;
  });

  const tol = 1e-12 + 1e-6 * scale;
  const good = worst <= tol;
  return ok("momentum — a colliding pair conserves momentum up to gravity", good, [
    `${good ? "ok  " : "BAD "} worst frame error=${worst.toExponential(2)} @f${worstFrame} ` +
      `(tol=${tol.toExponential(2)}, peak |p|=${scale.toExponential(2)})`,
  ]);
}

// ---------------------------------------------------------------------------
// rigid-ramp-hold: `ramp-hold`, with the ramp made of scenery instead of world.
//
// Identical geometry, identical coefficients; the only difference is that the
// ramp is a rigid body, so the resting contact gets no position pin. RED, and
// the next piece of work: the pin is what holds a slope at all, because kinetic
// friction cancels the velocity gravity adds each frame and never the *step* the
// integrator already took with it, and this engine integrates before it solves.
// The per-frame leak is g*sin(theta)*dt^2, which at 5 degrees comes to the 22 cm
// measured here almost exactly.
//
// It stays body-versus-static today because a pin writes position, and against
// another dynamic body the honest form is a pin on the pair's RELATIVE position,
// split by inverse mass - along with an answer to what "gripped" even means for
// two bodies that are both free to move. The pair solver is what makes that
// possible (the old objection, that the pin would fight the other body's own
// resolution pass, no longer applies - there is no other pass), but it is a
// design question and not a port of the static one.
//
// Getting it wrong is worse than the creep: a grip that holds everything is a
// weld, and a welded body is immovable by anything that lands on it.
// ---------------------------------------------------------------------------
function caseRigidRampHold(sims: Sim[]): ContactResult {
  const details: string[] = [];
  let passed = true;
  for (const deg of [5, 20]) {
    const sim = new Sim(`rigid ramp ${deg}deg`, 120);
    sims.push(sim);
    const th = deg * DEG;
    // A heavy, gravity-free slab: it stands in for scenery that stays put, so
    // the case measures the resting contact and not the ramp falling over.
    const ramp = sim.addRigid(rectShape(40, 1), Vec2.ZERO, th);
    ramp.mass *= 50;
    ramp.inertia *= 50;
    ramp.gravityScale = 0;
    const box = sim.addRigid(rectShape(0.8, 0.5), new Vec2(0, -0.75).rotated(th), th);
    const start = box.globalPosition;
    sim.step(900);
    const drift = box.globalPosition.distanceTo(start);
    const good = drift < 0.1;
    passed &&= good;
    details.push(`${good ? "ok  " : "BAD "} ${deg}deg: drift=${(drift * 100).toFixed(1)}cm in 15s`);
  }
  // Green since the position pin became a RELATIVE one (`applyStaticGrip`): the
  // anchor is a material point of the surface, in the surface's own frame, so it
  // says the same thing about a rigid ramp that it always said about a static
  // one, and the correction is split by inverse mass and capped at mu times the
  // frame's normal impulse so it stays friction rather than a weld. It carried an
  // `expectedFail` marker for as long as the gap was open, and the marker came
  // off in the change that closed it - the runner fails a case that passes while
  // still carrying one, because a stale marker is a lie about coverage.
  return ok("rigid-ramp-hold — a box holds a ramp made of scenery", passed, details);
}

// ---------------------------------------------------------------------------
// spin-drive: a spinning ball resting on a crate must not drive it away.
//
// The sibling `impact-transfer` needs, and the one case the pair solver makes
// newly dangerous. Measuring slip between the two contact points - the standard
// formulation - is only legitimate because a pair impulse is equal and opposite,
// so the reaction is real. For the ball it is not: its spin is KINEMATIC, the aim
// steering overwrites `angularVelocity` every frame, so the angular half of the
// reaction is discarded the moment it is applied. A friction constraint reading a
// velocity it can never affect is not a brake but a motor, and an unbounded one -
// which is how a ball merely hanging on a chain walked its anchor 3.6 m across a
// level (session-611f).
//
// What bounds it is the Coulomb cone, and nothing else can. The ball's spin is an
// infinite reservoir - the steering refills it every frame regardless of what the
// contact does - so the slip it presents is a conveyor belt, and that is the
// INTENDED mechanic (see `roll-drive`). The guard is that the belt is
// friction-capped: the ball can spend `mu` times its own weight, while the crate's
// grip on the ground is `mu_s` times the weight of the crate AND the ball riding
// it, which is strictly more. So the crate holds.
//
// Taking the spin out of the friction slip instead is the tempting fix and it is
// wrong: it makes this case pass by making the ball unable to drive ANYTHING,
// which is the same statement as being unable to roll along scenery
// (`session-314f`, where a ball spinning at 20 rad/s on a rigid body sat at a
// dead stop). The two are one mechanism and cannot be separated.
// ---------------------------------------------------------------------------
function caseSpinDrive(sims: Sim[]): ContactResult {
  const sim = new Sim("spin-drive", 60);
  sims.push(sim);
  floor(sim);
  const crate = sim.addRigid(rectShape(1, 0.6), new Vec2(0, -0.8));
  const ball = sim.addRigid(circleShape(0.3), new Vec2(0, -1.4));
  ball.kinematicRotation = true;

  sim.step(1200, () => {
    // What aim steering does: rewrite the spin every frame, so no contact
    // impulse can ever slow it.
    ball.angularVelocity = 20;
  });

  const drift = Math.abs(crate.globalPosition.x);
  const speed = Math.abs(crate.linearVelocity.x);
  const good = drift < 0.1 && speed < 0.05;
  return ok("spin-drive — a spinning ball does not overpower the crate's own grip", good, [
    `${good ? "ok  " : "BAD "} crate driven ${(drift * 100).toFixed(1)}cm in 20s at a final ` +
      `${speed.toFixed(4)} m/s (want <10cm, <0.05 m/s)`,
  ]);
}

// ---------------------------------------------------------------------------
// roll-drive: a steered ball must roll along scenery exactly as along the world.
//
// The other half of `spin-drive`, and the one it is easy to break while
// tightening that one. The ball's rotation is a control input with no force
// behind it, so a contact cannot slow it; friction reading that spin as surface
// motion is what converts it into travel, and it has to do so against a rigid
// body just as it does against a static one.
//
// Excluding a kinematic spin from the friction slip - on the argument that a
// contact should not read a velocity it cannot affect - passes `spin-drive` and
// breaks this outright: the ball rolled 49.5 m along a static floor and 0.0 cm
// along the identical floor made of scenery, spinning at 20 rad/s the whole way
// (`session-314f`).
// ---------------------------------------------------------------------------
function caseRollDrive(sims: Sim[]): ContactResult {
  const travel = (rigidFloor: boolean): number => {
    const sim = new Sim(rigidFloor ? "roll-drive rigid" : "roll-drive static", 60);
    sims.push(sim);
    if (rigidFloor) {
      // Scenery to roll along: heavy and gravity-free, so the case measures the
      // ball's traction and not the floor being shoved out from under it. It
      // rests on the static base below, exactly as level scenery does.
      sim.addStatic(rectShape(200, 1), new Vec2(0, 2));
      const slab = sim.addRigid(rectShape(200, 1), Vec2.ZERO);
      slab.mass *= 200;
      slab.inertia *= 200;
      slab.gravityScale = 0;
    } else {
      sim.addStatic(rectShape(200, 1), Vec2.ZERO);
    }
    // The ball's own coefficients, not scenery's - it is a rolling body.
    const ball = sim.addRigid(circleShape(0.25), new Vec2(0, -0.75));
    ball.contactFriction = 1.8;
    ball.staticFriction = 0.58;
    ball.contactDamp = 0.99;
    ball.kinematicRotation = true;
    sim.step(600, () => {
      ball.angularVelocity = 20;
    });
    return ball.globalPosition.x;
  };

  const onStatic = travel(false);
  const onRigid = travel(true);
  // Rolls at all, and within a quarter of what the world gives it.
  const good = onRigid > 1 && onRigid > onStatic * 0.75;
  return ok("roll-drive — a steered ball rolls along scenery as it does along the world", good, [
    `${good ? "ok  " : "BAD "} travelled ${(onRigid * 100).toFixed(0)}cm on a rigid floor ` +
      `against ${(onStatic * 100).toFixed(0)}cm on a static one, in 10s`,
  ]);
}

// ---------------------------------------------------------------------------
// impulse-pairing: every velocity the contact phase writes came from a pair.
//
// `momentum` pins the aggregate at machine precision, which is the strongest
// statement available about two bodies in free space and says nothing at all
// about a scene with a floor in it: a one-sided write is absorbed silently by
// whatever infinite mass is nearby. This is the same statement per body - each
// body's momentum change across the solve equals the impulses handed to it and
// nothing else - and it is checked in EVERY scene above rather than in a scene
// of its own, because the defect it exists for (rigid-rigid friction sized from
// a motion it could not answer, session-611f) only appears where the geometry
// is awkward.
// ---------------------------------------------------------------------------
function caseImpulsePairing(): ContactResult {
  const violations = ContactAudit.violations;
  const good = violations.length === 0;
  const details = good
    ? ["ok   every contact-phase velocity change is accounted for by a pair impulse"]
    : violations.slice(0, 5).map((v) => `BAD  ${v}`);
  if (violations.length > 5) details.push(`     … ${violations.length - 5} more`);
  return ok("impulse-pairing — the contact solve writes only what it applied", good, details);
}

// ---------------------------------------------------------------------------
// penetration: nothing above may hold its answer while standing inside geometry.
//
// Aggregated across every scene rather than asserted per case, because it is a
// property of all of them: a case that reports a body settled while it is 2 cm
// inside the floor has not shown what it claims to. Momentum transfer shoves
// bodies into each other harder, so this is the number expected to move first if
// the positional sweep needs replacing.
// ---------------------------------------------------------------------------
function casePenetration(sims: Sim[]): ContactResult {
  const ranked = [...sims].sort((x, y) => y.maxPenetration - x.maxPenetration);
  const passed = ranked.every((s) => s.maxPenetration <= MAX_PENETRATION);
  // The three deepest, named: "something somewhere overlapped by 48 mm" is not
  // enough to act on, and the offender is rarely the scene being changed.
  const details = ranked
    .slice(0, 3)
    .map(
      (s) =>
        `${s.maxPenetration <= MAX_PENETRATION ? "ok  " : "BAD "} ${s.label}: ` +
        `standing ${(s.maxPenetration * 1000).toFixed(2)}mm @f${s.maxPenetrationFrame}` +
        `, transient peak ${(s.peakPenetration * 1000).toFixed(2)}mm`,
    );
  details.push(`     ${sims.length} scenes, limit ${MAX_PENETRATION * 1000}mm`);
  return ok("penetration — no scene stands more than 5 mm inside geometry", passed, details);
}

// ---------------------------------------------------------------------------
// loop-hop: driving the mounting loop into the ground must hop the ball by the
// same amount every time, for the same spin.
//
// The loop is a second collision circle offset on the ball's rim, so unlike the
// ball's own surface its contact point carries a NORMAL component of omega x r -
// and the spin is kinematic, so the solver may not take that energy back out of
// it. Every bit of it therefore lands in the ball's linear velocity, sized by
// where in its arc the loop happened to be at the instant it touched. That is
// the mechanic the player likes (hit the loop into the ground and bounce) with
// its magnitude set by the one variable they cannot see: the same roll into the
// same floor launched at 1.7 m/s once and 4.4 m/s a few hundred frames later
// (session-1594f).
//
// `BallPlayer.applyLoopHop` states it instead, as the loop's own tip speed, and
// this case is the statement that the phase no longer reaches it: the same drop
// at eight different starting rotations must hop within a couple of centimetres
// per second of each other. The hop must also still HAPPEN - a fix that made
// every launch identically zero would pass a spread check on its own.
// ---------------------------------------------------------------------------
function caseLoopHop(sims: Sim[]): ContactResult {
  const MIN = BallPlayer.LOOP_HOP_MIN_SPIN;
  const FULL = BallPlayer.LOOP_HOP_FULL_SPIN;
  const MAX = BallPlayer.LOOP_HOP_MAX_SPEED;
  // Under the threshold, halfway up the ramp, and at the top of it. The case
  // follows the tuning constants rather than pinning numbers the feel is allowed
  // to move.
  const SLOW = MIN * 0.5;
  const MID = (MIN + FULL) / 2;
  const PHASES = 8;

  const launches = (spin: number, tag: string): number[] => {
    const out: number[] = [];
    for (let i = 0; i < PHASES; i++) {
      const sim = new Sim(`loop-hop-${tag}-${i}`);
      sims.push(sim);
      floor(sim);
      const ball = new BallPlayer(0.12);
      ball.globalPosition = new Vec2(0, -2.3);
      ball.globalRotation = (i * 2 * Math.PI) / PHASES;
      sim.world.add(ball);
      // The ball's velocity as the previous frame left it — what the hop measures
      // its cap against, standing in for BallLevel's pre-contact snapshot.
      let before = ball.linearVelocity;
      let launch = 0;
      sim.step(90, () => {
        // What aim steering does every frame: drive the spin kinematically.
        ball.kinematicRotation = true;
        ball.angularVelocity = spin;
        ball.applyLoopHop(sim.world.frameContacts, before);
        before = ball.linearVelocity;
        launch = Math.max(launch, -ball.linearVelocity.y);
      });
      out.push(launch);
    }
    return out;
  };

  const fast = launches(FULL, "fast");
  const mid = launches(MID, "mid");
  const slow = launches(SLOW, "slow");
  const spread = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);
  const fastLo = Math.min(...fast);
  const midLo = Math.min(...mid);
  const slowHi = Math.max(...slow);
  // The drop itself bounces a little - the ball is 0.15 elastic - so the bar for
  // "did not hop" is the restitution bounce, not zero.
  const NO_HOP = 1.0;
  // Halfway up the ramp is half the speed, within a tolerance that is a bound on
  // the mechanic rather than a claim about the exact number.
  const midWanted = MAX / 2;
  const consistent = spread(fast) < 0.05 && spread(mid) < 0.05;
  const linear = Math.abs(midLo - midWanted) < 0.15 * MAX;
  const tops = Math.abs(fastLo - MAX) < 0.05 * MAX;
  const quiet = slowHi < NO_HOP;
  const good = consistent && linear && tops && quiet;
  return ok("loop-hop — the hop follows the spin, on a ramp, and a slow one does not hop", good, [
    `${consistent ? "ok  " : "BAD "} ${PHASES} phases spread ${(spread(fast) * 100).toFixed(1)}` +
      `cm/s at ${FULL} rad/s and ${(spread(mid) * 100).toFixed(1)}cm/s at ${MID} (want <5)`,
    `${tops ? "ok  " : "BAD "} the top of the ramp launched ${fastLo.toFixed(3)} m/s ` +
      `(want ${MAX.toFixed(2)})`,
    `${linear ? "ok  " : "BAD "} halfway up it launched ${midLo.toFixed(3)} m/s ` +
      `(want ${midWanted.toFixed(2)})`,
    `${quiet ? "ok  " : "BAD "} the same drop at ${SLOW} rad/s, under the threshold, peaked at ` +
      `${slowHi.toFixed(3)} m/s (want <${NO_HOP})`,
  ]);
}

// ---------------------------------------------------------------------------
// grip-reseed: a steered ball that loses its footing and gets it back must not
// be dragged back to where it lost it.
//
// The steered ball's grip pins its centre to an anchor that advances by the roll
// it intended, which is what removes the frame of gravity creep integration
// slides in underneath it. That anchor survives a few ungripped frames on
// purpose (`STICK_RELEASE_FRAMES`), because the grip flickers and re-seeding on
// every miss walks a body downhill. For a crate holding a slope that is right -
// it drifts sub-millimetre while the grip is off. A rolling ball does not drift,
// it TRAVELS, and the anchor stands still while it does.
//
// So resuming onto a held anchor yanks the whole lapse out in one frame, with no
// velocity change to show for it: five ungripped frames at 2.4 m/s put the
// anchor 21.7 cm behind and the ball was dragged back there, backwards, through
// its own direction of travel (`session-497f` f376 - which reads on screen as
// the player teleporting).
//
// The scene is the cheapest way to make the grip lapse and return: a floor with
// a gap in it, and a ball rolled across.
// ---------------------------------------------------------------------------
function caseGripReseed(sims: Sim[]): ContactResult {
  const sim = new Sim("grip-reseed");
  sims.push(sim);
  // Two slabs with a 15 cm gap, tops level at y = 0. The gap is small on
  // purpose: the lapse has to be SHORTER than `STICK_RELEASE_FRAMES`, or the
  // anchor is dropped on its own and there is nothing stale to snap back to.
  sim.addStatic(rectShape(6, 1), new Vec2(-3.075, 0.5));
  sim.addStatic(rectShape(6, 1), new Vec2(3.075, 0.5));
  const ball = new BallPlayer(0.12);
  ball.globalPosition = new Vec2(-2, -0.12);
  sim.world.add(ball);
  ball.linearVelocity = new Vec2(3, 0);

  let worstBack = 0;
  let worstFrame = 0;
  let prev = ball.globalPosition;
  sim.step(240, (n) => {
    // Steered: the spin is driven every frame and the ball rolls on it.
    ball.kinematicRotation = true;
    ball.angularVelocity = 25;
    const moved = ball.globalPosition.x - prev.x;
    // Backwards travel while the ball is going forwards is the yank. Nothing
    // else in this scene can produce it: the floor is flat and the ball is only
    // ever rolling right.
    if (ball.linearVelocity.x > 0 && -moved > worstBack) {
      worstBack = -moved;
      worstFrame = n;
    }
    prev = ball.globalPosition;
  });

  const good = worstBack < 0.005 && ball.globalPosition.x > 0;
  return ok("grip-reseed — a ball that re-grips is not dragged back to where it slipped", good, [
    `${worstBack < 0.005 ? "ok  " : "BAD "} worst backwards step ${(worstBack * 1000).toFixed(1)}mm` +
      ` @f${worstFrame} (want <5mm)`,
    `${ball.globalPosition.x > 0 ? "ok  " : "BAD "} the ball crossed the gap, ending at x=` +
      `${ball.globalPosition.x.toFixed(2)} (want >0)`,
  ]);
}

// ---------------------------------------------------------------------------
// hook-blocked-attaches — the hook anchors to anything the solver stops it on.
//
// A `BallHook` decides for itself, before it moves, whether the step ahead ends
// on a surface. The solver decides afterwards, from a different measurement:
// separation along a contact normal, closed at the normal component of the
// approach, out to `CONTACT_SLOP`. Those two disagree at the margin, and the
// solver always wins, because it runs second. Where it wins, the throw is spent:
// its approach velocity is cancelled and what is left is tangential, so a shot
// aimed dead at a surface skates off along it instead of anchoring, and does so
// while every invariant reports HEALTHY (`session-593f`, `session-1154f`).
//
// The property, and it is the whole point of the case: a hook that the solver
// pushes on must be a hook that anchors. Asserted over a FAN of throws past the
// end of a tilted slab rather than at one hand-placed near-miss, because the
// margin is a sub-millimetre band whose position moves with any change to the
// manifold - a fixed offset would stop straddling it silently, and pass by
// missing the geometry rather than by handling it.
// ---------------------------------------------------------------------------
function caseHookBlockedAttaches(): ContactResult {
  const OFFSETS = 240;
  // Across the slab's end and well past its corner, so the fan covers head-on
  // hits, the corner, and clean misses in one sweep.
  const FROM = -0.35;
  const TO = 0.15;

  let blocked = 0;
  let unattached = 0;
  let firstBad = "";
  for (let i = 0; i < OFFSETS; i++) {
    const x = FROM + ((TO - FROM) * i) / (OFFSETS - 1);
    const world = new World();
    // The hanging plank of `session-1154f`, pinned: a 2.4 x 0.8 slab at 60°,
    // thrown at from below so the shot meets its lower end face near head-on.
    const slab = new StaticBody2D();
    slab.globalPosition = new Vec2(0, -2);
    slab.globalRotation = 1.05;
    slab.setShape(rectShape(2.4, 0.8));
    world.add(slab);

    const hook = new BallHook();
    hook.globalPosition = new Vec2(x, 0);
    hook.linearVelocity = new Vec2(0, -BallPlayer.HOOK_SPEED);
    let attached = false;
    hook.registerAttachmentCallback(() => {
      attached = true;
    });
    world.add(hook);

    // The level's own order: every body's physicsStep, then one integrate.
    for (let f = 0; f < 20 && !attached; f++) {
      hook.physicsStep(DT);
      if (attached) break;
      world.integrate(DT);
      const pushed = world.frameContacts.some(
        (c) => (c.a === hook || c.b === hook) && c.normalImpulse > 0,
      );
      if (!pushed) continue;
      blocked++;
      // One more physicsStep is all it may take: the sweep anchors on the frame
      // of contact, the backstop on the frame after.
      hook.physicsStep(DT);
      if (!attached) {
        unattached++;
        if (!firstBad) firstBad = `x=${x.toFixed(4)} f${f + 1}`;
      }
      break;
    }
  }

  // A fan that never gets blocked would pass the check above by testing nothing.
  const enough = blocked >= 10;
  const good = unattached === 0;
  return ok("hook-blocked-attaches — a hook the solver pushes on is a hook that anchors", good && enough, [
    `${good ? "ok  " : "BAD "} ${unattached} of ${blocked} blocked throws failed to anchor` +
      `${firstBad ? ` (first at ${firstBad})` : ""} (want 0)`,
    `${enough ? "ok  " : "BAD "} ${blocked} of ${OFFSETS} throws were blocked at all (want >=10)`,
  ]);
}

// ---------------------------------------------------------------------------
// area-reach — an area acts on what it actually contains, and on nothing else.
//
// Every area query in the world goes through one predicate (`shapesOverlap`),
// and its vertex-vs-vertex branch used to answer with a BOUNDING CIRCLE: a rect
// against the half-diagonal disc of the other, with a comment promising a
// refinement that was never written. For the round avatar that branch is never
// taken, which is why it survived - and for a long thin area it is enormous. The
// ball arena's 31.5 x 0.7 m river current reached as a 15.75 m disc, so a plank
// hung on scene chains 5.6 m above the water was accelerated sideways at a
// steady 3 m/s² and swung a metre off its anchors, in a rig whose geometry is
// symmetrical to the millimetre.
//
// The case is three rect bodies against one long thin current, and it is written
// as the general statement rather than as that level: a body clear of the volume
// is untouched however close the bounding circle passes, a body inside is
// carried, and a body dipping a corner in is carried too. That last one is what
// stops the fix being "test the centre", which would pass the first two.
//
// Gravity is off throughout: what is asserted is the area's own acceleration, and
// a falling body would leave the volume mid-case and confuse the two.
// ---------------------------------------------------------------------------
function caseAreaReach(): ContactResult {
  const FRAMES = 30;
  const ACCEL = 3;
  const world = new World();

  // The current: long, thin, and pointing -x (rot pi, as the level authors it).
  const current = new ForceArea();
  current.globalPosition = new Vec2(0, 0);
  current.globalRotation = Math.PI;
  current.setShape(rectShape(31.5, 0.7));
  current.magnitude = ACCEL;
  world.add(current);

  const plank = (x: number, y: number): RigidBody2D => {
    const b = new RigidBody2D();
    b.globalPosition = new Vec2(x, y);
    b.setShape(rectShape(3.4, 0.6));
    b.gravityScale = 0;
    world.add(b);
    return b;
  };

  // Clear of the volume by 5.3 m of empty air, and 7.6 m from its centre - well
  // inside the old bounding circle, which is the whole point of where it sits.
  const above = plank(-5, -5.6);
  // Squarely inside.
  const inside = plank(-5, 0);
  // Overlapping the top face by 5 cm, centre outside.
  const dipping = plank(5, -0.6);

  for (let f = 0; f < FRAMES; f++) world.integrate(DT);

  // What the area is worth over the run, and the bar for "carried": most of it,
  // since a body inside for every frame gets all of it.
  const full = ACCEL * DT * FRAMES;
  const clear = above.linearVelocity.length() === 0;
  const carried = inside.linearVelocity.x <= -full * 0.99;
  const dipped = dipping.linearVelocity.x <= -full * 0.99;

  return ok("area-reach — an area acts on what it contains, not on its bounding circle", clear && carried && dipped, [
    `${clear ? "ok  " : "BAD "} body 5.3m clear of the volume: |v| ${above.linearVelocity.length().toFixed(4)} m/s (want 0)`,
    `${carried ? "ok  " : "BAD "} body inside: vx ${inside.linearVelocity.x.toFixed(3)} m/s (want <= ${(-full * 0.99).toFixed(3)})`,
    `${dipped ? "ok  " : "BAD "} body dipping a corner in: vx ${dipping.linearVelocity.x.toFixed(3)} m/s (want <= ${(-full * 0.99).toFixed(3)})`,
  ]);
}

// ---------------------------------------------------------------------------
// chain-order — a symmetrical rig hangs symmetrically, whichever order its
// chains are written in.
//
// Every scene chain is an independent PBD solve that writes positions and
// credits itself velocity, so sweeping the list once is Gauss-Seidel with one
// iteration: the chain that solves first moves the bodies, and the one after it
// gets the last word. Where two chains hold the SAME pair of bodies - which is
// what a bridle, a swing seat or any two-point hanger is - the residual is a
// lean, and it is the array's lean rather than the geometry's. On the ball
// arena's hanging weight it was 18 cm and 18 degrees of link tilt, in a rig
// symmetrical to the millimetre, and swapping the two chains in the level file
// mirrored the answer digit for digit.
//
// So the case builds one rig twice, identical but for the order of its two lower
// chains, and asserts what the level author sees: over the settled tail it hangs
// near centre and its link hangs near level, in BOTH orders. Running both orders
// is what makes the bound honest rather than a fit to one arrangement - the two
// runs are each other's reflection, so a solver that leans fails whichever way
// the level happens to list its chains.
// ---------------------------------------------------------------------------
function caseChainOrder(): ContactResult {
  const FRAMES = 900;
  // Bounds, not numbers. The shipped sweep leaves this rig at 9 mm, 0.9 deg and
  // 15 mm of stretch; a single sweep leaves it at 236 mm, 25.3 deg and 191 mm.
  // The bars sit a couple of times clear of the first and well under the second.
  const MAX_LEAN = 0.04;
  const MAX_TILT = 3 * DEG;
  // Stretch is the springiness a level author actually sees, and the reason the
  // sweep runs to a residual rather than to a count: every chain here is pinned
  // to exactly its length by its own solve and stretched back out by the one
  // solved after it.
  //
  // This rig does NOT meet `CHAIN_TOLERANCE` - its chains run 14 degrees off
  // horizontal, which is a big tension for the load and the slowest thing there
  // is for Gauss-Seidel, so `MAX_CHAIN_SWEEPS` binds before the tolerance does
  // (it wants ~200 sweeps for 5 mm, against the ball arena's rig converging
  // inside the cap). That is deliberate: the case is the one that measures what
  // the CAP is worth, and a bar written at the tolerance would be asserting
  // something this scene never reaches.
  const MAX_STRETCH = 0.02;

  // Returns the worst [weight lean, link tilt, chain stretch] over the settled
  // tail, not the pose at one instant: the rig is a pendulum, so a single sample
  // can catch a leaning one crossing centre and read as healthy.
  const hang = (swapped: boolean): [number, number, number] => {
    const sim = new Sim("chain-order");
    const ceiling = new StaticBody2D();
    ceiling.globalPosition = new Vec2(0, -4);
    ceiling.setShape(rectShape(4, 0.2));
    sim.world.add(ceiling);
    const link = sim.addRigid(rectShape(0.2, 0.4), new Vec2(0, -2.3));
    const weight = sim.addRigid(rectShape(2, 1.7), new Vec2(0, -1));

    // Anchors sit ON the surfaces they are bolted to, as `buildSceneChains`
    // snaps an authored one: an anchor inside a body leaves the span starting
    // in its interior and the chain winds around its own anchor.
    const chain = (a: [PhysicsBody2D, number, number], b: [PhysicsBody2D, number, number]) => {
      const pa = new Vec2(a[1], a[2]);
      const pb = new Vec2(b[1], b[2]);
      return new SceneChain(RopeContact.at(a[0], pa), RopeContact.at(b[0], pb), pa.distanceTo(pb), null);
    };
    const hanger = chain([ceiling, 0, -3.9], [link, 0, -2.5]);
    const left = chain([link, -0.1, -2.1], [weight, -1, -1.85]);
    const right = chain([link, 0.1, -2.1], [weight, 1, -1.85]);
    const chains = swapped ? [hanger, right, left] : [hanger, left, right];

    let lean = 0;
    let tilt = 0;
    let stretch = 0;
    sim.step(FRAMES, (n) => {
      stepSceneChains(chains, DT);
      if (n <= FRAMES - 300) return;
      lean = Math.max(lean, Math.abs(weight.globalPosition.x));
      tilt = Math.max(tilt, Math.abs(wrapAngle(link.globalRotation)));
      for (const c of chains) stretch = Math.max(stretch, c.rope.overLength);
    });
    return [lean, tilt, stretch];
  };

  const [leanA, tiltA, stretchA] = hang(false);
  const [leanB, tiltB, stretchB] = hang(true);
  const lean = Math.max(leanA, leanB);
  const tilt = Math.max(tiltA, tiltB);
  const stretch = Math.max(stretchA, stretchB);
  const hangs = lean <= MAX_LEAN;
  const level = tilt <= MAX_TILT;
  const rigid = stretch <= MAX_STRETCH;

  return ok("chain-order — a symmetrical hanging rig hangs straight and its chains do not stretch", hangs && level && rigid, [
    `${hangs ? "ok  " : "BAD "} worst lean ${(leanA * 1000).toFixed(1)}mm, ${(leanB * 1000).toFixed(1)}mm swapped ` +
      `(want <${MAX_LEAN * 1000}mm)`,
    `${level ? "ok  " : "BAD "} worst link tilt ${(tiltA / DEG).toFixed(2)}deg, ${(tiltB / DEG).toFixed(2)}deg swapped ` +
      `(want <${(MAX_TILT / DEG).toFixed(0)}deg)`,
    `${rigid ? "ok  " : "BAD "} worst chain stretch ${(stretchA * 1000).toFixed(2)}mm, ${(stretchB * 1000).toFixed(2)}mm swapped ` +
      `(want <${MAX_STRETCH * 1000}mm)`,
  ]);
}

// ---------------------------------------------------------------------------
// materials — an authored shape weighs what its material and its thickness say
// it weighs, per SHAPE and not per body.
//
// Mass is authored state, and authored state that nothing checks is authored
// state that quietly stops being read: the fields reach the sim through
// `makePiece`, and a build that ignored one would produce a level that looks
// identical, plays differently and violates nothing. So this is arithmetic
// asserted directly - area × thickness × density - rather than a scenario whose
// outcome depends on it.
//
// The compound case is the one that motivates per-shape material at all: a
// group's mass, centre of mass and inertia are sums over its pieces, so a stone
// head on a wooden shaft has to land its origin near the head. Checking the
// centre of mass is also what catches the subtler failure - a build that reads
// the materials for the mass but weighs the pieces as oak when it places the
// origin, which is every rigid-body lever arm measured from the wrong point.
// ---------------------------------------------------------------------------
function caseMaterials(): ContactResult {
  const SLAB = 0.2; // the default thickness, in metres
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-12;

  const build = (bodies: LevelBodyData[]): (CollisionObject2D | null)[] => {
    const world = new World();
    const data: LevelData = { player: { x: 0, y: 0, radius: 0.08 }, bodies };
    return buildLevelBodies(world, data, () => {}).byIndex;
  };

  const rect = (extra: Partial<LevelBodyData>): LevelBodyData => ({
    kind: "rigid",
    x: 0,
    y: 0,
    rot: 0,
    shape: { kind: "rect", w: 2, h: 0.4 },
    ...extra,
  });

  const [plain, stone, thick, wheel] = build([
    // Names nothing: 20 cm of oak, which is what it weighed before materials.
    rect({}),
    rect({ material: "stone" }),
    rect({ material: "stone", thickness: 2 * SLAB }),
    // A circle is a DISC of its thickness (a wheel seen face on), not a sphere:
    // an authored thickness that some shape kinds ignored would be a field that
    // lies about what it does. The sphere rule stays the code-built round
    // bodies' - see `ShapeGeometry.computeMass`.
    { kind: "rigid", x: 0, y: 0, rot: 0, shape: { kind: "circle", r: 0.5 }, material: "steel", thickness: 0.1 },
  ]) as RigidBody2D[];

  const wantPlain = 2 * 0.4 * SLAB * MATERIALS.wood;
  const wantStone = 2 * 0.4 * SLAB * MATERIALS.stone;
  const wantWheel = Math.PI * 0.25 * 0.1 * MATERIALS.steel;
  const plainOk = near(plain!.mass, wantPlain);
  const stoneOk = near(stone!.mass, wantStone);
  const thickOk = near(thick!.mass, 2 * wantStone);
  const wheelOk = near(wheel!.mass, wantWheel);

  // A compound body of two 1 m squares side by side, one oak and one lead. The
  // pieces are 1 m apart, so a build that weighed them equally would put the
  // origin at x = 0 - the midpoint of the two, which is what the assertion is
  // written against.
  const square = (x: number, material: string): LevelBodyData => ({
    kind: "rigid",
    x,
    y: 0,
    rot: 0,
    shape: { kind: "rect", w: 1, h: 1 },
    material,
    group: "g1",
  });
  const [piece] = build([square(-0.5, "wood"), square(0.5, "lead")]) as RigidBody2D[];
  const mWood = SLAB * MATERIALS.wood;
  const mLead = SLAB * MATERIALS.lead;
  const wantCentre = (-0.5 * mWood + 0.5 * mLead) / (mWood + mLead);
  const sumOk = near(piece!.mass, mWood + mLead);
  const centreOk = near(piece!.globalPosition.x, wantCentre);

  const passed = plainOk && stoneOk && thickOk && wheelOk && sumOk && centreOk;
  return ok("materials — an authored shape weighs its area × thickness × density, per shape", passed, [
    `${plainOk ? "ok  " : "BAD "} no material named: ${plain!.mass.toFixed(4)} kg (want ${wantPlain.toFixed(4)}, 20cm of oak)`,
    `${stoneOk ? "ok  " : "BAD "} same slab in stone: ${stone!.mass.toFixed(4)} kg (want ${wantStone.toFixed(4)})`,
    `${thickOk ? "ok  " : "BAD "} twice as thick: ${thick!.mass.toFixed(4)} kg (want ${(2 * wantStone).toFixed(4)})`,
    `${wheelOk ? "ok  " : "BAD "} steel disc r=0.5 t=0.1: ${wheel!.mass.toFixed(4)} kg (want ${wantWheel.toFixed(4)}, NOT the sphere's ${((4 / 3) * Math.PI * 0.125 * MATERIALS.steel).toFixed(1)})`,
    `${sumOk ? "ok  " : "BAD "} oak+lead group mass: ${piece!.mass.toFixed(4)} kg (want ${(mWood + mLead).toFixed(4)})`,
    `${centreOk ? "ok  " : "BAD "} its centre of mass: x ${piece!.globalPosition.x.toFixed(4)} m (want ${wantCentre.toFixed(4)}, midpoint would be 0)`,
  ]);
}

// ---------------------------------------------------------------------------
// impermeable-shape — hook-proof is a property of the SURFACE, and both hooks
// ask the piece they reached.
//
// It used to be a body KIND, which could say neither of the two things a level
// wants. A kind is one per body, so nothing could be `rigid` and hook-proof at
// once - a crate that falls, is hauled about and still refuses the hook was not
// expressible - and a compound wall was hook-proof in whole or not at all, so a
// single attachable ledge among hook-proof faces could not be authored either.
//
// Both hooks are checked because they reach a surface by different means: the
// grapple hook raycasts and is destroyed, the ball's sweeps/probes and is
// deflected. Each has its own answer to "which piece did I hit", and a fix
// applied to one of them alone is exactly the class of bug the shape/body rule
// exists to stop.
//
// The legacy kind is checked in the same breath: every level on disk still
// carries `kind: "impermeable"`, and the fold-in happens in one place
// (`normalizeLevelData`, inside `scaleLevelData`). If it ever stops happening,
// walls that have repelled the hook since a level was designed silently start
// catching it, which no invariant can see.
// ---------------------------------------------------------------------------
function caseImpermeableShape(): ContactResult {
  // A compound wall: hook-proof on the left piece, attachable on the right.
  const wall = (x: number, hookProof: boolean): LevelBodyData => ({
    kind: "static",
    x,
    y: 2,
    rot: 0,
    shape: { kind: "rect", w: 1, h: 1 },
    group: "wall",
    ...(hookProof ? { impermeable: true } : {}),
  });
  const bodies: LevelBodyData[] = [
    wall(-0.5, true),
    wall(0.5, false),
    // The case a kind could not express at all: a dynamic body that is also
    // hook-proof. Pinned with `gravityScale` 0 so the throw meets it where it
    // was authored rather than wherever it has fallen to.
    {
      kind: "rigid",
      x: 3,
      y: 2,
      rot: 0,
      shape: { kind: "rect", w: 1, h: 1 },
      impermeable: true,
    },
    // Authored the retired way, which is how every level on disk still says it.
    { kind: "impermeable", x: 5, y: 2, rot: 0, shape: { kind: "rect", w: 1, h: 1 } },
  ];

  const build = () => {
    const world = new World();
    const data = scaleLevelData({ player: { x: 0, y: 0, radius: 0.08 }, bodies }, 1);
    const built = buildLevelBodies(world, data, () => {});
    for (const b of world.bodies) if (b instanceof RigidBody2D) b.gravityScale = 0;
    return { world, built, data };
  };

  // Does a ball hook thrown straight down at `x` anchor, or is it turned away?
  const ballAttaches = (x: number): boolean => {
    const { world } = build();
    const hook = new BallHook();
    hook.globalPosition = new Vec2(x, 0);
    hook.linearVelocity = new Vec2(0, BallPlayer.HOOK_SPEED);
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
    return attached;
  };

  // The grapple hook is a raycast and is DESTROYED rather than deflected, so
  // its two outcomes are "attached" and "destroyed" rather than "attached" and
  // "still flying".
  const grappleAttaches = (x: number): boolean => {
    const { world } = build();
    const hook = new Hook();
    hook.globalPosition = new Vec2(x, 0);
    hook.velocity = new Vec2(0, 0.2);
    let attached = false;
    let destroyed = false;
    hook.registerAttachmentCallback(() => {
      attached = true;
    });
    hook.onDestroyed(() => {
      destroyed = true;
    });
    world.add(hook);
    for (let f = 0; f < 30 && !attached && !destroyed; f++) hook.physicsStep();
    return attached;
  };

  const { built, data } = build();
  const legacy = data.bodies[3]!;
  const legacyFolded =
    legacy.kind === "static" &&
    legacy.impermeable === true &&
    built.byIndex[3]!.getShapes().every((s) => s.impermeable);
  // The group is ONE body of two pieces, and the pieces must disagree - that is
  // the whole statement.
  const pieces = built.byIndex[0]!.getShapes();
  const perShape = pieces.length === 2 && pieces[0]!.impermeable && !pieces[1]!.impermeable;

  const ballProof = !ballAttaches(-0.5);
  const ballLedge = ballAttaches(0.5);
  const ballRigid = !ballAttaches(3);
  const grappleProof = !grappleAttaches(-0.5);
  const grappleLedge = grappleAttaches(0.5);

  const passed =
    perShape && legacyFolded && ballProof && ballLedge && ballRigid && grappleProof && grappleLedge;
  return ok("impermeable-shape — hook-proof is per surface, and both hooks ask the piece they hit", passed, [
    `${perShape ? "ok  " : "BAD "} one compound body, two pieces, only the first hook-proof`,
    `${legacyFolded ? "ok  " : "BAD "} the retired \`kind: "impermeable"\` loads as a static with a hook-proof shape`,
    `${ballProof ? "ok  " : "BAD "} ball hook into the hook-proof piece: ${ballProof ? "deflected" : "ANCHORED"}`,
    `${ballLedge ? "ok  " : "BAD "} ball hook into its attachable sibling: ${ballLedge ? "anchored" : "TURNED AWAY"}`,
    `${ballRigid ? "ok  " : "BAD "} ball hook into a hook-proof RIGID body: ${ballRigid ? "deflected" : "ANCHORED"}`,
    `${grappleProof ? "ok  " : "BAD "} grapple hook into the hook-proof piece: ${grappleProof ? "destroyed" : "ANCHORED"}`,
    `${grappleLedge ? "ok  " : "BAD "} grapple hook into its attachable sibling: ${grappleLedge ? "anchored" : "TURNED AWAY"}`,
  ]);
}

// ---------------------------------------------------------------------------
// background-group — a background panel welded into a compound body rides it,
// and everything else about it stays decoration.
//
// Authored state that nothing checks is authored state that quietly stops being
// read, and this one is invisible to every other detector here: a panel is never
// simulated, so a build that dropped the attachment entirely would violate no
// invariant, diverge no digest and pass every bundle. What it would do is leave
// the paint behind while the body it decorates swings away from it - a thing only
// a person looking at the game would notice, which is exactly the failure this
// suite exists to turn into a number.
//
// Three statements, and the third is what stops the first two passing for the
// wrong reason:
//
// - the tagged panel resolves to the group's engine body, and after that body has
//   fallen and turned by a real amount its drawn placement has followed - moved
//   by what the body moved by, turned by what the body turned by;
// - the panel is not a PIECE of that body: it brings no shape, so the built body
//   still carries exactly the shapes its geometry authored;
// - an untagged panel, and one tagged into a group no body carries, are drawn
//   exactly where they were authored after all of it. Without those two, "every
//   panel rides something" would pass this case just as well as the rule does.
// ---------------------------------------------------------------------------
function caseBackgroundGroup(): ContactResult {
  const panel = (
    x: number,
    y: number,
    rot: number,
    group?: string,
  ): BackgroundData => ({
    x,
    y,
    rot,
    shape: { kind: "rect", w: 3.4, h: 1.4 },
    ...(group !== undefined ? { group } : {}),
  });
  const data = scaleLevelData(
    {
      player: { x: 0, y: 0, radius: 0.08 },
      bodies: [
        { kind: "static", x: 0, y: 3, rot: 0, shape: { kind: "rect", w: 20, h: 1 } },
        // One shape, so the count below says whether the panel joined it.
        { kind: "rigid", x: 0, y: -1, rot: 0.35, shape: { kind: "rect", w: 2.2, h: 0.4 }, group: "slab" },
      ],
      // Offset from the body's origin on purpose: a panel drawn at the origin
      // would follow the body under a rotation that was being ignored.
      backgrounds: [panel(0.6, -1.3, 0.35, "slab"), panel(6, -1, 0), panel(-6, -1, 0, "nothing")],
    },
    1,
  );

  const world = new World();
  const built = buildLevelBodies(world, data, () => {});
  const [rider, loose, orphan] = buildSceneBackgrounds(data.backgrounds!, built.byGroup);
  const body = built.byGroup.get("slab") as RigidBody2D | undefined;

  const before = {
    body: body ? { pos: body.globalPosition, rot: body.globalRotation } : null,
    rider: backgroundTransform(rider!, 1),
    loose: backgroundTransform(loose!, 1),
    orphan: backgroundTransform(orphan!, 1),
  };
  for (let f = 0; f < 240; f++) world.integrate(DT);
  const after = {
    rider: backgroundTransform(rider!, 1),
    loose: backgroundTransform(loose!, 1),
    orphan: backgroundTransform(orphan!, 1),
  };

  const attached = rider!.body !== null && rider!.body === body;
  const onePiece = (body?.getShapes().length ?? 0) === 1;
  // The slab has to have actually gone somewhere, or "it followed" is a
  // statement about a body that never moved.
  const bodyMoved = body ? body.globalPosition.distanceTo(before.body!.pos) : 0;
  const bodyTurned = body ? Math.abs(wrapAngle(body.globalRotation - before.body!.rot)) : 0;
  const worthChecking = bodyMoved > 1 && bodyTurned > 0.02;
  // Followed means its placement IN THE BODY'S FRAME is what it was - not that
  // it moved by what the body's origin moved by, which a panel held off that
  // origin cannot do while the body turns: it swings, and the swing is the part
  // being checked. Paired with the travel below, since a panel that stopped
  // being attached altogether would hold its frame-relative placement in the
  // only way that matters here by not moving at all.
  const localOf = (t: { pos: Vec2; rot: number }, pose: { pos: Vec2; rot: number }) => ({
    off: t.pos.sub(pose.pos).rotated(-pose.rot),
    rot: wrapAngle(t.rot - pose.rot),
  });
  const nowPose = body
    ? { pos: body.globalPosition, rot: body.globalRotation }
    : { pos: Vec2.ZERO, rot: 0 };
  const wasLocal = localOf(before.rider, before.body ?? nowPose);
  const nowLocal = localOf(after.rider, nowPose);
  const followedPos = nowLocal.off.distanceTo(wasLocal.off);
  const followedRot = Math.abs(wrapAngle(nowLocal.rot - wasLocal.rot));
  const riderTravelled = after.rider.pos.distanceTo(before.rider.pos);
  const followed = body !== undefined && followedPos < 1e-9 && followedRot < 1e-9 && riderTravelled > 1;
  const looseStill =
    after.loose.pos.distanceTo(before.loose.pos) === 0 && after.loose.rot === before.loose.rot;
  const orphanStill =
    orphan!.body === null &&
    after.orphan.pos.distanceTo(before.orphan.pos) === 0 &&
    after.orphan.rot === before.orphan.rot;

  const passed = attached && onePiece && worthChecking && followed && looseStill && orphanStill;
  return ok("background-group — a welded panel rides its body and adds nothing to it", passed, [
    `${attached ? "ok  " : "BAD "} the tagged panel resolves to the group's engine body`,
    `${onePiece ? "ok  " : "BAD "} the body carries ${body?.getShapes().length ?? 0} shape(s) — a panel is not a piece`,
    `${worthChecking ? "ok  " : "BAD "} the body moved ${bodyMoved.toFixed(2)} m and turned ${(bodyTurned / DEG).toFixed(1)}°`,
    `${followed ? "ok  " : "BAD "} the panel followed it ${riderTravelled.toFixed(2)} m, holding its place in the body's frame to ${(followedPos * 1000).toFixed(6)} mm / ${(followedRot / DEG).toFixed(6)}°`,
    `${looseStill ? "ok  " : "BAD "} an untagged panel is drawn where it was authored`,
    `${orphanStill ? "ok  " : "BAD "} a panel tagged into a group with no body is drawn where it was authored`,
  ]);
}

export function runContactCases(): ContactResult[] {
  const sims: Sim[] = [];
  // Audit every scene below, not a scene of its own (see `impulse-pairing`).
  ContactAudit.enabled = true;
  ContactAudit.reset();
  const results = [
    caseSettle(sims),
    caseStack(sims),
    caseRampHold(sims),
    caseRampBreak(sims),
    caseRigidRampHold(sims),
    caseTopple(sims),
    casePivot(sims),
    caseImpactTransfer(sims),
    caseMomentum(sims),
    caseSpinDrive(sims),
    caseRollDrive(sims),
    caseLoopHop(sims),
    caseGripReseed(sims),
  ];
  ContactAudit.enabled = false;
  results.push(caseMaterials());
  results.push(caseImpermeableShape());
  results.push(caseBackgroundGroup());
  results.push(caseAreaReach());
  results.push(caseChainOrder());
  results.push(caseHookBlockedAttaches());
  results.push(caseImpulsePairing());
  results.push(casePenetration(sims));
  return results;
}
