// Keeps each object's solid up to date with its outlines. Exact meshing takes
// milliseconds, so it runs on the page in short slices (selected objects
// first) that leave the UI responsive on large scenes; results are kept by a
// key of the outlines, so undo is instant.

import { createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { buildMesh, MESH_VERSION, type Mesh, type MeshMeta } from "./core/mesher";
import type { SceneObject } from "./core/types";
import { state, ui } from "./store";

export interface MeshEntry extends Mesh {
  key: string;
}

export const meshes = new Map<string, MeshEntry>();
/** Reactive per-object build status for the UI. */
export const [meshStatus, setMeshStatus] = createStore<
  Record<string, { key: string; meta: MeshMeta; triangles: number; error?: string }>
>({});
/** Bumps whenever a mesh is installed or removed; renderers track it. */
export const [meshVersion, setMeshVersion] = createSignal(0);

/** The mesh depends on the parts, and (through which edges are creases) on the box's proportions. */
export const shapeKey = (e: SceneObject) => `${MESH_VERSION}|${e.size.join(",")}|${JSON.stringify(e.parts)}`;

/** Build for at most this long before yielding to the page. */
const SLICE_MS = 12;
let timer: ReturnType<typeof setTimeout> | undefined;
const installListeners: ((id: string, mesh: MeshEntry | null) => void)[] = [];

/** Renderers upload GPU buffers here. */
export const onMeshChange = (f: (id: string, mesh: MeshEntry | null) => void) => installListeners.push(f);

function install(id: string, mesh: MeshEntry | null) {
  if (mesh) meshes.set(id, mesh);
  else meshes.delete(id);
  for (const f of installListeners) f(id, mesh);
  if (mesh) setMeshStatus(id, { key: mesh.key, meta: mesh.meta, triangles: mesh.indices.length / 3 });
  else setMeshStatus(id, undefined!);
  setMeshVersion((v) => v + 1);
}

function build(e: SceneObject) {
  const key = shapeKey(e);
  try {
    install(e.id, { ...buildMesh(unwrap(e).parts, [...e.size]), key });
  } catch (error) {
    install(e.id, null);
    setMeshStatus(e.id, {
      key,
      meta: { empty: true, parts: [] },
      triangles: 0,
      error: (error as Error).message || String(error),
    });
  }
}

/** Build out-of-date solids, a slice at a time. */
export function schedule() {
  for (const id of [...meshes.keys()]) if (!state.objects.some((e) => e.id === id)) install(id, null);
  for (const id of Object.keys(meshStatus)) if (!state.objects.some((e) => e.id === id)) setMeshStatus(id, undefined!);
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    const start = performance.now();
    const stale = [...state.objects]
      .filter((e) => meshStatus[e.id]?.key !== shapeKey(e))
      .sort((a, b) => Number(ui.selected.includes(b.id)) - Number(ui.selected.includes(a.id)));
    for (const e of stale) {
      if (performance.now() - start > SLICE_MS) {
        schedule();
        return;
      }
      build(e);
    }
  }, 0);
}

/**
 * Install the solids that are out of date right now, without yielding. For
 * the few places that need every mesh before continuing (renders, the API).
 */
export function buildNow() {
  for (const e of state.objects) if (meshStatus[e.id]?.key !== shapeKey(e)) build(e);
}

export const allMeshesCurrent = () => state.objects.every((e) => meshStatus[e.id]?.key === shapeKey(e));

/** Resolves once every object's mesh matches its outlines. */
export function settle(): Promise<void> {
  buildNow();
  return Promise.resolve();
}

/** After the scene is replaced: drop the meshes that no longer match their outlines, and rebuild. */
export function refreshMeshes() {
  const current = (id: string, key: string) => {
    const e = state.objects.find((o) => o.id === id);
    return !!e && key === shapeKey(e);
  };
  for (const [id, m] of [...meshes]) if (!current(id, m.key)) install(id, null);
  setMeshStatus(
    reconcile(Object.fromEntries(Object.entries(unwrap(meshStatus)).filter(([id, s]) => current(id, s.key)))),
  );
  schedule();
}
