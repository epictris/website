// Modal dialogs: help, add object, full-size reference image.

import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import { createObject } from "../actions";
import { image } from "../assets";
import { MIN_SIZE } from "../core/math";
import type { Primitive } from "../core/ring";
import type { Vec3 } from "../core/types";
import { AXES, VIEWS } from "../core/views";
import { setMode, state, toast } from "../store";
import { referenceDialog, setReferenceDialog } from "./SceneTab";

/** Close a dialog when its backdrop is clicked. */
function backdropClose(d: HTMLDialogElement) {
  d.addEventListener("click", (e) => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  });
}

let helpDialog!: HTMLDialogElement;
let addDialog!: HTMLDialogElement;
export const openHelp = () => helpDialog.showModal();

const [addForm, setAddForm] = createSignal({
  name: "New object",
  primitive: "box" as Primitive,
  color: "#5ee9cf",
  center: [0, 0, 0] as Vec3,
  size: [4, 4, 4] as Vec3,
});
export function openAddObject() {
  setAddForm((f) => ({ ...f, center: state.scene.size.map((v) => v / 2) as Vec3 }));
  addDialog.showModal();
}

export function Dialogs() {
  let refDialog!: HTMLDialogElement;
  onMount(() => {
    for (const d of [helpDialog, addDialog, refDialog]) backdropClose(d);
    refDialog.addEventListener("close", () => setReferenceDialog(null));
  });
  createEffect(() => {
    if (referenceDialog() && !refDialog.open) refDialog.showModal();
  });
  const refImage = () => {
    const v = referenceDialog();
    return v ? image(state.references[v]?.image) : undefined;
  };
  const create = () => {
    const f = addForm();
    if (!f.center.every(Number.isFinite) || !f.size.every((v) => Number.isFinite(v) && v >= MIN_SIZE)) {
      toast("Use finite coordinates and dimensions of at least 0.001 u.", true);
      return;
    }
    const id = createObject({
      name: f.name.trim() || "New object",
      kind: f.primitive === "rock" ? "rock" : "",
      color: f.color,
      primitive: f.primitive,
      center: f.center,
      size: f.size,
    });
    if (!id) return;
    addDialog.close();
    setMode("outline");
    toast(`${id} added. Edit any of its three outlines.`);
  };
  const vecInput = (key: "center" | "size", a: number, label: string) => (
    <label>
      {label}
      <input
        type="number"
        step="0.1"
        min={key === "size" ? "0.001" : undefined}
        value={addForm()[key][a]}
        onInput={(e) => {
          const next = [...addForm()[key]] as Vec3;
          next[a] = Number(e.currentTarget.value);
          setAddForm((f) => ({ ...f, [key]: next }));
        }}
      />
    </label>
  );
  return (
    <>
      <dialog ref={helpDialog}>
        <div class="dialog-head">
          <h2>Orthographic Studio</h2>
          <button type="button" class="iconbtn" aria-label="Close help" onClick={() => helpDialog.close()}>
            ✕
          </button>
        </div>
        <div class="dialog-body">
          <div class="help-grid">
            <div>
              <h3>What this is</h3>
              <p>
                A scene is a set of objects, each described by one closed outline in the front, top and right-side
                views. The 3D solid is where the three outlines, extruded along their view directions, overlap.
                Reference images behind each view help trace the outlines; the perspective view checks the result
                against a photo or drawing.
              </p>
              <h3>Edit the outlines</h3>
              <p>
                Select an object, choose <b>Outline (V)</b>, then a view. Drag a vertex to reshape that view's outline.
                Double-click an edge, or use the + handle, to insert a point; select a point and press Delete to remove
                it. Exact coordinates are in the inspector.
              </p>
              <p>
                <b>Redraw outline</b> replaces the whole loop: click corners, then Enter or Finish drawing. Escape
                cancels. Outlines cannot cross themselves or have holes. Moving an outermost point changes the object's
                extent on that axis, and the other two views stretch to match.
              </p>
              <h3>Objects</h3>
              <p>
                <b>Add (N)</b> creates a box, ellipsoid, cylinder or rock. Move (M) and Resize (R) transform whole
                objects; Ctrl/⌘-click selects several. Locked objects cannot change. Everything can be undone.
              </p>
              <h3>Reference images</h3>
              <p>
                Each view can have its own reference image: use the image button in its header or drop an image onto it.
                Front, top and side place the image on the view plane in scene units (Scene / scale); perspective
                overlays it on the camera frame (Camera / image).
              </p>
            </div>
            <div>
              <h3>Camera</h3>
              <p>
                Camera / image sets the camera position, look-at target, vertical FOV (or its full-frame focal length, f
                = 12 mm / tan(FOV / 2)), roll, clipping, frame size and display. In the perspective view drag to orbit,
                Shift/right-drag to pan, and wheel to dolly.
              </p>
              <h3>Load / save</h3>
              <p>
                <b>Save (Ctrl/⌘ S)</b> downloads the project: every object, image, camera setting and the editor layout.{" "}
                <b>Load (Ctrl/⌘ O)</b> restores one, or drop a project file anywhere. The save menu also offers a
                compact agent document, a working HTML copy, an SVG drawing, a perspective PNG and a CSV table.
              </p>
              <h3>For agents</h3>
              <p>
                The scene format is documented at <a href="llms.txt">llms.txt</a> and{" "}
                <a href="schema.json">schema.json</a>. In the page, <code>window.orthographic</code> reads and edits the
                scene, validates it and renders each view; the same operations are available over HTTP under{" "}
                <code>/orthographic/api</code>.
              </p>
              <h3>Navigation</h3>
              <p>
                1 / 2 / 3 / 4: expand front / top / side / perspective. 0: all views. Home: fit. F: focus selection.
                Space-drag: pan. Wheel: zoom. Alt-drag: no snapping. Shift-drag: one axis. Ctrl/⌘ Z / Shift Z: undo /
                redo. Ctrl/⌘ D: duplicate.
              </p>
            </div>
          </div>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn primary" onClick={() => helpDialog.close()}>
            Continue editing
          </button>
        </div>
      </dialog>

      <dialog ref={addDialog}>
        <div class="dialog-head">
          <h2>Add an object</h2>
          <button type="button" class="iconbtn" aria-label="Close" onClick={() => addDialog.close()}>
            ✕
          </button>
        </div>
        <div class="dialog-body">
          <div class="help-grid">
            <label class="labelled">
              Name
              <input
                maxLength={180}
                value={addForm().name}
                onInput={(e) => setAddForm((f) => ({ ...f, name: e.currentTarget.value }))}
              />
            </label>
            <label class="labelled">
              Starting shape
              <select
                value={addForm().primitive}
                onChange={(e) => setAddForm((f) => ({ ...f, primitive: e.currentTarget.value as Primitive }))}
              >
                <option value="box">Box</option>
                <option value="ellipsoid">Ellipsoid</option>
                <option value="cylinder">Vertical cylinder</option>
                <option value="rock">Rock / tapered ledge</option>
              </select>
            </label>
          </div>
          <label class="labelled">
            Outline colour
            <input
              type="color"
              style={{ width: "80px" }}
              value={addForm().color}
              onInput={(e) => setAddForm((f) => ({ ...f, color: e.currentTarget.value }))}
            />
          </label>
          <h3>Bounding-box centre · scene units</h3>
          <div class="triplet">
            <For each={[0, 1, 2]}>{(a) => vecInput("center", a, AXES[a].toUpperCase())}</For>
          </div>
          <h3>Dimensions · scene units</h3>
          <div class="triplet">
            <For each={[0, 1, 2]}>{(a) => vecInput("size", a, ["Width X", "Depth Y", "Height Z"][a])}</For>
          </div>
          <p class="note">
            A new object starts with one closed, editable outline in each view. Its 3D solid is rebuilt from those three
            outlines.
          </p>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn primary" onClick={create}>
            Add object
          </button>
        </div>
      </dialog>

      <dialog ref={refDialog} class="reference-dialog">
        <div class="dialog-head">
          <h2>
            {referenceDialog()
              ? `${VIEWS[referenceDialog()!].name} reference · ${refImage()?.name ?? ""}`
              : "Reference image"}
          </h2>
          <button type="button" class="iconbtn" aria-label="Close reference" onClick={() => refDialog.close()}>
            ✕
          </button>
        </div>
        <div class="dialog-body">
          <Show when={refImage()}>
            {(a) => <img class="reference-large" alt="Reference at full size" src={a().url} />}
          </Show>
          <p class="note">
            Shown behind this view's outlines at the placement set under Scene / scale → Reference images. It stays
            fixed while you edit.
          </p>
        </div>
      </dialog>
    </>
  );
}
