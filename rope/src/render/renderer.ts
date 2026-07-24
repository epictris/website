// Canvas renderer. Draws the world in the terminal-ish palette; the C# code drew
// via Godot's scene graph and Debug canvas overlay.

import { Vec2 } from "../engine/vec2";
import type { ShapeTransform } from "../engine/shapes";
import {
  AnimatableBody2D,
  Area2D,
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
import type { Level } from "../level/level";
import type { BallLevel } from "../level/ballLevel";
import type { Camera } from "./camera";
import { drawDebugOverlay } from "./debugOverlay";
import {
  drawPlayerRigBack,
  drawPlayerRigFront,
  updatePlayerRig,
} from "./playerRig";

const BG = "#1f2430";
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

function pathShape(ctx: CanvasRenderingContext2D, t: ShapeTransform): void {
  ctx.beginPath();
  if (t.shape.kind === "circle") {
    ctx.arc(t.globalPosition.x, t.globalPosition.y, t.shape.radius, 0, Math.PI * 2);
  } else {
    const hw = t.shape.size.x * 0.5;
    const hh = t.shape.size.y * 0.5;
    ctx.save();
    ctx.translate(t.globalPosition.x, t.globalPosition.y);
    ctx.rotate(t.globalRotation);
    ctx.rect(-hw, -hh, hw * 2, hh * 2);
    ctx.restore();
  }
}

function drawBody(ctx: CanvasRenderingContext2D, body: CollisionObject2D): void {
  if (!body.hasShape()) return;
  const t = body.getShape();
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
    const c = body.globalPosition;
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
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  ctx.save();
  ctx.translate(cssWidth / 2, cssHeight / 2);
  // World is in metres; scale metres → screen pixels. camera.zoom is the view
  // knob, PIXELS_PER_METER the unit conversion. Fixed-pixel decoration drawn in
  // this space is expressed as a world length via PX (= 1 / PIXELS_PER_METER).
  ctx.scale(camera.zoom * PIXELS_PER_METER, camera.zoom * PIXELS_PER_METER);
  ctx.translate(-camera.position.x, -camera.position.y);

  for (const body of level.world.bodies) {
    if (body instanceof Player) continue; // drawn between the rig layers below
    drawBody(ctx, body);
  }
  for (const area of level.world.areas) drawBody(ctx, area);

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
    for (const { span } of rope.getSpans()) {
      ctx.moveTo(span.start.x, span.start.y);
      ctx.lineTo(span.end.x, span.end.y);
    }
    ctx.stroke();
  }

  // Player sandwich over the rope: far-side limbs, body, near-side limbs.
  updatePlayerRig(level);
  drawPlayerRigBack(ctx);
  drawBody(ctx, level.player);
  drawPlayerRigFront(ctx);

  // Gamepad crosshair — only while the right stick owns aim (with the mouse,
  // the OS cursor shows aim already).
  if (gamepadAim) drawCrosshair(ctx, gamepadAim);

  // Debug overlay (toggle: L): ledge-grab markers + player contact normals.
  if (showDebug) drawDebugOverlay(ctx, level);

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
  ctx.fillStyle = "#cbccc6";
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
    ctx.strokeStyle = broad ? CHAIN : CHAIN_DARK;
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
function drawChainPolyline(ctx: CanvasRenderingContext2D, points: Vec2[]): void {
  let phase = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const r = drawChainLink(ctx, points[i]!, points[i + 1]!, phase);
    phase = r.phase;
    // (Per-segment remainder is small and lands at wrap corners / the covered
    // ball centre; the visible run from the anchor stays world-pinned.)
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

// Ball & chain frame: bodies + chain spans. No rig, no ledge overlay — the
// ball has neither; aim is shown by the loop on the ball itself.
export function renderBall(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  cssWidth: number,
  cssHeight: number,
  level: BallLevel,
  camera: Camera,
  fps: number,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  ctx.save();
  ctx.translate(cssWidth / 2, cssHeight / 2);
  // World is in metres; scale metres → screen pixels. camera.zoom is the view
  // knob, PIXELS_PER_METER the unit conversion. Fixed-pixel decoration drawn in
  // this space is expressed as a world length via PX (= 1 / PIXELS_PER_METER).
  ctx.scale(camera.zoom * PIXELS_PER_METER, camera.zoom * PIXELS_PER_METER);
  ctx.translate(-camera.position.x, -camera.position.y);

  for (const body of level.world.bodies) {
    if (body instanceof BallPlayer) continue; // drawn over the chain below
    if (body instanceof BallHook) continue; // the manacle is drawn at the chain tip
    drawBody(ctx, body);
  }
  for (const area of level.world.areas) drawBody(ctx, area);

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
    // Node path loop→anchor (loop is spans[0].start, then each span end).
    const loopToAnchor = [spans[0]!.span.start, ...spans.map((s) => s.span.end)];
    // Walk anchor → … → loop → ball centre: reverse to start at the anchor,
    // then extend past the loop into the covered centre at the ball end.
    const path = [...loopToAnchor.reverse(), ball.globalPosition];
    drawChainPolyline(ctx, path);

    // Manacle at the chain's far end (flying hook, dangling tip, or anchor).
    // Orient its housing toward the previous chain node.
    const tip = spans[spans.length - 1]!.span.end;
    const prev = spans[spans.length - 1]!.span.start;
    const dir = tip.distanceTo(prev) > 1e-3 * PX ? tip.directionTo(prev) : ball.loopDirection;
    drawManacle(ctx, tip, dir);
  }
  drawBody(ctx, ball);

  // Steel mounting loop: material point on the rim, rotating with the ball
  // (its aim direction when no chain is out). Drawn on top of the body.
  const loop = ball.globalPosition.add(ball.loopDirection.mul(ball.radius + 1.5 * PX));
  ctx.strokeStyle = CHAIN;
  ctx.lineWidth = PX;
  ctx.beginPath();
  ctx.arc(loop.x, loop.y, 2 * PX, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();

  // FPS counter (screen space, top-right).
  ctx.font = "14px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#cbccc6";
  ctx.fillText(`${Math.round(fps)} fps`, cssWidth - 8, 6);
  ctx.textAlign = "left";
}
