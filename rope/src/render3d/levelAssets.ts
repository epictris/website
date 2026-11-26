// What a level will download, worked out from the level data alone.
//
// This is the same question `Scene3D.setLevel` answers by BUILDING the scene -
// the sky, the avatar, the models, the water maps, a belt's surface -
// asked without a canvas, a GPU or a body. It exists because the answer is
// needed before any of that: the preload list inlined into `index.html` (see
// `preloadManifest` in vite.config.ts) is what lets the page start fetching at
// first paint instead of after the whole module graph has landed, and a build
// step cannot build a scene.
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

import type { LevelSource, RawLevelData } from "../level/levelFormat";
import { normalizeLevelData, scaleLevelData } from "../level/levelFormat";
import { PX } from "../engine/units";
import { rootMeshKey } from "./rootKey";
import rootBakes from "./rootBakes.json";
import { modelMeta } from "./modelMeta";
import { MODEL_ASSETS, modelFile } from "./models";
import { formationServedFile } from "../formation/bundle";
import {
  BALL_MESH,
  HDRI_ASSETS,
  IRON_SURFACE,
  rootSurfaceFor,
  MESH_ASSETS,
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

// A model's file for the preloader. Its weight is the published pin's, or the
// local export's `meta.json` for a model exported here and not yet published,
// or 0 with a warning for one with neither: a 0 is otherwise a silent wrong
// answer, and it only means the bar does not count the file.
function modelStoredFile(model: string): StoredFile {
  const bytes = MODEL_ASSETS[model]?.bytes ?? modelMeta(model)?.bytes;
  if (bytes === undefined) {
    console.warn(`[levelAssets] model "${model}" is not in the store and has no meta.json; preloading ${modelFile(model)} unweighted`);
  }
  return { file: modelFile(model), bytes: bytes ?? 0 };
}

// The file each of the level's built formations draws (`formationServedFile`),
// each once.
export function levelFormationFiles(raw: LevelSource): StoredFile[] {
  const out = new Map<string, StoredFile>();
  for (const body of normalizeLevelData(raw).bodies) {
    const served = body.formation ? formationServedFile(body.formation) : null;
    if (served) out.set(served.path, { file: served.path, bytes: served.bytes });
  }
  return [...out.values()];
}

// Every model the level's bodies carry, by name, each once, in authored order.
export function levelModelNames(raw: LevelSource): string[] {
  const names = new Set<string>();
  for (const body of normalizeLevelData(raw).bodies) {
    for (const object of body.objects) if (object.type === "model") names.add(object.model);
  }
  return [...names];
}

// The pinned root bake (`rootBakes.json`) holding any of this level's root
// bodies, by their keys, which are of the level in metres.
export function rootBakeOfLevel(raw: LevelSource): StoredFile | undefined {
  const keys = new Set(scaleLevelData(raw, PX).bodies.map(rootMeshKey).filter(Boolean));
  if (!keys.size) return undefined;
  const bakes: Record<string, { file: string; bytes: number; keys: string[] }> = rootBakes;
  return Object.values(bakes).find((bake) => bake.keys.some((k) => keys.has(k)));
}

// Every stored file the 3D scene will request for this level, in roughly the
// order it will request them - the sky and the avatar first, then the models
// and formations, then what the bodies draw themselves - so a connection that cannot carry all
// of it at once carries the most visible parts first.
export function levelStoredFiles(raw: LevelSource, controller?: string): StoredFile[] {
  // Normalised, not scaled: the units are irrelevant here, and the retired forms
  // only read as the level they now are on the way through this gate.
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
  // The avatar's model, and the one thing here that the level DATA cannot
  // answer: which controller a level is played with lives in the registry
  // beside it (`LevelSpec.controller`), and a grapple level builds no
  // `BallVisual` and so fetches no ball. It is named right after the sky
  // because it is what the player is looking at.
  if (controller === "ball") add(MESH_ASSETS[BALL_MESH]);
  // The models its bodies carry are what the level looks like...
  for (const model of levelModelNames(raw)) add(modelStoredFile(model));
  // ...and its generated formations, each the one file it draws
  // (docs/formations.md): a baked tier weighs what its bake recorded, an
  // unbaked rock's iteration mesh is unweighed.
  for (const f of levelFormationFiles(raw)) add(f);

  // The level's roots, grown ahead of time (`rootBake.ts`): the bake that
  // holds any of its bodies. A body it does not hold is grown at load.
  add(rootBakeOfLevel(raw));

  // Water draws from nothing stored (its ripples are generated, see
  // render3d/waterLook.ts).
  for (const body of data.bodies) {
    // A conveyor's band wears its own surface, drawn by the game (see
    // `BodyVisual.mountBelt`).
    for (const object of body.objects) {
      if (object.type === "collision" && object.root) addSurface(rootSurfaceFor(object.root.bark));
      if (object.type === "collision" && object.shape.kind === "belt") addSurface(object.shape.texture);
    }
  }
  return out;
}
