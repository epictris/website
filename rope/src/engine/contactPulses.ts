import type { CollisionObject2D, PhysicsBody2D } from "./body";
import type { ContactConstraint } from "./world";

/** Observation only: the latest fresh contact on a launch surface, retained
 * across physics steps so render frames cannot miss a brief bounce. No solver
 * reads these values; a WeakMap releases removed surfaces automatically. */
export class ContactPulses {
  time = 0;
  readonly latest = new WeakMap<CollisionObject2D, { time: number; impulse: number }>();
  private touching = new Set<string>();

  scan(contacts: readonly ContactConstraint[], dt: number): void {
    this.time += dt;
    const touching = new Set<string>();
    const hits = new Map<PhysicsBody2D, number>();
    const visit = (body: PhysicsBody2D, other: PhysicsBody2D, impulse: number): void => {
      if (body.launchSpeed <= 0) return;
      const key = `${body.id}:${other.id}`;
      touching.add(key);
      if (!this.touching.has(key)) hits.set(body, (hits.get(body) ?? 0) + impulse);
    };
    for (const c of contacts) {
      if (c.normalImpulse <= 0) continue;
      visit(c.a, c.b, c.normalImpulse);
      visit(c.b, c.a, c.normalImpulse);
    }
    for (const [body, impulse] of hits) this.latest.set(body, { time: this.time, impulse });
    this.touching = touching;
  }
}
