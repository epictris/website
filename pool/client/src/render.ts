// Canvas renderer for the table. Draws a realistic-looking felt table, wooden
// rails, pockets, glossy numbered balls, and the active player's aim line. Pure
// drawing — no game logic. (Both cue sticks are DOM <img> overlays in Game.tsx;
// the opponent's presence shows only as their blue cue, no aim line or cursor.)

import {
  CUSHION_SEGS,
  CUSHION_VERTS,
  IDENT3,
  POCKET_DEPTH,
  POCKET_LIST,
  R,
  TABLE,
  type Mat3,
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
import { groupOf, type Group } from "./rules";

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
  onEight?: boolean; // shooter has cleared their group -> the 8 is a legal target
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
  if (s.myAim && s.prediction && !s.animating)
    drawPrediction(ctx, l, s.prediction, s.myGroup ?? null, s.onEight ?? false);

  drawBalls(ctx, l, s.world, s.ballInHand ? 0 : -1);
  if (s.sinks) for (const sk of s.sinks) drawSink(ctx, l, sk);

  // NB: both cue sticks are DOM <img> overlays in Game.tsx (so they can extend
  // past the canvas edge): the active player's own cue, and the opponent's blue
  // cue mirroring their aim. Neither is drawn here — and the opponent's raw
  // cursor is deliberately NOT shown (only their cue is).

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

// world = M · body, for a body-frame unit vector. The ball's z axis points UP
// out of the cloth toward the viewer (physics uses r = (0,0,-R) down), so a
// rotated point is on the visible near hemisphere when its world z > 0.
function applyM(m: Mat3, x: number, y: number, z: number) {
  return {
    x: m[0] * x + m[1] * y + m[2] * z,
    y: m[3] * x + m[4] * y + m[5] * z,
    z: m[6] * x + m[7] * y + m[8] * z,
  };
}

// A world-plane vector (world x,y) -> canvas pixel delta, matching toPx: portrait
// turns the table 90°, so a world (dx,dy) becomes screen (-dy,dx). z (out of the
// cloth) is untouched by that in-plane rotation, so depth carries straight over.
const dirPx = (rotated: boolean, vx: number, vy: number) =>
  rotated ? { x: -vy, y: vx } : { x: vx, y: vy };

// The stripe band: the true latitude band (within ±BAND_PHI of the equator that
// is perpendicular to the body y axis). It is filled as a ribbon between the two
// latitude edges rather than a fixed-width stroke, so it foreshortens correctly
// as the ball turns — a fixed-width stroke made the band (and the leftover white)
// warp wrongly. Where an edge dives behind the sphere the band is bounded by the
// silhouette, so a behind-hemisphere edge point is clamped to the rim. Handles
// every orientation: axis in the view plane -> a straight stripe; axis toward the
// viewer -> a ring near the rim. The white number spots (drawn after) sit on it.
const BAND_PHI = 0.42; // half-width of the band in radians (~24°)
function drawBand(
  ctx: CanvasRenderingContext2D,
  c: Vec,
  rpx: number,
  o: Mat3,
  rotated: boolean,
  color: string,
) {
  const a = applyM(o, 0, 1, 0); // band axis (body +y) in world
  // An orthonormal basis of the equator plane (perpendicular to a).
  const t = Math.abs(a.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
  let e1x = a.y * t.z - a.z * t.y;
  let e1y = a.z * t.x - a.x * t.z;
  let e1z = a.x * t.y - a.y * t.x;
  const e1n = Math.hypot(e1x, e1y, e1z) || 1e-9;
  e1x /= e1n;
  e1y /= e1n;
  e1z /= e1n;
  const e2x = a.y * e1z - a.z * e1y;
  const e2y = a.z * e1x - a.x * e1z;
  const e2z = a.x * e1y - a.y * e1x;

  const cp = Math.cos(BAND_PHI);
  const sp = Math.sin(BAND_PHI);
  const N = 72;
  ctx.fillStyle = color;

  // Project a surface point to the canvas; a point on the far hemisphere is
  // clamped out to the silhouette (its band edge is occluded by the rim there).
  const proj = (x: number, y: number, z: number): Vec => {
    const d = dirPx(rotated, x, y);
    if (z >= 0) return { x: c.x + d.x * rpx, y: c.y + d.y * rpx };
    const l = Math.hypot(d.x, d.y) || 1e-9;
    return { x: c.x + (d.x / l) * rpx, y: c.y + (d.y / l) * rpx };
  };

  let run: { A: Vec; B: Vec }[] = [];
  const flush = () => {
    if (run.length > 1) {
      ctx.beginPath();
      ctx.moveTo(run[0].A.x, run[0].A.y);
      for (let i = 1; i < run.length; i++) ctx.lineTo(run[i].A.x, run[i].A.y);
      for (let i = run.length - 1; i >= 0; i--) ctx.lineTo(run[i].B.x, run[i].B.y);
      ctx.closePath();
      ctx.fill();
    }
    run = [];
  };
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * Math.PI * 2;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const mx = ct * e1x + st * e2x; // equator (meridian) unit vector
    const my = ct * e1y + st * e2y;
    const mz = ct * e1z + st * e2z;
    // The two latitude edges of the band: cos·meridian ± sin·axis.
    const Az = cp * mz + sp * a.z;
    const Bz = cp * mz - sp * a.z;
    if (Az <= 1e-4 && Bz <= 1e-4) {
      flush(); // this whole slice of the band is behind the ball
      continue;
    }
    run.push({
      A: proj(cp * mx + sp * a.x, cp * my + sp * a.y, Az),
      B: proj(cp * mx - sp * a.x, cp * my - sp * a.y, Bz),
    });
  }
  flush();
}

// The numbered white spot(s). Each pole carries a tangent frame (a body-frame
// right + up axis on the ball's surface); rotating those by the orientation and
// projecting them orthographically gives an affine that spins AND warps the disc
// and its glyph exactly as the printed spot would turn on the real ball — the
// number squashes toward the silhouette and rotates under English. Both antipodal
// poles are drawn (nearer one on top) so the number swings in and out of view.
const NUM_FONT = 42; // nominal glyph px; the affine rescales it to the ball
// Lift a projected axis to a minimum length, keeping its direction, so a spot
// near the silhouette stays legible instead of foreshortening to a line.
function soften(v: Vec): Vec {
  const len = Math.hypot(v.x, v.y) || 1e-9;
  const f = Math.max(len, 0.45) / len;
  return { x: v.x * f, y: v.y * f };
}
function drawNumberSpots(
  ctx: CanvasRenderingContext2D,
  c: Vec,
  rpx: number,
  o: Mat3,
  rotated: boolean,
  id: number,
) {
  // n = pole (spot centre) direction; r,u = the spot's surface right/up axes.
  const poles = [
    { n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
    { n: [0, 0, -1], r: [1, 0, 0], u: [0, -1, 0] },
  ]
    .map((P) => {
      const n = applyM(o, P.n[0], P.n[1], P.n[2]);
      const rw = applyM(o, P.r[0], P.r[1], P.r[2]);
      const uw = applyM(o, P.u[0], P.u[1], P.u[2]);
      const nd = dirPx(rotated, n.x, n.y);
      return {
        z: n.z,
        x: c.x + nd.x * rpx,
        y: c.y + nd.y * rpx,
        // Projected surface axes (length <= 1) — they shorten with tilt, which is
        // the warp. Floored so a near-edge spot squishes but never collapses to a
        // sliver (a painted-on spot wraps the surface, so it keeps some width).
        r: soften(dirPx(rotated, rw.x, rw.y)),
        u: soften(dirPx(rotated, uw.x, uw.y)),
      };
    })
    .sort((a, b) => a.z - b.z); // nearer (higher z) drawn last, on top

  const label = String(id);
  const k = (rpx * 0.7) / NUM_FONT; // font px -> ball px, so the glyph fits the spot
  for (const p of poles) {
    // Fade the spot in across the horizon so it rolls into view from the rim
    // instead of popping in at full opacity (its antipode fades out in step).
    const fade = Math.min(1, Math.max(0, (p.z - 0.02) / 0.22));
    if (fade <= 0) continue;
    ctx.save();
    ctx.globalAlpha = fade;
    // White spot: ellipse from the two projected axes (skew ignored, disc-only).
    ctx.beginPath();
    ctx.fillStyle = "#f4f1ea";
    ctx.ellipse(
      p.x,
      p.y,
      rpx * 0.42 * Math.hypot(p.r.x, p.r.y),
      rpx * 0.42 * Math.hypot(p.u.x, p.u.y),
      Math.atan2(p.r.y, p.r.x),
      0,
      Math.PI * 2,
    );
    ctx.fill();
    // Glyph: full affine (columns = images of the glyph's x/y axes) so it rotates
    // and warps with the surface. Composes onto the existing dpr transform.
    ctx.translate(p.x, p.y);
    ctx.transform(k * p.r.x, k * p.r.y, k * p.u.x, k * p.u.y, 0, 0);
    ctx.fillStyle = "#111";
    ctx.font = `${NUM_FONT}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }
}

// Cue ball: two black dots on opposite ends of the body x axis. One is on the
// near face while the other is round the back, so a dot slides across the ball
// (rolling) or orbits the centre (English), making the spin plainly visible.
function drawCueDots(
  ctx: CanvasRenderingContext2D,
  c: Vec,
  rpx: number,
  o: Mat3,
  rotated: boolean,
) {
  for (const s of [1, -1]) {
    const w = applyM(o, s, 0, 0);
    // Fade across the horizon so a dot rolls into view instead of popping in.
    const fade = Math.min(1, Math.max(0, (w.z - 0.02) / 0.22));
    if (fade <= 0) continue;
    const f = 0.4 + 0.6 * w.z;
    const d = dirPx(rotated, w.x, w.y);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = "#111417";
    ctx.beginPath();
    ctx.arc(c.x + d.x * rpx, c.y + d.y * rpx, rpx * 0.2 * f, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Draw a single glossy numbered ball at pixel centre c, radius rpx, alpha. */
function drawBall(
  ctx: CanvasRenderingContext2D,
  c: Vec,
  id: number,
  rpx: number,
  alpha: number,
  o: Mat3,
  rotated: boolean,
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

  // Body colour: stripes are a white ball wearing a coloured band; solids and the
  // eight are the full hue; the cue is off-white.
  const stripe = id > 8;
  const base = id === 0 ? "#f4f1ea" : stripe ? "#f4f1ea" : HUE[id];
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

  // Surface markings turn with the ball's orientation; clip them to the sphere.
  ctx.save();
  ctx.beginPath();
  ctx.arc(c.x, c.y, rpx, 0, Math.PI * 2);
  ctx.clip();
  if (stripe) drawBand(ctx, c, rpx, o, rotated, HUE[id - 8]);
  if (id === 0) drawCueDots(ctx, c, rpx, o, rotated);
  else drawNumberSpots(ctx, c, rpx, o, rotated, id);
  ctx.restore();

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
    drawBall(ctx, toPx(l, b.p), b.id, rpx, b.id === translucentId ? 0.55 : 1, b.o ?? IDENT3, l.rotated);
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
  drawBall(ctx, c, sk.id, Math.max(1, rpx * (1 - 0.82 * sk.t)), 1 - sk.t, IDENT3, l.rotated, false);
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

const MIN_OBJ_LEN = 0.05; // struck-ball preview floor: ~5cm in table metres.

// Guarantee the struck-ball line spans at least MIN_OBJ_LEN by extending its
// endpoint along the ball's heading (start→end direction). Short paths get a
// visible direction hint; longer ones pass through unchanged.
function liftObjectPath(pts: Vec[]): Vec[] {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len >= MIN_OBJ_LEN || len < 1e-9) return pts;
  const f = MIN_OBJ_LEN / len;
  return [a, { x: a.x + dx * f, y: a.y + dy * f }];
}

/** Draw the spin-aware predicted paths (from the real engine preview). */
function drawPrediction(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  pr: Prediction,
  myGroup: Group | null,
  onEight: boolean,
) {
  const rpx = R * l.scale;
  ctx.save();

  // Cue-ball path up to first contact — dashed white; captures the spin curve.
  ctx.strokeStyle = "rgba(255,255,255,0.82)";
  ctx.lineWidth = 1.6;
  ctx.setLineDash([6, 5]);
  polyline(ctx, l, pr.cue);
  ctx.setLineDash([]);

  // A predicted foul: cue ball scratches, or first contact is an opponent ball.
  const oppHit =
    myGroup !== null &&
    pr.objectId !== undefined &&
    groupOf(pr.objectId) !== myGroup &&
    groupOf(pr.objectId) !== "eight";
  // Hitting the 8 first is a foul unless the shooter is on the 8 (group cleared).
  const eightHit =
    pr.objectId !== undefined && groupOf(pr.objectId) === "eight" && !onEight;
  const foul = pr.cuePotted || oppHit || eightHit;

  // Struck ball's initial travel — solid white line from its centre. Suppressed
  // on a predicted foul (the shot is illegal, so its outcome isn't previewed).
  if (!foul && pr.object && pr.object.length > 1) {
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.6;
    // The trace is only a ~0.02s burst, so a slow struck ball barely moves and
    // its line vanishes. Lift it to a legible minimum length along its heading.
    polyline(ctx, l, liftObjectPath(pr.object));
  }

  // Ghost cue ball at first contact — red ring when the shot is a predicted foul.
  if (pr.ghost) {
    const g = toPx(l, pr.ghost);
    ctx.beginPath();
    ctx.strokeStyle = foul ? "#f08778" : "rgba(255,255,255,0.7)";
    ctx.arc(g.x, g.y, rpx, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Foul cross (red X). Drawn where the cue ball ends up:
  //  - a scratch: cue ball falls straight into a pocket, or
  //  - first contact is one of the opponent's balls (a wrong-ball-first foul),
  //    marked in the ghost cue circle at the moment of contact.
  const crossAt = pr.cuePotted
    ? pr.cue.length
      ? pr.cue[pr.cue.length - 1]
      : null
    : oppHit || eightHit
      ? pr.ghost
      : null;
  if (crossAt) {
    const c = toPx(l, crossAt);
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
