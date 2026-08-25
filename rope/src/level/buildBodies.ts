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
  ForceArea,
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
  WaterArea,
} from "../engine/body";
import { rectShape, circleShape, polyShapeCentred, type Shape } from "../engine/shapes";
import { decomposeConvex } from "../lib/polygon";
import { GRAVITY, World } from "../engine/world";
import { wrapAngle } from "../engine/mathf";
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
  DEFAULT_BOUNCE,
  DEFAULT_LAUNCH,
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
  // The trampoline pair (see `LevelBodyData.bounce`). Applied here, with the
  // friction, because it is the same sort of thing: what this surface is like to
  // meet, stated once by the body and read by whatever meets it. Every kind gets
  // it - an area is never a contact side, so setting it there costs nothing and
  // saves the build a branch that would have to be kept in step with the kinds.
  body.restitution = b.bounce ?? DEFAULT_BOUNCE;
  body.launchSpeed = b.launch ?? DEFAULT_LAUNCH;
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

// Spring bodies (see `LevelBodyData.springFreqX`). The damping default is a few
// visible swings before it settles, which is the whole point of the mechanic -
// critically damped, the leaf would simply sink and return. The frequency
// ceiling is shared with the editor's inspector: 8 Hz is already visually rigid
// and sits well under the ~19 Hz where semi-implicit Euler stops being stable at
// the fixed 1/60 step, so it is a bound on nonsense rather than on authoring.
export const DEFAULT_SPRING_DAMPING = 0.15;
export const MAX_SPRING_FREQ = 8;

function clampFreq(f: number): number {
  return Number.isFinite(f) ? Math.min(MAX_SPRING_FREQ, Math.max(0, f)) : 0;
}

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

// Move a mounted rigid body's origin from the centre of mass `mountPieces`
// placed it at onto `point` - the authored bearing of an off-centre pivot
// (`LevelBodyData.pivotX`). Every piece keeps its world placement (the local
// offsets absorb the shift), the inertia gains the parallel-axis term for the
// centre of mass now being off-origin, and the return value is that centre in
// the body's new local frame - which is what gravity's torque about the
// bearing is measured by (`RigidBody2D.pivotComOffset`). Must run AFTER
// `setCompoundInertia` (the term stacks on the centre-of-mass inertia) and at
// build only, before anything queries the body: the per-shape caches never see
// the old frame (see `CollisionShape2D.isVertexExposed`).
function reoriginTo(rb: RigidBody2D, point: Vec2): Vec2 {
  const comLocal = rb.globalPosition.sub(point).rotated(-rb.globalRotation);
  for (const s of rb.getShapes()) s.localOffset = s.localOffset.add(comLocal);
  rb.inertia += rb.mass * comLocal.lengthSquared();
  rb.globalPosition = point;
  return comLocal;
}

// A sprung body SPAWNS at its rest pose rather than at the authored one, so a
// level does not open with every leaf and branch visibly falling to where it
// was always going to hang - and so the editor's scene, built through this same
// function, shows the level as it will actually stand. The authored pose keeps
// its whole meaning: it is the spring's anchor and the torsion spring's rest
// angle, and the displacement here is the same closed-form equilibrium
// `cli spring` asserts the sim settles to. A fixed point of the integrator, the
// statement `buildVines` already makes about a catenary: a settled body is at
// rest on frame one, with nothing for the first seconds to correct.
//
// Called AFTER the `BuiltBody` frame is captured (see the build loop), which is
// load-bearing: `localPlacement` resolves every geometry object, decoration and
// chain anchor against the frame the authored placements were written in, so
// the origin recorded there must be the pre-settle one - resolved against the
// settled pose instead, a leaf's visual stands at the authored spot while its
// body hangs below it.
function applyRestPose(rb: RigidBody2D): void {
  if (rb.spring) {
    // Per-axis droop `g/w²`: gravity has no x component, and a pinned axis
    // (omega 0) is pinned to the anchor already.
    if (rb.spring.omegaY > 0) {
      const droop = (GRAVITY.y * rb.gravityScale) / (rb.spring.omegaY * rb.spring.omegaY);
      rb.globalPosition = new Vec2(rb.spring.anchor.x, rb.spring.anchor.y + droop);
    }
    return;
  }
  if (rb.pivot) rb.globalRotation = settledPivotAngle(rb);
}

// Where a pivot body comes to rest, from the pose it stands at now. Exported
// for the editor's settled ghost, so what the canvas draws cannot disagree with
// where the build spawns.
export function settledPivotAngle(rb: RigidBody2D): number {
  const r = rb.pivotComOffset;
  const d = r.length();
  const theta0 = rb.globalRotation;
  const g = GRAVITY.y * rb.gravityScale;
  // A bearing at the centre of mass gives gravity no leverage (the plain
  // windmill, bit-for-bit unchanged); the epsilon guards a bearing authored a
  // float's width off it, whose "hanging" angle would be the noise's atan2.
  if (d < 1e-9 || g === 0) return theta0;
  if (!rb.pivotSpring) {
    // A free bearing hangs with the centre of mass straight below (or above,
    // for a negative gravity scale), at the representative nearest the
    // authored angle.
    const hang = (g > 0 ? Math.PI / 2 : -Math.PI / 2) - Math.atan2(r.y, r.x);
    return theta0 + wrapAngle(hang - theta0);
  }
  // Torsion spring: the root of `I·w²·(θ - rest) = m·g·(r rotated θ).x`,
  // gravity's torque about the bearing against the spring's. Transcendental,
  // so it is bisected from the same statement `World.integrate` applies; the
  // bracket is the largest deflection gravity's bounded torque can buy
  // (`m·|g|·d / I·w²`), inside which the two sides are guaranteed to cross.
  const s = rb.pivotSpring;
  const k = rb.inertia * s.omega * s.omega;
  const span = (rb.mass * Math.abs(g) * d) / k + 1e-6;
  let lo = s.restAngle - span;
  let hi = s.restAngle + span;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (k * (mid - s.restAngle) - rb.mass * g * r.rotated(mid).x < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
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
    // The rest-pose displacement comes AFTER the frame above is captured - the
    // local placements every geometry object, decoration and chain anchor
    // resolve through must be measured in the authored frame, so they ride the
    // settled body rather than standing where it was drawn (see
    // `applyRestPose`).
    if (built instanceof RigidBody2D) applyRestPose(built);
    // Wrappable geometry is exactly the solid bodies: areas are not
    // PhysicsBody2D at all, and a `passable` body reports `isSolid` false.
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
    // An authored pivot POINT re-origins the body onto its bearing (see
    // `LevelBodyData.pivotX`): with the origin at the hinge, `inverseMass` 0
    // holds the axle and every lever arm the engine measures from
    // `globalPosition` is the hinged body's own, so no impulse path needs to
    // know. What is kept is the centre of mass in the body's local frame, for
    // gravity's torque about the bearing.
    if (rb.pivot && (b.pivotX !== undefined || b.pivotY !== undefined)) {
      const bearing = worldPlacement(b, { x: b.pivotX ?? 0, y: b.pivotY ?? 0 });
      rb.pivotComOffset = reoriginTo(rb, bearing.pos);
    }
    // ...and a torsion spring about it (see `LevelBodyData.pivotFreq`): the
    // rest angle is the angle the body was BUILT at, the same statement the
    // linear spring's anchor makes about position. Clamped exactly as the
    // linear spring's frequency is, and for the same integrator reason.
    if (rb.pivot && b.pivotFreq) {
      rb.pivotSpring = {
        restAngle: rb.globalRotation,
        omega: 2 * Math.PI * clampFreq(b.pivotFreq),
        zeta: Math.min(1, Math.max(0, b.pivotDamping ?? DEFAULT_SPRING_DAMPING)),
      };
    }
    // Held at its authored position by a two-axis spring-damper instead (see
    // `LevelBodyData.springFreqX`): it sags under load and springs back. The
    // anchor is taken AFTER `mountPieces`, so it is the body's centre of mass -
    // the point every impulse and the position step already act through - and
    // not wherever the first piece happened to be drawn.
    //
    // `!rb.pivot` restates the exclusion `normalizeLevelData` already resolved:
    // a hand-written level that never passed through the loader's normalisation
    // must not build a body that can neither translate nor rotate. The clamp is
    // the same belt and braces - 8 Hz is already visually rigid, and the
    // integrator wants w·dt < 2 - so a typo'd frequency is a stiff spring
    // rather than an explosion.
    if (!rb.pivot && (b.springFreqX || b.springFreqY)) {
      rb.spring = {
        anchor: rb.globalPosition,
        omegaX: 2 * Math.PI * clampFreq(b.springFreqX ?? 0),
        omegaY: 2 * Math.PI * clampFreq(b.springFreqY ?? 0),
        zeta: Math.min(1, Math.max(0, b.springDamping ?? DEFAULT_SPRING_DAMPING)),
      };
    }
    // The authored `friction` is the body's material grip, so it scales what the
    // body brings to a contact as well as what it offers one: an ice block is
    // slippery to stand on *and* slides on the floor it sits on. The contact
    // solve multiplies the two sides together, so an ice block on an ice floor
    // is frictionless from either end, which is the answer either reading gives.
    rb.contactFriction = RIGID_KINETIC_FRICTION * rb.surfaceFriction;
    rb.staticFriction = RIGID_STATIC_FRICTION * rb.surfaceFriction;
    // Hook-only (see `LevelBodyData.passable`): it still falls, is still sprung
    // to its anchor and is still hauled about by a chain attached to it - what
    // it stops having is contacts, so nothing in the scene is in its way and it
    // is in nothing else's. A background leaf on a stem is exactly that body.
    rb.passable = b.passable === true;
    world.add(rb);
    return rb;
  }

  // Hook-proof is not a kind any more - it is a flag `mountPieces` puts on the
  // shapes themselves, so an ordinary static carries it (see `Piece`).
  const sb = new StaticBody2D();
  mountPieces(sb, pieces);
  applyStyle(sb, b);
  // ...and hook-only is not a kind any more either: a static that nothing but
  // the hook can find is what the retired `anchor` kind was, and as a flag it
  // composes with `rigid` as well (see `LevelBodyData.passable`).
  sb.passable = b.passable === true;
  world.add(sb);
  return sb;
}
