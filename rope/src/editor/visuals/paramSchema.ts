// The editor's entry point to the generator parameter schemas, and the one
// place that says what a generated object's mesh key SHOULD be.
//
// The schema functions themselves (loading, validation, the default merge and
// strip, scaling by unit, the canonical form) live in `level/generatorParams.ts`
// because `scaleObject` needs them and the level format cannot depend on the
// editor; they are re-exported here so panel, job and workspace code has one
// module to import. What is added here is the part that reads the MODEL: the
// generator's input for an item as it now stands, and whether its mesh is stale.

import { Vec2 } from "../../engine/vec2";
import {
  generatedKey,
  type BoulderInput,
  type GeneratorInput,
  type MushroomsInput,
  type PatchHost,
} from "../../render3d/generated";
import { localVertices, type EdItem } from "../model";

export {
  GENERATOR_KINDS,
  GENERATOR_SCHEMAS,
  PARAM_RESOLUTION,
  canonicalParams,
  isGeneratorKind,
  loadSchema,
  mergeDefaults,
  paramSpec,
  roundParam,
  scaleParams,
  stripDefaults,
  validateParams,
  type GeneratorKind,
  type ParamIssue,
  type ParamSchema,
  type ParamSpec,
  type ParamType,
  type ParamUnit,
  type ParamValue,
  type ParamValues,
} from "../../level/generatorParams";
export type { BoulderInput, GeneratorInput, MushroomsInput, PatchHost };

// How a generated object finds its patch's host: by item id, through whatever
// index the caller keeps (a Map over `model.items`, typically built once per
// frame or per rebuild rather than per item).
export type ItemLookup = (id: number) => EdItem | undefined;

export function itemLookup(items: readonly EdItem[]): ItemLookup {
  const byId = new Map(items.map((i) => [i.id, i]));
  return (id) => byId.get(id);
}

// y down (the level's) to y up (the generator's and three's), for one point.
const up = (v: Vec2): [number, number] => [v.x, -v.y];

// A boulder's outline: the object's own shape in its own frame, y up (see
// `BoulderInput`). Only a polygon or a rect has one; a circle, a curve or a
// belt is not something the boulder generator fits.
function boulderInput(item: EdItem): BoulderInput | null {
  if (item.shape.kind !== "poly" && item.shape.kind !== "rect") return null;
  const outline = localVertices(item).map(up);
  return outline.length >= 3 ? { outline } : null;
}

// What decides a host's drawn surface, placed relative to the patch (see
// `PatchHost`). Relative so a body moved as a whole leaves the patch current.
function hostOf(patch: EdItem, host: EdItem): PatchHost {
  const rel = host.pos.sub(patch.pos).rotated(-patch.rot);
  const v = host.visual;
  const pose: PatchHost["pose"] = [
    rel.x,
    -rel.y,
    v.offsetZ - patch.visual.offsetZ,
    // In three's sense (counter-clockwise, y up), the negation of the level's.
    -(host.rot - patch.rot),
    v.rotX,
    v.rotY,
    v.scale,
  ];
  if (v.kind === "mesh") return { kind: "mesh", mesh: v.mesh, pose };
  return {
    kind: "primitive",
    mesh: "",
    ...(host.shape.kind === "circle" ? { radius: host.shape.r } : { outline: localVertices(host).map(up) }),
    depth: v.depth,
    bevel: v.bevel,
    taperStart: v.taperStart,
    taperAngle: v.taperAngle,
    pose,
  };
}

// A patch's loop and host (see `MushroomsInput`), or null when it has no host
// to grow on or no loop to grow inside.
function mushroomsInput(item: EdItem, lookup: ItemLookup): MushroomsInput | null {
  const patch = item.visual.generator?.patch;
  if (!patch || patch.points.length < 3 || patch.hostId === 0) return null;
  const host = lookup(patch.hostId);
  if (!host || host.object !== "geometry" || host === item) return null;
  return {
    loop: patch.points.map((p) => [p.x, -p.y, p.z]),
    host: hostOf(item, host),
  };
}

// The generator's input for an item as it now stands, or null when it has no
// generator block or cannot be generated (a boulder on a circle, a patch whose
// host is gone). The same value the job client sends, so the key the server
// checks and the key the editor compares are computed from one thing.
export function generatorInput(item: EdItem, lookup: ItemLookup): GeneratorInput | null {
  const g = item.visual.generator;
  if (!g || item.object !== "geometry") return null;
  if (g.kind === "boulder") return boulderInput(item);
  if (g.kind === "mushrooms") return mushroomsInput(item, lookup);
  return null;
}

// The mesh key this item's generator block and input make, or null when there
// is none to make (see `generatorInput`).
export function expectedKey(item: EdItem, lookup: ItemLookup): string | null {
  const g = item.visual.generator;
  const input = generatorInput(item, lookup);
  if (!g || !input) return null;
  return generatedKey(g.kind, g.version, input, g.params);
}

// Whether a generated object's mesh no longer matches what it would be
// generated from now: its outline, its loop or host, its parameters, or its
// schema version changed since. Never-generated (no `mesh` yet) and
// ungeneratable (no input) objects are stale too - neither shows the rock or
// patch its block describes. An object with no generator block is never stale.
// The editor never regenerates on its own; this is the badge.
export function isStale(item: EdItem, lookup: ItemLookup): boolean {
  if (!item.visual.generator) return false;
  const key = expectedKey(item, lookup);
  return key === null || item.visual.mesh !== key;
}
