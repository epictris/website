// Named level registry — the entry point for replay/playtest tooling and the
// live app to resolve a level id to its spec (static data + optional movers).

import { Vec2 } from "../engine/vec2";
import { LEVEL_2 } from "./levelData";
import { addSlidingPlatform, addWindmill } from "./movers";
import {
  TEST_BRANCH,
  TEST_LIFT,
  TEST_SPIN,
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
// The rail sandbox: a low-friction zipline between two posts, a peg, and a
// hanging lantern whose handles are rails and whose lid, bulb and base are
// hook-proof (see `lib/rail.ts`). Hand-authored, so `levels/ball.json` - which
// the editor may have open - is left alone.
import railTestJson from "../../levels/rail-test.json";
// The viscous sandbox: a mud ceiling to hang from until the cuff creeps out
// of it, and a mud wall beside a stone column to fall past and catch on (see
// `lib/viscous.ts`). Hand-authored, as the rail sandbox is.
import mudTestJson from "../../levels/mud-test.json";
// The camera sandbox: a flat run through two rooms that overlap by exactly the
// width of their falloff band (so the hand-over is an exact cross-fade), and a
// priority island at the end that takes the camera outright. Hand-authored,
// like the rail and mud sandboxes, so `levels/ball.json` is left alone.
import cameraTestJson from "../../levels/camera-test.json";
// The breakable sandbox: a stair up to a ceiling to swing from, and a row of
// breakable ledges under it at a few thresholds and durabilities, over a drop
// to the stone floor (see `level/breakable.ts`). Hand-authored, like the rail,
// mud and camera sandboxes.
import breakTestJson from "../../levels/break-test.json";

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
  // Two counter-turning rotors and a sail on an authored bearing (see
  // `TEST_SPIN`).
  TEST_SPIN,
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
  BALL: { data: ballLevelJson as RawLevelData, controller: "ball", file: "ball" },
  // Rails to clamp and slide along, driven with the ball (see `lib/rail.ts`).
  RAIL_TEST: { data: railTestJson as RawLevelData, controller: "ball", file: "rail-test" },
  // Mud to bite into and creep through, driven with the ball (see `lib/viscous.ts`).
  MUD_TEST: { data: mudTestJson as RawLevelData, controller: "ball", file: "mud-test" },
  // Geometry that gives way: swing off the ceiling and drop through it (see
  // `docs/breakable.md`). The three ledges are 2.5 kN, 5 kN, and 4 kN three
  // times over; the L at the end is one body of two pieces, so it goes as one.
  BREAK_TEST: { data: breakTestJson as RawLevelData, controller: "ball", file: "break-test" },
  // Camera regions that blend, and a priority island that does not (see
  // `docs/camera.md`). Nothing to grapple: roll right and watch the framing.
  CAMERA_TEST: { data: cameraTestJson as RawLevelData, controller: "ball", file: "camera-test" },
  // The ball & chain controller in the grapple arena, kept for A/B comparison.
  BALL_LEVEL_2: { data: LEVEL_2, controller: "ball" },
};

export const DEFAULT_LEVEL = "BALL";

// ---------------------------------------------------------------------------
// The level select's list
// ---------------------------------------------------------------------------

// One row of the level select (see `docs/levels.md`).
export interface ListedLevel {
  id: string;
  title: string;
  intro: boolean;
  // The `levels/<file>.json` stem, which is what the level hash is taken over.
  file: string;
}

// The levels `/` offers, in the order it offers them: the introduction first,
// then the rest by title, case-insensitively.
//
// FILE-BACKED BALL LEVELS ONLY, and both halves of that are deliberate. The
// hand-written `TEST_*` specs in `testLevel.ts` are rigs with no geometry an
// author owns, no bell to ring and no file to hash; the grapple levels are a
// different controller that the completion flow has never been through. Both
// stay reachable by `?level=`, which is what `unlisted` says for a level file.
//
// Derived rather than a second list, so a level added to `LEVELS` is on the
// menu by existing. What an author writes is `meta` in the file itself (see
// `LevelMetaData`), and `cli levels` is what holds the set to one intro and to
// titles that do not collide.
export function listedLevels(): ListedLevel[] {
  const rows: ListedLevel[] = [];
  for (const [id, spec] of Object.entries(LEVELS)) {
    if (spec.controller !== "ball" || !spec.file) continue;
    const meta = spec.data.meta;
    if (meta?.unlisted) continue;
    rows.push({ id, title: meta?.title ?? id, intro: meta?.intro === true, file: spec.file });
  }
  // The intro is FIRST rather than sorted into place, which is the whole of the
  // flag: a level called "Zither" that is the introduction is still the first
  // thing a new player is offered.
  return rows.sort((a, b) =>
    a.intro !== b.intro
      ? Number(b.intro) - Number(a.intro)
      : a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );
}
