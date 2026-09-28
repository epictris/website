// Blender scenes: the level's dressing, modelled as one `.blend` and exported
// as one GLB (see docs/blender-scenes.md).
//
// A level names its scene once (`LevelData.scene`). Every object in the exported
// file whose name is a body's `name` is that body's look, mounted on the body
// and carried by it; every other object is scenery, standing where Blender put
// it. Collision is never derived from any of this - the file is appearance and
// nothing else, exactly as a geometry object is.
//
// This module is the browser-safe half: where a scene's files live, how a body
// name is matched to a node, the manifest that pins a published scene, and the
// shape of the `meta.json` the exporter writes beside the mesh. Loading and
// mounting are `sceneDressing.ts`; reading `meta.json` off disk (node only) is
// `sceneMeta.ts`, kept apart so no `fs` import reaches the browser bundle.

import { PropertyBinding } from "three";
import manifest from "./sceneAssets.json";

// Where scenes are served from under `public/`. Gitignored; `just scene`
// writes here, `assets:fetch` pulls a published scene back into the same
// layout.
export const SCENES_DIR = "/scenes";
export const SCENE_MESH_FILE = "scene.glb";
export const SCENE_META_FILE = "meta.json";

// What a scene may be called: it names a directory, a `.blend` under
// `assets-src/scenes/` and a release asset, all of which want one plain
// spelling. Lower case so that a `River.blend` on one machine and a
// `river.blend` on another cannot be two scenes.
export const SCENE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function isSceneName(name: string): boolean {
  return SCENE_NAME.test(name);
}

export function sceneDir(scene: string): string {
  return `${SCENES_DIR}/${scene}`;
}
export function sceneFile(scene: string): string {
  return `${sceneDir(scene)}/${SCENE_MESH_FILE}`;
}
export function sceneMetaFile(scene: string): string {
  return `${sceneDir(scene)}/${SCENE_META_FILE}`;
}
// The file's name in the release. The store is one flat namespace keyed by
// basename and every scene on disk is `scene.glb`, so the name is spelled out
// of the scene's own (see `generatedReleaseName` for the same rule).
export function sceneReleaseName(scene: string): string {
  return `scene-${scene}.glb`;
}

// A published scene, pinned as a prop is (see `MeshAsset.sha256` / `.bytes`):
// the sha256 says which export this revision was written against, `bytes` is
// what the loading bar counts. Unlike a generated mesh the file is REPLACED in
// place on publish - a scene is re-exported for as long as the level is being
// dressed, and a content-addressed name per export would leave every draft in
// the release - so the pin is the only thing that says which export a commit
// meant, and `assets:fetch` verifies it. Written by `assets:publish-scenes`
// and by nothing else.
// Someone else's work shipped inside a scene: a texture Blender packed into the
// export. `name` is the image (or set) as the credits list it. Resolved by the
// exporter from `tools/blender/image_credits.json` and pinned on publish, so
// CREDITS.md (scripts/credits.ts) lists what a published scene carries.
export interface SceneCredit {
  name: string;
  author: string;
  source: string;
  license: string;
}

export interface SceneAsset {
  sha256: string;
  bytes: number;
  credits?: SceneCredit[];
}
export const SCENE_ASSETS: Readonly<Record<string, SceneAsset>> = manifest;

// How three.js spells a glTF node's name: `GLTFLoader` passes every node name
// through `PropertyBinding.sanitizeNodeName` (whitespace to `_`; `.`, `:`, `/`
// and square brackets dropped), so a Blender object called `Ledge.001` is a
// node called `Ledge001`. A body's `name` is matched through the same rule, so
// the author may type either spelling and the exporter's report (which runs in
// Python, with the rule copied there) agrees with what is drawn.
export function nodeNameOf(bodyName: string): string {
  return PropertyBinding.sanitizeNodeName(bodyName);
}

// One exported object, as `meta.json` records it. `node` is the name three will
// give it (`nodeNameOf` of the Blender name); `position` and `bounds` are in
// the game's frame (three's: x right, y up, z toward the camera), metres.
export interface SceneNodeMeta {
  name: string;
  node: string;
  triangles: number;
  position: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  materials: string[];
}

// What `just scene` writes beside `scene.glb`. Half of it is Blender's account
// of what it exported (the nodes, what it skipped and why, what it warned
// about), the other half is the shipped file's facts (bytes, sha256) and the
// binding report against the level as it stood at export.
export interface SceneMeta {
  scene: string;
  level: string;
  // The `.blend` this came from, relative to `rope/`, and its sha256 - which
  // says whether the export is of the file as it now is.
  source: string;
  sourceSha256: string;
  exportedAt: string; // ISO 8601
  blender: string;
  bytes: number; // of scene.glb, as shipped
  sha256: string;
  triangles: number;
  nodes: SceneNodeMeta[];
  // Objects Blender left out, each with the reason (linked, a guide, hidden in
  // render, a light).
  skipped: { name: string; reason: string }[];
  // What the exporter could not carry as authored (a procedural Base Color, a
  // material with no image), one line each - and every shipped image the
  // credits table does not know.
  warnings: string[];
  // The third-party work inside the export, one entry per credited set.
  credits: SceneCredit[];
  // The binding as of the export: node names that matched a body, node names
  // that matched none (scenery), and body names with no object behind them.
  bound: string[];
  scenery: string[];
  unbound: string[];
}
