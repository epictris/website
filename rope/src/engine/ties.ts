// The island solver: tied chains, authored ropes and the contacts of the bodies
// they hold, solved together as rows of one substepped soft step.
//
// This is the solver `plans/rope-bridge.md` arrived at for a rope bridge, and
// the measurements that chose it are there. The short form: a tie between two
// slats is a 15 cm straight segment that will never wrap anything, so solving
// it as a `Rope` (`level/chains.ts`) paid the wrap scan, the self-intersection
// resolver, a path-object allocation and a snapshot per segment per sweep -
// sixty times the arithmetic - and a Gauss-Seidel sweep over twenty of them in
// series wanted the 64-sweep cap every frame to carry the ball's weight one
// link per pass. Here a segment is a point-to-point inequality
// `|p_b - p_a| <= L` with a torque arm on each body, solved at velocity level
// with an accumulated impulse that warm-starts the next substep and the next
// frame, and the frame is split into substeps so the load crosses the bridge
// many times a frame at a cost that is a known function of rows times
// substeps rather than a cap that is always hit.
//
// The formulation is Box2D v3's soft step (Catto, Solver2D 2024): for each
// substep, integrate velocities, warm start, solve every row with a soft bias,
// integrate positions, then solve every row again with no bias (relax). Soft
// rows are not a concession. A straight taut cable under transverse load has
// unbounded tension, and the study's direct solve of the exact inequalities
// turned a 5.5e-3 kg m² slat by radians per step; softness is what makes the
// system well-posed, and at 60 Hz with a damping ratio of 2 it is invisible at
// the 5 mm the renderer can show.
//
// A ROW is anything with a slack, a slack rate and a Jacobian over some bodies
// (`IslandRow`): a tie segment, an authored rope whose wrap path the row
// regenerates every substep (`RopeRow` in `level/chains.ts` - the plan's
// second stage), or a contact. A UNIT (`IslandUnit`) is the thing that sleeps
// and wakes: a tied chain, or one rope. Every connected set of units' bodies
// is one ISLAND: it integrates here and not in `World.integrate`'s gravity
// loop, it sleeps only when every body in the island is ready to
// (`TieSolver.settleSleep`), and it wakes whole when any of them is touched.
// That closes by construction the defect the bridge rig found in the chain
// phase - a slat asleep on one chain while the next hauled it away with
// nothing measuring its length.
//
// A held body's contacts with the scenery, with other held bodies and with a
// free body - the ball on a slat - are rows of the same solve, prepared from
// the world's own narrowphase (`World.collectContacts`) with their anchors
// carried in the bodies' frames so the separation is re-read every substep.
// The free body keeps its own integration and its grip; the island solves it
// with its real mass so that it and the slat agree at the end of the frame.
//
// Nothing here calls a platform `Math` transcendental: the axis of a row is a
// difference of points divided by its length, and the only rotation is
// `Vec2.rotated`, which goes through `dmath`.

import { Vec2 } from "./vec2";
import {
  AnimatableBody2D,
  beginSpinMotorStep,
  endSpinMotorStep,
  PhysicsBody2D,
  RigidBody2D,
  solveSpinMotor,
} from "./body";
import type { ContactConstraint } from "./world";
import { SolverStats } from "./solverStats";

// --- softness ---------------------------------------------------------------
// Catto's soft constraint (GDC 2011; Box2D's `b2MakeSoft`): a row driven as a
// damped spring in the substep's implicit integration, which is what makes a
// taut bridge well-posed (see the file comment).
export interface Softness {
  readonly biasRate: number;
  readonly massScale: number;
  readonly impulseScale: number;
}

export const RIGID: Softness = { biasRate: 0, massScale: 1, impulseScale: 0 };

export type MutableSoftness = { -readonly [K in keyof Softness]: Softness[K] };

export function softness(hertz: number, zeta: number, h: number): Softness {
  return softnessInto({ biasRate: 0, massScale: 1, impulseScale: 0 }, hertz, zeta, h);
}

// `softness` written into `out` rather than a fresh object, for a row that
// derives its own frequency on every solve (a plant's spring rows, thousands a
// frame). `RIGID` for zero hertz, as `softness` answers.
export function softnessInto(out: MutableSoftness, hertz: number, zeta: number, h: number): Softness {
  if (hertz === 0) return RIGID;
  const omega = 2 * Math.PI * hertz;
  const a1 = 2 * zeta + h * omega;
  const a2 = h * omega * a1;
  const a3 = 1 / (1 + a2);
  out.biasRate = omega / a1;
  out.massScale = a2 * a3;
  out.impulseScale = a3;
  return out;
}

// A rope row's stiffness, as a soft constraint's frequency and damping ratio.
// Mutable so a study (`scripts/bridge-solver-study.ts`) can sweep it; the
// values here are the ones every level runs with, and they are measured in
// `cli bridges` (see the plan's tuning table).
export const TieTuning = {
  hertz: 60,
  damping: 2,
};

// A held body's contact rows: Box2D's contact defaults. The hertz is capped at
// a quarter of the substep rate, and the push-out velocity a penetrating
// contact may recover at is bounded so a slat that ends up inside the floor
// comes out rather than launches.
const CONTACT_HERTZ = 30;
const CONTACT_DAMPING = 10;
const MAX_PUSH_VELOCITY = 3;
// Below this closing speed a contact does not bounce (`World`'s own bar).
const RESTITUTION_THRESHOLD = 1;
// Per-frame velocity retention of a held body, the chain phase's own
// (`CHAIN_BODY_DAMPING`): a bridge in free air touches nothing that would ever
// stop it swinging, and the rest rule needs it to stop. A body the ball's chain
// has hold of is left alone, as the chain phase leaves it.
const TIE_BODY_DAMPING = 0.99;

// The substeps a unit gets when the author names none: eight, which with a
// solve and a relax per substep is the 16 solves per segment per frame
// `bridge-long` holds the bridge to, and which the study measured at 17 mm on
// the 19-slat rig under a ball swinging at 3 m/s (`scripts/bridge-solver-study.ts`,
// `sub k=8 p=2`) against 21 mm for the capped sweep at four times the work.
export const DEFAULT_TIE_SUBSTEPS = 8;
export const MAX_TIE_SUBSTEPS = 32;

// --- rows and units ---------------------------------------------------------

// A constraint the island solves: a slack that must stay non-negative, its
// rate, and the impulse that drives it, applied to its bodies.
export interface IslandRow {
  // Once a frame, before any substep, with the contacts the island solves this
  // frame beside the rows (the ball's row asks whether the ball is touching a
  // body on its path).
  beginFrame(dt: number, contacts: readonly ContactConstraint[]): void;
  // Once a substep, before the warm start: a rope regenerates its wrap path
  // here against the bodies as they stand.
  prepare(h: number): void;
  warmStart(): void;
  solve(h: number, soft: Softness, useBias: boolean): void;
  // End of the frame: what the row ended at (`over`).
  measure(): void;
  readonly over: number;
}

// The thing that sleeps and wakes, and whose bodies the island integrates.
export interface IslandUnit {
  // The dynamic bodies this unit holds and the island integrates: free rigid
  // bodies, pivots and spring bodies (`islandOwns`).
  readonly bodies: readonly RigidBody2D[];
  readonly rows: readonly IslandRow[];
  readonly substeps: number;
  asleep: boolean;
  fallAsleep(): void;
  // Has a static the unit hangs from moved since it slept (a post on a mover)?
  anchorsMoved(): boolean;
  // The unit's bodies are left undamped (`TIE_BODY_DAMPING`): a berry plant
  // the ball hangs from, which the chain phase never damps either, and whose
  // bounce is the energy the damping would take (`level/plantRows.ts`).
  readonly undamped?: boolean;
}

// A knot: the rope is fixed to the body at this point, in the body's own frame.
export class TiePoint {
  constructor(
    readonly body: PhysicsBody2D,
    readonly local: Vec2,
  ) {}

  world(): Vec2 {
    return this.body.globalPosition.add(this.local.rotated(this.body.globalRotation));
  }

  // Against the render transforms, as a rope node is drawn, so a drawn chain
  // stays welded to the drawn bodies.
  renderWorld(alpha: number): Vec2 {
    return this.body.renderPosition(alpha).add(this.local.rotated(this.body.renderRotation(alpha)));
  }
}

// The rope between two consecutive knots on different bodies: a row.
export class TieSegment implements IslandRow {
  // The accumulated impulse, in N·s, carried across substeps and frames. A rope
  // pulls and never pushes, so it is clamped at zero.
  impulse = 0;
  // What the segment measured at the end of the last frame: its length, and how
  // far over `length` it ended (zero while slack) - the residual the digests
  // and `chain-over-length` read.
  current = 0;
  over = 0;

  // Mutable so a caller re-knotting a segment (the editor, a build) can keep
  // the accumulated impulse, which is what warm-starting the row across the
  // change means.
  constructor(
    public a: TiePoint,
    public b: TiePoint,
    public length: number,
  ) {}

  beginFrame(_dt: number): void {}

  prepare(): void {}

  measure(): void {
    this.current = this.b.world().distanceTo(this.a.world());
    this.over = Math.max(0, this.current - this.length);
  }

  warmStart(): void {
    if (this.impulse === 0) return;
    const pa = this.a.world();
    const pb = this.b.world();
    const d = pb.sub(pa);
    const len = d.length();
    if (len < 1e-9) return;
    const impulse = d.mul(this.impulse / len);
    applyAt(this.a.body, impulse, pa.sub(this.a.body.globalPosition));
    applyAt(this.b.body, impulse.neg(), pb.sub(this.b.body.globalPosition));
  }

  // The row: `C = |p_b - p_a| - L`, `J = [-n, -(r_a x n), n, (r_b x n)]`, the
  // impulse along `n` pulling the two knots together, accumulated and clamped
  // at zero. While slack (`C < 0`) the segment may lengthen by what slack it
  // has this substep and no more, which keeps the row in the solve as the
  // contact solver keeps a speculative contact; over its length it is pulled
  // back by the soft bias, and in the relax pass by nothing but the velocity.
  solve(h: number, soft: Softness, useBias: boolean): void {
    const A = this.a.body;
    const B = this.b.body;
    const pa = this.a.world();
    const pb = this.b.world();
    const d = pb.sub(pa);
    const len = d.length();
    if (len < 1e-9) return;
    const n = d.div(len);
    const ra = pa.sub(A.globalPosition);
    const rb = pb.sub(B.globalPosition);
    const raxn = ra.cross(n);
    const rbxn = rb.cross(n);
    const w =
      invMassOf(A) + invMassOf(B) + raxn * raxn * invInertiaOf(A) + rbxn * rbxn * invInertiaOf(B);
    if (w <= 0) return;
    // The constraint as the quantity that must stay non-negative - the SLACK,
    // `L - |d|` - and its rate, which is minus the rate the segment lengthens
    // at; the same shape as a contact's separation and closing speed, so the
    // same solve applies.
    const slackRate = -n.dot(knotVelocity(B, pb).sub(knotVelocity(A, pa)));
    const applied = ropeImpulse(this, this.length - len, slackRate, w, h, soft, useBias);
    if (applied === 0) return;
    const impulse = n.mul(applied);
    applyAt(A, impulse, ra);
    applyAt(B, impulse.neg(), rb);
  }
}

// The accumulated-impulse update every rope-like row shares, given the slack,
// its rate and the row's effective inverse mass: the increment that drives the
// slack rate to the bias, clamped so the total never pushes. Returns what was
// applied this call.
export function ropeImpulse(
  row: { impulse: number },
  slack: number,
  slackRate: number,
  w: number,
  h: number,
  soft: Softness,
  useBias: boolean,
): number {
  let bias = 0;
  let massScale = 1;
  let impulseScale = 0;
  if (slack > 0) {
    bias = slack / h;
  } else if (useBias) {
    bias = soft.biasRate * slack;
    massScale = soft.massScale;
    impulseScale = soft.impulseScale;
  }
  const inc = (-massScale * (slackRate + bias)) / w - impulseScale * row.impulse;
  const next = Math.max(row.impulse + inc, 0);
  const applied = next - row.impulse;
  row.impulse = next;
  return applied;
}

// One authored chain tied through N bodies (`ChainData.through`).
export class TieChain implements IslandUnit {
  readonly segments: readonly TieSegment[];
  // The distinct dynamic bodies the chain is knotted to, in route order. These
  // are the bodies the island integrates; a static knot (a post) is infinite
  // mass and simply holds.
  readonly bodies: readonly RigidBody2D[];
  // The static bodies it is knotted to, whose moving (a mover's post) is a
  // reason for a sleeping chain to get up.
  private readonly statics: readonly PhysicsBody2D[];
  private readonly sleptAtVersion: number[];
  // Asleep: out of the frame's solve entirely. Set and cleared only by
  // `TieSolver`, per island.
  asleep = false;

  constructor(
    readonly points: readonly TiePoint[],
    lengths: readonly number[],
    readonly substeps: number,
    readonly color: string | null,
  ) {
    const segments: TieSegment[] = [];
    let k = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      // Two consecutive knots on one body are the body itself and no rope.
      if (a.body === b.body) continue;
      segments.push(new TieSegment(a, b, lengths[k++]!));
    }
    this.segments = segments;
    const bodies: RigidBody2D[] = [];
    const statics: PhysicsBody2D[] = [];
    for (const p of points) {
      if (p.body instanceof RigidBody2D) {
        if (!bodies.includes(p.body)) bodies.push(p.body);
      } else if (!statics.includes(p.body)) {
        statics.push(p.body);
      }
    }
    this.bodies = bodies;
    this.statics = statics;
    this.sleptAtVersion = statics.map(() => -1);
    for (const s of segments) s.measure();
  }

  get rows(): readonly IslandRow[] {
    return this.segments;
  }

  // The worst segment residual at the end of the last frame.
  get over(): number {
    let worst = 0;
    for (const s of this.segments) if (s.over > worst) worst = s.over;
    return worst;
  }

  // The chain's length as it stands, every segment summed.
  get currentLength(): number {
    let sum = 0;
    for (const s of this.segments) sum += s.current;
    return sum;
  }

  // Every knot's world point in route order: what the renderers draw.
  path(): Vec2[] {
    return this.points.map((p) => p.world());
  }

  fallAsleep(): void {
    this.asleep = true;
    for (let i = 0; i < this.statics.length; i++) {
      this.sleptAtVersion[i] = this.statics[i]!.transformVersion;
    }
  }

  anchorsMoved(): boolean {
    for (let i = 0; i < this.statics.length; i++) {
      if (this.statics[i]!.transformVersion !== this.sleptAtVersion[i]) return true;
    }
    return false;
  }
}

// --- bodies -----------------------------------------------------------------

export function invMassOf(body: PhysicsBody2D): number {
  return body instanceof RigidBody2D ? body.inverseMass : 0;
}

// As `World.solveContacts` reads it: a kinematically turned body (the steered
// ball) is rotationally locked to a row, and a static is both zeros.
export function invInertiaOf(body: PhysicsBody2D): number {
  if (!(body instanceof RigidBody2D)) return 0;
  return body.kinematicRotation ? 0 : body.inverseInertia;
}

// The velocity of a knot on a body, for a row's rate. A body whose rotation is
// driven kinematically - the steered ball, whose aim writes its spin every
// frame - carries its knot round its rim at a speed no impulse can change
// (`invInertiaOf` is 0 for it), so to a row that rim motion is an infinite
// reservoir: read into the rate, a rope from the ball's rim to a hanging
// weight saw the rim coming and going at the aim's 33 rad/s and spent impulses
// cancelling it, and the only things those impulses could move were the ball's
// centre and the weight - 17 m/s out of a hand's whirl (`hung-anchor`). The
// winch that spin genuinely drives is the coil (`Rope.syncCoil`), which
// reaches a row as its length, so the knot's velocity is the centre's.
export function knotVelocity(body: PhysicsBody2D, at: Vec2): Vec2 {
  if (body instanceof RigidBody2D && body.kinematicRotation) return body.linearVelocity;
  return body.velocityAtPoint(at);
}

// The tangential slip a body's KINEMATIC spin presents at arm `r`: zero for
// every body whose spin an impulse can change.
function spinSlipOf(body: RigidBody2D, r: Vec2, tangent: Vec2): number {
  return body.kinematicRotation ? body.angularVelocity * r.cross(tangent) : 0;
}

// Apply `impulse` at arm `r` to a body (a static takes nothing).
export function applyAt(body: PhysicsBody2D, impulse: Vec2, r: Vec2): void {
  if (!(body instanceof RigidBody2D)) return;
  body.linearVelocity = body.linearVelocity.add(impulse.mul(body.inverseMass));
  body.angularVelocity += r.cross(impulse) * invInertiaOf(body);
}

// Is this body one an island integrates, if a unit holds it: any rigid body.
// A pivot turns on its bearing and a spring body hangs on its stem, and the
// island steps both as `World.integrate` does, substep by substep. Left to the
// world's once-a-frame step with the row's impulse handed over as velocity, a
// pivot stood still through the substeps with its speed live in the row: the
// ball whirled on a root 108 kg and 1.5 m long ended every frame 1-4 mm over a
// chain that was 8-35 mm slack once the root took its step, and the unwind
// charged that to the spin and refused the whole of every turn
// (`session-97f-1` f50-62); and a sprung log the drum wound into a static went
// 47 mm into it in three frames, its bearing's step unable to hear the
// island's contact (`session-136f` f132-135).
export function islandOwns(body: PhysicsBody2D): body is RigidBody2D {
  return body instanceof RigidBody2D;
}

// --- contact rows -----------------------------------------------------------

// A contact between a held body and the scenery, another held body or a free
// body, as a row. The world's narrowphase gives one point, a normal out of `b`
// toward `a` and a depth; the point is carried in each body's frame so the
// separation can be re-read as the bodies move through the substep (Box2D's
// anchors), and the whole of it is gathered again at the top of every
// substep (`place`, see `TieSolver.solveIsland`).
class ContactRow {
  // The contact as last gathered, where the frame's impulses are written back.
  c: ContactConstraint;
  readonly a: RigidBody2D;
  readonly b: PhysicsBody2D;
  la: Vec2;
  // `a`'s shape is a circle on its body's origin (see the constructor).
  readonly aRound: boolean;
  lb: Vec2;
  normal: Vec2;
  tangent: Vec2;
  // Separation at the substep's gather: negative is penetration.
  s0: number;
  readonly friction: number;
  readonly restitution: number;
  // Relative normal velocity when the row was first gathered, for restitution
  // after the substeps.
  readonly vn0: number;
  // Gathered at the top of this substep: a row whose feature the narrowphase
  // no longer reports applies nothing until it does again.
  live = true;
  readonly key: string;
  // Solved without softness in the biased pass (see `TieSolver.hardBody`).
  readonly hard: boolean;
  // The coefficient that resists slip the kinematic spin is NOT driving -
  // the haul of the ball's own chain along a face, a slide - where `friction`
  // is the spin's drive traction. The same for every contact but the ball's
  // hard rows (see `solveContact`).
  readonly brake: number;
  // The ball's chain's own press into this contact, which funds none of its
  // friction (see `TieSolver.chainPress`), or null.
  readonly press: ((normal: Vec2) => number) | null;
  // `press` read once at the top of the substep and held through its passes:
  // read live, the cone moved as the motor's impulse did inside the substep,
  // the warm-started friction was clamped back out of a cone that had just
  // shrunk, and the contact flipped the ball's speed along the face by
  // 1.4 m/s inside every substep - a ball hauled up a face jerked away from
  // it each time it touched (`session-165f` f74, 0.58 m/s along it in, 2.59
  // out).
  pressNow = 0;
  // A kinematic spin no chain holds is a FREE spinning body's (the ball with
  // its chain stowed, in flight or dangling - `RigidBody2D.constraintTethered`
  // false), and its drive may spend only what the body's own weight presses
  // into this surface: the world's spin-traction cap (`World.solveTangent`,
  // `spinCone`), per substep. The spin is an infinite reservoir, and an
  // impact's normal impulse spent against it is energy from nothing - a ball
  // rolled into a wall with its chain dangling climbed it (`session-251f`,
  // `ball-roll-wall-dangling`). `weightPress` is that weight into the
  // surface, N: the spinning body's own mass, not the pair's effective mass -
  // a ball resting on a light slat presses it with all of its weight, and
  // read through the pair it funded a fraction of that and the ball could not
  // roll the deck (`bridge-ball-rolls`). The world reaches the same number on
  // a light body through its sustained-load ramp (`World.pairLoad`), which the
  // island keeps no books for; nor does it take off the normal a spun
  // off-centre shape fabricates (`spinFabricatedNormal`).
  readonly freeSpin: boolean;
  weightPress = 0;
  private readonly freeA: boolean;
  private readonly freeB: boolean;
  private readonly gravity: Vec2;
  // The accumulated impulses: each substep's, warm started from the one
  // before, so after the last substep they are what that substep spent.
  n = 0;
  t = 0;
  maxN = 0;
  // Whether the last friction solve ended at the cone, and whether any
  // substep's did: the frame's statement (see the write-back).
  limited = false;
  limitedAny = false;
  // What the contact spent over the whole frame: every substep's `n` and `t`
  // as it ended (each substep re-applies its accumulated impulse from the warm
  // start up), and restitution's after them - Box2D v3's
  // `totalNormalImpulse`, and the number the world's one-pass solve reports.
  totalN = 0;
  totalT = 0;

  constructor(
    c: ContactConstraint,
    friction: number,
    hard: boolean,
    press: ((normal: Vec2) => number) | null,
    // `a` is the ball itself, not a holder on its path (see `aRound`, `brake`).
    ball: boolean,
    gravity: Vec2,
  ) {
    this.c = c;
    this.hard = hard;
    this.brake = hard && ball ? c.a.staticFriction * c.b.surfaceFriction : friction;
    this.press = press;
    this.a = c.a;
    this.b = c.b;
    // A circle centred on its body meets a face at the same point however the
    // body turns, so its anchor is held in the WORLD frame, not carried round
    // with the body: carried, the ball's own spin swung the point round the
    // rim and the contact read the chord as separation - R(1 - cos θ), 3.2 mm
    // for the 0.23 rad a frame's kinematic turn makes inside the island
    // before the unwind hands it back - and let the chain haul the ball that
    // far into a face it is wound against, every frame, the push-out paying
    // it back as lease (`session-187f` f134-185, 49 mm of lease to 617).
    const shapeA = c.a.collisionShapes[c.shapeA];
    this.aRound =
      hard &&
      ball &&
      shapeA !== undefined &&
      shapeA.shape.kind === "circle" &&
      shapeA.localOffset.x === 0 &&
      shapeA.localOffset.y === 0;
    this.friction = friction;
    this.restitution = Math.max(c.a.restitution, c.b.restitution);
    this.vn0 = c.a.velocityAtPoint(c.point).sub(c.b.velocityAtPoint(c.point)).dot(c.normal);
    const bRigid = c.b instanceof RigidBody2D ? c.b : null;
    this.freeA = c.a.kinematicRotation && !c.a.constraintTethered;
    this.freeB = bRigid !== null && bRigid.kinematicRotation && !bRigid.constraintTethered;
    this.freeSpin = this.freeA || this.freeB;
    this.gravity = gravity;
    this.key = contactKey(c);
    this.c = c;
    this.la = this.lb = this.normal = this.tangent = Vec2.ZERO;
    this.s0 = 0;
    this.place(c);
  }

  // The row's geometry from a gather of its feature at the bodies' present
  // poses.
  place(c: ContactConstraint): void {
    this.c = c;
    const offsetA = c.point.sub(c.a.globalPosition);
    this.la = this.aRound ? offsetA : offsetA.rotated(-c.a.globalRotation);
    this.lb = c.point.sub(c.b.globalPosition).rotated(-c.b.globalRotation);
    this.normal = c.normal;
    this.tangent = new Vec2(-c.normal.y, c.normal.x);
    this.s0 = -c.depth;
    const g = this.gravity;
    const b = this.b;
    this.weightPress =
      (this.freeA ? this.a.mass * this.a.gravityScale * Math.max(0, -g.dot(c.normal)) : 0) +
      (this.freeB && b instanceof RigidBody2D ? b.mass * b.gravityScale * Math.max(0, g.dot(c.normal)) : 0);
  }
}

function contactKey(c: ContactConstraint): string {
  return `${c.a.id}:${c.b.id}:${c.shapeA}:${c.shapeB}:${c.featureId}`;
}

// The world's narrowphase for one contact's shape pair at the bodies' present
// poses, out to the reach the frame's gather used, appending to `out`.
export type IslandCollide = (c: ContactConstraint, dt: number, out: ContactConstraint[]) => void;

// The world's swept position step for one body over `h`: along its velocity,
// stopping at the static geometry it would cross.
export type IslandSweep = (body: RigidBody2D, h: number) => void;

interface CachedImpulse {
  n: number;
  t: number;
}

// --- the solver -------------------------------------------------------------

export class TieSolver {
  // The tied chains (`ChainData.through`), kept apart for the renderers and
  // the digest...
  readonly chains: TieChain[] = [];
  // ...and every unit, chains included: what the islands are built over.
  readonly units: IslandUnit[] = [];
  // The ball's chain as a unit of its own (`BallChainRow` in
  // `level/chains.ts`, the plan's third stage): set by the level before each
  // `World.integrate` on the frames the chain is a row, null otherwise. Its
  // bodies are the ball and whatever free bodies its path runs over, so it
  // joins the island of the slat it is hooked to by sharing that body, and
  // the ball's arrest, its weight and its winch reach the bridge through one
  // solve rather than a positional haul the island then has to undo.
  //
  // It replaced the GUEST row stage 1 shipped - the free span from the coil
  // to the knot as a tie segment, the chain phase still positional with the
  // slat immovable to it. That split leaked by construction: the gravity step
  // dropped the ball 2.7 mm a frame that the row restored in velocity and not
  // in position, the positional solve hauled it back into the slat, and the
  // pair separation kicked the slat 3 rad/s a frame for its share
  // (`session-1118f` f1012-1024, 52 J unforced); wound tight with the chain
  // over a slat edge the guest was gone and the same loop spun a slat 32 rad/s
  // a frame and flung two others at 13 m/s (`session-394f` f237-241).
  ballRow: IslandUnit | null = null;
  // The ball the ball's row holds, whose contacts with the SCENERY are solved
  // hard: no softness and no push-out bias in the biased pass, so a contact
  // only ever stops the ball's motion into a surface and never pushes it back
  // out (the chain phase's static push-out does that, in position alone).
  // Soft, the 30 Hz contact lost to the 60 Hz chain row whose drum reels
  // without bound: the ball sank 4-9 cm a frame into a wall it was hauled
  // along, the push-out bias that recovered it inflated the normal impulse
  // to 9-14 kN·s a frame where the chain's pull into the wall asked for a
  // fraction of that, and the friction cone it opened let the kinematic spin
  // roll the ball UP the wall away from its anchor while the drum wound on
  // (`session-1052f` f290-303). Against a contact that cannot be pushed into,
  // the normal impulse is the chain's pull into the surface and nothing more.
  // Only the scenery: a slat the ball rests on is a body of the island, and
  // their contact stays the island's soft row.
  hardBody: RigidBody2D | null = null;
  // The free bodies on the ball's chain's path, whose contacts with the
  // scenery are hard rows as the ball's are: the chain hauls them into a wall
  // as it hauls the ball, and soft they sank the same way - a 294 kg anchor
  // 53 mm into a static, recovering 6 mm a frame (`session-726f` f194).
  hardHolders: readonly RigidBody2D[] = [];
  // The impulse the ball's chain is pressing it into a face with, along that
  // face's normal, this substep: friction is funded by the face's load LESS
  // this. The haul of a winding chain slides the ball along whatever it is
  // pressed against, as the positional phase's length projection always did
  // - friction there acts on velocity and never on the correction - and
  // what grips is what the ball's other loads press (its weight on a floor).
  // Counted as load, the chain's own press bought grip against itself: the
  // ball's drive traction of 3.8, or even its sliding 0.58, against a pull
  // 0.90 into a face held it still while the drum wound on (`session-105f`,
  // `session-187f`, `session-119f`). It once launched the ball (`session-85f`
  // f51, 1000 J off a ceiling) when the drum was an unbounded rate that
  // pulled through slack; the drum is a speculative motor now (see
  // `BallChainRow.RATED_PULL`).
  chainPress: ((normal: Vec2) => number) | null = null;
  // The ball's dangling hook while it is the chain's end, and the chain's
  // pull on it into a face (`BallChainRow.tipPressInto`): what the chain
  // presses the tip into funds none of its grip, as for the ball, so a
  // pinned tip slides off instead of holding the chain.
  tipBody: RigidBody2D | null = null;
  tipPress: ((normal: Vec2) => number) | null = null;
  // The movers that moved this frame (set by `World.stepTies`). A mover's
  // script puts it at the END of the frame before anything is solved, with
  // its velocity the frame's displacement over the frame, and an island that
  // left it there saw a node standing still through the substeps while its
  // speed was live in every row and contact that touched it: a ball anchored
  // to a mover moving away was a frame's travel behind it at the end of every
  // frame, which the unwind charged to the spin, and one moving towards it a
  // frame's travel slack - the same lag a pivot stepped once a frame had
  // (`islandOwns`). So the island takes each one back to where the frame
  // found it and carries it by its velocity substep by substep, which sums to
  // where the script put it, and puts it exactly there afterwards.
  driven: readonly AnimatableBody2D[] = [];
  // Last frame's accumulated contact impulses by contact key, looked up only.
  private contactCache = new Map<string, CachedImpulse>();
  // This frame's contact rows by every gather of the contact they solve, for
  // `engaged`.
  private rowOf = new Map<ContactConstraint, ContactRow>();

  // The narrowphase every substep gathers the island's contacts with (see
  // `solveIsland`), the world's own (`World.recollide`), and the swept
  // position step a `continuous` body takes through each substep, the
  // world's own (`World.integrateContinuous`).
  constructor(
    private readonly collide: IslandCollide,
    private readonly sweep: IslandSweep,
  ) {}

  // Is this contact's face engaged as the island stands: closed (the row's
  // separation re-read at the bodies' present poses) or carrying load (its
  // accumulated normal impulse, the last substep's, or last frame's
  // warm-started before the first). A gathered contact may be a speculative
  // one up to `CONTACT_SLOP` clear of its face, which refuses nothing; and
  // load alone is not enough either, because a soft row touching a free body
  // carries nothing on the substeps it is recovering, and a drum that reeled
  // through those wound the ball and the weight it hangs from into a 5 m/s
  // slingshot (`hung-anchor`).
  // A row the substep's gather no longer reports is engaged with nothing:
  // its anchors are where it last stood, and read at the bodies' present
  // poses they answered "closed" for a face 19 cm away (`session-126f` f97).
  engaged(c: ContactConstraint): boolean {
    const row = this.rowOf.get(c);
    return row !== undefined && row.live && (row.n > 0 || separationOf(row) <= 0);
  }
  // The islands this frame was solved in, kept for the sleep pass.
  private frameIslands: IslandUnit[][] = [];

  get active(): boolean {
    return this.units.length > 0 || this.ballRow !== null;
  }

  add(chain: TieChain): void {
    this.chains.push(chain);
    this.addUnit(chain);
  }

  addUnit(unit: IslandUnit): void {
    this.units.push(unit);
    for (const body of unit.bodies) body.tied = true;
  }

  // A unit whose bodies changed - an authored chain's path wrapping onto a
  // free body, or off one (`RopeRow.sync`) - is re-tied: what it took is the
  // island's, and what it let go is free again unless another unit still
  // holds it. Before the world steps, since `tied` is what keeps a body out of
  // `World.integrate`'s own step.
  retie(unit: IslandUnit, before: readonly RigidBody2D[]): void {
    for (const body of unit.bodies) body.tied = true;
    for (const body of before) {
      if (unit.bodies.includes(body)) continue;
      if (this.units.some((u) => u !== unit && u.bodies.includes(body))) continue;
      body.tied = false;
    }
  }

  // A unit that exists only while something holds it (a berry plant on the
  // ball's chain) leaves the solve with its bodies free again.
  removeUnit(unit: IslandUnit): void {
    const i = this.units.indexOf(unit);
    if (i < 0) return;
    this.units.splice(i, 1);
    for (const body of unit.bodies) body.tied = false;
  }

  // Is this contact the island's to solve: anything touching a held body. The
  // scenery and other held bodies, and also a FREE body - the ball on a slat -
  // which is solved here with its real mass and never integrated here (the
  // world steps it), so that it and the slat agree at the end of the frame.
  // Solved in the world instead, with the ties riding along in its velocity
  // iterations, the ball and the slat agreed after the world's solve and then
  // disagreed by exactly the island's correction: the slat was lifted back
  // onto its bridge and the ball was left falling at 0.2 m/s, every frame, and
  // the slat under it turned ±6 rad/s frame to frame for ever.
  static ownsContact(c: ContactConstraint): boolean {
    return c.a.tied || (c.b instanceof RigidBody2D && c.b.tied);
  }

  // One frame of every unit, with the island contacts the world gathered.
  // `only` narrows the frame to some of the units: the build settle steps the
  // units that hang clear and leaves the rest for play.
  step(
    contacts: readonly ContactConstraint[],
    gravity: Vec2,
    dt: number,
    only: ReadonlySet<IslandUnit> | null = null,
  ): ContactConstraint[] {
    const t0 = SolverStats.now();
    const all = this.ballRow ? [...this.units, this.ballRow] : this.units;
    const units = only ? all.filter((u) => only.has(u)) : all;
    // Top of the frame: a sleeping unit gets up if anything woke one of its
    // bodies (the ball's contact, an impulse, the avatar's chain reaching it)
    // or moved one of its static knots. An awake unit keeps its bodies awake.
    for (const unit of units) {
      if (unit.asleep) {
        let disturbed = unit.anchorsMoved();
        for (const body of unit.bodies) if (!body.asleep) disturbed = true;
        if (!disturbed) continue;
        unit.asleep = false;
      }
      for (const body of unit.bodies) body.wake();
    }
    // A contact wakes the held body it pushes, as the world's own solve wakes
    // the body on the far side of a contact.
    for (const c of contacts) {
      if (c.b instanceof RigidBody2D && c.b.asleep) c.b.wake();
    }
    const islands = this.islands(units, contacts);
    this.frameIslands = islands;
    this.rowOf.clear();
    // The frame's contacts as the substeps last gathered them, in the order
    // the world gave them, and after them any feature a substep met that the
    // frame's gather had not (see `solveIsland`).
    const last = new Map<ContactConstraint, ContactRow>();
    const born: ContactRow[] = [];
    for (const island of islands) {
      // Whole or not at all: one awake unit in an island wakes the rest.
      let awake = false;
      for (const unit of island) if (!unit.asleep) awake = true;
      if (!awake) continue;
      for (const unit of island) {
        if (unit.asleep) {
          unit.asleep = false;
          for (const body of unit.bodies) body.wake();
        }
      }
      this.solveIsland(island, contacts, gravity, dt, last, born);
    }
    const out = contacts.map((c) => last.get(c)?.c ?? c);
    for (const row of born) out.push(row.c);
    if (SolverStats.enabled) SolverStats.chainMs += performance.now() - t0;
    return out;
  }

  // The connected components of "shares a held body" over the units, with two
  // units whose bodies touch this frame joined as well: a crate hung on one
  // chain resting on a slat of another is one system while they touch.
  private islands(
    units: readonly IslandUnit[],
    contacts: readonly ContactConstraint[],
  ): IslandUnit[][] {
    const n = units.length;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]!]!;
        i = parent[i]!;
      }
      return i;
    };
    const union = (i: number, j: number): void => {
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[b] = a;
    };
    const owner = new Map<RigidBody2D, number>();
    for (let i = 0; i < n; i++) {
      for (const body of units[i]!.bodies) {
        const j = owner.get(body);
        if (j === undefined) owner.set(body, i);
        else union(i, j);
      }
    }
    for (const c of contacts) {
      if (!(c.b instanceof RigidBody2D)) continue;
      const i = owner.get(c.a);
      const j = owner.get(c.b);
      if (i !== undefined && j !== undefined) union(i, j);
    }
    const groups = new Map<number, IslandUnit[]>();
    const out: IslandUnit[][] = [];
    for (let i = 0; i < n; i++) {
      const root = find(i);
      const group = groups.get(root);
      if (group) group.push(units[i]!);
      else {
        const fresh = [units[i]!];
        groups.set(root, fresh);
        out.push(fresh);
      }
    }
    return out;
  }

  private solveIsland(
    island: readonly IslandUnit[],
    contacts: readonly ContactConstraint[],
    gravity: Vec2,
    dt: number,
    last: Map<ContactConstraint, ContactRow>,
    born: ContactRow[],
  ): void {
    let k = 1;
    const bodies: RigidBody2D[] = [];
    const inIsland = new Set<RigidBody2D>();
    const rows: IslandRow[] = [];
    const undamped = new Set<RigidBody2D>();
    for (const unit of island) {
      if (unit.substeps > k) k = unit.substeps;
      for (const body of unit.bodies) {
        if (!body.removed && !inIsland.has(body)) {
          bodies.push(body);
          inIsland.add(body);
        }
        if (unit.undamped) undamped.add(body);
      }
      for (const row of unit.rows) rows.push(row);
    }
    const contactRows: ContactRow[] = [];
    const rowByKey = new Map<string, ContactRow>();
    const makeRow = (c: ContactConstraint): ContactRow => {
      // `b` is the scenery whenever it is not a rigid body (`a` always is).
      const hard =
        !(c.b instanceof RigidBody2D) &&
        ((this.hardBody !== null && c.a === this.hardBody) || this.hardHolders.includes(c.a));
      // The chain's press funds no grip on ANY face the ball is against, a
      // holder on its path as much as the scenery: chained to a 430 kg block
      // and resting on it, the ball was held still by the grip its own
      // chain's squeeze bought, the length row reached 16-40 kN, and the two
      // soft corrections pumped 15-39 J a frame into the pair with no input
      // at all (`session-1195f` f278-307). The normal points out of `b`, so
      // the face's outward normal at the ball is `-normal` when the ball is
      // `b`.
      const tipPress = this.tipPress;
      const press =
        this.hardBody !== null && this.chainPress !== null && c.a === this.hardBody
          ? this.chainPress
          : this.hardBody !== null && this.chainPress !== null && c.b === this.hardBody
            ? (normal: Vec2) => this.chainPress!(normal.neg())
            : tipPress !== null && c.a === this.tipBody
              ? tipPress
              : tipPress !== null && c.b === this.tipBody
                ? (normal: Vec2) => tipPress(normal.neg())
                : null;
      const row = new ContactRow(c, pairFriction(c), hard, press, c.a === this.hardBody, gravity);
      const cached = this.contactCache.get(row.key);
      if (cached) {
        row.n = cached.n;
        row.t = cached.t;
      }
      contactRows.push(row);
      rowByKey.set(row.key, row);
      this.rowOf.set(c, row);
      return row;
    };
    // The shape pairs the frame's gather found within reach, each gathered
    // again at the top of every substep. Gathered once, at the poses the
    // frame found the bodies in, a contact's normal was the frame's for all
    // eight substeps while the gather reached out a whole frame's travel
    // (`World.gatherReach`): a ball swung past a corner it clears by 36 mm
    // read its travel along that frame-start normal as closing on the corner,
    // and at 20 m/s it was stopped and thrown straight up at 14 m/s in the
    // first frame (`island-corner-graze`). Gathered per substep, a row can
    // only be wrong about the substep's own travel - the bodies are gathered
    // once a frame for candidates and every substep for contacts, as XPBD's
    // substepped rigid bodies are (Müller et al. 2020, section 3.5).
    const pairs: ContactConstraint[] = [];
    const pairSeen = new Set<string>();
    for (const c of contacts) {
      if (!inIsland.has(c.a) && !(c.b instanceof RigidBody2D && inIsland.has(c.b))) continue;
      last.set(c, makeRow(c));
      const pair = `${c.a.id}:${c.b.id}:${c.shapeA}:${c.shapeB}`;
      if (pairSeen.has(pair)) continue;
      pairSeen.add(pair);
      pairs.push(c);
    }
    const gathered: ContactConstraint[] = [];
    // `open`: the top of a substep, where a feature the narrowphase no longer
    // reports leaves the solve. Before the relax a row stays in for the pass
    // whatever the gather says, at the geometry it had: the relax is what
    // takes back what the biased pass left in it, and a row dropped between
    // the two kept its warm start in the bodies' velocity. A ball the chain
    // had crushed into the corner of a belt and a wall started its frame
    // with 2.6 kN·s warm in each of the two rows, moved 8 cm off both in the
    // first substep - out of the slop - and was launched at 40 m/s
    // (`ride-tear` f104).
    const regather = (open: boolean): void => {
      gathered.length = 0;
      for (let i = 0; i < pairs.length; i++) this.collide(pairs[i]!, dt, gathered);
      if (open) for (let i = 0; i < contactRows.length; i++) contactRows[i]!.live = false;
      for (let i = 0; i < gathered.length; i++) {
        const c = gathered[i]!;
        const row = rowByKey.get(contactKey(c));
        if (row === undefined) {
          const fresh = makeRow(c);
          // Met after the warm start, a row has applied nothing yet, and last
          // frame's impulse counted as applied would be taken back from the
          // bodies by the relax.
          if (!open) fresh.n = fresh.t = 0;
          born.push(fresh);
          continue;
        }
        row.place(c);
        row.live = true;
        this.rowOf.set(c, row);
      }
      // A feature the narrowphase stopped reporting holds nothing over: its
      // impulse would warm start the next substep into a face it is not on.
      for (let i = 0; i < contactRows.length; i++) {
        const row = contactRows[i]!;
        if (row.live) continue;
        row.n = 0;
        row.t = 0;
      }
    };

    const h = dt / k;
    // The island's spin motors (`RigidBody2D.spinMotorActive`): the steered
    // ball's, solved substep by substep beside the rows that resist it - first
    // in each pass, as a joint's motor is - so the chain's pull on the rim and
    // the motor's rating meet in one solve.
    const motors: RigidBody2D[] = [];
    for (const body of bodies) if (body.spinMotorActive) motors.push(body);
    const tieSoft = softness(Math.min(TieTuning.hertz, 0.25 / h), TieTuning.damping, h);
    const contactSoft = softness(Math.min(CONTACT_HERTZ, 0.25 / h), CONTACT_DAMPING, h);

    for (const row of rows) row.beginFrame(dt, contacts);
    // Once a frame, before anything is measured, as the chain phase damps its
    // bodies (see `TIE_BODY_DAMPING`). Not a pivot or a spring body: their
    // mountings carry their own damping and the world takes nothing else off
    // them, so a root swings the same with a chain hung from it as without.
    for (const body of bodies) {
      if (body.held || !body.canSleep || undamped.has(body)) continue;
      if (body.pivot || body.spring !== null) continue;
      body.linearVelocity = body.linearVelocity.mul(TIE_BODY_DAMPING);
      body.angularVelocity *= TIE_BODY_DAMPING;
    }

    // The substeps are the island's hot loop (a held berry plant: eight of
    // them over some 230 rows), so their loops are indexed - a `for...of`
    // over an array allocated an iterator result per element there - and the
    // integration is written in scalars, `v += gravity·(gravityScale·h)` and
    // `p += v·h` with the same operations and no vector to throw away.
    // A pivot's mounting acceleration is summed over the substeps for the
    // rope's credit bound, as `World.integrate` records its frame's.
    for (const body of bodies) if (body.pivot) body.pivotFrameAccelDw = 0;
    // The movers back to where the frame found them (see `driven`).
    const driven = this.driven;
    const drivenEnd: { position: Vec2; rotation: number }[] = [];
    for (const body of driven) {
      drivenEnd.push({ position: body.globalPosition, rotation: body.globalRotation });
      body.globalPosition = body.framePosition;
      body.globalRotation = body.frameRotation;
    }
    for (let s = 0; s < k; s++) {
      for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i]!;
        if (body.pivot) {
          // A pivot turns on its bearing and nothing translates it, stepped
          // as `World.integrate` steps it (see there): the linear velocity an
          // area wrote is cancelled, and the off-centre bearing's gravity
          // torque and the torsion spring are taken substep by substep.
          body.linearVelocity = Vec2.ZERO;
          const alpha = body.pivotAcceleration(gravity);
          if (alpha !== 0) body.angularVelocity += alpha * h;
          body.pivotFrameAccelDw += alpha * h;
          continue;
        }
        const v = body.linearVelocity;
        const gs = body.gravityScale * h;
        let dvx = gravity.x * gs;
        let dvy = gravity.y * gs;
        if (body.spring) {
          // A spring body hangs on its stem and does not spin (see
          // `RigidBody2D.spring`).
          const a = body.springAcceleration();
          dvx += a.x * h;
          dvy += a.y * h;
          body.angularVelocity = 0;
        }
        body.linearVelocity = new Vec2(v.x + dvx, v.y + dvy);
      }
      // The contacts, and a rope's wrap path, against the bodies as they now
      // stand.
      regather(true);
      for (let i = 0; i < rows.length; i++) rows[i]!.prepare(h);
      // Warm start: last substep's answer, applied before the first iteration.
      for (let i = 0; i < rows.length; i++) rows[i]!.warmStart();
      for (let i = 0; i < motors.length; i++) beginSpinMotorStep(motors[i]!, h);
      for (let i = 0; i < contactRows.length; i++) {
        const row = contactRows[i]!;
        if (!row.live) continue;
        row.pressNow = row.press !== null ? row.press(row.normal) : 0;
        warmStartContact(row);
      }
      // Solve with bias. The rows alternate direction substep by substep, so
      // the order bias of one pass is the mirror of the next's.
      for (let i = 0; i < motors.length; i++) solveSpinMotor(motors[i]!);
      solveRows(rows, h, tieSoft, true, s % 2 === 1);
      for (let i = 0; i < contactRows.length; i++) {
        const row = contactRows[i]!;
        if (row.live) solveContact(row, h, row.hard ? RIGID : contactSoft, !row.hard);
      }      for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i]!;
        // A `continuous` body (the ball, its hook) is swept against the
        // scenery as the world sweeps it when free, so no substep carries it
        // across a face its contacts had not reached (see `World.recollide`).
        if (body.continuous) this.sweep(body, h);
        else {
          const p = body.globalPosition;
          const v = body.linearVelocity;
          body.globalPosition = new Vec2(p.x + v.x * h, p.y + v.y * h);
        }
        body.globalRotation += body.angularVelocity * h;
        if (body.spring) body.pinSpringAxes();
      }
      for (let i = 0; i < driven.length; i++) {
        const body = driven[i]!;
        const p = body.globalPosition;
        const v = body.linearVelocity;
        body.globalPosition = new Vec2(p.x + v.x * h, p.y + v.y * h);
        body.globalRotation += body.angularVelocity * h;
      }
      // Relax: the same rows against the new positions, with no bias, which
      // takes back the velocity the bias put in.
      regather(false);
      for (let i = 0; i < motors.length; i++) solveSpinMotor(motors[i]!);
      solveRows(rows, h, tieSoft, false, s % 2 === 1);
      for (let i = 0; i < contactRows.length; i++) {
        const row = contactRows[i]!;
        if (!row.live) continue;
        solveContact(row, h, RIGID, false);
        row.totalN += row.n;
        row.totalT += row.t;
      }
      for (let i = 0; i < motors.length; i++) endSpinMotorStep(motors[i]!, h);      if (SolverStats.enabled) {
        SolverStats.sweeps += 2;
        SolverStats.solves += 2 * (rows.length + contactRows.length);
      }
    }
    // Where the scripts put them, to the bit.
    for (let i = 0; i < driven.length; i++) {
      driven[i]!.globalPosition = drivenEnd[i]!.position;
      driven[i]!.globalRotation = drivenEnd[i]!.rotation;
    }
    for (const row of contactRows) if (row.live) applyRestitution(row);
    for (const row of contactRows) {
      // The last substep's impulses warm start the next frame's first...
      this.contactCache.set(row.key, { n: row.n, t: row.t });
      // ...and what the contact spent over the frame is written back where the
      // world's own solve writes it, so the grips, the braces, the hook's
      // attach, the breakables, the digest and `cli trace` read a contact the
      // island solved as they read any other. Written as the last substep's
      // alone, it read an eighth of a steady load (8.0x under, the median over
      // the bridge regressions' 1041 contact rows) and zero for one in twelve
      // that had pushed and was leaving by the end of the frame - the glass
      // ball bounced whole off the bed (`session-198f` f129, 89.7 N·s pushed).
      row.c.normalImpulse = row.totalN;
      row.c.tangentImpulse = row.totalT;
      // Whether the last substep's friction ended at its bound: a contact the
      // island solved reported "not limited" whatever it did, so `roll-unfunded`
      // read a ball hauled along a face its chain's press funds no grip on as
      // one rolling without slip and charged the slip to nothing (`session-537f`).
      // At the cone on ANY substep, since a contact that hit it slipped during
      // the frame: the last substep alone read a ball hauled 0.17 m/s along
      // the 280 kg body it rests on as rolling without slip, its cone moving
      // substep by substep with the chain's press (`session-379f` f333-363,
      // the frame's friction at 0.8-1.0 of the normal).
      row.c.limited = row.limitedAny;
      row.c.maxNormalImpulse = Math.max(row.maxN, row.n);
    }
    for (const row of rows) row.measure();
  }

  // End of the frame, after `World.settleSleep` has run the rest rule over the
  // bodies and marked the held ones that satisfy it (`RigidBody2D.restReady`)
  // rather than sleeping them one by one. An island sleeps when every body in
  // it is ready, and not before - which is the whole of why a bridge is an
  // island: a slat asleep while its neighbour is hauled is a bridge that has let
  // go of one end.
  settleSleep(): void {
    for (const island of this.frameIslands) {
      let awake = false;
      for (const unit of island) if (!unit.asleep) awake = true;
      if (!awake) continue;
      let ready = true;
      for (const unit of island) {
        for (const body of unit.bodies) {
          if (body.removed) continue;
          if (!body.asleep && !body.restReady) ready = false;
        }
      }
      if (!ready) continue;
      for (const unit of island) {
        for (const body of unit.bodies) if (!body.asleep) body.sleep();
        unit.fallAsleep();
      }
    }
    for (const unit of this.units) for (const body of unit.bodies) body.restReady = false;
  }
}

function pairFriction(c: ContactConstraint): number {
  const muA = c.a.contactFriction * c.b.surfaceFriction;
  if (!(c.b instanceof RigidBody2D)) return muA;
  return Math.sqrt(muA * c.b.contactFriction * c.a.surfaceFriction);
}

function solveRows(
  rows: readonly IslandRow[],
  h: number,
  soft: Softness,
  useBias: boolean,
  reverse: boolean,
): void {
  if (reverse) {
    for (let i = rows.length - 1; i >= 0; i--) rows[i]!.solve(h, soft, useBias);
  } else {
    for (let i = 0; i < rows.length; i++) rows[i]!.solve(h, soft, useBias);
  }
}

// From `a`'s centre to the contact, as the body now stands.
function armA(r: ContactRow): Vec2 {
  return r.aRound ? r.la : r.la.rotated(r.a.globalRotation);
}

function warmStartContact(r: ContactRow): void {
  if (r.n === 0 && r.t === 0) return;
  const pa = r.a.globalPosition.add(armA(r));
  const pb = r.b.globalPosition.add(r.lb.rotated(r.b.globalRotation));
  const impulse = r.normal.mul(r.n).add(r.tangent.mul(r.t));
  applyAt(r.a, impulse, pa.sub(r.a.globalPosition));
  applyAt(r.b, impulse.neg(), pb.sub(r.b.globalPosition));
}

// Coulomb friction then non-penetration, the world's own ordering, so the
// normal row has the last word over anything friction just did. The
// separation is re-read from the carried anchors; a separated contact may
// close at what would just touch this substep (speculative), a penetrating
// one is pushed out at the soft rate, capped.
function solveContact(r: ContactRow, h: number, soft: Softness, useBias: boolean): void {
  const A = r.a;
  const B = r.b;
  const ra = armA(r);
  const rb = r.lb.rotated(B.globalRotation);
  const pa = A.globalPosition.add(ra);
  const pb = B.globalPosition.add(rb);
  const n = r.normal;
  const tg = r.tangent;
  const invMa = invMassOf(A);
  const invMb = invMassOf(B);
  const invIa = invInertiaOf(A);
  const invIb = invInertiaOf(B);
  // Friction.
  if (r.friction > 0) {
    const raxt = ra.cross(tg);
    const rbxt = rb.cross(tg);
    const invEffT = invMa + invMb + raxt * raxt * invIa + rbxt * rbxt * invIb;
    if (invEffT > 1e-9) {
      // The slip at the rim, less the share of a kinematic spin the chain
      // phase refused last frame (`spinDriveShare`, 1 unless the unwind said
      // otherwise) - the world's own rule (`World.solveTangent`). The spin is
      // what rolls a steered ball along a slat, and it is an infinite
      // reservoir: read in full against the body the ball is wound tight onto,
      // friction became a motor and the ball and the weight it hung from
      // pumped to 10 m/s (`hung-anchor`); read at the centre alone the ball
      // could not roll a deck at all (`bridge-ball-rolls`). What the unwind
      // lets stand is what drives.
      let vt = A.velocityAtPoint(pa).sub(B.velocityAtPoint(pb)).dot(tg);
      vt -= spinSlipOf(A, ra, tg) * (1 - A.spinDriveShare);
      if (B instanceof RigidBody2D) vt += spinSlipOf(B, rb, tg) * (1 - B.spinDriveShare);
      // The cone is the spin's drive traction in the direction that cancels
      // the slip the spin is driving, and the ball's own sliding friction the
      // other way (`brake`, its `staticFriction`, the 30 degree breakaway):
      // the world's split between friction that drives a steered ball and
      // friction that brakes it (`BallPlayer.ROLL_FRICTION`). Without it, a
      // ball its chain presses into a face and hauls along it met the 3.8 of
      // its drive traction as stiction, three times the haul whatever the
      // tension, and stood still while the drum wound on against it
      // (`session-105f`, the pull 0.56 into the face and 0.83 along it); at
      // 0.58 it slides along the face towards its anchor, braked, as the
      // positional phase's length projection always let it.
      const drive = -Math.sign(spinSlipOf(A, ra, tg) * A.spinDriveShare);
      const load = Math.max(0, r.n - r.pressNow);
      let conePos = (drive > 0 ? r.friction : r.brake) * load;
      let coneNeg = (drive < 0 ? r.friction : r.brake) * load;
      if (r.freeSpin && drive !== 0) {
        const funded = r.friction * r.weightPress * h;
        if (drive > 0) conePos = Math.min(conePos, funded);
        else coneNeg = Math.min(coneNeg, funded);
      }
      const total = Math.min(conePos, Math.max(-coneNeg, r.t - vt / invEffT));
      // At the cone, as the world's solve reports it (`ContactConstraint.limited`).
      r.limited = total >= conePos - 1e-12 || total <= -coneNeg + 1e-12;
      if (r.limited) r.limitedAny = true;
      const applied = total - r.t;
      r.t = total;
      if (applied !== 0) {
        const impulse = tg.mul(applied);
        applyAt(A, impulse, ra);
        applyAt(B, impulse.neg(), rb);
      }
    }
  }
  // Non-penetration.
  const raxn = ra.cross(n);
  const rbxn = rb.cross(n);
  const invEffN = invMa + invMb + raxn * raxn * invIa + rbxn * rbxn * invIb;
  if (invEffN <= 1e-9) return;
  const s = pa.sub(pb).dot(n) + r.s0;
  const vn = A.velocityAtPoint(pa).sub(B.velocityAtPoint(pb)).dot(n);
  let bias = 0;
  let massScale = 1;
  let impulseScale = 0;
  if (s > 0) {
    bias = s / h;
  } else if (useBias) {
    bias = Math.max(soft.biasRate * s, -MAX_PUSH_VELOCITY);
    massScale = soft.massScale;
    impulseScale = soft.impulseScale;
  }
  const inc = (-massScale * (vn + bias)) / invEffN - impulseScale * r.n;
  const total = Math.max(r.n + inc, 0);
  const applied = total - r.n;
  r.n = total;
  if (total > r.maxN) r.maxN = total;
  if (applied === 0) return;
  const impulse = n.mul(applied);
  applyAt(A, impulse, ra);
  applyAt(B, impulse.neg(), rb);
}

// A contact row's separation at the bodies' present poses, from its anchors:
// negative is penetration (see `solveContact`).
function separationOf(r: ContactRow): number {
  const pa = r.a.globalPosition.add(armA(r));
  const pb = r.b.globalPosition.add(r.lb.rotated(r.b.globalRotation));
  return pa.sub(pb).dot(r.normal) + r.s0;
}

// After the substeps, as Box2D applies it: a contact that closed faster than
// the threshold and carried load gets its share of the closing speed back.
function applyRestitution(r: ContactRow): void {
  if (r.restitution === 0 || r.vn0 > -RESTITUTION_THRESHOLD || r.maxN === 0) return;
  const A = r.a;
  const B = r.b;
  const ra = armA(r);
  const rb = r.lb.rotated(B.globalRotation);
  const pa = A.globalPosition.add(ra);
  const pb = B.globalPosition.add(rb);
  const n = r.normal;
  const raxn = ra.cross(n);
  const rbxn = rb.cross(n);
  const invEffN =
    invMassOf(A) + invMassOf(B) + raxn * raxn * invInertiaOf(A) + rbxn * rbxn * invInertiaOf(B);
  if (invEffN <= 1e-9) return;
  const vn = A.velocityAtPoint(pa).sub(B.velocityAtPoint(pb)).dot(n);
  const inc = -(vn + r.restitution * r.vn0) / invEffN;
  const total = Math.max(r.n + inc, 0);
  const applied = total - r.n;
  r.n = total;
  r.totalN += applied;
  if (applied === 0) return;
  const impulse = n.mul(applied);
  applyAt(A, impulse, ra);
  applyAt(B, impulse.neg(), rb);
}
