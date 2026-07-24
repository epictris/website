// Level editor. Owns its own canvas loop and DOM overlay (toolbar + inspector),
// manipulates an EdModel with the mouse, tests the scene with either controller,
// and saves/loads levels from disk through the dev-server API.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { screenToWorld, worldToScreen, type Camera } from "../render/camera";
import { render, renderBall } from "../render/renderer";
import { Level } from "../level/level";
import { BallLevel } from "../level/ballLevel";
import { LiveInputSource } from "../input/liveInput";
import { BallInputSource } from "../input/ballInput";
import type { FrameInput, IInputSource } from "../input/frameInput";
import { DEFAULT_BODY_COLOR, DEFAULT_BODY_OPACITY, type BodyKind } from "../level/levelFormat";
import {
  emptyModel,
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

type Tool = "select" | "rect" | "circle";

type Drag =
  | { mode: "pan"; lastScreen: Vec2 }
  | { mode: "move"; body: EdBody; grab: Vec2 }
  | { mode: "movePlayer"; grab: Vec2 }
  | { mode: "corner"; body: EdBody; anchor: Vec2 }
  | { mode: "radius"; body: EdBody }
  | { mode: "rotate"; body: EdBody }
  | { mode: "draw"; body: EdBody; start: Vec2 };

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
  let selectedId: number | null = null;
  let tool: Tool = "select";
  let newKind: BodyKind = "static";
  let snapOn = true;
  const gridStep = 0.1; // snap spacing: fixed 10 cm (matches the backdrop minor grid)
  let currentName: string | null = null;
  let dirty = false;
  let drag: Drag | null = null;
  let dragMoved = false;
  let dragPushed = false; // history snapshot taken for the in-progress drag?

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
    dirty = true;
    if (!model.bodies.some((b) => b.id === selectedId)) selectedId = null;
    rebuildInspector();
    updateTitle();
  }

  const selected = () => model.bodies.find((b) => b.id === selectedId) ?? null;
  const snap = (v: number) => (snapOn ? Math.round(v / gridStep) * gridStep : v);
  const snapVec = (v: Vec2) => new Vec2(snap(v.x), snap(v.y));
  // Snap a shape dimension (width/height/radius) to the grid, never below one cell.
  const snapLen = (v: number) => Math.max(gridStep, snap(v));
  // Centre → top-left offset of a body's (axis-aligned) bounding box, so moves
  // snap the top-left corner to the grid rather than the centre.
  const cornerOffset = (b: EdBody) =>
    b.shape.kind === "circle"
      ? new Vec2(b.shape.r, b.shape.r)
      : new Vec2(b.shape.w / 2, b.shape.h / 2);
  // Snap a would-be centre so the body's top-left corner lands on the grid.
  const snapCorner = (b: EdBody, center: Vec2) => {
    const off = cornerOffset(b);
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

  function startTest(controller: "grapple" | "ball"): void {
    if (mode === "test") stopTest();
    const pixelData = modelToDisk(model);
    savedCam = { pos: camera.position, zoom: camera.zoom };
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
    canvas.style.cursor = "crosshair";
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
    model = emptyModel();
    resetHistory();
    selectedId = null;
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
  for (const k of ["static", "rigid", "killzone", "impermeable"] as BodyKind[]) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k;
    kindSel.appendChild(o);
  }
  kindSel.value = newKind;
  kindSel.title = "Kind for new bodies (and the selected body)";
  kindSel.addEventListener("change", () => {
    newKind = kindSel.value as BodyKind;
    const s = selected();
    if (s) {
      beginAction();
      s.kind = newKind;
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
    for (const k of ["static", "rigid", "killzone", "impermeable"] as BodyKind[]) {
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
    });
    kw.appendChild(ks);
    g.appendChild(kw);

    numField(g, "x", () => s.pos.x * M2PX, (v) => (s.pos = s.pos.withX(v * PX)));
    numField(g, "y", () => s.pos.y * M2PX, (v) => (s.pos = s.pos.withY(v * PX)));
    if (s.shape.kind === "rect") {
      numField(g, "rot°", () => (s.rot * 180) / Math.PI, (v) => (s.rot = (v * Math.PI) / 180));
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
  function deleteSelected(): void {
    if (selectedId == null) return;
    beginAction();
    model.bodies = model.bodies.filter((b) => b.id !== selectedId);
    selectedId = null;
    markDirty();
    rebuildInspector();
  }
  function duplicateSelected(): void {
    const s = selected();
    if (!s) return;
    beginAction();
    const copy: EdBody = {
      ...s,
      id: newBodyId(),
      pos: s.pos.add(new Vec2(gridStep * 2, gridStep * 2)),
      shape: { ...s.shape },
    };
    model.bodies.push(copy);
    selectedId = copy.id;
    markDirty();
    rebuildInspector();
  }
  function select(id: number | null): void {
    if (id === selectedId) return;
    selectedId = id;
    rebuildInspector();
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
      selectedId = null;
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
      drag = { mode: "pan", lastScreen: pointerScreen(e) };
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
      const style = { color: DEFAULT_BODY_COLOR, opacity: DEFAULT_BODY_OPACITY };
      const body: EdBody =
        tool === "rect"
          ? { id: newBodyId(), kind: newKind, pos: start, rot: 0, shape: { kind: "rect", w: gridStep, h: gridStep }, ...style }
          : { id: newBodyId(), kind: newKind, pos: start, rot: 0, shape: { kind: "circle", r: gridStep }, ...style };
      model.bodies.push(body);
      selectedId = body.id;
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
      if (pointInBody(b, world)) {
        select(b.id);
        drag = { mode: "move", body: b, grab: b.pos.sub(world) };
        return;
      }
    }
    // 5. Empty space: pan, and deselect if it turns out to be a click.
    drag = { mode: "pan", lastScreen: scr };
  });

  window.addEventListener("mousemove", (e) => {
    if (mode !== "edit" || !drag) return;
    const scr = pointerScreen(e);
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
      case "move":
        drag.body.pos = snapCorner(drag.body, world.add(drag.grab));
        markDirty();
        refreshFields();
        break;
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
    if (drag.mode === "pan" && !dragMoved) select(null);
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
      else select(null);
      return;
    }
    if (mode !== "edit") return;
    // Ignore shortcuts while typing in a field (let the field's native undo win).
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === "KeyZ" && (e.ctrlKey || e.metaKey)) {
      if (e.shiftKey) redo();
      else undo();
      e.preventDefault();
    } else if (e.code === "KeyY" && (e.ctrlKey || e.metaKey)) {
      redo();
      e.preventDefault();
    } else if (e.code === "Delete" || e.code === "Backspace") {
      deleteSelected();
      e.preventDefault();
    } else if (e.code === "KeyV") setTool("select");
    else if (e.code === "KeyR") setTool("rect");
    else if (e.code === "KeyC") setTool("circle");
    else if (e.code === "KeyD" && (e.ctrlKey || e.metaKey)) {
      duplicateSelected();
      e.preventDefault();
    }
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
        accumulator -= STEP;
        steps++;
      }
      camera.position = testLevel.cameraPosition;
      if (testLevel instanceof BallLevel) {
        renderBall(ctx, dpr, cssW, cssH, testLevel, camera, fps);
      } else {
        render(ctx, dpr, cssW, cssH, testLevel, camera, fps, false, liveInput!.gamepadAim());
      }
    } else {
      drawEditor(ctx, dpr, cssW, cssH, camera, model, selectedId);
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
