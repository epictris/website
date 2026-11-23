// Where a formation's built files live, and what its `meta.json` says
// (docs/formations.md, "The store").
//
// While editing, every result is a folder named by its recipe's hash under
// `public/generated/`, served by the dev server with `no-store` (src/server/
// formations.ts). Regenerating one formation writes one new folder; nothing is
// ever rewritten in place under a hash but the tiers a bake adds and the meta
// that lists them. A folder no level names is garbage, removed by a sweep
// (`bun run formation:sweep`), never by a save.

import type { FormationTier } from "../level/levelFormat";
import type { FormationRecipe } from "./recipe";

export const FORMATION_STORE = "/generated";
// A store folder's name: the recipe's sha256. Anything else under
// `public/generated/` is the retired generator service's and is left alone.
export const FORMATION_HASH = /^[0-9a-f]{64}$/;

export const GEOMETRY_FILE = "geometry.glb";
export const META_FILE = "meta.json";
// The rock as the worker built it, with the bake's caps set on it: what a
// bake starts from, and what a decoration grows on.
export const ROCK_FILE = "rock.blend";

export function formationDir(hash: string): string {
  return `${FORMATION_STORE}/${hash}`;
}
export function geometryFile(hash: string): string {
  return `${formationDir(hash)}/${GEOMETRY_FILE}`;
}
export function tierFileName(tier: number): string {
  return `tier-${tier}.glb`;
}
export function tierFile(hash: string, tier: number): string {
  return `${formationDir(hash)}/${tierFileName(tier)}`;
}
export function metaFile(hash: string): string {
  return `${formationDir(hash)}/${META_FILE}`;
}

// A solid guide's stored meshes (`SolidPrim` "mesh"): fixed closed meshes in
// metres in the guide's frame, under `meshes/`. An imported one is
// `{verts, faces}` JSON named by the sha256 of its canonical text (the leaf's
// `file` is the bare hash); a sculpted or applied one is binary
// (`formation/meshBin.ts`), named by the sha256 of its bytes plus `.bin`.
// A level's paint, the strokes of its painted decorations, kept beside the
// level in `levels/paint/<level>.json` (src/server/formations.ts).
export const PAINT_API = "/api/paint";

export const MESHES = "meshes";
export const MESHES_API = "/api/formations/meshes";
// The file a leaf's `file` names, inside `meshes/`.
export function meshFileName(name: string): string {
  return name.endsWith(".bin") ? name : `${name}.json`;
}
export function meshFile(name: string): string {
  return `${FORMATION_STORE}/${MESHES}/${meshFileName(name)}`;
}

// A closed loop (or an open chain, where the rock had a hole at the plane) in
// the body's frame, metres, y down.
export interface SectionLoop {
  closed: boolean;
  points: { x: number; y: number }[];
}

export interface FormationMeta {
  hash: string;
  // What the hash was taken over, and what the worker was given.
  recipe: FormationRecipe;
  workerRecipe: Record<string, unknown>;
  generatorHash: string;
  recipeVersion: number;
  // The worker's whole-rock mesh, and the iteration look's (`geometry.glb`).
  triangles: number;
  geometryTriangles: number;
  // In the body's frame as the 3D view draws it (x right, y up, z toward the
  // camera), metres.
  bounds: { min: [number, number, number]; max: [number, number, number] };
  area: number;
  // Where the rock meets the play plane, at full detail, for "Fit collision
  // to geometry".
  section: SectionLoop[];
  // The tiers baked so far, finest first; empty until a bake.
  tiers: FormationTier[];
  // Seconds per stage, for the plan's measurements and the jobs panel.
  times: Record<string, number>;
  builtAt: string;
  // What the build noticed that the author should hear: a variant that filled
  // its guide's opening (formation_export.py `filled_openings`).
  warnings: string[];
}
