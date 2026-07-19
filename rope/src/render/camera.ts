import { Vec2 } from "../engine/vec2";

export interface Camera {
  position: Vec2;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
}

export function screenToWorld(cam: Camera, screenX: number, screenY: number): Vec2 {
  return cam.position.add(
    new Vec2(
      (screenX - cam.viewportWidth / 2) / cam.zoom,
      (screenY - cam.viewportHeight / 2) / cam.zoom,
    ),
  );
}
