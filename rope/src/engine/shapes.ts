// Collision shapes. The game only ever uses circles and axis-local rectangles
// (a rect rotated by its body's rotation), mirroring the Godot prototype.

import { Vec2 } from "./vec2";

export type Shape =
  | { readonly kind: "circle"; readonly radius: number }
  | { readonly kind: "rect"; readonly size: Vec2 };

export function circleShape(radius: number): Shape {
  return { kind: "circle", radius };
}

export function rectShape(width: number, height: number): Shape {
  return { kind: "rect", size: new Vec2(width, height) };
}

// A CollisionShape2D attached to a body. Its global transform is the body's
// transform (shapes are always mounted at the body origin in this project).
export interface ShapeTransform {
  readonly globalPosition: Vec2;
  readonly globalRotation: number;
  readonly shape: Shape;
}
