// The look of a berry vine (`level/starberry.ts`), shared by the 2D canvas,
// the editor overlay and the 3D layer so none of them has its own idea of
// where the cord or a stalk is. Render-only: nothing here reaches the sim.

import { Vec2 } from "../engine/vec2";
import { pointAlong } from "../level/starberry";

// The cord's drawn radius at `fraction` of the way down, metres: thinner than
// a plain vine (`VINE_VISUAL_RADIUS`, 0.03), tapering, with a little
// irregularity so it reads as grown rather than turned.
export function berryCordRadius(fraction: number, seed: number): number {
  return (0.02 - fraction * 0.009) * (1 + Math.sin(fraction * 47 + seed) * 0.12);
}

// The cord's colour: a dark woody brown, against a plain vine's green.
export const BERRY_CORD_COLOR = "#4a3423";

// A berry stalk's radius where it leaves the cord, metres; it tapers to about
// two thirds of that at the berry.
export const STALK_RADIUS = 0.013;
// How far the knot at the top of a berry stands above it, metres: the stalk
// runs into its top (`roundBerryAttachment`, `roundBerryKnot`).
export const STALK_KNOT_HEIGHT = 0.04;

// Fruit, calyx and the stalk's arrival tangent share one growth direction:
// UP, as Tris's reference has every berry - a fruit hangs from its stalk, so
// the stalk comes down into the top of it and the cap sits there - leaned a
// little toward where the stalk comes from (karin's axis pointed straight at
// it, which put the cap on the berry's shoulder).
export function roundBerryAttachment(root: Vec2, fruit: Vec2, radius: number): { axis: Vec2; end: Vec2; control: Vec2 } {
  const shoulder = root.add(fruit.sub(root).mul(0.6)).add(new Vec2(0, -0.06));
  const axis = new Vec2(0, -1).add(shoulder.sub(fruit).normalized().mul(0.15)).normalized();
  // Into the top of the knot, a little inside it, so the two are one piece.
  const end = fruit.add(axis.mul(radius + STALK_KNOT_HEIGHT * 0.8));
  const control = end.add(axis.mul(Math.max(0.035, root.distanceTo(fruit) * 0.22)));
  return { axis, end, control };
}

// Render-only crooked growth along the cord. Physics and the berries' grab
// positions stay where the sim has them.
export function naturalStemPoint(path: readonly Vec2[], fraction: number, seed: number): Vec2 {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += path[i]!.distanceTo(path[i - 1]!);
  const p = pointAlong(path, fraction * total);
  const phase = seed * 0.17;
  const envelope = Math.min(1, fraction * 12);
  return p.add(
    new Vec2(envelope * (Math.sin(fraction * 13 + phase) * 0.035 + Math.sin(fraction * 29 + phase * 0.7) * 0.012), 0),
  );
}

// The arc fraction of the point on `path` nearest `root` - on its segments, not
// just its vertices: the editor's rest path of a hanging vine is its two ends.
export function stemFraction(path: readonly Vec2[], root: Vec2): number {
  let total = 0;
  let along = 0;
  let nearest = Infinity;
  let at = 0;
  for (let i = 1; i < path.length; i++) total += path[i]!.distanceTo(path[i - 1]!);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const d = path[i]!.sub(a);
    const length = d.length();
    if (length === 0) continue;
    const t = Math.min(1, Math.max(0, root.sub(a).dot(d) / (length * length)));
    const distance = a.add(d.mul(t)).distanceTo(root);
    if (distance < nearest) {
      nearest = distance;
      at = along + length * t;
    }
    along += length;
  }
  return total ? at / total : 0;
}
