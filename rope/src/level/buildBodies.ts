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

// `data` must already be in metres (scaleLevelData(_, PX)). `onReset` fires when
// the avatar enters a killzone.
export function buildLevelBodies(
  world: World,
  data: LevelData,
  onReset: () => void,
): PhysicsBody2D[] {
  const wrapBodies: PhysicsBody2D[] = [];

  for (const b of data.bodies) {
    const made = makeShape(b.shape);
    const shape = made.shape;
    // A re-centred polygon's origin moved; put the geometry back where it was
    // authored by shifting the body by the (rotated) offset that was removed.
    const pos = new Vec2(b.x, b.y).add(made.offset.rotated(b.rot));

    if (b.kind === "killzone") {
      const kz = new KillZone(onReset);
      kz.setShape(shape);
      kz.globalPosition = pos;
      kz.globalRotation = b.rot;
      applyStyle(kz, b);
      world.add(kz);
      continue;
    }

    if (b.kind === "force") {
      // A current: accelerates whatever is inside along the area's rotation.
      // Not a wrap body — the rope passes straight through it.
      const fa = new ForceArea();
      fa.setShape(shape);
      fa.globalPosition = pos;
      fa.globalRotation = b.rot;
      fa.magnitude = b.force ?? 0;
      applyStyle(fa, b);
      world.add(fa);
      continue;
    }

    if (b.kind === "anchor") {
      // Hook-only geometry: in the world so the hook's queries can find it, but
      // NOT a wrap body — keeping it out of the returned list is what stops the
      // rope from catching on scenery the player passes straight through.
      const ab = new AnchorBody();
      ab.setShape(shape);
      ab.globalPosition = pos;
      ab.globalRotation = b.rot;
      applyStyle(ab, b);
      world.add(ab);
      continue;
    }

    if (b.kind === "rigid") {
      const rb = new RigidBody2D();
      rb.setShape(shape);
      rb.mass = ShapeGeometry.computeMass(rb.getShape());
      rb.inertia = ShapeGeometry.computeMomentOfInertia(rb.getShape(), rb.mass);
      rb.globalPosition = pos;
      rb.globalRotation = b.rot;
      applyStyle(rb, b);
      world.add(rb);
      wrapBodies.push(rb);
      continue;
    }

    const sb = b.kind === "impermeable" ? new ImpermeableBody() : new StaticBody2D();
    sb.setShape(shape);
    sb.globalPosition = pos;
    sb.globalRotation = b.rot;
    applyStyle(sb, b);
    world.add(sb);
    wrapBodies.push(sb);
  }

  return wrapBodies;
}
