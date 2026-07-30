// CannonBall — explosive projectile, ported from classes/CannonBall.cs.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { RigidBody2D } from "../engine/body";
import { circleShape } from "../engine/shapes";
import { Density, ShapeGeometry } from "../lib/shapeGeometry";
import { PX } from "../engine/units";

const EXPLOSION_RADIUS = 0.5; // metres
// Momentum (kg·m/s) handed to a body at ground zero, falling off linearly with
// distance. Sized in the unit the sim actually uses: a stone rock the size of
// the ones the sandbox spawns (0.1 m, ~10 kg) is thrown at about 0.25 m/s from
// the centre of the blast, which is the kick this has always given - it was
// written as 8e-6 back when a body's mass was its area in m² over a thousand.
const EXPLOSION_IMPULSE = 2.5;

export class CannonBall extends RigidBody2D {
  constructor() {
    super();
    this.name = "CannonBall";
    if (!this.hasShape()) this.setShape(circleShape(0.04));
    // A cast-iron shot, like the ball: 8 cm across, ~1.9 kg.
    this.mass = ShapeGeometry.computeMass(this.primaryShape(), Density.CAST_IRON);
    this.inertia = ShapeGeometry.computeMomentOfInertia(this.primaryShape(), this.mass);
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
