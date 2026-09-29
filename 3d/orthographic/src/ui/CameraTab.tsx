// Inspector: the perspective camera, its frame, the perspective reference overlay and display options.

import { For, Show } from "solid-js";
import { cameraPreset, chooseReference, frameScene } from "../actions";
import { image } from "../assets";
import { fovToFocal, horizontalFov } from "../core/camera";
import { type CameraPatch, setCamera, setDisplay, setReference } from "../core/commands";
import { fmt, lengthText, vec } from "../core/math";
import type { Blend, DisplayStyle, Vec3 } from "../core/types";
import { AXES } from "../core/views";
import { savePerspectivePng } from "../io";
import { beginGesture, commit, endGesture, preview, report, setUi, state, ui } from "../store";
import { Field, num } from "./fields";

const cam = (patch: CameraPatch) => report(commit((d) => setCamera(d, patch)));

function Slider(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  label: string;
  onPreview: (v: number, from: string) => void;
}) {
  let before: string | null = null;
  return (
    <input
      type="range"
      aria-label={props.label}
      min={props.min}
      max={props.max}
      step={props.step}
      value={props.value}
      disabled={props.disabled}
      style={{ width: "100%" }}
      onPointerDown={() => (before = beginGesture())}
      onInput={(e) => {
        before ??= beginGesture();
        props.onPreview(Number(e.currentTarget.value), before);
      }}
      onChange={() => {
        if (before) endGesture(before);
        before = null;
      }}
    />
  );
}

export function CameraTab() {
  const c = () => state.camera;
  const ref = () => state.references.perspective;
  const img = () => image(ref()?.image);
  const setVec = (key: "position" | "target", a: number, v: string) => {
    const n = num(v);
    if (n === null) return;
    const next = [...c()[key]] as Vec3;
    next[a] = n;
    cam({ [key]: next });
  };
  const refChange = (patch: Parameters<typeof setReference>[2]) =>
    report(commit((d) => setReference(d, "perspective", patch, image)));

  return (
    <div class="camera-tab">
      <section class="inspect-section">
        <div class="flex">
          <span class="eyebrow grow">Perspective camera</span>
          <span class="badge">Z-UP</span>
        </div>
        <p class="note">
          Orbit in the 3D view, or enter an exact pose here. Objects are edited in the three orthographic views.
        </p>
        <div class="section-title" style={{ "margin-top": "16px" }}>
          Position / look-at target · m
        </div>
        <div class="transform-grid">
          <span />
          <span class="column-label">Camera position</span>
          <span class="column-label">Look-at target</span>
          <For each={[0, 1, 2]}>
            {(a) => (
              <>
                <label class={`axis-dot axis-${AXES[a]}`} for={`cam-pos-${AXES[a]}`}>
                  {AXES[a].toUpperCase()}
                </label>
                <Field
                  type="number"
                  step="0.1"
                  id={`cam-pos-${AXES[a]}`}
                  aria-label={`Camera ${AXES[a]}`}
                  value={fmt(c().position[a], 4)}
                  onCommit={(v) => setVec("position", a, v)}
                />
                <Field
                  type="number"
                  step="0.1"
                  aria-label={`Look-at ${AXES[a]}`}
                  value={fmt(c().target[a], 4)}
                  onCommit={(v) => setVec("target", a, v)}
                />
              </>
            )}
          </For>
        </div>
        <div class="section-title" style={{ "margin-top": "17px" }}>
          <label for="cam-fov">Vertical field of view</label>
          <Field
            type="number"
            min="5"
            max="140"
            step="0.1"
            id="cam-fov"
            aria-label="Vertical field of view in degrees"
            style={{ width: "74px", height: "29px", padding: "4px 6px" }}
            value={fmt(c().fov, 2)}
            onCommit={(v) => {
              const n = num(v);
              if (n !== null) cam({ fov: n });
            }}
          />
        </div>
        <Slider
          label="Vertical field of view"
          min={5}
          max={140}
          step={0.1}
          value={c().fov}
          onPreview={(v, from) => preview(from, (d) => setCamera(d, { fov: v }))}
        />
        <div class="section-title" style={{ "margin-top": "10px" }}>
          <label for="cam-focal" title="Full-frame (36 × 24 mm) equivalent: f = 12 mm / tan(vertical FOV / 2)">
            Focal length · mm
          </label>
          <Field
            type="number"
            min="4.4"
            max="275"
            step="0.1"
            id="cam-focal"
            aria-label="Full-frame equivalent focal length in millimetres"
            style={{ width: "74px", height: "29px", padding: "4px 6px" }}
            value={fmt(fovToFocal(c().fov), 2)}
            onCommit={(v) => {
              const n = num(v);
              if (n !== null) cam({ focalLengthMm: n });
            }}
          />
        </div>
        <p class="note">
          {fmt(c().fov, 1)}° vertical / {fmt(horizontalFov(c()), 1)}° horizontal · {fmt(fovToFocal(c().fov), 1)} mm
          full-frame · distance {lengthText(vec.len(vec.sub(c().position, c().target)))}
        </p>
        <div class="section-title" style={{ "margin-top": "12px" }}>
          <span title="Slides the frame across the image plane: the horizon moves while verticals stay vertical">
            Lens shift · frame
          </span>
        </div>
        <div class="triplet shift-pair">
          <For each={[0, 1] as const}>
            {(axis) => (
              <label>
                {axis === 0 ? "Right" : "Up"}
                <Field
                  type="number"
                  min="-1"
                  max="1"
                  step="0.01"
                  value={fmt(c().shift?.[axis] ?? 0, 4)}
                  onCommit={(v) => {
                    const n = num(v);
                    if (n === null) return;
                    const shift: [number, number] = [...(c().shift ?? [0, 0])];
                    shift[axis] = n;
                    cam({ shift });
                  }}
                />
              </label>
            )}
          </For>
        </div>
        <div class="triplet" style={{ "margin-top": "12px" }}>
          <label>
            Roll °
            <Field
              type="number"
              min="-180"
              max="180"
              step="1"
              value={fmt(c().roll, 4)}
              onCommit={(v) => num(v) !== null && cam({ roll: num(v)! })}
            />
          </label>
          <label>
            Near clip
            <Field
              type="number"
              min="0.0001"
              step="0.01"
              value={fmt(c().near, 4)}
              onCommit={(v) => num(v) !== null && cam({ near: num(v)! })}
            />
          </label>
          <label>
            Far clip
            <Field
              type="number"
              min="1"
              step="10"
              value={fmt(c().far, 4)}
              onCommit={(v) => num(v) !== null && cam({ far: num(v)! })}
            />
          </label>
        </div>
        <div class="inspector-actions" style={{ "margin-top": "13px" }}>
          <button type="button" class="btn" onClick={() => cameraPreset("front")}>
            Front camera
          </button>
          <button type="button" class="btn" onClick={() => cameraPreset("overview")}>
            Overview
          </button>
          <button type="button" class="btn" onClick={() => frameScene()}>
            Frame scene
          </button>
        </div>
        <label class="pcheck">
          <input type="checkbox" checked={c().locked} onChange={(e) => cam({ locked: e.currentTarget.checked })} />
          Lock camera navigation
        </label>
      </section>
      <section class="inspect-section">
        <div class="section-title">Camera frame / PNG size</div>
        <div class="p-frame-inputs">
          <Field
            type="number"
            min="128"
            max="4096"
            step="1"
            aria-label="Frame width in pixels"
            value={c().frame[0]}
            onCommit={(v) => num(v) !== null && cam({ frame: [num(v)!, c().frame[1]] })}
          />
          <span>×</span>
          <Field
            type="number"
            min="128"
            max="4096"
            step="1"
            aria-label="Frame height in pixels"
            value={c().frame[1]}
            onCommit={(v) => num(v) !== null && cam({ frame: [c().frame[0], num(v)!] })}
          />
          <span>px</span>
        </div>
        <p class="note">The frame fixes the aspect ratio, so the framing stays the same when the panel is resized.</p>
        <div class="inspector-actions" style={{ "margin-top": "10px" }}>
          <button type="button" class="btn" onClick={() => cam({ frame: [1920, 1080] })}>
            16:9
          </button>
          <button
            type="button"
            class="btn"
            disabled={!img()}
            title="Match the frame to the perspective reference image"
            onClick={() => {
              const a = img()!;
              const s = Math.min(1, 4096 / Math.max(a.width, a.height));
              cam({ frame: [Math.max(128, Math.round(a.width * s)), Math.max(128, Math.round(a.height * s))] });
            }}
          >
            Image ratio
          </button>
        </div>
      </section>
      <section class="inspect-section">
        <div class="section-title">
          Perspective reference <span>{img() ? `${img()!.width} × ${img()!.height}` : "No image"}</span>
        </div>
        <div class="inspector-actions">
          <button type="button" class="btn primary" onClick={() => chooseReference("perspective")}>
            {ref() ? "Replace image" : "Load image"}
          </button>
          <button
            type="button"
            class="btn"
            disabled={!state.references.front}
            title="Use the front view's reference image here too"
            onClick={() => refChange({ image: state.references.front!.image, visible: true })}
          >
            Use front reference
          </button>
        </div>
        <Show when={img()}>
          <div id="overlayPreviewRow" style={{ display: "flex" }}>
            <img id="overlayThumb" alt="Perspective reference thumbnail" src={img()!.url} />
            <span class="small muted">{img()!.name}</span>
            <button
              type="button"
              class="iconbtn"
              title="Remove the perspective reference"
              onClick={() => report(commit((d) => setReference(d, "perspective", null, image)))}
            >
              ✕
            </button>
          </div>
        </Show>
        <div class="pchecks">
          <label class="pcheck">
            <input
              type="checkbox"
              checked={!!ref()?.visible}
              disabled={!ref()}
              onChange={(e) => refChange({ visible: e.currentTarget.checked })}
            />
            Show reference
          </label>
          <label class="pcheck">
            <input
              type="checkbox"
              checked={ui.alignReference}
              disabled={!ref()}
              onChange={(e) => setUi("alignReference", e.currentTarget.checked)}
            />
            Align image
          </label>
        </div>
        <div class="section-title" style={{ margin: "12px 0 5px" }}>
          Opacity <span>{Math.round((ref()?.opacity ?? 0.5) * 100)}%</span>
        </div>
        <Slider
          label="Reference opacity"
          min={0}
          max={1}
          step={0.01}
          disabled={!ref()}
          value={ref()?.opacity ?? 0.5}
          onPreview={(v, from) => preview(from, (d) => setReference(d, "perspective", { opacity: v }, image))}
        />
        <div class="triplet" style={{ "margin-top": "11px" }}>
          <label>
            Offset X %
            <Field
              type="number"
              step="0.1"
              disabled={!ref()}
              value={fmt(ref()?.offsetPercent[0] ?? 0, 2)}
              onCommit={(v) => num(v) !== null && refChange({ offsetPercent: [num(v)!, ref()!.offsetPercent[1]] })}
            />
          </label>
          <label>
            Offset Y %
            <Field
              type="number"
              step="0.1"
              disabled={!ref()}
              value={fmt(ref()?.offsetPercent[1] ?? 0, 2)}
              onCommit={(v) => num(v) !== null && refChange({ offsetPercent: [ref()!.offsetPercent[0], num(v)!] })}
            />
          </label>
          <label>
            Scale %
            <Field
              type="number"
              min="5"
              max="800"
              step="1"
              disabled={!ref()}
              value={fmt((ref()?.scale ?? 1) * 100, 2)}
              onCommit={(v) => num(v) !== null && refChange({ scale: num(v)! / 100 })}
            />
          </label>
        </div>
        <div class="p-two" style={{ "margin-top": "10px" }}>
          <label class="labelled">
            Rotation °
            <Field
              type="number"
              min="-180"
              max="180"
              step="0.1"
              disabled={!ref()}
              value={fmt(ref()?.rotationDegrees ?? 0, 2)}
              onCommit={(v) => num(v) !== null && refChange({ rotationDegrees: num(v)! })}
            />
          </label>
          <label class="labelled">
            Blend
            <select
              value={ref()?.blend ?? "normal"}
              disabled={!ref()}
              onChange={(e) => refChange({ blend: e.currentTarget.value as Blend })}
            >
              <option value="normal">Normal</option>
              <option value="difference">Difference</option>
              <option value="screen">Screen</option>
              <option value="multiply">Multiply</option>
            </select>
          </label>
        </div>
        <div class="inspector-actions">
          <button
            type="button"
            class="btn"
            disabled={!ref()}
            onClick={() => refChange({ offsetPercent: [0, 0], scale: 1, rotationDegrees: 0 })}
          >
            Reset alignment
          </button>
        </div>
        <p class="note">
          With <b>Align image</b> on, drag the image to position it and use the wheel to scale it; the camera stays
          still. This is a screen overlay on the camera frame, not a texture on the geometry.
        </p>
      </section>
      <section class="inspect-section">
        <div class="section-title">3D display</div>
        <label class="labelled">
          Render style
          <select
            value={state.display.style}
            onChange={(e) => report(commit((d) => setDisplay(d, { style: e.currentTarget.value as DisplayStyle })))}
          >
            <option value="solid">Object colours · shaded solids</option>
            <option value="clay">Neutral clay · shaded solids</option>
            <option value="wire">Triangle wireframe</option>
            <option value="ghost">X-ray solids</option>
          </select>
        </label>
        <div class="pchecks">
          <For
            each={
              [
                ["grid", "Floor grid"],
                ["labels", "3D labels"],
                ["crosshair", "Crosshair"],
              ] as const
            }
          >
            {([key, label]) => (
              <label class="pcheck">
                <input
                  type="checkbox"
                  checked={state.display[key]}
                  onChange={(e) => report(commit((d) => setDisplay(d, { [key]: e.currentTarget.checked })))}
                />
                {label}
              </label>
            )}
          </For>
        </div>
        <button type="button" class="btn" style={{ width: "100%", "margin-top": "10px" }} onClick={savePerspectivePng}>
          Save perspective PNG
        </button>
        <p class="note">The PNG includes the reference overlay when it is shown.</p>
      </section>
    </div>
  );
}
