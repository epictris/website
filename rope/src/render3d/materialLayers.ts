// How a MATERIAL LAYER is drawn (docs/formations.md "Material layers"): its
// baked material's maps, worn by its rock through paintLayers.ts, and its
// mask. The game draws what was built (`built.maps` and the build's
// `mask.png`). The editor draws its own instead while it has one
// (`setMaterialLayerSource`): the material baked for the rock as it is now,
// and the mask computed live from the strokes, so painting shows the
// material as it goes, before anything is built.

import type * as THREE from "three";
import { decorationMaskFile } from "../formation/decoration";
import { materialLayerFiles } from "../formation/materialLayer";
import type { DecorationObjectData } from "../level/levelFormat";
import { paintLayerTexture, type PaintLayer } from "./paintLayers";

export interface MaterialLayerDraw {
  // The baked material's store hash.
  maps: string;
  mask: THREE.Texture;
}

export type MaterialLayerSource = (o: DecorationObjectData) => MaterialLayerDraw | null;

let source: MaterialLayerSource | null = null;

// The editor's: what it draws for a material layer, in place of what was
// built. Null puts the built ones back.
export function setMaterialLayerSource(s: MaterialLayerSource | null): void {
  source = s;
}

export function materialLayerDraw(o: DecorationObjectData): MaterialLayerDraw | null {
  if (source) return source(o);
  if (!o.built?.maps) return null;
  return { maps: o.built.maps, mask: paintLayerTexture(decorationMaskFile(o.built.hash), true) };
}

// The layer a rock wears for `o`, or null when there is nothing to draw yet.
export function materialPaintLayer(o: DecorationObjectData): PaintLayer | null {
  const draw = materialLayerDraw(o);
  if (!draw) return null;
  const files = materialLayerFiles(draw.maps);
  return {
    texture: paintLayerTexture(files.color),
    material: { surface: paintLayerTexture(files.surface, true), normal: paintLayerTexture(files.normal, true), mask: draw.mask },
    tag: o,
  };
}
