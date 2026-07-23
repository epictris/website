// Debug overlay (toggle: L). Render-side only — draws directly from the same
// modules the sim runs through (LedgeDetection, the player state machine), so
// the visualization can never drift from the sim. Movers re-evaluate live: a
// rotating corner visibly swings in and out of grabbability.

import { Vec2 } from "../engine/vec2";
import { PhysicsBody2D } from "../engine/body";
import { Player } from "../classes/player";
import { GroundedState } from "../classes/states/groundedState";
import { OnWallState } from "../classes/states/onWallState";
import { LedgeHangState } from "../classes/states/ledgeHangState";
import { LedgeClimbState } from "../classes/states/ledgeClimbState";
import { GRAB_REACH_MARGIN, LedgeDetection } from "../lib/ledgeDetection";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { Surface } from "../lib/surface";
import { SurfaceType } from "../lib/types";
import type { Level } from "../level/level";

const GRABBABLE = "#bae67e"; // ayu-mirage green
const BLOCKED = "#ff4d4d";
const SEAM = "#5c6a7a"; // occluded seam corner — never grabbable
const FACE_COLORS: Record<SurfaceType, string> = {
  [SurfaceType.FLOOR]: "#bae67e",
  [SurfaceType.WALL]: "#ffe14d",
  [SurfaceType.CEILING]: "#ff4d4d",
};

const TICK_LENGTH = 10;
const MARKER_RADIUS = 3;

function drawTick(ctx: CanvasRenderingContext2D, from: Vec2, normal: Vec2, color: string): void {
  const to = from.add(normal.mul(TICK_LENGTH));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

// Draws, for every ledge-candidate vertex in the level:
//  - the two incident face normals, colored by surface classification
//    (floor green / wall yellow / ceiling red) — shows *why* a corner is or
//    isn't grabbable at weird angles,
//  - a vertex marker: filled green when grabbable now, hollow red when the
//    candidate has rotated out of reach, grey X when a compound-body seam
//    occludes it.
// Non-candidate vertices and circles (never grabbable) draw nothing.
function drawLedgeOverlay(ctx: CanvasRenderingContext2D, level: Level): void {
  const bodies = level.world.bodies;
  for (const body of bodies) {
    if (body instanceof Player) continue;
    if (!(body instanceof PhysicsBody2D) || !body.hasShape()) continue;
    const t = body.getShape();
    if (t.shape.kind !== "rect") continue;

    const vertexCount = ShapeGeometry.getLocalVertices(t.shape).length;
    for (let i = 0; i < vertexCount; i++) {
      if (!ShapeGeometry.isLedgeCandidate(t.shape, i)) continue;

      const vertex = ShapeGeometry.getVertexWorldPosition(t, i);
      const [inNormal, outNormal] = ShapeGeometry.getIncidentFaceNormals(t, i);
      drawTick(ctx, vertex, inNormal, FACE_COLORS[Surface.getSurfaceType(inNormal, body.isRotating)]);
      drawTick(ctx, vertex, outNormal, FACE_COLORS[Surface.getSurfaceType(outNormal, body.isRotating)]);

      const info = LedgeDetection.grabInfo(body, i);
      const seam = info !== null && LedgeDetection.isSeamOccluded(bodies, body, vertex);

      if (seam) {
        ctx.strokeStyle = SEAM;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(vertex.x - MARKER_RADIUS, vertex.y - MARKER_RADIUS);
        ctx.lineTo(vertex.x + MARKER_RADIUS, vertex.y + MARKER_RADIUS);
        ctx.moveTo(vertex.x - MARKER_RADIUS, vertex.y + MARKER_RADIUS);
        ctx.lineTo(vertex.x + MARKER_RADIUS, vertex.y - MARKER_RADIUS);
        ctx.stroke();
        continue;
      }

      ctx.beginPath();
      ctx.arc(vertex.x, vertex.y, MARKER_RADIUS, 0, Math.PI * 2);
      if (info) {
        ctx.fillStyle = GRABBABLE;
        ctx.fill();
        // Grab radius: the catch zone — a grab fires when the player's
        // swept centre path enters this circle (LedgeDetection reach).
        ctx.strokeStyle = GRABBABLE;
        ctx.globalAlpha = 0.3;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(vertex.x, vertex.y, level.player.radius + GRAB_REACH_MARGIN, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = BLOCKED;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
}

const CONTACT_ARROW_LENGTH = 24;
const CONTACT_ARROW_HEAD = 5;

function drawContactArrow(
  ctx: CanvasRenderingContext2D,
  from: Vec2,
  normal: Vec2,
  rotating: boolean,
): void {
  const color = FACE_COLORS[Surface.getSurfaceType(normal, rotating)];
  const to = from.add(normal.mul(CONTACT_ARROW_LENGTH));
  const dir = normal;
  const left = dir.rotated(Math.PI * 0.8).mul(CONTACT_ARROW_HEAD);
  const right = dir.rotated(-Math.PI * 0.8).mul(CONTACT_ARROW_HEAD);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x + left.x, to.y + left.y);
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x + right.x, to.y + right.y);
  ctx.stroke();
}

// Draws the surface normal(s) the sim currently believes the player is
// touching, as arrows from the contact point, colored by surface
// classification (floor green / wall yellow / ceiling red). Reads the same
// state fields the states steer by — no separate collision probe.
function drawContactNormals(ctx: CanvasRenderingContext2D, level: Level): void {
  const player = level.player;
  const state = player.state;

  if (state instanceof GroundedState || state instanceof OnWallState) {
    const normal = state.surfaceNormal;
    if (normal.lengthSquared() === 0) return;
    const contact = player.globalPosition.sub(normal.mul(player.radius));
    drawContactArrow(ctx, contact, normal, state.supportBody?.isRotating ?? false);
    return;
  }

  if (state instanceof LedgeHangState || state instanceof LedgeClimbState) {
    if (state.body.removed) return;
    const info = LedgeDetection.grabInfo(state.body, state.vertexIndex);
    if (!info) return;
    drawContactArrow(ctx, info.vertex, info.wallNormal, state.body.isRotating);
    drawContactArrow(ctx, info.vertex, info.floorNormal, state.body.isRotating);
  }
}

const COLLIDER = "#ffe14d";

// The player's actual circle collider — the rendered body is a narrower
// capsule, so the debug view shows the true collision bounds.
function drawPlayerCollider(ctx: CanvasRenderingContext2D, level: Level): void {
  const t = level.player.getShape();
  if (t.shape.kind !== "circle") return;
  ctx.strokeStyle = COLLIDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(t.globalPosition.x, t.globalPosition.y, t.shape.radius, 0, Math.PI * 2);
  ctx.stroke();
}

export function drawDebugOverlay(ctx: CanvasRenderingContext2D, level: Level): void {
  drawLedgeOverlay(ctx, level);
  drawContactNormals(ctx, level);
  drawPlayerCollider(ctx, level);
}
