// Rope — the wrap-point rope model + PBD length/friction solver, ported from
// classes/Rope.cs. Models the rope as a sequence of wrap points around scene
// geometry rather than evenly spaced segments.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { Mathf } from "../engine/mathf";
import {
  AnimatableBody2D,
  CollisionObject2D,
  CollisionShape2D,
  currentTransformEpoch,
  PhysicsBody2D,
  RigidBody2D,
} from "../engine/body";
import { isExposedCorner } from "../engine/shapes";
import { GRAVITY, type World } from "../engine/world";
import { Colors } from "../engine/debug";
import { Segment } from "../lib/segment";
import { Intersections, type Intersection } from "../lib/intersections";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { RopeGeneration } from "../lib/ropeGeneration";
import { cullDetachedNodes, MIN_WRAP_DEFLECTION } from "../lib/nodeDetachment";
import {
  shapeCrossesSpan,
  spanMotionBox,
  type Crossing,
  type Pose,
  type SpanMotion,
} from "../lib/spanSweep";
import { Calc } from "../lib/calc";
import {
  RopeAttachment,
  RopeContact,
  RopeNode,
  RopeWrap,
} from "../lib/ropeContact";
import { GenerationDirection, IntersectionStatus, WrapDirection } from "../lib/types";
import { PathEnd, PathObject, PathStart, PathWrap } from "../lib/pathObject";
import {
  RAIL_KINETIC_FRICTION,
  RAIL_MAX_SLIDE_SPEED,
  RAIL_STATIC_FRICTION,
  RopeClamp,
  type ClampState,
} from "../lib/rail";
import { MANACLE_BORE } from "../lib/manacle";
import { RopeEmbed, slipDistance, type EmbedState } from "../lib/viscous";
import { RopeVineClamp, type VineClampState } from "../lib/vineClamp";
import { Player } from "./player";
import { Hook } from "./hook";
import { PhaseTrace, type SolveBodyTerm } from "../engine/phaseTrace";

// Pass-through geometry (a `passable` body, a vine link): the rope may be *pinned* to
// it — that is what the hook is for — but it may never bend around it. Every
// wrap-generating path filters on this, so the invariant lives with the solver
// rather than depending on the caller handing it a pre-filtered body list.
function isPassThrough(obj: CollisionObject2D): boolean {
  return obj instanceof PhysicsBody2D && !obj.isSolid;
}

// A candidate the rope may wrap: one convex shape of one body. Compound bodies
// are the reason this is not simply the body — a body made of several convex
// pieces catches on whichever piece the span crosses, and the tangent walk needs
// that piece's own vertex loop and centre. The body rides along because a
// `RopeContact` names a body and a piece of it, not a piece on its own.
interface WrapCandidate {
  body: PhysicsBody2D;
  shape: CollisionShape2D;
  shapeIndex: number;
}

// The scene as the flat list of surfaces the rope may bend around. Every span in
// a regeneration scans the same list, so the body→shape flattening happens once
// per frame rather than once per span, and - the reason it exists - the scan
// downstream of it deals only in `WrapCandidate`. Handing that loop a body and a
// shape at the same time is what made "is this the surface my span ends on?"
// answerable by the wrong one.
function wrappableSurfaces(bodies: readonly PhysicsBody2D[]): WrapCandidate[] {
  if (surfacesStillValid(bodies)) return surfacesCache!.out;
  const out: WrapCandidate[] = [];
  for (const body of bodies) {
    if (isPassThrough(body)) continue;
    body.getShapes().forEach((shape, shapeIndex) => {
      if (shape.wrappable) out.push({ body, shape, shapeIndex });
    });
  }
  surfacesCache = { bodies, out };
  return out;
}

// The last list built, kept so the next ask can hand it back. A ball frame
// regenerates the path a dozen and more times (six scene chains, the coupled
// sweep, the ball's own step) over the same `bodies`, and every one of them
// was rebuilding this - three hundred candidate objects a call - to reach the
// same answer. The list is a function of the bodies array, each body's
// pass-through state, its shape array and each shape's `wrappable` flag, and
// `surfacesStillValid` re-reads exactly those before reusing it: the walk is
// the same one the build does, minus the allocation, so a body that turned
// solid or grew a shape between two asks rebuilds rather than being missed.
// Candidates are never written to downstream (`WrapCandidate` is read-only by
// convention - grep it), so sharing them across calls is safe.
let surfacesCache: { bodies: readonly PhysicsBody2D[]; out: WrapCandidate[] } | null = null;

// The mobile subset of a surfaces list, filtered once per list rather than
// once per span (see `sweepSpan`). Keyed on the list's identity, which the
// cache above keeps stable for as long as the list is valid; mobility is a
// class property of a body, so the subset cannot go stale while the list is.
let mobileCache: { of: readonly WrapCandidate[]; out: WrapCandidate[] } | null = null;

function mobileSurfaces(surfaces: readonly WrapCandidate[]): readonly WrapCandidate[] {
  if (mobileCache !== null && mobileCache.of === surfaces) return mobileCache.out;
  const out = surfaces.filter((cand) => cand.body.isMobile);
  mobileCache = { of: surfaces, out };
  return out;
}

function surfacesStillValid(bodies: readonly PhysicsBody2D[]): boolean {
  const cache = surfacesCache;
  if (cache === null || cache.bodies !== bodies) return false;
  const out = cache.out;
  let k = 0;
  for (const body of bodies) {
    if (isPassThrough(body)) continue;
    const shapes = body.getShapes();
    for (let i = 0; i < shapes.length; i++) {
      const shape = shapes[i]!;
      if (!shape.wrappable) continue;
      const c = out[k++];
      if (c === undefined || c.body !== body || c.shape !== shape || c.shapeIndex !== i) return false;
    }
  }
  return k === out.length;
}

// Is this vertex an interior seam of a compound body — a corner that exists only
// because the body is expressed as several convex pieces, and which has no
// outside for the rope to bend around?
//
// The mirror of LedgeDetection.isSeamOccluded, and it exists for the same
// reason: a concave form is authored as overlapping convex pieces (see
// "Convex-only polygons; compound bodies" in docs/game-design.md), and without
// this the rope snags on the join where the real surface is smooth. Only the
// body's *own* other shapes are consulted; a corner buried in a neighbouring
// body is a different situation, and the rope has always been free to catch it.
//
// "Interior" is decided by `CollisionShape2D.isVertexExposed`, which asks how
// much of the turn around the vertex the body's pieces cover between them, once,
// at build time. Proximity to a sibling is NOT the test: two pieces whose
// corners land on the same grid point share a vertex that is the outer corner of
// the body, with three quarters of a turn of outside around it (`session-410f`).
//
// Single-shape bodies are answered without asking. Their vertices are all the
// body's own corners by construction, and short-circuiting keeps a collinear
// vertex of a lone convex polygon reading exactly as it always has.
export function isSeamVertex(shape: CollisionShape2D, vertexIndex: number): boolean {
  return shape.owner.getShapes().length > 1 && !shape.isVertexExposed(vertexIndex);
}

// What a caller that pushed a path body out of geometry this frame reports to
// `absorbBlockedLength`: which body, and the outward normals of every surface
// that pushed it. One per body the geometry pushed this frame - a scene chain
// holds two, and either may be the one standing in a surface. See
// `unreachableShortening`.
export interface LengthRefusal {
  body: PhysicsBody2D;
  normals: readonly Vec2[];
}

export class RopePath {
  constructor(
    public from: RopeNode,
    public to: RopeNode,
    public span: Segment,
  ) {}
}

// What one iteration of the length solve may move, for its monotone guard to
// restore (see `snapshotPathBodies`).
interface PathSnapshot {
  bodies: { body: PhysicsBody2D; position: Vec2; rotation: number }[];
  clamp: ClampState | null;
  embed: EmbedState | null;
  ring: VineClampState | null;
  slideBudget: number;
}

interface DynamicBody {
  body: PhysicsBody2D;
  inertia: number;
  mass: number;
  // The body's linear velocity as the credit pass reads it — what the
  // impulse-pair bound in `boundRotationCredit` measures "paid" against.
  velocity: Vec2;
  addVelocity(v: Vec2): void;
  addRotation(r: number): void;
}

export class Rope {
  // Newton steps, and halvings per step, for unwindOverLength. One step is the
  // whole correction whenever the local rate holds; the rest cover the contact
  // moving far enough that it stops holding.
  private static readonly UNWIND_ITERATIONS = 4;
  private static readonly UNWIND_BACKTRACKS = 6;
  // Below this the rope is not really spooled on the body at all — it leaves
  // along the radius rather than the tangent — and rotating it would ask for a
  // wild angle to buy a millimetre. Metres per radian.
  private static readonly MIN_SPOOL_RATE = 0.001;
  // Arc between re-sampled coil nodes, radians. Only the last one carries any
  // physics; the rest are what the chain is drawn along, so this is a rendering
  // resolution. ~14° puts a link every 3 cm on the ball & chain's rim.
  private static readonly COIL_NODE_ARC = 0.25;
  // Below this the coil has spooled off and the rope leaves the body straight.
  private static readonly MIN_COIL_ANGLE = 1e-4;
  // How fast a blocked-correction lease is handed back once the block eases,
  // metres per second. Releasing it all at once puts the whole surplus into the
  // next solve's length error, and the solve converts length error to velocity
  // (Δposition over Δt), so that is a kick. 0.5 m/s gives back 8 mm a frame —
  // faster than any block accrues, slow enough to read as the rope reeling in.
  static readonly SLACK_RELEASE_RATE = 0.5;
  // Tolerance on "does not re-enter a surface" in `unreachableShortening`: a
  // surface's own tangent dots to zero with its normal up to float noise, and
  // the tangent is exactly the direction the statement is about.
  private static readonly REFUSAL_EPSILON = 1e-9;

  maxRopeLength = 10;
  maxIterations = 10;
  // Metres of path length that the last `regeneratePath` added or removed *with
  // the bodies held still* — a wrap node appearing or being culled.
  topologyJump = 0;
  // What fraction of the last solve's velocity credit was earned, 0..1.
  //
  // The path is a polyline through the wrap nodes, and the moment a node is
  // added the polyline is longer: the span A→B becomes A→W→B, and |AW| + |WB| >
  // |AB| by however far the span had already cut into the body before the
  // regeneration noticed. That is a discretisation artefact — with a smaller
  // step the wrap would have appeared with no deflection at all — and its size
  // grows with how fast things are moving. A ball spinning at 31 rad/s sweeps a
  // new wrap into being every frame, 9.5 cm of "length error" at a time
  // (session-265f), and the ball & chain's whole path can jump half a metre in
  // one frame (session-1474f).
  //
  // The constraint still has to be satisfied, so the *position* correction is
  // made in full. What must not happen is the rope paying itself velocity for
  // it: Δposition over Δt turns half a metre into a 96 m/s launch, and the rope
  // did not accelerate anything — the description of it changed. So the credit
  // is scaled by the share of the length error that bodies actually moving put
  // there, which on an ordinary frame is all of it and this is 1.
  topologyCreditScale = 1;
  // Metres of rope the frame's own retract commands have taken out of the
  // constraint since the last credit was paid. A shortening constraint is the
  // rope genuinely pulling, so it is inward speed the credit may honestly
  // contain (see `creditBound`); it is spent by the credit that follows it
  // rather than cleared per frame, because `retract` is called from input
  // handling, which for both controllers runs before the rope's frame opens.
  private retractedSinceCredit = 0;
  private frameBegun = false;
  // What `absorbBlockedLength` has had to let out, accumulated — how badly the
  // frame's length correction was blocked. It accumulates rather than
  // overwrites because the stall runs more than once in a ball frame (once at
  // the end of `physicsStep`, once after the push-out), and only the caller
  // knows where its frame begins; `BallLevel` zeroes it there.
  stalledLength = 0;
  // Extra length geometry is currently forcing on the constraint: the gap
  // between where the solve wants the far end and where a surface will actually
  // let it sit. Added to `maxRopeLength` to give `constraintLength`, the length
  // the solver actually enforces.
  //
  // This is a *lease*, not a payment. It is re-derived from the present geometry
  // every frame and released once the block eases, so `maxRopeLength` stays the
  // length the rope really has and a persistent block costs a fixed amount of
  // slack instead of a fresh instalment every frame. See `absorbBlockedLength`.
  blockedSlack = 0;
  // What the lease was before this frame's release, so the stall accounting can
  // tell a block being *re-earned* from a block getting worse. Re-earning the
  // 8 mm the release just handed back is the mechanism working, not a stall.
  private leaseAtFrameStart = 0;
  // How far geometry actually pushed the rope's own body this frame, summed
  // over the caller's push-outs — or `null` where the caller does not measure
  // it, which is every caller but `BallLevel` and means "unbounded", exactly as
  // this behaved before. See `noteGeometryPush` and `absorbBlockedLength`.
  private geometryPushAccum: number | null = null;
  // Trace-only scratch: the per-body terms the last correction step computed,
  // so `resolveLengthConstraint` can emit them beside the error it measured.
  // Filled only while `PhaseTrace.enabled`, read by nothing in the sim.
  private solveTerms: SolveBodyTerm[] = [];
  // Did geometry refuse the chain's correction on the frame just gone? Set by
  // the caller that can see it (`BallLevel`, from the push-out that follows its
  // solve); false for callers with nothing to report, which is every rope whose
  // correction has no separate push-out behind it.
  //
  // It gates the release, and it has to be *last* frame's answer, because the
  // release happens before this frame's solve — there is no evidence about a
  // frame that has not run yet. A block does not appear and vanish between two
  // frames, so last frame's is the right one to act on.
  private blockedLastFrame = false;
  frictionCoefficient = 0.4;
  // Continuous wrap detection: every regeneration also asks what passed
  // THROUGH each span since the last one, not only what the span overlaps
  // where it now is (see `sweepSpan`). Off by default and on for the ball's
  // chain only: the sample is what every scene chain was recorded through, and
  // a scene chain is not the thing moving at 15 m/s.
  continuous = false;
  // The baseline the sweep measures from - the path as the last regeneration
  // left it. Nodes are placed by ROLE rather than by identity, because the
  // node objects at the rope's two ends are not stable: the coil re-derives its
  // nodes every frame, and an attach replaces `end`. The point the rope leaves
  // its start body from (the last coil node, or the start itself) and the far
  // end are one point each whatever object carries them; a wrap in between is
  // a material point of its body, placed by that body's pose then.
  private lastExit: Vec2 | null = null;
  private lastEnd: Vec2 | null = null;
  private lastPoses = new Map<PhysicsBody2D, Pose>();
  // Set by a correction step that drew the far end all the way up to the node
  // it was being pulled towards (see `correctShapePositionAndRotation`); read
  // and cleared by the iteration loop, which rounds the corner for it.
  private endReachedNode = false;

  // `start`/`end`/`wraps` invalidate the memoized path geometry on ASSIGNMENT
  // (see `markPathChanged` below), so no caller - this file or another - can
  // leave a stale span cache behind. In-place element writes bypass the setter;
  // the one site that does that (`uncrossAdjacentNodes`) marks by hand.
  private start_!: RopeAttachment;
  private end_!: RopeAttachment;
  private wraps_!: RopeWrap[];

  get start(): RopeAttachment {
    return this.start_;
  }

  set start(value: RopeAttachment) {
    this.start_ = value;
    this.markPathChanged();
  }

  get end(): RopeAttachment {
    return this.end_;
  }

  set end(value: RopeAttachment) {
    this.end_ = value;
    this.markPathChanged();
    // A new end carries no tension history: what the chain carried to the
    // hook in flight says nothing about the ring it has just become.
    this.frameCorrection = 0;
    this.lastFrameCorrection = 0;
    this.frameCreepRelief = 0;
    this.lastFrameCreepRelief = 0;
  }

  get wraps(): RopeWrap[] {
    return this.wraps_;
  }

  set wraps(value: RopeWrap[]) {
    this.wraps_ = value;
    this.markPathChanged();
  }

  private frameStartDistanceLookup = new Map<RopeNode, number>();
  // Angle of rope wound onto the body the rope starts on, radians, *unwrapped*
  // so it counts whole turns rather than resetting at each one. Null when no
  // coil is on. See `syncCoil`.
  private coilWindAngle: number | null = null;
  private coilWrapDir: WrapDirection | null = null;

  constructor(
    start: RopeContact,
    end: RopeContact,
    wraps: RopeWrap[] | null = null,
    initialLength: number | null = null,
  ) {
    this.start = new RopeAttachment(start);
    this.end = new RopeAttachment(end);
    this.registerHookCallbacks();
    this.wraps = wraps ?? [];
    this.maxRopeLength = initialLength ?? this.calculateRopePathLength();
  }

  // The length the solver enforces: the rope's own length plus whatever slack
  // geometry is currently forcing on it. Everything that asks "is the rope over
  // its length" reads this; `maxRopeLength` alone is what the rope *has*, which
  // is what retract/extend and the growth invariant are about.
  get constraintLength(): number {
    return this.maxRopeLength + this.blockedSlack;
  }

  get isTaut(): boolean {
    return this.calculateRopePathLength() > this.constraintLength - 3 * PX;
  }

  // How far over its length the rope is right now - the solve's own residual,
  // and what a caller iterating a set of ropes measures convergence by (see
  // `stepSceneChains`). Zero for a slack rope: the constraint is an inequality,
  // so a rope shorter than its length is not in error, it is hanging loose.
  get overLength(): number {
    return Mathf.max(this.calculateRopePathLength() - this.constraintLength, 0);
  }

  retract(amount = PX): void {
    // The rope may never be retracted to a negative length.
    const before = this.maxRopeLength;
    this.maxRopeLength = Mathf.max(this.maxRopeLength - amount, 0);
    this.retractedSinceCredit += before - this.maxRopeLength;
  }

  extend(): void {
    this.maxRopeLength += PX;
  }

  updateFrameStartDistanceLookup(): void {
    this.frameStartDistanceLookup = this.genDistanceToStartLookup();
  }

  path(): RopeNode[] {
    return [this.start, ...this.wraps, this.end];
  }

  // Memoized span list and path objects. One solve pass asks for the same
  // geometry many times at the same state - the length measure, the Jacobian
  // build, the credit directions - and each ask regenerated it from scratch,
  // allocation and all (~40% of a coupled sweep's pass cost, session-198f).
  // Valid while (a) no body anywhere has moved, one integer against the global
  // transform epoch, and (b) this rope's own node list is unchanged - every
  // site that touches `wraps`/`start`/`end` calls `markPathChanged`. The cached
  // arrays and their objects are immutable after construction (`selfWrap` is
  // set during the build), so handing the same instances back is safe.
  private spanCache: RopePath[] | null = null;
  private spanCacheEpoch = -1;
  private pathObjectCache: PathObject[] | null = null;
  private pathObjectCacheEpoch = -1;
  // The leading coil run's measurement (see `leadingCoilRun`). Alone among the
  // caches here it is NOT keyed on the transform epoch, and does not need to be:
  // a coil run's nodes all ride ONE circle on ONE body and are stored in that
  // body's frame, so every span in it is an arc whose angle no rigid motion of
  // the body can change. Only the node list can, and every write to it - the two
  // in-place ones included - passes through `markPathChanged`.
  //
  // That difference is the whole value of it. The solve moves bodies on every
  // relaxation iteration, so the epoch-keyed caches are thrown away a thousand
  // times over in a frame the ball is rolling with its chain wound on, while
  // this one stands for the frame.
  private coilRunCache: { nodes: number; length: number } | null = null;

  private markPathChanged(): void {
    this.spanCache = null;
    this.pathObjectCache = null;
    this.coilRunCache = null;
  }

  // Metres a clamped end (`RopeClamp`) may still run along its rail this frame
  // - opened on the solve's first look at the clamp (see `slideClampedEnd`)
  // and spent by the slides the length solve's iterations take. Zero for a
  // rope whose frame has not begun, so a clamp never slides outside a frame.
  private slideBudget = 0;
  // The frame's step, for the budget above.
  private frameDelta = 0;
  // Told when a clamped end has run off the OPEN end of its rail: the owner
  // turns the ring back into the dangling tip it was before it clamped (see
  // `settleClamp`). The end has NOT been replaced when this fires; that is the
  // callback's job.
  onClampRunOff: ((clamp: RopeClamp, end: -1 | 1) => void) | null = null;
  // Told when an embedded end's mouth has crept clear of the viscous face it
  // bit, with the speed it was creeping at: the owner turns the cuff back into
  // the dangling tip it was before it bit (see `settleEmbed`). As above, the
  // end has NOT been replaced when this fires.
  onEmbedDrop: ((embed: RopeEmbed, velocity: Vec2) => void) | null = null;
  // Told when a ring on a vine has slid off the vine's free bottom end, with
  // the speed it left at: the owner turns it back into the dangling tip (see
  // `settleVineClamp`). As above, the end has NOT been replaced when this
  // fires.
  onVineRunOff: ((clamp: RopeVineClamp, velocity: Vec2) => void) | null = null;
  // Which way along the vine this frame's creep runs, for a ring on one:
  // decided with the budget at the solve's first look (`slipVineClampedEnd`).
  private slideSign: 1 | -1 = 1;
  // The length solve's summed correction this frame and last, as the
  // position-impulse the split is made of (`scaledCorrectionImpulse`, kg·m:
  // every body on the path moved by its inverse inertia times this), and the
  // over-length a ring on a vine crept away this frame and last. Together the
  // last frame's pair are the tension the chain actually carried, which is
  // what a ring on a vine reads its creep from (see `slipVineClampedEnd`).
  private frameCorrection = 0;
  private lastFrameCorrection = 0;
  private frameCreepRelief = 0;
  private lastFrameCreepRelief = 0;
  // Whether this frame has looked at the clamp yet: the first look is the one
  // that decides whether a running ring has come to rest (see `slideClampedEnd`).
  private slideLooked = false;
  // Whether this frame has hung the clamp yet (see `settleClampSeat`). Its own
  // flag rather than `slideLooked`'s: a ring hangs whether or not the chain is
  // taut enough for the length solve to look at it, and the two answers are
  // settled at different points in the frame.
  private seatLooked = false;

  // Wires hook attachment callbacks; called on construction and after snapshot restore.
  registerHookCallbacks(): void {
    const endObj = this.end.contact.obj;
    if (endObj instanceof Hook) {
      endObj.registerAttachmentCallback((body, point) => {
        // `RopeContact.at`: the hook anchors on whichever piece of the body it
        // hit, and the wrap resolvers walk the piece the contact names.
        this.end = new RopeAttachment(RopeContact.at(body, point));
        this.maxRopeLength = Mathf.max(this.maxRopeLength, this.calculateRopePathLength());
      });
    }
    const startObj = this.start.contact.obj;
    if (startObj instanceof Hook) {
      startObj.registerAttachmentCallback((body, point) => {
        this.start = new RopeAttachment(RopeContact.at(body, point));
        this.maxRopeLength = Mathf.max(this.maxRopeLength, this.calculateRopePathLength());
      });
    }
  }

  getSpans(): RopePath[] {
    return this.regenerateSpans();
  }

  // Recompute the wrap nodes against the current scene without running the
  // length solve — the same path regeneration physicsStep does first, exposed so
  // a caller can measure the true (wrapped) path length before the solver runs.
  syncWraps(bodies: PhysicsBody2D[]): void {
    this.regenerateAndMeasure(bodies);
  }

  // Regenerate the wrap path and record what the regeneration alone did to the
  // measured length, with the bodies held still. Accumulates across every
  // regeneration in a frame, because the ball controller syncs the path once
  // before the solve and `physicsStep` regenerates again — see
  // `topologyCreditScale`.
  private regenerateAndMeasure(bodies: PhysicsBody2D[]): void {
    // Baseline taken *after* a coil sync, not before. The coil's nodes ride the
    // body, so between frames they carry its rotation with them and the stored
    // path is a turn's worth out of date; bringing the coil to the current
    // geometry first is what makes the difference below the node set changing
    // rather than the body having moved.
    this.syncCoil();
    const before = this.calculateRopePathLength();
    this.uncrossAdjacentNodes();
    this.regeneratePath(bodies);
    this.topologyJump += Math.abs(this.calculateRopePathLength() - before);
  }

  // Zero the per-frame accounting and hand back this frame's instalment of the
  // blocked-length lease. Callers that touch the rope more than once a frame
  // (the ball controller syncs, solves, unwinds and re-bases) call this at the
  // top of their frame; `physicsStep` does it for callers that do not.
  //
  // The release happens *here*, before the solve, and that placement is the
  // whole mechanism. Released afterwards it could never bite: the solve enforces
  // `constraintLength`, so a taut rope ends the frame at exactly that length,
  // `absorbBlockedLength` measures the block as the lease it was already holding,
  // and `max(blocked, released)` keeps the lease for ever. Every instalment a
  // momentary block ever bought was therefore permanent, and a ball swinging on
  // a 108 cm chain grew 53 cm of surplus over a thousand frames without
  // `maxRopeLength` moving a millimetre (session-1080f). Released first, the
  // constraint the solve enforces is genuinely shorter, so the surplus is given
  // back as the rope reeling in rather than held for ever.
  //
  // It is gated on `blockedLastFrame` because releasing into a live block is not
  // a trial, it is grinding: the solve hauls the rope's far end into the surface
  // it is already resting on, the push-out undoes it, and the lease is re-earned
  // — every frame, for as long as the block lasts. A ball wound up under a
  // ceiling swung twice as wide that way, driven by a constraint that spent the
  // whole time pulling it into geometry that had already refused it. So the
  // lease is released only once the geometry has stopped saying no.
  beginFrame(delta: number): void {
    this.stalledLength = 0;
    this.topologyJump = 0;
    this.slideBudget = 0;
    this.frameDelta = delta;
    this.slideLooked = false;
    this.seatLooked = false;
    this.lastFrameCorrection = this.frameCorrection;
    this.lastFrameCreepRelief = this.frameCreepRelief;
    this.frameCorrection = 0;
    this.frameCreepRelief = 0;
    this.geometryPushAccum = null;
    this.leaseAtFrameStart = this.blockedSlack;
    if (!this.blockedLastFrame) {
      this.blockedSlack = Mathf.max(this.blockedSlack - Rope.SLACK_RELEASE_RATE * delta, 0);
    }
    this.frameBegun = true;
  }

  // Whether geometry refused this frame's correction, reported by the caller
  // that can see it: the ball controller's push-out normals. Only what the
  // *next* `beginFrame` reads — see `blockedLastFrame`.
  noteBlockedByGeometry(blocked: boolean): void {
    this.blockedLastFrame = blocked;
  }

  // How far a push-out moved this rope's own body, reported by the caller that
  // performed it. Additive over a frame (the ball controller pushes out three
  // times) and reset by `beginFrame`; a rope whose caller never reports one is
  // left unbounded, which is what every caller but `BallLevel` does.
  //
  // It is the SIZE of the refusal, and `absorbBlockedLength` needs it because
  // the existence of a push-out is not evidence of how much was refused. A
  // translation of the body by `d` can lengthen the rope's path by at most `d`
  // (the coil rides the body, so only the free span moves), which makes this an
  // exact bound rather than a tuned one.
  noteGeometryPush(distance: number): void {
    this.geometryPushAccum = (this.geometryPushAccum ?? 0) + Mathf.max(distance, 0);
  }

  // What that caller last reported. Read by the `rope-lease-held` invariant,
  // which is the statement that a lease nothing is blocking has to be repaid.
  get blockedByGeometry(): boolean {
    return this.blockedLastFrame;
  }

  // The SIZE of this frame's refusal, for the tooling: how far the caller's
  // push-outs moved this rope's own body, or null where the caller does not
  // measure it. `blockedByGeometry` answers whether geometry said no; this
  // answers by how much, which is the number the wound-tight anchor pump is
  // read on — 20 to 40 mm a frame beside a lease growing by the same
  // (`session-324f` f252-270).
  get geometryPush(): number | null {
    return this.geometryPushAccum;
  }

  // Wrap detection for a still-deploying ball chain. While the hook is in
  // flight the chain is slack (no length solver runs), so a straight span that
  // crosses scene geometry is normally ignored. This runs the wrap generator
  // once to catch that case: if the span has snagged a body OTHER than
  // `ballBody`, the wrap node(s) are kept so the caller can freeze the deploy
  // around them. Ball self-winding (from aiming spinning the ball) is not a
  // catch — when nothing else is hit the path is reset to straight so flight
  // keeps rendering as a single slack span. Returns true on a genuine catch.
  detectSceneCatch(bodies: PhysicsBody2D[], ballBody: PhysicsBody2D): boolean {
    this.regeneratePath(bodies);
    const caught = this.wraps.some((w) => w.contact.obj !== ballBody);
    if (!caught) {
      this.wraps = [];
      // The straight span is what the next sweep measures from, not the coil
      // the regeneration found and this discarded.
      this.recordSweepBaseline(bodies);
    }
    return caught;
  }

  getCurrentLength(): number {
    return this.calculateRopePathLength();
  }

  // How fast the rope path grows per radian `body` spins about its own centre,
  // in metres per radian: positive winds rope *onto* the body, negative unwinds
  // it. The spool picture, for a body the rope winds onto itself — the ball and
  // its chain.
  //
  // Every node is stored in its body's local frame, so rotating a body carries
  // its nodes with it. A span with both endpoints on `body` is rigid and its
  // length cannot change; a span with neither is untouched. Only the spans that
  // *straddle* the body — the places the rope actually leaves it — contribute,
  // each as -û·(dq/dθ) with q the moving endpoint and û pointing from it to the
  // fixed one. For a circle that comes to ±radius per radian, since the rope
  // leaves tangentially, but the sum is written generally so a body the rope
  // wraps mid-path measures the same way.
  //
  // The coil is the exception to "nodes ride the body". Its last node is the
  // point the rope leaves the rim at, which is geometry - a tangent from the
  // next node, fixed in the world while the body turns under it - and only the
  // material start point turns. So the span leaving the coil contributes
  // nothing and the coil contributes exactly its radius, in the direction that
  // winds (see `syncCoil` and `coilLengthPerRadian`). Read as a material span
  // instead, the leaving span gives the same radius at first order while it is
  // long enough to have a direction, and reads zero or either sign once the
  // anchor has come down onto the rim (`session-611f`), which is the frame
  // the unwind needs it most.
  lengthPerRadian(body: PhysicsBody2D): number {
    const centre = body.globalPosition;
    const coil = this.leadingCoilRun();
    const coilExit = coil.nodes > 0 ? this.wraps_[coil.nodes - 1]! : null;
    let rate = 0;
    for (const span of this.regenerateSpans()) {
      const fromOnBody = span.from.contact.obj === body;
      const toOnBody = span.to.contact.obj === body;
      if (fromOnBody === toOnBody) continue;
      if (span.from === coilExit) {
        rate += this.coilLengthPerRadian();
        continue;
      }
      const moving = fromOnBody ? span.span.start : span.span.end;
      const fixed = fromOnBody ? span.span.end : span.span.start;
      if (moving.distanceSquaredTo(fixed) < PX * PX * 1e-4) continue;
      const lever = moving.sub(centre);
      // d(v.rotated(θ))/dθ at the current θ is (-v.y, v.x).
      rate -= moving.directionTo(fixed).dot(new Vec2(-lever.y, lever.x));
    }
    return rate;
  }

  // How the coil's arc changes as its body turns by a radian with the rope's
  // leaving point held: the start point sweeps a radius of rim, towards the
  // leaving point when the turn is against the wrap and away from it when the
  // turn is with it. `absoluteAngle` measures from the start point to the
  // leaving point in the wrap direction, and a positive rotation carries the
  // start point the way `Clockwise` (+1) sweeps, so that direction shortens a
  // clockwise coil and lengthens a counter-clockwise one.
  private coilLengthPerRadian(): number {
    const shape = this.start_.contact.shape;
    if (shape.shape.kind !== "circle" || this.coilWrapDir === null) return 0;
    return -(this.coilWrapDir as number) * shape.shape.radius;
  }

  // Give the frame's remaining over-length back to `body`'s spin, and only then
  // let `absorbBlockedLength` see what is left. For a body the rope spools onto
  // — the ball and its chain.
  //
  // The ball's aim steering is *kinematic*: it overwrites angularVelocity
  // outright, so nothing the solver does can stop the ball winding more chain
  // onto itself than the chain has. Winding it on is the point, and while the
  // solver can pay for it by hauling the ball in towards the anchor it does; the
  // failure is only at the end of that, wound all the way up with the ball
  // against its anchor and nowhere left to be hauled. There the length solve
  // took the error back out as a positional correction that the depenetration
  // push-out immediately undid, `physicsStep` turned the correction into
  // velocity, and the stall covered the difference — so the ball flicked itself
  // along the ground and kept rolling around its anchor while 18 cm of chain
  // grew to 366 cm and dragged the anchor three metres (session-475f).
  //
  // Rotation is the one correction that is always available — a circle sweeps no
  // new ground as it turns, so there is no geometry to block it and nothing to
  // push out of afterwards — and it is precisely the motion that overspent. So
  // it is what pays, and only for the part the chain could not afford: a frame
  // the solver did settle leaves nothing here to do.
  //
  // It pays no more than it spent, though: `rotationAtFrameStart` is where the
  // body was before this frame turned it, and the correction may walk back
  // towards that and no further. The rest of any over-length is not the spin's
  // doing — the frame's biggest source of it is the depenetration push-out — and
  // charging the spin for that spins the ball *backwards*, which at the top of a
  // wind-up is a runaway: the correction subtracts angular velocity, the next
  // frame's push-out leaves a little more over-length, and within ten frames a
  // ball winding on at +4 rad/s was unwinding itself at -15 (session-394f). What
  // rotation may not or cannot reach falls through to the winch stall, as it did
  // before any of this.
  //
  // The search is Newton on `lengthPerRadian` with backtracking, and it keeps
  // the best angle it has seen rather than the last one it tried. Both matter:
  // the rate is only a local model of a path length that is *not* monotone in
  // the angle — one full Newton step can swing the contact clean past its
  // tangent point, which is where the rate flips sign — and undamped that
  // oscillates between two equally bad angles and returns to where it started.
  //
  // `forgive` is length this rope is ALLOWED to end the frame over by, and it is
  // subtracted before any of the above happens. The unwind's premise is that
  // over-length left at the end of the phase is over-length the solve could not
  // pay, so the spin has to give it back - and that premise fails for a solve
  // the phase deliberately skipped. A coupled sweep leaves the rope inside
  // `CHAIN_TOLERANCE` rather than at zero (see `sweepChains`), which is the
  // solver's own convergence budget and not the player's to fund: billed to the
  // spin it cancelled the ball's entire frame of rotation on 107 of the 312
  // frames of `session-337f` that were holding a vine, and read in the game as
  // a force resisting the turn. Zero for every caller that solves its rope to
  // convergence, which is every one but a held vine.
  unwindOverLength(
    body: PhysicsBody2D,
    rotationAtFrameStart: number,
    delta: number,
    forgive = 0,
  ): void {
    const startRotation = body.globalRotation;
    const lowRotation = Mathf.min(startRotation, rotationAtFrameStart);
    const highRotation = Mathf.max(startRotation, rotationAtFrameStart);
    // Every candidate is measured with the coil brought to it. The coil's nodes
    // are stored in the body's frame and so ride its rotation, which is right
    // for every other node on the body and wrong for the coil's last one: that
    // is the point the rope leaves the rim at, a tangent fixed in the world by
    // the next node, and turning the body under it changes the ARC and not the
    // point (`syncCoil`). Riding the body instead, the leaving point slid round
    // the rim away from an anchor sitting on it and the chord back to the
    // anchor grew with every candidate in either direction, so the search
    // found nothing to improve and stood still while the winding it was there
    // to refuse went on at the full frame's turn: `used 0%` for forty frames
    // and 26 cm over length on a 1.1 m chain (`session-611f` f250-290).
    const excessAt = (rotation: number): number => {
      body.globalRotation = rotation;
      this.syncCoil();
      return this.calculateRopePathLength() - this.constraintLength - forgive;
    };
    let bestRotation = startRotation;
    let bestExcess = excessAt(startRotation);

    for (let i = 0; i < Rope.UNWIND_ITERATIONS && bestExcess > 0; i++) {
      excessAt(bestRotation);
      const rate = this.lengthPerRadian(body);
      if (Math.abs(rate) < Rope.MIN_SPOOL_RATE) break;
      let step = -bestExcess / rate;
      let improved = false;
      for (let t = 0; t < Rope.UNWIND_BACKTRACKS; t++, step *= 0.5) {
        const candidate = Mathf.clamp(bestRotation + step, lowRotation, highRotation);
        if (candidate === bestRotation) break;
        const excess = excessAt(candidate);
        if (excess < bestExcess) {
          bestRotation = candidate;
          bestExcess = excess;
          improved = true;
          break;
        }
      }
      if (!improved) break;
    }

    excessAt(bestRotation);
    // What the search did with the window it was given: a third of the window
    // unused with centimetres of residual over-length standing is a stalled
    // search rather than a chain that will not unwind (`session-477f`), and it
    // was found with a temporary print. The spool rate is taken at the rotation
    // the search settled on, which is where the body already is - `regenerateSpans`
    // is cached against the global transform epoch, so asking costs nothing and
    // changes nothing.
    if (PhaseTrace.enabled) {
      PhaseTrace.unwind(
        highRotation - lowRotation,
        Math.abs(bestRotation - startRotation),
        bestExcess,
        this.lengthPerRadian(body),
      );
    }
    // Mirror the solve: a rotation the rope imposed is also a change in how fast
    // the body is turning. Without it a ball held against a wound-up chain is
    // spun forward by its own angular velocity every frame and rotated back out
    // here, and the two show up as a stutter. Bounded by the same window as the
    // rotation, so the chain can stall the spin but never reverse it.
    this.getDynamicBodyState(body)?.addRotation((bestRotation - startRotation) / delta);
  }

  getDistanceToStartLookup(): Map<RopeNode, number> {
    return this.genDistanceToStartLookup();
  }

  render(color: string): void {
    for (const span of this.getSpans()) {
      // Debug.drawLine(span.span.start, span.span.end, color, 1); // drawn by renderer via getSpans
    }
  }

  // One frame of the rope: open the frame if the caller has not, then solve it
  // once. This is what every single-pass caller wants and what they all did
  // before the split below.
  physicsStep(bodies: PhysicsBody2D[], delta: number): void {
    if (!this.frameBegun) this.beginFrame(delta);
    this.frameBegun = false;
    this.solvePass(bodies, delta);
  }

  // One solve pass: regenerate the path, enforce the length, credit the bodies
  // for what it moved. Split out of `physicsStep` so a caller solving a SET of
  // ropes can iterate the set without re-opening each rope's frame - the
  // per-frame bookkeeping in `beginFrame` (the lease release above all) is a
  // statement about the frame, and running it once per pass would release the
  // lease K times over. See `stepSceneChains`.
  solvePass(bodies: PhysicsBody2D[], delta: number): void {
    this.settleClamp(delta);
    this.regenerateAndMeasure(bodies);
    const lengthError = this.calculateRopePathLength() - this.constraintLength;
    this.topologyCreditScale =
      lengthError > 0 ? 1 - Mathf.clamp(this.topologyJump / lengthError, 0, 1) : 1;

    // Every body this solve may move, for the velocity books below: the bodies
    // on the rope's OWN path, whatever scene it was handed. The path is the
    // exact list on both sides.
    //
    // It is not too narrow, and that direction is the load-bearing one: the
    // solve corrects the position of whatever hangs on the chain, and a body
    // whose position is corrected but never credited keeps every frame's
    // gravity. A wrecking ball hanging from a background chain - on the chain's
    // path but absent from its restricted scene, so a scene-only list missed it
    // - sat perfectly still while its velocity climbed 0.16 m/s a frame, to
    // 119 m/s by the twelfth second, waiting to be released by the first frame
    // that gave it any slack.
    //
    // It is not too wide either: `resolveLengthConstraint` moves path bodies
    // and nothing else, so a scene body off the path measures a zero credit
    // every time. Measuring those zeros was not free - a rope handed the whole
    // level as its scene took pre-positions of all 174 bodies and asked
    // `pullDirection` about each of them, on every pass of the coupled sweep
    // (session-230f, 20 ms physics frames while hanging from a vine).
    const moved: PhysicsBody2D[] = [];
    for (const node of this.path()) {
      const obj = node.contact.obj;
      if (obj instanceof PhysicsBody2D && !moved.includes(obj)) moved.push(obj);
    }

    const prePositions = new Map<PhysicsBody2D, Vec2>();
    const preRotations = new Map<PhysicsBody2D, number>();
    for (const b of moved) {
      prePositions.set(b, b.globalPosition);
      preRotations.set(b, b.globalRotation);
    }

    if (
      this.start.contact.obj instanceof Player &&
      this.end.contact.obj instanceof Hook &&
      this.wraps.length === 0
    ) {
      // The slack rope sim looks weird while the hook is unfurling.
      this.maxRopeLength = this.calculateRopePathLength();
    } else {
      const endObj = this.end.contact.obj;
      if (endObj instanceof Hook) {
        const lastWrap = this.wraps[this.wraps.length - 1]!;
        endObj.velocity = endObj.globalPosition
          .directionTo(lastWrap.contact.obj.globalPosition)
          .mul(10 * PX);
        this.wraps.pop();
        this.end = new RopeAttachment(lastWrap.contact);
        this.markPathChanged();
        this.maxRopeLength = this.calculateRopePathLength();
        endObj.world?.remove(endObj);
      }
    }

    // Taken here and not later: the velocities on the bodies right now are the
    // ones the pass was handed, and what the solve is allowed to be worth is a
    // statement about those. A line below this and the correction has already
    // begun rewriting them.
    const creditBound = this.creditBound(delta);


    const correctionImpulse = this.resolveLengthConstraint();
    if (correctionImpulse !== null) {
      // Friction impulse may push the rope past its max length; re-solve.
      this.resolveLengthConstraint();

      // One path regeneration for the whole credit loop. The credits below are
      // velocity-level only, so nothing in the loop can move the path, and the
      // per-body `pullDirection` calls this replaces each regenerated the
      // identical path objects from scratch - the other half of session-230f's
      // 20 ms frames.
      const { dirs: pullDirs, pivotArms, pivotContacts } = this.pullDirections();

      // Two passes, compute-then-apply, so a PIVOT body's rotation credit can
      // be bounded by the reaction to the momentum this pass actually REMOVED
      // from the other bodies (see `boundRotationCredit`). Nothing a credit
      // writes feeds another body's credit — every credit is Δposition over Δt
      // against pre-positions, clamped by precomputed bounds — so splitting
      // the loop is bit-identical for every body the pair bound never touches.
      const pending: { dyn: DynamicBody; vel: Vec2; rot: number; body: PhysicsBody2D }[] = [];
      let paidImpulse = 0;
      let maxReceding = 0;
      for (const body of moved) {
        const dynamicBody = this.getDynamicBodyState(body);
        if (dynamicBody) {
          // Scaled by `topologyCreditScale`: the share of this frame's length
          // error that a wrap appearing or vanishing put there is corrected in
          // position but earns no velocity. Bounded by `creditBound`: the share
          // the bodies are no longer moving to earn does not either.
          const vel = Rope.clampCreditAlong(
            pullDirs.get(body) ?? null,
            body.globalPosition
              .sub(prePositions.get(body)!)
              .div(delta)
              .mul(this.topologyCreditScale),
            creditBound,
          );
          const rot =
            ((body.globalRotation - preRotations.get(body)!) / delta) * this.topologyCreditScale;
          pending.push({ dyn: dynamicBody, vel, rot, body });
          // What this pass PAID: the share of a body's credit that removed its
          // own recession along the pull — a braking impulse, real momentum the
          // constraint took off the body. Credit past cancelling the recession
          // is the solve GRANTING inward speed (the winch's haul), which is
          // exactly the credit the whirl ratchet was fed by, so it pays the
          // pivot nothing. A pivot's own mass reads Infinity and is excluded by
          // the same guard that keeps 0·Infinity out of the sum.
          const dir = pullDirs.get(body);
          if (dir && Number.isFinite(dynamicBody.mass)) {
            // Less gravity's own per-frame bite along the recession: a body
            // merely HANGING recedes by exactly that every frame and the solve
            // removes it every frame, and crediting the pivot for it is the
            // static weight arriving as a velocity trickle - ~0.13 rad/s a
            // frame into a frictionless bearing, which is session-136f's whip
            // by another door. The static load reaches a sprung anchor as the
            // position solve's displacement and `applyHangLoad`'s force, both
            // of which a spring answers with a settled droop.
            const bite = Math.max(0, -GRAVITY.dot(dir)) * delta;
            const receding = Math.max(0, -dynamicBody.velocity.dot(dir) - bite);
            if (receding >= Rope.PAIR_SNAP_MIN_RECESSION) {
              paidImpulse += Mathf.clamp(vel.dot(dir), 0, receding) * dynamicBody.mass;
              maxReceding = Math.max(maxReceding, receding);
            }
          }
        }
      }
      for (const p of pending) {
        p.dyn.addVelocity(p.vel);
        const arm = pivotArms.get(p.body);
        let reactionDw = 0;
        if (
          arm !== undefined &&
          arm > 1e-9 &&
          Number.isFinite(p.dyn.inertia) &&
          p.dyn.inertia > 0 &&
          paidImpulse > 0
        ) {
          // The pairing is INELASTIC at velocity level too: the pivot's contact
          // may be spun up along its pull direction until it matches the rate
          // the payer was receding at, never past it — that is where a real
          // arrest converges, and the cap is what keeps the whirl's per-cycle
          // recessions from ACCUMULATING in the bearing across cycles (the tip
          // there already co-rotates near the ball's speed, so the match
          // allowance reads near zero every pass).
          const pairDw = (paidImpulse * arm) / p.dyn.inertia;
          const dir = pullDirs.get(p.body);
          const contact = pivotContacts.get(p.body);
          const tipAlong =
            dir && contact ? Rope.velocityAt(p.body, contact).dot(dir) : 0;
          const matchDw = Math.max(0, maxReceding - tipAlong) / arm;
          reactionDw = Math.min(pairDw, matchDw);
        }
        p.dyn.addRotation(Rope.boundRotationCredit(p.body, p.rot, reactionDw));
        // (Godot pushed the mutated transform back into the physics server here;
        // in this engine the body transform is already authoritative.)
      }
    }

    // The frame's retract is the frame's to spend. Cleared whether or not a
    // correction ran, so a rope retracted while slack cannot bank the allowance
    // and hand it to some later frame's solve.
    this.retractedSinceCredit = 0;

    this.absorbBlockedLength();
  }

  // How fast the length solve may honestly haul, this frame, in metres per
  // second — the ceiling on the inward speed any credit it pays may contain.
  //
  // The credit is Δposition over Δt, a standard PBD velocity update, and it is
  // honest only while the position error it corrects is error the bodies are
  // still MOVING to create. Nothing in the frame guarantees that. A ball falling
  // onto the floor with its chain already taut arrives over its length by the
  // distance gravity integrated, the contact solve then reverses the velocity
  // that put it there and pushes the ball back out, and the solve corrects what
  // is left — a real position error, correctly corrected — and charges the ball
  // Δposition over Δt for motion the contact had already answered for. The chain
  // sold the same centimetres twice and the ball left the floor at 3 m/s having
  // landed at 0.9 (`session-360f` f305).
  //
  // So the credit is bounded by the constraint's own velocity-level form. The
  // rope's job is `length <= constraintLength`, and while it is taut the same
  // statement in velocity is `d(length)/dt <= d(constraintLength)/dt`: the solve
  // may remove exactly the rate at which the path is opening, and no more. Both
  // sides are measurable here — the left from the velocities the bodies carry
  // in, through the same path Jacobian the position correction uses, the right
  // from what the frame's own retract took out — so the bound is the constraint,
  // not a heuristic clamp on top of it.
  //
  // `extraInward` is for a caller holding a term the Jacobian cannot see. The
  // ball & chain's winch is the one: chain wound onto the ball's own rim
  // shortens the free path without any body moving, and the ball's rotation is
  // kinematic, so it contributes nothing here by design (see
  // `calculateTorqueArm`). `BallLevel` measures that as a length and passes it
  // in as a speed; without it the wind-up would be bounded to nothing and the
  // mechanic would stall, which is the failure `session-322f` is about.
  //
  // `entering` supplies the velocity a body carried into the phase, for callers
  // whose books are taken over a whole phase rather than a single pass and whose
  // bodies have therefore already been paid something. Bodies it does not name
  // are read live.
  creditBound(
    delta: number,
    entering?: ReadonlyMap<PhysicsBody2D, Vec2>,
    extraInward = 0,
  ): number {
    let openingRate = 0;
    for (const pathObject of this.generatePathObjects()) {
      const point = Rope.contactPointOf(pathObject);
      const velocity = entering?.get(pathObject.body) ?? Rope.velocityAt(pathObject.body, point);
      // `resolveCorrectionDir` points the way the correction hauls this body,
      // which is the way that SHORTENS the path — so a body moving along it is
      // closing the constraint and one moving against it is opening it.
      openingRate -=
        pathObject.calculateMechanicalAdvantage() *
        velocity.dot(pathObject.resolveCorrectionDir());
    }
    return Math.max(openingRate + this.retractedSinceCredit / delta + extraInward, 0);
  }

  // The impulse-pair allowance is for a SNAP, and a snap is FAST: only a body
  // receding above this rate pays the pivot its reaction. The two regimes it
  // separates were both measured. A hard radial catch arrives at 6-10 m/s of
  // recession (session-209f, the yank-catch rig); the whirl's churn - the
  // orbit's little per-cycle yanks, re-fed by the winch's own credit - runs at
  // 0.8-1.6 m/s, and a body merely hanging recedes by gravity's bite, 0.16.
  // Below the bar a recession pays nothing, so the whirl's bearing never
  // receives the seed spin the runaway bootstraps from and the orbit stays at
  // its governed baseline; discriminators derived from the aim instead were
  // tried and both read wrong (realized winding is ZERO in a whirl - the bar
  // co-rotates, so the chain never coils - and the steering snaps the ball's
  // spin to 47 rad/s in an ordinary catch as the ball passes its aim point).
  private static readonly PAIR_SNAP_MIN_RECESSION = 2.5;

  // The rotation credit for a PIVOT body may only top its spin up to the rate
  // the solve's own position correction sustained this pass, never past it.
  //
  // The credit is Δrotation over Δt, ADDED to the angular velocity - and for a
  // free body that add-form is kept honest by everything else acting on it: its
  // contacts damp it, its mass bounds the linear half, and a correction that
  // repeats stops repeating once the credited velocity carries the body with
  // the constraint. A pivot body has none of that. Its bearing is frictionless
  // and its axle immovable, so when the correction PERSISTS - a ball whirled in
  // circles on a chain anchored to a hinged bar, whose rotation co-rotates with
  // the whirl so the constraint direction turns and the correction never stops
  // - each frame's Δθ/dt lands on top of the ω the last frame's credit already
  // left, and the bearing integrates: the solve was correcting ~0.055 rad a
  // frame (a 3.3 rad/s drive) and the bar wound up to 24 rad/s, slinging the
  // ball at 39 m/s off a rig whose static-anchor control peaks at 2.5 (the
  // `whirl-anchor` case in `cli spring` is that rig; killing this credit alone
  // took the whip to 2.4 rad/s).
  //
  // So the credit saturates instead of accumulating - the standard PBD velocity
  // update is a SET, `v = Δx/Δt`, and topping up to the drive rate is that
  // statement made compatible with the add-form the loop uses. A body at rest
  // yanked hard still receives the full Δθ/dt (that is momentum transfer); one
  // already turning with the correction at the drive rate receives nothing,
  // which is exactly the frame on which the add-form was minting energy. The
  // bound is the solve's own position correction, so unlike a velocity-derived
  // bound (`creditBound`'s angular image, tried and reverted) it cannot chase
  // the runaway it exists to stop. Non-pivot bodies keep the add-form to the
  // bit.
  //
  // Saturation alone starves a HARD RADIAL YANK, and `reactionDw` is the other
  // half of the statement. A ball falling onto a chain anchored to a sprung
  // pivot spins the bar to the drive rate in the first frames of the arrest,
  // and from then on every frame's Δθ/dt sits under the spin already earned:
  // the credit clamps to zero while the ball goes on paying real momentum
  // through the same constraint - 0.4-1.1 m/s a frame with the bar credited
  // nothing, Newton's third law severed, 83% of a 2.76 kJ arrival destroyed
  // against an inelastic-jerk ceiling of 28% (session-209f f66-70, felt as the
  // branch giving no backlash at the bottom of the arc). So the pivot may
  // ALWAYS receive up to the reaction of the impulse the pass actually paid
  // the other bodies (`reactionDw` = ΣJ·arm/I, computed in the credit loop) -
  // that is momentum pairing, and it cannot mint: the payer measurably lost
  // what the pivot gains, and paid impulse counts only the BRAKING share of a
  // body's credit, so the whirl - whose orbit was hauled inward, never braked
  // - still pays nothing and the ratchet stays dead. Both allowances cap at
  // the position-backed credit itself: the solve's own correction remains the
  // most rotation a pass may be worth. Where two pivots share one path each is
  // offered the whole paid pool - a loose cap, but a CAP: the position solve's
  // effective-mass split is what actually apportions the correction between
  // them, and `cli spring` yank-catch is the detector on the arithmetic.
  //
  // And the top-up may never REFUND what the body's own dynamics just removed
  // (`RigidBody2D.pivotFrameAccelDw`). A ball hanging still from a sprung
  // branch generates a small position correction every frame - gravity's own
  // bite, split by effective mass - and the top-up read the spring's per-frame
  // deceleration of the branch as headroom: the spring bit 0.077 rad/s off,
  // the credit handed 0.078 back, and the branch position-marched DOWN at the
  // constant rate of the split, linear, with no bounce, straight past a torque
  // balance its spring already out-pulled two to one (session-333f, 0.14
  // rad/s of creep). Subtracting the restoring share leaves the spring's
  // bite in force: the march stalls a hair past the true balance (~2ζ·c/ω of
  // offset), and the approach is the spring's own damped oscillation - the
  // linear spring's interaction, locked to a rotation path. Strictly tighter
  // than the bare saturation, so nothing the whirl governor holds is loosened.
  private static boundRotationCredit(
    body: PhysicsBody2D,
    credit: number,
    reactionDw = 0,
  ): number {
    if (!(body instanceof RigidBody2D) || !body.pivot || credit === 0) return credit;
    const dir = Math.sign(credit);
    const alongCredit = body.angularVelocity * dir;
    const restoring = Math.max(0, -body.pivotFrameAccelDw * dir);
    const saturation = Mathf.clamp(
      Math.abs(credit) - Math.max(alongCredit, 0) - restoring,
      0,
      Math.abs(credit),
    );
    const paired = Math.min(Math.abs(credit), reactionDw);
    return dir * Math.max(saturation, paired);
  }

  // Spend the bound: strip whatever inward speed a credit carries past what the
  // solve was allowed to be worth. Only the inward component is touched — the
  // rest is the swing, and the push-outs the phase folded in, and neither is the
  // constraint's to refuse.
  clampCredit(body: PhysicsBody2D, credit: Vec2, bound: number): Vec2 {
    return Rope.clampCreditAlong(this.pullDirection(body), credit, bound);
  }

  private static clampCreditAlong(dir: Vec2 | null, credit: Vec2, bound: number): Vec2 {
    if (!dir) return credit;
    const inward = credit.dot(dir);
    if (inward <= bound) return credit;
    return credit.sub(dir.mul(inward - bound));
  }

  // Where the rope's load lands on the body it ENDS on: the point at which the
  // last free span meets that body. For a chain tied to a surface that is the
  // anchor itself; for a chain that has come round the holder it is the tangent
  // point the free span leaves from, which is where the tension actually acts -
  // a rope wound on a pulley pulls at the rim beside it, not at the knot on the
  // far side. The same point `calculateTorqueArm` measures the end body's lever
  // from, so a load applied here turns the holder the way the solve does.
  // Null while the path is empty of spans (a rope with no end body to load).
  endLoadPoint(): Vec2 | null {
    for (const pathObject of this.generatePathObjects()) {
      if (pathObject instanceof PathEnd) {
        return pathObject.selfWrap ? pathObject.selfWrap.previous.end : pathObject.previous.end;
      }
    }
    return null;
  }

  // The direction the length solve hauls `body`, or null for a body the path
  // does not hold. An attachment in preference to a wrap: a body the rope both
  // ends on and bends around is hauled from its attachment, and the wrap's
  // bisector is a weaker statement about the same pull.
  pullDirection(body: PhysicsBody2D): Vec2 | null {
    let fallback: Vec2 | null = null;
    for (const pathObject of this.generatePathObjects()) {
      if (pathObject.body !== body) continue;
      const dir = pathObject.resolveCorrectionDir();
      if (dir.lengthSquared() < 0.0001) continue;
      if (pathObject instanceof PathWrap) fallback ??= dir.normalized();
      else return dir.normalized();
    }
    return fallback;
  }

  // `pullDirection` for every path body at once, from ONE regeneration. Body by
  // body it answers exactly what `pullDirection` answers - attachment beats
  // wrap, first valid of each kind wins - it just walks the path once instead
  // of once per body, which is what a solve pass crediting the whole path
  // needs (see the credit loop in `solvePass`).
  private pullDirections(): {
    dirs: Map<PhysicsBody2D, Vec2>;
    // A PIVOT body's torque arm about its bearing and the contact the rope
    // acts through, for the impulse-pair bound in `boundRotationCredit` —
    // collected in the same walk so the credit loop costs one path
    // regeneration, not two (session-230f).
    pivotArms: Map<PhysicsBody2D, number>;
    pivotContacts: Map<PhysicsBody2D, Vec2>;
  } {
    const dirs = new Map<PhysicsBody2D, Vec2>();
    const fallbacks = new Map<PhysicsBody2D, Vec2>();
    const pivotArms = new Map<PhysicsBody2D, number>();
    const pivotContacts = new Map<PhysicsBody2D, Vec2>();
    for (const pathObject of this.generatePathObjects()) {
      const body = pathObject.body;
      if (body instanceof RigidBody2D && body.pivot) {
        const arm = Math.abs(this.calculateTorqueArm(pathObject));
        if (arm > (pivotArms.get(body) ?? 0)) {
          pivotArms.set(body, arm);
          pivotContacts.set(body, Rope.contactPointOf(pathObject));
        }
      }
      if (dirs.has(body)) continue;
      const dir = pathObject.resolveCorrectionDir();
      if (dir.lengthSquared() < 0.0001) continue;
      if (pathObject instanceof PathWrap) {
        if (!fallbacks.has(body)) fallbacks.set(body, dir.normalized());
      } else {
        dirs.set(body, dir.normalized());
      }
    }
    for (const [body, dir] of fallbacks) {
      if (!dirs.has(body)) dirs.set(body, dir);
    }
    return { dirs, pivotArms, pivotContacts };
  }

  private static contactPointOf(pathObject: PathObject): Vec2 {
    if (pathObject instanceof PathStart) return pathObject.next.start;
    if (pathObject instanceof PathEnd) return pathObject.previous.end;
    return (pathObject as PathWrap).wrapStartPosition;
  }

  // Velocity of the point of `body` the rope acts through. Rotation counts —
  // a mover turning under its own anchor opens the path as surely as one
  // sliding does — EXCEPT where it is kinematic, which is the same exclusion
  // `calculateTorqueArm` makes and for the same reason: a spin the controller
  // overwrites every frame is not motion the rope may be paid against.
  private static velocityAt(body: PhysicsBody2D, point: Vec2): Vec2 {
    if (body instanceof Player) return body.velocity;
    if (body instanceof RigidBody2D && body.kinematicRotation) return body.linearVelocity;
    return body.velocityAtPoint(point);
  }

  // Winch stall: if scene geometry blocked the correction (a pinned player
  // while retracting), the rope cannot actually shorten, and the constraint has
  // to be told so — otherwise it winds up against the obstruction and catapults
  // whatever it is holding the moment that obstruction clears. A converged solve
  // leaves length <= the constraint length, so this only bites when the solver
  // was blocked, and it only ever lets rope out.
  //
  // Exposed because `physicsStep` is not always the last thing to move the
  // bodies: the ball controller depenetrates the ball afterwards (see
  // BallLevel.physicsProcess), and that push-out is geometry blocking the
  // correction just as much as a wall the solver ran into. Re-basing only inside
  // the solve left the frame ending over-length every frame for a point-blank
  // anchor, since the ball was shoved back out after the solve had already
  // written its books.
  //
  // What it lets out is a *lease* (`blockedSlack`), not a payment into
  // `maxRopeLength`. The difference is everything, because a blocked correction
  // is rarely a one-off. Paid into the length, each frame's instalment became
  // the baseline the next frame measured against, so a rope held over its length
  // by something that is not going away grew by that much again every frame,
  // forever: a ball hanging from a ceiling, where all it takes is gravity's own
  // 2.7 mm integration step being refused by the surface the ball is resting on,
  // let 16 cm of chain out per second and ended up sliding away on the surplus
  // (session-537f). Held as a lease it is re-derived from the present geometry
  // instead, so the same persistent block costs the same fixed slack every
  // frame, and the moment it eases the slack is released — at a bounded rate, so
  // the rope reels back in rather than snapping to length. `maxRopeLength` is
  // left meaning what it says: the length the rope actually has.
  //
  // This half only ever *raises* the lease, to whatever the geometry has refused
  // once the frame's bodies have settled; the release is `beginFrame`'s, run
  // before the solve so what is measured here is a block the solver actually
  // ran into rather than the lease it was handed. Safe to call several times a
  // frame — the ball controller does, since the push-out moves the ball after
  // the solve — because raising is idempotent.
  //
  // The stall is measured against the lease at *frame start*, not against the
  // released one: re-earning this frame's instalment is the release working, and
  // counting it would report every legitimately-held chain as stalling for as
  // long as it is held. Only a lease that has to grow past where the frame began
  // is the constraint being pushed out further than it already was, which is
  // what `rope-stalling` watches for.
  // And it may not raise the lease by more than geometry actually PUSHED, where
  // the caller measures that (`noteGeometryPush`). The existence of a push-out
  // is not evidence of its size, and this half used to read it as though it
  // were: the whole over-length was charged to the surface on the strength of
  // any contact at all, however shallow. A ball whirled round a sprung bar it is
  // anchored to grazes that bar at a few hundredths of a millimetre, frame after
  // frame, which was enough to open the gate - and then the lease ratcheted, 3 cm
  // of fresh path a frame, because a looser constraint buys a longer path which
  // is measured as a bigger block. 1.69 m of chain reached a 2.19 m path and
  // slung the ball at 30 m/s (`cli spring` `whirl-anchor`, sprung/tip). Bounded
  // by the push, a graze buys a graze's worth: the over-length stands, and next
  // frame's solve corrects it like any other length error.
  //
  // The bound is against the lease at FRAME START rather than its running value,
  // so it says the same thing however many times a frame this is called, and so
  // a block being re-earned after the release is not charged twice.
  //
  // And, where the caller names the surfaces that pushed (`refusal`), it is
  // measured against what those surfaces make UNREACHABLE rather than against
  // where one solve left the path. A push-out along a normal does not refuse a
  // correction that was not along that normal; it deflects it. A ball resting on
  // a steep slope with its chain anchored a hand's width up the same slope is
  // hauled along the chain, which points 27% into the slope, and the push-out
  // hands back that 27% - which lengthens the path by 7% of what the solve just
  // took out. That residual is not a block: the ball can slide up the slope and
  // the very next solve would take it out, as it takes out any other length
  // error. Read as a block it was leased, the lease loosened the constraint by
  // exactly that much, the loosened constraint let the ball settle a little
  // lower, and the next frame's solve paid the same residual again: 0.2 mm of
  // chain a frame, for ever, out of a ball that was doing nothing but resting
  // against a wall. 7 cm of chain had doubled by frame 483 of `session-483f`,
  // and the rig that isolates it (`ball-slope-rest`) let out 20 cm in 600
  // frames. The push bound above could not see it, because the push really
  // was that big; what it could not tell was that the push was a deflection.
  //
  // So the refusal is the shortest path the pushing surfaces would still let
  // the body reach (`unreachableShortening`), and the lease may not stand above
  // what THAT is over `maxRopeLength`. Point-blank - anchor straight through the
  // surface the ball rests on - nothing along the surface shortens the span,
  // the whole over-length is unreachable, and the lease is what it always was.
  // On the slope the span can be closed by sliding, nothing is refused, and the
  // residual stands for the next solve. The same number answers whether the
  // geometry is blocking at all (the returned value; see
  // `noteBlockedByGeometry`), so a lease held against a surface that has only
  // been deflecting the solve is released like any other.
  //
  // Returns the refusal: how much of the over-length the named surfaces make
  // unreachable, or the whole over-length when no refusals are given. Given an
  // EMPTY list the answer is that nothing refused anything: every body on the
  // path is free to move along its own pull, so the whole over-length is next
  // frame's ordinary length error. With several bodies pushed, what each can
  // still take out of its own span adds up - to first order the two ends
  // shorten the path independently.
  absorbBlockedLength(refusals?: readonly LengthRefusal[]): number {
    const settledLength = this.calculateRopePathLength();
    const overLength = Mathf.max(settledLength - this.maxRopeLength, 0);
    let blocked = overLength;
    if (refusals !== undefined) {
      let reachable = 0;
      for (const refusal of refusals) reachable += this.unreachableShortening(refusal);
      // Nothing pushed: the far end is not held by anything, and this is the
      // same statement made with an empty normal set below (`allowed` is true
      // of every direction), taken over the whole path rather than one span.
      if (refusals.length === 0) reachable = overLength;
      blocked = Mathf.max(settledLength - reachable - this.maxRopeLength, 0);
    }
    const granted =
      this.geometryPushAccum === null
        ? blocked
        : Mathf.min(blocked, this.leaseAtFrameStart + this.geometryPushAccum);
    this.stalledLength += Mathf.max(
      granted - Mathf.max(this.blockedSlack, this.leaseAtFrameStart),
      0,
    );
    this.blockedSlack = Mathf.max(this.blockedSlack, granted);
    return blocked;
  }

  // How much of the path `refusal.body` can still take out of its own free span
  // by moving in a direction its pushing surfaces allow - to first order, with
  // the body translating and the span's far end held. The body may move along
  // any direction that does not re-enter a surface that pushed it (`d · n >= 0`
  // for every normal); moving along such a `d` shortens the span at the rate
  // `p · d`, where `p` is the pull direction, and the span's length can be
  // brought down to its perpendicular distance from that line, `s · sqrt(1 -
  // (p · d)²)`. The best `d` is `p` itself when nothing forbids it, else one of
  // the surface tangents; wedged so that no direction is allowed, nothing can
  // be shortened at all.
  //
  // Zero for a body the path does not hold by an attachment: a wrapped body's
  // span geometry is not the statement this makes, and zero here says the whole
  // over-length is refused, which is what the caller got before it named any
  // surfaces.
  private unreachableShortening(refusal: LengthRefusal): number {
    const span = this.freeSpan(refusal.body);
    if (span === null) return 0;
    const allowed = (d: Vec2): boolean =>
      refusal.normals.every((n) => d.dot(n) >= -Rope.REFUSAL_EPSILON);
    let best = allowed(span.pull) ? 1 : 0;
    for (const n of refusal.normals) {
      for (const t of [n.orthogonal(), n.orthogonal().neg()]) {
        if (allowed(t)) best = Mathf.max(best, span.pull.dot(t));
      }
    }
    if (best <= 0) return 0;
    const reachable = span.length * Math.sqrt(Mathf.max(1 - best * best, 0));
    return span.length - reachable;
  }

  // The span the length solve hauls `body` along, for a body the path is
  // attached to: its direction (the pull, away from the body) and its length.
  // Leaves a coil on the body where the chain leaves it, since the coil rides
  // the body and only the free span moves with it.
  private freeSpan(body: PhysicsBody2D): { pull: Vec2; length: number } | null {
    for (const pathObject of this.generatePathObjects()) {
      if (pathObject.body !== body) continue;
      if (pathObject instanceof PathStart) {
        const segment = (pathObject.selfWrap ?? pathObject).next;
        return { pull: pathObject.resolveCorrectionDir(), length: segment.length() };
      }
      if (pathObject instanceof PathEnd) {
        const segment = (pathObject.selfWrap ?? pathObject).previous;
        return { pull: pathObject.resolveCorrectionDir(), length: segment.length() };
      }
    }
    return null;
  }

  private regenerateSpans(): RopePath[] {
    const epoch = currentTransformEpoch();
    if (this.spanCache && this.spanCacheEpoch === epoch) return this.spanCache;
    const p = this.path();
    const spans: RopePath[] = [];
    for (let i = 0; i < p.length - 1; i++) {
      spans.push(
        new RopePath(
          p[i]!,
          p[i + 1]!,
          new Segment(p[i]!.contact.globalPosition, p[i + 1]!.contact.globalPosition),
        ),
      );
    }
    this.spanCache = spans;
    this.spanCacheEpoch = epoch;
    return spans;
  }

  private resolveSelfIntersectionAtStart(
    fromNode: RopeNode,
    span: Segment,
    toNode: RopeNode,
  ): RopeNode | null {
    const obj = fromNode.contact.obj;
    if (obj instanceof Player && fromNode === this.start) return null;
    if (obj instanceof Hook && fromNode === this.start) return null;
    if (isPassThrough(obj)) return null;
    // A span that ends on a ring clamped around a rail ends at the ring's
    // centre, and the chain leaves the ring at its rim: a corner of the same
    // body inside the cuff's disc is metal the chain is already clear of (see
    // the same rule in `regeneratePath`). Walking the lantern's base from its
    // far corner to the near one, 10 mm from the ring's centre, put a wrap
    // inside the cuff (`session-154f`).
    const cuff = toNode instanceof RopeClamp ? toNode : null;
    const inCuff = (point: Vec2): boolean => cuff !== null && obj === cuff.body && cuff.covers(point);

    // The piece of the body this node actually sits on, not merely the body's
    // primary shape: on a compound body those differ, and the tangent walk has
    // to run round the loop the rope is resting against.
    const fromShape = fromNode.contact.shape;
    const shapeIndex = fromNode.contact.shapeIndex;
    if (!fromShape.wrappable) return null;
    if (Intersections.intersectsSegment(fromShape, span) !== IntersectionStatus.Overlap) {
      return null;
    }
    const wrapDir = span.calculateWrapDirection(fromShape.globalPosition);
    if (fromNode instanceof RopeWrap && fromNode.wrapDir !== wrapDir) return null;

    if (
      fromShape.shape.kind === "circle" &&
      Intersections.intersectsPoint(fromShape, span.end) === IntersectionStatus.Separate
    ) {
      // Mirror of the C#: the else branch is always taken here (guarded by Separate above).
      const tangentPoint = RopeGeneration.calculateCircleTangentPoint(
        fromShape,
        wrapDir,
        span.end,
        GenerationDirection.Reversed,
      );
      if (tangentPoint.distanceTo(span.start) > 5 * PX && !inCuff(tangentPoint)) {
        return new RopeWrap(
          new RopeContact(obj, tangentPoint.sub(obj.globalPosition), shapeIndex),
          wrapDir,
        );
      }
    } else if (fromShape.shape.kind !== "circle") {
      const corners = ShapeGeometry.getGlobalCorners(fromShape);
      const nextVertexIndex = this.ownCornerToWrap(
        fromShape,
        fromNode.contact.globalPosition,
        wrapDir,
        span.end,
        GenerationDirection.Reversed,
      );
      if (nextVertexIndex === null) return null;
      const nextVertex = corners[nextVertexIndex]!;
      if (
        Intersections.intersectsPoint(fromShape, span.end) === IntersectionStatus.Separate &&
        !inCuff(nextVertex)
      ) {
        return new RopeWrap(
          new RopeContact(obj, nextVertex.sub(obj.globalPosition), shapeIndex),
          wrapDir,
        );
      }
    }
    return null;
  }

  // Which corner of its OWN shape a node's span bends round, for the
  // self-intersection resolvers: the polygon half of what
  // `calculateCircleTangentPoint` is for a circle. `contact` is the node's
  // position, `far` the span's other end, `direction` which end the node is.
  //
  // A contact ON the loop - a wrap sitting on a vertex, an attachment on a
  // face - leaves it along the surface, so the corner is the next vertex round
  // the loop in the wrap direction: one *vertex*, not a fixed quarter turn,
  // which is what makes it right for a loop of any length. Angles are measured
  // about this SHAPE's centre, not the body's: on a compound body they differ,
  // and the walk has to be about the piece the rope is resting on.
  //
  // A contact standing CLEAR of the loop is a different question, and the walk
  // gives it the wrong answer. A manacle's hinge pin stands one ring radius
  // proud of the face it bit, and a bite beside a vertex puts the pin 4.5 cm
  // off that vertex while the chain reaches it from below round the NEXT one:
  // the walk named the near vertex, which deflects the chain the wrong way and
  // was culled at the end of the same regeneration, and the cull ran after the
  // scan had already excluded the shape as the span's own endpoint - so the
  // rock the chain hung from stayed invisible to every path it could have been
  // found by, and the taut chain cut 8 cm through its corner for 150 frames
  // (`session-206f`). A span that reaches its contact from outside is a span
  // through scenery, and the corner it bends round is the tangent vertex from
  // its far end - the scan's own construction for a span clean through a
  // shape, seen from whichever end this node is not.
  private ownCornerToWrap(
    shape: CollisionShape2D,
    contact: Vec2,
    wrapDir: WrapDirection,
    far: Vec2,
    direction: GenerationDirection,
  ): number | null {
    if (Intersections.intersectsPoint(shape, contact) === IntersectionStatus.Separate) {
      // The tangent vertex is the extreme of the loop's fan as seen from `far`,
      // and which way round the fan is "the wrap side" flips with the end it
      // is seen from: the chain bends `wrapDir` in path order, which is the
      // opposite sense looking back from the span's end.
      const seenFrom =
        direction === GenerationDirection.Forward
          ? wrapDir
          : wrapDir === WrapDirection.Clockwise
            ? WrapDirection.CounterClockwise
            : WrapDirection.Clockwise;
      return RopeGeneration.calculateTangentVertexIndex(shape, seenFrom, far);
    }
    const centre = shape.globalPosition;
    const corners = ShapeGeometry.getGlobalCorners(shape);
    const n = corners.length;
    // The node before the span steps forward round the loop, the node after it
    // steps back to it.
    const step = -(direction as number) * (wrapDir as number);
    let nextVertexIndex = 0;
    let minAngle = Infinity;
    for (let i = 0; i < n; i++) {
      const vertex = corners[i]!;
      if (vertex.distanceSquaredTo(contact) < 0.01 * PX * PX) {
        nextVertexIndex = Calc.mod(i + step, n);
        break;
      }
      const angleToVertex =
        direction === GenerationDirection.Forward
          ? Calc.absoluteAngle(centre.directionTo(vertex), centre.directionTo(contact), wrapDir)
          : Calc.absoluteAngle(centre.directionTo(contact), centre.directionTo(vertex), wrapDir);
      if (angleToVertex < minAngle) {
        minAngle = angleToVertex;
        nextVertexIndex = i;
      }
    }
    return nextVertexIndex;
  }

  private resolveSelfIntersectionAtEnd(toNode: RopeNode, span: Segment): RopeNode | null {
    const obj = toNode.contact.obj;
    if (obj instanceof Hook && toNode === this.end) return null;
    // A clamp's contact is the cuff's centre, which is in the bar's BORE -
    // inside the bar for a push fit, a centimetre under it for a thin one -
    // so the span ending on it sits on or against the piece it is clamped
    // around. That is the chain reaching the bar, not the chain having wound
    // around its own anchor (the failure this resolver exists for); the bar is
    // thin and the cuff encircles it, so there is no corner to bend round.
    if (toNode instanceof RopeClamp) return null;
    if (isPassThrough(obj)) return null;

    const toShape = toNode.contact.shape;
    const shapeIndex = toNode.contact.shapeIndex;
    if (!toShape.wrappable) return null;
    if (Intersections.intersectsSegment(toShape, span) !== IntersectionStatus.Overlap) return null;

    const wrapDir = span.calculateWrapDirection(toShape.globalPosition);
    if (toNode instanceof RopeWrap && toNode.wrapDir !== wrapDir) return null;

    if (
      toShape.shape.kind === "circle" &&
      Intersections.intersectsPoint(toShape, span.start) === IntersectionStatus.Separate
    ) {
      const tangentPoint = RopeGeneration.calculateCircleTangentPoint(
        toShape,
        wrapDir,
        span.start,
        GenerationDirection.Forward,
      );
      if (tangentPoint.distanceTo(span.end) > 5 * PX) {
        return new RopeWrap(
          new RopeContact(obj, tangentPoint.sub(obj.globalPosition), shapeIndex),
          wrapDir,
        );
      }
    } else if (toShape.shape.kind !== "circle") {
      const corners = ShapeGeometry.getGlobalCorners(toShape);
      const nextVertexIndex = this.ownCornerToWrap(
        toShape,
        toNode.contact.globalPosition,
        wrapDir,
        span.start,
        GenerationDirection.Forward,
      );
      if (nextVertexIndex === null) return null;
      const nextVertex = corners[nextVertexIndex]!;
      if (Intersections.intersectsPoint(toShape, span.start) === IntersectionStatus.Separate) {
        return new RopeWrap(
          new RopeContact(obj, nextVertex.sub(obj.globalPosition), shapeIndex),
          wrapDir,
        );
      }
    }
    return null;
  }

  // Wrap nodes riding a body that has since left the world. Every regeneration
  // re-emits the existing wraps (they are the `from` of their span) before it
  // looks for new ones, so nothing else ever takes such a node out: a wrap on a
  // removed body is welded to the position that body was destroyed at and stays
  // there for the rest of the level, bending the rope around a corner of thin
  // air. A scene chain the ball's hook flew through kept one for 400 frames
  // after the hook was gone (session-735f).
  //
  // Dropped here rather than when the body is removed because a body does not
  // know which ropes hold nodes on it, and a rope is regenerated every frame
  // anyway - the check costs one pass over a list that is almost always empty.
  private dropWrapsOnGoneBodies(): void {
    if (this.wraps.some((w) => w.contact.obj.removed)) {
      this.wraps = this.wraps.filter((w) => !w.contact.obj.removed);
    }
  }

  private resolveNodeSelfIntersections(): void {
    const newNodes: RopeWrap[] = [];
    for (const span of this.regenerateSpans()) {
      if (span.from instanceof RopeWrap) newNodes.push(span.from);
      if (this.shouldIgnorePathCollisions(span)) continue;

      const startIntersection = this.resolveSelfIntersectionAtStart(span.from, span.span, span.to);
      if (startIntersection instanceof RopeWrap) {
        newNodes.push(startIntersection);
      } else {
        const endIntersection = this.resolveSelfIntersectionAtEnd(span.to, span.span);
        if (endIntersection instanceof RopeWrap) newNodes.push(endIntersection);
      }
    }
    this.wraps = newNodes;
  }

  private shouldIgnorePathCollisions(span: RopePath): boolean {
    return (
      span.from.contact.shape === span.to.contact.shape ||
      span.span.start.distanceTo(span.span.end) < PX
    );
  }

  private isPointOutsideBoundingStrip(point: Vec2, span: Segment): boolean {
    return (
      span.direction().dot(span.start.directionTo(point)) < 0 ||
      span.direction().dot(span.end.directionTo(point)) > 0
    );
  }

  private regeneratePath(bodies: PhysicsBody2D[]): void {
    this.dropWrapsOnGoneBodies();
    this.resolveNodeSelfIntersections();
    const newNodes: RopeWrap[] = [];
    // The scene as SURFACES, flattened once. Past this line the scan holds no
    // `PhysicsBody2D` at all, which is the point: every one of these bugs was a
    // question about a surface asked of a body, and both are in scope at the
    // same time in the shape-at-a-time form. A body appears again only where a
    // body is genuinely what is meant - building a `RopeContact`, which names a
    // body and a piece of it, and the seam test, which is about how a body's
    // pieces are arranged.
    const surfaces = wrappableSurfaces(bodies);

    // The broadphase answers "which shapes might this span cross" so the exact
    // scan below runs over a handful of candidates instead of every surface in
    // the scene - a rope handed the whole level paid surfaces × spans exact
    // segment tests per regeneration, ~90 regenerations a frame under the
    // coupled sweep (session-198f). The tree is a filter, never an authority:
    // candidates are mapped back into `surfaces` and restored to ITS order, so
    // the scan downstream - including the distance sort, whose ties keep scan
    // order - sees exactly the list it always saw, minus shapes the span
    // provably cannot touch. Falls back to the full list for a rope whose ends
    // are not in a world (nothing is, that early in a build), and for a scene
    // already smaller than the query itself - a vine's pair chain is handed a
    // handful of surfaces, and a tree walk plus a sort per span costs more than
    // exact-testing all five.
    const world =
      surfaces.length > 8
        ? (this.start.contact.obj.world ?? this.end.contact.obj.world)
        : null;
    const surfaceIndex = new Map<CollisionShape2D, number>();
    if (world) for (let i = 0; i < surfaces.length; i++) surfaceIndex.set(surfaces[i]!.shape, i);

    for (const span of this.regenerateSpans()) {
      if (span.from instanceof RopeWrap) newNodes.push(span.from);
      if (this.shouldIgnorePathCollisions(span)) continue;

      let scan = surfaces;
      if (world) {
        const cands = world.segmentCandidates(
          span.span.start.x,
          span.span.start.y,
          span.span.end.x,
          span.span.end.y,
        );
        const pool: WrapCandidate[] = [];
        for (const shape of cands) {
          const i = surfaceIndex.get(shape);
          if (i !== undefined) pool.push(surfaces[i]!);
        }
        pool.sort((a, b) => surfaceIndex.get(a.shape)! - surfaceIndex.get(b.shape)!);
        scan = pool;
      }

      // The span's own endpoints are excluded by SHAPE, not by body. A span
      // ending on a shape always reports overlap against it, and wrapping the
      // thing you are tied to is the self-intersection resolvers' job, not
      // this scan's - but a *sibling* piece of that same body is ordinary
      // scenery in the span's way. Excluding the whole body made a compound
      // wall stop existing for every span touching any of it: once the chain
      // wrapped the rotated slab, the vertical post it then cut straight
      // through was invisible, because the post and the slab happen to be one
      // body (`session-358f`).
      //
      // A span ending on a CLAMP ends at the centre of a ring threaded on a
      // bar, and the chain leaves that ring at its rim: a corner of the bar's
      // body inside the cuff's own disc - the joint of the bar the ring
      // straddles, the near corner of the lid it hangs beside - is metal the
      // chain is already clear of, not a corner for it to bend round. Wrapping
      // the lid 12 mm from the ring's centre gave the chain a last span shorter
      // than the ring is wide, whose direction the ring's own tilt then
      // changed, and the ring hunted between that and gravity every frame
      // (`session-189f`). The CORNER is excluded, not the piece: the far corner
      // of that same lid is what the chain bends round when the ball winds up
      // under the lantern, and excluding the piece sent the chain straight
      // through the lantern's base (`session-154f`).
      const cuff = span.to instanceof RopeClamp ? span.to : null;
      const inCuff = (body: CollisionObject2D, point: Vec2): boolean =>
        cuff !== null && body === cuff.body && cuff.covers(point);
      const notInPlay = (shape: CollisionShape2D): boolean =>
        shape === span.from.contact.shape ||
        shape === span.to.contact.shape ||
        (this.isPointOutsideBoundingStrip(shape.globalPosition, span.span) &&
          (Intersections.intersectsPoint(shape, span.span.start) === IntersectionStatus.Overlap ||
            Intersections.intersectsPoint(shape, span.span.end) === IntersectionStatus.Overlap));

      const colliders = scan.filter(
        ({ shape }) =>
          !notInPlay(shape) &&
          Intersections.intersectsSegment(shape, span.span) === IntersectionStatus.Overlap,
      );

      // What the span passed THROUGH on its way here, which the overlap test
      // above cannot see once it is through. A shape found both ways is one
      // shape, and the crossing is what decides its direction.
      const swept = this.continuous ? this.sweepSpan(span, surfaces, surfaceIndex, world) : null;
      if (swept) {
        for (const cand of swept.keys()) {
          if (!notInPlay(cand.shape) && !colliders.includes(cand)) colliders.push(cand);
        }
      }

      colliders.sort(
        (a, b) =>
          span.span.getClosestPointOnLine(a.shape.globalPosition).distanceTo(span.span.start) -
          span.span.getClosestPointOnLine(b.shape.globalPosition).distanceTo(span.span.start),
      );

      for (const cand of colliders) {
        const { body, shape: bodyShape, shapeIndex } = cand;
        // The side the shape came FROM, where it crossed the span; the side its
        // centre is on, where it did not. The second is the sample's rule and
        // it is wrong for exactly the shapes the first knows about: a body most
        // of the way through a span has its centre on the far side, and the
        // wrap the centre chooses bends the rope the way the body is LEAVING,
        // which the detachment cull then drops a frame later (`session-126f`
        // f93). A shape that crossed and now stands clear of the span's start
        // is wrapped at its tangent from there, the same construction the
        // sample uses for a span clean through a shape.
        const crossing = swept?.get(cand) ?? null;
        const wrapDir = crossing
          ? crossing.side
          : span.span.calculateWrapDirection(bodyShape.globalPosition);
        const crossedFromClear =
          crossing !== null &&
          Intersections.intersectsPoint(bodyShape, span.span.start) === IntersectionStatus.Separate;

        if (bodyShape.shape.kind === "circle") {
          let tangentPoint: Vec2;
          const { entry, exit } = Intersections.getIntersectionsShapeSegment(bodyShape, span.span);
          if (crossedFromClear) {
            tangentPoint = RopeGeneration.calculateCircleTangentPoint(
              bodyShape,
              wrapDir,
              span.span.start,
              GenerationDirection.Forward,
            );
          } else if (entry && !exit) tangentPoint = entry.point;
          else if (!entry && exit) tangentPoint = exit.point;
          else if (entry && exit) {
            tangentPoint = RopeGeneration.calculateCircleTangentPoint(
              bodyShape,
              wrapDir,
              span.span.start,
              GenerationDirection.Forward,
            );
          } else continue;

          if (tangentPoint.distanceTo(span.span.start) > 5 * PX && !inCuff(body, tangentPoint)) {
            newNodes.push(
              new RopeWrap(
                new RopeContact(body, tangentPoint.sub(body.globalPosition), shapeIndex),
                wrapDir,
              ),
            );
          }
        } else {
          const corners = ShapeGeometry.getGlobalCorners(bodyShape);
          let vertexIndex: number | null = null;
          const { entry, exit } = Intersections.getIntersectionsShapeSegment(bodyShape, span.span);
          if (crossedFromClear) {
            vertexIndex = RopeGeneration.calculateTangentVertexIndex(
              bodyShape,
              wrapDir,
              span.span.start,
            );
          } else if ((entry && !exit) || (!entry && exit) || (!entry && !exit)) {
            let maxVertexAngle = 0;
            for (let i = 0; i < corners.length; i++) {
              const vertex = corners[i]!;
              if (
                this.isPointOutsideBoundingStrip(vertex, span.span) ||
                span.span.calculateWrapDirection(vertex) === wrapDir ||
                inCuff(body, vertex)
              ) {
                continue;
              }
              const angleToVertex = Calc.absoluteAngle(
                span.span.direction(),
                span.span.start.directionTo(vertex),
                wrapDir === WrapDirection.Clockwise
                  ? WrapDirection.CounterClockwise
                  : WrapDirection.Clockwise,
              );
              if (maxVertexAngle < angleToVertex && angleToVertex < Mathf.Pi / 2) {
                vertexIndex = i;
                maxVertexAngle = angleToVertex;
              }
            }
          } else if (entry && exit) {
            vertexIndex = RopeGeneration.calculateTangentVertexIndex(
              bodyShape,
              wrapDir,
              span.span.start,
            );
          }
          if (
            vertexIndex !== null &&
            corners[vertexIndex]!.distanceTo(span.span.start) > 5 * PX &&
            !inCuff(body, corners[vertexIndex]!) &&
            // Grazing-contact gate: a corner this close to the span line
            // bends the rope sub-visibly and adds no physical constraint,
            // but renders as a phantom snag and flip-flops as the contact
            // crosses the line on moving bodies (destabilising detachment).
            // Only a corner that actually deflects the rope becomes a wrap.
            //
            // A SWEPT crossing is exempt, and that exemption is the whole
            // difference between a corner near the line and a body the span has
            // been through. The gate's argument is about a corner the span
            // merely passes close to: nothing happened, so nothing need be
            // recorded. `crossing` is the opposite claim - the sweep watched
            // this shape pass from one side of the span to the other since the
            // last regeneration - and its deflection is SMALL EXACTLY WHEN THE
            // CROSSING IS FRESH, because a shape the span has only just gone
            // through is still a hair from the line. Gating on that threw the
            // wrap away on the one frame it was worth having and let the span
            // finish its pass: `session-2202f` f2093, where the sweep named the
            // right corner and the right hand at 4.3 mm of deflection, the gate
            // refused it at 5 mm, and by f2095 the chain was out the far side of
            // a 10 cm rail sleeper. Seven of the eleven crossings that recording
            // swept were refused the same way.
            (crossing !== null ||
              span.span
                .getClosestPointOnLine(corners[vertexIndex]!)
                .distanceTo(corners[vertexIndex]!) > MIN_WRAP_DEFLECTION) &&
            !isSeamVertex(bodyShape, vertexIndex)
          ) {
            newNodes.push(
              new RopeWrap(
                new RopeContact(body, corners[vertexIndex]!.sub(body.globalPosition), shapeIndex),
                wrapDir,
              ),
            );
          }
        }
      }
    }
    this.wraps = newNodes;
    this.cullDuplicateNodes();
    this.cullNodesInCuff();
    this.wraps = cullDetachedNodes(this.start, this.end, this.wraps);
    this.syncCoil();
    this.recordSweepBaseline(bodies);
  }

  // Continuous wrap detection for one span: which surfaces passed through it
  // between the last regeneration and this one, and from which side (see
  // `SpanSweep`). The span's ends are placed where the last regeneration left
  // them (`previousNodePosition`), the scene's mobile bodies where it saw them
  // (`lastPoses`), and a static is where it is.
  //
  // Sweeps are chained regeneration to regeneration rather than frame to frame,
  // so every motion of the path is covered exactly once whatever the caller's
  // frame looks like: the ball controller regenerates before its solve, in it,
  // and on an attach, and the sweep between each pair is that step's motion.
  //
  // The rope's own two bodies are never swept for. The chain can cross the
  // ball's own disc on a fast swing, and the sample has always been free to
  // wrap the ball's rim when a span overlaps it (the coil); what this scan is
  // for is the SCENE, and a catch on the ball itself born of a crossing rather
  // than an overlap is a wrap the coil machinery has no reading of.
  private sweepSpan(
    span: RopePath,
    surfaces: readonly WrapCandidate[],
    surfaceIndex: Map<CollisionShape2D, number>,
    world: World | null,
  ): Map<WrapCandidate, Crossing> | null {
    const s0 = this.previousNodePosition(span.from);
    const e0 = this.previousNodePosition(span.to);
    if (s0 === null || e0 === null) return null;
    const motion: SpanMotion = { s0, e0, s1: span.span.start, e1: span.span.end };

    // The box the moving span covered answers for everything that stood still.
    // A body that MOVED may have come from anywhere, and there are few enough
    // of those to ask each one.
    let pool: readonly WrapCandidate[];
    if (world) {
      const box = spanMotionBox(motion);
      const found: WrapCandidate[] = [];
      for (const shape of world.queryShapes(box.minX, box.minY, box.maxX, box.maxY)) {
        const i = surfaceIndex.get(shape);
        if (i !== undefined) found.push(surfaces[i]!);
      }
      // Every mobile surface, wherever it is: a body's broadphase box is where
      // it is NOW, and a sweep is about where it was. Taken from the list the
      // regeneration filtered once rather than re-scanning all three hundred
      // surfaces for every span; same order, so `found` is the same list.
      for (const cand of mobileSurfaces(surfaces)) {
        if (!found.includes(cand)) found.push(cand);
      }
      pool = found;
    } else {
      pool = surfaces;
    }

    const startObj = this.start.contact.obj;
    const endObj = this.end.contact.obj;
    let out: Map<WrapCandidate, Crossing> | null = null;
    for (const cand of pool) {
      if (cand.body === startObj || cand.body === endObj) continue;
      if (cand.shape === span.from.contact.shape || cand.shape === span.to.contact.shape) continue;
      const pose = cand.body.isMobile ? this.sweepPose(cand.body) : null;
      const crossing = shapeCrossesSpan(cand.shape, pose, motion, (i) => !isSeamVertex(cand.shape, i));
      if (crossing) (out ??= new Map()).set(cand, crossing);
    }
    return out;
  }

  // Where a node of the current path was at the last regeneration, by role
  // (see `lastExit`); null where nothing was recorded, which is the first
  // regeneration of a rope and a node on a mobile body the scene did not hold.
  private previousNodePosition(node: RopeNode): Vec2 | null {
    if (node === this.end) return this.lastEnd;
    const obj = node.contact.obj;
    if (obj === this.start.contact.obj && node.contact.shapeIndex === this.start.contact.shapeIndex) {
      return this.lastExit;
    }
    if (!(obj instanceof PhysicsBody2D) || !obj.isMobile) return node.contact.globalPosition;
    const pose = this.sweepPose(obj);
    if (!pose) return null;
    return pose.position.add(node.contact.position.rotated(pose.rotation));
  }

  // Where a mobile body was at the last regeneration, for the sweep to place its
  // points at - and where it IS if it got here by teleporting.
  //
  // A `repeat` mover reaching the end of its run is put back at the start
  // (`moverScript`), and that is not a journey. Swept from the pose the last
  // regeneration saw, the platform crosses the whole level in one step: every
  // span hanging over its run reads as crossed, so a player hanging anywhere
  // along it is caught by a body that was never there and flung (`session-439f`,
  // 2.3 m/s to 45 m/s on the frame the trolley went home). It is the same delta
  // `AnimatableBody2D.commitMove` refuses to read as a contact velocity, refused
  // here for the same reason: the body has not passed through anything, it has
  // ceased to be where it was.
  //
  // `jumped` is true for the whole frame the jump happened on, so every
  // regeneration in it reads the body as standing still - which it is, having
  // already been put where it is going before the first of them.
  private sweepPose(body: PhysicsBody2D): Pose | null {
    if (body instanceof AnimatableBody2D && body.jumped) {
      return { position: body.globalPosition, rotation: body.globalRotation };
    }
    return this.lastPoses.get(body) ?? null;
  }

  private recordSweepBaseline(bodies: readonly PhysicsBody2D[]): void {
    if (!this.continuous) return;
    this.lastEnd = this.end.contact.globalPosition;
    const startObj = this.start.contact.obj;
    const startIndex = this.start.contact.shapeIndex;
    let exit: RopeNode = this.start;
    for (const wrap of this.wraps) {
      if (wrap.contact.obj !== startObj || wrap.contact.shapeIndex !== startIndex) break;
      exit = wrap;
    }
    this.lastExit = exit.contact.globalPosition;
    this.lastPoses = new Map();
    for (const body of bodies) {
      if (body.isMobile) {
        this.lastPoses.set(body, { position: body.globalPosition, rotation: body.globalRotation });
      }
    }
  }

  // The coil: rope wound onto the circular body the rope *starts* on — the ball
  // winding its own chain around itself.
  //
  // Everywhere else a wrap is a discrete decision about one corner, and that is
  // the right model: the rope either bends around that corner or it does not.
  // A coil is not that. It is one continuous quantity, the angle of rope lying
  // on the circle, and representing it as a run of twenty tangent points made
  // every frame's answer a fresh stack of twenty independent decisions. They do
  // not agree frame to frame. `cullDetachedNodes` drops a wrap once the rope
  // stops bending around it, which is correct per node and *cascades*: the tail
  // node goes, the one before it inherits the new outgoing span and goes too. In
  // session-458f three went at once and the measured path fell 18.6 cm with
  // nothing having moved — which the solver dutifully "corrected" by snapping
  // the bodies several centimetres, and the winch stall covered the rest.
  //
  // So the coil is carried as the angle instead, and the nodes are re-derived
  // from it. Three things determine it, and each is continuous on its own:
  //
  //   * the material point the rope leaves the body from (`start`), which simply
  //     rotates with the body;
  //   * the tangent point the rope leaves *at*, which is geometry — where a
  //     taut line from the next node touches the circle — and slides smoothly as
  //     that node moves;
  //   * how many whole turns are in between, which is the only thing that has to
  //     be remembered, and is remembered by unwrapping the angle against last
  //     frame's rather than re-deriving it.
  //
  // Winding past a full turn, and unwinding back through zero, are then both
  // ordinary arithmetic on one number. There is no create, no cull, and nothing
  // to cascade.
  private syncCoil(): void {
    const body = this.start.contact.obj;
    const shape = this.start.contact.shape;
    const shapeIndex = this.start.contact.shapeIndex;
    const onCoilShape = (node: RopeNode): boolean =>
      node.contact.obj === body && node.contact.shapeIndex === shapeIndex;

    if (shape.shape.kind !== "circle" || !shape.wrappable) {
      this.coilWindAngle = null;
      return;
    }
    // How far the leading run of self-wraps reaches. A coil *starts* when the
    // generator puts one there; once it exists it is kept alive by its angle,
    // not by the run, so that a frame where the run momentarily collapses
    // cannot lose the turns that are wound on.
    let runLength = 0;
    while (runLength < this.wraps.length && onCoilShape(this.wraps[runLength]!)) runLength++;
    if (runLength === 0 && this.coilWindAngle === null) return;
    const wrapDir = runLength > 0 ? this.wraps[0]!.wrapDir : this.coilWrapDir;
    if (wrapDir === null) {
      this.coilWindAngle = null;
      return;
    }

    const centre = shape.globalPosition;
    const radius = shape.shape.radius;
    const exitTowards = (this.wraps[runLength] ?? this.end).contact.globalPosition;
    const exitDistance = exitTowards.distanceTo(centre);
    // A point at the centre has no direction to leave along - the one frame
    // there is nothing to re-derive an angle from. Leave the coil as it stands.
    if (radius <= 0 || exitDistance === 0) return;

    // The point the rope leaves the rim at. A tangent, when the exit point is
    // clear of the circle; the exit point's own radial projection when it is on
    // or inside it, which is the tangent's limit as the point comes down onto
    // the rim (`acos(r/d)` goes to zero with `d - r`) and so keeps the wind
    // angle continuous through it. A ball wound tight against its anchor body
    // rests with the anchor ON its rim, to float noise either side
    // (`session-611f` f250-290): treating that as a frame with no answer left
    // the coil riding the body, so the unwind below measured every rotation as
    // LENGTHENING the path and refused to turn the ball back at all.
    const tangentPoint =
      exitDistance > radius
        ? RopeGeneration.calculateCircleTangentPoint(
            shape,
            wrapDir,
            exitTowards,
            GenerationDirection.Reversed,
          )
        : centre.add(centre.directionTo(exitTowards).mul(radius));
    const fromDirection = centre.directionTo(this.start.contact.globalPosition);
    const rawAngle = Calc.absoluteAngle(
      fromDirection,
      centre.directionTo(tangentPoint),
      wrapDir,
    );
    // Unwrap: pick the whole number of turns that keeps the angle nearest last
    // frame's, so the measure runs continuously through 0 and through 2π instead
    // of jumping a full turn at either.
    let windAngle = rawAngle;
    if (this.coilWindAngle !== null) {
      const turns = Math.round((this.coilWindAngle - rawAngle) / Mathf.Tau);
      windAngle = rawAngle + turns * Mathf.Tau;
    }
    if (windAngle <= Rope.MIN_COIL_ANGLE) {
      // Spooled off. The rope leaves the body straight from its start point.
      this.coilWindAngle = null;
      this.coilWrapDir = null;
      this.wraps = this.wraps.slice(runLength);
      return;
    }
    this.coilWindAngle = windAngle;
    this.coilWrapDir = wrapDir;

    // Re-sample the arc. The last sample is the tangent point exactly, which is
    // the only one the length solve reads (`generatePathObjects` collapses a run
    // of same-circle wraps into the one that leaves the body); the rest carry the
    // drawn chain round the rim.
    const steps = Math.max(1, Math.ceil(windAngle / Rope.COIL_NODE_ARC));
    const coilNodes: RopeWrap[] = [];
    for (let i = 1; i <= steps; i++) {
      const swept = (windAngle * i) / steps;
      const point = centre.add(fromDirection.rotated(swept * (wrapDir as number)).mul(radius));
      coilNodes.push(
        new RopeWrap(new RopeContact(body, point.sub(body.globalPosition), shapeIndex), wrapDir),
      );
    }
    this.wraps = [...coilNodes, ...this.wraps.slice(runLength)];
  }

  // Uncross segments adjacent to corner nodes of oppositely-wrapped shapes.
  private uncrossAdjacentNodes(): void {
    for (let i = 0; i < this.wraps.length - 3; i++) {
      const segAB = new Segment(
        this.wraps[i]!.contact.globalPosition,
        this.wraps[i + 1]!.contact.globalPosition,
      );
      const segCD = new Segment(
        this.wraps[i + 2]!.contact.globalPosition,
        this.wraps[i + 3]!.contact.globalPosition,
      );
      if (segAB.intersects(segCD, 0)) {
        const tmp = this.wraps[i + 1]!;
        this.wraps[i + 1] = this.wraps[i + 2]!;
        this.wraps[i + 2] = tmp;
        this.markPathChanged();
      }
    }
  }

  // A corner of the clamp's own body inside the cuff's DISC is not a corner
  // the chain bends round: the chain leaves the ring at its rim, so the joint
  // of the bar the ring straddles and the near corner of the lid it hangs
  // beside are metal it is already clear of. The wrap scan and both
  // self-intersection resolvers already refuse to be BORN there (`inCuff`),
  // and this is the same rule standing: the ring swings on the point it rests
  // on, so a corner it was legally born a millimetre outside the disc is one
  // the ring can then swing onto.
  //
  // Which is what it did: a node born 54 mm from the cuff's centre - the disc
  // is 53.5 - was 2 mm from it eight frames later, and a last span two
  // millimetres long has no direction but noise, so the ring hunted a fifth of
  // a radian either way of it at frame rate for the rest of the recording
  // (`session-153f`). Born-and-forgotten is not a rule, it is a race.
  private cullNodesInCuff(): void {
    const cuff = this.end_;
    if (!(cuff instanceof RopeClamp)) return;
    this.wraps = this.wraps.filter(
      (n) => n.contact.obj !== cuff.body || !cuff.covers(n.contact.globalPosition),
    );
  }

  private cullDuplicateNodes(): void {
    const newNodes: RopeWrap[] = [];
    let previousNode: RopeWrap | null = null;
    let previousNodePosition = this.start.contact.globalPosition;
    for (const node of this.wraps) {
      const shape = node.contact.shape;
      // Coincident duplicate: the same corner of the same body wrapped twice
      // in the same direction (adjacent spans can each contribute the corner
      // when it sits exactly on the rope line, e.g. a rotating rect crossing
      // it). The rect branch below would keep both; the resulting zero-length
      // span has no direction, which sends cullDetachedNodes into a
      // reroute/detach cycle until its depth cap throws — drop the duplicate.
      if (
        previousNode !== null &&
        node.contact.obj === previousNode.contact.obj &&
        node.wrapDir === previousNode.wrapDir &&
        node.contact.globalPosition.distanceSquaredTo(previousNodePosition) < 1e-6
      ) {
        continue;
      }
      if (
        shape.shape.kind !== "circle" ||
        node.contact.globalPosition.distanceTo(previousNodePosition) > PX
      ) {
        newNodes.push(node);
        previousNode = node;
        previousNodePosition = node.contact.globalPosition;
      }
    }
    this.wraps = newNodes;
  }

  private generatePathObjects(): PathObject[] {
    const epoch = currentTransformEpoch();
    if (this.pathObjectCache && this.pathObjectCacheEpoch === epoch) return this.pathObjectCache;
    const spans = this.regenerateSpans();
    const start = new PathStart(this.start.contact.obj as PhysicsBody2D, spans[0]!.span);
    const end = new PathEnd(this.end.contact.obj as PhysicsBody2D, spans[spans.length - 1]!.span);
    const pathWraps: PathWrap[] = [];

    let prevSegment = spans[0]!.span;
    const p = this.path();
    for (let i = 1; i < p.length - 1; i++) {
      const nodeA = p[i]!;
      const nodeB = p[i + 1]!;
      if (nodeA instanceof RopeWrap) {
        const shape = nodeA.contact.shape;
        // A run of coil nodes on ONE circle collapses into the single wrap that
        // leaves it; two nodes on two different pieces of one compound body are
        // two wraps, not a coil, so the comparison is by shape (`spanLength`
        // measures the same run the same way, and by shape for the same reason).
        if (
          nodeB.contact.shape !== shape ||
          shape.shape.kind !== "circle" ||
          nodeB === this.end
        ) {
          const nextSegment = new Segment(
            nodeA.contact.globalPosition,
            nodeB.contact.globalPosition,
          );
          pathWraps.push(
            new PathWrap(
              prevSegment,
              nextSegment,
              nodeA.contact.obj as PhysicsBody2D,
              nodeA.wrapDir,
              shape,
            ),
          );
          prevSegment = nextSegment;
        }
      }
    }
    if (pathWraps.length > 0 && pathWraps[0]!.body === start.body) {
      start.selfWrap = pathWraps[0]!;
      pathWraps.shift();
    }
    if (pathWraps.length > 0 && pathWraps[pathWraps.length - 1]!.body === end.body) {
      end.selfWrap = pathWraps[pathWraps.length - 1]!;
      pathWraps.pop();
    }
    const out: PathObject[] = [start, ...pathWraps, end];
    this.pathObjectCache = out;
    this.pathObjectCacheEpoch = epoch;
    return out;
  }

  // Length of one span of the path. A span between two nodes riding the same
  // circle is rope lying *on* that circle, so it is the arc, not the chord.
  //
  // This is what makes the path length continuous as wrap nodes come and go. A
  // coil is stored as a run of discrete tangent points, and the generator's
  // create/cull decisions for the ones at the tail of the run are marginal — in
  // session-458f four of them were dropped in a single regeneration and the
  // measured path fell 19.8 cm with nothing having moved, which the solver then
  // "corrected" by snapping the bodies several centimetres and the winch stall
  // covered whatever it could not reach. Measured as arcs there is nothing to
  // correct: dropping an intermediate node leaves r·(θ₃−θ₁) exactly as it was,
  // where dropping it from a chord sum does not. Chords also *understate* a
  // coil, and by more the coarser the node spacing, so the arc is the more
  // faithful measure besides being the stable one.
  //
  // Only the length changes. The solver still works in spans: tension acts along
  // the chord's tangent, and that geometry is unaffected.
  private spanLength(from: RopeNode, to: RopeNode): number {
    const chord = from.contact.globalPosition.distanceTo(to.contact.globalPosition);
    if (from.contact.obj !== to.contact.obj) return chord;
    const shape = from.contact.shape;
    if (shape.shape.kind !== "circle" || to.contact.shape !== shape) return chord;
    // The sweep direction comes from whichever end is a wrap; a run of coil
    // nodes shares it, and a span between two ends that are not wraps at all is
    // not a coil.
    const wrapDir =
      to instanceof RopeWrap ? to.wrapDir : from instanceof RopeWrap ? from.wrapDir : null;
    if (wrapDir === null) return chord;
    const centre = shape.globalPosition;
    const radius = shape.shape.radius;
    if (radius <= 0) return chord;
    const swept = Calc.absoluteAngle(
      centre.directionTo(from.contact.globalPosition),
      centre.directionTo(to.contact.globalPosition),
      wrapDir,
    );
    // A near-half-turn or more between adjacent nodes is not a coil step — the
    // rope is crossing the body, not lying on it — so trust the chord there.
    if (swept > Mathf.Pi) return chord;
    return radius * swept;
  }

  // The run of wrap nodes at the START of the path riding the start
  // attachment's own circle - the coil `syncCoil` winds on and spools off -
  // and what it measures. Zero of both when the rope does not start on a
  // circle, or starts on one with nothing wound onto it.
  //
  // This is the same collapse `generatePathObjects` already performs: a run of
  // coil nodes on one circle is ONE wrap to the solver, and the intermediate
  // nodes exist to carry the drawn chain round the rim (see `syncCoil`). The
  // length measure is the last reader that was still walking all of them, and
  // it is the one called thousands of times a frame - the ball rolling with
  // 2.4 turns wound on measured a 63-node path 2363 times on one frame of
  // `session-231f`, 61 of those nodes coil.
  private leadingCoilRun(): { nodes: number; length: number } {
    const cached = this.coilRunCache;
    if (cached) return cached;
    const wraps = this.wraps_;
    const obj = this.start_.contact.obj;
    const shapeIndex = this.start_.contact.shapeIndex;
    let nodes = 0;
    // By shape and not just by body, for the reason `spanLength` and
    // `generatePathObjects` both give: two nodes on two pieces of one compound
    // body are two wraps, not a coil.
    if (this.start_.contact.shape.shape.kind === "circle") {
      while (
        nodes < wraps.length &&
        wraps[nodes]!.contact.obj === obj &&
        wraps[nodes]!.contact.shapeIndex === shapeIndex
      ) {
        nodes++;
      }
    }
    // Summed in path order, so a cache built at this pose is bit-for-bit the
    // sum the walk below would have produced.
    let length = 0;
    let previous: RopeNode = this.start_;
    for (let i = 0; i < nodes; i++) {
      length += this.spanLength(previous, wraps[i]!);
      previous = wraps[i]!;
    }
    const run = { nodes, length };
    this.coilRunCache = run;
    return run;
  }

  private calculateRopePathLength(): number {
    // The coil run from its own cache, then the rest of the path span by span.
    // Walked directly rather than over `regenerateSpans` so that measuring a
    // length costs no `RopePath`/`Segment` allocation: those are built for the
    // Jacobian, which needs the chord geometry, and a length sum does not.
    const coil = this.leadingCoilRun();
    let cumulativeLength = coil.length;
    const wraps = this.wraps_;
    let previous: RopeNode = coil.nodes > 0 ? wraps[coil.nodes - 1]! : this.start_;
    for (let i = coil.nodes; i < wraps.length; i++) {
      cumulativeLength += this.spanLength(previous, wraps[i]!);
      previous = wraps[i]!;
    }
    cumulativeLength += this.spanLength(previous, this.end_);
    if (this.start.contact.obj instanceof Player) {
      cumulativeLength -= this.start.contact.obj.radialCoMOffset;
    }
    if (this.end.contact.obj instanceof Player) {
      cumulativeLength -= this.end.contact.obj.radialCoMOffset;
    }
    return cumulativeLength;
  }

  // Bodies the current pass must treat as immovable. Null outside a winch pass,
  // which is every pass every other caller makes.
  private held: ReadonlySet<CollisionObject2D> | null = null;

  // Enforce the length with `held` immovable, so the whole correction lands on
  // whatever is left free.
  //
  // This is the winch, stated as a solve. Winding chain onto the ball's own rim
  // shortens the free path, and the way that is paid for is by hauling the BALL
  // towards its anchor - never by hauling the anchor, which is a kinematic spin
  // driving a body that has to keep what it is given (`session-265f`). The
  // ordinary solve cannot say that: it splits every correction by effective
  // inverse mass, so an anchor lighter than the ball takes most of it, and
  // `BallLevel`'s rollback then takes that share back off the anchor and leaves
  // the length unpaid. Held, the same solve puts all of it where the winch was
  // always supposed to put it.
  //
  // Position only, like every other length correction: the caller pays the
  // velocity for it, over the displacement the phase actually ends on.
  solveLengthHolding(held: ReadonlySet<CollisionObject2D>): void {
    this.held = held;
    try {
      PhaseTrace.inPass("winch", () => this.resolveLengthConstraint());
    } finally {
      this.held = null;
    }
  }

  private resolveLengthConstraint(): number | null {
    let cumulativeCorrectionImpulse = 0;
    let error = this.calculateRopePathLength() - this.constraintLength;
    // The step is sized by the WHOLE error, and on a chain coiled tight onto
    // its ball most of that error is coil, which no translation can remove:
    // the free span from the coil to the anchor is millimetres long, the step
    // is decimetres, and the ball is carried straight past its anchor into a
    // longer path than it left (124 mm of error to 262 in one iteration,
    // `session-154f` f86-88). Undone outright the constraint is simply
    // abandoned for the frame and the pair drifts apart; halved until it
    // shortens, the translation takes the span's worth and leaves the coil's
    // worth to the unwind, which is whose it is.
    let relaxation = 1;
    // A continuous rope's guard carries a nanometre of tolerance, because the
    // end drawn exactly onto a node measures the same path to the last bit
    // only in exact arithmetic (see `roundEndNode`).
    const guardEpsilon = this.continuous ? Rope.MONOTONE_EPSILON : 0;
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      // An iteration may only shorten the path. The correction is a step along
      // the FIRST span's direction sized by the whole error, and on a chain
      // coiled tight onto its ball that direction is not the path's gradient:
      // the step overshoots, the next span flips the direction, and each
      // iteration lands longer than the last while turning the anchor the same
      // way every time. Ten of those spun a 12.6 kg weight fourteen turns in
      // one frame, wrapped the chain around it into a 3.8 m path, and the
      // winch hauled the ball 1.2 m after it: a 93 m/s launch out of a 27 cm
      // error (`session-239f` f192, replayed). Undone and stopped, the error
      // stands as over-length for the unwind and the stall lease, which is
      // what a correction geometry will not let through has always been.
      const before = this.snapshotPathBodies();
      const wrapsBefore = this.wraps;
      this.endReachedNode = false;
      const correctionImpulse = this.correctShapePositionAndRotation(relaxation);
      if (correctionImpulse === null) {
        if (iteration === 0) return null;
        break;
      }
      const after = this.calculateRopePathLength() - this.constraintLength;
      const undone = after > error + guardEpsilon;
      // One record per iteration, before the guard acts on it: what the
      // iteration was handed, what it left, whether it stood, and the per-body
      // terms that decided where the correction went. A diverging solve is ten
      // of these with the error climbing and `dirX` alternating (`session-239f`
      // f192), and it was visible only through a temporary print until now.
      PhaseTrace.solve(iteration, error, after, undone, this.solveTerms);
      if (undone) {
        this.restorePathBodies(before);
        if (this.wraps !== wrapsBefore) this.wraps = wrapsBefore;
        relaxation *= 0.5;
        if (relaxation < Rope.MIN_RELAXATION) break;
        continue;
      }
      error = after;
      cumulativeCorrectionImpulse += correctionImpulse;
      if (this.endReachedNode) this.roundEndNode();
    }
    this.frameCorrection += cumulativeCorrectionImpulse;
    return cumulativeCorrectionImpulse;
  }

  // The far end has been drawn up to the last wrap node, so the rope no longer
  // bends there: drop the node, and the next iteration pulls the end on towards
  // the one before it. This is how a light end rounds a corner INSIDE a solve.
  //
  // The correction step is a straight pull along the last span sized by the
  // whole error, and a chain caught over a small body by a ball falling at
  // 15 m/s has an error of 40 cm against a last span of 15 cm: the quarter-kilo
  // hook was carried a whole span past the corner, the next iteration pulled it
  // straight back, and ten iterations oscillated about the corner for 3 mm of
  // progress each (`session-126f` f97). The over-length then stood at 0.9 m
  // for four frames, the ball was braked to a standstill by a hook that could
  // not move, and when the hook finally bit the block the solve hauled the ball
  // 40 cm in one frame - 18 m/s straight up. Whipped round the block within
  // the frame instead, the hook bites where it lands and the ball is arrested
  // over the corner as a swing, which is what a chain over a block does.
  //
  // Only a scene node is dropped. The last node may be the start itself or
  // the coil on the start body, and neither is a corner to round: the coil is
  // `syncCoil`'s to keep and the start is where the rope ends.
  private roundEndNode(): void {
    const last = this.wraps[this.wraps.length - 1];
    if (!last) return;
    if (
      last.contact.obj === this.start.contact.obj &&
      last.contact.shapeIndex === this.start.contact.shapeIndex
    ) {
      return;
    }
    this.wraps = this.wraps.slice(0, -1);
  }

  // Smallest share of a correction step worth trying before the solve gives
  // the frame up: six halvings, a sixty-fourth of the error.
  private static readonly MIN_RELAXATION = 1 / 64;
  // Metres of lengthening the monotone guard forgives a continuous rope's
  // iteration, so an end snapped onto a node is not undone for float noise.
  private static readonly MONOTONE_EPSILON = 1e-9;

  // Everything an iteration of the length solve may move, so the monotone
  // guard can put it all back: the path bodies' poses, and - for a clamped
  // end - where along its rail the cuff stands and what is left of the
  // frame's slide budget. A slide undone with its budget kept would be a
  // clamp that runs out of road for a move it never made.
  private snapshotPathBodies(): PathSnapshot {
    const bodies: PathSnapshot["bodies"] = [];
    for (const node of this.path()) {
      const body = node.contact.obj;
      if (!(body instanceof PhysicsBody2D) || bodies.some((o) => o.body === body)) continue;
      bodies.push({ body, position: body.globalPosition, rotation: body.globalRotation });
    }
    const clamp = this.end instanceof RopeClamp ? this.end.snapshot() : null;
    const embed = this.end instanceof RopeEmbed ? this.end.snapshot() : null;
    const ring = this.end instanceof RopeVineClamp ? this.end.snapshot() : null;
    return { bodies, clamp, embed, ring, slideBudget: this.slideBudget };
  }

  private restorePathBodies(snapshot: PathSnapshot): void {
    for (const s of snapshot.bodies) {
      s.body.globalPosition = s.position;
      s.body.globalRotation = s.rotation;
    }
    if (snapshot.clamp && this.end instanceof RopeClamp) {
      this.end.restoreState(snapshot.clamp);
      this.markPathChanged();
    }
    if (snapshot.embed && this.end instanceof RopeEmbed) {
      this.end.restoreState(snapshot.embed);
      this.markPathChanged();
    }
    if (snapshot.ring && this.end instanceof RopeVineClamp) {
      this.end.restoreState(snapshot.ring);
      this.markPathChanged();
    }
    this.slideBudget = snapshot.slideBudget;
  }

  // The ring's own frame: let a clamped end run along its rail under its own
  // weight, or run off the bar's open end, and swing on the point it rests on
  // toward whatever is pulling it (`RopeClamp.coast`, `RopeClamp.seat`).
  //
  // Once a frame, and OUTSIDE the length solve, because a ring hangs and falls
  // whether or not the chain is taut: a ball resting on the floor under a slack
  // chain still swings the cuff as it rolls, a ring threaded onto a vertical
  // bar falls whatever the chain is doing, and the length solve returns before
  // it ever looks at a clamp when there is no error to correct. It runs before
  // the path is regenerated, so a ring that has run off the bar is replaced
  // before the pass reads the path - the node it swings toward is last
  // frame's, which the cuff cannot tell from this frame's.
  //
  // What it swings toward is the node the chain reaches it from while the
  // chain was pulling on it last frame, and straight down otherwise: a slack
  // chain's last span has a direction, but not one the ring hangs by.
  private settleClamp(delta: number): void {
    if (this.seatLooked) return;
    const clamp = this.end;
    if (clamp instanceof RopeEmbed) {
      this.seatLooked = true;
      this.settleEmbed(clamp);
      return;
    }
    if (clamp instanceof RopeVineClamp) {
      this.seatLooked = true;
      this.settleVineClamp(clamp);
      return;
    }
    if (!(clamp instanceof RopeClamp)) return;
    this.seatLooked = true;
    const grip = clamp.body.surfaceFriction;
    // The hang is decided BEFORE the ring is let go of, because whether the
    // chain is pulling on it decides both where it hangs and whether it is
    // free to run down the bar at all.
    const hang = this.clampHang(clamp);
    const coasted = clamp.coast(
      delta,
      RAIL_STATIC_FRICTION * grip,
      RAIL_KINETIC_FRICTION * grip,
      GRAVITY,
      hang.blocked,
    );
    if (coasted.ranOff !== 0) {
      this.markPathChanged();
      this.onClampRunOff?.(clamp, coasted.ranOff);
      return;
    }
    const seated = clamp.seat(hang.toward, delta, hang.pulling);
    if (coasted.moved || seated) this.markPathChanged();
  }

  // The frame's first look at an embedded end (`RopeEmbed`): is the cuff still
  // held? Its mouth is what grips the face, and a mouth that has crept clear
  // of every piece of the body it bit is gripping nothing - the cuff drops
  // out, at the speed it was creeping, and the owner replaces the end with the
  // dangling tip (`onEmbedDrop`). Once a frame and before the path is
  // regenerated, as a rail's run-off is, so a dropped cuff is replaced before
  // the pass reads the path. The frame's creep tally is read here and
  // cleared, so a cuff that is not pulled on this frame reads as still.
  private settleEmbed(embed: RopeEmbed): void {
    const velocity = this.frameDelta > 0 ? embed.slipped.div(this.frameDelta) : Vec2.ZERO;
    embed.slipped = Vec2.ZERO;
    if (embed.holding().kind !== "nothing") return;
    this.markPathChanged();
    this.onEmbedDrop?.(embed, velocity);
  }

  // Let an embedded end creep through the viscous face it bit, along the pull
  // of the span that reaches it, and say how much of the path's length that
  // took out (see `lib/viscous.ts`).
  //
  // The whole frame's creep is decided at the solve's first look, from the
  // tension the solve is about to apply: the path's over-length and the
  // effective mass along it are what the correction would be made of, so
  // `slipDistance` reads them as the force on the anchor and answers how far
  // the mud lets it move for that force. The share of the error a wrap
  // appearing or vanishing put there is no tension (`topologyCreditScale`),
  // so it is taken out of the reading. Later iterations of the same frame find
  // the budget spent; an undone iteration has it refunded with the pin's
  // position (`snapshotPathBodies`).
  //
  // The creep runs along the LAST span - from the pin toward the node the
  // chain reaches it from, the ball or a corner on the way - and no further
  // than that node, nor than the over-length itself: past either the chain
  // would be slack, and a slack chain is pulling on nothing. The pin is the
  // node the span ends on, so a creep of `s` along it shortens the path by
  // exactly `s`.
  //
  // A mouth that has crept out of the mud into a SOLID piece of the same body
  // is stuck fast there and creeps no further; one that has crept clear of
  // everything is dropped at the next frame's first look (`settleEmbed`).
  //
  // A pin that REACHES the node it is pulled toward has crept up to a corner
  // the chain bends round, and the chain no longer bends there: the node is
  // rounded - dropped, for the next iteration to pull the pin on toward the
  // one before it - exactly as a continuous rope's far end rounds a corner
  // inside a solve (`boundToNode`, `roundEndNode`). Left standing, a pin ON
  // its wrap node has a pull with no direction, and the cuff sat at the
  // corner of a mud blob for ever with the ball swinging under it
  // (`session-332f`, f208 on).
  private slipEmbeddedEnd(): number {
    const embed = this.end;
    if (!(embed instanceof RopeEmbed)) return 0;
    const nodes = this.path();
    const prev = nodes[nodes.length - 2];
    if (!prev) return 0;
    if (!this.slideLooked) {
      this.slideLooked = true;
      this.slideBudget = 0;
      const held = embed.holding();
      if (held.kind === "viscous") {
        const error = this.calculateRopePathLength() - this.constraintLength;
        const inverseInertia = this.effectiveInverseInertia(this.generatePathObjects());
        if (error > 0 && inverseInertia >= 1e-6) {
          this.slideBudget = slipDistance(
            error * this.topologyCreditScale,
            1 / inverseInertia,
            this.frameDelta,
            held.viscosity,
          );
        }
      }
    }
    if (this.slideBudget <= 0) return 0;
    const pin = embed.contact.globalPosition;
    const pull = prev.contact.globalPosition.sub(pin);
    const reach = pull.length();
    if (reach < Rope.EMBED_NODE_EPSILON) {
      this.endReachedNode = true;
      return 0;
    }
    const before = this.calculateRopePathLength();
    const step = Mathf.min(this.slideBudget, Mathf.min(before - this.constraintLength, reach));
    if (step <= 0) return 0;
    if (step >= reach) this.endReachedNode = true;
    embed.slip(pull.mul(step / reach));
    this.slideBudget = Mathf.max(this.slideBudget - step, 0);
    this.markPathChanged();
    return before - this.calculateRopePathLength();
  }

  // How close to the node it is pulled toward an embedded pin counts as ON it:
  // a micron, well under any creep a frame makes and well over float noise.
  private static readonly EMBED_NODE_EPSILON = 1e-6;

  // The frame's first look at a ring on a vine (`RopeVineClamp`): put it back
  // on the vine's line where its segment and fraction say it stands - the
  // links have moved since the last look, and the ring rides the cord rather
  // than its link's frame - then act on a ring the last creep drove off the
  // free end, which comes back as the dangling tip at the speed it was being
  // driven at (`onVineRunOff`), and hang the rim toward what is pulling. Once
  // a frame and before the path is regenerated, where a rail's `settleClamp`
  // and a mud embed's `settleEmbed` are, and for the same reason: a ring that
  // has left the vine is replaced before the pass reads the path.
  private settleVineClamp(clamp: RopeVineClamp): void {
    const dt = this.frameDelta;
    let velocity = dt > 0 ? clamp.slipped.div(dt) : Vec2.ZERO;
    clamp.slipped = Vec2.ZERO;
    if (clamp.sync()) this.markPathChanged();
    const ran = clamp.takeRunOff();
    if (ran.ranOff) {
      const t = clamp.tangent();
      if (t !== null && dt > 0) velocity = velocity.add(t.mul(ran.overrun / dt));
      this.markPathChanged();
      this.onVineRunOff?.(clamp, velocity);
      return;
    }
    // Pulling, or slack? The bound is the rail's (`clampHang`): a chain within
    // a bore's radius of taut can be taut at some hang of the ring; slacker
    // than that has really gone slack, and a slack chain hangs the rim
    // nowhere.
    const nodes = this.path();
    const prev = nodes[nodes.length - 2];
    const slack = this.constraintLength - this.calculateRopePathLength();
    const pulling = prev !== undefined && slack < MANACLE_BORE / 2;
    clamp.seat(pulling ? prev.contact.globalPosition : clamp.contact.globalPosition.add(GRAVITY), pulling);
  }

  // Let a ring on a vine creep along the vine under the pull of the span that
  // reaches it, and say how much of the path's length that took out - the mud
  // embed's seat (`slipEmbeddedEnd`), for a cuff LOCKED to a line (see
  // `lib/vineClamp.ts`).
  //
  // Two things differ from the mud, and both are the line's. Only the pull's
  // component ALONG the vine drives the creep, and a creep along it relieves
  // only that component's share of the error (`slipDistance`'s `along`), so a
  // ball hanging plumb under the vine draws the ring straight down it at the
  // law's speed and a ball swung out sideways barely moves it. And the tension
  // is read from the bodies the vine does NOT hold: the link the ring stands
  // on is on the path and the length solve may move it, but the load rope and
  // the pair chains hold it on the vine, which this solve cannot see - so it
  // is left out of the effective mass, and a ball under a held vine reads as
  // a ball under a fixed anchor. Its share of the correction still lands on
  // it below, and the coupled sweep then argues that out with the vine.
  //
  // The error the first look reads is not the whole of the tension, and that
  // is the other thing the link costs. Between one frame's last pass and the
  // next frame's first look the link falls under its own gravity and its
  // vine's own sweep leaves it sagging within the joints' tolerance, and the
  // ring, re-seated on the line (`settleVineClamp`), comes down with it - so
  // the first look sees the ball's fall LESS the link's sag, about a third
  // short on a dead hang (2.0 mm against 3.2, measured), and the squared law
  // made half the creep of it. The coupled sweep then lifts the link back and
  // corrects the ball for the rest, but the budget was decided. So the look
  // is floored by what the chain carried LAST frame: the length solve's
  // summed correction over every pass, which is the impulse the tension
  // actually delivered (both ends of a rope feel the same impulse however
  // the split falls, and the sweep's passes sum to the ball's whole
  // correction), plus the over-length the creep relieved before it. On a
  // steady hang that is the ball's fall exactly; on a catch the first look
  // is the larger by far and stands, so the ball is slowed over the frames
  // the slip takes to decay rather than in one, as the mud slows it.
  //
  // The budget is decided at the frame's first look and spent along the line
  // - crossing from link to link as it goes, stopping at a closed end, running
  // off the open one - no further than the over-length lets: past that the
  // chain would be slack and pulling on nothing. An undone iteration refunds
  // it with the ring's place on the line (`snapshotPathBodies`).
  private slipVineClampedEnd(): number {
    const clamp = this.end;
    if (!(clamp instanceof RopeVineClamp)) return 0;
    const nodes = this.path();
    const prev = nodes[nodes.length - 2];
    if (!prev) return 0;
    const t = clamp.tangent();
    if (t === null) return 0;
    const pull = prev.contact.globalPosition.sub(clamp.contact.globalPosition);
    const reach = pull.length();
    if (reach < Rope.EMBED_NODE_EPSILON) return 0;
    const along = pull.dot(t) / reach;
    if (!this.slideLooked) {
      this.slideLooked = true;
      this.slideBudget = 0;
      this.slideSign = along >= 0 ? 1 : -1;
      const inverseInertia = this.effectiveInverseInertia(this.generatePathObjects(), clamp.link);
      const seen = (this.calculateRopePathLength() - this.constraintLength) * this.topologyCreditScale;
      const carried = this.lastFrameCorrection * inverseInertia + this.lastFrameCreepRelief;
      const error = Mathf.max(seen, carried);
      if (error > 0 && inverseInertia >= 1e-6 && along !== 0) {
        this.slideBudget = slipDistance(
          error,
          1 / inverseInertia,
          this.frameDelta,
          clamp.vine.viscosity,
          Math.abs(along),
        );
      }
    }
    if (this.slideBudget <= 0 || along * this.slideSign <= 0) return 0;
    const before = this.calculateRopePathLength();
    const over = before - this.constraintLength;
    if (over <= 0) return 0;
    const step = Mathf.min(this.slideBudget, over / Math.abs(along));
    const moved = clamp.creep(this.slideSign * step);
    if (moved !== 0) {
      clamp.slipped = clamp.slipped.add(t.mul(moved));
      this.markPathChanged();
    }
    this.slideBudget = Mathf.max(this.slideBudget - Math.abs(moved), 0);
    const relieved = before - this.calculateRopePathLength();
    this.frameCreepRelief += relieved;
    return relieved;
  }

  // The path's summed inverse inertia along the constraint: what one metre of
  // length correction is divided by to become the correction impulse, and
  // whose reciprocal is the effective mass the chain's tension acts on. Each
  // dynamic body on the path contributes its mechanical advantage squared
  // over its effective inverse mass along the pull, torque arm included.
  //
  // `except` is a body left OUT of the sum: the link a ring on a vine stands
  // on, which the vine holds and the tension is not spent on (see
  // `slipVineClampedEnd`).
  private effectiveInverseInertia(pathObjects: PathObject[], except: PhysicsBody2D | null = null): number {
    let total = 0;
    for (const segment of pathObjects) {
      if (segment.body === except) continue;
      const dynamicBody = this.getDynamicBodyState(segment.body);
      if (dynamicBody) {
        const mechanicalAdvantage = segment.calculateMechanicalAdvantage();
        const torqueArm = this.calculateTorqueArm(segment);
        const inverseEffectiveMass =
          1 / dynamicBody.mass + (torqueArm * torqueArm) / dynamicBody.inertia;
        total += mechanicalAdvantage * mechanicalAdvantage * inverseEffectiveMass;
      }
    }
    return total;
  }

  // Where a clamped end hangs, and whether the chain is what is hanging it:
  // the node the chain reaches the ring from while the chain is pulling on it,
  // and straight down otherwise - a slack chain's last span has a direction,
  // but not one the ring hangs by.
  //
  // Is the chain PULLING on the ring, or has it really gone slack? The two
  // answers hang the ring in opposite directions, so this must not be a
  // question the ring's own hang can change the answer to, or it drives
  // itself: the ring swings, the swing moves the chain's end, the moved end
  // crosses the threshold, and the ring swings back (`session-283f`, where it
  // swept its whole tilt range at `RAIL_TILT_RATE` for the rest of the
  // recording).
  //
  // So the slack is measured to the point the ring RESTS on rather than to
  // its centre, which takes the tilt out of the measurement entirely - the
  // rest point is a function of `s` alone. The centre stands exactly a bore's
  // radius from it whatever the tilt is, so a chain within that of its length
  // can be taut at SOME hang of the ring, and slack by more than the ring
  // itself can make is a chain that has really gone slack. That is what
  // `MANACLE_BORE / 2` means here, and it is the exact bound rather than a
  // margin: hanging the ring cannot move the chain's end further.
  //
  // It is the WHOLE test, too. A `loaded` term beside it - the length solve
  // moved this ring last frame, so the chain must be pulling on it - is a
  // second opinion about the same thing, and where the ring sits near the
  // bound the two disagree: the solve touches it every third or fourth frame,
  // each of those frames hangs the ring the other way, and the drawn ring
  // flicks eleven degrees and back for as long as it takes the chain to come
  // taut (`session-164f`). Measured to the rest point the slack is the better
  // witness of the two, so it is the only one.
  clampHang(clamp: RopeClamp): { toward: Vec2; pulling: boolean; blocked: -1 | 0 | 1 } {
    const nodes = this.path();
    const prev = nodes[nodes.length - 2];
    const centre = clamp.contact.globalPosition;
    // The last span into a clamp is always a chord (the cuff's piece is a
    // stroke quad, never a coil's circle), so swapping its end for the rest
    // point is this one substitution rather than a second walk of the path.
    const prevPos = prev?.contact.globalPosition;
    const toRest =
      prevPos === undefined ? 0 : prevPos.distanceTo(centre) - prevPos.distanceTo(clamp.restPoint());
    const slack = this.constraintLength - this.calculateRopePathLength() + toRest;
    const pulling = slack < MANACLE_BORE / 2 && prev !== undefined;
    if (!pulling) return { toward: centre.add(GRAVITY), pulling, blocked: 0 };
    // Which way along the bar the taut chain will not let the ring go, for the
    // ring's own weight to respect (see `RopeClamp.coast`). Moving the ring by
    // `ds` along the bar's tangent changes the last span by `-(p̂·t)·ds`, so
    // the path LENGTHENS toward increasing arc length exactly when the pull
    // runs back against it.
    const toward = prev.contact.globalPosition;
    const t = clamp.tangent();
    const pull = toward.sub(centre);
    const len = pull.length();
    const blocked: -1 | 0 | 1 =
      t === null || len === 0 ? 0 : pull.dot(t) < 0 ? 1 : -1;
    return { toward, pulling, blocked };
  }

  // Let a clamped end swing on its rail and run along it under the pull of the
  // span that reaches it, and say how much of the path's length that took out.
  // The cuff is massless, so it goes first - to wherever force balance puts it,
  // hanging from the point of the bar it rests on (`RopeClamp.seat`) and then
  // running along the bar (`RopeClamp.slide`) - and the bodies split what is
  // left of the error.
  //
  // The pull is the last span's own direction, from the cuff to whatever node
  // the chain reaches it from: the ball, or a corner the chain bends round on
  // the way. The rail's grip is the body's authored `friction` on the rail
  // coefficients, exactly as a rigid body's contact friction is built.
  //
  // Where the ring HANGS is settled before the solve rather than in it (see
  // `settleClamp`); what this step moves is where along the bar it stands.
  //
  // How far it may move in the frame is bounded by what is driving it: the
  // speed it already had along the bar, the speed of the node pulling it
  // measured along the bar, and one frame of gravity on top - so a ring under a
  // ball falling down a vertical bar falls with the ball at `g`, a ring under a
  // coasting zipline ball keeps pace with it exactly, and a ring a ball has
  // swung past the static cone slips away at the ball's own speed rather than
  // leaping to the cone's edge in a frame and dropping the ball off its arc.
  // `RAIL_MAX_SLIDE_SPEED` caps the lot.
  private slideClampedEnd(): number {
    const clamp = this.end;
    if (!(clamp instanceof RopeClamp)) return 0;
    const nodes = this.path();
    const prev = nodes[nodes.length - 2];
    if (!prev) return 0;
    // The frame's first look settles the friction state and opens the budget;
    // every later iteration finds the ring where that look left it (see
    // `RopeClamp.slide`).
    const settle = !this.slideLooked;
    if (settle) {
      const t = clamp.tangent();
      const puller = prev.contact.obj;
      const driving =
        t && puller instanceof PhysicsBody2D
          ? Math.abs(puller.velocityAtPoint(prev.contact.globalPosition).dot(t))
          : 0;
      const pace = Math.abs(clamp.speed) + driving + GRAVITY.length() * this.frameDelta;
      this.slideBudget = Mathf.min(pace, RAIL_MAX_SLIDE_SPEED) * this.frameDelta;
    }
    this.slideLooked = true;
    clamp.noteLoaded();
    if (this.slideBudget <= 0) return 0;
    const before = this.calculateRopePathLength();
    const grip = clamp.body.surfaceFriction;
    const moved = clamp.slide(
      prev.contact.globalPosition,
      this.slideBudget,
      RAIL_STATIC_FRICTION * grip,
      RAIL_KINETIC_FRICTION * grip,
      settle,
    );
    if (moved === 0) return 0;
    this.slideBudget = Mathf.max(this.slideBudget - Math.abs(moved), 0);
    this.markPathChanged();
    return before - this.calculateRopePathLength();
  }

  // Perpendicular lever from the body's centre of rotation to the correction
  // force. That centre is the BODY's origin, which this engine keeps at the
  // centre of mass - not the primary shape's origin, which is the same point
  // only while the body has one shape. A compound body's first piece is mounted
  // at an offset, so measuring from it gave every lever an extra arm the body
  // does not have.
  private calculateTorqueArm(segment: PathObject): number {
    const correctionDir = segment.resolveCorrectionDir();
    const centre = segment.body.globalPosition;

    // A body whose rotation is driven KINEMATICALLY has no torque arm, because
    // it does not answer to torque: its angular velocity is overwritten outright
    // every frame by the controller that owns it (the ball's aim steering), so a
    // rotational share of the length correction is not the rope acting on the
    // body - it is the rope silently rewriting the pose the player asked for.
    //
    // Left in, it is the larger share, and it takes the wind-up with it. The
    // torque arm at a self-wrapped attachment is the ball's own radius, so
    // `inertia / (inertia + mass * arm^2)` leaves under a third of the
    // correction to HAUL and spends the rest unwinding: a ball winding chain
    // onto itself on the ground turned 0.47 rad by the aim and was turned
    // 0.46 rad back by the solve, every frame, for ever. Two things came out of
    // that, and they are the two this fixes:
    //
    //  - The wind-up stalls dead. The chain cannot shorten, the ball is never
    //    hauled towards its anchor, and the spin the player is holding buys
    //    nothing (session-322f: 130 frames at full aim, 0.3 mm of progress).
    //  - The ball visibly shakes. The rotation is walked back in POSITION, so
    //    every frame the ball is spun a quarter-radian one way and dragged back
    //    the other - and with the spin pinned, the mounting loop parks against
    //    the ground and grinds there, driving 3 m/s of contact impulse per frame
    //    into a ball that is not going anywhere.
    //
    // Hauling is the mechanic - winding chain onto yourself is what pulls you in
    // - and `unwindOverLength` is already the place a wind-up with nowhere left
    // to be hauled gives the radian back, bounded to the frame's own turn so the
    // ball stalls rather than unwinding itself. This leaves rotation to it.
    if (segment.body instanceof RigidBody2D && segment.body.kinematicRotation) return 0;

    if (segment instanceof PathStart) {
      if (segment.body instanceof Player) return 0;
      const leverArm = segment.selfWrap
        ? segment.selfWrap.next.start.sub(centre)
        : segment.next.start.sub(centre);
      return leverArm.cross(correctionDir);
    }
    if (segment instanceof PathEnd) {
      const leverArm = segment.selfWrap
        ? segment.selfWrap.previous.end.sub(centre)
        : segment.previous.end.sub(centre);
      return leverArm.cross(correctionDir);
    }
    // A wrapped circle passes its force through its own centre and produces no
    // torque, but that is a fact about the PIECE the rope is bent around, not
    // about the body: a rect welded to a circle is still a rect to wrap.
    if (segment instanceof PathWrap && segment.shape.shape.kind !== "circle") {
      const leverArm = segment.wrapStartPosition.sub(segment.body.globalPosition);
      const torqueFromStart = leverArm.cross(segment.directionToPrevious);
      const torqueFromEnd = leverArm.cross(segment.directionToNext);
      return (torqueFromStart + torqueFromEnd) / segment.calculateMechanicalAdvantage();
    }
    // Wrapped circle: force passes through the centre.
    return 0;
  }

  private getDynamicBodyState(body: PhysicsBody2D): DynamicBody | null {
    // Held for a winch pass: the caller has declared this body immovable for
    // the duration, and "immovable" already has a vocabulary here - it is what
    // a `StaticBody2D` is, and `null` is how the solve is told so. See
    // `solveLengthHolding`.
    if (this.held !== null && this.held.has(body)) return null;
    if (body instanceof RigidBody2D) {
      // A PIVOT body cannot translate, and the solve is told so in its own
      // vocabulary: infinite mass. `1 / mass` reads 0, so the linear share of
      // every correction is zero by the same arithmetic that splits it for a
      // free body (the one indeterminate limit is guarded where the split is
      // taken - see `correctShapePositionAndRotation`). The velocity credit is
      // a no-op for the same reason: the axle never moves, so there is no
      // Δposition to be paid for, and a stray credit would be velocity on a
      // body whose position integration ignores it.
      if (body.pivot) {
        return {
          body,
          inertia: body.inertia,
          mass: Infinity,
          velocity: body.linearVelocity,
          addVelocity: () => {},
          addRotation: (r) => {
            body.angularVelocity += r;
          },
        };
      }
      // A SPRING body cannot rotate, and the solve is told so in the same
      // vocabulary the pivot uses for the freedom it lacks: infinite inertia.
      // `arm²/inertia` reads 0, so the angular share of every correction is
      // zero by the same arithmetic that splits it for a free body (the
      // indeterminate limit is written out where the split is taken - see
      // `correctShapePositionAndRotation`), and the whole correction lands in
      // translation, which is the axis the spring then recovers along. The
      // rotation credit is a no-op for the same reason the body never turns.
      if (body.spring) {
        return {
          body,
          inertia: Infinity,
          mass: body.mass,
          velocity: body.linearVelocity,
          addVelocity: (v) => {
            body.linearVelocity = body.linearVelocity.add(v);
          },
          addRotation: () => {},
        };
      }
      // The LINK a ring on a vine stands on is told the same: the ring's
      // centre is offset from the link's along the cord, which is a lever,
      // and a link's spin means nothing (every constraint on it acts at its
      // centre), so the pull moves it by translation alone rather than
      // spinning a light body whose spin would carry the ring's contact round
      // with it (see `lib/vineClamp.ts`).
      if (this.end_ instanceof RopeVineClamp && body === this.end_.contact.obj) {
        return {
          body,
          inertia: Infinity,
          mass: body.mass,
          velocity: body.linearVelocity,
          addVelocity: (v) => {
            body.linearVelocity = body.linearVelocity.add(v);
          },
          addRotation: () => {},
        };
      }
      return {
        body,
        inertia: body.inertia,
        mass: body.mass,
        velocity: body.linearVelocity,
        addVelocity: (v) => {
          body.linearVelocity = body.linearVelocity.add(v);
        },
        addRotation: (r) => {
          body.angularVelocity += r;
        },
      };
    }
    if (body instanceof Player) {
      return {
        body,
        inertia: body.inertia,
        mass: body.mass,
        velocity: body.velocity,
        addVelocity: (v) => {
          body.velocity = body.velocity.add(v);
        },
        addRotation: (r) => {
          body.globalRotation += r;
        },
      };
    }
    return null;
  }

  private correctShapePositionAndRotation(relaxationFactor = 1): number | null {
    let currentLength = this.calculateRopePathLength();
    if (currentLength <= this.constraintLength) return null;

    // A clamped end slides before the bodies are moved, and may leave the
    // chain SLACK: a ring released from the static cone runs to the kinetic
    // cone's edge, which can be nearer the ball than a span's length, and the
    // ball then flies until the chain comes taut again. That is a correction
    // in the sense the iteration loop's guard reads it - the path got shorter
    // - so it is reported as one, with nothing else to split.
    // An embedded end creeps through its viscous face before the bodies are
    // moved, on the same terms (`slipEmbeddedEnd`): the creep is the mud
    // yielding, which is a correction, and it may take the whole error.
    // A ring on a vine creeps along the vine on the same terms again
    // (`slipVineClampedEnd`).
    if (this.slideClampedEnd() !== 0 || this.slipEmbeddedEnd() !== 0 || this.slipVineClampedEnd() !== 0) {
      currentLength = this.calculateRopePathLength();
      if (currentLength <= this.constraintLength) return 0;
    }

    const pathObjects = this.generatePathObjects();
    const lengthError = currentLength - this.constraintLength;
    const totalEffectiveInverseInertia = this.effectiveInverseInertia(pathObjects);
    const dynamicPathObjects = pathObjects.filter(
      (segment) => this.getDynamicBodyState(segment.body) !== null,
    );

    if (totalEffectiveInverseInertia < 1e-6) return 0;
    const scaledCorrectionImpulse = (lengthError * relaxationFactor) / totalEffectiveInverseInertia;
    if (PhaseTrace.enabled) this.solveTerms = [];

    for (const pathObject of dynamicPathObjects) {
      const dynamicBody = this.getDynamicBodyState(pathObject.body);
      if (!dynamicBody) continue;
      const correctionDir = pathObject.resolveCorrectionDir();
      if (correctionDir.lengthSquared() < 0.0001) continue;
      const mechanicalAdvantage = pathObject.calculateMechanicalAdvantage();
      if (mechanicalAdvantage < 1e-6) continue;
      const torqueArm = this.calculateTorqueArm(pathObject);
      const inverseEffectiveMass =
        1 / dynamicBody.mass + (torqueArm * torqueArm) / dynamicBody.inertia;
      const totalCorrectionMagnitude =
        scaledCorrectionImpulse * mechanicalAdvantage * inverseEffectiveMass;
      if (PhaseTrace.enabled) {
        this.solveTerms.push({
          id: pathObject.body.buildIndex,
          ma: mechanicalAdvantage,
          arm: torqueArm,
          invMass: 1 / dynamicBody.mass,
          invInertiaArm: (torqueArm * torqueArm) / dynamicBody.inertia,
          dirX: correctionDir.x,
          dirY: correctionDir.y,
        });
      }

      const torqueSquared = torqueArm * torqueArm;
      if (torqueSquared > 0) {
        const denominator = dynamicBody.inertia + dynamicBody.mass * torqueSquared;
        // Both indeterminate limits are written out rather than evaluated: each
        // is Inf/Inf = NaN taken literally.
        //
        // Infinite MASS is the pivot: the whole correction lands in rotation,
        // where mass·arm / (I + mass·arm²) tends to 1/arm, so arm·Δθ is exactly
        // the length the solve asked this body to remove.
        //
        // Infinite INERTIA is the spring body, whose rotation is locked: the
        // whole correction lands in translation instead, `linearFactor` tending
        // to 1 and the angular share to 0.
        const linearFactor = Number.isFinite(dynamicBody.inertia)
          ? dynamicBody.inertia / denominator
          : 1;
        const angularFactor = !Number.isFinite(dynamicBody.inertia)
          ? 0
          : Number.isFinite(dynamicBody.mass)
            ? (dynamicBody.mass * torqueArm) / denominator
            : 1 / torqueArm;
        this.applyCorrectionMotion(
          dynamicBody.body,
          this.boundToNode(pathObject, correctionDir.mul(totalCorrectionMagnitude * linearFactor)),
        );
        dynamicBody.body.globalRotation += totalCorrectionMagnitude * angularFactor;
      } else {
        this.applyCorrectionMotion(
          dynamicBody.body,
          this.boundToNode(pathObject, correctionDir.mul(totalCorrectionMagnitude)),
        );
      }
    }
    return scaledCorrectionImpulse;
  }

  // A continuous rope's far end may be drawn up to the node it is being pulled
  // towards and no further: past it the pull is through the corner the rope
  // is bent around, and the step only lands the end on the far side of a node
  // it should have rounded (see `roundEndNode`). A step that reaches the node
  // is noted for the iteration loop to round it.
  private boundToNode(pathObject: PathObject, motion: Vec2): Vec2 {
    if (!this.continuous || !(pathObject instanceof PathEnd) || pathObject.selfWrap) return motion;
    const reach = pathObject.previous.length();
    if (motion.length() < reach) return motion;
    this.endReachedNode = true;
    return pathObject.directionToPrevious.mul(reach);
  }

  // Positional corrections on the player go through the collision system so
  // the rope cannot drag the body through scene geometry: moveAndCollide
  // stops at contact and the remainder slides along the surface. (The C#
  // original wrote the transform directly and relied on Godot's MoveAndSlide
  // recovery next frame, which this engine does not replicate.) Other bodies
  // keep the direct write — rigid circles are depenetrated by the world.
  private applyCorrectionMotion(body: PhysicsBody2D, motion: Vec2): void {
    if (!(body instanceof Player)) {
      body.globalPosition = body.globalPosition.add(motion);
      return;
    }
    let remaining = motion;
    for (let i = 0; i < 3; i++) {
      const collision = body.moveAndCollide(remaining);
      if (!collision) return;
      remaining = collision.getRemainder().slide(collision.getNormal());
    }
  }

  private genDistanceToStartLookup(): Map<RopeNode, number> {
    const lookup = new Map<RopeNode, number>();
    lookup.set(this.start, 0);
    let prev: RopeNode = this.start;
    let cumulativeLength = 0;
    for (const node of this.path()) {
      if (node instanceof RopeWrap) {
        // Arc, not chord, for a coil step — the same measure the length solve
        // uses, so friction distances stay consistent with it.
        cumulativeLength += this.spanLength(prev, node);
        lookup.set(node, cumulativeLength);
        prev = node;
      }
    }
    return lookup;
  }
}
