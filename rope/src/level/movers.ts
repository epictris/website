// Scripted-mover builders shared by hand-written level inits (game-design.md:
// rects only move on authored paths — these are the authored paths).

import { Vec2 } from "../engine/vec2";
import { AnimatableBody2D } from "../engine/body";
import { rectShape } from "../engine/shapes";
import type { Level } from "./level";

// Horizontal sine shuttle: sweeps base.x ± amplitude. Keep peak speed
// (amplitude * omega) under ~2 px/frame (see MoverScript).
export function addSlidingPlatform(
  level: Level,
  base: Vec2,
  amplitude: number,
  omega: number,
  width = 120,
  height = 16,
): void {
  const platform = new AnimatableBody2D();
  platform.name = "SlidingPlatform";
  platform.setShape(rectShape(width, height));
  platform.globalPosition = base;
  level.addMover(platform, (body, time) => {
    body.globalPosition = base.add(new Vec2(amplitude * Math.sin(time * omega), 0));
  });
}

// Constant-rate rotor about its centre.
export function addWindmill(
  level: Level,
  pivot: Vec2,
  omega: number,
  length = 220,
  thickness = 14,
): void {
  const windmill = new AnimatableBody2D();
  windmill.name = "Windmill";
  windmill.setShape(rectShape(length, thickness));
  windmill.globalPosition = pivot;
  level.addMover(windmill, (body, time) => {
    body.globalRotation = time * omega;
  });
}
