// Level editor. Owns its own canvas loop and DOM overlay (toolbar + inspector),
// manipulates an EdModel with the mouse, tests the scene with either controller,
// and saves/loads levels from disk through the dev-server API.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER, PX } from "../engine/units";
import {
  ballCameraPosition,
  ballZoom,
  screenToWorld,
  worldToScreen,
  type Camera,
} from "../render/camera";
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
  emptyModel,
  groupBounds,
  halfExtents,
  modelFromDisk,
  modelToDisk,
  newBodyId,
  pointInBody,
  toWorld,
  type EdBody,
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
const BODY_KINDS: BodyKind[] = ["static", "rigid", "killzone", "impermeable", "force"];

type Drag =
  | { mode: "pan"; lastScreen: Vec2; keepSelection: boolean }
  // The lead body follows the pointer (and the grid); the rest of the
  // selection rides along at a fixed offset from it.
  | { mode: "move"; lead: EdBody; others: Array<{ body: EdBody; offset: Vec2 }>; grab: Vec2 }
  | { mode: "movePlayer"; grab: Vec2 }
  | { mode: "corner"; body: EdBody; anchor: Vec2 }
  | { mode: "radius"; body: EdBody }
  | { mode: "rotate"; body: EdBody }
  | { mode: "draw"; body: EdBody; start: Vec2 };

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
  let snapOn = true;
  const gridStep = 0.1; // snap spacing: fixed 10 cm (matches the backdrop minor grid)
  let currentName: string | null = null;
  let dirty = false;
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
    bodies: m.bodies.map((b) => ({ ...b, shape: { ...b.shape } })),
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
    dirty = true;
    const live = new Set(model.bodies.map((b) => b.id));
    for (const id of selectedIds) if (!live.has(id)) selectedIds.delete(id);
    rebuildInspector();
    updateTitle();
  }

  // Model order, so a group keeps its z-order through copy/duplicate.
  const selectedBodies = () => model.bodies.filter((b) => selectedIds.has(b.id));
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
  const snapCorner = (b: EdBody, center: Vec2) => {
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
    updateTitle();
  }

  // --- mode: edit | test ----------------------------------------------------
  let mode: "edit" | "test" = "edit";
  let testLevel: Level | BallLevel | null = null;
  let liveInput: LiveInputSource | null = null;
  let ballInput: BallInputSource | null = null;
  let savedCam: { pos: Vec2; zoom: number } | null = null;

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
    if (controller === "ball") {
      camera.zoom = ballZoom(camera.viewportHeight);
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

  // A resize mid-test re-derives the ball zoom from the new viewport height,
  // matching the game. Registered here rather than inside resize() because the
  // test state it reads is declared below resize()'s first call.
  window.addEventListener("resize", () => {
    if (mode === "test" && testController === "ball") camera.zoom = ballZoom(camera.viewportHeight);
  });

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
  toolRow.append(toolBtns.select, toolBtns.rect, toolBtns.circle, labelWrap("kind", kindSel));

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
    title.textContent = `${currentName ?? "(unsaved)"}${dirty ? " *" : ""} · ${model.bodies.length} bodies`;
  }
  function setTool(t: Tool): void {
    tool = t;
    for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle("active", k === t);
    canvas.style.cursor = t === "select" ? "default" : "crosshair";
  }
  setTool("select");

  // --- inspector build ------------------------------------------------------
  const fields: Array<{ input: HTMLInputElement; get: () => number; set: (v: number) => void }> = [];

  function numField(
    parent: HTMLElement,
    label: string,
    get: () => number,
    set: (v: number) => void,
    step = 1,
  ): void {
    const wrap = el("label", "ed-field");
    wrap.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "ed-num";
    input.step = String(step);
    input.value = fmt(get());
    // One undo step per editing session (snapshot on focus, before any edit).
    input.addEventListener("focus", () => beginAction());
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) {
        set(v);
        markDirty();
      }
    });
    wrap.appendChild(input);
    parent.appendChild(wrap);
    fields.push({ input, get, set });
  }

  function rebuildInspector(): void {
    fields.length = 0;
    inspector.innerHTML = "";
    const s = selected();

    const player = el("div", "ed-group");
    player.appendChild(heading("Player spawn"));
    numField(player, "x", () => model.player.pos.x * M2PX, (v) => (model.player.pos = model.player.pos.withX(v * PX)));
    numField(player, "y", () => model.player.pos.y * M2PX, (v) => (model.player.pos = model.player.pos.withY(v * PX)));
    numField(player, "radius", () => model.player.radius * M2PX, (v) => (model.player.radius = Math.max(1, v) * PX));
    inspector.appendChild(player);

    if (!s) {
      if (selectedIds.size > 1) {
        // Geometry fields are per-body, so a group only gets the ops that make
        // sense for all of it at once.
        const g = el("div", "ed-group");
        g.appendChild(heading(`${selectedIds.size} bodies selected`));
        const hint = el("div", "ed-hint");
        hint.textContent =
          "Drag to move them together. Shift+click to add/remove. Ctrl+C copies, Ctrl+V pastes at the cursor.";
        g.appendChild(hint);
        const row = el("div", "ed-row");
        row.append(
          button("Duplicate", () => duplicateSelected()),
          button("Delete", () => deleteSelected()),
        );
        g.appendChild(row);
        inspector.appendChild(g);
        return;
      }
      const hint = el("div", "ed-hint");
      hint.textContent = "No selection. Click a body, or pick +Rect / +Circle and drag on the canvas.";
      inspector.appendChild(hint);
      return;
    }

    const g = el("div", "ed-group");
    g.appendChild(heading(`Body #${s.id}`));

    const kw = el("label", "ed-field");
    kw.textContent = "kind";
    const ks = document.createElement("select");
    ks.className = "ed-select";
    for (const k of BODY_KINDS) {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = k;
      ks.appendChild(o);
    }
    ks.value = s.kind;
    ks.addEventListener("change", () => {
      beginAction();
      s.kind = ks.value as BodyKind;
      markDirty();
      // Which fields apply depends on the kind (force magnitude, friction), so
      // the panel has to be rebuilt rather than just revalued.
      rebuildInspector();
    });
    kw.appendChild(ks);
    g.appendChild(kw);

    // Areas are regions, not surfaces: nothing rests on them, so they carry no
    // friction. A force area does carry a direction, hence a rot° even when it
    // is a circle (whose rotation is otherwise invisible).
    const isArea = s.kind === "killzone" || s.kind === "force";

    numField(g, "x", () => s.pos.x * M2PX, (v) => (s.pos = s.pos.withX(v * PX)));
    numField(g, "y", () => s.pos.y * M2PX, (v) => (s.pos = s.pos.withY(v * PX)));
    if (s.shape.kind === "rect" || s.kind === "force") {
      numField(g, "rot°", () => (s.rot * 180) / Math.PI, (v) => (s.rot = (v * Math.PI) / 180));
    }
    if (s.shape.kind === "rect") {
      numField(g, "w", () => s.shape.kind === "rect" ? s.shape.w * M2PX : 0, (v) => {
        if (s.shape.kind === "rect") s.shape.w = Math.max(1, v) * PX;
      });
      numField(g, "h", () => s.shape.kind === "rect" ? s.shape.h * M2PX : 0, (v) => {
        if (s.shape.kind === "rect") s.shape.h = Math.max(1, v) * PX;
      });
    } else {
      numField(g, "radius", () => s.shape.kind === "circle" ? s.shape.r * M2PX : 0, (v) => {
        if (s.shape.kind === "circle") s.shape.r = Math.max(1, v) * PX;
      });
    }
    if (s.kind === "force") {
      // Acceleration along rot°, authored in px/s² like every other length.
      // Negative reverses the flow, so it is deliberately not clamped at 0.
      numField(g, "force", () => s.force * M2PX, (v) => (s.force = v * PX), 50);
    }
    if (!isArea) {
      numField(g, "friction", () => s.friction, (v) => (s.friction = Math.min(1, Math.max(0, v))), 0.1);
    }

    const cw = el("label", "ed-field");
    cw.textContent = "color";
    const ci = document.createElement("input");
    ci.type = "color";
    ci.className = "ed-color";
    ci.value = s.color;
    ci.addEventListener("focus", () => beginAction());
    ci.addEventListener("input", () => {
      s.color = ci.value;
      markDirty();
    });
    cw.appendChild(ci);
    g.appendChild(cw);
    numField(g, "opacity", () => s.opacity, (v) => (s.opacity = Math.min(1, Math.max(0, v))), 0.1);

    const row = el("div", "ed-row");
    row.append(
      button("Duplicate", () => duplicateSelected()),
      button("Delete", () => deleteSelected()),
    );
    g.appendChild(row);
    inspector.appendChild(g);
  }

  // Refresh field values after a canvas drag, without disturbing a focused input.
  function refreshFields(): void {
    for (const f of fields) {
      if (document.activeElement === f.input) continue;
      f.input.value = fmt(f.get());
    }
  }

  // --- editing ops ----------------------------------------------------------
  // Detached copies of the given bodies, each with a fresh id and shifted by
  // `offset`. Shapes are mutated in place, so clone them.
  const cloneBodies = (bodies: readonly EdBody[], offset: Vec2): EdBody[] =>
    bodies.map((b) => ({ ...b, id: newBodyId(), pos: b.pos.add(offset), shape: { ...b.shape } }));

  // Add freshly created bodies to the model and leave them selected, so the
  // group can immediately be dragged or pasted again.
  function addAndSelect(bodies: EdBody[]): void {
    model.bodies.push(...bodies);
    selectedIds.clear();
    for (const b of bodies) selectedIds.add(b.id);
    markDirty();
    rebuildInspector();
  }

  function deleteSelected(): void {
    if (!selectedIds.size) return;
    beginAction();
    model.bodies = model.bodies.filter((b) => !selectedIds.has(b.id));
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
  let clipboard: EdBody[] = [];

  function copySelection(): void {
    const sel = selectedBodies();
    if (!sel.length) return;
    clipboard = sel.map((b) => ({ ...b, shape: { ...b.shape } }));
  }
  function pasteClipboard(): void {
    if (!clipboard.length) return;
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
  async function doSave(saveAs: boolean): Promise<void> {
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
    try {
      await saveLevel(name, modelToDisk(model));
      currentName = name;
      dirty = false;
      await refreshLevelList();
      updateTitle();
    } catch (e) {
      alert(`Save failed: ${e}`);
    }
  }

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
    if (e.button === 1 || e.button === 2) {
      drag = { mode: "pan", lastScreen: pointerScreen(e), keepSelection: true };
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
    // 2. Draw tool: create a new body and drag out its size.
    if (tool === "rect" || tool === "circle") {
      beginAction();
      dragPushed = true;
      const start = snapVec(world);
      const style = {
        color: DEFAULT_BODY_COLOR,
        opacity: DEFAULT_BODY_OPACITY,
        friction: DEFAULT_SURFACE_FRICTION,
        // Only meaningful on a force area, but a new one needs a non-zero pull
        // or it would draw no arrows and do nothing until the field is touched.
        force: DEFAULT_FORCE_MAGNITUDE * PX,
      };
      const body: EdBody =
        tool === "rect"
          ? { id: newBodyId(), kind: newKind, pos: start, rot: 0, shape: { kind: "rect", w: gridStep, h: gridStep }, ...style }
          : { id: newBodyId(), kind: newKind, pos: start, rot: 0, shape: { kind: "circle", r: gridStep }, ...style };
      model.bodies.push(body);
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
    // 4. Topmost body under the pointer.
    for (let i = model.bodies.length - 1; i >= 0; i--) {
      const b = model.bodies[i]!;
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
    // 5. Empty space: pan, and deselect if it turns out to be a click (shift
    // keeps the selection so a miss doesn't undo the picking so far).
    drag = { mode: "pan", lastScreen: scr, keepSelection: e.shiftKey };
  });

  window.addEventListener("mousemove", (e) => {
    if (mode !== "edit") return;
    const scr = pointerScreen(e);
    lastPointerScreen = scr;
    if (!drag) return;
    const world = screenToWorld(camera, scr.x, scr.y);
    dragMoved = true;

    // Snapshot once, on the first movement of a model-mutating drag (pan does
    // not touch the model; draw already snapshotted at mousedown).
    if (!dragPushed && drag.mode !== "pan") {
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

  window.addEventListener("mouseup", () => {
    if (mode !== "edit" || !drag) return;
    if (drag.mode === "pan" && !dragMoved && !drag.keepSelection) setSelection([]);
    drag = null;
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
      camera.position =
        testLevel instanceof BallLevel
          ? ballCameraPosition(camera, testLevel.cameraPosition)
          : testLevel.cameraPosition;
      if (testLevel instanceof BallLevel) {
        renderBall(ctx, dpr, cssW, cssH, testLevel, camera, fps, ballInput?.aimPoint() ?? null);
      } else {
        render(ctx, dpr, cssW, cssH, testLevel, camera, fps, false, liveInput!.gamepadAim());
      }
    } else {
      drawEditor(ctx, dpr, cssW, cssH, camera, model, selectedIds);
    }
    requestAnimationFrame(frame);
  }

  // --- boot -----------------------------------------------------------------
  camera.position = model.player.pos;
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
function fmt(v: number): string {
  return (Math.round(v * 10) / 10).toString();
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
