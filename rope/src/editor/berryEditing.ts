import { Vec2 } from "../engine/vec2";
import type { StarberrySettings } from "../level/starberry";

export function berrySides(settings: StarberrySettings): number[] {
  return settings.sides ??= settings.positions.map((_, i) => i % 2 ? 1 : -1);
}

/** A new berry starts in the largest free interval, then can be dragged anywhere. */
export function addBerry(settings: StarberrySettings): void {
  if (settings.positions.length >= 8) return;
  const sides = berrySides(settings), sorted = [0.08, ...settings.positions.slice().sort((a, b) => a - b), 1];
  let gap = -1, position = 0.5;
  for (let i = 1; i < sorted.length; i++) {
    const distance = sorted[i]! - sorted[i - 1]!;
    if (distance > gap) { gap = distance; position = (sorted[i]! + sorted[i - 1]!) / 2; }
  }
  sides.push(settings.positions.length % 2 ? 1 : -1);
  settings.positions.push(position);
}

export function removeBerry(settings: StarberrySettings, index: number): void {
  berrySides(settings).splice(index, 1);
  settings.positions.splice(index, 1);
}

/** Arc fraction of the closest point on a hanging or spanning vine. */
export function berryPositionAt(path: readonly Vec2[], target: Vec2): number {
  let total = 0, along = 0, best = Infinity, nearest = 0;
  for (let i = 1; i < path.length; i++) total += path[i]!.distanceTo(path[i - 1]!);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, d = path[i]!.sub(a), length = d.length();
    if (!length) continue;
    const delta = target.sub(a);
    const t = Math.min(1, Math.max(0, (delta.x * d.x + delta.y * d.y) / (length * length)));
    const distance = a.add(d.mul(t)).distanceTo(target);
    if (distance < best) { best = distance; nearest = along + length * t; }
    along += length;
  }
  return Math.min(1, Math.max(0.08, total ? nearest / total : 0.5));
}

export function moveBerry(settings: StarberrySettings, index: number, fraction: number): void {
  const position = Math.min(1, Math.max(0.08, fraction));
  // Don't collapse two targets into one when the settings are normalised for play.
  if (settings.positions.some((p, i) => i !== index && Math.abs(p - position) < 0.002)) return;
  settings.positions[index] = position;
}
