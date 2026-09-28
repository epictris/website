// The perspective panel: the camera frame ("gate") with the rendered solids,
// the reference overlay, 3D labels and orbit / pan / dolly navigation.

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { assignReferenceFile, cameraPreset, chooseReference, expandView, frameScene } from "../actions";
import { image, type LoadedImage } from "../assets";
import { cameraMatrices } from "../core/camera";
import { replaceCamera, setReference } from "../core/commands";
import { clone, fmt, transform, vec } from "../core/math";
import type { Camera, PerspectiveReference, Vec3 } from "../core/types";
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

/** Where the reference overlay sits in a gate of the given size. */
export function overlayGeometry(width: number, height: number, r: PerspectiveReference, a: LoadedImage) {
  const factor = Math.min(width / a.width, height / a.height) * r.scale;
  return {
    width: a.width * factor,
    height: a.height * factor,
    cx: width * (0.5 + r.offsetPercent[0] / 100),
    cy: height * (0.5 + r.offsetPercent[1] / 100),
    radians: (r.rotationDegrees * Math.PI) / 180,
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
  const [gate, setGate] = createSignal<[number, number]>([1, 1], { equals: (a, b) => a[0] === b[0] && a[1] === b[1] });
  const [failure, setFailure] = createSignal<string | null>(null);
  const [labels, setLabels] = createSignal<{ id: string; x: number; y: number; color: string }[]>([]);
  const [ready, setReady] = createSignal(false);
  let drag: Drag | null = null;

  const reference = () => state.references.perspective;
  const referenceImage = createMemo(() => image(reference()?.image));
  const overlay = createMemo(() => {
    const r = reference();
    const a = referenceImage();
    if (!r || !a || !r.visible) return null;
    return {
      ...overlayGeometry(...gate(), r, a),
      url: a.url,
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
    const m = renderer.render(input);
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

  function pointerDown(ev: PointerEvent) {
    if (![0, 1, 2].includes(ev.button)) return;
    ev.preventDefault();
    setActiveView("perspective");
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

  const hud = () => {
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
        <span class="view-subtitle grow">3D FROM OUTLINES</span>
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
