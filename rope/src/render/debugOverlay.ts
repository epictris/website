// Debug overlay (toggle: L). Render-side only — draws directly from the same
// modules the sim runs through (LedgeDetection, the player state machine), so
// the visualization can never drift from the sim. Movers re-evaluate live: a
// rotating corner visibly swings in and out of grabbability.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
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
import {
  activeCameraRule,
  pathBandAxes,
  pathLookahead,
  pathRangeAxes,
  type HeldCamera,
  pathReleaseAxes,
  regionBuffer,
  type CameraRule,
} from "./cameraController";
import { pointAtArcLength, projectOntoPolyline } from "./cameraPath";
import { outlineOfData, pathCorridorEllipseInto, pathOutline, pathOutlineGrown } from "./shapePath";

const GRABBABLE = "#bae67e"; // ayu-mirage green
const BLOCKED = "#ff4d4d";
const SEAM = "#5c6a7a"; // occluded seam corner — never grabbable
const FACE_COLORS: Record<SurfaceType, string> = {
  [SurfaceType.FLOOR]: "#bae67e",
  [SurfaceType.WALL]: "#ffe14d",
  [SurfaceType.CEILING]: "#ff4d4d",
};

const TICK_LENGTH = 10 * PX;
const MARKER_RADIUS = 3 * PX;

function drawTick(ctx: CanvasRenderingContext2D, from: Vec2, normal: Vec2, color: string): void {
  const to = from.add(normal.mul(TICK_LENGTH));
  ctx.strokeStyle = color;
  ctx.lineWidth = PX;
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
    if (!body.isSolid) continue; // hook-only scenery is never grabbable
    // One pass per collision shape: a compound body offers the corners of every
    // piece it is made of, and the overlay has to show exactly the set
    // LedgeDetection walks.
    body.getShapes().forEach((t, si) => {
      if (t.shape.kind === "circle") return;

      const vertexCount = ShapeGeometry.getLocalVertices(t.shape).length;
      for (let i = 0; i < vertexCount; i++) {
        if (!ShapeGeometry.isLedgeCandidate(t.shape, i)) continue;

        const vertex = ShapeGeometry.getVertexWorldPosition(t, i);
        const [inNormal, outNormal] = ShapeGeometry.getIncidentFaceNormals(t, i);
        drawTick(ctx, vertex, inNormal, FACE_COLORS[Surface.getSurfaceType(inNormal, body.isRotating)]);
        drawTick(ctx, vertex, outNormal, FACE_COLORS[Surface.getSurfaceType(outNormal, body.isRotating)]);

        const info = LedgeDetection.grabInfo(body, si, i);
        const seam = info !== null && LedgeDetection.isSeamOccluded(bodies, body, si, i, vertex);

        if (seam) {
          ctx.strokeStyle = SEAM;
          ctx.lineWidth = PX;
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
          ctx.setLineDash([3 * PX, 3 * PX]);
          ctx.lineWidth = PX;
          ctx.beginPath();
          ctx.arc(vertex.x, vertex.y, level.player.radius + GRAB_REACH_MARGIN, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = BLOCKED;
          ctx.lineWidth = PX;
          ctx.stroke();
        }
      }
    });
  }
}

const CONTACT_ARROW_LENGTH = 24 * PX;
const CONTACT_ARROW_HEAD = 5 * PX;

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
  ctx.lineWidth = 1.5 * PX;
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
    const info = LedgeDetection.grabInfo(state.body, state.shapeIndex, state.vertexIndex);
    if (!info) return;
    drawContactArrow(ctx, info.vertex, info.wallNormal, state.body.isRotating);
    drawContactArrow(ctx, info.vertex, info.floorNormal, state.body.isRotating);
  }
}

const COLLIDER = "#ffe14d";

// The player's actual circle collider — the rendered body is a narrower
// capsule, so the debug view shows the true collision bounds.
function drawPlayerCollider(ctx: CanvasRenderingContext2D, level: Level): void {
  const t = level.player.primaryShape();
  if (t.shape.kind !== "circle") return;
  ctx.strokeStyle = COLLIDER;
  ctx.lineWidth = PX;
  ctx.beginPath();
  ctx.arc(t.globalPosition.x, t.globalPosition.y, t.shape.radius, 0, Math.PI * 2);
  ctx.stroke();
}

const CAMERA_REGION = "#c792ea"; // matches the editor's camera layer
// The screen-edge clamp. Amber rather than the camera layer's violet: it is not
// an authored volume, it is the one rule a level cannot opt out of, and it is
// on screen only while it is overriding whatever the level asked for.
const EDGE_HOLD = "#ffcc66";

// Metres between the direction arrowheads along a camera path. Direction is the
// design (the lookahead never reverses), so it has to be readable at a glance.
const PATH_ARROW_SPACING = 1.5;
const PATH_ARROW_LENGTH = 0.22;

// Camera rules are invisible in play by design, so a camera that offsets, zooms,
// pins or leads has no on-screen cause. The overlay draws every one of them and
// marks the one currently in force, which is the whole diagnosis.
function drawCameraRules(
  ctx: CanvasRenderingContext2D,
  level: Level,
  held: HeldCamera | null,
): void {
  // The live rule when the caller has a camera controller to hand; recomputed
  // only for a caller that has none, where a first-order answer beats nothing.
  const active = held?.rule ?? activeCameraRule(level.cameraRules, level.cameraPosition);
  for (const rule of level.cameraRules) {
    if (rule.kind === "region") {
      drawCameraRegion(ctx, rule, rule === active);
    } else {
      drawCameraPath(
        ctx,
        rule,
        rule === active,
        rule === held?.rule ? held : null,
        level.cameraPosition,
      );
    }
  }
}

function drawCameraRegion(
  ctx: CanvasRenderingContext2D,
  rule: CameraRule & { kind: "region" },
  active: boolean,
): void {
  const r = rule.region;
  ctx.beginPath();
  pathOutline(ctx, new Vec2(r.x, r.y), r.rot, outlineOfData(r.shape));
  if (active) {
    ctx.fillStyle = "rgba(199,146,234,0.12)";
    ctx.fill();
  }
  ctx.strokeStyle = CAMERA_REGION;
  ctx.lineWidth = 1.5 * PX;
  ctx.setLineDash([6 * PX, 4 * PX]);
  ctx.stroke();
  ctx.setLineDash([]);
  // The buffer zone of whichever region holds the camera. Only that one: a
  // region keeps its grip out to here, so this is the boundary that explains
  // why the camera has not changed hands, and drawing every region's would
  // bury it in overlapping outlines that mean nothing until the region is in
  // force.
  if (!active) return;
  ctx.beginPath();
  pathOutlineGrown(ctx, new Vec2(r.x, r.y), r.rot, outlineOfData(r.shape), regionBuffer(r));
  ctx.lineWidth = PX;
  ctx.setLineDash([2 * PX, 5 * PX]);
  ctx.stroke();
  ctx.setLineDash([]);
}

// A path draws as its polyline with direction arrowheads, plus the corridor it
// governs within. Nothing is FILLED, unlike a region: a corridor that doubles
// back overlaps itself, so an interior tint says more about the switchback than
// about which rule is in force.
function drawCameraPath(
  ctx: CanvasRenderingContext2D,
  rule: CameraRule & { kind: "path" },
  active: boolean,
  held: HeldCamera | null,
  // Where the avatar is, for the fallback projection when there is no held one.
  follow: Vec2,
): void {
  const ix = rule.index;

  const range = pathRangeAxes(rule.path);
  ctx.beginPath();
  pathCorridorEllipseInto(ctx, ix.verts, range.x, range.y);
  ctx.strokeStyle = CAMERA_REGION;
  ctx.lineWidth = 1.5 * PX;
  ctx.setLineDash([6 * PX, 4 * PX]);
  ctx.stroke();
  ctx.setLineDash([]);

  // The polyline itself, solid and brighter than its corridor: it is the route,
  // and the corridor is only how far off it the player may be.
  ctx.beginPath();
  ctx.moveTo(ix.verts[0]!.x, ix.verts[0]!.y);
  for (const v of ix.verts.slice(1)) ctx.lineTo(v.x, v.y);
  ctx.lineWidth = (active ? 2.5 : 1.5) * PX;
  ctx.stroke();

  for (let s = PATH_ARROW_SPACING / 2; s < ix.total; s += PATH_ARROW_SPACING) {
    drawPathArrow(ctx, ix.verts.length ? pointAtArcLength(ix, s) : Vec2.ZERO, pointAtArcLength(ix, Math.min(ix.total, s + 0.05)));
  }

  if (!active) return;

  // The far edge of the falloff band, and then the release boundary in the
  // sparser dash a region's buffer uses. The two are different statements: the
  // path's grip on the framing fades to nothing across the first, and only past
  // the second does the rule itself let go - so a path that seems slow to hand
  // over has both of its reasons on screen.
  const band = pathBandAxes(rule.path);
  if (band.x > range.x || band.y > range.y) {
    ctx.beginPath();
    pathCorridorEllipseInto(ctx, ix.verts, band.x, band.y);
    ctx.lineWidth = PX;
    ctx.setLineDash([3 * PX, 3 * PX]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const release = pathReleaseAxes(rule.path);
  ctx.beginPath();
  pathCorridorEllipseInto(ctx, ix.verts, release.x, release.y);
  ctx.lineWidth = PX;
  ctx.setLineDash([2 * PX, 5 * PX]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Where the player projects, and where the camera is therefore aimed. The
  // projection is the controller's own tracked one where there is one - a
  // recomputed global answer is a different number at a switchback, which is
  // exactly what the overlay is opened to see.
  const s = held?.s ?? projectOntoPolyline(ix, follow).s;
  // The lead is measured from the COMMITTED point, which sits still inside the
  // lookahead deadband while a swing runs back and forth under it. Drawing both
  // is the whole diagnosis of that buffer: the gap between them is the slack
  // the camera is currently declining to spend.
  const from = held?.leadS ?? s;
  const at = pointAtArcLength(ix, from);
  // The same lead the controller takes, resolved against the direction the
  // route heads in over it (see `pathLookahead`) - a recomputed straight-line
  // guess would mark a point the camera is not aimed at.
  const ahead = pointAtArcLength(ix, from + 0.05).sub(
    pointAtArcLength(ix, Math.max(0, from - 0.05)),
  );
  const lead = pointAtArcLength(ix, from + pathLookahead(rule.path, ahead));
  ctx.beginPath();
  ctx.moveTo(at.x, at.y);
  ctx.lineTo(lead.x, lead.y);
  ctx.lineWidth = 2 * PX;
  ctx.stroke();
  for (const [p, r] of [
    [at, MARKER_RADIUS],
    [lead, MARKER_RADIUS * 1.6],
  ] as const) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = CAMERA_REGION;
    ctx.fill();
  }
  // The avatar's own projection, hollow, wherever the buffer is holding the
  // committed point away from it. Absent when the two agree, so the mark
  // appearing IS the buffer doing something.
  if (Math.abs(s - from) > 1e-6) {
    const real = pointAtArcLength(ix, s);
    ctx.beginPath();
    ctx.arc(real.x, real.y, MARKER_RADIUS, 0, Math.PI * 2);
    ctx.lineWidth = PX;
    ctx.stroke();
  }
}

// A filled triangle at `at`, aimed along `at -> ahead`.
function drawPathArrow(ctx: CanvasRenderingContext2D, at: Vec2, ahead: Vec2): void {
  const dir = ahead.sub(at).normalized();
  if (dir.x === 0 && dir.y === 0) return;
  const side = new Vec2(-dir.y, dir.x).mul(PATH_ARROW_LENGTH * 0.4);
  const tip = at.add(dir.mul(PATH_ARROW_LENGTH / 2));
  const back = at.sub(dir.mul(PATH_ARROW_LENGTH / 2));
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(back.x + side.x, back.y + side.y);
  ctx.lineTo(back.x - side.x, back.y - side.y);
  ctx.closePath();
  ctx.fillStyle = CAMERA_REGION;
  ctx.fill();
}

export function drawDebugOverlay(
  ctx: CanvasRenderingContext2D,
  level: Level,
  // The camera state the controller currently holds; null = recompute the rule.
  heldCamera: HeldCamera | null = null,
): void {
  drawLedgeOverlay(ctx, level);
  drawContactNormals(ctx, level);
  drawPlayerCollider(ctx, level);
  drawCameraRules(ctx, level, heldCamera);
  drawEdgeConstraint(ctx, heldCamera);
}

// The screen-edge keep-out, drawn ONLY on the frames it is what is holding the
// camera. A camera that has stopped following has no on-screen cause otherwise,
// and drawing the box every frame would make it furniture rather than a
// diagnosis: seeing it at all means the avatar is against the constraint.
function drawEdgeConstraint(ctx: CanvasRenderingContext2D, held: HeldCamera | null): void {
  const edge = held?.edge;
  if (!edge) return;
  ctx.strokeStyle = EDGE_HOLD;
  ctx.lineWidth = 1.5 * PX;
  ctx.setLineDash([10 * PX, 6 * PX]);
  ctx.strokeRect(
    edge.centre.x - edge.reach.x,
    edge.centre.y - edge.reach.y,
    edge.reach.x * 2,
    edge.reach.y * 2,
  );
  ctx.setLineDash([]);
}
