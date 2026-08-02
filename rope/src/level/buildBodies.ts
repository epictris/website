// Shared level-geometry builder. Turns (metre-scaled) LevelData bodies into
// engine bodies and adds them to the world, returning the subset the rope may
// wrap (statics + rigids, but not areas and not hook-only anchors). Used by
// both level drivers so the grapple and ball controllers load identical
// geometry, including rigid bodies.

import { Vec2 } from "../engine/vec2";
import {
  AnchorBody,
  ForceArea,
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
} from "../engine/body";
import { rectShape, circleShape, polyShapeCentred, type Shape } from "../engine/shapes";
import { World } from "../engine/world";
import {
  DEFAULT_THICKNESS,
  materialDensity,
  prismMass,
  ShapeGeometry,
} from "../lib/shapeGeometry";
import { KillZone } from "../classes/killZone";
import { collides, resolveDecor, type SceneDecor } from "./decor";
import {
  DEFAULT_BODY_COLOR,
  DEFAULT_BODY_OPACITY,
  DEFAULT_SURFACE_FRICTION,
  type LevelBodyData,
  type LevelData,
} from "./levelFormat";
import type { CollisionObject2D } from "../engine/body";

// An authored shape plus the local-frame offset the loader had to remove from
// it. Only polygons ever carry one: their vertices are re-centred on the area
// centroid, because a body's origin is its centre of mass everywhere in this
// engine (every RigidBody2D lever arm is measured from `globalPosition`). The
// offset goes back onto the body's position, so the geometry lands exactly where
// it was authored while the origin ends up where the physics needs it.
function makeShape(shape: LevelBodyData["shape"]): { shape: Shape; offset: Vec2 } {
  if (shape.kind === "rect") return { shape: rectShape(shape.w, shape.h), offset: Vec2.ZERO };
  if (shape.kind === "circle") return { shape: circleShape(shape.r), offset: Vec2.ZERO };
  return polyShapeCentred(shape.verts.map((v) => new Vec2(v.x, v.y)));
}

function applyStyle(body: CollisionObject2D, b: LevelBodyData): void {
  body.fillColor = b.color ?? DEFAULT_BODY_COLOR;
  body.fillOpacity = b.opacity ?? DEFAULT_BODY_OPACITY;
  body.surfaceFriction = b.friction ?? DEFAULT_SURFACE_FRICTION;
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

// What `buildLevelBodies` hands back.
export interface BuiltBodies {
  // Everything the rope may wrap: statics and rigids, but not areas (the rope
  // passes through) and not hook-only anchors (nothing catches on them).
  wrapBodies: PhysicsBody2D[];
  // The engine object each `data.bodies` entry became, by index. Several entries
  // of one compound group map to the SAME object, which is the whole point of a
  // group; chains resolve their authored body index through this.
  byIndex: (CollisionObject2D | null)[];
  // The engine object each compound-group TAG became. Keyed by the tag rather
  // than by an index because a group's members belong to the group, not to one
  // particular entry of it, and the group is what has an engine body. A tag no
  // body carries (a group of decoration alone, or one whose colliding pieces
  // were all deleted) is simply absent.
  byGroup: Map<string, CollisionObject2D>;
  // The authored entries that are drawn but never simulated
  // (`LevelBodyData.collision: false`), each resolved to the body it rides, in
  // authored order. They are NOT in `byIndex`: they became no engine object and
  // no piece of one, which is the whole of what the flag means.
  decor: SceneDecor[];
  // Which SHAPE of that engine object each `data.bodies` entry became, by index.
  // `byIndex` alone cannot answer this once groups exist: several entries map to
  // one body, and a per-entry property (`material`, `impermeable`, and now
  // `visual`) belongs to one piece of it. The 3D renderer needs the piece so a
  // visual anchors to the local transform it was authored against; nothing in
  // the sim reads it, which is why it is an additive field rather than a change
  // to `byIndex`.
  shapeIndexByIndex: number[];
}

// The level as built, from the 3D renderer's point of view: the metre-scaled
// data and the mapping from its entries to engine objects and pieces. Both level
// drivers keep one (`visualSource`), which is the whole of what the renderer
// needs to know about the file a level came from.
export interface LevelVisualSource {
  data: LevelData;
  built: BuiltBodies;
}

// Areas are single-shape everywhere they are used - `World.integrate` tests
// overlap against `area.primaryShape()`, not `getShapes()` - so a grouped area would
// silently act through its first piece alone. Grouping is geometry-only; an area
// tagged into a group is built as its own body instead.
function groupable(kind: LevelBodyData["kind"]): boolean {
  return kind !== "killzone" && kind !== "force";
}

// The authored entries in build order, each as the run of entries that make up
// one engine body. A group's run is emitted where its FIRST member sits, so
// z-order and the `byIndex` mapping stay in authored order.
//
// Decoration is in its run like any other member: it is what welds it to the
// body, and it is dropped from the pieces (not from the run) further down, so
// "which body does this ride" and "which shapes does that body have" are read
// off one grouping rather than two that can disagree. Its own kind is not
// consulted for `groupable` - a kind is a statement about physics and a
// non-colliding shape makes none, so a piece of decoration a level happens to
// leave marked `force` still rides the crate it was welded to.
function groupRuns(bodies: readonly LevelBodyData[]): Array<{ tag: string | null; indices: number[] }> {
  const runs: Array<{ tag: string | null; indices: number[] }> = [];
  const byTag = new Map<string, { tag: string | null; indices: number[] }>();
  bodies.forEach((b, i) => {
    const tag = b.group && (!collides(b) || groupable(b.kind)) ? b.group : null;
    if (tag === null) {
      runs.push({ tag: null, indices: [i] });
      return;
    }
    const existing = byTag.get(tag);
    if (existing) {
      existing.indices.push(i);
      return;
    }
    const run = { tag, indices: [i] };
    byTag.set(tag, run);
    runs.push(run);
  });
  return runs;
}

// One authored entry, resolved to the shape and the world placement it asks for.
interface Piece {
  shape: Shape;
  pos: Vec2;
  rot: number;
  mass: number;
  // Hook-proof (`LevelBodyData.impermeable`), carried per piece: one body may
  // be attachable on one face and repel the hook on the next, which is why the
  // flag lives on the mounted `CollisionShape2D` rather than on a body kind.
  impermeable: boolean;
}

function makePiece(b: LevelBodyData): Piece {
  const made = makeShape(b.shape);
  // A re-centred polygon's origin moved; put the geometry back where it was
  // authored by shifting it by the (rotated) offset that was removed.
  const pos = new Vec2(b.x, b.y).add(made.offset.rotated(b.rot));
  return {
    shape: made.shape,
    pos,
    rot: b.rot,
    impermeable: b.impermeable === true,
    // The piece's own material and thickness, not the group's: they are the one
    // authored property a compound body does not have just one of, and every
    // sum below - centre of mass, mass, inertia - is written over the pieces
    // precisely so each can bring its own.
    //
    // A prism whatever the shape kind, a circle included: an authored circle is
    // a disc seen face on (a wheel, a barrel end), so it is `thickness` thick
    // like everything else on the level. The sphere rule is the code-built
    // round bodies' (the ball, its hook, the sandbox's rocks) and stays theirs -
    // see `ShapeGeometry.computeMass`.
    mass: prismMass(
      ShapeGeometry.area(made.shape),
      b.thickness ?? DEFAULT_THICKNESS,
      materialDensity(b.material),
    ),
  };
}

// Mount `pieces` on `body`: the origin goes to their combined centre of mass and
// each piece keeps its authored placement as a local offset and angle. The
// centre of mass - not the first piece, not the bounding-box centre - because
// every rigid-body lever arm in the engine is measured from `globalPosition`.
// A single piece reduces to exactly the old behaviour: offset zero, local
// rotation zero, the body carrying the authored transform itself.
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
  const byIndex: (CollisionObject2D | null)[] = data.bodies.map(() => null);
  const byGroup = new Map<string, CollisionObject2D>();
  const shapeIndexByIndex: number[] = data.bodies.map(() => 0);
  // Decoration, paired with the run it belongs to; resolved after the loop,
  // since resolving needs the body's final origin and that is the run's combined
  // centre of mass rather than anything an entry states.
  const pending: Array<{ index: number; run: number }> = [];
  const runBody: (CollisionObject2D | null)[] = [];

  for (const run of groupRuns(data.bodies)) {
    const runIndex = runBody.length;
    // Drawn-only entries are dropped here and nowhere else. Not built means not
    // in the world, not a collision shape, not a gram of mass and not a vertex
    // the rope can wrap - the exclusion is the absence, so there is no physics
    // path left to remember to exclude them from.
    const solid = run.indices.filter((i) => collides(data.bodies[i]!));
    for (const i of run.indices) {
      if (!collides(data.bodies[i]!)) pending.push({ index: i, run: runIndex });
    }
    if (solid.length === 0) {
      // A group of decoration alone: nothing to build, and its members stay
      // where they were authored. Legitimate rather than an error - it is what
      // several panels moved as one has always been.
      runBody.push(null);
      continue;
    }
    // A group's kind, style and friction come from its first COLLIDING member: a
    // body has one of each, and the editor keeps a group's members in agreement
    // so a file never disagrees with what it draws.
    const lead = data.bodies[solid[0]!]!;
    const pieces = solid.map((i) => makePiece(data.bodies[i]!));
    const built = buildOne(world, lead, pieces, onReset);
    // `mountPieces` mounts the run's pieces in order, so entry `solid[k]` is
    // shape `k` of the body it built - the same correspondence
    // `setCompoundInertia` relies on to weigh each piece by its own material.
    solid.forEach((i, k) => {
      byIndex[i] = built;
      shapeIndexByIndex[i] = k;
    });
    runBody.push(built);
    if (run.tag !== null) byGroup.set(run.tag, built);
    // Wrappable geometry is exactly the solid bodies: areas are not
    // PhysicsBody2D at all, and an AnchorBody reports `isSolid` false.
    if (built instanceof PhysicsBody2D && built.isSolid) wrapBodies.push(built);
  }

  // Authored order, which is the order they are drawn in.
  pending.sort((a, b) => a.index - b.index);
  const decor = pending.map((p) => resolveDecor(data.bodies[p.index]!, runBody[p.run] ?? null));

  return { wrapBodies, byIndex, byGroup, shapeIndexByIndex, decor };
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
