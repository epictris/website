// The editor's entry point to the generator parameter schemas, and the one
// place that says what a generated object's mesh key SHOULD be.
//
// The schema functions themselves (loading, validation, the default merge and
// strip, scaling by unit, the canonical form) live in `level/generatorParams.ts`
// because `scaleObject` needs them and the level format cannot depend on the
// editor; they are re-exported here so panel, job and workspace code has one
// module to import. What is added here is the part that reads the MODEL: the
// generator's input for an item as it now stands, and whether its mesh is stale.

import type * as THREE from "three";
import { Vec2 } from "../../engine/vec2";
import { patchMatrix } from "./surfacePatch";
import {
  generatedKey,
  type BoulderInput,
  type GeneratorInput,
  type MushroomsInput,
  type PatchHost,
} from "../../render3d/generated";
import { localVertices, type EdItem } from "../model";
import { loadSchema as loadSchemaOf } from "../../level/generatorParams";

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
  validatePairs,
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

// An item's frame as `patchMatrix` builds it (see `ObjectPose`), at its own
// `offsetZ`: both ends of a patch-host pair are measured the same way, and the
// body's depth they share cancels in the relative frame.
function itemFrame(item: EdItem): THREE.Matrix4 {
  const v = item.visual;
  return patchMatrix({ x: item.pos.x, y: item.pos.y, z: v.offsetZ, rot: item.rot, rotX: v.rotX, rotY: v.rotY, scale: v.scale });
}

// What decides a host's drawn surface, placed relative to the patch (see
// `PatchHost`). Relative so a body moved as a whole leaves the patch current;
// the WHOLE relative transform (both objects' place, turn, tilt and scale), so
// tipping or scaling either one alone is a different patch.
function hostOf(patch: EdItem, host: EdItem): PatchHost {
  const rel = itemFrame(patch).invert().multiply(itemFrame(host)).elements;
  // Three's elements are column-major; the key reads the rows.
  const frame = [0, 1, 2].flatMap((r) => [rel[r]!, rel[r + 4]!, rel[r + 8]!, rel[r + 12]!]);
  const v = host.visual;
  // A generated host never generated is drawn as a stand-in, which says
  // nothing about which rock it will be: its future key does. Asked with a
  // lookup that finds nothing, so a patch hosted on a patch cannot recurse.
  const pending = v.generator && !v.mesh ? expectedKey(host, () => undefined) : null;
  const generator = pending ? { generator: pending } : {};
  if (v.kind === "mesh") return { kind: "mesh", mesh: v.mesh, ...generator, frame };
  return {
    kind: "primitive",
    mesh: "",
    ...generator,
    ...(host.shape.kind === "circle" ? { radius: host.shape.r } : { outline: localVertices(host).map(up) }),
    depth: v.depth,
    bevel: v.bevel,
    taperStart: v.taperStart,
    taperAngle: v.taperAngle,
    // What the primitive wears and the lens it is drawn through.
    texture: v.texture,
    projection: v.projection,
    frame,
  };
}

// A patch's loop, facing and host (see `MushroomsInput`), or null when it has
// no host to grow on or no loop to grow inside.
function mushroomsInput(item: EdItem, lookup: ItemLookup): MushroomsInput | null {
  const patch = item.visual.generator?.patch;
  if (!patch || patch.points.length < 3 || patch.hostId === 0) return null;
  const host = lookup(patch.hostId);
  if (!host || host.object !== "geometry" || host === item) return null;
  const f = patch.facing;
  return {
    loop: patch.points.map((p) => [p.x, -p.y, p.z]),
    // Dimensionless and y up like the loop; absent for a patch saved before
    // the facing was stored (its side is then guessed, see `patchLoopWorld`).
    ...(f ? { facing: [f.x, -f.y, f.z] as [number, number, number] } : {}),
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

// The key the item would be generated under NOW: its input and parameters at
// the schema version this build runs, which is the version the server hashes
// at (it refuses any other). What Generate asks for and what a finished job is
// checked against before its mesh goes on the object; the stored `version` is
// brought up to it by that same swap. Null when there is nothing to generate.
export function wantedKey(item: EdItem, lookup: ItemLookup): string | null {
  const g = item.visual.generator;
  const schema = g ? loadSchemaOf(g.kind) : undefined;
  const input = generatorInput(item, lookup);
  if (!g || !schema || !input) return null;
  return generatedKey(g.kind, schema.version, input, g.params);
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
