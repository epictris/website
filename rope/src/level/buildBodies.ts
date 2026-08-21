// Shared level-geometry builder. Turns (metre-scaled) LevelData bodies into
// engine bodies and adds them to the world, returning the subset the rope may
// wrap (statics + rigids, but not areas and not hook-only anchors). Used by
// both level drivers so the grapple and ball controllers load identical
// geometry, including rigid bodies.
//
// A body's COLLISION OBJECTS are the only thing that reaches the sim. A body
// with none of them is never built: no collision shape, no `World` membership,
// no mass, no vertex the rope can wrap - the exclusion IS the absence, so there
// is no physics path left to remember to exclude decoration from. What such a
// body still gets is a place to stand, which is what `BuiltBody.origin` is for.

import { Vec2 } from "../engine/vec2";
import {
  AnchorBody,
  ForceArea,
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
  WaterArea,
} from "../engine/body";
import { rectShape, circleShape, polyShapeCentred, type Shape } from "../engine/shapes";
import { decomposeConvex } from "../lib/polygon";
import { World } from "../engine/world";
import {
  DEFAULT_THICKNESS,
  materialDensity,
  prismMass,
  ShapeGeometry,
} from "../lib/shapeGeometry";
import { KillZone } from "../classes/killZone";
import {
  collides,
  isCollisionObject,
  DEFAULT_BODY_COLOR,
  DEFAULT_BODY_OPACITY,
  DEFAULT_SURFACE_FRICTION,
  type CollisionObjectData,
  type LevelBodyData,
  type LevelData,
  type ObjectPlacement,
  type ShapeData,
} from "./levelFormat";
import type { CollisionObject2D } from "../engine/body";

// An authored shape as the ENGINE primitives it is made of, each with the
// local-frame offset the loader had to remove from it. Only polygons ever carry
// one: their vertices are re-centred on the area centroid, because a body's
// origin is its centre of mass everywhere in this engine (every RigidBody2D
// lever arm is measured from `globalPosition`). The offset goes back onto the
// piece's position, so the geometry lands exactly where it was authored while
// the origin ends up where the physics needs it.
//
// A list rather than one shape because an authored polygon may be **concave**,
// and the engine's polygon is convex without exception (see "Convex-only
// polygons; compound bodies" in docs/game-design.md). A concave outline is cut
// here, at load, into the convex pieces that tile it (`decomposeConvex`), and
// what the solvers see is the compound body an author would otherwise have had
// to assemble by hand - same seams, same corners, same mass. A convex loop takes
// the single-piece path it always took, which is what keeps every polygon
// authored before this bit-identical.
function makeShapes(shape: ShapeData): { shape: Shape; offset: Vec2 }[] {
  if (shape.kind === "rect") return [{ shape: rectShape(shape.w, shape.h), offset: Vec2.ZERO }];
  if (shape.kind === "circle") return [{ shape: circleShape(shape.r), offset: Vec2.ZERO }];
  const verts = shape.verts.map((v) => new Vec2(v.x, v.y));
  const pieces = decomposeConvex(verts);
  // Empty means the loop crosses itself, so there is no inside to build. The
  // editor cannot author one (`setPolyVerts` refuses the edit), which leaves a
  // hand-edited file - and a loud failure is what a concave loop already got
  // here before it was cut up, rather than a level that quietly loses a wall.
  if (!pieces.length) {
    throw new Error(
      `collision polygon is not a simple outline (${verts.length} vertices, it crosses itself)`,
    );
  }
  return pieces.map((p) => polyShapeCentred(p));
}

function applyStyle(body: CollisionObject2D, b: LevelBodyData): void {
  body.fillColor = b.color ?? DEFAULT_BODY_COLOR;
  body.fillOpacity = b.opacity ?? DEFAULT_BODY_OPACITY;
  body.surfaceFriction = b.friction ?? DEFAULT_SURFACE_FRICTION;
}

// Where an object actually is, in world metres: its own placement composed
// through its body's frame. One function, so the build, both renderers and the
// editor cannot each have their own idea of what "local to the body" means.
export function worldPlacement(
  body: LevelBodyData,
  o: ObjectPlacement,
): { pos: Vec2; rot: number } {
  const lx = o.x ?? 0;
  const ly = o.y ?? 0;
  const cos = Math.cos(body.rot);
  const sin = Math.sin(body.rot);
  return {
    pos: new Vec2(body.x + lx * cos - ly * sin, body.y + lx * sin + ly * cos),
    rot: body.rot + (o.rot ?? 0),
  };
}

// ...and how far off the gameplay plane it ends up, which is the object's own
// business and only its own. Kept beside the placement above because the pair is
// the whole of "where does this end up", and to say the asymmetry out loud: x, y
// and rot compose through the body's frame because the body HAS them, and z does
// not because it does not. A body is a thing in the gameplay plane (see
// `LevelBodyData`), so depth is authored per drawn object, against the plane
// itself, and a fallback is what an object that says nothing takes.
export function objectDepth(z: number | undefined, fallback: number): number {
  return z ?? fallback;
}

// Coulomb coefficients an authored `rigid` body brings to its own contacts.
// `RigidBody2D`'s class defaults are 0 and have to stay 0 (recorded replays
// predate the fields, and the avatars that want friction set their own), but a
// piece of scenery built from a level is exactly the case those defaults are
// wrong for: with no coefficients the only thing resisting a shove is the 0.98
// `contactDamp`, which is a pure exponential coast and never grips at all - a
// crate nudged by the player glided a metre across a flat floor and was still
// drifting 300 frames later (session-477f).
//
// Both coefficients, because kinetic friction alone is not enough to be called
// friction at all. Coulomb friction is capped at μ × the frame's normal impulse,
// which on a resting body is just gravity's bite (g·cosθ·dt), so it can cancel
// the *velocity* gravity adds each frame but never the *step* the integrator
// already took with it: a box on a 5° ramp still walked 21 cm in fifteen seconds
// and was not slowing, and at 15° it was 63 cm. Holding a slope is precisely
// what the stick anchor does, and there is no way to have it without arming the
// anchor - `staticFriction` is what arms it.
//
// That is the cost, and it is a real one: the anchor pins the body's
// along-surface position, so a chain hauling a crate gently enough to stay under
// the grip's release speed is pinned back every frame and the chain reads as
// blocked. `applyRigidContactFriction` refuses stiction for exactly this reason
// against another *rigid* body, where the pin would also fight that body's own
// resolution pass. Against a static surface the pin has no such rival, and the
// grip releases the moment the body is moving at all (`STICK_SPEED`), so a chain
// with any real pull on it still drags the crate - which is what the two bundles
// with a chain anchored to a rigid polygon show (session-431f, session-1474f):
// both stay healthy, with the chain's blocked-length lease paid back to zero.
//
// Slab-of-scenery numbers, not the rolling ball's: μ_s ≥ μ_k, as for a body that
// slides rather than rolls, and μ_s = 0.7 puts the breakaway angle at
// atan(0.7) ≈ 35°, so a crate holds a shallow ramp and lets go of a steep one.
export const RIGID_KINETIC_FRICTION = 0.6;
export const RIGID_STATIC_FRICTION = 0.7;

// One authored body as built.
export interface BuiltBody {
  // The authored body (metres), so a consumer that has a `BuiltBody` never has
  // to carry the data alongside it.
  readonly data: LevelBodyData;
  // What moves. NULL for a body with no collision objects - decoration, a lone
  // light - which entered no world and therefore stands wherever it was
  // authored, for ever.
  readonly body: CollisionObject2D | null;
  // The frame this body's objects are resolved into, at rest. For a built body
  // it is the engine object's own origin, which is the pieces' combined centre
  // of mass and NOT the authored `x`/`y`; for an unbuilt one it is the authored
  // transform itself.
  //
  // The two differ on purpose. The engine's origin has to be the centre of mass
  // (every lever arm in the engine is measured from `globalPosition`) and it
  // moves as collision objects are added; the authored one has to stay put, or
  // every offset in a body would shift whenever a piece was added to it. This
  // is where the difference is absorbed, once, at load - the same job
  // `resolveDecor` used to do for decoration and `buildSceneChains` still does
  // for chain anchors.
  readonly origin: Vec2;
  readonly rotation: number;
}

// Where one of a body's objects sits in the frame that actually moves - the
// engine body's, or the authored one for a body that built nothing. Rigid, so
// every caller works it out once at build and never per frame.
export function localPlacement(
  built: BuiltBody,
  o: ObjectPlacement,
): { pos: Vec2; rot: number } {
  const world = worldPlacement(built.data, o);
  return {
    pos: world.pos.sub(built.origin).rotated(-built.rotation),
    rot: world.rot - built.rotation,
  };
}

// What `buildLevelBodies` hands back.
export interface BuiltBodies {
  // Everything the rope may wrap: statics and rigids, but not areas (the rope
  // passes through) and not hook-only anchors (nothing catches on them).
  wrapBodies: PhysicsBody2D[];
  // One entry per `data.bodies` entry, in authored order. Chains resolve their
  // authored body index straight through this - which is now an index into the
  // bodies rather than into a flat entry list, so a chain names a body and
  // there is nothing left to collapse.
  bodies: BuiltBody[];
}

// The level as built, from the renderers' point of view: the metre-scaled data
// and what it became. Both level drivers keep one (`visualSource`), which is the
// whole of what a renderer needs to know about the file a level came from.
export interface LevelVisualSource {
  data: LevelData;
  built: BuiltBodies;
}

// One collision object, resolved to the shape and the world placement it asks
// for.
interface Piece {
  shape: Shape;
  pos: Vec2;
  rot: number;
  mass: number;
  // Hook-proof (`CollisionObjectData.impermeable`), carried per piece: one body
  // may be attachable on one face and repel the hook on the next, which is why
  // the flag lives on the mounted `CollisionShape2D` rather than on a body kind.
  impermeable: boolean;
}

// One collision object as the pieces it builds: one for every kind but a
// concave polygon, which builds the several convex pieces it was cut into.
//
// The pieces share everything the object authored - its placement, its
// hook-proofing, its material and thickness - and split its MASS by area, which
// is the same arithmetic as weighing each piece on its own: the cut is a
// partition, so the piece areas sum to the outline's area and the pieces' masses
// to its mass, with the combined centre of mass landing on its centroid.
function makePieces(body: LevelBodyData, o: CollisionObjectData): Piece[] {
  const world = worldPlacement(body, o);
  return makeShapes(o.shape).map((made) => makePiece(o, made, world));
}

function makePiece(
  o: CollisionObjectData,
  made: { shape: Shape; offset: Vec2 },
  world: { pos: Vec2; rot: number },
): Piece {
  // A re-centred polygon's origin moved; put the geometry back where it was
  // authored by shifting it by the (rotated) offset that was removed.
  return {
    shape: made.shape,
    pos: world.pos.add(made.offset.rotated(world.rot)),
    rot: world.rot,
    impermeable: o.impermeable === true,
    // The piece's own material and thickness, not the body's: they are the one
    // authored property a body does not have just one of, and every sum below -
    // centre of mass, mass, inertia - is written over the pieces precisely so
    // each can bring its own.
    //
    // A prism whatever the shape kind, a circle included: an authored circle is
    // a disc seen face on (a wheel, a barrel end), so it is `thickness` thick
    // like everything else on the level. The sphere rule is the code-built
    // round bodies' (the ball, its hook, the sandbox's rocks) and stays theirs -
    // see `ShapeGeometry.computeMass`.
    mass: prismMass(
      ShapeGeometry.area(made.shape),
      o.thickness ?? DEFAULT_THICKNESS,
      materialDensity(o.material),
    ),
  };
}

// Mount `pieces` on `body`: the origin goes to their combined centre of mass and
// each piece keeps its authored placement as a local offset and angle. The
// centre of mass - not the first piece, not the bounding-box centre - because
// every rigid-body lever arm in the engine is measured from `globalPosition`.
// A single piece reduces to the body carrying the piece's transform itself,
// offset zero and local rotation zero.
function mountPieces(body: CollisionObject2D, pieces: Piece[]): void {
  const total = pieces.reduce((m, p) => m + p.mass, 0);
  const centre =
    total > 0
      ? pieces.reduce((c, p) => c.add(p.pos.mul(p.mass)), Vec2.ZERO).div(total)
      : pieces.reduce((c, p) => c.add(p.pos), Vec2.ZERO).div(pieces.length);
  if (pieces.length === 1) {
    const only = pieces[0]!;
    body.globalPosition = only.pos;
    body.globalRotation = only.rot;
    body.setShape(only.shape).impermeable = only.impermeable;
    return;
  }
  body.globalPosition = centre;
  body.globalRotation = 0;
  body.collisionShapes = [];
  for (const p of pieces) {
    body.addShape(p.shape, p.pos.sub(centre), p.rot).impermeable = p.impermeable;
  }
}

// Mass and moment of inertia of a mounted compound body. Each piece contributes
// its own second moment about its own centroid plus the parallel-axis term for
// how far that centroid sits from the body origin.
//
// The masses come from the `pieces` rather than being re-derived from the
// mounted shapes, because a shape carries neither material nor thickness:
// re-deriving here would weigh every piece as 20 cm of oak and silently
// disagree with the centre of mass `mountPieces` just placed the origin at.
// `mountPieces` mounts the pieces in order, so the two lists correspond index
// for index.
function setCompoundInertia(rb: RigidBody2D, pieces: Piece[]): void {
  let mass = 0;
  let inertia = 0;
  const shapes = rb.getShapes();
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i]!;
    const m = pieces[i]!.mass;
    const d = s.localOffset.lengthSquared();
    mass += m;
    inertia += ShapeGeometry.computeMomentOfInertia(s, m) + m * d;
  }
  rb.mass = mass;
  rb.inertia = inertia;
}

// `data` must already be in metres (scaleLevelData(_, PX)). `onReset` fires when
// the avatar enters a killzone.
export function buildLevelBodies(
  world: World,
  data: LevelData,
  onReset: () => void,
): BuiltBodies {
  const wrapBodies: PhysicsBody2D[] = [];
  const bodies: BuiltBody[] = [];

  for (const b of data.bodies) {
    if (!collides(b)) {
      // Nothing to build. It keeps its place in this list so that a chain, a
      // renderer or the editor can still name it by index - a body that builds
      // no engine object is a perfectly ordinary thing to author, and it is what
      // decoration and a light with no visible source both are.
      bodies.push({ data: b, body: null, origin: new Vec2(b.x, b.y), rotation: b.rot });
      continue;
    }
    const pieces = b.objects.filter(isCollisionObject).flatMap((o) => makePieces(b, o));
    const built = buildOne(world, b, pieces, onReset);
    bodies.push({
      data: b,
      body: built,
      origin: built.globalPosition,
      rotation: built.globalRotation,
    });
    // Wrappable geometry is exactly the solid bodies: areas are not
    // PhysicsBody2D at all, and an AnchorBody reports `isSolid` false.
    if (built instanceof PhysicsBody2D && built.isSolid) wrapBodies.push(built);
  }

  return { wrapBodies, bodies };
}

function buildOne(
  world: World,
  b: LevelBodyData,
  pieces: Piece[],
  onReset: () => void,
): CollisionObject2D {
  if (b.kind === "killzone") {
    const kz = new KillZone(onReset);
    mountPieces(kz, pieces);
    applyStyle(kz, b);
    world.add(kz);
    return kz;
  }

  if (b.kind === "force") {
    // A current: accelerates whatever is inside along the area's rotation.
    // Not a wrap body - the rope passes straight through it.
    const fa = new ForceArea();
    mountPieces(fa, pieces);
    fa.magnitude = b.force ?? 0;
    applyStyle(fa, b);
    world.add(fa);
    return fa;
  }

  if (b.kind === "water") {
    // A body of water: drags whatever is inside it toward its current, aimed by
    // the area's rotation. Not a wrap body either - the rope passes straight
    // through it, and a chain hanging in a sewer channel is a chain in water
    // rather than a chain caught on it.
    const wa = new WaterArea();
    mountPieces(wa, pieces);
    wa.flow = b.flow ?? 0;
    wa.drag = b.drag ?? 0;
    applyStyle(wa, b);
    world.add(wa);
    return wa;
  }

  if (b.kind === "anchor") {
    // Hook-only geometry: in the world so the hook's queries can find it, but
    // NOT a wrap body - keeping it out of the returned list is what stops the
    // rope from catching on scenery the player passes straight through.
    const ab = new AnchorBody();
    mountPieces(ab, pieces);
    applyStyle(ab, b);
    world.add(ab);
    return ab;
  }

  if (b.kind === "rigid") {
    const rb = new RigidBody2D();
    mountPieces(rb, pieces);
    setCompoundInertia(rb, pieces);
    applyStyle(rb, b);
    // Bolted to a bearing at its centre of mass (see `LevelBodyData.pivot`):
    // free to spin, unable to translate. Mass and inertia above are kept as
    // computed - the inertia is what torque answers to, and the mass is what a
    // pushing character's impulse is sized against.
    rb.pivot = b.pivot === true;
    // The authored `friction` is the body's material grip, so it scales what the
    // body brings to a contact as well as what it offers one: an ice block is
    // slippery to stand on *and* slides on the floor it sits on. The contact
    // solve multiplies the two sides together, so an ice block on an ice floor
    // is frictionless from either end, which is the answer either reading gives.
    rb.contactFriction = RIGID_KINETIC_FRICTION * rb.surfaceFriction;
    rb.staticFriction = RIGID_STATIC_FRICTION * rb.surfaceFriction;
    world.add(rb);
    return rb;
  }

  // Hook-proof is not a kind any more - it is a flag `mountPieces` puts on the
  // shapes themselves, so an ordinary static carries it (see `Piece`).
  const sb = new StaticBody2D();
  mountPieces(sb, pieces);
  applyStyle(sb, b);
  world.add(sb);
  return sb;
}
