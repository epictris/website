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
import { circleOverlap, rayVsShape, sweepCircle } from "./collision";

// Godot 2D default gravity, in px/s². dt is 1/60, so ≈16.3 px/frame².
export const GRAVITY = new Vec2(0, 980);
const SKIN = 0.08;

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
      if (sweep && sweep.t <= 1 && (!sweepHit || sweep.t < sweepHit.t)) {
        sweepHit = { t: sweep.t, normal: sweep.normal, collider: target };
      }
    }

    // Depenetration takes priority over a forward sweep.
    if (overlapHit) {
      const finalPos = start.add(overlapHit.normal.mul(overlapHit.depth));
      const travel = finalPos.sub(start);
      if (!testOnly) body.globalPosition = finalPos;
      return new KinematicCollision2D(overlapHit.normal, travel, motion, overlapHit.collider);
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
    if (!testOnly) body.globalPosition = finalPos;
    return new KinematicCollision2D(sweepHit.normal, travel, remainder, sweepHit.collider);
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
    this.resolveDynamicCollisions();
    this.notifyAreas();
  }

  private resolveDynamicCollisions(): void {
    for (const body of this.bodies) {
      if (!(body instanceof RigidBody2D) || body.removed || !body.hasShape()) continue;
      const s = body.getShape().shape;
      const r = s.kind === "circle" ? s.radius : Math.hypot(s.size.x * 0.5, s.size.y * 0.5);
      for (const other of this.bodies) {
        if (other === body || other.removed || !other.hasShape()) continue;
        if (body.exceptions.has(other.id)) continue;
        if (!(other instanceof StaticBody2D || other instanceof RigidBody2D)) continue;
        const ov = circleOverlap(body.globalPosition, r, other.getShape());
        if (!ov) continue;
        if (other instanceof StaticBody2D) {
          // Push fully out of static geometry and kill inward velocity.
          body.globalPosition = body.globalPosition.add(ov.normal.mul(ov.depth));
          const vn = body.linearVelocity.dot(ov.normal);
          if (vn < 0) body.linearVelocity = body.linearVelocity.sub(ov.normal.mul(vn));
          body.linearVelocity = body.linearVelocity.mul(0.98); // light friction
        } else {
          // Rigid-rigid: split the push, damp approach velocity (approximate).
          body.globalPosition = body.globalPosition.add(ov.normal.mul(ov.depth * 0.5));
          const rel = body.linearVelocity.dot(ov.normal);
          if (rel < 0) body.linearVelocity = body.linearVelocity.sub(ov.normal.mul(rel * 0.5));
        }
      }
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
