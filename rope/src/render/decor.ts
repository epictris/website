// Decoration: the authored forms that are drawn and never simulated - a body's
// geometry objects that carry a shape of their own (see `level/decor.ts`). The
// whole visual contract lives here, so the editor and the game cannot draw it
// differently — what is authored is what plays.
//
// Two rules, both structural rather than stylistic (see "Backgrounds" in
// docs/game-design.md, which is the rule this inherits):
//
// - It is filled and **never stroked**. A border is what makes a shape read as
//   an object; decoration has none, and every body is drawn over it with one.
//   That is what keeps "anything the player passes through reads as
//   pass-through" true now that decoration and geometry are one authored type
//   distinguished by a flag rather than two lists.
// - It is drawn **before every body**, whatever its position in the authored
//   list, so nothing the player can touch is ever hidden behind it.

import { Vec2 } from "../engine/vec2";
import {
  DEFAULT_BODY_COLOR,
  DEFAULT_BODY_OPACITY,
  type GeometryObjectData,
} from "../level/levelFormat";
import { decorTransform, depthOf, type SceneDecor } from "../level/decor";
import { hexToRgba } from "./color";
import { outlineHalfExtents, outlineOfData, pathOutline, type Outline } from "./shapePath";

// One piece, in the caller's world transform. Split from `drawDecor` so the
// editor — which draws an `EdItem`, not a `LevelBodyData` — fills through
// exactly this path and only adds its own editor-chrome outline afterwards.
export function fillDecor(
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

// Half-extents of a form's (unrotated) bounding box, in metres — the same
// measure the editor's `halfExtents` gives an item.
export function decorHalfExtents(o: GeometryObjectData): Vec2 {
  return o.shape ? outlineHalfExtents(outlineOfData(o.shape)) : Vec2.ZERO;
}

// Every drawn-only form of a (metre-scaled) level, in authored order, in the
// caller's world transform. Called first by both game renderers.
//
// A form in a body that also has collision objects is drawn in that body's frame
// (`decorTransform`), so it moves with the thing it decorates; one in a body
// that built nothing draws exactly where it was authored. `alpha` is the render
// interpolation the rest of the frame uses, and an attached form has to be drawn
// against the same interpolated pose as the body itself.
export function drawDecor(
  ctx: CanvasRenderingContext2D,
  decor: readonly SceneDecor[],
  alpha: number,
): void {
  // Back to front, so the 2D view agrees with the 3D one about which of two
  // overlapping backdrops is in front - and with what a click in the editor
  // selects, which goes through the same `depthOf`. Authored order breaks a tie,
  // and `sort` is stable, so decoration that authors no depth at all draws
  // exactly as it always did.
  const ordered = [...decor].sort(
    (a, b) => depthOf(a.built.data, a.object) - depthOf(b.built.data, b.object),
  );
  for (const d of ordered) {
    const { pos, rot } = decorTransform(d, alpha);
    // Its OWN fill and not the body's: a backdrop is authored to sit behind the
    // geometry, so painting it the body's colour is exactly wrong (which is the
    // same reason the retired `syncGroupProps` left a non-colliding member
    // alone). Absent, it falls back to the body's, so a lantern welded onto a
    // crate and authored no colour still reads as part of it.
    const color = d.object.color ?? d.built.data.color ?? DEFAULT_BODY_COLOR;
    const opacity = d.object.opacity ?? d.built.data.opacity ?? DEFAULT_BODY_OPACITY;
    fillDecor(ctx, pos, rot, outlineOfData(d.object.shape!), hexToRgba(color, opacity));
  }
}
