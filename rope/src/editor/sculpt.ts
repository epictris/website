// SCULPT MODE (plans/sculpt-guides.md, docs/formations.md "Sculpting"): a
// solid guide shaped as Blender sculpts a mesh - Draw (D), Grab (G), Cut (C),
// with Dyntopo building detail where the brush goes and Remesh rebuilding the
// whole - in the Formations workspace, on one selected guide.
//
// The geometry is formation/: the working mesh (sculptMesh.ts), the brushes
// (sculptBrush.ts), Dyntopo (dyntopo.ts), the cut solid (sculptCut.ts) and
// the voxel remesh (sculptRemesh.ts). This is the editor's half: entering and
// leaving, turning pointer moves into dabs, the brush cursor, the cut's
// polygon, the sculpt's own undo, and committing the mesh to the store and
// the level.
//
// - ENTERING applies the guide's stack into one stored mesh first when it is
//   more than that (Apply, its own undo step), then holds the mesh as a
//   working mesh for the session.
// - THE MODEL IS NOT TOUCHED MID-STROKE. A stroke's end is a sculpt undo step
//   (Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y); the mesh is COMMITTED - stored and named
//   by the guide - on leaving, and after two idle seconds so a reload loses
//   little. The whole session is one editor undo step.
// - A commit is checked: a fold through itself (or anything manifold-3d will
//   not take as a solid) is not committed while idle (a notice says so), and
//   on leaving is remeshed first, with a notice.
// - CUT (C) works on a guide in or out of the mode: out of it, the whole
//   guide's stack is cut and becomes one mesh, as Apply would make it.

import * as THREE from "three";
import { Vec2 } from "../engine/vec2";
import { dyntopo } from "../formation/dyntopo";
import { manifoldOfMesh, meshOfManifold, solidManifold, storedGuideMesh } from "../formation/solid";
import { DAB_SPACING, dabsAlong, drawDab, GrabStroke, smoothDab } from "../formation/sculptBrush";
import { cutGuide, polygonIsSimple, type CutView } from "../formation/sculptCut";
import { SculptMesh, type SculptStep } from "../formation/sculptMesh";
import { selfIntersects, voxelRemesh } from "../formation/sculptRemesh";
import type { SolidMesh } from "../formation/meshBin";
import { meshLeafTree, needsApply, sculptedMeshOf } from "../formation/solidTree";
import type { SolidNode } from "../level/levelFormat";
import { applyGuide, type FormationHost } from "./formationPanel";
import type { EdItem } from "./model";
import { loadedMeshes, requestMeshes, storeMesh } from "./solidGuides";

export type SculptTool = "draw" | "grab";

export interface SculptSettings {
  tool: SculptTool;
  // The brush's radius on screen, CSS pixels (Blender's default "view"
  // radius), and its strength, 0 to 1.
  radiusPx: number;
  strength: number;
  dyntopo: boolean;
  // Dyntopo's and Remesh's detail size, metres.
  detail: number;
}

const DEFAULTS: SculptSettings = { tool: "draw", radiusPx: 50, strength: 0.5, dyntopo: true, detail: 0.02 };
const SETTINGS_KEY = "rope.editor.sculpt";
// After a stroke, the mesh is committed once nothing has happened for this
// long, so a reload loses little.
const IDLE_COMMIT_MS = 2000;
// A click this close to the cut's first point closes it, CSS pixels.
const CLOSE_PX = 8;
const UNDO_MAX = 64;

function readSettings(): SculptSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<SculptSettings>;
    const out = { ...DEFAULTS };
    if (raw.tool === "draw" || raw.tool === "grab") out.tool = raw.tool;
    for (const k of ["radiusPx", "strength", "detail"] as const) if (typeof raw[k] === "number" && Number.isFinite(raw[k])) out[k] = raw[k];
    if (typeof raw.dyntopo === "boolean") out.dyntopo = raw.dyntopo;
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export interface SculptUi {
  el(tag: string, cls: string): HTMLElement;
  button(text: string, onClick: () => void): HTMLButtonElement;
  checkbox(label: string, initial: boolean, onChange: (v: boolean) => void): HTMLElement;
  toolGroup(text: string): HTMLElement;
}

export interface SculptHost {
  // Where the working mesh and the cursor are drawn (the editor layer).
  layer: THREE.Object3D;
  camera(): THREE.Camera;
  // Over the canvas, for the cut's polygon and the radius ring.
  overlayParent: HTMLElement;
  canvas: HTMLCanvasElement;
  ndc(scr: Vec2): { x: number; y: number };
  item(id: number): EdItem | undefined;
  // Whether a formation is still what the author has selected in Formations.
  stillSelected(item: EdItem): boolean;
  // The guide's frame in the scene (`itemMatrix`), and its colour.
  frame(item: EdItem): THREE.Matrix4;
  color(item: EdItem): number;
  formation: FormationHost;
  notice(text: string): void;
  // The mode began or ended, or the cut did: the dock, the gizmo and what is
  // drawn follow.
  changed(): void;
  ui: SculptUi;
}

interface Session {
  itemId: number;
  mesh: SculptMesh;
  object: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  undo: SculptStep[];
  redo: SculptStep[];
  // The tree the guide holds as far as this session knows (what it found, or
  // last committed): a different one means it was changed from outside.
  tree: SolidNode;
  // Whether the session's editor undo step is taken (the first commit).
  stepTaken: boolean;
  // Edits since the last commit, and the triangles they touched (what the
  // commit's fold check looks at).
  dirty: boolean;
  touched: Set<number>;
  idle: number | null;
}

interface Stroke {
  kind: SculptTool;
  last: Vec2;
  carry: { left: number };
  // Grab: the vertices taken, the plane the pointer moves them in (world)
  // and where it met that plane at the press.
  grab: { g: GrabStroke; plane: THREE.Plane; from: THREE.Vector3; r: number; delta: number[] } | null;
  // Grab with Ctrl (or Shift) held smooths instead; let go, it takes up the
  // vertices under the brush afresh.
  smoothing: boolean;
}

interface CutDraft {
  // The guide cut: this session's, or a guide's whole stack.
  itemId: number;
  points: Vec2[];
  pointer: Vec2 | null;
}

type Adjust = { kind: "radius"; centre: Vec2; before: number } | { kind: "strength"; start: Vec2; before: number };

export class SculptController {
  settings = readSettings();
  private session: Session | null = null;
  private stroke: Stroke | null = null;
  private cut: CutDraft | null = null;
  private adjust: Adjust | null = null;
  private hover: Vec2 | null = null;
  private readonly cursor: THREE.LineLoop;
  private readonly matcap: THREE.Texture;
  private readonly svg: SVGSVGElement;
  private readonly ray = new THREE.Raycaster();
  readonly dock: HTMLElement;
  private dockRefresh: () => void = () => {};

  constructor(private readonly host: SculptHost) {
    const ring = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2), Math.sin((i / 64) * Math.PI * 2), 0)),
    );
    this.cursor = new THREE.LineLoop(ring, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }));
    this.cursor.renderOrder = 40;
    this.cursor.visible = false;
    this.cursor.raycast = () => {};
    host.layer.add(this.cursor);
    this.matcap = makeMatcap();
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.classList.add("ed-sculpt-overlay");
    this.svg.style.cssText = "position:absolute;pointer-events:none;overflow:visible;left:0;top:0;";
    host.overlayParent.appendChild(this.svg);
    this.dock = this.buildDock();
  }

  get active(): boolean {
    return this.session !== null;
  }
  get itemId(): number | null {
    return this.session?.itemId ?? null;
  }
  // Whether a cut's polygon is being drawn (in the mode or out of it).
  get cutting(): boolean {
    return this.cut !== null;
  }
  // Whether the pointer belongs to the mode right now (a stroke, a cut, an
  // adjustment): the editor's own handlers stand aside.
  get busy(): boolean {
    return this.stroke !== null || this.cut !== null || this.adjust !== null;
  }

  // --- entering and leaving -------------------------------------------------

  // Sculpt mode on `item`'s guide. False (with a notice) where it cannot
  // start yet.
  enter(item: EdItem): boolean {
    if (this.session?.itemId === item.id) return true;
    if (this.session) this.exit();
    const guide = item.formation?.guide;
    if (guide?.kind !== "solid") return false;
    if (needsApply(guide.tree) && !applyGuide(this.host.formation, item)) return false;
    const tree = (item.formation!.guide as { tree: SolidNode }).tree;
    const name = sculptedMeshOf(tree);
    const stored = name ? loadedMeshes().get(name) : undefined;
    if (!name || !stored) {
      requestMeshes(tree, () => this.host.changed());
      this.host.notice("The guide's mesh is still loading; Sculpt again in a moment.");
      return false;
    }
    // Through manifold-3d once, so a mesh imported welded only to a tenth of
    // a millimetre is one closed surface with shared vertices.
    let clean: SolidMesh;
    try {
      const m = manifoldOfMesh(stored);
      clean = meshOfManifold(m);
      m.delete();
    } catch (e) {
      this.host.notice(`The guide is not a closed solid (${(e as Error).message}); it cannot be sculpted.`);
      return false;
    }
    const mesh = SculptMesh.fromMesh(clean);
    const geometry = new THREE.BufferGeometry();
    // Flat shaded, as Blender's Dyntopo draws by default ("Smooth Shading"
    // off): a vertex normal averaged across a primitive's two-metre faces
    // streaks them, and at the detail size the facets are what is sculpted.
    const material = new THREE.MeshMatcapMaterial({ matcap: this.matcap, color: tint(this.host.color(item)), flatShading: true });
    const object = new THREE.Mesh(geometry, material);
    object.matrixAutoUpdate = false;
    object.frustumCulled = false;
    object.renderOrder = 20;
    object.raycast = () => {};
    this.host.layer.add(object);
    this.session = { itemId: item.id, mesh, object, geometry, undo: [], redo: [], tree, stepTaken: false, dirty: false, touched: new Set(), idle: null };
    this.uploadAll();
    this.host.changed();
    this.dockRefresh();
    this.host.notice("Sculpt: D draw, G grab, C cut, F radius, Shift+F strength; Ctrl digs (Draw) or smooths (Grab), Shift smooths. Esc leaves.");
    return true;
  }

  // Leave the mode, committing what was sculpted (`commit` false: drop it,
  // for a guide changed or removed from outside).
  exit(commit = true): void {
    const s = this.session;
    if (!s) return;
    this.endStroke();
    this.cut = null;
    this.adjust = null;
    if (commit) this.commit(true);
    if (s.idle !== null) clearTimeout(s.idle);
    this.host.layer.remove(s.object);
    s.geometry.dispose();
    (s.object.material as THREE.Material).dispose();
    this.session = null;
    this.cursor.visible = false;
    this.drawOverlay();
    this.host.changed();
    this.dockRefresh();
  }

  // Every frame: the mesh follows its body, the buffers take what changed,
  // and the mode ends when its guide is no longer selected, no longer there,
  // or changed from outside.
  frame(inFormations: boolean): void {
    const s = this.session;
    if (!s) return;
    const item = this.host.item(s.itemId);
    const guide = item?.formation?.guide;
    if (!item || guide?.kind !== "solid") {
      this.exit(false);
      return;
    }
    if (guide.tree !== s.tree) {
      this.host.notice("The guide was changed outside Sculpt; the sculpt since its last save is dropped.");
      this.exit(false);
      return;
    }
    if (!inFormations || !this.host.stillSelected(item)) {
      this.exit();
      return;
    }
    s.object.matrix.copy(this.host.frame(item));
    s.object.matrixWorldNeedsUpdate = true;
    this.upload();
  }

  // --- committing -----------------------------------------------------------

  private scheduleCommit(): void {
    const s = this.session;
    if (!s) return;
    if (s.idle !== null) clearTimeout(s.idle);
    s.idle = window.setTimeout(() => {
      s.idle = null;
      if (this.session === s && !this.stroke) this.commit(false);
    }, IDLE_COMMIT_MS);
  }

  // Store the working mesh and name it in the guide. `leaving`: a mesh that is
  // not a valid solid is remeshed first; otherwise it is left uncommitted
  // with a notice until it is fixed (Remesh) or the mode is left.
  private commit(leaving: boolean): void {
    const s = this.session;
    const item = s ? this.host.item(s.itemId) : undefined;
    if (!s || !s.dirty || !item?.formation) return;
    const working = s.mesh.toMesh();
    const fold = this.folds(s) ? "folds through itself" : null;
    const checked = fold ? { problem: fold } : storedGuideMesh(working);
    let mesh: SolidMesh;
    if ("mesh" in checked) mesh = checked.mesh;
    else {
      const problem = checked.problem;
      if (!leaving) {
        this.host.notice(`Not saved yet: the sculpt ${problem}. Remesh (Ctrl+R) repairs it; leaving Sculpt remeshes it.`);
        return;
      }
      let remeshed: ReturnType<typeof storedGuideMesh>;
      try {
        remeshed = storedGuideMesh(voxelRemesh(working, this.settings.detail).mesh);
      } catch (e) {
        remeshed = { problem: (e as Error).message };
      }
      if (!("mesh" in remeshed)) {
        this.host.notice(`The sculpt ${problem}, and the remesh failed (${remeshed.problem}); it was not saved.`);
        return;
      }
      mesh = remeshed.mesh;
      this.host.notice(`The sculpt ${problem}; it was remeshed at ${(this.settings.detail * 100).toFixed(1)} cm before saving.`);
    }
    const { name } = storeMesh(mesh);
    if (!s.stepTaken) {
      this.host.formation.beginAction();
      s.stepTaken = true;
    }
    const tree = meshLeafTree(name);
    item.formation = { ...item.formation, guide: { kind: "solid", tree } };
    s.tree = tree;
    s.dirty = false;
    s.touched.clear();
    this.host.formation.markDirty();
  }

  // Whether the working mesh folds through itself among the triangles touched
  // since the last commit: a solid manifold-3d accepts and a generator
  // misreads.
  private folds(s: Session): boolean {
    const m = s.mesh;
    m.sync();
    const p = m.pos, I = m.idx;
    const near = (t: number, visit: (u: number) => void): void => {
      const a = I[t * 3]! * 3, b = I[t * 3 + 1]! * 3, c = I[t * 3 + 2]! * 3;
      m.grid.queryBox(
        Math.min(p[a]!, p[b]!, p[c]!), Math.min(p[a + 1]!, p[b + 1]!, p[c + 1]!), Math.min(p[a + 2]!, p[b + 2]!, p[c + 2]!),
        Math.max(p[a]!, p[b]!, p[c]!), Math.max(p[a + 1]!, p[b + 1]!, p[c + 1]!), Math.max(p[a + 2]!, p[b + 2]!, p[c + 2]!),
        visit,
      );
    };
    return selfIntersects(m.pos, m.idx, m.tAlive, near, s.touched);
  }

  // A step done: kept for undo, its triangles for the commit's check.
  private pushStep(step: SculptStep | null): void {
    const s = this.session;
    if (!s || !step) return;
    s.undo.push(step);
    if (s.undo.length > UNDO_MAX) s.undo.shift();
    s.redo.length = 0;
    this.noteTouched(step);
    s.dirty = true;
    this.scheduleCommit();
  }
  private noteTouched(step: SculptStep): void {
    const s = this.session!;
    for (const t of step.after.t.keys()) s.touched.add(t);
    for (const v of step.after.v.keys()) for (const t of s.mesh.trisOf(v)) s.touched.add(t);
  }

  undo(): void {
    const s = this.session;
    const step = s?.undo.pop();
    if (!s || !step) return;
    s.mesh.restore(step.before);
    s.redo.push(step);
    this.noteTouched(step);
    s.dirty = true;
    this.scheduleCommit();
  }
  redo(): void {
    const s = this.session;
    const step = s?.redo.pop();
    if (!s || !step) return;
    s.mesh.restore(step.after);
    s.undo.push(step);
    this.noteTouched(step);
    s.dirty = true;
    this.scheduleCommit();
  }

  // The whole mesh rebuilt at the detail size (Blender's voxel remesh), one
  // sculpt undo step.
  remesh(): void {
    const s = this.session;
    if (!s) return;
    const t0 = performance.now();
    let made: { mesh: SolidMesh; cell: number };
    try {
      made = voxelRemesh(s.mesh.toMesh(), this.settings.detail);
    } catch (e) {
      this.host.notice(`Remesh failed: ${(e as Error).message}`);
      return;
    }
    s.mesh.beginStep();
    s.mesh.replaceWith(made.mesh);
    this.pushStep(s.mesh.endStep());
    const coarser = made.cell > this.settings.detail * 1.001 ? ` (coarsened to ${(made.cell * 100).toFixed(1)} cm: the guide is large for its detail)` : "";
    this.host.notice(`Remeshed: ${(made.mesh.indices.length / 3).toLocaleString()} triangles in ${Math.round(performance.now() - t0)} ms${coarser}. Ctrl+Z undoes.`);
  }

  // --- the pointer ------------------------------------------------------------

  // A left press. True when the mode took it.
  press(scr: Vec2, e: MouseEvent): boolean {
    if (this.adjust) {
      this.adjust = null;
      this.saveSettings();
      this.drawOverlay();
      return true;
    }
    if (this.cut) {
      const c = this.cut;
      if (c.points.length >= 3 && scr.distanceTo(c.points[0]!) <= CLOSE_PX) this.closeCut(e.altKey);
      else c.points.push(scr);
      this.drawOverlay();
      return true;
    }
    const s = this.session;
    if (!s) return false;
    const hit = this.hit(scr);
    if (!hit) return true;
    s.mesh.beginStep();
    const tool = this.settings.tool;
    this.stroke = { kind: tool, last: scr, carry: { left: 0 }, grab: null, smoothing: false };
    if (tool === "grab" && !(e.ctrlKey || e.shiftKey)) this.takeGrab(hit);
    else this.dab(hit, e);
    this.stroke.smoothing = tool === "grab" && (e.ctrlKey || e.shiftKey);
    return true;
  }

  // The pointer moved. True when the mode used it (a stroke, a cut, an
  // adjustment); the hover cursor follows either way.
  move(scr: Vec2, e: MouseEvent): boolean {
    this.hover = scr;
    if (this.adjust) {
      const a = this.adjust;
      if (a.kind === "radius") this.settings.radiusPx = Math.max(2, Math.min(1500, scr.distanceTo(a.centre)));
      else this.settings.strength = Math.max(0, Math.min(1, a.before + (scr.x - a.start.x) / 300));
      if (a.kind === "strength") this.host.notice(`Strength ${this.settings.strength.toFixed(2)} (click to set, Esc to keep ${a.before.toFixed(2)})`);
      this.drawOverlay();
      this.dockRefresh();
      return true;
    }
    if (this.cut) {
      this.cut.pointer = scr;
      this.drawOverlay();
      return true;
    }
    if (!this.session) return false;
    const st = this.stroke;
    if (st) this.continueStroke(st, scr, e);
    this.placeCursor(scr, e);
    return st !== null;
  }

  release(): void {
    if (this.stroke) this.endStroke();
  }

  private continueStroke(st: Stroke, scr: Vec2, e: MouseEvent): void {
    const s = this.session!;
    const smoothing = st.kind === "grab" && (e.ctrlKey || e.shiftKey);
    if (st.kind === "grab" && !smoothing) {
      // Ctrl (or Shift) let go: take up the vertices under the brush where
      // it is now, from where they are now.
      if (st.smoothing || !st.grab) {
        st.smoothing = false;
        const hit = this.hit(scr);
        if (hit) this.takeGrab(hit);
        st.last = scr;
        return;
      }
      const g = st.grab;
      const item = this.host.item(s.itemId)!;
      const toLocal = this.host.frame(item).invert();
      this.ray.setFromCamera(new THREE.Vector2(this.host.ndc(scr).x, this.host.ndc(scr).y), this.host.camera());
      const on = this.ray.ray.intersectPlane(g.plane, new THREE.Vector3());
      if (!on) return;
      const a = g.from.clone().applyMatrix4(toLocal);
      const b = on.applyMatrix4(toLocal);
      g.delta = [b.x - a.x, b.y - a.y, b.z - a.z];
      g.g.move(g.delta);
      if (this.settings.dyntopo) {
        const centre = [a.x + g.delta[0]! / 2, a.y + g.delta[1]! / 2, a.z + g.delta[2]! / 2];
        const reach = g.r + Math.hypot(g.delta[0]!, g.delta[1]!, g.delta[2]!) / 2;
        dyntopo(s.mesh, centre, reach, this.settings.detail, { collapse: false, flip: false, onSplit: (x, y, m) => g.g.split(x, y, m, g.delta) });
      }
      st.last = scr;
      return;
    }
    st.smoothing = smoothing;
    for (const at of dabsAlong([st.last.x, st.last.y], [scr.x, scr.y], DAB_SPACING * this.settings.radiusPx, st.carry)) {
      const hit = this.hit(new Vec2(at[0]!, at[1]!));
      if (hit) this.dab(hit, e);
    }
    st.last = scr;
  }

  // One dab where the brush meets the surface: Dyntopo first (if on), then
  // the brush - Smooth with Shift on any tool or Ctrl on Grab, Draw (Ctrl
  // digs) otherwise.
  private dab(hit: Hit, e: MouseEvent): void {
    const s = this.session!;
    if (this.settings.dyntopo) dyntopo(s.mesh, hit.local, hit.r, this.settings.detail);
    const smooth = e.shiftKey || (this.settings.tool === "grab" && e.ctrlKey);
    if (smooth) smoothDab(s.mesh, hit.local, hit.r, this.settings.strength);
    else drawDab(s.mesh, hit.local, hit.r, this.settings.strength, e.ctrlKey ? -1 : 1);
  }

  private takeGrab(hit: Hit): void {
    const st = this.stroke!;
    const s = this.session!;
    const normal = this.host.camera().getWorldDirection(new THREE.Vector3());
    st.grab = {
      g: new GrabStroke(s.mesh, hit.local, hit.r),
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.world),
      from: hit.world.clone(),
      r: hit.r,
      delta: [0, 0, 0],
    };
  }

  private endStroke(): void {
    const st = this.stroke;
    const s = this.session;
    this.stroke = null;
    if (!st || !s) return;
    // A grab's region tidied once it is let go: what it stretched split, what
    // it squeezed collapsed.
    if (st.grab && this.settings.dyntopo) {
      const g = st.grab;
      const item = this.host.item(s.itemId);
      if (item) {
        const a = g.from.clone().applyMatrix4(this.host.frame(item).invert());
        const centre = [a.x + g.delta[0]! / 2, a.y + g.delta[1]! / 2, a.z + g.delta[2]! / 2];
        dyntopo(s.mesh, centre, g.r + Math.hypot(g.delta[0]!, g.delta[1]!, g.delta[2]!) / 2, this.settings.detail);
      }
    }
    this.pushStep(s.mesh.endStep());
  }

  // --- hits and the cursor ----------------------------------------------------

  // Where the pointer meets the working mesh: in the guide's frame and the
  // world, with the brush's radius there (its screen radius at that depth).
  private hit(scr: Vec2): Hit | null {
    const s = this.session;
    const item = s ? this.host.item(s.itemId) : undefined;
    if (!s || !item) return null;
    const frame = this.host.frame(item);
    const toLocal = frame.clone().invert();
    const n = this.host.ndc(scr);
    this.ray.setFromCamera(new THREE.Vector2(n.x, n.y), this.host.camera());
    const o = this.ray.ray.origin.clone().applyMatrix4(toLocal);
    const d = this.ray.ray.direction.clone().transformDirection(toLocal);
    const h = s.mesh.raycast([o.x, o.y, o.z], [d.x, d.y, d.z]);
    if (!h) return null;
    const world = new THREE.Vector3(...h.point).applyMatrix4(frame);
    const normal = new THREE.Vector3(...s.mesh.triNormal(h.tri)).transformDirection(frame);
    return { local: h.point, world, normal, r: this.worldRadius(world), tri: h.tri };
  }

  // The brush's screen radius as metres at a world point.
  private worldRadius(at: THREE.Vector3): number {
    const cam = this.host.camera();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    const a = at.clone().project(cam);
    const b = at.clone().add(right).project(cam);
    const h = this.host.canvas.clientHeight || 1;
    const w = this.host.canvas.clientWidth || 1;
    const pxPerMetre = Math.hypot(((b.x - a.x) / 2) * w, ((b.y - a.y) / 2) * h);
    return this.settings.radiusPx / Math.max(pxPerMetre, 1e-9);
  }

  private placeCursor(scr: Vec2, e: MouseEvent): void {
    const hit = this.session ? this.hit(scr) : null;
    this.cursor.visible = hit !== null && !this.cut;
    if (!hit) return;
    this.cursor.position.copy(hit.world);
    this.cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal.normalize());
    this.cursor.scale.setScalar(hit.r);
    const smooth = e.shiftKey || (this.settings.tool === "grab" && e.ctrlKey);
    const dig = !smooth && e.ctrlKey;
    (this.cursor.material as THREE.LineBasicMaterial).color.setHex(smooth ? 0xf3dd8c : dig ? 0x8cc8f3 : 0xffffff);
  }

  // --- the cut ----------------------------------------------------------------

  // Start drawing a cut's polygon on `item`'s guide (in the mode: its own).
  startCut(item: EdItem): void {
    if (item.formation?.guide.kind !== "solid") return;
    this.cut = { itemId: item.id, points: [], pointer: this.hover };
    this.cursor.visible = false;
    this.drawOverlay();
    this.host.changed();
    this.host.notice("Cut: click the corners of what to keep; Enter or the first corner closes (Alt cuts it away instead), Esc drops it.");
  }

  private cancelCut(): void {
    this.cut = null;
    this.drawOverlay();
    this.host.changed();
  }

  private closeCut(subtract: boolean): void {
    const c = this.cut;
    if (!c) return;
    const poly = c.points.map((p) => [p.x, p.y] as [number, number]);
    if (poly.length < 3) {
      this.host.notice("Cut: a polygon needs three corners.");
      return;
    }
    if (!polygonIsSimple(poly)) {
      this.host.notice("Cut: the polygon crosses itself; move on or Esc.");
      return;
    }
    this.cut = null;
    this.drawOverlay();
    const item = this.host.item(c.itemId);
    if (item) this.applyCut(item, c.points, subtract);
    this.host.changed();
  }

  private applyCut(item: EdItem, points: Vec2[], subtract: boolean): void {
    const guide = item.formation?.guide;
    if (guide?.kind !== "solid") return;
    const s = this.session?.itemId === item.id ? this.session : null;
    // The guide as a solid, in its own frame: the working mesh, or its stack.
    let source;
    if (s) {
      try {
        source = manifoldOfMesh(s.mesh.toMesh());
      } catch (e) {
        this.host.notice(`Cut: the sculpt is not a closed solid (${(e as Error).message}); Remesh first.`);
        return;
      }
    } else {
      if (requestMeshes(guide.tree, () => this.host.changed())) {
        this.host.notice("Cut: the guide's meshes are still loading; cut again in a moment.");
        return;
      }
      const made = solidManifold(guide.tree, loadedMeshes());
      if (!made.solid) {
        this.host.notice(`Cut: the guide makes no solid (${made.error ?? "nothing"}).`);
        return;
      }
      source = made.solid;
    }
    let result: SolidMesh | null = null;
    try {
      const view = this.cutView(item, points, source.boundingBox());
      const cut = cutGuide(source, view, subtract);
      if (!cut.isEmpty()) result = meshOfManifold(cut);
      cut.delete();
    } finally {
      source.delete();
    }
    if (!result) {
      this.host.notice(`Cut: that ${subtract ? "cuts away all" : "keeps none"} of the guide; nothing changed.`);
      return;
    }
    if (s) {
      s.mesh.beginStep();
      s.mesh.replaceWith(result);
      this.pushStep(s.mesh.endStep());
      this.host.notice(`Cut ${subtract ? "away" : "to the polygon"}. Ctrl+Z undoes.`);
      return;
    }
    const { name } = storeMesh(result);
    this.host.formation.beginAction();
    item.formation = { ...item.formation!, guide: { kind: "solid", tree: meshLeafTree(name) } };
    this.host.formation.markDirty();
    this.host.formation.setSolidSel(null);
    this.host.notice(`Cut ${subtract ? "away" : "to the polygon"}: the guide is one mesh now. Ctrl+Z undoes.`);
  }

  // The camera's view of the polygon, for sculptCut.ts.
  private cutView(item: EdItem, points: Vec2[], box: { min: number[]; max: number[] }): CutView {
    const cam = this.host.camera();
    cam.updateMatrixWorld();
    const ortho = (cam as THREE.OrthographicCamera).isOrthographicCamera === true;
    const toCam = cam.matrixWorldInverse;
    const polygon = points.map((p) => {
      const n = this.host.ndc(p);
      const q = new THREE.Vector3(n.x, n.y, ortho ? -1 : 0.5).unproject(cam).applyMatrix4(toCam);
      return ortho ? ([q.x, q.y] as [number, number]) : ([q.x / -q.z, q.y / -q.z] as [number, number]);
    });
    const frame = this.host.frame(item);
    let near = Infinity;
    let far = -Infinity;
    for (let k = 0; k < 8; k++) {
      const c = new THREE.Vector3(k & 1 ? box.max[0] : box.min[0], k & 2 ? box.max[1] : box.min[1], k & 4 ? box.max[2] : box.min[2]);
      const depth = -c.applyMatrix4(frame).applyMatrix4(toCam).z;
      near = Math.min(near, depth);
      far = Math.max(far, depth);
    }
    const cameraToGuide = frame.clone().invert().multiply(cam.matrixWorld);
    return { kind: ortho ? "orthographic" : "perspective", polygon, cameraToGuide: cameraToGuide.elements, near, far };
  }

  // --- keys --------------------------------------------------------------------

  // A key in the editor. True when the mode took it.
  keydown(e: KeyboardEvent): boolean {
    const t = e.target;
    if ((t instanceof HTMLInputElement && t.type !== "checkbox" && t.type !== "radio") || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return false;
    if (this.adjust) {
      if (e.code === "Escape") {
        const a = this.adjust;
        if (a.kind === "radius") this.settings.radiusPx = a.before;
        else this.settings.strength = a.before;
        this.adjust = null;
        this.drawOverlay();
        this.dockRefresh();
      } else if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "KeyF") {
        this.adjust = null;
        this.saveSettings();
        this.drawOverlay();
      }
      return true;
    }
    if (this.cut) {
      if (e.code === "Escape") this.cancelCut();
      else if (e.code === "Enter" || e.code === "NumpadEnter") this.closeCut(e.altKey);
      else if (e.code === "Backspace") {
        this.cut.points.pop();
        this.drawOverlay();
      }
      // The view keys still move the view while the polygon is drawn.
      else return !isViewKey(e);
      return true;
    }
    if (!this.session) return false;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.code === "KeyZ") {
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (e.code === "KeyY") this.redo();
      else if (e.code === "KeyR") this.remesh();
      else if (e.code === "Tab") this.exit();
      return true;
    }
    if (e.code === "Escape" && !this.stroke) {
      this.exit();
      return true;
    }
    if (plain && !e.shiftKey && e.code === "KeyD") this.setTool("draw");
    else if (plain && !e.shiftKey && e.code === "KeyG") this.setTool("grab");
    else if (plain && !e.shiftKey && e.code === "KeyC") {
      const item = this.host.item(this.session.itemId);
      if (item) this.startCut(item);
    } else if (plain && e.code === "KeyF" && !e.repeat) {
      const at = this.hover ?? new Vec2(this.host.canvas.clientWidth / 2, this.host.canvas.clientHeight / 2);
      this.adjust = e.shiftKey
        ? { kind: "strength", start: at, before: this.settings.strength }
        : { kind: "radius", centre: new Vec2(at.x - this.settings.radiusPx, at.y), before: this.settings.radiusPx };
      this.cursor.visible = false;
      this.drawOverlay();
      this.host.notice(e.shiftKey ? "Strength: move the pointer sideways, click to set, Esc to keep" : "Radius: move the pointer, click to set, Esc to keep");
    } else if (isViewKey(e) || /^Digit[123]$/.test(e.code)) {
      // The view and the workspaces stay the editor's (a workspace left ends
      // the mode).
      return false;
    }
    // Everything else is held: the object tools (Delete, Tab, Shift+A, H, ...)
    // would act on the guide behind the mode's back.
    return true;
  }

  // A modifier pressed or let go: the cursor's colour follows at once.
  modifiers(e: KeyboardEvent): void {
    if (this.hover && this.session && !this.cut && !this.adjust) {
      this.placeCursor(this.hover, { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey } as MouseEvent);
    }
  }

  setTool(tool: SculptTool): void {
    this.settings.tool = tool;
    this.saveSettings();
    this.dockRefresh();
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // A browser that keeps nothing keeps the defaults.
    }
  }

  // --- drawing ------------------------------------------------------------------

  // The working mesh's arrays are the buffers' own: new buffers when they
  // grew, else the slots written since the last frame.
  private uploadAll(): void {
    const s = this.session!;
    const m = s.mesh;
    s.geometry.setAttribute("position", new THREE.BufferAttribute(m.pos, 3));
    s.geometry.setAttribute("normal", new THREE.BufferAttribute(m.nrm, 3));
    s.geometry.setIndex(new THREE.BufferAttribute(m.idx, 1));
    s.geometry.setDrawRange(0, m.tCount * 3);
    m.gpu.grown = false;
    m.gpu.v.clear();
    m.gpu.t.clear();
  }

  private upload(): void {
    const s = this.session!;
    const m = s.mesh;
    if (m.gpu.grown || s.geometry.getAttribute("position").array !== m.pos || s.geometry.getIndex()!.array !== m.idx) {
      s.geometry.dispose();
      const fresh = new THREE.BufferGeometry();
      s.object.geometry = fresh;
      s.geometry = fresh;
      this.uploadAll();
      return;
    }
    if (m.gpu.v.size) {
      const pos = s.geometry.getAttribute("position") as THREE.BufferAttribute;
      const nrm = s.geometry.getAttribute("normal") as THREE.BufferAttribute;
      for (const [start, count] of runs(m.gpu.v)) {
        pos.addUpdateRange(start * 3, count * 3);
        nrm.addUpdateRange(start * 3, count * 3);
      }
      pos.needsUpdate = true;
      nrm.needsUpdate = true;
      m.gpu.v.clear();
    }
    if (m.gpu.t.size) {
      const idx = s.geometry.getIndex()!;
      for (const [start, count] of runs(m.gpu.t)) idx.addUpdateRange(start * 3, count * 3);
      idx.needsUpdate = true;
      m.gpu.t.clear();
    }
    s.geometry.setDrawRange(0, m.tCount * 3);
  }

  // The cut's polygon and the radius ring, in CSS pixels over the canvas.
  private drawOverlay(): void {
    const r = this.host.canvas.getBoundingClientRect();
    const parent = this.host.overlayParent.getBoundingClientRect();
    this.svg.style.left = `${r.left - parent.left}px`;
    this.svg.style.top = `${r.top - parent.top}px`;
    this.svg.setAttribute("width", String(r.width));
    this.svg.setAttribute("height", String(r.height));
    let body = "";
    const c = this.cut;
    if (c) {
      const pts = [...c.points, ...(c.pointer ? [c.pointer] : [])];
      const simple = pts.length < 4 || polygonIsSimple(pts.map((p) => [p.x, p.y] as [number, number]));
      const colour = simple ? "#edc282" : "#ef7a6b";
      const path = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      body += `<polygon points="${path}" fill="${colour}" fill-opacity="0.12" stroke="${colour}" stroke-width="1.5" stroke-dasharray="${c.pointer ? "" : "4 3"}"/>`;
      for (const [i, p] of c.points.entries()) {
        const near = i === 0 && c.pointer && c.points.length >= 3 && c.pointer.distanceTo(p) <= CLOSE_PX;
        body += `<circle cx="${p.x}" cy="${p.y}" r="${near ? 5 : 3}" fill="${i === 0 ? colour : "#1f2430"}" stroke="${colour}" stroke-width="1.5"/>`;
      }
    }
    const a = this.adjust;
    if (a?.kind === "radius") {
      body += `<circle cx="${a.centre.x}" cy="${a.centre.y}" r="${this.settings.radiusPx}" fill="none" stroke="#ffffff" stroke-width="1.5"/>`;
      body += `<circle cx="${a.centre.x}" cy="${a.centre.y}" r="${a.before}" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-dasharray="3 3"/>`;
      body += `<text x="${a.centre.x}" y="${a.centre.y}" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${Math.round(this.settings.radiusPx)} px</text>`;
    }
    this.svg.innerHTML = body;
  }

  // --- the dock -------------------------------------------------------------------

  private buildDock(): HTMLElement {
    const { el, button, checkbox, toolGroup } = this.host.ui;
    // Its children are the dock's grid cells (`display: contents`, shown only
    // while sculpting: studio.css).
    const dock = el("div", "ed-sculpt-dock");
    const seg = el("div", "ed-seg ed-ws-wide");
    const tools = new Map<SculptTool, HTMLButtonElement>();
    for (const [tool, label, tip] of [
      ["draw", "Draw", "Draw (D): build the surface up under the brush; Ctrl digs in, Shift smooths"],
      ["grab", "Grab", "Grab (G): pull the surface under the brush with the pointer; Ctrl or Shift smooths"],
    ] as const) {
      const b = button(label, () => this.setTool(tool));
      b.title = tip;
      tools.set(tool, b);
      seg.appendChild(b);
    }
    const cutBtn = button("Cut", () => {
      const item = this.session ? this.host.item(this.session.itemId) : undefined;
      if (item) this.startCut(item);
    });
    cutBtn.title = "Cut (C): draw a polygon; only what is inside it as seen now is kept (Alt when closing cuts it away)";
    seg.appendChild(cutBtn);
    const number = (label: string, tip: string, get: () => number, set: (v: number) => void, step: number): { wrap: HTMLElement; input: HTMLInputElement } => {
      const wrap = el("label", "ed-inline ed-ws-wide");
      wrap.title = tip;
      wrap.appendChild(document.createTextNode(label));
      const input = document.createElement("input");
      input.type = "number";
      input.className = "ed-num";
      input.step = String(step);
      input.addEventListener("change", () => {
        const v = parseFloat(input.value);
        if (Number.isFinite(v)) {
          set(v);
          this.saveSettings();
        }
        input.value = String(round(get()));
      });
      wrap.appendChild(input);
      return { wrap, input };
    };
    const radius = number("Radius px", "The brush's radius on screen (F, then move the pointer)", () => this.settings.radiusPx, (v) => (this.settings.radiusPx = Math.max(2, Math.min(1500, v))), 5);
    const strength = number("Strength", "How strongly each dab moves the surface, 0 to 1 (Shift+F)", () => this.settings.strength, (v) => (this.settings.strength = Math.max(0, Math.min(1, v))), 0.05);
    const dyn = checkbox("Dyntopo", this.settings.dyntopo, (v) => {
      this.settings.dyntopo = v;
      this.saveSettings();
    });
    dyn.title = "Dynamic topology: the mesh is split and collapsed under the brush to the detail size, so detail is built where it is drawn";
    const detail = number("Detail cm", "Dyntopo's edge length and Remesh's cell, centimetres", () => this.settings.detail * 100, (v) => (this.settings.detail = Math.max(0.2, Math.min(50, v)) / 100), 0.5);
    const remesh = button("Remesh", () => this.remesh());
    remesh.title = "Rebuild the whole mesh at the detail size (Ctrl+R): repairs a guide folded through itself";
    const done = button("Done", () => this.exit());
    done.classList.add("ed-ws-wide");
    done.title = "Leave Sculpt (Esc): the sculpt is saved to the guide";
    const hint = el("div", "ed-hint ed-ws-hint");
    hint.textContent = "F radius · Shift+F strength · Ctrl+Z undoes a stroke · Esc leaves";
    dock.append(toolGroup("Sculpt"), seg, radius.wrap, strength.wrap, detail.wrap, dyn, remesh, done, hint);
    this.dockRefresh = () => {
      for (const [tool, b] of tools) {
        b.classList.toggle("active", this.settings.tool === tool);
        b.setAttribute("aria-pressed", String(this.settings.tool === tool));
      }
      cutBtn.classList.toggle("active", this.cut !== null);
      if (document.activeElement !== radius.input) radius.input.value = String(round(this.settings.radiusPx));
      if (document.activeElement !== strength.input) strength.input.value = String(round(this.settings.strength));
      if (document.activeElement !== detail.input) detail.input.value = String(round(this.settings.detail * 100));
      (dyn.querySelector("input") as HTMLInputElement).checked = this.settings.dyntopo;
    };
    this.dockRefresh();
    return dock;
  }

  // Called when the dock is shown, so it says the settings as they are.
  refreshDock(): void {
    this.dockRefresh();
  }
}

interface Hit {
  local: number[];
  world: THREE.Vector3;
  normal: THREE.Vector3;
  r: number;
  tri: number;
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

function isViewKey(e: KeyboardEvent): boolean {
  return e.code.startsWith("Numpad") || e.code === "Home";
}

// Sorted slots as runs of consecutive ones, gaps under 64 slots bridged (an
// upload of a few spare slots is cheaper than another range).
function runs(slots: Set<number>): [number, number][] {
  const sorted = [...slots].sort((a, b) => a - b);
  const out: [number, number][] = [];
  let start = sorted[0]!;
  let end = start;
  for (const v of sorted.slice(1)) {
    if (v - end <= 64) end = v;
    else {
      out.push([start, end - start + 1]);
      start = end = v;
    }
  }
  if (sorted.length) out.push([start, end - start + 1]);
  return out;
}

// The guide's colour, mostly grey: a sculpt reads by its shading, and the
// colour only says whose it is.
function tint(color: number): THREE.Color {
  return new THREE.Color(0xd8d8d8).lerp(new THREE.Color(color), 0.3);
}

// A matcap: a lit clay sphere, light from the upper left and a soft rim, so
// the form reads the same from every angle without the scene's lights (the
// sculpt is drawn opaque and lit this way, as Blender draws sculpt mode).
function makeMatcap(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const img = g.createImageData(size, size);
  const light = new THREE.Vector3(-0.45, 0.6, 0.66).normalize();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / (size / 2) - 1;
      const ny = 1 - (y + 0.5) / (size / 2);
      const r2 = nx * nx + ny * ny;
      const i = (y * size + x) * 4;
      if (r2 > 1) {
        img.data[i + 3] = 255;
        continue;
      }
      const nz = Math.sqrt(1 - r2);
      // Wrapped diffuse, so a face turned from the light is shaded, not
      // black: every side of a form reads.
      const diffuse = Math.max(0, (nx * light.x + ny * light.y + nz * light.z + 0.4) / 1.4);
      const half = new THREE.Vector3(light.x, light.y, light.z + 1).normalize();
      const spec = Math.max(0, nx * half.x + ny * half.y + nz * half.z) ** 40;
      const rim = (1 - nz) ** 3;
      const v = Math.min(1, 0.22 + 0.62 * diffuse + 0.14 * spec + 0.1 * rim);
      const c = Math.round(255 * v);
      img.data[i] = c;
      img.data[i + 1] = c;
      img.data[i + 2] = Math.round(c * 0.97);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
