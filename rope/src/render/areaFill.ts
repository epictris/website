// Canvas fill for everything the player passes through — areas and hook-only
// anchor geometry: the shape's colour with its glyph stamped out of it (see
// `areaGlyphs.ts` for what the glyphs are and why these shapes carry them).
//
// The fill is a single even-odd path — outline plus glyph polygons — so the
// glyphs are cutouts showing whatever is behind the area rather than a colour
// of their own. That keeps them legible against any authored fill, including an
// opaque one, with no contrast colour to choose.
//
// Shared by the game renderer and the level editor, so authoring shows exactly
// what play shows.

import { Vec2 } from "../engine/vec2";
import { anchorGlyphs, forceAreaGlyphs, killZoneGlyphs, type PolyPath } from "./areaGlyphs";
import { outlineHalfExtents, outlineIsRound, pathOutline, type Outline } from "./shapePath";

// The glyph lattice is laid out over the shape's bounding half-extents whatever
// the shape is, and the even-odd clip below trims it to the real outline — so a
// polygon area is stamped with exactly the same marks at exactly the same pitch
// as the rect that bounds it, and only the visible count differs.
function fillWithCutouts(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  rotation: number,
  shape: Outline,
  fillStyle: string,
  glyphs: ((p: PolyPath) => void) | null,
): void {
  const half = outlineHalfExtents(shape);
  const outline = (): void => pathOutline(ctx, center, rotation, shape);

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
  shape: Outline,
  magnitude: number,
  fillStyle: string,
  timeMs: number = performance.now(),
): void {
  const half = outlineHalfExtents(shape);
  fillWithCutouts(ctx, center, rotation, shape, fillStyle, (p) =>
    forceAreaGlyphs(p, half, outlineIsRound(shape), magnitude, timeMs),
  );
}

// A hook-only anchor body: a grate mesh, its holes showing the backdrop
// through the body so it reads as scenery rather than a surface.
export function fillAnchor(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  rotation: number,
  shape: Outline,
  fillStyle: string,
): void {
  const half = outlineHalfExtents(shape);
  fillWithCutouts(ctx, center, rotation, shape, fillStyle, (p) =>
    anchorGlyphs(p, half, outlineIsRound(shape)),
  );
}

// A killzone: static skulls.
export function fillKillZone(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  rotation: number,
  shape: Outline,
  fillStyle: string,
): void {
  const half = outlineHalfExtents(shape);
  fillWithCutouts(ctx, center, rotation, shape, fillStyle, (p) =>
    killZoneGlyphs(p, half, outlineIsRound(shape)),
  );
}
