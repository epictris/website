// Editor canvas rendering: the scene in the same camera transform as the sim,
// plus a grid and selection handles. `computeHandles` is the single source of
// truth for handle positions, shared by drawing and hit-testing.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { worldToScreen, type Camera } from "../render/camera";
import { drawTrainingGrid } from "../render/trainingGrid";
import { hexToRgba } from "../render/color";
import { toWorld, type EdBody, type EdModel } from "./model";

const PLAYER = "#65bddb";
const IMPERMEABLE_EDGE = "#9db8c6"; // hook-proof surfaces: dashed steel border
const SELECT = "#f4a460";
const HANDLE = "#f4a460";
const HANDLE_FILL = "#1f2430";

export const HANDLE_SIZE_PX = 8; // drawn square side
export const HANDLE_HIT_PX = 9; // pointer pick radius
const ROT_OFFSET_PX = 26; // rotate handle distance beyond the top edge

export interface Handles {
  body: EdBody;
  corners: Vec2[]; // screen; rect only (TL, TR, BR, BL)
  rotate: Vec2 | null; // screen
  radius: Vec2 | null; // screen; circle only
}

// Screen-space handle points for a body, used for both drawing and hit-testing.
export function computeHandles(cam: Camera, body: EdBody): Handles {
  if (body.shape.kind === "circle") {
    const r = body.shape.r;
    return {
      body,
      corners: [],
      rotate: null,
      radius: worldToScreen(cam, toWorld(body, new Vec2(r, 0))),
    };
  }
  const hw = body.shape.w / 2;
  const hh = body.shape.h / 2;
  const corners = [
    new Vec2(-hw, -hh),
    new Vec2(hw, -hh),
    new Vec2(hw, hh),
    new Vec2(-hw, hh),
  ].map((l) => worldToScreen(cam, toWorld(body, l)));
  const topMid = worldToScreen(cam, toWorld(body, new Vec2(0, -hh)));
  const up = new Vec2(0, -1).rotated(body.rot).normalized();
  const rotate = topMid.add(up.mul(ROT_OFFSET_PX));
  return { body, corners, rotate, radius: null };
}

function pathBody(ctx: CanvasRenderingContext2D, body: EdBody): void {
  ctx.beginPath();
  if (body.shape.kind === "circle") {
    ctx.arc(body.pos.x, body.pos.y, body.shape.r, 0, Math.PI * 2);
  } else {
    const hw = body.shape.w / 2;
    const hh = body.shape.h / 2;
    ctx.save();
    ctx.translate(body.pos.x, body.pos.y);
    ctx.rotate(body.rot);
    ctx.rect(-hw, -hh, hw * 2, hh * 2);
    ctx.restore();
  }
}

function square(ctx: CanvasRenderingContext2D, p: Vec2): void {
  const s = HANDLE_SIZE_PX;
  ctx.fillStyle = HANDLE_FILL;
  ctx.strokeStyle = HANDLE;
  ctx.lineWidth = 1.5;
  ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
  ctx.strokeRect(p.x - s / 2, p.y - s / 2, s, s);
}

function circleHandle(ctx: CanvasRenderingContext2D, p: Vec2): void {
  ctx.fillStyle = HANDLE_FILL;
  ctx.strokeStyle = HANDLE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, HANDLE_SIZE_PX / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

export function drawEditor(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  w: number,
  h: number,
  cam: Camera,
  model: EdModel,
  selectedId: number | null,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTrainingGrid(ctx, cam, w, h);

  ctx.save();
  ctx.translate(w / 2, h / 2);
  const scale = cam.zoom * PIXELS_PER_METER;
  ctx.scale(scale, scale);
  ctx.translate(-cam.position.x, -cam.position.y);

  const worldLine = 1 / scale;
  for (const body of model.bodies) {
    pathBody(ctx, body);
    ctx.fillStyle = hexToRgba(body.color, body.opacity);
    ctx.fill();
    if (body.kind === "impermeable") {
      // Hook-proof: dashed steel border so it's distinct from a plain static
      // (matches the in-game render).
      ctx.strokeStyle = IMPERMEABLE_EDGE;
      ctx.lineWidth = worldLine * 2;
      ctx.setLineDash([5 * PX, 3 * PX]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = body.color; // border fully opaque
      ctx.lineWidth = worldLine;
      ctx.stroke();
    }
  }

  // Player spawn marker: ring at the avatar radius + crosshair.
  const p = model.player.pos;
  ctx.strokeStyle = PLAYER;
  ctx.lineWidth = worldLine * 1.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, model.player.radius, 0, Math.PI * 2);
  ctx.stroke();
  const tick = model.player.radius * 1.6;
  ctx.beginPath();
  ctx.moveTo(p.x - tick, p.y);
  ctx.lineTo(p.x + tick, p.y);
  ctx.moveTo(p.x, p.y - tick);
  ctx.lineTo(p.x, p.y + tick);
  ctx.stroke();

  // Selection outline (drawn in world space, over the fill).
  const selected = model.bodies.find((b) => b.id === selectedId);
  if (selected) {
    pathBody(ctx, selected);
    ctx.strokeStyle = SELECT;
    ctx.lineWidth = worldLine * 2;
    ctx.stroke();
  }

  ctx.restore();

  // Handles in screen space so they stay a constant on-screen size.
  if (selected) {
    const hs = computeHandles(cam, selected);
    if (hs.rotate) {
      // Stalk from the top edge to the rotate knob.
      const topMid = hs.corners.length
        ? hs.corners[0]!.add(hs.corners[1]!).mul(0.5)
        : hs.rotate;
      ctx.strokeStyle = HANDLE;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(topMid.x, topMid.y);
      ctx.lineTo(hs.rotate.x, hs.rotate.y);
      ctx.stroke();
      circleHandle(ctx, hs.rotate);
    }
    for (const c of hs.corners) square(ctx, c);
    if (hs.radius) square(ctx, hs.radius);
  }
}
