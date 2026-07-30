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
import { RigidBody2D, StaticBody2D } from "../engine/body";
import { circleOverlap } from "../engine/collision";
import { shapeContacts } from "../engine/manifold";
import { polyShapeCentred, rectShape, type Shape } from "../engine/shapes";
import { World } from "../engine/world";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { RIGID_KINETIC_FRICTION, RIGID_STATIC_FRICTION } from "../level/buildBodies";

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
// stack: four boxes dropped into a pile must settle on each other.
//
// The rigid-vs-rigid case of `settle`, and the one momentum transfer is most
// likely to destabilise: a pile that currently sits still because nothing drives
// it may start moving once the contacts actually exchange impulses.
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
    details.push(`${good ? "ok  " : "BAD "} box${i}: |w|=${w.toFixed(4)} span=${span.toFixed(3)}deg`);
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

export function runContactCases(): ContactResult[] {
  const sims: Sim[] = [];
  const results = [
    caseSettle(sims),
    caseStack(sims),
    caseRampHold(sims),
    caseRampBreak(sims),
    caseTopple(sims),
    casePivot(sims),
    caseImpactTransfer(sims),
    caseMomentum(sims),
  ];
  results.push(casePenetration(sims));
  return results;
}
