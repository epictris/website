// Every edit to the scene, as a function that mutates a draft EditorState and
// returns the issues that stopped it (an empty list means it applied). The
// store runs these on a copy and commits only when nothing is an error, so the
// UI and the agent API share one set of rules.

import { cameraProblem, focalToFov } from "./camera";
import { clone, finite, MAX_VALUE, MIN_FRAME, MIN_SIZE } from "./math";
import { boundsOf, DEFAULT_COLOR, initialState, MAX_OBJECTS, objectById, uniqueId } from "./model";
import { setWorldParts, type WorldPart, worldParts } from "./parts";
import { assignRing, type Primitive, presetOutlines, RING_PROBLEMS, ringProblem, toNormalized } from "./ring";
import type {
  Blend,
  Camera,
  Display,
  EditorState,
  Issue,
  OrthoReference,
  PerspectiveReference,
  Point,
  ReferenceView,
  Ring,
  SceneObject,
  Vec3,
  ViewId,
} from "./types";
import { AXES, axisNames, VIEW_IDS, VIEWS } from "./views";

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const issue = (code: string, message: string, extra: Partial<Issue> = {}): Issue => ({
  severity: "error",
  code,
  path: "",
  message,
  ...extra,
});

const missing = (id: string): Issue[] => [
  issue("unknown-object", `There is no object with id "${id}".`, { objectId: id }),
];
const lockedIssue = (e: SceneObject): Issue[] => [
  issue("object-locked", `${e.id} is locked. Unlock it before changing it.`, { objectId: e.id }),
];

// ---- Objects ---------------------------------------------------------------

/** A trace as documents and tools give it: hidden runs are optional. */
export interface TraceSpec {
  points: Point[];
  hidden?: [number, number][];
}

export interface ObjectProps {
  name?: string;
  kind?: string;
  color?: string;
  visible?: boolean;
  locked?: boolean;
  reviewed?: boolean;
  opacity?: number;
  notes?: string;
  /** The silhouette traced in the perspective reference, or null to remove it. */
  trace?: TraceSpec | null;
  inFrontOf?: string[];
}

/** Why a trace is unusable (one issue per problem), with paths under `path`. */
function traceIssues(t: TraceSpec, objectId?: string, path = "/trace"): Issue[] {
  const problem = ringProblem(t?.points);
  if (problem)
    return [
      issue(`trace-${problem}`, `The trace of ${objectId ?? "the object"} ${RING_PROBLEMS[problem]}.`, {
        objectId,
        path: `${path}/points`,
      }),
    ];
  const n = t.points.length;
  const out: Issue[] = [];
  (t.hidden ?? []).forEach((run, i) => {
    if (!(Array.isArray(run) && run.length === 2 && run.every((k) => Number.isInteger(k) && k >= 0 && k < n)))
      out.push(
        issue("invalid-hidden-run", `hidden[${i}] must be two vertex indices from 0 to ${n - 1}.`, {
          objectId,
          path: `${path}/hidden/${i}`,
        }),
      );
    else if (run[0] === run[1])
      out.push(
        issue("invalid-hidden-run", `hidden[${i}] starts and ends at vertex ${run[0]}; a run needs two vertices.`, {
          objectId,
          path: `${path}/hidden/${i}`,
        }),
      );
  });
  return out;
}

function propsIssues(p: ObjectProps, objectId?: string): Issue[] {
  const out: Issue[] = [];
  const bad = (field: string, what: string) =>
    out.push(issue("invalid-property", `${field} ${what}.`, { objectId, path: `/${field}` }));
  if (p.trace !== undefined && p.trace !== null) out.push(...traceIssues(p.trace, objectId));
  if (
    p.inFrontOf !== undefined &&
    !(
      Array.isArray(p.inFrontOf) &&
      p.inFrontOf.every((id) => typeof id === "string" && ID_PATTERN.test(id)) &&
      new Set(p.inFrontOf).size === p.inFrontOf.length
    )
  )
    bad("inFrontOf", "must be a list of distinct object ids");
  else if (objectId !== undefined && p.inFrontOf?.includes(objectId)) bad("inFrontOf", "cannot name the object itself");
  if (p.name !== undefined && (typeof p.name !== "string" || p.name.length > 180))
    bad("name", "must be text of at most 180 characters");
  if (p.kind !== undefined && (typeof p.kind !== "string" || p.kind.length > 40))
    bad("kind", "must be text of at most 40 characters");
  if (p.color !== undefined && !COLOR_PATTERN.test(String(p.color)))
    bad("color", 'must be a hex colour such as "#5ee9cf"');
  for (const k of ["visible", "locked", "reviewed"] as const)
    if (p[k] !== undefined && typeof p[k] !== "boolean") bad(k, "must be true or false");
  if (p.opacity !== undefined && !(finite(p.opacity) && p.opacity >= 0.05 && p.opacity <= 1))
    bad("opacity", "must be from 0.05 to 1");
  if (p.notes !== undefined && (typeof p.notes !== "string" || p.notes.length > 2000))
    bad("notes", "must be text of at most 2000 characters");
  return out;
}

function applyProps(e: SceneObject, p: ObjectProps) {
  for (const k of ["name", "kind", "color", "visible", "locked", "reviewed", "opacity", "notes"] as const)
    if (p[k] !== undefined) (e as unknown as Record<string, unknown>)[k] = p[k];
  if (p.trace !== undefined)
    e.trace = p.trace && { points: clone(p.trace.points), hidden: clone(p.trace.hidden ?? []) };
  if (p.inFrontOf !== undefined) e.inFrontOf = [...p.inFrontOf];
}

/** inFrontOf entries naming objects the scene does not have (errors, for edits; `only` limits the check). */
export function inFrontOfIssues(
  s: EditorState,
  only?: ReadonlySet<string>,
  severity: Issue["severity"] = "error",
): Issue[] {
  const ids = new Set(s.objects.map((e) => e.id));
  const out: Issue[] = [];
  s.objects.forEach((e, i) => {
    if (only && !only.has(e.id)) return;
    (e.inFrontOf ?? []).forEach((other, j) => {
      if (!ids.has(other))
        out.push({
          severity,
          code: "unknown-object",
          path: `/objects/${i}/inFrontOf/${j}`,
          objectId: e.id,
          message: `${e.id} is said to be in front of "${other}", which is not in the scene.`,
        });
    });
  });
  return out;
}

/** An object's shape in metres, as documents give it: one solid, or a union of parts. */
export type WorldShape =
  | { outlines: Record<ViewId, Ring> }
  | { parts: { id?: string; outlines: Record<ViewId, Ring> }[] };

const MAX_PARTS = 32;

/**
 * One part from world-unit outlines: its box on each axis is the union of the
 * two views that show it; a mismatch between them is a warning, because the
 * narrower silhouette clips the solid. `name` and `path` say where problems are.
 */
function partFromWorld(
  outlines: Record<ViewId, Ring>,
  id: string,
  name: string,
  path: string,
): { part?: WorldPart; issues: Issue[] } {
  const issues: Issue[] = [];
  for (const view of VIEW_IDS) {
    const problem = ringProblem(outlines?.[view]);
    if (problem)
      issues.push(
        issue(`ring-${problem}`, `The ${view} outline of ${name} ${RING_PROBLEMS[problem]}.`, {
          objectId: id,
          view,
          path: `${path}/outlines/${view}`,
        }),
      );
  }
  if (issues.length) return { issues };
  // Span of each world axis as seen by each view that shows it.
  const spans: { view: ViewId; lo: number; hi: number }[][] = [[], [], []];
  for (const view of VIEW_IDS) {
    VIEWS[view].axes.forEach((axis, j) => {
      const values = outlines[view].map((p) => p[j]);
      spans[axis].push({ view, lo: Math.min(...values), hi: Math.max(...values) });
    });
  }
  const min = [0, 0, 0] as Vec3;
  const size = [0, 0, 0] as Vec3;
  for (let axis = 0; axis < 3; axis++) {
    const [p, q] = spans[axis];
    const lo = Math.min(p.lo, q.lo);
    const hi = Math.max(p.hi, q.hi);
    min[axis] = lo;
    size[axis] = hi - lo;
    if (size[axis] < MIN_SIZE) {
      issues.push(
        issue("collapsed-axis", `${name} has no extent along ${AXES[axis]} (at least ${MIN_SIZE} m is needed).`, {
          objectId: id,
          path: `${path}/outlines`,
        }),
      );
      continue;
    }
    const tolerance = 1e-6 * Math.max(1, size[axis]);
    if (Math.abs(p.lo - q.lo) > tolerance || Math.abs(p.hi - q.hi) > tolerance)
      issues.push({
        severity: "warning",
        code: "extent-mismatch",
        path: `${path}/outlines`,
        objectId: id,
        message: `The ${p.view} and ${q.view} outlines of ${name} disagree along ${AXES[axis]}: ${p.view} spans ${p.lo}..${p.hi}, ${q.view} spans ${q.lo}..${q.hi}. The box uses ${lo}..${hi}; the narrower outline clips the solid. Make both span the same range.`,
      });
  }
  if (issues.some((i) => i.severity === "error")) return { issues };
  const normalised = {} as Record<ViewId, Ring>;
  for (const view of VIEW_IDS) {
    const [a, b] = VIEWS[view].axes;
    normalised[view] = outlines[view].map((p) => [(p[0] - min[a]) / size[a], (p[1] - min[b]) / size[b]] as Point);
  }
  return { part: { min, size, outlines: normalised }, issues };
}

/** The parts of a shape in world units, or the problems that stop them. */
function partsFromWorld(id: string, shape: WorldShape, pathPrefix = ""): { parts?: WorldPart[]; issues: Issue[] } {
  const issues: Issue[] = [];
  if ("parts" in shape && shape.parts) {
    const list = shape.parts;
    if (!Array.isArray(list) || !list.length || list.length > MAX_PARTS)
      return {
        issues: [
          issue("invalid-parts", `parts needs 1 to ${MAX_PARTS} parts.`, { objectId: id, path: `${pathPrefix}/parts` }),
        ],
      };
    const parts: WorldPart[] = [];
    const ids = new Map<string, number>();
    list.forEach((spec, k) => {
      const path = `${pathPrefix}/parts/${k}`;
      if (spec.id !== undefined) {
        if (!ID_PATTERN.test(spec.id) || ids.has(spec.id))
          issues.push(
            issue("invalid-part-id", `Part ${k} of ${id} needs a valid id unused by its other parts.`, {
              objectId: id,
              path: `${path}/id`,
            }),
          );
        ids.set(spec.id, k);
      }
      const r = partFromWorld(spec.outlines, id, `${id} part ${spec.id ?? k}`, path);
      issues.push(...r.issues);
      if (r.part) parts.push({ ...(spec.id !== undefined && { id: spec.id }), ...r.part });
    });
    return issues.some((i) => i.severity === "error") ? { issues } : { parts, issues };
  }
  const r = partFromWorld((shape as { outlines: Record<ViewId, Ring> }).outlines, id, id, pathPrefix);
  return r.part ? { parts: [r.part], issues: r.issues } : { issues: r.issues };
}

/** Build an object from a shape in world units (outlines, or parts) and its properties. */
export function objectFromWorld(
  id: string,
  shape: WorldShape,
  props: ObjectProps = {},
  pathPrefix = "",
): { object?: SceneObject; issues: Issue[] } {
  const built = partsFromWorld(id, shape, pathPrefix);
  const issues = [...built.issues];
  for (const found of propsIssues(props, id)) issues.push({ ...found, path: `${pathPrefix}${found.path}` });
  if (!built.parts || issues.some((i) => i.severity === "error")) return { issues };
  const object: SceneObject = {
    id,
    name: id,
    kind: "",
    color: DEFAULT_COLOR,
    min: [0, 0, 0],
    size: [1, 1, 1],
    parts: [],
    visible: true,
    locked: false,
    reviewed: false,
    opacity: 1,
    notes: "",
  };
  setWorldParts(object, built.parts);
  applyProps(object, props);
  return { object, issues };
}

export interface NewObject extends ObjectProps {
  id?: string;
  /** World-unit outlines for all three views. */
  outlines?: Record<ViewId, Ring>;
  /** Or the object as a union of parts, each with world-unit outlines. */
  parts?: { id?: string; outlines: Record<ViewId, Ring> }[];
  /** Or a starting shape filling a box. */
  primitive?: Primitive;
  center?: Vec3;
  size?: Vec3;
}

export function addObject(s: EditorState, spec: NewObject): { id?: string; issues: Issue[] } {
  if (s.objects.length >= MAX_OBJECTS)
    return { issues: [issue("too-many-objects", `A scene holds at most ${MAX_OBJECTS} objects.`)] };
  const id = spec.id ?? uniqueId(s);
  if (!ID_PATTERN.test(id))
    return {
      issues: [
        issue(
          "invalid-id",
          `"${id}" is not a valid id: use letters, digits, "_", "." or "-", starting with a letter or digit (at most 64).`,
        ),
      ],
    };
  if (objectById(s, id))
    return { issues: [issue("duplicate-id", `An object with id "${id}" already exists.`, { objectId: id })] };
  const issues = propsIssues(spec, id);
  if (issues.length) return { issues };
  if (spec.outlines && spec.parts) return { issues: [issue("invalid-shape", "Give outlines or parts, not both.")] };
  let outlines = spec.outlines;
  if (!outlines && !spec.parts) {
    const size = spec.size ?? [4, 4, 4];
    const center = spec.center ?? (s.scene.size.map((v) => v / 2) as Vec3);
    if (!size.every((v) => finite(v) && v >= MIN_SIZE) || !center.every((v) => finite(v)))
      return { issues: [issue("invalid-box", "center must be finite and every size at least 0.001 m.")] };
    const min = center.map((c, i) => c - size[i] / 2);
    const preset = presetOutlines(spec.primitive ?? "box");
    outlines = {} as Record<ViewId, Ring>;
    for (const view of VIEW_IDS) {
      const [a, b] = VIEWS[view].axes;
      outlines[view] = preset[view].map((p) => [min[a] + p[0] * size[a], min[b] + p[1] * size[b]] as Point);
    }
  }
  const built = objectFromWorld(id, spec.parts ? { parts: spec.parts } : { outlines: outlines! }, spec);
  if (!built.object) return { issues: built.issues };
  s.objects.push(built.object);
  return { id, issues: built.issues };
}

export function updateObject(s: EditorState, id: string, patch: ObjectProps): Issue[] {
  const e = objectById(s, id);
  if (!e) return missing(id);
  // Locking and unlocking are always allowed; other changes to a locked object are not.
  const { locked, ...rest } = patch;
  if (e.locked && locked !== false && Object.keys(rest).length) return lockedIssue(e);
  const issues = propsIssues(patch, id);
  if (issues.length) return issues;
  applyProps(e, patch);
  return [];
}

/** The part an edit names, or the issue that says it does not exist. */
function partIssue(e: SceneObject, part: number): Issue[] {
  return Number.isInteger(part) && part >= 0 && part < e.parts.length
    ? []
    : [
        issue(
          "unknown-part",
          `${e.id} has ${e.parts.length} part${e.parts.length === 1 ? "" : "s"}; part ${part} is not one of them (they count from 0).`,
          { objectId: e.id },
        ),
      ];
}

/** Replace one view's outline of a part (default the first) with world-unit points. */
export function setOutline(s: EditorState, id: string, view: ViewId, points: Ring, part = 0): Issue[] {
  const e = objectById(s, id);
  if (!e) return missing(id);
  if (e.locked) return lockedIssue(e);
  const wrong = partIssue(e, part);
  if (wrong.length) return wrong;
  const problem = ringProblem(points);
  if (problem)
    return [issue(`ring-${problem}`, `That ${view} outline ${RING_PROBLEMS[problem]}.`, { objectId: id, view })];
  const start = clone(e);
  if (
    !assignRing(
      e,
      start,
      view,
      points.map((p) => toNormalized(start, view, p, part)),
      part,
    )
  )
    return [
      issue("collapsed-axis", `That ${view} outline collapses an axis to less than ${MIN_SIZE} m.`, {
        objectId: id,
        view,
      }),
    ];
  return [];
}

/**
 * Replace all three outlines of a part at once, with world-unit points: the
 * part's box comes from the three together, so no view is stretched to fit
 * another on the way. An object of several parts needs `part` said.
 */
export function setOutlines(s: EditorState, id: string, outlines: Record<ViewId, Ring>, part?: number): Issue[] {
  const e = objectById(s, id);
  if (!e) return missing(id);
  if (e.locked) return lockedIssue(e);
  if (part === undefined && e.parts.length > 1)
    return [
      issue("part-required", `${e.id} has ${e.parts.length} parts: say which part these outlines are for.`, {
        objectId: id,
      }),
    ];
  const k = part ?? 0;
  const wrong = partIssue(e, k);
  if (wrong.length) return wrong;
  const built = partsFromWorld(id, { outlines });
  if (!built.parts) return built.issues;
  const parts = worldParts(e);
  parts[k] = { ...(parts[k].id !== undefined && { id: parts[k].id }), ...built.parts[0] };
  setWorldParts(e, parts);
  e.reviewed = false;
  return built.issues;
}

/** Replace every part of an object (world-unit outlines per part); one part with no id is a plain object. */
export function setParts(
  s: EditorState,
  id: string,
  parts: { id?: string; outlines: Record<ViewId, Ring> }[],
): Issue[] {
  const e = objectById(s, id);
  if (!e) return missing(id);
  if (e.locked) return lockedIssue(e);
  const built = partsFromWorld(id, { parts });
  if (!built.parts) return built.issues;
  setWorldParts(e, built.parts);
  e.reviewed = false;
  return built.issues;
}

/** Add a part: a box filling the middle half of the object's box, or the given outlines. Returns its index. */
export function addPart(
  s: EditorState,
  id: string,
  outlines?: Record<ViewId, Ring>,
): { part?: number; issues: Issue[] } {
  const e = objectById(s, id);
  if (!e) return { issues: missing(id) };
  if (e.locked) return { issues: lockedIssue(e) };
  if (e.parts.length >= MAX_PARTS)
    return { issues: [issue("too-many-parts", `An object has at most ${MAX_PARTS} parts.`)] };
  let shape = outlines;
  if (!shape) {
    const lo = e.min.map((v, a) => v + e.size[a] / 4);
    const hi = e.min.map((v, a) => v + (3 * e.size[a]) / 4);
    shape = {} as Record<ViewId, Ring>;
    for (const view of VIEW_IDS) {
      const [a, b] = VIEWS[view].axes;
      shape[view] = [
        [lo[a], lo[b]],
        [hi[a], lo[b]],
        [hi[a], hi[b]],
        [lo[a], hi[b]],
      ];
    }
  }
  const built = partsFromWorld(id, { outlines: shape });
  if (!built.parts) return { issues: built.issues };
  setWorldParts(e, [...worldParts(e), built.parts[0]]);
  e.reviewed = false;
  return { part: e.parts.length - 1, issues: built.issues };
}

/** Remove a part; an object keeps at least one. */
export function removePart(s: EditorState, id: string, part: number): Issue[] {
  const e = objectById(s, id);
  if (!e) return missing(id);
  if (e.locked) return lockedIssue(e);
  const wrong = partIssue(e, part);
  if (wrong.length) return wrong;
  if (e.parts.length === 1) return [issue("last-part", `${e.id} has only this part; delete the object instead.`)];
  setWorldParts(
    e,
    worldParts(e).filter((_, k) => k !== part),
  );
  e.reviewed = false;
  return [];
}

/** Replace one view's outline of a part with points normalised to the part's current box (editor internals). */
export function setNormalizedOutline(s: EditorState, id: string, view: ViewId, raw: Ring, part = 0): Issue[] {
  const e = objectById(s, id);
  if (!e) return missing(id);
  if (e.locked) return lockedIssue(e);
  const wrong = partIssue(e, part);
  if (wrong.length) return wrong;
  if (!assignRing(e, clone(e), view, raw, part))
    return [issue("ring-invalid", "Edges cannot cross, and an outline cannot collapse.", { objectId: id, view })];
  return [];
}

function unlocked(s: EditorState, ids: string[]): { items: SceneObject[]; issues: Issue[] } {
  const items: SceneObject[] = [];
  for (const id of ids) {
    const e = objectById(s, id);
    if (!e) return { items, issues: missing(id) };
    if (e.locked) return { items, issues: lockedIssue(e) };
    items.push(e);
  }
  if (!items.length) return { items, issues: [issue("empty-selection", "Name at least one object.")] };
  return { items, issues: [] };
}

function withinLimits(items: SceneObject[]): Issue[] {
  const ok = items.every(
    (e) =>
      e.min.every((v, a) => Number.isFinite(v) && Math.abs(v) <= MAX_VALUE && Math.abs(v + e.size[a]) <= MAX_VALUE) &&
      e.size.every((v) => Number.isFinite(v) && v >= MIN_SIZE && v <= MAX_VALUE),
  );
  return ok
    ? []
    : [issue("out-of-range", "Objects must stay within ±1,000,000 m, with every dimension at least 0.001 m.")];
}

/** Translate objects by a world-unit offset. */
export function moveObjects(s: EditorState, ids: string[], delta: Vec3): Issue[] {
  const { items, issues } = unlocked(s, ids);
  if (issues.length) return issues;
  for (const e of items) {
    for (let a = 0; a < 3; a++) e.min[a] += delta[a];
    e.reviewed = false;
  }
  return withinLimits(items);
}

/**
 * Set the bounding box of a group along one axis. Objects scale and move
 * together, keeping their relative placement inside the group box.
 */
export function setGroupAxis(s: EditorState, ids: string[], axis: number, lo: number, hi: number): Issue[] {
  const { items, issues } = unlocked(s, ids);
  if (issues.length) return issues;
  if (!finite(lo) || !finite(hi) || hi - lo < MIN_SIZE)
    return [issue("invalid-box", "The new extent must be finite and at least 0.001 m.")];
  const b = boundsOf(items)!;
  const factor = (hi - lo) / (b.max[axis] - b.min[axis]);
  for (const e of items) {
    e.min[axis] = lo + (e.min[axis] - b.min[axis]) * factor;
    e.size[axis] *= factor;
    e.reviewed = false;
  }
  return withinLimits(items);
}

/** Set an object's (or group's) whole box: any of min / max per axis. */
export function setBounds(s: EditorState, ids: string[], box: { min?: Partial<Vec3>; max?: Partial<Vec3> }): Issue[] {
  const { items, issues } = unlocked(s, ids);
  if (issues.length) return issues;
  const b = boundsOf(items)!;
  for (let a = 0; a < 3; a++) {
    const lo = box.min?.[a] ?? b.min[a];
    const hi = box.max?.[a] ?? b.max[a];
    if (lo === b.min[a] && hi === b.max[a]) continue;
    const out = setGroupAxis(s, ids, a, lo, hi);
    if (out.length) return out;
  }
  return [];
}

export function deleteObjects(s: EditorState, ids: string[]): Issue[] {
  const { items, issues } = unlocked(s, ids);
  if (issues.length) return issues;
  const drop = new Set(items.map((e) => e.id));
  s.objects = s.objects.filter((e) => !drop.has(e.id));
  // Nothing can stand in front of an object that is gone.
  for (const e of s.objects)
    if (e.inFrontOf?.some((id) => drop.has(id))) e.inFrontOf = e.inFrontOf.filter((id) => !drop.has(id));
  return [];
}

export function duplicateObjects(
  s: EditorState,
  ids: string[],
  offset: Vec3 = [1, 1, 0],
): { ids: string[]; issues: Issue[] } {
  const out: string[] = [];
  for (const id of ids) {
    const original = objectById(s, id);
    if (!original) return { ids: out, issues: missing(id) };
    if (s.objects.length >= MAX_OBJECTS)
      return { ids: out, issues: [issue("too-many-objects", `A scene holds at most ${MAX_OBJECTS} objects.`)] };
    const e = clone(original);
    e.id = uniqueId(s, original.id.replace(/-\d+$/, "") || "obj");
    e.name = `${original.name} copy`;
    e.min = e.min.map((v, i) => v + offset[i]) as Vec3;
    // Moved away from what was traced, the trace no longer describes it.
    e.trace = null;
    e.locked = false;
    e.reviewed = false;
    s.objects.push(e);
    out.push(e.id);
  }
  return { ids: out, issues: [] };
}

// ---- Scene, camera, display --------------------------------------------------

export interface ScenePatch {
  title?: string;
  size?: Vec3;
  scaleBasis?: string;
  notes?: string;
}

export function setScene(s: EditorState, p: ScenePatch): Issue[] {
  if (p.title !== undefined && (typeof p.title !== "string" || p.title.length > 100))
    return [issue("invalid-scene", "title must be text of at most 100 characters.")];
  if (
    p.size !== undefined &&
    !(Array.isArray(p.size) && p.size.length === 3 && p.size.every((v) => finite(v) && v >= MIN_FRAME))
  )
    return [issue("invalid-scene", `size needs three finite values of at least ${MIN_FRAME} m.`)];
  if (p.scaleBasis !== undefined && (typeof p.scaleBasis !== "string" || p.scaleBasis.length > 1000))
    return [issue("invalid-scene", "scale basis must be text of at most 1000 characters.")];
  if (p.notes !== undefined && (typeof p.notes !== "string" || p.notes.length > 4000))
    return [issue("invalid-scene", "notes must be text of at most 4000 characters.")];
  if (p.title !== undefined) s.scene.title = p.title;
  if (p.size !== undefined) s.scene.size = [...p.size];
  if (p.scaleBasis !== undefined) s.scene.scaleBasis = p.scaleBasis;
  if (p.notes !== undefined) s.scene.notes = p.notes;
  return [];
}

/**
 * Scale the whole scene about the origin: the frame, every object (locked ones
 * too: this corrects the scene's size, not an object's shape), the placement
 * of the orthographic references and the camera. For when the scale estimate
 * changes: everything keeps its place relative to everything else.
 */
export function rescaleScene(s: EditorState, factor: number): Issue[] {
  if (!(finite(factor) && factor > 0)) return [issue("invalid-scale", "factor must be a positive number.")];
  const scale = (v: number[]) => v.map((x) => x * factor);
  s.scene.size = scale(s.scene.size) as Vec3;
  for (const e of s.objects) {
    e.min = scale(e.min) as Vec3;
    e.size = scale(e.size) as Vec3;
  }
  for (const view of VIEW_IDS) {
    const r = s.references[view];
    if (!r) continue;
    r.min = scale(r.min) as Point;
    r.size = scale(r.size) as Point;
  }
  const c = s.camera;
  c.position = scale(c.position) as Vec3;
  c.target = scale(c.target) as Vec3;
  c.near = Math.max(0.0001, c.near * factor);
  c.far *= factor;
  const refs = VIEW_IDS.flatMap((v) => s.references[v] ?? []);
  const fits =
    s.scene.size.every((v) => v >= MIN_FRAME && v <= MAX_VALUE) &&
    refs.every((r) => r.size.every((v) => v >= MIN_SIZE) && [...r.min, ...r.size].every((v) => finite(v)));
  if (!fits || withinLimits(s.objects).length || cameraProblem(c))
    return [
      issue(
        "out-of-range",
        `Scaling by ${factor} takes the scene out of range: the frame must stay ${MIN_FRAME} m to 1,000,000 m, objects and references at least ${MIN_SIZE} m and within ±1,000,000 m.`,
      ),
    ];
  return [];
}

export interface CameraPatch {
  position?: Vec3;
  target?: Vec3;
  fov?: number;
  focalLengthMm?: number;
  roll?: number;
  shift?: [number, number];
  near?: number;
  far?: number;
  frame?: [number, number];
  locked?: boolean;
}

export function setCamera(s: EditorState, p: CameraPatch): Issue[] {
  const c: Camera = clone(s.camera);
  if (p.fov !== undefined && p.focalLengthMm !== undefined)
    return [issue("invalid-camera", "Give the lens as fov or focalLengthMm, not both.")];
  if (p.focalLengthMm !== undefined) {
    if (!(finite(p.focalLengthMm) && p.focalLengthMm > 0))
      return [issue("invalid-camera", "focalLengthMm must be positive.")];
    c.fov = focalToFov(p.focalLengthMm);
  }
  for (const k of ["position", "target", "fov", "roll", "shift", "near", "far", "frame", "locked"] as const)
    if (p[k] !== undefined) (c as unknown as Record<string, unknown>)[k] = clone(p[k]);
  const problem = cameraProblem(c);
  if (problem) return [issue("invalid-camera", problem)];
  s.camera = c;
  return [];
}

/** Replace the whole camera (presets, orbiting); validated like setCamera. */
export function replaceCamera(s: EditorState, c: Camera): Issue[] {
  const problem = cameraProblem(c);
  if (problem) return [issue("invalid-camera", problem)];
  s.camera = clone(c);
  return [];
}

/** Start over with an empty scene. */
export function clearScene(s: EditorState): Issue[] {
  Object.assign(s, initialState());
  return [];
}

export function setDisplay(s: EditorState, p: Partial<Display>): Issue[] {
  if (p.style !== undefined && !["solid", "clay", "wire", "ghost"].includes(p.style))
    return [issue("invalid-display", "style must be solid, clay, wire or ghost.")];
  for (const k of ["grid", "labels", "crosshair"] as const)
    if (p[k] !== undefined && typeof p[k] !== "boolean")
      return [issue("invalid-display", `${k} must be true or false.`)];
  Object.assign(s.display, p);
  return [];
}

// ---- References --------------------------------------------------------------

export interface OrthoReferencePatch {
  image?: string;
  opacity?: number;
  visible?: boolean;
  /** Lower-left corner on the view plane, in the view's (horizontal, vertical) axes. */
  min?: Point;
  size?: Point;
}

export interface PerspectiveReferencePatch {
  image?: string;
  opacity?: number;
  visible?: boolean;
  offsetPercent?: Point;
  scale?: number;
  rotationDegrees?: number;
  blend?: Blend;
}

export interface ImageSize {
  width: number;
  height: number;
}

/** The largest placement with the image's aspect ratio that fits the scene frame on this view's plane, centred. */
export function fitReferencePlacement(s: EditorState, view: ViewId, image: ImageSize): { min: Point; size: Point } {
  const [a, b] = VIEWS[view].axes;
  const W = s.scene.size[a];
  const H = s.scene.size[b];
  const aspect = image.width / image.height;
  const width = Math.min(W, H * aspect);
  const height = width / aspect;
  return { min: [(W - width) / 2, (H - height) / 2], size: [width, height] };
}

export function defaultPerspectiveReference(image: string): PerspectiveReference {
  return { image, opacity: 0.5, visible: true, offsetPercent: [0, 0], scale: 1, rotationDegrees: 0, blend: "normal" };
}

/**
 * Create, change or (with null) remove a view's reference. `images` resolves
 * image ids to their pixel size; a new image without a placement is fitted to
 * the scene frame.
 */
export function setReference(
  s: EditorState,
  view: ReferenceView,
  patch: OrthoReferencePatch | PerspectiveReferencePatch | null,
  images: (id: string) => ImageSize | undefined,
): Issue[] {
  if (patch === null) {
    s.references[view] = null;
    return [];
  }
  const current = s.references[view];
  const image = patch.image ?? current?.image;
  if (!image)
    return [
      issue("missing-image", `The ${view} view has no reference yet: give an image id.`, {
        path: `/references/${view}`,
      }),
    ];
  const size = images(image);
  if (!size)
    return [
      issue("unknown-image", `There is no image with id "${image}". Add it first.`, {
        path: `/references/${view}/image`,
      }),
    ];
  if (patch.opacity !== undefined && !(finite(patch.opacity) && patch.opacity >= 0 && patch.opacity <= 1))
    return [issue("invalid-reference", "opacity must be from 0 to 1.")];
  if (patch.visible !== undefined && typeof patch.visible !== "boolean")
    return [issue("invalid-reference", "visible must be true or false.")];
  if (view === "perspective") {
    const p = patch as PerspectiveReferencePatch;
    const next: PerspectiveReference = {
      ...(current ? clone(current as PerspectiveReference) : defaultPerspectiveReference(image)),
      image,
    };
    if (
      p.offsetPercent !== undefined &&
      !(p.offsetPercent.length === 2 && p.offsetPercent.every((v) => finite(v, 1e4)))
    )
      return [issue("invalid-reference", "offsetPercent needs two values within ±10000.")];
    if (p.scale !== undefined && !(finite(p.scale) && p.scale >= 0.05 && p.scale <= 8))
      return [issue("invalid-reference", "scale must be 0.05–8.")];
    if (p.rotationDegrees !== undefined && !(finite(p.rotationDegrees) && Math.abs(p.rotationDegrees) <= 180))
      return [issue("invalid-reference", "rotationDegrees must be within ±180.")];
    if (p.blend !== undefined && !["normal", "difference", "screen", "multiply"].includes(p.blend))
      return [issue("invalid-reference", "blend must be normal, difference, screen or multiply.")];
    for (const k of ["opacity", "visible", "offsetPercent", "scale", "rotationDegrees", "blend"] as const)
      if (p[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = clone(p[k]);
    s.references.perspective = next;
    return [];
  }
  const p = patch as OrthoReferencePatch;
  const [ua, va] = axisNames(view);
  const changedImage = !current || current.image !== image;
  const placement = changedImage && !p.min && !p.size ? fitReferencePlacement(s, view, size) : null;
  const next: OrthoReference = {
    image,
    opacity: (current as OrthoReference | null)?.opacity ?? 0.35,
    visible: (current as OrthoReference | null)?.visible ?? true,
    min: placement?.min ?? (current as OrthoReference | null)?.min ?? fitReferencePlacement(s, view, size).min,
    size: placement?.size ?? (current as OrthoReference | null)?.size ?? fitReferencePlacement(s, view, size).size,
  };
  if (p.min !== undefined) {
    if (!(p.min.length === 2 && p.min.every((v) => finite(v))))
      return [issue("invalid-reference", `min needs finite ${ua} and ${va}.`)];
    next.min = [...p.min];
  }
  if (p.size !== undefined) {
    if (!(p.size.length === 2 && p.size.every((v) => finite(v) && v >= MIN_SIZE)))
      return [issue("invalid-reference", `size needs ${ua} and ${va} of at least ${MIN_SIZE} m.`)];
    next.size = [...p.size];
  }
  if (p.opacity !== undefined) next.opacity = p.opacity;
  if (p.visible !== undefined) next.visible = p.visible;
  s.references[view] = next;
  return [];
}
