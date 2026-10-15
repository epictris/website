import { Vec2 } from "../engine/vec2";
import { sampleVineCurve, vineMaterial, type VineCurvePoint } from "./vineCurve";
import { vineNodeCount, vineNodeFraction, vineRandom } from "./vineGrowth";

// Leaves are fixed to rest-length material stations, so they travel with a vine without
// changing number or jumping between links as the physics path bends.
export function forEachVineLeaf(
  path: readonly Vec2[], seed: number,
  emit: (x: number, y: number, side: number, length: number, tone: number, tx: number, ty: number, turn: number, fraction: number) => void,
  curve: readonly VineCurvePoint[] = sampleVineCurve(path),
  growthLength = curve.length ? vineMaterial(curve.at(-1)!) : 0,
): void {
  const total = curve.length ? vineMaterial(curve.at(-1)!) : 0;
  const count = vineNodeCount(growthLength);
  if (!count) return;
  for (let leaf = 0; leaf < count; leaf++) {
    const random = (salt: number): number => vineRandom(seed, leaf, salt);
    const pair = random(4) > .76 ? 2 : 1;
    const side = random(5) > .5 ? -1 : 1;
    for (let sibling = 0; sibling < pair; sibling++) {
      const fraction = Math.min(.94, vineNodeFraction(seed, leaf, count) + sibling * (.025 + random(6) * .09) / Math.max(growthLength, .1));
      const target = total * fraction;
      for (let i = 0; i < curve.length - 1; i++) {
        const a = curve[i]!;
        const b = curve[i + 1]!;
        const segment = vineMaterial(b) - vineMaterial(a);
        if (segment < 1e-6) continue;
        if (vineMaterial(b) >= target || i === curve.length - 2) {
          const t = Math.min(1, Math.max(0, (target - vineMaterial(a)) / segment));
          const tx = a.tx + (b.tx - a.tx) * t, ty = a.ty + (b.ty - a.ty) * t;
          const tangentLength = Math.hypot(tx, ty);
          emit(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t,
            sibling ? -side : side, (.08 + random(1 + sibling * 7) ** 1.35 * .25) * (1 - fraction * .3), Math.floor(random(2 + sibling * 7) * 3),
            tangentLength > 1e-6 ? tx / tangentLength : a.tx,
            tangentLength > 1e-6 ? ty / tangentLength : a.ty, (random(3 + sibling * 7) - .5) * 1.4, fraction);
          break;
        }
      }
    }
  }
}
