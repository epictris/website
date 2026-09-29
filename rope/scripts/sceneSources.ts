// The SOURCES of the Blender scenes: the `.blend` files under `assets-src/`
// and the pictures their tools paint with. The game never loads one - it loads
// the exported `scene.glb` (`scripts/publish-scenes.ts`) - but a scene's
// `.blend` is the only copy of how its dressing was made, and before these
// were pinned it was lost with the machine that made it.
//
// They live in the same release store as every other binary, and for the same
// reason (docs/asset-store.md: deletable, never in git history), under a name
// of their own - `source-<path with "/" as "-">` - and are REPLACED IN PLACE on
// publish, as scenes are: a source is saved again and again while it is
// worked on, and a name per save would keep every draft for ever. The pin in
// `scripts/sceneSources.json` (sha256 + bytes, keyed by the path under
// `assets-src/`) is what says which save a commit meant.
//
//   bun run assets:publish-sources [path ...]   (part of `just publish`)
//   bun run assets:fetch-sources                (`just sources`)
//
// The build does not fetch them: a deploy draws exports, never sources, and a
// scene's `.blend` is tens of megabytes it has no use for.

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ASSET_REPO, ASSET_TAG, levelsSceneNames } from "./assetStore";

export const ROOT = resolve(import.meta.dirname, "..");
export const SOURCES_DIR = join(ROOT, "assets-src");
export const MANIFEST = join(ROOT, "scripts", "sceneSources.json");

export interface SourceAsset {
  sha256: string;
  bytes: number;
}

export function readManifest(): Record<string, SourceAsset> {
  return existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, SourceAsset>) : {};
}

// `scenes/grotto.blend` -> `source-scenes-grotto.blend`: flat, as the store is.
export function sourceReleaseName(path: string): string {
  return `source-${path.replaceAll("/", "-")}`;
}

export function sourceUrl(path: string): string {
  return `https://github.com/${ASSET_REPO}/releases/download/${ASSET_TAG}/${sourceReleaseName(path)}`;
}

// A path as the manifest keys it: under `assets-src/`, forward slashes.
export function sourceKey(path: string): string {
  const rel = relative(SOURCES_DIR, resolve(SOURCES_DIR, path)).replaceAll("\\", "/");
  if (rel.startsWith("..")) throw new Error(`${path} is not under assets-src/`);
  return rel;
}

// The `.blend` of every scene a registered level names: always a source.
export function levelSceneSources(): string[] {
  return [...levelsSceneNames().keys()].map((scene) => `scenes/${scene}.blend`);
}
