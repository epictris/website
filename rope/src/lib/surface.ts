// Surface classification ported from lib/Surface.cs.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { SurfaceType } from "./types";

// 45-degree slope from horizontal; small tolerance keeps vertical walls off "ceiling".
const MAX_WALL_SLOPE = 0.4 * Mathf.Sqrt2;

export const Surface = {
  getSurfaceType(normal: Vec2): SurfaceType {
    if (normal.y > MAX_WALL_SLOPE) return SurfaceType.CEILING;
    if (normal.y > -MAX_WALL_SLOPE) return SurfaceType.WALL;
    return SurfaceType.FLOOR;
  },
};
