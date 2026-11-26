// A MATERIAL LAYER's build (docs/formations.md, "Material layers"): a
// library material (`assets-src/materials/<name>.blend`, a Principled BSDF
// authored in Blender) baked into one rock's paint UV by
// tools/blender/material_layer.py, through scripts/material-layer-build.ts.

import { sha256Hex } from "./sha256";

export interface MaterialLayerRequest {
  // The formation build it is baked onto (its `rock.blend` in the store).
  host: string;
  // The library material's name: its file's and the material's in it.
  material: string;
  // The sha256 of the library file's bytes, so an edit in Blender bakes anew.
  library: string;
  // The maps' side, texels; the rock's colour map side without one.
  side?: number;
}

export const MATERIAL_LAYER_FILES = ["color.png", "surface.png", "normal.png"] as const;

// A material's name is its library file's, lower case: what a level's
// `settings.material` holds.
export function materialLayerHash(r: MaterialLayerRequest): string {
  const { host, material, library, side } = r;
  return sha256Hex(JSON.stringify({ kind: "material-layer", host, material: material.toLowerCase(), library, side: side ?? null }));
}

// Where the library is, relative to rope/, and the dev API that lists it.
export const MATERIAL_LIBRARY_DIR = "assets-src/materials";
export const MATERIALS_API = "/api/materials";
export const MATERIAL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function materialLibraryFile(material: string): string {
  return `${MATERIAL_LIBRARY_DIR}/${material.toLowerCase()}.blend`;
}

// One material of the library, as the API lists it.
export interface MaterialLibraryEntry {
  name: string;
  // The sha256 of its file's bytes (a decoration's request's `library`).
  library: string;
}

// A material's name as the palette shows it.
export function materialLabel(name: string): string {
  return name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Where the game reads a built layer's maps.
export function materialLayerFiles(hash: string): { color: string; surface: string; normal: string } {
  return {
    color: `/generated/${hash}/color.png`,
    surface: `/generated/${hash}/surface.png`,
    normal: `/generated/${hash}/normal.png`,
  };
}
