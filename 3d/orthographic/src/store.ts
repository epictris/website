// Application state: the scene (undoable, edited only through core commands)
// and the editor UI around it (selection, modes, panels; not undoable).

import { batch, createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { clone } from "./core/math";
import { initialState, objectById } from "./core/model";
import type { EditorState, Issue, Point, SceneObject, ViewId } from "./core/types";

// ---- Scene state and history -----------------------------------------------------

export const [state, setScene] = createStore<EditorState>(initialState());

const HISTORY_LIMIT = 120;
let past: string[] = [];
let future: string[] = [];
const [historyCounts, setHistoryCounts] = createSignal({ undo: 0, redo: 0 });

export { historyCounts };

/** Called after every committed change (autosave hooks in here). */
const changeListeners: (() => void)[] = [];
export const onSceneChange = (f: () => void) => changeListeners.push(f);

export const snapshot = () => JSON.stringify(unwrap(state));

/** Replace the whole scene state, keeping unchanged parts reactive-stable. */
export function replaceState(next: EditorState) {
  setScene(reconcile(next, { key: "id", merge: false }));
}

function updateCounts() {
  setHistoryCounts({ undo: past.length, redo: future.length });
}

function pushHistory(before: string) {
  past.push(before);
  if (past.length > HISTORY_LIMIT) past.shift();
  future = [];
  updateCounts();
  for (const f of changeListeners) f();
}

export const errors = (issues: Issue[]) => issues.filter((i) => i.severity === "error");

/**
 * Run a core command on a copy of the state and commit it as one undoable
 * step, unless it reported an error. Returns the command's issues.
 */
export function commit(command: (draft: EditorState) => Issue[]): Issue[] {
  const before = snapshot();
  const draft = clone(unwrap(state)) as EditorState;
  const issues = command(draft);
  if (errors(issues).length) return issues;
  if (JSON.stringify(draft) === before) return issues;
  batch(() => replaceState(draft));
  pushHistory(before);
  return issues;
}

/** Commit an externally built state (loading a document) as one undoable step. */
export function commitState(next: EditorState) {
  const before = snapshot();
  replaceState(next);
  pushHistory(before);
}

/** Start a live edit (a drag): changes preview without history until endGesture. */
export function beginGesture(): string {
  return snapshot();
}

/** Apply a command during a gesture. Returns its issues; an error leaves the preview unchanged. */
export function preview(from: string, command: (draft: EditorState) => Issue[]): Issue[] {
  const draft = JSON.parse(from) as EditorState;
  const issues = command(draft);
  if (!errors(issues).length) replaceState(draft);
  return issues;
}

export function endGesture(before: string) {
  if (snapshot() !== before) pushHistory(before);
}

export function cancelGesture(before: string) {
  replaceState(JSON.parse(before));
}

export function undo() {
  const prev = past.pop();
  if (prev === undefined) return false;
  future.push(snapshot());
  replaceState(JSON.parse(prev));
  updateCounts();
  for (const f of changeListeners) f();
  return true;
}

export function redo() {
  const next = future.pop();
  if (next === undefined) return false;
  past.push(snapshot());
  replaceState(JSON.parse(next));
  updateCounts();
  for (const f of changeListeners) f();
  return true;
}

export function resetHistory() {
  past = [];
  future = [];
  updateCounts();
}

export const obj = (id: string): SceneObject | undefined => objectById(state, id);

// ---- Editor UI state ------------------------------------------------------------

export type Mode = "move" | "resize" | "outline";
export type ActiveView = ViewId | "perspective";
export type InspectorTab = "transform" | "scene" | "camera";

export interface Prefs {
  snap: boolean;
  snapStep: number;
  grid: boolean;
  labels: boolean;
  bounds: boolean;
  isolate: boolean;
  pointIds: boolean;
  /** Draw objects' traces over the perspective reference. */
  traces: boolean;
}

export interface OrthoCamera {
  scale: number;
  center: Point;
  autoFit: boolean;
}

export interface UiState {
  selected: string[];
  activeView: ActiveView;
  mode: Mode;
  anchor: "center" | "min";
  focusView: ActiveView | null;
  prefs: Prefs;
  pointSelection: { id: string; view: ViewId; index: number; part: number } | null;
  /** The part of the selected object whose outlines are edited. */
  part: number;
  contourView: ViewId;
  redrawing: { id: string; view: ViewId; points: Point[]; part: number } | null;
  /** The selected vertex of an object's trace (perspective view, outline mode). */
  tracePoint: { id: string; index: number } | null;
  /** A trace being drawn in the perspective view: points in the reference image's pixels. */
  tracing: { id: string; points: Point[] } | null;
  inspectorTab: InspectorTab;
  referenceTab: ViewId;
  panels: { layersHidden: boolean; inspectorHidden: boolean; showLayers: boolean; showInspector: boolean };
  search: string;
  /** Perspective reference alignment mode: dragging moves the image, not the camera. */
  alignReference: boolean;
  orthoCameras: Record<ViewId, OrthoCamera>;
  simplifyTolerance: number;
  spaceHeld: boolean;
  panning: boolean;
}

export const [ui, setUi] = createStore<UiState>({
  selected: [],
  activeView: "front",
  mode: "move",
  anchor: "center",
  focusView: null,
  prefs: {
    snap: false,
    snapStep: 0.25,
    grid: true,
    labels: true,
    bounds: false,
    isolate: false,
    pointIds: false,
    traces: true,
  },
  pointSelection: null,
  part: 0,
  contourView: "front",
  redrawing: null,
  tracePoint: null,
  tracing: null,
  inspectorTab: "transform",
  referenceTab: "front",
  panels: { layersHidden: false, inspectorHidden: false, showLayers: false, showInspector: false },
  search: "",
  alignReference: false,
  orthoCameras: {
    front: { scale: 10, center: [20, 10], autoFit: true },
    top: { scale: 10, center: [20, 15], autoFit: true },
    side: { scale: 10, center: [15, 10], autoFit: true },
  },
  simplifyTolerance: 0.006,
  spaceHeld: false,
  panning: false,
});

export const isSelected = (id: string) => ui.selected.includes(id);
export const selectedObjects = () => state.objects.filter((e) => ui.selected.includes(e.id));

export function setSelection(ids: string[]) {
  const valid = ids.filter((id) => obj(id));
  batch(() => {
    if (valid.join() !== ui.selected.join()) setUi("part", 0);
    setUi("selected", valid);
    if (ui.pointSelection && !valid.includes(ui.pointSelection.id)) setUi("pointSelection", null);
    if (ui.redrawing && !valid.includes(ui.redrawing.id)) setUi("redrawing", null);
    if (ui.tracePoint && !valid.includes(ui.tracePoint.id)) setUi("tracePoint", null);
    if (ui.tracing && !valid.includes(ui.tracing.id)) setUi("tracing", null);
  });
}

export function selectId(id: string, add = false, preserve = false) {
  if (!obj(id)) return;
  if (add) setSelection(ui.selected.includes(id) ? ui.selected.filter((x) => x !== id) : [...ui.selected, id]);
  else if (!preserve || !ui.selected.includes(id)) setSelection([id]);
}

export function setActiveView(id: ActiveView) {
  batch(() => {
    setUi("activeView", id);
    if (id !== "perspective") setUi("contourView", id);
  });
}

export function setMode(m: Mode) {
  batch(() => {
    setUi({ mode: m, redrawing: null, tracing: null });
    if (m !== "outline") setUi("tracePoint", null);
    if (m === "outline") {
      if (ui.selected.length > 1) setUi("selected", [ui.selected[0]]);
      if (ui.activeView !== "perspective") setUi("contourView", ui.activeView);
      setUi("inspectorTab", "transform");
    }
  });
}

export function showInspectorTab(tab: InspectorTab) {
  batch(() => {
    setUi("inspectorTab", tab);
    if (innerWidth <= 1020) setUi("panels", "showInspector", true);
    else setUi("panels", "inspectorHidden", false);
  });
}

/** Drop selection and editing state that points at objects which no longer exist. */
export function pruneUi() {
  const ids = new Set(state.objects.map((e) => e.id));
  batch(() => {
    if (ui.selected.some((id) => !ids.has(id)))
      setUi(
        "selected",
        ui.selected.filter((id) => ids.has(id)),
      );
    const p = ui.pointSelection;
    if (p && (!ids.has(p.id) || !obj(p.id)!.parts[p.part]?.outlines[p.view][p.index])) setUi("pointSelection", null);
    const e = ui.selected.length === 1 ? obj(ui.selected[0]) : undefined;
    if (ui.part && (!e || ui.part >= e.parts.length)) setUi("part", 0);
    if (ui.redrawing && !ids.has(ui.redrawing.id)) setUi("redrawing", null);
    const t = ui.tracePoint;
    if (t && !obj(t.id)?.trace?.points[t.index]) setUi("tracePoint", null);
    if (ui.tracing && !ids.has(ui.tracing.id)) setUi("tracing", null);
  });
}

// ---- Toasts and status --------------------------------------------------------------

const [toastState, setToastState] = createSignal<{ text: string; error: boolean; visible: boolean }>({
  text: "",
  error: false,
  visible: false,
});

export { toastState };

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string, error = false) {
  setToastState({ text, error, visible: true });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setToastState((t) => ({ ...t, visible: false })), error ? 5500 : 3200);
}

/** Toast the first error of a command, if any. Returns true when it applied. */
export function report(issues: Issue[]): boolean {
  const e = errors(issues)[0];
  if (e) toast(e.message, true);
  return !e;
}

export const [saveStatus, setSaveStatus] = createSignal({ message: "Ready · offline", cached: true });
