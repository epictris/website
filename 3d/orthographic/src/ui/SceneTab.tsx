// Inspector: per-view reference images, the scene frame and scale.

import { createSignal, For } from "solid-js";
import { chooseReference } from "../actions";
import { image } from "../assets";
import { clearScene, fitReferencePlacement, rescaleScene, setReference, setScene } from "../core/commands";
import { fmt } from "../core/math";
import type { OrthoReference, Point, ViewId } from "../core/types";
import { AXES, axisNames, VIEW_IDS, VIEWS } from "../core/views";
import { beginGesture, commit, endGesture, preview, report, setUi, state, ui } from "../store";
import { Field, num, TextArea } from "./fields";

export const [referenceDialog, setReferenceDialog] = createSignal<ViewId | null>(null);

function ReferenceSection() {
  const view = () => ui.referenceTab;
  const ref = () => state.references[view()] as OrthoReference | null;
  const img = () => image(ref()?.image);
  const names = () => axisNames(view()).map((a) => a.toUpperCase());
  const change = (patch: Parameters<typeof setReference>[2]) =>
    report(commit((d) => setReference(d, view(), patch, image)));
  const setPlacement = (key: "min" | "size", j: number, v: string) => {
    const n = num(v);
    const r = ref();
    if (n === null || !r) return;
    const next = [...r[key]] as Point;
    next[j] = n;
    change({ [key]: next });
  };
  let opacityBefore: string | null = null;
  return (
    <section class="inspect-section">
      <div class="section-title">
        Reference images <span>{ref() ? `${Math.round(ref()!.opacity * 100)}%` : ""}</span>
      </div>
      <div class="outline-view-tabs">
        <For each={VIEW_IDS}>
          {(v) => (
            <button type="button" classList={{ active: view() === v }} onClick={() => setUi("referenceTab", v)}>
              {VIEWS[v].name.replace("Right side", "Side")}
            </button>
          )}
        </For>
      </div>
      <div id="refPreviewRow">
        <img
          id="refThumb"
          alt="Reference thumbnail"
          src={img()?.url}
          style={{ visibility: img() ? "visible" : "hidden" }}
        />
        <span class="small muted" id="refFileName">
          {img()
            ? `${img()!.name} · ${img()!.width} × ${img()!.height}`
            : `No ${VIEWS[view()].name.toLowerCase()} image`}
        </span>
        <button
          type="button"
          class="iconbtn"
          aria-label="Remove reference image"
          title="Remove this view's reference image"
          disabled={!ref()}
          onClick={() => report(commit((d) => setReference(d, view(), null, image)))}
        >
          ✕
        </button>
      </div>
      <label class="pcheck">
        <input
          type="checkbox"
          checked={!!ref()?.visible}
          disabled={!ref()}
          onChange={(e) => change({ visible: e.currentTarget.checked })}
        />
        Show in view
      </label>
      <input
        aria-label="Reference opacity"
        type="range"
        min="0"
        max="1"
        step="0.01"
        style={{ width: "100%", "margin-top": "10px" }}
        disabled={!ref()}
        value={ref()?.opacity ?? 0.35}
        onPointerDown={() => (opacityBefore = beginGesture())}
        onInput={(e) => {
          opacityBefore ??= beginGesture();
          const v = Number(e.currentTarget.value);
          preview(opacityBefore, (d) => setReference(d, view(), { opacity: v }, image));
        }}
        onChange={() => {
          if (opacityBefore) endGesture(opacityBefore);
          opacityBefore = null;
        }}
      />
      <div class="ref-frame">
        <For each={[0, 1]}>
          {(j) => (
            <label>
              <span>Min {names()[j]} · m</span>
              <Field
                type="number"
                step="0.1"
                disabled={!ref()}
                value={ref() ? fmt(ref()!.min[j], 4) : ""}
                onCommit={(v) => setPlacement("min", j, v)}
              />
            </label>
          )}
        </For>
        <For each={[0, 1]}>
          {(j) => (
            <label>
              <span>Size {names()[j]} · m</span>
              <Field
                type="number"
                step="0.1"
                min="0.001"
                disabled={!ref()}
                value={ref() ? fmt(ref()!.size[j], 4) : ""}
                onCommit={(v) => setPlacement("size", j, v)}
              />
            </label>
          )}
        </For>
      </div>
      <div class="inspector-actions" style={{ "margin-top": "11px" }}>
        <button type="button" class="btn" onClick={() => chooseReference(view())}>
          {ref() ? "Replace image" : "Load image"}
        </button>
        <button
          type="button"
          class="btn"
          title="Fit the image inside the scene frame, keeping its aspect ratio"
          disabled={!img()}
          onClick={() => change(fitReferencePlacement(state, view(), img()!))}
        >
          Fit to frame
        </button>
      </div>
      <div class="inspector-actions" style={{ "margin-top": "7px" }}>
        <button type="button" class="btn" disabled={!img()} onClick={() => setReferenceDialog(view())}>
          View full size
        </button>
      </div>
      <p class="note">
        Each orthographic view has its own image, placed on that view's plane in metres (
        {VIEW_IDS.map(
          (v) => `${VIEWS[v].name.replace("Right side", "side").toLowerCase()} ${axisNames(v).join("/")}`,
        ).join(", ")}
        ). Assign one with the image button in a view header, or drop an image onto the view. Assigned images are
        embedded in the project, even when hidden. The perspective reference is under Camera / image.
      </p>
    </section>
  );
}

export function SceneTab() {
  const s = () => state.scene;
  return (
    <div class="scene-tab">
      <ReferenceSection />
      <section class="inspect-section">
        <label class="labelled">
          Scene name
          <Field
            value={s().title}
            maxLength={100}
            onCommit={(v) => report(commit((d) => setScene(d, { title: v.trim() || "Untitled scene" })))}
          />
        </label>
        <div class="section-title">Scene frame · metres</div>
        <div class="triplet">
          <For each={[0, 1, 2]}>
            {(a) => (
              <label>
                {["Width X", "Depth Y", "Height Z"][a]}
                <Field
                  type="number"
                  min="0.01"
                  step="1"
                  value={fmt(s().size[a], 5)}
                  onCommit={(v) => {
                    const n = num(v);
                    if (n === null) return;
                    const size = [...s().size] as [number, number, number];
                    size[a] = n;
                    report(commit((d) => setScene(d, { size })));
                  }}
                />
              </label>
            )}
          </For>
        </div>
        <p class="note">
          The frame is a guide, not a boundary: changing it does not move or resize objects, and objects may extend
          beyond it.
        </p>
      </section>
      <section class="inspect-section">
        <label class="section-title" for="scale-basis">
          Scale basis
        </label>
        <TextArea
          id="scale-basis"
          maxLength={1000}
          placeholder="What the sizes were taken from, e.g. doorway 2.1 m tall…"
          value={s().scaleBasis}
          onCommit={(v) => report(commit((d) => setScene(d, { scaleBasis: v.trim() })))}
        />
        <label class="labelled">
          Rescale everything by
          <Field
            type="number"
            min="0.000001"
            step="0.1"
            placeholder="Factor, e.g. 0.5"
            value=""
            onCommit={(v) => {
              const n = num(v);
              if (n !== null) report(commit((d) => rescaleScene(d, n)));
            }}
          />
        </label>
        <p class="note">
          Every length is in metres. Rescaling multiplies the objects, the frame, the reference placements and the
          camera together, for when the size estimate changes.
        </p>
      </section>
      <section class="inspect-section">
        <label class="section-title" for="scene-notes">
          Scene notes
        </label>
        <TextArea
          id="scene-notes"
          maxLength={4000}
          placeholder="Overall intent or instructions for the reconstruction…"
          value={s().notes}
          onCommit={(v) => report(commit((d) => setScene(d, { notes: v })))}
        />
      </section>
      <section class="inspect-section">
        <div class="section-title">Coordinates</div>
        <p class="small muted">
          Right-handed, Z up.
          <br />X = right in the front view.
          <br />Y = depth, away from the front camera.
          <br />Z = up.
          <br />
          Origin = lower-left-front corner of the scene frame.
        </p>
        <p class="note">
          Machine-readable description: <a href="llms.txt">llms.txt</a> and <a href="schema.json">schema.json</a>. Axes
          per view: {AXES.length} world axes,{" "}
          {VIEW_IDS.map((v) => `${VIEWS[v].name.toLowerCase()} = ${axisNames(v).join("/")}`).join(", ")}.
        </p>
      </section>
      <section class="inspect-section">
        <button
          type="button"
          class="btn"
          style={{ width: "100%" }}
          onClick={() => {
            if (confirm("Start a new, empty scene? You can undo this.")) report(commit(clearScene));
          }}
        >
          New empty scene
        </button>
        <p class="note">Undoable. Clears the objects, references and camera; images stay loaded for reuse.</p>
      </section>
    </div>
  );
}
