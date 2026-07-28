import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER } from "../engine/units";

export interface Camera {
  position: Vec2;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
}

// Screen pixels per world metre: the view scale (camera.zoom) times the
// metre↔pixel conversion. This mirrors the render transform exactly, so a
// pointer un-projects back to the metre coordinate it was drawn at.
export function screenToWorld(cam: Camera, screenX: number, screenY: number): Vec2 {
  const scale = cam.zoom * PIXELS_PER_METER;
  return cam.position.add(
    new Vec2((screenX - cam.viewportWidth / 2) / scale, (screenY - cam.viewportHeight / 2) / scale),
  );
}

// Base view scale of the grapple controller — the zoom a level frames at with
// no camera region in force. A region's `viewportScale` is applied on top of it
// by the CameraController.
export const GRAPPLE_ZOOM = 2;

// Ball & chain plays at a tighter scale than the grapple level (BALL_ZOOM on a
// desktop-height viewport), but scales down on short viewports so a landscape
// phone still frames the ball and its chain arc. Height-driven: the vertical
// span is what has to fit. Shared by the game (main.ts) and the editor's inline
// ▶ Test Ball, so both frame the ball identically.
export const BALL_ZOOM = 2.2;
const BALL_ZOOM_REF_HEIGHT = 900; // viewport height the base zoom is tuned for
export function ballZoom(viewportHeight: number): number {
  return Math.min(BALL_ZOOM, BALL_ZOOM * (viewportHeight / BALL_ZOOM_REF_HEIGHT));
}

// Inverse of screenToWorld: a world-metre point → CSS-pixel screen coordinate.
export function worldToScreen(cam: Camera, world: Vec2): Vec2 {
  const scale = cam.zoom * PIXELS_PER_METER;
  return new Vec2(
    (world.x - cam.position.x) * scale + cam.viewportWidth / 2,
    (world.y - cam.position.y) * scale + cam.viewportHeight / 2,
  );
}
