// Canvas renderer. Draws the world in the terminal-ish palette; the C# code drew
// via Godot's scene graph and Debug canvas overlay.

import { Vec2 } from "../engine/vec2";
import type { ShapeTransform } from "../engine/shapes";
import {
  AnimatableBody2D,
  Area2D,
  RigidBody2D,
  StaticBody2D,
  type CollisionObject2D,
} from "../engine/body";
import { Debug } from "../engine/debug";
import { Player } from "../classes/player";
import { Hook } from "../classes/hook";
import type { Level } from "../level/level";
import type { Camera } from "./camera";
import { drawLedgeOverlay } from "./ledgeOverlay";

const BG = "#1f2430";
const GEOMETRY_FILL = "#2a2f3d";
const GEOMETRY_STROKE = "#3c445c";
const DYNAMIC_FILL = "#5c6a7a";
const MOVER_FILL = "#3d4a45";
const PLAYER = "#65bddb";
const HOOK = "#f4a460";
const KILLZONE = "rgba(220,60,80,0.35)";

function pathShape(ctx: CanvasRenderingContext2D, t: ShapeTransform): void {
  ctx.beginPath();
  if (t.shape.kind === "circle") {
    ctx.arc(t.globalPosition.x, t.globalPosition.y, t.shape.radius, 0, Math.PI * 2);
  } else {
    const hw = t.shape.size.x * 0.5;
    const hh = t.shape.size.y * 0.5;
    ctx.save();
    ctx.translate(t.globalPosition.x, t.globalPosition.y);
    ctx.rotate(t.globalRotation);
    ctx.rect(-hw, -hh, hw * 2, hh * 2);
    ctx.restore();
  }
}

function drawBody(ctx: CanvasRenderingContext2D, body: CollisionObject2D): void {
  if (!body.hasShape()) return;
  const t = body.getShape();
  if (body instanceof Player) {
    pathShape(ctx, t);
    ctx.fillStyle = PLAYER;
    ctx.fill();
    // Facing indicator.
    return;
  }
  if (body instanceof Hook) {
    pathShape(ctx, t);
    ctx.fillStyle = HOOK;
    ctx.fill();
    return;
  }
  if (body instanceof RigidBody2D) {
    pathShape(ctx, t);
    ctx.fillStyle = DYNAMIC_FILL;
    ctx.fill();
    ctx.strokeStyle = GEOMETRY_STROKE;
    ctx.lineWidth = 1;
    ctx.stroke();
    return;
  }
  if (body instanceof AnimatableBody2D) {
    pathShape(ctx, t);
    ctx.fillStyle = MOVER_FILL;
    ctx.fill();
    ctx.strokeStyle = GEOMETRY_STROKE;
    ctx.lineWidth = 1;
    ctx.stroke();
    return;
  }
  if (body instanceof StaticBody2D) {
    pathShape(ctx, t);
    ctx.fillStyle = GEOMETRY_FILL;
    ctx.fill();
    ctx.strokeStyle = GEOMETRY_STROKE;
    ctx.lineWidth = 1;
    ctx.stroke();
    return;
  }
  if (body instanceof Area2D) {
    pathShape(ctx, t);
    ctx.fillStyle = KILLZONE;
    ctx.fill();
    return;
  }
}

function arrowHead(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2, color: string): void {
  const dir = a.directionTo(b);
  const left = dir.rotated(Math.PI * 0.8).mul(4);
  const right = dir.rotated(-Math.PI * 0.8).mul(4);
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x + left.x, b.y + left.y);
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x + right.x, b.y + right.y);
  ctx.strokeStyle = color;
  ctx.stroke();
}

export function render(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  cssWidth: number,
  cssHeight: number,
  level: Level,
  camera: Camera,
  fps: number,
  showLedges = false,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  ctx.save();
  ctx.translate(cssWidth / 2, cssHeight / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.position.x, -camera.position.y);

  for (const body of level.world.bodies) drawBody(ctx, body);
  for (const area of level.world.areas) drawBody(ctx, area);

  // Rope spans.
  const rope = level.player.rope;
  if (rope) {
    ctx.strokeStyle = HOOK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const span of rope.getSpans()) {
      ctx.moveTo(span.span.start.x, span.span.start.y);
      ctx.lineTo(span.span.end.x, span.span.end.y);
    }
    ctx.stroke();
  }

  // Ledge-grab overlay (toggle: L).
  if (showLedges) drawLedgeOverlay(ctx, level);

  // Debug overlay.
  for (const cmd of Debug.cmds) {
    ctx.strokeStyle = cmd.color;
    ctx.lineWidth = cmd.width;
    ctx.beginPath();
    ctx.moveTo(cmd.a.x, cmd.a.y);
    ctx.lineTo(cmd.b.x, cmd.b.y);
    ctx.stroke();
    if (cmd.kind === "arrow") arrowHead(ctx, cmd.a, cmd.b, cmd.color);
  }

  ctx.restore();

  // FPS counter (screen space, top-right).
  ctx.font = "14px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#cbccc6";
  ctx.fillText(`${Math.round(fps)} fps`, cssWidth - 8, 6);
  ctx.textAlign = "left";
}
