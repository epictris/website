// Scene edits in the document's vocabulary ({x, y, z} objects, world-unit
// outline points, views by name), translated to the core commands. The page
// API (window.orthographic) and the server's tools (HTTP and MCP) both call
// these, so an edit means the same thing wherever it comes from.
//
// Each op mutates a draft state and returns its issues plus any values to
// report (the id of a new object, say); the caller commits the draft only when
// no issue is an error.

import { focalToFov } from "./camera";
import * as cmd from "./commands";
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
  metersPerUnit?: number | null;
  notes?: string;
}

export interface CameraArgs {
  position?: DocVec3;
  target?: DocVec3;
  verticalFovDegrees?: number;
  focalLengthMm35Equivalent?: number;
  rollDegrees?: number;
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
  return { issues: r.issues, value: { id: r.id }, touched: r.id ? [r.id] : [] };
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
    const r = addObject(d, spec);
    for (const found of r.issues) issues.push({ ...found, path: `/objects/${i}${found.path}` });
    if (r.value?.id) ids.push(r.value.id as string);
  });
  return { issues, value: { ids }, touched: ids };
}

export function updateObject(d: EditorState, id: string, patch: cmd.ObjectProps): OpResult {
  return { issues: cmd.updateObject(d, id, patch), touched: [id] };
}

/** Replace one view's outline: points in world units, [x, z] front, [x, y] top, [y, z] side. */
export function setOutline(d: EditorState, id: string, view: ViewId, points: Ring): OpResult {
  if (!isView(view)) return bad("invalid-view", 'view must be "front", "top" or "side".');
  return { issues: cmd.setOutline(d, id, view, points), touched: [id] };
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
  return { issues: cmd.setScene(d, { ...patch, size: vec3(patch.size) }) };
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
