// The manifold-3d geometry kernel (WASM), loaded once. Every module that builds
// exact solids imports it from here; the top-level await means importers can
// use it synchronously. In the single-file build the WASM is inlined as a data
// URL; in Bun it is read from node_modules.

import Module from "manifold-3d/manifold";

export const manifold = await Module();
manifold.setup();

export type { CrossSection, Manifold, Vec3 as ManifoldVec3 } from "manifold-3d/manifold";
