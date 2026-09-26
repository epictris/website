// The mushroom patch generator (tools/blender/mushrooms): the surface the
// author painted, as a triangle soup, in; a merged mesh of glowing mushrooms
// out. editor_patch.py runs the MushroomPatch Geometry Nodes group in Blender
// with every socket set from params.json and the request's overrides.
//
// Two things arrive, because the key and the generator want different ones.
// The key input (`MushroomsInput`: the painted loop and a description of the
// host) is what the patch is made FROM, and what the mesh key hashes; the
// `soup` is the host surface inside the loop, collected by the editor from the
// host's drawn meshes at generation time, and is what Blender grows on. The
// soup is derived from the key input, so it is not hashed; it is kept beside
// meta.json as input.json.

import { join } from "node:path";
import type { MushroomsInput } from "../../render3d/generated";
import type { Generator } from "./run";

export interface MushroomInput {
  key: MushroomsInput;
  /** Flat triangle soup in the three.js frame relative to the patch origin, metres. */
  soup: number[];
}

// Coordinates within this many metres of the patch origin (m).
const MAX_COORD = 100;

const finiteVector = (v: unknown, length: number): boolean =>
  Array.isArray(v) && v.length === length && v.every((n) => typeof n === "number" && Number.isFinite(n));

// The key input's shape, as `generatorInput` in editor/visuals/paramSchema.ts
// builds it. Only the shape: whether it is the RIGHT loop and host is the
// key's business, which the service checks against it.
function checkKeyInput(value: unknown): MushroomsInput {
  const v = value as MushroomsInput | null;
  if (!v || !Array.isArray(v.loop) || v.loop.length < 3 || !v.loop.every((p) => finiteVector(p, 3)))
    throw new Error("input.loop must be three or more [x, y, z] points.");
  if (v.facing !== undefined && !finiteVector(v.facing, 3))
    throw new Error("input.facing, when given, must be an [x, y, z] direction.");
  const h = v.host;
  if (!h || (h.kind !== "primitive" && h.kind !== "mesh") || typeof h.mesh !== "string" || !finiteVector(h.frame, 12))
    throw new Error("input.host must be { kind, mesh, frame: [the top three rows of the host's frame in the patch's], ... }.");
  return v;
}
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

  validateInput(input, soup, values) {
    const key = checkKeyInput(input);
    const maxTriangles = values.maxTriangles as number;
    const maxEstimate = values.maxEstimate as number;
    const density = values.density as number;
    const positions = soup as number[];
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
    return { key, soup: positions };
  },

  keyInput: (input) => input.key,
  sidecars: (input) => ({ "input.json": { soup: input.soup } }),

  request(input, overrides, schema) {
    return { kind: "mushrooms", version: schema.version, positions: input.soup, params: overrides };
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
