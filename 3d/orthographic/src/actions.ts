// Editor operations shared by components and keyboard shortcuts. Scene edits
// go through core commands via commit(); these add selection, toasts and view
// handling around them.

import { batch } from "solid-js";
import { addImageFile, image } from "./assets";
import { fitCamera as fitPerspective, presetCamera } from "./core/camera";
import {
  addObject,
  deleteObjects,
  duplicateObjects,
  moveObjects,
  type NewObject,
  replaceCamera,
  setGroupAxis,
  setNormalizedOutline,
  setReference,
} from "./core/commands";
import { clone } from "./core/math";
import { boundsOf, sceneBounds } from "./core/model";
import { simplifyRing, toNormalized, toWorld } from "./core/ring";
import type { Point, ReferenceView, Ring, ViewId } from "./core/types";
import { VIEW_IDS, VIEWS } from "./core/views";
import { fitCamera } from "./ortho/frame";
import {
  type ActiveView,
  commit,
  obj,
  redo as redoState,
  report,
  selectedObjects,
  setActiveView,
  setMode,
  setSelection,
  setUi,
  showInspectorTab,
  state,
  toast,
  ui,
  undo as undoState,
} from "./store";

// ---- View sizing ----------------------------------------------------------------------

/** Measured pixel size of each orthographic view's drawing area. */
export const viewSizes: Record<ViewId, { W: number; H: number }> = {
  front: { W: 0, H: 0 },
  top: { W: 0, H: 0 },
  side: { W: 0, H: 0 },
};

export function fitView(view: ViewId, toSelection = false) {
  const { W, H } = viewSizes[view];
  if (W < 5 || H < 5) return;
  const box = toSelection ? boundsOf(selectedObjects()) : sceneBounds(state);
  if (!box) return;
  setUi("orthoCameras", view, { ...fitCamera(view, box, W, H), autoFit: !toSelection });
}

export function fitAll(toSelection = false) {
  if (toSelection && !ui.selected.length) {
    toast("Select an object first.");
    return;
  }
  batch(() => {
    for (const v of VIEW_IDS) fitView(v, toSelection);
  });
}

export function expandView(id: ActiveView | null) {
  const next = id === ui.focusView ? null : id;
  batch(() => {
    setUi("focusView", next);
    if (id) setActiveView(id);
  });
  requestAnimationFrame(() => {
    for (const v of VIEW_IDS) if (ui.orthoCameras[v].autoFit) fitView(v);
  });
}

// ---- History ------------------------------------------------------------------------

export function undo() {
  if (undoState()) toast("Undid the last edit.");
}

export function redo() {
  if (redoState()) toast("Redid the edit.");
}

// ---- Objects ------------------------------------------------------------------------

export function createObject(spec: NewObject): string | undefined {
  let id: string | undefined;
  const issues = commit((d) => {
    const r = addObject(d, spec);
    id = r.id;
    return r.issues;
  });
  if (!report(issues) || !id) return undefined;
  setSelection([id]);
  return id;
}

export function duplicateSelection() {
  if (!ui.selected.length) return;
  let ids: string[] = [];
  if (
    report(
      commit((d) => {
        const r = duplicateObjects(d, ui.selected);
        ids = r.ids;
        return r.issues;
      }),
    )
  ) {
    setSelection(ids);
    toast(`${ids.length} object${ids.length === 1 ? "" : "s"} duplicated.`);
  }
}

export function deleteSelection(confirmFirst = true) {
  const items = selectedObjects();
  if (!items.length) return;
  if (items.some((e) => e.locked)) {
    toast("Unlock the selection before deleting it.", true);
    return;
  }
  const what = items.length === 1 ? `${items[0].id} · ${items[0].name}` : `${items.length} selected objects`;
  if (confirmFirst && !confirm(`Delete ${what}? This can be undone.`)) return;
  if (
    report(
      commit((d) =>
        deleteObjects(
          d,
          items.map((e) => e.id),
        ),
      ),
    )
  )
    setSelection([]);
}

/** Set the selection's position (per the anchor) or dimension along one axis. */
export function applyNumeric(kind: "pos" | "size", axis: number, value: number) {
  const items = selectedObjects();
  const b = boundsOf(items);
  if (!b) return;
  const lo = b.min[axis];
  const hi = b.max[axis];
  const current = kind === "pos" ? (ui.anchor === "center" ? (lo + hi) / 2 : lo) : hi - lo;
  if (Math.abs(value - current) < 1e-10) return;
  const ids = items.map((e) => e.id);
  if (kind === "pos")
    report(commit((d) => moveObjects(d, ids, [0, 1, 2].map((a) => (a === axis ? value - current : 0)) as never)));
  else {
    const origin = ui.anchor === "center" ? (lo + hi) / 2 : lo;
    const factor = value / (hi - lo);
    report(commit((d) => setGroupAxis(d, ids, axis, origin + (lo - origin) * factor, origin + (hi - origin) * factor)));
  }
}

export function nudgeSelection(view: ViewId, key: string, large: boolean) {
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  const direction = key === "ArrowLeft" || key === "ArrowDown" ? -1 : 1;
  const p = ui.pointSelection;
  if (ui.mode === "outline" && p && ui.selected.includes(p.id)) {
    const e = obj(p.id);
    if (!e || e.locked) return;
    const step = (ui.prefs.snap ? ui.prefs.snapStep : 0.05) * (large ? 10 : 1);
    const q = toWorld(e, p.view, e.outlines[p.view][p.index]);
    q[horizontal ? 0 : 1] += step * direction;
    movePoint(p.id, p.view, p.index, q);
    return;
  }
  const items = selectedObjects();
  if (!items.length) return;
  const step = (ui.prefs.snap ? ui.prefs.snapStep : 0.1) * (large ? 10 : 1);
  const axis = VIEWS[view].axes[horizontal ? 0 : 1];
  const delta = [0, 0, 0] as [number, number, number];
  delta[axis] = step * direction;
  report(
    commit((d) =>
      moveObjects(
        d,
        items.map((e) => e.id),
        delta,
      ),
    ),
  );
}

// ---- Outline points -----------------------------------------------------------------

/** Move one outline point to a world position. */
export function movePoint(id: string, view: ViewId, index: number, world: Point): boolean {
  const e = obj(id);
  if (!e) return false;
  const raw = clone(e.outlines[view]) as Ring;
  raw[index] = toNormalized(e, view, world);
  return report(commit((d) => setNormalizedOutline(d, id, view, raw)));
}

export function insertPoint(after: number | null = null, world: Point | null = null) {
  const e = selectedObjects()[0];
  const view = ui.contourView;
  if (ui.mode !== "outline" || ui.selected.length !== 1 || !e || e.locked) return;
  const r = e.outlines[view];
  if (r.length >= 512) {
    toast("An outline has at most 512 points.", true);
    return;
  }
  const i = after ?? (ui.pointSelection?.view === view ? ui.pointSelection.index : 0);
  const q: Point = world
    ? toNormalized(e, view, world)
    : [(r[i][0] + r[(i + 1) % r.length][0]) / 2, (r[i][1] + r[(i + 1) % r.length][1]) / 2];
  const raw = clone(r) as Ring;
  raw.splice(i + 1, 0, q);
  if (report(commit((d) => setNormalizedOutline(d, e.id, view, raw))))
    setUi("pointSelection", { id: e.id, view, index: i + 1 });
}

export function deletePoint() {
  const p = ui.pointSelection;
  const e = p && obj(p.id);
  if (!p || !e || e.locked) return;
  const r = e.outlines[p.view];
  if (r.length <= 3) {
    toast("A closed outline needs at least three points.", true);
    return;
  }
  const raw = clone(r) as Ring;
  raw.splice(p.index, 1);
  const issues = commit((d) => setNormalizedOutline(d, e.id, p.view, raw));
  if (issues.length) toast("Removing that point would cross the outline. Move nearby points first.", true);
  else setUi("pointSelection", { ...p, index: Math.min(p.index, raw.length - 1) });
}

export function simplifyOutline() {
  const e = selectedObjects()[0];
  if (!e || e.locked || ui.selected.length !== 1) return;
  const view = ui.contourView;
  const { ring, removed } = simplifyRing(e.outlines[view], ui.simplifyTolerance);
  if (!removed) {
    toast("No redundant points at this tolerance.");
    return;
  }
  if (report(commit((d) => setNormalizedOutline(d, e.id, view, ring)))) {
    setUi("pointSelection", null);
    toast(`Removed ${removed} points from the ${view} outline.`);
  }
}

export function startRedraw() {
  const e = selectedObjects()[0];
  if (ui.selected.length !== 1 || !e || e.locked) return;
  setMode("outline");
  setUi("redrawing", { id: e.id, view: ui.contourView, points: [] });
  toast("Click successive corners. Enter closes the outline; Escape cancels.");
}

export function finishRedraw() {
  const d = ui.redrawing;
  if (!d) return;
  const e = obj(d.id);
  if (!e) return;
  const points = d.points.slice();
  while (
    points.length > 1 &&
    Math.hypot(points.at(-1)![0] - points.at(-2)![0], points.at(-1)![1] - points.at(-2)![1]) < 1e-6
  )
    points.pop();
  const raw = points.map((p) => toNormalized(e, d.view, p));
  const issues = commit((s) => setNormalizedOutline(s, d.id, d.view, raw));
  if (issues.length) {
    toast("Draw a non-crossing loop with at least three corners.", true);
    return;
  }
  setUi({ redrawing: null, pointSelection: null });
}

// ---- References ---------------------------------------------------------------------

export const imageSize = (id: string) => image(id);

/** Assign an image file as a view's reference and show its settings. */
export async function assignReferenceFile(view: ReferenceView, file: File) {
  try {
    const a = await addImageFile(file);
    if (report(commit((d) => setReference(d, view, { image: a.id, visible: true }, imageSize)))) {
      if (view === "perspective") showInspectorTab("camera");
      else {
        setUi("referenceTab", view);
        showInspectorTab("scene");
      }
      toast(
        `${view === "perspective" ? "Perspective" : VIEWS[view].name} reference assigned. Save embeds the full image.`,
      );
    }
  } catch (e) {
    toast(`Could not load the reference: ${(e as Error).message}`, true);
  }
}

/** Ask for an image file (resolves null when cancelled). */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export async function chooseReference(view: ReferenceView) {
  const file = await pickFile(IMAGE_ACCEPT);
  if (file) await assignReferenceFile(view, file);
}

// ---- Perspective camera -----------------------------------------------------------------

export function cameraPreset(which: "front" | "overview") {
  report(commit((d) => replaceCamera(d, presetCamera(d.camera, which, sceneBounds(d)))));
}

export function frameScene(toSelection = false) {
  report(
    commit((d) => {
      const items =
        toSelection && ui.selected.length
          ? d.objects.filter((e) => ui.selected.includes(e.id))
          : d.objects.filter((e) => e.visible);
      return replaceCamera(d, fitPerspective(d.camera, boundsOf(items) ?? sceneBounds(d)));
    }),
  );
}
