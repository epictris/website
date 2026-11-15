import type { CollisionObject2D, PhysicsBody2D } from "./body";
import type { ContactConstraint } from "./world";

/** Observation only: the latest fresh contact on a launch surface, retained
 * across physics steps so render frames cannot miss a brief bounce. No solver
 * reads these values; a WeakMap releases removed surfaces automatically. */
export class ContactPulses {
  time = 0;
  readonly latest = new WeakMap<CollisionObject2D, { time: number; impulse: number; directionX: number; directionY: number }>();
  private touching = new Set<string>();

  scan(contacts: readonly ContactConstraint[], dt: number): void {
    this.time += dt;
    const touching = new Set<string>();
    const hits = new Map<PhysicsBody2D, { impulse: number; directionX: number; directionY: number }>();
    const visit = (body: PhysicsBody2D, other: PhysicsBody2D, impulse: number, nx: number, ny: number): void => {
      if (body.launchSpeed <= 0) return;
      const key = `${body.id}:${other.id}`;
      touching.add(key);
      if (!this.touching.has(key)) {
        const hit = hits.get(body) ?? { impulse: 0, directionX: 0, directionY: 0 };
        hit.impulse += impulse;
        hit.directionX += nx * impulse;
        hit.directionY += ny * impulse;
        hits.set(body, hit);
      }
    };
    for (const c of contacts) {
      if (c.normalImpulse <= 0) continue;
      visit(c.a, c.b, c.normalImpulse, -c.normal.x, -c.normal.y);
      visit(c.b, c.a, c.normalImpulse, c.normal.x, c.normal.y);
    }
    for (const [body, hit] of hits) this.latest.set(body, { time: this.time, ...hit });
    this.touching = touching;
  }
}
