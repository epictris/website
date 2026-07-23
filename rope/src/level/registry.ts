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
      // Shuttle crossing the arena above the big circle: sweeps x [-325, -135]
      // (edges [-385, -75]), clear of the leaning wall (right face ≈ -417),
      // the circle (top -53), the small walls (top -46) and the centre pillar
      // (left face -72). Peak speed 95 * 0.7 ≈ 1.1 px/frame.
      addSlidingPlatform(level, new Vec2(-230, -70), 95, 0.7);
      // Slow windmill in the upper-right pocket between the ceiling's right
      // edge (corner (156,-278), 133 px away), the 30° slope (face 128 px
      // away) and the right wall. Blade radius 110 clears all three; tip
      // speed 110 * 0.3 = 33 px/s ≈ 0.55 px/frame.
      addWindmill(level, new Vec2(280, -230), 0.3);
    },
  },
  TEST_MOVERS,
  TEST_WINDMILL,
};

export const DEFAULT_LEVEL = "LEVEL_2";
