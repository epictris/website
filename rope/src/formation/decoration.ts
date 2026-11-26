// A decoration's build request and the hash that names its result
// (docs/formations.md, "Decorations"); DOM-free and wasm-free, as recipe.ts.

import type { DecorationAnchor, DecorationKind, DecorationObjectData, DecorationSettings, PaintStamp } from "../level/levelFormat";
import { PAINTED_DECORATIONS } from "../level/levelFormat";
import { canonical } from "./recipe";
import { sha256Hex } from "./sha256";

// Bumped when what a request means changes.
export const DECORATION_VERSION = 1;

export interface DecorationRequest {
  version: number;
  // The formation build it grows on.
  host: string;
  kind: DecorationKind;
  seed?: number;
  settings?: DecorationSettings;
  // The level's focal length, mm (the detail budget's lens).
  lens?: number;
  // A placed one: where it is grown. A painted one: its strokes.
  at?: DecorationAnchor;
  stamps?: PaintStamp[];
  // A texture layer (`isTextureLayer`): built as a map in its rock's paint UV,
  // not a mesh, so never the same build as the shell it was before
  // 2026-11-25.
  layer?: true;
  // A material layer's library file's sha256 (`materialLibraries`), so an
  // edit of the material in Blender asks for a new build.
  library?: string;
}

export function isPainted(kind: DecorationKind): boolean {
  return PAINTED_DECORATIONS.includes(kind);
}

// What growing `d` on the build `host` asks for. A placed decoration is grown
// where it is drawn (`onRock`); a painted one from its strokes. A material
// layer is its material (`library`: the library file's sha256; null when it is
// not known, and then there is no request) and its strokes: it has no seed,
// and no growth to budget by the lens.
export function decorationRequest(
  d: Pick<DecorationObjectData, "kind" | "seed" | "settings" | "anchor" | "onRock">,
  host: string,
  strokes: readonly PaintStamp[] | undefined,
  lens?: number,
  library?: string | null,
): DecorationRequest | null {
  const material = isMaterialLayer(d);
  if (material && !library) return null;
  return canonical({
    version: DECORATION_VERSION,
    host,
    kind: d.kind,
    ...(d.seed !== undefined && !material ? { seed: d.seed } : {}),
    ...(d.settings ? { settings: d.settings } : {}),
    ...(lens !== undefined && !material ? { lens } : {}),
    ...(isPainted(d.kind) ? { stamps: strokes ?? [] } : { at: d.onRock ?? d.anchor }),
    ...(isTextureLayer(d) ? { layer: true } : {}),
    ...(material ? { library } : {}),
  }) as DecorationRequest;
}

export function decorationHash(r: DecorationRequest): string {
  return sha256Hex(JSON.stringify(canonical(r)));
}

export function decorationFile(hash: string): string {
  return `/generated/${hash}/decoration.glb`;
}

// A TEXTURE LAYER (docs/formations.md, "Texture layers"): a painted
// decoration that grows no mesh but a map in its rock's paint UV, which the
// game lays over the rock's colour - a texture-only moss today. Its build is
// `layer.png` (`decorationLayerFile`), not `decoration.glb`.
// A material layer is one too, built as a mask (`decorationMaskFile`) over
// its baked material (`built.maps`).
export function isTextureLayer(d: Pick<DecorationObjectData, "kind" | "settings">): boolean {
  return (d.kind === "moss" && d.settings?.["kind"] === "TEXTURE") || d.kind === "material";
}

export function decorationLayerFile(hash: string): string {
  return `/generated/${hash}/layer.png`;
}

// A MATERIAL LAYER (docs/formations.md, "Material layers"): a library
// material laid on its rock where its strokes are. Which material is its
// `settings.material`, the library file's name (`materialLibraryFile`).
export function isMaterialLayer(d: Pick<DecorationObjectData, "kind">): boolean {
  return d.kind === "material";
}

export function materialOf(d: Pick<DecorationObjectData, "settings">): string {
  return String(d.settings?.["material"] ?? "");
}

export function decorationMaskFile(hash: string): string {
  return `/generated/${hash}/mask.png`;
}
