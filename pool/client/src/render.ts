// Canvas renderer for the table. Draws a realistic-looking felt table, wooden
// rails, pockets, glossy numbered balls, the cue stick + aim line, and the
// opponent's live ghost cue / cursor. Pure drawing — no game logic.

import {
  CUSHIONS,
  POCKET_LIST,
  R,
  TABLE,
  type Cushion,
  type Prediction,
  type Vec,
  type World,
} from "./physics";
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

/** Build a layout at a given px-per-metre, optionally rotated to portrait. */
export function layoutFor(scale: number, rotated = false): Layout {
  const rail = Math.max(22, scale * 0.09);
  const pw = (rotated ? TABLE.h : TABLE.w) * scale;
  const ph = (rotated ? TABLE.w : TABLE.h) * scale;
  return {
    scale,
    ox: rail,
    oy: rail,
    rail,
    rotated,
    pw,
    ph,
    W: pw + rail * 2,
    H: ph + rail * 2,
  };
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
};

export function drawScene(ctx: CanvasRenderingContext2D, s: Scene) {
  const l = s.layout;
  ctx.clearRect(0, 0, l.W, l.H);
  drawTable(ctx, l);

  // Aim assist — the spin-aware predicted path, shown only once power is being
  // dialled in (no preview at zero power).
  if (s.myAim && s.prediction && !s.animating) drawPrediction(ctx, l, s.prediction);
  if (s.opponent?.aim && !s.animating)
    drawGhostAim(ctx, l, s.world, s.opponent.aim);

  drawBalls(ctx, l, s.world, s.ballInHand ? 0 : -1);
  if (s.sinks) for (const sk of s.sinks) drawSink(ctx, l, sk);

  // Cue stick for the active player.
  if (s.myAim && s.showCue && !s.animating)
    drawCueStick(ctx, l, s.world, s.myAim);

  if (s.opponent?.cursor) drawCursor(ctx, l, s.opponent.cursor);
}

// A cushion drawn as an angled blue block. The nose (felt edge) spans the full
// collision extent [lo, hi]; the outer (rail) edge is narrower, so the ends
// come to jaw points aimed at the pockets — the classic cushion facing.
function cushionPoly(c: Cushion): [Vec, Vec, Vec, Vec] {
  const D = 0.05; // depth into the rail (blue band width)
  const F = 0.035; // jaw facing angle
  switch (c.rail) {
    case "ymin":
      return [
        { x: c.lo, y: 0 }, { x: c.hi, y: 0 },
        { x: c.hi - F, y: -D }, { x: c.lo + F, y: -D },
      ];
    case "ymax":
      return [
        { x: c.lo, y: TABLE.h }, { x: c.hi, y: TABLE.h },
        { x: c.hi - F, y: TABLE.h + D }, { x: c.lo + F, y: TABLE.h + D },
      ];
    case "xmin":
      return [
        { x: 0, y: c.lo }, { x: 0, y: c.hi },
        { x: -D, y: c.hi - F }, { x: -D, y: c.lo + F },
      ];
    default: // xmax
      return [
        { x: TABLE.w, y: c.lo }, { x: TABLE.w, y: c.hi },
        { x: TABLE.w + D, y: c.hi - F }, { x: TABLE.w + D, y: c.lo + F },
      ];
  }
}

function drawTable(ctx: CanvasRenderingContext2D, l: Layout) {
  // Black rail frame.
  const frame = ctx.createLinearGradient(0, 0, 0, l.H);
  frame.addColorStop(0, "#151515");
  frame.addColorStop(0.5, "#0b0b0b");
  frame.addColorStop(1, "#050505");
  ctx.fillStyle = frame;
  roundRect(ctx, 0, 0, l.W, l.H, l.rail * 0.8);
  ctx.fill();

  const px = l.ox;
  const py = l.oy;
  const pw = l.pw;
  const ph = l.ph;

  // Bright blue baize with a lit centre.
  const felt = ctx.createRadialGradient(
    px + pw * 0.45,
    py + ph * 0.4,
    Math.min(pw, ph) * 0.1,
    px + pw / 2,
    py + ph / 2,
    Math.max(pw, ph) * 0.72,
  );
  felt.addColorStop(0, "#28abe8");
  felt.addColorStop(1, "#1487c8");
  ctx.fillStyle = felt;
  ctx.fillRect(px, py, pw, ph);

  // Blue felt cushions: nose (felt side) shadowed, rail side lit; jaw points
  // aim at the pockets. A subtle dark crease sits at the nose.
  for (const c of CUSHIONS) {
    const poly = cushionPoly(c).map((p) => toPx(l, p));
    const noseMid = { x: (poly[0].x + poly[1].x) / 2, y: (poly[0].y + poly[1].y) / 2 };
    const backMid = { x: (poly[2].x + poly[3].x) / 2, y: (poly[2].y + poly[3].y) / 2 };
    const grad = ctx.createLinearGradient(noseMid.x, noseMid.y, backMid.x, backMid.y);
    grad.addColorStop(0, "#1a91cf");
    grad.addColorStop(1, "#2eaee6");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
    ctx.fill();
    // Nose crease shadow onto the felt.
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = Math.max(1, l.scale * 0.005);
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    ctx.lineTo(poly[1].x, poly[1].y);
    ctx.stroke();
  }

  // Pocket holes: the SAME circle the physics uses to pot, so visual == capture.
  for (const pk of POCKET_LIST) {
    const c = toPx(l, pk.center);
    const r = pk.hole * l.scale;
    const g = ctx.createRadialGradient(c.x, c.y, r * 0.2, c.x, c.y, r);
    g.addColorStop(0, "#000");
    g.addColorStop(1, "#0a0a0a");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(210,214,222,0.8)";
    ctx.lineWidth = Math.max(1.4, l.scale * 0.007);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // White sight dots on the black rail.
  ctx.fillStyle = "#e6e6de";
  const off = (l.rail * 0.5) / l.scale; // into the rail, in world units
  const dot = (p: Vec) => {
    const c = toPx(l, p);
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(1.4, l.scale * 0.009), 0, Math.PI * 2);
    ctx.fill();
  };
  for (let i = 1; i < 8; i++) {
    if (i === 4) continue; // side pocket
    const x = (TABLE.w * i) / 8;
    dot({ x, y: -off });
    dot({ x, y: TABLE.h + off });
  }
  for (let i = 1; i < 4; i++) {
    if (i === 2) continue;
    const y = (TABLE.h * i) / 4;
    dot({ x: -off, y });
    dot({ x: TABLE.w + off, y });
  }
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

function drawCueStick(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  world: World,
  aim: Aim,
) {
  const cue = world.balls[0];
  if (cue.potted) return;
  const c = toPx(l, cue.p);
  const rpx = R * l.scale;
  // Cue points opposite the travel direction; pull back by power.
  const ang = aim.angle + (l.rotated ? Math.PI / 2 : 0); // world dir -> screen dir
  const back = ang + Math.PI;
  const gap = rpx * (1.4 + aim.power * 3);
  const bx = c.x + Math.cos(back) * gap;
  const by = c.y + Math.sin(back) * gap;
  // A raised cue is foreshortened when viewed top-down.
  const tipLen = rpx * 18 * (0.25 + 0.75 * Math.cos(aim.elevation ?? 0));
  const ex = bx + Math.cos(back) * tipLen;
  const ey = by + Math.sin(back) * tipLen;

  const grad = ctx.createLinearGradient(bx, by, ex, ey);
  grad.addColorStop(0, "#d9b382");
  grad.addColorStop(1, "#6e4a24");
  ctx.strokeStyle = grad;
  ctx.lineWidth = rpx * 0.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  // Blue tip.
  ctx.strokeStyle = "#3a6ea5";
  ctx.lineWidth = rpx * 0.4;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx + Math.cos(back) * rpx * 0.6, by + Math.sin(back) * rpx * 0.6);
  ctx.stroke();
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
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
