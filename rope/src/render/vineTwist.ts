import { vineMaterial, type VineCurvePoint } from "./vineCurve";

// A render-owned torsional rod on REST coordinates. Planar bending transports
// the section normal (-ty, tx, 0) without adding axial roll. Only differential
// extension of a helical bundle drives twist: its preferred twist density
// relaxes under tension. Both tied ends hold their original material angle.
// This is not a 3D rod solver: angular torque does not feed back into gameplay.
export class VineTwist {
  private angles = new Float64Array(0);
  private velocities = new Float64Array(0);
  private preferred = new Float64Array(0);
  private time = NaN;
  private remainder = 0;
  private length = 0;

  reset(): void { this.time = NaN; this.remainder = 0; this.angles.fill(0); this.velocities.fill(0); }

  // The roll at a material station, as the last `update` left it: the same
  // interpolation `update` writes into the curve, for a caller holding only
  // link points (the 3D braid's pose, one roll per link).
  angleAt(material: number): number {
    const count = this.angles.length;
    if (count < 2 || !(this.length > 0)) return 0;
    const h = this.length / (count - 1);
    const u = Math.max(0, Math.min(count - 1, material / h)), i = Math.min(count - 2, Math.floor(u));
    return this.angles[i]! * (1 - (u - i)) + this.angles[i + 1]! * (u - i);
  }

  update(curve: readonly VineCurvePoint[], time: number, attachedAtBothEnds: boolean): void {
    if (!curve.length) return;
    const length = vineMaterial(curve.at(-1)!);
    // Below the bundle's own diameter there is no resolved torsional span.
    // Avoid arbitrarily many CFL substeps on a nearly coincident attachment.
    if (!attachedAtBothEnds || length < .02) { this.reset(); for (const p of curve) p.twist = 0; return; }
    const count = Math.max(3, Math.min(129, Math.ceil(length / .08) + 1));
    let dt = time - this.time;
    if (count !== this.angles.length || length !== this.length) {
      this.angles = new Float64Array(count); this.velocities = new Float64Array(count);
      this.preferred = new Float64Array(count - 1); this.length = length; this.reset();
      dt = NaN;
    }
    const h = length / (count - 1);
    let ring = 0;
    for (let i = 0; i < count - 1; i++) {
      const station = (i + .5) * h;
      while (ring + 1 < curve.length - 1 && vineMaterial(curve[ring + 1]!) < station) ring++;
      const a = curve[ring]!, b = curve[Math.min(ring + 1, curve.length - 1)]!;
      const t = Math.max(0, Math.min(1, (station - vineMaterial(a)) / Math.max(1e-8, vineMaterial(b) - vineMaterial(a))));
      const stretch = (a.stretch ?? 1) * (1 - t) + (b.stretch ?? 1) * t;
      // Compression folds a slack cord; it does not wind the braid tighter.
      this.preferred[i] = -6 * Math.max(0, Math.min(.15, stretch - 1));
    }
    if (!Number.isFinite(dt) || dt < 0 || dt > .1) this.reset();
    else if (dt > 0) {
      // CFL-safe substeps even for short authored spans. Damping dissipates
      // torsional waves instead of attaching a wall-clock sine to each ring.
      const step = Math.min(1 / 240, h / 4);
      this.remainder += dt;
      while (this.remainder >= step) {
        for (let i = 1; i < count - 1; i++) {
          const left = (this.angles[i]! - this.angles[i - 1]!) / h - this.preferred[i - 1]!;
          const right = (this.angles[i + 1]! - this.angles[i]!) / h - this.preferred[i]!;
          this.velocities[i] = (this.velocities[i]! + 2.8 ** 2 * (right - left) / h * step) * Math.exp(-5 * step);
        }
        for (let i = 1; i < count - 1; i++) {
          const angle = this.angles[i]! + this.velocities[i]! * step;
          this.angles[i] = Math.max(-.45, Math.min(.45, angle));
          if (Math.abs(angle) > .45) this.velocities[i] = 0;
        }
        this.remainder -= step;
      }
    }
    this.time = time;
    for (const p of curve) {
      const u = Math.max(0, Math.min(count - 1, vineMaterial(p) / h)), i = Math.min(count - 2, Math.floor(u));
      p.twist = this.angles[i]! * (1 - (u - i)) + this.angles[i + 1]! * (u - i);
    }
  }
}
