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

// A BRANCH to hang off (see `LevelBodyData.pivotX` / `pivotFreq`): the spring
// level's chasm again, with the leaf replaced by a bough hinged where it meets
// the far wall. Where the leaf TRANSLATES on its spring, the branch ROTATES
// about its bearing - grab the free end and the whole thing swings down about
// the trunk, then springs back up to its authored angle when you let go.
//
// The branch is 1.9 x 0.24 m of oak at the default 20 cm thickness, 63.8 kg,
// hinged at its right end (pivotX = +95 px), so the centre of mass sits
// d = 0.95 m out from the bearing and I about the bearing is
// I_com + m·d² ≈ 77 kg·m². At 1.25 Hz the closed forms
// (`I·w²·Δθ = τ·cos θ`) give:
//
//   its own weight   m·g·d = 594 N·m    ≈  7° of droop, the tip down ~23 cm
//   a player on the tip adds 1303 N·m   ≈ 21° in all, the tip down ~69 cm
//
// so the swing is felt in tens of centimetres over the pit, exactly the range
// the leaf's numbers were chosen for, and the free end still crosses the
// run-off arrival height at x = 1.1 m. Damping 0.2 leaves a few visible
// swings on the spring back.
const BRANCH_DATA: RawLevelData = {
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
    // The far side, whose left face (x = 300) is the trunk the branch grows out
    // of.
    {
      kind: "static",
      x: 700,
      y: 100,
      rot: 0,
      objects: [
        { type: "collision", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 800, h: 40 } },
      ],
    },
    // The pit floor, far enough down that the branch's whole travel clears it.
    {
      kind: "static",
      x: 150,
      y: 400,
      rot: 0,
      objects: [
        { type: "collision", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 340, h: 40 } },
      ],
    },
    // The branch: free end at x = 1.1 m over the pit, bearing at the far wall's
    // face.
    {
      kind: "rigid",
      x: 205,
      y: 121,
      rot: 0,
      color: "#7a5a3a",
      pivot: true,
      pivotX: 95,
      pivotY: 0,
      pivotFreq: 1.25,
      pivotDamping: 0.2,
      objects: [
        { type: "collision", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 190, h: 24 } },
      ],
    },
  ],
};

export const TEST_BRANCH: LevelSpec = { data: BRANCH_DATA };

// Vines to swing on (see `level/vines.ts`): a chasm with two hanging from
// branches over it, a third long enough to pool on the far ledge, and a fourth
// SPANNING between the second and third branches - attached at both ends, with
// a metre of slack, so it drapes in a catenary the player can grab anywhere
// along.
//
// The layout is the mechanic. A vine is only interesting where the alternative
// is falling, so the two swing vines hang over an 8 m gap at heights a player
// running off the left lip can reach with the hook - and they are placed a swing
// apart rather than side by side, because chaining one to the next is the thing
// a vine offers that a static anchor does not.
//
// The third hangs 7 m from a branch 5.6 m above the right ledge. It used to
// drape 1.4 m of itself onto that ledge; vines ignore the scenery now (see
// `level/vines.ts`), so it hangs its full length straight through it - kept as
// authored, as the visible statement of that contract.
const VINE_DATA: RawLevelData = {
  player: { x: -300, y: 20, radius: 8 },
  bodies: [
    // The left approach, ending at x = 0 - the lip the run leaves from.
    {
      kind: "static",
      x: -500,
      y: 100,
      rot: 0,
      objects: [{ type: "collision", shape: { kind: "rect", w: 1000, h: 40 } }],
    },
    // The far side, to land on. Deliberately 2.5 m LOWER than the lip: a swing
    // ends where the arc puts you, and a landing you have to reach on the way
    // down is what the two vines are for. Level with the lip it is unreachable -
    // a player hanging on a 4 m vine is 4 m below its branch however far the
    // swing carries them.
    {
      kind: "static",
      x: 1300,
      y: 330,
      rot: 0,
      objects: [{ type: "collision", shape: { kind: "rect", w: 1000, h: 40 } }],
    },
    // The pit floor, far enough down that a missed swing is a fall rather than
    // a stumble.
    {
      kind: "static",
      x: 400,
      y: 700,
      rot: 0,
      objects: [{ type: "collision", shape: { kind: "rect", w: 1000, h: 40 } }],
    },
    // First branch, 4.3 m above the lip.
    {
      kind: "static",
      x: 250,
      y: -350,
      rot: 0,
      color: "#4a3b2a",
      objects: [
        { type: "collision", shape: { kind: "rect", w: 220, h: 40 } },
        { type: "anchor", id: 1, x: 0, y: 20 },
      ],
    },
    // Second branch, a swing further on and a metre lower.
    {
      kind: "static",
      x: 620,
      y: -250,
      rot: 0,
      color: "#4a3b2a",
      objects: [
        { type: "collision", shape: { kind: "rect", w: 220, h: 40 } },
        { type: "anchor", id: 2, x: 0, y: 20 },
      ],
    },
    // The branch the third vine pools from, over the far ledge.
    {
      kind: "static",
      x: 1100,
      y: -500,
      rot: 0,
      color: "#4a3b2a",
      objects: [
        { type: "collision", shape: { kind: "rect", w: 220, h: 40 } },
        { type: "anchor", id: 3, x: 0, y: 20 },
      ],
    },
  ],
  // 25 cm rather than the 15 cm default, because the cost of a vine is its LINK
  // COUNT and a level pays for all of them at once: these three at the default
  // are 111 links and 8.0 ms a frame of a 16.7 ms budget, for scenery. At 25 cm
  // they are 66 links and 2.4 ms, and what it costs is a slightly coarser drape -
  // the grab radius grows with the spacing, so grabbing anywhere along one is
  // unaffected (see `DEFAULT_VINE_SPACING`).
  vines: [
    { anchor: 1, length: 500, spacing: 25 },
    { anchor: 2, length: 450, spacing: 25 },
    { anchor: 3, length: 850, spacing: 25 },
    // The span: the same two branches the second and third vines hang from,
    // ~5.4 m apart, with 6.5 m of vine between them - a metre of slack, worn
    // as the sag.
    { anchor: 2, anchor2: 3, length: 650, spacing: 25 },
  ],
};

export const TEST_VINES: LevelSpec = { data: VINE_DATA };

// Trampolines to bounce and be thrown by (see `LevelBodyData.bounce`): a floor
// with three pads set flush into it, and a bouncy wall to be flung off.
//
// The three pads are the mechanic's two halves and the difference between them,
// laid out so an author can feel it rather than read it. The first states a
// BOUNCE and no launch, which is the lively floor: roll onto it and nothing
// happens, drop onto it from the ledge and most of the drop comes back. The
// other two state a LAUNCH and no bounce, at 6 and 10 m/s, and they throw
// whatever touches them 1.8 m and 5.1 m up whether it arrived from a hop or a
// dive. The far one is sized to the ledge above it, which is what a launch is
// for: a jump an author can place, because the height it reaches is a property
// of the pad and not of how the player happened to arrive.
//
// The pads are floor SEGMENTS rather than slabs laid on top of one, so the
// surface stays flush and a ball rolls onto a pad without a step to climb. The
// wall is at the right-hand end, where a ball driven along the floor arrives at
// speed with somewhere to be thrown back to.
const TRAMPOLINE_DATA: RawLevelData = {
  player: { x: -1400, y: -100, radius: 8 },
  bodies: [
    // The floor, in the segments the pads are set between. Top face at y = 0.
    ...([
      { x: -1300, w: 600 },
      { x: -400, w: 400 },
      { x: 400, w: 400 },
      { x: 1300, w: 600 },
    ].map((seg) => ({
      kind: "static" as const,
      x: seg.x,
      y: 100,
      rot: 0,
      objects: [{ type: "collision" as const, shape: { kind: "rect" as const, w: seg.w, h: 200 } }],
    }))),
    // The lively floor: gives back most of a drop, and nothing at all to a body
    // that rolls across it.
    {
      kind: "static",
      x: -800,
      y: 100,
      rot: 0,
      color: "#8a4f7d",
      bounce: 0.85,
      objects: [{ type: "collision", shape: { kind: "rect", w: 400, h: 200 } }],
    },
    // A short pad: 6 m/s, so 1.8 m up.
    {
      kind: "static",
      x: 0,
      y: 100,
      rot: 0,
      color: "#4f8a6b",
      launch: 600,
      objects: [{ type: "collision", shape: { kind: "rect", w: 400, h: 200 } }],
    },
    // ...and the one the ledge is placed against: 10 m/s, so 5.1 m up.
    {
      kind: "static",
      x: 800,
      y: 100,
      rot: 0,
      color: "#c4813d",
      launch: 1000,
      objects: [{ type: "collision", shape: { kind: "rect", w: 400, h: 200 } }],
    },
    // The ledge the far pad reaches, 4.2 m up and set back over the floor so the
    // throw has to carry some travel with it rather than landing where it left.
    {
      kind: "static",
      x: 400,
      y: -400,
      rot: 0,
      objects: [{ type: "collision", shape: { kind: "rect", w: 400, h: 40 } }],
    },
    // The left wall, plain, and the right one bouncy - a ball driven along the
    // floor arrives at it with speed and is thrown back down the level.
    {
      kind: "static",
      x: -1650,
      y: -600,
      rot: 0,
      objects: [{ type: "collision", shape: { kind: "rect", w: 100, h: 1400 } }],
    },
    {
      kind: "static",
      x: 1650,
      y: -600,
      rot: 0,
      color: "#8a4f7d",
      bounce: 0.85,
      objects: [{ type: "collision", shape: { kind: "rect", w: 100, h: 1400 } }],
    },
  ],
};

export const TEST_TRAMPOLINE: LevelSpec = { data: TRAMPOLINE_DATA, controller: "ball" };
