import { Vec2 } from "../engine/vec2";

/** Lengths use the containing level's units; positions are fractions of the vine. */
export interface StarberrySettings {
  /** Omitted in older levels: the original star-shaped fruit. Appearance only. */
  appearance?: "star" | "round";
  positions: number[];
  /** Optional explicit branch sides, in berry order. Older plants alternate. */
  sides?: number[];
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
  const entries = (value?.positions ?? [0.28, 0.58, 0.88])
    .map((p, i) => ({ p, i })).filter(e => Number.isFinite(e.p))
    .map(e => ({ ...e, p: Math.min(1, Math.max(0.08, e.p)) }));
  const unique = entries.filter((e, i) => entries.findIndex(other => other.p === e.p) === i).slice(0, 8);
  return {
    ...(value?.appearance === "round" ? { appearance: "round" as const } : {}),
    positions: unique.map(e => e.p),
    ...(value?.sides ? { sides: unique.map(e => value.sides![e.i] === 1 ? 1 : value.sides![e.i] === -1 ? -1 : e.i % 2 ? 1 : -1) } : {}),
    radius: number(value?.radius, value?.appearance === "round" ? 0.125 : 0.25, 0.06, 0.65),
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

export function branchDirection(index: number, settings?: StarberrySettings): Vec2 {
  const side = settings?.sides?.[index] ?? (index % 2 === 0 ? -1 : 1);
  return new Vec2(side * 0.78, 0.626).normalized();
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
    const root = pointAlong(path, p), direction = branchDirection(i, settings);
    return { root, joint: root.add(direction.mul(settings.stemLength * 0.5)),
      fruit: root.add(direction.mul(settings.stemLength)), held: false };
  });
}
