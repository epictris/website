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
import {
  ellipseReach,
  PATH_FLATTEN_STEP,
  pointAtArcLength,
  projectOntoPolyline,
  type PolylineIndex,
} from "./cameraPath";

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

// The subset of the canvas path interface a `Path2D` also offers. `pathOutline`
// above places its outline with the context's transform stack, which a Path2D
// has none of, so the world placement is baked into the emitted points instead.
export interface OutlineSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
}

// Append the outline to a Path2D-style sink, in world coordinates. This is what
// lets the several pieces of a compound body be accumulated into ONE path and
// filled as their union - a body is one object, and filling its pieces
// separately double-darkens wherever two of them overlap.
export function pathOutlineInto(
  p: OutlineSink,
  center: Vec2,
  rot: number,
  o: Outline,
): void {
  if (o.kind === "circle") {
    p.moveTo(center.x + o.radius, center.y);
    p.arc(center.x, center.y, o.radius, 0, Math.PI * 2);
    p.closePath();
    return;
  }
  const local =
    o.kind === "rect"
      ? [
          new Vec2(-o.half.x, -o.half.y),
          new Vec2(o.half.x, -o.half.y),
          new Vec2(o.half.x, o.half.y),
          new Vec2(-o.half.x, o.half.y),
        ]
      : o.verts;
  local.forEach((v, i) => {
    const w = center.add(v.rotated(rot));
    if (i === 0) p.moveTo(w.x, w.y);
    else p.lineTo(w.x, w.y);
  });
  p.closePath();
}

// The outline pushed out by `grow` on every side, in world coordinates, appended
// to the same kind of sink. A true offset - faces pushed out, corners rounded -
// for EVERY kind, a rect included, which is where this parts company with
// `pathOutlineGrown` below: that one grows a rect with square corners because
// square corners are literally what a camera region's containment test does.
//
// This is a MASK and not a zone. What it exists to cover is a stroke drawn along
// an outline, which straddles that outline half in and half out, so the thing to
// grow by is half a line width and the shape to grow into is whatever the stroke
// occupies - which has no square corners to match. `drawCompoundGeometry` is the
// caller: two pieces of a body that ABUT rather than overlap (a decomposed
// concave outline, or two grid-snapped rects sharing a face) leave their shared
// edge exactly on each other's boundary, so an unfilled clip erases half of each
// piece's stroke and leaves the other half drawn - a hairline crack across a
// solid wall, at the one place the body has no edge at all.
//
// Convex outlines only, which is what a mounted piece always is: at a reflex
// vertex the fillet would sweep the long way round and cross the path.
export function pathOutlineIntoGrown(
  p: OutlineSink,
  center: Vec2,
  rot: number,
  o: Outline,
  grow: number,
): void {
  if (grow <= 0) {
    pathOutlineInto(p, center, rot, o);
    return;
  }
  if (o.kind === "circle") {
    p.moveTo(center.x + o.radius + grow, center.y);
    p.arc(center.x, center.y, o.radius + grow, 0, Math.PI * 2);
    p.closePath();
    return;
  }
  const local =
    o.kind === "rect"
      ? [
          new Vec2(-o.half.x, -o.half.y),
          new Vec2(o.half.x, -o.half.y),
          new Vec2(o.half.x, o.half.y),
          new Vec2(-o.half.x, o.half.y),
        ]
      : o.verts;
  const world = local.map((v) => center.add(v.rotated(rot)));
  const n = world.length;
  // Outward face normals, one per edge (a→b), under the polygon winding contract
  // in shapes.ts - the same normals `pathOutlineGrown` takes.
  const normals = world.map((a, i) => {
    const e = world[(i + 1) % n]!.sub(a);
    const len = e.length();
    return len < 1e-9 ? Vec2.ZERO : new Vec2(e.y / len, -e.x / len);
  });
  let started = false;
  for (let i = 0; i < n; i++) {
    const a = world[i]!;
    const b = world[(i + 1) % n]!;
    const nrm = normals[i]!;
    if (nrm.x === 0 && nrm.y === 0) continue;
    const oa = a.add(nrm.mul(grow));
    if (!started) {
      p.moveTo(oa.x, oa.y);
      started = true;
    } else {
      p.lineTo(oa.x, oa.y);
    }
    p.lineTo(b.x + nrm.x * grow, b.y + nrm.y * grow);
    // Corner fillet at `b`, from this face's normal round to the next face's.
    // The loop turns clockwise on screen, which in y-down space is the direction
    // of increasing angle — the canvas's default sweep.
    const next = normals[(i + 1) % n]!;
    if (next.x !== 0 || next.y !== 0) {
      p.arc(b.x, b.y, grow, Math.atan2(nrm.y, nrm.x), Math.atan2(next.y, next.x));
    }
  }
  p.closePath();
}

// How far an outline is grown: one distance on every side, or a distance per
// side. Sides are the outline's OWN — left/right are ∓x and top/bottom are ∓y in
// the shape's local frame, so a rotated region's "top" turns with it.
//
// Only a rect can express sides at all: a circle has none, and a polygon's
// growth is a signed-distance offset with no axis to hang them on. Both take
// `uniformMargin` instead, so what is drawn stays exactly what `pointInRegion`
// tests for those kinds.
export interface SideMargin {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export type Margin = number | SideMargin;

export const marginSides = (m: Margin): SideMargin =>
  typeof m === "number" ? { left: m, right: m, top: m, bottom: m } : m;

export const uniformMargin = (m: Margin): number =>
  typeof m === "number" ? m : Math.max(m.left, m.right, m.top, m.bottom);

// The outline grown by `margin` — the shape of a camera region's buffer zone,
// and the one place its geometry is decided.
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
  margin: Margin,
): void {
  if (o.kind === "circle") {
    ctx.arc(center.x, center.y, o.radius + uniformMargin(margin), 0, Math.PI * 2);
    return;
  }
  if (o.kind === "rect") {
    const m = marginSides(margin);
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(rot);
    ctx.rect(
      -(o.half.x + m.left),
      -(o.half.y + m.top),
      o.half.x * 2 + m.left + m.right,
      o.half.y * 2 + m.top + m.bottom,
    );
    ctx.restore();
    return;
  }
  const grow = uniformMargin(margin);
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
    const oa = a.add(nrm.mul(grow));
    if (i === 0) ctx.moveTo(oa.x, oa.y);
    else ctx.lineTo(oa.x, oa.y);
    ctx.lineTo(b.x + nrm.x * grow, b.y + nrm.y * grow);
    // Corner fillet at `b`, from this face's normal round to the next face's.
    // The loop turns clockwise on screen, which in y-down space is the
    // direction of increasing angle — canvas's default sweep.
    const next = normals[(i + 1) % n]!;
    if (next.x !== 0 || next.y !== 0) {
      ctx.arc(b.x, b.y, grow, Math.atan2(nrm.y, nrm.x), Math.atan2(next.y, next.x));
    }
  }
  ctx.closePath();
  ctx.restore();
}

// The boundary of a camera path's corridor: everything whose displacement from
// its closest point on the route lies inside the ellipse the route carries
// THERE, pathed as one closed loop in world coordinates. `axesAt` answers the
// ellipse's semi-axes at an arc length - the range, the band or the release,
// each resolved through the path's keys - so what is drawn is exactly the
// zone `pathRange` / `pathBand` / `pathRelease` test, which is the whole
// reason the editor and the overlay draw it while it is being authored.
//
// A corridor is not an outline of anything - there is no inside to a polyline
// - so it is traversed as the degenerate polygon that runs the samples forward
// and then back again, the same walk `pathOutlineIntoGrown` does one dimension
// down: the reversed leg's edge normals point the other way, so it draws the
// far side, and the turnaround at each end is a fan of exactly half a turn,
// which is the cap.
//
// A SWEEP rather than a Minkowski sum, because the ellipse is allowed to vary
// along the route: the old construction ran the circular fillet walk in a
// space with y scaled by the axis ratio, which only works while one ratio
// holds for the whole path. So each side is the route offset along its edge
// normal by the ellipse reach at that sample, and each convex joint is a fan of
// the joint's own ellipse from one edge normal round to the next. Straight
// edges are resampled at `step` on the way, since the axes may change along a
// single authored edge and the offset of a straight edge is then a curve. The
// fan is skipped where it would sweep the LONG way round - the inside of a
// bend, where the offsets of neighbouring edges genuinely overlap.
//
// Every sample is then held to the predicate itself. An offset curve grows a
// swallowtail on the inside of a bend tighter than its offset, and for a
// circle that loop lies inside the zone; for an ellipse it need not - the
// point's NEAREST route point is somewhere else on the bend, seeing it along
// a direction where the reach is shorter, so the loop pokes outside what is
// tested (19 cm on an ordinary bend, before this). A sample that tests
// outside is pulled back along its own offset ray until it does not, which
// lands it on the zone's boundary exactly - the tested zone has a radial cusp
// there, and that is what gets drawn. The check is one projection per sample
// and the pull-in a dozen more on the few samples that need it.
export function pathCorridorSweepInto(
  sink: OutlineSink,
  index: PolylineIndex,
  axesAt: (s: number) => { x: number; y: number },
  step = PATH_FLATTEN_STEP,
): void {
  const { verts, cum } = index;
  if (verts.length < 2) return;
  // Samples along the route with their arc lengths: every vertex, plus enough
  // between two to keep the spacing under `step`.
  const pts: Vec2[] = [verts[0]!];
  const ss: number[] = [cum[0]!];
  for (let i = 0; i + 1 < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[i + 1]!;
    const len = cum[i + 1]! - cum[i]!;
    if (len < 1e-9) continue;
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k++) {
      pts.push(a.add(b.sub(a).mul(k / n)));
      ss.push(cum[i]! + (len * k) / n);
    }
  }
  const m = pts.length;
  if (m < 2) return;
  const loop: number[] = [];
  for (let i = 0; i < m; i++) loop.push(i);
  for (let i = m - 2; i >= 1; i--) loop.push(i);
  const n = loop.length;
  const normals = loop.map((ia, i) => {
    const e = pts[loop[(i + 1) % n]!]!.sub(pts[ia]!);
    const len = e.length();
    return len < 1e-9 ? null : new Vec2(e.y / len, -e.x / len);
  });
  const reach = (i: number, dir: Vec2): number => {
    const ax = axesAt(ss[i]!);
    return ellipseReach(ax.x, ax.y, dir);
  };
  // The predicate the controller tests (`pathRange` and its kin, through the
  // caller's `axesAt`): is `p` within the ellipse the route carries at p's
  // nearest point?
  const inside = (p: Vec2): boolean => {
    const s = projectOntoPolyline(index, p).s;
    const off = p.sub(pointAtArcLength(index, s));
    const ax = axesAt(s);
    // A hair of slack, so a sample that is on the boundary by construction is
    // not pulled in by the rounding of its own projection.
    return off.length() <= ellipseReach(ax.x, ax.y, off) + 1e-9;
  };
  // `p`, offset from its route point `q`, held to the predicate: on the
  // boundary or inside it, never outside.
  const held = (q: Vec2, p: Vec2): Vec2 => {
    if (inside(p)) return p;
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < CORRIDOR_PULL_STEPS; k++) {
      const mid = (lo + hi) / 2;
      if (inside(q.add(p.sub(q).mul(mid)))) lo = mid;
      else hi = mid;
    }
    return q.add(p.sub(q).mul(lo));
  };
  let started = false;
  // Set when the joint just passed was concave and emitted its miter, so the
  // next edge does not restate its own start point a hair away from it.
  let mitred = false;
  for (let i = 0; i < n; i++) {
    const nrm = normals[i];
    if (!nrm) continue;
    const ia = loop[i]!;
    const ib = loop[(i + 1) % n]!;
    const a = pts[ia]!;
    const b = pts[ib]!;
    if (!mitred) {
      const oa = held(a, a.add(nrm.mul(reach(ia, nrm))));
      if (!started) {
        sink.moveTo(oa.x, oa.y);
        started = true;
      } else {
        sink.lineTo(oa.x, oa.y);
      }
    }
    mitred = false;
    // The next edge with a direction, so a duplicate sample is stepped over
    // rather than ending the chain.
    let next: Vec2 | null = null;
    for (let k = 1; k <= n && !next; k++) next = normals[(i + k) % n] ?? null;
    const rb = reach(ib, nrm);
    if (!next) {
      const ob = held(b, b.add(nrm.mul(rb)));
      sink.lineTo(ob.x, ob.y);
      continue;
    }
    const from = Math.atan2(nrm.y, nrm.x);
    const to = Math.atan2(next.y, next.x);
    const sweep = (to - from + Math.PI * 2) % (Math.PI * 2);
    if (sweep > Math.PI + 1e-9) {
      // A CONCAVE joint: the two edges' offsets cross, and the boundary is
      // their crossing - the miter - rather than either edge's own end point.
      // Emitting both end points, as the fillet walk did, put two points a
      // reach-difference apart at every sample on the inside of a bend, which
      // for a circle is an invisible inward nick and for an ellipse is a
      // visible zigzag. The lines are x.n = b.n + r for each edge's normal and
      // reach at `b`; parallel ones (a straight run) fall back to the end
      // point itself.
      const rn = reach(ib, next);
      const det = nrm.x * next.y - nrm.y * next.x;
      const c1 = b.dot(nrm) + rb;
      const c2 = b.dot(next) + rn;
      const miter =
        Math.abs(det) < 1e-9
          ? b.add(nrm.mul(rb))
          : new Vec2((c1 * next.y - c2 * nrm.y) / det, (nrm.x * c2 - next.x * c1) / det);
      const m = held(b, miter);
      sink.lineTo(m.x, m.y);
      mitred = true;
      continue;
    }
    const ob = held(b, b.add(nrm.mul(rb)));
    sink.lineTo(ob.x, ob.y);
    // The fan at `b`: the joint's own ellipse from this normal round to the
    // next, sampled finely enough that the chord error is a centimetre on the
    // axes a level authors.
    const fanSteps = Math.max(1, Math.ceil(sweep / CORRIDOR_FAN_STEP));
    for (let k = 1; k <= fanSteps; k++) {
      const t = from + (sweep * k) / fanSteps;
      const d = new Vec2(Math.cos(t), Math.sin(t));
      const f = held(b, b.add(d.mul(reach(ib, d))));
      sink.lineTo(f.x, f.y);
    }
  }
  sink.closePath();
}

// Radians between the samples of a corridor fan. At 10° on a 4 m axis the
// chord sits 1.5 cm inside the true ellipse.
const CORRIDOR_FAN_STEP = Math.PI / 18;

// Bisection steps when a sample is pulled back onto the boundary: 2^-12 of
// the offset, a millimetre on the widest corridor a level authors.
const CORRIDOR_PULL_STEPS = 12;
