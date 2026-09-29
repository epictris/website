// Scene edits in the document's vocabulary ({x, y, z} objects, outline points
// in metres, views by name), translated to the core commands. The page
// API (window.orthographic) and the server's tools (HTTP and MCP) both call
// these, so an edit means the same thing wherever it comes from.
//
// Each op mutates a draft state and returns its issues plus any values to
// report (the id of a new object, say); the caller commits the draft only when
// no issue is an error.

import { focalToFov } from "./camera";
import * as cmd from "./commands";
import { FitError, fitFront as fitFrontOutline, suggestViews as suggestPrisms } from "./fit";
import { framePixel, hitAt, type MeshOf, type PixelSpace, pointAtDepth } from "./raycast";
import type { Primitive } from "./ring";
import type {
  Blend,
  DisplayStyle,
  DocVec3,
  EditorState,
  Issue,
  Point,
  ReferenceView,
  Ring,
  SceneObject,
  Vec3,
  ViewId,
} from "./types";
import { axisNames, VIEW_IDS } from "./views";

export interface OpResult {
  issues: Issue[];
  /** Values to report once the edit is committed. */
  value?: Record<string, unknown>;
  /** Objects the edit created or changed, for callers that report them back. */
  touched?: string[];
}

export interface OpContext {
  /** Pixel size of an image the scene can use, or undefined when there is no such image. */
  image: (id: string) => cmd.ImageSize | undefined;
}

type Ids = string | string[];

export interface AddObjectArgs extends cmd.ObjectProps {
  id?: string;
  outlines?: Record<ViewId, Ring>;
  /** Instead of outlines: the object as a union of parts. */
  parts?: { id?: string; outlines: Record<ViewId, Ring> }[];
  primitive?: Primitive;
  center?: DocVec3;
  size?: DocVec3;
}

export interface BoundsArgs {
  min?: Partial<DocVec3>;
  max?: Partial<DocVec3>;
}

export interface SceneArgs {
  title?: string;
  size?: DocVec3;
  scale?: { basis?: string };
  notes?: string;
}

export interface CameraArgs {
  position?: DocVec3;
  target?: DocVec3;
  verticalFovDegrees?: number;
  focalLengthMm35Equivalent?: number;
  rollDegrees?: number;
  shift?: { x: number; y: number };
  near?: number;
  far?: number;
  frame?: { width: number; height: number };
  locked?: boolean;
}

export interface DisplayArgs {
  style?: DisplayStyle;
  grid?: boolean;
  labels?: boolean;
  crosshair?: boolean;
}

export interface ReferenceArgs {
  image?: string;
  opacity?: number;
  visible?: boolean;
  /** front / top / side: lower-left corner and size on the view plane, named by the view's axes. */
  min?: Record<string, number>;
  size?: Record<string, number>;
  /** perspective only. */
  offsetPercent?: { x: number; y: number };
  scale?: number;
  rotationDegrees?: number;
  blend?: Blend;
}

const bad = (code: string, message: string): OpResult => ({ issues: [cmd.issue(code, message)] });
const list = (ids: Ids) => (Array.isArray(ids) ? ids : [ids]);
const vec3 = (v: DocVec3 | undefined): Vec3 | undefined => (v ? [v.x, v.y, v.z] : undefined);
const partial = (v: Partial<DocVec3> | undefined) => (v ? ([v.x, v.y, v.z] as Partial<Vec3>) : undefined);
export const isView = (v: unknown): v is ViewId => VIEW_IDS.includes(v as ViewId);
const pairOf = (view: ViewId, o: Record<string, number> | undefined): Point | undefined => {
  if (!o) return undefined;
  const [a, b] = axisNames(view);
  return [o[a], o[b]];
};

export function addObject(d: EditorState, spec: AddObjectArgs): OpResult {
  const r = cmd.addObject(d, { ...spec, center: vec3(spec.center), size: vec3(spec.size) });
  const issues = [...r.issues, ...(r.id ? cmd.inFrontOfIssues(d, new Set([r.id])) : [])];
  return { issues, value: { id: r.id }, touched: r.id ? [r.id] : [] };
}

/**
 * Add several objects as one edit. Every object is checked and every problem
 * reported (paths start at /objects/<index> of the list); the caller keeps
 * none of them unless none has an error.
 */
export function addObjects(d: EditorState, specs: AddObjectArgs[]): OpResult {
  const issues: Issue[] = [];
  const ids: string[] = [];
  specs.forEach((spec, i) => {
    const r = cmd.addObject(d, { ...spec, center: vec3(spec.center), size: vec3(spec.size) });
    for (const found of r.issues) issues.push({ ...found, path: `/objects/${i}${found.path}` });
    if (r.id) ids.push(r.id);
  });
  // Objects in the batch may stand in front of one another, so references are checked once all are in.
  for (const found of cmd.inFrontOfIssues(d, new Set(ids)))
    issues.push({ ...found, path: found.path.replace(/^\/objects\/\d+/, `/objects/${ids.indexOf(found.objectId!)}`) });
  return { issues, value: { ids }, touched: ids };
}

export function updateObject(d: EditorState, id: string, patch: cmd.ObjectProps): OpResult {
  const issues = cmd.updateObject(d, id, patch);
  if (issues.length) return { issues, touched: [id] };
  // inFrontOf must name objects in the scene; paths are relative to the object, as for its other properties.
  const refs = cmd
    .inFrontOfIssues(d, new Set([id]))
    .map((i) => ({ ...i, path: i.path.replace(/^\/objects\/\d+/, "") }));
  return { issues: refs, touched: [id] };
}

/** Set (or with null remove) the silhouette traced in the perspective reference, in its image's pixels. */
export function setTrace(d: EditorState, id: string, trace: cmd.TraceSpec | null): OpResult {
  return { issues: cmd.updateObject(d, id, { trace }), touched: [id] };
}

export interface FitArgs {
  /** For an object of several parts: the part to fit (counted from 0). */
  part?: number;
  /** Top [x, y] and side [y, z] outlines to fit with, in metres (default: the object's own). */
  top?: Ring;
  side?: Ring;
  /** Ids of objects the fitted solid rests on and must not enter. */
  restOn?: string[];
  /** Replace the top and side by the fitted solid's own shadows (default true). */
  trim?: boolean;
  maxPoints?: number;
}

/** The perspective reference image's size, or an issue saying why there is none. */
function referenceImage(d: EditorState, ctx: OpContext): cmd.ImageSize | OpResult {
  const ref = d.references.perspective;
  const image = ref && ctx.image(ref.image);
  return image ?? bad("no-reference", "The scene has no perspective reference image: traces are in its pixels.");
}

/** Run a fit and apply its outlines, turning its failures into issues. */
function fitting(
  d: EditorState,
  id: string,
  f: () => { outlines: Record<ViewId, Ring>; extra?: Record<string, unknown> },
  part?: number,
): OpResult {
  let fit: ReturnType<typeof f>;
  try {
    fit = f();
  } catch (e) {
    if (e instanceof FitError) return { issues: [cmd.issue(e.code, e.message, { objectId: id })] };
    throw e;
  }
  const issues = cmd.setOutlines(d, id, fit.outlines, part);
  const tidy = (v: number) => Math.round(v * 1e9) / 1e9;
  const outlines = Object.fromEntries(VIEW_IDS.map((v) => [v, fit.outlines[v].map((p) => p.map(tidy))]));
  return { issues, value: { outlines, ...fit.extra }, touched: [id] };
}

/**
 * Fit the front outline to the object's trace, keeping its (or the given) top
 * and side views, and apply all three outlines as one step. See core/fit.ts.
 */
export function fitFront(d: EditorState, id: string, args: FitArgs, ctx: OpContext): OpResult {
  const e = d.objects.find((o) => o.id === id);
  if (!e) return { issues: [cmd.issue("unknown-object", `There is no object with id "${id}".`, { objectId: id })] };
  const image = referenceImage(d, ctx);
  if ("issues" in image) return image;
  if (args.part === undefined && e.parts.length > 1)
    return bad("part-required", `${id} has ${e.parts.length} parts: say which part to fit.`);
  const part = args.part ?? 0;
  if (!e.parts[part]) return bad("unknown-part", `${id} has no part ${part} (parts count from 0).`);
  const restOn: SceneObject[] = [];
  for (const other of args.restOn ?? []) {
    const q = d.objects.find((o) => o.id === other);
    if (!q) return bad("unknown-object", `restOn names "${other}", which is not in the scene.`);
    restOn.push(q);
  }
  return fitting(
    d,
    id,
    () => {
      const r = fitFrontOutline(d, e, image, { ...args, part, restOn });
      return { outlines: r.outlines, extra: { cell: r.cell } };
    },
    part,
  );
}

/** Plain prisms from the trace between two depths (y, metres): a starting point for fitFront. */
export function suggestViews(
  d: EditorState,
  id: string,
  depth: { min: number; max: number },
  ctx: OpContext,
): OpResult {
  const e = d.objects.find((o) => o.id === id);
  if (!e) return { issues: [cmd.issue("unknown-object", `There is no object with id "${id}".`, { objectId: id })] };
  const image = referenceImage(d, ctx);
  if ("issues" in image) return image;
  // An object of several parts becomes one plain box: a fresh start.
  return fitting(d, id, () => {
    const outlines = suggestPrisms(d, e, image, depth.min, depth.max);
    if (e.parts.length > 1) cmd.setParts(d, id, [{ outlines }]);
    return { outlines };
  });
}

/** Replace all three outlines of an object at once (metres), as one step; the box follows the three together. */
export function setOutlines(d: EditorState, id: string, outlines: Record<ViewId, Ring>, part?: number): OpResult {
  if (!outlines || !VIEW_IDS.every((v) => outlines[v]))
    return bad("missing-argument", "Give outlines with front, top and side.");
  return { issues: cmd.setOutlines(d, id, outlines, part), touched: [id] };
}

/**
 * Add or change objects by id, as one edit. A new id is added (outlines or a
 * primitive required); an existing object gets the given properties and
 * keeps the rest (outlines, or parts, replace its whole shape; trace: null
 * removes the trace). All or nothing; problems are reported under /objects/<index>.
 */
export function upsertObjects(d: EditorState, specs: AddObjectArgs[]): OpResult {
  const issues: Issue[] = [];
  const added: string[] = [];
  const changed: string[] = [];
  const indexOf = new Map<string, number>();
  specs.forEach((spec, i) => {
    const at = (list: Issue[]) => {
      for (const found of list) issues.push({ ...found, path: `/objects/${i}${found.path}` });
    };
    const existing = spec.id !== undefined && d.objects.some((e) => e.id === spec.id);
    if (!existing) {
      const r = cmd.addObject(d, { ...spec, center: vec3(spec.center), size: vec3(spec.size) });
      at(r.issues);
      if (r.id) {
        added.push(r.id);
        indexOf.set(r.id, i);
      }
      return;
    }
    const id = spec.id!;
    if (spec.primitive !== undefined || spec.center !== undefined || spec.size !== undefined) {
      at([cmd.issue("invalid-argument", `${id} exists: give it outlines, not a primitive, center or size.`)]);
      return;
    }
    const { id: _, outlines, parts, primitive: __, center: ___, size: ____, ...props } = spec;
    // Unlock first, so an object can be unlocked and changed in one step; lock last.
    const { locked, ...rest } = props;
    if (locked === false) at(cmd.updateObject(d, id, { locked }));
    if (outlines && parts) at([cmd.issue("invalid-shape", "Give outlines or parts, not both.")]);
    else if (outlines) at(cmd.setParts(d, id, [{ outlines }]));
    else if (parts) at(cmd.setParts(d, id, parts));
    if (Object.keys(rest).length) at(cmd.updateObject(d, id, rest));
    if (locked === true) at(cmd.updateObject(d, id, { locked }));
    changed.push(id);
    indexOf.set(id, i);
  });
  const touched = [...added, ...changed];
  for (const found of cmd.inFrontOfIssues(d, new Set(touched)))
    issues.push({
      ...found,
      path: found.path.replace(/^\/objects\/\d+/, `/objects/${indexOf.get(found.objectId!)}`),
    });
  return { issues, value: { added, changed }, touched };
}

/** Replace one view's outline: points in metres, [x, z] front, [x, y] top, [y, z] side. */
export function setOutline(d: EditorState, id: string, view: ViewId, points: Ring, part = 0): OpResult {
  if (!isView(view)) return bad("invalid-view", 'view must be "front", "top" or "side".');
  return { issues: cmd.setOutline(d, id, view, points, part), touched: [id] };
}

/** Set the bounding box of one object or a group: any of min / max per axis. Outlines scale with it. */
export function setBounds(d: EditorState, ids: Ids, box: BoundsArgs): OpResult {
  return { issues: cmd.setBounds(d, list(ids), { min: partial(box.min), max: partial(box.max) }), touched: list(ids) };
}

export function moveObjects(d: EditorState, ids: Ids, delta: DocVec3): OpResult {
  if (!delta) return bad("invalid-offset", "Give the offset as {x, y, z}.");
  return { issues: cmd.moveObjects(d, list(ids), vec3(delta)!), touched: list(ids) };
}

export function deleteObjects(d: EditorState, ids: Ids): OpResult {
  return { issues: cmd.deleteObjects(d, list(ids)) };
}

export function duplicateObjects(d: EditorState, ids: Ids, offset?: DocVec3): OpResult {
  const r = cmd.duplicateObjects(d, list(ids), vec3(offset));
  return { issues: r.issues, value: { ids: r.ids }, touched: r.ids };
}

export function setScene(d: EditorState, patch: SceneArgs): OpResult {
  const { scale, ...rest } = patch;
  return { issues: cmd.setScene(d, { ...rest, size: vec3(patch.size), scaleBasis: scale?.basis }) };
}

/**
 * Scale the whole scene by a factor about the origin (objects, frame,
 * reference placement, camera), optionally recording the new scale basis in
 * the same step.
 */
export function rescaleScene(d: EditorState, factor: number, scale?: { basis?: string }): OpResult {
  const issues = cmd.rescaleScene(d, factor);
  if (issues.length || scale?.basis === undefined) return { issues };
  return { issues: cmd.setScene(d, { scaleBasis: scale.basis }) };
}

/** Camera fields as in the document; the lens as verticalFovDegrees or focalLengthMm35Equivalent. */
export function setCamera(d: EditorState, patch: CameraArgs): OpResult {
  if (patch.verticalFovDegrees !== undefined && patch.focalLengthMm35Equivalent !== undefined)
    return bad("invalid-camera", "Give verticalFovDegrees or focalLengthMm35Equivalent, not both.");
  return {
    issues: cmd.setCamera(d, {
      position: vec3(patch.position),
      target: vec3(patch.target),
      fov:
        patch.focalLengthMm35Equivalent !== undefined
          ? focalToFov(patch.focalLengthMm35Equivalent)
          : patch.verticalFovDegrees,
      roll: patch.rollDegrees,
      shift: patch.shift ? [patch.shift.x, patch.shift.y] : undefined,
      near: patch.near,
      far: patch.far,
      frame: patch.frame ? [patch.frame.width, patch.frame.height] : undefined,
      locked: patch.locked,
    }),
  };
}

export function setDisplay(d: EditorState, patch: DisplayArgs): OpResult {
  return { issues: cmd.setDisplay(d, patch) };
}

/**
 * Set (or with null remove) a view's reference, as in the document: front /
 * top / side take min and size on the view plane ({x, z} for front); a new
 * image without them is fitted to the scene frame. perspective takes
 * offsetPercent {x, y}, scale, rotationDegrees and blend.
 */
export function setReference(d: EditorState, view: ReferenceView, patch: ReferenceArgs | null, ctx: OpContext) {
  if (view !== "perspective" && !isView(view))
    return bad("invalid-view", 'view must be "front", "top", "side" or "perspective".');
  if (patch === null) return { issues: cmd.setReference(d, view, null, ctx.image) };
  const p =
    view === "perspective"
      ? {
          ...patch,
          offsetPercent: patch.offsetPercent ? ([patch.offsetPercent.x, patch.offsetPercent.y] as Point) : undefined,
        }
      : { ...patch, min: pairOf(view, patch.min), size: pairOf(view, patch.size) };
  return { issues: cmd.setReference(d, view, p as never, ctx.image) };
}

// ---- Queries (change nothing) ----------------------------------------------------------------

const docVec = (v: Vec3): DocVec3 => ({
  x: Math.round(v[0] * 1e6) / 1e6,
  y: Math.round(v[1] * 1e6) / 1e6,
  z: Math.round(v[2] * 1e6) / 1e6,
});
const metres = (v: number) => Math.round(v * 1e6) / 1e6;

export interface QueryContext {
  meshOf: MeshOf;
  /** The perspective reference image's pixel size, when there is one. */
  referenceImage?: cmd.ImageSize;
}

/** Pixels as frame points, or an issue naming the first that cannot be placed. */
function framePoints(d: EditorState, points: Point[], space: PixelSpace, ctx: QueryContext): Point[] | OpResult {
  if (space !== "frame" && space !== "reference") return bad("invalid-space", 'space must be "frame" or "reference".');
  const out: Point[] = [];
  for (const p of points) {
    if (!(Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(v))))
      return bad("invalid-point", "Points are [u, v] pixel pairs.");
    const q = framePixel(d, p, space, ctx.referenceImage);
    if (!q) return bad("no-reference", "reference pixels need a perspective reference image.");
    out.push(q);
  }
  return out;
}

/**
 * What each pixel sees: the object hit, the world point (metres), the
 * surface normal, the distance from the camera and the depth along its view
 * axis; null where nothing is hit.
 */
export function raycastPoints(d: EditorState, points: Point[], space: PixelSpace, ctx: QueryContext): OpResult {
  const frame = framePoints(d, points, space, ctx);
  if (!Array.isArray(frame)) return frame;
  const hits = frame.map((p) => {
    const h = hitAt(d, ctx.meshOf, p);
    return h
      ? {
          id: h.id,
          point: docVec(h.point),
          normal: docVec(h.normal),
          distance: metres(h.distance),
          depth: metres(h.depth),
        }
      : null;
  });
  return { issues: [], value: { hits } };
}

/**
 * The length in metres between two pixels. `at` places both ends: an object
 * id (both at the depth along the view axis where that object's surface is at
 * `from`), a depth in metres, or "surface" (each end where its ray meets the
 * nearest surface).
 */
export function measure(
  d: EditorState,
  args: { from: Point; to: Point; space?: PixelSpace; at: string | number },
  ctx: QueryContext,
): OpResult {
  const frame = framePoints(d, [args.from, args.to], args.space ?? "frame", ctx);
  if (!Array.isArray(frame)) return frame;
  const [from, to] = frame;
  let a: Vec3;
  let b: Vec3;
  let depth: number | undefined;
  if (args.at === "surface") {
    const [ha, hb] = [hitAt(d, ctx.meshOf, from), hitAt(d, ctx.meshOf, to)];
    if (!ha || !hb) return bad("no-hit", `The ${ha ? "to" : "from"} pixel meets no surface.`);
    [a, b] = [ha.point, hb.point];
  } else {
    if (typeof args.at === "number") {
      if (!(Number.isFinite(args.at) && args.at > 0))
        return bad("invalid-depth", "A depth must be a positive number of metres.");
      depth = args.at;
    } else {
      const e = d.objects.find((o) => o.id === args.at);
      if (!e) return bad("unknown-object", `There is no object with id "${args.at}".`);
      const h = hitAt(d, ctx.meshOf, from, [e]);
      if (!h) return bad("no-hit", `The from pixel does not meet ${e.id}'s surface.`);
      depth = h.depth;
    }
    [a, b] = [pointAtDepth(d, from, depth), pointAtDepth(d, to, depth)];
  }
  return {
    issues: [],
    value: {
      length: metres(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])),
      from: docVec(a),
      to: docVec(b),
      ...(depth !== undefined && { depth: metres(depth) }),
    },
  };
}
