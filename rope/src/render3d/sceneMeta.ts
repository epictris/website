// A scene's recorded facts, read off disk. Node only (the dev server, the
// preload list in `vite.config.ts`, bun tools): it imports `fs`, which is why it
// is not in `scenes.ts`, which the browser loads.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sceneMetaFile, type SceneMeta } from "./scenes";

// `public/`, found from this file rather than from the working directory, so a
// caller run from anywhere reads the same tree (see `generatedMeta.ts`).
const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));

// The `meta.json` beside a scene's mesh, or null when the scene was never
// exported on this machine (a fresh checkout has only what `assets:fetch`
// pulled, which is the mesh alone). `publicDir` is for tests.
export function sceneMeta(scene: string, publicDir: string = PUBLIC_DIR): SceneMeta | null {
  try {
    return JSON.parse(readFileSync(`${publicDir}${sceneMetaFile(scene)}`, "utf8")) as SceneMeta;
  } catch {
    return null;
  }
}
