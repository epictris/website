// Client for the dev-server level API (see vite.config.ts). All calls speak the
// on-disk pixel LevelData format.

import type { LevelData } from "../level/levelFormat";

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

export async function saveLevel(name: string, data: LevelData): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`save failed: ${res.status}`);
}

export async function deleteLevel(name: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}
