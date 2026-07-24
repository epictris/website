// Shared level-geometry builder. Turns (metre-scaled) LevelData bodies into
// engine bodies and adds them to the world, returning the subset the rope may
// wrap (statics + rigids, but not killzones). Used by both level drivers so the
// grapple and ball controllers load identical geometry, including rigid bodies.

import { Vec2 } from "../engine/vec2";
import {
  ImpermeableBody,
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
} from "../engine/body";
import { rectShape, circleShape } from "../engine/shapes";
import { World } from "../engine/world";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { KillZone } from "../classes/killZone";
import {
  DEFAULT_BODY_COLOR,
  DEFAULT_BODY_OPACITY,
  type LevelBodyData,
  type LevelData,
} from "./levelFormat";
import type { CollisionObject2D } from "../engine/body";

function makeShape(shape: LevelBodyData["shape"]) {
  return shape.kind === "rect" ? rectShape(shape.w, shape.h) : circleShape(shape.r);
}

function applyStyle(body: CollisionObject2D, b: LevelBodyData): void {
  body.fillColor = b.color ?? DEFAULT_BODY_COLOR;
  body.fillOpacity = b.opacity ?? DEFAULT_BODY_OPACITY;
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
    const shape = makeShape(b.shape);
    const pos = new Vec2(b.x, b.y);

    if (b.kind === "killzone") {
      const kz = new KillZone(onReset);
      kz.setShape(shape);
      kz.globalPosition = pos;
      kz.globalRotation = b.rot;
      applyStyle(kz, b);
      world.add(kz);
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
