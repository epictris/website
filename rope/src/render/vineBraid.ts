import { Vec2 } from "../engine/vec2";
import { VINE_VISUAL_RADIUS } from "../level/vines";
import { sampleVineCurve, vineMaterial, type VineCurvePoint } from "./vineCurve";
import { vineNodeCount, vineNodeFraction, vineRandom } from "./vineGrowth";

// Shared by tube rings and leaf roots: attachments sit on an actual strand,
// rather than a fixed offset from the centreline that can leave a visible gap.
export function forEachBraidSection(
  seed: number, fraction: number, growthLength: number,
  emit: (across: number, depth: number, radius: number, strand: number) => void,
  attachedAtBothEnds = false, rotation = 0, stretch = 1,
): void {
  const d = fraction * growthLength, phase = (seed % 997) * 2.399963229728653;
  const t = Math.max(0, Math.min(1, (growthLength - d) / Math.min(.18, growthLength * .3)));
  const tip = attachedAtBothEnds ? 1 : t * t * (3 - 2 * t);
  const pitch = .27 + vineRandom(seed, 0, 30) * .13; // metres per turn
  const slow = 2.8 + vineRandom(seed, 0, 31) * 1.6, fast = 7 + vineRandom(seed, 0, 32) * 3;
  // Integrate a strictly positive, smoothly varying twist rate. The braid
  // loosens and tightens without reversing or kinking at a growth interval.
  const twist = rotation + phase + Math.PI * 2 / pitch * (d +
    .56 / slow * (Math.sin(d * slow + phase) - Math.sin(phase)) +
    .24 / fast * (Math.sin(d * fast + phase * .63) - Math.sin(phase * .63)));
  let nodeSwell = 0;
  const nodes = vineNodeCount(growthLength);
  for (let node = 0; node < nodes; node++) {
    const width = .022 + .03 * vineRandom(seed, node, 33); // metres
    const near = (d - vineNodeFraction(seed, node, nodes) * growthLength) / width;
    nodeSwell += (.08 + .12 * vineRandom(seed, node, 34)) * Math.exp(-near * near);
  }
  // A tied span has no growing tip. Slight thinning under tension preserves
  // bundle volume; compression is not allowed to inflate overlapping links.
  const taper = (attachedAtBothEnds ? 1 - .12 * Math.sin(Math.PI * fraction) : 1 - .3 * fraction) *
    (.025 + .975 * tip) * (1 + nodeSwell) / Math.sqrt(Math.max(1, Math.min(1.3, stretch)));
  const r0 = VINE_VISUAL_RADIUS * .52 * taper * (1.08 + .12 * Math.sin(d * 2.9 + phase));
  const r1 = VINE_VISUAL_RADIUS * .52 * taper * (.89 + .10 * Math.sin(d * 4.1 + phase + 2));
  const r2 = VINE_VISUAL_RADIUS * .52 * taper * (.73 + .085 * Math.sin(d * 3.3 + phase + 4));
  // Pack unequal circles in a tangent triangle so the stems remain touching.
  const ab = r0 + r1, ac = r0 + r2, bc = r1 + r2;
  const cx = (ac * ac + ab * ab - bc * bc) / (2 * ab), cy = Math.sqrt(Math.max(0, ac * ac - cx * cx));
  const centreX = (ab + cx) / 3, centreY = cy / 3;
  for (let strand = 0; strand < 3; strand++) {
    const px = (strand === 0 ? 0 : strand === 1 ? ab : cx) - centreX;
    const py = (strand === 2 ? cy : 0) - centreY;
    emit(px * Math.cos(twist) - py * Math.sin(twist), px * Math.sin(twist) + py * Math.cos(twist),
      strand === 0 ? r0 : strand === 1 ? r1 : r2, strand);
  }
}

export interface VineLeafAttachment { across: number; depth: number; }
export function braidLeafAttachment(
  seed: number, fraction: number, growthLength: number, side: number, out: VineLeafAttachment,
  attachedAtBothEnds = false, rotation = 0, stretch = 1,
): void {
  let outermost = -Infinity;
  forEachBraidSection(seed, fraction, growthLength, (across, depth, radius) => {
    const score = side * across + radius;
    if (score <= outermost) return;
    outermost = score;
    // The 2D silhouette and the 3D fallback start outside the ridged surface;
    // the 3D renderer refines this against the actual tube triangles.
    out.across = across + side * radius * 1.03;
    out.depth = depth;
  }, attachedAtBothEnds, rotation, stretch);
}

// Follow the simulated centreline with three continuous strands. The third
// coordinate lifts each strand in front of and behind the gameplay plane.
export function forEachBraidPoint(
  curve: readonly VineCurvePoint[], seed: number,
  emit: (index: number, x: number, y: number, z: number, strand: number, girth: number) => void,
  growthLength = curve.length ? vineMaterial(curve.at(-1)!) : 0,
  attachedAtBothEnds = false,
): void {
  const total = curve.length ? vineMaterial(curve.at(-1)!) : 0;
  for (let i = 0; i < curve.length; i++) {
    const p = curve[i]!;
    forEachBraidSection(seed, vineMaterial(p) / total, growthLength, (across, depth, radius, strand) => {
      emit(i, p.x - p.ty * across, p.y + p.tx * across, depth, strand, radius / (VINE_VISUAL_RADIUS * .52));
    }, attachedAtBothEnds, p.twist ?? 0, p.stretch ?? 1);
  }
}

export function forEachBraidSegment(
  path: readonly Vec2[], seed: number,
  emit: (ax: number, ay: number, az: number, bx: number, by: number, bz: number, strand: number, girth: number) => void,
  curve: readonly VineCurvePoint[] = sampleVineCurve(path),
  growthLength = curve.length ? vineMaterial(curve.at(-1)!) : 0,
  attachedAtBothEnds = false,
): void {
  const previous = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  forEachBraidPoint(curve, seed, (i, x, y, z, strand, girth) => {
    const p = previous[strand]!;
    if (i) emit(p[0]!, p[1]!, p[2]!, x, y, z, strand, (p[3]! + girth) * .5);
    p[0] = x; p[1] = y; p[2] = z; p[3] = girth;
  }, growthLength, attachedAtBothEnds);
}
