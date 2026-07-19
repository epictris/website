// Slide classification ported from lib/Slide.cs.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { SlideType } from "./types";

export const Slide = {
  canSlideToSurface(motion: Vec2, surfaceNormal: Vec2): boolean {
    return Mathf.abs(surfaceNormal.angleTo(motion)) < Mathf.Pi * 0.75;
  },

  getSlideType(motion: Vec2, surfaceNormal: Vec2): SlideType {
    if (Mathf.abs(surfaceNormal.angleTo(motion)) < Mathf.Pi * 0.75) {
      return SlideType.KEEP_VELOCITY;
    }
    return SlideType.PROJECT_VELOCITY;
  },
};
