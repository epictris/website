// Ledge-grab debug overlay (toggle: L). Render-side only — draws directly
// from LedgeDetection, the same module the player states grab through, so the
// visualization can never drift from the sim. Movers re-evaluate live: a
// rotating corner visibly swings in and out of grabbability.

import { Vec2 } from "../engine/vec2";
import { PhysicsBody2D } from "../engine/body";
import { Player } from "../classes/player";
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
export function drawLedgeOverlay(ctx: CanvasRenderingContext2D, level: Level): void {
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
