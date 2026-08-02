// Editor canvas rendering: the scene in the same camera transform as the sim,
// plus a grid and selection handles. `computeHandles` is the single source of
// truth for handle positions, shared by drawing and hit-testing.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { worldToScreen, type Camera } from "../render/camera";
import { drawTrainingGrid } from "../render/trainingGrid";
import { fillBackground } from "../render/background";
import { fillAnchor, fillForceArea, fillKillZone } from "../render/areaFill";
import { hexToRgba } from "../render/color";
import {
  arrowEnds,
  CAMERA_REGION_COLOR,
  chainEnds,
  ED_LAYERS,
  groupBounds,
  groupCentroid,
  groupMembers,
  halfExtents,
  isArrowNote,
  NOTE_COLOR,
  toWorld,
  type EdChain,
  type EdItem,
  type EdLayer,
  type EdModel,
} from "./model";
import { DEFAULT_VIEWPORT_SCALE } from "../level/levelFormat";
import {
  pathOutline,
  pathOutlineGrown,
  pathOutlineInto,
  uniformMargin,
  type Margin,
  type Outline,
} from "../render/shapePath";
import { REGION_EXIT_MARGIN } from "../render/cameraController";

const PLAYER = "#65bddb";
const IMPERMEABLE_EDGE = "#9db8c6"; // hook-proof surfaces: dashed steel border
const SELECT = "#f4a460";
// Marks a shape whose 3D visual is NOT its own outline (see the badge pass): a
// muted violet, distinct from the selection orange and the hook-proof steel, and
// from the camera layer's own violet by being fully saturated rather than a fill.
const VISUAL_BADGE = "#b07cff";
const MARQUEE_FILL = "rgba(244,164,96,0.10)";
const CAMERA_LOCK = "#e6c07b"; // camera-lock guides: warm, distinct from the region violet
// Editor-only outline of a background panel. In game a background is drawn with
// no border at all — that is what keeps it from reading as an object — but an
// author still has to see where a dark or near-transparent panel ends, and has
// to be able to find one to click. Dashed, like every other volume that is not
// a body, and a saturated teal rather than a grey: the outline has to carry
// against both the pale grid backdrop and whatever the panel is filled with,
// and a neutral edge disappears into one or the other.
const BACKGROUND_EDGE = "#4ec9b0";
const HANDLE = "#f4a460";
const HANDLE_FILL = "#1f2430";

// Chains. Forged iron rather than a saturated editor colour: a chain is played,
// not editor furniture, so it is drawn as the thing it will be and only its
// handles are chrome. `CHAIN_DEFAULT_COLOR` is what an unauthored chain shows in
// the inspector's colour well - the same steel the game's links are drawn in.
export const CHAIN_DEFAULT_COLOR = "#8a94a6";
export const CHAIN_HIT_PX = 7; // pointer pick band, half-width in screen px
const CHAIN_ANCHOR_R_PX = 3.5;
// Compound bodies. A dashed hull and spokes to the centre of mass - the point
// the built body's origin sits at and the point it rotates about, so it has to
// be visible while a group is being laid out.
const GROUP_MARK = "#7fd6a8";

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
  // Screen positions of a polygon's vertices, in loop order. A polygon has no
  // meaningful width and height to resize, so it is edited vertex by vertex —
  // the same reason an arrow note is edited by its endpoints rather than by a
  // box. The midpoints between them are where a new vertex is inserted.
  verts: Vec2[] | null;
  vertMids: Vec2[] | null;
}

// Screen-space handle points for a body, used for both drawing and hit-testing.
export function computeHandles(cam: Camera, body: EdItem): Handles {
  // An arrow is a segment, so it is edited by its endpoints: dragging either one
  // sets the position, length and direction at once, which is what a corner box
  // plus a rotate knob would take three gestures to do.
  const none = { corners: [], rotate: null, rotateBase: null, radius: null, ends: null, verts: null, vertMids: null };
  if (isArrowNote(body)) {
    const { tail, head } = arrowEnds(body);
    return {
      ...none,
      body,
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
      ...none,
      body,
      rotate: base ? base.add(up.mul(ROT_OFFSET_PX)) : null,
      rotateBase: base,
      radius: worldToScreen(cam, toWorld(body, new Vec2(r, 0))),
    };
  }
  const h = halfExtents(body);
  const topMid = worldToScreen(cam, toWorld(body, new Vec2(0, -h.y)));
  if (body.shape.kind === "poly") {
    // Vertices, and the edge midpoints that split an edge into two. A polygon
    // has no width/height to drag, so this is its whole resize interface.
    const world = body.shape.verts.map((v) => toWorld(body, v));
    const n = world.length;
    return {
      ...none,
      body,
      rotate: topMid.add(up.mul(ROT_OFFSET_PX)),
      rotateBase: topMid,
      verts: world.map((w) => worldToScreen(cam, w)),
      vertMids: world.map((w, i) =>
        worldToScreen(cam, w.add(world[(i + 1) % n]!).mul(0.5)),
      ),
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
  return {
    ...none,
    body,
    corners,
    rotate: topMid.add(up.mul(ROT_OFFSET_PX)),
    rotateBase: topMid,
  };
}

// Screen positions of a chain's two anchor handles, or null if either body it
// was tied to has gone.
export function computeChainHandles(
  cam: Camera,
  model: EdModel,
  chain: EdChain,
): { a: Vec2; b: Vec2 } | null {
  const ends = chainEnds(model, chain);
  if (!ends) return null;
  return { a: worldToScreen(cam, ends.a), b: worldToScreen(cam, ends.b) };
}

// The rotate knob for a whole compound body: above the group's bounding box, on
// the world's up axis. Deliberately not on any one member's up axis - the pieces
// have their own angles and the body as a whole has none, so the knob is placed
// by the group's extent and the drag measures how far the pointer swings rather
// than snapping something to the cursor.
export function computeGroupHandles(
  cam: Camera,
  items: readonly EdItem[],
): { rotate: Vec2; rotateBase: Vec2; centre: Vec2 } {
  const box = groupBounds(items);
  const topMid = worldToScreen(cam, new Vec2((box.min.x + box.max.x) / 2, box.min.y));
  return {
    rotate: topMid.add(new Vec2(0, -ROT_OFFSET_PX)),
    rotateBase: topMid,
    centre: worldToScreen(cam, groupCentroid(items)),
  };
}

// The item's outline — one description, shared with the game renderer, the
// backdrop pass and the SVG snapshot, so an authored shape is drawn by exactly
// the same geometry that plays.
function outlineOf(body: EdItem): Outline {
  if (body.shape.kind === "circle") return { kind: "circle", radius: body.shape.r };
  if (body.shape.kind === "poly") return { kind: "poly", verts: body.shape.verts };
  return { kind: "rect", half: new Vec2(body.shape.w / 2, body.shape.h / 2) };
}

function pathBody(ctx: CanvasRenderingContext2D, body: EdItem): void {
  ctx.beginPath();
  pathOutline(ctx, body.pos, body.rot, outlineOf(body));
}

// A camera region's buffer zone: the volume grown by `buffer`, which is where
// the region keeps its grip on the camera. `pathOutlineGrown` owns the geometry
// (square corners for a rect, filleted for a polygon) so what is drawn is
// exactly what `pointInRegion` tests.
export function pathRegionBuffer(
  ctx: CanvasRenderingContext2D,
  body: EdItem,
  buffer: Margin,
): void {
  ctx.beginPath();
  pathOutlineGrown(ctx, body.pos, body.rot, outlineOf(body), buffer);
}

// The buffer a camera region holds by, as `regionBuffer` computes it from the
// saved file - a plain distance, or a rect's per-side set once any side is
// authored, each side falling back to the region's own buffer and then to the
// controller's jitter margin. Null = nothing authored at all, which is drawn as
// nothing: the default margin is 15 cm of hysteresis rather than a reach an
// author placed, and outlining it on every region would say otherwise.
export function cameraBufferMargin(r: EdItem): Margin | null {
  const { buffer, bufferLeft, bufferRight, bufferTop, bufferBottom } = r.cam;
  const perSide =
    r.shape.kind === "rect" &&
    [bufferLeft, bufferRight, bufferTop, bufferBottom].some((s) => s !== null);
  if (buffer === null && !perSide) return null;
  const base = buffer ?? REGION_EXIT_MARGIN;
  if (!perSide) return base;
  return {
    left: bufferLeft ?? base,
    right: bufferRight ?? base,
    top: bufferTop ?? base,
    bottom: bufferBottom ?? base,
  };
}

// Every piece of a compound body accumulated into one path, so it can be filled
// as their union (nonzero) rather than one fill per piece.
function unionPath(items: readonly EdItem[]): Path2D {
  const p = new Path2D();
  for (const i of items) pathOutlineInto(p, i.pos, i.rot, outlineOf(i));
  return p;
}

// Stroke each piece only where it lies outside every sibling - the compound
// body's real outline. `style` sets the stroke before each piece, so the same
// walk serves the selection halo and the body's own border. Mirrors
// `drawCompoundGeometry` in render/renderer.ts, including why the siblings are
// clipped one at a time: a single even-odd clip keeps the region inside two of
// them, which is exactly where an interior seam sits.
function strokeCompoundOutline(
  ctx: CanvasRenderingContext2D,
  items: readonly EdItem[],
  // Called with the piece about to be stroked, so a style that differs per
  // piece (a hook-proof face among ordinary ones) can say so.
  style: (item: EdItem) => void,
): void {
  const box = groupBounds(items);
  const pad = 1;
  for (let i = 0; i < items.length; i++) {
    ctx.save();
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const outside = new Path2D();
      outside.rect(
        box.min.x - pad,
        box.min.y - pad,
        box.max.x - box.min.x + 2 * pad,
        box.max.y - box.min.y + 2 * pad,
      );
      pathOutlineInto(outside, items[j]!.pos, items[j]!.rot, outlineOf(items[j]!));
      ctx.clip(outside, "evenodd");
    }
    const own = new Path2D();
    pathOutlineInto(own, items[i]!.pos, items[i]!.rot, outlineOf(items[i]!));
    style(items[i]!);
    ctx.stroke(own);
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

// Edge-midpoint handle of a polygon: a small round one against the square
// vertex handles, so the two are told apart by shape and size rather than by
// position along an edge. It carries the same dark fill as every other handle —
// a hollow or dimmed ring vanishes into the selection halo it sits on top of,
// which is the one place these handles always are.
const MID_HANDLE_RADIUS_PX = 3;
function midHandle(ctx: CanvasRenderingContext2D, p: Vec2): void {
  ctx.fillStyle = HANDLE_FILL;
  ctx.strokeStyle = HANDLE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, MID_HANDLE_RADIUS_PX, 0, Math.PI * 2);
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
  const buf = cameraBufferMargin(r);
  if (buf !== null) {
    // Per side, the sides are named rather than left to a reading order nobody
    // can guess from four numbers.
    parts.push(
      typeof buf === "number"
        ? `buf ${px(buf)}`
        : `buf l${px(buf.left)} r${px(buf.right)} t${px(buf.top)} b${px(buf.bottom)}`,
    );
  }
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

// Compound-body marks. Every group gets a diamond at its centre of mass - the
// origin its built body will have, and the point it rotates about - and a
// selected one adds spokes to each piece plus a dashed hull, which is what says
// "these are one body" rather than "these shapes happen to overlap".
// `visible` is what may be marked (the members on layers that are drawn);
// `all` is every item in the model, which is what the centre of mass is measured
// over - the diamond is the built body's origin, and hiding a layer may not move
// it.
function drawGroupMarks(
  ctx: CanvasRenderingContext2D,
  visible: readonly EdItem[],
  all: readonly EdItem[],
  selectedIds: ReadonlySet<number>,
  worldLine: number,
): void {
  const groups = new Set<number>();
  for (const b of visible) if (b.group !== null) groups.add(b.group);
  for (const id of groups) {
    if (groupMembers(all, id).length < 2) continue;
    const members = groupMembers(visible, id);
    const centre = groupCentroid(groupMembers(all, id));
    const selected = members.some((m) => selectedIds.has(m.id));
    ctx.strokeStyle = GROUP_MARK;
    if (selected) {
      const box = groupBounds(members);
      ctx.lineWidth = worldLine * 1.5;
      ctx.setLineDash([6 * PX, 4 * PX]);
      ctx.strokeRect(box.min.x, box.min.y, box.max.x - box.min.x, box.max.y - box.min.y);
      ctx.setLineDash([]);
      ctx.lineWidth = worldLine;
      ctx.beginPath();
      for (const m of members) {
        ctx.moveTo(centre.x, centre.y);
        ctx.lineTo(m.pos.x, m.pos.y);
      }
      ctx.stroke();
    }
    // The centre-of-mass diamond, always: a group has to be identifiable as one
    // without being selected first.
    const r = 5 * worldLine;
    ctx.lineWidth = worldLine * 1.5;
    ctx.beginPath();
    ctx.moveTo(centre.x, centre.y - r);
    ctx.lineTo(centre.x + r, centre.y);
    ctx.lineTo(centre.x, centre.y + r);
    ctx.lineTo(centre.x - r, centre.y);
    ctx.closePath();
    ctx.stroke();
  }
}

export function drawEditor(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  w: number,
  h: number,
  cam: Camera,
  model: EdModel,
  selectedIds: ReadonlySet<number>,
  marquee: { min: Vec2; max: Vec2; window: boolean } | null = null,
  visibleLayers: ReadonlySet<EdLayer> = new Set<EdLayer>(ED_LAYERS),
  // A polygon being clicked out: the vertices placed so far plus where the
  // pointer is, so the outline is visible while it is being drawn rather than
  // only once it closes.
  polyDraft: { verts: readonly Vec2[]; cursor: Vec2 } | null = null,
  // Chains carry their own selection (see `selectedChainIds` in editor.ts).
  selectedChainIds: ReadonlySet<number> = new Set<number>(),
  // A chain being strung out: where it started and where the pointer is, plus
  // whether it is currently over a body it could land on - so the gesture says
  // in advance whether releasing will make a chain or drop it.
  chainDraft: { from: Vec2; to: Vec2; valid: boolean } | null = null,
  // How much of the scene this canvas is responsible for drawing.
  //
  // "fill" is the editor as it has always been: every item filled and stroked,
  // on the training-grid backdrop.
  //
  // With a 3D scene underneath, what an item IS is already drawn there, so the
  // overlay's job changes: "outline" drops the backdrop and every fill and draws
  // the collision boundaries, the handles and the marquee alone, so the geometry
  // below stays visible through the thing describing it.
  //
  // The scene-only third state of the editor's view toggle needs nothing here -
  // it simply does not call this - which is why there are two values and not
  // three.
  layers: "fill" | "outline" = "fill",
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // The backdrop is the editor's own paper. With a 3D scene underneath, this
  // canvas is a transparent sheet over it and painting paper on it would hide
  // the level.
  if (layers === "fill") drawTrainingGrid(ctx, cam, w, h);
  else ctx.clearRect(0, 0, w, h); // in CSS pixels: the transform above carries the DPR

  // Every fill goes through this. In outline mode it turns each of them fully
  // transparent rather than each call site growing a branch: the strokes, the
  // glyph lattices and the even-odd cutouts are all still computed and still
  // land exactly where they did, so nothing about the drawing can drift between
  // the two modes - only whether the paint is opaque.
  const paint = (color: string): string => (layers === "fill" ? color : "rgba(0,0,0,0)");

  ctx.save();
  ctx.translate(w / 2, h / 2);
  const scale = cam.zoom * PIXELS_PER_METER;
  ctx.scale(scale, scale);
  ctx.translate(-cam.position.x, -cam.position.y);

  const worldLine = 1 / scale;
  // Backgrounds first, exactly as the game draws them: decoration is under
  // everything, so nothing the player can touch is ever hidden behind it.
  const backgrounds = visibleLayers.has("background")
    ? model.items.filter((i) => i.layer === "background")
    : [];
  for (const g of backgrounds) {
    fillBackground(ctx, g.pos, g.rot, outlineOf(g), paint(hexToRgba(g.color, g.opacity)));
    if (selectedIds.has(g.id)) {
      pathBody(ctx, g);
      ctx.strokeStyle = SELECT;
      ctx.lineWidth = worldLine * 5;
      ctx.stroke();
    }
    pathBody(ctx, g);
    ctx.strokeStyle = BACKGROUND_EDGE;
    ctx.lineWidth = worldLine * 1.5;
    ctx.setLineDash([6 * PX, 4 * PX]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

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
  // Compound bodies draw as one object rather than as their pieces - union fill,
  // and a border only where a piece is not covered by a sibling. Drawn piece by
  // piece instead, the overlaps fill twice (a darker patch) and the joins get a
  // border each (a crack across a solid wall), neither of which is in the level.
  // Anchors keep the per-shape path: their fill is a grate lattice punched out of
  // each piece, which has no union form.
  const drawnAsGroup = new Set<number>();
  for (const body of ordered) {
    if (body.group === null || body.kind === "anchor" || drawnAsGroup.has(body.id)) continue;
    const members = groupMembers(ordered, body.group).filter((m) => m.kind !== "anchor");
    if (members.length < 2) continue;
    for (const m of members) drawnAsGroup.add(m.id);
    const union = unionPath(members);
    ctx.fillStyle = paint(hexToRgba(body.color, body.opacity));
    ctx.fill(union);
    if (members.some((m) => selectedIds.has(m.id))) {
      strokeCompoundOutline(ctx, members, () => {
        ctx.strokeStyle = SELECT;
        ctx.lineWidth = worldLine * 5;
        ctx.setLineDash([]);
      });
    }
    // The border is per PIECE, because hook-proof is: a compound wall may be
    // attachable on the ledge the player aims at and repel the hook everywhere
    // else, and one border for the body would draw only one of those.
    strokeCompoundOutline(ctx, members, (m) => {
      if (m.impermeable) {
        ctx.strokeStyle = IMPERMEABLE_EDGE;
        ctx.lineWidth = worldLine * 2;
        ctx.setLineDash([5 * PX, 3 * PX]);
      } else {
        ctx.strokeStyle = body.color;
        ctx.lineWidth = worldLine;
        ctx.setLineDash([]);
      }
    });
    ctx.setLineDash([]);
  }
  for (const body of ordered) {
    if (drawnAsGroup.has(body.id)) continue;
    // Areas fill with their glyph cut out of them — the same calls the game
    // makes, so authoring shows exactly what play shows.
    if (body.kind === "force") {
      fillForceArea(
        ctx,
        body.pos,
        body.rot,
        outlineOf(body),
        body.force,
        paint(hexToRgba(body.color, body.opacity)),
      );
    } else if (body.kind === "killzone") {
      fillKillZone(
        ctx,
        body.pos,
        body.rot,
        outlineOf(body),
        paint(hexToRgba(body.color, body.opacity)),
      );
    } else if (body.kind === "anchor") {
      // Hook-only scenery: the same grate mesh the game punches through it.
      fillAnchor(
        ctx,
        body.pos,
        body.rot,
        outlineOf(body),
        paint(hexToRgba(body.color, body.opacity)),
      );
    } else {
      pathBody(ctx, body);
      ctx.fillStyle = paint(hexToRgba(body.color, body.opacity));
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
    if (body.impermeable) {
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

  // What the 3D renderer will do with a shape, marked on the 2D view - which
  // cannot otherwise show it at all. Only the two kinds that are NOT what the
  // shape looks like are marked: `mesh` (a prop stands in for this outline) and
  // `none` (nothing is drawn here at all, an invisible wall). `auto` is the
  // default and is exactly the shape as drawn, so a badge on it would be a mark
  // on almost every body saying nothing.
  for (const body of [...(visibleLayers.has("geometry") ? geometry : []), ...backgrounds]) {
    const kind = body.visual.kind;
    if (kind === "auto") continue;
    const r = 6 * PX;
    ctx.lineWidth = worldLine * 1.5;
    ctx.strokeStyle = VISUAL_BADGE;
    ctx.beginPath();
    if (kind === "mesh") {
      // A cube seen in three-quarter: the mark for "a prop is drawn here".
      ctx.rect(body.pos.x - r, body.pos.y - r, r * 2, r * 2);
      ctx.moveTo(body.pos.x - r, body.pos.y - r);
      ctx.lineTo(body.pos.x - r * 0.4, body.pos.y - r * 1.6);
      ctx.lineTo(body.pos.x + r * 1.6, body.pos.y - r * 1.6);
      ctx.lineTo(body.pos.x + r, body.pos.y - r);
      ctx.moveTo(body.pos.x + r, body.pos.y + r);
      ctx.lineTo(body.pos.x + r * 1.6, body.pos.y + r * 0.4);
      ctx.lineTo(body.pos.x + r * 1.6, body.pos.y - r * 1.6);
    } else {
      // A struck-through ring: "solid, and drawn by nothing".
      ctx.arc(body.pos.x, body.pos.y, r, 0, Math.PI * 2);
      ctx.moveTo(body.pos.x - r * 0.71, body.pos.y + r * 0.71);
      ctx.lineTo(body.pos.x + r * 0.71, body.pos.y - r * 0.71);
    }
    ctx.stroke();
  }

  // Compound-body marks, over the geometry they describe. A group is one body,
  // and nothing about the drawn shapes says so on their own - they are simply
  // several shapes touching - so the marks are what make the seam rule visible
  // while a level is being laid out.
  //
  // Backgrounds are in the same pass, spokes and hull included: a panel welded
  // into a body rides it in play, and the spoke reaching down to a backdrop is
  // the only thing on screen that says so. Only the VISIBLE members are marked,
  // so hiding a layer really does take it out of the picture; the diamond stays
  // put whatever is hidden, since it is the shapes' centre of mass alone.
  const markable = [...(visibleLayers.has("geometry") ? geometry : []), ...backgrounds];
  drawGroupMarks(ctx, markable, model.items, selectedIds, worldLine);

  // Chains over the bodies they hold. Drawn STRAIGHT, because that is what the
  // solver renders: a chain's span is a straight line between wrap nodes, and
  // drawing a guessed sag here would be a drawing of something the level does
  // not contain.
  if (visibleLayers.has("geometry")) {
    for (const c of model.chains) {
      const ends = chainEnds(model, c);
      if (!ends) continue;
      const selected = selectedChainIds.has(c.id);
      if (selected) {
        ctx.strokeStyle = SELECT;
        ctx.lineWidth = worldLine * 5;
        ctx.beginPath();
        ctx.moveTo(ends.a.x, ends.a.y);
        ctx.lineTo(ends.b.x, ends.b.y);
        ctx.stroke();
      }
      const color = c.color ?? CHAIN_DEFAULT_COLOR;
      ctx.strokeStyle = color;
      ctx.lineWidth = worldLine * 2;
      // Chains are drawn broken, the same way every editor marks a thing that is
      // there but cannot be touched: a chain hangs behind the level and passes
      // through it, the player and the hook (see `SceneChain`). The anchor rings
      // stay solid - those are still real, editable points.
      ctx.setLineDash([7 * worldLine, 5 * worldLine]);
      ctx.beginPath();
      ctx.moveTo(ends.a.x, ends.a.y);
      ctx.lineTo(ends.b.x, ends.b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // A ring at each anchor: the chain is pinned to a point on a body, and the
      // point is what an author places, so it has to be findable under the fill.
      ctx.fillStyle = color;
      for (const p of [ends.a, ends.b]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, CHAIN_ANCHOR_R_PX * worldLine, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // The chain being strung out, if any: dashed while it has nowhere to land,
  // solid the moment it is over a body it can attach to.
  if (chainDraft) {
    ctx.strokeStyle = chainDraft.valid ? CHAIN_DEFAULT_COLOR : SELECT;
    ctx.lineWidth = worldLine * 2;
    if (!chainDraft.valid) ctx.setLineDash([6 * PX, 4 * PX]);
    ctx.beginPath();
    ctx.moveTo(chainDraft.from.x, chainDraft.from.y);
    ctx.lineTo(chainDraft.to.x, chainDraft.to.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Camera regions above the geometry they reshape — they are annotations on a
  // scene, not part of it.
  const regions = visibleLayers.has("camera")
    ? model.items.filter((i) => i.layer === "camera")
    : [];
  for (const r of regions) {
    pathBody(ctx, r);
    ctx.fillStyle = paint(hexToRgba(CAMERA_REGION_COLOR, r.opacity));
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
    // The buffer zone, when one is authored: the region holds the camera
    // anywhere inside it, so a region drawn without it looks like it lets go at
    // its own edge. Finer dots and a thinner line than the region's own border,
    // since it is the region's reach rather than a second volume.
    const buffer = cameraBufferMargin(r);
    if (buffer !== null && uniformMargin(buffer) > 0) {
      pathRegionBuffer(ctx, r, buffer);
      ctx.strokeStyle = CAMERA_REGION_COLOR;
      ctx.lineWidth = worldLine;
      ctx.setLineDash([2 * PX, 5 * PX]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
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
    ctx.fillStyle = paint(hexToRgba(NOTE_COLOR, n.opacity));
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

  // Polygon in progress, above the scene it is being drawn over: the placed
  // vertices as a solid outline, the run back from the pointer dashed, so it is
  // obvious which edge is still being aimed and which are committed.
  if (polyDraft && polyDraft.verts.length) {
    const v = polyDraft.verts;
    ctx.strokeStyle = SELECT;
    ctx.lineWidth = worldLine * 2;
    ctx.beginPath();
    v.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
    ctx.stroke();
    ctx.setLineDash([6 * PX, 4 * PX]);
    ctx.beginPath();
    ctx.moveTo(v[v.length - 1]!.x, v[v.length - 1]!.y);
    ctx.lineTo(polyDraft.cursor.x, polyDraft.cursor.y);
    if (v.length >= 2) ctx.lineTo(v[0]!.x, v[0]!.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // A dot per placed vertex, and a ring on the first one: clicking it is what
    // closes the loop, so it has to be findable.
    ctx.fillStyle = SELECT;
    for (const q of v) {
      ctx.beginPath();
      ctx.arc(q.x, q.y, worldLine * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    if (v.length >= 3) {
      ctx.lineWidth = worldLine * 1.5;
      ctx.beginPath();
      ctx.arc(v[0]!.x, v[0]!.y, worldLine * 6, 0, Math.PI * 2);
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
  // A selected chain is edited by its two anchors: round, like every other
  // handle that is dragged somewhere rather than sizing a box.
  for (const c of model.chains) {
    if (!selectedChainIds.has(c.id)) continue;
    const hs = computeChainHandles(cam, model, c);
    if (!hs) continue;
    circleHandle(ctx, hs.a);
    circleHandle(ctx, hs.b);
  }
  // A whole compound body turns as one, so it gets a rotate knob where a lone
  // shape does - placed by the group's extent, with the centre of mass it turns
  // about marked at the other end of the stalk.
  const groupSel =
    selection.length > 1 &&
    selection[0]!.group !== null &&
    selection.every((b) => b.group === selection[0]!.group) &&
    groupMembers(model.items, selection[0]!.group!).length === selection.length
      ? selection
      : null;
  if (groupSel) {
    const gh = computeGroupHandles(cam, groupSel);
    ctx.strokeStyle = HANDLE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(gh.rotateBase.x, gh.rotateBase.y);
    ctx.lineTo(gh.rotate.x, gh.rotate.y);
    ctx.stroke();
    circleHandle(ctx, gh.rotate);
  }
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
    // A polygon is edited vertex by vertex: square handles on the vertices, and
    // smaller hollow ones at the edge midpoints, which insert a new vertex when
    // dragged. The midpoints are drawn differently on purpose - a uniform row of
    // handles would read as "these are all vertices" and hide that the shape has
    // four corners rather than eight.
    if (hs.verts) for (const v of hs.verts) square(ctx, v);
    if (hs.vertMids) for (const m of hs.vertMids) midHandle(ctx, m);
    // An arrow's endpoints are round, so they read as "drag me somewhere"
    // rather than as the corners of a box.
    if (hs.ends) for (const e of hs.ends) circleHandle(ctx, e);
  }

  // Rubber-band box, in screen space so its outline stays one pixel at any zoom.
  // The two selection modes have to be told apart *while dragging*, since which
  // one is live depends on a drag direction the box itself cannot show: a solid
  // edge is a window (encloses), a dashed one a crossing (touches) — the CAD
  // convention, so it reads the same way as in Fusion 360 or AutoCAD.
  if (marquee) {
    const a = worldToScreen(cam, marquee.min);
    const b = worldToScreen(cam, marquee.max);
    ctx.fillStyle = MARQUEE_FILL;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeStyle = SELECT;
    ctx.lineWidth = 1;
    if (!marquee.window) ctx.setLineDash([4, 3]);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([]);
  }
}
