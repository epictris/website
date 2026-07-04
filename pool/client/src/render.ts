// Canvas renderer for the table. Draws a realistic-looking felt table, wooden
// rails, pockets, glossy numbered balls, the cue stick + aim line, and the
// opponent's live ghost cue / cursor. Pure drawing — no game logic.

import {
  POCKETS,
  POCKET_R,
  R,
  TABLE,
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

  // Cue stick for the active player.
  if (s.myAim && s.showCue && !s.animating)
    drawCueStick(ctx, l, s.world, s.myAim);

  if (s.opponent?.cursor) drawCursor(ctx, l, s.opponent.cursor);
}

function drawTable(ctx: CanvasRenderingContext2D, l: Layout) {
  const w = l.W;
  const h = l.H;
  // Wooden rail frame.
  const wood = ctx.createLinearGradient(0, 0, 0, h);
  wood.addColorStop(0, "#5a3a22");
  wood.addColorStop(0.5, "#7a4e2d");
  wood.addColorStop(1, "#4a2f1b");
  ctx.fillStyle = wood;
  roundRect(ctx, 0, 0, w, h, l.rail * 0.5);
  ctx.fill();

  // Felt (play-area pixel box already accounts for rotation).
  const px = l.ox;
  const py = l.oy;
  const pw = l.pw;
  const ph = l.ph;
  const felt = ctx.createRadialGradient(
    px + pw / 2,
    py + ph / 2,
    Math.min(pw, ph) * 0.1,
    px + pw / 2,
    py + ph / 2,
    Math.max(pw, ph) * 0.7,
  );
  felt.addColorStop(0, "#1f7a4d");
  felt.addColorStop(1, "#15603b");
  ctx.fillStyle = felt;
  ctx.fillRect(px, py, pw, ph);

  // Cushion inner bevel shadow.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = Math.max(2, l.scale * 0.02);
  ctx.strokeRect(px, py, pw, ph);

  // Diamond sights — placed in world space just outside each cushion and run
  // through toPx, so they follow the rotation automatically. Long rails (along
  // world x) get 8 divisions, short rails (along world y) get 4.
  ctx.fillStyle = "rgba(240,235,220,0.85)";
  const off = (l.rail * 0.5) / l.scale; // half-rail, in world units
  const diamond = (p: Vec) => {
    const c = toPx(l, p);
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(1.5, l.scale * 0.012), 0, Math.PI * 2);
    ctx.fill();
  };
  for (let i = 1; i < 8; i++) {
    if (i === 4) continue; // side pocket, no sight
    const x = (TABLE.w * i) / 8;
    diamond({ x, y: -off });
    diamond({ x, y: TABLE.h + off });
  }
  for (let i = 1; i < 4; i++) {
    if (i === 2) continue;
    const y = (TABLE.h * i) / 4;
    diamond({ x: -off, y });
    diamond({ x: TABLE.w + off, y });
  }

  // Pockets.
  for (const pk of POCKETS) {
    const c = toPx(l, pk);
    ctx.beginPath();
    ctx.fillStyle = "#0a0a0a";
    ctx.arc(c.x, c.y, POCKET_R * l.scale * 1.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = l.scale * 0.02;
    ctx.stroke();
  }
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
    const c = toPx(l, b.p);

    // Drop shadow.
    ctx.beginPath();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.ellipse(c.x + rpx * 0.15, c.y + rpx * 0.35, rpx, rpx * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    if (b.id === translucentId) ctx.globalAlpha = 0.55;

    // Body with a light source top-left.
    const base = ballColor(b.id);
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

    // Stripe band.
    if (b.id > 8) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(c.x, c.y, rpx, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = "#f4f1ea";
      ctx.fillRect(c.x - rpx, c.y - rpx * 0.45, rpx * 2, rpx * 0.9);
      ctx.restore();
    }

    // Number pip (skip on the cue ball).
    if (b.id !== 0) {
      ctx.beginPath();
      ctx.fillStyle = "#f4f1ea";
      ctx.arc(c.x, c.y, rpx * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#111";
      ctx.font = `${Math.max(6, rpx * 0.55)}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(b.id), c.x, c.y + rpx * 0.02);
    }

    // Specular highlight.
    ctx.beginPath();
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.ellipse(
      c.x - rpx * 0.35,
      c.y - rpx * 0.4,
      rpx * 0.28,
      rpx * 0.18,
      -0.6,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.restore();
  }
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
