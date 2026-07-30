// ShapeGeometry — shape helpers ported from lib/ShapeGeometry.cs. Operates on the
// engine's Shape/ShapeTransform instead of Godot CollisionShape2D nodes.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { circleShape, polyArea, polyShape, rectShape, shapeVertices } from "../engine/shapes";
import type { Shape, ShapeTransform } from "../engine/shapes";

// Ledge candidacy (game-design.md, vertex angles): a vertex is a candidate when
// its interior angle is at/below this threshold. Rect 90° corners qualify;
// near-straight vertices don't.
export const LEDGE_MAX_INTERIOR_ANGLE = Mathf.degToRad(100);

// Interior angles are rotation-invariant — computed once per Shape and cached.
const interiorAngleCache = new WeakMap<Shape, number[]>();

// How thick a slab of scenery is, in metres. A rect or polygon is a flat piece
// cut from the world - a platform, a crate, a plank - so its mass is its area
// times this depth times its density. Circles do NOT use it (see `computeMass`).
export const SCENE_DEPTH = 0.2;

// Real material densities, kg/m³. A body's mass is a physical quantity here, not
// a tuning number: the ball is cast iron and weighs what a cast-iron ball of its
// size weighs, and everything else is sized against the same table rather than
// against it. Ratios are what the simulation feels - a ball that outweighs the
// crate it hits by 20× behaves that way whatever the units - but getting the
// absolute scale right is what makes those ratios checkable against reality
// instead of against each other.
export const Density = {
  CAST_IRON: 7200,
  STEEL: 7850,
  // Oak: generic scene props - crates, planks, the movable slabs levels author
  // as `rigid`. Level geometry carries no material of its own yet, so this is
  // what an authored rigid body is made of.
  WOOD: 700,
  // Rock/rubble: the loose circles the grapple sandbox spawns.
  STONE: 2400,
  // The grapple avatar. A body is mostly water, and its mass only ever sizes the
  // push it gives a rigid body it walks into (`applyCharacterPush`) - it is a
  // CharacterBody2D and nothing pushes back.
  FLESH: 1000,
} as const;

// What a body is made of when nothing says otherwise: an authored `rigid` level
// body is a wooden crate or plank until the level format can name its material.
export const DEFAULT_DENSITY = Density.WOOD;

// The two volume rules, exposed for callers that hold a radius or an area rather
// than a shape (the editor's group centre of mass), so there is one statement of
// each in the project.
export function sphereMass(radius: number, density: number = DEFAULT_DENSITY): number {
  return (4 / 3) * Mathf.Pi * radius * radius * radius * density;
}

export function slabMass(area: number, density: number = DEFAULT_DENSITY): number {
  return area * SCENE_DEPTH * density;
}

export const ShapeGeometry = {
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

  // Mass in KILOGRAMS: the shape's real volume times its material's density
  // (see `Density` / `SCENE_DEPTH` above). The sim runs in metres and seconds,
  // so mass is the third SI unit and every derived quantity - momentum,
  // impulses, kinetic energy - is a real one too.
  //
  // A circle is a SPHERE and a rect/poly is a prism of `SCENE_DEPTH`, which is
  // the one place this file is deliberately not a single extrusion: the round
  // things here are balls (the cast-iron ball, its hook, a cannonball, a rock)
  // and the flat ones are slabs cut from the scenery. Extruding a ball to the
  // slab depth makes small balls absurdly heavy - a 4 cm hook would outweigh a
  // 5 cm rock by six times - so each kind gets the volume its shape actually
  // has.
  computeMass(shape: ShapeTransform, density: number = DEFAULT_DENSITY): number {
    const s = shape.shape;
    if (s.kind === "circle") return sphereMass(s.radius, density);
    if (s.kind === "poly") return slabMass(polyArea(s.verts), density);
    return slabMass(s.size.x * s.size.y, density);
  },

  // Second moment about the shape's own origin. For a polygon that origin must
  // be the area centroid — the loader re-centres authored vertices onto it
  // (`polyShapeCentred`) precisely because every RigidBody2D lever arm in the
  // engine is measured from `globalPosition`.
  //
  // A circle's second moment stays the DISC's (1/2·m·r²) even though its mass is
  // now a sphere's, and the mismatch is deliberate. Every rotation in this engine
  // is planar - one angle about z, contact and rope lever arms measured in the
  // plane - so a circle spins as the disc it is drawn as; the sphere is only how
  // much stuff is in it.
  //
  // Measured rather than assumed: switching to 2/5·m·r² makes the ball a fifth
  // easier to spin up for the same chain torque, and `ball-wind-up`'s chain
  // growth goes from 1.3 cm to 6.7 cm over the same 580-frame wind-up (the
  // solver settling the spin it cannot afford by leasing chain instead). The
  // mass change is behaviour-neutral - a uniform scale on every mass leaves an
  // acceleration-driven sim exactly where it was, and the playtest reproduces to
  // four digits - and this would not have been.
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
