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

// Camera position that frames the ball 3/5 of the way down the screen (more
// room above for the chain arc). Centering puts cam.position at the viewport
// middle, so shift the camera up by 1/10 of a viewport-height in world metres.
export function ballCameraPosition(cam: Camera, ballPos: Vec2): Vec2 {
  const scale = cam.zoom * PIXELS_PER_METER;
  return new Vec2(ballPos.x, ballPos.y - cam.viewportHeight / 10 / scale);
}

// Inverse of screenToWorld: a world-metre point → CSS-pixel screen coordinate.
export function worldToScreen(cam: Camera, world: Vec2): Vec2 {
  const scale = cam.zoom * PIXELS_PER_METER;
  return new Vec2(
    (world.x - cam.position.x) * scale + cam.viewportWidth / 2,
    (world.y - cam.position.y) * scale + cam.viewportHeight / 2,
  );
}
