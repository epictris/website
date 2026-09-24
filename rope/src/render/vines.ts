// Drawing a hanging vine: a smoothed cord through the anchor and the link
// centres, at the visual gauge rather than at the links' grab radius.
//
// `chainMetrics.ts` is deliberately not used here, and the difference is the
// point. That walk exists to place links along a WRAP PATH because a scene chain
// has no per-link bodies and its shape has to be invented from its span; a vine
// has real link positions, which are the honest source. Nothing is invented, so
// what is drawn is exactly where the thing the hook grabs actually is.
//
// The load rope is not drawn at all. It is a constraint rather than a thing, and
// the links already say where the vine is.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { shade } from "./color";
import { VINE_VISUAL_RADIUS, type Vine } from "../level/vines";
import { forEachBraidSegment } from "./vineBraid";
import { forEachVineLeaf } from "./vineLeaves";

// A vine with no authored colour. Deliberately desaturated: it hangs among the
// level's own greys and has to read as growth without pulling the eye off the
// geometry.
export const VINE_COLOR = "#5c7a48";

// How much darker the cord's rim is than its body. A cord reads as round only if
// its edge is shaded, and one flat stroke at this width reads as a drawn line.
const RIM_SHADE = 0.55;

export function drawVines(
  ctx: CanvasRenderingContext2D,
  vines: readonly Vine[],
  alpha: number,
): void {
  for (const vine of vines) {
    if (vine.links.length === 0) continue;
    const points = [
      vine.anchorContact.renderGlobalPosition(alpha),
      ...vine.links.map((l) => l.renderPosition(alpha)),
    ];
    const color = vine.color ?? VINE_COLOR;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (vine.braidSeed !== null) {
      const colors = [shade(color, 1.2), color, shade(color, 0.7)];
      forEachBraidSegment(points, vine.braidSeed, (ax, ay, _az, bx, by, _bz, strand, girth) => {
        ctx.strokeStyle = colors[strand]!;
        ctx.lineWidth = VINE_VISUAL_RADIUS * 0.95 * girth;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      });
      forEachVineLeaf(points, vine.braidSeed, (x, y, side, length, tone) => {
        const baseX = x + side * 0.045;
        const baseY = y + 0.025;
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.005;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(baseX, baseY);
        ctx.stroke();
        const tipX = baseX + side * length * 0.45;
        const tipY = baseY + length * 0.89;
        const width = length * 0.3;
        ctx.fillStyle = ["#397b35", "#5a9d38", "#7dad48"][tone]!;
        ctx.beginPath();
        ctx.moveTo(baseX, baseY);
        ctx.quadraticCurveTo(baseX + side * width * 1.5, baseY + length * 0.28, tipX, tipY);
        ctx.quadraticCurveTo(baseX - side * width * 0.45, baseY + length * 0.52, baseX, baseY);
        ctx.fill();
      });
      ctx.restore();
      continue;
    }
    traceVine(ctx, points);
    ctx.strokeStyle = shade(color, RIM_SHADE);
    ctx.lineWidth = VINE_VISUAL_RADIUS * 2;
    ctx.stroke();
    // The same path again a hair thinner, which leaves the rim showing along
    // both edges - one stroke and one clip would cost a second path for the
    // same picture.
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(VINE_VISUAL_RADIUS * 2 - 2 * PX, PX);
    ctx.stroke();
    ctx.restore();
  }
}

// The points as a smooth curve: quadratics whose control points are the points
// themselves and whose ends are the midpoints between them, which is the
// standard midpoint smoothing. A polyline through 10 cm link centres reads as
// visibly faceted at any zoom the player grabs a vine at.
function traceVine(ctx: CanvasRenderingContext2D, p: readonly Vec2[]): void {
  ctx.beginPath();
  ctx.moveTo(p[0]!.x, p[0]!.y);
  if (p.length === 2) {
    ctx.lineTo(p[1]!.x, p[1]!.y);
    return;
  }
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i]!;
    const b = p[i + 1]!;
    ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
  const last = p[p.length - 1]!;
  ctx.lineTo(last.x, last.y);
}
