import { Vector3 } from "three";

// A blade's spring: stiffness (1/s², per unit of displacement) and damping
// (1/s), shared by the tip's lag and the fold at its base (`VineLeafFold`) so a
// leaf springs back the way it sways.
export const LEAF_STIFFNESS = 100;
export const LEAF_DAMPING = 7.5;

// Advance a damped spring `x'' = -LEAF_STIFFNESS·x - 2·LEAF_DAMPING·x'` exactly
// over `dt` (the closed form, so a long frame cannot pump it): returns the new
// displacement and writes the new velocity to `out[0]`.
export function leafSpring(x: number, v: number, dt: number, out: [number]): number {
  const decay = Math.exp(-LEAF_DAMPING * dt), frequency = Math.sqrt(LEAF_STIFFNESS - LEAF_DAMPING * LEAF_DAMPING);
  const c = Math.cos(frequency * dt), s = Math.sin(frequency * dt) / frequency;
  out[0] = (v * (c - LEAF_DAMPING * s) - LEAF_STIFFNESS * s * x) * decay;
  return (x * c + (v + LEAF_DAMPING * x) * s) * decay;
}

// Small render-only damped spring driven by motion of a fixed leaf attachment.
// The explicit simulation clock freezes it on pause and resets it on seek.
export class VineLeafLag {
  readonly offset = new Vector3();
  private readonly velocity = new Vector3();
  private readonly root = new Vector3();
  private time = NaN;
  private readonly scratch = new Vector3();

  update(root: Vector3, time: number, length: number): Vector3 {
    const dt = time - this.time, moved = this.root.distanceTo(root);
    if (!Number.isFinite(dt) || dt < 0 || dt > .1 || moved > .5 || (dt === 0 && moved > 1e-8)) {
      this.offset.set(0, 0, 0); this.velocity.set(0, 0, 0);
    } else if (dt > 0) {
      this.offset.addScaledVector(this.scratch.subVectors(root, this.root), -.5);
      const decay = Math.exp(-LEAF_DAMPING * dt), frequency = Math.sqrt(LEAF_STIFFNESS - LEAF_DAMPING * LEAF_DAMPING);
      const c = Math.cos(frequency * dt), s = Math.sin(frequency * dt) / frequency;
      this.scratch.copy(this.velocity).addScaledVector(this.offset, LEAF_DAMPING);
      this.velocity.multiplyScalar(c - LEAF_DAMPING * s).addScaledVector(this.offset, -LEAF_STIFFNESS * s).multiplyScalar(decay);
      this.offset.multiplyScalar(c).addScaledVector(this.scratch, s).multiplyScalar(decay);
      this.offset.clampLength(0, length * .18);
    }
    this.root.copy(root); this.time = time;
    return this.offset;
  }
}
