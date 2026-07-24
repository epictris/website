// Hand-written mover test levels: a sliding platform and a rotating windmill.
// Exercise velocity inheritance, surface reclassification and ledge grabbing
// on mobile shapes (game-design.md).

import { Vec2 } from "../engine/vec2";
import { addSlidingPlatform, addWindmill } from "./movers";
import type { LevelData } from "./levelData";
import type { LevelSpec } from "./level";

// Peak platform speed = amplitude * ω = 0.8 * 0.8 = 0.64 m/s ≈ 0.0107 m/frame.
// Windmill blade tip speed = 1.1 * 0.6 = 0.66 m/s ≈ 0.011 m/frame.

// Player spawns on the sliding platform (floor top face is at y=80).
const MOVERS_DATA: LevelData = {
  player: { x: -200, y: 20, radius: 8 },
  bodies: [
    { kind: "static", x: 0, y: 100, rot: 0, shape: { kind: "rect", w: 1200, h: 40 } },
    { kind: "static", x: -520, y: -60, rot: 0, shape: { kind: "rect", w: 40, h: 280 } },
  ],
};

export const TEST_MOVERS: LevelSpec = {
  data: MOVERS_DATA,
  init: (level) => {
    addSlidingPlatform(level, new Vec2(-2, 0.4), 0.8, 0.8);
    addWindmill(level, new Vec2(3.8, -0.8), 0.6);
  },
};

// Player spawns falling onto the windmill blade while it is near-horizontal.
const WINDMILL_DATA: LevelData = {
  player: { x: 60, y: -70, radius: 8 },
  bodies: [
    { kind: "static", x: 0, y: 100, rot: 0, shape: { kind: "rect", w: 1200, h: 40 } },
  ],
};

export const TEST_WINDMILL: LevelSpec = {
  data: WINDMILL_DATA,
  init: (level) => {
    addWindmill(level, new Vec2(0, -0.4), 0.6);
  },
};
