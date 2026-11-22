// Which tier of a formation's bake the game loads (docs/formations.md, "Level
// of detail"): the one the formation names, or the automatic one, chosen by
// how far behind the play plane the rock stands.

import { PIXELS_PER_METER } from "../engine/units";
import type { FormationData } from "../level/levelFormat";
import { BALL_ZOOM } from "../render/camera";
import { VIEW_HEIGHT } from "../render/viewport";

// The game's vertical field of view (render3d/space.ts `FOV_Y_DEG`, which
// imports three and so is not imported here), held to it by
// scripts/test-formations.ts.
export const FOV_Y_DEG = 34;

// How far the game camera stands from the play plane at the level's own zoom
// and a 1080-line frame: the distance a texel's size on screen is measured
// against (`autoTier`).
export const PLANE_DISTANCE = VIEW_HEIGHT / BALL_ZOOM / PIXELS_PER_METER / 2 / Math.tan((FOV_Y_DEG * Math.PI) / 360);

// The tier a rock `behind` metres back from the play plane can draw without
// a texel showing larger than tier 0's does on the plane: each tier halves
// the maps' side, and a surface d behind the plane is drawn PLANE_DISTANCE /
// (PLANE_DISTANCE + d) as large, so tier k is enough from where that ratio
// reaches 1 / 2^k.
export function autoTier(behind: number, tiers: number): number {
  if (tiers <= 0) return 0;
  const k = Math.floor(Math.log2((PLANE_DISTANCE + Math.max(0, behind)) / PLANE_DISTANCE));
  return Math.max(0, Math.min(tiers - 1, k));
}

// The tier the game loads, or null when there is no bake (the iteration
// geometry is drawn instead).
export function chosenTierOf(f: FormationData): number | null {
  const tiers = f.built?.tiers.length ?? 0;
  if (!f.built || !tiers) return null;
  if (typeof f.lod === "number") return Math.max(0, Math.min(tiers - 1, Math.round(f.lod)));
  return autoTier(-f.built.front, tiers);
}
