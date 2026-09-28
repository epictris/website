import { buildMesh } from "./core/mesher";

self.onmessage = (event: MessageEvent) => {
  const { id, key, outlines, resolution } = event.data;
  try {
    const m = buildMesh(outlines, resolution);
    (self as unknown as Worker).postMessage({ id, key, ...m }, [m.pos.buffer, m.norm.buffer, m.indices.buffer]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, key, error: (e as Error).message || String(e) });
  }
};
