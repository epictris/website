// Client for the dev-server level API (see vite.config.ts). All calls speak the
// on-disk pixel LevelData format.

import type { LevelData } from "../level/levelFormat";
import type { ImageAsset } from "../render3d/images";

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
  data: LevelData,
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

// Add a picture through the dev server's image upload (src/server/images.ts):
// the bytes go up as they are, and what comes back is the manifest entry the
// server pinned for them.
export async function uploadImage(file: File): Promise<{ key: string; asset: ImageAsset }> {
  const res = await fetch(`/api/images?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  // Not JSON at all is a server without the endpoint: one started before it
  // existed, whose config has not been reloaded since.
  const text = await res.text();
  let body: { key: string; asset: ImageAsset } | { error: string };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(
      res.status === 404
        ? "this dev server has no picture upload - restart it (`bun run dev`)"
        : `the server answered ${res.status} with no JSON`,
    );
  }
  if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `upload failed: ${res.status}`);
  return body;
}
