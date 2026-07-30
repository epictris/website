// Background panels: authored decoration drawn behind the level. The whole
// visual contract lives here, so the editor and the game cannot draw a backdrop
// differently — what is authored is what plays.
//
// Two rules, both structural rather than stylistic (see BackgroundData and
// "Backgrounds" in docs/game-design.md):
//
// - It is filled and **never stroked**. A border is what makes a shape read as
//   an object; a backdrop has none, and every body is drawn over it with one.
// - It is drawn **before every body**, so nothing the player can touch is ever
//   hidden behind decoration.
//
// An image fill (scale / crop / tile) lands in `fillBackground` and nowhere
// else: the caller already hands it the placement and extent an image needs.

import { Vec2 } from "../engine/vec2";
import {
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_BACKGROUND_OPACITY,
  type BackgroundData,
} from "../level/levelFormat";
import { hexToRgba } from "./color";
import { outlineHalfExtents, outlineOfData, pathOutline, type Outline } from "./shapePath";

// One panel, in the caller's world transform. Split from `drawBackgrounds` so
// the editor — which draws an `EdItem`, not a `BackgroundData` — fills through
// exactly this path and only adds its own editor-chrome outline afterwards.
export function fillBackground(
  ctx: CanvasRenderingContext2D,
  pos: Vec2,
  rot: number,
  shape: Outline,
  fill: string,
): void {
  ctx.beginPath();
  pathOutline(ctx, pos, rot, shape);
  ctx.fillStyle = fill;
  ctx.fill();
}

// Half-extents of a panel's (unrotated) bounding box, in metres — the same
// measure the editor's `halfExtents` gives an item.
export function backgroundHalfExtents(g: BackgroundData): Vec2 {
  return outlineHalfExtents(outlineOfData(g.shape));
}

// Every panel of a (metre-scaled) level, in authored order, in the caller's
// world transform. Called first by both game renderers.
export function drawBackgrounds(
  ctx: CanvasRenderingContext2D,
  backgrounds: readonly BackgroundData[],
): void {
  for (const g of backgrounds) {
    fillBackground(
      ctx,
      new Vec2(g.x, g.y),
      g.rot,
      outlineOfData(g.shape),
      hexToRgba(g.color ?? DEFAULT_BACKGROUND_COLOR, g.opacity ?? DEFAULT_BACKGROUND_OPACITY),
    );
  }
}
