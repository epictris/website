// Inspector: the selected object's properties, outline editing tools and exact placement.

import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { unwrap } from "solid-js/store";
import {
  applyNumeric,
  deletePoint,
  deleteSelection,
  deleteTracePoint,
  duplicateSelection,
  finishRedraw,
  finishTrace,
  insertPoint,
  movePoint,
  removeTrace,
  simplifyOutline,
  startRedraw,
  startTrace,
  toggleHiddenEdge,
} from "../actions";
import { image } from "../assets";
import { addPart, type ObjectProps, removePart, updateObject } from "../core/commands";
import { compareToReference, hiddenEdges, MIN_PIXELS, MIN_SHARE, type ObjectComparison } from "../core/compare";
import { fmt } from "../core/math";
import { COVERAGE_WARNING } from "../core/mesher";
import { boundsOf } from "../core/model";
import * as ops from "../core/ops";
import { toWorld } from "../core/ring";
import type { EditorState, ViewId } from "../core/types";
import { AXES, VIEW_IDS, VIEWS } from "../core/views";
import { allMeshesCurrent, meshes, meshStatus, meshVersion, shapeKey } from "../meshes";
import { commit, report, selectedObjects, setActiveView, setMode, setUi, state, ui } from "../store";
import { Field, num, TextArea } from "./fields";

const update = (id: string, patch: ObjectProps) => report(commit((d) => ops.updateObject(d, id, patch).issues));

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
              ? `${one()!.kind || "object"} · ${one()!.parts.length > 1 ? `${one()!.parts.length} parts, ` : ""}one outline per view${one()!.parts.length > 1 ? " each" : ""}`
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
              <TraceTools />
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
            <span class="column-label">Position · m</span>
            <span class="column-label">Dimensions · m</span>
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
          extruded along their view directions, overlap. An object can also be a union of parts, each with its own three
          outlines (Parts, under Outline editing), for a shape that varies in more than one direction at once. Selection
          boxes and vertex handles are editing guides, not part of the shape.
        </p>
      </section>
    </div>
  );
}

function OutlineTools() {
  const e = () => selectedObjects()[0];
  const view = () => ui.contourView;
  const part = () => (e().parts[ui.part] ? ui.part : 0);
  const ring = () => e().parts[part()].outlines[view()];
  const point = () => {
    const p = ui.pointSelection;
    return p && p.id === e().id && p.view === view() && p.part === part() ? p : null;
  };
  const world = () => {
    const p = point();
    return p && ring()[p.index] ? toWorld(e(), p.view, ring()[p.index], p.part) : null;
  };
  const status = () => {
    const s = meshStatus[e().id];
    if (!s || s.key !== shapeKey(e())) return { text: "Updating 3D from the three outlines…", warning: false };
    if (s.error) return { text: `Could not build the solid: ${s.error}`, warning: true };
    const m = s.meta.parts[part()];
    const which = e().parts.length > 1 ? "this part's" : "these";
    if (!m || m.empty)
      return {
        text: `No common volume: ${which} three outlines do not overlap in 3D. Make them agree along their shared axes.`,
        warning: true,
      };
    const low = Math.min(...Object.values(m.coverage));
    if (low < COVERAGE_WARNING)
      return {
        text: `3D rebuilt. The other views clip part of an outline (${Object.entries(m.coverage)
          .map(([v, n]) => `${v} ${Math.round(n * 100)}%`)
          .join(", ")} filled). Your outlines are unchanged.`,
        warning: true,
      };
    return {
      text: `3D rebuilt · ${s.triangles.toLocaleString()} triangles.`,
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
    movePoint(p.id, p.view, p.index, q, p.part);
  };
  const choosePart = (k: number) => setUi({ part: k, pointSelection: null, redrawing: null });
  return (
    <section class="inspect-section">
      <div class="section-title">
        <span>Outline editing</span>
        <span class="mono">{ring().length} vertices</span>
      </div>
      <div class="part-row">
        <span class="part-label">Parts</span>
        <div class="outline-view-tabs part-tabs">
          <For each={e().parts}>
            {(p, k) => (
              <button
                type="button"
                classList={{ active: part() === k() }}
                title={p.id ? `Part ${k() + 1}: ${p.id}` : `Part ${k() + 1}`}
                onClick={() => choosePart(k())}
              >
                {p.id ?? k() + 1}
              </button>
            )}
          </For>
        </div>
        <button
          type="button"
          class="iconbtn part-btn"
          title="Add a part: the object becomes the union of its parts"
          aria-label="Add a part"
          disabled={e().locked}
          onClick={() => {
            let added: number | undefined;
            if (
              report(
                commit((d) => {
                  const r = addPart(d, e().id);
                  added = r.part;
                  return r.issues;
                }),
              ) &&
              added !== undefined
            )
              choosePart(added);
          }}
        >
          +
        </button>
        <button
          type="button"
          class="iconbtn part-btn"
          title="Remove this part"
          aria-label="Remove this part"
          disabled={e().locked || e().parts.length === 1}
          onClick={() => {
            const k = part();
            if (report(commit((d) => removePart(d, e().id, k)))) choosePart(Math.max(0, k - 1));
          }}
        >
          −
        </button>
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
            <span>{axisLabel(0)} · m</span>
            <Field
              type="number"
              step="0.01"
              value={fmt(world()![0], 6)}
              disabled={e().locked}
              onCommit={(v) => pointEdit(0, v)}
            />
          </label>
          <label>
            <span>{axisLabel(1)} · m</span>
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
        <button type="button" class="btn" disabled={!point() || e().locked || ring().length <= 3} onClick={deletePoint}>
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

/** Width at which the inspector scores a trace: quick enough to follow edits, fine enough to read. */
const MATCH_WIDTH = 800;

function TraceTools() {
  const e = () => selectedObjects()[0];
  const ref = () => state.references.perspective;
  const refImage = () => (ref() ? image(ref()!.image) : undefined);
  const point = () => (ui.tracePoint?.id === e().id && e().trace?.points[ui.tracePoint.index] ? ui.tracePoint : null);
  const pointHidden = () => {
    const p = point();
    return !!p && hiddenEdges(e().trace!.points.length, e().trace!.hidden)[p.index];
  };
  // The selected object's match with its trace, recomputed shortly after anything it depends on changes.
  const [match, setMatch] = createSignal<ObjectComparison | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => [
        e()?.id,
        JSON.stringify(e()?.trace),
        meshVersion(),
        JSON.stringify(state.camera),
        JSON.stringify(ref()),
        !!refImage(),
        state.objects.map((o) => [o.id, o.visible, o.min.join()]).join(";"),
      ],
      () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const target = e();
          const img = refImage();
          if (!target?.trace || !img || !allMeshesCurrent()) return setMatch(null);
          const width = Math.min(MATCH_WIDTH, state.camera.frame[0]);
          const c = compareToReference(unwrap(state) as EditorState, (o) => meshes.get(o.id), img, {
            ids: [target.id],
            width,
          });
          setMatch(c?.objects[0] ?? null);
        }, 250);
      },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  const share = (n: number) => {
    const m = match();
    return m?.tracePixels ? `${Math.round((n / m.tracePixels) * 1000) / 10}%` : "0%";
  };
  return (
    <section class="inspect-section">
      <div class="section-title">
        <span>Trace in the reference</span>
        <span class="mono">{e().trace ? `${e().trace!.points.length} points` : "none"}</span>
      </div>
      <p class="note">
        {ui.tracing
          ? "DRAWING: click the silhouette's corners in the perspective view · Enter to close · Escape to cancel."
          : e().trace
            ? "The object's silhouette in the perspective reference, as if nothing stood in front. In Outline mode (V), drag its points in the perspective view, double-click an edge to add one, Delete to remove one. Dotted edges are guesses where something covers the object."
            : "Trace the object's silhouette over the perspective reference to score how well the solid matches it."}
      </p>
      <div class="inspector-actions" style={{ "margin-top": "9px" }}>
        <button
          type="button"
          class="btn"
          disabled={e().locked || !refImage()}
          onClick={() => (ui.tracing ? finishTrace() : startTrace())}
        >
          {ui.tracing ? "Finish trace" : e().trace ? "Redraw trace" : "Draw trace"}
        </button>
        <button type="button" class="btn" disabled={e().locked || !e().trace} onClick={removeTrace}>
          Remove trace
        </button>
      </div>
      <Show when={point()}>
        <div class="inspector-actions" style={{ "margin-top": "7px" }}>
          <button type="button" class="btn" disabled={e().locked} onClick={toggleHiddenEdge}>
            {pointHidden() ? `Edge ${point()!.index + 1}→ traced` : `Edge ${point()!.index + 1}→ hidden`}
          </button>
          <button
            type="button"
            class="btn"
            disabled={e().locked || e().trace!.points.length <= 3}
            onClick={deleteTracePoint}
          >
            − Delete point
          </button>
        </div>
      </Show>
      <label class="labelled" style={{ "margin-top": "9px" }}>
        In front of
        <Field
          value={(e().inFrontOf ?? []).join(", ")}
          placeholder="ids of objects this one hides"
          disabled={e().locked}
          onCommit={(v) =>
            update(e().id, {
              inFrontOf: v
                .split(/[\s,]+/)
                .map((id) => id.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <Show when={match()}>
        {(m) => (
          <div
            class="mesh-status"
            classList={{
              warning:
                m().spill.count > Math.max(MIN_PIXELS, MIN_SHARE * m().tracePixels) ||
                m().missing.count > Math.max(MIN_PIXELS, MIN_SHARE * m().tracePixels),
            }}
          >
            {`Trace match · IoU ${Math.round(m().iou * 1000) / 10}% · spill ${share(m().spill.count)} · missing ${share(m().missing.count)}${
              Object.keys(m().order).length ? ` · in front of it: ${Object.keys(m().order).join(", ")}` : ""
            }`}
          </div>
        )}
      </Show>
    </section>
  );
}
