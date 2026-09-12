// What a level will download, worked out from the level data alone.
//
// This is the same question `Scene3D.setLevel` answers by BUILDING the scene -
// every geometry object's surface, every prop, the sky, the water maps - asked
// without a canvas, a GPU or a body. It exists because the answer is needed
// before any of that: the preload list inlined into `index.html` (see
// `preloadManifest` in vite.config.ts) is what lets the page start fetching
// 26 MB at first paint instead of after the whole module graph has landed, and
// a build step cannot build a scene.
//
// IT MUST AGREE WITH THE SCENE, and nothing here can prove that it does - the
// two walk the same data by different routes. The guard is at the other end:
// `download.ts` warns in dev whenever a file is asked for that the preload list
// did not name, so drift shows up the first time the level is played rather
// than as a bar that stops at 94%.
//
// Over-naming a file is the cheaper mistake (a wasted download) and under-naming
// it is nearly free too (the app fetches it when it gets there, a beat late), so
// this is deliberately a resolver with no cleverness in it: walk everything,
// resolve each name exactly as the renderer's own `surfaceName` does, and let
// the set do the deduplicating.

import type { RawLevelData } from "../level/levelFormat";
import { normalizeLevelData } from "../level/levelFormat";
import {
  emissiveMapName,
  HDRI_ASSETS,
  IRON_SURFACE,
  MESH_ASSETS,
  RAW_ASSETS,
  surfaceName,
  TEXTURE_ASSETS,
  textureMaps,
} from "./assets";

// One stored file, as the preloader needs it: where to get it and what it
// weighs (see `TextureMap.bytes`).
export interface StoredFile {
  file: string;
  bytes: number;
}

// Every stored file the 3D scene will request for this level, in roughly the
// order it will request them - the sky and the avatar first, then the bodies in
// authored order - so a connection that cannot carry all of it at once carries
// the most visible parts first.
export function levelStoredFiles(raw: RawLevelData): StoredFile[] {
  // Normalised, not scaled: the units are irrelevant here, but a level still in
  // the retired flat form only grows its geometry objects (and so its texture
  // names) on the way through this gate. `LEVEL_2` is one - it comes from the
  // Godot extractor - so skipping it would report a level with no surfaces at
  // all.
  const data = normalizeLevelData(raw);
  const out: StoredFile[] = [];
  const seen = new Set<string>();

  const add = (asset: StoredFile | undefined): void => {
    if (!asset || seen.has(asset.file)) return;
    seen.add(asset.file);
    out.push({ file: asset.file, bytes: asset.bytes });
  };
  // A surface is up to six files, and the name resolves authored-first through
  // the renderer's own rule - so an absent name is the default material, and a
  // material with an authored set of the same name wears it (see `surfaceName`).
  const addSurface = (name: string | undefined): void => {
    const asset = TEXTURE_ASSETS[surfaceName(name)];
    if (asset) for (const map of textureMaps(asset)) add(map);
  };

  if (data.environment?.hdri) add(HDRI_ASSETS[data.environment.hdri]);
  // Every 3D page builds a `ChainLayer`, ball level or not, and a chain link is
  // forged iron - so this set is on the critical path of any scene.
  addSurface(IRON_SURFACE);

  let water = false;
  for (const body of data.bodies) {
    if (body.kind === "water") water = true;
    for (const object of body.objects) {
      if (object.type !== "geometry") continue;
      addSurface(object.texture);
      // A borrowed emission map is a second set worn for its emissive slot
      // alone, and `emissiveMapName` is what says whether the name resolves to
      // one at all (an unknown key leaves the shape unmapped rather than
      // glowing in the fallback's).
      const glow = emissiveMapName(object.emissiveTexture);
      if (glow) addSurface(glow);
      if (object.mesh) add(MESH_ASSETS[object.mesh]);
    }
  }
  // The flipbook and the foam mask are loaded when the first water material is
  // built, which is when a water body is drawn (see render3d/water.ts).
  if (water) {
    add(RAW_ASSETS["water-normal-flip"]);
    add(RAW_ASSETS["water-foam"]);
  }
  return out;
}
