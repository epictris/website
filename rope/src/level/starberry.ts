import { Vec2 } from "../engine/vec2";

/** Lengths use the containing level's units; positions are fractions of the vine. */
export interface StarberrySettings {
  positions: number[];
  radius: number;
  stemLength: number;
  leafDensity: number;
  sway: number;
  glow: number;
  seed: number;
}

export function starberrySettings(value?: Partial<StarberrySettings>): StarberrySettings {
  const number = (v: number | undefined, fallback: number, min: number, max: number) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, v!)) : fallback;
  const positions = (value?.positions ?? [0.28, 0.58, 0.88])
    .filter(Number.isFinite).map(p => Math.min(1, Math.max(0.08, p)));
  return {
    positions: [...new Set(positions)].sort((a, b) => a - b).slice(0, 8),
    radius: number(value?.radius, 0.25, 0.06, 0.65),
    stemLength: number(value?.stemLength, 0.38, 0.2, 1.5),
    leafDensity: number(value?.leafDensity, 0.95, 0.25, 2.5),
    sway: number(value?.sway, 0.65, 0, 1),
    glow: number(value?.glow, 1.5, 0, 3),
    seed: Math.floor(number(value?.seed, 1701, 0, 2147483647)),
  };
}

export interface StarberryPose {
  root: Vec2;
  joint: Vec2;
  fruit: Vec2;
  held: boolean;
}

export function branchDirection(index: number): Vec2 {
  return new Vec2(index % 2 === 0 ? -0.78 : 0.78, 0.626).normalized();
}

export function pointAlong(path: readonly Vec2[], fraction: number): Vec2 {
  let length = 0;
  for (let i = 1; i < path.length; i++) length += path[i]!.distanceTo(path[i - 1]!);
  let remaining = length * fraction;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!, d = a.distanceTo(b);
    if (remaining <= d && d > 0) return a.add(b.sub(a).mul(remaining / d));
    remaining -= d;
  }
  return path[path.length - 1] ?? Vec2.ZERO;
}

export function restStarberries(path: readonly Vec2[], settings: StarberrySettings): StarberryPose[] {
  return settings.positions.map((p, i) => {
    const root = pointAlong(path, p), direction = branchDirection(i);
    return { root, joint: root.add(direction.mul(settings.stemLength * 0.5)),
      fruit: root.add(direction.mul(settings.stemLength)), held: false };
  });
}
