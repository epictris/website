// window.orthographic: the agent API. It speaks the document's vocabulary
// ({x, y, z} objects, outline points in metres), every edit goes through the
// same core commands as the UI (one undoable step each), and every call
// returns { ok, issues } instead of throwing.

import { unwrap } from "solid-js/store";
import { addImageBytes, image } from "./assets";
import { issue, type ObjectProps, type TraceSpec } from "./core/commands";
import { compareToReference, referenceIssues } from "./core/compare";
import { geometryIssues, validateDocument } from "./core/document";
import { base64ToBytes, parseDataUrl } from "./core/images";
import type { MeshMeta } from "./core/mesher";
import * as ops from "./core/ops";
import { placements, projection } from "./core/projection";
import type { PixelSpace } from "./core/raycast";
import type {
  DocVec3,
  EditorState,
  Issue,
  ReferenceView,
  Ring,
  SceneDocument,
  SceneObject,
  ViewId,
} from "./core/types";
import { currentDocument, editorConfig, loadDocument } from "./io";
import { meshes, meshStatus, settle, shapeKey } from "./meshes";
import { orthoPng, orthoSvg, perspectiveDepth, perspectiveIds, perspectivePng, projectionSheet } from "./snapshots";
import { commit, errors, redo, setSelection, state, ui, undo } from "./store";

export interface ApiResult {
  ok: boolean;
  issues: Issue[];
  [key: string]: unknown;
}

const result = (issues: Issue[], extra: Record<string, unknown> = {}): ApiResult => ({
  ok: !errors(issues).length,
  issues,
  ...extra,
});
const bad = (code: string, message: string) => result([issue(code, message)]);

/** Guard every entry point: an unexpected exception becomes an issue, not a thrown error. */
function safe<A extends unknown[]>(f: (...args: A) => ApiResult | Promise<ApiResult>) {
  return async (...args: A): Promise<ApiResult> => {
    try {
      return await f(...args);
    } catch (e) {
      return bad("internal-error", (e as Error).message || String(e));
    }
  };
}

/** Commit an op as one undoable step and report its values when it applied. */
function edit(op: (d: EditorState) => ops.OpResult) {
  let out: ops.OpResult | undefined;
  const issues = commit((d) => {
    out = op(d);
    return out.issues;
  });
  return result(issues, errors(issues).length ? {} : (out?.value ?? {}));
}

const meshOf = (e: SceneObject) => meshes.get(e.id);
const referenceImage = () => {
  const ref = state.references.perspective;
  return ref ? image(ref.image) : undefined;
};

const queryContext = (): ops.QueryContext => ({ meshOf, referenceImage: referenceImage() });

const metaFor = (id: string): MeshMeta | undefined => {
  const e = state.objects.find((o) => o.id === id);
  const s = meshStatus[id];
  return e && s && s.key === shapeKey(e) ? s.meta : undefined;
};

export const api = {
  version: 1,
  schema: "https://3d.tris.sh/orthographic/schema.json",
  guide: "https://3d.tris.sh/orthographic/llms.txt",

  /** The scene as a document. images: "metadata" (default), "data" or "none". */
  getDocument(
    opts: { images?: "data" | "metadata" | "none"; derived?: boolean; editor?: boolean } = {},
  ): SceneDocument {
    return currentDocument({
      images: opts.images ?? "metadata",
      derived: opts.derived,
      editor: opts.editor ? editorConfig() : undefined,
    });
  },

  /** Replace the scene with a document (one undoable step). Nothing changes when an issue is an error. */
  loadDocument: safe(async (doc: unknown) => {
    const issues = await loadDocument(doc);
    return result(issues);
  }),

  /**
   * Check a document without loading it, or (no argument) the current scene.
   * Includes geometry: outlines that share no volume or clip each other.
   */
  validate: safe(async (doc?: unknown) => {
    if (doc !== undefined) {
      const v = validateDocument(doc, { known: (id) => image(id) });
      return result(v.issues);
    }
    await settle();
    const s = unwrap(state) as EditorState;
    return result([...geometryIssues(s, metaFor), ...referenceIssues(s, meshOf, referenceImage())]);
  }),

  /**
   * Score every traced object (or those in ids) against the perspective
   * reference: spill, missing, iou and order per object, the issues validate
   * reports, and with diff a picture (correct grey, spill red, missing blue).
   */
  compareToReference: safe(async (opts: { ids?: string[]; diff?: boolean } = {}) => {
    await settle();
    const s = unwrap(state) as EditorState;
    const image = referenceImage();
    if (!s.references.perspective || !image)
      return bad("no-reference", "The scene has no perspective reference image to compare with.");
    const c = compareToReference(s, meshOf, image, opts);
    if (!c) return bad("nothing-to-compare", "No visible object has a trace.");
    const extra: Record<string, unknown> = { frame: { width: c.width, height: c.height }, objects: c.objects };
    if (c.diff) {
      const canvas = document.createElement("canvas");
      canvas.width = c.width;
      canvas.height = c.height;
      canvas.getContext("2d")!.putImageData(new ImageData(c.diff, c.width, c.height), 0, 0);
      extra.images = { diff: canvas.toDataURL("image/png") };
    }
    return result(c.issues, extra);
  }),

  /** Add an image from base64 (or a data: URL). Its id is derived from the bytes. */
  addImage: safe(async (spec: { data: string; name?: string }) => {
    const parsed = spec.data.startsWith("data:") ? parseDataUrl(spec.data) : { data: spec.data };
    if (!parsed) return bad("invalid-image", "data must be base64 or a base64 data: URL.");
    const a = await addImageBytes(base64ToBytes(parsed.data), spec.name ?? "image");
    return result([], { id: a.id, width: a.width, height: a.height });
  }),

  addObject: safe((spec: ops.AddObjectArgs) => edit((d) => ops.addObject(d, spec))),

  /** Add several objects as one undoable step; none is added when any has an error. */
  addObjects: safe((specs: ops.AddObjectArgs[]) => edit((d) => ops.addObjects(d, specs))),

  updateObject: safe((id: string, patch: ObjectProps) => edit((d) => ops.updateObject(d, id, patch))),

  /** Record (or with null remove) the silhouette traced in the perspective reference: image pixels, hidden runs optional. */
  setTrace: safe((id: string, trace: TraceSpec | null) => edit((d) => ops.setTrace(d, id, trace))),

  /** Replace all three outlines (of `part`, for an object of several) at once in metres, as one step. */
  setOutlines: safe((id: string, outlines: Record<ViewId, Ring>, part?: number) =>
    edit((d) => ops.setOutlines(d, id, outlines, part)),
  ),

  /** Add objects, or change existing ones by id keeping their other properties; all or nothing. */
  upsertObjects: safe((specs: ops.AddObjectArgs[]) => edit((d) => ops.upsertObjects(d, specs))),

  /**
   * Fit the front outline to the object's trace, keeping its (or the given)
   * top and side, and apply all three: { top?, side?, restOn?, trim?, maxPoints? }.
   */
  fitFront: safe(async (id: string, opts: ops.FitArgs = {}) => {
    await settle();
    return edit((d) => ops.fitFront(d, id, opts, { image }));
  }),

  /** Plain box outlines from the trace between two depths (world y): a starting point for fitFront. */
  suggestViews: safe((id: string, depth: { min: number; max: number }) =>
    edit((d) => ops.suggestViews(d, id, depth, { image })),
  ),

  /** Replace one view's outline (of `part`, from 0): points in metres, [x, z] front, [x, y] top, [y, z] side. */
  setOutline: safe((id: string, view: ViewId, points: Ring, part?: number) =>
    edit((d) => ops.setOutline(d, id, view, points, part ?? 0)),
  ),

  /** Set the bounding box of one object or a group: any of min / max per axis. Outlines scale with it. */
  setBounds: safe((ids: string | string[], box: ops.BoundsArgs) => edit((d) => ops.setBounds(d, ids, box))),

  moveObjects: safe((ids: string | string[], delta: DocVec3) => edit((d) => ops.moveObjects(d, ids, delta))),

  deleteObjects: safe((ids: string | string[]) => edit((d) => ops.deleteObjects(d, ids))),

  duplicateObjects: safe((ids: string | string[], offset?: DocVec3) =>
    edit((d) => ops.duplicateObjects(d, ids, offset)),
  ),

  setScene: safe((patch: ops.SceneArgs) => edit((d) => ops.setScene(d, patch))),

  /** Scale the whole scene about the origin (objects, frame, reference placements, camera); scale.basis records why. */
  rescaleScene: safe((factor: number, scale?: { basis?: string }) => edit((d) => ops.rescaleScene(d, factor, scale))),

  /** Camera fields as in the document; give the lens as verticalFovDegrees or focalLengthMm35Equivalent. */
  setCamera: safe((patch: ops.CameraArgs) => edit((d) => ops.setCamera(d, patch))),

  setDisplay: safe((patch: ops.DisplayArgs) => edit((d) => ops.setDisplay(d, patch))),

  /**
   * Set (or with null remove) a view's reference, as in the document: front /
   * top / side take min and size on the view plane ({x, z} for front); a new
   * image without them is fitted to the scene frame. perspective takes
   * offsetPercent {x, y}, scale, rotationDegrees and blend.
   */
  setReference: safe((view: ReferenceView, patch: ops.ReferenceArgs | null) =>
    edit((d) => ops.setReference(d, view, patch, { image })),
  ),

  select: (ids: string[]) => {
    setSelection(ids);
    return result([], { selected: [...ui.selected] });
  },

  undo: () => result([], { undone: undo() }),
  redo: () => result([], { redone: redo() }),

  /** Resolves once every object's 3D solid matches its outlines. */
  waitForGeometry: safe(async () => {
    await settle();
    return result([]);
  }),

  /**
   * Pictures for checking the scene against its references, or for making
   * reference views from. Orthographic views share one scale (pixelsPerMeter,
   * or the largest round scale at which every view fits width x height) and
   * cover the scene frame and every object, so views sharing an axis line up;
   * placements says where each picture lies in metres. Perspective uses the
   * camera frame. Returns PNG data: URLs (or SVG markup with format "svg" for
   * orthographic views).
   */
  render: safe(
    async (
      opts: {
        views?: ReferenceView[];
        width?: number;
        height?: number;
        pixelsPerMeter?: number;
        references?: boolean;
        labels?: boolean;
        grid?: boolean;
        format?: "png" | "svg";
        mode?: "shaded" | "ids" | "depth";
        outlines?: "all" | "silhouette";
        referenceOpacity?: number;
      } = {},
    ) => {
      const views = opts.views ?? ["front", "top", "side", "perspective"];
      const unknown = views.find((v) => v !== "perspective" && !ops.isView(v));
      if (unknown) return bad("invalid-view", `Unknown view "${unknown}".`);
      if (opts.mode !== undefined && !["shaded", "ids", "depth"].includes(opts.mode))
        return bad("invalid-mode", 'mode must be "shaded", "ids" or "depth".');
      if (opts.outlines !== undefined && !["all", "silhouette"].includes(opts.outlines))
        return bad("invalid-outlines", 'outlines must be "all" or "silhouette".');
      if (
        opts.referenceOpacity !== undefined &&
        !(Number.isFinite(opts.referenceOpacity) && opts.referenceOpacity >= 0 && opts.referenceOpacity <= 1)
      )
        return bad("invalid-reference", "referenceOpacity must be from 0 to 1.");
      if (opts.pixelsPerMeter !== undefined && !(Number.isFinite(opts.pixelsPerMeter) && opts.pixelsPerMeter > 0))
        return bad("invalid-scale", "pixelsPerMeter must be a positive number.");
      await settle();
      const ortho = views.filter(ops.isView);
      const p = ortho.length ? projection(unwrap(state) as EditorState, opts) : undefined;
      if (typeof p === "string") return bad("render-too-large", p);
      const images: Record<string, string> = {};
      const extra: Record<string, unknown> = {};
      for (const v of views) {
        if (v !== "perspective")
          images[v] = opts.format === "svg" ? orthoSvg(v, p!, opts) : await orthoPng(v, p!, opts);
        else if (opts.mode === "ids") {
          const out = await perspectiveIds({ width: opts.width });
          images[v] = out.png;
          extra.legend = out.legend;
        } else if (opts.mode === "depth") {
          const out = await perspectiveDepth({ width: opts.width });
          images[v] = out.png;
          extra.depthRange = out.depthRange;
        } else
          images[v] = await perspectivePng({
            width: opts.width,
            references: opts.references,
            referenceOpacity: opts.referenceOpacity,
            outlines: opts.outlines,
          });
      }
      return result([], {
        images,
        ...extra,
        ...(p && { pixelsPerMeter: p.pixelsPerMeter, placements: placements(p, ortho) }),
      });
    },
  ),

  /** What each pixel sees ([u, v] in the frame's pixels, or the reference image's with space "reference"). */
  raycast: safe(async (points: [number, number][], space: PixelSpace = "frame") => {
    await settle();
    const r = ops.raycastPoints(unwrap(state) as EditorState, points, space, queryContext());
    return result(r.issues, r.value);
  }),

  /** The length in metres between two pixels, both ends at an object's depth, a depth, or "surface". */
  measure: safe(
    async (args: { from: [number, number]; to: [number, number]; space?: PixelSpace; at: string | number }) => {
      await settle();
      const r = ops.measure(unwrap(state) as EditorState, args, queryContext());
      return result(r.issues, r.value);
    },
  ),

  /** The three views on one SVG drawing sheet, with the scene document in its metadata. */
  sheet: safe(async () => {
    await settle();
    return result([], { svg: projectionSheet(currentDocument({ images: "metadata" })) });
  }),
};

declare global {
  interface Window {
    orthographic: typeof api;
  }
}

export function installApi() {
  window.orthographic = api;
}
