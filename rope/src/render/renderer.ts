// Canvas renderer. Draws the world in the terminal-ish palette; the C# code drew
// via Godot's scene graph and Debug canvas overlay.

import { Vec2 } from "../engine/vec2";
import type { ShapeTransform } from "../engine/shapes";
import {
  AnimatableBody2D,
  Area2D,
  ForceArea,
  RigidBody2D,
  StaticBody2D,
  VineLink,
  WaterArea,
  type CollisionObject2D,
  type CollisionShape2D,
} from "../engine/body";
import { Debug } from "../engine/debug";
import { PIXELS_PER_METER, PX } from "../engine/units";
import type { SparkSystem } from "./sparks";
import { Player } from "../classes/player";
import { BallPlayer } from "../classes/ballPlayer";
import { BallHook } from "../classes/ballHook";
import { Hook } from "../classes/hook";
import { KillZone } from "../classes/killZone";
import type { Level } from "../level/level";
import type { BallLevel } from "../level/ballLevel";
import type { SceneChain } from "../level/chains";
import type { Camera } from "./camera";
import type { ViewTransform } from "./viewport";
import type { HeldCamera } from "./cameraController";
import { CHAIN_LINK_LEN, CHAIN_LINK_W, trimPathStart, walkChain } from "./chainMetrics";
import { chainEndFacing, MANACLE_BAND, MANACLE_RADIUS } from "../lib/manacle";
import { drawTrainingGrid } from "./trainingGrid";
import { drawDecor } from "./decor";
import { drawVines } from "./vines";
import { fillAnchor, fillForceArea, fillKillZone, fillWaterArea } from "./areaFill";
import {
  outlineHalfExtents,
  outlineOfShape,
  pathOutline,
  pathOutlineInto,
  pathOutlineIntoGrown,
} from "./shapePath";
import { hexToRgba, shade } from "./color";
import { drawDebugOverlay } from "./debugOverlay";
import {
  drawPlayerRigBack,
  drawPlayerRigFront,
  updatePlayerRig,
} from "./playerRig";

const GEOMETRY_FILL = "#2a2f3d";
const GEOMETRY_STROKE = "#3c445c";
const DYNAMIC_FILL = "#5c6a7a";
const MOVER_FILL = "#3d4a45";
const PLAYER = "#65bddb";
const HOOK = "#f4a460";
// Ball & chain palette: rusty black cast iron — warm near-black base, rust
// browns for wear, matte throughout (no bright steel).
const CANNONBALL = "#3a424b"; // steel body (shaded side)
const CANNONBALL_HI = "#8b939d"; // metallic sheen
const CHAIN = "#767e88"; // steel — broad (lit) link
const CHAIN_DARK = "#4e555e"; // shadowed / narrow link
const MANACLE = "#7c848e"; // steel cuff band
const MANACLE_DARK = "#454c55"; // lock housing / hinge shadow
const KILLZONE = "rgba(220,60,80,0.35)";
const IMPERMEABLE_EDGE = "#9db8c6"; // hook-proof surfaces: dashed steel border
const ANCHOR_FILL = "rgba(122,140,155,0.38)"; // hook-only scenery with no authored colour
const FORCE_FILL = "rgba(101,189,219,0.16)"; // force areas with no authored colour
// Water with no authored colour: sewer green, dark and murky rather than the
// force area's clean blue, and opaque enough that what is under it is dimmed.
const WATER_FILL = "rgba(58,94,74,0.55)";
// Ball & chain aim reticle: the OS cursor is hidden there, so this white ring is
// the cursor. World-sized (not fixed pixels) so it keeps its size relative to
// the ball and its reach at any zoom. The thin dark edge keeps it legible
// against the pale grid backdrop.
const RETICLE = "#ffffff";
const RETICLE_EDGE = "#12161d";
const RETICLE_RADIUS = 5 * PX;

function pathShape(ctx: CanvasRenderingContext2D, t: ShapeTransform): void {
  ctx.beginPath();
  pathOutline(ctx, t.globalPosition, t.globalRotation, outlineOfShape(t.shape));
}

// `alpha` is the render interpolation factor (see CollisionObject2D.renderShape):
// every body is drawn between its previous and current sim transform, so motion
// is smooth on a display faster than the 60 Hz simulation.
function drawBody(ctx: CanvasRenderingContext2D, body: CollisionObject2D, alpha: number): void {
  if (!body.hasShape()) return;
  const t = body.renderShape(alpha);
  // The avatars are drawn from their primary shape alone and return below: the
  // ball's auxiliary rim circle is its mounting loop, drawn as a loop by
  // `renderBall` rather than as a second cannonball. Level geometry falls
  // through to the compound loop at the end, which draws every piece.
  if (body instanceof Player) {
    pathShape(ctx, t);
    ctx.fillStyle = PLAYER;
    ctx.fill();
    return;
  }
  if (body instanceof Hook || body instanceof BallHook) {
    pathShape(ctx, t);
    ctx.fillStyle = HOOK;
    ctx.fill();
    return;
  }
  if (body instanceof BallPlayer) {
    const c = t.globalPosition;
    const r = body.radius;
    // Cast-iron cannonball: near-black body, subtle off-centre highlight for sheen.
    pathShape(ctx, t);
    ctx.fillStyle = CANNONBALL;
    ctx.fill();
    const g = ctx.createRadialGradient(
      c.x - r * 0.35,
      c.y - r * 0.35,
      r * 0.1,
      c.x,
      c.y,
      r,
    );
    g.addColorStop(0, CANNONBALL_HI);
    g.addColorStop(1, CANNONBALL);
    ctx.fillStyle = g;
    ctx.fill();
    return;
  }
  // Authored level geometry: every shape the body carries, so a compound body
  // (several convex pieces on one transform) draws as all of its pieces rather
  // than only the primary one.
  const shapes = body.renderShapes(alpha);
  // A compound body is ONE object, and drawing it piece by piece says otherwise:
  // the overlaps fill twice and read as a darker patch, and the joins get a
  // border each and read as cracks across a solid wall. So its pieces are filled
  // as a union and outlined only where they are not covered by a sibling - which
  // is exactly the body's real outline. Areas and hook-only scenery stay
  // per-shape: their fill is a glyph lattice punched out of each piece, and a
  // lattice has no union form.
  if (shapes.length > 1 && !(body instanceof Area2D) && !body.passable) {
    drawCompoundGeometry(ctx, body, shapes);
    return;
  }
  const pieces = body.getShapes();
  shapes.forEach((s, i) => drawGeometryShape(ctx, body, s, pieces[i]));
}

// How a body's geometry is painted: the same choices `drawGeometryShape` makes,
// pulled out so the compound path cannot drift from the single-shape one.
function geometryStyle(
  body: CollisionObject2D,
  // The PIECE being drawn, when there is one: hook-proof is a property of the
  // surface, so one body may draw a dashed steel edge on the face that repels
  // the hook and its ordinary border on the ledge that does not.
  piece?: CollisionShape2D,
): { fill: string | null; stroke: string; width: number; dash: number[] } {
  if (piece?.impermeable) {
    return {
      fill: body.fillColor ? hexToRgba(body.fillColor, body.fillOpacity) : null,
      stroke: IMPERMEABLE_EDGE,
      width: 2 * PX,
      dash: [5 * PX, 3 * PX],
    };
  }
  if (body.fillColor) {
    return {
      fill: hexToRgba(body.fillColor, body.fillOpacity),
      stroke: body.fillColor,
      width: PX,
      dash: [],
    };
  }
  const fill =
    body instanceof RigidBody2D
      ? DYNAMIC_FILL
      : body instanceof AnimatableBody2D
        ? MOVER_FILL
        : GEOMETRY_FILL;
  return { fill, stroke: GEOMETRY_STROKE, width: PX, dash: [] };
}

function unionPath(shapes: readonly ShapeTransform[]): Path2D {
  const p = new Path2D();
  for (const s of shapes) {
    pathOutlineInto(p, s.globalPosition, s.globalRotation, outlineOfShape(s.shape));
  }
  return p;
}

// A world box comfortably containing `shapes` - the outer ring of an even-odd
// "everything outside this shape" clip. Only ever used with a stroke a pixel or
// two wide, so a metre of margin is generous.
function shapesBounds(shapes: readonly ShapeTransform[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of shapes) {
    const h = outlineHalfExtents(outlineOfShape(s.shape));
    const r = Math.hypot(h.x, h.y); // rotation-proof: the enclosing disc
    minX = Math.min(minX, s.globalPosition.x - r);
    minY = Math.min(minY, s.globalPosition.y - r);
    maxX = Math.max(maxX, s.globalPosition.x + r);
    maxY = Math.max(maxY, s.globalPosition.y + r);
  }
  const pad = 1;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

function drawCompoundGeometry(
  ctx: CanvasRenderingContext2D,
  body: CollisionObject2D,
  shapes: readonly ShapeTransform[],
): void {
  const style = geometryStyle(body);
  // Filled as one path with the nonzero rule, so overlapping pieces contribute
  // one layer of the authored opacity rather than one each.
  if (style.fill) {
    ctx.fillStyle = style.fill;
    ctx.fill(unionPath(shapes));
  }
  const box = shapesBounds(shapes);
  const pieces = body.getShapes();
  for (let i = 0; i < shapes.length; i++) {
    // Per piece, because hook-proof is: `renderShapes` returns the mounted
    // shapes in order, so piece `i` is the transform's own.
    const edge = geometryStyle(body, pieces[i]);
    ctx.strokeStyle = edge.stroke;
    ctx.lineWidth = edge.width;
    ctx.setLineDash(edge.dash);
    ctx.save();
    // Clip away each sibling in turn. Clips intersect, so after the loop what is
    // left is "outside every other piece" - which is where this piece's edge is
    // a real edge of the body rather than an interior seam. One combined
    // even-odd clip would not do: a point inside two siblings crosses three
    // rings and comes out odd, i.e. wrongly kept.
    //
    // Each sibling is grown by A LINE WIDTH first. Pieces that overlap hide each
    // other's seam strokes either way; pieces that merely ABUT - two decomposed
    // pieces of one concave outline, or two grid-snapped rects sharing a face -
    // put the shared edge exactly on the boundary, where an ungrown clip keeps
    // the outer half of each piece's stroke and draws a hairline crack up the
    // middle of a solid wall.
    //
    // A full width rather than the half a stroke actually reaches: at exactly
    // half, the clip boundary lands on the outermost row of stroke pixels and
    // antialiasing leaves a fraction of it - the crack goes from solid to faint
    // rather than away. What the extra width costs is up to a stroke of a REAL
    // edge, at a point where a sibling is already touching it.
    const grow = edge.width;
    for (let j = 0; j < shapes.length; j++) {
      if (i === j) continue;
      const outside = new Path2D();
      outside.rect(box.x, box.y, box.w, box.h);
      const s = shapes[j]!;
      pathOutlineIntoGrown(outside, s.globalPosition, s.globalRotation, outlineOfShape(s.shape), grow);
      ctx.clip(outside, "evenodd");
    }
    const own = new Path2D();
    const s = shapes[i]!;
    pathOutlineInto(own, s.globalPosition, s.globalRotation, outlineOfShape(s.shape));
    ctx.stroke(own);
    ctx.restore();
  }
  ctx.setLineDash([]);
}

// One piece of level geometry, drawn in the style its body's kind asks for.
function drawGeometryShape(
  ctx: CanvasRenderingContext2D,
  body: CollisionObject2D,
  t: ShapeTransform,
  piece?: CollisionShape2D,
): void {
  // Impermeable (hook-proof) surfaces: authored fill, but a dashed steel border
  // instead of the plain one so they read as chain-repelling — it's clear why
  // the hook bounces off them rather than anchoring.
  if (piece?.impermeable) {
    pathShape(ctx, t);
    if (body.fillColor) {
      ctx.fillStyle = hexToRgba(body.fillColor, body.fillOpacity);
      ctx.fill();
    }
    ctx.strokeStyle = IMPERMEABLE_EDGE;
    ctx.lineWidth = 2 * PX;
    ctx.setLineDash([5 * PX, 3 * PX]);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  // Hook-only geometry (a background grate, a girder, a leaf on a stem): the
  // hook attaches to it, but the avatar and the rope pass straight through.
  // Punched with a grate mesh — the backdrop shows through the holes — and given
  // a dotted edge rather than a solid one, so nothing about it reads as
  // standable. `render` draws these first, behind the solid geometry they sit
  // among.
  if (body.passable) {
    const fill = body.fillColor ? hexToRgba(body.fillColor, body.fillOpacity) : ANCHOR_FILL;
    fillAnchor(ctx, t.globalPosition, t.globalRotation, outlineOfShape(t.shape), fill);
    pathShape(ctx, t);
    ctx.strokeStyle = body.fillColor ?? IMPERMEABLE_EDGE;
    ctx.lineWidth = PX;
    ctx.setLineDash([PX, 2 * PX]);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  // Force areas: authored fill (or a translucent blue default) with the flow
  // arrows punched out of it. Checked before the generic authored branch so an
  // area that was given a colour still gets its arrows.
  if (body instanceof ForceArea) {
    fillForceArea(
      ctx,
      t.globalPosition,
      t.globalRotation,
      outlineOfShape(t.shape),
      body.magnitude,
      body.fillColor ? hexToRgba(body.fillColor, body.fillOpacity) : FORCE_FILL,
    );
    return;
  }

  // Water: authored fill (or a murky green default) with the flow streaks
  // punched out of it, in BOTH renderers.
  //
  // There was a 3D water renderer that drew it as a real volume, and while it
  // existed the overlay stood down for water alone. It is gone, so water is back
  // to being an area like every other one - if it is ever drawn as a volume
  // again, this is the other half of that change.
  if (body instanceof WaterArea) {
    fillWaterArea(
      ctx,
      t.globalPosition,
      t.globalRotation,
      outlineOfShape(t.shape),
      body.flow,
      body.fillColor ? hexToRgba(body.fillColor, body.fillOpacity) : WATER_FILL,
    );
    return;
  }

  // Killzones: authored fill (or translucent red) stamped with skulls, so a
  // lethal region is never mistakable for standable geometry. Before the
  // generic authored branch so a killzone given a colour still gets its mark.
  if (body instanceof KillZone) {
    fillKillZone(
      ctx,
      t.globalPosition,
      t.globalRotation,
      outlineOfShape(t.shape),
      body.fillColor ? hexToRgba(body.fillColor, body.fillOpacity) : KILLZONE,
    );
    return;
  }

  // Authored level geometry (static/rigid): fill in the body's colour
  // + opacity, border fully opaque in the same colour.
  if (body.fillColor) {
    pathShape(ctx, t);
    ctx.fillStyle = hexToRgba(body.fillColor, body.fillOpacity);
    ctx.fill();
    ctx.strokeStyle = body.fillColor;
    ctx.lineWidth = PX;
    ctx.stroke();
    return;
  }

  if (body instanceof RigidBody2D) {
    pathShape(ctx, t);
    ctx.fillStyle = DYNAMIC_FILL;
    ctx.fill();
    ctx.strokeStyle = GEOMETRY_STROKE;
    ctx.lineWidth = PX;
    ctx.stroke();
    return;
  }
  if (body instanceof AnimatableBody2D) {
    pathShape(ctx, t);
    ctx.fillStyle = MOVER_FILL;
    ctx.fill();
    ctx.strokeStyle = GEOMETRY_STROKE;
    ctx.lineWidth = PX;
    ctx.stroke();
    return;
  }
  if (body instanceof StaticBody2D) {
    pathShape(ctx, t);
    ctx.fillStyle = GEOMETRY_FILL;
    ctx.fill();
    ctx.strokeStyle = GEOMETRY_STROKE;
    ctx.lineWidth = PX;
    ctx.stroke();
    return;
  }
  // Any other area (none today): still filled as an area, never as geometry.
  if (body instanceof Area2D) {
    pathShape(ctx, t);
    ctx.fillStyle = KILLZONE;
    ctx.fill();
    return;
  }
}

function arrowHead(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2, color: string): void {
  const dir = a.directionTo(b);
  const left = dir.rotated(Math.PI * 0.8).mul(4 * PX);
  const right = dir.rotated(-Math.PI * 0.8).mul(4 * PX);
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x + left.x, b.y + left.y);
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x + right.x, b.y + right.y);
  ctx.strokeStyle = color;
  ctx.stroke();
}

// Small ring + four ticks, drawn in world space at the stick aim point.
function drawCrosshair(ctx: CanvasRenderingContext2D, p: Vec2): void {
  const r = 4 * PX;
  const tick = 3 * PX;
  ctx.strokeStyle = "#cbccc6";
  ctx.lineWidth = PX;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    ctx.moveTo(p.x + dx * r, p.y + dy * r);
    ctx.lineTo(p.x + dx * (r + tick), p.y + dy * (r + tick));
  }
  ctx.stroke();
}

export function render(
  ctx: CanvasRenderingContext2D,
  // Where the fixed 16:9 frame lands on this canvas and how big — the scale
  // carries the display's DPR with it (see render/viewport.ts).
  view: ViewTransform,
  level: Level,
  camera: Camera,
  fps: number,
  showDebug = false,
  gamepadAim: Vec2 | null = null,
  // Fraction of a physics step elapsed since the last one: every moving body is
  // drawn between its previous and current sim transform. 1 = draw the sim
  // state exactly (what a caller with no fixed-step accumulator wants).
  alpha = 1,
  // The camera state in force, for the debug overlay (see drawDebugOverlay).
  heldCamera: HeldCamera | null = null,
  // See `renderBall`: draw only the genuinely-2D layers, leaving the scene to
  // the WebGL canvas underneath. The grapple avatar's rig and its rope STAY on
  // this canvas even in overlay mode - the Player state-machine slice is 2D-only
  // (see "Explicitly out of scope" in docs/3d-rendering-plan.md), so a 3D
  // grapple level is a 3D world with a 2D avatar in it.
  overlayOnly = false,
  // The hook's sparks, drawn in world space over everything else (see
  // `render/sparks.ts`). Deliberately NOT gated on `overlayOnly`: a spark is an
  // emissive, screen-thin flat mark over the scene, which is exactly what this
  // canvas keeps in 3D. Absent everywhere that has no spark system to hand.
  sparks: SparkSystem | null = null,
): void {
  const { width: viewWidth, height: viewHeight } = view;
  ctx.setTransform(view.scale, 0, 0, view.scale, view.originX, view.originY);
  if (overlayOnly) ctx.clearRect(0, 0, viewWidth, viewHeight);
  else drawTrainingGrid(ctx, camera, viewWidth, viewHeight);

  ctx.save();
  ctx.translate(viewWidth / 2, viewHeight / 2);
  // World is in metres; scale metres → screen pixels. camera.zoom is the view
  // knob, PIXELS_PER_METER the unit conversion. Fixed-pixel decoration drawn in
  // this space is expressed as a world length via PX (= 1 / PIXELS_PER_METER).
  ctx.scale(camera.zoom * PIXELS_PER_METER, camera.zoom * PIXELS_PER_METER);
  ctx.translate(-camera.position.x, -camera.position.y);

  if (!overlayOnly) {
    // Authored decoration, under everything: nothing the player can touch may be
    // hidden behind a backdrop.
    drawDecor(ctx, level.decor, alpha);

    // Chains hang among the decoration, behind every solid thing - which is the
    // same statement as their passing through it (see `SceneChain`).
    drawSceneChains(ctx, level.sceneChains, alpha);
  }

  // Hook-only scenery is background the player passes through, so it goes down
  // first and solid geometry draws over it. 2D only, like the water it follows:
  // in 3D the scene draws the body itself, set back behind the gameplay plane,
  // and a grate lattice stamped over that fights the thing it is describing (see
  // `renderBall`).
  if (!overlayOnly) {
    for (const body of level.world.bodies) {
      if (body.passable) drawBody(ctx, body, alpha);
    }
  }
  if (!overlayOnly) {
    for (const body of level.world.bodies) {
      if (body instanceof Player) continue; // drawn between the rig layers below
      if (body.passable) continue; // already drawn, behind
      // A vine link's collision circle is its GRAB radius, several times the
      // gauge the vine is drawn at, and a vine is one cord rather than thirty
      // discs - `drawVines` below draws the whole thing from the link centres.
      if (body instanceof VineLink) continue;
      drawBody(ctx, body, alpha);
    }
  }
  for (const area of level.world.areas) {
    // Water is the exception to "areas stay 2D": it is a volume with a surface
    // rather than a mark on a region, so in 3D (`overlayOnly`) the scene draws
    // the real thing and a lattice of streaks over the top would only fight it.
    if (overlayOnly && area instanceof WaterArea) continue;
    drawBody(ctx, area, alpha);
  }

  // Vines over the geometry and under the player: a vine is a thing the player
  // grabs, so unlike a scene chain it may not be hidden behind the wall it hangs
  // in front of - and unlike the player it is scenery, so it passes behind them.
  //
  // 2D only. In 3D the scene draws the vine itself (`render3d/vineVisual.ts`),
  // where it has depth and takes the level's light; a flat cord over the top of
  // that would be the same vine drawn twice, and the flat one would be the one
  // in front.
  if (!overlayOnly) drawVines(ctx, level.vines, alpha);

  // Rope spans, drawn exactly as simulated and BEHIND the player so the body
  // covers the origin at its centre. The first span used to be redrawn from
  // the right hand's centre, but the offset between the hand and the sim
  // attach point bent the rendered path at every wrap node — a sub-pixel wrap
  // read as the rope snagging on a corner. The rig's arm reaches toward the
  // rope instead (playerRig), so the hand still tracks the rope visually.
  const rope = level.player.rope;
  if (rope) {
    ctx.strokeStyle = HOOK;
    ctx.lineWidth = PX;
    ctx.beginPath();
    // Drawn from the wrap NODES rather than the resolved spans: a node is a
    // point in its body's local frame, so re-resolving it against the render
    // transform keeps the rope attached to the drawn bodies at both ends.
    for (const { from, to } of rope.getSpans()) {
      const a = from.contact.renderGlobalPosition(alpha);
      const b = to.contact.renderGlobalPosition(alpha);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  // Player sandwich over the rope: far-side limbs, body, near-side limbs.
  updatePlayerRig(level, alpha);
  drawPlayerRigBack(ctx);
  drawBody(ctx, level.player, alpha);
  drawPlayerRigFront(ctx);

  sparks?.draw(ctx);

  // Gamepad crosshair — only while the right stick owns aim (with the mouse,
  // the OS cursor shows aim already).
  if (gamepadAim) drawCrosshair(ctx, gamepadAim);

  // Debug overlay (toggle: L): ledge-grab markers + player contact normals.
  if (showDebug) drawDebugOverlay(ctx, level, heldCamera);

  // Debug overlay.
  for (const cmd of Debug.cmds) {
    ctx.strokeStyle = cmd.color;
    ctx.lineWidth = cmd.width * PX;
    ctx.beginPath();
    ctx.moveTo(cmd.a.x, cmd.a.y);
    ctx.lineTo(cmd.b.x, cmd.b.y);
    ctx.stroke();
    if (cmd.kind === "arrow") arrowHead(ctx, cmd.a, cmd.b, cmd.color);
  }

  ctx.restore();

  // Atmosphere, over the scene and under the instruments (see drawVignette).
  if (overlayOnly) drawVignette(ctx, viewWidth, viewHeight);

  // FPS counter (screen space, top-right). The rest of the instruments - frame
  // time, CPU, GPU, memory and their five-second graphs - are the perf HUD's,
  // drawn by the caller over this canvas (see render/perfHud.ts).
  ctx.font = "14px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#5a6472";
  ctx.fillText(`${Math.round(fps)} fps`, viewWidth - 8, 6);
  ctx.textAlign = "left";
}

// Metal chain along a polyline: interlocking oval links of a FIXED world length,
// alternately rotated 90° so it reads as forged loops.
//
// Where the links FALL is `walkChain` (render/chainMetrics.ts), shared with the
// 3D renderer so the two chains cannot disagree about the one part of this that
// has ever been wrong; this function is only how a link is painted on a canvas.
function drawChainPolyline(
  ctx: CanvasRenderingContext2D,
  points: Vec2[],
  // Link colours. The defaults are the forged-iron pair the ball & chain hangs
  // on; an authored scene chain passes its own, darkened for the narrow links so
  // the alternation still reads as interlocking loops.
  colors: { broad: string; narrow: string } = { broad: CHAIN, narrow: CHAIN_DARK },
): void {
  const half = CHAIN_LINK_LEN * 0.62; // overlap neighbours so links interlock
  ctx.lineWidth = PX;
  walkChain(points, ({ mid, dir, broad }) => {
    const w = broad ? CHAIN_LINK_W : CHAIN_LINK_W * 0.5;
    ctx.strokeStyle = broad ? colors.broad : colors.narrow;
    ctx.beginPath();
    // Oval link as a rounded capsule: two side arcs are approximated by an
    // ellipse aligned to the span.
    ctx.save();
    ctx.translate(mid.x, mid.y);
    ctx.rotate(Math.atan2(dir.y, dir.x));
    ctx.ellipse(0, 0, half, w, 0, 0, Math.PI * 2);
    ctx.restore();
    ctx.stroke();
  });
}

// How far a chain's links are pushed toward the backdrop: the fill they are
// drawn at, so they read as the same iron seen through the level's own haze
// rather than as a different, thinner chain.
const CHAIN_ALPHA = 0.55;

// A soft darkening toward the corners of the frame, drawn on the OVERLAY canvas
// rather than as a post-processing pass. That is not a shortcut: a vignette is a
// screen-space multiply over the finished frame and the overlay canvas is
// already exactly that, so drawing it here costs one gradient fill and saves the
// whole render-target plumbing an effect composer would need for it.
//
// 3D mode only, and deliberately: the 2D renderer's flat fills carry no light
// of their own, so darkening their corners reads as a smudge rather than as a
// lens. Drawn under the reticle and the FPS counter, which are instruments and
// must not be dimmed.
const VIGNETTE_STRENGTH = 0.34;

function drawVignette(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const cx = width / 2;
  const cy = height / 2;
  const inner = Math.min(width, height) * 0.42;
  const outer = Math.hypot(cx, cy);
  const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${VIGNETTE_STRENGTH})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}

// The alignment probe (`?probe3d=1`): a known world rect outlined on THIS canvas
// while `Scene3D` draws a box of the same rect on the one underneath. The two
// coinciding at every zoom, camera position and mid-blend frame is the
// acceptance criterion the whole 3D renderer stands on, and it is the one form
// of it a person can see - `cli render3d` asserts the same claim numerically.
//
// Drawn in screen space from the 2D camera transform, deliberately: reading the
// projection off the same arithmetic the bodies are drawn with is what makes a
// disagreement with the 3D scene mean something.
export function drawProbeOutline(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  camera: Camera,
  rect: { x: number; y: number; w: number; h: number },
): void {
  ctx.setTransform(view.scale, 0, 0, view.scale, view.originX, view.originY);
  ctx.save();
  ctx.translate(view.width / 2, view.height / 2);
  ctx.scale(camera.zoom * PIXELS_PER_METER, camera.zoom * PIXELS_PER_METER);
  ctx.translate(-camera.position.x, -camera.position.y);
  ctx.strokeStyle = "#00ff88";
  ctx.lineWidth = PX;
  ctx.strokeRect(rect.x - rect.w / 2, rect.y - rect.h / 2, rect.w, rect.h);
  ctx.restore();
}

// Authored scene chains: the same forged links, laid along each chain's wrap
// path. Drawn from the wrap NODES against the render transforms, exactly as the
// rope and the ball's chain are, so a chain stays welded to the drawn bodies at
// both ends instead of to their 60 Hz sim positions.
//
// Drawn behind the level's geometry, which is the visible half of a chain being
// scenery; the other half is that it is solved against nothing but its own two
// bodies (see `SceneChain.physicsStep`).
function drawSceneChains(
  ctx: CanvasRenderingContext2D,
  chains: readonly SceneChain[],
  alpha: number,
): void {
  for (const chain of chains) {
    const spans = chain.rope.getSpans();
    if (!spans.length) continue;
    const path = [
      spans[0]!.from.contact.renderGlobalPosition(alpha),
      ...spans.map((s) => s.to.contact.renderGlobalPosition(alpha)),
    ];
    ctx.save();
    ctx.globalAlpha *= CHAIN_ALPHA;
    drawChainPolyline(
      ctx,
      path,
      chain.color ? { broad: chain.color, narrow: shade(chain.color, 0.65) } : undefined,
    );
    ctx.restore();
  }
}

// The chain's far end - the "hook" - drawn as an iron manacle: two jaws pinned
// together at the HINGE and shut on each other at the LOCK opposite it. `dir`
// points out of the hinge: at the chain while the cuff hangs free, and out of the
// surface it bit once it is clamped (see `BallPlayer.manacleFacing`).
//
// The jaws are drawn shut always. They used to gape while the manacle was
// unattached, which read well and cost the one thing that matters more: a swung
// jaw stands a third of a radius outside the ring, so the drawn shape and the
// disc the sim collides as could not be the same shape, and every difference
// between the two had to be papered over somewhere (see lib/manacle).
//
// What makes it a manacle rather than a ring is therefore drawn INWARD: the lock
// is a block on the inside of the mouth, and the two jaws stop short of each
// other at either end - at the mouth and at the hinge - so the two pieces read
// as two. Nothing may stand outside `MANACLE_DISC`, and nothing stands proud of
// the band on the hinge side at all: the chain is laid over that arc.
function drawManacle(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  dir: Vec2,
  buried: boolean,
): void {
  const R = MANACLE_RADIUS;
  const BAND = MANACLE_BAND; // bar stock the cuff is forged from
  const GAP = 0.16; // radians of daylight at the mouth, under the lock
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(Math.atan2(dir.y, dir.x)); // +x now points along `dir`
  // A clamped cuff is centred ON the surface it bit, so half of it is inside
  // that surface and only the half on the +x side of the bite is above ground.
  // The terrain is already drawn by the time the chain is, so without this the
  // buried half is painted back over the wall and the cuff reads as a ring stuck
  // ON the surface rather than one clamped THROUGH it.
  if (buried) {
    ctx.beginPath();
    ctx.rect(0, -R - BAND, R + BAND, (R + BAND) * 2);
    ctx.clip();
  }
  const cap = ctx.lineCap;
  ctx.lineCap = "butt";

  // The two jaws: matching arcs from the hinge (+x) round either side to the
  // lock (-x), stopping short of each other only at the MOUTH, under the lock.
  // Closed at the hinge, because that is where they are pinned and because the
  // chain's own first link is laid across that arc - daylight there reads as a
  // ring the chain is about to fall out of.
  ctx.lineWidth = BAND;
  ctx.strokeStyle = MANACLE;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI - GAP);
  ctx.stroke();
  ctx.beginPath();
  // A hair past the hinge, so the two butt caps overlap instead of leaving a
  // seam down the middle of a joint that is meant to be solid.
  ctx.arc(0, 0, R, Math.PI + GAP, Math.PI * 2 + 0.03);
  ctx.stroke();

  // Lock: the housing over the mouth, holding the two jaw tips shut, with its
  // keyhole. Set inward off the band's outer edge so its corners stay inside the
  // collision disc.
  ctx.fillStyle = MANACLE_DARK;
  ctx.fillRect(-R - BAND / 2 + 0.3 * PX, -1.4 * PX, 2.6 * PX, 2.8 * PX);
  ctx.fillStyle = MANACLE;
  ctx.beginPath();
  ctx.arc(-R + 0.7 * PX, 0, 0.45 * PX, 0, Math.PI * 2);
  ctx.fill();

  // Rivets through the jaws, halfway round each.
  ctx.fillStyle = MANACLE_DARK;
  for (const sy of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(0, sy * R, 0.45 * PX, 0, Math.PI * 2);
    ctx.fill();
  }

  // No knuckle at the hinge. The two jaws are pinned there and the arcs stop
  // short of each other to say so, but a barrel drawn over the joint reads as a
  // knob on the rim, and the chain's own first link is laid across exactly that
  // spot - so the one thing the chain must appear to run freely over was the one
  // thing standing proud of it.
  ctx.lineCap = cap;
  ctx.restore();
}

// The aim reticle — the cursor for the ball controller, whichever device aims.
// Drawn straight at the aim point BallInputSource reports, so the sim aims
// exactly where this is drawn; any bounding of that point belongs there.
// A hollow ring, not a disc: the scene stays visible through the middle, so the
// reticle never hides what is being aimed at. Drawn as a dark stroke with the
// white one laid over it, which leaves a thin dark edge on both sides of the
// white — legible over pale grid and dark geometry alike.
function drawAimReticle(ctx: CanvasRenderingContext2D, at: Vec2): void {
  ctx.beginPath();
  ctx.arc(at.x, at.y, RETICLE_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = RETICLE_EDGE;
  ctx.lineWidth = 2.2 * PX;
  ctx.stroke();
  ctx.strokeStyle = RETICLE;
  ctx.lineWidth = 1 * PX;
  ctx.stroke();
}

// Ball & chain frame: bodies + chain spans + the aim reticle. No rig, no ledge
// overlay — the ball has neither.
//
// `aimWorld` is the aim point from BallInputSource (null = not aiming) — see
// drawAimReticle.
export function renderBall(
  ctx: CanvasRenderingContext2D,
  // See `render`: where the fixed 16:9 frame lands on this canvas.
  view: ViewTransform,
  level: BallLevel,
  camera: Camera,
  fps: number,
  aimWorld: Vec2 | null = null,
  // See `render`: fraction of a physics step elapsed since the last one.
  alpha = 1,
  // Draw ONLY what is genuinely 2D, leaving the scene to the WebGL canvas
  // underneath (see render3d/scene.ts). What stays is everything whose size is
  // fixed on screen or whose meaning is a flat mark: the area glyphs, the aim
  // reticle, the FPS counter. What goes is the backdrop and every body, ball and
  // chain, because the 3D scene draws those - hook-only scenery included, which
  // the scene sets back behind the gameplay plane instead.
  //
  // Default false, so the 2D path, `shot.html` and `cli shot` are untouched.
  overlayOnly = false,
  // See `render`: the hook's sparks, drawn in both render modes.
  sparks: SparkSystem | null = null,
): void {
  const { width: viewWidth, height: viewHeight } = view;
  ctx.setTransform(view.scale, 0, 0, view.scale, view.originX, view.originY);
  if (overlayOnly) ctx.clearRect(0, 0, viewWidth, viewHeight);
  else drawTrainingGrid(ctx, camera, viewWidth, viewHeight);

  ctx.save();
  ctx.translate(viewWidth / 2, viewHeight / 2);
  // World is in metres; scale metres → screen pixels. camera.zoom is the view
  // knob, PIXELS_PER_METER the unit conversion. Fixed-pixel decoration drawn in
  // this space is expressed as a world length via PX (= 1 / PIXELS_PER_METER).
  ctx.scale(camera.zoom * PIXELS_PER_METER, camera.zoom * PIXELS_PER_METER);
  ctx.translate(-camera.position.x, -camera.position.y);

  if (!overlayOnly) {
    // Authored decoration under everything (see `render`).
    drawDecor(ctx, level.decor, alpha);

    // Chains behind the solid geometry they pass through (see `render`).
    drawSceneChains(ctx, level.sceneChains, alpha);
  }

  // Hook-only scenery behind the solid geometry it sits among (see `render`).
  // Dropped in overlay mode, which is the same exception water takes: the 3D
  // scene draws the body a quarter of a metre behind the gameplay plane, and
  // that setback is what says the player passes through it there, so a grate
  // lattice stamped flat over the top only fights the depth cue (see
  // "Pass-through geometry must read as pass-through" in docs/game-design.md).
  if (!overlayOnly) {
    for (const body of level.world.bodies) {
      if (body.passable) drawBody(ctx, body, alpha);
    }
  }
  if (!overlayOnly) {
    for (const body of level.world.bodies) {
      if (body instanceof BallPlayer) continue; // drawn over the chain below
      if (body instanceof BallHook) continue; // the manacle is drawn at the chain tip
      if (body.passable) continue; // already drawn, behind
      if (body instanceof VineLink) continue; // one cord, not twenty discs (see `render`)
      drawBody(ctx, body, alpha);
    }
    // ...and the vine as that cord, over the geometry and under the ball. 2D
    // only, for the reason `render` gives: in 3D the scene draws it.
    drawVines(ctx, level.vines, alpha);
  }
  // Areas stay 2D in both modes: a killzone's skulls and a force area's flow
  // arrows are flat marks on a region of space, and a region of space has no
  // solid to extrude.
  for (const area of level.world.areas) {
    // Water is the exception to "areas stay 2D": it is a volume with a surface
    // rather than a mark on a region, so in 3D (`overlayOnly`) the scene draws
    // the real thing and a lattice of streaks over the top would only fight it.
    if (overlayOnly && area instanceof WaterArea) continue;
    drawBody(ctx, area, alpha);
  }

  // Metal chain behind the ball. Links are laid at a fixed length from the
  // ANCHOR toward the ball, then on through the loop into the ball CENTRE
  // (that tail runs under the body, which is drawn on top). Pinning the links
  // to the anchor means that as the chain reels in — the ball being pulled
  // toward the anchor — the links stay put in the world and are consumed one
  // by one INTO the cannonball, instead of the whole chain compressing away at
  // the anchor.
  const ball = level.ball;
  const chain = ball.chain;
  if (chain && !overlayOnly) {
    // Node path loop→anchor. The slack sim's polyline: the coil and both ends
    // welded to the render transforms (so the chain never visibly detaches
    // from the drawn ball or hook between steps), the free run draped — and
    // exactly the straight wrap path whenever the chain is taut.
    const loopToAnchor =
      ball.chainSlack?.pathLoopToAnchor(alpha) ??
      chain.path().map((n) => n.contact.renderGlobalPosition(alpha));
    // Manacle at the chain's far end (flying hook, dangling tip, or anchor).
    //
    // Centred on the chain's own end node, always. Free, that node IS the hook
    // body - the hook collides as the whole cuff and the rope ends at its centre
    // - and anchored it is the point the cuff bit, which the sim puts on the
    // geometry itself, so the cuff reads as clamped half in and half out of it.
    // Placing the cuff a radius back along the CHAIN instead was a guess about a
    // body whose pose was in hand, and it drifted off that body as the hook
    // turned: a manacle resting on the ground was drawn a whole radius below the
    // disc that was doing the resting (session-150f).
    const at = loopToAnchor[loopToAnchor.length - 1]!;
    // Where the chain runs, and which way the cuff faces - the same thing while
    // the cuff is free to hang from the chain, and no longer the same thing once
    // it is clamped: a bolted cuff keeps the facing it bit with and the chain
    // travels round its rim instead.
    const chainDir = chainEndFacing(loopToAnchor, ball.renderLoopDirection(alpha));
    // A facing at all means the cuff is CLAMPED (a free one, flying or dangling,
    // has none), which is also when half of it is inside what it bit.
    const clamped = ball.manacleFacing(alpha);
    const dir = clamped ?? chainDir;
    // Walk anchor → … → loop → ball centre: reverse to start at the anchor,
    // then extend past the loop into the covered centre at the ball end.
    const path = [...loopToAnchor.reverse(), ball.renderPosition(alpha)];
    // The links stop ON THE RIM, on whichever side the chain runs - the touch
    // point of a chain laid over a ring, which slides round the ring as the ball
    // swings, and which is the only part of the join that moves once the cuff is
    // clamped. Run to the end node instead and the links are drawn straight
    // through the middle of the cuff.
    trimPathStart(path, MANACLE_RADIUS);
    path[0] = at.add(chainDir.mul(MANACLE_RADIUS));
    drawChainPolyline(ctx, path);
    drawManacle(ctx, at, dir, clamped !== null);
  }
  if (!overlayOnly) {
    drawBody(ctx, ball, alpha);

    // Steel mounting loop: material point on the rim, rotating with the ball
    // (its aim direction when no chain is out). Drawn on top of the body.
    const loop = ball.renderLoopCenter(alpha);
    ctx.strokeStyle = CHAIN;
    ctx.lineWidth = PX;
    ctx.beginPath();
    ctx.arc(loop.x, loop.y, BallPlayer.LOOP_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
  }

  sparks?.draw(ctx);

  if (aimWorld) drawAimReticle(ctx, aimWorld);

  ctx.restore();

  // Atmosphere, over the scene and under the instruments (see drawVignette).
  if (overlayOnly) drawVignette(ctx, viewWidth, viewHeight);

  // FPS counter (screen space, top-right). The rest of the instruments - frame
  // time, CPU, GPU, memory and their five-second graphs - are the perf HUD's,
  // drawn by the caller over this canvas (see render/perfHud.ts).
  ctx.font = "14px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#5a6472";
  ctx.fillText(`${Math.round(fps)} fps`, viewWidth - 8, 6);
  ctx.textAlign = "left";
}
