// Canvas renderer for the table. Draws a realistic-looking felt table, wooden
// rails, pockets, glossy numbered balls, and the active player's aim line. Pure
// drawing — no game logic. (Both cue sticks are DOM <img> overlays in Game.tsx;
// the opponent's presence shows only as their blue cue, no aim line or cursor.)

import {
  CUSHION_SEGS,
  CUSHION_VERTS,
  currentGeo,
  geoFor,
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

// Each variant's table is a photo. `mmPerPx` is the ONE image→world scale: how
// many world millimetres one image pixel spans. `fx,fy` is the measured pixel of
// the felt-box origin (top-left cushion nose). The felt box SIZE is not stored —
// it's derived from the real felt (feltWidth×feltHeight mm ÷ mmPerPx), so tuning
// feltWidth/feltHeight resizes the PLAYFIELD and never rescales the drawn photo;
// mmPerPx alone governs how the image maps to the world. CROP = the tight opaque
// box (wooden rails), used to size the canvas so the table fills it.
type TableArt = {
  IMG: { W: number; H: number; fx: number; fy: number };
  mmPerPx: number; // world mm per image pixel
  CROP: { x: number; y: number; w: number; h: number };
};
const ART: Record<Variant, TableArt> = {
  pool: {
    IMG: { W: 2391, H: 1793, fx: 270, fy: 457 },
    mmPerPx: 1981 / 1828, // felt spans 1902 px = feltWidth 1981 mm
    CROP: { x: 146, y: 332, w: 2078, h: 1164 },
  },
  // Snooker photo (1600×848): felt-nose origin measured off the cushion-nose
  // shadow line (fx48 fy48); felt spans 1504 px = feltWidth 3569 mm.
  snooker: {
    IMG: { W: 1600, H: 848, fx: 48, fy: 48 },
    mmPerPx: 3569 / 1504,
    CROP: { x: 0, y: 0, w: 1600, h: 848 },
  },
};
// The felt pixel box: measured origin (fx,fy) + a size derived from the real felt
// size through mmPerPx. This is the single place feltWidth/feltHeight touch the
// image — and only to place the world's felt corners on the photo, never to
// stretch it (m11==m22==scale·mmPerPx in drawTable, independent of felt size).
function feltPx(variant: Variant): { fx: number; fy: number; fw: number; fh: number } {
  const { IMG, mmPerPx } = ART[variant];
  const g = geoFor(variant);
  return { fx: IMG.fx, fy: IMG.fy, fw: g.feltWidth / mmPerPx, fh: g.feltHeight / mmPerPx };
}
// Ball-return gutter geometry, expressed in ball radii (rpx). Shared by layoutFor
// (which reserves the vertical gap for it) and drawRack (which draws it). The
// channel holds a ball (radius 1) with ~a rail width of clearance to the inner
// rail on each side; the outer rail is spaced out past that.
const G_RAIL_W = 0.16; // base rail width unit
const G_HALF = 1 + G_RAIL_W * 1.5; // channel half-height (ball + the peeking rail)
const G_DROP = 0.35; // clearance between the table's bottom edge and the gutter
const G_BELOW = G_DROP + 2 * G_HALF + G_RAIL_W; // total gutter extent below the table (rpx)
// Constant speed (world mm/sec) a potted ball rolls down the return track.
// Distance-based, not time-based, so every ball rolls at the same pace whatever
// its slot.
const ROLL_MPS = 384;
// One <img> per variant, lazily loaded and cached by variant so switching tables
// (or a mixed set of tabs) never re-fetches or cross-wires the photos.
const tableImgs: Partial<Record<Variant, HTMLImageElement>> = {};
const tableReady: Partial<Record<Variant, boolean>> = {};
function ensureTableImg(variant: Variant) {
  if (tableImgs[variant] || typeof Image === "undefined") return;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => (tableReady[variant] = true);
  img.src = TABLE_IMG[variant];
  tableImgs[variant] = img;
}
import { groupOf, type Group } from "./rules";
import { TABLE_IMG, type Variant } from "./variant";
import { isColour } from "./physics";

export type Layout = {
  scale: number; // px per world millimetre
  ox: number; // origin x (px) of play area
  oy: number;
  rail: number; // rail thickness (px)
  rotated: boolean; // portrait: table turned 90° (long axis vertical)
  pw: number; // play-area pixel width
  ph: number; // play-area pixel height
  W: number; // full canvas css width
  H: number; // full canvas css height
  imgLeft: number; // px offset from felt origin (ox) to the table image's opaque left edge (minx, ≤0)
  imgRight: number; // px offset from felt origin (ox) to the table image's opaque right edge (maxx)
  imgBottom: number; // px offset from felt origin (oy) to the table image's opaque bottom edge (maxy)
  gutter: number; // px depth of the ball-return gutter reserved below the table (rackPx)
};

/**
 * Build a layout at a given px-per-metre, optionally rotated to portrait. The
 * canvas is sized to hold the whole table PHOTO: the felt box maps onto the play
 * area, and the surrounding wooden rails extend outside it. Rail widths come
 * straight from the image, so the canvas is bigger than the bare playfield.
 */
export function layoutFor(scale: number, rotated = false, variant: Variant = "pool"): Layout {
  const { CROP } = ART[variant];
  const IMG = feltPx(variant);
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
  // Shift world (0,0) so the image starts at the canvas origin. `gutter` is the
  // pixel extent the ball-return track occupies BELOW the table — reserved by
  // resize() as the bottom gap; the felt mapping itself is untouched.
  const gutterPx = variant === "snooker" ? 0 : G_BELOW * R * scale;
  const ox = rotated ? -minx - Hpx : -minx;
  const oy = -miny;
  const pw = (rotated ? TABLE.h : TABLE.w) * scale;
  const ph = (rotated ? TABLE.w : TABLE.h) * scale;
  return { scale, ox, oy, rail: 0, rotated, pw, ph, W: maxx - minx, H: maxy - miny, imgLeft: minx, imgRight: maxx, imgBottom: maxy, gutter: gutterPx };
}

// World -> pixel. Landscape is a straight scale; portrait applies a proper 90°
// rotation (determinant +1, so chirality — and thus the sense of English — is
// preserved). Glyphs (ball numbers) are drawn at these points but not rotated,
// so they stay upright.
const toPx = (l: Layout, p: Vec) =>
  l.rotated
    ? { x: l.ox + (TABLE.h - p.y) * l.scale, y: l.oy + p.x * l.scale }
    : { x: l.ox + p.x * l.scale, y: l.oy + p.y * l.scale };

// ── Cue stick ───────────────────────────────────────────────────────────────
// Drawn straight onto the table canvas (in painter's order with the balls), so
// over/under the cue ball is just draw order — no DOM overlay, no occluder.
export type CueBand = { dark: string; light: string };
export type CueDraw = {
  at: Vec; // cue-ball centre (or a frozen strike point)
  angle: number; // world aim angle
  power: number; // 0..1 pull-back
  elevation: number; // radians
  side: number; // english −1..1
  follow: number; // follow/draw −1..1
  band: CueBand; // red (you) / blue (opponent)
};
const CUE_CURVE = 1.0; // how hard the colour rings bow toward the tip when reared
const CUE_PULL_TILT = 0.4; // rad of butt-toward-camera lift at full pull, vertical cue
const CUE_PULL_ZOOM = 0.3; // extra scale at full pull, vertical cue

// Straight rod bitmap (tip at top-centre, pointing down), foreshortened by
// elevation. Reused offscreen canvas. Ported verbatim from the old DOM cue.
let rodEl: HTMLCanvasElement | null = null;
function rodBitmap(sizeCss: number, dpr: number, elev: number, band: CueBand) {
  const px = Math.max(1, Math.round(sizeCss * dpr));
  if (!rodEl) rodEl = document.createElement("canvas");
  const canvas = rodEl;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const S = sizeCss;
  const cx = S / 2;
  const tipR = S * 0.0072;
  const buttR = S * 0.0168 * (1 + 0.9 * (1 - Math.cos(elev)));
  const len = S * 0.9358 * Math.cos(elev);
  ctx.beginPath();
  ctx.moveTo(cx - tipR, tipR);
  ctx.lineTo(cx - buttR, len);
  ctx.arc(cx, len, buttR, Math.PI, 0, true);
  ctx.lineTo(cx + tipR, tipR);
  ctx.arc(cx, tipR, tipR, 0, Math.PI, true);
  ctx.closePath();
  ctx.save();
  ctx.clip();
  const sinE = Math.sin(elev);
  const localR = (y: number) =>
    tipR + (buttR - tipR) * Math.max(0, Math.min(1, y / len));
  const fillFromRing = (yBase: number, color: string) => {
    const r = localR(yBase);
    const amp = r * sinE * CUE_CURVE;
    ctx.beginPath();
    const N = 26;
    for (let i = 0; i <= N; i++) {
      const x = -buttR + 2 * buttR * (i / N);
      const u = r > 0 ? x / r : 2;
      const dip = Math.abs(u) < 1 ? amp * Math.sqrt(1 - u * u) : 0;
      const pt = { x: cx + x, y: yBase - dip };
      i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y);
    }
    ctx.lineTo(cx + buttR, len + buttR);
    ctx.lineTo(cx - buttR, len + buttR);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  fillFromRing(0, "#93685b");
  fillFromRing(len * 0.0106, "#f4efda");
  fillFromRing(len * 0.0481, "#e3c3a6");
  fillFromRing(len * 0.6107, "#1d1d1b");
  fillFromRing(len * 0.642, band.light);
  fillFromRing(len * 0.9363, "#1d1d1b");
  const stripes: [number, number, string][] = [
    [0.0, 0.16, "rgba(0,0,0,0.42)"],
    [0.16, 0.34, "rgba(0,0,0,0.18)"],
    [0.74, 0.86, "rgba(0,0,0,0.2)"],
    [0.86, 1.0, "rgba(0,0,0,0.44)"],
  ];
  for (const [a, b, color] of stripes) {
    ctx.fillStyle = color;
    ctx.fillRect(cx - buttR + a * buttR * 2, 0, (b - a) * buttR * 2, len + buttR);
  }
  ctx.restore();
  return canvas;
}

// A straight (elevation 0) cue sprite as a data URL — tip at the top, butt at the
// bottom — wrapped in the given band colour. The power widget uses this so its
// cue matches the on-table cue's colour instead of a fixed red PNG. Allocates a
// bitmap each call; cache the result by colour at the call site.
export function cueSpriteDataURL(band: CueBand, sizeCss = 300): string {
  return rodBitmap(sizeCss, 2, 0, band).toDataURL();
}

// Tip screen position + aim-back direction + whether the tip passes under the
// ball. Mirrors the old positionCue contact geometry (see its comment).
export function cueContact(l: Layout, d: CueDraw) {
  const rpx = R * l.scale;
  const b = toPx(l, d.at);
  const scr = d.angle + (l.rotated ? Math.PI / 2 : 0);
  const back = scr + Math.PI;
  const kf = 0.5 * d.follow;
  const ks = 0.5 * d.side;
  const c = Math.sqrt(Math.max(0, 1 - kf * kf - ks * ks));
  const reach = rpx * (c * Math.cos(d.elevation) - kf * Math.sin(d.elevation));
  const perp = back + Math.PI / 2;
  const across = -rpx * ks;
  return {
    back,
    under: c * Math.sin(d.elevation) + kf * Math.cos(d.elevation) < 0,
    tipX: b.x + Math.cos(back) * reach + Math.cos(perp) * across,
    tipY: b.y + Math.sin(back) * reach + Math.sin(perp) * across,
  };
}

// Draw the cue onto the main canvas. The pull-back (butt lifting toward the
// camera on a reared cue) is faked by foreshortening the rod along its length
// (butt lifts toward the camera → appears shorter) plus a slight zoom — a single
// seamless blit, so the rounded butt stays curved and never splits into strips.
export function drawCue(ctx: CanvasRenderingContext2D, l: Layout, d: CueDraw) {
  const { tipX, tipY, back } = cueContact(l, d);
  const rpx = R * l.scale;
  const size = rpx * 32;
  const rod = rodBitmap(size, ctx.getTransform().a || 1, d.elevation, d.band);
  const pull = d.power * 6 * rpx;
  const slide = pull * Math.cos(d.elevation); // pull-back gap along the aim
  const tilt = d.power * Math.sin(d.elevation) * CUE_PULL_TILT;
  const zoom = 1 + d.power * Math.sin(d.elevation) * CUE_PULL_ZOOM;
  const fore = Math.cos(tilt); // pull-tilt foreshortens the rod toward the camera
  ctx.save();
  ctx.translate(tipX, tipY);
  ctx.rotate(back - Math.PI / 2); // local +y now points down the cue (away from aim)
  ctx.scale(zoom, zoom);
  ctx.drawImage(rod, 0, 0, rod.width, rod.height, -size / 2, slide, size, size * fore);
  ctx.restore();
}

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

// Debug overlay layer toggles — each collider type can be shown/hidden.
export type DebugLayers = {
  cushions: boolean; // red cushion faces
  normals: boolean; // salmon inward-normal ticks
  pockets: boolean; // green pot circles
  sinks: boolean; // pink sink polygons
  walls: boolean; // orange outer rattle walls
  balls: boolean; // yellow/cyan per-ball loci
};
export const DEBUG_LAYERS_ALL: DebugLayers = {
  cushions: true, normals: true, pockets: true, sinks: true, walls: true, balls: true,
};

export type Scene = {
  world: World;
  layout: Layout;
  variant?: Variant; // pool (default) selects the table photo + ball styling
  myAim?: Aim; // shown while it is my turn to aim
  prediction?: Prediction; // spin-aware predicted paths for my shot
  showCue?: boolean; // draw the physical cue stick behind the ball
  ballInHand?: boolean;
  growCue?: boolean; // draw the cue ball enlarged (grabbed for ball-in-hand)
  cue?: CueDraw; // the on-table cue stick (own aim, opponent's, or strike linger)
  myGroup?: Group | null;
  onEight?: boolean; // shooter has cleared their group -> the 8 is a legal target
  opponent?: { cursor?: Vec; aim?: Aim };
  pointers?: { pos: Vec; color: string }[]; // each drawer's live pointing-finger
  strokes?: { pts: Vec[]; erase: number; color: string }[]; // dotted paths; `erase`=fraction wiped from the start
  emojis?: { ch: string; pos: Vec; scale: number }[]; // dragged-out emoji stamps
  animating?: boolean;
  sinks?: Sink[]; // balls mid-drop into a pocket
  rack?: RackEntry[]; // potted balls collected in the return track, in pot order
  now?: number; // wall-clock ms, for driving rack roll animations
  debug?: boolean; // overlay the real collision geometry
  debugLayers?: DebugLayers; // which collider types to show (defaults to all)
  debugCursor?: Vec; // world coords under the cursor, shown as a readout (debug)
  debugCopied?: boolean; // flash "copied" in the readout after a click-to-copy
};

// One ball resting in (or rolling into) the return track. `rollStart` is the ms
// at which it emerges at the top of the track; before that it's still "under the
// table" (mid pocket-drop) and isn't drawn. Order in the array = slot order.
export type RackEntry = { id: number; rollStart: number };

export function drawScene(ctx: CanvasRenderingContext2D, s: Scene) {
  const l = s.layout;
  const variant = s.variant ?? "pool";
  ctx.clearRect(0, 0, l.W, l.H);
  ensureTableImg(variant);
  // Gutter BEFORE the table so the L-bend entry rails tuck up under the table
  // (the opaque table image drawn next covers them above its bottom edge).
  // Snooker has no ball-return track — potted balls stay in the pocket.
  if (variant !== "snooker") drawRack(ctx, l, s.rack ?? [], s.now ?? 0, variant);
  drawTable(ctx, l, variant);

  // Object balls first; the cue ball + cue stick go down in painter's order so
  // "tip under/over the ball" is just which one is drawn last — no occluder.
  drawBalls(ctx, l, s.world, s.ballInHand ? 0 : -1, s.growCue ? 2.88 : 1, true, variant);
  const cb = s.world.balls[0];
  const drawCueBall = () => {
    if (cb.potted) return;
    const rpx = R * l.scale * (s.growCue ? 2.88 : 1);
    drawBall(ctx, toPx(l, cb.p), 0, rpx, s.ballInHand ? 0.55 : 1, cb.o ?? IDENT3, l.rotated, true, variant);
  };
  const under = s.cue ? cueContact(l, s.cue).under : false;
  if (s.cue && under) {
    drawCue(ctx, l, s.cue); // tip under the ball → cue first
    drawCueBall();
  } else {
    drawCueBall();
    if (s.cue) drawCue(ctx, l, s.cue); // tip over the ball → cue last
  }
  if (s.sinks) for (const sk of s.sinks) drawSink(ctx, l, sk, variant);

  // Aim assist — the spin-aware predicted path, shown only once power is being
  // dialled in (no preview at zero power). Drawn AFTER the balls so the lines
  // (cue path, ghost, struck-ball ray) sit on top of them, not under.
  if (s.myAim && s.prediction && !s.animating)
    drawPrediction(ctx, l, s.prediction, s.myGroup ?? null, s.onEight ?? false);

  // NB: both cue sticks are DOM <img> overlays in Game.tsx (so they can extend
  // past the canvas edge): the active player's own cue, and the opponent's blue
  // cue mirroring their aim. Neither is drawn here — and the opponent's raw
  // cursor is deliberately NOT shown (only their cue is).

  // Live annotation from the waiting player: dotted paths under a pointing finger.
  if (s.strokes && s.strokes.length) drawStrokes(ctx, l, s.strokes);
  if (s.pointers) for (const p of s.pointers) drawPointer(ctx, l, p.pos);
  if (s.emojis) for (const e of s.emojis) drawEmoji(ctx, l, e);

  if (s.debug) drawDebugOverlay(ctx, l, s.world, variant, s.debugLayers);
  if (s.debug && s.debugCursor) drawCursorReadout(ctx, l, s.debugCursor, s.debugCopied);
}

// Debug: a little popup above the cursor showing its world coordinates, so
// pocket-polygon points can be read straight off the table. Flashes "copied"
// after a click-to-copy.
function drawCursorReadout(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  w: Vec,
  copied?: boolean,
) {
  const c = toPx(l, w);
  const label = copied
    ? `✓ ${w.x.toFixed(3)}, ${w.y.toFixed(3)}`
    : `${w.x.toFixed(3)}, ${w.y.toFixed(3)}`;
  ctx.save();
  ctx.font = "12px monospace";
  ctx.textBaseline = "middle";
  const padX = 5;
  const tw = ctx.measureText(label).width;
  const bx = c.x - tw / 2 - padX;
  const by = c.y - 26;
  const accent = copied ? "rgba(57,255,136,0.95)" : "rgba(255,90,220,0.9)";
  ctx.fillStyle = "rgba(0,0,0,0.8)";
  ctx.fillRect(bx, by - 9, tw + padX * 2, 18);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by - 9, tw + padX * 2, 18);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.fillText(label, c.x, by);
  // Crosshair at the exact point.
  ctx.strokeStyle = accent;
  ctx.beginPath();
  ctx.moveTo(c.x - 6, c.y);
  ctx.lineTo(c.x + 6, c.y);
  ctx.moveTo(c.x, c.y - 6);
  ctx.lineTo(c.x, c.y + 6);
  ctx.stroke();
  ctx.restore();
}

// The waiting player's dragged annotation paths — dotted accent lines on the
// felt. Each stroke carries its own alpha so a released stroke can fade out.
function drawStrokes(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  strokes: { pts: Vec[]; erase: number; color: string }[],
) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([2, l.scale * 26]); // fine dots (26 mm pitch)
  const under = Math.max(3.5, l.scale * 9);
  const top = Math.max(2.5, l.scale * 6);
  for (const s of strokes) {
    // Wipe the leading `erase` fraction of the path so the line undoes itself
    // from its start toward where the drawer released.
    const { pts, cut } = s.erase > 0 ? trimFromStart(s.pts, s.erase) : { pts: s.pts, cut: 0 };
    if (pts.length < 2) continue;
    // Shift the dash phase by the erased world-length (in px) so the dots stay
    // fixed in space and simply vanish — rather than sliding toward the end.
    ctx.lineDashOffset = cut * l.scale;
    // Dark underlay so the colour reads on light felt, then bright dots on top in
    // the author's profile colour.
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = under;
    polyline(ctx, l, pts);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = top;
    polyline(ctx, l, pts);
  }
  ctx.lineDashOffset = 0;
  ctx.setLineDash([]);
  ctx.restore();
}

// Drop the leading `frac` (0..1) of a polyline's arc length, interpolating the
// new first point so the cut advances smoothly. Returns the remaining tail plus
// the removed world-length `cut` (used to keep the dash pattern stationary).
function trimFromStart(pts: Vec[], frac: number): { pts: Vec[]; cut: number } {
  if (frac >= 1 || pts.length < 2) return { pts: [], cut: 0 };
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const cut = total * frac;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + seg >= cut) {
      const t = seg > 0 ? (cut - acc) / seg : 0;
      const start = {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
      };
      return { pts: [start, ...pts.slice(i)], cut };
    }
    acc += seg;
  }
  return { pts: [], cut };
}

// The waiting player's live pointing finger, tip pinned to the touched point.
function drawPointer(ctx: CanvasRenderingContext2D, l: Layout, p: Vec) {
  const c = toPx(l, p);
  const size = R * l.scale * 2.6;
  ctx.save();
  ctx.font = `${size}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom"; // 👇 tip sits at the glyph's bottom edge, on the point
  ctx.fillText("👇", c.x, c.y);
  ctx.restore();
}

// A dragged-out emoji stamp, centred on its world point and scaled by its
// spawn/despawn animation (Game.tsx drives the scale).
function drawEmoji(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  e: { ch: string; pos: Vec; scale: number },
) {
  if (e.scale <= 0) return;
  const c = toPx(l, e.pos);
  const size = R * l.scale * 3 * e.scale;
  ctx.save();
  ctx.font = `${size}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(e.ch, c.x, c.y);
  ctx.restore();
}

// Overlay the collision boundaries the physics ACTUALLY uses. Cushions are the
// felt-surface polygon a ball's edge strikes (the physics insets by R on the
// fly, so these lines ARE the collision faces). Convex corners are drawn as
// R-circles: a ball centre rounds them, which is how it rebounds off a nose/jaw
// tip at any angle. Pockets are a pure centre test whose circle is the hole.
function drawDebugOverlay(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  world: World,
  variant: Variant,
  layers?: DebugLayers,
) {
  const L = layers ?? DEBUG_LAYERS_ALL;
  ctx.save();
  ctx.lineWidth = Math.max(0.5, l.scale * 2);

  // Cushion contact surface — the nose + angled jaws a ball's edge strikes, on
  // the true felt surface. Salmon ticks show each face's inward normal.
  if (L.cushions || L.normals) {
    for (const s of CUSHION_SEGS) {
      if (L.cushions) {
        ctx.strokeStyle = "#ff3b3b";
        const a = toPx(l, s.a);
        const b = toPx(l, s.b);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      if (L.normals) {
        const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
        const m = toPx(l, mid);
        const n = toPx(l, { x: mid.x + s.nx * 20, y: mid.y + s.ny * 20 });
        ctx.strokeStyle = "rgba(255,120,120,0.7)";
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(n.x, n.y);
        ctx.stroke();
      }
    }
    // Fillet arcs (r > 0 verts) — a TRUE curved collider, sampled only for drawing.
    // The tip verts (r = 0) are point-circles rounded by R; not drawn.
    if (L.cushions) {
      ctx.strokeStyle = "#ff3b3b";
      for (const vt of CUSHION_VERTS) {
        if (vt.r <= 0) continue;
        const a1 = Math.atan2(vt.n1y, vt.n1x);
        let da = Math.atan2(vt.n2y, vt.n2x) - a1;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        ctx.beginPath();
        const N = 14;
        for (let i = 0; i <= N; i++) {
          const ang = a1 + (da * i) / N;
          const p = toPx(l, { x: vt.x + vt.r * Math.cos(ang), y: vt.y + vt.r * Math.sin(ang) });
          i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
    }
  }

  // Pocket pot circles — a centre inside this drops the ball.
  if (L.pockets) {
    ctx.strokeStyle = "#39ff88";
    for (const pk of POCKET_LIST) {
      const c = toPx(l, pk.center);
      ctx.beginPath();
      ctx.arc(c.x, c.y, pk.hole * l.scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Sink polygons — the hole shape a potted ball rattles inside.
  if (L.sinks) {
    ctx.strokeStyle = "rgba(255,90,220,0.9)";
    ctx.fillStyle = "rgba(255,90,220,0.9)";
    for (const pk of POCKET_LIST) {
      const poly = sinkPoly(pk.center, variant);
      ctx.beginPath();
      poly.forEach((v, i) => {
        const p = toPx(l, v);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.stroke();
      for (const v of poly) {
        const p = toPx(l, v);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2); // vertex markers
        ctx.fill();
      }
    }
  }

  // Hard outer pocket walls — where a centre reflects if it misses the hole.
  if (L.walls) {
    ctx.strokeStyle = "rgba(255,170,40,0.8)";
    const wall = toPx(l, { x: -POCKET_DEPTH, y: -POCKET_DEPTH });
    const wall2 = toPx(l, { x: TABLE.w + POCKET_DEPTH, y: TABLE.h + POCKET_DEPTH });
    ctx.strokeRect(
      Math.min(wall.x, wall2.x),
      Math.min(wall.y, wall2.y),
      Math.abs(wall2.x - wall.x),
      Math.abs(wall2.y - wall.y),
    );
  }

  // Per-ball loci: R (own edge) and 2R (where another centre first contacts it).
  if (L.balls) {
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
  }

  ctx.restore();
}

// Draw the table PHOTO. The image's felt box (IMG.f*) is mapped onto the world
// play area with an affine transform derived from three world corners, so it
// works in both orientations (portrait just rotates U/V) and keeps the felt,
// pockets, and collision geometry aligned.
function drawTable(ctx: CanvasRenderingContext2D, l: Layout, variant: Variant) {
  const IMG = feltPx(variant);
  const tableImg = tableImgs[variant];
  if (!tableImg || !tableReady[variant]) {
    // Until the photo loads, fill the play area with felt colour so balls read.
    ctx.fillStyle = variant === "snooker" ? "#2ca02c" : "#1f9ad6";
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
  let m11 = ux / IMG.fw;
  let m12 = uy / IMG.fw;
  let m21 = vx / IMG.fh;
  let m22 = vy / IMG.fh;
  let dx = c00.x - (IMG.fx / IMG.fw) * ux - (IMG.fy / IMG.fh) * vx;
  let dy = c00.y - (IMG.fx / IMG.fw) * uy - (IMG.fy / IMG.fh) * vy;
  // Snooker photo is rotated 180° about the felt-box centre: negate the linear
  // part and shift the origin so the same felt box still maps onto the play area.
  if (variant === "snooker") {
    const cx = 2 * (IMG.fx + IMG.fw / 2);
    const cy = 2 * (IMG.fy + IMG.fh / 2);
    dx += m11 * cx + m21 * cy;
    dy += m12 * cx + m22 * cy;
    m11 = -m11;
    m12 = -m12;
    m21 = -m21;
    m22 = -m22;
  }
  ctx.save();
  ctx.transform(m11, m12, m21, m22, dx, dy); // composes onto the dpr transform
  ctx.drawImage(tableImg, 0, 0);
  ctx.restore();
}

// Body-frame rotation about the screen-x axis by `a` — a ball rolling straight
// down the track spins about the horizontal, so its markings tumble instead of
// sliding rigidly. Feeds drawBall's orientation matrix.
function rollX(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

// Spin about the screen-y axis — the ball rolling sideways as it comes out from
// under the table before it rounds the corner into the vertical channel.
function rollY(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

function mul3(a: Mat3, b: Mat3): Mat3 {
  const m: number[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      m[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[c + 3] + a[r * 3 + 2] * b[c + 6];
  return m as unknown as Mat3;
}

// The ball-return track along the BOTTOM rail: a recessed channel in the gutter
// layoutFor opened below the table. Every ball potted so far (the cue is
// re-spotted, so it never enters) collects here in POT ORDER — each drops into a
// pocket (the Sink animation), vanishes "under the table", then emerges at the
// left end of the track and rolls left→right to stack against the ones already
// resting at the right end. Drawn in raw canvas pixels, not world coords, so it
// lives entirely below the felt and touches no physics.
function drawRack(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  rack: RackEntry[],
  now: number,
  variant: Variant,
) {
  const rpx = R * l.scale;
  const w = Math.max(2, G_RAIL_W * rpx); // rail tube width
  const roOut = rpx - 2; // rail centre inset 2px from the ball edge (ball sits on it)
  const half = G_HALF * rpx; // channel half-height
  const drop = G_DROP * rpx - 2; // clearance between the table bottom and the channel
  // The table image's opaque bottom edge, in canvas px. The felt origin (oy)
  // moves with the layout's tableWrap offset, so anchor here rather than canvas 0.
  const tableBottom = l.oy + l.imgBottom;
  const cy = tableBottom + drop + half; // channel centre, just below the table
  const left = l.ox + l.imgLeft;
  const right = l.ox + l.imgRight;

  // Gutter holds every object ball (15) — no wider — and is centred under the
  // table. Balls enter at the left L-bend and stack right at the U-bend.
  const CAP = 15;
  const step = rpx * 2.05; // ball pitch along the channel
  const Lr = roOut + rpx * 0.9; // L-turn centreline radius (soft; > roOut)
  const railLen = Lr + (CAP - 1) * step + rpx * 0.9; // cornerX → uX
  const gutterW = railLen + 2 * roOut; // chute-left to U-right
  const cornerX = (left + right) / 2 - gutterW / 2 + roOut; // centred
  const uX = cornerX + railLen; // U-bend centre
  const startX = uX + (roOut - rpx) + 2; // first ball seated against the U-bend back
  const chuteTop = cy - half - rpx * 3; // entry runs up under the table (drawn first → hidden)
  const clx = cornerX + Lr; // L-turn centre
  const cly = cy - Lr;

  // Silver ball-return rails: an L-bend entry at the left (balls roll out from
  // under the table and turn right) and a closed U-bend at the right. Each rail
  // is a tube — concentric strokes dark → steel → silver for a metallic sheen.
  // The L-turn and U-turn arcs share one centre per turn (radii Lr∓ro / ro), so
  // the inner and outer rails stay a constant distance apart the whole way.
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const railPath = (ro: number) => {
    const p = new Path2D();
    p.moveTo(cornerX + ro, chuteTop); // right entry wall, up under the table
    p.lineTo(cornerX + ro, cly); // down to the top L-turn
    p.arc(clx, cly, Lr - ro, Math.PI, Math.PI / 2, true); // top L-turn (inner)
    p.lineTo(uX, cy - ro); // top rail →
    p.arc(uX, cy, ro, -Math.PI / 2, Math.PI / 2, false); // U-bend (right)
    p.lineTo(clx, cy + ro); // ← bottom rail to the bottom L-turn
    p.arc(clx, cly, Lr + ro, Math.PI / 2, Math.PI, false); // bottom L-turn (outer)
    p.lineTo(cornerX - ro, chuteTop); // left entry wall, up under the table
    return p;
  };
  // A single thick metal rail as a round tube: many concentric strokes from a
  // dark casing edge up through shaded steel to a silver sheen down the centre
  // give it a smooth, rounded, lit look.
  const coats: [string, number][] = [
    ["#12161d", 1], // dark casing edge
    ["#262d36", 0.88],
    ["#3c444d", 0.76],
    ["#535c65", 0.63],
    ["#6e777f", 0.5],
    ["#8b939b", 0.37],
    ["#aeb6bd", 0.24],
    ["#d2d8de", 0.12], // silver sheen (not white)
  ];
  const rw = w * 2.4; // thick tube
  for (const [col, f] of coats) {
    ctx.strokeStyle = col;
    ctx.lineWidth = rw * f;
    ctx.stroke(railPath(roOut));
  }
  ctx.restore();

  const speed = (ROLL_MPS * l.scale) / 1000; // px per ms
  // Ball path: down the vertical chute, around the L-turn ARC (centred on the
  // channel so the ball stays centred through the bend), then along the channel.
  const arcLen = (Lr * Math.PI) / 2;
  const vLen = drop + half + rpx - Lr; // vertical descent before the arc
  const vTopY = cly - vLen; // start of the descent (up under the table)
  const posAt = (s: number) => {
    if (s <= vLen) return { x: cornerX, y: vTopY + s };
    const sa = s - vLen;
    if (sa <= arcLen) {
      const ang = Math.PI - (sa / arcLen) * (Math.PI / 2); // π → π/2
      return { x: clx + Lr * Math.cos(ang), y: cly + Lr * Math.sin(ang) };
    }
    return { x: clx + (sa - arcLen), y: cy };
  };

  // Clip so a ball is hidden above the table's bottom edge (it's "under the
  // table") and appears as it emerges into the gutter.
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, tableBottom, right - left, cy + half + w - tableBottom);
  ctx.clip();
  let prevS = Infinity; // path distance of the ball ahead (further along the track)
  for (let i = 0; i < rack.length; i++) {
    const restX = startX - i * step;
    if (restX < clx - rpx) break; // gutter full (15 balls + spare) — stop
    const pathLen = vLen + arcLen + (restX - clx); // total distance to this slot
    // Constant-speed travel, clamped to the slot AND to one ball-gap behind the
    // ball ahead (in path distance) — a trailing ball can never overlap or
    // overtake its leader, even around the corner.
    let s = now >= rack[i].rollStart ? speed * (now - rack[i].rollStart) : -1;
    s = Math.min(s, pathLen, prevS - step);
    prevS = s;
    if (s < 0) continue; // still under the table (or queued behind) — hidden
    const p = posAt(s);
    // Roll ~without slipping via net displacement: down about x, across about y.
    const o = mul3(rollY((p.x - cornerX) / rpx), rollX(-(p.y - vTopY) / rpx));
    drawBall(ctx, { x: p.x, y: p.y }, rack[i].id, rpx, 1, o, false, true, variant);
  }
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
  const k = (rpx * 0.74) / NUM_FONT; // font px -> ball px; sized up so the numeral reads on small screens
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
      rpx * 0.48 * Math.hypot(p.r.x, p.r.y),
      rpx * 0.48 * Math.hypot(p.u.x, p.u.y),
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
    // Pro balls (Aramith) print the number in a bold sans-serif — Helvetica/Arial-like.
    ctx.font = `bold ${NUM_FONT}px "Helvetica Neue", Arial, sans-serif`;
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
  // Six dots on the principal axes (±x, ±y, ±z), like an Aramith Pro cue ball:
  // one per cube face, so a dot sits on alternating sides as the ball rolls.
  const AXES: [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];
  for (const [ax, ay, az] of AXES) {
    const w = applyM(o, ax, ay, az);
    // Fade across the horizon so a dot rolls into view instead of popping in.
    const fade = Math.min(1, Math.max(0, (w.z - 0.02) / 0.22));
    if (fade <= 0) continue;
    const f = 0.4 + 0.6 * w.z;
    const d = dirPx(rotated, w.x, w.y);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = "#111417";
    ctx.beginPath();
    ctx.arc(c.x + d.x * rpx, c.y + d.y * rpx, rpx * 0.16 * f, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Draw a single glossy numbered ball at pixel centre c, radius rpx, alpha. */
// Snooker ball hues: cue is off-white, reds share one red, each colour its own.
const SNOOKER_HUE: Record<number, string> = {
  16: "#e2c200", // yellow
  17: "#128a35", // green
  18: "#7a4a1e", // brown
  19: "#1f5fd0", // blue
  20: "#e87ba6", // pink
  21: "#14181d", // black
};
const snookerBase = (id: number) =>
  id === 0 ? "#f4f1ea" : isColour(id) ? SNOOKER_HUE[id] : "#c81f1f"; // else a red

export function drawBall(
  ctx: CanvasRenderingContext2D,
  c: Vec,
  id: number,
  rpx: number,
  alpha: number,
  o: Mat3,
  rotated: boolean,
  shadow = true,
  variant: Variant = "pool",
) {
  ctx.save();
  ctx.globalAlpha = alpha;

  if (shadow) {
    ctx.beginPath();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.ellipse(c.x + rpx * 0.15, c.y + rpx * 0.35, rpx, rpx * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const snooker = variant === "snooker";
  // Body colour. Pool: stripes are a white ball wearing a coloured band; solids
  // and the eight are the full hue; the cue is off-white. Snooker: reds/colours
  // are solid, no numbers; the cue is off-white.
  const stripe = !snooker && id > 8;
  const base = snooker ? snookerBase(id) : id === 0 ? "#f4f1ea" : stripe ? "#f4f1ea" : HUE[id];
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
  // Snooker balls carry no number; the cue keeps its dots so spin still reads.
  if (id === 0) drawCueDots(ctx, c, rpx, o, rotated);
  else if (!snooker) drawNumberSpots(ctx, c, rpx, o, rotated, id);
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
  cueScale = 1,
  hideCue = false,
  variant: Variant = "pool",
) {
  const rpx = R * l.scale;
  for (const b of world.balls) {
    if (b.potted) continue;
    if (hideCue && b.id === 0) continue;
    const r = b.id === 0 ? rpx * cueScale : rpx;
    drawBall(ctx, toPx(l, b.p), b.id, r, b.id === translucentId ? 0.55 : 1, b.o ?? IDENT3, l.rotated, true, variant);
  }
}

/** A ball dropping into a pocket. `v` = its world velocity at the pot (m/s),
 *  `ms` = elapsed since. It keeps that momentum until it hits the pocket back,
 *  then plunges. */
export type Sink = { id: number; from: Vec; pocket: Vec; v: Vec; ms: number; o0: Mat3 };

// Rodrigues rotation about an in-plane (world x,y) axis — rolls the ball's
// markings as it travels. The roll axis is the travel direction turned 90° in
// the felt plane, so the ball rolls without slipping along its path.
function rollAlong(vx: number, vy: number, ang: number): Mat3 {
  const n = Math.hypot(vx, vy) || 1e-9;
  const kx = -vy / n;
  const ky = vx / n; // unit axis ⟂ travel, in the felt plane (kz = 0)
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const t = 1 - c;
  return [
    1 - t * ky * ky, t * kx * ky, s * ky,
    t * kx * ky, 1 - t * kx * kx, -s * kx,
    -s * ky, s * kx, c,
  ];
}

// A potted ball's drop: it keeps the momentum it entered with and rattles inside
// the pocket, bouncing off the walls and damping the velocity on each bounce,
// then sinks into shadow and shrinks away. Fully re-integrated from the pot each
// frame (the Sink carries no live state), so it's deterministic: same ms → pos.
//
// The pocket interior is a POLYGON (the hole shape a ball rattles inside). It's
// defined once per pocket type in a local frame — u = "outward" (table centre →
// pocket, i.e. deeper into the pocket), w = perpendicular — then rotated onto
// each pocket. So the mouth (toward the felt) is at negative u, the back at
// positive u. Edit these 12 points against the debug overlay to match the art;
// winding doesn't matter (inward normals are found via the centroid).
type Vec2 = [number, number];
// The rattle-hole polygon, in each pocket's local frame: u = "outward" (into the
// pocket), w = perpendicular. The felt-side mouth is DERIVED (see pocketSinkLocal)
// so it always rides the pot circle as the pocket params are tuned; only the
// bowl-back (+u) is hand-authored here — corners deep, sides shallow.
// World mm, in each pocket's local frame (u = into the pocket, w = perpendicular).
const SINK_BACK_CORNER: Record<Variant, Vec2[]> = {
  pool: [[28.61, 31.42], [51.33, 20.24], [59.71, 0], [51.33, -20.24], [28.61, -31.42]],
  // Apex on the diagonal (w=0); the flanking pair is mirrored across it (w -> -w).
  snooker: [[-7.3, 41.6], [10.3, 29.1], [25.5, 0], [10.3, -29.1], [-7.3, -41.6]],
};
const SINK_BACK_SIDE: Record<Variant, Vec2[]> = {
  pool: [[13.72, 32.34], [27.31, 15.89], [29.26, 0], [27.31, -15.89], [13.72, -32.34]],
  // Apex on the axis (w=0); the flanking pair is mirrored across it (w -> -w).
  snooker: [[7.5, 42.8], [23.6, 25.0], [30.7, 0], [23.6, -25.0], [7.5, -42.8]],
};

// The felt-side mouth: 5 points on the pot circle (radius = pot hole about the
// pocket centre), spanning jaw tip to jaw tip along the felt-facing arc through
// (-hole, 0). The tips sit on that circle ±throat/2 off the centre line, so tip
// angle = atan2(throat/2, -√(hole²-(throat/2)²)). Identical for corners and sides
// (a side's tips lie ±sideThroat/2 along the rail, the same relation).
function mouthArc(hole: number, half: number): Vec2[] {
  const h = Math.min(half, hole); // guard: tip must lie on the circle
  const c = Math.sqrt(Math.max(0, hole * hole - h * h));
  const a0 = Math.atan2(h, -c); // one jaw tip
  const a1 = 2 * Math.PI - a0; // the other, via the felt side (through π)
  const out: Vec2[] = [];
  for (let i = 0; i < 5; i++) {
    const a = a0 + ((a1 - a0) * i) / 4;
    out.push([hole * Math.cos(a), hole * Math.sin(a)]);
  }
  return out;
}

// A pocket's local polygon: derived felt-side mouth + hand-authored bowl-back,
// ordered by angle about the centre so the loop stays simple.
function pocketSinkLocal(isSide: boolean, variant: Variant): Vec2[] {
  const g = currentGeo();
  const hole = isSide ? g.sideHole : g.cornerHole;
  const throat = isSide ? g.sideThroat : g.cornerThroat;
  const back = isSide ? SINK_BACK_SIDE[variant] : SINK_BACK_CORNER[variant];
  return [...mouthArc(hole, throat / 2), ...back].sort(
    (p, q) => Math.atan2(p[1], p[0]) - Math.atan2(q[1], q[0]),
  );
}

// Map a pocket's local polygon into world coords, oriented along "outward" (into
// the pocket). Corners point along the 45° table diagonal (a right-angle corner,
// regardless of the table's aspect ratio); side pockets point straight out (±y).
function sinkPoly(pocket: Vec, variant: Variant): Vec[] {
  const isSide = Math.abs(pocket.x - TABLE.w / 2) < 10;
  const local = pocketSinkLocal(isSide, variant);
  const sx = Math.sign(pocket.x - TABLE.w / 2);
  const sy = Math.sign(pocket.y - TABLE.h / 2);
  const oux = isSide ? 0 : sx;
  const ouy = isSide ? sy : sy;
  const oun = Math.hypot(oux, ouy) || 1e-9;
  const Ux = oux / oun;
  const Uy = ouy / oun; // outward (into the pocket): diagonal for corners, ±y for sides
  const Wx = -Uy;
  const Wy = Ux; // perpendicular
  return local.map(([u, w]) => ({
    x: pocket.x + u * Ux + w * Wx,
    y: pocket.y + u * Uy + w * Wy,
  }));
}
const SINK_DT = 0.004; // fixed sim step (s) — small enough a fast ball can't tunnel
const SINK_REST = 0.62; // wall restitution (normal energy kept per bounce — soft liner)
const SINK_WALL_FRIC = 0.8; // tangential energy kept per bounce (the liner grabs the ball)
const SINK_DRAG = 1.3; // per-second velocity bleed (rolling friction in the bowl)
const SINK_G = 300; // accel (mm/s²) toward the pocket back — tips a slow ball in
const SINK_INSET_LO = -50; // depth (mm) where the wall inset starts ramping up from 0
const SINK_INSET_HI = 0; // depth (mm) where the inset reaches full ball radius R
const SINK_ENTER_GATE = -30; // depth (mm) past which the whole ball has cleared the mouth
const SINK_FALL_MS = 240; // once past the boundary, how long the shrink/fall takes
const SINK_DROP = 0.7; // screen-down depth of the fall, in ball radii
function drawSink(ctx: CanvasRenderingContext2D, l: Layout, sk: Sink, variant: Variant = "pool") {
  const rpx = R * l.scale;

  // The pocket polygon + per-edge inward normals (pointing toward the centroid,
  // so the winding of the point list doesn't matter).
  const poly = sinkPoly(sk.pocket, variant);
  const N = poly.length;
  let cx = 0;
  let cy = 0;
  for (const p of poly) {
    cx += p.x;
    cy += p.y;
  }
  cx /= N;
  cy /= N;
  // "Into the pocket" direction (same basis as sinkPoly): corners point along the
  // 45° diagonal toward the corner, sides straight out. NOT the centroid — the
  // polygon reaches further toward the mouth than the back, so the centroid sits
  // on the wrong side and would flip this.
  const isSideP = Math.abs(sk.pocket.x - TABLE.w / 2) < 10;
  const uox = isSideP ? 0 : Math.sign(sk.pocket.x - TABLE.w / 2);
  const uoy = Math.sign(sk.pocket.y - TABLE.h / 2);
  const uon = Math.hypot(uox, uoy) || 1e-9;
  const Ux = uox / uon;
  const Uy = uoy / uon;
  const nrm = poly.map((a, i) => {
    const b = poly[(i + 1) % N];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const el = Math.hypot(ex, ey) || 1e-9;
    let nx = -ey / el;
    let ny = ex / el;
    // Flip to point inward (toward the centroid) if needed.
    if ((cx - a.x) * nx + (cy - a.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    // The MOUTH lips face almost straight out the opening (inward normal ≈ +U).
    // They're ONE-WAY: they contain a ball trying to escape, but let an entering
    // ball (moving toward the centre) pass — otherwise they'd eject a slow,
    // rim-caught ball deep into the pocket (a teleport). The angled jaws below
    // this threshold stay full walls, so a ball never clips out the side.
    const mouth = nx * Ux + ny * Uy > 0.85;
    return { nx, ny, ax: a.x, ay: a.y, mouth };
  });

  // The wall is inset by the ball radius so the ball's EDGE — not its centre —
  // rides the polygon. But the inset TAPERS with depth: ~0 at the mouth (where
  // the gap is narrower than the ball, so a full inset would shove a rim-caught
  // ball deep — a teleport) up to full R deeper in (where the ball rests, edge
  // fully contained). Depth-based, NOT time-based, so it's identical every frame
  // and the path never re-solves differently ("spazzes").
  const insetAt = (x: number, y: number) => {
    const depth = (x - sk.pocket.x) * Ux + (y - sk.pocket.y) * Uy;
    const t = (depth - SINK_INSET_LO) / (SINK_INSET_HI - SINK_INSET_LO);
    return R * Math.max(0, Math.min(1, t));
  };

  // Confine a point so the ball stays inside the inset polygon; returns the
  // clamped point + the inward normal of the edge it was pushed off (0,0 if
  // already inside). A few passes settle sharp corners where two edges overlap.
  // A mouth lip is skipped while the ball moves inward through it (v·n > 0), so
  // the ball enters freely but is still walled in on its way back out.
  const confine = (x: number, y: number, vx: number, vy: number) => {
    let nx = 0;
    let ny = 0;
    for (let pass = 0; pass < 3; pass++) {
      const inset = insetAt(x, y);
      let minD = 0;
      let hit = -1;
      for (let i = 0; i < N; i++) {
        if (nrm[i].mouth && vx * nrm[i].nx + vy * nrm[i].ny > 0) continue; // entering — pass
        const d = (x - nrm[i].ax) * nrm[i].nx + (y - nrm[i].ay) * nrm[i].ny - inset;
        if (d < minD) {
          minD = d;
          hit = i;
        }
      }
      if (hit < 0) break;
      x -= minD * nrm[hit].nx;
      y -= minD * nrm[hit].ny;
      nx = nrm[hit].nx;
      ny = nrm[hit].ny;
    }
    return { x, y, nx, ny };
  };

  // Start exactly where physics dropped the ball — no snap. The mouth is narrower
  // than the ball, so the one-way lips let it roll in under gravity without an
  // ejecting teleport.
  let px = sk.from.x;
  let py = sk.from.y;
  let vx = sk.v.x;
  let vy = sk.v.y;
  let dist = 0; // path length, for rolling the markings
  let crossMs = -1; // ms at which the ball first fully clears the mouth boundary

  // Rattle simulation — integrate from the pot (ms 0) to now, bouncing off the
  // polygon walls. Cheap: ~n = ms/4 steps, one potted ball at a time.
  const target = sk.ms / 1000;
  for (let t = 0; t < target; t += SINK_DT) {
    const step = Math.min(SINK_DT, target - t);
    // Gravity toward the back of the pocket (a fixed direction, so no swirl):
    // tips a slow, rim-caught ball over the lip and accelerates it in.
    vx += Ux * SINK_G * step;
    vy += Uy * SINK_G * step;
    px += vx * step;
    py += vy * step;
    dist += Math.hypot(vx, vy) * step;
    const decay = 1 - SINK_DRAG * step;
    vx *= decay;
    vy *= decay;
    const s = confine(px, py, vx, vy);
    px = s.x;
    py = s.y;
    if (s.nx !== 0 || s.ny !== 0) {
      const vn = vx * s.nx + vy * s.ny; // inward normal: <0 means heading out
      if (vn < 0) {
        // Split into normal + tangential and damp each: restitution kills the
        // bounce, wall friction scrubs the slide — a soft pocket liner deadens
        // the ball fast, like a real table.
        const tx = vx - vn * s.nx;
        const ty = vy - vn * s.ny;
        vx = tx * SINK_WALL_FRIC - SINK_REST * vn * s.nx;
        vy = ty * SINK_WALL_FRIC - SINK_REST * vn * s.ny;
      }
    }
    // Note the moment the whole ball has passed the boundary into the hole — the
    // shrink/fall only starts then, so a slow ball rolls fully in at full size
    // before it drops (rather than fading while still at the rim).
    if (crossMs < 0) {
      const depth = (px - sk.pocket.x) * Ux + (py - sk.pocket.y) * Uy;
      if (depth >= SINK_ENTER_GATE) crossMs = t * 1000;
    }
  }

  // Fall progress: 0 until the ball has fully entered, then ramps over the fall
  // once it's past the boundary. Full size + no fade while it's still rolling in.
  const sinkP = crossMs < 0 ? 0 : Math.min(1, (sk.ms - crossMs) / SINK_FALL_MS);
  if (sinkP >= 1) return; // fully sunk — nothing left to draw

  // Sink: shrink to nothing + drop into shadow (screen-down) + darken.
  const r = rpx * (1 - sinkP);
  const scr = toPx(l, { x: px, y: py });
  const c = { x: scr.x, y: scr.y + rpx * SINK_DROP * sinkP * sinkP };
  // Compose the rattle's rolling ON TOP of the ball's field orientation at the
  // moment it dropped (o0), so the markings carry over continuously instead of
  // snapping to a fresh identity as the sink animation takes over.
  const o = mul3(rollAlong(vx, vy, dist / R), sk.o0);
  drawBall(ctx, c, sk.id, r, 1, o, l.rotated, false, variant);
  // A dark disc grows over it as it sinks below the rim into the pocket.
  ctx.save();
  ctx.globalAlpha = 0.8 * sinkP;
  ctx.fillStyle = "#05070c";
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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
  myGroup: Group | null,
  onEight: boolean,
) {
  const rpx = R * l.scale;
  const PRED_LINE_W = 1.6; // one width for both prediction lines (cue + struck)
  ctx.save();

  // Cue-ball path up to first contact — dashed white; captures the spin curve.
  ctx.strokeStyle = "rgba(255,255,255,0.82)";
  ctx.lineWidth = PRED_LINE_W;
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
    // Colour the ray like the struck ball, saturated + lifted so it reads
    // against the felt. Stripes (9..15) reuse their solid's hue. Length encodes hit
    // fullness (head-on = longest, grazing shrinks to nothing) — draw as-is.
    const oid = pr.objectId ?? 1;
    const base = HUE[oid <= 8 ? oid : oid - 8] ?? "#f4f1ea";
    ctx.strokeStyle = saturate(base, 0.4, 0.06);
    ctx.lineWidth = PRED_LINE_W;
    polyline(ctx, l, pr.object);
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
// Push channels away from their grey mean (more saturation) with a small
// lightness lift so the ray stays vivid against the felt.
function saturate(hex: string, sat: number, light = 0) {
  const { r, g, b } = hexToRgb(hex);
  const m = (r + g + b) / 3;
  const f = (c: number) => clamp(m + (c - m) * (1 + sat) + 255 * light);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
