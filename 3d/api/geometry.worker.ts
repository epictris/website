// Reconstructs solids off the server's main thread (a large scene takes seconds).

import { buildMesh } from "../orthographic/src/core/mesher";
import type { Ring, ViewId } from "../orthographic/src/core/types";

declare const self: Worker;

self.onmessage = (e: MessageEvent<{ id: number; outlines: Record<ViewId, Ring>; resolution: number }>) => {
  const { id, outlines, resolution } = e.data;
  self.postMessage({ id, meta: buildMesh(outlines, resolution).meta });
};
