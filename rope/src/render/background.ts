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

// One panel, in the caller's world transform. Split from `drawBackgrounds` so
// the editor — which draws an `EdItem`, not a `BackgroundData` — fills through
// exactly this path and only adds its own editor-chrome outline afterwards.
export function fillBackground(
  ctx: CanvasRenderingContext2D,
  pos: Vec2,
  rot: number,
  half: Vec2,
  circle: boolean,
  fill: string,
): void {
  ctx.beginPath();
  if (circle) {
    ctx.arc(pos.x, pos.y, half.x, 0, Math.PI * 2);
  } else {
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(rot);
    ctx.rect(-half.x, -half.y, half.x * 2, half.y * 2);
    ctx.restore();
  }
  ctx.fillStyle = fill;
  ctx.fill();
}

// Half-extents of a panel's (unrotated) box, in metres — the same measure the
// editor's `halfExtents` gives an item.
export function backgroundHalfExtents(g: BackgroundData): Vec2 {
  return g.shape.kind === "circle"
    ? new Vec2(g.shape.r, g.shape.r)
    : new Vec2(g.shape.w / 2, g.shape.h / 2);
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
      backgroundHalfExtents(g),
      g.shape.kind === "circle",
      hexToRgba(g.color ?? DEFAULT_BACKGROUND_COLOR, g.opacity ?? DEFAULT_BACKGROUND_OPACITY),
    );
  }
}
