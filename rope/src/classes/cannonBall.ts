// CannonBall — explosive projectile, ported from classes/CannonBall.cs.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { RigidBody2D } from "../engine/body";
import { circleShape } from "../engine/shapes";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { PX } from "../engine/units";

const EXPLOSION_RADIUS = 0.5; // metres
// Momentum (mass·velocity). Mass is area-derived, so at metre scale it shrank
// by PIXELS_PER_METER² while the target velocity change shrank by
// PIXELS_PER_METER — hence the impulse scales by PIXELS_PER_METER³ (÷1e6).
const EXPLOSION_IMPULSE = 8e-6;

export class CannonBall extends RigidBody2D {
  constructor() {
    super();
    this.name = "CannonBall";
    if (!this.hasShape()) this.setShape(circleShape(0.04));
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
      if (dist < 0.0001 * PX) continue;
      const falloff = Mathf.clamp(1 - dist / EXPLOSION_RADIUS, 0, 1);
      if (body instanceof RigidBody2D) {
        body.applyImpulse(delta.div(dist).mul(EXPLOSION_IMPULSE * falloff));
      }
    }
    this.world.remove(this);
  }
}
