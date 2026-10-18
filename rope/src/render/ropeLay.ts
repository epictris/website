import { VINE_VISUAL_RADIUS } from "../level/vines";
import { vineMaterial, type VineCurvePoint } from "./vineCurve";

// A braided vine drawn as laid rope (`VineData.rope`): three equal strands
// twisted about the cord at one fixed lay, right-handed, as a hawser-laid rope
// is. Unlike the braid nothing here grows - no gauge drift, no pitch drift, no
// nodes, no tapered tip - so the seed only sets where the lay starts.
//
// The strands are packed a little CLOSER than tangent circles (whose centres
// would sit 1.155 radii out): a laid rope's strands are pressed into each
// other, and tangent circles leave a slot down every groove that reads as
// three cords rather than one rope - while much closer fills the groove in
// and the strands stop reading as round.
export const ROPE_STRAND_RADIUS = VINE_VISUAL_RADIUS * .5;
const STRAND_OFFSET = ROPE_STRAND_RADIUS * 1.1;
// Metres per turn: 2.7 rope diameters, a hard lay, which stands the strands at
// about 49° to the axis on the crowns.
export const ROPE_LAY = 2.7 * 2 * (STRAND_OFFSET + ROPE_STRAND_RADIUS);

// A rope's colour when the vine has none of its own: manila.
export const ROPE_COLOR = "#c99b55";

// The three strands' centres and radius at material distance `d` along the
// rope, in the centreline's own frame (across the cord, out of the plane).
// `rotation` is the twist rod's roll there and `stretch` its links' strain,
// which narrows the rope by `1 / sqrt(stretch)` exactly as it does the braid.
export function forEachRopeSection(
  seed: number, d: number,
  emit: (across: number, depth: number, radius: number, strand: number) => void,
  rotation = 0, stretch = 1,
): void {
  const squeeze = 1 / Math.sqrt(Math.max(1, Math.min(1.3, stretch)));
  const lay = rotation + (seed % 997) * 2.399963229728653 + Math.PI * 2 * d / ROPE_LAY;
  for (let strand = 0; strand < 3; strand++) {
    const angle = lay + strand * Math.PI * 2 / 3;
    emit(STRAND_OFFSET * squeeze * Math.cos(angle), STRAND_OFFSET * squeeze * Math.sin(angle),
      ROPE_STRAND_RADIUS * squeeze, strand);
  }
}

// `forEachBraidPoint` for the rope: each strand's centre at every curve
// sample, the third coordinate out of the gameplay plane.
export function forEachRopePoint(
  curve: readonly VineCurvePoint[], seed: number,
  emit: (index: number, x: number, y: number, z: number, strand: number, radius: number) => void,
): void {
  for (let i = 0; i < curve.length; i++) {
    const p = curve[i]!;
    forEachRopeSection(seed, vineMaterial(p), (across, depth, radius, strand) => {
      emit(i, p.x - p.ty * across, p.y + p.tx * across, depth, strand, radius);
    }, p.twist ?? 0, p.stretch ?? 1);
  }
}
