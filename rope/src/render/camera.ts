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

// Ball & chain plays at a tighter scale than the grapple level. It is a plain
// constant because the view is a fixed 16:9 frame scaled to fit the window (see
// render/viewport.ts): a short window makes the whole frame smaller rather than
// showing less of the level, so there is no longer a viewport height for a zoom
// to be derived from. It used to scale down on short viewports, which is what
// let a landscape phone frame the ball and its chain arc.
export const BALL_ZOOM = 2.2;

// Inverse of screenToWorld: a world-metre point → CSS-pixel screen coordinate.
export function worldToScreen(cam: Camera, world: Vec2): Vec2 {
  const scale = cam.zoom * PIXELS_PER_METER;
  return new Vec2(
    (world.x - cam.position.x) * scale + cam.viewportWidth / 2,
    (world.y - cam.position.y) * scale + cam.viewportHeight / 2,
  );
}
