// Editor canvas rendering: the scene in the same camera transform as the sim,
// plus a grid and selection handles. `computeHandles` is the single source of
// truth for handle positions, shared by drawing and hit-testing.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { worldToScreen, type Camera } from "../render/camera";
import { drawTrainingGrid } from "../render/trainingGrid";
import { fillAnchor, fillForceArea, fillKillZone } from "../render/areaFill";
import { hexToRgba } from "../render/color";
import {
  arrowEnds,
  CAMERA_REGION_COLOR,
  ED_LAYERS,
  halfExtents,
  isArrowNote,
  NOTE_COLOR,
  toWorld,
  type EdItem,
  type EdLayer,
  type EdModel,
} from "./model";
import { DEFAULT_VIEWPORT_SCALE } from "../level/levelFormat";

const PLAYER = "#65bddb";
const IMPERMEABLE_EDGE = "#9db8c6"; // hook-proof surfaces: dashed steel border
const SELECT = "#f4a460";
const MARQUEE_FILL = "rgba(244,164,96,0.10)";
const CAMERA_LOCK = "#e6c07b"; // camera-lock guides: warm, distinct from the region violet
const HANDLE = "#f4a460";
const HANDLE_FILL = "#1f2430";

export const HANDLE_SIZE_PX = 8; // drawn square side
export const HANDLE_HIT_PX = 9; // pointer pick radius
const ROT_OFFSET_PX = 26; // rotate handle distance beyond the top edge

export interface Handles {
  body: EdItem;
  corners: Vec2[]; // screen; rect only (TL, TR, BR, BL)
  rotate: Vec2 | null; // screen
  rotateBase: Vec2 | null; // screen; where the rotate knob's stalk starts
  radius: Vec2 | null; // screen; circle only
  ends: Vec2[] | null; // screen; arrow notes only (tail, head)
}

// Screen-space handle points for a body, used for both drawing and hit-testing.
export function computeHandles(cam: Camera, body: EdItem): Handles {
  // An arrow is a segment, so it is edited by its endpoints: dragging either one
  // sets the position, length and direction at once, which is what a corner box
  // plus a rotate knob would take three gestures to do.
  if (isArrowNote(body)) {
    const { tail, head } = arrowEnds(body);
    return {
      body,
      corners: [],
      rotate: null,
      rotateBase: null,
      radius: null,
      ends: [worldToScreen(cam, tail), worldToScreen(cam, head)],
    };
  }
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
      ends: null,
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
  return {
    body,
    corners,
    rotate: topMid.add(up.mul(ROT_OFFSET_PX)),
    rotateBase: topMid,
    radius: null,
    ends: null,
  };
}

function pathBody(ctx: CanvasRenderingContext2D, body: EdItem): void {
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

// One-line summary of what a camera region does, drawn above it. Lengths are in
// scene pixels, matching the inspector's fields. A region with nothing authored
// says so rather than showing an empty label.
export function cameraRegionLabel(r: EdItem): string {
  const px = (v: number) => String(Math.round(v * PIXELS_PER_METER));
  const parts: string[] = [];
  if (r.cam.offset.x !== 0 || r.cam.offset.y !== 0) {
    parts.push(`off ${px(r.cam.offset.x)},${px(r.cam.offset.y)}`);
  }
  if (r.cam.viewportScale !== DEFAULT_VIEWPORT_SCALE) {
    parts.push(`view ×${Number(r.cam.viewportScale.toFixed(2))}`);
  }
  const lock = `${r.cam.lockX !== null ? "x" : ""}${r.cam.lockY !== null ? "y" : ""}`;
  if (lock) parts.push(`lock ${lock}`);
  if (r.cam.blend !== null) parts.push(`${Number(r.cam.blend.toFixed(2))}s`);
  if (r.cam.priority !== 0) parts.push(`p${r.cam.priority}`);
  return parts.length ? `cam · ${parts.join(" · ")}` : "cam · (no effect)";
}

// Where a locked axis pins the camera. Both axes locked is a point, so it draws
// a target there (and a leader from the region, since the point may be outside
// it); one axis locked is a line, drawn across the region's span.
function drawLockMarks(ctx: CanvasRenderingContext2D, r: EdItem, worldLine: number): void {
  const { lockX, lockY } = r.cam;
  if (lockX === null && lockY === null) return;
  const h = halfExtents(r);
  const reach = 0.5; // metres the guide lines overhang the region
  ctx.strokeStyle = CAMERA_LOCK;
  ctx.lineWidth = worldLine * 1.5;
  ctx.setLineDash([4 * PX, 4 * PX]);
  ctx.beginPath();
  if (lockX !== null && lockY !== null) {
    ctx.moveTo(r.pos.x, r.pos.y);
    ctx.lineTo(lockX, lockY);
  } else if (lockX !== null) {
    ctx.moveTo(lockX, r.pos.y - h.y - reach);
    ctx.lineTo(lockX, r.pos.y + h.y + reach);
  } else if (lockY !== null) {
    ctx.moveTo(r.pos.x - h.x - reach, lockY);
    ctx.lineTo(r.pos.x + h.x + reach, lockY);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  if (lockX !== null && lockY !== null) {
    const s = 0.12;
    ctx.beginPath();
    ctx.arc(lockX, lockY, s, 0, Math.PI * 2);
    ctx.moveTo(lockX - s * 1.8, lockY);
    ctx.lineTo(lockX + s * 1.8, lockY);
    ctx.moveTo(lockX, lockY - s * 1.8);
    ctx.lineTo(lockX, lockY + s * 1.8);
    ctx.stroke();
  }
}

// Notes are world-scaled throughout — glyph height, box, arrow line and head all
// live in metres — so an annotation keeps its relationship to the geometry it
// points at instead of swelling over the level as you zoom out.
const NOTE_PADDING = 0.06; // metres between the box edge and its text
const NOTE_LINE_HEIGHT = 1.3; // multiples of the glyph height
const ARROW_LINE_WIDTH = 0.018; // metres
const ARROW_HEAD_LENGTH = 0.12; // metres
const ARROW_HEAD_HALF_WIDTH = 0.055; // metres
const NOTE_EMPTY_PLACEHOLDER = "(empty note)";

// Greedy word wrap against the measured width, honouring explicit newlines. The
// caller has already set the font, since measurement depends on it.
function wrapNoteText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      const candidate = line ? `${line} ${word}` : word;
      // A single word wider than the box still gets its own line — breaking
      // mid-word would mangle an identifier, which is most of what a note names.
      if (line && ctx.measureText(candidate).width > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

// An arrow note: a shaft from tail to head with a solid head at the +X end. The
// head is clamped to half the arrow so a very short one still reads as an arrow
// rather than a triangle.
function drawArrowNote(ctx: CanvasRenderingContext2D, item: EdItem, selected: boolean): void {
  const { tail, head } = arrowEnds(item);
  const d = head.sub(tail);
  const len = d.length();
  if (len < 1e-6) return;
  const u = d.div(len);
  const n = u.orthogonal();
  const headLen = Math.min(ARROW_HEAD_LENGTH, len * 0.5);
  const headHalf = ARROW_HEAD_HALF_WIDTH * (headLen / ARROW_HEAD_LENGTH);
  const base = head.sub(u.mul(headLen));

  if (selected) {
    ctx.strokeStyle = SELECT;
    ctx.lineWidth = ARROW_LINE_WIDTH * 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    ctx.lineTo(head.x, head.y);
    ctx.stroke();
    ctx.lineCap = "butt";
  }
  ctx.strokeStyle = NOTE_COLOR;
  ctx.fillStyle = NOTE_COLOR;
  ctx.lineWidth = ARROW_LINE_WIDTH;
  ctx.beginPath();
  ctx.moveTo(tail.x, tail.y);
  ctx.lineTo(base.x, base.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(head.x, head.y);
  ctx.lineTo(base.x + n.x * headHalf, base.y + n.y * headHalf);
  ctx.lineTo(base.x - n.x * headHalf, base.y - n.y * headHalf);
  ctx.closePath();
  ctx.fill();
}

// A text note's body, drawn in screen space so the glyphs stay crisp, at a size
// derived from the world glyph height so it still scales with the zoom. The box
// is drawn in the world pass; this only fills it.
function drawNoteText(ctx: CanvasRenderingContext2D, cam: Camera, item: EdItem): void {
  const scale = cam.zoom * PIXELS_PER_METER;
  const fontPx = item.note.size * scale;
  if (fontPx < 4) return; // illegible at this zoom; the box still shows it is there
  const h = halfExtents(item);
  const corner = worldToScreen(cam, toWorld(item, new Vec2(-h.x, -h.y)));
  const empty = item.note.text.trim() === "";
  ctx.save();
  ctx.translate(corner.x, corner.y);
  ctx.rotate(item.rot);
  ctx.font = `${fontPx}px monospace`;
  ctx.textBaseline = "top";
  ctx.fillStyle = NOTE_COLOR;
  ctx.globalAlpha *= empty ? 0.45 : 1;
  const pad = NOTE_PADDING * scale;
  const lines = wrapNoteText(
    ctx,
    empty ? NOTE_EMPTY_PLACEHOLDER : item.note.text,
    Math.max(1, h.x * 2 * scale - pad * 2),
  );
  let y = pad;
  for (const line of lines) {
    ctx.fillText(line, pad, y);
    y += fontPx * NOTE_LINE_HEIGHT;
  }
  ctx.restore();
}

export function drawEditor(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  w: number,
  h: number,
  cam: Camera,
  model: EdModel,
  selectedIds: ReadonlySet<number>,
  marquee: { min: Vec2; max: Vec2 } | null = null,
  visibleLayers: ReadonlySet<EdLayer> = new Set<EdLayer>(ED_LAYERS),
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTrainingGrid(ctx, cam, w, h);

  ctx.save();
  ctx.translate(w / 2, h / 2);
  const scale = cam.zoom * PIXELS_PER_METER;
  ctx.scale(scale, scale);
  ctx.translate(-cam.position.x, -cam.position.y);

  const worldLine = 1 / scale;
  // Every visible layer draws at full strength, whether or not it is the one
  // being edited: a dimmed layer is harder to read against the geometry it
  // annotates, and the toolbar's layer list already says which one a click
  // will hit. Visibility is the control for getting a layer out of the way.
  // Hook-only anchors first: they are background the player passes through, and
  // the game draws them behind solid geometry too. `sort` is stable, so the
  // authored order is preserved within each group.
  const geometry = model.items.filter((i) => i.layer === "geometry");
  const ordered = visibleLayers.has("geometry")
    ? [...geometry].sort((a, b) => Number(a.kind !== "anchor") - Number(b.kind !== "anchor"))
    : [];
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

  // Camera regions above the geometry they reshape — they are annotations on a
  // scene, not part of it.
  const regions = visibleLayers.has("camera")
    ? model.items.filter((i) => i.layer === "camera")
    : [];
  for (const r of regions) {
    pathBody(ctx, r);
    ctx.fillStyle = hexToRgba(CAMERA_REGION_COLOR, r.opacity);
    ctx.fill();
    if (selectedIds.has(r.id)) {
      ctx.strokeStyle = SELECT;
      ctx.lineWidth = worldLine * 5;
      ctx.stroke();
    }
    // Dashed border: a camera region is a volume the player passes through, so
    // nothing about it may read as solid.
    ctx.strokeStyle = CAMERA_REGION_COLOR;
    ctx.lineWidth = worldLine * 1.5;
    ctx.setLineDash([6 * PX, 4 * PX]);
    ctx.stroke();
    ctx.setLineDash([]);
    drawLockMarks(ctx, r, worldLine);
  }

  // Notes on top of everything they annotate — they are commentary on the
  // scene, and a note hidden behind the geometry it explains would be useless.
  const notes = visibleLayers.has("notes")
    ? model.items.filter((i) => i.layer === "notes")
    : [];
  for (const n of notes) {
    if (n.note.kind === "arrow") {
      drawArrowNote(ctx, n, selectedIds.has(n.id));
      continue;
    }
    pathBody(ctx, n);
    ctx.fillStyle = hexToRgba(NOTE_COLOR, n.opacity);
    ctx.fill();
    if (selectedIds.has(n.id)) {
      ctx.strokeStyle = SELECT;
      ctx.lineWidth = worldLine * 5;
      ctx.stroke();
    }
    // Dashed, like every other volume the player passes through: a note is not
    // geometry and must never read as a wall in a screenshot.
    ctx.strokeStyle = NOTE_COLOR;
    ctx.lineWidth = worldLine * 1.5;
    ctx.setLineDash([6 * PX, 4 * PX]);
    ctx.stroke();
    ctx.setLineDash([]);
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

  // Region labels in screen space: what a region does has to stay readable at
  // any zoom, and a world-space label would shrink to nothing.
  for (const r of regions) {
    const h = halfExtents(r);
    const anchor = worldToScreen(cam, r.pos.sub(h));
    ctx.font = "11px monospace";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = CAMERA_REGION_COLOR;
    ctx.fillText(cameraRegionLabel(r), anchor.x + 2, anchor.y - 3);
  }
  for (const n of notes) {
    if (n.note.kind === "text") drawNoteText(ctx, cam, n);
  }

  // Handles in screen space so they stay a constant on-screen size. They edit
  // one item's geometry, so they only appear for a single selection.
  const selection = model.items.filter((b) => selectedIds.has(b.id));
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
    // An arrow's endpoints are round, so they read as "drag me somewhere"
    // rather than as the corners of a box.
    if (hs.ends) for (const e of hs.ends) circleHandle(ctx, e);
  }

  // Rubber-band box, in screen space so its outline stays one pixel at any zoom.
  if (marquee) {
    const a = worldToScreen(cam, marquee.min);
    const b = worldToScreen(cam, marquee.max);
    ctx.fillStyle = MARQUEE_FILL;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeStyle = SELECT;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([]);
  }
}
