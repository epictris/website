// The KEY a body's root meshes are known by (`rootBuild.ts`, `rootBake.ts`):
// a hash of exactly what they are grown from. Apart from the build so that
// what only needs to name a body's roots - the preload list, `cli assets` -
// does not load the simplifier to do it.

import { worldPlacement } from "../level/buildBodies";
import { isCollisionObject, type LevelBodyData } from "../level/levelFormat";

// Bumped whenever what the build makes from the same data changes - the
// generator (`rootMesh.ts`), the fuse (`rootFork.ts`), the simplifier's
// settings (`rootBuild.ts`) - so every bake made before it is stale: its keys
// no longer match, and its bodies are grown again until it is re-baked.
// Nothing can notice a forgotten bump (the bake would go on drawing the old
// look), so it belongs in the same change as the edit.
export const ROOT_MESH_VERSION = 1;

// Each root piece's curve, its placement in the world, whether it is a trunk
// or which piece it grows from, and its index (the seed of its look), with
// `ROOT_MESH_VERSION`. Not its colour or bark, which are its material's.
// Empty for a body with no roots. `data` is in metres (`scaleLevelData`).
export function rootMeshKey(data: LevelBodyData): string {
  const roots = data.objects.flatMap((o, i) =>
    isCollisionObject(o) && o.root && o.shape.kind === "curve"
      ? [{ i, shape: o.shape, parent: o.root.parent ?? null, place: worldPlacement(data, o) }]
      : [],
  );
  return roots.length ? hashString(JSON.stringify({ v: ROOT_MESH_VERSION, roots })) : "";
}

// A 64-bit FNV-1a of the string's UTF-16 units, as 16 hex digits: the same in
// the browser and in bun, and synchronous, which `crypto.subtle` is not.
function hashString(text: string): string {
  let hi = 0xcbf29ce4, lo = 0x84222325;
  for (let i = 0; i < text.length; i++) {
    // Unsigned: `^` alone gives a signed 32-bit result.
    lo = (lo ^ text.charCodeAt(i)) >>> 0;
    // Multiply the 64-bit (hi, lo) by the FNV prime 0x100000001b3.
    const loMul = lo * 0x1b3;
    const carry = Math.floor(loMul / 0x100000000);
    hi = (Math.imul(hi, 0x1b3) + Math.imul(lo, 0x100) + carry) >>> 0;
    lo = loMul >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}
