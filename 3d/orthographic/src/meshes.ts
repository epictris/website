// Keeps each object's reconstructed mesh up to date with its outlines. Builds
// run one at a time in a worker (selected objects first); results are cached by
// a key of the outlines and resolution, so undo and reloads are instant.

import { createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { base64ToBytes, bytesToBase64 } from "./core/images";
import { buildMesh, MESH_VERSION, type Mesh, type MeshMeta } from "./core/mesher";
import type { SceneObject } from "./core/types";
import MeshWorker from "./mesher.worker?worker&inline";
import { state, toast, ui } from "./store";

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

export const shapeKey = (e: SceneObject, resolution = state.reconstruction.resolution) =>
  `${MESH_VERSION}|${resolution}|${JSON.stringify(e.outlines)}`;

let worker: Worker | null = null;
let busy: { id: string; key: string } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const waiters: (() => void)[] = [];
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

export function initMesher() {
  try {
    worker = new MeshWorker();
    worker.onmessage = (e: MessageEvent) => finished(e.data);
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      busy = null;
      toast("Building 3D on the main thread (the worker failed).", true);
      schedule(true);
    };
  } catch {
    worker = null;
  }
}

function finished(d: { id: string; key: string; error?: string } & Partial<Mesh>) {
  busy = null;
  const e = state.objects.find((o) => o.id === d.id);
  if (e && d.key === shapeKey(e)) {
    if (d.error) {
      setMeshStatus(d.id, {
        key: d.key,
        meta: {
          empty: true,
          coverage: { front: 0, top: 0, side: 0 },
          occupied: 0,
          grid: state.reconstruction.resolution,
        },
        triangles: 0,
        error: d.error,
      });
      toast(`Could not build ${d.id}: ${d.error}`, true);
    } else install(d.id, { pos: d.pos!, norm: d.norm!, indices: d.indices!, meta: d.meta!, key: d.key });
  }
  schedule(true);
}

/** Queue the next out-of-date object. */
export function schedule(immediate = false) {
  for (const id of [...meshes.keys()]) if (!state.objects.some((e) => e.id === id)) install(id, null);
  for (const id of Object.keys(meshStatus)) if (!state.objects.some((e) => e.id === id)) setMeshStatus(id, undefined!);
  if (busy) return;
  if (timer) {
    if (!immediate) return;
    clearTimeout(timer);
  }
  timer = setTimeout(
    () => {
      timer = undefined;
      if (busy) return;
      const ordered = [...state.objects].sort(
        (a, b) => Number(ui.selected.includes(b.id)) - Number(ui.selected.includes(a.id)),
      );
      const e = ordered.find((o) => meshStatus[o.id]?.key !== shapeKey(o));
      if (!e) {
        for (const f of waiters.splice(0)) f();
        return;
      }
      const job = {
        id: e.id,
        key: shapeKey(e),
        outlines: JSON.parse(JSON.stringify(e.outlines)),
        resolution: state.reconstruction.resolution,
      };
      busy = { id: e.id, key: job.key };
      if (worker) worker.postMessage(job);
      else
        setTimeout(() => {
          try {
            finished({ ...job, ...buildMesh(job.outlines, job.resolution) });
          } catch (error) {
            finished({ ...job, error: (error as Error).message });
          }
        }, 0);
    },
    immediate ? 0 : 90,
  );
}

export const allMeshesCurrent = () => state.objects.every((e) => meshStatus[e.id]?.key === shapeKey(e));

/** Resolves once every object's mesh matches its outlines. */
export function settle(timeoutMs = 120000): Promise<void> {
  schedule(true);
  if (allMeshesCurrent()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("The 3D geometry is still rebuilding; try again shortly.")), timeoutMs);
    waiters.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

// ---- Cache in saved projects ---------------------------------------------------------

export interface CachedMesh {
  id: string;
  key: string;
  positions: string;
  normals: string;
  indices: string;
  indexType: "uint16" | "uint32";
  meta: MeshMeta;
}

export function saveMeshCache(): CachedMesh[] {
  const out: CachedMesh[] = [];
  for (const e of state.objects) {
    const m = meshes.get(e.id);
    if (!m || m.key !== shapeKey(e)) continue;
    const b = (a: ArrayBufferView) => bytesToBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    out.push({
      id: e.id,
      key: m.key,
      positions: b(m.pos),
      normals: b(m.norm),
      indices: b(m.indices),
      indexType: m.indices instanceof Uint32Array ? "uint32" : "uint16",
      meta: m.meta,
    });
  }
  return out;
}

/**
 * After the scene is replaced: keep the meshes that still match their outlines
 * (a live update usually changes few objects), install cached meshes that do,
 * and rebuild the rest.
 */
export function restoreMeshCache(cache: unknown) {
  const current = (id: string, key: string) => {
    const e = state.objects.find((o) => o.id === id);
    return !!e && key === shapeKey(e);
  };
  for (const [id, m] of [...meshes]) if (!current(id, m.key)) install(id, null);
  setMeshStatus(
    reconcile(Object.fromEntries(Object.entries(unwrap(meshStatus)).filter(([id, s]) => current(id, s.key)))),
  );
  if (Array.isArray(cache)) installCached(cache as CachedMesh[]);
  schedule(true);
}

function installCached(cache: CachedMesh[]) {
  for (const c of cache) {
    const e = state.objects.find((o) => o.id === c?.id);
    if (!e || c.key !== shapeKey(e) || meshes.get(e.id)?.key === c.key) continue;
    try {
      const buf = (s: string) => base64ToBytes(s).buffer as ArrayBuffer;
      const pos = new Uint16Array(buf(c.positions));
      const norm = new Int8Array(buf(c.normals));
      const indices = c.indexType === "uint32" ? new Uint32Array(buf(c.indices)) : new Uint16Array(buf(c.indices));
      if (
        pos.length !== norm.length ||
        pos.length % 3 ||
        indices.length % 3 ||
        indices.some((i) => i >= pos.length / 3) ||
        !c.meta?.coverage
      )
        continue;
      install(e.id, { pos, norm, indices, meta: c.meta, key: c.key });
    } catch {
      // A damaged cache entry is rebuilt from the outlines.
    }
  }
}
