import * as THREE from "three";
import type { CollisionObject2D } from "../engine/body";
import type { ContactPulses } from "../engine/contactPulses";
import { threeY } from "./space";

/** Render-only spring response. Collision and launch stay with the physics body. */
export class MushroomBounce {
  private readonly direction = new THREE.Vector3();
  private readonly inverseParent = new THREE.Matrix4();

  constructor(private readonly node: THREE.Object3D, private readonly stemHeight: number) {
    node.matrixAutoUpdate = false;
  }

  sync(body: CollisionObject2D, pulses: ContactPulses, alpha: number): void {
    const hit = pulses.latest.get(body);
    const age = hit ? Math.max(0, pulses.time - hit.time - (1 - alpha) / 60) : Infinity;
    // Actual contact impulse drives the extension: light touches stay subtle,
    // strong launches approach 28% smoothly without a hard saturation threshold.
    const amplitude = hit ? .28 * (1 - Math.exp(-Math.max(0, hit.impulse) / 12)) : 0;
    const spring = age < 1.6 ? amplitude * Math.exp(-4.5 * age) * Math.cos(16 * age) : 0;
    this.direction.set(hit?.directionX ?? 0, threeY(hit?.directionY ?? -1), 0);
    if (this.node.parent) {
      this.node.parent.updateWorldMatrix(true, false);
      this.inverseParent.copy(this.node.parent.matrixWorld).invert();
      this.direction.transformDirection(this.inverseParent);
    } else this.direction.normalize();
    const { x, y, z } = this.direction.multiplyScalar(spring);
    // Displace toward the launch, increasing from zero at the planted foot
    // to the full extension at the cap. Preserve the cap's sideways width.
    this.node.matrix.set(
      1, x, 0, this.stemHeight * x,
      0, 1 + y, 0, this.stemHeight * y,
      0, z, 1, this.stemHeight * z,
      0, 0, 0, 1,
    );
    this.node.matrixWorldNeedsUpdate = true;
  }
}
