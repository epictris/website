// ShapeGeometry — shape helpers ported from lib/ShapeGeometry.cs. Operates on the
// engine's Shape/ShapeTransform instead of Godot CollisionShape2D nodes.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { circleShape, rectShape } from "../engine/shapes";
import type { Shape, ShapeTransform } from "../engine/shapes";
import type { CollisionObject2D, CollisionShape2D } from "../engine/body";

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

  getGlobalCorners(shape: ShapeTransform): Vec2[] {
    const local = ShapeGeometry.getLocalCorners(shape);
    const pos = shape.globalPosition;
    const rot = shape.globalRotation;
    return local.map((c) => pos.add(c.rotated(rot)));
  },

  computeMass(shape: ShapeTransform): number {
    const s = shape.shape;
    if (s.kind === "circle") return (Mathf.Pi * s.radius * s.radius) / 1000;
    return (s.size.x * s.size.y) / 1000;
  },

  computeMomentOfInertia(shape: ShapeTransform, mass: number): number {
    const s = shape.shape;
    if (s.kind === "circle") return 0.5 * mass * s.radius * s.radius;
    return (1 / 12) * mass * (s.size.x * s.size.x + s.size.y * s.size.y);
  },
};
