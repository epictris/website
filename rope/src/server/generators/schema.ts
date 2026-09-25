// A generator's parameter schema, `tools/blender/<dir>/params.json`, as the dev
// server reads it: to validate a request's overrides before a Blender run is
// spent on them. The Python reads the same file for the defaults, so a value
// is stated once; this module never restates one.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ParamValue = number | boolean | string | null | number[];
export type Params = Record<string, ParamValue>;

export interface ParamSpec {
  key: string;
  type: "int" | "number" | "bool" | "enum" | "color";
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: (number | string)[];
  group: string;
  basic?: boolean;
  doc: string;
}

export interface Schema {
  kind: string;
  version: number;
  groups: string[];
  params: ParamSpec[];
}

export function schemaPath(root: string, dir: string): string {
  return join(root, "tools", "blender", dir, "params.json");
}

// Read per request rather than cached: the file is small, and a schema edited
// while the server runs is then in force at once, as it is for the Python.
export function loadSchema(root: string, dir: string): Schema {
  return JSON.parse(readFileSync(schemaPath(root, dir), "utf8")) as Schema;
}

const unitSuffix = (p: ParamSpec) => (p.unit ? ` ${p.unit}` : "");

function checkValue(p: ParamSpec, v: unknown): void {
  const range = () => {
    if ((p.min !== undefined && (v as number) < p.min) || (p.max !== undefined && (v as number) > p.max))
      throw new Error(`${p.key} must be between ${p.min} and ${p.max}${unitSuffix(p)}.`);
  };
  switch (p.type) {
    case "int":
      if (!Number.isInteger(v)) throw new Error(`${p.key} must be a whole number.`);
      return range();
    case "number":
      // A null default means "blank": derived by the generator (the boulder's
      // tolerance), so null is a value the author may write back.
      if (v === null && p.default === null) return;
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${p.key} must be a number.`);
      return range();
    case "bool":
      if (typeof v !== "boolean") throw new Error(`${p.key} must be true or false.`);
      return;
    case "enum":
      if (!p.options?.includes(v as number | string))
        throw new Error(`${p.key} must be one of ${(p.options ?? []).join(", ")}.`);
      return;
    case "color":
      if (!Array.isArray(v) || v.length !== 3 || v.some((c) => typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1))
        throw new Error(`${p.key} must be three linear RGB channels from 0 to 1.`);
      return;
  }
}

/** The overrides, checked key by key against the schema; throws on the first bad one. */
export function validateParams(schema: Schema, value: unknown): Params {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("params must be an object of parameter values.");
  const specs = new Map(schema.params.map((p) => [p.key, p]));
  for (const [key, v] of Object.entries(value)) {
    const p = specs.get(key);
    if (!p) throw new Error(`${key} is not a ${schema.kind} parameter.`);
    checkValue(p, v);
  }
  return value as Params;
}

/** Defaults, then the overrides: the values a generation runs with. */
export function mergeParams(schema: Schema, overrides: Params): Params {
  const values: Params = {};
  for (const p of schema.params) values[p.key] = p.default;
  return { ...values, ...overrides };
}

/**
 * A `<name>Min` and `<name>Max` pair bounds one random draw, and numpy refuses
 * a draw whose low end is above its high end with a traceback from inside the
 * job. The merged values are checked at the door instead, so raising only the
 * Min past the default Max is a 400 that names both keys.
 */
export function validatePairs(values: Params): void {
  for (const [key, low] of Object.entries(values)) {
    if (!key.endsWith("Min")) continue;
    const highKey = `${key.slice(0, -3)}Max`;
    const high = values[highKey];
    if (typeof low === "number" && typeof high === "number" && low > high)
      throw new Error(`${key} (${low}) must not be above ${highKey} (${high}).`);
  }
}
