// A berry vine on a 2D canvas: the canvas renderer's own, and the editor's
// overlay. The same poses the 3D layer draws (`render3d/starberryVisual.ts`),
// flattened - there is no depth here, so the cord set back behind the plane
// in 3D is simply drawn first, under its stalks and berries.

import { Vec2 } from "../engine/vec2";
import { berrySide, restStarberries } from "../level/starberry";
import type { VineCord } from "../level/vines";
import {
  BERRY_CORD_COLOR,
  STALK_RADIUS,
  berryCordRadius,
  naturalStemPoint,
  roundBerryAttachment,
  stemFraction,
} from "./starberryArt";

// The standard vine's three leaf greens (`render3d/vineVisual.ts`), in sRGB.
const CAP_GREENS = ["#4f7540", "#648c48", "#829d58"];

// One leaf of a berry's cap in the berry's own frame (the stalk up, -y): from
// the top of a berry `r` across to its tip at (`tipX`, `tipY`), `width` across
// at its widest, the tip turned up by `curl`. Filled and edged.
function capLeaf(
  ctx: CanvasRenderingContext2D,
  r: number,
  tipX: number,
  tipY: number,
  width: number,
  curl: number,
  fill: string,
): void {
  const baseY = -r * 1.04;
  const dx = tipX;
  const dy = tipY - baseY;
  const length = Math.hypot(dx, dy) || 1;
  // Across the leaf, and its widest point a third of the way along it.
  const nx = -dy / length;
  const ny = dx / length;
  const midX = dx * 0.38;
  const midY = baseY + dy * 0.38;
  const tx = tipX + Math.sign(tipX || 1) * Math.abs(curl);
  const ty = tipY - Math.abs(curl);
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(0, baseY);
  ctx.quadraticCurveTo(midX + nx * width, midY + ny * width, tx, ty);
  ctx.quadraticCurveTo(midX - nx * width, midY - ny * width, 0, baseY);
  ctx.fill();
  ctx.stroke();
}

export function drawStarberry(ctx: CanvasRenderingContext2D, vine: VineCord, alpha: number): void {
  const settings = vine.starberry;
  if (!settings) return;
  const path: Vec2[] = [];
  vine.path(alpha, path);
  if (path.length < 2) return;
  const berries = vine.berryPoses?.(alpha) ?? restStarberries(path, settings);
  ctx.save();
  ctx.lineCap = "round";

  // The cord: one strand, tapering.
  let length = 0;
  for (let i = 1; i < path.length; i++) length += path[i]!.distanceTo(path[i - 1]!);
  const segments = Math.max(8, Math.min(350, Math.ceil(length / 0.045)));
  ctx.strokeStyle = BERRY_CORD_COLOR;
  for (let i = 0; i < segments; i++) {
    const a = naturalStemPoint(path, i / segments, settings.seed);
    const b = naturalStemPoint(path, (i + 1) / segments, settings.seed);
    ctx.lineWidth = 2 * berryCordRadius((i + 0.5) / segments, settings.seed);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }


  // The stalks and berries.
  for (const [i, berry] of berries.entries()) {
    const root = naturalStemPoint(path, stemFraction(path, berry.root), settings.seed);
    const attachment = roundBerryAttachment(root, berry.fruit, berry.radius);
    const axis = attachment.axis;
    const end = attachment.end;
    const side = berrySide(i, settings);
    ctx.lineWidth = 2 * STALK_RADIUS;
    // The cord's own brown: a stalk is the vine's growth, and the leaves are
    // the only green.
    ctx.strokeStyle = BERRY_CORD_COLOR;
    ctx.beginPath();
    ctx.moveTo(root.x, root.y);
    ctx.bezierCurveTo(
      root.x + (end.x - root.x) * 0.25 + side * 0.025,
      root.y - 0.055,
      attachment.control.x,
      attachment.control.y,
      end.x,
      end.y,
    );
    ctx.stroke();
    // karin's round berry, coloured as the 3D one is: dark translucent amber
    // with a faint light at its heart...
    const { x, y } = berry.fruit;
    const r = berry.radius;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(x + r * 0.025, y, r * 0.91, r, Math.atan2(axis.x, -axis.y), 0, Math.PI * 2);
    ctx.clip();
    const body = ctx.createRadialGradient(x, y, 0, x, y, r);
    body.addColorStop(0, berry.held ? "#f7c46a" : "#e9a24a");
    body.addColorStop(0.3, "#b8621c");
    body.addColorStop(0.75, "#7e3a0e");
    body.addColorStop(1, "#4e2107");
    ctx.fillStyle = body;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.restore();
    // ...under its cap, seen side on: the 3D cap's outer leaves first,
    // running down over the shoulder, then the shorter inner ones over their
    // bases, each its own length, spread and green and edged a shade darker
    // so the overlaps read - a different cap on every berry.
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(axis.x, -axis.y));
    ctx.lineWidth = r * 0.03;
    ctx.strokeStyle = "#2f3c1a";
    const random = (leaf: number, salt: number): number => {
      const n = Math.sin((settings.seed * 0.0137 + i * 7.31) * 127.1 + (leaf * 1.73 + salt) * 311.7) * 43758.5453;
      return n - Math.floor(n);
    };
    const outer = 4 + Math.floor(random(0, 1) * 2);
    const inner = 2 + Math.floor(random(0, 2) * 2);
    for (let leaf = 0; leaf < outer + inner; leaf++) {
      const isOuter = leaf < outer;
      const n = isOuter ? outer : inner;
      const k = isOuter ? leaf : leaf - outer;
      // Spread across the cap, -1 to 1, a little irregular.
      const spread = (n === 1 ? 0 : (k / (n - 1)) * 2 - 1) * (isOuter ? 1 : 0.7) + (random(leaf, 3) - 0.5) * 0.25;
      const length = isOuter ? 0.85 + 0.25 * random(leaf, 4) : 0.55 + 0.2 * random(leaf, 4);
      const tone = CAP_GREENS[random(leaf, 5) < (isOuter ? 0.35 : 0.15) ? 0 : random(leaf, 5) < (isOuter ? 0.8 : 0.55) ? 1 : 2]!;
      capLeaf(
        ctx,
        r,
        spread * r * length,
        -r * (1.04 - length * (0.55 + 0.25 * (1 - Math.abs(spread)))),
        r * (isOuter ? 0.3 : 0.28) * (0.85 + 0.35 * random(leaf, 6)),
        (isOuter ? 0.08 + 0.1 * random(leaf, 7) : 0.04) * r * (spread || 1),
        tone,
      );
    }
    ctx.restore();
  }
  ctx.restore();
}
