// Rope — the wrap-point rope model + PBD length/friction solver, ported from
// classes/Rope.cs. Models the rope as a sequence of wrap points around scene
// geometry rather than evenly spaced segments.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { Mathf } from "../engine/mathf";
import {
  CollisionObject2D,
  CollisionShape2D,
  currentTransformEpoch,
  PhysicsBody2D,
  RigidBody2D,
} from "../engine/body";
import { isExposedCorner } from "../engine/shapes";
import { GRAVITY } from "../engine/world";
import { Colors } from "../engine/debug";
import { Segment } from "../lib/segment";
import { Intersections, type Intersection } from "../lib/intersections";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { RopeGeneration } from "../lib/ropeGeneration";
import { cullDetachedNodes } from "../lib/nodeDetachment";
import { Calc } from "../lib/calc";
import {
  RopeAttachment,
  RopeContact,
  RopeNode,
  RopeWrap,
} from "../lib/ropeContact";
import { GenerationDirection, IntersectionStatus, WrapDirection } from "../lib/types";
import { PathEnd, PathObject, PathStart, PathWrap } from "../lib/pathObject";
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
  const out: WrapCandidate[] = [];
  for (const body of bodies) {
    if (isPassThrough(body)) continue;
    body.getShapes().forEach((shape, shapeIndex) => {
      if (shape.wrappable) out.push({ body, shape, shapeIndex });
    });
  }
  return out;
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
function isSeamVertex(shape: CollisionShape2D, vertexIndex: number): boolean {
  return shape.owner.getShapes().length > 1 && !shape.isVertexExposed(vertexIndex);
}

export class RopePath {
  constructor(
    public from: RopeNode,
    public to: RopeNode,
    public span: Segment,
  ) {}
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
  // Minimum distance a rect corner must deflect the rope path before it
  // becomes a wrap node (see the grazing-contact gate in regeneratePath).
  private static readonly MIN_WRAP_DEFLECTION = 0.005;
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

  private markPathChanged(): void {
    this.spanCache = null;
    this.pathObjectCache = null;
  }

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
    if (!caught) this.wraps = [];
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
  lengthPerRadian(body: PhysicsBody2D): number {
    const centre = body.globalPosition;
    let rate = 0;
    for (const span of this.regenerateSpans()) {
      const fromOnBody = span.from.contact.obj === body;
      const toOnBody = span.to.contact.obj === body;
      if (fromOnBody === toOnBody) continue;
      const moving = fromOnBody ? span.span.start : span.span.end;
      const fixed = fromOnBody ? span.span.end : span.span.start;
      if (moving.distanceSquaredTo(fixed) < PX * PX * 1e-4) continue;
      const lever = moving.sub(centre);
      // d(v.rotated(θ))/dθ at the current θ is (-v.y, v.x).
      rate -= moving.directionTo(fixed).dot(new Vec2(-lever.y, lever.x));
    }
    return rate;
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
    let bestRotation = startRotation;
    let bestExcess = this.calculateRopePathLength() - this.constraintLength - forgive;

    for (let i = 0; i < Rope.UNWIND_ITERATIONS && bestExcess > 0; i++) {
      body.globalRotation = bestRotation;
      const rate = this.lengthPerRadian(body);
      if (Math.abs(rate) < Rope.MIN_SPOOL_RATE) break;
      let step = -bestExcess / rate;
      let improved = false;
      for (let t = 0; t < Rope.UNWIND_BACKTRACKS; t++, step *= 0.5) {
        const candidate = Mathf.clamp(bestRotation + step, lowRotation, highRotation);
        if (candidate === bestRotation) break;
        body.globalRotation = candidate;
        const excess = this.calculateRopePathLength() - this.constraintLength - forgive;
        if (excess < bestExcess) {
          bestRotation = candidate;
          bestExcess = excess;
          improved = true;
          break;
        }
      }
      if (!improved) break;
    }

    body.globalRotation = bestRotation;
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
  absorbBlockedLength(): void {
    const settledLength = this.calculateRopePathLength();
    const blocked = Mathf.max(settledLength - this.maxRopeLength, 0);
    const granted =
      this.geometryPushAccum === null
        ? blocked
        : Mathf.min(blocked, this.leaseAtFrameStart + this.geometryPushAccum);
    this.stalledLength += Mathf.max(
      granted - Mathf.max(this.blockedSlack, this.leaseAtFrameStart),
      0,
    );
    this.blockedSlack = Mathf.max(this.blockedSlack, granted);
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

  private resolveSelfIntersectionAtStart(fromNode: RopeNode, span: Segment): RopeNode | null {
    const obj = fromNode.contact.obj;
    if (obj instanceof Player && fromNode === this.start) return null;
    if (obj instanceof Hook && fromNode === this.start) return null;
    if (isPassThrough(obj)) return null;

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
      if (tangentPoint.distanceTo(span.start) > 5 * PX) {
        return new RopeWrap(
          new RopeContact(obj, tangentPoint.sub(obj.globalPosition), shapeIndex),
          wrapDir,
        );
      }
    } else if (fromShape.shape.kind !== "circle") {
      // Angles are measured about this SHAPE's centre, not the body's: on a
      // compound body they differ, and the walk has to be about the piece the
      // rope is resting on. Identical for the centred single-shape case.
      const rectCenter = fromShape.globalPosition;
      const corners = ShapeGeometry.getGlobalCorners(fromShape);
      const n = corners.length;
      let nextVertexIndex = 0;
      let minAngle = Infinity;
      for (let i = 0; i < n; i++) {
        const vertex = corners[i]!;
        if (vertex.distanceSquaredTo(fromNode.contact.globalPosition) < 0.01 * PX * PX) {
          // Already sitting on this vertex: step one place round the loop in the
          // wrap direction. The step is one *vertex*, not a fixed quarter turn,
          // which is what makes it right for a loop of any length.
          nextVertexIndex = Calc.mod(i + (wrapDir as number), n);
          break;
        }
        const angleToVertex = Calc.absoluteAngle(
          rectCenter.directionTo(fromNode.contact.globalPosition),
          rectCenter.directionTo(vertex),
          wrapDir,
        );
        if (angleToVertex < minAngle) {
          minAngle = angleToVertex;
          nextVertexIndex = i;
        }
      }
      const nextVertex = corners[nextVertexIndex]!;
      if (Intersections.intersectsPoint(fromShape, span.end) === IntersectionStatus.Separate) {
        return new RopeWrap(
          new RopeContact(obj, nextVertex.sub(obj.globalPosition), shapeIndex),
          wrapDir,
        );
      }
    }
    return null;
  }

  private resolveSelfIntersectionAtEnd(toNode: RopeNode, span: Segment): RopeNode | null {
    const obj = toNode.contact.obj;
    if (obj instanceof Hook && toNode === this.end) return null;
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
      const rectCenter = toShape.globalPosition;
      const corners = ShapeGeometry.getGlobalCorners(toShape);
      const n = corners.length;
      let nextVertexIndex = 0;
      let minAngle = Infinity;
      for (let i = 0; i < n; i++) {
        const vertex = corners[i]!;
        if (vertex.distanceSquaredTo(toNode.contact.globalPosition) < 0.01 * PX * PX) {
          nextVertexIndex = Calc.mod(i - (wrapDir as number), n);
          break;
        }
        const angleToVertex = Calc.absoluteAngle(
          rectCenter.directionTo(vertex),
          rectCenter.directionTo(toNode.contact.globalPosition),
          wrapDir,
        );
        if (angleToVertex < minAngle) {
          minAngle = angleToVertex;
          nextVertexIndex = i;
        }
      }
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

      const startIntersection = this.resolveSelfIntersectionAtStart(span.from, span.span);
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

      const colliders = scan.filter(({ shape }) => {
        // The span's own endpoints are excluded by SHAPE, not by body. A span
        // ending on a shape always reports overlap against it, and wrapping the
        // thing you are tied to is the self-intersection resolvers' job, not
        // this scan's - but a *sibling* piece of that same body is ordinary
        // scenery in the span's way. Excluding the whole body made a compound
        // wall stop existing for every span touching any of it: once the chain
        // wrapped the rotated slab, the vertical post it then cut straight
        // through was invisible, because the post and the slab happen to be one
        // body (`session-358f`).
        if (shape === span.from.contact.shape || shape === span.to.contact.shape) return false;
        if (
          this.isPointOutsideBoundingStrip(shape.globalPosition, span.span) &&
          (Intersections.intersectsPoint(shape, span.span.start) === IntersectionStatus.Overlap ||
            Intersections.intersectsPoint(shape, span.span.end) === IntersectionStatus.Overlap)
        ) {
          return false;
        }
        return Intersections.intersectsSegment(shape, span.span) === IntersectionStatus.Overlap;
      });

      colliders.sort(
        (a, b) =>
          span.span.getClosestPointOnLine(a.shape.globalPosition).distanceTo(span.span.start) -
          span.span.getClosestPointOnLine(b.shape.globalPosition).distanceTo(span.span.start),
      );

      for (const { body, shape: bodyShape, shapeIndex } of colliders) {
        const wrapDir = span.span.calculateWrapDirection(bodyShape.globalPosition);

        if (bodyShape.shape.kind === "circle") {
          let tangentPoint: Vec2;
          const { entry, exit } = Intersections.getIntersectionsShapeSegment(bodyShape, span.span);
          if (entry && !exit) tangentPoint = entry.point;
          else if (!entry && exit) tangentPoint = exit.point;
          else if (entry && exit) {
            tangentPoint = RopeGeneration.calculateCircleTangentPoint(
              bodyShape,
              wrapDir,
              span.span.start,
              GenerationDirection.Forward,
            );
          } else continue;

          if (tangentPoint.distanceTo(span.span.start) > 5 * PX) {
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
          if ((entry && !exit) || (!entry && exit) || (!entry && !exit)) {
            let maxVertexAngle = 0;
            for (let i = 0; i < corners.length; i++) {
              const vertex = corners[i]!;
              if (
                this.isPointOutsideBoundingStrip(vertex, span.span) ||
                span.span.calculateWrapDirection(vertex) === wrapDir
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
            // Grazing-contact gate: a corner this close to the span line
            // bends the rope sub-visibly and adds no physical constraint,
            // but renders as a phantom snag and flip-flops as the contact
            // crosses the line on moving bodies (destabilising detachment).
            // Only a corner that actually deflects the rope becomes a wrap.
            span.span
              .getClosestPointOnLine(corners[vertexIndex]!)
              .distanceTo(corners[vertexIndex]!) > Rope.MIN_WRAP_DEFLECTION &&
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
    this.wraps = cullDetachedNodes(this.start, this.end, this.wraps);
    this.syncCoil();
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
    // No tangent exists to a point inside the circle — a degenerate frame, and
    // not one to re-derive an angle from. Leave the coil as it stands.
    if (radius <= 0 || exitTowards.distanceTo(centre) <= radius) return;

    const tangentPoint = RopeGeneration.calculateCircleTangentPoint(
      shape,
      wrapDir,
      exitTowards,
      GenerationDirection.Reversed,
    );
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

  private calculateRopePathLength(): number {
    let cumulativeLength = 0;
    for (const span of this.regenerateSpans()) {
      cumulativeLength += this.spanLength(span.from, span.to);
    }
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
      const correctionImpulse = this.correctShapePositionAndRotation(relaxation);
      if (correctionImpulse === null) {
        if (iteration === 0) return null;
        break;
      }
      const after = this.calculateRopePathLength() - this.constraintLength;
      const undone = after > error;
      // One record per iteration, before the guard acts on it: what the
      // iteration was handed, what it left, whether it stood, and the per-body
      // terms that decided where the correction went. A diverging solve is ten
      // of these with the error climbing and `dirX` alternating (`session-239f`
      // f192), and it was visible only through a temporary print until now.
      PhaseTrace.solve(iteration, error, after, undone, this.solveTerms);
      if (undone) {
        this.restorePathBodies(before);
        relaxation *= 0.5;
        if (relaxation < Rope.MIN_RELAXATION) break;
        continue;
      }
      error = after;
      cumulativeCorrectionImpulse += correctionImpulse;
    }
    return cumulativeCorrectionImpulse;
  }

  // Smallest share of a correction step worth trying before the solve gives
  // the frame up: six halvings, a sixty-fourth of the error.
  private static readonly MIN_RELAXATION = 1 / 64;

  private snapshotPathBodies(): { body: PhysicsBody2D; position: Vec2; rotation: number }[] {
    const out: { body: PhysicsBody2D; position: Vec2; rotation: number }[] = [];
    for (const node of this.path()) {
      const body = node.contact.obj;
      if (!(body instanceof PhysicsBody2D) || out.some((o) => o.body === body)) continue;
      out.push({ body, position: body.globalPosition, rotation: body.globalRotation });
    }
    return out;
  }

  private restorePathBodies(
    snapshot: readonly { body: PhysicsBody2D; position: Vec2; rotation: number }[],
  ): void {
    for (const s of snapshot) {
      s.body.globalPosition = s.position;
      s.body.globalRotation = s.rotation;
    }
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
    const currentLength = this.calculateRopePathLength();
    if (currentLength <= this.constraintLength) return null;

    const pathObjects = this.generatePathObjects();
    const lengthError = currentLength - this.constraintLength;
    let totalEffectiveInverseInertia = 0;
    const dynamicPathObjects: PathObject[] = [];

    for (const segment of pathObjects) {
      const dynamicBody = this.getDynamicBodyState(segment.body);
      if (dynamicBody) {
        dynamicPathObjects.push(segment);
        const mechanicalAdvantage = segment.calculateMechanicalAdvantage();
        const torqueArm = this.calculateTorqueArm(segment);
        const inverseEffectiveMass =
          1 / dynamicBody.mass + (torqueArm * torqueArm) / dynamicBody.inertia;
        totalEffectiveInverseInertia +=
          mechanicalAdvantage * mechanicalAdvantage * inverseEffectiveMass;
      }
    }

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
          correctionDir.mul(totalCorrectionMagnitude * linearFactor),
        );
        dynamicBody.body.globalRotation += totalCorrectionMagnitude * angularFactor;
      } else {
        this.applyCorrectionMotion(
          dynamicBody.body,
          correctionDir.mul(totalCorrectionMagnitude),
        );
      }
    }
    return scaledCorrectionImpulse;
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
