// THE GENERATOR GROUP on a generated object's panel: the Rock group on a
// boulder, the Mushrooms group on a patch (plans/visuals-workspace.md, "The
// rock tool and panel", "The mushroom tool and panel").
//
// Built from the parameter schema rather than written out: every parameter of
// `tools/blender/<kind>/params.json` is a field of its own type, the basic ones
// first and each schema group's others under an Advanced disclosure, so a knob
// added to the schema is in the inspector without a line here. The label says
// the unit, the tooltip is the schema's `doc`, a blank field is the default
// (shown as the placeholder), and only a value that differs from the default is
// ever written (`withParam`).
//
// Lengths are shown in metres, the schema's unit, where the rest of the panel
// shows scene pixels: the schema's steps, ranges and defaults are metres, and
// the doc of every parameter says what it is in them.
//
// The pure half (values in and out of a parameter record, the status line, the
// clipboard payload) is exported for the `generator:` cases; the DOM half is
// handed the editor's own field builders and undo through `PanelHost`.

import * as THREE from "three";
import type { EdItem } from "../model";
import {
  loadSchema,
  mergeDefaults,
  paramSpec,
  stripDefaults,
  validatePairs,
  validateParams,
  wantedKey,
  expectedKey,
  generatorInput,
  isStale,
  type ItemLookup,
  type ParamSchema,
  type ParamSpec,
  type ParamValue,
  type ParamValues,
} from "./paramSchema";
import type { Job } from "./jobs";

// --- values ------------------------------------------------------------------

// A parameter's authored value, or null where it is the default (blank field).
export function paramValue(params: Readonly<ParamValues>, spec: ParamSpec): ParamValue | null {
  const v = params[spec.key];
  return v === undefined ? null : v;
}

// `params` with one value set, as the panel writes it: null, or a value equal to
// the default at the schema's resolution, removes the key, so a level only ever
// states what was changed. The other keys are left exactly as they were
// (including a default a file stated), since the editor writes back what it
// loaded.
export function withParam(
  params: Readonly<ParamValues>,
  schema: ParamSchema,
  key: string,
  value: ParamValue | null,
): ParamValues {
  const out: ParamValues = {};
  for (const [k, v] of Object.entries(params)) if (k !== key) out[k] = Array.isArray(v) ? [...v] : v;
  if (value === null) return out;
  const kept = stripDefaults({ [key]: value }, schema);
  if (key in kept) out[key] = kept[key]!;
  return out;
}

// A typed number held to what the schema allows: an integer for `int`, inside
// [min, max]. A field is typed into a character at a time, so this is what
// lands while the author is half-way through a number.
export function clampParam(spec: ParamSpec, n: number): number {
  let v = spec.type === "int" ? Math.round(n) : n;
  if (spec.min !== undefined) v = Math.max(spec.min, v);
  if (spec.max !== undefined) v = Math.min(spec.max, v);
  return v;
}

// A linear RGB triple (how a `color` parameter is stored) as the sRGB hex a
// colour input shows, and back at the schema's resolution.
export function hexOfLinear(rgb: readonly number[]): string {
  return `#${new THREE.Color().setRGB(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, THREE.LinearSRGBColorSpace).getHexString()}`;
}
export function linearOfHex(hex: string): number[] {
  const c = new THREE.Color(hex);
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return [r(c.r), r(c.g), r(c.b)];
}

// The parameters with the seed moved on by one (wrapping at its max).
export function nextSeedParams(params: Readonly<ParamValues>, schema: ParamSchema): ParamValues {
  const spec = paramSpec(schema, "seed");
  if (!spec) return { ...params };
  const now = (params.seed ?? spec.default) as number;
  const next = spec.max !== undefined && now + 1 > spec.max ? (spec.min ?? 0) : now + 1;
  return withParam(params, schema, "seed", next);
}

// What is wrong with a set of parameters as the generator would see them: each
// value on its own, then every Min above its Max once the defaults are in.
export function paramIssues(params: Readonly<ParamValues>, schema: ParamSchema): string[] {
  const issues = [...validateParams(params, schema), ...validatePairs(mergeDefaults(params, schema))];
  return issues.map((i) => `${i.key}: ${i.message}`);
}

// --- the clipboard ------------------------------------------------------------

// A look carried between rocks and levels: the kind, the schema version it was
// set under and the values that differ from the defaults, as JSON.
export function paramsPayload(kind: string, version: number, params: Readonly<ParamValues>): string {
  return JSON.stringify({ kind, version, params });
}

// The parameters a pasted payload carries for `kind`, or why it cannot be used.
// A payload from another schema version is taken (its keys are checked one by
// one, so a renamed or dropped one is refused by name rather than slipped in).
export function parseParamsPayload(
  text: string,
  schema: ParamSchema,
): { params: ParamValues } | { error: string } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: "the clipboard holds no copied parameters" };
  }
  const b = body as { kind?: unknown; params?: unknown } | null;
  if (!b || typeof b !== "object" || typeof b.kind !== "string" || !b.params || typeof b.params !== "object")
    return { error: "the clipboard holds no copied parameters" };
  if (b.kind !== schema.kind) return { error: `those are ${b.kind} parameters, not ${schema.kind}` };
  const params = b.params as ParamValues;
  const issues = paramIssues(params, schema);
  if (issues.length) return { error: issues.join("; ") };
  return { params: stripDefaults(params, schema) };
}

// --- the status line -----------------------------------------------------------

export type StatusTone = "ok" | "busy" | "warn" | "fail";
export interface GeneratorStatus {
  text: string;
  tone: StatusTone;
  // The whole of a failure, for the tooltip; the text carries its first lines.
  detail?: string;
}

// How many lines of a failure the status line shows: the validators' verdicts
// come first in the service's message (docs/generators.md, "Failures"), and the
// first few are what says which check refused the rock.
const FAILURE_LINES = 3;

// A byte count as the panel reads it.
function size(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

// What the object's generation is doing, in one line: the job it is waiting
// for, else whether its mesh matches what it would be generated from now, else
// what the mesh is.
export function generatorStatus(
  item: EdItem,
  lookup: ItemLookup,
  job: Job | undefined,
  facts: (key: string) => { bytes: number; triangles: number } | null,
): GeneratorStatus {
  const g = item.visual.generator;
  if (!g) return { text: "", tone: "ok" };
  const wanted = wantedKey(item, lookup);
  if (job?.state === "queued") return { text: "queued", tone: "busy" };
  if (job?.state === "running") return { text: `generating ${Math.round(job.elapsed)} s`, tone: "busy" };
  // A failure or a supersede is about the content it was asked for, so it is
  // said while that is still what the object holds; an edit since makes it
  // simply stale again.
  if (job && job.key === wanted && job.state === "failed") {
    const message = job.message ?? "the generator failed";
    const lines = message.split("\n").map((l) => l.trim()).filter(Boolean);
    // The check that refused it first: the message leads with a headline and
    // every validator's verdict, and the FAIL is what the author acts on.
    const fails = lines.filter((l) => /\bFAIL\b/.test(l));
    const shown = (fails.length ? fails : lines).slice(0, FAILURE_LINES).join("\n");
    // A boulder's validators are strict by design (docs/generators.md,
    // "Failures"): the answer is another seed, or a looser tolerance.
    const remedy = g.kind === "boulder" && fails.length ? "\nanother seed or a looser tolerance may pass" : "";
    return { text: `failed: ${shown}${remedy}`, tone: "fail", detail: message };
  }
  if (job && job.key === wanted && job.state === "superseded")
    return { text: `superseded${job.message ? `: ${job.message}` : ""}`, tone: "warn" };
  if (!generatorInput(item, lookup)) {
    return g.kind === "mushrooms"
      ? { text: "no host: the surface this patch grows on is gone (Edit loop paints it again)", tone: "warn" }
      : { text: "cannot generate: a rock needs a polygon or rect outline", tone: "warn" };
  }
  if (!item.visual.mesh) return { text: "stale: never generated", tone: "warn" };
  if (isStale(item, lookup)) return { text: "stale", tone: "warn" };
  const f = facts(item.visual.mesh);
  return { text: f ? `${f.triangles.toLocaleString("en")} triangles · ${size(f.bytes)}` : "generated", tone: "ok" };
}

// The outliner's badge for an object: what the status line would lead with,
// in a word, or "" for nothing to say.
export function generatorBadge(item: EdItem, lookup: ItemLookup, job: Job | undefined): string {
  if (!item.visual.generator) return "";
  if (job?.state === "queued") return "queued";
  if (job?.state === "running") return "generating";
  if (job?.state === "failed" && job.key === wantedKey(item, lookup)) return "failed";
  return isStale(item, lookup) ? "stale" : "";
}

// Re-exported for the editor, which asks the same question of the same item.
export { expectedKey };

// --- the DOM -------------------------------------------------------------------

export interface PanelHost {
  // The editor's own number field (`numField`): refreshed with the rest of the
  // panel, one undo step per editing session.
  numField(
    parent: HTMLElement,
    label: string,
    get: () => number | null,
    set: (v: number) => void,
    step: number,
    mixable: boolean,
    opts: { placeholder?: string; onEmpty?: () => void },
  ): HTMLInputElement;
  // Read-only lines refreshed with the fields.
  readonly readouts: Array<{ el: HTMLElement; get: () => string }>;
  beginAction(): void;
  markDirty(): void;
  refreshFields(): void;
  lookup(): ItemLookup;
  job(itemId: number): Job | undefined;
  facts(key: string): { bytes: number; triangles: number } | null;
  generate(item: EdItem): void;
  // Mushrooms: reopen the loop for dragging, and what the loop covers now.
  editLoop(item: EdItem): void;
  surfaceSummary(item: EdItem): string;
  notice(text: string): void;
}

// Which Advanced disclosures are open, per kind and group, so a panel rebuilt
// by an edit keeps the one the author was working in.
const openAdvanced = new Set<string>();

function el(tag: string, cls: string, text = ""): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "ed-btn";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

// A parameter's label: its words, then its unit.
export function paramLabel(spec: ParamSpec): string {
  const words = spec.key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spec.unit === "m" ? `${words} (m)` : spec.unit === "deg" ? `${words}°` : words;
}

function defaultText(spec: ParamSpec): string {
  if (spec.default === null) return "auto";
  if (Array.isArray(spec.default)) return hexOfLinear(spec.default);
  return String(spec.default);
}

// The field's label as an element that can shrink: the panel is 190 px wide
// and a schema key is as long as its meaning needs, so a long one is cut with
// an ellipsis and read whole in the tooltip.
function relabel(wrap: HTMLElement, spec: ParamSpec): void {
  const first = wrap.firstChild;
  if (first && first.nodeType === Node.TEXT_NODE) wrap.removeChild(first);
  const label = el("span", "ed-gen-label", paramLabel(spec));
  wrap.insertBefore(label, wrap.firstChild);
  wrap.title = `${spec.key}${spec.unit ? ` (${spec.unit === "deg" ? "degrees" : "metres"})` : ""}: ${spec.doc} Default ${defaultText(spec)}.`;
}

// One parameter's field, of its schema type.
function addParamField(host: PanelHost, parent: HTMLElement, item: EdItem, schema: ParamSchema, spec: ParamSpec): void {
  const gen = () => item.visual.generator!;
  const write = (value: ParamValue | null): void => {
    gen().params = withParam(gen().params, schema, spec.key, value);
  };
  if (spec.type === "int" || spec.type === "number") {
    const input = host.numField(
      parent,
      paramLabel(spec),
      () => {
        const v = paramValue(gen().params, spec);
        return typeof v === "number" ? v : null;
      },
      (v) => write(clampParam(spec, v)),
      spec.step ?? 1,
      false,
      { placeholder: defaultText(spec), onEmpty: () => write(null) },
    );
    if (spec.min !== undefined) input.min = String(spec.min);
    if (spec.max !== undefined) input.max = String(spec.max);
    relabel(input.parentElement!, spec);
    return;
  }
  const wrap = el("label", "ed-field");
  wrap.textContent = paramLabel(spec);
  if (spec.type === "bool") {
    const box = document.createElement("input");
    box.type = "checkbox";
    const read = () => (paramValue(gen().params, spec) ?? spec.default) === true;
    box.checked = read();
    box.addEventListener("change", () => {
      host.beginAction();
      write(box.checked);
      host.markDirty();
      host.refreshFields();
    });
    host.readouts.push({ el: el("span", ""), get: () => ((box.checked = read()), "") });
    wrap.appendChild(box);
  } else if (spec.type === "enum") {
    const sel = document.createElement("select");
    sel.className = "ed-select";
    for (const o of spec.options ?? []) {
      const opt = document.createElement("option");
      opt.value = String(o);
      opt.textContent = String(o) + (o === spec.default ? " (default)" : "");
      sel.appendChild(opt);
    }
    const read = () => String(paramValue(gen().params, spec) ?? spec.default);
    sel.value = read();
    sel.addEventListener("change", () => {
      const picked = (spec.options ?? []).find((o) => String(o) === sel.value);
      if (picked === undefined) return;
      host.beginAction();
      write(picked);
      host.markDirty();
      host.refreshFields();
    });
    host.readouts.push({ el: el("span", ""), get: () => ((sel.value = read()), "") });
    wrap.appendChild(sel);
  } else if (spec.type === "color") {
    const input = document.createElement("input");
    input.type = "color";
    input.className = "ed-color";
    const read = () => hexOfLinear((paramValue(gen().params, spec) ?? spec.default ?? [0, 0, 0]) as number[]);
    input.value = read();
    // One undo step per editing session, as a number field's.
    input.addEventListener("focus", () => host.beginAction());
    input.addEventListener("input", () => {
      write(linearOfHex(input.value));
      host.markDirty();
      host.refreshFields();
    });
    host.readouts.push({
      el: el("span", ""),
      get: () => {
        if (document.activeElement !== input) input.value = read();
        return "";
      },
    });
    wrap.appendChild(input);
  }
  relabel(wrap, spec);
  parent.appendChild(wrap);
}

// The Rock or Mushrooms group for one selected generated object.
export function buildGeneratorGroup(host: PanelHost, item: EdItem): HTMLElement {
  const g = item.visual.generator!;
  const schema = loadSchema(g.kind);
  const group = el("div", "ed-group ed-gen");
  group.appendChild(el("div", "ed-heading", g.kind === "boulder" ? "Rock" : "Mushrooms"));
  if (!schema) {
    group.appendChild(
      el("div", "ed-hint ed-warn", `A ${g.kind} generator is not one this editor knows; its block is kept as it is.`),
    );
    return group;
  }
  if (g.version !== schema.version) {
    group.appendChild(
      el("div", "ed-hint", `Set under schema version ${g.version}; Generate makes it under ${schema.version}.`),
    );
  }

  // The status line, refreshed with the fields (the job client refreshes them
  // at every poll, so "generating N s" counts).
  const status = el("div", "ed-gen-status");
  const statusNow = () => generatorStatus(item, host.lookup(), host.job(item.id), (k) => host.facts(k));
  host.readouts.push({
    el: status,
    get: () => {
      const s = statusNow();
      status.dataset["tone"] = s.tone;
      status.title = s.detail ?? "";
      return s.text;
    },
  });
  status.textContent = statusNow().text;
  group.appendChild(status);

  const actions = el("div", "ed-row ed-gen-actions");
  actions.append(
    button("Generate", "Generate this object's mesh from its outline and parameters now (Ctrl+Enter). A result already made is taken from the cache.", () =>
      host.generate(item),
    ),
    button("Next seed", "Move the seed on by one and generate: another rock (or patch) from the same outline and settings.", () => {
      host.beginAction();
      g.params = nextSeedParams(g.params, schema);
      host.markDirty();
      host.refreshFields();
      host.generate(item);
    }),
    button("Reset", "Every parameter back to its default (does not generate).", () => {
      if (!Object.keys(g.params).length) return;
      host.beginAction();
      g.params = {};
      host.markDirty();
      host.refreshFields();
    }),
    button("Copy", "Copy these parameters (the values that differ from the defaults) to the clipboard, to paste onto another object of this kind.", () => {
      const text = paramsPayload(g.kind, g.version, g.params);
      lastCopied = text;
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      host.notice(`copied ${Object.keys(g.params).length} ${g.kind} parameter(s)`);
    }),
    button("Paste", "Replace these parameters with the ones last copied from another object of this kind.", () => {
      const apply = (text: string): void => {
        const parsed = parseParamsPayload(text, schema);
        if ("error" in parsed) {
          host.notice(`paste: ${parsed.error}`);
          return;
        }
        host.beginAction();
        g.params = parsed.params;
        host.markDirty();
        host.refreshFields();
        host.notice(`pasted ${Object.keys(parsed.params).length} ${g.kind} parameter(s)`);
      };
      const read = navigator.clipboard?.readText?.();
      if (!read) apply(lastCopied);
      else void read.then(apply, () => apply(lastCopied));
    }),
  );
  if (g.kind === "mushrooms") {
    actions.appendChild(
      button("Edit loop", "Show the painted loop's points on the surface and drag them (each drag re-picks the surface under the pointer). Enter or Esc ends it.", () =>
        host.editLoop(item),
      ),
    );
  }
  group.appendChild(actions);

  if (g.kind === "mushrooms") {
    const surface = el("div", "ed-hint");
    host.readouts.push({ el: surface, get: () => host.surfaceSummary(item) });
    surface.textContent = host.surfaceSummary(item);
    group.appendChild(surface);
  }

  // Min above Max, and anything else the generator would refuse, said before a
  // round trip to the server does.
  const issues = el("div", "ed-hint ed-warn");
  const issuesNow = () => paramIssues(g.params, schema).join("; ");
  host.readouts.push({ el: issues, get: issuesNow });
  issues.textContent = issuesNow();
  group.appendChild(issues);

  for (const name of schema.groups) {
    const specs = schema.params.filter((p) => p.group === name);
    if (!specs.length) continue;
    const section = el("div", "ed-group ed-gen-section");
    section.appendChild(el("div", "ed-gen-subhead", name));
    for (const spec of specs.filter((p) => p.basic)) addParamField(host, section, item, schema, spec);
    const advanced = specs.filter((p) => !p.basic);
    if (advanced.length) {
      const id = `${g.kind}/${name}`;
      const details = document.createElement("details");
      details.className = "ed-details";
      details.open = openAdvanced.has(id);
      details.addEventListener("toggle", () => {
        if (details.open) openAdvanced.add(id);
        else openAdvanced.delete(id);
      });
      const summary = document.createElement("summary");
      const set = advanced.filter((p) => p.key in g.params).length;
      summary.textContent = `Advanced (${advanced.length}${set ? `, ${set} set` : ""})`;
      details.appendChild(summary);
      const body = el("div", "ed-group");
      for (const spec of advanced) addParamField(host, body, item, schema, spec);
      details.appendChild(body);
      section.appendChild(details);
    }
    group.appendChild(section);
  }
  return group;
}

// What Copy put on the clipboard last, for a page the browser will not let
// read the clipboard back (no permission, or not a secure context).
let lastCopied = "";

// The panel's own styles, added once beside the editor's.
export const GENERATOR_PANEL_CSS = `
  .ed-gen-status { white-space: pre-wrap; line-height: 1.4; color: #9aa0ac; }
  .ed-gen-status[data-tone="warn"] { color: #d0a215; }
  .ed-gen-status[data-tone="fail"] { color: #e06c75; }
  .ed-gen-status[data-tone="busy"] { color: #65bddb; }
  .ed-gen-actions { flex-wrap: wrap; gap: 4px; }
  .ed-gen-subhead { color: #9aa0ac; border-bottom: 1px dotted #313244; margin-top: 4px; }
  /* Not the readout rule the inspector gives every span in a field (which wraps
     and right-aligns a computed sentence): a label stays one line, left, and
     gives way with an ellipsis. */
  .ed-gen .ed-field > .ed-gen-label { white-space: nowrap; text-align: left; overflow: hidden;
    text-overflow: ellipsis; min-width: 0; flex: 1 1 auto; }
  .ed-details > summary { color: #6b7280; cursor: pointer; list-style: none; }
  .ed-details > summary::before { content: "▸ "; }
  .ed-details[open] > summary::before { content: "▾ "; }
  .ed-details > summary:hover { color: #cbccc6; }
  .ed-details > .ed-group { padding-left: 10px; margin-top: 4px; }
  .ed-out-badge { color: #d0a215; margin-left: auto; }
  .ed-out-badge:empty { display: none; }
  .ed-out-badge:not(:empty) + .ed-out-count { margin-left: 6px; }
  .ed-out-badge.busy { color: #65bddb; }
  .ed-out-badge.fail { color: #e06c75; }
`;
