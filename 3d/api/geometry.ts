// Geometry checks for the server: the same rules as the editor
// (core/document.ts geometryIssues), with the solids reconstructed in a worker
// and remembered by shape, so checking a scene again costs only its changes.

import { geometryIssues } from "../orthographic/src/core/document";
import type { MeshMeta } from "../orthographic/src/core/mesher";
import type { EditorState, Issue, SceneObject } from "../orthographic/src/core/types";

const CACHE_LIMIT = 4000;
const cache = new Map<string, MeshMeta>();
const pending = new Map<number, (meta: MeshMeta) => void>();
let nextId = 0;
let worker: Worker | null = null;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./geometry.worker.ts", import.meta.url));
  worker.onmessage = (e: MessageEvent<{ id: number; meta: MeshMeta }>) => {
    pending.get(e.data.id)?.(e.data.meta);
    pending.delete(e.data.id);
  };
  // The worker keeps no state worth keeping the process alive for.
  (worker as unknown as { unref(): void }).unref();
  return worker;
}

const keyOf = (e: SceneObject, resolution: number) => `${resolution}|${JSON.stringify(e.outlines)}`;

function meshMeta(e: SceneObject, resolution: number): Promise<MeshMeta> {
  const key = keyOf(e, resolution);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, (meta) => {
      cache.set(key, meta);
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      resolve(meta);
    });
    getWorker().postMessage({ id, outlines: e.outlines, resolution });
  });
}

/** Problems with the reconstructed solids of every object (or just `only`). */
export async function checkGeometry(s: EditorState, only?: ReadonlySet<string>): Promise<Issue[]> {
  const metas = new Map<string, MeshMeta>();
  await Promise.all(
    s.objects
      .filter((e) => !only || only.has(e.id))
      .map(async (e) => metas.set(e.id, await meshMeta(e, s.reconstruction.resolution))),
  );
  return geometryIssues(s, (id) => metas.get(id), only);
}
