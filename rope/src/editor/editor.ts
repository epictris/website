// Level editor. Owns its own canvas loop and DOM overlay (toolbar + inspector),
// manipulates an EdModel with the mouse, tests the scene with either controller,
// and saves/loads levels from disk through the dev-server API.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { ballZoom, GRAPPLE_ZOOM, screenToWorld, worldToScreen, type Camera } from "../render/camera";
import {
  CAMERA_BLEND_TIME,
  CameraController,
  REGION_EXIT_MARGIN,
} from "../render/cameraController";
import { render, renderBall } from "../render/renderer";
import { Level } from "../level/level";
import { BallLevel } from "../level/ballLevel";
import { LiveInputSource } from "../input/liveInput";
import { BallInputSource } from "../input/ballInput";
import type { FrameInput, IInputSource } from "../input/frameInput";
import {
  DEFAULT_FORCE_MAGNITUDE,
  DEFAULT_SURFACE_FRICTION,
  type BodyKind,
} from "../level/levelFormat";
import {
  arrowEnds,
  bodyIntersectsRect,
  chainEnds,
  chainEndWorld,
  cloneChain,
  cloneShape,
  convexHull,
  bodyWithinRect,
  defaultCamera,
  defaultNote,
  distanceToChain,
  ED_LAYERS,
  emptyModel,
  groupBounds,
  groupCentroid,
  groupMembers,
  halfExtents,
  isArrowNote,
  LAYER_STYLE,
  MIN_ARROW_LENGTH,
  modelFromDisk,
  modelToDisk,
  newBodyId,
  NOTE_ARROW_BAND,
  NOTE_DEFAULT_ARROW_LENGTH,
  NOTE_DEFAULT_SIZE,
  nearestSurfaceLocal,
  pickGroupOf,
  pointInBody,
  rotateGroupAbout,
  setArrowEnds,
  setPolyVerts,
  syncGroupProps,
  toWorld,
  type EdChain,
  type EdItem,
  type EdLayer,
  type EdModel,
} from "./model";
import {
  computeChainHandles,
  computeGroupHandles,
  computeHandles,
  drawEditor,
  CHAIN_DEFAULT_COLOR,
  CHAIN_HIT_PX,
  HANDLE_HIT_PX,
} from "./render";
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

type Tool = "select" | "rect" | "circle" | "poly" | "text" | "arrow" | "chain";

// Which tools each layer offers. A shape tool has no meaning on the notes layer
// (a note is a text box or an arrow, never a circle) and vice versa, so the
// toolbar shows only the applicable ones and switching layer drops a tool that
// no longer applies. `+Chain` is geometry-only: a chain is strung between two
// bodies, and no other layer has any.
const LAYER_TOOLS: Record<EdLayer, Tool[]> = {
  background: ["select", "rect", "circle", "poly"],
  geometry: ["select", "rect", "circle", "poly", "chain"],
  camera: ["select", "rect", "circle", "poly"],
  notes: ["select", "text", "arrow"],
};

// Kinds a chain may be tied to. An area is a region, not a body - nothing hangs
// off a killzone or a current - so the chain tool passes straight through one.
const CHAINABLE_KINDS: BodyKind[] = ["static", "impermeable", "anchor", "rigid"];
const chainable = (b: EdItem): boolean =>
  b.layer === "geometry" && CHAINABLE_KINDS.includes(b.kind);

// What the inspector says when nothing is selected: what the active layer is
// for, and how to put something on it.
const EMPTY_HINTS: Record<EdLayer, string> = {
  background:
    "Background layer. Decoration drawn behind the level, with nothing to collide with, wrap or stand on. Pick +Rect / +Circle and drag one out, or +Poly and click out an outline. Tab switches layer.",
  geometry:
    "No selection. Click a body, or pick +Rect / +Circle and drag on the canvas; +Poly clicks out a convex outline (Enter or click the first vertex to close, Esc to cancel). +Chain drags a chain from one body to another. Ctrl+G welds several shapes into one compound body (Ctrl+Shift+G splits it; Alt+click picks one piece out). Rubber-band from empty space: drag left→right to catch what the box encloses, right→left for anything it touches. Any visible layer can be selected.",
  camera:
    "Camera layer. Click a region, drag to rubber-band select, or pick +Rect / +Circle and drag one out (+Poly clicks out an outline). Tab switches layer.",
  notes:
    "Notes layer. +Text drops a box to type into, +Arrow drags a pointer out. Notes are editor-only and never appear in play. Tab switches layer.",
};

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
  // One vertex of a convex polygon follows the pointer. `accepted` is the last
  // position the loop stayed convex at, so a drag that would dent the shape
  // stalls there instead of writing a concave polygon the rope cannot wrap.
  | { mode: "polyVertex"; body: EdItem; index: number; accepted: Vec2 }
  // One end of an arrow note follows the pointer; the other stays put.
  | { mode: "arrowEnd"; body: EdItem; fixed: Vec2; movingIsHead: boolean }
  // A whole compound body turns about its centre of mass - the point its built
  // body's origin sits at, so the drag is the body's own rotation and not a
  // per-piece one. `grabAngle` is where the pointer was when the drag started,
  // so the group turns by how far the pointer has swung rather than snapping its
  // (arbitrary) first member's angle to the cursor.
  | { mode: "rotateGroup"; items: EdItem[]; centre: Vec2; grabAngle: number; applied: number }
  // Stringing a new chain out from a body: the anchor is fixed in `from`'s local
  // frame, and the free end follows the pointer until it is dropped on a body.
  | { mode: "chainDraw"; from: EdItem; local: Vec2; cursor: Vec2 }
  // Re-anchoring one end of an existing chain. It follows the pointer and lands
  // on whatever body it is dropped on, so moving a chain end and moving it to a
  // different body are one gesture.
  | { mode: "chainEnd"; chain: EdChain; end: "a" | "b"; cursor: Vec2 }
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
  // Chains carry their own selection, and the two are mutually exclusive: a
  // chain has no shape, no placement and no properties in common with an item,
  // so a mixed selection would have nothing an inspector panel could say about
  // it and nothing a nudge or a resize could mean.
  const selectedChainIds = new Set<number>();
  let tool: Tool = "select";
  let newKind: BodyKind = "static";
  // Layers. Every *visible* layer is hit-testable, so a selection may span them
  // and the inspector shows one panel per layer it contains. The active layer is
  // what new items are drawn onto, and it breaks the pick: a camera region
  // blankets the geometry it governs, so a click that could mean either takes
  // the active layer's item. Hidden layers are excluded from picking entirely —
  // an item that cannot be seen must not be selectable.
  let activeLayer: EdLayer = "geometry";
  const visibleLayers = new Set<EdLayer>(ED_LAYERS);
  // Locked layers still draw — that is the point, they are the reference you are
  // working against — but nothing on them can be picked, drawn or edited. Lock
  // and visibility are independent: one keeps a layer out of the way, the other
  // keeps it on screen and out of harm's way.
  const lockedLayers = new Set<EdLayer>();
  let snapOn = true;
  const gridStep = 0.1; // snap spacing: fixed 10 cm (matches the backdrop minor grid)
  let currentName: string | null = null;
  let dirty = false;
  // Bumped by every model edit, so a save that started before an edit knows not
  // to clear `dirty` on a model that has moved on under it.
  let modelRev = 0;
  let saveError: string | null = null;
  let drag: Drag | null = null;
  // Vertices clicked out so far for a polygon in progress, in world metres.
  // Drawing a polygon is a run of clicks rather than one drag, so it needs state
  // that outlives a mouse gesture — unlike every other tool.
  let polyDraft: Vec2[] | null = null;
  let dragMoved = false;
  let dragPushed = false; // history snapshot taken for the in-progress drag?
  let nudging = false; // arrow-key run in progress? (coalesces into one undo step)

  // --- undo/redo ------------------------------------------------------------
  // Snapshots of the whole model. Shapes, camera framing and note bodies are
  // mutated in place, so clone them; Vec2 is immutable, so its refs are safe to
  // share.
  const HISTORY_MAX = 50; // undo steps retained
  const history: EdModel[] = [];
  const future: EdModel[] = [];
  const snapshot = (m: EdModel): EdModel => ({
    player: { pos: m.player.pos, radius: m.player.radius },
    items: m.items.map((b) => ({
      ...b,
      shape: cloneShape(b.shape),
      cam: { ...b.cam },
      note: { ...b.note },
    })),
    chains: m.chains.map(cloneChain),
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
    const liveChains = new Set(model.chains.map((c) => c.id));
    for (const id of selectedChainIds) if (!liveChains.has(id)) selectedChainIds.delete(id);
    rebuildInspector();
    markDirty(); // an undo/redo is a change like any other - it autosaves too
  }

  // Model order, so a group keeps its z-order through copy/duplicate.
  const selectedBodies = () => model.items.filter((b) => selectedIds.has(b.id));
  // The items a click or a rubber-band may touch: everything on a layer that is
  // both visible and unlocked.
  const pickableItems = () =>
    model.items.filter((b) => visibleLayers.has(b.layer) && !lockedLayers.has(b.layer));
  // The same set in click order, bottom-first (callers walk it backwards to take
  // the topmost hit): draw order — layer, then model order — with the active
  // layer lifted above the rest, so a camera region drawn over a wall does not
  // swallow the click while geometry is the layer being edited.
  const pickOrder = (): EdItem[] =>
    pickableItems()
      .map((b, i) => ({ b, i }))
      .sort(
        (p, q) =>
          Number(p.b.layer === activeLayer) - Number(q.b.layer === activeLayer) ||
          ED_LAYERS.indexOf(p.b.layer) - ED_LAYERS.indexOf(q.b.layer) ||
          p.i - q.i,
      )
      .map((p) => p.b);
  const selected = () => (selectedIds.size === 1 ? selectedBodies()[0] ?? null : null);
  const selectedChains = () => model.chains.filter((c) => selectedChainIds.has(c.id));
  function setSelection(ids: readonly number[]): void {
    const unchanged =
      ids.length === selectedIds.size &&
      ids.every((id) => selectedIds.has(id)) &&
      selectedChainIds.size === 0;
    if (unchanged) return;
    selectedIds.clear();
    selectedChainIds.clear();
    for (const id of ids) selectedIds.add(id);
    nudging = false;
    rebuildInspector();
  }
  function setChainSelection(ids: readonly number[]): void {
    selectedIds.clear();
    selectedChainIds.clear();
    for (const id of ids) selectedChainIds.add(id);
    nudging = false;
    rebuildInspector();
  }
  function toggleSelection(id: number): void {
    selectedChainIds.clear();
    if (!selectedIds.delete(id)) selectedIds.add(id);
    nudging = false;
    rebuildInspector();
  }
  // The items a click on `hit` selects: its whole compound body, since a group
  // IS one body. Alt reaches past that to the single piece, which is what the
  // per-vertex and per-shape edits need.
  const clickTargets = (hit: EdItem, alt: boolean): EdItem[] =>
    alt ? [hit] : pickGroupOf(model.items, hit);
  // Expand a set of item ids so no group is ever half-selected - a rubber band
  // that touches one piece of a body has touched the body.
  function withWholeGroups(ids: Iterable<number>): number[] {
    const out = new Set<number>(ids);
    const groups = new Set<number>();
    for (const b of model.items) if (out.has(b.id) && b.group !== null) groups.add(b.group);
    for (const b of model.items) if (b.group !== null && groups.has(b.group)) out.add(b.id);
    return [...out];
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

  // `spawn` (world metres) overrides the level's own spawn marker for this run
  // only — the model is untouched, so a spot-check from the cursor never edits
  // the level. It is baked into the data the test level is built from, so a
  // reset (and the exported bundle) respawns at the same place.
  function startTest(controller: "grapple" | "ball", spawn?: Vec2): void {
    if (mode === "test") stopTest();
    const pixelData = modelToDisk(model);
    if (spawn) {
      pixelData.player = { ...pixelData.player, x: spawn.x * M2PX, y: spawn.y * M2PX };
    }
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
    testLevel.onReset = () => startTest(controller, spawn);
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
    poly: button("+ Poly", () => setTool("poly")),
    text: button("+ Text", () => setTool("text")),
    arrow: button("+ Arrow", () => setTool("arrow")),
    chain: button("+ Chain", () => setTool("chain")),
  };
  toolBtns.chain.title = "Drag from one body to another to string a chain between them";
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
  toolBtns.poly.title = "Click out a convex outline; Enter or the first vertex closes it, Esc cancels";
  toolRow.append(
    toolBtns.select,
    toolBtns.rect,
    toolBtns.circle,
    toolBtns.poly,
    toolBtns.text,
    toolBtns.arrow,
    toolBtns.chain,
    kindWrap,
  );

  // Layer list: which layer is being edited (Tab cycles), plus a visibility
  // toggle each. Visibility is independent of active — a hidden active layer
  // would be an invisible edit target, so hiding one also moves the edit focus.
  // It stacks vertically, with the visibility boxes in a column down the left:
  // a layer stack is a fixed, ordered set you read down, not a row of toolbar
  // buttons, and one row per layer leaves room for a name of any length.
  const layerList = el("div", "ed-layers");
  bar.appendChild(layerList);
  const layerHeading = el("div", "ed-layer-label");
  layerHeading.textContent = "layer";
  layerList.appendChild(layerHeading);
  const layerBtns = {} as Record<EdLayer, HTMLButtonElement>;
  const layerEyes = {} as Record<EdLayer, HTMLButtonElement>;
  const layerLocks = {} as Record<EdLayer, HTMLButtonElement>;
  for (const l of ED_LAYERS) {
    const row = el("div", "ed-layer-row");
    const eye = document.createElement("button");
    eye.className = "ed-eye";
    eye.addEventListener("click", () => setLayerVisible(l, !visibleLayers.has(l)));
    layerEyes[l] = eye;
    const lock = document.createElement("button");
    lock.className = "ed-eye ed-lock";
    lock.addEventListener("click", () => setLayerLocked(l, !lockedLayers.has(l)));
    layerLocks[l] = lock;
    const b = button(l, () => setLayer(l));
    b.classList.add("ed-layer-btn");
    b.title = `Edit the ${l} layer (Tab cycles)`;
    layerBtns[l] = b;
    row.append(eye, lock, b);
    layerList.appendChild(row);
    setLayerVisible(l, true); // paints the icon and its tooltip
    setLayerLocked(l, false); // ditto
  }

  // Show or hide a layer. Hiding everything would leave a blank canvas nothing
  // can be clicked on, so the last visible layer refuses to go; hiding the one
  // being edited moves the edit focus rather than leaving an invisible target.
  function setLayerVisible(l: EdLayer, visible: boolean): void {
    if (!visible && visibleLayers.size === 1) return;
    if (visible) visibleLayers.add(l);
    else visibleLayers.delete(l);
    const eye = layerEyes[l];
    eye.innerHTML = eyeIcon(visible);
    eye.classList.toggle("off", !visible);
    eye.title = `${visible ? "Hide" : "Show"} the ${l} layer`;
    eye.setAttribute("aria-pressed", String(visible));
    if (!visible) {
      // Nothing hidden stays selected: it can no longer be seen or clicked, but
      // a nudge, an inspector edit or a Delete would still reach it.
      let dropped = false;
      for (const b of model.items) {
        if (b.layer === l && selectedIds.delete(b.id)) dropped = true;
      }
      if (dropped) rebuildInspector();
    }
    if (!visible && activeLayer === l) {
      setLayer(ED_LAYERS.find((o) => visibleLayers.has(o))!);
    }
  }

  // Lock or unlock a layer. A locked layer keeps drawing and keeps its place in
  // the stack; what it loses is every edit path — picking, drawing into it, and
  // any selection it was part of, since a selected item on it would still be
  // reached by a nudge, an inspector field or a Delete.
  function setLayerLocked(l: EdLayer, locked: boolean): void {
    if (locked) lockedLayers.add(l);
    else lockedLayers.delete(l);
    const lock = layerLocks[l];
    lock.innerHTML = lockIcon(locked);
    lock.classList.toggle("on", locked);
    lock.title = `${locked ? "Unlock" : "Lock"} the ${l} layer`;
    lock.setAttribute("aria-pressed", String(locked));
    if (locked) {
      let dropped = false;
      for (const b of model.items) {
        if (b.layer === l && selectedIds.delete(b.id)) dropped = true;
      }
      if (dropped) rebuildInspector();
    }
    // The toolbar has to stop offering what the layer no longer accepts.
    if (l === activeLayer) refreshToolButtons();
  }

  // Which draw tools the toolbar offers: the active layer's own set, and none at
  // all while it is locked. An armed tool the new state cannot draw falls back to
  // Select rather than lingering as a lit dead button.
  function refreshToolButtons(): void {
    const tools: Tool[] = lockedLayers.has(activeLayer) ? ["select"] : LAYER_TOOLS[activeLayer];
    for (const [k, b] of Object.entries(toolBtns)) {
      b.style.display = tools.includes(k as Tool) ? "" : "none";
    }
    if (!tools.includes(tool)) setTool("select");
  }

  function setLayer(l: EdLayer): void {
    if (!visibleLayers.has(l)) setLayerVisible(l, true);
    activeLayer = l;
    // The selection survives: every visible layer is pickable, so items on the
    // outgoing layer are still selectable and still shown by the inspector.
    for (const [k, b] of Object.entries(layerBtns)) b.classList.toggle("active", k === l);
    // `kind` is a geometry property; a camera region and a note have none.
    kindWrap.style.display = l === "geometry" ? "" : "none";
    refreshToolButtons();
    rebuildInspector();
  }

  const testRow = el("div", "ed-row");
  bar.appendChild(testRow);
  const btnTestBall = button("▶ Test Ball", () => startTest("ball"));
  btnTestBall.title = "Test from the level's spawn (B tests from the cursor)";
  testRow.append(button("▶ Test Grapple", () => startTest("grapple")), btnTestBall);
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
    const count = (l: EdLayer) => model.items.filter((i) => i.layer === l).length;
    // Only the layers that have anything on them are named, so the title stays
    // short on a level that only uses geometry.
    const groups = new Set(
      model.items.filter((i) => i.group !== null).map((i) => i.group),
    ).size;
    const extra =
      ([
        ["background", "bg"],
        ["camera", "cam"],
        ["notes", "notes"],
      ] as const)
        .map(([l, name]) => (count(l) ? ` · ${count(l)} ${name}` : ""))
        .join("") +
      (groups ? ` · ${groups} grouped` : "") +
      (model.chains.length
        ? ` · ${model.chains.length} chain${model.chains.length === 1 ? "" : "s"}`
        : "");
    const draft = polyDraft
      ? ` · polygon: ${polyDraft.length} ${polyDraft.length === 1 ? "vertex" : "vertices"}${polyDraft.length >= 3 ? " · Enter to close" : ""}`
      : "";
    title.textContent = `${currentName ?? "(unsaved)"}${state} · ${count("geometry")} bodies${extra}${draft}`;
  }
  // The cursor a drag borrows and must hand back (pan swaps in a grab hand).
  function applyToolCursor(): void {
    canvas.style.cursor = tool === "select" ? "default" : "crosshair";
  }
  function setTool(t: Tool): void {
    if (!LAYER_TOOLS[activeLayer].includes(t)) return;
    // A locked layer accepts no new geometry either, so its draw tools cannot be
    // armed by the keyboard shortcuts any more than by the (hidden) buttons.
    if (t !== "select" && lockedLayers.has(activeLayer)) return;
    if (t !== "poly") cancelPolyDraft();
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
  // Read-only panel values (a polygon's vertex count). They refresh with the
  // number fields rather than only on a panel rebuild: a canvas drag can change
  // one — inserting or removing a vertex — and the panel is deliberately not
  // rebuilt mid-drag, so without this the count silently goes stale.
  const readouts: Array<{ el: HTMLElement; get: () => string }> = [];

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
  // group agrees on (blank if they differ) and writes to every member. `after`
  // runs once per write - the geometry panel uses it to keep a compound body's
  // members in agreement when only one piece of it is selected.
  function groupNum(g: HTMLElement, items: EdItem[], after?: () => void) {
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
          after?.();
        },
        step,
        items.length > 1,
        opts,
      );
  }
  type GroupNum = ReturnType<typeof groupNum>;

  // Is this set of items exactly one whole compound body of several pieces? The
  // properties a body has one of - most visibly its rotation - are edited on the
  // group when it is, and per item when it is not.
  function wholeGroup(items: readonly EdItem[]): EdItem[] | null {
    if (items.length < 2) return null;
    const g = items[0]!.group;
    if (g === null || !items.every((b) => b.group === g)) return null;
    const members = groupMembers(model.items, g);
    return members.length === items.length ? [...items] : null;
  }

  // Placement and size. Shared by every layer's panel: whatever layer an item
  // lives on, it is a placed shape and moves, rotates and resizes the same way.
  function addTransformFields(g: HTMLElement, num: GroupNum, items: EdItem[]): void {
    num("x", (b) => b.pos.x * M2PX, (b, v) => (b.pos = b.pos.withX(v * PX)));
    num("y", (b) => b.pos.y * M2PX, (b, v) => (b.pos = b.pos.withY(v * PX)));
    // A circle's rotation is invisible, so it only gets the field where it aims
    // something (a force area's current).
    if (
      items.every(
        (b) => b.shape.kind !== "circle" || (b.layer === "geometry" && b.kind === "force"),
      )
    ) {
      const whole = wholeGroup(items);
      if (whole) {
        // A compound body has ONE rotation, about the centre of mass its built
        // body's origin sits at. Turning each piece about its own centre would
        // pull the body apart, so the field is a delta applied to the group -
        // shown against the first member's angle, which is the built body's own
        // frame of reference.
        const lead = whole[0]!;
        numField(
          g,
          "rot°",
          () => (lead.rot * 180) / Math.PI,
          (v) => rotateGroupAbout(whole, groupCentroid(whole), (v * Math.PI) / 180 - lead.rot),
        );
      } else {
        num("rot°", (b) => (b.rot * 180) / Math.PI, (b, v) => (b.rot = (v * Math.PI) / 180));
      }
    }
    // An arrow is stored as a box, but its height is only a pick band and its
    // width is its length — the notes panel exposes that instead.
    if (items.some(isArrowNote)) return;
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
    } else if (items.every((b) => b.shape.kind === "poly")) {
      // A polygon has no width or height to type: it is edited on the canvas,
      // vertex by vertex. The panel says so and reports the count, rather than
      // leaving a gap where every other shape has its size fields.
      const count = (): string => {
        const counts = items.map((b) => (b.shape.kind === "poly" ? b.shape.verts.length : 0));
        return counts.every((c) => c === counts[0]) ? String(counts[0]) : "mixed";
      };
      const row = el("label", "ed-field");
      row.textContent = "vertices";
      const val = document.createElement("span");
      val.textContent = count();
      row.appendChild(val);
      g.appendChild(row);
      readouts.push({ el: val, get: count });
      const hint = el("div", "ed-hint");
      hint.textContent =
        "Drag a corner to move it, an edge midpoint to add one, Alt+click a corner to remove it. The outline always stays convex.";
      g.appendChild(hint);
    }
  }

  // Authored appearance: a colour swatch plus a fill opacity. Shared by the
  // geometry and background panels — the two layers whose look is saved and
  // played, as against the fixed colours of the editor-only furniture.
  function addFillFields(
    g: HTMLElement,
    num: GroupNum,
    items: EdItem[],
    after?: () => void,
  ): void {
    const cw = el("label", "ed-field");
    cw.textContent = "color";
    const ci = document.createElement("input");
    ci.type = "color";
    ci.className = "ed-color";
    // A colour input has no mixed state; it shows the first item's and writes
    // to all of them, which is the only sane reading of "set the colour".
    ci.value = items[0]!.color;
    ci.addEventListener("focus", () => beginAction());
    ci.addEventListener("input", () => {
      for (const b of items) b.color = ci.value;
      after?.();
      markDirty();
    });
    cw.appendChild(ci);
    g.appendChild(cw);
    num("opacity", (b) => b.opacity, (b, v) => (b.opacity = Math.min(1, Math.max(0, v))), 0.1);
  }

  // Every layer's panel ends the same way: the two actions that apply to any
  // selection, whatever it is made of. Duplicate and Delete act on the *whole*
  // selection, so a cross-layer one carries a single shared row above the
  // per-layer panels instead of one per panel that would each claim to be about
  // its own layer while reaching outside it.
  let selectionSpansLayers = false;
  function addActionsRow(g: HTMLElement): void {
    if (selectionSpansLayers) return;
    appendActions(g);
  }
  function appendActions(g: HTMLElement): void {
    const row = el("div", "ed-row");
    row.append(
      button("Duplicate", () => duplicateSelected()),
      button("Delete", () => deleteSelected()),
    );
    g.appendChild(row);
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
        "Edits apply to all of them. Shift+click adds or removes; rubber-band left→right encloses, right→left touches.";
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

    const sync = () => syncEditedGroups(bodies);
    const num = groupNum(g, bodies, sync);
    addTransformFields(g, num, bodies);
    if (bodies.every((b) => b.kind === "force")) {
      // Acceleration along rot°, authored in px/s² like every other length.
      // Negative reverses the flow, so it is deliberately not clamped at 0.
      num("force", (b) => b.force * M2PX, (b, v) => (b.force = v * PX), 50);
    }
    if (!bodies.some(frictionless)) {
      num("friction", (b) => b.friction, (b, v) => (b.friction = Math.min(1, Math.max(0, v))), 0.1);
    }

    addFillFields(g, num, bodies, sync);
    addGroupSection(g, bodies);
    addActionsRow(g);
    inspector.appendChild(g);
  }

  // Compound-body controls. A group is one engine body carrying several convex
  // shapes: the pieces share a transform, and the joins between them stop being
  // corners - the rope will not wrap a vertex buried inside a sibling shape, and
  // ledge detection will not grab one. That is the whole reason to group, so the
  // panel says it rather than offering a bare button.
  function addGroupSection(g: HTMLElement, bodies: EdItem[]): void {
    const groups = new Set(bodies.map((b) => b.group).filter((x): x is number => x !== null));
    const row = el("div", "ed-row");
    // Areas are single-shape everywhere they are used, so they are not groupable
    // (see `groupable` in buildBodies.ts) and the button would be a lie.
    const eligible = bodies.filter((b) => b.kind !== "killzone" && b.kind !== "force");
    if (eligible.length > 1) {
      const b = button("Group", () => groupSelected());
      b.title = "Weld these shapes into one compound body (Ctrl+G)";
      row.appendChild(b);
    }
    if (groups.size) {
      const b = button("Ungroup", () => ungroupSelected());
      b.title = "Split this compound body back into independent ones (Ctrl+Shift+G)";
      row.appendChild(b);
    }
    if (!row.childElementCount) return;
    g.appendChild(row);
    const hint = el("div", "ed-hint");
    if (groups.size === 1 && bodies.every((b) => b.group !== null)) {
      const members = groupMembers(model.items, bodies[0]!.group!).length;
      hint.textContent = `One compound body of ${members} shapes: they share a transform, and the rope and ledge grabs treat the seams between them as interior. Alt+click a piece to edit it alone.`;
    } else {
      hint.textContent =
        "Grouping builds these as ONE body, so the rope runs straight over the seams between them instead of snagging. Kind, fill and friction collapse onto the first one's.";
    }
    g.appendChild(hint);
  }

  // Chain panel. A chain has no placement of its own - both ends are points on
  // bodies - so the panel is what it holds, how long it is, and its colour.
  function buildChainGroup(chains: EdChain[]): void {
    const g = el("div", "ed-group");
    g.appendChild(
      heading(chains.length === 1 ? `Chain #${chains[0]!.id}` : `${chains.length} chains selected`),
    );
    const hint = el("div", "ed-hint");
    hint.textContent =
      "Strung between two bodies and solved every frame: a rigid body on either end hangs and swings from it, a static one just holds. Drag an end handle to move or re-anchor it.";
    g.appendChild(hint);

    const planeHint = el("div", "ed-hint");
    planeHint.textContent =
      "Scenery: drawn behind the level, and solved against nothing but its own two bodies, so it passes through the geometry, the player and the hook.";
    g.appendChild(planeHint);

    // Slack is what a chain is for, so the length is authored in scene pixels
    // like every other length. Blank = exactly taut between the two anchors,
    // re-derived on load, which is what dragging one out gives.
    numField(
      g,
      "length",
      () => {
        const first = chains[0]!.length;
        return chains.every((c) => c.length === first) ? (first ?? NaN) * M2PX : null;
      },
      (v) => {
        for (const c of chains) c.length = Math.max(0, v * PX);
      },
      10,
      chains.length > 1,
      {
        placeholder: "taut",
        onEmpty: () => {
          for (const c of chains) c.length = null;
        },
      },
    );

    // A "slack" readout: how much longer than the straight gap the chain is, so
    // the number above can be set by eye against the drape it produces.
    const slack = (): string => {
      const c = chains[0]!;
      const ends = chainEnds(model, c);
      if (!ends || chains.length > 1) return "-";
      const straight = ends.a.distanceTo(ends.b);
      const len = c.length ?? straight;
      return `${Math.round((len - straight) * M2PX)} px`;
    };
    const srow = el("label", "ed-field");
    srow.textContent = "slack";
    const sval = document.createElement("span");
    sval.textContent = slack();
    srow.appendChild(sval);
    g.appendChild(srow);
    readouts.push({ el: sval, get: slack });

    const cw = el("label", "ed-field");
    cw.textContent = "color";
    const ci = document.createElement("input");
    ci.type = "color";
    ci.className = "ed-color";
    ci.value = chains[0]!.color ?? CHAIN_DEFAULT_COLOR;
    ci.addEventListener("focus", () => beginAction());
    ci.addEventListener("input", () => {
      for (const c of chains) c.color = ci.value;
      markDirty();
    });
    cw.appendChild(ci);
    g.appendChild(cw);

    const row = el("div", "ed-row");
    row.append(
      button("Reset color", () => {
        beginAction();
        for (const c of chains) c.color = null;
        markDirty();
        rebuildInspector();
      }),
      button("Delete", () => deleteSelected()),
    );
    g.appendChild(row);
    inspector.appendChild(g);
  }

  // Background-layer panel. A background is a placed shape and an appearance and
  // nothing else — it has no kind, no friction and no behaviour of any sort —
  // so the panel is exactly the transform plus the fill. An image fill (scale /
  // crop / tile) is the one section still to come.
  function buildBackgroundGroup(items: EdItem[]): void {
    const g = el("div", "ed-group");
    g.appendChild(
      heading(
        items.length === 1 ? `Background #${items[0]!.id}` : `${items.length} backgrounds selected`,
      ),
    );
    const hint = el("div", "ed-hint");
    hint.textContent =
      "Decoration only: drawn behind every body, with nothing to collide with, wrap or stand on. Images are not implemented yet.";
    g.appendChild(hint);

    const num = groupNum(g, items);
    addTransformFields(g, num, items);
    addFillFields(g, num, items);
    addActionsRow(g);
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
    addTransformFields(g, num, regions);

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
    // How far outside the region the avatar may travel before it gives the
    // camera up. Blank = the controller's jitter margin (REGION_EXIT_MARGIN),
    // which is what every region authored before this field had.
    num(
      "buffer",
      (b) => (b.cam.buffer ?? NaN) * M2PX,
      (b, v) => (b.cam.buffer = Math.max(0, v * PX)),
      10,
      {
        placeholder: String(Math.round(REGION_EXIT_MARGIN * M2PX)),
        onEmpty: () => {
          for (const b of regions) b.cam.buffer = null;
        },
      },
    );
    num("priority", (b) => b.cam.priority, (b, v) => (b.cam.priority = Math.round(v)), 1);

    addActionsRow(g);
    inspector.appendChild(g);
  }

  // The live note textarea, so a freshly placed text note can be typed into
  // without a trip to the inspector. Null whenever the panel shows no single
  // text note.
  let noteText: HTMLTextAreaElement | null = null;

  // Put the caret in that textarea, at the end of whatever is already written.
  // It is scrolled into view because the inspector is a scrolling stack of
  // per-layer panels, so the note's panel need not be on screen.
  function focusNoteText(): void {
    if (!noteText) return;
    noteText.scrollIntoView({ block: "nearest" });
    noteText.focus();
    const end = noteText.value.length;
    noteText.setSelectionRange(end, end);
  }

  // Notes-layer panel. A note's whole point is its prose, so the text box leads;
  // everything below it is placement.
  function buildNotesGroup(notes: EdItem[]): void {
    const g = el("div", "ed-group");
    g.appendChild(
      heading(notes.length === 1 ? `Note #${notes[0]!.id}` : `${notes.length} notes selected`),
    );
    const hint = el("div", "ed-hint");
    hint.textContent =
      "Editor-only: notes record why geometry is placed as it is, so it isn't later removed as arbitrary. They never appear in play.";
    g.appendChild(hint);

    const allText = notes.every((n) => n.note.kind === "text");
    const allArrows = notes.every((n) => n.note.kind === "arrow");
    if (allText && notes.length === 1) {
      const n = notes[0]!;
      const ta = document.createElement("textarea");
      ta.className = "ed-text";
      ta.rows = 4;
      ta.value = n.note.text;
      ta.placeholder = "Why is this here?";
      // One undo step per editing session, snapshotted on the first keystroke
      // rather than on focus: placing a note focuses it, and a focus-time
      // snapshot would make the first Ctrl+Z a visible no-op.
      let edited = false;
      ta.addEventListener("blur", () => (edited = false));
      ta.addEventListener("input", () => {
        if (!edited) {
          beginAction();
          edited = true;
        }
        n.note.text = ta.value;
        markDirty();
      });
      noteText = ta;
      g.appendChild(ta);
    } else if (allText) {
      // Merging prose across a group has no sane meaning, so the text stays a
      // single-selection edit while placement stays group-wide.
      const many = el("div", "ed-hint");
      many.textContent = "Select one note to edit its text.";
      g.appendChild(many);
    }

    const num = groupNum(g, notes);
    addTransformFields(g, num, notes);
    if (allArrows) {
      num("length", (b) => (b.shape.kind === "rect" ? b.shape.w * M2PX : 0), (b, v) => {
        if (b.shape.kind === "rect") b.shape.w = Math.max(MIN_ARROW_LENGTH, v * PX);
      });
    }
    if (allText) {
      num("text px", (b) => b.note.size * M2PX, (b, v) => (b.note.size = Math.max(4, v) * PX), 1);
    }

    addActionsRow(g);
    inspector.appendChild(g);
  }

  function rebuildInspector(): void {
    fields.length = 0;
    readouts.length = 0;
    noteText = null;
    inspector.innerHTML = "";

    const player = el("div", "ed-group");
    player.appendChild(heading("Player spawn"));
    numField(player, "x", () => model.player.pos.x * M2PX, (v) => (model.player.pos = model.player.pos.withX(v * PX)));
    numField(player, "y", () => model.player.pos.y * M2PX, (v) => (model.player.pos = model.player.pos.withY(v * PX)));
    numField(player, "radius", () => model.player.radius * M2PX, (v) => (model.player.radius = Math.max(1, v) * PX));
    inspector.appendChild(player);

    // Chains carry their own, exclusive selection (see `selectedChainIds`).
    const chains = selectedChains();
    if (chains.length) {
      buildChainGroup(chains);
      return;
    }

    const sel = selectedBodies();
    if (!sel.length) {
      const hint = el("div", "ed-hint");
      // A locked layer explains itself first: with nothing pickable on it, the
      // usual "click a body" hint would read as the editor being broken.
      hint.textContent = lockedLayers.has(activeLayer)
        ? `The ${activeLayer} layer is locked: it still draws, but nothing on it can be picked, drawn or edited. Use the padlock in the layer list to unlock it.`
        : EMPTY_HINTS[activeLayer];
      inspector.appendChild(hint);
      return;
    }
    // A selection may span layers, and their properties have nothing in common
    // (a note has no kind, a camera region no fill), so it gets one panel per
    // layer rather than a reconciled mixed one. Panels come in layer order, so
    // the same selection always reads the same way down the inspector.
    const layers = ED_LAYERS.filter((l) => sel.some((b) => b.layer === l));
    selectionSpansLayers = layers.length > 1;
    if (selectionSpansLayers) {
      const g = el("div", "ed-group");
      g.appendChild(heading(`${sel.length} items across ${layers.length} layers`));
      const hint = el("div", "ed-hint");
      hint.textContent = `${layers.join(", ")} — each layer's properties are edited in its own panel below. Duplicate and Delete apply to all of them.`;
      g.appendChild(hint);
      appendActions(g);
      inspector.appendChild(g);
    }
    for (const l of layers) {
      const items = sel.filter((b) => b.layer === l);
      if (l === "background") buildBackgroundGroup(items);
      else if (l === "camera") buildCameraGroup(items);
      else if (l === "notes") buildNotesGroup(items);
      else buildBodyGroup(items);
    }
  }

  // Refresh field values after a canvas drag, without disturbing a focused input.
  function refreshFields(): void {
    for (const f of fields) {
      if (document.activeElement === f.input) continue;
      f.input.value = fmtOrBlank(f.get());
    }
    for (const r of readouts) r.el.textContent = r.get();
  }

  // --- editing ops ----------------------------------------------------------
  // Detached copies of the given bodies, each with a fresh id and shifted by
  // `offset`. Shapes are mutated in place, so clone them. Group ids are remapped
  // too: a duplicated compound body is a NEW body, not a second set of pieces
  // welded into the one it was copied from. `idOf` maps old id → new, which is
  // what lets the chains between them be copied along with the bodies.
  function cloneBodies(
    bodies: readonly EdItem[],
    offset: Vec2,
  ): { items: EdItem[]; idOf: Map<number, number> } {
    const groups = new Map<number, number>();
    const idOf = new Map<number, number>();
    const items = bodies.map((b) => {
      const id = newBodyId();
      idOf.set(b.id, id);
      let group = b.group;
      if (group !== null) {
        let mapped = groups.get(group);
        if (mapped === undefined) {
          mapped = newBodyId();
          groups.set(group, mapped);
        }
        group = mapped;
      }
      return {
        ...b,
        id,
        group,
        pos: b.pos.add(offset),
        shape: cloneShape(b.shape),
        cam: { ...b.cam },
        note: { ...b.note },
      };
    });
    return { items, idOf };
  }

  // Copies of the chains whose BOTH ends landed in the copied set. A chain with
  // one end outside it would be a chain to a body that is not there, so it is
  // left behind rather than silently re-pointed at the original.
  function cloneChainsWithin(
    chains: readonly EdChain[],
    idOf: ReadonlyMap<number, number>,
  ): EdChain[] {
    const out: EdChain[] = [];
    for (const c of chains) {
      const a = idOf.get(c.a.itemId);
      const b = idOf.get(c.b.itemId);
      if (a === undefined || b === undefined) continue;
      out.push({
        ...cloneChain(c),
        id: newBodyId(),
        a: { ...c.a, itemId: a },
        b: { ...c.b, itemId: b },
      });
    }
    return out;
  }

  // Add freshly created bodies to the model and leave them selected, so the
  // group can immediately be dragged or pasted again.
  function addAndSelect(bodies: EdItem[], chains: EdChain[] = []): void {
    model.items.push(...bodies);
    model.chains.push(...chains);
    selectedIds.clear();
    selectedChainIds.clear();
    for (const b of bodies) selectedIds.add(b.id);
    markDirty();
    rebuildInspector();
  }

  // --- groups ---------------------------------------------------------------
  // Weld the selected geometry into one compound body. The pieces keep their
  // placement exactly; what changes is that they now build as a single engine
  // body, so the rope refuses to wrap the seams between them and ledge detection
  // refuses to grab one. Body-level properties (kind, fill, friction, force)
  // collapse onto the first member's, since a body has only one of each.
  function groupSelected(): void {
    const sel = selectedBodies().filter((b) => b.layer === "geometry" && b.kind !== "killzone" && b.kind !== "force");
    if (sel.length < 2) return;
    beginAction();
    const id = newBodyId();
    // Absorb any group the selection already had: grouping a body and a loose
    // shape means one body, not a body holding a body.
    const absorbed = new Set(sel.map((b) => b.group).filter((g): g is number => g !== null));
    for (const b of model.items) {
      if (b.group !== null && absorbed.has(b.group)) b.group = id;
    }
    for (const b of sel) b.group = id;
    const members = groupMembers(model.items, id);
    syncGroupProps(sel[0]!, members);
    setSelection(members.map((b) => b.id));
    markDirty();
    rebuildInspector();
  }

  // Break the selected compound bodies back into independent ones. Nothing else
  // changes - the pieces stay exactly where they are, and only stop sharing a
  // transform and a seam rule.
  function ungroupSelected(): void {
    const sel = selectedBodies().filter((b) => b.group !== null);
    if (!sel.length) return;
    beginAction();
    const groups = new Set(sel.map((b) => b.group!));
    for (const b of model.items) if (b.group !== null && groups.has(b.group)) b.group = null;
    markDirty();
    rebuildInspector();
  }

  // Keep a compound body's members in agreement after an edit to one of them.
  // Only the lead's body-level properties are built, so this is what stops a
  // file from disagreeing with what the editor draws.
  function syncEditedGroups(edited: readonly EdItem[]): void {
    const seen = new Set<number>();
    for (const b of edited) {
      if (b.group === null || seen.has(b.group)) continue;
      seen.add(b.group);
      const members = groupMembers(model.items, b.group);
      syncGroupProps(members[0]!, members);
    }
  }

  // --- chains ---------------------------------------------------------------
  // String a chain between two bodies, anchored where each end was placed. A
  // chain to the body you started on (or to another piece of the same compound
  // body) is a chain tied to itself and is refused.
  function addChain(from: EdItem, fromLocal: Vec2, to: EdItem, world: Vec2): void {
    if (!chainable(to)) return;
    if (to.id === from.id) return;
    if (from.group !== null && to.group === from.group) return;
    beginAction();
    const chain: EdChain = {
      id: newBodyId(),
      a: { itemId: from.id, local: fromLocal },
      b: { itemId: to.id, local: nearestSurfaceLocal(to, world) },
      length: null, // taut as drawn
      color: null,
    };
    model.chains.push(chain);
    setChainSelection([chain.id]);
    markDirty();
  }

  // Drop chains that no longer have two bodies to hold. Called after any item
  // deletion, so a chain can never outlive what it was tied to.
  function pruneChains(): void {
    const live = new Set(model.items.filter((i) => i.layer === "geometry").map((i) => i.id));
    model.chains = model.chains.filter((c) => live.has(c.a.itemId) && live.has(c.b.itemId));
  }

  // A group of one is not a compound body - it builds exactly as a lone shape
  // would - so a deletion that leaves one member behind clears the tag rather
  // than leaving the item claiming a group that no longer means anything.
  function pruneGroups(): void {
    const counts = new Map<number, number>();
    for (const b of model.items) {
      if (b.group !== null) counts.set(b.group, (counts.get(b.group) ?? 0) + 1);
    }
    for (const b of model.items) {
      if (b.group !== null && counts.get(b.group) === 1) b.group = null;
    }
  }

  // A fresh item for the draw tool, on the active layer. Every layer's item is
  // the same type, so this only picks the appearance and the starting size —
  // the drag that follows resizes it identically whatever it is.
  function newDrawnItem(t: Exclude<Tool, "select" | "chain">, start: Vec2): EdItem {
    const style = LAYER_STYLE[activeLayer];
    const base = {
      id: newBodyId(),
      layer: activeLayer,
      group: null, // a fresh shape is its own body until it is grouped
      pos: start,
      rot: 0,
      kind: newKind,
      color: style.color,
      opacity: style.opacity,
      friction: DEFAULT_SURFACE_FRICTION,
      // Only meaningful on a force area, but a new one needs a non-zero pull
      // or it would draw no arrows and do nothing until the field is touched.
      force: DEFAULT_FORCE_MAGNITUDE * PX,
      // A fresh region is a no-op until a framing field is authored.
      cam: defaultCamera(),
      note: defaultNote(),
    };
    if (t === "text" || t === "arrow") {
      const item: EdItem = {
        ...base,
        shape:
          t === "arrow"
            ? { kind: "rect", w: NOTE_DEFAULT_ARROW_LENGTH, h: NOTE_ARROW_BAND }
            : { kind: "rect", w: NOTE_DEFAULT_SIZE.x, h: NOTE_DEFAULT_SIZE.y },
        note: { ...base.note, kind: t },
      };
      // A note is usually placed with a click rather than dragged out, so it
      // starts at a size worth writing in: a box growing down-right from the
      // click, or an arrow pointing right from it. A drag overrides both.
      if (t === "arrow") {
        setArrowEnds(item, start, start.add(new Vec2(NOTE_DEFAULT_ARROW_LENGTH, 0)));
      } else {
        item.pos = start.add(NOTE_DEFAULT_SIZE.mul(0.5));
      }
      return item;
    }
    if (t === "poly") {
      // A placeholder triangle; the caller replaces the loop with the drafted
      // hull immediately. It exists so the item is a well-formed convex polygon
      // at every instant, never a shape with no vertices.
      return {
        ...base,
        shape: {
          kind: "poly",
          verts: [
            new Vec2(-gridStep, gridStep),
            new Vec2(0, -gridStep),
            new Vec2(gridStep, gridStep),
          ],
        },
      };
    }
    return {
      ...base,
      shape:
        t === "rect"
          ? { kind: "rect", w: gridStep, h: gridStep }
          : { kind: "circle", r: gridStep },
    };
  }

  // How close (in screen px) a click must land to the draft's first vertex to
  // close the loop rather than adding another vertex.
  const POLY_CLOSE_PX = 10;

  function cancelPolyDraft(): void {
    if (!polyDraft) return;
    polyDraft = null;
    updateTitle();
  }

  // Turn the clicked points into an item on the active layer. The outline is
  // taken as their convex hull (see `convexHull`): a convex polygon is its own
  // hull, so a well-drawn shape lands exactly as clicked, and a dented or
  // out-of-order one becomes the nearest convex shape instead of being refused
  // after all the clicking. Fewer than three non-collinear points is not a
  // shape at all, so that draft is simply dropped.
  function commitPolyDraft(): void {
    const pts = polyDraft;
    polyDraft = null;
    if (!pts) return;
    const hull = convexHull(pts);
    if (hull.length < 3) {
      updateTitle();
      return;
    }
    const item = newDrawnItem("poly", hull[0]!);
    // `setPolyVerts` re-centres the loop and moves `pos` to the centroid, so the
    // starting position only has to be somewhere sane in the item's own frame.
    item.pos = Vec2.ZERO;
    item.shape = { kind: "poly", verts: hull.map((h) => h.clone()) };
    if (!setPolyVerts(item, hull)) {
      updateTitle();
      return;
    }
    beginAction();
    addAndSelect([item]);
  }

  function deleteSelected(): void {
    if (!selectedIds.size && !selectedChainIds.size) return;
    beginAction();
    model.items = model.items.filter((b) => !selectedIds.has(b.id));
    model.chains = model.chains.filter((c) => !selectedChainIds.has(c.id));
    // A chain whose body has just gone has nothing left to hold, and a compound
    // body down to its last piece is no longer compound.
    pruneChains();
    pruneGroups();
    selectedIds.clear();
    selectedChainIds.clear();
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
    const copy = cloneBodies(sel, new Vec2(gridStep * 2, gridStep * 2));
    addAndSelect(copy.items, cloneChainsWithin(model.chains, copy.idOf));
  }

  // --- clipboard ------------------------------------------------------------
  // Copies detached from the model (so later edits or an undo can't mutate
  // them); paste re-centres the group's bounding box on the cursor.
  let clipboard: EdItem[] = [];
  // Chains whose two ends are both inside `clipboard`, so a copied assembly
  // (two bodies and the chain between them) pastes as the assembly.
  let clipboardChains: EdChain[] = [];

  function copySelection(): void {
    const sel = selectedBodies();
    if (!sel.length) return;
    clipboard = sel.map((b) => ({
      ...b,
      shape: cloneShape(b.shape),
      cam: { ...b.cam },
      note: { ...b.note },
    }));
    const copied = new Set(sel.map((b) => b.id));
    clipboardChains = model.chains
      .filter((c) => copied.has(c.a.itemId) && copied.has(c.b.itemId))
      .map(cloneChain);
  }
  function pasteClipboard(): void {
    if (!clipboard.length) return;
    // Pasted items keep the layer they were copied from — a camera region can't
    // become a body — so a paste reveals and unlocks any layer it lands on
    // rather than dropping items where they can be neither seen nor clicked.
    for (const l of new Set(clipboard.map((i) => i.layer))) {
      setLayerVisible(l, true);
      setLayerLocked(l, false);
    }
    const box = groupBounds(clipboard);
    let delta = pointerWorld().sub(box.min.add(box.max).mul(0.5));
    // Land the group's top-left corner on the grid, as a move does.
    if (snapOn) delta = snapVec(box.min.add(delta)).sub(box.min);
    beginAction();
    const copy = cloneBodies(clipboard, delta);
    addAndSelect(copy.items, cloneChainsWithin(clipboardChains, copy.idOf));
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
  //
  // `"consumed"` means the press *was* a handle interaction that finished on the
  // spot and started no drag — removing a polygon vertex. It has to be
  // distinguishable from "no handle here": falling through to the body pick
  // would land on empty space (the vertex just went away) and clear the
  // selection, so a removal would deselect the shape it edited.
  function pickHandle(scr: Vec2, alt = false): Drag | "consumed" | null {
    // A selected chain is edited by its two end handles and nothing else.
    const chains = selectedChains();
    if (chains.length === 1) {
      const ends = computeChainHandles(camera, model, chains[0]!);
      if (ends) {
        for (const end of ["a", "b"] as const) {
          const p = ends[end];
          if (scr.distanceTo(p) <= HANDLE_HIT_PX) {
            return { mode: "chainEnd", chain: chains[0]!, end, cursor: p };
          }
        }
      }
      return null;
    }
    // A whole compound body turns as one, about the centre of mass its built
    // body's origin sits at, so it gets a rotate knob where a lone shape does.
    const whole = wholeGroup(selectedBodies());
    if (whole) {
      const gh = computeGroupHandles(camera, whole);
      if (scr.distanceTo(gh.rotate) <= HANDLE_HIT_PX) {
        const centre = groupCentroid(whole);
        const world = screenToWorld(camera, scr.x, scr.y).sub(centre);
        return {
          mode: "rotateGroup",
          items: whole,
          centre,
          grabAngle: Math.atan2(world.y, world.x),
          applied: 0,
        };
      }
      return null;
    }
    const s = selected();
    if (!s) return null;
    const h = computeHandles(camera, s);
    if (h.ends) {
      // Head first, so a zero-length arrow (a click that never dragged) still
      // has an end that grows it rather than two coincident ones.
      const { tail, head } = arrowEnds(s);
      if (scr.distanceTo(h.ends[1]!) <= HANDLE_HIT_PX) {
        return { mode: "arrowEnd", body: s, fixed: tail, movingIsHead: true };
      }
      if (scr.distanceTo(h.ends[0]!) <= HANDLE_HIT_PX) {
        return { mode: "arrowEnd", body: s, fixed: head, movingIsHead: false };
      }
      return null;
    }
    // Vertices before the rotate knob: on a small polygon the knob can overlap a
    // corner, and the corner is what the pointer is far more often after.
    if (h.verts && s.shape.kind === "poly") {
      for (let i = 0; i < h.verts.length; i++) {
        if (scr.distanceTo(h.verts[i]!) > HANDLE_HIT_PX) continue;
        // Alt+click removes the vertex instead of dragging it — a triangle is
        // the floor, so the last three are not removable.
        if (alt) {
          if (s.shape.verts.length <= 3) return null;
          beginAction();
          const rest = s.shape.verts.filter((_, j) => j !== i);
          if (setPolyVerts(s, rest)) {
            markDirty();
            rebuildInspector();
          }
          return "consumed";
        }
        return { mode: "polyVertex", body: s, index: i, accepted: s.shape.verts[i]! };
      }
      // An edge midpoint splits that edge: insert a vertex there and drag it
      // straight away, so adding a corner and placing it is one gesture.
      for (let i = 0; i < (h.vertMids?.length ?? 0); i++) {
        if (scr.distanceTo(h.vertMids![i]!) > HANDLE_HIT_PX) continue;
        const verts = s.shape.verts;
        const mid = verts[i]!.add(verts[(i + 1) % verts.length]!).mul(0.5);
        const next = [...verts.slice(0, i + 1), mid, ...verts.slice(i + 1)];
        beginAction();
        dragPushed = true;
        if (!setPolyVerts(s, next)) return null;
        markDirty();
        return { mode: "polyVertex", body: s, index: i + 1, accepted: mid };
      }
    }
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
    const h = pickHandle(scr, e.altKey);
    if (h === "consumed") return; // handled outright; no drag, selection intact
    if (h) {
      drag = h;
      return;
    }
    // 1b. Polygon drafting: a run of clicks, not a drag. Clicking the first
    // vertex again (or Enter) closes the loop; Esc drops it.
    if (tool === "poly") {
      const p = snapVec(world);
      if (polyDraft && polyDraft.length >= 3) {
        const first = worldToScreen(camera, polyDraft[0]!);
        if (scr.distanceTo(first) <= POLY_CLOSE_PX) {
          commitPolyDraft();
          return;
        }
      }
      polyDraft = [...(polyDraft ?? []), p];
      updateTitle();
      return;
    }
    // 1c. Chain tool: a chain is not a shape to drag out but a link between two
    // bodies, so the gesture is a drag FROM one body TO another. Pressing
    // anywhere else does nothing rather than dropping a chain with one end in
    // mid-air.
    if (tool === "chain") {
      const from = topmostAt(world, (b) => chainable(b));
      if (from) {
        // The anchor lands on the body's surface, not where the pointer happens
        // to be inside it (see `nearestSurfaceLocal`).
        drag = { mode: "chainDraw", from, local: nearestSurfaceLocal(from, world), cursor: world };
      }
      return;
    }
    // 2. Draw tool: create a new item on the active layer and drag out its size.
    if (tool !== "select") {
      beginAction();
      dragPushed = true;
      const start = snapVec(world);
      const body = newDrawnItem(tool, start);
      model.items.push(body);
      setSelection([body.id]);
      drag = { mode: "draw", body, start };
      markDirty();
      rebuildInspector();
      // A text note is placed to be written in, so the caret goes there rather
      // than making the first act after every note a trip to the inspector.
      // The default mousedown action moves focus to the document *after* this
      // listener, which would blur the textarea the moment it was focused, so a
      // note placement is the one canvas press that suppresses it. Every other
      // press keeps the default, since clicking the canvas has to blur whatever
      // inspector field was being typed into — otherwise the keyboard shortcuts
      // would stay swallowed by it.
      if (noteText) e.preventDefault();
      focusNoteText();
      return;
    }
    // 3. Player spawn marker (small target — needs pointer within its radius).
    if (world.distanceTo(model.player.pos) <= Math.max(model.player.radius, 12 / (camera.zoom * PIXELS_PER_METER))) {
      drag = { mode: "movePlayer", grab: model.player.pos.sub(world) };
      return;
    }
    // 4. Topmost item under the pointer, over every visible layer — the active
    // layer wins a tie (see `pickOrder`), so the layer switch still says which
    // of two stacked items a click means. A grouped item selects its whole
    // compound body, since a group IS one body; Alt reaches past that to the
    // single piece.
    const hit = topmostAt(world);
    if (hit) {
      const targets = clickTargets(hit, e.altKey);
      if (e.shiftKey) {
        // Shift+click only edits the selection — no drag, so it can't nudge
        // geometry while picking bodies out of a group.
        if (targets.length === 1) toggleSelection(hit.id);
        else setSelection(withWholeGroups([...selectedIds, ...targets.map((t) => t.id)]));
        drag = null;
        return;
      }
      // Clicking inside an existing multi-selection drags the whole group.
      if (!targets.every((t) => selectedIds.has(t.id))) {
        setSelection(targets.map((t) => t.id));
      }
      const others = selectedBodies()
        .filter((o) => o !== hit)
        .map((o) => ({ body: o, offset: o.pos.sub(hit.pos) }));
      drag = { mode: "move", lead: hit, others, grab: hit.pos.sub(world) };
      return;
    }
    // 5. A chain under the pointer. Tested after the bodies, since a chain is
    // strung over the geometry it holds and its ends sit inside those bodies -
    // picking it first would swallow every click near an anchor.
    const chain = topmostChainAt(world);
    if (chain) {
      setChainSelection([chain.id]);
      drag = null;
      return;
    }
    // 6. Empty space: rubber-band select. A click that never moves deselects
    // (shift keeps the selection, so a miss doesn't undo the picking so far).
    drag = { mode: "marquee", start: world, current: world, additive: e.shiftKey };
  });

  // Topmost pickable item at a world point (optionally filtered), or null.
  function topmostAt(world: Vec2, accept?: (b: EdItem) => boolean): EdItem | null {
    const pickable = pickOrder();
    for (let i = pickable.length - 1; i >= 0; i--) {
      const b = pickable[i]!;
      if (!pointInBody(b, world)) continue;
      if (accept && !accept(b)) continue;
      return b;
    }
    return null;
  }

  // The chain nearest a world point, within the pick band, or null. Chains are
  // only pickable while the geometry layer is one a click can reach - they are
  // geometry-layer furniture, and a hidden or locked layer must not be editable
  // through them.
  function topmostChainAt(world: Vec2): EdChain | null {
    if (!visibleLayers.has("geometry") || lockedLayers.has("geometry")) return null;
    const band = CHAIN_HIT_PX / (camera.zoom * PIXELS_PER_METER);
    let best: EdChain | null = null;
    let bestD = band;
    for (const c of model.chains) {
      const d = distanceToChain(model, c, world);
      if (d <= bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // Double-clicking a text note opens its prose for editing — the gesture every
  // other canvas editor uses for "edit this thing's content". The text itself
  // still lives in the inspector's textarea (one editor for it, not two that
  // could disagree), so this selects the note alone and drops the caret in.
  canvas.addEventListener("dblclick", (e) => {
    if (mode !== "edit" || e.button !== 0 || tool !== "select") return;
    const world = screenToWorld(camera, pointerScreen(e).x, pointerScreen(e).y);
    const pickable = pickOrder();
    for (let i = pickable.length - 1; i >= 0; i--) {
      const b = pickable[i]!;
      if (!pointInBody(b, world)) continue;
      // Only the topmost item under the pointer is considered: a note behind
      // something else is not what was double-clicked.
      if (b.layer !== "notes" || b.note.kind !== "text") return;
      setSelection([b.id]);
      focusNoteText();
      return;
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (mode !== "edit") return;
    const scr = pointerScreen(e);
    lastPointerScreen = scr;
    if (!drag) return;
    const world = screenToWorld(camera, scr.x, scr.y);
    dragMoved = true;

    // Snapshot once, on the first movement of a model-mutating drag (pan and
    // marquee don't touch the model; draw already snapshotted at mousedown;
    // a chain being strung out has not created anything yet, and takes its
    // snapshot in `addChain` when it lands).
    if (
      !dragPushed &&
      drag.mode !== "pan" &&
      drag.mode !== "marquee" &&
      drag.mode !== "chainDraw"
    ) {
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
      case "arrowEnd": {
        const p = snapVec(world);
        if (drag.movingIsHead) setArrowEnds(drag.body, drag.fixed, p);
        else setArrowEnds(drag.body, p, drag.fixed);
        markDirty();
        refreshFields();
        break;
      }
      case "draw": {
        const b = drag.body;
        const p = snapVec(world);
        if (isArrowNote(b)) {
          // An arrow is dragged out tail-first, exactly as an endpoint handle
          // moves it afterwards.
          setArrowEnds(b, drag.start, p);
          markDirty();
          refreshFields();
        } else if (b.shape.kind === "rect") {
          const w = Math.max(gridStep, Math.abs(p.x - drag.start.x));
          const h = Math.max(gridStep, Math.abs(p.y - drag.start.y));
          b.shape.w = w;
          b.shape.h = h;
          b.pos = new Vec2((drag.start.x + p.x) / 2, (drag.start.y + p.y) / 2);
        } else if (b.shape.kind === "circle") {
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
      case "polyVertex": {
        const b = drag.body;
        if (b.shape.kind !== "poly") break;
        const local = snapVec(world).sub(b.pos).rotated(-b.rot);
        const index = drag.index;
        const next = b.shape.verts.map((v, i) => (i === index ? local : v));
        // A rejected edit leaves the loop exactly as it was, so the vertex stalls
        // at the last convex position instead of the shape turning inside out.
        if (setPolyVerts(b, next)) drag.accepted = local;
        markDirty();
        refreshFields();
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
      case "rotateGroup": {
        // How far the pointer has swung since the grab, applied to the whole
        // body about its centre of mass. Tracked as a total rather than a
        // per-move delta so snapping cannot accumulate rounding across a drag.
        const d = world.sub(drag.centre);
        const wanted = snapAngle(Math.atan2(d.y, d.x) - drag.grabAngle);
        rotateGroupAbout(drag.items, drag.centre, wanted - drag.applied);
        drag.applied = wanted;
        markDirty();
        refreshFields();
        break;
      }
      case "chainDraw":
        drag.cursor = world;
        break;
      case "chainEnd": {
        drag.cursor = world;
        // Land on whatever body is under the pointer, so moving an end along its
        // own body and moving it onto a different one are the same gesture.
        const over = topmostAt(world, (b) => chainable(b));
        const c = drag.chain;
        const other = drag.end === "a" ? c.b : c.a;
        const otherItem = itemOf(other.itemId);
        const sameBody =
          over !== null &&
          (over.id === other.itemId ||
            (over.group !== null && over.group === otherItem?.group));
        if (over && !sameBody) {
          c[drag.end] = { itemId: over.id, local: nearestSurfaceLocal(over, world) };
        } else {
          // Off any body (or over the one the other end already holds): slide the
          // anchor around the body it has, so the drag never leaves the chain
          // tied to nothing.
          const own = itemOf(c[drag.end].itemId);
          if (own) c[drag.end] = { itemId: own.id, local: nearestSurfaceLocal(own, world) };
        }
        markDirty();
        refreshFields();
        break;
      }
    }
  });

  const itemOf = (id: number): EdItem | null => model.items.find((i) => i.id === id) ?? null;

  // The in-progress rubber-band, as a sorted world-space box (null unless one is
  // actually being dragged out — a click that never moves draws nothing).
  // The rubber band, plus which of the two CAD selection modes the drag
  // direction asks for: left→right is a **window** (only what it fully encloses),
  // right→left a **crossing** (anything it touches). Same convention as Fusion
  // 360 and AutoCAD. A drag with no horizontal travel counts as a window, so the
  // stricter mode is the one a degenerate drag falls into.
  function marqueeBand(): { min: Vec2; max: Vec2; window: boolean } | null {
    if (!drag || drag.mode !== "marquee" || !dragMoved) return null;
    const { start, current } = drag;
    return {
      min: new Vec2(Math.min(start.x, current.x), Math.min(start.y, current.y)),
      max: new Vec2(Math.max(start.x, current.x), Math.max(start.y, current.y)),
      window: current.x >= start.x,
    };
  }

  window.addEventListener("mouseup", () => {
    if (mode !== "edit" || !drag) return;
    if (drag.mode === "marquee") {
      const box = marqueeBand();
      if (box) {
        const caught = box.window ? bodyWithinRect : bodyIntersectsRect;
        const hits = pickableItems()
          .filter((b) => caught(b, box.min, box.max))
          .map((b) => b.id);
        // No group is ever half-caught: a band that touches one piece of a
        // compound body has touched the body.
        setSelection(
          withWholeGroups(drag.additive ? [...selectedIds, ...hits] : hits),
        );
      } else if (!drag.additive) {
        setSelection([]); // a plain click on empty space clears
      }
    }
    if (drag.mode === "chainDraw") {
      // A chain lands only on a body: released over empty space the gesture is
      // simply abandoned, rather than leaving one end in mid-air.
      const to = topmostAt(drag.cursor, (b) => chainable(b));
      if (to) addChain(drag.from, drag.local, to, drag.cursor);
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
      else if (polyDraft) cancelPolyDraft();
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
      focused instanceof HTMLTextAreaElement ||
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
        case "KeyG":
          // Ctrl+G welds the selection into one compound body; Ctrl+Shift+G
          // breaks one back up - the pairing every editor uses.
          if (e.shiftKey) ungroupSelected();
          else groupSelected();
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
    if ((e.code === "Enter" || e.code === "NumpadEnter") && polyDraft) {
      commitPolyDraft();
      e.preventDefault();
      return;
    }
    if (e.code === "Delete" || e.code === "Backspace") {
      deleteSelected();
      e.preventDefault();
    } else if (e.code === "KeyB") {
      // Spot-check a spot: test the ball from wherever the cursor is, without
      // moving the level's own spawn marker.
      startTest("ball", pointerWorld());
    } else if (e.code === "KeyV") setTool("select");
    else if (e.code === "KeyR") setTool("rect");
    else if (e.code === "KeyC") setTool("circle");
    else if (e.code === "KeyP") setTool("poly");
    else if (e.code === "KeyT") setTool("text");
    else if (e.code === "KeyA") setTool("arrow");
    else if (e.code === "KeyK") setTool("chain");
  });

  // Releasing an arrow closes the nudge run, so the next press starts a fresh
  // undo step.
  window.addEventListener("keyup", (e) => {
    if (NUDGE_DIRS[e.code]) nudging = false;
  });

  // The chain being strung out, as the renderer wants it: the fixed anchor, the
  // pointer, and whether releasing here would actually make a chain.
  function chainDraftView(): { from: Vec2; to: Vec2; valid: boolean } | null {
    if (!drag || drag.mode !== "chainDraw") return null;
    const from = toWorld(drag.from, drag.local);
    const to = topmostAt(drag.cursor, (b) => chainable(b));
    const valid =
      to !== null &&
      to.id !== drag.from.id &&
      !(drag.from.group !== null && to.group === drag.from.group);
    return { from, to: drag.cursor, valid };
  }

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
        marqueeBand(),
        visibleLayers,
        polyDraft ? { verts: polyDraft, cursor: pointerWorld() } : null,
        selectedChainIds,
        chainDraftView(),
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
// Layer visibility icon: an open eye when the layer draws, a closed lid when it
// does not. Inline SVG rather than an emoji or a glyph, so it inherits the
// toolbar's colour through `currentColor`, stays crisp at any DPI, and looks the
// same on every platform (👁 does not).
function eyeIcon(open: boolean): string {
  const svg = (body: string) =>
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  return open
    ? svg('<path d="M1 8s2.6-4.4 7-4.4S15 8 15 8s-2.6 4.4-7 4.4S1 8 1 8Z"/><circle cx="8" cy="8" r="1.9"/>')
    : // The same almond, shut: the lid curve plus three lashes, so a hidden
      // layer reads as "closed" and not merely as a missing icon.
      svg(
        '<path d="M1.4 6.6S4 10.4 8 10.4s6.6-3.8 6.6-3.8"/><path d="M3.1 9.3 1.9 11"/><path d="M8 10.4V12.5"/><path d="M12.9 9.3 14.1 11"/>',
      );
}

// Padlock for the layer list, drawn the same way as the eye (inline SVG on
// `currentColor`, so it takes the toolbar's colour and stays crisp at any DPI).
// The open state lifts the shackle off the case and hangs it to one side — an
// upright shackle that merely failed to meet the case reads as a rendering
// glitch rather than as "open".
function lockIcon(locked: boolean): string {
  const svg = (body: string) =>
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const body = '<rect x="2.8" y="7" width="9" height="6.2" rx="1.2"/>';
  return locked
    ? svg(`${body}<path d="M5 7V4.9a2.3 2.3 0 0 1 4.6 0V7"/>`)
    : svg(`${body}<path d="M9.6 7V4.9a2.3 2.3 0 0 1 4.6 0"/>`);
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
  .ed-text { background: #1f2430; color: #cbccc6; border: 1px solid #3c445c;
    font-family: monospace; font-size: 13px; padding: 4px; border-radius: 2px;
    width: 100%; box-sizing: border-box; resize: vertical; }
  .ed-color { width: 44px; height: 22px; padding: 0; background: #1f2430;
    border: 1px solid #3c445c; border-radius: 2px; cursor: pointer; }
  .ed-inline, .ed-check { display: inline-flex; gap: 4px; align-items: center; color: #9aa0ac; }
  .ed-layers { display: flex; flex-direction: column; gap: 4px; align-self: flex-start; }
  .ed-layer-label { color: #9aa0ac; }
  .ed-layer-row { display: flex; gap: 6px; align-items: center; }
  /* One width for every layer, so the list reads as a column rather than as
     buttons that happen to be stacked - but sized to its own longest name, not
     stretched across the whole toolbar. */
  .ed-layer-btn { min-width: 96px; text-align: left; }
  .ed-eye { display: flex; align-items: center; justify-content: center;
    width: 24px; height: 22px; padding: 0; background: transparent; color: #cbccc6;
    border: 1px solid transparent; border-radius: 2px; cursor: pointer; }
  .ed-eye:hover { background: #2a2f3d; border-color: #3c445c; }
  .ed-eye.off { color: #5b6172; }
  /* The padlock's resting state is *unlocked*, so it is the dim one: a row of
     lit padlocks would read as "everything is locked". Locked is amber rather
     than the accent blue, which the layer list already spends on "active". */
  .ed-lock { color: #5b6172; }
  .ed-lock.on { color: #e5c07b; }
  .ed-title { color: #65bddb; padding-top: 2px; }
  /* A cross-layer selection stacks one panel per layer, so the inspector can
     outgrow the viewport — it scrolls rather than running off the bottom. */
  .ed-inspector { position: absolute; top: 8px; right: 8px; width: 190px;
    background: rgba(31,36,48,0.92); border: 1px solid #313244; padding: 8px;
    border-radius: 2px; display: flex; flex-direction: column; gap: 10px;
    max-height: calc(100vh - 16px); overflow-y: auto;
    scrollbar-width: thin; scrollbar-color: #3c445c transparent; }
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
