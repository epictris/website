// The editor shell: header, toolbar, the four views, side panels and status bar.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  deletePoint,
  deleteSelection,
  duplicateSelection,
  expandView,
  finishRedraw,
  fitAll,
  frameScene,
  nudgeSelection,
  pickFile,
  redo,
  undo,
} from "../actions";
import {
  importFile,
  saveAgentDocument,
  saveCsv,
  savePerspectivePng,
  saveProject,
  saveSvg,
  saveWorkingHtml,
} from "../io";
import { live, shareLive } from "../live";
import { OrthoView } from "../ortho/OrthoView";
import { PerspectiveView } from "../perspective/PerspectiveView";
import {
  historyCounts,
  type Mode,
  saveStatus,
  setMode,
  setSelection,
  setUi,
  state,
  toast,
  toastState,
  ui,
} from "../store";
import { CameraTab } from "./CameraTab";
import { Dialogs, openAddObject, openHelp } from "./dialogs";
import { ElementList } from "./ElementList";
import {
  BrandIcon,
  ChevronIcon,
  FitIcon,
  FolderIcon,
  HelpIcon,
  LinkIcon,
  MoveIcon,
  OutlineIcon,
  RedoIcon,
  ResizeIcon,
  SaveIcon,
  UndoIcon,
} from "./icons";
import { SceneTab } from "./SceneTab";
import { TransformTab } from "./TransformTab";

async function share() {
  const url = await shareLive();
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    toast(`Live link copied: ${url}`);
  } catch {
    toast(`Live link: ${url}`);
  }
}

const openProject = async () => {
  const f = await pickFile(".json,application/json");
  if (f) importFile(f);
};

const SAVE_MENU: { label: string; sub: string; run: () => void }[] = [
  { label: "Save project · JSON", sub: "Objects, outlines, images and editor layout", run: saveProject },
  { label: "Save for agents · JSON", sub: "Compact scene document without image pixels", run: saveAgentDocument },
  { label: "Save working editor · HTML", sub: "The editor with this project inside, one file", run: saveWorkingHtml },
  { label: "Save drawing · SVG", sub: "Three views, with the scene document embedded", run: saveSvg },
  { label: "Save perspective · PNG", sub: "Camera frame with the visible reference overlay", run: savePerspectivePng },
  { label: "Save coordinate table · CSV", sub: "Bounds per object; not a complete project", run: saveCsv },
];

function Header() {
  const [menuOpen, setMenuOpen] = createSignal(false);
  onMount(() => {
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".export-wrap")) setMenuOpen(false);
    };
    document.addEventListener("click", close);
    onCleanup(() => document.removeEventListener("click", close));
  });
  const m = () => state.scene.metersPerUnit;
  return (
    <header class="app-header">
      <div class="brandmark" aria-hidden="true">
        <BrandIcon />
      </div>
      <div class="brand">
        <h1>Orthographic Studio</h1>
        <p>OUTLINES · CAMERA · REFERENCES</p>
      </div>
      <Show
        when={live()}
        fallback={
          <span class="badge hide-small" title="Runs in the browser; nothing is uploaded.">
            OFFLINE · 3D
          </span>
        }
      >
        <span
          class="badge live hide-small"
          title="This scene is stored on the server: every change saves there, and changes made elsewhere (agents, other tabs) appear here. Anyone with the link can view and edit it."
        >
          LIVE · SHARED
        </span>
      </Show>
      <span class="badge head-unit" classList={{ warn: !m() }}>
        {m() ? `1 u = ${m()} m` : "ASSUMED SCENE UNITS"}
      </span>
      <div class="header-actions">
        <button
          type="button"
          class="iconbtn"
          aria-label="Undo"
          title="Undo (Ctrl/⌘ Z)"
          disabled={!historyCounts().undo}
          onClick={undo}
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          class="iconbtn"
          aria-label="Redo"
          title="Redo (Ctrl/⌘ Shift Z)"
          disabled={!historyCounts().redo}
          onClick={redo}
        >
          <RedoIcon />
        </button>
        <div class="divider hide-small" />
        <button type="button" class="btn" title="Load a project JSON (Ctrl/⌘ O)" onClick={openProject}>
          <FolderIcon />
          Load
        </button>
        <button
          type="button"
          class="btn"
          title={
            live()
              ? "Copy this live scene's link"
              : "Store this scene on the server and copy a link: agents (over MCP or HTTP) and people with the link edit it together"
          }
          onClick={share}
        >
          <LinkIcon />
          <span class="hide-small">{live() ? "Copy link" : "Share"}</span>
        </button>
        <div class="export-wrap">
          <div class="export-combo">
            <button
              type="button"
              class="btn primary"
              title="Save the project, including images and editor layout (Ctrl/⌘ S)"
              onClick={saveProject}
            >
              <SaveIcon />
              <span>Save</span>
            </button>
            <button
              type="button"
              class="btn primary"
              aria-label="More save options"
              aria-expanded={menuOpen()}
              onClick={() => setMenuOpen(!menuOpen())}
            >
              <ChevronIcon />
            </button>
          </div>
          <div class="export-menu" classList={{ open: menuOpen() }} role="menu">
            <For each={SAVE_MENU}>
              {(item, i) => (
                <>
                  <Show when={i() === 3}>
                    <div class="menu-line" />
                  </Show>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      item.run();
                    }}
                  >
                    <span>
                      {item.label}
                      <span class="menu-sub">{item.sub}</span>
                    </span>
                  </button>
                </>
              )}
            </For>
          </div>
        </div>
        <button type="button" class="iconbtn" aria-label="Help" title="Help & keyboard shortcuts" onClick={openHelp}>
          <HelpIcon />
        </button>
      </div>
    </header>
  );
}

function Toolbar() {
  const modeButton = (m: Mode, label: string, title: string, Icon: () => ReturnType<typeof MoveIcon>) => (
    <button type="button" class="btn" classList={{ active: ui.mode === m }} title={title} onClick={() => setMode(m)}>
      <Icon />
      {label}
    </button>
  );
  const toggle = (
    key: "snap" | "grid" | "labels" | "bounds" | "isolate" | "pointIds",
    label: string,
    cls?: string,
    title?: string,
  ) => (
    <label class={cls} title={title}>
      <input type="checkbox" checked={ui.prefs[key]} onChange={(e) => setUi("prefs", key, e.currentTarget.checked)} />
      {label}
    </label>
  );
  const narrow = () => innerWidth <= 730;
  return (
    <div class="toolbar">
      <div class="toolgroup">
        {modeButton("move", "Move", "Move selected objects (M)", MoveIcon)}
        {modeButton("resize", "Resize", "Resize with bounding-box handles (R)", ResizeIcon)}
        {modeButton("outline", "Outline", "Edit one view's outline (V)", OutlineIcon)}
      </div>
      <div class="divider" />
      {toggle("snap", "Snap")}
      <select
        aria-label="Snap increment"
        value={ui.prefs.snapStep}
        onChange={(e) => setUi("prefs", "snapStep", Number(e.currentTarget.value))}
      >
        <For each={[0.05, 0.1, 0.25, 0.5, 1, 2]}>{(s) => <option value={s}>{s} u</option>}</For>
      </select>
      <div class="divider" />
      {toggle("grid", "Grid")}
      {toggle("labels", "Labels")}
      {toggle("bounds", "Bounds", "hide-mobile")}
      {toggle("isolate", "Isolate", undefined, "Show only the selected objects")}
      {toggle("pointIds", "Point IDs", undefined, "Number every outline point")}
      <div class="divider hide-small" />
      <button type="button" class="btn" title="Fit the scene in all views (Home)" onClick={() => fitAll()}>
        <FitIcon />
        Fit<span class="hide-small"> views</span>
      </button>
      <button
        type="button"
        class="btn hide-mobile"
        title="Zoom all views to the selection (F)"
        disabled={!ui.selected.length}
        onClick={() => fitAll(true)}
      >
        Focus selection
      </button>
      <Show when={ui.focusView}>
        <button type="button" class="btn" title="Show all views (0)" onClick={() => expandView(null)}>
          All views
        </button>
      </Show>
      <div class="toolbar-end">
        <button
          type="button"
          class="btn"
          title="Show or hide the object list"
          onClick={() =>
            narrow()
              ? setUi("panels", "showLayers", !ui.panels.showLayers)
              : setUi("panels", "layersHidden", !ui.panels.layersHidden)
          }
        >
          Objects
        </button>
        <button
          type="button"
          class="btn"
          title="Show or hide the inspector"
          onClick={() =>
            innerWidth <= 1020
              ? setUi("panels", "showInspector", !ui.panels.showInspector)
              : setUi("panels", "inspectorHidden", !ui.panels.inspectorHidden)
          }
        >
          Inspector
        </button>
      </div>
    </div>
  );
}

function Inspector() {
  const tab = (id: "transform" | "scene" | "camera", label: string) => (
    <button type="button" classList={{ active: ui.inspectorTab === id }} onClick={() => setUi("inspectorTab", id)}>
      {label}
    </button>
  );
  return (
    <aside
      class="sidebar inspector"
      classList={{ "tab-scene": ui.inspectorTab === "scene", "tab-camera": ui.inspectorTab === "camera" }}
      aria-label="Inspector"
    >
      <div class="inspector-tabs">
        {tab("transform", "Transform")}
        {tab("scene", "Scene / scale")}
        {tab("camera", "Camera / image")}
      </div>
      <TransformTab />
      <SceneTab />
      <CameraTab />
    </aside>
  );
}

function StatusBar() {
  const reviewed = () => state.objects.filter((e) => e.reviewed).length;
  const m = () => state.scene.metersPerUnit;
  return (
    <footer class="statusbar">
      <span>
        <i class="status-indicator" style={{ background: saveStatus().cached ? "var(--accent)" : "var(--yellow)" }} />
        {saveStatus().message}
      </span>
      <span>
        {state.objects.length} objects · {reviewed()} reviewed
      </span>
      <span class="unit-status">{m() ? `1 u = ${m()} m` : "1 u = arbitrary scene unit"}</span>
      <span class="instructions">V: outline · Double-click edge: add point · Ctrl/⌘ S: save</span>
    </footer>
  );
}

/** Keyboard shortcuts. */
function useKeyboard() {
  onMount(() => {
    const down = (e: KeyboardEvent) => {
      const command = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (document.querySelector("dialog[open]")) return;
      if (command && (key === "s" || key === "o")) {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur();
        if (key === "s") saveProject();
        else openProject();
        return;
      }
      const target = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable) return;
      const take = (f: () => void) => {
        e.preventDefault();
        f();
      };
      if (command && key === "z") return take(e.shiftKey ? redo : undo);
      if (command && key === "y") return take(redo);
      if (command && key === "a")
        return take(() => setSelection(state.objects.filter((o) => o.visible).map((o) => o.id)));
      if (command && key === "d") return take(duplicateSelection);
      if (e.code === "Space") {
        e.preventDefault();
        setUi("spaceHeld", true);
        return;
      }
      if (e.key === "Escape") {
        return take(() => {
          if (ui.redrawing) setUi("redrawing", null);
          else setSelection([]);
        });
      }
      if (e.key === "Enter" && ui.redrawing) return take(finishRedraw);
      if (e.key === "Delete" || e.key === "Backspace")
        return take(() => (ui.mode === "outline" && ui.pointSelection ? deletePoint() : deleteSelection()));
      if (e.key.startsWith("Arrow")) {
        const view = ui.activeView === "perspective" ? "front" : ui.activeView;
        return take(() => nudgeSelection(view, e.key, e.shiftKey));
      }
      if (command || e.altKey) return;
      const views = { "1": "front", "2": "top", "3": "side", "4": "perspective" } as const;
      if (key in views) return take(() => expandView(views[key as keyof typeof views]));
      switch (key) {
        case "0":
          return take(() => expandView(null));
        case "m":
          return take(() => setMode("move"));
        case "r":
          return take(() => setMode("resize"));
        case "v":
          return take(() => setMode("outline"));
        case "n":
          return take(openAddObject);
        case "f":
          return take(() => (ui.activeView === "perspective" ? frameScene(true) : fitAll(true)));
        case "home":
          return take(() => fitAll());
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setUi("spaceHeld", false);
    };
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    onCleanup(() => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
    });
  });
}

/** Dropping a JSON anywhere loads it; views take dropped images themselves. */
function DropZone() {
  const [depth, setDepth] = createSignal(0);
  onMount(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDepth((d) => d + 1);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = () => setDepth((d) => Math.max(0, d - 1));
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDepth(0);
      const f = e.dataTransfer?.files[0];
      if (f) importFile(f);
    };
    const handled = () => setDepth(0);
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", drop);
    document.addEventListener("orthographic-drop-handled", handled);
    onCleanup(() => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", drop);
      document.removeEventListener("orthographic-drop-handled", handled);
    });
  });
  return (
    <div class="drop-overlay" classList={{ show: depth() > 0 }}>
      <div>
        Drop a project JSON
        <span>Loads the whole scene. Drop an image onto a view instead to make it that view's reference.</span>
      </div>
    </div>
  );
}

export function App() {
  useKeyboard();
  return (
    <>
      <div id="app">
        <Header />
        <Toolbar />
        <main
          class="workspace"
          classList={{
            "no-layers": ui.panels.layersHidden,
            "no-inspector": ui.panels.inspectorHidden,
            "show-layers": ui.panels.showLayers,
            "show-inspector": ui.panels.showInspector,
            "outline-mode": ui.mode === "outline",
            "pan-ready": ui.spaceHeld,
            "dragging-pan": ui.panning,
          }}
        >
          <ElementList />
          <section id="views" classList={{ "focus-views": !!ui.focusView }} aria-label="Linked views">
            <OrthoView view="front" />
            <OrthoView view="top" />
            <OrthoView view="side" />
            <PerspectiveView />
          </section>
          <Inspector />
        </main>
        <StatusBar />
      </div>
      <div
        class="toast"
        classList={{ visible: toastState().visible, error: toastState().error }}
        role="status"
        aria-live="polite"
      >
        {toastState().text}
      </div>
      <DropZone />
      <Dialogs />
    </>
  );
}
