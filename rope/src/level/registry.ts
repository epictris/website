// Named level registry — the entry point for replay/playtest tooling and the
// live app to resolve a level id to its spec (static data + optional movers).

import { Vec2 } from "../engine/vec2";
import { LEVEL_2 } from "./levelData";
import { addSlidingPlatform, addWindmill } from "./movers";
import {
  TEST_BRANCH,
  TEST_LIFT,
  TEST_SWING,
  TEST_MOVERS,
  TEST_SPRING,
  TEST_TRAMPOLINE,
  TEST_VINES,
  TEST_WINDMILL,
} from "./testLevel";
import type { LevelSpec } from "./level";
import type { RawLevelData } from "./levelFormat";
// The hand-authored ball arena, bundled straight from the editor's on-disk
// store so the level has one source of truth. The dev-only /api/levels route
// serves the same file to the editor; importing it here compiles it into the
// built app, which has no server. JSON widens string literals (`kind: string`),
// hence the cast — the file is written by the editor against this schema.
import ballLevelJson from "../../levels/ball.json";

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
  // A spring body to hang off, dive from and hook into (see `TEST_SPRING`).
  TEST_SPRING,
  // A branch on a sprung bearing to swing down and be sprung back by
  // (see `TEST_BRANCH`).
  TEST_BRANCH,
  // Two kinematic pendulums to time a crossing against (see `TEST_SWING`).
  TEST_SWING,
  // A lift, a trolley on a loop and an eased shuttle (see `TEST_LIFT`).
  TEST_LIFT,
  // Hanging vines over a chasm, to swing across and to see drape and pool
  // (see `TEST_VINES`).
  TEST_VINES,
  // Trampolines to be thrown by, driven with the ball (see `TEST_TRAMPOLINE`).
  TEST_TRAMPOLINE,
  // Ball & chain controller in its own authored arena. Any mover in it is one
  // the FILE authored - a swinging body (see `LevelBodyData.swingAmp`) - since
  // the ball driver takes no `init` hook.
  BALL: { data: ballLevelJson as RawLevelData, controller: "ball" },
  // The ball & chain controller in the grapple arena, kept for A/B comparison.
  BALL_LEVEL_2: { data: LEVEL_2, controller: "ball" },
};

export const DEFAULT_LEVEL = "BALL";
