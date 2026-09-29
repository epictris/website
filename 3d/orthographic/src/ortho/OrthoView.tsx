// One interactive orthographic panel: header controls, the live drawing, and
// pointer editing (select, move, resize, outline vertices, redraw, pan, zoom).

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  assignReferenceFile,
  chooseReference,
  expandView,
  finishRedraw,
  fitView,
  insertPoint,
  viewSizes,
} from "../actions";
import { image } from "../assets";
import { moveObjects, setGroupAxis, setNormalizedOutline, setReference } from "../core/commands";
import { clone, fmt, MIN_SIZE } from "../core/math";
import { boundsOf } from "../core/model";
import { toWorld as outlineToWorld, toNormalized } from "../core/ring";
import type { Point, Ring, SceneObject, ViewId } from "../core/types";
import { AXES, VIEWS } from "../core/views";
import {
  beginGesture,
  cancelGesture,
  commit,
  endGesture,
  isSelected,
  obj,
  preview,
  report,
  selectedObjects,
  selectId,
  setActiveView,
  setSelection,
  setUi,
  state,
  toast,
  ui,
} from "../store";
import { ExpandIcon, ImagePlusIcon } from "../ui/icons";
import { type Frame, frameOf, type Rect, screenBox, toScreen, toWorld } from "./frame";
import { OrthoScene } from "./OrthoScene";

const NUMBERS: Record<ViewId, string> = { front: "01", top: "02", side: "03" };
const HINTS: Record<ViewId, [string, string]> = {
  front: ["Drag X ↔ / Z ↕ · Y unchanged", "X →   Z ↑"],
  top: ["Drag X ↔ / Y ↕ · Z unchanged", "Front below · back above"],
  side: ["Drag Y ↔ / Z ↕ · X unchanged", "Front left · back right"],
};

type Drag =
  | { type: "pan"; pointerId: number; startPx: Point; startCenter: Point }
  | {
      type: "move" | "resize";
      pointerId: number;
      startPx: Point;
      startWorld: Point;
      before: string;
      ids: string[];
      box: { min: number[]; max: number[] };
      handle?: string;
      moved: boolean;
    }
  | {
      type: "vertex";
      pointerId: number;
      startPx: Point;
      before: string;
      id: string;
      index: number;
      start: SceneObject;
      moved: boolean;
      invalid: boolean;
    };

const snap = (n: number, alt: boolean) =>
  ui.prefs.snap && !alt ? Math.round(n / ui.prefs.snapStep) * ui.prefs.snapStep : n;

export function OrthoView(props: { view: ViewId }) {
  const view = props.view;
  const def = VIEWS[view];
  const [a, b] = def.axes;
  let svg!: SVGSVGElement;
  const [size, setSize] = createSignal({ W: 0, H: 0 });
  const [coords, setCoords] = createSignal(HINTS[view][1]);
  const frame = createMemo<Frame>(() => frameOf(ui.orthoCameras[view], size().W, size().H));
  const items = createMemo(() =>
    state.objects.filter((e) => e.visible && (!ui.prefs.isolate || !ui.selected.length || ui.selected.includes(e.id))),
  );
  let drag: Drag | null = null;

  onMount(() => {
    const observer = new ResizeObserver(() => {
      const W = svg.clientWidth;
      const H = svg.clientHeight;
      viewSizes[view] = { W, H };
      setSize({ W, H });
      if (ui.orthoCameras[view].autoFit) fitView(view);
    });
    observer.observe(svg);
    onCleanup(() => observer.disconnect());
  });

  const local = (ev: PointerEvent | MouseEvent | WheelEvent): Point => {
    const r = svg.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  };
  const canTransform = () => selectedObjects().length > 0 && !selectedObjects().some((e) => e.locked);

  function pointerDown(ev: PointerEvent) {
    if (ev.button !== 0 && ev.button !== 1) return;
    setActiveView(view);
    const px = local(ev);
    const world = toWorld(frame(), ...px);
    const target = ev.target as Element;
    if (ev.button === 1 || ui.spaceHeld) {
      ev.preventDefault();
      svg.setPointerCapture(ev.pointerId);
      drag = {
        type: "pan",
        pointerId: ev.pointerId,
        startPx: px,
        startCenter: [...ui.orthoCameras[view].center] as Point,
      };
      setUi("panning", true);
      return;
    }
    if (ui.mode === "outline") return outlinePointerDown(ev, px, world, target);
    const handle = target.closest("[data-resize]") as HTMLElement | null;
    if (handle && canTransform()) {
      ev.preventDefault();
      svg.setPointerCapture(ev.pointerId);
      drag = { type: "resize", handle: handle.dataset.resize, ...gestureStart(ev, px, world) };
      return;
    }
    const hit = target.closest("[data-id]") as HTMLElement | null;
    if (!hit) {
      if (!(ev.ctrlKey || ev.metaKey)) setSelection([]);
      return;
    }
    const id = hit.dataset.id!;
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) return selectId(id, true);
    selectId(id, false, true);
    if (!canTransform()) {
      toast("This selection is locked. Use the padlock in the object list.");
      return;
    }
    svg.setPointerCapture(ev.pointerId);
    drag = { type: "move", ...gestureStart(ev, px, world) };
  }

  function gestureStart(ev: PointerEvent, px: Point, world: Point) {
    const box = boundsOf(selectedObjects())!;
    return {
      pointerId: ev.pointerId,
      startPx: px,
      startWorld: world,
      before: beginGesture(),
      ids: [...ui.selected],
      box: { min: [...box.min], max: [...box.max] },
      moved: false,
    };
  }

  function outlinePointerDown(ev: PointerEvent, px: Point, world: Point, target: Element) {
    ev.preventDefault();
    const r = ui.redrawing;
    if (r) {
      if (r.view === view)
        setUi("redrawing", "points", (pts) => [...pts, world.map((n) => snap(n, ev.altKey)) as Point]);
      return;
    }
    const hit = target.closest("[data-id]") as HTMLElement | null;
    if (!hit) return;
    const id = hit.dataset.id!;
    const e = obj(id);
    if (!e) return;
    if (ev.ctrlKey || ev.metaKey) return selectId(id, true);
    if (!isSelected(id) || ui.selected.length !== 1) selectId(id);
    if (e.locked) {
      toast("Unlock this object to edit its outline.");
      return;
    }
    const insert = target.closest("[data-insert]") as HTMLElement | null;
    if (insert) return insertPoint(Number(insert.dataset.insert));
    const vertex = target.closest("[data-vertex]") as HTMLElement | null;
    if (!vertex) {
      setUi("pointSelection", null);
      return;
    }
    const index = Number(vertex.dataset.vertex);
    setUi("pointSelection", { id, view, index });
    svg.setPointerCapture(ev.pointerId);
    drag = {
      type: "vertex",
      pointerId: ev.pointerId,
      startPx: px,
      before: beginGesture(),
      id,
      index,
      start: clone(e),
      moved: false,
      invalid: false,
    };
  }

  function pointerMove(ev: PointerEvent) {
    const px = local(ev);
    const world = toWorld(frame(), ...px);
    setCoords(`${AXES[a].toUpperCase()} ${fmt(world[0], 2)} · ${AXES[b].toUpperCase()} ${fmt(world[1], 2)}`);
    const d = drag;
    if (!d || d.pointerId !== ev.pointerId) return;
    ev.preventDefault();
    if (d.type === "pan") {
      const s = ui.orthoCameras[view].scale;
      setUi("orthoCameras", view, {
        center: [d.startCenter[0] - (px[0] - d.startPx[0]) / s, d.startCenter[1] + (px[1] - d.startPx[1]) / s],
        autoFit: false,
      });
      return;
    }
    if (!d.moved && Math.hypot(px[0] - d.startPx[0], px[1] - d.startPx[1]) < 2) return;
    d.moved = true;
    if (d.type === "vertex") {
      const start = d.start;
      const old = outlineToWorld(start, view, start.outlines[view][d.index]);
      let q: Point = [...world];
      if (ev.shiftKey) {
        if (Math.abs(q[0] - old[0]) >= Math.abs(q[1] - old[1])) q[1] = old[1];
        else q[0] = old[0];
      }
      q = q.map((n) => snap(n, ev.altKey)) as Point;
      const raw = clone(start.outlines[view]) as Ring;
      raw[d.index] = toNormalized(start, view, q);
      d.invalid = preview(d.before, (s) => setNormalizedOutline(s, d.id, view, raw)).length > 0;
      setCoords(
        d.invalid
          ? "Crossing or collapsed edges are rejected"
          : q.map((n, j) => `${AXES[def.axes[j]].toUpperCase()} ${fmt(n, 3)}`).join(" · "),
      );
      return;
    }
    const delta: Point = [world[0] - d.startWorld[0], world[1] - d.startWorld[1]];
    if (d.type === "move") {
      if (ev.shiftKey) {
        if (Math.abs(delta[0]) >= Math.abs(delta[1])) delta[1] = 0;
        else delta[0] = 0;
      }
      [a, b].forEach((axis, j) => {
        if (delta[j] !== 0) delta[j] = snap(d.box.min[axis] + delta[j], ev.altKey) - d.box.min[axis];
      });
      const move: [number, number, number] = [0, 0, 0];
      move[a] = delta[0];
      move[b] = delta[1];
      preview(d.before, (s) => moveObjects(s, d.ids, move));
      return;
    }
    // Resize: which sides each handle drags, per screen axis (-1 fixed, 0 low side, 1 high side).
    const sides: Record<string, [number, number]> = {
      nw: [0, 1],
      n: [-1, 1],
      ne: [1, 1],
      e: [1, -1],
      se: [1, 0],
      s: [-1, 0],
      sw: [0, 0],
      w: [0, -1],
    };
    const which = sides[d.handle!];
    const lo = [...d.box.min];
    const hi = [...d.box.max];
    [a, b].forEach((axis, j) => {
      if (which[j] === 0) lo[axis] = Math.min(hi[axis] - MIN_SIZE, snap(lo[axis] + delta[j], ev.altKey));
      else if (which[j] === 1) hi[axis] = Math.max(lo[axis] + MIN_SIZE, snap(hi[axis] + delta[j], ev.altKey));
    });
    preview(d.before, (s) => [...setGroupAxis(s, d.ids, a, lo[a], hi[a]), ...setGroupAxis(s, d.ids, b, lo[b], hi[b])]);
  }

  function pointerUp(ev: PointerEvent) {
    const d = drag;
    if (!d || d.pointerId !== ev.pointerId) return;
    drag = null;
    try {
      svg.releasePointerCapture(ev.pointerId);
    } catch {}
    if (d.type === "pan") {
      setUi("panning", false);
      return;
    }
    if (d.moved) endGesture(d.before);
    if (d.type === "vertex" && d.invalid) toast("The last valid outline was kept. Edges cannot cross.", true);
  }

  function cancelDrag() {
    const d = drag;
    if (!d) return;
    drag = null;
    if (d.type === "pan") {
      setUi("orthoCameras", view, "center", d.startCenter);
      setUi("panning", false);
    } else cancelGesture(d.before);
  }
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drag) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancelDrag();
      }
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancelDrag);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancelDrag);
    });
  });

  function wheel(ev: WheelEvent) {
    ev.preventDefault();
    if (drag) return;
    setActiveView(view);
    const px = local(ev);
    const point = toWorld(frame(), ...px);
    const delta = ev.deltaY * (ev.deltaMode === 1 ? 18 : 1);
    const scale = Math.max(1e-4, Math.min(1e5, ui.orthoCameras[view].scale * Math.exp(-delta * 0.0015)));
    const { W, H } = size();
    setUi("orthoCameras", view, {
      scale,
      center: [point[0] - (px[0] - W / 2) / scale, point[1] + (px[1] - H / 2) / scale],
      autoFit: false,
    });
  }

  function doubleClick(ev: MouseEvent) {
    if (ui.mode !== "outline" || ui.selected.length !== 1) return;
    ev.preventDefault();
    if (ui.redrawing) return finishRedraw();
    const e = selectedObjects()[0];
    const f = frame();
    const screen = local(ev);
    let best = { distance: Infinity, index: 0, world: [0, 0] as Point };
    const ring = e.outlines[view];
    ring.forEach((p, i) => {
      const pa = toScreen(f, ...outlineToWorld(e, view, p));
      const pb = toScreen(f, ...outlineToWorld(e, view, ring[(i + 1) % ring.length]));
      const dx = pb[0] - pa[0];
      const dy = pb[1] - pa[1];
      const t = Math.max(
        0.01,
        Math.min(0.99, ((screen[0] - pa[0]) * dx + (screen[1] - pa[1]) * dy) / (dx * dx + dy * dy || 1)),
      );
      const h: Point = [pa[0] + dx * t, pa[1] + dy * t];
      const distance = Math.hypot(h[0] - screen[0], h[1] - screen[1]);
      if (distance < best.distance) best = { distance, index: i, world: toWorld(f, ...h) };
    });
    setActiveView(view);
    if (best.distance < 18) insertPoint(best.index, best.world);
  }

  function drop(ev: DragEvent) {
    const f = ev.dataTransfer?.files[0];
    if (!f?.type.startsWith("image/")) return;
    ev.preventDefault();
    ev.stopPropagation();
    document.dispatchEvent(new CustomEvent("orthographic-drop-handled"));
    assignReferenceFile(view, f);
  }

  const reference = () => state.references[view];
  const toggleReference = (on: boolean) => report(commit((d) => setReference(d, view, { visible: on }, image)));

  return (
    <article
      class={`view-panel ${view}`}
      classList={{ "active-view": ui.activeView === view, expanded: ui.focusView === view }}
      data-view={view}
      onDrop={drop}
    >
      <header class="view-head">
        <span class="view-number">{NUMBERS[view]}</span>
        <span class="view-title">{def.name}</span>
        <span class="view-subtitle grow">{def.description}</span>
        <span class="grow" style={{ flex: 0.1 }} />
        <label
          title={
            reference()
              ? `Show the ${def.name.toLowerCase()} reference image behind the outlines`
              : "Assign a reference image first"
          }
        >
          <input
            type="checkbox"
            checked={!!reference()?.visible}
            disabled={!reference()}
            onChange={(e) => toggleReference(e.currentTarget.checked)}
          />
          Reference
        </label>
        <button
          type="button"
          class="iconbtn"
          aria-label={`Assign ${def.name.toLowerCase()} reference image`}
          title={`Assign a reference image to the ${def.name.toLowerCase()} view, or drop one onto it`}
          onClick={() => chooseReference(view)}
        >
          <ImagePlusIcon />
        </button>
        <button
          type="button"
          class="iconbtn expand-btn"
          aria-label={`Expand ${def.name.toLowerCase()} view`}
          title={`Expand ${def.name.toLowerCase()} view (${Number(NUMBERS[view])})`}
          onClick={() => expandView(view)}
        >
          <ExpandIcon />
        </button>
      </header>
      <div class="view-body">
        <svg
          ref={svg}
          class="stage"
          role="img"
          aria-label={`${def.name} projection. Dragging changes ${AXES[a].toUpperCase()} and ${AXES[b].toUpperCase()}.`}
          viewBox={`0 0 ${size().W} ${size().H}`}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={cancelDrag}
          onWheel={wheel}
          onDblClick={doubleClick}
        >
          <Show when={size().W >= 5 && size().H >= 5}>
            <OrthoScene
              view={view}
              frame={frame()}
              state={state}
              items={items()}
              selected={isSelected}
              showGrid={ui.prefs.grid}
              showLabels={ui.prefs.labels}
              showBounds={ui.prefs.bounds}
              reserved={dimensionRects(view, frame())}
            >
              <SelectionOverlay view={view} frame={frame()} />
            </OrthoScene>
          </Show>
        </svg>
      </div>
      <footer class="view-foot">
        <span>{HINTS[view][0]}</span>
        <span class="coords">{coords()}</span>
      </footer>
    </article>
  );
}

/** The selection's screen box and its dimension texts, or null when nothing visible is selected. */
function selectionBox(view: ViewId, frame: Frame) {
  const [a, d] = VIEWS[view].axes;
  const items = selectedObjects();
  const bb = boundsOf(items);
  if (!bb || !items.some((e) => e.visible)) return null;
  const s = screenBox(frame, view, bb.min, bb.max);
  return {
    ...s,
    cx: (s.left + s.right) / 2,
    cy: (s.top + s.bottom) / 2,
    w: `${fmt(bb.max[a] - bb.min[a], 3)} m`,
    h: `${fmt(bb.max[d] - bb.min[d], 3)} m`,
    locked: items.some((e) => e.locked),
  };
}

/** Where the selection's dimension labels sit, so object labels can keep clear of them. */
function dimensionRects(view: ViewId, frame: Frame): Rect[] {
  const s = selectionBox(view, frame);
  if (!s) return [];
  return [
    { x: s.cx - s.w.length * 3.2 - 3, y: s.top - 21, w: s.w.length * 6.4 + 6, h: 15 },
    { x: s.left - 21, y: s.cy - s.h.length * 3.2 - 3, w: 15, h: s.h.length * 6.4 + 6 },
  ];
}

/** Selection box, dimensions and resize handles; in outline mode also the vertex handles. */
function SelectionOverlay(props: { view: ViewId; frame: Frame }) {
  const box = createMemo(() => selectionBox(props.view, props.frame));
  const handles = (s: NonNullable<ReturnType<typeof box>>) =>
    [
      ["nw", s.left, s.top, "nwse-resize"],
      ["n", s.cx, s.top, "ns-resize"],
      ["ne", s.right, s.top, "nesw-resize"],
      ["e", s.right, s.cy, "ew-resize"],
      ["se", s.right, s.bottom, "nwse-resize"],
      ["s", s.cx, s.bottom, "ns-resize"],
      ["sw", s.left, s.bottom, "nesw-resize"],
      ["w", s.left, s.cy, "ew-resize"],
    ] as const;
  const editing = createMemo(() => {
    if (ui.mode !== "outline" || ui.selected.length !== 1 || ui.contourView !== props.view) return null;
    const e = selectedObjects()[0];
    return e?.visible ? e : null;
  });
  return (
    <Show when={box()}>
      {(s) => (
        <g data-selection-overlay="true">
          <rect
            x={s().left}
            y={s().top}
            width={s().width}
            height={s().height}
            fill="none"
            stroke="#e4f7fa"
            stroke-opacity=".65"
            stroke-dasharray="5 4"
            stroke-width=".8"
            pointer-events="none"
          />
          <path
            d={`M${s().cx - 5},${s().cy}h10 M${s().cx},${s().cy - 5}v10`}
            stroke="#ffffff"
            stroke-width="1"
            stroke-opacity=".8"
            pointer-events="none"
          />
          <g pointer-events="none" font-family="monospace" font-size="10" fill="#e4f7fa">
            <path
              d={`M${s().left},${s().top - 7}v-9 M${s().right},${s().top - 7}v-9 M${s().left},${s().top - 12}H${s().right}`}
              stroke="#d2ecf3"
              stroke-opacity=".6"
              stroke-width=".7"
            />
            <rect
              x={s().cx - s().w.length * 3.2 - 3}
              y={s().top - 21}
              width={s().w.length * 6.4 + 6}
              height="15"
              rx="2"
              fill="#15283a"
            />
            <text x={s().cx} y={s().top - 10} text-anchor="middle">
              {s().w}
            </text>
            <path
              d={`M${s().left - 7},${s().top}h-9 M${s().left - 7},${s().bottom}h-9 M${s().left - 12},${s().top}V${s().bottom}`}
              stroke="#d2ecf3"
              stroke-opacity=".6"
              stroke-width=".7"
            />
            <g transform={`translate(${s().left - 12},${s().cy}) rotate(-90)`}>
              <rect
                x={-s().h.length * 3.2 - 3}
                y="-9"
                width={s().h.length * 6.4 + 6}
                height="15"
                rx="2"
                fill="#15283a"
              />
              <text text-anchor="middle" y="2">
                {s().h}
              </text>
            </g>
          </g>
          <Show when={ui.mode === "resize" && !s().locked}>
            <For each={handles(s())}>
              {([id, x, y, cursor]) => (
                <rect
                  class="resize-handle"
                  data-resize={id}
                  x={x - 4.5}
                  y={y - 4.5}
                  width="9"
                  height="9"
                  rx="1.5"
                  fill="#b0f8e9"
                  stroke="#073f3c"
                  stroke-width="1.2"
                  style={{ cursor }}
                />
              )}
            </For>
          </Show>
          <Show when={editing()}>{(e) => <VertexHandles view={props.view} frame={props.frame} e={e()} />}</Show>
        </g>
      )}
    </Show>
  );
}

function VertexHandles(props: { view: ViewId; frame: Frame; e: SceneObject }) {
  const points = createMemo(() =>
    props.e.outlines[props.view].map((p) => toScreen(props.frame, ...outlineToWorld(props.e, props.view, p))),
  );
  const selectedIndex = () => {
    const p = ui.pointSelection;
    return p && p.id === props.e.id && p.view === props.view ? p.index : -1;
  };
  const insertAt = createMemo(() => {
    const i = selectedIndex();
    const pts = points();
    if (i < 0 || props.e.locked || !pts[i]) return null;
    const next = pts[(i + 1) % pts.length];
    return { i, x: (pts[i][0] + next[0]) / 2, y: (pts[i][1] + next[1]) / 2 };
  });
  const redraw = createMemo(() => {
    const r = ui.redrawing;
    if (!r || r.view !== props.view || r.id !== props.e.id) return null;
    return r.points.map((p) => toScreen(props.frame, ...p));
  });
  return (
    <>
      <Show when={!props.e.locked}>
        <For each={points()}>
          {(q, i) => {
            const is = () => selectedIndex() === i();
            return (
              <>
                <circle
                  class="vertex-handle"
                  data-vertex={i()}
                  data-id={props.e.id}
                  cx={q[0]}
                  cy={q[1]}
                  r={is() ? 5 : 3}
                  fill={is() ? "#fff5c8" : "#102a3a"}
                  stroke={is() ? "#ffe497" : props.e.color}
                  stroke-width={is() ? 2 : 1.25}
                />
                <Show when={ui.prefs.pointIds || is()}>
                  <text
                    x={q[0] + 6}
                    y={q[1] - 6}
                    fill={is() ? "#ffe497" : props.e.color}
                    font-family="monospace"
                    font-size="10"
                    pointer-events="none"
                  >
                    {i() + 1}
                  </text>
                </Show>
              </>
            );
          }}
        </For>
      </Show>
      <Show when={insertAt()}>
        {(p) => (
          <g class="insert-point" data-insert={p().i} data-id={props.e.id}>
            <circle cx={p().x} cy={p().y} r="6" fill="#103a40" stroke="#92eee2" />
            <path d={`M${p().x - 3},${p().y}h6 M${p().x},${p().y - 3}v6`} stroke="#c2fff3" pointer-events="none" />
          </g>
        )}
      </Show>
      <Show when={redraw()}>
        {(pts) => (
          <>
            <path
              d={pts()
                .map((q, i) => `${i ? "L" : "M"}${q[0]},${q[1]}`)
                .join(" ")}
              fill="none"
              stroke="#fff1aa"
              stroke-width="2"
              stroke-dasharray="4 3"
              pointer-events="none"
            />
            <For each={pts()}>{(q) => <circle cx={q[0]} cy={q[1]} r="4" fill="#fff1aa" pointer-events="none" />}</For>
          </>
        )}
      </Show>
    </>
  );
}
