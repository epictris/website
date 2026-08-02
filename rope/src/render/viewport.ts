// The game is drawn into a fixed 16:9 frame, scaled to fit whatever it is drawn
// into.
//
// It is 1920×1080 because that is the resolution the zoom constants are tuned
// against: a full-screen 1080p display is what `GRAPPLE_ZOOM` and `BALL_ZOOM`
// were being read on, so at that size the frame is 1:1 and every other display
// is the same picture, larger or smaller.
//
// Everything above the canvas — the camera, the renderer, pointer un-projection
// — works in VIEW_WIDTH × VIEW_HEIGHT *view pixels* and never sees the window's
// real size, so every player is shown exactly the same slice of the world
// whatever their display is. That is what makes a level's framing authorable at
// all: a camera region's `viewportScale` says how much world is on screen, and
// it can only mean something if "the screen" is a fixed shape. Sized off the
// window instead, a tall monitor saw further up and down than a laptop, and a
// phone in landscape saw a different level again.
//
// The window decides one thing: how large that frame is drawn. It is centred and
// scaled by the tighter of the two axes, and whatever is left over on the other
// axis is background — letterbox bars above and below on a 4:3 display,
// pillarbox bars either side on a phone.

import { Vec2 } from "../engine/vec2";

export const VIEW_WIDTH = 1920;
export const VIEW_HEIGHT = 1080;

// The bars the frame is centred in. The game and the frame grabber let the
// page's own background be this (their canvas *is* the frame); a canvas the
// frame does not fill — the editor's ▶ Test, which borrows the whole editor
// canvas — has to paint it.
export const LETTERBOX_COLOR = "#1f2430";

// Where the frame lands inside the surface it is drawn on, and how big. `scale`
// is target pixels per view pixel and the origin is the frame's top-left corner
// in target pixels — the two together are exactly the canvas transform the
// renderer sets, which is why they travel as one value rather than as a scale
// the caller pairs with dimensions it works out itself.
//
// The same shape describes the frame in *client* pixels (see `clientToView`), so
// a pointer is un-projected through the identical arithmetic the frame was drawn
// with rather than through a second copy of it.
export interface ViewTransform {
  scale: number;
  originX: number;
  originY: number;
  // The frame's own size, always VIEW_WIDTH × VIEW_HEIGHT (1920 × 1080). Carried so the
  // renderer takes one argument for the whole view.
  width: number;
  height: number;
}

// Fit the 16:9 frame into a `width` × `height` surface, centred.
export function viewTransform(width: number, height: number): ViewTransform {
  const scale = Math.min(width / VIEW_WIDTH, height / VIEW_HEIGHT);
  return {
    scale,
    originX: (width - VIEW_WIDTH * scale) / 2,
    originY: (height - VIEW_HEIGHT * scale) / 2,
    width: VIEW_WIDTH,
    height: VIEW_HEIGHT,
  };
}

// Size `canvas` to the largest 16:9 frame that fits the window and return the
// transform to draw it with. The backing store is the CSS size times the DPR, so
// the frame is drawn at the display's real resolution rather than upscaled from
// 1920×1080 — which is the role `devicePixelRatio` played on its own before the
// fit existed, and it still carries it, folded into `scale`.
//
// The canvas's parent (if any) is sized with it, so an overlay positioned inside
// it — the touch controls — is positioned against the play frame rather than
// against the window, and never lands in a letterbox bar.
// Takes a LIST because the frame may be drawn by more than one canvas stacked on
// the same rectangle: the WebGL scene underneath and the 2D overlay on top (see
// render3d/scene.ts). They must be sized by one arithmetic rather than two, or
// an outline drawn on the overlay lands a device pixel off the geometry it
// describes at some window sizes and not others.
export function fitCanvas(canvas: HTMLCanvasElement | HTMLCanvasElement[]): ViewTransform {
  const canvases = Array.isArray(canvas) ? canvas : [canvas];
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.min(window.innerWidth / VIEW_WIDTH, window.innerHeight / VIEW_HEIGHT);
  const cssWidth = VIEW_WIDTH * scale;
  const cssHeight = VIEW_HEIGHT * scale;

  // The backing store is whole device pixels, and its height is derived from its
  // rounded width rather than rounded on its own: the frame is drawn under a
  // single uniform scale, so the two dimensions have to agree about what that
  // scale is or the bottom of the frame is drawn a pixel outside it.
  const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
  const pixelHeight = Math.max(1, Math.round((pixelWidth * VIEW_HEIGHT) / VIEW_WIDTH));

  for (const c of canvases) {
    const frame = c.parentElement;
    if (frame) {
      frame.style.width = `${cssWidth}px`;
      frame.style.height = `${cssHeight}px`;
    }
    c.style.width = `${cssWidth}px`;
    c.style.height = `${cssHeight}px`;
    c.width = pixelWidth;
    c.height = pixelHeight;
  }
  return viewTransform(pixelWidth, pixelHeight);
}

// A browser event's client coordinates → the view pixel they landed on. The
// canvas's offset in the page and the frame's fit inside it are both read from
// its live rect, so this is correct during a resize, needs nothing kept in step
// with `fitCanvas`, and is equally correct for a canvas the frame does not fill
// (the editor's ▶ Test, which borrows the whole editor canvas).
export function clientToView(canvas: HTMLCanvasElement, clientX: number, clientY: number): Vec2 {
  const rect = canvas.getBoundingClientRect();
  const fit = viewTransform(rect.width, rect.height);
  if (fit.scale <= 0) return Vec2.ZERO; // not laid out yet: no mapping to speak of
  return new Vec2(
    (clientX - rect.left - fit.originX) / fit.scale,
    (clientY - rect.top - fit.originY) / fit.scale,
  );
}

// View pixels per client pixel — what a *delta* in client space (a pointer-lock
// `movementX/Y`) has to be multiplied by to become one in view space. A canvas
// that is not laid out yet has no scale to speak of, so it reports 1 rather than
// dividing by zero.
export function viewPerClientPx(canvas: HTMLCanvasElement): number {
  const rect = canvas.getBoundingClientRect();
  const fit = viewTransform(rect.width, rect.height);
  return fit.scale > 0 ? 1 / fit.scale : 1;
}
