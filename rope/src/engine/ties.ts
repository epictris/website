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
import { PhysicsBody2D, RigidBody2D } from "./body";
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

export function softness(hertz: number, zeta: number, h: number): Softness {
  if (hertz === 0) return RIGID;
  const omega = 2 * Math.PI * hertz;
  const a1 = 2 * zeta + h * omega;
  const a2 = h * omega * a1;
  const a3 = 1 / (1 + a2);
  return { biasRate: omega / a1, massScale: a2 * a3, impulseScale: a3 };
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
  // bodies, never a pivot or a spring body (those keep `World.integrate`'s own
  // step and take a row's impulses as velocity only).
  readonly bodies: readonly RigidBody2D[];
  readonly rows: readonly IslandRow[];
  readonly substeps: number;
  asleep: boolean;
  fallAsleep(): void;
  // Has a static the unit hangs from moved since it slept (a post on a mover)?
  anchorsMoved(): boolean;
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

// Is this body one an island integrates, if a unit holds it: a free rigid
// body. A pivot turns on a bearing and a spring body hangs on its stem, both
// stepped by `World.integrate` in ways the island does not reproduce, so a row
// on one applies its impulse as velocity and leaves the step to the world.
export function islandOwns(body: PhysicsBody2D): body is RigidBody2D {
  return body instanceof RigidBody2D && !body.pivot && body.spring === null;
}

// --- contact rows -----------------------------------------------------------

// A contact between a held body and the scenery, another held body or a free
// body, as a row. The world's narrowphase gives one point, a normal out of `b`
// toward `a` and a depth; the point is carried in each body's frame so the
// separation can be re-read as the bodies move through the substeps (Box2D's
// anchors), and the normal is held for the frame.
class ContactRow {
  readonly c: ContactConstraint;
  readonly a: RigidBody2D;
  readonly b: PhysicsBody2D;
  readonly la: Vec2;
  readonly lb: Vec2;
  readonly normal: Vec2;
  readonly tangent: Vec2;
  // Separation at collection: negative is penetration.
  readonly s0: number;
  readonly friction: number;
  readonly restitution: number;
  // Relative normal velocity at collection, for restitution after the substeps.
  readonly vn0: number;
  readonly key: string;
  n = 0;
  t = 0;
  maxN = 0;

  constructor(c: ContactConstraint, friction: number) {
    this.c = c;
    this.a = c.a;
    this.b = c.b;
    this.la = c.point.sub(c.a.globalPosition).rotated(-c.a.globalRotation);
    this.lb = c.point.sub(c.b.globalPosition).rotated(-c.b.globalRotation);
    this.normal = c.normal;
    this.tangent = new Vec2(-c.normal.y, c.normal.x);
    this.s0 = -c.depth;
    this.friction = friction;
    this.restitution = Math.max(c.a.restitution, c.b.restitution);
    this.vn0 = c.a.velocityAtPoint(c.point).sub(c.b.velocityAtPoint(c.point)).dot(c.normal);
    this.key = `${c.a.id}:${c.b.id}:${c.shapeA}:${c.shapeB}:${c.featureId}`;
  }
}

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
  // Last frame's accumulated contact impulses by contact key, looked up only.
  private contactCache = new Map<string, CachedImpulse>();
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
  ): void {
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
      this.solveIsland(island, contacts, gravity, dt);
    }
    if (SolverStats.enabled) SolverStats.chainMs += performance.now() - t0;
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
  ): void {
    let k = 1;
    const bodies: RigidBody2D[] = [];
    const rows: IslandRow[] = [];
    for (const unit of island) {
      if (unit.substeps > k) k = unit.substeps;
      for (const body of unit.bodies) {
        if (!body.removed && !bodies.includes(body)) bodies.push(body);
      }
      for (const row of unit.rows) rows.push(row);
    }
    const inIsland = new Set<RigidBody2D>(bodies);
    const contactRows: ContactRow[] = [];
    for (const c of contacts) {
      if (!inIsland.has(c.a) && !(c.b instanceof RigidBody2D && inIsland.has(c.b))) continue;
      const row = new ContactRow(c, pairFriction(c));
      const cached = this.contactCache.get(row.key);
      if (cached) {
        row.n = cached.n;
        row.t = cached.t;
      }
      contactRows.push(row);
    }

    const h = dt / k;
    const tieSoft = softness(Math.min(TieTuning.hertz, 0.25 / h), TieTuning.damping, h);
    const contactSoft = softness(Math.min(CONTACT_HERTZ, 0.25 / h), CONTACT_DAMPING, h);

    for (const row of rows) row.beginFrame(dt, contacts);
    // Once a frame, before anything is measured, as the chain phase damps its
    // bodies (see `TIE_BODY_DAMPING`).
    for (const body of bodies) {
      if (body.held || !body.canSleep) continue;
      body.linearVelocity = body.linearVelocity.mul(TIE_BODY_DAMPING);
      body.angularVelocity *= TIE_BODY_DAMPING;
    }

    for (let s = 0; s < k; s++) {
      for (const body of bodies) {
        body.linearVelocity = body.linearVelocity.add(gravity.mul(body.gravityScale * h));
      }
      // A rope regenerates its wrap path against the bodies as they now stand.
      for (const row of rows) row.prepare(h);
      // Warm start: last substep's answer, applied before the first iteration.
      for (const row of rows) row.warmStart();
      for (const row of contactRows) warmStartContact(row);
      // Solve with bias. The rows alternate direction substep by substep, so
      // the order bias of one pass is the mirror of the next's.
      solveRows(rows, h, tieSoft, true, s % 2 === 1);
      for (const row of contactRows) solveContact(row, h, contactSoft, true);
      for (const body of bodies) {
        body.globalPosition = body.globalPosition.add(body.linearVelocity.mul(h));
        body.globalRotation += body.angularVelocity * h;
      }
      // Relax: the same rows against the new positions, with no bias, which
      // takes back the velocity the bias put in.
      solveRows(rows, h, tieSoft, false, s % 2 === 1);
      for (const row of contactRows) solveContact(row, h, RIGID, false);
      if (SolverStats.enabled) {
        SolverStats.sweeps += 2;
        SolverStats.solves += 2 * (rows.length + contactRows.length);
      }
    }
    for (const row of contactRows) applyRestitution(row);
    for (const row of contactRows) {
      this.contactCache.set(row.key, { n: row.n, t: row.t });
      // What the contact spent, written back where the world's own solve
      // writes it, so the grips, the digest and `cli trace` read a contact
      // the island solved as they read any other.
      row.c.normalImpulse = row.n;
      row.c.tangentImpulse = row.t;
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

function warmStartContact(r: ContactRow): void {
  if (r.n === 0 && r.t === 0) return;
  const pa = r.a.globalPosition.add(r.la.rotated(r.a.globalRotation));
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
  const ra = r.la.rotated(A.globalRotation);
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
      const cone = r.friction * r.n;
      const total = Math.min(cone, Math.max(-cone, r.t - vt / invEffT));
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

// After the substeps, as Box2D applies it: a contact that closed faster than
// the threshold and carried load gets its share of the closing speed back.
function applyRestitution(r: ContactRow): void {
  if (r.restitution === 0 || r.vn0 > -RESTITUTION_THRESHOLD || r.maxN === 0) return;
  const A = r.a;
  const B = r.b;
  const ra = r.la.rotated(A.globalRotation);
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
  if (applied === 0) return;
  const impulse = n.mul(applied);
  applyAt(A, impulse, ra);
  applyAt(B, impulse.neg(), rb);
}
