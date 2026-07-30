// Collision shapes: circles, axis-local rectangles (a rect rotated by its
// body's rotation) and convex polygons.
//
// `rect` is kept as its own kind rather than being folded into `poly` even
// though a rect *is* a convex polygon: every collision path has a closed-form
// slab implementation for it, and those are what every recorded replay was
// simulated with. A four-vertex `poly` goes down the general convex path and is
// geometrically identical; it is simply not bit-identical, which is why the two
// stay separate.
//
// A polygon is **convex** — always, no exceptions (see "Convex-only polygons;
// compound bodies" in docs/game-design.md). Concavity is expressed by giving a
// body several convex shapes, not by one shape with a reflex vertex: the rope's
// wrap solver decides which side of a body a span passes on from the body
// origin, walks the vertex loop monotonically for the tangent vertex, and can
// never hold a taut contact on a reflex corner — none of which survives a
// concave loop.

import { Vec2 } from "./vec2";

export type Shape =
  | { readonly kind: "circle"; readonly radius: number }
  | { readonly kind: "rect"; readonly size: Vec2 }
  // Vertices in the shape's local frame, ordered so that consecutive edge
  // cross-products are positive (clockwise on screen, y being down). That is the
  // same winding `rectShape` produces, and it is what makes the outward normal
  // of the edge a→b its Godot orthogonal, (b-a).y, -(b-a).x.
  | { readonly kind: "poly"; readonly verts: readonly Vec2[] };

export function circleShape(radius: number): Shape {
  return { kind: "circle", radius };
}

export function rectShape(width: number, height: number): Shape {
  return { kind: "rect", size: new Vec2(width, height) };
}

// Twice the signed area of a vertex loop; positive for the winding above.
export function polySignedArea2(verts: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    s += a.cross(b);
  }
  return s;
}

export function polyArea(verts: readonly Vec2[]): number {
  return Math.abs(polySignedArea2(verts)) * 0.5;
}

// Area centroid of a vertex loop. A body's origin is its centre of mass
// everywhere in this engine (RigidBody2D takes every lever arm from
// `globalPosition`), so authored polygons are re-centred on this before they
// become shapes — see `polyShapeCentred`.
export function polyCentroid(verts: readonly Vec2[]): Vec2 {
  const a2 = polySignedArea2(verts);
  if (Math.abs(a2) < 1e-12) {
    // Degenerate (collinear) loop: fall back to the vertex average, which is
    // still the sane centre for the editor's purposes.
    let s = Vec2.ZERO;
    for (const v of verts) s = s.add(v);
    return verts.length ? s.div(verts.length) : Vec2.ZERO;
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    const c = a.cross(b);
    cx += (a.x + b.x) * c;
    cy += (a.y + b.y) * c;
  }
  return new Vec2(cx / (3 * a2), cy / (3 * a2));
}

// Is a vertex loop convex (no reflex vertex, no self-intersection for a simple
// loop)? Collinear vertices are tolerated — an author dragging a vertex onto the
// line between its neighbours has not made the shape concave.
export function isConvexLoop(verts: readonly Vec2[]): boolean {
  const n = verts.length;
  if (n < 3) return false;
  const sign = polySignedArea2(verts) >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % n]!;
    const c = verts[(i + 2) % n]!;
    if (b.sub(a).cross(c.sub(b)) * sign < -1e-12) return false;
  }
  return true;
}

// A convex polygon from a vertex loop. The winding is normalised (reversed if
// the loop was authored the other way round) so every consumer can rely on the
// edge/normal convention above. Throws on a loop that is not convex: a concave
// primitive would break the rope solver silently rather than loudly.
export function polyShape(verts: readonly Vec2[]): Shape {
  if (verts.length < 3) throw new Error(`polyShape needs 3+ vertices, got ${verts.length}`);
  const ordered = polySignedArea2(verts) >= 0 ? [...verts] : [...verts].reverse();
  if (!isConvexLoop(ordered)) throw new Error("polyShape requires a convex vertex loop");
  return { kind: "poly", verts: ordered };
}

// `polyShape`, re-centred on the loop's area centroid. Returns the shape plus
// the local-frame offset that was removed, so the caller can add it back to the
// body's position and leave the polygon exactly where it was authored.
export function polyShapeCentred(verts: readonly Vec2[]): { shape: Shape; offset: Vec2 } {
  const c = polyCentroid(verts);
  return { shape: polyShape(verts.map((v) => v.sub(c))), offset: c };
}

// The shape's vertex loop in its local frame — rect corners, polygon vertices,
// or nothing at all for a circle. The single accessor every vertex-walking
// query goes through (ledge candidacy, rope wrap generation, SAT).
//
// The rect ordering is bottom-left, top-left, top-right, bottom-right in y-down
// space, i.e. clockwise on screen, matching the polygon winding contract.
const RECT_VERTS = new WeakMap<object, readonly Vec2[]>();
export function shapeVertices(shape: Shape): readonly Vec2[] {
  if (shape.kind === "poly") return shape.verts;
  if (shape.kind !== "rect") return [];
  const cached = RECT_VERTS.get(shape);
  if (cached) return cached;
  const hw = shape.size.x * 0.5;
  const hh = shape.size.y * 0.5;
  const verts: readonly Vec2[] = [
    new Vec2(-hw, hh),
    new Vec2(-hw, -hh),
    new Vec2(hw, -hh),
    new Vec2(hw, hh),
  ];
  RECT_VERTS.set(shape, verts);
  return verts;
}

// Outward unit normal of the edge leaving vertex `i` of a vertex loop. The one
// place the winding contract above is cashed out, so a consumer never has to
// remember which way round `orthogonal()` goes. Zero for a degenerate edge.
export function polyEdgeNormal(verts: readonly Vec2[], i: number): Vec2 {
  const a = verts[i]!;
  const b = verts[(i + 1) % verts.length]!;
  const e = b.sub(a);
  const len = e.length();
  return len < 1e-12 ? Vec2.ZERO : new Vec2(e.y / len, -e.x / len);
}

// A CollisionShape2D attached to a body. Its global transform is the body's
// transform, offset by the shape's own mount point (zero for the single-shape
// bodies that make up most of the project).
export interface ShapeTransform {
  readonly globalPosition: Vec2;
  readonly globalRotation: number;
  readonly shape: Shape;
}
