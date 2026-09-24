import { Vec2 } from "../engine/vec2";
import { VINE_VISUAL_RADIUS } from "../level/vines";

// Follow the simulated centreline with three continuous strands. The third
// coordinate lifts each strand in front of and behind the gameplay plane.
export function forEachBraidSegment(
  path: readonly Vec2[], seed: number,
  emit: (ax: number, ay: number, az: number, bx: number, by: number, bz: number, strand: number, girth: number) => void,
): void {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) total += path[i]!.distanceTo(path[i + 1]!);
  let distance = 0;
  const phase = (seed % 997) * 2.399963229728653;
  const twist = (d: number): number => phase + d * Math.PI * 2 / 0.24 +
    0.62 * Math.sin(d * 2.7 + phase * 0.37) + 0.23 * Math.sin(d * 5.8 + phase * 0.81);
  const tip = (d: number): number => {
    const t = Math.max(0, Math.min(1, (total - d) / 0.18));
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) continue;
    const nx = -dy / length;
    const ny = dx / length;
    const steps = Math.ceil(length / 0.035);
    for (let j = 0; j < steps; j++) {
      const t0 = j / steps;
      const t1 = (j + 1) / steps;
      for (let strand = 0; strand < 3; strand++) {
        const d0 = distance + length * t0;
        const d1 = distance + length * t1;
        const offset = strand * Math.PI * 2 / 3;
        const p0 = offset + twist(d0);
        const p1 = offset + twist(d1);
        const spreadAt = (d: number): number => VINE_VISUAL_RADIUS * 0.62 *
          Math.max(0.55, 0.84 + 0.23 * Math.sin(d * 3.3 + phase + strand * 1.7) +
            0.08 * Math.sin(d * 7.1 + strand * 2.3)) * (0.08 + 0.92 * tip(d));
        const girthAt = (d: number): number =>
          Math.max(0.63, 0.86 + 0.17 * Math.sin(d * 4.3 + phase + strand * 2.1) +
            0.08 * Math.sin(d * 8.2 + strand)) * (0.025 + 0.975 * tip(d));
        const spread0 = spreadAt(d0);
        const spread1 = spreadAt(d1);
        emit(
          a.x + dx * t0 + nx * Math.cos(p0) * spread0,
          a.y + dy * t0 + ny * Math.cos(p0) * spread0,
          Math.sin(p0) * spread0,
          a.x + dx * t1 + nx * Math.cos(p1) * spread1,
          a.y + dy * t1 + ny * Math.cos(p1) * spread1,
          Math.sin(p1) * spread1,
          strand,
          (girthAt(d0) + girthAt(d1)) * 0.5,
        );
      }
    }
    distance += length;
  }
}
