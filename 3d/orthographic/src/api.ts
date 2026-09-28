// window.orthographic: the agent API. It speaks the document's vocabulary
// ({x, y, z} objects, world-unit outline points), every edit goes through the
// same core commands as the UI (one undoable step each), and every call
// returns { ok, issues } instead of throwing.

import { unwrap } from "solid-js/store";
import { addImageBytes, image } from "./assets";
import { focalToFov } from "./core/camera";
import * as cmd from "./core/commands";
import { geometryIssues, validateDocument } from "./core/document";
import { base64ToBytes, parseDataUrl } from "./core/images";
import type { MeshMeta } from "./core/mesher";
import type {
  Blend,
  DisplayStyle,
  DocVec3,
  EditorState,
  Issue,
  Point,
  ReferenceView,
  Ring,
  SceneDocument,
  ViewId,
} from "./core/types";
import { axisNames, VIEW_IDS } from "./core/views";
import { currentDocument, editorConfig, loadDocument } from "./io";
import { meshStatus, settle, shapeKey } from "./meshes";
import { orthoPng, orthoSvg, perspectivePng } from "./snapshots";
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
const bad = (code: string, message: string) => result([cmd.issue(code, message)]);
const vec3 = (v: DocVec3 | undefined): [number, number, number] | undefined => (v ? [v.x, v.y, v.z] : undefined);
const isView = (v: unknown): v is ViewId => VIEW_IDS.includes(v as ViewId);
const pairOf = (view: ViewId, o: Record<string, number> | undefined): Point | undefined => {
  if (!o) return undefined;
  const [a, b] = axisNames(view);
  return [o[a], o[b]];
};

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

function edit(command: (d: EditorState) => Issue[], extra: () => Record<string, unknown> = () => ({})) {
  const issues = commit(command);
  return result(issues, errors(issues).length ? {} : extra());
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

  addObject: safe(
    (spec: {
      id?: string;
      name?: string;
      kind?: string;
      color?: string;
      outlines?: Record<ViewId, Ring>;
      primitive?: "box" | "ellipsoid" | "cylinder" | "rock";
      center?: DocVec3;
      size?: DocVec3;
      visible?: boolean;
      locked?: boolean;
      opacity?: number;
      notes?: string;
    }) => {
      let id: string | undefined;
      return edit(
        (d) => {
          const r = cmd.addObject(d, { ...spec, center: vec3(spec.center), size: vec3(spec.size) });
          id = r.id;
          return r.issues;
        },
        () => ({ id }),
      );
    },
  ),

  updateObject: safe((id: string, patch: cmd.ObjectProps) => edit((d) => cmd.updateObject(d, id, patch))),

  /** Replace one view's outline: points in world units, [x, z] front, [x, y] top, [y, z] side. */
  setOutline: safe((id: string, view: ViewId, points: Ring) => {
    if (!isView(view)) return bad("invalid-view", 'view must be "front", "top" or "side".');
    return edit((d) => cmd.setOutline(d, id, view, points));
  }),

  /** Set the bounding box of one object or a group: any of min / max per axis. Outlines scale with it. */
  setBounds: safe((ids: string | string[], box: { min?: Partial<DocVec3>; max?: Partial<DocVec3> }) => {
    const list = Array.isArray(ids) ? ids : [ids];
    const toArr = (v?: Partial<DocVec3>) => (v ? [v.x, v.y, v.z] : undefined);
    return edit((d) => cmd.setBounds(d, list, { min: toArr(box.min) as never, max: toArr(box.max) as never }));
  }),

  moveObjects: safe((ids: string | string[], delta: DocVec3) =>
    edit((d) => cmd.moveObjects(d, Array.isArray(ids) ? ids : [ids], vec3(delta)!)),
  ),

  deleteObjects: safe((ids: string | string[]) => edit((d) => cmd.deleteObjects(d, Array.isArray(ids) ? ids : [ids]))),

  duplicateObjects: safe((ids: string | string[], offset?: DocVec3) => {
    let created: string[] = [];
    return edit(
      (d) => {
        const r = cmd.duplicateObjects(d, Array.isArray(ids) ? ids : [ids], vec3(offset));
        created = r.ids;
        return r.issues;
      },
      () => ({ ids: created }),
    );
  }),

  setScene: safe((patch: { title?: string; size?: DocVec3; metersPerUnit?: number | null; notes?: string }) =>
    edit((d) => cmd.setScene(d, { ...patch, size: vec3(patch.size) })),
  ),

  /** Camera fields as in the document; give the lens as verticalFovDegrees or focalLengthMm35Equivalent. */
  setCamera: safe(
    (patch: {
      position?: DocVec3;
      target?: DocVec3;
      verticalFovDegrees?: number;
      focalLengthMm35Equivalent?: number;
      rollDegrees?: number;
      near?: number;
      far?: number;
      frame?: { width: number; height: number };
      locked?: boolean;
    }) => {
      if (patch.verticalFovDegrees !== undefined && patch.focalLengthMm35Equivalent !== undefined)
        return bad("invalid-camera", "Give verticalFovDegrees or focalLengthMm35Equivalent, not both.");
      return edit((d) =>
        cmd.setCamera(d, {
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
      );
    },
  ),

  setDisplay: safe((patch: { style?: DisplayStyle; grid?: boolean; labels?: boolean; crosshair?: boolean }) =>
    edit((d) => cmd.setDisplay(d, patch)),
  ),

  /**
   * Set (or with null remove) a view's reference, as in the document: front /
   * top / side take min and size on the view plane ({x, z} for front); a new
   * image without them is fitted to the scene frame. perspective takes
   * offsetPercent {x, y}, scale, rotationDegrees and blend.
   */
  setReference: safe(
    (
      view: ReferenceView,
      patch: {
        image?: string;
        opacity?: number;
        visible?: boolean;
        min?: Record<string, number>;
        size?: Record<string, number>;
        offsetPercent?: { x: number; y: number };
        scale?: number;
        rotationDegrees?: number;
        blend?: Blend;
      } | null,
    ) => {
      if (view !== "perspective" && !isView(view))
        return bad("invalid-view", 'view must be "front", "top", "side" or "perspective".');
      if (patch === null) return edit((d) => cmd.setReference(d, view, null, image));
      const p =
        view === "perspective"
          ? {
              ...patch,
              offsetPercent: patch.offsetPercent
                ? ([patch.offsetPercent.x, patch.offsetPercent.y] as Point)
                : undefined,
            }
          : { ...patch, min: pairOf(view, patch.min), size: pairOf(view, patch.size) };
      return edit((d) => cmd.setReference(d, view, p as never, image));
    },
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
        else if (isView(v)) images[v] = opts.format === "svg" ? orthoSvg(v, opts) : await orthoPng(v, opts);
        else return bad("invalid-view", `Unknown view "${v}".`);
      }
      return result([], { images });
    },
  ),
};

declare global {
  interface Window {
    orthographic: typeof api;
  }
}

export function installApi() {
  window.orthographic = api;
}
