// window.orthographic: the agent API. It speaks the document's vocabulary
// ({x, y, z} objects, world-unit outline points), every edit goes through the
// same core commands as the UI (one undoable step each), and every call
// returns { ok, issues } instead of throwing.

import { unwrap } from "solid-js/store";
import { addImageBytes, image } from "./assets";
import { issue, type ObjectProps } from "./core/commands";
import { geometryIssues, validateDocument } from "./core/document";
import { base64ToBytes, parseDataUrl } from "./core/images";
import type { MeshMeta } from "./core/mesher";
import * as ops from "./core/ops";
import type { DocVec3, EditorState, Issue, ReferenceView, Ring, SceneDocument, ViewId } from "./core/types";
import { currentDocument, editorConfig, loadDocument } from "./io";
import { meshStatus, settle, shapeKey } from "./meshes";
import { orthoPng, orthoSvg, perspectivePng, projectionSheet } from "./snapshots";
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
    return result(geometryIssues(unwrap(state) as EditorState, metaFor));
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

  /** Replace one view's outline: points in world units, [x, z] front, [x, y] top, [y, z] side. */
  setOutline: safe((id: string, view: ViewId, points: Ring) => edit((d) => ops.setOutline(d, id, view, points))),

  /** Set the bounding box of one object or a group: any of min / max per axis. Outlines scale with it. */
  setBounds: safe((ids: string | string[], box: ops.BoundsArgs) => edit((d) => ops.setBounds(d, ids, box))),

  moveObjects: safe((ids: string | string[], delta: DocVec3) => edit((d) => ops.moveObjects(d, ids, delta))),

  deleteObjects: safe((ids: string | string[]) => edit((d) => ops.deleteObjects(d, ids))),

  duplicateObjects: safe((ids: string | string[], offset?: DocVec3) =>
    edit((d) => ops.duplicateObjects(d, ids, offset)),
  ),

  setScene: safe((patch: ops.SceneArgs) => edit((d) => ops.setScene(d, patch))),

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
   * Pictures for checking the scene against its references. Orthographic views
   * are fitted to the scene; perspective uses the camera frame. Returns
   * PNG data: URLs (or SVG markup with format "svg" for orthographic views).
   */
  render: safe(
    async (
      opts: {
        views?: ReferenceView[];
        width?: number;
        height?: number;
        references?: boolean;
        labels?: boolean;
        grid?: boolean;
        format?: "png" | "svg";
      } = {},
    ) => {
      const views = opts.views ?? ["front", "top", "side", "perspective"];
      await settle();
      const images: Record<string, string> = {};
      for (const v of views) {
        if (v === "perspective") images[v] = await perspectivePng({ width: opts.width, references: opts.references });
        else if (ops.isView(v)) images[v] = opts.format === "svg" ? orthoSvg(v, opts) : await orthoPng(v, opts);
        else return bad("invalid-view", `Unknown view "${v}".`);
      }
      return result([], { images });
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
