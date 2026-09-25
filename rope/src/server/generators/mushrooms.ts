// The mushroom patch generator (tools/blender/mushrooms): the surface the
// author painted, as a triangle soup, in; a merged mesh of glowing mushrooms
// out. editor_patch.py runs the MushroomPatch Geometry Nodes group in Blender
// with every socket set from params.json and the request's overrides.

import { join } from "node:path";
import type { Generator } from "./run";
import type { Params, Schema } from "./schema";

export interface MushroomInput {
  /** Flat triangle soup in the three.js frame relative to the patch origin, metres. */
  positions: number[];
}

// Coordinates within this many metres of the patch origin (m).
const MAX_COORD = 100;
// Below this the surface has no area to grow on (m^2).
const MIN_AREA = 1e-4;

export function soupArea(positions: readonly number[]): number {
  let area = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ux = positions[i + 3]! - positions[i]!, uy = positions[i + 4]! - positions[i + 1]!, uz = positions[i + 5]! - positions[i + 2]!;
    const vx = positions[i + 6]! - positions[i]!, vy = positions[i + 7]! - positions[i + 1]!, vz = positions[i + 8]! - positions[i + 2]!;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return area;
}

export const mushrooms: Generator<MushroomInput> = {
  kind: "mushrooms",
  dir: "mushrooms",
  timeout: 300_000,

  validateInput(input, values) {
    const maxTriangles = values.maxTriangles as number;
    const maxEstimate = values.maxEstimate as number;
    const density = values.density as number;
    const positions = (input as MushroomInput | null)?.positions;
    if (
      !Array.isArray(positions) ||
      positions.length < 9 ||
      positions.length % 9 !== 0 ||
      positions.length > maxTriangles * 9 ||
      positions.some((n) => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > MAX_COORD)
    )
      throw new Error(`Select 1-${maxTriangles} faces within ${MAX_COORD} metres of the patch origin.`);
    const area = soupArea(positions);
    if (area < MIN_AREA) throw new Error("The selected surface is too small or has zero area.");
    // The node group's No Overlaps pass is exact and pairwise, so its cost grows
    // with the square of the count; past maxEstimate the bake stops being
    // interactive.
    if (area * density > maxEstimate)
      throw new Error(
        `About ${Math.round(area * density)} mushrooms (${area.toFixed(2)} m²); ` +
          `lower the density or select less than ${maxEstimate} / density m².`,
      );
    return { positions };
  },

  request(input, overrides: Params, schema: Schema) {
    return { kind: "mushrooms", version: schema.version, positions: input.positions, params: overrides };
  },

  missing: (tools) => (tools.blender ? null : "No Blender found: put blender on PATH, or set BLENDER_PATH."),

  command(tools, root, requestFile, outDir) {
    const script = join(root, "tools", "blender", "mushrooms", "editor_patch.py");
    return {
      file: tools.blender!,
      args: ["--background", "--factory-startup", "--python-exit-code", "1", "--python", script, "--", "--spec", requestFile, "--out", outDir],
    };
  },

  output: (outDir) => join(outDir, "mushrooms.glb"),

  // editor_patch.py states its own refusals on a `MUSHROOMS:` line; its success
  // line carries "->", which is not a reason.
  failure(stdout, stderr, fallback, kept) {
    const said = /MUSHROOMS: (.*)/.exec(stdout + stderr)?.[1];
    if (said && !said.includes("->")) return said;
    return `Mushroom generation failed.\nOutput kept in ${kept}\n${(stderr || stdout || fallback).slice(-1800)}`;
  },
};
