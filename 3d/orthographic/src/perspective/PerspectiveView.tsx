// The perspective panel: the camera frame ("gate") with the rendered solids,
// the reference overlay, 3D labels and orbit / pan / dolly navigation.

import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show } from "solid-js";
import {
  assignReferenceFile,
  cameraPreset,
  chooseReference,
  expandView,
  frameScene,
  insertTracePoint,
  tracePointMoved,
} from "../actions";
import { image } from "../assets";
import { cameraMatrices } from "../core/camera";
import { replaceCamera, setReference, updateObject } from "../core/commands";
import { hiddenEdges } from "../core/compare";
import { clone, fmt, transform, vec } from "../core/math";
import { frameToImage, imageToFrame, overlayGeometry } from "../core/overlay";
import type { Camera, Point, SceneObject, Vec3 } from "../core/types";
import { meshes, meshVersion, onMeshChange } from "../meshes";
import {
  beginGesture,
  cancelGesture,
  commit,
  endGesture,
  isSelected,
  preview,
  report,
  selectId,
  setActiveView,
  setSelection,
  setUi,
  showInspectorTab,
  snapshot,
  state,
  ui,
} from "../store";
import { ExpandIcon, ImagePlusIcon } from "../ui/icons";
import { PerspectiveRenderer, pick, type RenderInput } from "./renderer";

let renderer: PerspectiveRenderer | null = null;
export const perspectiveRenderer = () => renderer;

export function renderInput(): RenderInput {
  return {
    camera: state.camera,
    display: state.display,
    sceneSize: state.scene.size,
    objects: state.objects.filter((e) => e.visible && meshes.get(e.id)?.indices.length),
    meshes,
    selected: isSelected,
  };
}

type Drag = {
  id: number;
  type: "orbit" | "pan" | "overlay";
  start: [number, number];
  before: string;
  camera: Camera;
  offset: [number, number];
  moved: boolean;
};

export function PerspectiveView() {
  let body!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let outlineCanvas!: HTMLCanvasElement;
  const [gate, setGate] = createSignal<[number, number]>([1, 1], { equals: (a, b) => a[0] === b[0] && a[1] === b[1] });
  const [failure, setFailure] = createSignal<string | null>(null);
  const [labels, setLabels] = createSignal<{ id: string; x: number; y: number; color: string }[]>([]);
  const [ready, setReady] = createSignal(false);
  let drag: Drag | null = null;

  const reference = () => state.references.perspective;
  const referenceImage = createMemo(() => image(reference()?.image));
  const depthImage = createMemo(() => image(reference()?.depth));
  const overlay = createMemo(() => {
    const r = reference();
    const a = referenceImage();
    if (!r || !a || !r.visible) return null;
    // The depth map covers the whole image, whatever its own resolution: it takes the image's place.
    const depth = ui.prefs.depth ? depthImage() : undefined;
    return {
      ...overlayGeometry(...gate(), r, a),
      url: (depth ?? a).url,
      opacity: r.opacity,
      rotation: r.rotationDegrees,
      blend: r.blend,
    };
  });
  const aligning = () => !!(ui.alignReference && reference() && referenceImage());

  function layout() {
    const r = body.getBoundingClientRect();
    const aspect = state.camera.frame[0] / state.camera.frame[1];
    if (r.width < 2 || r.height < 2) return;
    const w = Math.max(1, Math.floor(Math.min(r.width, r.height * aspect)));
    const h = Math.max(1, Math.floor(w / aspect));
    setGate([w, h]);
    const dpr = renderer?.software ? Math.min(1, 640 / w) : Math.min(devicePixelRatio || 1, 2);
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
  }

  function draw() {
    if (!renderer) return;
    const input = renderInput();
    // Over a reference image, the solids' outlines are drawn above it at full opacity.
    const m = renderer.render(input, overlay() ? outlineCanvas : undefined);
    if (!state.display.labels) {
      setLabels([]);
      return;
    }
    const [w, h] = gate();
    const out: { id: string; x: number; y: number; color: string }[] = [];
    for (const e of input.objects) {
      const q = transform(m.vp, e.min.map((v, i) => v + e.size[i] / 2) as Vec3);
      if (q[3] <= 0) continue;
      const [x, y, z] = [q[0] / q[3], q[1] / q[3], q[2] / q[3]];
      if (Math.abs(x) > 1 || Math.abs(y) > 1 || Math.abs(z) > 1) continue;
      out.push({ id: e.id, x: (x * 0.5 + 0.5) * w, y: (-y * 0.5 + 0.5) * h, color: e.color });
    }
    setLabels(out);
  }

  onMount(() => {
    try {
      renderer = new PerspectiveRenderer(canvas);
      renderer.onContextLost = () =>
        setFailure("The GPU context was lost. Save your project and reload the editor to restore 3D.");
      for (const [id, m] of meshes) renderer.upload(id, m);
      onMeshChange((id, m) => renderer?.upload(id, m));
      setReady(true);
    } catch (e) {
      setFailure(`${(e as Error).message} The orthographic editor and project Save remain available.`);
    }
    const observer = new ResizeObserver(() => {
      layout();
      draw();
    });
    observer.observe(body);
    onCleanup(() => observer.disconnect());
    layout();
  });

  // Redraw whenever anything the picture depends on changes.
  createEffect(
    on(
      () => [
        ready(),
        meshVersion(),
        JSON.stringify(state.camera),
        JSON.stringify(state.display),
        JSON.stringify(state.objects.map((e) => [e.id, e.min, e.size, e.color, e.visible, e.opacity])),
        state.scene.size.join(),
        ui.selected.join(),
        gate().join(),
        !!overlay(),
      ],
      () => {
        layout();
        draw();
      },
    ),
  );

  const local = (ev: MouseEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  };

  /** The trace mapping for the current gate: image pixels to gate pixels and back. */
  const traceSpace = createMemo(() => {
    const r = reference();
    const a = referenceImage();
    if (!r || !a) return null;
    const g = overlayGeometry(...gate(), r, a);
    return {
      toGate: (p: Point) => imageToFrame(g, a, p),
      toImage: (p: Point) => frameToImage(g, a, p),
    };
  });

  function pointerDown(ev: PointerEvent) {
    if (![0, 1, 2].includes(ev.button)) return;
    ev.preventDefault();
    setActiveView("perspective");
    const t = ui.tracing;
    const space = traceSpace();
    if (t && space && ev.button === 0) {
      setUi("tracing", "points", (pts) => [...pts, space.toImage(local(ev))]);
      return;
    }
    const type = aligning()
      ? "overlay"
      : ev.shiftKey || ev.button === 1 || ev.button === 2 || ui.spaceHeld
        ? "pan"
        : "orbit";
    if (state.camera.locked && type !== "overlay") {
      if (ev.button === 0) pickAt(ev);
      return;
    }
    canvas.setPointerCapture(ev.pointerId);
    drag = {
      id: ev.pointerId,
      type,
      start: local(ev),
      before: beginGesture(),
      camera: clone(state.camera),
      offset: [...(reference()?.offsetPercent ?? [0, 0])] as [number, number],
      moved: false,
    };
  }

  function pointerMove(ev: PointerEvent) {
    const d = drag;
    if (!d || d.id !== ev.pointerId) return;
    const q = local(ev);
    const dx = q[0] - d.start[0];
    const dy = q[1] - d.start[1];
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    ev.preventDefault();
    const [w, h] = gate();
    if (d.type === "overlay") {
      preview(d.before, (s) =>
        setReference(
          s,
          "perspective",
          { offsetPercent: [d.offset[0] + (dx / w) * 100, d.offset[1] + (dy / h) * 100] },
          image,
        ),
      );
      return;
    }
    const c = d.camera;
    let next: Camera;
    if (d.type === "pan") {
      const m = cameraMatrices(c);
      const unit = (2 * vec.len(vec.sub(c.position, c.target)) * Math.tan((c.fov * Math.PI) / 360)) / h;
      const delta = vec.add(vec.mul(m.right, -dx * unit), vec.mul(m.up, dy * unit));
      next = { ...c, position: vec.add(c.position, delta), target: vec.add(c.target, delta) };
    } else {
      const offset = vec.sub(c.position, c.target);
      const radius = vec.len(offset);
      const az = Math.atan2(offset[1], offset[0]) - dx * 0.006;
      const el = Math.max(
        -Math.PI / 2 + 0.015,
        Math.min(Math.PI / 2 - 0.015, Math.asin(offset[2] / radius) + dy * 0.006),
      );
      next = {
        ...c,
        position: vec.add(c.target, [
          radius * Math.cos(el) * Math.cos(az),
          radius * Math.cos(el) * Math.sin(az),
          radius * Math.sin(el),
        ]),
      };
    }
    preview(d.before, (s) => replaceCamera(s, next));
  }

  function pointerUp(ev: PointerEvent) {
    const d = drag;
    if (!d || d.id !== ev.pointerId) return;
    drag = null;
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch {}
    if (d.moved) endGesture(d.before);
    else if (d.type !== "overlay") pickAt(ev);
  }

  function cancel() {
    const d = drag;
    if (!d) return;
    drag = null;
    cancelGesture(d.before);
  }
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drag) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancel();
      }
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
    });
  });

  function pickAt(ev: MouseEvent) {
    const [px, py] = local(ev);
    const hit = pick(renderInput(), px, py, ...gate());
    if (hit) selectId(hit, ev.ctrlKey || ev.metaKey);
    else if (!(ev.ctrlKey || ev.metaKey)) setSelection([]);
  }

  // Wheel dollies the camera (or scales the overlay while aligning); one undo step per burst.
  let wheelBefore: string | null = null;
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  function wheel(ev: WheelEvent) {
    ev.preventDefault();
    setActiveView("perspective");
    if (state.camera.locked && !aligning()) return;
    wheelBefore ??= beginGesture();
    const delta = ev.deltaY * (ev.deltaMode === 1 ? 16 : 1);
    const factor = Math.exp(Math.max(-2, Math.min(2, delta * 0.0015)));
    const before = wheelBefore;
    if (aligning()) {
      const scale = Math.max(0.05, Math.min(8, reference()!.scale / factor));
      preview(snapshot(), (s) => setReference(s, "perspective", { scale }, image));
    } else {
      const c = state.camera;
      const off = vec.sub(c.position, c.target);
      const dist = vec.len(off);
      const next = Math.max(c.near * 4, Math.min(1e6, dist * factor));
      preview(snapshot(), (s) => replaceCamera(s, { ...c, position: vec.add(c.target, vec.mul(off, next / dist)) }));
    }
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelBefore = null;
      endGesture(before);
    }, 180);
  }

  function drop(ev: DragEvent) {
    const f = ev.dataTransfer?.files[0];
    if (!f?.type.startsWith("image/")) return;
    ev.preventDefault();
    ev.stopPropagation();
    document.dispatchEvent(new CustomEvent("orthographic-drop-handled"));
    assignReferenceFile("perspective", f);
  }

  /** Double-click near an edge of the selected object's trace (outline mode) inserts a point there. */
  function doubleClick(ev: MouseEvent) {
    const e = traceEditing();
    const space = traceSpace();
    if (!e?.trace || !space) return;
    const q = local(ev);
    const pts = e.trace.points.map(space.toGate);
    let best = { distance: Infinity, index: 0, at: q };
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = Math.max(0.01, Math.min(0.99, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      const h: Point = [a[0] + dx * t, a[1] + dy * t];
      const distance = Math.hypot(h[0] - q[0], h[1] - q[1]);
      if (distance < best.distance) best = { distance, index: i, at: h };
    });
    if (best.distance < 18) insertTracePoint(e.id, best.index, space.toImage(best.at));
  }

  /** The object whose trace is being edited: the one selected in outline mode, unlocked, with a trace. */
  const traceEditing = createMemo(() => {
    if (ui.mode !== "outline" || ui.selected.length !== 1 || ui.tracing) return null;
    const e = state.objects.find((o) => o.id === ui.selected[0]);
    return e?.trace && e.visible && !e.locked ? e : null;
  });

  const hud = () => {
    if (ui.tracing) return `TRACE · ${ui.tracing.points.length} corners · click to add, Enter closes, Escape cancels`;
    if (aligning()) return "ALIGN REFERENCE · drag image / wheel to scale";
    meshVersion(); // the object count depends on which meshes exist
    const shown = state.objects.filter((e) => e.visible && meshes.get(e.id)?.indices.length).length;
    return `${renderer?.software ? "CPU" : "GPU"} · ${shown} objects · FOV ${fmt(state.camera.fov, 1)}°`;
  };

  return (
    <article
      class="view-panel perspective"
      classList={{ "active-view": ui.activeView === "perspective", expanded: ui.focusView === "perspective" }}
      data-view="perspective"
      onDrop={drop}
    >
      <header class="view-head">
        <span class="view-number">04</span>
        <span class="view-title">Perspective</span>
        <span class="view-subtitle whole grow">
          <span>3D SOLIDS</span>
        </span>
        <span class="grow" />
        <label title={reference() ? "Show the perspective reference image" : "Assign a reference image first"}>
          <input
            type="checkbox"
            checked={!!reference()?.visible}
            disabled={!reference()}
            onChange={(e) =>
              report(commit((d) => setReference(d, "perspective", { visible: e.currentTarget.checked }, image)))
            }
          />
          Reference
        </label>
        <Show when={depthImage()}>
          <label title="Show the reference's estimated depth map (nearer lighter) in place of the image">
            <input
              type="checkbox"
              checked={ui.prefs.depth}
              disabled={!reference()?.visible}
              onChange={(e) => setUi("prefs", "depth", e.currentTarget.checked)}
            />
            Depth
          </label>
        </Show>
        <Show when={state.objects.some((e) => e.trace)}>
          <label title="Draw each object's trace over the reference: dashed where traced, dotted where guessed">
            <input
              type="checkbox"
              checked={ui.prefs.traces}
              onChange={(e) => setUi("prefs", "traces", e.currentTarget.checked)}
            />
            Traces
          </label>
        </Show>
        <button
          type="button"
          class="phead-btn"
          title="Camera and reference settings"
          onClick={() => showInspectorTab("camera")}
        >
          Camera
        </button>
        <button
          type="button"
          class="iconbtn"
          aria-label="Assign perspective reference image"
          title="Assign a reference image to the perspective view, or drop one onto it"
          onClick={() => chooseReference("perspective")}
        >
          <ImagePlusIcon />
        </button>
        <button
          type="button"
          class="iconbtn expand-btn"
          aria-label="Expand perspective"
          title="Expand perspective (4)"
          onClick={() => expandView("perspective")}
        >
          <ExpandIcon />
        </button>
      </header>
      <div class="view-body" id="pBody" ref={body}>
        <div id="pGate" style={{ width: `${gate()[0]}px`, height: `${gate()[1]}px` }}>
          <canvas
            ref={canvas}
            id="pCanvas"
            classList={{ "overlay-align": aligning(), "camera-locked": state.camera.locked }}
            aria-label="Perspective solid model. Drag to orbit; shift-drag to pan; click an object to select it."
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={cancel}
            onWheel={wheel}
            onDblClick={doubleClick}
            onContextMenu={(e) => e.preventDefault()}
          />
          <div id="pOverlayClip" style={{ "mix-blend-mode": overlay()?.blend ?? "normal" }}>
            <Show when={overlay()}>
              {(o) => (
                <img
                  id="pOverlayImg"
                  alt="Perspective reference"
                  draggable={false}
                  src={o().url}
                  style={{
                    display: "block",
                    width: `${o().width}px`,
                    height: `${o().height}px`,
                    left: `${o().cx - o().width / 2}px`,
                    top: `${o().cy - o().height / 2}px`,
                    transform: `rotate(${o().rotation}deg)`,
                    opacity: o().opacity,
                  }}
                />
              )}
            </Show>
          </div>
          <canvas ref={outlineCanvas} id="pOutline" style={{ display: overlay() ? "block" : "none" }} />
          <Show when={traceSpace()}>
            {(space) => <TraceLayer space={space()} editing={traceEditing()} gate={gate()} local={local} />}
          </Show>
          <div id="pLabels">
            <For each={labels()}>
              {(l) => (
                <span class="p-label" style={{ left: `${l.x}px`, top: `${l.y}px`, color: l.color }}>
                  {l.id}
                </span>
              )}
            </For>
          </div>
          <div id="pCrosshair" style={{ display: state.display.crosshair ? "block" : "none" }} />
        </div>
        <div class="p-hud">{failure() ? "3D rendering unavailable" : hud()}</div>
        <div class="p-corner">
          <button type="button" title="Frame all visible geometry" onClick={() => frameScene()}>
            Frame scene
          </button>
          <button
            type="button"
            title="Reset to a front-facing perspective camera"
            onClick={() => cameraPreset("front")}
          >
            Front camera
          </button>
        </div>
        <Show when={failure()}>
          <div id="pError">{failure()}</div>
        </Show>
      </div>
      <footer class="view-foot">
        <span>Drag: orbit · Shift/right drag: pan · Wheel: dolly</span>
        <span class="coords">
          {state.camera.frame[0]} × {state.camera.frame[1]} · Z-up
        </span>
      </footer>
    </article>
  );
}

interface TraceSpace {
  toGate: (p: Point) => Point;
  toImage: (p: Point) => Point;
}

/**
 * Objects' traces over the perspective view, in their colours: traced edges
 * dashed, hidden (guessed) edges dotted. In outline mode the selected object's
 * trace has handles: drag to move a point, double-click an edge to add one,
 * Delete to remove the selected one. A trace being drawn shows its corners.
 */
function TraceLayer(props: {
  space: TraceSpace;
  editing: SceneObject | null;
  gate: [number, number];
  local: (ev: MouseEvent) => [number, number];
}) {
  const traced = createMemo(() =>
    ui.prefs.traces ? state.objects.filter((e) => e.visible && e.trace && e.trace.points.length >= 3) : [],
  );
  const paths = (e: SceneObject) => {
    const pts = e.trace!.points.map(props.space.toGate);
    const hidden = hiddenEdges(pts.length, e.trace!.hidden);
    const seg = (want: boolean) =>
      pts
        .map((a, i) => {
          if (hidden[i] !== want) return "";
          const b = pts[(i + 1) % pts.length];
          return `M${a[0]},${a[1]}L${b[0]},${b[1]}`;
        })
        .join("");
    return { traced: seg(false), hidden: seg(true) };
  };
  let drag: { pointer: number; id: string; index: number; before: string; start: SceneObject; moved: boolean } | null =
    null;
  const down = (ev: PointerEvent, e: SceneObject, index: number) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    setUi("tracePoint", { id: e.id, index });
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    drag = { pointer: ev.pointerId, id: e.id, index, before: beginGesture(), start: clone(e), moved: false };
  };
  const move = (ev: PointerEvent) => {
    const d = drag;
    if (!d || d.pointer !== ev.pointerId) return;
    d.moved = true;
    const to = props.space.toImage(props.local(ev));
    preview(d.before, (s) => updateObject(s, d.id, { trace: tracePointMoved(d.start, d.index, to) }));
  };
  const up = (ev: PointerEvent) => {
    const d = drag;
    if (!d || d.pointer !== ev.pointerId) return;
    drag = null;
    if (d.moved) endGesture(d.before);
  };
  const drawing = createMemo(() => ui.tracing?.points.map(props.space.toGate) ?? []);
  // Handles are keyed by index, so the one being dragged (it holds the pointer capture) survives each update.
  return (
    <svg id="pTraces" width={props.gate[0]} height={props.gate[1]} aria-hidden="true">
      <For each={traced()}>
        {(e) => {
          const d = () => paths(e);
          const selected = () => isSelected(e.id);
          return (
            <g stroke={e.color} fill="none" stroke-width={selected() ? 2 : 1.3} stroke-linecap="round">
              <path d={d().traced} stroke-dasharray="7 4" />
              <path d={d().hidden} stroke-dasharray="0.5 4.5" stroke-width={selected() ? 2.6 : 2} />
            </g>
          );
        }}
      </For>
      <Show when={props.editing}>
        {(e) => (
          <Index each={e().trace!.points.map(props.space.toGate)}>
            {(q, i) => {
              const is = () => ui.tracePoint?.id === e().id && ui.tracePoint.index === i;
              return (
                <circle
                  class="trace-handle"
                  cx={q()[0]}
                  cy={q()[1]}
                  r={is() ? 5 : 3.5}
                  fill={is() ? "#fff5c8" : "#102a3a"}
                  stroke={is() ? "#ffe497" : e().color}
                  stroke-width={is() ? 2 : 1.4}
                  onPointerDown={(ev) => down(ev, e(), i)}
                  onPointerMove={move}
                  onPointerUp={up}
                  onPointerCancel={up}
                />
              );
            }}
          </Index>
        )}
      </Show>
      <Show when={drawing().length}>
        <path
          d={drawing()
            .map((q, i) => `${i ? "L" : "M"}${q[0]},${q[1]}`)
            .join("")}
          fill="none"
          stroke="#fff1aa"
          stroke-width="2"
          stroke-dasharray="4 3"
        />
        <For each={drawing()}>{(q) => <circle cx={q[0]} cy={q[1]} r="3.5" fill="#fff1aa" />}</For>
      </Show>
    </svg>
  );
}
