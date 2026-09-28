// Loading and saving: project files, the browser session cache, the embedded
// document of a saved working HTML, and the export formats.

import { batch } from "solid-js";
import { unwrap } from "solid-js/store";
import { fitView } from "./actions";
import { allImages, image, registerImage } from "./assets";
import { type ExportOptions, fromDocument, toDocument } from "./core/document";
import { fmt } from "./core/math";
import type { EditorState, Issue, SceneDocument, ViewId } from "./core/types";
import { VIEW_IDS } from "./core/views";
import { restoreMeshCache, saveMeshCache, settle } from "./meshes";
import { perspectiveCanvas, projectionSheet } from "./snapshots";
import {
  commitState,
  errors,
  onSceneChange,
  pruneUi,
  replaceState,
  resetHistory,
  setSaveStatus,
  setUi,
  state,
  toast,
  type UiState,
  ui,
} from "./store";

const STORAGE_KEY = "orthographic-studio-v1";

// ---- Editor configuration (the document's "editor" section) ------------------------

export function editorConfig(): Record<string, unknown> {
  const u = unwrap(ui);
  return {
    prefs: u.prefs,
    selected: u.selected,
    mode: u.mode,
    anchor: u.anchor,
    activeView: u.activeView,
    contourView: u.contourView,
    focusView: u.focusView,
    inspectorTab: u.inspectorTab,
    referenceTab: u.referenceTab,
    panels: u.panels,
    orthoCameras: u.orthoCameras,
    simplifyTolerance: u.simplifyTolerance,
  };
}

/** Restore what is valid in a saved editor section; ignore the rest. */
function applyEditorConfig(raw: Record<string, unknown> | undefined) {
  if (!raw || typeof raw !== "object") return;
  const r = raw as Partial<UiState>;
  const views = [...VIEW_IDS, "perspective"];
  batch(() => {
    if (r.prefs && typeof r.prefs === "object")
      for (const k of ["snap", "grid", "labels", "bounds", "isolate", "pointIds"] as const)
        if (typeof r.prefs[k] === "boolean") setUi("prefs", k, r.prefs[k]);
    if (r.prefs && [0.05, 0.1, 0.25, 0.5, 1, 2].includes(r.prefs.snapStep))
      setUi("prefs", "snapStep", r.prefs.snapStep);
    if (Array.isArray(r.selected))
      setUi(
        "selected",
        r.selected.filter((id) => typeof id === "string" && state.objects.some((e) => e.id === id)),
      );
    if (r.mode && ["move", "resize", "outline"].includes(r.mode)) setUi("mode", r.mode);
    if (r.anchor === "center" || r.anchor === "min") setUi("anchor", r.anchor);
    if (r.activeView && views.includes(r.activeView)) setUi("activeView", r.activeView);
    if (r.contourView && VIEW_IDS.includes(r.contourView)) setUi("contourView", r.contourView);
    if (r.focusView === null || (r.focusView && views.includes(r.focusView))) setUi("focusView", r.focusView ?? null);
    if (r.inspectorTab && ["transform", "scene", "camera"].includes(r.inspectorTab))
      setUi("inspectorTab", r.inspectorTab);
    if (r.referenceTab && VIEW_IDS.includes(r.referenceTab)) setUi("referenceTab", r.referenceTab);
    if (r.panels && typeof r.panels === "object")
      for (const k of ["layersHidden", "inspectorHidden"] as const)
        if (typeof r.panels[k] === "boolean") setUi("panels", k, r.panels[k]);
    if (r.orthoCameras && typeof r.orthoCameras === "object")
      for (const v of VIEW_IDS) {
        const c = r.orthoCameras[v as ViewId];
        if (
          c &&
          Number.isFinite(c.scale) &&
          c.scale >= 0.001 &&
          c.scale <= 1200 &&
          Array.isArray(c.center) &&
          c.center.length === 2 &&
          c.center.every(Number.isFinite)
        )
          setUi("orthoCameras", v, {
            scale: c.scale,
            center: [c.center[0], c.center[1]],
            autoFit: c.autoFit !== false,
          });
      }
    if (typeof r.simplifyTolerance === "number" && r.simplifyTolerance >= 0.0001 && r.simplifyTolerance <= 0.05)
      setUi("simplifyTolerance", r.simplifyTolerance);
  });
}

// ---- Documents -----------------------------------------------------------------------

export function currentDocument(opts: ExportOptions = {}): SceneDocument {
  return toDocument(unwrap(state) as EditorState, allImages(), opts);
}

/** The full project file: every image embedded, editor layout, and the mesh cache. */
export const projectDocument = (meshes = true) =>
  currentDocument({ images: "data", editor: editorConfig(), meshCache: meshes ? saveMeshCache() : undefined });

/**
 * Load a document, replacing the scene (undoable). Resolves with every issue
 * found; nothing changes when any of them is an error.
 */
export async function loadDocument(doc: unknown, opts: { undoable?: boolean } = {}): Promise<Issue[]> {
  const read = fromDocument(doc, (id) => image(id));
  if (!read.state) return read.issues;
  for (const a of read.images) {
    try {
      await registerImage(a);
    } catch (e) {
      return [
        ...read.issues,
        { severity: "error", code: "image-undecodable", path: `/images/${a.id}`, message: (e as Error).message },
      ];
    }
  }
  batch(() => {
    if (opts.undoable === false) {
      replaceState(read.state!);
      resetHistory();
    } else commitState(read.state!);
    setUi({ selected: [], pointSelection: null, redrawing: null });
    restoreMeshCache(read.meshCache);
    applyEditorConfig(read.editor);
    pruneUi();
  });
  requestAnimationFrame(() => {
    for (const v of VIEW_IDS) if (ui.orthoCameras[v].autoFit) fitView(v);
  });
  return read.issues;
}

export async function importFile(file: File) {
  if (file.size > 90 * 1024 * 1024) {
    toast("That project exceeds the 90 MB limit.", true);
    return;
  }
  try {
    const issues = await loadDocument(JSON.parse(await file.text()));
    const e = errors(issues);
    if (e.length)
      toast(
        `Could not load ${file.name}: ${e[0].message}${e.length > 1 ? ` (and ${e.length - 1} more problems)` : ""}`,
        true,
      );
    else
      toast(
        `Loaded ${file.name}: ${state.objects.length} objects${issues.length ? `, ${issues.length} warning${issues.length === 1 ? "" : "s"}` : ""}.`,
      );
  } catch (e) {
    toast(`Could not read ${file.name}: ${(e as Error).message}`, true);
  }
}

// ---- Session cache and startup -----------------------------------------------------------

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let changedSinceSave = false;

export function queueAutosave() {
  changedSinceSave = true;
  clearTimeout(autosaveTimer);
  setSaveStatus({ message: "Unsaved session changes", cached: true });
  autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(projectDocument(false)));
      setSaveStatus({ message: "Session cached · use Save for a project file", cached: true });
    } catch {
      setSaveStatus({ message: "Use Save · the browser session cache is unavailable", cached: false });
    }
  }, 700);
}

onSceneChange(queueAutosave);

export const hasUnsavedChanges = () => changedSinceSave;

/** The document a saved working HTML carries, if this page is one. */
function embeddedDocument(): unknown {
  try {
    return JSON.parse(document.getElementById("embedded-document")?.textContent || "null");
  } catch {
    return null;
  }
}

export async function restoreAtStartup() {
  const embedded = embeddedDocument();
  let cached: unknown = null;
  try {
    cached = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    setSaveStatus({ message: "Use Save · the browser session cache is unavailable", cached: false });
  }
  for (const [doc, label] of [
    [cached, "Saved session restored"],
    [embedded, "Embedded project loaded"],
  ] as const) {
    if (!doc) continue;
    const issues = await loadDocument(doc, { undoable: false });
    if (!errors(issues).length) {
      setSaveStatus({ message: label, cached: true });
      changedSinceSave = false;
      return;
    }
    toast(`Could not restore the saved session: ${errors(issues)[0].message}`, true);
  }
}

// ---- Files ------------------------------------------------------------------------------

export function slug() {
  return (
    state.scene.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "scene"
  );
}

export function download(name: string, content: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function saved(message: string) {
  changedSinceSave = false;
  setSaveStatus({ message, cached: true });
}

export async function saveProject() {
  if (ui.redrawing) {
    toast("Finish or cancel the outline you are drawing before saving.", true);
    return;
  }
  try {
    await settle();
    download(`${slug()}.scene.json`, JSON.stringify(projectDocument(), null, 1), "application/json");
    saved("Project saved");
    toast("Project saved: objects, outlines, images, camera and editor layout.");
  } catch (e) {
    toast(`Save failed: ${(e as Error).message}`, true);
  }
}

/** The compact document for agents: world coordinates, no pixels, no editor state. */
export function saveAgentDocument() {
  download(
    `${slug()}.agent.json`,
    JSON.stringify(currentDocument({ images: "metadata" }), null, 1),
    "application/json",
  );
  toast("Agent document saved (no image pixels or editor layout).");
}

export async function saveWorkingHtml() {
  if (import.meta.env.DEV) {
    toast("A working HTML copy needs the built editor; use the deployed site.", true);
    return;
  }
  try {
    await settle();
    const html = document.documentElement.cloneNode(true) as HTMLElement;
    html.querySelector("#embedded-document")!.textContent = JSON.stringify(projectDocument()).replace(/</g, "\\u003c");
    html.querySelector("#root")!.innerHTML = "";
    download(`${slug()}.editor.html`, `<!doctype html>\n${html.outerHTML}`, "text/html");
    saved("Working HTML saved");
    toast("Saved a working HTML copy with the project embedded.");
  } catch (e) {
    toast(`Save failed: ${(e as Error).message}`, true);
  }
}

export function saveSvg() {
  download(`${slug()}.views.svg`, projectionSheet(currentDocument({ images: "metadata" })), "image/svg+xml");
  toast("Three-view drawing saved, with the scene document in its metadata.");
}

export async function savePerspectivePng() {
  try {
    const canvas = await perspectiveCanvas({ references: !!state.references.perspective?.visible });
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG encoding failed.");
    download(`${slug()}.perspective.png`, blob, "image/png");
    toast("Perspective PNG saved, including the reference overlay.");
  } catch (e) {
    toast(`PNG save failed: ${(e as Error).message}`, true);
  }
}

export function saveCsv() {
  const header = [
    "id",
    "name",
    "kind",
    "color",
    "center_x",
    "center_y",
    "center_z",
    "size_x",
    "size_y",
    "size_z",
    "min_x",
    "min_y",
    "min_z",
    "max_x",
    "max_y",
    "max_z",
    "visible",
    "locked",
    "reviewed",
    "notes",
  ];
  const rows: (string | number | boolean)[][] = [header];
  for (const e of state.objects) {
    const max = e.min.map((v, i) => v + e.size[i]);
    const center = e.min.map((v, i) => v + e.size[i] / 2);
    rows.push([
      e.id,
      e.name,
      e.kind,
      e.color,
      ...center,
      ...e.size,
      ...e.min,
      ...max,
      e.visible,
      e.locked,
      e.reviewed,
      e.notes,
    ]);
  }
  const cell = (v: string | number | boolean) => {
    let s = typeof v === "number" ? fmt(v, 6) : String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  download(`${slug()}.objects.csv`, `﻿${rows.map((r) => r.map(cell).join(",")).join("\r\n")}`, "text/csv;charset=utf-8");
  toast("Coordinate table saved (scene units).");
}
