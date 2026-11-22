// Decorations in the editor (docs/formations.md, "Decorations"): the list on a
// formation's panel, a decoration's own panel, and the gestures in the Visuals
// workspace - placing one on the rock, dragging it along the rock, painting
// and erasing a painted one's strokes - and what happens to them all when
// their rock is regenerated.
//
// Every edit replaces a decoration's fields (an undo snapshot holds the old
// ones). Growing is a job (scripts/decoration-build.ts): a placed decoration is
// grown once and only moved after; a painted one is grown again when its
// strokes or its rock change.

import * as THREE from "three";
import { decorationHash, decorationRequest, isPainted } from "../formation/decoration";
import { PAINTED_DECORATIONS, type DecorationAnchor, type DecorationKind, type PaintStamp } from "../level/levelFormat";
import { showToast } from "../render/toast";
import { anchorAt, formationMatrix, markPos, projectOnRock, reproject, reprojectStrokes, rockOf, toFormation, v3 } from "./decorations";
import type { FormationJobs, JobState } from "./formationJobs";
import { bodyMembers, newBodyId, type EdDecoration, type EdItem, type EdModel } from "./model";
import { DEFAULT_THRESHOLD, PaintCoverage } from "./paintCoverage";
import { buildDecorationSettings } from "./decorationSettings";
import { describe, fieldRow } from "./panelUi";

export const DECORATION_LABELS: Record<DecorationKind, string> = {
  moss: "Moss",
  ivy: "Ivy",
  fern: "Fern",
  vine: "Hanging vine",
  mushroom: "Mushrooms",
  orbs: "Pendant orbs",
  glow: "Glow flora",
};
const KINDS = Object.keys(DECORATION_LABELS) as DecorationKind[];
// A new brush's radius, metres.
const BRUSH_RADIUS = 0.25;

export interface DecorationHost {
  model(): EdModel;
  jobs: FormationJobs;
  beginAction(): void;
  markDirty(): void;
  rebuildInspector(): void;
  select(ids: number[]): void;
  // The level's focal length, mm, for the growth's detail budget.
  lens(): number | undefined;
}

// A hit on the scene in the Visuals workspace: the item it names (the
// formation's rock answers with the formation item), and where, in three's
// world.
export interface SurfaceHit {
  itemId: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

const button = (text: string, onClick: () => void, title?: string): HTMLButtonElement => {
  const b = document.createElement("button");
  b.className = "ed-btn";
  b.textContent = text;
  b.addEventListener("click", onClick);
  if (title) b.title = title;
  return b;
};
const div = (cls: string, text = ""): HTMLDivElement => Object.assign(document.createElement("div"), { className: cls, textContent: text });

export class DecorationController {
  // A kind waiting for its first click on a formation's rock.
  placing: { kind: DecorationKind; formationId: number } | null = null;
  // The painted decoration the brush is on, and how it paints.
  painting: { itemId: number; radius: number; erase: boolean } | null = null;
  private drag: { mode: "move" | "paint"; itemId: number; last: THREE.Vector3 | null } | null = null;
  // What the paint covers, drawn over the rock while the brush is on.
  readonly preview = new THREE.Group();
  private previewKey = "";
  // The coverage of the rock being painted, kept while the same rock and
  // decoration are, so a dab composites only its own stamp.
  private coverage: { rock: THREE.Object3D; itemId: number; field: PaintCoverage } | null = null;

  constructor(private readonly host: DecorationHost) {
    this.preview.name = "decoration-paint";
    this.preview.renderOrder = 12;
  }

  private item(id: number): EdItem | null {
    return this.host.model().items.find((i) => i.id === id) ?? null;
  }
  private formationOf(d: EdItem): EdItem | null {
    const f = this.host.model().items.find((i) => i.bodyId === d.bodyId && i.object === "formation");
    return f && f.formation?.id === d.decoration?.formation ? f : null;
  }

  // The formation item a gesture now would land on: the one being placed on,
  // painted on, or the selected decoration's.
  target(selected: readonly EdItem[]): number | null {
    if (this.placing) return this.placing.formationId;
    const d = this.painting ? this.item(this.painting.itemId) : selected.length === 1 && selected[0]!.object === "decoration" ? selected[0]! : null;
    return d ? (this.formationOf(d)?.id ?? null) : null;
  }

  // --- requests and results ---------------------------------------------------

  request(d: EdItem): ReturnType<typeof decorationRequest> | null {
    const f = this.formationOf(d);
    const host = f?.formation?.built?.hash;
    if (!d.decoration || !host) return null;
    return decorationRequest(d.decoration, host, d.decoration.strokes, this.host.lens());
  }

  // Whether what is drawn is not what the decoration now asks for. A placed
  // one is measured where it was grown and on what: it only MOVES after.
  stale(d: EdItem): boolean {
    const dec = d.decoration;
    if (!dec) return false;
    if (!dec.built) return true;
    if (isPainted(dec.kind)) {
      const r = this.request(d);
      return !r || decorationHash(r) !== dec.built.hash;
    }
    const r = decorationRequest({ ...dec, onRock: dec.built.at }, dec.built.host, undefined, this.host.lens());
    return decorationHash(r) !== dec.built.hash;
  }

  grow(d: EdItem): void {
    const r = this.request(d);
    if (!r) {
      showToast("Generate the formation first: a decoration grows on its rock.", "warn");
      return;
    }
    if (isPainted(r.kind) && !(r.stamps ?? []).some((s) => s.s > 0)) return;
    void fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "decoration", request: r, label: `${DECORATION_LABELS[r.kind]} ${d.decoration!.id}` }),
    })
      .then((res) => res.json() as Promise<{ id?: string; error?: string }>)
      .then((b) => (b.id ? this.host.rebuildInspector() : showToast(b.error ?? "the job runner refused the growth", "warn")));
  }

  // A finished growth recorded on every decoration whose request it is.
  applyResult(job: JobState): boolean {
    if (job.kind !== "decoration" || job.state !== "done") return false;
    let changed = false;
    for (const d of this.host.model().items) {
      if (d.object !== "decoration" || !d.decoration) continue;
      const r = this.request(d);
      if (!r || decorationHash(r) !== job.hash || d.decoration.built?.hash === job.hash) continue;
      d.decoration = { ...d.decoration, built: { hash: job.hash, host: r.host, at: r.at ?? d.decoration.onRock ?? d.decoration.anchor } };
      changed = true;
    }
    return changed;
  }

  // The rock of `f` changed (a Generate landed): carry every decoration on it
  // onto the new rock (docs/formations.md): a placed one is moved, a painted
  // one has its strokes carried and is grown again; one that cannot follow is
  // lost and left where it was. Waits for the new rock to load.
  afterRegenerate(f: EdItem): void {
    const rock = rockOf(f, () => this.afterRegenerate(f));
    if (!rock) return;
    let changed = false;
    let lost = 0;
    for (const d of bodyMembers(this.host.model().items, f.bodyId)) {
      if (d.object !== "decoration" || !d.decoration || d.decoration.formation !== f.formation?.id) continue;
      const dec = d.decoration;
      if (isPainted(dec.kind)) {
        const carried = reprojectStrokes(rock, dec.strokes ?? []);
        changed = true;
        if (carried.lost) {
          // Left as it was, strokes and growth, and flagged: a large edit
          // means painting it again, and nothing guesses where.
          lost++;
          d.decoration = { ...dec, lost: true };
          continue;
        }
        const { lost: _was, ...rest } = dec;
        d.decoration = { ...rest, strokes: carried.strokes };
        this.grow(d);
      } else {
        const r = reproject(rock, dec.anchor, dec.onRock);
        if (r.lost) lost++;
        const { lost: _was, ...rest } = dec;
        d.decoration = { ...rest, onRock: r.onRock, ...(r.lost ? { lost: true } : {}) };
        d.pos = markPos(f, r.onRock);
        changed = true;
      }
    }
    if (changed) this.host.markDirty();
    if (lost) showToast(`${lost} decoration${lost === 1 ? "" : "s"} could not follow the new rock and are flagged: place them again.`, "warn");
  }

  // --- gestures ---------------------------------------------------------------

  // A press in the Visuals workspace. True when it was a decoration's.
  // Whether a placing or painting mode is on (Esc, or a press off the rock,
  // ends it).
  get busy(): boolean {
    return this.placing !== null || this.painting !== null;
  }

  // Out of placing and painting, the panel saying so.
  cancel(): void {
    if (!this.busy) return;
    this.placing = null;
    this.painting = null;
    this.previewKey = "";
    this.syncPreview();
    this.host.rebuildInspector();
  }

  press(hit: SurfaceHit | null, selected: readonly EdItem[]): boolean {
    // A press OFF the rock leaves placing or painting and is then an ordinary
    // click (it selects what it lands on), as a click away from a tool is in
    // any editor. Swallowing it instead left the editor unable to select
    // anything with no word as to why while a brush was still on.
    if (this.placing) {
      const f = this.item(this.placing.formationId);
      if (!hit || !f || hit.itemId !== f.id) {
        this.cancel();
        return false;
      }
      this.place(f, this.placing.kind, hit);
      this.placing = null;
      return true;
    }
    if (this.painting) {
      const d = this.item(this.painting.itemId);
      if (!d || !hit) {
        this.cancel();
        return false;
      }
      this.host.beginAction();
      this.drag = { mode: "paint", itemId: d.id, last: null };
      this.stroke(d, hit);
      return true;
    }
    const d = selected.length === 1 && selected[0]!.object === "decoration" && !isPainted(selected[0]!.decoration!.kind) ? selected[0]! : null;
    if (d && hit && hit.itemId === this.formationOf(d)?.id) {
      this.host.beginAction();
      this.drag = { mode: "move", itemId: d.id, last: null };
      this.moveTo(d, hit);
      return true;
    }
    return false;
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  move(hit: SurfaceHit | null): void {
    const g = this.drag;
    const d = g ? this.item(g.itemId) : null;
    if (!g || !d || !hit || hit.itemId !== this.formationOf(d)?.id) return;
    if (g.mode === "move") this.moveTo(d, hit);
    else this.stroke(d, hit);
  }

  release(): void {
    const g = this.drag;
    this.drag = null;
    if (g?.mode === "paint") {
      const d = this.item(g.itemId);
      if (d) this.grow(d);
    }
  }

  private place(f: EdItem, kind: DecorationKind, hit: SurfaceHit): void {
    const local = toFormation(f, hit.point, hit.normal);
    const anchor = anchorAt(f, local.p) ?? { p: v3(local.p), n: v3(local.n) };
    const rock = rockOf(f, () => {});
    const onRock = (rock && projectOnRock(rock, anchor)) ?? { p: v3(local.p), n: v3(local.n.normalize()) };
    const model = this.host.model();
    const taken = new Set(model.items.flatMap((i) => (i.decoration ? [i.decoration.id] : [])));
    let id = "";
    do id = `${kind}-${Math.floor(Math.random() * 36 ** 5).toString(36)}`; while (taken.has(id));
    const decoration: EdDecoration = {
      id,
      kind,
      formation: f.formation!.id,
      anchor,
      onRock,
      seed: Math.floor(Math.random() * 100000),
      ...(isPainted(kind) ? { strokes: [] } : {}),
    };
    this.host.beginAction();
    const item: EdItem = {
      ...f,
      id: newBodyId(),
      object: "decoration",
      pos: markPos(f, onRock),
      rot: 0,
      shape: { kind: "rect", w: 0.15, h: 0.15 },
      formation: null,
      decoration,
    };
    const at = model.items.lastIndexOf(bodyMembers(model.items, f.bodyId).at(-1)!);
    model.items.splice(at + 1, 0, item);
    this.host.markDirty();
    this.host.select([item.id]);
    if (isPainted(kind)) {
      this.painting = { itemId: item.id, radius: BRUSH_RADIUS, erase: false };
      showToast(`Paint the ${DECORATION_LABELS[kind].toLowerCase()} onto the rock; it grows when you let go.`);
    } else this.grow(item);
  }

  // A placed decoration dragged along its rock: the anchor follows the guide,
  // and what is drawn lands on the rock under it every frame.
  private moveTo(d: EdItem, hit: SurfaceHit): void {
    const f = this.formationOf(d);
    if (!f || !d.decoration) return;
    const local = toFormation(f, hit.point, hit.normal);
    const anchor = anchorAt(f, local.p);
    if (!anchor) return;
    const rock = rockOf(f, () => {});
    const onRock = (rock && projectOnRock(rock, anchor)) ?? { p: v3(local.p), n: v3(local.n.normalize()) };
    const { lost: _l, ...rest } = d.decoration;
    d.decoration = { ...rest, anchor, onRock };
    d.pos = markPos(f, onRock);
    this.host.markDirty();
  }

  // One dab of the brush, no closer to the last than a third of its radius.
  private stroke(d: EdItem, hit: SurfaceHit): void {
    const f = this.formationOf(d);
    const brush = this.painting;
    if (!f || !d.decoration || !brush) return;
    const local = toFormation(f, hit.point, hit.normal);
    const g = this.drag;
    if (g?.last && g.last.distanceTo(local.p) < brush.radius / 3) return;
    if (g) g.last = local.p.clone();
    const stamp: PaintStamp = { p: v3(local.p), n: v3(local.n.normalize()), r: brush.radius, s: brush.erase ? -1 : 1 };
    d.decoration = { ...d.decoration, strokes: [...(d.decoration.strokes ?? []), stamp] };
    this.host.markDirty();
  }

  // What the decoration being painted covers, as the Blender brush shows it:
  // a field of dots where the paint reaches the grower's threshold (see
  // paintCoverage.ts). Nothing until the rock it is painted on has loaded.
  syncPreview(): void {
    const d = this.painting ? this.item(this.painting.itemId) : null;
    const f = d ? this.formationOf(d) : null;
    const rock = f ? rockOf(f, () => (this.previewKey = "")) : null;
    const strokes = d?.decoration?.strokes ?? [];
    const threshold = Number(d?.decoration?.settings?.["threshold"] ?? DEFAULT_THRESHOLD);
    // Placed every frame: a 3D body's depth and tilt move it with no item
    // changing. The key is for the coverage alone.
    if (f) {
      this.preview.matrixAutoUpdate = false;
      this.preview.matrix.copy(formationMatrix(f));
    }
    const key = f && rock ? JSON.stringify([f.formation?.built?.hash, strokes.length, d!.id, threshold]) : "";
    if (key === this.previewKey) return;
    this.previewKey = key;
    this.preview.clear();
    if (!f || !rock || !d) {
      this.dropCoverage();
      return;
    }
    if (this.coverage?.rock !== rock || this.coverage.itemId !== d.id) {
      this.dropCoverage();
      this.coverage = { rock, itemId: d.id, field: new PaintCoverage(rock) };
    }
    if (!this.coverage.field.update(strokes, threshold)) {
      // Undone or erased past what was composited: start the field over.
      this.dropCoverage();
      this.coverage = { rock, itemId: d.id, field: new PaintCoverage(rock) };
      this.coverage.field.update(strokes, threshold);
    }
    this.preview.matrixAutoUpdate = false;
    this.preview.matrix.copy(formationMatrix(f));
    this.preview.add(this.coverage.field.object);
  }

  private dropCoverage(): void {
    this.coverage?.field.dispose();
    this.coverage = null;
  }

  // --- panels -----------------------------------------------------------------

  // The decorations on a formation, in its section.
  buildList(parent: HTMLElement, f: EdItem): void {
    const items = bodyMembers(this.host.model().items, f.bodyId).filter((i) => i.object === "decoration" && i.decoration?.formation === f.formation?.id);
    const list = div("ed-solid-tree");
    for (const d of items) {
      const dec = d.decoration!;
      const job = dec.built ? null : this.request(d) ? this.host.jobs.latest(decorationHash(this.request(d)!)) : null;
      const state = dec.lost ? "LOST" : !dec.built ? (job && job.state !== "done" ? job.state : "not grown") : this.stale(d) ? "stale" : "";
      const row = div("ed-solid-row", `${DECORATION_LABELS[dec.kind]} ${dec.id}${state ? ` (${state})` : ""}`);
      row.classList.toggle("ed-stale", !!dec.lost);
      row.addEventListener("click", () => this.host.select([d.id]));
      list.appendChild(row);
    }
    if (items.length) parent.appendChild(list);
    const adds = div("ed-row");
    for (const kind of KINDS) {
      adds.appendChild(button(`+ ${DECORATION_LABELS[kind]}`, () => {
        if (!f.formation?.built) {
          showToast("Generate the formation first: a decoration grows on its rock.", "warn");
          return;
        }
        this.placing = { kind, formationId: f.id };
        this.painting = null;
        showToast(`Click the rock to ${PAINTED_DECORATIONS.includes(kind) ? "start painting" : "place"} the ${DECORATION_LABELS[kind].toLowerCase()}.`);
      }, PAINTED_DECORATIONS.includes(kind) ? "Painted onto the rock, grown again whenever the paint or the rock changes." : "Placed on the rock, grown once, then dragged along the rock."));
    }
    parent.appendChild(adds);
  }

  // A decoration's own panel.
  buildGroup(parent: HTMLElement, d: EdItem): void {
    const dec = d.decoration!;
    const status = div("ed-hint ed-formation-status");
    const refresh = (): void => {
      const now = d.decoration!;
      const r = this.request(d);
      const job = r ? this.host.jobs.latest(decorationHash(r)) : null;
      const running = job && (job.state === "queued" || job.state === "running");
      status.textContent = [
        now.lost ? "LOST: it could not follow its rock's last change. Drag it back onto the rock, or delete it." : "",
        !now.built ? "Not grown yet." : this.stale(d) ? "Stale: its settings or paint have changed. Grow it again." : "Grown.",
        running ? `Growing: ${Math.round((job.progress ?? 0) * 100)}% ${job.step ?? ""}` : job?.state === "failed" ? `The last growth failed: ${job.error?.split("\n").pop() ?? ""}` : "",
      ].filter(Boolean).join(" ");
      status.classList.toggle("ed-stale", !!now.lost || this.stale(d));
    };
    refresh();
    status.addEventListener("refresh", refresh);
    parent.appendChild(status);

    const seedRow = fieldRow("seed");
    const seed = Object.assign(document.createElement("input"), { type: "number", className: "ed-num", step: "1", value: String(dec.seed ?? 0) });
    seed.addEventListener("change", () => {
      this.host.beginAction();
      d.decoration = { ...d.decoration!, seed: Math.round(Number(seed.value) || 0) };
      this.host.markDirty();
      refresh();
    });
    seedRow.appendChild(seed);
    parent.appendChild(seedRow);

    // The add-on's own settings: the fields its Blender panel shows for this
    // kind (decorationSettings.ts). A change marks the decoration stale; Grow
    // again builds it with them.
    let growButton: HTMLButtonElement | null = null;
    buildDecorationSettings(parent, dec.kind, {
      settings: () => d.decoration!.settings,
      begin: () => this.host.beginAction(),
      write: (next, structural) => {
        const { settings: _s, ...rest } = d.decoration!;
        d.decoration = next ? { ...rest, settings: next } : rest;
        this.host.markDirty();
        if (structural) this.host.rebuildInspector();
        else {
          refresh();
          growButton?.classList.toggle("ed-attention", this.stale(d));
        }
      },
    });

    const actions = div("ed-row");
    growButton = button(dec.built ? "Grow again" : "Grow", () => this.grow(d));
    growButton.classList.toggle("ed-attention", this.stale(d));
    actions.appendChild(growButton);
    if (isPainted(dec.kind)) {
      const on = this.painting?.itemId === d.id;
      actions.append(
        button(on && !this.painting!.erase ? "Painting…" : "Paint", () => {
          this.painting = { itemId: d.id, radius: this.painting?.radius ?? BRUSH_RADIUS, erase: false };
          this.host.rebuildInspector();
        }, "Drag on the rock to paint; it grows when you let go."),
        button(on && this.painting!.erase ? "Erasing…" : "Erase", () => {
          this.painting = { itemId: d.id, radius: this.painting?.radius ?? BRUSH_RADIUS, erase: true };
          this.host.rebuildInspector();
        }),
      );
      if (on) actions.appendChild(button("Done", () => {
        this.painting = null;
        this.host.rebuildInspector();
      }));
    }
    parent.appendChild(actions);
    if (this.painting?.itemId === d.id) {
      const r = fieldRow("brush (m)");
      const radius = Object.assign(document.createElement("input"), { type: "number", className: "ed-num", step: "0.05", min: "0.02", value: String(this.painting.radius) });
      radius.addEventListener("input", () => {
        const v = Number(radius.value);
        if (v > 0 && this.painting) this.painting.radius = v;
      });
      r.appendChild(radius);
      parent.appendChild(r);
    }
    parent.appendChild(div("ed-hint", isPainted(dec.kind)
      ? `${(dec.strokes ?? []).length} strokes.`
      : "Drag it along its rock: it stays on the rock as it moves."));
  }
}
