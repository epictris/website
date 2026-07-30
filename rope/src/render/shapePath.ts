// One outline description, and one way to path it. Circles, rects and convex
// polygons are drawn identically by the game renderer, the level editor, the
// backdrop pass, the area-glyph fills and the headless SVG snapshot — so the
// geometry lives here once rather than as a `kind === "circle" ? arc : rect`
// branch repeated in each of them (which is exactly what would have had to gain
// a third arm per site when polygons arrived).
//
// It is deliberately its own type rather than either `Shape` (the engine's) or
// `ShapeData` (the on-disk one): the editor draws items that have no engine body
// yet, and the SVG writer has no canvas. Both source types adapt into it.

import { Vec2 } from "../engine/vec2";
import { shapeVertices } from "../engine/shapes";
import type { Shape } from "../engine/shapes";
import type { ShapeData } from "../level/levelFormat";

export type Outline =
  | { kind: "circle"; radius: number }
  | { kind: "rect"; half: Vec2 }
  | { kind: "poly"; verts: readonly Vec2[] };

export function outlineOfShape(s: Shape): Outline {
  if (s.kind === "circle") return { kind: "circle", radius: s.radius };
  if (s.kind === "poly") return { kind: "poly", verts: s.verts };
  return { kind: "rect", half: s.size.mul(0.5) };
}

export function outlineOfData(s: ShapeData): Outline {
  if (s.kind === "circle") return { kind: "circle", radius: s.r };
  if (s.kind === "poly") return { kind: "poly", verts: s.verts.map((v) => new Vec2(v.x, v.y)) };
  return { kind: "rect", half: new Vec2(s.w / 2, s.h / 2) };
}

// Half-extents of the outline's unrotated bounding box. What the area-glyph
// lattice is laid out over, and what the editor snaps and rubber-bands against.
export function outlineHalfExtents(o: Outline): Vec2 {
  if (o.kind === "circle") return new Vec2(o.radius, o.radius);
  if (o.kind === "rect") return o.half;
  let x = 0;
  let y = 0;
  for (const v of o.verts) {
    x = Math.max(x, Math.abs(v.x));
    y = Math.max(y, Math.abs(v.y));
  }
  return new Vec2(x, y);
}

// A circle has no meaningful rotation to draw, so callers that only rotate for
// the outline's sake can skip the transform entirely.
export function outlineIsRound(o: Outline): boolean {
  return o.kind === "circle";
}

// Append the outline to the current path, placed at `center` and turned by
// `rot`. Leaves the context transform as it found it.
export function pathOutline(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  rot: number,
  o: Outline,
): void {
  if (o.kind === "circle") {
    ctx.arc(center.x, center.y, o.radius, 0, Math.PI * 2);
    return;
  }
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(rot);
  if (o.kind === "rect") {
    ctx.rect(-o.half.x, -o.half.y, o.half.x * 2, o.half.y * 2);
  } else {
    o.verts.forEach((v, i) => (i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y)));
    ctx.closePath();
  }
  ctx.restore();
}

// The outline grown by `margin` on every side — the shape of a camera region's
// buffer zone, and the one place its geometry is decided.
//
// A rect grows per axis, with square corners, because that is literally what
// `pointInRegion` tests for it. A polygon grows as a true offset (faces pushed
// out, corners rounded), because a polygon's containment test is its signed
// distance and a mitred corner would claim reach the region does not have.
export function pathOutlineGrown(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  rot: number,
  o: Outline,
  margin: number,
): void {
  if (o.kind === "circle") {
    ctx.arc(center.x, center.y, o.radius + margin, 0, Math.PI * 2);
    return;
  }
  if (o.kind === "rect") {
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(rot);
    const hx = o.half.x + margin;
    const hy = o.half.y + margin;
    ctx.rect(-hx, -hy, hx * 2, hy * 2);
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(rot);
  const n = o.verts.length;
  // Outward face normals, one per edge (a→b), under the polygon winding
  // contract in shapes.ts.
  const normals = o.verts.map((a, i) => {
    const e = o.verts[(i + 1) % n]!.sub(a);
    const len = e.length();
    return len < 1e-9 ? Vec2.ZERO : new Vec2(e.y / len, -e.x / len);
  });
  for (let i = 0; i < n; i++) {
    const a = o.verts[i]!;
    const b = o.verts[(i + 1) % n]!;
    const nrm = normals[i]!;
    if (nrm.x === 0 && nrm.y === 0) continue;
    const oa = a.add(nrm.mul(margin));
    if (i === 0) ctx.moveTo(oa.x, oa.y);
    else ctx.lineTo(oa.x, oa.y);
    ctx.lineTo(b.x + nrm.x * margin, b.y + nrm.y * margin);
    // Corner fillet at `b`, from this face's normal round to the next face's.
    // The loop turns clockwise on screen, which in y-down space is the
    // direction of increasing angle — canvas's default sweep.
    const next = normals[(i + 1) % n]!;
    if (next.x !== 0 || next.y !== 0) {
      ctx.arc(b.x, b.y, margin, Math.atan2(nrm.y, nrm.x), Math.atan2(next.y, next.x));
    }
  }
  ctx.closePath();
  ctx.restore();
}
