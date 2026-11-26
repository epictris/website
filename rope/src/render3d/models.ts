// The model library: 3D models a level PLACES on its bodies, each modelled in a
// `.blend` of its own and exported as one GLB (see docs/blender-models.md).
//
// A model is authored once, in `assets-src/models/<model>.blend`, exported by
// `just model <model>`, and placed by a level's `model` objects
// (`ModelObjectData`) on any body, which carries it - a lantern on its chain, a
// crate, a mover's platform - in as many places and levels as name it.
// Appearance only: collision is the body's own, authored in the editor, and
// never derived from a model.
//
// This module is the browser-safe half: where a model's files live, the
// manifest that pins a published model, and the shape of the `meta.json` the
// exporter writes beside the mesh. Loading and mounting are `exportFiles.ts`
// (the one loader every Blender export goes through) and `bodyVisuals.ts`;
// reading `meta.json` off disk (node only) is `modelMeta.ts`, kept apart so no
// `fs` import reaches the browser bundle.

import manifest from "./modelAssets.json";
import type { ExportCredit, ExportNodeMeta } from "./exportFiles";

// Where models are served from under `public/`. Gitignored; `just model`
// writes here, `assets:fetch` pulls a published model back into the same
// layout.
export const MODELS_DIR = "/models";
export const MODEL_MESH_FILE = "model.glb";
// The dev server's list of the models the editor may offer: every model
// exported on this machine and every one the store pins, sorted (served by
// src/server/models.ts).
export const MODELS_API = "/api/models";
export const MODEL_META_FILE = "meta.json";

// What a model may be called: it names a directory, a `.blend` under
// `assets-src/models/` and a release asset, all of which want one plain
// spelling. Lower case so that a `Lantern.blend` on one machine and a
// `lantern.blend` on another cannot be two models.
export const MODEL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function isModelName(name: string): boolean {
  return MODEL_NAME.test(name);
}

export function modelDir(model: string): string {
  return `${MODELS_DIR}/${model}`;
}
export function modelFile(model: string): string {
  return `${modelDir(model)}/${MODEL_MESH_FILE}`;
}
export function modelMetaFile(model: string): string {
  return `${modelDir(model)}/${MODEL_META_FILE}`;
}
// The file's name in the release. The store is one flat namespace keyed by
// basename and every model on disk is `model.glb`, so the name is spelt out of
// the model's own.
export function modelReleaseName(model: string): string {
  return `model-${model}.glb`;
}

// A published model, pinned as a prop is (see `MeshAsset.sha256` / `.bytes`):
// the sha256 says which export this revision was written against, `bytes` is
// what the loading bar counts. Unlike a generated mesh the file is REPLACED in
// place on publish - a model is re-exported for as long as it is being worked
// on, and a content-addressed name per export would leave every draft in the
// release - so the pin is the only thing that says which export a commit
// meant, and `assets:fetch` verifies it. Written by `assets:publish-models`
// and by nothing else.
export interface ModelAsset {
  sha256: string;
  bytes: number;
  credits?: ExportCredit[];
}
export const MODEL_ASSETS: Readonly<Record<string, ModelAsset>> = manifest;

// What `just model` writes beside `model.glb`: Blender's account of what it
// exported, the shipped file's facts, and the model's extent - which is what
// the editor draws a model's footprint by before (or without) loading it.
export interface ModelMeta {
  model: string;
  // The `.blend` this came from, relative to `rope/`, and its sha256.
  source: string;
  sourceSha256: string;
  exportedAt: string; // ISO 8601
  blender: string;
  bytes: number; // of model.glb, as shipped
  sha256: string;
  triangles: number;
  nodes: ExportNodeMeta[];
  // Every node's bounds together, in the model's own frame (three's: x right,
  // y up, z toward the camera), metres. Null for a model with nothing in it.
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  skipped: { name: string; reason: string }[];
  warnings: string[];
  credits: ExportCredit[];
}
