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
import {
  anchorGlyphs,
  finishGlyphs,
  forceAreaGlyphs,
  killZoneGlyphs,
  waterAreaGlyphs,
  type PolyPath,
} from "./areaGlyphs";
import {
  outlineHalfExtents,
  outlineIsRound,
  pathOutline,
  pathOutlineInto,
  type Outline,
} from "./shapePath";

// The STATIC glyph sets - a grate, a finish line's chequer, a killzone's
// skulls - as Path2Ds in the shape's local frame, built once per lattice.
//
// They depend on nothing but the lattice's half-extents and roundness, yet a
// grate is up to MAX_GLYPHS square holes at five canvas calls apiece, and the
// editor was re-emitting every hole of every anchor on every frame (about 5 ms
// a frame on the river level, measured in a trace). Cached, a fill is one
// `addPath`. Keyed by size, so resizing an area in the editor builds a new
// entry per size it passes through; the cap keeps a long drag from growing the
// map without bound, and clearing it outright costs one rebuild per shape.
type StaticGlyphs = "anchor" | "finish" | "killzone";
const STATIC_GLYPHS: Record<StaticGlyphs, (p: PolyPath, half: Vec2, circle: boolean) => void> = {
  anchor: anchorGlyphs,
  finish: finishGlyphs,
  killzone: killZoneGlyphs,
};
const STATIC_GLYPH_CACHE_MAX = 256;
const staticGlyphCache = new Map<string, Path2D>();

function staticGlyphPath(kind: StaticGlyphs, half: Vec2, circle: boolean): Path2D {
  const key = `${kind}:${half.x}:${half.y}:${circle}`;
  let path = staticGlyphCache.get(key);
  if (!path) {
    if (staticGlyphCache.size >= STATIC_GLYPH_CACHE_MAX) staticGlyphCache.clear();
    path = new Path2D();
    STATIC_GLYPHS[kind](path, half, circle);
    staticGlyphCache.set(key, path);
  }
  return path;
}

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
  // A function emits glyphs that change frame to frame (a drifting current);
  // a Path2D is a static set from `staticGlyphPath`, in the local frame.
  glyphs: ((p: PolyPath) => void) | Path2D | null,
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

  if (glyphs instanceof Path2D) {
    // A Path2D cannot be appended to the context's current path, so the
    // outline goes into a Path2D of its own (world coordinates, as
    // `pathOutline` places it) and the glyphs are added under the transform
    // the function branch below sets on the context.
    const p = new Path2D();
    pathOutlineInto(p, center, rotation, shape);
    p.addPath(
      glyphs,
      new DOMMatrix().translateSelf(center.x, center.y).rotateSelf((rotation * 180) / Math.PI),
    );
    ctx.fill(p, "evenodd");
    ctx.restore();
    return;
  }
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

// A water area: flow streaks drifting at the current's own speed. A still body
// of water simply fills, which is what a level authoring zero flow means.
export function fillWaterArea(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  rotation: number,
  shape: Outline,
  flow: number,
  fillStyle: string,
  timeMs: number = performance.now(),
): void {
  const half = outlineHalfExtents(shape);
  fillWithCutouts(ctx, center, rotation, shape, fillStyle, (p) =>
    waterAreaGlyphs(p, half, outlineIsRound(shape), flow, timeMs),
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
  fillWithCutouts(
    ctx,
    center,
    rotation,
    shape,
    fillStyle,
    staticGlyphPath("anchor", half, outlineIsRound(shape)),
  );
}

// A finish line: static chequers.
export function fillFinish(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  rotation: number,
  shape: Outline,
  fillStyle: string,
): void {
  const half = outlineHalfExtents(shape);
  fillWithCutouts(
    ctx,
    center,
    rotation,
    shape,
    fillStyle,
    staticGlyphPath("finish", half, outlineIsRound(shape)),
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
  fillWithCutouts(
    ctx,
    center,
    rotation,
    shape,
    fillStyle,
    staticGlyphPath("killzone", half, outlineIsRound(shape)),
  );
}
