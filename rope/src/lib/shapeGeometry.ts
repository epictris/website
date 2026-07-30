// ShapeGeometry — shape helpers ported from lib/ShapeGeometry.cs. Operates on the
// engine's Shape/ShapeTransform instead of Godot CollisionShape2D nodes.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { circleShape, polyArea, polyShape, rectShape, shapeVertices } from "../engine/shapes";
import type { Shape, ShapeTransform } from "../engine/shapes";
import type { CollisionObject2D, CollisionShape2D } from "../engine/body";

// Ledge candidacy (game-design.md, vertex angles): a vertex is a candidate when
// its interior angle is at/below this threshold. Rect 90° corners qualify;
// near-straight vertices don't.
export const LEDGE_MAX_INTERIOR_ANGLE = Mathf.degToRad(100);

// Interior angles are rotation-invariant — computed once per Shape and cached.
const interiorAngleCache = new WeakMap<Shape, number[]>();

export const ShapeGeometry = {
  getShape(body: CollisionObject2D): CollisionShape2D {
    return body.getShape();
  },

  createRectangle(width: number, height: number): Shape {
    return rectShape(width, height);
  },

  createCircle(radius: number): Shape {
    return circleShape(radius);
  },

  createPolygon(verts: readonly Vec2[]): Shape {
    return polyShape(verts);
  },

  getRadius(shape: ShapeTransform): number {
    if (shape.shape.kind !== "circle") throw new Error("getRadius on non-circle");
    return shape.shape.radius;
  },

  getSize(shape: ShapeTransform): Vec2 {
    if (shape.shape.kind !== "rect") throw new Error("getSize on non-rect");
    return shape.shape.size;
  },

  getHalfWidth(shape: ShapeTransform): number {
    return ShapeGeometry.getSize(shape).x * 0.5;
  },

  getHalfHeight(shape: ShapeTransform): number {
    return ShapeGeometry.getSize(shape).y * 0.5;
  },

  // Ordered clockwise: bottom-left, top-left, top-right, bottom-right (y-down).
  getLocalCorners(shape: ShapeTransform): Vec2[] {
    const hw = ShapeGeometry.getHalfWidth(shape);
    const hh = ShapeGeometry.getHalfHeight(shape);
    return [
      new Vec2(-hw, hh),
      new Vec2(-hw, -hh),
      new Vec2(hw, -hh),
      new Vec2(hw, hh),
    ];
  },

  // The placed shape's vertex loop in world space — rect corners or polygon
  // vertices, [] for a circle. Named "corners" for the C# lineage; it is the
  // world-space form of `getLocalVertices` and every wrap/SAT walk uses it.
  getGlobalCorners(shape: ShapeTransform): Vec2[] {
    const local = ShapeGeometry.getLocalVertices(shape.shape);
    const pos = shape.globalPosition;
    const rot = shape.globalRotation;
    return local.map((c) => pos.add(c.rotated(rot)));
  },

  // Ordered local vertex loop for a shape; [] for circles (no vertices).
  getLocalVertices(shape: Shape): readonly Vec2[] {
    return shapeVertices(shape);
  },

  // Interior angle (radians) at each vertex, computed once per Shape.
  getVertexInteriorAngles(shape: Shape): number[] {
    const cached = interiorAngleCache.get(shape);
    if (cached) return cached;
    const verts = ShapeGeometry.getLocalVertices(shape);
    const n = verts.length;
    const angles = verts.map((v, i) => {
      const incoming = v.sub(verts[(i + n - 1) % n]!);
      const outgoing = verts[(i + 1) % n]!.sub(v);
      return Mathf.Pi - Mathf.abs(incoming.angleTo(outgoing));
    });
    interiorAngleCache.set(shape, angles);
    return angles;
  },

  isLedgeCandidate(shape: Shape, vertexIndex: number): boolean {
    const angles = ShapeGeometry.getVertexInteriorAngles(shape);
    const angle = angles[vertexIndex];
    return angle !== undefined && angle <= LEDGE_MAX_INTERIOR_ANGLE;
  },

  getVertexWorldPosition(t: ShapeTransform, vertexIndex: number): Vec2 {
    const v = ShapeGeometry.getLocalVertices(t.shape)[vertexIndex];
    if (!v) throw new Error(`No vertex ${vertexIndex}`);
    return t.globalPosition.add(v.rotated(t.globalRotation));
  },

  // Nearest vertex of the placed shape to worldPoint within maxDistance, else
  // null. Circles have no vertices — always null (never ledge-grabbable).
  findNearestVertexIndex(t: ShapeTransform, worldPoint: Vec2, maxDistance: number): number | null {
    const verts = ShapeGeometry.getLocalVertices(t.shape);
    let best: number | null = null;
    let bestDist = maxDistance;
    verts.forEach((v, i) => {
      const world = t.globalPosition.add(v.rotated(t.globalRotation));
      const d = world.distanceTo(worldPoint);
      if (d <= bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  },

  // Outward world-space normals of the two faces incident to the vertex.
  // The vertex loop is clockwise in y-down space, so the outward normal of
  // edge a→b is its Godot orthogonal (y, -x), normalized.
  getIncidentFaceNormals(t: ShapeTransform, vertexIndex: number): [Vec2, Vec2] {
    const verts = ShapeGeometry.getLocalVertices(t.shape);
    const n = verts.length;
    if (n === 0) throw new Error("getIncidentFaceNormals on vertex-less shape");
    const rot = t.globalRotation;
    const prev = verts[(vertexIndex + n - 1) % n]!;
    const v = verts[vertexIndex]!;
    const next = verts[(vertexIndex + 1) % n]!;
    const inNormal = v.sub(prev).rotated(rot).orthogonal().normalized();
    const outNormal = next.sub(v).rotated(rot).orthogonal().normalized();
    return [inNormal, outNormal];
  },

  // Mass is area / 1000 for every shape — one density for the whole project, so
  // a polygon weighs exactly what the rect or circle covering the same area does.
  computeMass(shape: ShapeTransform): number {
    const s = shape.shape;
    if (s.kind === "circle") return (Mathf.Pi * s.radius * s.radius) / 1000;
    if (s.kind === "poly") return polyArea(s.verts) / 1000;
    return (s.size.x * s.size.y) / 1000;
  },

  // Second moment about the shape's own origin. For a polygon that origin must
  // be the area centroid — the loader re-centres authored vertices onto it
  // (`polyShapeCentred`) precisely because every RigidBody2D lever arm in the
  // engine is measured from `globalPosition`.
  computeMomentOfInertia(shape: ShapeTransform, mass: number): number {
    const s = shape.shape;
    if (s.kind === "circle") return 0.5 * mass * s.radius * s.radius;
    if (s.kind === "poly") {
      // I = (m/6) · Σ|aᵢ×aᵢ₊₁|(aᵢ·aᵢ + aᵢ·aᵢ₊₁ + aᵢ₊₁·aᵢ₊₁) / Σ|aᵢ×aᵢ₊₁|.
      // (Reduces to (1/12)m(w²+h²) for a rectangle's four vertices.)
      let num = 0;
      let den = 0;
      const v = s.verts;
      for (let i = 0; i < v.length; i++) {
        const a = v[i]!;
        const b = v[(i + 1) % v.length]!;
        const c = Mathf.abs(a.cross(b));
        num += c * (a.dot(a) + a.dot(b) + b.dot(b));
        den += c;
      }
      return den > 0 ? (mass / 6) * (num / den) : 0;
    }
    return (1 / 12) * mass * (s.size.x * s.size.x + s.size.y * s.size.y);
  },
};
