// CannonBall — explosive projectile, ported from classes/CannonBall.cs.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { RigidBody2D } from "../engine/body";
import { circleShape } from "../engine/shapes";
import { ShapeGeometry } from "../lib/shapeGeometry";

const EXPLOSION_RADIUS = 50;
const EXPLOSION_IMPULSE = 8;

export class CannonBall extends RigidBody2D {
  constructor() {
    super();
    this.name = "CannonBall";
    if (!this.hasShape()) this.setShape(circleShape(4));
    this.mass = ShapeGeometry.computeMass(this.getShape());
    this.inertia = ShapeGeometry.computeMomentOfInertia(this.getShape(), this.mass);
  }

  explode(): void {
    if (!this.world) return;
    const origin = this.globalPosition;
    const hits = this.world.intersectCircle(origin, EXPLOSION_RADIUS, 64);
    for (const body of hits) {
      if (body === this) continue;
      const delta = body.globalPosition.sub(origin);
      const dist = delta.length();
      if (dist < 0.0001) continue;
      const falloff = Mathf.clamp(1 - dist / EXPLOSION_RADIUS, 0, 1);
      if (body instanceof RigidBody2D) {
        body.applyImpulse(delta.div(dist).mul(EXPLOSION_IMPULSE * falloff));
      }
    }
    this.world.remove(this);
  }
}
