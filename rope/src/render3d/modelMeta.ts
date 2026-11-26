// A model's recorded facts, read off disk. Node only (the dev server, the
// preload list in `vite.config.ts`, bun tools): it imports `fs`, which is why it
// is not in `models.ts`, which the browser loads.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { modelMetaFile, type ModelMeta } from "./models";

// `public/`, found from this file rather than from the working directory, so a
// caller run from anywhere reads the same tree (see `generatedMeta.ts`).
const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));

// The `meta.json` beside a model's mesh, or null when the model was never
// exported on this machine (a fresh checkout has only what `assets:fetch`
// pulled, which is the mesh alone). `publicDir` is for tests.
export function modelMeta(model: string, publicDir: string = PUBLIC_DIR): ModelMeta | null {
  try {
    return JSON.parse(readFileSync(`${publicDir}${modelMetaFile(model)}`, "utf8")) as ModelMeta;
  } catch {
    return null;
  }
}
