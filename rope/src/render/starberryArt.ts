import { Vec2 } from "../engine/vec2";
import { pointAlong, type StarberryPose, type StarberrySettings } from "../level/starberry";

export interface LeafFootprint { center: Vec2; radius: number }
export interface StarberryLeaf extends LeafFootprint {
  base: Vec2; root: Vec2; size: number; angle: number; variation: number;
}

/** Render-only crooked growth. Physics and berry grab positions stay authoritative. */
export function naturalStemPoint(path: readonly Vec2[], fraction: number, seed: number): Vec2 {
  const p = pointAlong(path, fraction);
  const phase = seed * 0.17;
  const envelope = Math.min(1, fraction * 12);
  return p.add(new Vec2(envelope * (Math.sin(fraction * 13 + phase) * 0.035
    + Math.sin(fraction * 29 + phase * 0.7) * 0.012), 0));
}

export function stemFraction(path: readonly Vec2[], root: Vec2): number {
  let total = 0, nearest = Infinity, at = 0;
  for (let i = 0; i < path.length; i++) {
    if (i) total += path[i]!.distanceTo(path[i - 1]!);
    const distance = path[i]!.distanceTo(root);
    if (distance < nearest) { nearest = distance; at = total; }
  }
  return total ? at / total : 0;
}

/** Conservative silhouettes include blade curvature and its full flutter envelope. */
export function starberryLeaves(path: readonly Vec2[], settings: StarberrySettings,
  berries: readonly StarberryPose[], occupied: LeafFootprint[] = []): StarberryLeaf[] {
  let length = 0;
  for (let i = 1; i < path.length; i++) length += path[i]!.distanceTo(path[i - 1]!);
  const count = Math.min(100, Math.ceil(length / 0.27 * settings.leafDensity));
  const leaves: StarberryLeaf[] = [];
  for (let i = 0; i < count; i++) {
    const noise = Math.sin(i * 127.1 + settings.seed * 3.17) * 43758.5453;
    const variation = noise - Math.floor(noise), side = i % 2 ? 1 : -1;
    const fraction = (i + 0.35 + variation * 0.3) / count;
    const root = naturalStemPoint(path, fraction, settings.seed);
    const size = (0.19 + variation * 0.065) * (1 - fraction * 0.15);
    const angle = side * (0.72 + variation * 0.5);
    const base = root.add(new Vec2(side * (0.035 + variation * 0.025), 0.02));
    const center = base.add(new Vec2(Math.sin(angle), Math.cos(angle)).mul(size * 0.48));
    const radius = size * 0.67;
    // Reserve the complete fruit silhouette plus an air gap, not just its centre.
    if (berries.some(b => b.fruit.distanceTo(center) < settings.radius * 1.06 + radius + 0.045)) continue;
    if (occupied.some(other => other.center.distanceTo(center) < radius + other.radius + 0.035)) continue;
    const leaf = { root, base, center, radius, size, angle, variation };
    occupied.push(leaf); leaves.push(leaf);
  }
  return leaves;
}

/** Entire blade stays behind even the back of the player/fruit, including flutter. */
export function leafDepth(ballRadius: number, berryRadius: number): number {
  return -Math.max(ballRadius, berryRadius, 0.22) - 0.16;
}
