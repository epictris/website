// A decoration's settings as fields: the same sections and fields the
// add-on's own Blender panel shows for its kind, with each field's label,
// description, type, bounds and options read off the add-on itself
// (src/level/decorationSchema.json, written by
// tools/blender/decoration_schema_export.py; `just decoration-schema`).
//
// Values are the add-on's own, by property name, as `DecorationObjectData.
// settings` keeps them: a value at its default is left out, so a decoration
// keeps only what was changed. Colours are linear, as Blender's COLOR
// properties are; the colour picker is sRGB, so it converts.

import schemaJson from "../level/decorationSchema.json";
import type { DecorationKind, DecorationSettings } from "../level/levelFormat";
import { describe, fieldRow } from "./panelUi";

interface FieldMeta {
  label: string;
  description: string;
  type: "float" | "int" | "bool" | "enum" | "color" | "string";
  default: number | boolean | string | number[];
  min?: number | null;
  max?: number | null;
  softMin?: number | null;
  softMax?: number | null;
  step?: number;
  precision?: number;
  gamma?: boolean;
  items?: { id: string; label: string; description: string }[];
}
type Condition = Record<string, string[]>;
interface FieldRef {
  field: string;
  when?: Condition;
  whenNot?: Condition;
}
interface Section {
  title: string;
  fields: FieldRef[];
  when?: Condition;
  whenNot?: Condition;
  closed?: boolean;
}
interface DecorationSchema {
  kinds: Record<DecorationKind, { group: string; sections: Section[] }>;
  fields: Record<string, Record<string, FieldMeta>>;
}
const SCHEMA = schemaJson as unknown as DecorationSchema;

// Which closed-by-default sections have been opened, and which open ones
// closed, by kind and title: remembered for the session, as Blender's are.
const toggled = new Set<string>();

const toSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hex = (rgb: number[], gamma: boolean): string =>
  "#" + rgb.slice(0, 3).map((c) => Math.round(Math.min(1, Math.max(0, gamma ? c : toSrgb(c))) * 255).toString(16).padStart(2, "0")).join("");
const fromHex = (h: string, gamma: boolean): number[] =>
  [1, 3, 5].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return Number((gamma ? c : toLinear(c)).toFixed(4));
  });

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// Does a condition hold for these values (the settings over the defaults)?
function holds(values: (key: string) => unknown, when?: Condition, whenNot?: Condition): boolean {
  for (const [k, allowed] of Object.entries(when ?? {})) if (!allowed.includes(String(values(k)))) return false;
  for (const [k, refused] of Object.entries(whenNot ?? {})) if (refused.includes(String(values(k)))) return false;
  return true;
}

export interface SettingsHost {
  // The settings as they stand.
  settings(): DecorationSettings | undefined;
  // Write them (one call per change); `structural` when the change can show
  // or hide fields, so the panel is built again.
  write(next: DecorationSettings | undefined, structural: boolean): void;
  // Called when a field's editing session begins: one undo step per session.
  begin(): void;
}

export function hasSettings(kind: DecorationKind): boolean {
  return !!SCHEMA.kinds[kind];
}

export function buildDecorationSettings(parent: HTMLElement, kind: DecorationKind, host: SettingsHost): void {
  const spec = SCHEMA.kinds[kind];
  if (!spec) return;
  const meta = SCHEMA.fields[spec.group]!;
  const value = (key: string): unknown => host.settings()?.[key] ?? meta[key]?.default;
  const set = (key: string, v: number | boolean | string | number[], structural: boolean): void => {
    const next: DecorationSettings = { ...(host.settings() ?? {}) };
    if (same(v, meta[key]!.default)) delete next[key];
    else next[key] = v;
    host.write(Object.keys(next).length ? next : undefined, structural);
  };
  // Fields another field's condition reads: changing one rebuilds the panel.
  const governing = new Set<string>();
  for (const s of spec.sections) {
    for (const c of [s.when, s.whenNot, ...s.fields.flatMap((f) => [f.when, f.whenNot])]) for (const k of Object.keys(c ?? {})) governing.add(k);
  }

  for (const section of spec.sections) {
    if (!holds(value, section.when, section.whenNot)) continue;
    const fields = section.fields.filter((f) => meta[f.field] && holds(value, f.when, f.whenNot));
    if (!fields.length) continue;
    const id = `${kind}/${section.title}`;
    const open = section.closed ? toggled.has(id) : !toggled.has(id);
    const head = document.createElement("button");
    head.className = "ed-settings-head";
    head.textContent = `${open ? "▾" : "▸"} ${section.title}`;
    head.setAttribute("aria-expanded", String(open));
    const body = document.createElement("div");
    body.className = "ed-settings-body";
    body.hidden = !open;
    head.addEventListener("click", () => {
      if (toggled.has(id)) toggled.delete(id);
      else toggled.add(id);
      body.hidden = !body.hidden;
      head.textContent = `${body.hidden ? "▸" : "▾"} ${section.title}`;
      head.setAttribute("aria-expanded", String(!body.hidden));
    });
    parent.append(head, body);
    for (const { field: key } of fields) body.appendChild(fieldControl(key, meta[key]!, value(key), set, governing.has(key), host));
  }
}

function fieldControl(
  key: string,
  m: FieldMeta,
  current: unknown,
  set: (key: string, v: number | boolean | string | number[], structural: boolean) => void,
  structural: boolean,
  host: SettingsHost,
): HTMLElement {
  const row = fieldRow(m.label, m.type === "bool" ? "label" : "div");
  if (m.type === "enum") {
    const pick = Object.assign(document.createElement("select"), { className: "ed-select" });
    for (const it of m.items ?? []) pick.add(new Option(it.label, it.id));
    pick.value = String(current);
    pick.addEventListener("change", () => {
      host.begin();
      set(key, pick.value, structural);
    });
    row.appendChild(pick);
  } else if (m.type === "bool") {
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: current === true });
    box.addEventListener("change", () => {
      host.begin();
      set(key, box.checked, structural);
    });
    row.appendChild(box);
  } else if (m.type === "color") {
    const pick = Object.assign(document.createElement("input"), { type: "color", className: "ed-color", value: hex(current as number[], !!m.gamma) });
    pick.addEventListener("focus", () => host.begin());
    pick.addEventListener("input", () => {
      const rgb = fromHex(pick.value, !!m.gamma);
      set(key, (current as number[]).length === 4 ? [...rgb, (current as number[])[3]!] : rgb, false);
    });
    row.appendChild(pick);
  } else if (m.type === "string") {
    const text = Object.assign(document.createElement("input"), { type: "text", className: "ed-text", value: String(current ?? "") });
    text.addEventListener("focus", () => host.begin());
    text.addEventListener("change", () => set(key, text.value, structural));
    row.appendChild(text);
  } else {
    const num = Object.assign(document.createElement("input"), { type: "number", className: "ed-num" });
    num.step = m.type === "int" ? String(m.step ?? 1) : String(m.step && m.step > 0 ? m.step : 10 ** -(m.precision ?? 2));
    if (m.min !== null && m.min !== undefined) num.min = String(m.min);
    if (m.max !== null && m.max !== undefined) num.max = String(m.max);
    // Six significant digits, as the add-on's fields show them.
    num.value = String(Number(Number(current).toPrecision(6)));
    num.addEventListener("focus", () => host.begin());
    num.addEventListener("input", () => {
      let v = parseFloat(num.value);
      if (!Number.isFinite(v)) return;
      if (m.type === "int") v = Math.round(v);
      if (m.min !== null && m.min !== undefined) v = Math.max(m.min, v);
      if (m.max !== null && m.max !== undefined) v = Math.min(m.max, v);
      set(key, v, structural);
    });
    row.appendChild(num);
  }
  describe(row, `${m.description}${m.description && !m.description.endsWith(".") ? "." : ""} Default ${m.type === "color" ? hex(m.default as number[], !!m.gamma) : String(m.default)}.`);
  return row;
}
