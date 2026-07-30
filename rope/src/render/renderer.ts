// Canvas renderer. Draws the world in the terminal-ish palette; the C# code drew
// via Godot's scene graph and Debug canvas overlay.

import { Vec2 } from "../engine/vec2";
import type { ShapeTransform } from "../engine/shapes";
import {
  AnchorBody,
  AnimatableBody2D,
  Area2D,
  ForceArea,
  ImpermeableBody,
  RigidBody2D,
  StaticBody2D,
  type CollisionObject2D,
} from "../engine/body";
import { Debug } from "../engine/debug";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { Player } from "../classes/player";
import { BallPlayer } from "../classes/ballPlayer";
import { BallHook } from "../classes/ballHook";
import { Hook } from "../classes/hook";
import { KillZone } from "../classes/killZone";
import type { Level } from "../level/level";
import type { BallLevel } from "../level/ballLevel";
import type { SceneChain } from "../level/chains";
import type { Camera } from "./camera";
import type { CameraRegionData, ChainLayer } from "../level/levelFormat";
import { drawTrainingGrid } from "./trainingGrid";
import { drawBackgrounds } from "./background";
import { fillAnchor, fillForceArea, fillKillZone } from "./areaFill";
import {
  outlineHalfExtents,
  outlineOfShape,
  pathOutline,
  pathOutlineInto,
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
  // is exactly the body's real outline. Areas and hook-only anchors stay
  // per-shape: their fill is a glyph lattice punched out of each piece, and a
  // lattice has no union form.
  if (shapes.length > 1 && !(body instanceof Area2D) && !(body instanceof AnchorBody)) {
    drawCompoundGeometry(ctx, body, shapes);
    return;
  }
  for (const s of shapes) drawGeometryShape(ctx, body, s);
}

// How a body's geometry is painted: the same choices `drawGeometryShape` makes,
// pulled out so the compound path cannot drift from the single-shape one.
function geometryStyle(
  body: CollisionObject2D,
): { fill: string | null; stroke: string; width: number; dash: number[] } {
  if (body instanceof ImpermeableBody) {
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
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = style.width;
  ctx.setLineDash(style.dash);
  for (let i = 0; i < shapes.length; i++) {
    ctx.save();
    // Clip away each sibling in turn. Clips intersect, so after the loop what is
    // left is "outside every other piece" - which is where this piece's edge is
    // a real edge of the body rather than an interior seam. One combined
    // even-odd clip would not do: a point inside two siblings crosses three
    // rings and comes out odd, i.e. wrongly kept.
    for (let j = 0; j < shapes.length; j++) {
      if (i === j) continue;
      const outside = new Path2D();
      outside.rect(box.x, box.y, box.w, box.h);
      const s = shapes[j]!;
      pathOutlineInto(outside, s.globalPosition, s.globalRotation, outlineOfShape(s.shape));
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
): void {
  // Impermeable (hook-proof) surfaces: authored fill, but a dashed steel border
  // instead of the plain one so they read as chain-repelling — it's clear why
  // the hook bounces off them rather than anchoring.
  if (body instanceof ImpermeableBody) {
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

  // Hook-only anchor geometry (a background grate, a girder): the hook attaches
  // to it, but the avatar and the rope pass straight through. Punched with a
  // grate mesh — the backdrop shows through the holes — and given a dotted edge
  // rather than a solid one, so nothing about it reads as standable. `render`
  // draws these first, behind the solid geometry they sit among.
  if (body instanceof AnchorBody) {
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
  dpr: number,
  cssWidth: number,
  cssHeight: number,
  level: Level,
  camera: Camera,
  fps: number,
  showDebug = false,
  gamepadAim: Vec2 | null = null,
  // Fraction of a physics step elapsed since the last one: every moving body is
  // drawn between its previous and current sim transform. 1 = draw the sim
  // state exactly (what a caller with no fixed-step accumulator wants).
  alpha = 1,
  // The camera region in force, for the debug overlay (see drawDebugOverlay).
  heldCameraRegion: CameraRegionData | null = null,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTrainingGrid(ctx, camera, cssWidth, cssHeight);

  ctx.save();
  ctx.translate(cssWidth / 2, cssHeight / 2);
  // World is in metres; scale metres → screen pixels. camera.zoom is the view
  // knob, PIXELS_PER_METER the unit conversion. Fixed-pixel decoration drawn in
  // this space is expressed as a world length via PX (= 1 / PIXELS_PER_METER).
  ctx.scale(camera.zoom * PIXELS_PER_METER, camera.zoom * PIXELS_PER_METER);
  ctx.translate(-camera.position.x, -camera.position.y);

  // Authored decoration, under everything: nothing the player can touch may be
  // hidden behind a backdrop.
  drawBackgrounds(ctx, level.backgrounds);

  // Background chains hang among the decoration, behind every solid thing -
  // which is the same statement as their passing through it (see `ChainLayer`).
  drawSceneChains(ctx, level.sceneChains, "background", alpha);

  // Hook-only scenery is background the player passes through, so it goes down
  // first and solid geometry draws over it.
  for (const body of level.world.bodies) {
    if (body instanceof AnchorBody) drawBody(ctx, body, alpha);
  }
  for (const body of level.world.bodies) {
    if (body instanceof Player) continue; // drawn between the rig layers below
    if (body instanceof AnchorBody) continue; // already drawn, behind
    drawBody(ctx, body, alpha);
  }
  for (const area of level.world.areas) drawBody(ctx, area, alpha);

  // Foreground chains over the geometry they are strung between, under the rope
  // and the avatar.
  drawSceneChains(ctx, level.sceneChains, "foreground", alpha);

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

  // Gamepad crosshair — only while the right stick owns aim (with the mouse,
  // the OS cursor shows aim already).
  if (gamepadAim) drawCrosshair(ctx, gamepadAim);

  // Debug overlay (toggle: L): ledge-grab markers + player contact normals.
  if (showDebug) drawDebugOverlay(ctx, level, heldCameraRegion);

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

  // FPS counter (screen space, top-right).
  ctx.font = "14px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#5a6472";
  ctx.fillText(`${Math.round(fps)} fps`, cssWidth - 8, 6);
  ctx.textAlign = "left";
}

const CHAIN_LINK_LEN = 3.8 * PX; // fixed on-screen link length (world metres)
const CHAIN_LINK_W = 1.8 * PX; // half-width of the broad (in-plane) link

// Metal chain from `a` to `b`: interlocking oval links, alternately rotated
// 90° so it reads as forged loops. Links are a FIXED world length, laid from
// `a` — the partial leftover falls at the `b` end. Callers pass the anchored
// (world-fixed) end as `a` and the ball-side as `b`, so as the chain reels the
// links stay put in the world and the last one is consumed into the ball
// rather than the whole chain compressing toward the anchor. `phase` seeds the
// broad/narrow alternation for continuity across joined segments; returns the
// next phase and the unused remainder length past the last full link.
function drawChainLink(
  ctx: CanvasRenderingContext2D,
  a: Vec2,
  b: Vec2,
  phase = 0,
  // Link colours. The defaults are the forged-iron pair the ball & chain hangs
  // on; an authored scene chain passes its own, darkened for the narrow links so
  // the alternation still reads as interlocking loops.
  colors: { broad: string; narrow: string } = { broad: CHAIN, narrow: CHAIN_DARK },
): { phase: number; remainder: number } {
  const total = a.distanceTo(b);
  if (total < 1e-3 * PX) return { phase, remainder: 0 };
  const dir = a.directionTo(b);
  const n = Math.floor(total / CHAIN_LINK_LEN);
  const half = CHAIN_LINK_LEN * 0.62; // overlap neighbours so links interlock

  ctx.lineWidth = PX;
  for (let i = 0; i < n; i++) {
    const mid = a.add(dir.mul((i + 0.5) * CHAIN_LINK_LEN));
    const broad = (i + phase) % 2 === 0; // alternate link orientation
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
  }
  return { phase: phase + n, remainder: total - n * CHAIN_LINK_LEN };
}

// Lay chain links at fixed spacing along a polyline, measured from points[0]
// (the anchor). The sub-link remainder falls at the far end (the ball centre,
// hidden under the body), so reeling consumes links into the ball rather than
// rescaling the whole chain.
function drawChainPolyline(
  ctx: CanvasRenderingContext2D,
  points: Vec2[],
  colors?: { broad: string; narrow: string },
): void {
  let phase = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const r = drawChainLink(ctx, points[i]!, points[i + 1]!, phase, colors);
    phase = r.phase;
    // (Per-segment remainder is small and lands at wrap corners / the covered
    // ball centre; the visible run from the anchor stays world-pinned.)
  }
}

// How far a background chain's links are pushed toward the backdrop: the fill
// they are drawn at, so they read as the same iron seen through the level's own
// haze rather than as a different, thinner chain.
const BACKGROUND_CHAIN_ALPHA = 0.55;

// Authored scene chains of one layer: the same forged links, laid along each
// chain's wrap path. Drawn from the wrap NODES against the render transforms,
// exactly as the rope and the ball's chain are, so a chain stays welded to the
// drawn bodies at both ends instead of to their 60 Hz sim positions.
//
// Called twice a frame, once per layer, because the two layers sit on opposite
// sides of the level's geometry - that is the whole visible half of what the
// layer means (the other half is what the chain is solved against; see
// `SceneChain.physicsStep`).
function drawSceneChains(
  ctx: CanvasRenderingContext2D,
  chains: readonly SceneChain[],
  layer: ChainLayer,
  alpha: number,
): void {
  const background = layer === "background";
  for (const chain of chains) {
    if (chain.layer !== layer) continue;
    const spans = chain.rope.getSpans();
    if (!spans.length) continue;
    const path = [
      spans[0]!.from.contact.renderGlobalPosition(alpha),
      ...spans.map((s) => s.to.contact.renderGlobalPosition(alpha)),
    ];
    ctx.save();
    if (background) ctx.globalAlpha *= BACKGROUND_CHAIN_ALPHA;
    drawChainPolyline(
      ctx,
      path,
      chain.color ? { broad: chain.color, narrow: shade(chain.color, 0.65) } : undefined,
    );
    ctx.restore();
  }
}

// The chain's far end — the "hook" — drawn as an iron manacle: a thick steel
// cuff band with a lock housing on the chain side, a hinge pin opposite, and a
// clevis link joining it to the chain. `dir` points from the cuff toward the
// chain, so the housing always faces the span it hangs from.
function drawManacle(ctx: CanvasRenderingContext2D, center: Vec2, dir: Vec2): void {
  const R = 4.5 * PX; // cuff band radius
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(Math.atan2(dir.y, dir.x)); // +x now points toward the chain
  // Cuff band: thick steel ring.
  ctx.lineWidth = 1.6 * PX;
  ctx.strokeStyle = MANACLE;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.stroke();
  // Hinge pin on the far side (opposite the chain).
  ctx.fillStyle = MANACLE_DARK;
  ctx.beginPath();
  ctx.arc(-R, 0, 1.1 * PX, 0, Math.PI * 2);
  ctx.fill();
  // Lock housing where the chain meets the cuff (chain side, +x).
  ctx.fillStyle = MANACLE_DARK;
  ctx.fillRect(R - 1.2 * PX, -2 * PX, 3.4 * PX, 4 * PX);
  ctx.lineWidth = 0.7 * PX;
  ctx.strokeStyle = MANACLE;
  ctx.strokeRect(R - 1.2 * PX, -2 * PX, 3.4 * PX, 4 * PX);
  // Clevis link joining the housing to the chain.
  ctx.lineWidth = 1.2 * PX;
  ctx.beginPath();
  ctx.arc(R + 2.6 * PX, 0, 1.4 * PX, 0, Math.PI * 2);
  ctx.stroke();
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
  dpr: number,
  cssWidth: number,
  cssHeight: number,
  level: BallLevel,
  camera: Camera,
  fps: number,
  aimWorld: Vec2 | null = null,
  // See `render`: fraction of a physics step elapsed since the last one.
  alpha = 1,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTrainingGrid(ctx, camera, cssWidth, cssHeight);

  ctx.save();
  ctx.translate(cssWidth / 2, cssHeight / 2);
  // World is in metres; scale metres → screen pixels. camera.zoom is the view
  // knob, PIXELS_PER_METER the unit conversion. Fixed-pixel decoration drawn in
  // this space is expressed as a world length via PX (= 1 / PIXELS_PER_METER).
  ctx.scale(camera.zoom * PIXELS_PER_METER, camera.zoom * PIXELS_PER_METER);
  ctx.translate(-camera.position.x, -camera.position.y);

  // Authored decoration under everything (see `render`).
  drawBackgrounds(ctx, level.backgrounds);

  // Background chains behind the solid geometry they pass through (see `render`).
  drawSceneChains(ctx, level.sceneChains, "background", alpha);

  // Hook-only scenery behind the solid geometry it sits among (see `render`).
  for (const body of level.world.bodies) {
    if (body instanceof AnchorBody) drawBody(ctx, body, alpha);
  }
  for (const body of level.world.bodies) {
    if (body instanceof BallPlayer) continue; // drawn over the chain below
    if (body instanceof BallHook) continue; // the manacle is drawn at the chain tip
    if (body instanceof AnchorBody) continue; // already drawn, behind
    drawBody(ctx, body, alpha);
  }
  for (const area of level.world.areas) drawBody(ctx, area, alpha);

  // Foreground chains over the geometry, under the ball's own chain.
  drawSceneChains(ctx, level.sceneChains, "foreground", alpha);

  // Metal chain behind the ball. Links are laid at a fixed length from the
  // ANCHOR toward the ball, then on through the loop into the ball CENTRE
  // (that tail runs under the body, which is drawn on top). Pinning the links
  // to the anchor means that as the chain reels in — the ball being pulled
  // toward the anchor — the links stay put in the world and are consumed one
  // by one INTO the cannonball, instead of the whole chain compressing away at
  // the anchor.
  const ball = level.ball;
  const chain = ball.chain;
  if (chain) {
    const spans = chain.getSpans();
    // Node path loop→anchor (the loop is the first span's `from`, then each
    // span's `to`). Resolved against the render transforms, so the chain stays
    // welded to the drawn ball and the drawn hook rather than to their 60 Hz
    // sim positions — otherwise the chain visibly detaches between steps.
    const loopToAnchor = [
      spans[0]!.from.contact.renderGlobalPosition(alpha),
      ...spans.map((s) => s.to.contact.renderGlobalPosition(alpha)),
    ];
    // Walk anchor → … → loop → ball centre: reverse to start at the anchor,
    // then extend past the loop into the covered centre at the ball end.
    const path = [...loopToAnchor.reverse(), ball.renderPosition(alpha)];
    drawChainPolyline(ctx, path);

    // Manacle at the chain's far end (flying hook, dangling tip, or anchor).
    // Orient its housing toward the previous chain node.
    const last = spans[spans.length - 1]!;
    const tip = last.to.contact.renderGlobalPosition(alpha);
    const prev = last.from.contact.renderGlobalPosition(alpha);
    const dir =
      tip.distanceTo(prev) > 1e-3 * PX ? tip.directionTo(prev) : ball.renderLoopDirection(alpha);
    drawManacle(ctx, tip, dir);
  }
  drawBody(ctx, ball, alpha);

  // Steel mounting loop: material point on the rim, rotating with the ball
  // (its aim direction when no chain is out). Drawn on top of the body.
  const loop = ball.renderLoopCenter(alpha);
  ctx.strokeStyle = CHAIN;
  ctx.lineWidth = PX;
  ctx.beginPath();
  ctx.arc(loop.x, loop.y, BallPlayer.LOOP_RADIUS, 0, Math.PI * 2);
  ctx.stroke();

  if (aimWorld) drawAimReticle(ctx, aimWorld);

  ctx.restore();

  // FPS counter (screen space, top-right).
  ctx.font = "14px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#5a6472";
  ctx.fillText(`${Math.round(fps)} fps`, cssWidth - 8, 6);
  ctx.textAlign = "left";
}
