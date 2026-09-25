// The boulder v5 generator (tools/blender/boulders): a collision outline in, a
// fractured, bevelled, baked stone out. rockgen.py builds the pieces in Python
// and runs Blender for the booleans, remesh, decimation and bake; its request
// is the outline plus the parameters that differ from params.json, and
// `read_specs` derives the fork's full spec from them (slab count, tolerance).

import { join } from "node:path";
import { generatorFailure } from "./failure";
import type { Generator } from "./run";
import type { Params, Schema } from "./schema";

export interface BoulderInput {
  /** The object's local outline, metres, y up, as [x, y] pairs. */
  outline: number[][];
}

// The outline's bounds, as the fork's server checked them: a vertex count the
// Boolean pass handles, and coordinates within this many metres of the origin.
const MAX_VERTICES = 128;
const MAX_COORD = 100; // m
// Below this the outline has no area to build a rock on (m^2).
const MIN_AREA = 1e-4;

/** Shoelace area (m^2), in the order the fork's server summed it. */
export function outlineArea(outline: readonly number[][]): number {
  return Math.abs(
    outline.reduce((sum, point, i) => {
      const next = outline[(i + 1) % outline.length]!;
      return sum + point[0]! * next[1]! - next[0]! * point[1]!;
    }, 0) / 2,
  );
}

export const boulder: Generator<BoulderInput> = {
  kind: "boulder",
  dir: "boulders",
  timeout: 600_000,

  validateInput(input) {
    const outline = (input as BoulderInput | null)?.outline;
    if (
      !Array.isArray(outline) ||
      outline.length < 3 ||
      outline.length > MAX_VERTICES ||
      outline.some(
        (p) =>
          !Array.isArray(p) ||
          p.length !== 2 ||
          p.some((n) => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > MAX_COORD),
      )
    )
      throw new Error(`Use an outline of 3-${MAX_VERTICES} vertices, within ${MAX_COORD} metres of its origin.`);
    if (outlineArea(outline) < MIN_AREA) throw new Error("The outline is too small or has zero area.");
    return { outline };
  },

  request(input, overrides: Params, schema: Schema) {
    return { kind: "boulder", version: schema.version, outline: input.outline, params: overrides };
  },

  missing(tools) {
    if (!tools.python) return "No Python found: run `bun run generators:setup`, or set PYTHON_PATH.";
    if (!tools.blender) return "No Blender found: put blender on PATH, or set BLENDER_PATH.";
    return null;
  },

  command(tools, root, requestFile, outDir) {
    const script = join(root, "tools", "blender", "boulders", "rockgen.py");
    // --no-render skips the preview renders; --samples is the preview's and the
    // bake sets its own (bakeSamples), as the fork ran it.
    return {
      file: tools.python!,
      args: [script, requestFile, "--output", outDir, "--no-render", "--samples", "16", "--blender", tools.blender!],
    };
  },

  output: (outDir) => join(outDir, "models", "boulder.glb"),

  failure: (stdout, stderr, fallback, kept) => generatorFailure("Boulder generation", stdout, stderr, fallback, kept),
};
