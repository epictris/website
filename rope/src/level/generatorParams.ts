// The parameter schemas of the two procedural generators (boulders and mushroom
// patches), and the pure functions every reader of a `generator` block shares:
// px/m scaling, validation, and the default merge and strip.
//
// The schema itself is data, in `tools/blender/<kind>/params.json`, because the
// Python that consumes the parameters reads the same file: a constant stated
// once, read by both languages (see plans/visuals-workspace.md, "The parameter
// schema"). This module is the TypeScript half of that contract.
//
// It lives under `src/level/` rather than beside the editor's panel code because
// `scaleObject` needs it: a length inside `params` is pixels on disk and metres
// in the sim like every other length, and the level format cannot depend on the
// editor. The editor's own entry point is `editor/visuals/paramSchema.ts`, which
// re-exports all of this. Being under `src/level/` puts it under the dmath scan,
// which it passes trivially: nothing here is more than arithmetic and rounding.

import boulderSchemaJson from "../../tools/blender/boulders/params.json";
import mushroomsSchemaJson from "../../tools/blender/mushrooms/params.json";

export type GeneratorKind = "boulder" | "mushrooms";
export const GENERATOR_KINDS: readonly GeneratorKind[] = ["boulder", "mushrooms"];

// A parameter's value as it is stored: a number (int, number, a numeric enum
// option), a flag, a string enum option, or a linear RGB triple.
export type ParamValue = number | boolean | string | number[];
export type ParamValues = Record<string, ParamValue>;

// `int` and `number` carry min/max/step; `color` is a linear RGB triple whose
// channels are held to min/max; `enum` lists its `options`; `bool` has neither.
export type ParamType = "int" | "number" | "bool" | "enum" | "color";

// "m" is a length (scaled px <-> m by `scaleObject`), "deg" is an angle in
// degrees (never scaled). Absent is dimensionless, or a rate stated in metres
// whatever the file's units (a density per square metre, a noise frequency per
// metre), which is not scaled either: the schema's doc says which.
export type ParamUnit = "m" | "deg";

export interface ParamSpec {
  key: string;
  type: ParamType;
  // null only where the generator derives the value when none is given
  // (a boulder's `tolerance`, from the outline's area).
  default: ParamValue | null;
  min?: number;
  max?: number;
  step?: number;
  unit?: ParamUnit;
  options?: (number | string)[];
  group: string;
  // Shown without opening the group's Advanced disclosure.
  basic: boolean;
  doc: string;
}

export interface ParamSchema {
  kind: GeneratorKind;
  // Bumped whenever the generator's output changes for the same parameters
  // (a new default, a changed algorithm), since it is part of every mesh key.
  version: number;
  groups: string[];
  notes: { units: string; defaults: string; constants: string[] };
  params: ParamSpec[];
}

// JSON widens every literal, so the files are cast rather than inferred; the
// `generator:` cases in cli render3d hold them to this shape field by field.
export const GENERATOR_SCHEMAS: Readonly<Record<GeneratorKind, ParamSchema>> = {
  boulder: boulderSchemaJson as unknown as ParamSchema,
  mushrooms: mushroomsSchemaJson as unknown as ParamSchema,
};

export function isGeneratorKind(kind: unknown): kind is GeneratorKind {
  return kind === "boulder" || kind === "mushrooms";
}

// The schema for a kind, or undefined for a kind this build does not know (a
// level written by a newer editor), which every caller passes through untouched
// rather than guessing at.
export function loadSchema(kind: string): ParamSchema | undefined {
  return isGeneratorKind(kind) ? GENERATOR_SCHEMAS[kind] : undefined;
}

// Specs by key, built once per schema: validation and the merge ask per key.
const specIndex = new Map<ParamSchema, Map<string, ParamSpec>>();
export function paramSpec(schema: ParamSchema, key: string): ParamSpec | undefined {
  let index = specIndex.get(schema);
  if (!index) {
    index = new Map(schema.params.map((p) => [p.key, p]));
    specIndex.set(schema, index);
  }
  return index.get(key);
}

// Every parameter whose unit is a length multiplied by `factor`, everything else
// copied. A key the schema does not know is copied unscaled: it is invalid (and
// `validateParams` says so), but dropping it here would delete an author's value
// on the first autosave, which is worse than carrying it. No schema at all (an
// unknown kind) copies everything for the same reason.
export function scaleParams(
  params: Readonly<ParamValues>,
  schema: ParamSchema | undefined,
  factor: number,
): ParamValues {
  const out: ParamValues = {};
  for (const [key, value] of Object.entries(params)) {
    const spec = schema ? paramSpec(schema, key) : undefined;
    if (spec?.unit === "m" && typeof value === "number") out[key] = value * factor;
    else out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

// The resolution parameters are compared and hashed at: a ten-thousandth of
// whatever unit the value is in (a tenth of a millimetre for a length). Float
// noise from the px <-> m round trip is twelve orders below it, and nothing an
// author sets is finer.
export const PARAM_RESOLUTION = 1e4; // steps per unit
export function roundParam(v: number): number {
  const r = Math.round(v * PARAM_RESOLUTION) / PARAM_RESOLUTION;
  // -0 and 0 are one value; String(-0) is "0" but Object.is is not fooled.
  return r === 0 ? 0 : r;
}

function sameValue(a: ParamValue | null, b: ParamValue | null): boolean {
  if (typeof a === "number" && typeof b === "number") return roundParam(a) === roundParam(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => roundParam(v) === roundParam(b[i]!));
  }
  return a === b;
}

// What is wrong with a set of parameters, one line per problem; empty means
// valid. Unknown keys are rejected: the server passes the merged spec to Python
// verbatim, and a key nothing reads is a setting that silently does nothing.
export interface ParamIssue {
  key: string;
  message: string;
}
export function validateParams(params: Readonly<Record<string, unknown>>, schema: ParamSchema): ParamIssue[] {
  const issues: ParamIssue[] = [];
  for (const [key, value] of Object.entries(params)) {
    const spec = paramSpec(schema, key);
    if (!spec) {
      issues.push({ key, message: `unknown parameter for ${schema.kind}` });
      continue;
    }
    const inRange = (v: number): boolean =>
      (spec.min === undefined || v >= spec.min) && (spec.max === undefined || v <= spec.max);
    const range = `${spec.min ?? "-inf"}..${spec.max ?? "inf"}`;
    switch (spec.type) {
      case "int":
        if (typeof value !== "number" || !Number.isInteger(value)) issues.push({ key, message: "must be an integer" });
        else if (!inRange(value)) issues.push({ key, message: `${value} is outside ${range}` });
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) issues.push({ key, message: "must be a finite number" });
        else if (!inRange(value)) issues.push({ key, message: `${value} is outside ${range}` });
        break;
      case "bool":
        if (typeof value !== "boolean") issues.push({ key, message: "must be true or false" });
        break;
      case "enum":
        if (!(spec.options ?? []).some((o) => o === value)) {
          issues.push({ key, message: `${JSON.stringify(value)} is not one of ${JSON.stringify(spec.options ?? [])}` });
        }
        break;
      case "color":
        if (
          !Array.isArray(value) ||
          value.length !== 3 ||
          !value.every((c) => typeof c === "number" && Number.isFinite(c))
        ) {
          issues.push({ key, message: "must be a linear RGB triple" });
        } else if (!value.every((c) => inRange(c as number))) {
          issues.push({ key, message: `a channel is outside ${range}` });
        }
        break;
    }
  }
  return issues;
}

// Every parameter the schema lists, the given value where there is one and the
// default where not (null where the generator derives it). What the generator
// is handed. Keys the schema does not know are kept, for `validateParams` to
// refuse rather than for this to hide.
export function mergeDefaults(
  params: Readonly<ParamValues>,
  schema: ParamSchema,
): Record<string, ParamValue | null> {
  const out: Record<string, ParamValue | null> = {};
  for (const spec of schema.params) {
    const given = params[spec.key];
    const value = given !== undefined ? given : spec.default;
    out[spec.key] = Array.isArray(value) ? [...value] : value;
  }
  for (const [key, value] of Object.entries(params)) {
    if (!(key in out)) out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

// Only the values that differ from the default, at `PARAM_RESOLUTION`: the form
// a level stores and the form a key is hashed from, so a parameter set back to
// its default and one never touched are the same rock. A null (derive it) is
// dropped, which is what absent means.
export function stripDefaults(
  params: Readonly<Record<string, ParamValue | null>>,
  schema: ParamSchema,
): ParamValues {
  const out: ParamValues = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null) continue;
    const spec = paramSpec(schema, key);
    if (spec && sameValue(value, spec.default)) continue;
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

// The one form parameters are compared and hashed in: defaults stripped, keys
// sorted, numbers at `PARAM_RESOLUTION`. Two parameter sets with the same
// canonical form make the same mesh. An unknown kind's parameters are only
// sorted and rounded.
export function canonicalParams(
  params: Readonly<Record<string, ParamValue | null>>,
  schema: ParamSchema | undefined,
): ParamValues {
  const stripped: ParamValues = schema
    ? stripDefaults(params, schema)
    : (Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null)) as ParamValues);
  const out: ParamValues = {};
  for (const key of Object.keys(stripped).sort()) {
    const v = stripped[key]!;
    out[key] = typeof v === "number" ? roundParam(v) : Array.isArray(v) ? v.map(roundParam) : v;
  }
  return out;
}
