// Surface classification ported from lib/Surface.cs.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { SurfaceType } from "./types";

// 45-degree slope from horizontal; small tolerance keeps vertical walls off "ceiling".
const MAX_WALL_SLOPE = 0.4 * Mathf.Sqrt2;
// Grip grace for rotating surfaces (game-design.md wedge rules): a rotating
// face hovering just past the static wall threshold would flip the player
// between grounded and wall-slide and treadmill them; rotating faces stay
// "floor" up to a steeper angle (~65°) so they remain runnable. Translating
// movers and the ceiling side keep the static threshold.
const ROTATING_MAX_WALL_SLOPE = 0.42;

export const Surface = {
  getSurfaceType(normal: Vec2, rotating = false): SurfaceType {
    if (normal.y > MAX_WALL_SLOPE) return SurfaceType.CEILING;
    if (normal.y > -(rotating ? ROTATING_MAX_WALL_SLOPE : MAX_WALL_SLOPE)) return SurfaceType.WALL;
    return SurfaceType.FLOOR;
  },
};
