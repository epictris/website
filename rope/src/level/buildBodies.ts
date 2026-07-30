// Shared level-geometry builder. Turns (metre-scaled) LevelData bodies into
// engine bodies and adds them to the world, returning the subset the rope may
// wrap (statics + rigids, but not areas and not hook-only anchors). Used by
// both level drivers so the grapple and ball controllers load identical
// geometry, including rigid bodies.

import { Vec2 } from "../engine/vec2";
import {
  AnchorBody,
  ForceArea,
  ImpermeableBody,
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
} from "../engine/body";
import { rectShape, circleShape, polyShapeCentred, type Shape } from "../engine/shapes";
import { World } from "../engine/world";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { KillZone } from "../classes/killZone";
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

// What `buildLevelBodies` hands back.
export interface BuiltBodies {
  // Everything the rope may wrap: statics and rigids, but not areas (the rope
  // passes through) and not hook-only anchors (nothing catches on them).
  wrapBodies: PhysicsBody2D[];
  // The engine object each `data.bodies` entry became, by index. Several entries
  // of one compound group map to the SAME object, which is the whole point of a
  // group; chains resolve their authored body index through this.
  byIndex: (CollisionObject2D | null)[];
}

// Areas are single-shape everywhere they are used - `World.integrate` tests
// overlap against `area.getShape()`, not `getShapes()` - so a grouped area would
// silently act through its first piece alone. Grouping is geometry-only; an area
// tagged into a group is built as its own body instead.
function groupable(kind: LevelBodyData["kind"]): boolean {
  return kind !== "killzone" && kind !== "force";
}

// The authored entries in build order, each as the run of entries that make up
// one engine body. A group's run is emitted where its FIRST member sits, so
// z-order and the `byIndex` mapping stay in authored order.
function groupRuns(bodies: readonly LevelBodyData[]): Array<{ indices: number[] }> {
  const runs: Array<{ indices: number[] }> = [];
  const byTag = new Map<string, { indices: number[] }>();
  bodies.forEach((b, i) => {
    const tag = b.group && groupable(b.kind) ? b.group : null;
    if (tag === null) {
      runs.push({ indices: [i] });
      return;
    }
    const existing = byTag.get(tag);
    if (existing) {
      existing.indices.push(i);
      return;
    }
    const run = { indices: [i] };
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
    mass: ShapeGeometry.computeMass({ shape: made.shape, globalPosition: pos, globalRotation: b.rot }),
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
    body.setShape(only.shape);
    return;
  }
  body.globalPosition = centre;
  body.globalRotation = 0;
  body.collisionShapes = [];
  for (const p of pieces) body.addShape(p.shape, p.pos.sub(centre), p.rot);
}

// Mass and moment of inertia of a mounted compound body. Each piece contributes
// its own second moment about its own centroid plus the parallel-axis term for
// how far that centroid sits from the body origin.
function setCompoundInertia(rb: RigidBody2D): void {
  let mass = 0;
  let inertia = 0;
  for (const s of rb.getShapes()) {
    const m = ShapeGeometry.computeMass(s);
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

  for (const run of groupRuns(data.bodies)) {
    // A group's kind, style and friction come from its first member: a body has
    // one of each, and the editor keeps a group's members in agreement so a file
    // never disagrees with what it draws.
    const lead = data.bodies[run.indices[0]!]!;
    const pieces = run.indices.map((i) => makePiece(data.bodies[i]!));
    const built = buildOne(world, lead, pieces, onReset);
    for (const i of run.indices) byIndex[i] = built;
    // Wrappable geometry is exactly the solid bodies: areas are not
    // PhysicsBody2D at all, and an AnchorBody reports `isSolid` false.
    if (built instanceof PhysicsBody2D && built.isSolid) wrapBodies.push(built);
  }

  return { wrapBodies, byIndex };
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
    setCompoundInertia(rb);
    applyStyle(rb, b);
    world.add(rb);
    return rb;
  }

  const sb = b.kind === "impermeable" ? new ImpermeableBody() : new StaticBody2D();
  mountPieces(sb, pieces);
  applyStyle(sb, b);
  world.add(sb);
  return sb;
}
