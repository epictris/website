// A formation's recipe: what the generator is asked for, and the hash that
// names the result (docs/formations.md).
//
// DOM-free and wasm-free, so the editor, the game, the dev server and Bun's
// scripts all hash a formation the same way. The generators' parameters are
// read from `formationSchema.json`, which `tools/blender/formations/
// schema_export.py` writes from the add-on itself.
//
// THE HASH is taken over the recipe as AUTHORED: the generator, the solid
// variant, every parameter with the generator's defaults filled in, the recipe
// version, and the guide as the level holds it (in metres). Not over what the
// guide is turned into (the outline the pieces' union is, the mesh a solid
// tree is): those are computed by libraries whose upgrade would otherwise
// mark every rock stale at once. A formation is STALE when its hash now is not
// the one it was built from (`built.hash`).
//
// Numbers are rounded to 1e-6 (a micrometre, for a length in metres) before
// hashing, so a guide that has been to disk in pixels and back hashes the same.

import type { FormationData, FormationGenerator, FormationGuide, SolidVariant } from "../level/levelFormat";
import schemaJson from "../level/formationSchema.json";
import { sha256Hex } from "./sha256";

export interface FieldSpec {
  key: string;
  label: string;
  description: string;
  type: "bool" | "int" | "float";
  unit?: "m";
  precision?: number;
  min?: number;
  max?: number;
  softmin?: number;
  softmax?: number;
  default: number | boolean;
}

export interface VariantSpec {
  id: SolidVariant;
  label: string;
  description: string;
  hidden: string[];
  labels: Record<string, string>;
}

export interface GeneratorSpec {
  label: string;
  fields: FieldSpec[];
  variants?: VariantSpec[];
}

export interface FormationSchema {
  version: number;
  generators: Record<FormationGenerator, GeneratorSpec>;
  outline: FormationGenerator[];
  solid: FormationGenerator[];
}

export const FORMATION_SCHEMA = schemaJson as unknown as FormationSchema;
export const RECIPE_VERSION = FORMATION_SCHEMA.version;

// The solid generator's variant when a formation names none: what the worker
// builds a recipe without one as (worker.GENERATORS: jointed).
export const DEFAULT_VARIANT: SolidVariant = "cliff";

// The generators a guide of this kind may use, in the order offered.
export function generatorsFor(guide: FormationGuide): FormationGenerator[] {
  return guide.kind === "collision" ? FORMATION_SCHEMA.outline : FORMATION_SCHEMA.solid;
}

export function variantOf(f: Pick<FormationData, "generator" | "variant">): SolidVariant | undefined {
  return f.generator === "solid" ? (f.variant ?? DEFAULT_VARIANT) : undefined;
}

// The fields the panel shows for this generator and variant, with the label
// the variant gives each (params.draw's rules, as data).
export function visibleFields(generator: FormationGenerator, variant?: SolidVariant): FieldSpec[] {
  const spec = FORMATION_SCHEMA.generators[generator];
  const v = spec.variants?.find((x) => x.id === variant);
  return spec.fields
    .filter((f) => !v?.hidden.includes(f.key))
    .map((f) => (v?.labels[f.key] ? { ...f, label: v.labels[f.key]! } : f));
}

// Every parameter of the generator, the formation's own where it has one and
// the default where not. Keys the generator does not have are dropped, so a
// switch of generator does not carry the other's into the recipe.
export function resolvedParams(f: Pick<FormationData, "generator" | "params">): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const field of FORMATION_SCHEMA.generators[f.generator].fields) {
    const v = f.params[field.key];
    out[field.key] = v === undefined || typeof v !== typeof field.default ? field.default : v;
  }
  return out;
}

// A value with its object keys sorted and its numbers rounded to 1e-6, so the
// same recipe is the same text wherever it was written.
export function canonical(value: unknown): unknown {
  if (typeof value === "number") {
    const r = Math.round(value * 1e6) / 1e6;
    return Object.is(r, -0) ? 0 : r;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonical(v);
    }
    return out;
  }
  return value;
}

// What the hash is taken over (see the top of this file).
export interface FormationRecipe {
  version: number;
  generator: FormationGenerator;
  variant?: SolidVariant;
  params: Record<string, number | boolean>;
  guide: FormationGuide;
}

export function formationRecipe(f: Pick<FormationData, "generator" | "variant" | "params" | "guide">): FormationRecipe {
  const variant = variantOf(f);
  return canonical({
    version: RECIPE_VERSION,
    generator: f.generator,
    ...(variant ? { variant } : {}),
    params: resolvedParams(f),
    // `subset` says where the pieces came from, and a piece's own fields what
    // to put back; neither is part of what is built.
    guide:
      f.guide.kind === "collision"
        ? { kind: "collision", pieces: f.guide.pieces.map((p) => ({ shape: p.shape, x: p.x ?? 0, y: p.y ?? 0, rot: p.rot ?? 0 })) }
        : f.guide,
  }) as FormationRecipe;
}

export function recipeHash(recipe: FormationRecipe): string {
  return sha256Hex(JSON.stringify(canonical(recipe)));
}

export function formationHash(f: Pick<FormationData, "generator" | "variant" | "params" | "guide">): string {
  return recipeHash(formationRecipe(f));
}

// Whether the formation's guide or recipe has changed since what is drawn was
// built (or nothing has been built yet).
export function isStale(f: FormationData): boolean {
  return !f.built || f.built.hash !== formationHash(f);
}

// A fresh formation id: eight base-36 characters, which the level holds unique
// (`cli levels`). Random rather than counted, so two editors, a paste and a
// script can each mint one without asking the others.
export function newFormationId(taken: ReadonlySet<string> = new Set()): string {
  for (;;) {
    let id = "";
    for (let i = 0; i < 8; i++) id += Math.floor(Math.random() * 36).toString(36);
    if (!taken.has(id)) return id;
  }
}
