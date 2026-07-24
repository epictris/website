// Named level registry — the entry point for replay/playtest tooling and the
// live app to resolve a level id to its spec (static data + optional movers).

import { Vec2 } from "../engine/vec2";
import { LEVEL_2 } from "./levelData";
import { addSlidingPlatform, addWindmill } from "./movers";
import { TEST_MOVERS, TEST_WINDMILL } from "./testLevel";
import type { LevelSpec } from "./level";

export const LEVELS: Record<string, LevelSpec> = {
  LEVEL_2: {
    data: LEVEL_2,
    init: (level) => {
      // Shuttle crossing the arena above the big circle: sweeps x [-3.25, -1.35]
      // (edges [-3.85, -0.75]), clear of the leaning wall (right face ≈ -4.17),
      // the circle (top -0.53), the small walls (top -0.46) and the centre
      // pillar (left face -0.72). Peak speed 0.95 * 0.7 ≈ 0.011 m/frame.
      addSlidingPlatform(level, new Vec2(-2.3, -0.7), 0.95, 0.7);
      // Slow windmill in the upper-right pocket between the ceiling's right
      // edge (corner (1.56,-2.78), 1.33 m away), the 30° slope (face 1.28 m
      // away) and the right wall. Blade radius 1.1 clears all three; tip
      // speed 1.1 * 0.3 = 0.33 m/s ≈ 0.0055 m/frame.
      addWindmill(level, new Vec2(2.8, -2.3), 0.3);
    },
  },
  TEST_MOVERS,
  TEST_WINDMILL,
  // Ball & chain controller in the LEVEL_2 arena (no movers — the ball level
  // driver has no mover support yet).
  BALL: { data: LEVEL_2, controller: "ball" },
};

export const DEFAULT_LEVEL = "LEVEL_2";
