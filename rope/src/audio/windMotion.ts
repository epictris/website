// Acceleration here means gaining speed, not changing direction: centripetal
// acceleration during a constant-speed swing must not sustain a fake boost.
export class WindMotion {
  private previousSpeed: number | null = null;
  private acceleration = 0;

  reset(): void {
    this.previousSpeed = null;
    this.acceleration = 0;
  }

  observe(speed: number, dt: number, submerged: number): { speed: number; acceleration: number } {
    if (!Number.isFinite(speed) || !Number.isFinite(dt) || dt <= 0) {
      this.reset();
      return { speed: 0, acceleration: 0 };
    }
    const raw = this.previousSpeed === null ? 0 : (speed - this.previousSpeed) / dt;
    this.previousSpeed = speed;
    const target = Math.max(0, Math.min(30, raw));
    const follow = target > this.acceleration ? 0.045 : 0.14;
    this.acceleration += (target - this.acceleration) * (1 - Math.exp(-dt / follow));
    const dry = Math.max(0, Math.min(1, 1 - submerged));
    return { speed: Math.max(0, speed) * dry, acceleration: this.acceleration * dry };
  }
}
