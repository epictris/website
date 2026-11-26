// Client for the dev-server level API (see vite.config.ts). All calls speak the
// on-disk pixel LevelData format.

import type { LevelData } from "../level/levelFormat";
import type { LevelTree, PrefabData } from "../level/nodes";

const BASE = "/api/levels";

export async function listLevels(): Promise<string[]> {
  const res = await fetch(BASE);
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return (await res.json()).names as string[];
}

export async function loadLevel(name: string): Promise<LevelData> {
  const res = await fetch(`${BASE}/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`load failed: ${res.status}`);
  return (await res.json()) as LevelData;
}

// `keepalive` lets a save started while the page is going away still complete
// (the pagehide flush of a pending autosave).
export async function saveLevel(
  name: string,
  data: LevelData | LevelTree,
  opts: { keepalive?: boolean } = {},
): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    keepalive: opts.keepalive ?? false,
  });
  if (!res.ok) throw new Error(`save failed: ${res.status}`);
}

export async function deleteLevel(name: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}

// PREFABS (plans/node-tree.md "Prefabs"): the same four verbs against
// `prefabs/<name>.json`, `{ format: 3, root }` in pixels.
const PREFABS = "/api/prefabs";

export async function listPrefabs(): Promise<string[]> {
  const res = await fetch(PREFABS, { cache: "no-store" });
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return (await res.json()).names as string[];
}

export async function loadPrefab(name: string): Promise<PrefabData> {
  const res = await fetch(`${PREFABS}/${encodeURIComponent(name)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`load failed: ${res.status}`);
  return (await res.json()) as PrefabData;
}

export async function savePrefab(name: string, data: PrefabData): Promise<void> {
  const res = await fetch(`${PREFABS}/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`save failed: ${res.status}`);
}
