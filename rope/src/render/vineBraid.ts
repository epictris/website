import { Vec2 } from "../engine/vec2";
import { VINE_VISUAL_RADIUS } from "../level/vines";

// Follow the simulated centreline with three continuous strands. The third
// coordinate lifts each strand in front of and behind the gameplay plane.
export function forEachBraidSegment(
  path: readonly Vec2[], seed: number,
  emit: (ax: number, ay: number, az: number, bx: number, by: number, bz: number, strand: number) => void,
): void {
  let distance = 0;
  const phase = (seed % 997) * 2.399963229728653;
  const pitch = 0.24;
  const spread = VINE_VISUAL_RADIUS * 0.62;
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
        const offset = phase + strand * Math.PI * 2 / 3;
        const p0 = offset + (distance + length * t0) * Math.PI * 2 / pitch;
        const p1 = offset + (distance + length * t1) * Math.PI * 2 / pitch;
        emit(
          a.x + dx * t0 + nx * Math.cos(p0) * spread,
          a.y + dy * t0 + ny * Math.cos(p0) * spread,
          Math.sin(p0) * spread,
          a.x + dx * t1 + nx * Math.cos(p1) * spread,
          a.y + dy * t1 + ny * Math.cos(p1) * spread,
          Math.sin(p1) * spread,
          strand,
        );
      }
    }
    distance += length;
  }
}
