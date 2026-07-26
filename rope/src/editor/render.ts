// Editor canvas rendering: the scene in the same camera transform as the sim,
// plus a grid and selection handles. `computeHandles` is the single source of
// truth for handle positions, shared by drawing and hit-testing.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { worldToScreen, type Camera } from "../render/camera";
import { drawTrainingGrid } from "../render/trainingGrid";
import { fillAnchor, fillForceArea, fillKillZone } from "../render/areaFill";
import { hexToRgba } from "../render/color";
import { halfExtents, toWorld, type EdBody, type EdModel } from "./model";

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
  rotateBase: Vec2 | null; // screen; where the rotate knob's stalk starts
  radius: Vec2 | null; // screen; circle only
}

// Screen-space handle points for a body, used for both drawing and hit-testing.
export function computeHandles(cam: Camera, body: EdBody): Handles {
  // Knob sits above the shape's top edge, along the body's own up axis.
  const up = new Vec2(0, -1).rotated(body.rot).normalized();
  if (body.shape.kind === "circle") {
    const r = body.shape.r;
    // A circle's rotation is invisible — except on a force area, where it aims
    // the current, so those get the knob too rather than only the rot° field.
    const base =
      body.kind === "force" ? worldToScreen(cam, toWorld(body, new Vec2(0, -r))) : null;
    return {
      body,
      corners: [],
      rotate: base ? base.add(up.mul(ROT_OFFSET_PX)) : null,
      rotateBase: base,
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
  return { body, corners, rotate: topMid.add(up.mul(ROT_OFFSET_PX)), rotateBase: topMid, radius: null };
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
  selectedIds: ReadonlySet<number>,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTrainingGrid(ctx, cam, w, h);

  ctx.save();
  ctx.translate(w / 2, h / 2);
  const scale = cam.zoom * PIXELS_PER_METER;
  ctx.scale(scale, scale);
  ctx.translate(-cam.position.x, -cam.position.y);

  const worldLine = 1 / scale;
  // Hook-only anchors first: they are background the player passes through, and
  // the game draws them behind solid geometry too. `sort` is stable, so the
  // authored order is preserved within each group.
  const ordered = [...model.bodies].sort(
    (a, b) => Number(a.kind !== "anchor") - Number(b.kind !== "anchor"),
  );
  for (const body of ordered) {
    // Areas fill with their glyph cut out of them — the same calls the game
    // makes, so authoring shows exactly what play shows.
    if (body.kind === "force") {
      fillForceArea(
        ctx,
        body.pos,
        body.rot,
        halfExtents(body),
        body.shape.kind === "circle",
        body.force,
        hexToRgba(body.color, body.opacity),
      );
    } else if (body.kind === "killzone") {
      fillKillZone(
        ctx,
        body.pos,
        body.rot,
        halfExtents(body),
        body.shape.kind === "circle",
        hexToRgba(body.color, body.opacity),
      );
    } else if (body.kind === "anchor") {
      // Hook-only scenery: the same grate mesh the game punches through it.
      fillAnchor(
        ctx,
        body.pos,
        body.rot,
        halfExtents(body),
        body.shape.kind === "circle",
        hexToRgba(body.color, body.opacity),
      );
    } else {
      pathBody(ctx, body);
      ctx.fillStyle = hexToRgba(body.color, body.opacity);
      ctx.fill();
    }
    pathBody(ctx, body);
    if (selectedIds.has(body.id)) {
      // Selection halo, drawn *under* the body's own border so an
      // impermeable's dashed steel edge stays readable while selected.
      ctx.strokeStyle = SELECT;
      ctx.lineWidth = worldLine * 5;
      ctx.stroke();
    }
    if (body.kind === "impermeable") {
      // Hook-proof: dashed steel border so it's distinct from a plain static
      // (matches the in-game render).
      ctx.strokeStyle = IMPERMEABLE_EDGE;
      ctx.lineWidth = worldLine * 2;
      ctx.setLineDash([5 * PX, 3 * PX]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (body.kind === "anchor") {
      // Hook-only: dotted edge, as in game — nothing about it reads as solid.
      ctx.strokeStyle = body.color;
      ctx.lineWidth = worldLine;
      ctx.setLineDash([PX, 2 * PX]);
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

  ctx.restore();

  // Handles in screen space so they stay a constant on-screen size. They edit
  // one body's geometry, so they only appear for a single selection.
  const selection = model.bodies.filter((b) => selectedIds.has(b.id));
  const selected = selection.length === 1 ? selection[0]! : null;
  if (selected) {
    const hs = computeHandles(cam, selected);
    if (hs.rotate) {
      // Stalk from the top edge to the rotate knob.
      const topMid = hs.rotateBase ?? hs.rotate;
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
