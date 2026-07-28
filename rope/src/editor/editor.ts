// Level editor. Owns its own canvas loop and DOM overlay (toolbar + inspector),
// manipulates an EdModel with the mouse, tests the scene with either controller,
// and saves/loads levels from disk through the dev-server API.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { ballZoom, GRAPPLE_ZOOM, screenToWorld, type Camera } from "../render/camera";
import { CAMERA_BLEND_TIME, CameraController } from "../render/cameraController";
import { render, renderBall } from "../render/renderer";
import { Level } from "../level/level";
import { BallLevel } from "../level/ballLevel";
import { LiveInputSource } from "../input/liveInput";
import { BallInputSource } from "../input/ballInput";
import type { FrameInput, IInputSource } from "../input/frameInput";
import {
  DEFAULT_BODY_COLOR,
  DEFAULT_BODY_OPACITY,
  DEFAULT_FORCE_MAGNITUDE,
  DEFAULT_SURFACE_FRICTION,
  type BodyKind,
} from "../level/levelFormat";
import {
  bodyIntersectsRect,
  CAMERA_REGION_COLOR,
  CAMERA_REGION_OPACITY,
  defaultCamera,
  ED_LAYERS,
  emptyModel,
  groupBounds,
  halfExtents,
  modelFromDisk,
  modelToDisk,
  newBodyId,
  pointInBody,
  toWorld,
  type EdItem,
  type EdLayer,
  type EdModel,
} from "./model";
import { computeHandles, drawEditor, HANDLE_HIT_PX } from "./render";
import { deleteLevel, listLevels, loadLevel, saveLevel } from "./api";
import {
  digest,
  digestBall,
  serializeInput,
  type Digest,
  type Recording,
  type SerializedFrame,
} from "../sim/trace";
import type { LevelData } from "../level/levelFormat";

type Tool = "select" | "rect" | "circle";

// Kinds offered by both kind pickers (toolbar + inspector), in one place so
// they can't drift apart.
const BODY_KINDS: BodyKind[] = ["static", "rigid", "killzone", "impermeable", "anchor", "force"];

type Drag =
  | { mode: "pan"; lastScreen: Vec2 }
  // Rubber-band select. `additive` (shift) unions the hits into the existing
  // selection instead of replacing it.
  | { mode: "marquee"; start: Vec2; current: Vec2; additive: boolean }
  // The lead body follows the pointer (and the grid); the rest of the
  // selection rides along at a fixed offset from it.
  | { mode: "move"; lead: EdItem; others: Array<{ body: EdItem; offset: Vec2 }>; grab: Vec2 }
  | { mode: "movePlayer"; grab: Vec2 }
  | { mode: "corner"; body: EdItem; anchor: Vec2 }
  | { mode: "radius"; body: EdItem }
  | { mode: "rotate"; body: EdItem }
  | { mode: "draw"; body: EdItem; start: Vec2 };

// Arrow-key nudge directions (world axes, +y down).
const NUDGE_DIRS: Record<string, Vec2 | undefined> = {
  ArrowLeft: new Vec2(-1, 0),
  ArrowRight: new Vec2(1, 0),
  ArrowUp: new Vec2(0, -1),
  ArrowDown: new Vec2(0, 1),
};

const STEP = 1 / 60;
const MAX_STEPS = 5;

const M2PX = PIXELS_PER_METER;

export function startEditor(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d")!;
  const camera: Camera = {
    position: Vec2.ZERO,
    zoom: 2,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };

  let cssW = window.innerWidth;
  let cssH = window.innerHeight;
  let dpr = window.devicePixelRatio || 1;
  function resize(): void {
    dpr = window.devicePixelRatio || 1;
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    camera.viewportWidth = cssW;
    camera.viewportHeight = cssH;
  }
  resize();
  window.addEventListener("resize", resize);

  // --- state ----------------------------------------------------------------
  let model: EdModel = emptyModel();
  // Selection is a set: plain click selects one, shift+click toggles a body in
  // or out. Handles and the per-body inspector only apply to a lone selection.
  const selectedIds = new Set<number>();
  let tool: Tool = "select";
  let newKind: BodyKind = "static";
  // Layers. Only the active one is hit-testable and drawable-into (the others
  // render dimmed as context), so clicking a camera region can never grab the
  // wall behind it — and the two overlap everywhere by nature. A selection
  // therefore never spans layers, which is what lets the inspector show one
  // layer's properties without a mixed-layer case.
  let activeLayer: EdLayer = "geometry";
  const visibleLayers = new Set<EdLayer>(ED_LAYERS);
  let snapOn = true;
  const gridStep = 0.1; // snap spacing: fixed 10 cm (matches the backdrop minor grid)
  let currentName: string | null = null;
  let dirty = false;
  // Bumped by every model edit, so a save that started before an edit knows not
  // to clear `dirty` on a model that has moved on under it.
  let modelRev = 0;
  let saveError: string | null = null;
  let drag: Drag | null = null;
  let dragMoved = false;
  let dragPushed = false; // history snapshot taken for the in-progress drag?
  let nudging = false; // arrow-key run in progress? (coalesces into one undo step)

  // --- undo/redo ------------------------------------------------------------
  // Snapshots of the whole model. Shapes are mutated in place, so clone them;
  // Vec2 is immutable, so its refs are safe to share.
  const HISTORY_MAX = 50; // undo steps retained
  const history: EdModel[] = [];
  const future: EdModel[] = [];
  const snapshot = (m: EdModel): EdModel => ({
    player: { pos: m.player.pos, radius: m.player.radius },
    items: m.items.map((b) => ({ ...b, shape: { ...b.shape }, cam: { ...b.cam } })),
  });
  const resetHistory = (): void => {
    history.length = 0;
    future.length = 0;
  };
  // Record the current state before a mutating action, so it can be undone.
  function beginAction(): void {
    nudging = false; // any other action ends the current nudge run
    history.push(snapshot(model));
    if (history.length > HISTORY_MAX) history.shift();
    future.length = 0;
  }
  function undo(): void {
    if (!history.length) return;
    future.push(snapshot(model));
    model = history.pop()!;
    afterHistoryChange();
  }
  function redo(): void {
    if (!future.length) return;
    history.push(snapshot(model));
    model = future.pop()!;
    afterHistoryChange();
  }
  function afterHistoryChange(): void {
    drag = null;
    nudging = false;
    const live = new Set(model.items.map((b) => b.id));
    for (const id of selectedIds) if (!live.has(id)) selectedIds.delete(id);
    rebuildInspector();
    markDirty(); // an undo/redo is a change like any other - it autosaves too
  }

  // Model order, so a group keeps its z-order through copy/duplicate.
  const selectedBodies = () => model.items.filter((b) => selectedIds.has(b.id));
  // The items a click, a rubber-band or a paste may touch: the active layer.
  const layerItems = () => model.items.filter((b) => b.layer === activeLayer);
  const selected = () => (selectedIds.size === 1 ? selectedBodies()[0] ?? null : null);
  function setSelection(ids: readonly number[]): void {
    if (ids.length === selectedIds.size && ids.every((id) => selectedIds.has(id))) return;
    selectedIds.clear();
    for (const id of ids) selectedIds.add(id);
    nudging = false;
    rebuildInspector();
  }
  function toggleSelection(id: number): void {
    if (!selectedIds.delete(id)) selectedIds.add(id);
    nudging = false;
    rebuildInspector();
  }

  const snap = (v: number) => (snapOn ? Math.round(v / gridStep) * gridStep : v);
  const snapVec = (v: Vec2) => new Vec2(snap(v.x), snap(v.y));
  // Snap a shape dimension (width/height/radius) to the grid, never below one cell.
  const snapLen = (v: number) => Math.max(gridStep, snap(v));
  // Snap a would-be centre so the body's top-left corner lands on the grid
  // (moves snap the corner rather than the centre).
  const snapCorner = (b: EdItem, center: Vec2) => {
    const off = halfExtents(b);
    return snapVec(center.sub(off)).add(off);
  };
  const snapAngle = (a: number) => {
    if (!snapOn) return a;
    const step = Math.PI / 12; // 15°
    return Math.round(a / step) * step;
  };

  function markDirty(): void {
    dirty = true;
    modelRev++;
    scheduleAutosave();
    updateTitle();
  }

  // --- mode: edit | test ----------------------------------------------------
  let mode: "edit" | "test" = "edit";
  let testLevel: Level | BallLevel | null = null;
  let liveInput: LiveInputSource | null = null;
  let ballInput: BallInputSource | null = null;
  let savedCam: { pos: Vec2; zoom: number } | null = null;
  // The test run's camera (eased follow + camera regions). Separate from the
  // editor's own camera handling, which is a direct pan/zoom.
  const testCameraCtl = new CameraController();

  // Full-session recording of the current test run — press P to download a
  // self-contained replay bundle (embeds the tested geometry, since an
  // in-editor level isn't in the registry). Mirrors main.ts's P export.
  let testController: "grapple" | "ball" = "grapple";
  let testData: LevelData | null = null;
  const recFrames: SerializedFrame[] = [];
  const recDigests: Digest[] = [];

  function startTest(controller: "grapple" | "ball"): void {
    if (mode === "test") stopTest();
    const pixelData = modelToDisk(model);
    savedCam = { pos: camera.position, zoom: camera.zoom };
    testController = controller;
    testData = pixelData;
    recFrames.length = 0;
    recDigests.length = 0;
    // The camera controller owns the zoom from here (base framing × the active
    // region's viewportScale), and re-derives it every frame, so a resize
    // mid-test needs no separate handling.
    testCameraCtl.snap();
    if (controller === "ball") {
      testLevel = new BallLevel(pixelData);
      ballInput ??= new BallInputSource(canvas, camera, () =>
        testLevel instanceof BallLevel ? testLevel.ball.globalPosition : Vec2.ZERO,
      );
    } else {
      testLevel = new Level(pixelData);
      liveInput ??= new LiveInputSource(canvas, camera, () =>
        testLevel instanceof Level ? testLevel.player.globalPosition : Vec2.ZERO,
      );
    }
    testLevel.onReset = () => startTest(controller);
    accumulator = 0;
    lastNow = -1;
    mode = "test";
    root.style.display = "none";
    testBanner.style.display = "block";
    // The ball controller draws its own aim reticle, so the OS cursor would be
    // a second pointer — hide it there (the grapple aims with the cursor).
    canvas.style.cursor = controller === "ball" ? "none" : "crosshair";
  }

  function downloadTestRecording(): void {
    if (!testData || recFrames.length === 0) return;
    const rec: Recording = {
      level: currentName ?? "editor",
      git: __GIT_COMMIT__,
      controller: testController,
      data: testData,
      frames: recFrames.slice(),
      digests: recDigests.slice(),
    };
    const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${recFrames.length}f.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function stopTest(): void {
    mode = "edit";
    testLevel = null;
    if (savedCam) {
      camera.position = savedCam.pos;
      camera.zoom = savedCam.zoom;
    }
    root.style.display = "";
    testBanner.style.display = "none";
    canvas.style.cursor = "default";
  }

  // --- DOM ------------------------------------------------------------------
  injectStyles();
  const root = document.createElement("div");
  root.className = "ed-root";
  document.body.appendChild(root);

  const testBanner = document.createElement("div");
  testBanner.className = "ed-test-banner";
  testBanner.textContent = "TESTING — Esc to return to the editor";
  testBanner.style.display = "none";
  document.body.appendChild(testBanner);

  // Toolbar.
  const bar = el("div", "ed-bar");
  root.appendChild(bar);

  const fileRow = el("div", "ed-row");
  bar.appendChild(fileRow);
  const btnNew = button("New", () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    cancelAutosave();
    model = emptyModel();
    resetHistory();
    selectedIds.clear();
    currentName = null;
    dirty = false;
    camera.position = Vec2.ZERO;
    rebuildInspector();
    updateTitle();
  });
  const loadSel = document.createElement("select");
  loadSel.className = "ed-select";
  loadSel.title = "Load level from disk";
  loadSel.addEventListener("change", async () => {
    const name = loadSel.value;
    if (!name) return;
    if (dirty && !confirm("Discard unsaved changes?")) {
      loadSel.value = "";
      return;
    }
    await doLoad(name);
    loadSel.value = "";
  });
  const btnSave = button("Save", () => doSave(false));
  const btnSaveAs = button("Save As", () => doSave(true));
  const btnDelete = button("Delete File", async () => {
    if (!currentName) return;
    if (!confirm(`Delete level "${currentName}" from disk?`)) return;
    cancelAutosave(); // a queued write would recreate the file
    await deleteLevel(currentName);
    currentName = null;
    dirty = true;
    await refreshLevelList();
    updateTitle();
  });
  fileRow.append(btnNew, loadSel, btnSave, btnSaveAs, btnDelete);

  const toolRow = el("div", "ed-row");
  bar.appendChild(toolRow);
  const toolBtns: Record<Tool, HTMLButtonElement> = {
    select: button("Select", () => setTool("select")),
    rect: button("+ Rect", () => setTool("rect")),
    circle: button("+ Circle", () => setTool("circle")),
  };
  const kindSel = document.createElement("select");
  kindSel.className = "ed-select";
  for (const k of BODY_KINDS) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k;
    kindSel.appendChild(o);
  }
  kindSel.value = newKind;
  kindSel.title = "Kind for new bodies (and every selected body)";
  kindSel.addEventListener("change", () => {
    newKind = kindSel.value as BodyKind;
    const sel = selectedBodies();
    if (sel.length) {
      beginAction();
      for (const b of sel) b.kind = newKind;
      markDirty();
      rebuildInspector();
    }
  });
  const kindWrap = labelWrap("kind", kindSel);
  toolRow.append(toolBtns.select, toolBtns.rect, toolBtns.circle, kindWrap);

  // Layer row: which layer is being edited (Tab cycles), plus a visibility
  // toggle each. Visibility is independent of active — a hidden active layer
  // would be an invisible edit target, so hiding one also moves the edit focus.
  const layerRow = el("div", "ed-row");
  bar.appendChild(layerRow);
  const layerBtns = {} as Record<EdLayer, HTMLButtonElement>;
  const layerChks = {} as Record<EdLayer, HTMLInputElement>;
  for (const l of ED_LAYERS) {
    const b = button(l, () => setLayer(l));
    b.title = `Edit the ${l} layer (Tab cycles)`;
    layerBtns[l] = b;
    const wrap = el("label", "ed-check");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.title = `Show the ${l} layer`;
    box.addEventListener("change", () => {
      if (box.checked) {
        visibleLayers.add(l);
        return;
      }
      // Hiding everything leaves a blank canvas nothing can be clicked on, so
      // the last visible layer refuses to go.
      if (visibleLayers.size === 1) {
        box.checked = true;
        return;
      }
      visibleLayers.delete(l);
      // Never leave the edit target invisible.
      if (activeLayer === l) setLayer(ED_LAYERS.find((o) => visibleLayers.has(o))!);
    });
    layerChks[l] = box;
    wrap.appendChild(box);
    layerRow.append(b, wrap);
  }
  layerRow.prepend(document.createTextNode("layer"));

  function setLayer(l: EdLayer): void {
    if (!visibleLayers.has(l)) {
      visibleLayers.add(l);
      layerChks[l].checked = true;
    }
    activeLayer = l;
    // A selection never spans layers, so switching drops it rather than leaving
    // items selected that can no longer be clicked.
    selectedIds.clear();
    for (const [k, b] of Object.entries(layerBtns)) b.classList.toggle("active", k === l);
    // `kind` is a geometry property; a camera region has none.
    kindWrap.style.display = l === "geometry" ? "" : "none";
    rebuildInspector();
  }

  const testRow = el("div", "ed-row");
  bar.appendChild(testRow);
  testRow.append(
    button("▶ Test Grapple", () => startTest("grapple")),
    button("▶ Test Ball", () => startTest("ball")),
  );
  const snapChk = checkbox("snap 10cm", snapOn, (v) => (snapOn = v));
  testRow.append(snapChk);

  const title = el("div", "ed-title");
  bar.appendChild(title);

  // Inspector.
  const inspector = el("div", "ed-inspector");
  root.appendChild(inspector);

  function updateTitle(): void {
    // A named level autosaves, so `*` is a brief in-flight marker rather than a
    // standing warning; an unnamed one keeps it until the first Save names it.
    const state = saveError ? " · SAVE FAILED" : dirty ? " *" : "";
    const bodies = model.items.filter((i) => i.layer === "geometry").length;
    const regions = model.items.length - bodies;
    const cams = regions ? ` · ${regions} cam` : "";
    title.textContent = `${currentName ?? "(unsaved)"}${state} · ${bodies} bodies${cams}`;
  }
  // The cursor a drag borrows and must hand back (pan swaps in a grab hand).
  function applyToolCursor(): void {
    canvas.style.cursor = tool === "select" ? "default" : "crosshair";
  }
  function setTool(t: Tool): void {
    tool = t;
    for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle("active", k === t);
    applyToolCursor();
  }
  setTool("select");

  // --- inspector build ------------------------------------------------------
  // `get` returns null when the selected bodies disagree — a mixed field shows
  // blank and only writes once something is typed into it.
  const fields: Array<{
    input: HTMLInputElement;
    get: () => number | null;
    set: (v: number) => void;
  }> = [];

  function numField(
    parent: HTMLElement,
    label: string,
    get: () => number | null,
    set: (v: number) => void,
    step = 1,
    mixable = false, // can the selected bodies disagree on this value?
    // `placeholder` overrides the "mixed" hint (an optional field shows its
    // default there instead); `onEmpty` makes clearing the field meaningful —
    // without it a blank input is simply ignored.
    opts: {
      placeholder?: string;
      onEmpty?: () => void;
      disabled?: boolean;
      // A control that sits between the label and the number (the lock toggle).
      prefix?: HTMLElement;
    } = {},
  ): HTMLInputElement {
    const wrap = el("label", "ed-field");
    wrap.textContent = label;
    if (opts.prefix) wrap.appendChild(opts.prefix);
    const input = document.createElement("input");
    input.type = "number";
    input.className = "ed-num";
    input.step = String(step);
    input.value = fmtOrBlank(get());
    if (opts.placeholder !== undefined) input.placeholder = opts.placeholder;
    else if (mixable) input.placeholder = "mixed";
    if (opts.disabled) input.disabled = true;
    // One undo step per editing session (snapshot on focus, before any edit).
    input.addEventListener("focus", () => beginAction());
    input.addEventListener("input", () => {
      if (input.value.trim() === "" && opts.onEmpty) {
        opts.onEmpty();
        markDirty();
        return;
      }
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) {
        set(v);
        markDirty();
      }
    });
    wrap.appendChild(input);
    parent.appendChild(wrap);
    fields.push({ input, get, set });
    return input;
  }

  // The value every body in the group agrees on, or null if they differ.
  function shared(bodies: readonly EdItem[], get: (b: EdItem) => number): number | null {
    const first = get(bodies[0]!);
    return bodies.every((b) => get(b) === first) ? first : null;
  }

  // Nothing rests on a region or on hook-only scenery, so neither carries a
  // friction. A force area does carry a direction, hence a rot° even when it is
  // a circle (whose rotation is otherwise invisible).
  const frictionless = (b: EdItem) =>
    b.kind === "killzone" || b.kind === "force" || b.kind === "anchor";

  // A number field bound to one panel and one selection: it shows the value the
  // group agrees on (blank if they differ) and writes to every member.
  function groupNum(g: HTMLElement, items: EdItem[]) {
    return (
      label: string,
      get: (b: EdItem) => number,
      set: (b: EdItem, v: number) => void,
      step?: number,
      opts?: { placeholder?: string; onEmpty?: () => void },
    ): HTMLInputElement =>
      numField(
        g,
        label,
        () => shared(items, get),
        (v) => {
          for (const b of items) set(b, v);
        },
        step,
        items.length > 1,
        opts,
      );
  }
  type GroupNum = ReturnType<typeof groupNum>;

  // Placement and size. Shared by every layer's panel: whatever layer an item
  // lives on, it is a placed shape and moves, rotates and resizes the same way.
  function addTransformFields(num: GroupNum, items: EdItem[]): void {
    num("x", (b) => b.pos.x * M2PX, (b, v) => (b.pos = b.pos.withX(v * PX)));
    num("y", (b) => b.pos.y * M2PX, (b, v) => (b.pos = b.pos.withY(v * PX)));
    // A circle's rotation is invisible, so it only gets the field where it aims
    // something (a force area's current).
    if (items.every((b) => b.shape.kind === "rect" || (b.layer === "geometry" && b.kind === "force"))) {
      num("rot°", (b) => (b.rot * 180) / Math.PI, (b, v) => (b.rot = (v * Math.PI) / 180));
    }
    // Size is per-shape, so it only appears when the group is all one shape.
    if (items.every((b) => b.shape.kind === "rect")) {
      num("w", (b) => (b.shape.kind === "rect" ? b.shape.w * M2PX : 0), (b, v) => {
        if (b.shape.kind === "rect") b.shape.w = Math.max(1, v) * PX;
      });
      num("h", (b) => (b.shape.kind === "rect" ? b.shape.h * M2PX : 0), (b, v) => {
        if (b.shape.kind === "rect") b.shape.h = Math.max(1, v) * PX;
      });
    } else if (items.every((b) => b.shape.kind === "circle")) {
      num("radius", (b) => (b.shape.kind === "circle" ? b.shape.r * M2PX : 0), (b, v) => {
        if (b.shape.kind === "circle") b.shape.r = Math.max(1, v) * PX;
      });
    }
  }

  // One panel for the whole selection: every property the group has in common
  // is editable and writes to all of them. A lone body is just the N=1 case, so
  // single and multi editing can't drift apart.
  function buildBodyGroup(bodies: EdItem[]): void {
    const g = el("div", "ed-group");
    g.appendChild(
      heading(bodies.length === 1 ? `Body #${bodies[0]!.id}` : `${bodies.length} bodies selected`),
    );
    if (bodies.length > 1) {
      const hint = el("div", "ed-hint");
      hint.textContent =
        "Edits apply to all of them. Shift+click adds or removes; drag empty space to rubber-band.";
      g.appendChild(hint);
    }

    const kw = el("label", "ed-field");
    kw.textContent = "kind";
    const ks = document.createElement("select");
    ks.className = "ed-select";
    const sharedKind = bodies.every((b) => b.kind === bodies[0]!.kind) ? bodies[0]!.kind : null;
    if (!sharedKind) {
      // Mixed kinds: a blank entry holds the selection until one is picked, so
      // the picker never misreports one kind as the group's.
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "mixed";
      ks.appendChild(o);
    }
    for (const k of BODY_KINDS) {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = k;
      ks.appendChild(o);
    }
    ks.value = sharedKind ?? "";
    ks.addEventListener("change", () => {
      if (!ks.value) return;
      beginAction();
      for (const b of bodies) b.kind = ks.value as BodyKind;
      markDirty();
      // Which fields apply depends on the kind (force magnitude, friction), so
      // the panel has to be rebuilt rather than just revalued.
      rebuildInspector();
    });
    kw.appendChild(ks);
    g.appendChild(kw);

    const num = groupNum(g, bodies);
    addTransformFields(num, bodies);
    if (bodies.every((b) => b.kind === "force")) {
      // Acceleration along rot°, authored in px/s² like every other length.
      // Negative reverses the flow, so it is deliberately not clamped at 0.
      num("force", (b) => b.force * M2PX, (b, v) => (b.force = v * PX), 50);
    }
    if (!bodies.some(frictionless)) {
      num("friction", (b) => b.friction, (b, v) => (b.friction = Math.min(1, Math.max(0, v))), 0.1);
    }

    const cw = el("label", "ed-field");
    cw.textContent = "color";
    const ci = document.createElement("input");
    ci.type = "color";
    ci.className = "ed-color";
    // A colour input has no mixed state; it shows the first body's and writes
    // to all of them, which is the only sane reading of "set the colour".
    ci.value = bodies[0]!.color;
    ci.addEventListener("focus", () => beginAction());
    ci.addEventListener("input", () => {
      for (const b of bodies) b.color = ci.value;
      markDirty();
    });
    cw.appendChild(ci);
    g.appendChild(cw);
    num("opacity", (b) => b.opacity, (b, v) => (b.opacity = Math.min(1, Math.max(0, v))), 0.1);

    const row = el("div", "ed-row");
    row.append(
      button("Duplicate", () => duplicateSelected()),
      button("Delete", () => deleteSelected()),
    );
    g.appendChild(row);
    inspector.appendChild(g);
  }

  // Camera-layer panel. Same shape as the body panel — group-wide edits, blank
  // for a value the group disagrees on — over the region's framing properties.
  function buildCameraGroup(regions: EdItem[]): void {
    const g = el("div", "ed-group");
    g.appendChild(
      heading(
        regions.length === 1 ? `Camera region #${regions[0]!.id}` : `${regions.length} regions selected`,
      ),
    );
    const hint = el("div", "ed-hint");
    hint.textContent =
      "While the avatar is inside, the camera offsets, rescales the viewport, or pins to a locked axis. Every change eases in.";
    g.appendChild(hint);

    const num = groupNum(g, regions);
    addTransformFields(num, regions);

    num("off x", (b) => b.cam.offset.x * M2PX, (b, v) => (b.cam.offset = b.cam.offset.withX(v * PX)), 10);
    num("off y", (b) => b.cam.offset.y * M2PX, (b, v) => (b.cam.offset = b.cam.offset.withY(v * PX)), 10);
    // How much world is on screen: 2 = twice as much (zoomed out).
    num(
      "view ×",
      (b) => b.cam.viewportScale,
      (b, v) => (b.cam.viewportScale = Math.min(10, Math.max(0.1, v))),
      0.1,
    );

    // A locked axis pins the camera at a world coordinate and ignores that
    // axis's offset; the checkbox seeds the lock from the region's own centre,
    // which is the sane starting point for "frame this room".
    const lockField = (label: string, axis: "lockX" | "lockY", centre: (b: EdItem) => number): void => {
      const box = document.createElement("input");
      box.type = "checkbox";
      const locked = regions.map((b) => b.cam[axis] !== null);
      box.checked = locked.every(Boolean);
      box.indeterminate = !box.checked && locked.some(Boolean);
      box.addEventListener("change", () => {
        beginAction();
        for (const b of regions) b.cam[axis] = box.checked ? centre(b) : null;
        markDirty();
        rebuildInspector(); // enables/disables the value field
      });
      numField(
        g,
        label,
        // An unlocked axis has no value: NaN never equals itself, so `shared`
        // reports it as "no agreed value" and the field shows blank.
        () => shared(regions, (b) => (b.cam[axis] ?? NaN) * M2PX),
        (v) => {
          for (const b of regions) b.cam[axis] = v * PX;
        },
        10,
        regions.length > 1,
        { disabled: !box.checked, placeholder: box.checked ? "mixed" : "follow", prefix: box },
      );
    };
    lockField("lock x", "lockX", (b) => b.pos.x);
    lockField("lock y", "lockY", (b) => b.pos.y);

    // Blank = the controller's default cross-fade (CAMERA_BLEND_TIME).
    num(
      "blend s",
      (b) => b.cam.blend ?? NaN,
      (b, v) => (b.cam.blend = Math.max(0, v)),
      0.1,
      {
        placeholder: String(CAMERA_BLEND_TIME),
        onEmpty: () => {
          for (const b of regions) b.cam.blend = null;
        },
      },
    );
    num("priority", (b) => b.cam.priority, (b, v) => (b.cam.priority = Math.round(v)), 1);

    const row = el("div", "ed-row");
    row.append(
      button("Duplicate", () => duplicateSelected()),
      button("Delete", () => deleteSelected()),
    );
    g.appendChild(row);
    inspector.appendChild(g);
  }

  function rebuildInspector(): void {
    fields.length = 0;
    inspector.innerHTML = "";

    const player = el("div", "ed-group");
    player.appendChild(heading("Player spawn"));
    numField(player, "x", () => model.player.pos.x * M2PX, (v) => (model.player.pos = model.player.pos.withX(v * PX)));
    numField(player, "y", () => model.player.pos.y * M2PX, (v) => (model.player.pos = model.player.pos.withY(v * PX)));
    numField(player, "radius", () => model.player.radius * M2PX, (v) => (model.player.radius = Math.max(1, v) * PX));
    inspector.appendChild(player);

    const sel = selectedBodies();
    if (!sel.length) {
      const hint = el("div", "ed-hint");
      hint.textContent =
        activeLayer === "camera"
          ? "Camera layer. Click a region, drag to rubber-band select, or pick +Rect / +Circle and drag one out. Tab switches layer."
          : "No selection. Click a body, drag to rubber-band select, or pick +Rect / +Circle and drag on the canvas.";
      inspector.appendChild(hint);
      return;
    }
    // A selection never spans layers (only the active one is pickable), so the
    // panel is chosen by the layer rather than reconciled across it.
    if (sel[0]!.layer === "camera") buildCameraGroup(sel);
    else buildBodyGroup(sel);
  }

  // Refresh field values after a canvas drag, without disturbing a focused input.
  function refreshFields(): void {
    for (const f of fields) {
      if (document.activeElement === f.input) continue;
      f.input.value = fmtOrBlank(f.get());
    }
  }

  // --- editing ops ----------------------------------------------------------
  // Detached copies of the given bodies, each with a fresh id and shifted by
  // `offset`. Shapes are mutated in place, so clone them.
  const cloneBodies = (bodies: readonly EdItem[], offset: Vec2): EdItem[] =>
    bodies.map((b) => ({
      ...b,
      id: newBodyId(),
      pos: b.pos.add(offset),
      shape: { ...b.shape },
      cam: { ...b.cam },
    }));

  // Add freshly created bodies to the model and leave them selected, so the
  // group can immediately be dragged or pasted again.
  function addAndSelect(bodies: EdItem[]): void {
    model.items.push(...bodies);
    selectedIds.clear();
    for (const b of bodies) selectedIds.add(b.id);
    markDirty();
    rebuildInspector();
  }

  function deleteSelected(): void {
    if (!selectedIds.size) return;
    beginAction();
    model.items = model.items.filter((b) => !selectedIds.has(b.id));
    selectedIds.clear();
    markDirty();
    rebuildInspector();
  }
  // Arrow-key nudge: one grid cell, or `NUDGE_FINE` with Ctrl held. A pure
  // translation — deliberately not snapped, so a body keeps whatever sub-cell
  // offset it has and a fine nudge survives with snap on.
  const NUDGE_FINE = 0.01; // 1 cm
  function nudgeSelection(dir: Vec2, fine: boolean): void {
    const sel = selectedBodies();
    if (!sel.length) return;
    // One undo step per run of nudges (a held arrow is a single gesture, like
    // a drag); releasing the key or any other action ends it.
    if (!nudging) {
      beginAction();
      nudging = true;
    }
    const d = dir.mul(fine ? NUDGE_FINE : gridStep);
    for (const b of sel) b.pos = b.pos.add(d);
    markDirty();
    refreshFields();
  }

  function duplicateSelected(): void {
    const sel = selectedBodies();
    if (!sel.length) return;
    beginAction();
    addAndSelect(cloneBodies(sel, new Vec2(gridStep * 2, gridStep * 2)));
  }

  // --- clipboard ------------------------------------------------------------
  // Copies detached from the model (so later edits or an undo can't mutate
  // them); paste re-centres the group's bounding box on the cursor.
  let clipboard: EdItem[] = [];

  function copySelection(): void {
    const sel = selectedBodies();
    if (!sel.length) return;
    clipboard = sel.map((b) => ({ ...b, shape: { ...b.shape }, cam: { ...b.cam } }));
  }
  function pasteClipboard(): void {
    if (!clipboard.length) return;
    // Pasted items keep the layer they were copied from — a camera region can't
    // become a body — so the edit focus follows them rather than dropping them
    // somewhere unclickable.
    if (clipboard[0]!.layer !== activeLayer) setLayer(clipboard[0]!.layer);
    const box = groupBounds(clipboard);
    let delta = pointerWorld().sub(box.min.add(box.max).mul(0.5));
    // Land the group's top-left corner on the grid, as a move does.
    if (snapOn) delta = snapVec(box.min.add(delta)).sub(box.min);
    beginAction();
    addAndSelect(cloneBodies(clipboard, delta));
  }

  // --- disk -----------------------------------------------------------------
  async function refreshLevelList(): Promise<void> {
    try {
      const names = await listLevels();
      loadSel.innerHTML = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = names.length ? "Load…" : "(no saved levels)";
      loadSel.appendChild(placeholder);
      for (const n of names) {
        const o = document.createElement("option");
        o.value = n;
        o.textContent = n;
        loadSel.appendChild(o);
      }
    } catch (e) {
      console.error(e);
    }
  }
  async function doLoad(name: string): Promise<void> {
    cancelAutosave(); // don't write the outgoing model to the incoming name
    try {
      const data = await loadLevel(name);
      model = modelFromDisk(data);
      resetHistory();
      selectedIds.clear();
      currentName = name;
      dirty = false;
      camera.position = model.player.pos;
      rebuildInspector();
      updateTitle();
    } catch (e) {
      alert(`Load failed: ${e}`);
    }
  }
  // --- autosave -------------------------------------------------------------
  // Once a model has a name on disk, every edit is written back, debounced so a
  // drag (or a burst of nudges) collapses into one write. An unnamed model is
  // left alone: the first Save/Save As names the file, and everything after it
  // persists on its own. Writes do not reload the page - the levelApi plugin in
  // vite.config.ts keeps levels/*.json out of HMR.
  const AUTOSAVE_DELAY_MS = 750;
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelAutosave(): void {
    if (autosaveTimer !== null) clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  function scheduleAutosave(): void {
    if (!currentName) return;
    cancelAutosave();
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      void doSave(false, true);
    }, AUTOSAVE_DELAY_MS);
  }

  async function doSave(saveAs: boolean, auto = false): Promise<void> {
    // A queued autosave can fire after New/Delete cleared the name, or after a
    // manual Save already wrote the model. Either way it must be a no-op - and
    // in particular must never reach the "Save as" prompt below.
    if (auto && (!dirty || !currentName)) return;
    let name = currentName;
    if (saveAs || !name) {
      const input = prompt("Save level as (letters, digits, _ and - only):", name ?? "level");
      if (!input) return;
      if (!/^[A-Za-z0-9_-]+$/.test(input)) {
        alert("Invalid name. Use letters, digits, _ and - only.");
        return;
      }
      name = input;
    }
    cancelAutosave();
    // Snapshot what is being written, so edits landing during the request are
    // still seen as unsaved when it returns.
    const isNewFile = name !== currentName;
    const rev = modelRev;
    const data = modelToDisk(model);
    try {
      await saveLevel(name, data);
      currentName = name;
      if (modelRev === rev) dirty = false;
      saveError = null;
      if (isNewFile) await refreshLevelList();
      updateTitle();
    } catch (e) {
      if (!auto) {
        alert(`Save failed: ${e}`);
        return;
      }
      // An autosave failure must not throw a modal dialog at someone mid-drag; the
      // title carries the state and the next edit retries.
      console.error(e);
      saveError = String(e);
      updateTitle();
    }
  }

  // A pending autosave would otherwise be lost on navigation/close; `keepalive`
  // lets the request outlive the page.
  window.addEventListener("pagehide", () => {
    if (autosaveTimer === null || !dirty || !currentName) return;
    cancelAutosave();
    void saveLevel(currentName, modelToDisk(model), { keepalive: true }).catch(() => {});
  });

  // --- canvas input ---------------------------------------------------------
  function pointerScreen(e: MouseEvent): Vec2 {
    const r = canvas.getBoundingClientRect();
    return new Vec2(e.clientX - r.left, e.clientY - r.top);
  }

  // Last pointer position, kept in screen space so it un-projects through the
  // current camera (paste targets where the cursor is *now*, after any zoom or
  // pan). Falls back to the view centre before the mouse has moved.
  let lastPointerScreen: Vec2 | null = null;
  const pointerWorld = (): Vec2 =>
    lastPointerScreen
      ? screenToWorld(camera, lastPointerScreen.x, lastPointerScreen.y)
      : camera.position;

  // Which handle of the selected body (if any) is under the pointer?
  function pickHandle(scr: Vec2): Drag | null {
    const s = selected();
    if (!s) return null;
    const h = computeHandles(camera, s);
    if (h.rotate && scr.distanceTo(h.rotate) <= HANDLE_HIT_PX) return { mode: "rotate", body: s };
    if (h.radius && scr.distanceTo(h.radius) <= HANDLE_HIT_PX) return { mode: "radius", body: s };
    if (s.shape.kind === "rect") {
      const hw = s.shape.w / 2;
      const hh = s.shape.h / 2;
      // Same order as computeHandles: TL, TR, BR, BL.
      const local = [new Vec2(-hw, -hh), new Vec2(hw, -hh), new Vec2(hw, hh), new Vec2(-hw, hh)];
      for (let i = 0; i < h.corners.length; i++) {
        if (scr.distanceTo(h.corners[i]!) <= HANDLE_HIT_PX) {
          // Anchor the diagonally opposite corner so the box grows toward the drag.
          return { mode: "corner", body: s, anchor: toWorld(s, local[(i + 2) % 4]!) };
        }
      }
    }
    return null;
  }

  canvas.addEventListener("mousedown", (e) => {
    if (mode !== "edit") return;
    // Pan is a middle-button drag (right too, as a convenience): the left button
    // draws the rubber-band selection instead.
    if (e.button === 1 || e.button === 2) {
      drag = { mode: "pan", lastScreen: pointerScreen(e) };
      canvas.style.cursor = "grabbing";
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const scr = pointerScreen(e);
    const world = screenToWorld(camera, scr.x, scr.y);
    dragMoved = false;
    dragPushed = false;

    // 1. Handles of the current selection.
    const h = pickHandle(scr);
    if (h) {
      drag = h;
      return;
    }
    // 2. Draw tool: create a new item on the active layer and drag out its size.
    if (tool === "rect" || tool === "circle") {
      beginAction();
      dragPushed = true;
      const start = snapVec(world);
      const isCamera = activeLayer === "camera";
      const style = {
        layer: activeLayer,
        kind: newKind,
        color: isCamera ? CAMERA_REGION_COLOR : DEFAULT_BODY_COLOR,
        opacity: isCamera ? CAMERA_REGION_OPACITY : DEFAULT_BODY_OPACITY,
        friction: DEFAULT_SURFACE_FRICTION,
        // Only meaningful on a force area, but a new one needs a non-zero pull
        // or it would draw no arrows and do nothing until the field is touched.
        force: DEFAULT_FORCE_MAGNITUDE * PX,
        // A fresh region is a no-op until a framing field is authored.
        cam: defaultCamera(),
      };
      const body: EdItem =
        tool === "rect"
          ? { id: newBodyId(), pos: start, rot: 0, shape: { kind: "rect", w: gridStep, h: gridStep }, ...style }
          : { id: newBodyId(), pos: start, rot: 0, shape: { kind: "circle", r: gridStep }, ...style };
      model.items.push(body);
      setSelection([body.id]);
      drag = { mode: "draw", body, start };
      markDirty();
      rebuildInspector();
      return;
    }
    // 3. Player spawn marker (small target — needs pointer within its radius).
    if (world.distanceTo(model.player.pos) <= Math.max(model.player.radius, 12 / (camera.zoom * PIXELS_PER_METER))) {
      drag = { mode: "movePlayer", grab: model.player.pos.sub(world) };
      return;
    }
    // 4. Topmost item under the pointer, on the active layer only — a camera
    // region blankets the geometry it governs, so a click has to mean one or
    // the other, and the layer switch is what says which.
    const pickable = layerItems();
    for (let i = pickable.length - 1; i >= 0; i--) {
      const b = pickable[i]!;
      if (!pointInBody(b, world)) continue;
      if (e.shiftKey) {
        // Shift+click only edits the selection — no drag, so it can't nudge
        // geometry while picking bodies out of a group.
        toggleSelection(b.id);
        drag = null;
        return;
      }
      // Clicking inside an existing multi-selection drags the whole group.
      if (!selectedIds.has(b.id)) setSelection([b.id]);
      const others = selectedBodies()
        .filter((o) => o !== b)
        .map((o) => ({ body: o, offset: o.pos.sub(b.pos) }));
      drag = { mode: "move", lead: b, others, grab: b.pos.sub(world) };
      return;
    }
    // 5. Empty space: rubber-band select. A click that never moves deselects
    // (shift keeps the selection, so a miss doesn't undo the picking so far).
    drag = { mode: "marquee", start: world, current: world, additive: e.shiftKey };
  });

  window.addEventListener("mousemove", (e) => {
    if (mode !== "edit") return;
    const scr = pointerScreen(e);
    lastPointerScreen = scr;
    if (!drag) return;
    const world = screenToWorld(camera, scr.x, scr.y);
    dragMoved = true;

    // Snapshot once, on the first movement of a model-mutating drag (pan and
    // marquee don't touch the model; draw already snapshotted at mousedown).
    if (!dragPushed && drag.mode !== "pan" && drag.mode !== "marquee") {
      beginAction();
      dragPushed = true;
    }

    switch (drag.mode) {
      case "pan": {
        const scale = camera.zoom * PIXELS_PER_METER;
        const d = scr.sub(drag.lastScreen);
        camera.position = camera.position.sub(d.div(scale));
        drag.lastScreen = scr;
        break;
      }
      case "marquee":
        drag.current = world;
        break;
      case "move": {
        // Snap the lead body's corner; the rest keep their relative offsets so
        // a group's internal layout survives the move.
        const lead = snapCorner(drag.lead, world.add(drag.grab));
        drag.lead.pos = lead;
        for (const o of drag.others) o.body.pos = lead.add(o.offset);
        markDirty();
        refreshFields();
        break;
      }
      case "movePlayer":
        model.player.pos = snapVec(world.add(drag.grab));
        markDirty();
        refreshFields();
        break;
      case "draw": {
        const b = drag.body;
        const p = snapVec(world);
        if (b.shape.kind === "rect") {
          const w = Math.max(gridStep, Math.abs(p.x - drag.start.x));
          const h = Math.max(gridStep, Math.abs(p.y - drag.start.y));
          b.shape.w = w;
          b.shape.h = h;
          b.pos = new Vec2((drag.start.x + p.x) / 2, (drag.start.y + p.y) / 2);
        } else {
          b.shape.r = snapLen(drag.start.distanceTo(p));
        }
        markDirty();
        refreshFields();
        break;
      }
      case "corner": {
        const b = drag.body;
        if (b.shape.kind === "rect") {
          // Fixed opposite corner (anchor); the dragged corner follows the
          // pointer. Extents measured in the body's local axes so it works
          // rotated; the anchor stays put and the centre shifts to the midpoint.
          const A = drag.anchor;
          const d = world.sub(A).rotated(-b.rot);
          const w = snapLen(Math.abs(d.x));
          const h = snapLen(Math.abs(d.y));
          const sx = d.x >= 0 ? 1 : -1;
          const sy = d.y >= 0 ? 1 : -1;
          b.shape.w = w;
          b.shape.h = h;
          b.pos = A.add(new Vec2((sx * w) / 2, (sy * h) / 2).rotated(b.rot));
          markDirty();
          refreshFields();
        }
        break;
      }
      case "radius": {
        const b = drag.body;
        if (b.shape.kind === "circle") {
          b.shape.r = snapLen(world.distanceTo(b.pos));
          markDirty();
          refreshFields();
        }
        break;
      }
      case "rotate": {
        const b = drag.body;
        const d = world.sub(b.pos);
        // Local up (0,-1) rotated by rot should point at the pointer.
        b.rot = snapAngle(Math.atan2(d.x, -d.y));
        markDirty();
        refreshFields();
        break;
      }
    }
  });

  // The in-progress rubber-band, as a sorted world-space box (null unless one is
  // actually being dragged out — a click that never moves draws nothing).
  function marqueeRect(): { min: Vec2; max: Vec2 } | null {
    if (!drag || drag.mode !== "marquee" || !dragMoved) return null;
    const { start, current } = drag;
    return {
      min: new Vec2(Math.min(start.x, current.x), Math.min(start.y, current.y)),
      max: new Vec2(Math.max(start.x, current.x), Math.max(start.y, current.y)),
    };
  }

  window.addEventListener("mouseup", () => {
    if (mode !== "edit" || !drag) return;
    if (drag.mode === "marquee") {
      const box = marqueeRect();
      if (box) {
        // Touch semantics: anything the band overlaps is caught.
        const hits = layerItems()
          .filter((b) => bodyIntersectsRect(b, box.min, box.max))
          .map((b) => b.id);
        setSelection(drag.additive ? [...new Set([...selectedIds, ...hits])] : hits);
      } else if (!drag.additive) {
        setSelection([]); // a plain click on empty space clears
      }
    }
    drag = null;
    applyToolCursor();
  });

  canvas.addEventListener("wheel", (e) => {
    if (mode !== "edit") return;
    e.preventDefault();
    const scr = pointerScreen(e);
    const before = screenToWorld(camera, scr.x, scr.y);
    const factor = Math.exp(-e.deltaY * 0.001);
    camera.zoom = Math.min(20, Math.max(0.2, camera.zoom * factor));
    const after = screenToWorld(camera, scr.x, scr.y);
    camera.position = camera.position.add(before.sub(after));
  }, { passive: false });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape") {
      if (mode === "test") stopTest();
      else setSelection([]);
      return;
    }
    if (mode === "test") {
      if (e.code === "KeyP") downloadTestRecording();
      return;
    }
    if (mode !== "edit") return;
    // Ignore shortcuts while a field that consumes keystrokes has focus (let
    // its native editing/undo win). Toggles don't consume them, so clicking the
    // snap checkbox must not leave the editor deaf to shortcuts.
    const focused = e.target;
    const typing =
      (focused instanceof HTMLInputElement &&
        focused.type !== "checkbox" &&
        focused.type !== "radio") ||
      focused instanceof HTMLSelectElement;
    if (typing) return;
    // Arrows before the Ctrl block: Ctrl+Arrow is the fine nudge, not a combo.
    const dir = NUDGE_DIRS[e.code];
    if (dir) {
      nudgeSelection(dir, e.ctrlKey || e.metaKey);
      e.preventDefault(); // don't scroll the page
      return;
    }
    // Modifier combos first: the bare-key tool shortcuts share letters with
    // them (V/C), so Ctrl+V must not also switch tools.
    if (e.ctrlKey || e.metaKey) {
      switch (e.code) {
        case "KeyZ":
          if (e.shiftKey) redo();
          else undo();
          break;
        case "KeyY":
          redo();
          break;
        case "KeyD":
          duplicateSelected();
          break;
        case "KeyC":
          copySelection();
          break;
        case "KeyV":
          pasteClipboard();
          break;
        default:
          return;
      }
      e.preventDefault();
      return;
    }
    if (e.code === "Tab") {
      // Cycle the edit layer. Preventing the default keeps focus on the canvas
      // rather than walking the toolbar.
      const i = ED_LAYERS.indexOf(activeLayer);
      setLayer(ED_LAYERS[(i + 1) % ED_LAYERS.length]!);
      e.preventDefault();
      return;
    }
    if (e.code === "Delete" || e.code === "Backspace") {
      deleteSelected();
      e.preventDefault();
    } else if (e.code === "KeyV") setTool("select");
    else if (e.code === "KeyR") setTool("rect");
    else if (e.code === "KeyC") setTool("circle");
  });

  // Releasing an arrow closes the nudge run, so the next press starts a fresh
  // undo step.
  window.addEventListener("keyup", (e) => {
    if (NUDGE_DIRS[e.code]) nudging = false;
  });

  // --- loop -----------------------------------------------------------------
  let accumulator = 0;
  let lastNow = -1;
  let fps = 0;

  function frame(now: number): void {
    if (mode === "test" && testLevel) {
      if (lastNow < 0) lastNow = now;
      let dt = (now - lastNow) / 1000;
      lastNow = now;
      if (dt > 0.25) dt = 0.25;
      accumulator += dt;
      if (dt > 0) fps += (1 / dt - fps) * 0.1;
      const src: IInputSource = (testLevel instanceof BallLevel ? ballInput : liveInput)!;
      let steps = 0;
      while (accumulator >= STEP && steps < MAX_STEPS) {
        const fi: FrameInput = src.sample();
        testLevel.physicsProcess(fi, STEP);
        recFrames.push(serializeInput(fi));
        recDigests.push(
          testLevel instanceof BallLevel ? digestBall(testLevel) : digest(testLevel),
        );
        accumulator -= STEP;
        steps++;
      }
      // Same camera the game runs (eased follow + the level's camera regions),
      // so a region authored here is tested exactly as it will play.
      // Render interpolation factor, as in main.ts: the sim is a fixed 60 Hz,
      // so bodies are drawn between steps rather than snapping to the newest.
      const alpha = Math.min(1, accumulator / STEP);
      testCameraCtl.update(
        camera,
        dt,
        testLevel.cameraRenderPosition(alpha),
        testLevel.cameraRegions,
        testController === "ball" ? ballZoom(camera.viewportHeight) : GRAPPLE_ZOOM,
      );
      // Render-rate refresh of stick aim (see LiveInputSource.pollAim).
      ballInput?.pollAim();
      liveInput?.pollAim();
      if (testLevel instanceof BallLevel) {
        renderBall(
          ctx,
          dpr,
          cssW,
          cssH,
          testLevel,
          camera,
          fps,
          ballInput?.aimPoint() ?? null,
          alpha,
        );
      } else {
        render(ctx, dpr, cssW, cssH, testLevel, camera, fps, false, liveInput!.gamepadAim(), alpha);
      }
    } else {
      drawEditor(
        ctx,
        dpr,
        cssW,
        cssH,
        camera,
        model,
        selectedIds,
        marqueeRect(),
        activeLayer,
        visibleLayers,
      );
    }
    requestAnimationFrame(frame);
  }

  // --- boot -----------------------------------------------------------------
  camera.position = model.player.pos;
  setLayer("geometry");
  rebuildInspector();
  updateTitle();
  refreshLevelList();
  requestAnimationFrame(frame);
}

// --- DOM helpers ------------------------------------------------------------
function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "ed-btn";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
function checkbox(label: string, initial: boolean, onChange: (v: boolean) => void): HTMLElement {
  const wrap = el("label", "ed-check");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = initial;
  box.addEventListener("change", () => onChange(box.checked));
  wrap.appendChild(box);
  wrap.appendChild(document.createTextNode(label));
  return wrap;
}
function labelWrap(label: string, control: HTMLElement): HTMLElement {
  const wrap = el("label", "ed-inline");
  wrap.appendChild(document.createTextNode(label));
  wrap.appendChild(control);
  return wrap;
}
function heading(text: string): HTMLElement {
  const h = el("div", "ed-heading");
  h.textContent = text;
  return h;
}
// Three decimals: enough for a 0.05 friction or opacity step to survive a
// panel rebuild (1 dp used to redisplay 0.25 as 0.3), and short enough that
// float noise from the metre/pixel round trip rounds away.
function fmt(v: number): string {
  return String(Number(v.toFixed(3)));
}
// A field whose selected bodies disagree shows blank (with a "mixed"
// placeholder) rather than picking one body's value to display.
function fmtOrBlank(v: number | null): string {
  return v === null ? "" : fmt(v);
}

function injectStyles(): void {
  if (document.getElementById("ed-styles")) return;
  const s = document.createElement("style");
  s.id = "ed-styles";
  s.textContent = `
  .ed-root { position: fixed; inset: 0; pointer-events: none; color: #cbccc6;
    font-family: monospace; font-size: 13px; }
  .ed-root button, .ed-root select, .ed-root input, .ed-inspector { pointer-events: auto; }
  .ed-bar { position: absolute; top: 8px; left: 8px; display: flex; flex-direction: column;
    gap: 6px; background: rgba(31,36,48,0.92); border: 1px solid #313244; padding: 8px;
    border-radius: 2px; }
  .ed-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .ed-btn { background: #2a2f3d; color: #cbccc6; border: 1px solid #3c445c;
    padding: 3px 8px; font-family: monospace; font-size: 13px; cursor: pointer;
    border-radius: 2px; }
  .ed-btn:hover { background: #343b4d; }
  .ed-btn.active { border-color: #65bddb; color: #65bddb; }
  .ed-select, .ed-num { background: #1f2430; color: #cbccc6; border: 1px solid #3c445c;
    font-family: monospace; font-size: 13px; padding: 2px 4px; border-radius: 2px; }
  .ed-num { width: 64px; }
  .ed-color { width: 44px; height: 22px; padding: 0; background: #1f2430;
    border: 1px solid #3c445c; border-radius: 2px; cursor: pointer; }
  .ed-inline, .ed-check { display: inline-flex; gap: 4px; align-items: center; color: #9aa0ac; }
  .ed-title { color: #65bddb; padding-top: 2px; }
  .ed-inspector { position: absolute; top: 8px; right: 8px; width: 190px;
    background: rgba(31,36,48,0.92); border: 1px solid #313244; padding: 8px;
    border-radius: 2px; display: flex; flex-direction: column; gap: 10px; }
  .ed-group { display: flex; flex-direction: column; gap: 4px; }
  .ed-heading { color: #65bddb; border-bottom: 1px solid #313244; padding-bottom: 2px; margin-bottom: 2px; }
  .ed-field { display: flex; justify-content: space-between; align-items: center; color: #9aa0ac; }
  .ed-hint { color: #6b7280; line-height: 1.4; }
  .ed-test-banner { position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
    background: rgba(31,36,48,0.92); border: 1px solid #65bddb; color: #65bddb;
    font-family: monospace; font-size: 13px; padding: 4px 12px; border-radius: 2px; z-index: 10; }
  `;
  document.head.appendChild(s);
}
