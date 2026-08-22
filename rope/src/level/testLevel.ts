// Hand-written mover test levels: a sliding platform and a rotating windmill.
// Exercise velocity inheritance, surface reclassification and ledge grabbing
// on mobile shapes (game-design.md).

import { Vec2 } from "../engine/vec2";
import { addSlidingPlatform, addWindmill } from "./movers";
import type { LevelData } from "./levelData";
import type { RawLevelData } from "./levelFormat";
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

// A spring body to hang off (see `LevelBodyData.springFreqX`): one leaf reaching
// out over a chasm, sprung at 1.5 Hz sideways and 1 Hz vertically.
//
// The CHASM is the whole layout. A spring body's interesting range is the tens
// of centimetres between its unloaded droop and its loaded one, so a leaf hung
// over solid ground either has to be stiff enough that nothing visible happens
// or ends up resting on the floor with the player standing on it; over a pit it
// has room to sag, to be dived off, and to spring back.
//
// The leaf is 1.6 x 0.24 m of oak at the default 20 cm thickness, so it weighs
// 53.8 kg, and at 1 Hz that is:
//
//   its own weight   g/w²            = 24.8 cm of droop, resting it at y = 1.458
//   a hung player    F/(m·w²)        = 31.3 cm more, to y = 1.772
//   the spring back  62% of the drop = a 19.6 cm overshoot above its rest height
//
// and the approach is the run-off rather than a jump, because a ledge grab needs
// the corner reached from BELOW or alongside - arriving from above is a landing,
// not a grab. So the leaf hangs 54 cm under the lip and 1.1 m out from it, which
// is where a player running off the left edge at full speed is on the frame it
// has fallen to the leaf's own height: the grab reach is only radius + 5 cm, so
// that intersection is what the numbers are chosen for. `playtests/
// ledge-spring-leaf.json` is the same run scripted, and it fails on a hang that
// transfers no weight.
const SPRING_DATA: RawLevelData = {
  player: { x: -300, y: 20, radius: 8 },
  bodies: [
    // The left approach, ending at x = 0 - the lip the run leaves from.
    {
      kind: "static",
      x: -400,
      y: 100,
      rot: 0,
      objects: [
        { type: "collision", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 800, h: 40 } },
      ],
    },
    // The far side, to climb out onto.
    {
      kind: "static",
      x: 700,
      y: 100,
      rot: 0,
      objects: [
        { type: "collision", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 800, h: 40 } },
      ],
    },
    // The pit floor, far enough down that the leaf's whole travel is clear of it.
    {
      kind: "static",
      x: 150,
      y: 400,
      rot: 0,
      objects: [
        { type: "collision", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 340, h: 40 } },
      ],
    },
    // The leaf, spanning x = 1.1 .. 2.7 m over the chasm, so its LEFT corner is
    // the one the fall arrives at and its far end stops 30 cm short of the wall
    // even at the extreme of its sideways sway.
    {
      kind: "rigid",
      x: 190,
      y: 121,
      rot: 0,
      color: "#4c8c4a",
      springFreqX: 1.5,
      springFreqY: 1,
      objects: [
        { type: "collision", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 160, h: 24 } },
      ],
    },
  ],
};

export const TEST_SPRING: LevelSpec = { data: SPRING_DATA };
