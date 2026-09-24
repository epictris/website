import { Vec2 } from "../engine/vec2";

// Leaves are fixed to arc length, so they travel with a swinging vine without
// changing number or jumping between links as the physics path bends.
export function forEachVineLeaf(
  path: readonly Vec2[], seed: number,
  emit: (x: number, y: number, side: number, length: number, tone: number) => void,
): void {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) total += path[i]!.distanceTo(path[i + 1]!);
  const count = Math.max(0, Math.round(total / 0.75));
  if (!count) return;
  for (let leaf = 0; leaf < count; leaf++) {
    const random = (salt: number): number => {
      const n = Math.sin((seed + 1) * 127.1 + (leaf + 1) * 311.7 + salt * 74.7) * 43758.5453;
      return n - Math.floor(n);
    };
    const target = total * (leaf + 0.3 + random(0) * 0.4) / count;
    let walked = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      const segment = a.distanceTo(b);
      if (segment < 1e-6) continue;
      if (walked + segment >= target || i === path.length - 2) {
        const t = Math.min(1, Math.max(0, (target - walked) / segment));
        emit(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t,
          leaf % 2 ? -1 : 1, 0.108 + random(1) * 0.082, Math.floor(random(2) * 3));
        break;
      }
      walked += segment;
    }
  }
}
