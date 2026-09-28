// Inspector: the selected object's properties, outline editing tools and exact placement.

import { createMemo, For, Show } from "solid-js";
import {
  applyNumeric,
  deletePoint,
  deleteSelection,
  duplicateSelection,
  finishRedraw,
  insertPoint,
  movePoint,
  simplifyOutline,
  startRedraw,
} from "../actions";
import { type ObjectProps, updateObject } from "../core/commands";
import { fmt } from "../core/math";
import { COVERAGE_WARNING } from "../core/mesher";
import { boundsOf } from "../core/model";
import { toWorld } from "../core/ring";
import type { ViewId } from "../core/types";
import { AXES, VIEW_IDS, VIEWS } from "../core/views";
import { meshStatus, shapeKey } from "../meshes";
import { commit, report, selectedObjects, setActiveView, setMode, setUi, ui } from "../store";
import { Field, num, TextArea } from "./fields";

const update = (id: string, patch: ObjectProps) => report(commit((d) => updateObject(d, id, patch)));

export function TransformTab() {
  const items = createMemo(() => selectedObjects());
  const one = () => (items().length === 1 ? items()[0] : null);
  const bounds = createMemo(() => boundsOf(items()));
  const locked = () => items().some((e) => e.locked);
  const reviewed = () => items().length > 0 && items().every((e) => e.reviewed);
  const position = () => {
    const b = bounds()!;
    return ui.anchor === "center" ? b.min.map((v, a) => (v + b.max[a]) / 2) : b.min;
  };

  return (
    <div class="transform-tab">
      <Show
        when={items().length}
        fallback={
          <div class="no-selection">
            Select an outline in a view or an object in the list.
            <br />
            <br />
            All three views edit the same position and dimensions.
          </div>
        }
      >
        <section class="inspect-section">
          <div class="flex">
            <span class="id-badge" style={{ color: one()?.color ?? "var(--accent)" }}>
              {one() ? one()!.id : `${items().length} OBJECTS`}
            </span>
            <span class="grow" />
            <span class="status-tag" classList={{ edited: reviewed() }}>
              {locked() ? "Locked" : reviewed() ? "✓ Reviewed" : ""}
            </span>
          </div>
          <div class="selected-name">{one() ? one()!.name : "Multi-object selection"}</div>
          <div class="small muted">
            {one()
              ? `${one()!.kind || "object"} · one outline per view`
              : "Positions and dimensions describe the whole selection."}
          </div>
        </section>
        <Show when={one()}>
          {(e) => (
            <>
              <section class="inspect-section">
                <div class="object-fields">
                  <label class="labelled">
                    Name
                    <Field
                      value={e().name}
                      maxLength={180}
                      disabled={e().locked}
                      onCommit={(v) => update(e().id, { name: v.trim() || e().id })}
                    />
                  </label>
                  <label class="labelled">
                    Color
                    <Field
                      type="color"
                      value={e().color}
                      disabled={e().locked}
                      onCommit={(v) => update(e().id, { color: v })}
                    />
                  </label>
                </div>
                <div class="object-fields" style={{ "margin-top": "9px" }}>
                  <label class="labelled">
                    Kind
                    <Field
                      value={e().kind}
                      maxLength={40}
                      placeholder="rock, plant, wall…"
                      disabled={e().locked}
                      onCommit={(v) => update(e().id, { kind: v.trim() })}
                    />
                  </label>
                  <label class="labelled">
                    Opacity
                    <Field
                      type="number"
                      min="0.05"
                      max="1"
                      step="0.05"
                      value={fmt(e().opacity, 2)}
                      disabled={e().locked}
                      onCommit={(v) => {
                        const n = num(v);
                        if (n !== null) update(e().id, { opacity: n });
                      }}
                    />
                  </label>
                </div>
                <div class="inspector-actions">
                  <button type="button" class="btn" onClick={duplicateSelection}>
                    Duplicate object
                  </button>
                  <button type="button" class="btn danger" onClick={() => deleteSelection()}>
                    Delete object
                  </button>
                </div>
              </section>
              <OutlineTools />
            </>
          )}
        </Show>
        <section class="inspect-section">
          <div class="section-title">Position anchor</div>
          <div class="origin-control">
            <button
              type="button"
              classList={{ active: ui.anchor === "center" }}
              onClick={() => setUi("anchor", "center")}
            >
              Bounding-box centre
            </button>
            <button type="button" classList={{ active: ui.anchor === "min" }} onClick={() => setUi("anchor", "min")}>
              Minimum corner
            </button>
          </div>
          <div class="transform-grid">
            <span />
            <span class="column-label">Position · u</span>
            <span class="column-label">Dimensions · u</span>
            <For each={[0, 1, 2]}>
              {(a) => (
                <>
                  <label class={`axis-dot axis-${AXES[a]}`} for={`pos-${AXES[a]}`}>
                    {AXES[a].toUpperCase()}
                  </label>
                  <Field
                    type="number"
                    step="0.01"
                    id={`pos-${AXES[a]}`}
                    aria-label={`${AXES[a].toUpperCase()} position`}
                    value={fmt(position()[a], 5)}
                    disabled={locked()}
                    onCommit={(v) => {
                      const n = num(v);
                      if (n !== null) applyNumeric("pos", a, n);
                    }}
                  />
                  <Field
                    type="number"
                    step="0.01"
                    min="0.001"
                    aria-label={`Size along ${AXES[a].toUpperCase()}`}
                    value={fmt(bounds()!.max[a] - bounds()!.min[a], 5)}
                    disabled={locked()}
                    onCommit={(v) => {
                      const n = num(v);
                      if (n !== null) applyNumeric("size", a, n);
                    }}
                  />
                </>
              )}
            </For>
          </div>
          <div class="axis-caption">
            <span>X width</span>
            <span>Y depth</span>
            <span>Z height</span>
          </div>
          <div class="bounds-readout">
            min{" "}
            <span>
              {bounds()!
                .min.map((v) => fmt(v, 3))
                .join(" / ")}
            </span>
            <br />
            max{" "}
            <span>
              {bounds()!
                .max.map((v) => fmt(v, 3))
                .join(" / ")}
            </span>
          </div>
          <p class="note">
            {locked()
              ? "Unlock all selected objects to move or resize them."
              : items().length > 1
                ? "Numeric edits transform the whole selection; resizing scales objects and the gaps between them."
                : "Numeric edits are exact and do not snap. Resizing keeps the chosen anchor."}
          </p>
        </section>
        <section class="inspect-section">
          <div class="inspector-actions">
            <button
              type="button"
              class="btn"
              onClick={() => {
                const value = !reviewed();
                report(commit((d) => items().flatMap((e) => updateObject(d, e.id, { reviewed: value }))));
              }}
            >
              {reviewed() ? "Unmark reviewed" : "Mark reviewed"}
            </button>
          </div>
          <p class="note">Ctrl/⌘-click to select several objects and move them together.</p>
        </section>
        <section class="inspect-section">
          <label class="section-title" for="object-notes">
            Object notes
          </label>
          <TextArea
            id="object-notes"
            maxLength={2000}
            disabled={!one()}
            placeholder={
              one() ? "Attachment, depth or reconstruction instructions…" : "Select one object to edit its notes."
            }
            value={one()?.notes ?? ""}
            onCommit={(v) => one() && update(one()!.id, { notes: v })}
          />
          <p class="note">Notes and review status are saved with the project.</p>
        </section>
      </Show>
      <section class="inspect-section">
        <div class="section-title">One outline per view</div>
        <p class="note">
          Each object has one closed outline in each orthographic view. The 3D solid is where the three outlines,
          extruded along their view directions, overlap. Selection boxes and vertex handles are editing guides, not part
          of the shape.
        </p>
      </section>
    </div>
  );
}

function OutlineTools() {
  const e = () => selectedObjects()[0];
  const view = () => ui.contourView;
  const point = () => {
    const p = ui.pointSelection;
    return p && p.id === e().id && p.view === view() ? p : null;
  };
  const world = () => {
    const p = point();
    return p && e().outlines[p.view][p.index] ? toWorld(e(), p.view, e().outlines[p.view][p.index]) : null;
  };
  const status = () => {
    const s = meshStatus[e().id];
    if (!s || s.key !== shapeKey(e())) return { text: "Updating 3D from the three outlines…", warning: false };
    if (s.error) return { text: `Could not build the solid: ${s.error}`, warning: true };
    if (s.meta.empty)
      return {
        text: "No common volume: these three outlines do not overlap in 3D. Make them agree along their shared axes.",
        warning: true,
      };
    const low = Math.min(...Object.values(s.meta.coverage));
    if (low < COVERAGE_WARNING)
      return {
        text: `3D rebuilt. The other views clip part of an outline (${Object.entries(s.meta.coverage)
          .map(([v, n]) => `${v} ${Math.round(n * 100)}%`)
          .join(", ")} filled). Your outlines are unchanged.`,
        warning: true,
      };
    return {
      text: `3D rebuilt · ${s.triangles.toLocaleString()} triangles · resolution ${s.meta.grid}.`,
      warning: false,
    };
  };
  const axisLabel = (j: number) => AXES[VIEWS[view()].axes[j]].toUpperCase();
  const pointEdit = (j: number, v: string) => {
    const p = point();
    const w = world();
    const n = num(v);
    if (!p || !w || n === null) return;
    const q: [number, number] = [...w];
    q[j] = n;
    movePoint(p.id, p.view, p.index, q);
  };
  return (
    <section class="inspect-section">
      <div class="section-title">
        <span>Outline editing</span>
        <span class="mono">{e().outlines[view()].length} vertices</span>
      </div>
      <div class="outline-view-tabs">
        <For each={VIEW_IDS}>
          {(v: ViewId) => (
            <button
              type="button"
              classList={{ active: view() === v }}
              onClick={() => {
                setUi("redrawing", null);
                setActiveView(v);
                setMode("outline");
              }}
            >
              {VIEWS[v].name.replace("Right side", "Side")}
            </button>
          )}
        </For>
      </div>
      <div class="eyebrow" style={{ margin: "10px 0 7px", "font-size": "9px" }}>
        ONE CLOSED OUTLINE / VIEW
      </div>
      <p class="note">
        {ui.redrawing
          ? "DRAWING: click corners · Enter to close · Escape to cancel."
          : ui.mode === "outline"
            ? "Drag a vertex. Double-click an edge to add a point. Delete removes the selected point."
            : "Choose Outline (V) to edit vertices in any orthographic view."}
      </p>
      <Show when={point() && world()}>
        <div class="point-grid">
          <span class="mono">#{point()!.index + 1}</span>
          <label>
            <span>{axisLabel(0)} · u</span>
            <Field
              type="number"
              step="0.01"
              value={fmt(world()![0], 6)}
              disabled={e().locked}
              onCommit={(v) => pointEdit(0, v)}
            />
          </label>
          <label>
            <span>{axisLabel(1)} · u</span>
            <Field
              type="number"
              step="0.01"
              value={fmt(world()![1], 6)}
              disabled={e().locked}
              onCommit={(v) => pointEdit(1, v)}
            />
          </label>
        </div>
      </Show>
      <div class="inspector-actions" style={{ "margin-top": "11px" }}>
        <button
          type="button"
          class="btn"
          disabled={e().locked}
          onClick={() => {
            setMode("outline");
            insertPoint();
          }}
        >
          ＋ Add point
        </button>
        <button
          type="button"
          class="btn"
          disabled={!point() || e().locked || e().outlines[view()].length <= 3}
          onClick={deletePoint}
        >
          − Delete point
        </button>
      </div>
      <div class="inspector-actions" style={{ "margin-top": "7px" }}>
        <button
          type="button"
          class="btn"
          disabled={e().locked}
          onClick={() => (ui.redrawing ? finishRedraw() : startRedraw())}
        >
          {ui.redrawing ? "Finish outline" : "Redraw outline"}
        </button>
        <button
          type="button"
          class="btn"
          title="Finish drawing (Enter)"
          disabled={!ui.redrawing}
          onClick={finishRedraw}
        >
          Finish drawing
        </button>
      </div>
      <div class="simplify-row">
        <button type="button" class="btn" disabled={e().locked} onClick={simplifyOutline}>
          Simplify
        </button>
        <label title="Largest distance (as a fraction of the object's size) a removed corner may deviate">
          Tolerance{" "}
          <Field
            type="number"
            min="0.0001"
            max="0.05"
            step="0.001"
            value={ui.simplifyTolerance}
            onCommit={(v) => {
              const n = num(v);
              if (n !== null && n >= 0.0001 && n <= 0.05) setUi("simplifyTolerance", n);
            }}
          />
        </label>
      </div>
      <p class="note">
        Moving an outermost vertex changes the object's extent along that axis, and the other two views stretch to
        match. Interior vertices change only this outline. Crossing edges are rejected.
      </p>
      <div class="mesh-status" classList={{ warning: status().warning }}>
        {status().text}
      </div>
    </section>
  );
}
