// Physics world / space-state substitute. Owns the body list, answers the
// space queries the game issues (IntersectRay, IntersectShape, moveAndCollide)
// and integrates dynamic bodies. Semantics approximate Godot's 2D physics
// closely enough for the character controller and rope; it is self-consistent
// (deterministic replay), not bit-compatible with Godot.

import { Vec2 } from "./vec2";
import { circleShape } from "./shapes";
import type { ShapeTransform } from "./shapes";
import {
  Area2D,
  CharacterBody2D,
  CollisionObject2D,
  ForceArea,
  KinematicCollision2D,
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
} from "./body";
import {
  circleOverlap,
  outwardDirection,
  rayVsShape,
  shapeRadius,
  sweepCircle,
} from "./collision";
import { shapeContacts } from "./manifold";
import { PhysTrace } from "./physTrace";

// Trace helper: one record per moveAndCollide hit.
function traceContact(
  mode: "overlap" | "sweep",
  body: CharacterBody2D,
  collider: PhysicsBody2D,
  normal: Vec2,
  position: Vec2,
  testOnly: boolean,
): void {
  if (!PhysTrace.enabled) return;
  PhysTrace.emit({
    t: "contact",
    mode,
    body: body.name || body.constructor.name,
    hit: collider.name || collider.constructor.name,
    mobile: collider.isMobile,
    n: [Number(normal.x.toFixed(4)), Number(normal.y.toFixed(4))],
    ...(collider.isMobile
      ? {
          cvel: (({ x, y }) => [Number(x.toFixed(2)), Number(y.toFixed(2))])(
            collider.velocityAtPoint(position),
          ),
        }
      : {}),
    test: testOnly,
  });
}

// Gravity in m/s² — the ported Godot default (980 px/s² at 100 px/m) reads as
// real-world 9.8. dt is 1/60, so ≈0.00272 m/frame².
export const GRAVITY = new Vec2(0, 9.8);
// Contact skin: the sliver of penetration left after depenetration, in metres.
const SKIN = 0.0008;
// Scale on the impulse a pushing character imparts to a rigid circle.
const CHARACTER_PUSH_FACTOR = 0.5;
// Share of a rigid-vs-rigid contact each of the two bodies resolves. There is no
// pair solver here: each body meets the other again on its own pass, with no
// knowledge of what that pass will do, so each takes half and the contact
// converges over a couple of frames instead of both resolving it in full.
const RIGID_PAIR_SHARE = 0.5;
// Sweeps of the scene-wide positional recovery per physics step. Each sweep gives
// every rigid body one depenetration pass, so a pile settles together instead of
// whichever body the loop reached last winning its overlap outright.
const DEPENETRATION_PASSES = 3;

// Static friction only grabs a body moving slower than this (m/s) and spinning
// slower than this (rad/s); a faster body slides/rolls under kinetic friction
// until it slows into the grip. The spin gate also lets a steered ball roll:
// while the aim actively sweeps the ball (high ω) it rolls, and it only grips
// once the aim settles (ω → 0).
const STICK_SPEED = 0.3;
const STICK_SPIN = 0.5;
// Static-friction slip threshold (m/s): a steered contact grips (no-slip roll)
// only while the relative velocity between the ball's contact point and the
// surface stays below this. Rotate/move slowly and the contact sticks — precise
// placement; rotate or travel fast and the slip exceeds it, so the contact
// falls through to the slippery, Coulomb-capped kinetic friction instead.
const SLIP_STICK = 0.15;

export interface RayResult {
  collider: PhysicsBody2D;
  position: Vec2;
  normal: Vec2;
}

export interface RayOptions {
  collisionMask?: number;
  exclude?: CollisionObject2D[];
  hitFromInside?: boolean;
}

// Does the world resolve collisions against this body? The allowlist every
// collision path is written as (see AnchorBody, which is outside it by
// construction rather than by a special case per site).
function isSolidTarget(body: PhysicsBody2D): boolean {
  return body instanceof StaticBody2D || body instanceof RigidBody2D;
}

export class World {
  readonly bodies: PhysicsBody2D[] = [];
  readonly areas: Area2D[] = [];

  add(body: CollisionObject2D): void {
    body.world = this;
    body.removed = false;
    if (body instanceof Area2D) {
      if (!this.areas.includes(body)) this.areas.push(body);
    } else if (body instanceof PhysicsBody2D) {
      if (!this.bodies.includes(body)) this.bodies.push(body);
    }
  }

  // Snapshot every body's transform for render interpolation. Called at the top
  // of a level's physics step, before anything moves; render-only state, so it
  // cannot affect the simulation (see CollisionObject2D.captureRenderTransform).
  captureRenderTransforms(): void {
    for (const b of this.bodies) b.captureRenderTransform();
    for (const a of this.areas) a.captureRenderTransform();
  }

  remove(body: CollisionObject2D): void {
    body.removed = true;
    const i = this.bodies.indexOf(body as PhysicsBody2D);
    if (i >= 0) this.bodies.splice(i, 1);
    const j = this.areas.indexOf(body as Area2D);
    if (j >= 0) this.areas.splice(j, 1);
  }

  private matchesMask(body: PhysicsBody2D, mask: number | undefined): boolean {
    return mask === undefined || (body.collisionLayer & mask) !== 0;
  }

  // ---- CharacterBody2D.moveAndCollide -----------------------------------

  moveAndCollide(
    body: CharacterBody2D,
    motion: Vec2,
    testOnly: boolean,
  ): KinematicCollision2D | null {
    const shape = body.primaryShape().shape;
    if (shape.kind !== "circle") return null; // characters are circles here
    const r = shape.radius;
    const start = body.globalPosition;

    let overlapHit: { normal: Vec2; depth: number; collider: PhysicsBody2D } | null = null;
    let sweepHit: { t: number; normal: Vec2; collider: PhysicsBody2D } | null = null;

    for (const target of this.bodies) {
      if (target === body || target.removed) continue;
      if (!(target instanceof StaticBody2D || target instanceof RigidBody2D)) continue;
      if (body.exceptions.has(target.id)) continue;
      if (!target.hasShape()) continue;
      // Every shape the target carries. A compound body (a concave form built
      // from convex pieces) blocks with all of them; a single-shape body is the
      // one-iteration case this has always been.
      for (const ts of target.getShapes()) {
        const ov = circleOverlap(start, r, ts);
        if (ov && ov.depth > SKIN) {
          if (!overlapHit || ov.depth > overlapHit.depth) {
            overlapHit = { normal: ov.normal, depth: ov.depth, collider: target };
          }
          continue;
        }

        const sweep = sweepCircle(start, motion, r, ts);
        if (sweep) {
          // Phantom-contact guards for grazing sweeps that start within the
          // skin of a thin shape (a rotating blade): the reported normal can
          // belong to the far face — "hit from inside" — which misclassifies
          // the surface and resets the player's state.
          // 1. A real contact opposes the motion.
          if (sweep.normal.dot(motion) > 1e-9) continue;
          // 2. The normal must agree with the side of the shape the sweep
          //    starts on.
          if (sweep.normal.dot(outwardDirection(start, ts)) < -1e-6) continue;
        }
        if (sweep && sweep.t <= 1 && (!sweepHit || sweep.t < sweepHit.t)) {
          sweepHit = { t: sweep.t, normal: sweep.normal, collider: target };
        }
      }
    }

    // Depenetration takes priority over a forward sweep. Recover against ALL
    // overlapping bodies, not just the deepest: pushing out of one body may
    // push into another (a mover advancing into a static wedge), and a
    // single-body pushout ping-pongs deeper into the pair every call —
    // whichever body the last pass handled wins, and the rope solver turns
    // the leftover displacement into velocity spikes. Godot's recovery
    // resolves the full shape set at once; mirror that with bounded passes.
    // Each pass gathers the two deepest overlaps at the recovered position:
    // one overlap is a plain pushout, two with converging normals (dot < 0)
    // are solved simultaneously — the translation d with d·n1 = depth1 and
    // d·n2 = depth2 escapes through the wedge mouth instead of oscillating.
    // A true crush (near-opposite normals) falls back to the deepest pushout
    // and leaves a residual at the cap.
    if (overlapHit) {
      let finalPos = start;
      for (let pass = 0; pass < 4; pass++) {
        // Gather the two deepest contacts INCLUDING within-skin ones: a full
        // pushout of one wedge face re-embeds the other, so scanning only for
        // depth > SKIN sees one face per pass and ping-pongs. The shallow
        // second face must join the solve before the first pushout runs.
        let a: { normal: Vec2; depth: number } | null = null;
        let b: { normal: Vec2; depth: number } | null = null;
        for (const target of this.bodies) {
          if (target === body || target.removed) continue;
          if (!(target instanceof StaticBody2D || target instanceof RigidBody2D)) continue;
          if (body.exceptions.has(target.id)) continue;
          if (!target.hasShape()) continue;
          for (const ts of target.getShapes()) {
            const ov = circleOverlap(finalPos, r, ts);
            if (!ov) continue;
            if (!a || ov.depth > a.depth) {
              b = a;
              a = { normal: ov.normal, depth: ov.depth };
            } else if (!b || ov.depth > b.depth) {
              b = { normal: ov.normal, depth: ov.depth };
            }
          }
        }
        if (!a || a.depth <= SKIN) break;
        const c = b ? a.normal.dot(b.normal) : 1;
        // Converging pair: translate so BOTH faces end flush (d·n1 = depth1,
        // d·n2 = depth2) — the exit through the wedge mouth. Guarded away
        // from a degenerate crush (denominator 1-c² explodes as c → -1),
        // which falls back to the deepest pushout and accepts a residual.
        if (b && c < 0 && c > -0.98) {
          const inv = 1 / (1 - c * c);
          const ka = (a.depth - c * b.depth) * inv;
          const kb = (b.depth - c * a.depth) * inv;
          finalPos = finalPos.add(a.normal.mul(ka)).add(b.normal.mul(kb));
        } else {
          finalPos = finalPos.add(a.normal.mul(a.depth));
        }
      }
      const travel = finalPos.sub(start);
      const position = finalPos.sub(overlapHit.normal.mul(r));
      traceContact("overlap", body, overlapHit.collider, overlapHit.normal, position, testOnly);
      if (!testOnly) {
        body.globalPosition = finalPos;
        this.applyCharacterPush(body, overlapHit.collider, overlapHit.normal, position);
      }
      return new KinematicCollision2D(
        overlapHit.normal,
        travel,
        motion,
        overlapHit.collider,
        position,
      );
    }

    if (!sweepHit) {
      if (!testOnly) body.globalPosition = start.add(motion);
      return null;
    }

    // Stop at contact, backing off by the skin so the body rests just clear.
    const contact = start.add(motion.mul(sweepHit.t));
    const finalPos = contact.add(sweepHit.normal.mul(SKIN));
    const travel = finalPos.sub(start);
    const remainder = motion.mul(1 - sweepHit.t);
    const position = contact.sub(sweepHit.normal.mul(r));
    traceContact("sweep", body, sweepHit.collider, sweepHit.normal, position, testOnly);
    if (!testOnly) {
      body.globalPosition = finalPos;
      this.applyCharacterPush(body, sweepHit.collider, sweepHit.normal, position);
    }
    return new KinematicCollision2D(
      sweepHit.normal,
      travel,
      remainder,
      sweepHit.collider,
      position,
    );
  }

  // Circles are the only physics-driven shape and "move when collided with by
  // the player" (game-design.md) — impart a modest mass-aware impulse.
  private applyCharacterPush(
    body: CharacterBody2D,
    collider: PhysicsBody2D,
    normal: Vec2,
    position: Vec2,
  ): void {
    if (!body.pushesRigidBodies || !(collider instanceof RigidBody2D)) return;
    const rel = body.velocity.sub(collider.velocityAtPoint(position));
    const vn = rel.dot(normal); // normal points toward the character
    if (vn >= 0) return;
    const mEff = (body.mass * collider.mass) / (body.mass + collider.mass);
    collider.applyImpulse(
      normal.mul(vn * mEff * CHARACTER_PUSH_FACTOR),
      position.sub(collider.globalPosition),
    );
  }

  // ---- space-state IntersectRay -----------------------------------------

  intersectRay(from: Vec2, to: Vec2, opts: RayOptions = {}): RayResult | null {
    const excludeIds = new Set((opts.exclude ?? []).map((b) => b.id));
    let best: RayResult | null = null;
    let bestT = Infinity;
    for (const body of this.bodies) {
      if (body.removed || excludeIds.has(body.id)) continue;
      if (!this.matchesMask(body, opts.collisionMask)) continue;
      if (!body.hasShape()) continue;
      for (const s of body.getShapes()) {
        const hit = rayVsShape(from, to, s, opts.hitFromInside ?? false);
        if (hit && hit.t < bestT) {
          bestT = hit.t;
          best = { collider: body, position: hit.position, normal: hit.normal };
        }
      }
    }
    return best;
  }

  // ---- space-state IntersectShape (circle overlap query) ----------------

  intersectCircle(center: Vec2, radius: number, maxResults = 64): PhysicsBody2D[] {
    const probe: ShapeTransform = {
      globalPosition: center,
      globalRotation: 0,
      shape: circleShape(radius),
    };
    const out: PhysicsBody2D[] = [];
    for (const body of this.bodies) {
      if (body.removed || !body.hasShape()) continue;
      // Overlap test: does the probe circle intersect the body's shape?
      if (body.getShapes().some((s) => shapesOverlap(probe, s))) {
        out.push(body);
        if (out.length >= maxResults) break;
      }
    }
    return out;
  }

  // ---- dynamic-body integration -----------------------------------------

  integrate(dt: number): void {
    this.applyAreaForces(dt);
    for (const body of this.bodies) {
      if (body instanceof RigidBody2D && !body.removed) {
        body.linearVelocity = body.linearVelocity.add(GRAVITY.mul(body.gravityScale * dt));
        body.globalPosition = body.globalPosition.add(body.linearVelocity.mul(dt));
        body.globalRotation += body.angularVelocity * dt;
      }
    }
    this.resolveDynamicCollisions(dt);
    this.notifyAreas();
  }

  // Constant-acceleration areas (a river current, wind). Runs before gravity
  // so a body entering the area is already carried on its first frame inside.
  // Both velocity-carrying body types are pushed — the grapple avatar and the
  // hook are CharacterBody2D, the ball, its hook and loose debris are
  // RigidBody2D — so a current moves everything that can move. A level with no
  // force areas touches nothing here, keeping recorded replays bit-identical.
  private applyAreaForces(dt: number): void {
    for (const area of this.areas) {
      if (!(area instanceof ForceArea) || area.removed || !area.hasShape()) continue;
      if (area.magnitude === 0) continue;
      const dv = area.acceleration.mul(dt);
      const ashape = area.primaryShape();
      for (const body of this.bodies) {
        if (body.removed || !body.hasShape()) continue;
        if (!body.getShapes().some((s) => shapesOverlap(ashape, s))) continue;
        if (body instanceof RigidBody2D) {
          body.linearVelocity = body.linearVelocity.add(dv);
        } else if (body instanceof CharacterBody2D) {
          // The character's state machine reads this velocity next frame; the
          // grounded basis discards the into-surface component, so a current
          // pushes along a floor rather than through it.
          body.velocity = body.velocity.add(dv);
        }
      }
    }
  }

  // Positional-only push-out of one rigidbody's shapes from the solid geometry
  // around it.
  // Velocity and rotation are untouched — this is not a contact solve but the
  // "geometry wins" pass a constraint solver that runs AFTER integrate needs.
  // Rope writes its positional correction straight onto a rigid body (only the
  // grapple avatar sweeps, see Rope.applyCorrectionMotion, which is written
  // assuming the world depenetrates everything else); the ball's chain solves
  // after World.integrate, so nothing else in its frame can undo a correction
  // that pulls the ball into a surface. Iterated so a body wedged in a corner
  // settles out of both faces rather than sliding along one into the other.
  //
  // "Solid" here is any body the world collides with — a StaticBody2D *or*
  // another RigidBody2D — and not only the statics it used to mean. The
  // narrower version was sufficient only while rects and polygons were never
  // physics-driven, so the sole thing a rope could haul the ball into was static
  // scenery. A rigid polygon's surface is exactly as solid, and the failure it
  // leaves is the one this guard exists to prevent, in the same words: a chain
  // anchored to one of its faces hauls the ball a little deeper every frame,
  // because the rope writes position last and wins. Left unguarded the ball
  // buried itself ~16 cm into a rigid polygon over ~20 frames, and when it
  // finally emerged the wrap path it should have been taking all along appeared
  // at full size in a single frame — half a metre of length error, which the
  // solver converted straight into a 96 m/s launch (session-1474f).
  //
  // Returns the outward normals it pushed along. A surface a body had to be
  // pushed out of is a surface that body is resting against, and a caller that
  // derives velocity from the frame's displacement (see BallLevel) needs that
  // set to refuse itself credit for driving into one.
  depenetrateRigid(body: RigidBody2D, iterations = 2): Vec2[] {
    const pushedOutOf: Vec2[] = [];
    if (body.removed || !body.hasShape()) return pushedOutOf;
    for (let pass = 0; pass < iterations; pass++) {
      const [a, b] = this.gatherDepenetration(body);
      if (!a) return pushedOutOf;
      // Resolve the two deepest overlaps *together* rather than one after the
      // other. Pushing fully out of one surface can push straight into another,
      // and a sequential pushout then ping-pongs deeper into the pair every pass
      // — whichever surface was handled last wins. `moveAndCollide` already
      // solves this for the character sweep, and this is the same solve: for a
      // converging pair, the translation d with d·n1 = depth1 and d·n2 = depth2
      // leaves both faces flush, escaping through the wedge mouth.
      //
      // A ball resting on the floor beneath a rigid polygon is exactly such a
      // wedge — floor pushing up, polygon pushing down — and resolved
      // sequentially it drove the ball ~10 cm into the floor over four frames,
      // the polygon's push landing last every time (session-284f).
      const c = b ? a.normal.dot(b.normal) : 1;
      if (b && c < 0 && c > -0.98) {
        const inv = 1 / (1 - c * c);
        body.globalPosition = body.globalPosition
          .add(a.normal.mul((a.depth - c * b.depth) * inv))
          .add(b.normal.mul((b.depth - c * a.depth) * inv));
        pushedOutOf.push(a.normal, b.normal);
      } else if (b && c <= -0.98) {
        // A true crush: two near-opposite faces, whose simultaneous solve has no
        // finite answer (the denominator explodes as c → -1). The two demands are
        // mutually exclusive, so the best available position is the one that
        // **equalises** them: moving along `a.normal` by half the difference
        // leaves both faces at the mean depth, and leaves a body already centred
        // between them exactly where it is.
        //
        // This used to resolve the deepest face in full and accept a residual,
        // which is the very thing the simultaneous solve above exists to prevent
        // - "pushing fully out of one surface can push straight into another, and
        // whichever was handled last wins" - reintroduced in the one branch where
        // both surfaces are certain to be real. And it is iterated, so the last
        // pass wins and the error compounds: a ball resting on the floor with a
        // falling slab on top of it was shoved 33 mm up out of the floor, which
        // buried it 47 mm in the slab, which shoved it 47 mm back down, net
        // deeper than it began. Every frame, until it was a quarter of a metre
        // inside the ground (session-326f).
        body.globalPosition = body.globalPosition.add(a.normal.mul((a.depth - b.depth) * 0.5));
        // Held by both, so both are surfaces this frame drove the body out of -
        // callers deriving velocity from the frame (see BallLevel) must refuse
        // themselves credit for driving into either.
        pushedOutOf.push(a.normal, b.normal);
      } else {
        // A single overlap: push out of it.
        body.globalPosition = body.globalPosition.add(a.normal.mul(a.depth));
        pushedOutOf.push(a.normal);
      }
    }
    return pushedOutOf;
  }

  // The two deepest overlaps of `body` against the solid geometry around it, at
  // its current position. Rotation never changes during a depenetration pass, so
  // each shape's offset from the body centre is fixed and the overlaps can simply
  // be re-gathered after every push.
  private gatherDepenetration(
    body: RigidBody2D,
  ): [{ normal: Vec2; depth: number } | null, { normal: Vec2; depth: number } | null] {
    let a: { normal: Vec2; depth: number } | null = null;
    let b: { normal: Vec2; depth: number } | null = null;
    const consider = (ov: { normal: Vec2; depth: number }): void => {
      if (!a || ov.depth > a.depth) {
        b = a;
        a = ov;
      } else if (!b || ov.depth > b.depth) {
        b = ov;
      }
    };
    for (const bshape of body.getShapes()) {
      for (const other of this.bodies) {
        if (other === body || other.removed || !other.hasShape()) continue;
        if (body.exceptions.has(other.id)) continue;
        if (!isSolidTarget(other)) continue;
        for (const oshape of other.getShapes()) {
          if (bshape.shape.kind === "circle") {
            const ov = circleOverlap(bshape.globalPosition, bshape.shape.radius, oshape);
            if (ov) consider(ov);
          } else {
            // A vertex shape contributes its manifold points, same as the
            // dynamic solver reads them.
            for (const ct of shapeContacts(bshape, oshape)) consider(ct);
          }
        }
      }
    }
    return [a, b];
  }

  private resolveDynamicCollisions(dt: number): void {
    for (const body of this.bodies) {
      if (!(body instanceof RigidBody2D) || body.removed || !body.hasShape()) continue;
      // Resolve every shape the body carries — a compound body (the ball &
      // chain avatar) adds an offset rim circle for its loop. The primary
      // circle is centred and keeps the historical resolution bit-for-bit;
      // offset circles additionally torque the body, and a rect or convex
      // polygon resolves through the manifold path below (a face contact, not a
      // point, so a box settles on a floor instead of teetering on one corner).
      let stuck = false;
      for (const bshape of body.getShapes()) {
        if (bshape.shape.kind !== "circle") {
          for (const other of this.bodies) {
            if (other === body || other.removed || !other.hasShape()) continue;
            if (body.exceptions.has(other.id)) continue;
            if (!(other instanceof StaticBody2D || other instanceof RigidBody2D)) continue;
            for (const oshape of other.getShapes()) {
              stuck = this.resolveRigidLoop(body, bshape, other, oshape, dt) || stuck;
            }
          }
          continue;
        }
        const r = bshape.shape.radius;
        // Local-frame offset from the body centre to this circle's centre. The
        // primary shape is centred, so this is exactly zero (position cancels)
        // and the resolution below reduces to the historical centred path.
        const offset = bshape.globalPosition.sub(body.globalPosition);
        for (const other of this.bodies) {
          if (other === body || other.removed || !other.hasShape()) continue;
          if (body.exceptions.has(other.id)) continue;
          if (!(other instanceof StaticBody2D || other instanceof RigidBody2D)) continue;
          // A compound target exposes each of its shapes (e.g. the ball's loop
          // blocks other dynamic bodies too).
          for (const oshape of other.getShapes()) {
            stuck = this.resolveRigidCircle(body, offset, r, other, oshape, dt) || stuck;
          }
        }
      }
      // Released (or never gripped) this frame: drop the anchor so it can move
      // freely and never snaps back to a stale spot after leaving the ground.
      if (!stuck) body.stickAnchor = null;
    }

    // Position is recovered for the whole scene AFTER every body's contacts have
    // been solved, and iterated over all of them together.
    //
    // The contact routines above push out per (shape, shape) pair, along that
    // pair's own deepest contact and in ignorance of the others. That is the
    // wedge failure `moveAndCollide` and `depenetrateRigid` were both fixed for,
    // in their own words: pushing fully out of one surface can push straight into
    // another, and whichever pair was handled last wins. The fix was never
    // applied here, so a body touching two things at once could not settle
    // against either. A slab leaning on another polygon with its lower end on the
    // floor is exactly that wedge, and it stood **165 mm** inside them, buzzing:
    // penetration that deep churns the contact set frame to frame, so the normal
    // impulse fired about one frame in five while contact friction went on
    // torquing the body every frame, and the slab's spin sawtoothed between -0.18
    // and +0.13 rad/s for as long as it slid (session-326f).
    //
    // Sweeping the whole scene rather than recovering each body at the end of its
    // own pass is what keeps the recovery fair. Depenetration is a race: whoever
    // moves last wins the overlap, so a body recovered inside another's contact
    // pass is answering a scene that is still half-solved, and a heavier or
    // simply later-listed neighbour walks straight through it. Interleaved into
    // the loop, a falling slab drove the ball a quarter of a metre into the
    // floor; swept afterwards, the two settle against each other.
    // A gripped body's `stickAnchor` rides along with whatever this recovery
    // moves it by.
    //
    // The anchor is a *positional* constraint - it is where the surface had hold,
    // and the grip pins the body's along-surface position to it - so putting the
    // position solve after the contact pass took the last word away from it. The
    // two then fought: the grip dragged the body back to an anchor that the
    // recovery had already found to be inside something, the recovery pushed it
    // back out, and a polygon resting perfectly still on the floor buzzed 4 cm
    // back and forth, every frame, for as long as it sat there (session-255f).
    //
    // Carrying the anchor with the correction settles it, and does not weaken the
    // grip: what stiction exists to cancel is the tangential *drift* gravity
    // integrates in one step, which is measured against the anchor and is
    // unaffected by moving both. It is the same trick the steered-ball coil path
    // already uses, where the anchor advances by the roll the frame intended and
    // only the gravity creep on top is removed.
    for (let pass = 0; pass < DEPENETRATION_PASSES; pass++) {
      for (const body of this.bodies) {
        if (!(body instanceof RigidBody2D) || body.removed) continue;
        const before = body.globalPosition;
        this.depenetrateRigid(body, 1);
        if (body.stickAnchor !== null) {
          body.stickAnchor = body.stickAnchor.add(body.globalPosition.sub(before));
        }
      }
    }
  }

  // Resolve one of a rigidbody's vertex shapes (a rect or convex polygon)
  // against a single target shape, through a contact manifold rather than the
  // single point a circle can produce. Returns whether static friction has the
  // body gripped.
  //
  // Deliberately a sibling of `resolveRigidCircle` rather than a generalisation
  // of it: that routine carries the ball & chain avatar's steering path and a
  // centred-circle branch that is bit-identical to every recorded replay, and
  // folding a manifold through it would put both at risk for no gain — a
  // polygon never steers, and no replay predates it.
  private resolveRigidLoop(
    body: RigidBody2D,
    bshape: ShapeTransform,
    other: PhysicsBody2D,
    oshape: ShapeTransform,
    dt: number,
  ): boolean {
    const contacts = shapeContacts(bshape, oshape);
    if (contacts.length === 0) return false;

    if (!(other instanceof StaticBody2D)) {
      // Rigid-rigid: split the push and damp the approach, as this path has
      // always approximated it - but through the *coupled* linear/angular
      // effective mass, and per manifold point, so an off-centre contact torques
      // the body.
      //
      // It used to read `body.linearVelocity.dot(normal)` and write the impulse
      // back into `linearVelocity` alone, which is a contact with **no torque at
      // all**. A circle can get away with that (its contact normal passes through
      // its centre, so there is genuinely no lever), and this branch was written
      // as the circle path's twin; a vertex shape cannot. Resting on another
      // rigid body, it could only ever be pushed, never turned, so a body balanced
      // on a corner of one had no way to fall off it: a long sliver cantilevered
      // out into thin air over the corner of another polygon rotated at 0.2 rad/s
      // - a crumb of friction torque, the only kind reaching it - where it should
      // have whipped round in a fraction of a second (session-166f).
      //
      // `RIGID_PAIR_SHARE` is the same halving as before: neither body's solve
      // knows about the other's, so each takes half and the pair converges over a
      // couple of frames rather than both resolving the contact in full.
      let deepest = contacts[0]!;
      for (const c of contacts) if (c.depth > deepest.depth) deepest = c;
      body.globalPosition = body.globalPosition.add(deepest.normal.mul(deepest.depth * 0.5));
      const invI = body.kinematicRotation ? 0 : body.inverseInertia;
      let vnKilled = 0;
      for (const c of contacts) {
        const rContact = c.point.sub(body.globalPosition);
        const vn = body.linearVelocity
          .add(new Vec2(-rContact.y, rContact.x).mul(body.angularVelocity))
          .sub(other.velocityAtPoint(c.point))
          .dot(c.normal);
        if (vn >= 0) continue;
        const rCrossN = rContact.cross(c.normal);
        const invEffN = body.inverseMass + rCrossN * rCrossN * invI;
        const jn = invEffN > 1e-9 ? (-vn * RIGID_PAIR_SHARE) / invEffN : 0;
        body.linearVelocity = body.linearVelocity.add(c.normal.mul(jn * body.inverseMass));
        body.angularVelocity += rCrossN * jn * invI;
        vnKilled += jn * body.inverseMass;
      }
      // Friction and the contact damp stay a once-per-contact-pair affair, at the
      // deepest point: `applyRigidContactFriction` ends with `contactDamp`, and
      // calling it per manifold point would apply that damp once per point.
      this.applyRigidContactFriction(
        body,
        other,
        deepest.point.sub(body.globalPosition),
        deepest.normal,
        vnKilled,
        dt,
      );
      return false;
    }

    const grip = other.surfaceFriction;
    const staticMu = body.staticFriction * grip;
    const kineticMu = body.contactFriction * grip;
    const invI = body.kinematicRotation ? 0 : body.inverseInertia;

    // Push out along the deepest contact only: the manifold's points share one
    // normal, so resolving each in turn would push out several times over.
    let deepest = contacts[0]!;
    for (const c of contacts) if (c.depth > deepest.depth) deepest = c;
    body.globalPosition = body.globalPosition.add(deepest.normal.mul(deepest.depth));

    // The impulses, on the other hand, are per point — that is the whole reason
    // for a two-point manifold, since one point cannot resist a rotation about
    // itself. Each is solved in full against the velocity left by the one
    // before it (Gauss-Seidel), NOT scaled by 1/count: sharing the normal
    // impulse leaves a slice of the approach velocity alive every frame, and a
    // box resting on a flat floor then sits there re-earning gravity forever at
    // a visible fraction of a metre per second.
    const share = 1 / contacts.length;
    const g = GRAVITY.mul(body.gravityScale);
    let stuck = false;
    for (const c of contacts) {
      const rContact = c.point.sub(body.globalPosition);
      const surfaceVel = other.velocityAtPoint(c.point);
      const pointVel = (): Vec2 =>
        body.linearVelocity.add(new Vec2(-rContact.y, rContact.x).mul(body.angularVelocity));

      const vn = pointVel().sub(surfaceVel).dot(c.normal);
      let vnKilled = 0;
      if (vn < 0) {
        const rCrossN = rContact.cross(c.normal);
        const invEffN = body.inverseMass + rCrossN * rCrossN * invI;
        const jn = invEffN > 1e-9 ? (-vn * (1 + body.restitution)) / invEffN : 0;
        body.linearVelocity = body.linearVelocity.add(c.normal.mul(jn * body.inverseMass));
        body.angularVelocity += rCrossN * jn * invI;
        vnKilled = jn * body.inverseMass;
      }

      // Stiction: a nearly-stopped body on a slope gentler than its breakaway
      // angle is pinned rather than left to creep downhill one integration step
      // at a time. Same rule and the same anchor the circle path uses, but
      // deliberately NOT the same authority over rotation - see below.
      const gN = -g.dot(c.normal);
      const rel = body.linearVelocity.sub(surfaceVel);
      if (
        staticMu > 0 &&
        !other.isMobile &&
        gN > 1e-6 &&
        rel.length() < STICK_SPEED &&
        Math.abs(body.angularVelocity) < STICK_SPIN &&
        g.sub(c.normal.mul(g.dot(c.normal))).length() <= staticMu * gN
      ) {
        const tanVel = surfaceVel.sub(c.normal.mul(surfaceVel.dot(c.normal)));
        // Keep the normal component only where it *separates*. A gripped body is
        // at rest against the surface, so a velocity pointing into it is one it
        // can never realise, and this manifold path is the one that leaves such a
        // component behind: zeroing the spin here discards the angular half of
        // the normal impulse solved a few lines above, so the linear approach it
        // was cancelling survives. The push-out then hides it - a crate settled
        // flat on a floor sat at a perfectly stable position while reporting a
        // permanent 0.275 m/s into the ground, re-earned and re-pushed-out every
        // frame. Nothing on this path is load-bearing for a recorded replay (no
        // ball bundle predates the manifold solve), and the circle path deals in
        // a single contact whose normal impulse is not split, so it is left
        // bit-for-bit alone.
        const vnKeep = Math.max(0, body.linearVelocity.dot(c.normal));
        body.linearVelocity = c.normal.mul(vnKeep).add(tanVel);
        // Rotation is left alone. The circle path zeroes it here, and for a
        // circle that is free: rotation cannot change which part of the shape is
        // holding it up, so a settled ball simply should not be spinning. A
        // vertex shape's orientation IS its balance, and zeroing the spin of a
        // gripped one holds it in whatever pose it is in by fiat - gravity gets
        // no say, so a slab tipped up on a corner can never topple back down.
        // Worse, nothing here anchors the *angle* the way `stickAnchor` anchors
        // the position, so any rotation written after this solve is kept in full
        // and re-frozen next frame: a chain that turns the body a fraction of a
        // degree per tug ratchets it round for good. That is how a polygon group
        // a chain had rotated to -22.8° stayed there with the chain gone, reading
        // as gravity having been switched off for it (session-1195f).
        //
        // Left free, the normal impulses solved per manifold point above are what
        // resist rotation - which is what they are a two-point manifold *for* -
        // and a body that really is toppling spins past `STICK_SPIN`, releases
        // the grip, and falls. The grip stays what it is meant to be: a brake on
        // translation, not a lock on pose.
        if (body.stickAnchor === null) {
          body.stickAnchor = body.globalPosition;
        } else {
          const d = body.globalPosition.sub(body.stickAnchor);
          body.globalPosition = body.stickAnchor.add(c.normal.mul(d.dot(c.normal)));
        }
        stuck = true;
        continue;
      }

      if (kineticMu <= 0) continue;
      const tangent = new Vec2(-c.normal.y, c.normal.x);
      const surfSpeed = pointVel().sub(surfaceVel).dot(tangent);
      const rCrossT = rContact.cross(tangent);
      const invEff = body.inverseMass + rCrossT * rCrossT * invI;
      if (invEff <= 1e-9) continue;
      const gravityBite = Math.max(0, g.mul(dt).dot(c.normal.mul(-1)));
      const maxImpulse = kineticMu * body.mass * (vnKilled + gravityBite * share);
      let j = -surfSpeed / invEff;
      j = Math.max(-maxImpulse, Math.min(maxImpulse, j));
      if (tangent.mul(j).dot(body.linearVelocity) < 0) j *= body.contactBrakeScale;
      body.linearVelocity = body.linearVelocity.add(tangent.mul(j * body.inverseMass));
      body.angularVelocity += rCrossT * j * invI;
    }

    const damp = grip === 1 ? body.contactDamp : 1 - (1 - body.contactDamp) * grip;
    body.linearVelocity = body.linearVelocity.mul(damp);
    return stuck;
  }

  // Resolve one of a rigidbody's circles (centred at `body.globalPosition +
  // offset`, radius `r`) against a single target shape. A centred circle
  // (offset zero) reproduces the legacy resolution exactly; an offset circle
  // adds a torque term so an off-centre contact spins the body.
  private resolveRigidCircle(
    body: RigidBody2D,
    offset: Vec2,
    r: number,
    other: PhysicsBody2D,
    oshape: ShapeTransform,
    dt: number,
  ): boolean {
    const center = body.globalPosition.add(offset);
    const ov = circleOverlap(center, r, oshape);
    if (!ov) return false;
    // The primary shape's offset is exactly (0,0), so this gate (not a
    // floating-point cross-product test) keeps the centred circle on the
    // legacy torque-free path, bit-for-bit with recorded replays.
    const centered = offset.x === 0 && offset.y === 0;
    if (other instanceof StaticBody2D) {
      // The surface's own friction scales both Coulomb coefficients the body
      // brings to the contact: 1 (the default) multiplies by exactly 1 and is
      // bit-identical to the pre-surface-friction path, 0 makes the surface
      // ice — no traction to roll on, no stiction to hold a slope.
      const grip = other.surfaceFriction;
      const staticMu = body.staticFriction * grip;
      const kineticMu = body.contactFriction * grip;
      // Push fully out of static geometry and kill inward velocity, relative to
      // the surface (scripted movers can bat circles).
      body.globalPosition = body.globalPosition.add(ov.normal.mul(ov.depth));
      // Body centre → contact point. For the centred primary circle this is
      // exactly -r·n (offset is zero), so the torque lever below vanishes.
      const rContact = offset.add(ov.normal.mul(-r));
      const contactPoint = body.globalPosition.add(rContact);
      // Approach velocity AT THE CONTACT POINT, spin included. A centred circle's
      // lever is exactly -r·n, so ω × r is purely tangential and contributes
      // nothing to `vn`; the gate keeps that arithmetic out of the legacy path
      // rather than relying on the two cross terms cancelling bit-for-bit.
      //
      // An offset circle's lever is not radial, so the term is real, and leaving
      // it out is what made a compound body unable to settle: the first circle's
      // impulse spins the body, and the second circle then measured an approach
      // that ignored the spin it was there to cancel. Two circles resting flat on
      // a floor therefore torqued each other in turn and rocked forever
      // (session-735f).
      const rel = (centered
        ? body.linearVelocity
        : body.linearVelocity.add(
            new Vec2(-body.angularVelocity * rContact.y, body.angularVelocity * rContact.x),
          )
      ).sub(other.velocityAtPoint(contactPoint));
      const vn = rel.dot(ov.normal);
      // Rotation may be kinematically driven (aim steering overwrites the ball's
      // angular velocity every frame); then contacts must not feed angular
      // velocity — it would be discarded anyway, and the wasted impulse is what
      // let the ball slide instead of braking. Treat it as rotationally locked:
      // infinite rotational inertia in the contact solve, so the same friction
      // that spun the ball up instead brakes the linear slide.
      const invI = body.kinematicRotation ? 0 : body.inverseInertia;
      let vnKilled = 0;
      if (vn < 0) {
        // Kill inward velocity and reflect a restitution fraction back out.
        // restitution = 0 (default) removes exactly vn — the historical
        // fully-inelastic path, bit-identical for recorded replays.
        const bounce = 1 + body.restitution;
        if (centered || body.kinematicRotation) {
          // No torque (centred contact, or rotation externally driven): direct
          // velocity change, exactly the legacy centred path.
          body.linearVelocity = body.linearVelocity.sub(ov.normal.mul(vn * bounce));
          vnKilled = -vn * bounce;
        } else {
          // Off-centre contact: normal impulse through the coupled
          // linear/angular effective mass, so the loop can tip the ball.
          const rCrossN = rContact.cross(ov.normal);
          const invEffN = body.inverseMass + rCrossN * rCrossN * invI;
          const jn = invEffN > 1e-9 ? (-vn * bounce) / invEffN : 0;
          body.linearVelocity = body.linearVelocity.add(ov.normal.mul(jn * body.inverseMass));
          body.angularVelocity += rCrossN * jn * invI;
          vnKilled = jn * body.inverseMass; // equivalent normal Δv for the friction cap
        }
      }
      // Steered (aiming) contact: the aim steering drives rotation
      // kinematically, with full authority — a control input, not a
      // friction-limited force. Static/kinetic split on the contact slip: while
      // the ball's contact point moves slowly relative to the surface (slow,
      // careful rotation) grip it and enforce exact roll-without-slip — the
      // centre orbits the contact so the ball rolls/pivots over it and the
      // off-centre loop never scrubs. Rotate or travel fast and the slip exceeds
      // the threshold, so it falls through to the slippery Coulomb kinetic
      // friction below instead of stopping dead on contact.
      if (body.kinematicRotation) {
        const surfV = other.velocityAtPoint(contactPoint);
        const wCrossR = new Vec2(
          -body.angularVelocity * rContact.y,
          body.angularVelocity * rContact.x,
        );
        // Pre-solve slip: relative velocity between the contact points, tangent
        // to the surface.
        const relV = body.linearVelocity.add(wCrossR).sub(surfV);
        const slipTan = relV.sub(ov.normal.mul(relV.dot(ov.normal)));
        const g = GRAVITY.mul(body.gravityScale);
        const gN = -g.dot(ov.normal);
        const withinBudget =
          staticMu > 0 &&
          !other.isMobile &&
          gN > 1e-6 &&
          g.sub(ov.normal.mul(g.dot(ov.normal))).length() <= staticMu * gN;
        if (slipTan.length() < SLIP_STICK && withinBudget) {
          // Grip: drive the centre so the contact is stationary,
          // v_centre = surfaceVel − ω × r_contact.
          const desired = surfV.sub(wCrossR);
          const vnKeep = body.linearVelocity.dot(ov.normal);
          const rollTan = desired.sub(ov.normal.mul(desired.dot(ov.normal)));
          body.linearVelocity = ov.normal.mul(vnKeep).add(rollTan);
          // Kill gravity creep at any spin: integration slides the ball one step
          // of gravity downhill each frame before this solve (worse the steeper
          // the slope); undo it by pinning the along-surface position to an
          // anchor that ADVANCES by the intended roll (rollTan·dt). The steered
          // roll is preserved exactly while the gravity drift on top is removed;
          // at ω = 0 the anchor is static and the ball simply holds.
          if (body.stickAnchor === null) {
            body.stickAnchor = body.globalPosition;
          } else {
            body.stickAnchor = body.stickAnchor.add(rollTan.mul(dt));
          }
          const d = body.globalPosition.sub(body.stickAnchor);
          const dTan = d.sub(ov.normal.mul(d.dot(ov.normal)));
          body.globalPosition = body.globalPosition.sub(dTan);
          return true;
        }
        // Slipping: release the grip and fall through to kinetic friction.
        body.stickAnchor = null;
      }
      // Tangential contact friction (opt-in per body): drive the relative
      // surface velocity at the contact point toward zero through the coupled
      // linear/angular effective mass, so a sliding circle spins up into a
      // roll. Coulomb-capped: the impulse cannot exceed contactFriction (μ)
      // times this frame's normal impulse — estimated from the normal velocity
      // just killed plus gravity's bite into the surface. A vertical wall gets
      // no gravity bite and thus (once resting) no traction, so a spinning ball
      // cannot climb it. contactFriction = 0 skips this — the historical path.
      // Every circle the body carries shares its friction and restitution, so an
      // offset auxiliary (the ball & chain avatar's loop) grips exactly like the
      // main tread.
      //
      // Static friction (stiction): a slow body on a slope gentler than its
      // breakaway angle atan(μ_s) is pinned rather than left to roll/creep off.
      // Compare the along-surface gravity to μ_s × the normal force; if it is
      // within budget and the body is nearly stopped, cancel its tangential
      // velocity and spin, pin its along-surface position, and skip kinetic
      // friction. Steered (aiming) contacts are handled above (grip or slip) and
      // must not enter here — this zeroes spin, which would fight the steering.
      let stuck = false;
      if (!body.kinematicRotation && staticMu > 0 && !other.isMobile) {
        const g = GRAVITY.mul(body.gravityScale);
        const gN = -g.dot(ov.normal); // normal gravity pull into the surface
        const rel = body.linearVelocity.sub(other.velocityAtPoint(contactPoint));
        if (
          gN > 1e-6 &&
          rel.length() < STICK_SPEED &&
          Math.abs(body.angularVelocity) < STICK_SPIN &&
          g.sub(ov.normal.mul(g.dot(ov.normal))).length() <= staticMu * gN
        ) {
          const otherVel = other.velocityAtPoint(contactPoint);
          const vn = body.linearVelocity.dot(ov.normal);
          // Keep only the normal component; match the surface's tangential
          // velocity (zero for a static floor). Spin stops too.
          const otherTan = otherVel.sub(ov.normal.mul(otherVel.dot(ov.normal)));
          body.linearVelocity = ov.normal.mul(vn).add(otherTan);
          body.angularVelocity = 0;
          // Pin the along-surface position to the grip anchor. Without this the
          // body still slides one integration step of gravity each frame (move
          // then freeze), creeping downhill; here that drift is undone while the
          // normal component stays free to settle onto the surface.
          if (body.stickAnchor === null) {
            body.stickAnchor = body.globalPosition;
          } else {
            const d = body.globalPosition.sub(body.stickAnchor);
            body.globalPosition = body.stickAnchor.add(ov.normal.mul(d.dot(ov.normal)));
          }
          stuck = true;
        }
      }
      if (!stuck && kineticMu > 0) {
        const tangent = new Vec2(-ov.normal.y, ov.normal.x);
        const surfSpeed = body.linearVelocity
          .add(new Vec2(-rContact.y, rContact.x).mul(body.angularVelocity))
          .sub(other.velocityAtPoint(contactPoint))
          .dot(tangent);
        const rCrossT = rContact.cross(tangent);
        const invEff = body.inverseMass + rCrossT * rCrossT * invI;
        if (invEff > 1e-9) {
          const gravityBite = Math.max(
            0,
            GRAVITY.mul(body.gravityScale * dt).dot(ov.normal.mul(-1)),
          );
          const maxImpulse = kineticMu * body.mass * (vnKilled + gravityBite);
          let j = -surfSpeed / invEff; // full-stick impulse
          j = Math.max(-maxImpulse, Math.min(maxImpulse, j));
          // Braking impulses (opposing current travel) are scaled by
          // contactBrakeScale; driving ones always apply in full.
          if (tangent.mul(j).dot(body.linearVelocity) < 0) j *= body.contactBrakeScale;
          body.linearVelocity = body.linearVelocity.add(tangent.mul(j * body.inverseMass));
          body.angularVelocity += rCrossT * j * invI;
        }
      }
      // Light contact drag. `contactDamp` is the fraction of speed *retained*,
      // so the surface fades it toward 1 (no drag) as friction drops to ice.
      // The grip === 1 branch is not an optimisation: it keeps the default path
      // on the literal `contactDamp`, since 1 - (1 - 0.98) * 1 does not round
      // back to exactly 0.98 and would drift recorded replays.
      const damp = grip === 1 ? body.contactDamp : 1 - (1 - body.contactDamp) * grip;
      body.linearVelocity = body.linearVelocity.mul(damp);
      return stuck;
    } else {
      // Rigid-rigid: split the push, damp approach velocity (approximate).
      body.globalPosition = body.globalPosition.add(ov.normal.mul(ov.depth * 0.5));
      const rContact = offset.add(ov.normal.mul(-r));
      const rel = body.linearVelocity.dot(ov.normal);
      let vnKilled = 0;
      if (rel < 0) {
        body.linearVelocity = body.linearVelocity.sub(ov.normal.mul(rel * 0.5));
        vnKilled = -rel * 0.5;
      }
      this.applyRigidContactFriction(body, other, rContact, ov.normal, vnKilled, dt);
      return false;
    }
  }

  // Tangential friction and damping for a contact with another *rigid* body,
  // where the static path's Coulomb solve does not reach.
  //
  // Resting on a rigid body used to be resting on ice: the branch split the
  // push-out and killed the approach velocity and stopped there, so a circle's
  // `contactFriction` and `contactDamp` — which decide everything about how it
  // behaves on a static floor — did nothing at all against a polygon. Gravity
  // then does work down a rigid slope for ever, and with a chain to carry it
  // away that is a motor: a ball hanging on a rigid polygon's face slid the pair
  // across the level at a steady 0.7 m/s and never slowed (session-431f).
  //
  // Deliberately the simple half of the static solve — Coulomb-capped kinetic
  // friction and the contact damp, no stiction and no stick anchor. Those pin a
  // body to a surface that is not going anywhere, which is not true of a rigid
  // body, and the pinning would fight the other body's own resolution pass.
  private applyRigidContactFriction(
    body: RigidBody2D,
    other: PhysicsBody2D,
    rContact: Vec2,
    normal: Vec2,
    vnKilled: number,
    dt: number,
  ): void {
    const grip = other.surfaceFriction;
    const kineticMu = body.contactFriction * grip;
    if (kineticMu > 0) {
      const invI = body.kinematicRotation ? 0 : body.inverseInertia;
      const contactPoint = body.globalPosition.add(rContact);
      const tangent = new Vec2(-normal.y, normal.x);
      const pointVel = body.linearVelocity.add(
        new Vec2(-rContact.y, rContact.x).mul(body.angularVelocity),
      );
      // Slip measured against the WORLD, not against the other body's surface.
      //
      // The static path measures relative slip, and must: a scripted mover is an
      // infinite-mass surface whose motion is a given, so a body resting on one
      // is dragged along with it and that is the whole point. Two *dynamic*
      // bodies are a different situation, and the difference is that this routine
      // is not one half of a reciprocal impulse pair. It only ever writes to
      // `body`; the other direction is a separate call, on a separate pass, whose
      // impulse is sized independently from its own mass and its own normal
      // budget. Nothing makes the two equal and opposite, so any impulse taken
      // from `other`'s motion is energy the contact invented.
      //
      // Read as relative slip, the ball resting against a crate therefore drove
      // it: the ball's spin is kinematic (the aim rewrites it every frame, so
      // nothing the contact does can slow it) and its linear velocity is whatever
      // the chain solve last credited it, which for a wedged ball is metres per
      // second of motion the geometry is refusing. Either one appears here as a
      // surface sliding under the crate, and Coulomb friction dutifully drags the
      // crate along with it - at a dead-steady 2.4 mm a frame, for ever, because
      // the crate's own grip on the floor is resolved earlier in the same pass
      // and cannot answer a drive that lands after it. A ball merely hanging on a
      // chain walked its anchor 3.6 m across the level that way (session-611f).
      //
      // Against the world the impulse can only ever oppose the body's own motion,
      // so the contact is a brake and never a motor - which is what this routine
      // was added to be, and all `session-431f` (gravity doing work down a rigid
      // slope for ever) ever needed. The bodies still shove each other through
      // the normal channel, which *is* solved as a pair.
      const surfSpeed = pointVel.dot(tangent);
      const rCrossT = rContact.cross(tangent);
      const invEff = body.inverseMass + rCrossT * rCrossT * invI;
      if (invEff > 1e-9) {
        const g = GRAVITY.mul(body.gravityScale);
        const gravityBite = Math.max(0, g.mul(dt).dot(normal.mul(-1)));
        const maxImpulse = kineticMu * body.mass * (vnKilled + gravityBite);
        let j = -surfSpeed / invEff;
        j = Math.max(-maxImpulse, Math.min(maxImpulse, j));
        if (tangent.mul(j).dot(body.linearVelocity) < 0) j *= body.contactBrakeScale;
        body.linearVelocity = body.linearVelocity.add(tangent.mul(j * body.inverseMass));
        body.angularVelocity += rCrossT * j * invI;
      }
    }
    const damp = grip === 1 ? body.contactDamp : 1 - (1 - body.contactDamp) * grip;
    body.linearVelocity = body.linearVelocity.mul(damp);
  }

  private notifyAreas(): void {
    for (const area of this.areas) {
      if (area.removed || !area.hasShape()) continue;
      const inside: CollisionObject2D[] = [];
      for (const body of this.bodies) {
        if (body.removed || !body.hasShape()) continue;
        if (body.getShapes().some((s) => shapesOverlap(area.primaryShape(), s))) inside.push(body);
      }
      area.notifyOverlaps(inside);
    }
  }
}

// Cheap symmetric overlap test between two shape transforms.
function shapesOverlap(a: ShapeTransform, b: ShapeTransform): boolean {
  if (a.shape.kind === "circle") {
    return circleOverlap(a.globalPosition, a.shape.radius, b) !== null;
  }
  if (b.shape.kind === "circle") {
    return circleOverlap(b.globalPosition, b.shape.radius, a) !== null;
  }
  // Two vertex shapes: sample via one's bounding circle then refine with the
  // min-translation test against the other (sufficient for the area/explosion
  // queries the game issues, which always involve a circle in practice).
  return circleOverlap(a.globalPosition, shapeRadius(a.shape), b) !== null;
}
