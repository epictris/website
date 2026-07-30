// Rope — the wrap-point rope model + PBD length/friction solver, ported from
// classes/Rope.cs. Models the rope as a sequence of wrap points around scene
// geometry rather than evenly spaced segments.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { Mathf } from "../engine/mathf";
import { CollisionObject2D, CollisionShape2D, PhysicsBody2D, RigidBody2D } from "../engine/body";
import { circleOverlap } from "../engine/collision";
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

// Pass-through geometry (a hook-only `AnchorBody`): the rope may be *pinned* to
// it — that is what the hook is for — but it may never bend around it. Every
// wrap-generating path filters on this, so the invariant lives with the solver
// rather than depending on the caller handing it a pre-filtered body list.
function isPassThrough(obj: CollisionObject2D): boolean {
  return obj instanceof PhysicsBody2D && !obj.isSolid;
}

// A candidate the rope may wrap: one convex shape of one body. Compound bodies
// are the reason this is not simply the body — a body made of several convex
// pieces catches on whichever piece the span crosses, and the tangent walk needs
// that piece's own vertex loop and centre.
interface WrapCandidate {
  body: PhysicsBody2D;
  shape: CollisionShape2D;
  shapeIndex: number;
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
const SEAM_EPSILON = 0.005;
function isSeamVertex(body: PhysicsBody2D, shapeIndex: number, vertex: Vec2): boolean {
  const shapes = body.getShapes();
  if (shapes.length < 2) return false;
  for (let i = 0; i < shapes.length; i++) {
    if (i === shapeIndex) continue;
    if (circleOverlap(vertex, SEAM_EPSILON, shapes[i]!)) return true;
  }
  return false;
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
  private static readonly SLACK_RELEASE_RATE = 0.5;

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
  private slackReleasedThisFrame = false;
  frictionCoefficient = 0.4;

  start: RopeAttachment;
  end: RopeAttachment;
  wraps: RopeWrap[];

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

  retract(amount = PX): void {
    // The rope may never be retracted to a negative length.
    this.maxRopeLength = Mathf.max(this.maxRopeLength - amount, 0);
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

  // Zero the per-frame accounting. Callers that touch the rope more than once a
  // frame (the ball controller syncs, solves, unwinds and re-bases) call this at
  // the top of their frame; `physicsStep` does it for callers that do not.
  beginFrame(): void {
    this.stalledLength = 0;
    this.topologyJump = 0;
    this.slackReleasedThisFrame = false;
    this.frameBegun = true;
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
  unwindOverLength(body: PhysicsBody2D, rotationAtFrameStart: number, delta: number): void {
    const startRotation = body.globalRotation;
    const lowRotation = Mathf.min(startRotation, rotationAtFrameStart);
    const highRotation = Mathf.max(startRotation, rotationAtFrameStart);
    let bestRotation = startRotation;
    let bestExcess = this.calculateRopePathLength() - this.constraintLength;

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
        const excess = this.calculateRopePathLength() - this.constraintLength;
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

  physicsStep(bodies: PhysicsBody2D[], delta: number): void {
    if (!this.frameBegun) this.beginFrame();
    this.frameBegun = false;
    this.regenerateAndMeasure(bodies);
    const lengthError = this.calculateRopePathLength() - this.constraintLength;
    this.topologyCreditScale =
      lengthError > 0 ? 1 - Mathf.clamp(this.topologyJump / lengthError, 0, 1) : 1;

    const prePositions = new Map<PhysicsBody2D, Vec2>();
    const preRotations = new Map<PhysicsBody2D, number>();
    for (const b of bodies) {
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
        this.maxRopeLength = this.calculateRopePathLength();
        endObj.world?.remove(endObj);
      }
    }

    const correctionImpulse = this.resolveLengthConstraint();
    if (correctionImpulse !== null) {
      // Friction impulse may push the rope past its max length; re-solve.
      this.resolveLengthConstraint();

      for (const body of bodies) {
        const dynamicBody = this.getDynamicBodyState(body);
        if (dynamicBody) {
          // Scaled by `topologyCreditScale`: the share of this frame's length
          // error that a wrap appearing or vanishing put there is corrected in
          // position but earns no velocity.
          dynamicBody.addVelocity(
            body.globalPosition
              .sub(prePositions.get(body)!)
              .div(delta)
              .mul(this.topologyCreditScale),
          );
          dynamicBody.addRotation(
            ((body.globalRotation - preRotations.get(body)!) / delta) * this.topologyCreditScale,
          );
          // (Godot pushed the mutated transform back into the physics server here;
          // in this engine the body transform is already authoritative.)
        }
      }
    }

    this.absorbBlockedLength(delta);
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
  // Released once per frame however many times the frame stalls; `beginFrame`
  // opens the next one.
  absorbBlockedLength(delta: number): void {
    const settledLength = this.calculateRopePathLength();
    const blocked = Mathf.max(settledLength - this.maxRopeLength, 0);
    this.stalledLength += Mathf.max(blocked - this.blockedSlack, 0);
    const released = this.slackReleasedThisFrame
      ? this.blockedSlack
      : this.blockedSlack - Rope.SLACK_RELEASE_RATE * delta;
    this.blockedSlack = Mathf.max(Mathf.max(blocked, released), 0);
    this.slackReleasedThisFrame = true;
  }

  private regenerateSpans(): RopePath[] {
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
      span.from.contact.obj === span.to.contact.obj ||
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
    this.resolveNodeSelfIntersections();
    const newNodes: RopeWrap[] = [];

    for (const span of this.regenerateSpans()) {
      if (span.from instanceof RopeWrap) newNodes.push(span.from);
      if (this.shouldIgnorePathCollisions(span)) continue;

      // Candidates are SHAPES, not bodies: a compound body is several convex
      // pieces sharing a transform, and the rope catches on whichever piece the
      // span actually crosses. A single-shape body contributes exactly one
      // candidate, so this is the same scan it always was for scene geometry.
      const colliders: WrapCandidate[] = [];
      for (const body of bodies) {
        if (body === span.from.contact.obj || body === span.to.contact.obj) continue;
        if (isPassThrough(body)) continue;
        body.getShapes().forEach((shape, shapeIndex) => {
          if (!shape.wrappable) return;
          if (
            this.isPointOutsideBoundingStrip(shape.globalPosition, span.span) &&
            (Intersections.intersectsPoint(shape, span.span.start) === IntersectionStatus.Overlap ||
              Intersections.intersectsPoint(shape, span.span.end) === IntersectionStatus.Overlap)
          ) {
            return;
          }
          if (Intersections.intersectsSegment(shape, span.span) === IntersectionStatus.Overlap) {
            colliders.push({ body, shape, shapeIndex });
          }
        });
      }

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
            vertexIndex = RopeGeneration.calculateRectangleTangentIndex(
              bodyShape,
              wrapDir,
              span.span.start,
              GenerationDirection.Forward,
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
            !isSeamVertex(body, shapeIndex, corners[vertexIndex]!)
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
        if (
          nodeA.contact.obj !== nodeB.contact.obj ||
          shape.shape.kind !== "circle" ||
          nodeB === this.end
        ) {
          const nextSegment = new Segment(
            nodeA.contact.globalPosition,
            nodeB.contact.globalPosition,
          );
          pathWraps.push(
            new PathWrap(prevSegment, nextSegment, nodeA.contact.obj as PhysicsBody2D, nodeA.wrapDir),
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
    return [start, ...pathWraps, end];
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

  private resolveLengthConstraint(): number | null {
    let cumulativeCorrectionImpulse = 0;
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      const correctionImpulse = this.correctShapePositionAndRotation();
      if (correctionImpulse !== null) {
        cumulativeCorrectionImpulse += correctionImpulse;
      } else if (iteration === 0) {
        return null;
      } else {
        break;
      }
    }
    return cumulativeCorrectionImpulse;
  }

  // Perpendicular lever from the body's centre of rotation to the correction force.
  private calculateTorqueArm(segment: PathObject): number {
    const correctionDir = segment.resolveCorrectionDir();

    if (segment instanceof PathStart) {
      if (segment.body instanceof Player) return 0;
      const shape = segment.body.getShape();
      const leverArm = segment.selfWrap
        ? segment.selfWrap.next.start.sub(shape.globalPosition)
        : segment.next.start.sub(shape.globalPosition);
      return leverArm.cross(correctionDir);
    }
    if (segment instanceof PathEnd) {
      const shape = segment.body.getShape();
      const leverArm = segment.selfWrap
        ? segment.selfWrap.previous.end.sub(shape.globalPosition)
        : segment.previous.end.sub(shape.globalPosition);
      return leverArm.cross(correctionDir);
    }
    if (segment instanceof PathWrap && segment.body.getShape().shape.kind !== "circle") {
      const leverArm = segment.wrapStartPosition.sub(segment.body.globalPosition);
      const torqueFromStart = leverArm.cross(segment.directionToPrevious);
      const torqueFromEnd = leverArm.cross(segment.directionToNext);
      return (torqueFromStart + torqueFromEnd) / segment.calculateMechanicalAdvantage();
    }
    // Wrapped circle: force passes through the centre.
    return 0;
  }

  private getDynamicBodyState(body: PhysicsBody2D): DynamicBody | null {
    if (body instanceof RigidBody2D) {
      return {
        body,
        inertia: body.inertia,
        mass: body.mass,
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

  private correctShapePositionAndRotation(): number | null {
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

    const relaxationFactor = 1;
    if (totalEffectiveInverseInertia < 1e-6) return 0;
    const scaledCorrectionImpulse = (lengthError * relaxationFactor) / totalEffectiveInverseInertia;

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

      const torqueSquared = torqueArm * torqueArm;
      if (torqueSquared > 0) {
        const denominator = dynamicBody.inertia + dynamicBody.mass * torqueSquared;
        const linearFactor = dynamicBody.inertia / denominator;
        const angularFactor = (dynamicBody.mass * torqueArm) / denominator;
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
