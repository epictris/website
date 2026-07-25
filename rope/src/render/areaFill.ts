// Canvas fill for non-body areas: the area's colour with its glyph stamped out
// of it (see `areaGlyphs.ts` for what the glyphs are and why areas carry them).
//
// The fill is a single even-odd path — outline plus glyph polygons — so the
// glyphs are cutouts showing whatever is behind the area rather than a colour
// of their own. That keeps them legible against any authored fill, including an
// opaque one, with no contrast colour to choose.
//
// Shared by the game renderer and the level editor, so authoring shows exactly
// what play shows.

import { Vec2 } from "../engine/vec2";
import { forceAreaGlyphs, killZoneGlyphs, type PolyPath } from "./areaGlyphs";

// `half` is the area's half-extents (a circle passes its radius in both axes).
function fillWithCutouts(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  rotation: number,
  half: Vec2,
  circle: boolean,
  fillStyle: string,
  glyphs: ((p: PolyPath) => void) | null,
): void {
  const outline = (): void => {
    if (circle) ctx.arc(center.x, center.y, half.x, 0, Math.PI * 2);
    else {
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate(rotation);
      ctx.rect(-half.x, -half.y, half.x * 2, half.y * 2);
      ctx.restore();
    }
  };

  ctx.fillStyle = fillStyle;
  if (!glyphs || half.x <= 0 || half.y <= 0) {
    ctx.beginPath();
    outline();
    ctx.fill();
    return;
  }

  // Clip to the area first: a glyph straddling the edge would otherwise have
  // its outside part counted as fill by the even-odd rule and appear as a solid
  // blob beyond the boundary. Clipped, glyphs slide in and out under the edge.
  ctx.save();
  ctx.beginPath();
  outline();
  ctx.clip();

  ctx.beginPath();
  outline();
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(rotation);
  glyphs(ctx);
  ctx.restore();
  ctx.fill("evenodd");
  ctx.restore();
}

// A force area: flow arrows drifting along the push direction. A zero magnitude
// simply fills — an area that does nothing shows no flow.
export function fillForceArea(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  rotation: number,
  half: Vec2,
  circle: boolean,
  magnitude: number,
  fillStyle: string,
  timeMs: number = performance.now(),
): void {
  fillWithCutouts(ctx, center, rotation, half, circle, fillStyle, (p) =>
    forceAreaGlyphs(p, half, circle, magnitude, timeMs),
  );
}

// A killzone: static skulls.
export function fillKillZone(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  rotation: number,
  half: Vec2,
  circle: boolean,
  fillStyle: string,
): void {
  fillWithCutouts(ctx, center, rotation, half, circle, fillStyle, (p) =>
    killZoneGlyphs(p, half, circle),
  );
}
