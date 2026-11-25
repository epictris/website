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
import { DEFAULT_THRESHOLD, PaintCoverage, samplesOf } from "./paintCoverage";
import { PaintCursor } from "./paintCursor";
import type { GizmoHandlers } from "./gizmo";
import { anchorFrame, placedFrame } from "../render3d/formations";
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
// The coverage a painted decoration grows where it reaches: its own
// `threshold` setting, or the grower's default.
const thresholdOf = (d: EdItem): number => Number(d.decoration?.settings?.["threshold"] ?? DEFAULT_THRESHOLD);
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
  // A kind waiting for its first click on a formation's rock: the one whose
  // list armed it, or (null, the Decorations workspace's palette) any rock
  // that is generated.
  placing: { kind: DecorationKind; formationId: number | null } | null = null;
  // The painted decoration the brush is on, and how it paints. `palette`: the
  // palette's brush, a workspace tool that never touches the selection (it
  // paints whichever rock it is pressed on); otherwise the selected
  // decoration's own (its panel's Paint), which ends when the selection moves.
  painting: { itemId: number; radius: number; erase: boolean; palette?: boolean } | null = null;
  private drag: { mode: "move" | "paint"; itemId: number; last: THREE.Vector3 | null } | null = null;
  // What the paint covers, drawn over the rock while the brush is on.
  readonly preview = new THREE.Group();
  // What the preview was last built for; null means stale, build again. Not
  // "": that is also the key of "nothing to show", so resetting to it made
  // the next sync match and keep the dots (2026-11-23: Esc or a click off the
  // rock ended the brush and left its coverage drawn).
  private previewKey: string | null = "";
  // The coverage of the rock being painted, kept while the same rock and
  // decoration are, so a dab composites only its own stamp.
  private coverage: { rock: THREE.Object3D; itemId: number; field: PaintCoverage } | null = null;
  // The brush under the pointer (paintCursor.ts), while a painted kind is
  // armed or its brush is on; what it was last drawn for, so a change of
  // radius, of paint or erase, or the brush ending redraws it.
  readonly cursor = new PaintCursor();
  private hovered: SurfaceHit | null = null;
  private cursorKey = "";
  // The brush's radius, metres: kept between brushes, so the cursor of an
  // armed kind is the brush its first press paints with.
  private radius = BRUSH_RADIUS;
  // Whether the palette's brush erases.
  private erasing = false;
  // What the palette's brush has painted since it was armed: a right-click
  // grows them all.
  private readonly session = new Set<number>();
  // The growth each decoration was last asked for by a right-click (`apply`),
  // by its request's hash.
  private readonly asked = new Map<number, string>();

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
    return this.selectedTarget(selected);
  }

  // Whether the next press may land on any generated rock (the palette's
  // placing), rather than on `target`'s alone.
  get anyRock(): boolean {
    return this.placing !== null && this.placing.formationId === null;
  }

  // Whether an item is a rock a decoration can be put on: a formation that is
  // generated.
  isRock(id: number): boolean {
    const f = this.item(id);
    return f?.object === "formation" && !!f.formation?.built;
  }

  // Arm a kind for the next click on any generated rock (the Decorations
  // workspace's palette). Clicking the armed kind again disarms it.
  arm(kind: DecorationKind): void {
    if (this.placing?.kind === kind && this.placing.formationId === null) {
      this.cancel();
      return;
    }
    this.placing = { kind, formationId: null };
    this.painting = null;
    this.previewKey = null;
    this.syncPreview();
    this.host.rebuildInspector();
  }

  private selectedTarget(selected: readonly EdItem[]): number | null {
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

  // Placing and painting belong to what is selected: the brush to its painted
  // decoration, selected alone (its panel holds Painting… and Done), placing
  // to the formation's body. A selection that moves anywhere else ends the
  // mode, as leaving a tool's object ends the tool. Before 2026-11-23 only
  // Esc, Done or a click off the rock did: picking another item in the
  // outliner left the brush on with no panel to say so, its coverage dots
  // drawn over the rock and a click on the rock still painting.
  followSelection(selected: readonly EdItem[], selectedBodies: ReadonlySet<number>): void {
    if (this.painting && !this.painting.palette) {
      if (selected.length !== 1 || selected[0]!.id !== this.painting.itemId) this.cancel();
      return;
    }
    // The palette's placing is the workspace's tool, not the selection's: it
    // stays armed until Esc, its button or a press off every rock.
    if (this.placing && this.placing.formationId !== null) {
      const f = this.item(this.placing.formationId);
      if (!f || !(selectedBodies.has(f.bodyId) || selected.some((i) => i.bodyId === f.bodyId))) this.cancel();
    }
  }

  // Out of placing and painting, the panel saying so.
  cancel(): void {
    if (!this.busy) return;
    this.placing = null;
    this.painting = null;
    this.session.clear();
    for (const c of this.fields.values()) c.field.dispose();
    this.fields.clear();
    this.previewKey = null;
    this.syncPreview();
    this.host.rebuildInspector();
  }

  press(hit: SurfaceHit | null, selected: readonly EdItem[]): boolean {
    // A press OFF the rock leaves placing or painting and is then an ordinary
    // click (it selects what it lands on), as a click away from a tool is in
    // any editor. Swallowing it instead left the editor unable to select
    // anything with no word as to why while a brush was still on.
    if (this.placing) {
      const palette = this.placing.formationId === null;
      const f = this.item(this.placing.formationId ?? hit?.itemId ?? -1);
      if (!hit || !f || hit.itemId !== f.id || !this.isRock(f.id)) {
        this.cancel();
        return false;
      }
      const kind = this.placing.kind;
      // The palette's brush: the press is a stroke on this rock's own paint
      // of the kind, started here the first time. It stays armed, and
      // selects nothing (since 2026-11-25: selecting the new moss put its
      // panel and gizmo up over the rock being painted).
      if (palette && isPainted(kind)) {
        // The patch under the brush, or the rock's own; the stroke takes in
        // any other it reaches (`stroke`).
        const existing = this.patchesUnder(f, kind, this.stampAt(f, hit, this.radius, this.erasing))[0] ?? this.paintedOn(f, kind);
        // An eraser on a rock with none of this paint has nothing to do.
        if (!existing && this.erasing) return true;
        if (existing) this.host.beginAction();
        const d = existing ?? this.place(f, kind, hit, false);
        if (!this.session.size) showToast(`Painting ${DECORATION_LABELS[kind].toLowerCase()}: right-click to grow it, right-click again to stop.`);
        this.session.add(d.id);
        this.painting = { itemId: d.id, radius: this.radius, erase: this.erasing, palette: true };
        this.drag = { mode: "paint", itemId: d.id, last: null };
        this.stroke(d, hit);
        return true;
      }
      // A placed kind from the palette stays armed, so a row of ferns is a
      // row of clicks, and selects nothing; one from a rock's own list is
      // selected, and a painted one goes to its brush, the press its first
      // stroke.
      if (!palette) this.placing = null;
      const item = this.place(f, kind, hit, !palette);
      if (isPainted(kind)) {
        this.painting = { itemId: item.id, radius: this.radius, erase: false };
        this.drag = { mode: "paint", itemId: item.id, last: null };
        this.stroke(item, hit);
      } else this.grow(item);
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

  // The left button let go: the stroke ends, and nothing grows yet. A
  // painted decoration grows on a right-click (`apply`), so several strokes,
  // with the view moved between them, wait on one growth rather than each on
  // its own.
  release(): void {
    this.drag = null;
  }

  // A right-click while a kind is armed or a brush is on: "done". It grows
  // what was painted, if that is not grown or asked for as it stands, and
  // the brush stays on; with nothing left to grow it ends the brush or the
  // placing, back to Select (2026-11-25). Asked for, not grown: a growth takes
  // a while to land and the paint reads as stale until it does, so judging by
  // `stale` alone, the second right-click asked for the same growth again
  // rather than ending the brush. True when the click was the brush's.
  apply(): boolean {
    if (!this.busy) return false;
    const ids = [...this.session, ...(this.painting && !this.painting.palette ? [this.painting.itemId] : [])];
    let grew = 0;
    for (const id of ids) {
      const d = this.item(id);
      const r = d && this.stale(d) ? this.request(d) : null;
      if (!d || !r) continue;
      const hash = decorationHash(r);
      if (this.asked.get(d.id) === hash) continue;
      this.asked.set(d.id, hash);
      this.grow(d);
      grew++;
    }
    if (!grew) this.cancel();
    return true;
  }

  // The rock's own paint of a kind, for the palette's brush: the last one
  // made, unless it could not follow its rock.
  private paintedOn(f: EdItem, kind: DecorationKind): EdItem | null {
    return this.patchesOn(f, kind).at(-1) ?? null;
  }

  // The PATCHES of a kind on a rock: its painted decorations of that kind,
  // but one that could not follow its rock.
  private patchesOn(f: EdItem, kind: DecorationKind): EdItem[] {
    return bodyMembers(this.host.model().items, f.bodyId).filter(
      (i) => i.object === "decoration" && i.decoration?.kind === kind && i.decoration.formation === f.formation?.id && !i.decoration.lost,
    );
  }

  // The patches of a kind on a rock whose paint a stamp would reach (their
  // coverage, as the dots draw it: `PaintCoverage.touches`), but `except`.
  // Nothing until the rock has loaded.
  private patchesUnder(f: EdItem, kind: DecorationKind, stamp: PaintStamp, except?: number): EdItem[] {
    const rock = rockOf(f, () => {});
    if (!rock) return [];
    return this.patchesOn(f, kind).filter((d) => d.id !== except && this.fieldOf(d, rock).touches(stamp));
  }

  // Each patch's coverage on its rock, kept while its strokes are only
  // added to, so a dab tests a patch without compositing it again.
  private readonly fields = new Map<number, { rock: THREE.Object3D; field: PaintCoverage }>();
  private fieldOf(d: EdItem, rock: THREE.Object3D): PaintCoverage {
    const strokes = d.decoration?.strokes ?? [];
    const threshold = thresholdOf(d);
    let c = this.fields.get(d.id);
    if (!c || c.rock !== rock || !c.field.update(strokes, threshold)) {
      c?.field.dispose();
      c = { rock, field: new PaintCoverage(rock) };
      c.field.update(strokes, threshold);
      this.fields.set(d.id, c);
    }
    return c.field;
  }

  // Painting over another patch of the same kind COMBINES them (2026-11-25):
  // two patches grown on one stretch of rock were two growths through each
  // other. `from`'s strokes go after `into`'s (so neither's erasing takes
  // away the other's paint it never saw) and `from` is taken out of the
  // level, in the stroke's own undo step.
  private absorb(into: EdItem, from: EdItem): void {
    const model = this.host.model();
    into.decoration = { ...into.decoration!, strokes: [...(into.decoration!.strokes ?? []), ...(from.decoration!.strokes ?? [])] };
    const at = model.items.indexOf(from);
    if (at >= 0) model.items.splice(at, 1);
    this.session.delete(from.id);
    this.asked.delete(from.id);
    this.fields.get(from.id)?.field.dispose();
    this.fields.delete(from.id);
    this.host.markDirty();
  }

  // A stamp of the brush at a hit, in `f`'s frame.
  private stampAt(f: EdItem, hit: SurfaceHit, radius: number, erase: boolean): PaintStamp {
    const local = toFormation(f, hit.point, hit.normal);
    return { p: v3(local.p), n: v3(local.n.normalize()), r: radius, s: erase ? -1 : 1 };
  }

  // A new decoration of `kind` on `f` where `hit` is, selected when `select`.
  private place(f: EdItem, kind: DecorationKind, hit: SurfaceHit, select: boolean): EdItem {
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
    if (select) this.host.select([item.id]);
    return item;
  }

  // A placed decoration dragged along its rock: the anchor follows the guide,
  // and what is drawn lands on the rock under it every frame.
  private moveTo(d: EdItem, hit: SurfaceHit): void {
    const f = this.formationOf(d);
    if (!f || !d.decoration) return;
    const local = toFormation(f, hit.point, hit.normal);
    this.landAt(d, f, local);
  }

  // A placed decoration carried to the rock nearest `local` (the formation's
  // frame): its anchor the guide's nearest point, drawn where that lands on
  // the rock.
  private landAt(d: EdItem, f: EdItem, local: { p: THREE.Vector3; n: THREE.Vector3 }): void {
    if (!d.decoration) return;
    const anchor = anchorAt(f, local.p);
    if (!anchor) return;
    const rock = rockOf(f, () => {});
    const onRock = (rock && projectOnRock(rock, anchor)) ?? { p: v3(local.p), n: v3(local.n.normalize()) };
    const { lost: _l, ...rest } = d.decoration;
    d.decoration = { ...rest, anchor, onRock };
    d.pos = markPos(f, onRock);
    this.host.markDirty();
  }

  // THE GIZMO on a placed decoration selected alone: its handles stand on it in
  // 3D, turned as it is (since 2026-11-25; before, it had the 2D object's
  // handles, on its mark on the gameplay plane and moving only that). A move
  // slides it over the rock: the point the handles are carried to is landed
  // on the rock, as a drag along it lands. A turn and a size are its own
  // (`turn`, `scale`), about where it stands, and regrow nothing.
  gizmo(id: number): GizmoHandlers | null {
    const now = (): { d: EdItem; f: EdItem; dec: EdDecoration } | null => {
      const d = this.item(id);
      const f = d ? this.formationOf(d) : null;
      return d?.decoration && f && !isPainted(d.decoration.kind) ? { d, f, dec: d.decoration } : null;
    };
    if (!now()) return null;
    // The decoration's whole frame in the world, and its anchor's alone (the
    // turn is measured against it).
    const frameOf = (c: { f: EdItem; dec: EdDecoration }, own: boolean): { pos: THREE.Vector3; quat: THREE.Quaternion } => {
      const m = formationMatrix(c.f).multiply(own ? placedFrame(c.dec) : anchorFrame(c.dec.onRock ?? c.dec.anchor));
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      m.decompose(pos, quat, new THREE.Vector3());
      return { pos, quat };
    };
    let base: THREE.Vector3 | null = null;
    return {
      pose: () => {
        const c = now();
        return c ? frameOf(c, true) : { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
      },
      axes: () => (now() ? { x: true, y: true, z: true } : null),
      begin: () => {
        const c = now();
        this.host.beginAction();
        base = new THREE.Vector3(...(c?.dec.scale ?? [1, 1, 1]));
      },
      apply: (mode, pos, quat, scale) => {
        const c = now();
        if (!c || !base) return;
        if (mode === "translate") {
          const { p, n } = toFormation(c.f, pos, new THREE.Vector3(...(c.dec.onRock ?? c.dec.anchor).n).transformDirection(formationMatrix(c.f)));
          this.landAt(c.d, c.f, { p, n });
        } else if (mode === "rotate") {
          const turn = frameOf(c, false).quat.invert().multiply(quat).normalize();
          c.d.decoration = { ...c.d.decoration!, turn: [turn.x, turn.y, turn.z, turn.w] };
        } else {
          const s = base.clone().multiply(scale);
          const min = 0.01;
          c.d.decoration = { ...c.d.decoration!, scale: [Math.max(min, s.x), Math.max(min, s.y), Math.max(min, s.z)] };
        }
        this.host.markDirty();
      },
      end: () => {
        base = null;
        this.host.rebuildInspector();
      },
    };
  }

  // One dab of the brush, no closer to the last than a third of its radius.
  private stroke(d: EdItem, hit: SurfaceHit): void {
    const f = this.formationOf(d);
    const brush = this.painting;
    if (!f || !d.decoration || !brush) return;
    const stamp = this.stampAt(f, hit, brush.radius, brush.erase);
    const at = new THREE.Vector3(...stamp.p);
    const g = this.drag;
    if (g?.last && g.last.distanceTo(at) < brush.radius / 3) return;
    if (g) g.last = at;
    for (const other of this.patchesUnder(f, d.decoration.kind, stamp, d.id)) this.absorb(d, other);
    d.decoration = { ...d.decoration!, strokes: [...(d.decoration!.strokes ?? []), stamp] };
    this.host.markDirty();
  }

  // What the decoration being painted covers, as the Blender brush shows it:
  // a field of dots where the paint reaches the grower's threshold (see
  // paintCoverage.ts). Nothing until the rock it is painted on has loaded.
  syncPreview(): void {
    this.syncCursor();
    const d = this.previewed();
    const f = d ? this.formationOf(d) : null;
    const rock = f ? rockOf(f, () => (this.previewKey = null)) : null;
    const strokes = d?.decoration?.strokes ?? [];
    const threshold = d ? thresholdOf(d) : DEFAULT_THRESHOLD;
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

  // Whose paint the dots show: the decoration being painted, or with the
  // palette's brush the paint of its kind on the rock under the pointer, so
  // what is there already shows before the first press (and what an eraser
  // would take away).
  private previewed(): EdItem | null {
    const painted = this.painting ? this.item(this.painting.itemId) : null;
    if (this.painting && !this.painting.palette) return painted;
    const kind = this.placing && this.placing.formationId === null && isPainted(this.placing.kind) ? this.placing.kind : null;
    if (!kind) return painted;
    if (this.drag) return painted;
    const f = this.hovered ? this.item(this.hovered.itemId) : null;
    if (!f) return painted;
    return f.id === (painted && this.formationOf(painted)?.id) ? painted : this.paintedOn(f, kind);
  }

  // --- the brush's cursor ----------------------------------------------------

  // The brush a press would paint with now: the one that is on, or the one an
  // armed painted kind starts.
  get brush(): { radius: number; erase: boolean } | null {
    if (this.painting) return this.painting;
    if (this.placing && isPainted(this.placing.kind)) return { radius: this.radius, erase: this.placing.formationId === null && this.erasing };
    return null;
  }

  // The palette brush's settings, for the dock: its radius (metres) and
  // whether it erases.
  get brushRadius(): number {
    return this.radius;
  }
  setBrushRadius(v: number): void {
    if (!(v > 0)) return;
    this.radius = v;
    if (this.painting) this.painting.radius = v;
  }
  get brushErases(): boolean {
    return this.erasing;
  }
  setBrushErases(v: boolean): void {
    this.erasing = v;
    if (this.painting?.palette) this.painting.erase = v;
  }

  // The pointer moved (null: off the canvas, or off every rock a press here
  // would paint).
  hover(hit: SurfaceHit | null): void {
    this.hovered = hit;
    this.drawCursor();
  }

  private drawCursor(): void {
    const hit = this.hovered;
    const brush = this.brush;
    const f = hit && brush ? this.item(hit.itemId) : null;
    this.cursorKey = this.brushKey();
    if (!hit || !brush || !f || !this.isRock(f.id)) {
      this.cursor.set(null);
      return;
    }
    const local = toFormation(f, hit.point, hit.normal);
    // A rock not loaded yet draws the ring alone, and the footprint when it lands.
    const rock = rockOf(f, () => this.drawCursor());
    this.cursor.set({ frame: formationMatrix(f), p: local.p, n: local.n, r: brush.radius, erase: brush.erase, samples: rock ? samplesOf(rock) : null });
  }

  private brushKey(): string {
    const b = this.brush;
    return b ? `${b.radius} ${b.erase}` : "";
  }

  // Once a frame: the brush ended, or changed with no pointer move (Esc, the
  // panel's Erase, its radius), and the formation's frame, which a 3D body's
  // depth and tilt move with no pointer move either.
  private syncCursor(): void {
    if (this.brushKey() !== this.cursorKey) this.drawCursor();
    const f = this.hovered && this.cursor.object.visible ? this.item(this.hovered.itemId) : null;
    if (f) this.cursor.setFrame(formationMatrix(f));
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
          this.painting = { itemId: d.id, radius: this.radius, erase: false };
          this.host.rebuildInspector();
        }, "Drag on the rock to paint, as many strokes as you like; right-click to grow it, right-click again to stop."),
        button(on && this.painting!.erase ? "Erasing…" : "Erase", () => {
          this.painting = { itemId: d.id, radius: this.radius, erase: true };
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
        this.setBrushRadius(v);
      });
      r.appendChild(radius);
      parent.appendChild(r);
    }
    parent.appendChild(div("ed-hint", isPainted(dec.kind)
      ? `${(dec.strokes ?? []).length} strokes.`
      : "Drag it along its rock: it stays on the rock as it moves."));
  }
}
