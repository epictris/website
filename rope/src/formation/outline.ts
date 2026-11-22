// A guide piece's outline, and the plane geometry the rest of the formation
// code shares: no wasm, so the editor's 2D canvas can draw a guide without
// loading the solid kernel.

import type { GuidePiece } from "../level/levelFormat";

export interface Pt {
  x: number;
  y: number;
}

// A circle as a polygon: sides enough that no chord strays more than this far
// from the arc, metres. A guide only shapes the generator's coarse form.
const CIRCLE_CHORD_ERROR = 0.01;

// One piece's outline in its formation's frame, or null for a shape that
// encloses nothing a rock could be grown from (a curve, a belt).
export function piecePolygon(p: GuidePiece): Pt[] | null {
  const s = p.shape;
  let local: Pt[];
  if (s.kind === "rect") {
    const hx = s.w / 2;
    const hy = s.h / 2;
    local = [{ x: -hx, y: -hy }, { x: hx, y: -hy }, { x: hx, y: hy }, { x: -hx, y: hy }];
  } else if (s.kind === "circle") {
    const n = Math.max(12, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - CIRCLE_CHORD_ERROR / s.r))));
    local = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return { x: Math.cos(a) * s.r, y: Math.sin(a) * s.r };
    });
  } else if (s.kind === "poly") {
    if (s.verts.length < 3) return null;
    local = s.verts.map((v) => ({ x: v.x, y: v.y }));
  } else {
    return null;
  }
  // Placed as every authored shape is (`Vec2.rotated`).
  const c = Math.cos(p.rot ?? 0);
  const n = Math.sin(p.rot ?? 0);
  const ox = p.x ?? 0;
  const oy = p.y ?? 0;
  return local.map((q) => ({ x: ox + q.x * c - q.y * n, y: oy + q.x * n + q.y * c }));
}

export function signedArea(ring: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j]!.x * ring[i]!.y - ring[i]!.x * ring[j]!.y;
  return a / 2;
}
