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

// How thick a piece of scenery is through the z axis - the dimension the 2D
// view cannot show - in metres. A level shape authors its own `thickness`; this
// is what one that does not is, and it is what every body authored before the
// field was 0.2 m thick as.
//
// It is NOT used by the code-built round bodies (the ball, its hook, a
// cannonball, the sandbox's rocks), which are spheres rather than extrusions -
// see `computeMass`.
export const DEFAULT_THICKNESS = 0.2;

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
  // as `rigid`. A level shape names its own material (`LevelBodyData.material`,
  // per shape rather than per body); this is what one that names none is.
  WOOD: 700,
  // Rock/rubble: the loose circles the grapple sandbox spawns.
  STONE: 2400,
  // The grapple avatar. A body is mostly water, and its mass only ever sizes the
  // push it gives a rigid body it walks into (`applyCharacterPush`) - it is a
  // CharacterBody2D and nothing pushes back.
  FLESH: 1000,
} as const;

// The materials a level shape may be made of, in ascending density - the order
// the editor's picker lists them in, which is the order an author thinks about
// them in ("heavier than that").
//
// Names rather than raw numbers, because a material is what an author is
// actually choosing: "this crate is stone" is a decision about the level, and
// 2400 is a fact about stone that the level should not have to restate (or get
// slightly wrong in three different places). It is also what keeps the numbers
// honest - every one of these is the real density of the real thing, so a
// stone slab of a given size weighs what such a slab weighs.
//
// The keys are what reaches disk, so they are stable: renaming one is a level
// format change and an unknown name loads as the default rather than as zero
// mass.
export const MATERIALS = {
  wood: Density.WOOD,
  ice: 917,
  flesh: Density.FLESH,
  rubber: 1100,
  brick: 1900,
  stone: Density.STONE,
  glass: 2500,
  aluminium: 2700,
  "cast iron": Density.CAST_IRON,
  steel: Density.STEEL,
  lead: 11340,
} as const;

export type MaterialName = keyof typeof MATERIALS;

export const MATERIAL_NAMES = Object.keys(MATERIALS) as MaterialName[];

// What a shape is made of when it names nothing: an authored level shape is a
// wooden crate or plank.
export const DEFAULT_MATERIAL: MaterialName = "wood";
export const DEFAULT_DENSITY = MATERIALS[DEFAULT_MATERIAL];

// The density of a named material, defaulting whatever the name is not one of
// them - a hand-edited level naming a material this build does not have gets
// oak rather than a body of zero mass.
export function materialDensity(name: string | undefined): number {
  if (name === undefined) return DEFAULT_DENSITY;
  return (MATERIALS as Record<string, number | undefined>)[name] ?? DEFAULT_DENSITY;
}

// The two volume rules, exposed for callers that hold a radius or an area rather
// than a shape (the editor's group centre of mass), so there is one statement of
// each in the project.
//
// A SPHERE is what the code-built round bodies are - the ball, its hook, a
// cannonball, the sandbox's rocks - and it is deliberately not an extrusion:
// extruding a ball to a slab's thickness makes small ones absurd (a 4 cm hook
// would outweigh a 5 cm rock six times over).
export function sphereMass(radius: number, density: number = DEFAULT_DENSITY): number {
  return (4 / 3) * Mathf.Pi * radius * radius * radius * density;
}

// A PRISM is what authored level geometry is: a flat piece cut from the world -
// a platform, a crate, a plank, a wheel - of the thickness the author gave it
// through the z axis the 2D view cannot show. Every shape kind takes this rule,
// a circle included: an authored circle is a disc seen face on (a wheel, a
// barrel end), and a `thickness` that some shapes quietly ignored would be a
// field that lies about what it does.
export function prismMass(
  area: number,
  thickness: number = DEFAULT_THICKNESS,
  density: number = DEFAULT_DENSITY,
): number {
  return area * thickness * density;
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

  // A shape's area in m², whichever kind it is. One statement of it, so the two
  // mass rules and the editor's centre of mass cannot disagree about how big a
  // shape is.
  area(shape: Shape): number {
    if (shape.kind === "circle") return Mathf.Pi * shape.radius * shape.radius;
    if (shape.kind === "poly") return polyArea(shape.verts);
    return shape.size.x * shape.size.y;
  },

  // Mass in KILOGRAMS: the shape's real volume times its material's density
  // (see `Density` above). The sim runs in metres and seconds, so mass is the
  // third SI unit and every derived quantity - momentum, impulses, kinetic
  // energy - is a real one too.
  //
  // This is the CODE-BUILT bodies' rule, where a circle is a SPHERE: the round
  // things built here are balls (the cast-iron ball, its hook, a cannonball, a
  // rock) and the flat ones are slabs of the default thickness. Authored level
  // geometry does not come through here - it is a prism of the thickness its
  // author gave it, `prismMass` over `area`, a circle included (see
  // `buildBodies.ts`), because there the field has to mean what it says.
  computeMass(shape: ShapeTransform, density: number = DEFAULT_DENSITY): number {
    const s = shape.shape;
    if (s.kind === "circle") return sphereMass(s.radius, density);
    return prismMass(ShapeGeometry.area(s), DEFAULT_THICKNESS, density);
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
