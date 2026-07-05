// Canvas renderer for the table. Draws a realistic-looking felt table, wooden
// rails, pockets, glossy numbered balls, the cue stick + aim line, and the
// opponent's live ghost cue / cursor. Pure drawing — no game logic.

import {
  CUSHION_SEGS,
  CUSHION_VERTS,
  POCKET_DEPTH,
  POCKET_LIST,
  R,
  TABLE,
  type Prediction,
  type Vec,
  type World,
} from "./physics";

// The table is a photo (public/table.png). These are the pixel coordinates of
// its felt playfield (the cushion-nose rectangle) within that image, measured
// once — the felt box is mapped onto the physics play area so the drawn table,
// its pockets, and the collision geometry all line up.
const IMG = { W: 2391, H: 1793, fx: 233, fy: 418, fw: 1902, fh: 991 };
// The table itself (wooden rails) occupies only part of the image — the rest is
// empty transparent background. This is the tight opaque box (measured), used to
// size the canvas so the visible table fills it and the margin is cropped off.
const CROP = { x: 146, y: 332, w: 2078, h: 1164 };
let tableImg: HTMLImageElement | null = null;
let tableReady = false;
function ensureTableImg() {
  if (tableImg || typeof Image === "undefined") return;
  tableImg = new Image();
  tableImg.crossOrigin = "anonymous";
  tableImg.onload = () => (tableReady = true);
  tableImg.src = "https://iili.io/CaPOw1s.png";
}
import type { Group } from "./rules";

export type Layout = {
  scale: number; // px per metre
  ox: number; // origin x (px) of play area
  oy: number;
  rail: number; // rail thickness (px)
  rotated: boolean; // portrait: table turned 90° (long axis vertical)
  pw: number; // play-area pixel width
  ph: number; // play-area pixel height
  W: number; // full canvas css width
  H: number; // full canvas css height
};

/**
 * Build a layout at a given px-per-metre, optionally rotated to portrait. The
 * canvas is sized to hold the whole table PHOTO: the felt box maps onto the play
 * area, and the surrounding wooden rails extend outside it. Rail widths come
 * straight from the image, so the canvas is bigger than the bare playfield.
 */
export function layoutFor(scale: number, rotated = false): Layout {
  const Wpx = TABLE.w * scale;
  const Hpx = TABLE.h * scale;
  // Screen delta (css px) for a full world width (U) / height (V), matching how
  // toPx maps world -> screen in each orientation.
  const U = rotated ? { x: 0, y: Wpx } : { x: Wpx, y: 0 };
  const V = rotated ? { x: -Hpx, y: 0 } : { x: 0, y: Hpx };
  // Where each image corner lands relative to world (0,0), via the felt mapping.
  const off = (ix: number, iy: number) => {
    const a = (ix - IMG.fx) / IMG.fw;
    const b = (iy - IMG.fy) / IMG.fh;
    return { x: a * U.x + b * V.x, y: a * U.y + b * V.y };
  };
  // Frame the canvas to the table box (CROP), not the whole image, so the
  // surrounding empty background is pushed off-canvas.
  const cs = [
    off(CROP.x, CROP.y),
    off(CROP.x + CROP.w, CROP.y),
    off(CROP.x, CROP.y + CROP.h),
    off(CROP.x + CROP.w, CROP.y + CROP.h),
  ];
  const minx = Math.min(...cs.map((c) => c.x));
  const maxx = Math.max(...cs.map((c) => c.x));
  const miny = Math.min(...cs.map((c) => c.y));
  const maxy = Math.max(...cs.map((c) => c.y));
  // Shift world (0,0) so the image starts at the canvas origin.
  const ox = (rotated ? -minx - Hpx : -minx);
  const oy = -miny;
  const pw = (rotated ? TABLE.h : TABLE.w) * scale;
  const ph = (rotated ? TABLE.w : TABLE.h) * scale;
  return { scale, ox, oy, rail: 0, rotated, pw, ph, W: maxx - minx, H: maxy - miny };
}

// World -> pixel. Landscape is a straight scale; portrait applies a proper 90°
// rotation (determinant +1, so chirality — and thus the sense of English — is
// preserved). Glyphs (ball numbers) are drawn at these points but not rotated,
// so they stay upright.
const toPx = (l: Layout, p: Vec) =>
  l.rotated
    ? { x: l.ox + (TABLE.h - p.y) * l.scale, y: l.oy + p.x * l.scale }
    : { x: l.ox + p.x * l.scale, y: l.oy + p.y * l.scale };

// Ball hues (standard pool colours). Stripes reuse the solid hue + a band.
const HUE: Record<number, string> = {
  1: "#e8b923",
  2: "#1f52a8",
  3: "#c0392b",
  4: "#6c3fa4",
  5: "#d97a1f",
  6: "#1f8a4c",
  7: "#7c2c2c",
  8: "#111417",
};
function ballColor(id: number): string {
  if (id === 0) return "#f4f1ea";
  if (id <= 8) return HUE[id];
  return HUE[id - 8];
}

export type Aim = {
  angle: number;
  power: number; // 0..1
  follow: number;
  side: number;
  elevation: number; // radians (raises/foreshortens the drawn cue)
};

export type Scene = {
  world: World;
  layout: Layout;
  myAim?: Aim; // shown while it is my turn to aim
  prediction?: Prediction; // spin-aware predicted paths for my shot
  showCue?: boolean; // draw the physical cue stick behind the ball
  ballInHand?: boolean;
  myGroup?: Group | null;
  opponent?: { cursor?: Vec; aim?: Aim };
  animating?: boolean;
  sinks?: Sink[]; // balls mid-drop into a pocket
  debug?: boolean; // overlay the real collision geometry
};

export function drawScene(ctx: CanvasRenderingContext2D, s: Scene) {
  const l = s.layout;
  ctx.clearRect(0, 0, l.W, l.H);
  ensureTableImg();
  drawTable(ctx, l);

  // Aim assist — the spin-aware predicted path, shown only once power is being
  // dialled in (no preview at zero power).
  if (s.myAim && s.prediction && !s.animating) drawPrediction(ctx, l, s.prediction);
  if (s.opponent?.aim && !s.animating)
    drawGhostAim(ctx, l, s.world, s.opponent.aim);

  drawBalls(ctx, l, s.world, s.ballInHand ? 0 : -1);
  if (s.sinks) for (const sk of s.sinks) drawSink(ctx, l, sk);

  // NB: the active player's cue stick is a DOM <img> overlay in Game.tsx (so it
  // can extend past the canvas edge), not drawn here.

  if (s.opponent?.cursor) drawCursor(ctx, l, s.opponent.cursor);

  if (s.debug) drawDebugOverlay(ctx, l, s.world);
}

// Overlay the collision boundaries the physics ACTUALLY uses. Cushions are the
// felt-surface polygon a ball's edge strikes (the physics insets by R on the
// fly, so these lines ARE the collision faces). Convex corners are drawn as
// R-circles: a ball centre rounds them, which is how it rebounds off a nose/jaw
// tip at any angle. Pockets are a pure centre test whose circle is the hole.
function drawDebugOverlay(ctx: CanvasRenderingContext2D, l: Layout, world: World) {
  ctx.save();
  ctx.lineWidth = Math.max(0.5, l.scale * 0.002);

  // Cushion contact surface — the nose + angled jaws a ball's edge strikes, on
  // the true felt surface. Salmon ticks show each face's inward normal.
  ctx.strokeStyle = "#ff3b3b";
  for (const s of CUSHION_SEGS) {
    const a = toPx(l, s.a);
    const b = toPx(l, s.b);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
    const m = toPx(l, mid);
    const n = toPx(l, { x: mid.x + s.nx * 0.02, y: mid.y + s.ny * 0.02 });
    ctx.strokeStyle = "rgba(255,120,120,0.7)";
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(n.x, n.y);
    ctx.stroke();
    ctx.strokeStyle = "#ff3b3b";
  }

  // Rounded convex corners — the ball centre rebounds off these R-circles.
  ctx.strokeStyle = "rgba(190,120,255,0.9)";
  for (const vt of CUSHION_VERTS) {
    const c = toPx(l, { x: vt.x, y: vt.y });
    ctx.beginPath();
    ctx.arc(c.x, c.y, R * l.scale, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Pocket pot circles — a centre inside this drops the ball.
  ctx.strokeStyle = "#39ff88";
  for (const pk of POCKET_LIST) {
    const c = toPx(l, pk.center);
    ctx.beginPath();
    ctx.arc(c.x, c.y, pk.hole * l.scale, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Hard outer pocket walls — where a centre reflects if it misses the hole.
  ctx.strokeStyle = "rgba(255,170,40,0.8)";
  const wall = toPx(l, { x: -POCKET_DEPTH, y: -POCKET_DEPTH });
  const wall2 = toPx(l, { x: TABLE.w + POCKET_DEPTH, y: TABLE.h + POCKET_DEPTH });
  ctx.strokeRect(
    Math.min(wall.x, wall2.x),
    Math.min(wall.y, wall2.y),
    Math.abs(wall2.x - wall.x),
    Math.abs(wall2.y - wall.y),
  );

  // Per-ball loci: R (own edge) and 2R (where another centre first contacts it).
  for (const b of world.balls) {
    if (b.potted) continue;
    const c = toPx(l, b.p);
    ctx.strokeStyle = "rgba(255,221,51,0.9)";
    ctx.beginPath();
    ctx.arc(c.x, c.y, R * l.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(90,220,255,0.5)";
    ctx.beginPath();
    ctx.arc(c.x, c.y, 2 * R * l.scale, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

// Draw the table PHOTO. The image's felt box (IMG.f*) is mapped onto the world
// play area with an affine transform derived from three world corners, so it
// works in both orientations (portrait just rotates U/V) and keeps the felt,
// pockets, and collision geometry aligned.
function drawTable(ctx: CanvasRenderingContext2D, l: Layout) {
  if (!tableImg || !tableReady) {
    // Until the photo loads, fill the play area with felt colour so balls read.
    ctx.fillStyle = "#1f9ad6";
    ctx.fillRect(l.ox, l.oy, l.pw, l.ph);
    return;
  }
  const c00 = toPx(l, { x: 0, y: 0 });
  const c10 = toPx(l, { x: TABLE.w, y: 0 });
  const c01 = toPx(l, { x: 0, y: TABLE.h });
  const ux = c10.x - c00.x;
  const uy = c10.y - c00.y;
  const vx = c01.x - c00.x;
  const vy = c01.y - c00.y;
  // image (ix,iy) -> screen: c00 + ((ix-fx)/fw)U + ((iy-fy)/fh)V.
  const m11 = ux / IMG.fw;
  const m12 = uy / IMG.fw;
  const m21 = vx / IMG.fh;
  const m22 = vy / IMG.fh;
  const dx = c00.x - (IMG.fx / IMG.fw) * ux - (IMG.fy / IMG.fh) * vx;
  const dy = c00.y - (IMG.fx / IMG.fw) * uy - (IMG.fy / IMG.fh) * vy;
  ctx.save();
  ctx.transform(m11, m12, m21, m22, dx, dy); // composes onto the dpr transform
  ctx.drawImage(tableImg, 0, 0);
  ctx.restore();
}

/** Draw a single glossy numbered ball at pixel centre c, radius rpx, alpha. */
function drawBall(
  ctx: CanvasRenderingContext2D,
  c: Vec,
  id: number,
  rpx: number,
  alpha: number,
  shadow = true,
) {
  ctx.save();
  ctx.globalAlpha = alpha;

  if (shadow) {
    ctx.beginPath();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.ellipse(c.x + rpx * 0.15, c.y + rpx * 0.35, rpx, rpx * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const base = ballColor(id);
  const g = ctx.createRadialGradient(
    c.x - rpx * 0.35,
    c.y - rpx * 0.35,
    rpx * 0.1,
    c.x,
    c.y,
    rpx,
  );
  g.addColorStop(0, lighten(base, 0.5));
  g.addColorStop(0.7, base);
  g.addColorStop(1, darken(base, 0.35));
  ctx.beginPath();
  ctx.fillStyle = g;
  ctx.arc(c.x, c.y, rpx, 0, Math.PI * 2);
  ctx.fill();

  if (id > 8) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(c.x, c.y, rpx, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#f4f1ea";
    ctx.fillRect(c.x - rpx, c.y - rpx * 0.45, rpx * 2, rpx * 0.9);
    ctx.restore();
  }

  if (id !== 0) {
    ctx.beginPath();
    ctx.fillStyle = "#f4f1ea";
    ctx.arc(c.x, c.y, rpx * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#111";
    ctx.font = `${Math.max(6, rpx * 0.55)}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(id), c.x, c.y + rpx * 0.02);
  }

  ctx.beginPath();
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.ellipse(c.x - rpx * 0.35, c.y - rpx * 0.4, rpx * 0.28, rpx * 0.18, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBalls(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  world: World,
  translucentId: number,
) {
  const rpx = R * l.scale;
  for (const b of world.balls) {
    if (b.potted) continue;
    drawBall(ctx, toPx(l, b.p), b.id, rpx, b.id === translucentId ? 0.55 : 1);
  }
}

/** A ball dropping into a pocket: lerps toward the pocket, shrinking + fading. */
export type Sink = { id: number; from: Vec; pocket: Vec; t: number };

function drawSink(ctx: CanvasRenderingContext2D, l: Layout, sk: Sink) {
  const rpx = R * l.scale;
  const e = sk.t * sk.t; // accelerate into the pocket
  const c = toPx(l, {
    x: sk.from.x + (sk.pocket.x - sk.from.x) * e,
    y: sk.from.y + (sk.pocket.y - sk.from.y) * e,
  });
  drawBall(ctx, c, sk.id, Math.max(1, rpx * (1 - 0.82 * sk.t)), 1 - sk.t, false);
}

function polyline(ctx: CanvasRenderingContext2D, l: Layout, pts: Vec[]) {
  if (pts.length < 2) return;
  ctx.beginPath();
  const a = toPx(l, pts[0]);
  ctx.moveTo(a.x, a.y);
  for (let i = 1; i < pts.length; i++) {
    const p = toPx(l, pts[i]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

/** Draw the spin-aware predicted paths (from the real engine preview). */
function drawPrediction(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  pr: Prediction,
) {
  const rpx = R * l.scale;
  ctx.save();

  // Cue-ball path up to first contact — dashed white; captures the spin curve.
  ctx.strokeStyle = "rgba(255,255,255,0.82)";
  ctx.lineWidth = 1.6;
  ctx.setLineDash([6, 5]);
  polyline(ctx, l, pr.cue);
  ctx.setLineDash([]);

  // Struck ball's initial travel — solid white line from its centre.
  if (pr.object && pr.object.length > 1) {
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.6;
    polyline(ctx, l, pr.object);
  }

  // Ghost cue ball at first contact.
  if (pr.ghost) {
    const g = toPx(l, pr.ghost);
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.arc(g.x, g.y, rpx, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Mark it if the cue ball would fall straight into a pocket (a scratch).
  if (pr.cuePotted && pr.cue.length) {
    const c = toPx(l, pr.cue[pr.cue.length - 1]);
    ctx.strokeStyle = "#f08778";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c.x - 5, c.y - 5);
    ctx.lineTo(c.x + 5, c.y + 5);
    ctx.moveTo(c.x + 5, c.y - 5);
    ctx.lineTo(c.x - 5, c.y + 5);
    ctx.stroke();
  }

  ctx.restore();
}

function drawGhostAim(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  world: World,
  aim: Aim,
) {
  const cue = world.balls[0];
  if (cue.potted) return;
  const c = toPx(l, cue.p);
  const ang = aim.angle + (l.rotated ? Math.PI / 2 : 0); // world dir -> screen dir
  const len = R * l.scale * 6 * (0.4 + aim.power);
  ctx.save();
  ctx.strokeStyle = "rgba(120,200,255,0.5)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(c.x + Math.cos(ang) * len, c.y + Math.sin(ang) * len);
  ctx.stroke();
  ctx.restore();
}

function drawCursor(ctx: CanvasRenderingContext2D, l: Layout, p: Vec) {
  const c = toPx(l, p);
  ctx.save();
  ctx.fillStyle = "rgba(120,200,255,0.9)";
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(c.x + 10, c.y + 4);
  ctx.lineTo(c.x + 4, c.y + 10);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// --- colour helpers ---------------------------------------------------------
function clamp(n: number) {
  return Math.max(0, Math.min(255, Math.round(n)));
}
function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function lighten(hex: string, amt: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${clamp(r + 255 * amt)},${clamp(g + 255 * amt)},${clamp(b + 255 * amt)})`;
}
function darken(hex: string, amt: number) {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${clamp(r * (1 - amt))},${clamp(g * (1 - amt))},${clamp(b * (1 - amt))})`;
}
