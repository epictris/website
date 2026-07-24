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
  KinematicCollision2D,
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
} from "./body";
import { circleOverlap, outwardDirection, rayVsShape, sweepCircle } from "./collision";
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
    const shape = body.getShape().shape;
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
      const ts = target.getShape();

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
          const ov = circleOverlap(finalPos, r, target.getShape());
          if (!ov) continue;
          if (!a || ov.depth > a.depth) {
            b = a;
            a = { normal: ov.normal, depth: ov.depth };
          } else if (!b || ov.depth > b.depth) {
            b = { normal: ov.normal, depth: ov.depth };
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
      const hit = rayVsShape(from, to, body.getShape(), opts.hitFromInside ?? false);
      if (hit && hit.t < bestT) {
        bestT = hit.t;
        best = { collider: body, position: hit.position, normal: hit.normal };
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
      if (shapesOverlap(probe, body.getShape())) {
        out.push(body);
        if (out.length >= maxResults) break;
      }
    }
    return out;
  }

  // ---- dynamic-body integration -----------------------------------------

  integrate(dt: number): void {
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

  private resolveDynamicCollisions(dt: number): void {
    for (const body of this.bodies) {
      if (!(body instanceof RigidBody2D) || body.removed || !body.hasShape()) continue;
      // Rects/polygons are never physics-driven (game-design.md); circles are
      // the only dynamic bodies. Resolve every circle the body carries — a
      // compound body (the ball & chain avatar) adds an offset rim circle for
      // its loop. The primary circle is centred and keeps the historical
      // resolution bit-for-bit; offset circles additionally torque the body.
      let stuck = false;
      for (const bshape of body.getShapes()) {
        if (bshape.shape.kind !== "circle") continue;
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
      // Push fully out of static geometry and kill inward velocity, relative to
      // the surface (scripted movers can bat circles).
      body.globalPosition = body.globalPosition.add(ov.normal.mul(ov.depth));
      // Body centre → contact point. For the centred primary circle this is
      // exactly -r·n (offset is zero), so the torque lever below vanishes.
      const rContact = offset.add(ov.normal.mul(-r));
      const contactPoint = body.globalPosition.add(rContact);
      const rel = body.linearVelocity.sub(other.velocityAtPoint(contactPoint));
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
          body.staticFriction > 0 &&
          !other.isMobile &&
          gN > 1e-6 &&
          g.sub(ov.normal.mul(g.dot(ov.normal))).length() <= body.staticFriction * gN;
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
      if (!body.kinematicRotation && body.staticFriction > 0 && !other.isMobile) {
        const g = GRAVITY.mul(body.gravityScale);
        const gN = -g.dot(ov.normal); // normal gravity pull into the surface
        const rel = body.linearVelocity.sub(other.velocityAtPoint(contactPoint));
        if (
          gN > 1e-6 &&
          rel.length() < STICK_SPEED &&
          Math.abs(body.angularVelocity) < STICK_SPIN &&
          g.sub(ov.normal.mul(g.dot(ov.normal))).length() <= body.staticFriction * gN
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
      if (!stuck && body.contactFriction > 0) {
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
          const maxImpulse = body.contactFriction * body.mass * (vnKilled + gravityBite);
          let j = -surfSpeed / invEff; // full-stick impulse
          j = Math.max(-maxImpulse, Math.min(maxImpulse, j));
          // Braking impulses (opposing current travel) are scaled by
          // contactBrakeScale; driving ones always apply in full.
          if (tangent.mul(j).dot(body.linearVelocity) < 0) j *= body.contactBrakeScale;
          body.linearVelocity = body.linearVelocity.add(tangent.mul(j * body.inverseMass));
          body.angularVelocity += rCrossT * j * invI;
        }
      }
      body.linearVelocity = body.linearVelocity.mul(body.contactDamp); // light friction
      return stuck;
    } else {
      // Rigid-rigid: split the push, damp approach velocity (approximate).
      body.globalPosition = body.globalPosition.add(ov.normal.mul(ov.depth * 0.5));
      const rel = body.linearVelocity.dot(ov.normal);
      if (rel < 0) body.linearVelocity = body.linearVelocity.sub(ov.normal.mul(rel * 0.5));
      return false;
    }
  }

  private notifyAreas(): void {
    for (const area of this.areas) {
      if (area.removed || !area.hasShape()) continue;
      const inside: CollisionObject2D[] = [];
      for (const body of this.bodies) {
        if (body.removed || !body.hasShape()) continue;
        if (shapesOverlap(area.getShape(), body.getShape())) inside.push(body);
      }
      area.notifyOverlaps(inside);
    }
  }
}

// Cheap symmetric overlap test between two shape transforms (circle/rect).
function shapesOverlap(a: ShapeTransform, b: ShapeTransform): boolean {
  if (a.shape.kind === "circle") {
    return circleOverlap(a.globalPosition, a.shape.radius, b) !== null;
  }
  if (b.shape.kind === "circle") {
    return circleOverlap(b.globalPosition, b.shape.radius, a) !== null;
  }
  // rect vs rect: sample via the larger rect's bounding circle then refine with
  // the min-translation test against one rect (sufficient for the area/explosion
  // queries the game issues, which always involve a circle in practice).
  const ar = Math.hypot(a.shape.size.x * 0.5, a.shape.size.y * 0.5);
  return circleOverlap(a.globalPosition, ar, b) !== null;
}
