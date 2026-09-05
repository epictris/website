// Editor canvas rendering: the scene in the same camera transform as the sim,
// plus a grid and selection handles. `computeHandles` is the single source of
// truth for handle positions, shared by drawing and hit-testing.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { worldToScreen, type Camera } from "../render/camera";
import { drawTrainingGrid } from "../render/trainingGrid";
import { fillDecor } from "../render/decor";
import { fillAnchor, fillForceArea, fillKillZone, fillWaterArea } from "../render/areaFill";
import { hexToRgba } from "../render/color";
import {
  arrowEnds,
  isKeyed,
  pathDataOf,
  CAMERA_REGION_COLOR,
  chainEnds,
  vineRestPath,
  ED_LAYERS,
  bodyBounds,
  bodyCentroid,
  bodyFrameOf,
  routeWorldPoints,
  bodyMembers,
  halfExtents,
  isArrowNote,
  collidingBodyIds,
  itemDepth,
  NOTE_COLOR,
  polyMustBeConvex,
  toWorld,
  type EdChain,
  type EdVine,
  type EdItem,
  type EdLayer,
  type EdModel,
  type SettleGhost,
} from "./model";
import { cubicAt } from "../render/cameraPath";
import {
  DEFAULT_PATH_FALLOFF_X,
  DEFAULT_PATH_FALLOFF_Y,
  DEFAULT_PATH_LOOKAHEAD_BUFFER_X,
  DEFAULT_PATH_LOOKAHEAD_BUFFER_Y,
  DEFAULT_PATH_LOOKAHEAD_X,
  DEFAULT_PATH_LOOKAHEAD_Y,
  DEFAULT_PATH_RANGE_X,
  DEFAULT_PATH_RANGE_Y,
  DEFAULT_VIEWPORT_SCALE,
} from "../level/levelFormat";
import {
  pathOutline,
  pathCorridorSweepInto,
  pathOutlineGrown,
  pathOutlineInto,
  pathOutlineIntoGrown,
  uniformMargin,
  type Margin,
  type Outline,
} from "../render/shapePath";
import {
  REGION_EXIT_MARGIN,
  buildCameraRules,
  pathBandAxes,
  pathHasBand,
  pathParamsAt,
  pathRangeAxes,
  pathReleaseAxes,
  type PathKeyField,
} from "../render/cameraController";
import { decomposeSeams, isSimpleLoop } from "../lib/polygon";

const PLAYER = "#65bddb";
const IMPERMEABLE_EDGE = "#9db8c6"; // hook-proof surfaces: dashed steel border
export const SELECT = "#f4a460";
// Marks a shape whose 3D visual is NOT its own outline (see the badge pass): a
// muted violet, distinct from the selection orange and the hook-proof steel, and
// from the camera layer's own violet by being fully saturated rather than a fill.
const VISUAL_BADGE = "#b07cff";
const MARQUEE_FILL = "rgba(244,164,96,0.10)";
const CAMERA_LOCK = "#e6c07b"; // camera-lock guides: warm, distinct from the region violet
// Editor-only outline of a non-colliding shape. In game decoration is drawn
// with no border at all — that is what keeps it from reading as an object — but
// an author still has to see where a dark or near-transparent panel ends, has to
// be able to find one to click, and above all has to be able to tell at a glance
// which shapes on the canvas are part of the level and which are only drawn.
// Dashed, like every other volume the player passes through, and a saturated
// teal rather than a grey: the outline has to carry against both the pale grid
// backdrop and whatever the shape is filled with, and a neutral edge disappears
// into one or the other.
const DECOR_EDGE = "#4ec9b0";
const HANDLE = "#f4a460";
const HANDLE_FILL = "#1f2430";
// Where a concave outline is cut into convex pieces: dim and dashed, because a
// seam is not a surface. It has to read as "this is inside the shape" against
// the orange handles, which are the things on a polygon that CAN be dragged.
const SEAM = "#8a93a5";
// A draft outline that crosses itself. Said while it is being clicked out rather
// than when it is closed, because closing it is when it stops being fixable by
// moving the pointer - and a crossed loop is the one draft the poly tool cannot
// take as drawn (it falls back to the convex hull, which is not what was drawn).
const DRAFT_CROSSED = "#d4756f";

// Chains. Forged iron rather than a saturated editor colour: a chain is played,
// not editor furniture, so it is drawn as the thing it will be and only its
// handles are chrome. `CHAIN_DEFAULT_COLOR` is what an unauthored chain shows in
// the inspector's colour well - the same steel the game's links are drawn in.
export const CHAIN_DEFAULT_COLOR = "#8a94a6";
export const CHAIN_HIT_PX = 7; // pointer pick band, half-width in screen px
// What an unauthored vine shows in the editor - the renderer's own vine green,
// so the canvas and the game agree about what a vine looks like.
export const VINE_DEFAULT_COLOR = "#5c7a48";
const CHAIN_ANCHOR_R_PX = 3.5;
// Compound bodies. A dashed hull and spokes to the centre of mass - the point
// the built body's origin sits at and the point it rotates about, so it has to
// be visible while a group is being laid out.
const GROUP_MARK = "#7fd6a8";
// The objects of the body currently selected. A body is selected and its objects
// are NOT - clicking again is what drills into one - so this cannot be the
// selection orange, which everywhere else means "an edit applies to this". Blue
// says the opposite: these are what the selected body is made of, shown so the
// body's extent is visible without the pieces being picked.
export const BODY_MEMBER = "#4f9dff";

// Scripted motion - a pendulum's arc, a platform's route. A colour of its own
// because it is neither geometry nor a handle: it is what the level DOES with a
// body, drawn over the level and grabbable only on the body that is selected. A
// warm amber against the group marks' green and the members' blue, so a canvas
// carrying all three still says which is which.
const MOVER_MARK = "#e0a548";

export const HANDLE_SIZE_PX = 8; // drawn square side
// Half-diagonal of a keyed path node's diamond, in screen pixels: past the
// vertex square's corners (half its side is 4) by enough to read as a
// different glyph rather than a misdrawn one.
const PATH_KEY_DIAMOND_PX = 7;
export const HANDLE_HIT_PX = 9; // pointer pick radius
const ROT_OFFSET_PX = 26; // rotate handle distance beyond the top edge
const DEPTH_OFFSET_PX = 26; // depth handle distance beyond the right edge

// Which objects have a z at all: the ones that are DRAWN, and lights. A
// collision shape has none - it is the gameplay plane, which is what makes it
// collision - so it gets no depth handle rather than one that writes nothing.
export function hasDepth(item: EdItem): boolean {
  return item.object === "geometry" || item.object === "light";
}

// What that handle is dragging, in metres off the plane.
export function depthOf(item: EdItem): number {
  return item.object === "geometry" ? item.visual.offsetZ : item.object === "light" ? item.light.z : 0;
}

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
  // Screen position of the DEPTH handle: the one axis the canvas cannot show,
  // dragged up and down beside the shape (see `drawDepthHandle`). Only the
  // objects that have a z - a drawn form and a light - get one.
  //
  // The 3D gizmo has a blue z arrow and it is not a substitute: three's
  // `TransformControls` hides an axis pointing at the camera, which is exactly
  // what z is in the view this editor authors in. So the gizmo's arrow is what
  // an ORBITED view offers and this is what the head-on one does.
  depth: Vec2 | null;
  // Screen positions of a camera path's Bézier tangent handles, two per node.
  // A node whose handle is unset shows a STUB - a fixed screen distance along
  // the edge's own direction - rather than a grip sitting exactly on the vertex
  // it belongs to, which would be unpickable. Dragging a stub is what authors
  // the first real handle, so every corner is one drag from smooth.
  pathHandles: PathHandlePoint[] | null;
}

export interface PathHandlePoint {
  pos: Vec2; // screen
  vert: number;
  side: "in" | "out";
}

// How far from its node an unset handle's grip is drawn, in screen pixels.
// Clear of `HANDLE_HIT_PX` around the vertex, so reaching for one is never
// ambiguous with reaching for the other.
const HANDLE_STUB_PX = 26;

// Screen-space handle points for a body, used for both drawing and hit-testing.
// Does this item offer handles on the gameplay plane at all?
//
// Every one of them - the corner boxes, the rotate knob, the radius grip, a
// polygon's vertices, the depth arrow - is a point on an OUTLINE, so the
// question is whether the thing drawn on this canvas HAS that outline.
//
// A MESH does not, and once a scene is drawn underneath there is nothing on the
// canvas standing for it: the handles are the box that was just taken away,
// drawn as four squares floating in empty space with nothing between them,
// sitting metres from the prop, and since the file has one `scale` for a mesh
// and no width at all, most of them edit nothing visible either. So in a 3D view
// a mesh's handle set IS the transform gizmo, which is in the scene and
// therefore on the thing being edited.
//
// A PRIMITIVE is the opposite case: it is its own shape extruded, so the solid
// drawn under the overlay is exactly that outline and the handles land on its
// corners. Suppressing them there cost the cheapest edit a primitive has - drag
// a corner to resize it - in the view the editor opens in, and offered the
// gizmo's scale boxes as the only substitute. The handles are projected on the
// gameplay plane like every other one, so a primitive pushed off the plane by
// its `off z` has them where its outline is rather than where the perspective
// draws its face; an orbited view drops the whole overlay in any case.
//
// Everything else - collision shapes, camera regions, notes, lights - keeps its
// handles in every view, because the overlay goes on drawing those.
export function hasPlaneHandles(item: EdItem, layers: "fill" | "outline"): boolean {
  return layers === "fill" || item.object !== "geometry" || item.visual.kind === "primitive";
}

export function computeHandles(cam: Camera, body: EdItem): Handles {
  // An arrow is a segment, so it is edited by its endpoints: dragging either one
  // sets the position, length and direction at once, which is what a corner box
  // plus a rotate knob would take three gestures to do.
  const none = {
    corners: [],
    rotate: null,
    rotateBase: null,
    radius: null,
    ends: null,
    verts: null,
    vertMids: null,
    depth: null,
    pathHandles: null,
  };
  // Beside the shape's right edge, on the body's own +x, so it sits clear of the
  // corner boxes and turns with the shape exactly as the rotate knob does.
  const depthHandle = (edge: number): Vec2 | null => {
    if (!hasDepth(body)) return null;
    const right = new Vec2(1, 0).rotated(body.rot).normalized();
    return worldToScreen(cam, toWorld(body, new Vec2(edge, 0))).add(right.mul(DEPTH_OFFSET_PX));
  };
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
    // A circle's rotation is invisible - except on a force area or a body of
    // water, where it aims the current, so those get the knob too rather than
    // only the rot° field.
    const base =
      body.kind === "force" || body.kind === "water"
        ? worldToScreen(cam, toWorld(body, new Vec2(0, -r)))
        : null;
    return {
      ...none,
      body,
      rotate: base ? base.add(up.mul(ROT_OFFSET_PX)) : null,
      rotateBase: base,
      radius: worldToScreen(cam, toWorld(body, new Vec2(r, 0))),
      // A light's circle is its REACH, which is as wide as the room it lights,
      // so its depth handle goes beside the source icon instead - the same
      // reason a click on a light lands on the icon and not on the pool.
      depth: depthHandle(
        body.object === "light" ? lightPickRadius(1 / (cam.zoom * PIXELS_PER_METER)) : r,
      ),
    };
  }
  const h = halfExtents(body);
  const topMid = worldToScreen(cam, toWorld(body, new Vec2(0, -h.y)));
  if (body.shape.kind === "path") {
    // The same vertex interface a polygon has, minus the wrap: an open run has
    // one fewer edge than it has verts, so the last vert gets no midpoint after
    // it and the endpoints are dragged rather than joined.
    //
    // The midpoint of a CURVED edge is the curve's own midpoint (t = 1/2), not
    // the chord's: inserting there is a de Casteljau split, which leaves the
    // shape exactly as it was and puts the new grip on the line the author can
    // see.
    const shape = body.shape;
    const world = shape.verts.map((v) => toWorld(body, v));
    const nodes = shape.verts.map((p, i) => ({
      p,
      in: shape.handles[i]?.in ?? Vec2.ZERO,
      out: shape.handles[i]?.out ?? Vec2.ZERO,
    }));
    const mids = nodes
      .slice(0, -1)
      .map((a, i) =>
        worldToScreen(
          cam,
          toWorld(
            body,
            cubicAt(a.p, a.p.add(a.out), nodes[i + 1]!.p.add(nodes[i + 1]!.in), nodes[i + 1]!.p, 0.5),
          ),
        ),
      );
    return {
      ...none,
      body,
      rotate: topMid.add(up.mul(ROT_OFFSET_PX)),
      rotateBase: topMid,
      verts: world.map((w) => worldToScreen(cam, w)),
      vertMids: mids,
      depth: depthHandle(h.x),
      pathHandles: pathHandlePoints(cam, body, nodes),
    };
  }
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
      depth: depthHandle(h.x),
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
    depth: depthHandle(hw),
  };
}

// Where a path's tangent grips are drawn, in screen space. A handle that has
// been authored sits at its own offset; one that has not is a STUB along the
// edge it belongs to, at a fixed screen distance so it is the same size to grab
// at any zoom. An end node has only the edge it actually has, so its outward
// side takes that edge's direction too rather than pointing nowhere.
function pathHandlePoints(
  cam: Camera,
  body: EdItem,
  nodes: readonly { p: Vec2; in: Vec2; out: Vec2 }[],
): PathHandlePoint[] {
  const out: PathHandlePoint[] = [];
  const perPx = 1 / (cam.zoom * PIXELS_PER_METER);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    // The edge direction each side faces, falling back to the other edge at an
    // end node so a stub always has somewhere to point.
    const prev = nodes[i - 1];
    const next = nodes[i + 1];
    const back = (prev ? prev.p.sub(n.p) : next ? n.p.sub(next.p) : Vec2.LEFT).normalized();
    const fwd = (next ? next.p.sub(n.p) : prev ? n.p.sub(prev.p) : Vec2.RIGHT).normalized();
    for (const [side, offset, dir] of [
      ["in", n.in, back],
      ["out", n.out, fwd],
    ] as const) {
      const local = offset.lengthSquared() > 0 ? offset : dir.mul(HANDLE_STUB_PX * perPx);
      out.push({ pos: worldToScreen(cam, toWorld(body, n.p.add(local))), vert: i, side });
    }
  }
  return out;
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

// Screen positions of a vine's two draggable handles: the anchor it hangs from,
// which is WHERE the vine is, and the other end - the free end of a hanging
// vine's rest pose, which is how long it is, or the second anchor of a span.
// Both, and not the tip alone, for the reason a chain has one at each end: the
// anchor is an object with no canvas presence of its own, so the handle its
// cord draws at it is the only thing there is to take hold of.
export function computeVineHandles(
  cam: Camera,
  model: EdModel,
  vine: EdVine,
): { top: Vec2; tip: Vec2 } | null {
  const path = vineRestPath(model, vine);
  if (!path) return null;
  return {
    top: worldToScreen(cam, path[0]!),
    tip: worldToScreen(cam, path[path.length - 1]!),
  };
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
  const box = bodyBounds(items);
  const topMid = worldToScreen(cam, new Vec2((box.min.x + box.max.x) / 2, box.min.y));
  return {
    rotate: topMid.add(new Vec2(0, -ROT_OFFSET_PX)),
    rotateBase: topMid,
    centre: worldToScreen(cam, bodyCentroid(items)),
  };
}

// The item's outline — one description, shared with the game renderer, the
// backdrop pass and the SVG snapshot, so an authored shape is drawn by exactly
// the same geometry that plays.
function outlineOf(body: EdItem): Outline {
  if (body.shape.kind === "circle") return { kind: "circle", radius: body.shape.r };
  if (body.shape.kind === "poly") return { kind: "poly", verts: body.shape.verts };
  // A camera path is an open polyline and has no outline at all - no inside, no
  // area, nothing to fill. It is drawn by `drawCameraPath` instead, and every
  // caller here is about a closed shape, so answering its bounding box would be
  // a rectangle that is not the thing.
  if (body.shape.kind === "path") {
    const h = halfExtents(body);
    return { kind: "rect", half: h };
  }
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
  const box = bodyBounds(items);
  const pad = 1;
  for (let i = 0; i < items.length; i++) {
    ctx.save();
    // The style first, because the clip below is measured in it: each sibling is
    // grown by a line width so that two pieces which ABUT rather than overlap
    // lose the whole of their shared edge's stroke instead of half of it each,
    // which reads as a hairline crack across a solid body. Same rule and same
    // reason as `drawCompoundGeometry` in render/renderer.ts, where the full
    // account of the arithmetic is.
    style(items[i]!);
    const grow = ctx.lineWidth;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const outside = new Path2D();
      outside.rect(
        box.min.x - pad,
        box.min.y - pad,
        box.max.x - box.min.x + 2 * pad,
        box.max.y - box.min.y + 2 * pad,
      );
      pathOutlineIntoGrown(outside, items[j]!.pos, items[j]!.rot, outlineOf(items[j]!), grow);
      ctx.clip(outside, "evenodd");
    }
    const own = new Path2D();
    pathOutlineInto(own, items[i]!.pos, items[i]!.rot, outlineOf(items[i]!));
    ctx.stroke(own);
    ctx.restore();
  }
}

// The depth handle: an up/down arrow beside the shape, in the gizmo's own blue
// so the two ways of authoring the same axis read as the same axis. Dragging it
// up is toward the camera, which is +z, and the value is drawn beside it in the
// inspector's units - a handle for a quantity with no on-screen extent has to
// say what it is at, or a drag has no feedback but the shading.
function drawDepthHandle(ctx: CanvasRenderingContext2D, p: Vec2, z: number): void {
  const r = HANDLE_SIZE_PX / 2 + 1;
  ctx.strokeStyle = BODY_MEMBER;
  ctx.fillStyle = HANDLE_FILL;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r + 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - r);
  ctx.lineTo(p.x, p.y + r);
  for (const s of [-1, 1]) {
    ctx.moveTo(p.x - 3, p.y + s * (r - 3));
    ctx.lineTo(p.x, p.y + s * r);
    ctx.lineTo(p.x + 3, p.y + s * (r - 3));
  }
  ctx.stroke();
  // Scene pixels, which is what the inspector's `off z` field shows: two
  // readouts of one number in two units is a number nobody trusts.
  ctx.fillStyle = BODY_MEMBER;
  ctx.textBaseline = "middle";
  ctx.fillText(`z ${Math.round(z * PIXELS_PER_METER)}`, p.x + r + 4, p.y);
}

function square(ctx: CanvasRenderingContext2D, p: Vec2): void {
  const s = HANDLE_SIZE_PX;
  ctx.fillStyle = HANDLE_FILL;
  ctx.strokeStyle = HANDLE;
  ctx.lineWidth = 1.5;
  ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
  ctx.strokeRect(p.x - s / 2, p.y - s / 2, s, s);
}

// A vertex that is PICKED, as against merely draggable. Filled in the selection
// orange rather than outlined in it, which is the same distinction the halo
// draws around a selected object: the colour means "an edit applies to this",
// and a hollow handle at every corner already means "you may drag me".
function filledSquare(ctx: CanvasRenderingContext2D, p: Vec2): void {
  const s = HANDLE_SIZE_PX;
  ctx.fillStyle = HANDLE;
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

// A camera path's tangent grip: filled in the camera layer's own violet, so a
// handle reads as belonging to the path rather than to the item's box. Smaller
// than a vertex square for the same reason a polygon's edge midpoints are - the
// nodes are the route and the tangents only shape it.
function tangentHandle(ctx: CanvasRenderingContext2D, p: Vec2): void {
  ctx.fillStyle = CAMERA_REGION_COLOR;
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
// One light, as editor furniture. Three marks, and each says a different thing:
//
// - THE REACH, a dashed ring at the item's own radius. This is the field that
//   authors the look - falloff is inverse-square, so where the light ends is
//   where the lit part of the level ends - and it is the one thing about a lamp
//   with a size, so it is drawn as the volume rather than as a number.
// - THE SOURCE, a small burst at the centre, in the light's own colour. It is
//   world-scaled like everything else here, but with a floor in screen terms, so
//   a lamp zoomed away to nothing is still findable and clickable.
// - THE CONE, for a spot: the two edge rays out to the reach, so the aim is read
//   off the canvas rather than out of three numbers in the inspector.
function drawLightGizmo(
  ctx: CanvasRenderingContext2D,
  l: EdItem,
  worldLine: number,
  selected: boolean,
  paint: (color: string) => string,
): void {
  const range = l.shape.kind === "circle" ? l.shape.r : 0;
  // A light's reach is a SPHERE, and this is a plan view of one plane through
  // it. What the level actually receives is the circle where that sphere cuts
  // the gameplay plane, which shrinks as the lamp is pulled toward the camera
  // and closes entirely once it is further off the plane than it reaches.
  //
  // Drawing that rather than the authored radius alone is the only feedback `z`
  // has: a light is invisible, so moving one through z changes nothing on the
  // canvas and nothing in the 2D overlay, and the field reads as doing nothing
  // at all until the 3D view is consulted.
  const planeReach = lightPlaneReach(l);
  ctx.beginPath();
  ctx.arc(l.pos.x, l.pos.y, planeReach, 0, Math.PI * 2);
  ctx.fillStyle = paint(hexToRgba(l.color, l.opacity));
  ctx.fill();
  if (selected) {
    ctx.strokeStyle = SELECT;
    ctx.lineWidth = worldLine * 5;
    ctx.stroke();
  }
  // Dashed, like every other volume the player passes through: a light is not
  // geometry and must never read as a wall in a screenshot.
  ctx.strokeStyle = l.color;
  ctx.lineWidth = worldLine * 1.5;
  ctx.setLineDash([6 * PX, 4 * PX]);
  ctx.stroke();
  ctx.setLineDash([]);
  // The authored reach itself, as a fainter outer ring, whenever the lamp is off
  // the plane and the two differ. Without it the ring would shrink as `z` is
  // typed and there would be nothing on screen still saying what `range` is.
  if (planeReach < range - 1e-6) {
    ctx.beginPath();
    ctx.arc(l.pos.x, l.pos.y, range, 0, Math.PI * 2);
    ctx.strokeStyle = l.color;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = worldLine;
    ctx.setLineDash([2 * PX, 6 * PX]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  if (l.light.kind === "spot" && planeReach > 0) {
    const aim = Math.atan2(l.light.dir.y, l.light.dir.x);
    const half = (l.light.angle * Math.PI) / 180;
    const range = planeReach;
    // The cone is a 3D one and this is a plan view of the gameplay plane, so
    // what is drawn is its section: correct wherever the aim lies in the plane,
    // and a spot aimed mostly at the camera (`aim z`) is legitimately a small
    // one here. The inspector carries the z; this carries the direction the
    // author is steering by eye.
    ctx.beginPath();
    for (const s of [-1, 1]) {
      ctx.moveTo(l.pos.x, l.pos.y);
      ctx.lineTo(l.pos.x + Math.cos(aim + s * half) * range, l.pos.y + Math.sin(aim + s * half) * range);
    }
    ctx.strokeStyle = l.color;
    ctx.lineWidth = worldLine;
    ctx.setLineDash([4 * PX, 4 * PX]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // The source burst. Solid, and the one part of a light drawn at full strength:
  // everything else about the gizmo is a faint volume, and without a hard mark
  // there is nothing to aim a click at.
  const r = Math.max(LIGHT_MARK_SIZE, worldLine * 4);
  ctx.strokeStyle = l.color;
  ctx.lineWidth = worldLine * 2;
  ctx.beginPath();
  for (let i = 0; i < LIGHT_MARK_RAYS; i++) {
    const a = (i * Math.PI * 2) / LIGHT_MARK_RAYS;
    ctx.moveTo(l.pos.x + Math.cos(a) * r * 0.4, l.pos.y + Math.sin(a) * r * 0.4);
    ctx.lineTo(l.pos.x + Math.cos(a) * r, l.pos.y + Math.sin(a) * r);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(l.pos.x, l.pos.y, r * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = l.color;
  ctx.fill();
}

// Half-size of the source burst in metres, and how many rays it has.
const LIGHT_MARK_SIZE = 0.18;
const LIGHT_MARK_RAYS = 8;

// What a click on a light has to land on: the source burst, and nothing else.
//
// The reach is a READOUT - it is as wide as the room the lamp lights, and on a
// level lit from inside that is most of the level. Picking by it made a lamp a
// transparent sheet over everything it lit: every click meant for a wall inside
// the pool selected the light instead, and two lamps whose pools overlapped made
// the geometry between them unreachable entirely.
//
// So the pick is the icon, which is the one part of the gizmo drawn at full
// strength precisely because there has to be something to aim at. It grows with
// the zoom exactly as the drawn burst does (`worldLine * 4`), so what you can
// hit is always what you can see.
export function lightPickRadius(worldLine: number): number {
  return Math.max(LIGHT_MARK_SIZE, worldLine * 4);
}

// How far a light reaches ON THE GAMEPLAY PLANE, in metres.
//
// The authored `range` is the radius of a sphere and the level is a plane
// through it, so the two are only the same for a lamp sitting exactly on the
// plane. A lamp `z` off it cuts a circle of `sqrt(range² - z²)` - and once it is
// further away than it reaches, it lights the plane not at all, which is a
// perfectly reachable authoring mistake and one nothing else would report.
export function lightPlaneReach(l: EdItem): number {
  const range = l.shape.kind === "circle" ? l.shape.r : 0;
  const z = Math.abs(l.light.z);
  return z >= range ? 0 : Math.sqrt(range * range - z * z);
}

// What a light does, for the screen-space label beside it. Only what was
// authored away from the defaults, so an ordinary lamp reads as `light` and a
// guttering shadow-casting spot says so.
export function lightLabel(l: EdItem): string {
  const parts: string[] = [l.light.kind];
  parts.push(`${Number(l.light.intensity.toFixed(1))}cd`);
  const px = (v: number) => Math.round(v * PIXELS_PER_METER);
  if (l.shape.kind === "circle") parts.push(`${px(l.shape.r)}reach`);
  if (l.light.z !== 0) {
    parts.push(`z${px(l.light.z)}`);
    // What that `z` costs, in the units the reach is authored in. A lamp off
    // the plane reaches less of it, and a lamp further off than it reaches
    // lights the level not at all - which is silent everywhere else.
    const plane = lightPlaneReach(l);
    parts.push(plane > 0 ? `${px(plane)}on plane` : "MISSES PLANE");
  }
  if (l.light.flicker > 0) parts.push(`flicker ${Number(l.light.flicker.toFixed(2))}`);
  if (l.light.castShadow) parts.push("shadows");
  return parts.join(" · ");
}

export function cameraRegionLabel(r: EdItem): string {
  const px = (v: number) => String(Math.round(v * PIXELS_PER_METER));
  const parts: string[] = [];
  if (r.shape.kind === "path") {
    // A path's defaults are shown rather than omitted: `range` and `lookahead`
    // ARE the tuning, so "not authored" and "authored at the default" have to
    // read the same way while an author is comparing two paths by eye.
    // A keyed field's path-level value is read nowhere, so it is not quoted
    // as if it were; the keys are on the nodes, and the label says how many.
    const nodeKeys = r.shape.keys;
    const keyed = (f: PathKeyField): boolean => nodeKeys.some((k) => k[f] !== null);
    parts.push(
      keyed("rangeX") || keyed("rangeY")
        ? "range keyed"
        : `range ${px(r.cam.rangeX ?? DEFAULT_PATH_RANGE_X)},${px(r.cam.rangeY ?? DEFAULT_PATH_RANGE_Y)}`,
    );
    const fallX = r.cam.falloffX ?? DEFAULT_PATH_FALLOFF_X;
    const fallY = r.cam.falloffY ?? DEFAULT_PATH_FALLOFF_Y;
    if (keyed("falloffX") || keyed("falloffY")) parts.push("falloff keyed");
    else if (fallX > 0 || fallY > 0) parts.push(`falloff ${px(fallX)},${px(fallY)}`);
    const leadKeyed = keyed("lookaheadX") || keyed("lookaheadY");
    const bufKeyed = keyed("lookaheadBufferX") || keyed("lookaheadBufferY");
    parts.push(
      `lead ${
        leadKeyed
          ? "keyed"
          : `${px(r.cam.lookaheadX ?? DEFAULT_PATH_LOOKAHEAD_X)},${px(r.cam.lookaheadY ?? DEFAULT_PATH_LOOKAHEAD_Y)}`
      } ±${
        bufKeyed
          ? "keyed"
          : `${px(r.cam.lookaheadBufferX ?? DEFAULT_PATH_LOOKAHEAD_BUFFER_X)},${px(r.cam.lookaheadBufferY ?? DEFAULT_PATH_LOOKAHEAD_BUFFER_Y)}`
      }`,
    );
    if (keyed("viewportScale")) parts.push("view keyed");
    else if (r.cam.viewportScale !== DEFAULT_VIEWPORT_SCALE) {
      parts.push(`view ×${Number(r.cam.viewportScale.toFixed(2))}`);
    }
    const keys = nodeKeys.filter(isKeyed).length;
    if (keys) parts.push(`${keys} key${keys === 1 ? "" : "s"}`);
    if (r.cam.blend !== null) parts.push(`${Number(r.cam.blend.toFixed(2))}s`);
    if (keyed("buffer")) parts.push("buf keyed");
    else if (r.cam.buffer !== null) parts.push(`buf ${px(r.cam.buffer)}`);
    if (r.cam.priority !== 0) parts.push(`p${r.cam.priority}`);
    return `path · ${parts.join(" · ")}`;
  }
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
// Metres between the direction arrowheads along an authored path, and how long
// each is. Direction is the design - the lookahead never reverses - so it has to
// be readable without selecting the path first.
const PATH_ARROW_SPACING = 1.5;
const PATH_ARROW_LENGTH = 0.22;

// A camera path: its corridor, the polyline itself, and the arrowheads that say
// which way it runs.
//
// Nothing is filled. A path that doubles back overlaps its own corridor, so an
// interior tint says more about the switchback than about the path - and unlike
// a region there is no volume for a fill to MEAN, which is the same reason
// `outlineOf` has nothing to answer for one.
function drawCameraPath(
  ctx: CanvasRenderingContext2D,
  item: EdItem,
  worldLine: number,
  selected: boolean,
): void {
  if (item.shape.kind !== "path") return;
  const shape = item.shape;
  // THE FLATTENED CURVE, not the node points: the handles are what shape the
  // route, and drawing the control polygon instead would draw something the
  // camera does not ride. Built as the RULE the game builds (`pathDataOf` is
  // the one mapping), so the polyline, the keys along it and every corridor
  // below are exactly what the controller tests.
  const rule = buildCameraRules([], [pathDataOf(item)])[0];
  if (rule?.kind !== "path") return;
  const world = rule.index.verts;
  // NOT through `paint`. That is the fill switch - it goes fully transparent in
  // the overlay view, where the 3D scene underneath is what shows the level -
  // and every mark here is a STROKE or a glyph on one, the same as a camera
  // region's dashed border. Run through it, the whole path vanished the moment
  // it was deselected in the view the editor opens in.
  const stroke = CAMERA_REGION_COLOR;

  // The corridor at the range: how far off the route the player may be while
  // the path still narrates it. Per axis - the ellipse with the range's
  // semi-axes swept along the route, so it is screen-shaped, and resolved
  // through the keys at every sample, so a range that widens along the route
  // is drawn widening - `pathCorridorSweepInto` owns the geometry, so what is
  // drawn is exactly the zone the controller tests.
  ctx.beginPath();
  pathCorridorSweepInto(ctx, rule.index, (s) => pathRangeAxes(pathParamsAt(rule, s)));
  ctx.strokeStyle = stroke;
  ctx.lineWidth = worldLine * 1.5;
  ctx.setLineDash([6 * PX, 4 * PX]);
  ctx.stroke();
  ctx.setLineDash([]);

  // ...and the far edge of the falloff band beyond it: across the band the
  // path's grip fades to nothing, which is a different statement from the
  // corridor and worth seeing while the range and falloff are being tuned
  // against each other.
  if (pathHasBand(rule)) {
    ctx.beginPath();
    pathCorridorSweepInto(ctx, rule.index, (s) => pathBandAxes(pathParamsAt(rule, s)));
    ctx.lineWidth = worldLine;
    ctx.setLineDash([3 * PX, 3 * PX]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // ...and the release boundary, when a buffer is authored. Finer dots and a
  // thinner line, as a region's buffer is drawn: it is the path's reach rather
  // than a second corridor. The buffer grows both semi-axes, which is exactly
  // how `pathRelease` tests it.
  if (item.cam.buffer !== null || shape.keys.some((k) => k.buffer !== null)) {
    ctx.beginPath();
    pathCorridorSweepInto(ctx, rule.index, (s) => pathReleaseAxes(pathParamsAt(rule, s)));
    ctx.lineWidth = worldLine;
    ctx.setLineDash([2 * PX, 5 * PX]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // The route itself, solid: the corridor is only how far off it the player may
  // stray, and this is the line being authored.
  ctx.beginPath();
  ctx.moveTo(world[0]!.x, world[0]!.y);
  for (const w of world.slice(1)) ctx.lineTo(w.x, w.y);
  if (selected) {
    ctx.strokeStyle = SELECT;
    ctx.lineWidth = worldLine * 5;
    ctx.stroke();
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = worldLine * 2.5;
  ctx.stroke();

  // A KEYED node wears a diamond, selected or not, so where the framing changes
  // along the route can be seen without clicking through every node. Larger
  // than the vertex square drawn over it when the path is selected, so it
  // still shows around the square's edges.
  ctx.fillStyle = stroke;
  shape.keys.forEach((k, i) => {
    const p = shape.verts[i];
    if (!p || !isKeyed(k)) return;
    const w = toWorld(item, p);
    const r = worldLine * PATH_KEY_DIAMOND_PX;
    ctx.beginPath();
    ctx.moveTo(w.x, w.y - r);
    ctx.lineTo(w.x + r, w.y);
    ctx.lineTo(w.x, w.y + r);
    ctx.lineTo(w.x - r, w.y);
    ctx.closePath();
    ctx.fill();
  });

  let carried = PATH_ARROW_SPACING / 2;
  for (let i = 0; i + 1 < world.length; i++) {
    const a = world[i]!;
    const b = world[i + 1]!;
    const len = a.distanceTo(b);
    if (len < 1e-9) continue;
    const dir = b.sub(a).div(len);
    for (let d = carried; d < len; d += PATH_ARROW_SPACING) {
      drawPathArrow(ctx, a.add(dir.mul(d)), dir);
    }
    // Carried across the joint so the spacing is arc length along the whole
    // path rather than restarting at every vertex - a run of short segments
    // would otherwise be solid arrowheads.
    carried = ((carried - len) % PATH_ARROW_SPACING + PATH_ARROW_SPACING) % PATH_ARROW_SPACING;
  }
}

// A filled triangle centred at `at`, pointing along the unit vector `dir`.
function drawPathArrow(ctx: CanvasRenderingContext2D, at: Vec2, dir: Vec2): void {
  const side = new Vec2(-dir.y, dir.x).mul(PATH_ARROW_LENGTH * 0.4);
  const tip = at.add(dir.mul(PATH_ARROW_LENGTH / 2));
  const back = at.sub(dir.mul(PATH_ARROW_LENGTH / 2));
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(back.x + side.x, back.y + side.y);
  ctx.lineTo(back.x - side.x, back.y - side.y);
  ctx.closePath();
  ctx.fill();
}

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

// A zigzag coil centred on `at` and running along `angle`, with a tick at each
// end: the glyph for a spring mounting. Sized in `worldLine` units like every
// other body mark, so it stays one thickness on screen at any zoom.
function drawCoil(
  ctx: CanvasRenderingContext2D,
  at: Vec2,
  angle: number,
  worldLine: number,
): void {
  const half = 7 * worldLine; // reach along the coil's own axis
  const amp = 3 * worldLine; // how far the zigzag swings across it
  const zigs = 6;
  const dir = new Vec2(Math.cos(angle), Math.sin(angle));
  const perp = new Vec2(-dir.y, dir.x);
  ctx.beginPath();
  for (let i = 0; i <= zigs; i++) {
    const t = -half + (2 * half * i) / zigs;
    // Flat at both ends and alternating in between: a coil with a lead-in,
    // rather than a triangle wave that starts mid-swing.
    const a = i === 0 || i === zigs ? 0 : (i % 2 === 0 ? -amp : amp);
    const p = at.add(dir.mul(t)).add(perp.mul(a));
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  // The end ticks, across the coil: what it is sprung BETWEEN.
  ctx.beginPath();
  for (const end of [-half, half]) {
    const c = at.add(dir.mul(end));
    ctx.moveTo(c.x - perp.x * amp, c.y - perp.y * amp);
    ctx.lineTo(c.x + perp.x * amp, c.y + perp.y * amp);
  }
  ctx.stroke();
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
  model: EdModel,
  visible: readonly EdItem[],
  all: readonly EdItem[],
  selectedIds: ReadonlySet<number>,
  worldLine: number,
): void {
  const bodies = new Set<number>();
  for (const b of visible) bodies.add(b.bodyId);
  for (const id of bodies) {
    const allMembers = bodyMembers(all, id);
    // How the built body is MOUNTED, from the collision object the body's
    // physics is written from: a pivot's axle or a spring's coil. Drawn for a
    // body of one as well - unlike the compound diamond, neither mounting is
    // visible on the canvas without a mark, and the two shapes look identical.
    const leadCollision = allMembers.find((m) => m.object === "collision");
    if (leadCollision && leadCollision.kind === "rigid" && leadCollision.pivot) {
      // An authored bearing draws where it was authored - the point the body
      // will actually swing about - and only an unauthored one falls back to
      // the centre of mass, which is what an absent point means at build.
      // `pivotAt` is in the body's frame, so it is resolved through the same
      // `bodyFrameOf` the save writes it against.
      const axle = ((): Vec2 => {
        if (!leadCollision.pivotAt) return bodyCentroid(allMembers);
        const f = bodyFrameOf(model, leadCollision.bodyId);
        return f.pos.add(leadCollision.pivotAt.rotated(f.rot));
      })();
      const ar = 6 * worldLine;
      ctx.strokeStyle = GROUP_MARK;
      ctx.lineWidth = worldLine * 1.5;
      ctx.beginPath();
      ctx.arc(axle.x, axle.y, ar, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(axle.x, axle.y, ar / 3, 0, Math.PI * 2);
      ctx.fillStyle = GROUP_MARK;
      ctx.fill();
    }
    // A spring body's mounting, always, and for the same reason the axle is
    // drawn: being spring-mounted is invisible on the geometry itself, so
    // without a mark a leaf and a crate are the same picture. A coil at the
    // centre of mass - the anchor the body is sprung about and the point the
    // spring force acts through - with its axis along whichever axes are
    // actually sprung, so a body that only bobs vertically LOOKS like one.
    if (leadCollision && leadCollision.kind === "rigid" && !leadCollision.pivot) {
      const sx = leadCollision.springFreqX > 0;
      const sy = leadCollision.springFreqY > 0;
      if (sx || sy) {
        const at = bodyCentroid(allMembers);
        ctx.strokeStyle = GROUP_MARK;
        ctx.lineWidth = worldLine * 1.5;
        // Both axes sprung: one diagonal coil rather than two crossed ones,
        // which at this size reads as a scribble.
        drawCoil(ctx, at, sx && sy ? Math.PI / 4 : sx ? 0 : Math.PI / 2, worldLine);
      }
    }
    if (allMembers.length < 2) continue;
    const members = bodyMembers(visible, id);
    const centre = bodyCentroid(bodyMembers(all, id));
    const selected = members.some((m) => selectedIds.has(m.id));
    ctx.strokeStyle = GROUP_MARK;
    if (selected) {
      const box = bodyBounds(members);
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

// A scripted mover's motion, which is the one thing about a level that is
// invisible on a still canvas: a swinging body and a plain wall are the same
// picture, and so are a platform and the lift it is about to become.
//
// Two marks, one per motion (see `LevelBodyData.swingAmp` and `movePath`):
//
//   - a PENDULUM gets a ring at its bearing, and the arc its body sweeps drawn
//     through the point of it that reaches furthest - which is the part a player
//     actually meets, and the part an author is placing when they pick an
//     amplitude;
//   - a TRAVELLING body gets its route as a polyline with a square at every
//     waypoint, an arrow along the first leg saying which way it sets off, and a
//     ring at the closing leg's midpoint when it is a loop.
//
// Drawn for every mover rather than only for the selected one - what a level
// does while it is running is a fact about the level, and hunting for it one
// click at a time is how a rhythm gets authored twice. The SELECTED body's
// waypoints are drawn as grabbable handles on top, in the selection colour, so
// what can be dragged is what looks draggable.
function drawMoverMarks(
  ctx: CanvasRenderingContext2D,
  model: EdModel,
  visible: readonly EdItem[],
  all: readonly EdItem[],
  selectedBodyIds: ReadonlySet<number>,
  worldLine: number,
): void {
  const bodies = new Set<number>();
  for (const b of visible) bodies.add(b.bodyId);
  for (const id of bodies) {
    const members = bodyMembers(all, id);
    const lead = members.find((m) => m.object === "collision");
    if (!lead || lead.kind !== "static") continue;
    const frame = bodyFrameOf(model, id);
    const picked = selectedBodyIds.has(id);

    if (lead.swingAmp !== 0 && lead.swingPeriod > 0) {
      const bearing = lead.pivotAt
        ? frame.pos.add(lead.pivotAt.rotated(frame.rot))
        : bodyCentroid(members);
      // The arc is drawn at the radius of whatever reaches furthest from the
      // bearing, which is the swept edge rather than a circle round the middle,
      // and centred on where the body actually HANGS - the direction from the
      // bearing to its centre of mass. Straight down is only that direction for
      // a body drawn hanging, and a level may perfectly well author one at an
      // angle.
      let reach = 0;
      for (const m of members) {
        if (m.object === "collision") reach = Math.max(reach, m.pos.sub(bearing).length());
      }
      const hang = bodyCentroid(members).sub(bearing);
      ctx.strokeStyle = MOVER_MARK;
      ctx.lineWidth = worldLine * 1.5;
      const ar = 6 * worldLine;
      ctx.beginPath();
      ctx.arc(bearing.x, bearing.y, ar, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(bearing.x, bearing.y, ar / 3, 0, Math.PI * 2);
      ctx.fillStyle = MOVER_MARK;
      ctx.fill();
      if (reach > 0) {
        const rest = hang.length() > 1e-9 ? Math.atan2(hang.y, hang.x) : Math.PI / 2;
        ctx.setLineDash([4 * PX, 4 * PX]);
        ctx.lineWidth = worldLine;
        ctx.beginPath();
        ctx.arc(bearing.x, bearing.y, reach, rest - lead.swingAmp, rest + lead.swingAmp);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (lead.movePath.length === 0) continue;
    const pts = routeWorldPoints(model, lead);
    ctx.strokeStyle = MOVER_MARK;
    ctx.lineWidth = worldLine * 1.5;
    ctx.setLineDash([6 * PX, 4 * PX]);
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    if (lead.moveClosed) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    // Which way it sets off, on the first leg - the only thing that separates a
    // lap from the same lap the other way round.
    const dir = pts[1]!.sub(pts[0]!);
    if (dir.length() > 1e-9) {
      const at = pts[0]!.add(dir.mul(0.5));
      const n = dir.normalized();
      const t = new Vec2(-n.y, n.x);
      const a = 5 * worldLine;
      ctx.beginPath();
      ctx.moveTo(at.x + n.x * a, at.y + n.y * a);
      ctx.lineTo(at.x - n.x * a + t.x * a * 0.7, at.y - n.y * a + t.y * a * 0.7);
      ctx.lineTo(at.x - n.x * a - t.x * a * 0.7, at.y - n.y * a - t.y * a * 0.7);
      ctx.closePath();
      ctx.fillStyle = MOVER_MARK;
      ctx.fill();
    }

    // The waypoints. Zero is the body itself and is drawn as a ring rather than
    // as a square, because it is the one point of the route that is not dragged
    // on its own - moving the body moves it, which is what makes the route ride
    // the thing it belongs to.
    const r = 4 * worldLine;
    ctx.lineWidth = worldLine * 1.5;
    ctx.strokeStyle = picked ? HANDLE : MOVER_MARK;
    ctx.beginPath();
    ctx.arc(pts[0]!.x, pts[0]!.y, r, 0, Math.PI * 2);
    ctx.stroke();
    for (const p of pts.slice(1)) {
      ctx.beginPath();
      ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
      if (picked) {
        ctx.fillStyle = HANDLE_FILL;
        ctx.fill();
      }
      ctx.stroke();
    }
    // ...and the midpoints, which insert one. Only on the selected body: they
    // are an affordance rather than information, and drawn on every mover in the
    // level they would be a second row of dots nobody may click.
    if (!picked) continue;
    ctx.strokeStyle = HANDLE;
    ctx.lineWidth = worldLine;
    for (const m of routeMidpoints(pts, lead.moveClosed)) {
      ctx.beginPath();
      ctx.arc(m.x, m.y, r * 0.6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// The midpoint of every leg a waypoint can be inserted into - the legs between
// consecutive waypoints, plus the closing leg home on a loop. Exported because
// the press handler picks the same points the canvas drew, and two lists of them
// would be two answers to "what is under the pointer".
export function routeMidpoints(pts: readonly Vec2[], closed: boolean): Vec2[] {
  const mids: Vec2[] = [];
  for (let i = 1; i < pts.length; i++) mids.push(pts[i - 1]!.add(pts[i]!).mul(0.5));
  if (closed && pts.length > 1) mids.push(pts[pts.length - 1]!.add(pts[0]!).mul(0.5));
  return mids;
}

// The objects of the selected BODY, outlined where they are - which is the only
// thing on the canvas that says what a body is made of while none of its objects
// is selected.
//
// Each piece is outlined on its own rather than as the body's union outline (the
// shape the selection halo takes), because that is the question this answers: how
// many objects there are and where each one is, which a union deliberately hides.
// The objects with no outline of their own get a ring at the mark a click has to
// land on, since a light's own circle is its reach and an anchor has no shape at
// all.
function drawBodyMembers(
  ctx: CanvasRenderingContext2D,
  items: readonly EdItem[],
  bodyIds: ReadonlySet<number>,
  visibleLayers: ReadonlySet<EdLayer>,
  worldLine: number,
  // A geometry object's outline is not drawn on this canvas at all while a scene
  // is under it (see the decoration pass), so neither is this ring round it -
  // the scene paints the body's objects instead (`Scene3D.setHighlight`).
  drawGeometry: boolean,
): void {
  if (!bodyIds.size) return;
  ctx.strokeStyle = BODY_MEMBER;
  ctx.lineWidth = worldLine * 3;
  for (const i of items) {
    if (!bodyIds.has(i.bodyId) || !visibleLayers.has(i.layer)) continue;
    if (i.object === "geometry" && !drawGeometry) continue;
    if (i.object === "light" || i.object === "anchor") {
      ctx.beginPath();
      ctx.arc(i.pos.x, i.pos.y, lightPickRadius(worldLine) * 1.6, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    pathBody(ctx, i);
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
  polyDraft: { kind: "poly" | "path"; verts: readonly Vec2[]; cursor: Vec2 } | null = null,
  // Chains carry their own selection (see `selectedChainIds` in editor.ts).
  selectedChainIds: ReadonlySet<number> = new Set<number>(),
  // A chain being strung out: where it started and where the pointer is, plus
  // whether it is currently over a body it could land on - so the gesture says
  // in advance whether releasing will make a chain or drop it.
  chainDraft: { from: Vec2; to: Vec2; valid: boolean } | null = null,
  // Vines carry their own selection too, and their own draft. "hang" is a vine
  // being pulled out DOWNWARD from the body it is anchored to - an anchor and a
  // length rather than two points; "attach" is a tip being Shift-dragged toward
  // a second anchor, which reads like a chain draft: where it started, where
  // the pointer is, and whether releasing there would attach.
  selectedVineIds: ReadonlySet<number> = new Set<number>(),
  vineDraft:
    | { kind: "hang"; from: Vec2; length: number; valid: boolean }
    | { kind: "attach"; from: Vec2; to: Vec2; valid: boolean }
    | null = null,
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
  // The bodies selected as BODIES (see `selectedBodyIds` in editor.ts). Their
  // objects are outlined rather than haloed: the body is what is selected, and
  // nothing an edit reaches may wear the selection colour.
  selectedBodyIds: ReadonlySet<number> = new Set<number>(),
  // Which of the selected shape's VERTICES are picked out (see `selectedVerts`
  // in editor.ts). They are drawn as filled squares against the hollow ones, so
  // what an edit applies to is legible at the corner itself rather than only in
  // the panel - the same thing the selection halo says about a whole object.
  selectedVerts: ReadonlySet<number> = new Set<number>(),
  // Where sprung bodies actually REST (see `settledGhosts` in model.ts):
  // dashed outlines at the settled pose, so a leaf's droop and a branch's hang
  // are visible while the authored pose is what is being edited. Cached by the
  // caller per model revision - the list is a full level build.
  settleGhosts: readonly SettleGhost[] = [],
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
  // Decoration first, exactly as the game draws it: a non-colliding shape is
  // under everything, whatever its position in the list, so nothing the player
  // can touch is ever hidden behind it.
  // Back to front by the same depth the game draws (and a click selects) by, so
  // the panel on top on screen is the panel on top everywhere. `sort` is stable,
  // so decoration at one depth keeps its authored order.
  // Whether an object's BODY collides, which decides both how deep it is drawn
  // and whether its fill is drawn here at all. Computed once for the model
  // rather than per item, since this covers the whole geometry layer.
  const collidingBodies = collidingBodyIds(model.items);
  const depth = (i: EdItem) => itemDepth(i, collidingBodies.has(i.bodyId));
  const decor = (
    visibleLayers.has("scene")
      ? model.items.filter((i) => i.object === "geometry")
      : []
  ).sort((a, b) => depth(a) - depth(b));
  // A GEOMETRY OBJECT HAS NO OUTLINE HERE ONCE THERE IS A SCENE UNDER IT.
  //
  // What this loop draws is a rectangle (or circle, or loop) on the gameplay
  // plane, and that is not what a geometry object IS: a primitive is a solid
  // extruded through z and a mesh is a prop whose silhouette the outline never
  // described at all, so the box round a lamp bracket says the bracket is a
  // metre wide and the box round a pipe says it is where the pipe is not. In the
  // 2D view the outline is all there is and it stays; in a 3D view the model is
  // on screen, it is what a click lands on (see `raycastItems`), and drawing a
  // second, wrong shape over it is the editor stating something the level does
  // not contain. Selection is said on the model instead (`Scene3D.setHighlight`).
  for (const g of layers === "fill" ? decor : []) {
    // FILLED ONLY WHERE NOTHING ELSE FILLS IT, which is the rule the game's 2D
    // view is drawn under (`collectDecor`): a body that collides has a primitive
    // per collision shape, stating the same outline in the same place, and this
    // canvas already fills that outline as the body. Painting it twice darkens
    // every wall in the editor by its own opacity - and shows the author a level
    // that is not what plays.
    //
    // The dashed teal edge below is drawn either way, so the object is still
    // visible, still clickable and still says where its 3D form is: one that has
    // been resized or moved off its collision shape reads as exactly that, an
    // outline with no fill of its own standing away from the solid.
    const paintedByBody = collidingBodies.has(g.bodyId) && depth(g) === 0;
    if (!paintedByBody) {
      fillDecor(ctx, g.pos, g.rot, outlineOf(g), paint(hexToRgba(g.color, g.opacity)));
    }
    if (selectedIds.has(g.id)) {
      pathBody(ctx, g);
      ctx.strokeStyle = SELECT;
      ctx.lineWidth = worldLine * 5;
      ctx.stroke();
    }
    pathBody(ctx, g);
    ctx.strokeStyle = DECOR_EDGE;
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
  // A camera PATH is excluded: this pass fills and strokes a closed outline, and
  // an open polyline has none - `outlineOf` can only answer its bounding box,
  // which is a rectangle that is not the thing. It is drawn by `drawCameraPath`
  // in the camera pass instead. Camera REGIONS and notes stay in, because they
  // are closed shapes and this is where their fill has always come from.
  const geometry = model.items.filter(
    (i) => i.object === "collision" && i.shape.kind !== "path",
  );
  const ordered = visibleLayers.has("scene")
    ? [...geometry].sort((a, b) => Number(!a.passable) - Number(!b.passable))
    : [];
  // Compound bodies draw as one object rather than as their pieces - union fill,
  // and a border only where a piece is not covered by a sibling. Drawn piece by
  // piece instead, the overlaps fill twice (a darker patch) and the joins get a
  // border each (a crack across a solid wall), neither of which is in the level.
  // Hook-only bodies keep the per-shape path: their fill is a grate lattice
  // punched out of each piece, which has no union form.
  const drawnAsBody = new Set<number>();
  for (const body of ordered) {
    if (body.passable || drawnAsBody.has(body.id)) continue;
    const members = bodyMembers(ordered, body.bodyId).filter((m) => !m.passable);
    if (members.length < 2) continue;
    for (const m of members) drawnAsBody.add(m.id);
    const union = unionPath(members);
    ctx.fillStyle = paint(hexToRgba(body.color, body.opacity));
    ctx.fill(union);
    // THE HALO IS ROUND WHAT IS SELECTED, not round the body it is in. Alt+click
    // picks one piece of a compound body out precisely so that piece can be
    // edited on its own, and haloing the whole body says the edit applies to all
    // of it - which for a numeric field or a delete is exactly what it would not.
    //
    // Clipped against the SELECTED pieces rather than against every member, so
    // the rule holds at both ends: one piece selected shows its own full outline,
    // seam edge included, because that outline is what the piece IS; the whole
    // body selected shows the body's outline with no seams drawn across it,
    // which is the same answer the border below gives.
    const haloed = members.filter((m) => selectedIds.has(m.id));
    if (haloed.length) {
      strokeCompoundOutline(ctx, haloed, () => {
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
    if (drawnAsBody.has(body.id)) continue;
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
    } else if (body.kind === "water") {
      fillWaterArea(
        ctx,
        body.pos,
        body.rot,
        outlineOf(body),
        body.flow,
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
    } else if (body.passable) {
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
    } else if (body.passable) {
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
  // cannot otherwise show it at all. Only `mesh` is marked, since that is the
  // one kind whose outline is NOT what the player sees: a prop stands in for it.
  // A primitive is drawn as exactly the shape on screen, so a badge on it would
  // be a mark on almost every object saying nothing.
  // ...and only where the prop is NOT drawn. In a 3D view the prop itself is on
  // screen, so a badge saying "a prop is drawn here" is a mark pointing at the
  // thing it is standing on.
  const badged =
    layers === "fill" ? [...(visibleLayers.has("scene") ? geometry : []), ...decor] : [];
  for (const body of badged) {
    const kind = body.visual.kind;
    if (kind !== "mesh") continue;
    const r = 6 * PX;
    ctx.lineWidth = worldLine * 1.5;
    ctx.strokeStyle = VISUAL_BADGE;
    ctx.beginPath();
    {
      // A cube seen in three-quarter: the mark for "a prop is drawn here".
      ctx.rect(body.pos.x - r, body.pos.y - r, r * 2, r * 2);
      ctx.moveTo(body.pos.x - r, body.pos.y - r);
      ctx.lineTo(body.pos.x - r * 0.4, body.pos.y - r * 1.6);
      ctx.lineTo(body.pos.x + r * 1.6, body.pos.y - r * 1.6);
      ctx.lineTo(body.pos.x + r, body.pos.y - r);
      ctx.moveTo(body.pos.x + r, body.pos.y + r);
      ctx.lineTo(body.pos.x + r * 1.6, body.pos.y + r * 0.4);
      ctx.lineTo(body.pos.x + r * 1.6, body.pos.y - r * 1.6);
    }
    ctx.stroke();
  }

  // Compound-body marks, over the geometry they describe. A group is one body,
  // and nothing about the drawn shapes says so on their own - they are simply
  // several shapes touching - so the marks are what make the seam rule visible
  // while a level is being laid out.
  //
  // Decoration is in the same pass, spokes and hull included: a panel welded
  // into a body rides it in play, and the spoke reaching down to a backdrop is
  // the only thing on screen that says so. Only the VISIBLE members are marked,
  // so hiding a layer really does take it out of the picture; the diamond stays
  // put whatever is hidden, since it is the shapes' centre of mass alone.
  const markable = [...(visibleLayers.has("scene") ? geometry : []), ...decor];
  drawGroupMarks(ctx, model, markable, model.items, selectedIds, worldLine);

  // ...and how the level DRIVES a body: a pendulum's arc and a platform's route.
  drawMoverMarks(ctx, model, markable, model.items, selectedBodyIds, worldLine);

  // Where a sprung body actually rests, as a dashed outline of its collision
  // shapes at the settled pose. The authored outline stays what is drawn and
  // edited - it is the spring's anchor and the torsion spring's rest angle -
  // and the ghost is what says where the body will stand when the level opens,
  // which nothing else on this canvas can (the build spawns bodies settled, so
  // in a 3D view the scene below already stands there; this is the 2D view's
  // only account of it, and in a 3D view it ties the drawn model back to the
  // outline it belongs to).
  if (visibleLayers.has("scene") && settleGhosts.length) {
    ctx.save();
    ctx.strokeStyle = GROUP_MARK;
    ctx.lineWidth = worldLine * 1.5;
    ctx.setLineDash([6 * worldLine, 4 * worldLine]);
    for (const g of settleGhosts) {
      for (const m of bodyMembers(model.items, g.bodyId)) {
        if (m.object !== "collision") continue;
        const pos = g.about.add(m.pos.sub(g.about).rotated(g.drot)).add(g.dpos);
        ctx.beginPath();
        pathOutline(ctx, pos, m.rot + g.drot, outlineOf(m));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Chains over the bodies they hold. Drawn STRAIGHT, because that is what the
  // solver renders: a chain's span is a straight line between wrap nodes, and
  // drawing a guessed sag here would be a drawing of something the level does
  // not contain.
  if (visibleLayers.has("scene")) {
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

  // Vines, drawn at their straight-down REST POSE for the same reason a chain is
  // drawn straight: where a vine actually hangs is the solver's answer, and a
  // guess at it would be a drawing of something the level does not contain.
  // Solid rather than dashed - unlike a chain, a vine IS a run of bodies the
  // hook can catch, so it is not a thing that is only there to look at.
  //
  // The CORD is drawn here only with the fills, because with a scene underneath
  // the scene draws the vine itself (`render3d/vineVisual.ts`) and this would be
  // the same cord painted flat over the top of it. What the overlay keeps in
  // both is the anchor mark and the selection, which are editor chrome.
  if (visibleLayers.has("scene")) {
    const tracePath = (path: readonly Vec2[]): void => {
      ctx.beginPath();
      ctx.moveTo(path[0]!.x, path[0]!.y);
      for (let i = 1; i < path.length; i++) ctx.lineTo(path[i]!.x, path[i]!.y);
      ctx.stroke();
    };
    for (const v of model.vines) {
      // Straight down for a hanging vine, the resting catenary for a span (see
      // `vineRestPath`).
      const path = vineRestPath(model, v);
      if (!path) continue;
      if (selectedVineIds.has(v.id)) {
        ctx.strokeStyle = SELECT;
        ctx.lineWidth = worldLine * 6;
        tracePath(path);
      }
      const color = v.color ?? VINE_DEFAULT_COLOR;
      if (layers === "fill") {
        ctx.strokeStyle = color;
        ctx.lineWidth = worldLine * 3;
        tracePath(path);
      }
      // An anchor mark at each bolted end: one for a hanging vine, both for a
      // span.
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(path[0]!.x, path[0]!.y, CHAIN_ANCHOR_R_PX * worldLine, 0, Math.PI * 2);
      ctx.fill();
      if (v.anchor2 !== null) {
        const end = path[path.length - 1]!;
        ctx.beginPath();
        ctx.arc(end.x, end.y, CHAIN_ANCHOR_R_PX * worldLine, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // The vine being pulled out - or the tip being carried toward a second
  // anchor. Dashed until releasing would build (or attach) something, so the
  // gesture says in advance what letting go will do.
  if (vineDraft) {
    ctx.strokeStyle = vineDraft.valid ? VINE_DEFAULT_COLOR : SELECT;
    ctx.lineWidth = worldLine * 3;
    if (!vineDraft.valid) ctx.setLineDash([6 * PX, 4 * PX]);
    ctx.beginPath();
    ctx.moveTo(vineDraft.from.x, vineDraft.from.y);
    if (vineDraft.kind === "hang") {
      ctx.lineTo(vineDraft.from.x, vineDraft.from.y + vineDraft.length);
    } else {
      ctx.lineTo(vineDraft.to.x, vineDraft.to.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
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
    if (r.shape.kind === "path") {
      drawCameraPath(ctx, r, worldLine, selectedIds.has(r.id));
      continue;
    }
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

  // Lights above the geometry they light, for the reason camera regions are:
  // they are a statement ABOUT the scene rather than part of it, and a lamp
  // hidden behind the wall it is mounted on could not be found to be clicked.
  const lights = visibleLayers.has("scene")
    ? model.items.filter((i) => i.object === "light")
    : [];
  for (const l of lights) {
    drawLightGizmo(ctx, l, worldLine, selectedIds.has(l.id), paint);
  }

  // Over every object it marks - a body's pieces are drawn in several passes and
  // an outline under one of them would be half hidden - and under the handles,
  // which are still the topmost thing on the canvas.
  drawBodyMembers(ctx, model.items, selectedBodyIds, visibleLayers, worldLine, layers === "fill");

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
    const open = polyDraft.kind === "path";
    // The draft is drawn in the warning colour exactly when the loop it would
    // close is not a shape. Concave is not that - a dented outline is a shape
    // and is what the tool is for - so this fires only on a loop that crosses
    // itself. A PATH is never warned about: an open run has no loop to close,
    // and crossing itself is what a switchback is.
    const crossed = !open && v.length >= 3 && !isSimpleLoop([...v, polyDraft.cursor]);
    const draftColor = crossed ? DRAFT_CROSSED : SELECT;
    ctx.strokeStyle = draftColor;
    ctx.lineWidth = worldLine * 2;
    ctx.beginPath();
    v.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
    ctx.stroke();
    ctx.setLineDash([6 * PX, 4 * PX]);
    ctx.beginPath();
    ctx.moveTo(v[v.length - 1]!.x, v[v.length - 1]!.y);
    ctx.lineTo(polyDraft.cursor.x, polyDraft.cursor.y);
    // The run back to the first vertex is the CLOSING edge, which a path does
    // not have: it ends where the last click was.
    if (!open && v.length >= 2) ctx.lineTo(v[0]!.x, v[0]!.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // A dot per placed vertex, and a ring on the first one: clicking it is what
    // closes the loop, so it has to be findable.
    ctx.fillStyle = draftColor;
    for (const q of v) {
      ctx.beginPath();
      ctx.arc(q.x, q.y, worldLine * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!open && v.length >= 3) {
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
  // ...and the lights', for the same reason: what a lamp does is numbers, and a
  // world-space label would shrink to nothing as the level is zoomed out. Placed
  // beside the source rather than at the edge of the reach, which is where the
  // thing being labelled actually is.
  for (const l of lights) {
    const anchor = worldToScreen(cam, l.pos);
    ctx.font = "11px monospace";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = l.color;
    ctx.fillText(lightLabel(l), anchor.x + 8, anchor.y - 6);
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
  // A selected vine is edited by its anchor, which is where it hangs from, and
  // by its free end, which is its length.
  for (const v of model.vines) {
    if (!selectedVineIds.has(v.id)) continue;
    const hs = computeVineHandles(cam, model, v);
    if (!hs) continue;
    circleHandle(ctx, hs.top);
    circleHandle(ctx, hs.tip);
  }
  // A whole compound body turns as one, so it gets a rotate knob where a lone
  // shape does - placed by the group's extent, with the centre of mass it turns
  // about marked at the other end of the stalk.
  const groupSel =
    selection.length > 1 &&
    selection[0]!.bodyId !== null &&
    selection.every((b) => b.bodyId === selection[0]!.bodyId) &&
    bodyMembers(model.items, selection[0]!.bodyId!).length === selection.length
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
  const selected =
    selection.length === 1 && hasPlaneHandles(selection[0]!, layers) ? selection[0]! : null;
  // The cut, before the handles so a vertex handle is never hidden under it: an
  // authored concave outline is one object here and several convex pieces in the
  // simulation, and these dashed lines are where it divides. Worth drawing
  // because the pieces are what the physics is - the rope wraps their shared
  // corners and refuses their seams - and because a count in the panel says how
  // many there are without saying where a cut has landed across a face.
  if (selected && selected.shape.kind === "poly" && !polyMustBeConvex(selected)) {
    const seams = decomposeSeams(selected.shape.verts);
    if (seams.length) {
      ctx.strokeStyle = SEAM;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (const [a, b] of seams) {
        const p = worldToScreen(cam, toWorld(selected, a));
        const q = worldToScreen(cam, toWorld(selected, b));
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

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
    // Tangent grips BEFORE the vertex squares, so a handle pulled back onto its
    // own node sits under the node rather than over it: the vertex is the thing
    // you reach for more often, and the pick agrees (it tests verts first).
    if (hs.pathHandles && hs.verts) {
      ctx.strokeStyle = HANDLE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const h of hs.pathHandles) {
        const v = hs.verts[h.vert];
        if (!v) continue;
        ctx.moveTo(v.x, v.y);
        ctx.lineTo(h.pos.x, h.pos.y);
      }
      ctx.stroke();
      for (const h of hs.pathHandles) tangentHandle(ctx, h.pos);
    }
    if (hs.verts) {
      for (let i = 0; i < hs.verts.length; i++) {
        if (selectedVerts.has(i)) filledSquare(ctx, hs.verts[i]!);
        else square(ctx, hs.verts[i]!);
      }
    }
    if (hs.vertMids) for (const m of hs.vertMids) midHandle(ctx, m);
    // An arrow's endpoints are round, so they read as "drag me somewhere"
    // rather than as the corners of a box.
    if (hs.ends) for (const e of hs.ends) circleHandle(ctx, e);
    if (hs.depth) drawDepthHandle(ctx, hs.depth, depthOf(selected));
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
