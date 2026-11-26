import variants from './mushroomVariants.json';

export interface MushroomParameters {
  width: number;
  capHeight: number;
  stemHeight: number;
}
export function mushroomParameters(name: string, overrides?: Partial<MushroomParameters>): MushroomParameters | null {
  const base = variants.find(v => v.model === name);
  if (!base) return null;
  const positive = (v: number | undefined, fallback: number) => Number.isFinite(v) ? Math.max(.02, Math.min(20, v!)) : fallback;
  return {
    width: positive(overrides?.width, base.width),
    capHeight: positive(overrides?.capHeight, base.capHeight),
    stemHeight: positive(overrides?.stemHeight, base.stemHeight),
  };
}
/**
 * Where a mushroom's own light sits, in the model's frame (physics y-down,
 * metres): the middle of the cap, at the model's depth. The cap glows by its
 * emission maps; a point light INSIDE it lights what is around the mushroom
 * and none of the mushroom itself, since every surface of the cap, the gills
 * and the stem faces away from it. A light at the body origin with the
 * default stand-off (`DEFAULT_LIGHT_Z`) sat level with the gills and a third
 * of a metre in front, and lit the mushroom from the side.
 */
export function mushroomCapCentre(p: MushroomParameters, scale = 1): { x: number; y: number } {
  return { x: 0, y: -p.capHeight * scale * .5 };
}
/** Same elliptical dome profile as the procedural mesh, in the physics y-down frame. */
export function mushroomOutline(p: MushroomParameters, scale = 1) {
  const verts = Array.from({ length: 17 }, (_, i) => {
    const a = Math.PI * i / 16;
    return { x: -Math.cos(a) * p.width * .5 * scale, y: -Math.sin(a) * p.capHeight * scale };
  });
  verts.push({ x: p.width * .42 * scale, y: .045 * scale }, { x: -p.width * .42 * scale, y: .045 * scale });
  return verts;
}
