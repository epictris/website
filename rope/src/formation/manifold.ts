// The manifold-3d geometry kernel (WASM), loaded once: rope's own dependency
// since 2026-11-23 (plans/sculpt-guides.md), where it had been imported from
// the Orthographic Studio's tree (3d/orthographic/src/core/manifold.ts).
// Every module that builds exact solids imports it from here; the top-level
// await means importers can use it synchronously. In the browser vite serves
// the WASM from beside the module (`optimizeDeps.exclude` in vite.config.ts);
// in Bun it is read from node_modules.

import Module from "manifold-3d/manifold";

export const manifold = await Module();
manifold.setup();

export type { CrossSection, Manifold, Vec3 as ManifoldVec3 } from "manifold-3d/manifold";
