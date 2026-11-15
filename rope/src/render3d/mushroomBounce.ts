import type * as THREE from "three";
import type { CollisionObject2D } from "../engine/body";
import type { ContactPulses } from "../engine/contactPulses";

/** Render-only spring response. Collision and launch stay with the physics body. */
export class MushroomBounce {
  constructor(private readonly node: THREE.Object3D, private readonly stemHeight: number) {}

  sync(body: CollisionObject2D, pulses: ContactPulses, alpha: number): void {
    const hit = pulses.latest.get(body);
    const age = hit ? Math.max(0, pulses.time - hit.time - (1 - alpha) / 60) : Infinity;
    const amplitude = hit ? Math.min(1, .35 + hit.impulse / 30) : 0;
    // Immediate widening/compression, a small elastic overshoot, then rest.
    const spring = age < 1.2 ? amplitude * Math.exp(-5 * age) * Math.cos(15 * age) : 0;
    this.node.scale.set(1 + .28 * spring, 1 - .3 * spring, 1 + .28 * spring);
    // Pin the stem foot as the stem compresses.
    this.node.position.y = -this.stemHeight * .3 * spring;
  }
}
