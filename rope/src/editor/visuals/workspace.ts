// THE VISUALS WORKSPACE's controller: the free camera it is looked through,
// the guides it draws into the scene, and the pointer gestures that navigate
// it (plans/visuals-workspace.md, "The workspace").
//
// The editor stays one editor: the model, undo, the selection, the layers, the
// tools and the inspector are `editor.ts`'s and are shared by both workspaces.
// What changes in this one is how the VIEW is driven - a `ViewPose` of its
// own, orbited, panned and dollied Blender's way, instead of the 2D camera -
// and so where a screen position lands, which is always through the camera the
// pose places rather than through the 2D camera's scale and offset. This file
// owns exactly that: the pose, the guides that stand in for the 2D overlay, and
// the few questions the editor asks about the pointer (where it meets a plane,
// what is under it, where a world point is on screen). Every gesture's
// arithmetic is in `viewControls.ts`; this is the wiring.
//
// Nothing here writes the model. The editor's press handler decides what a
// click means and writes it through `markDirty`, as it does head on.

import * as THREE from "three";
import { Vec2 } from "../../engine/vec2";
import type { Camera } from "../../render/camera";
import type { Scene3D } from "../../render3d/scene";
import {
  applyPose,
  threeY,
  unprojectToPlane,
  type SceneLens,
  type ViewPose,
} from "../../render3d/space";
import {
  collidingBodyIds,
  itemBounds,
  type EdItem,
  type EdModel,
} from "../model";
import { Guides, guidePlaneZ, type GuideDraft, type GuideView } from "./guides";
import { isGuideTag, type GuideTag } from "./tags";
import { dolly, frame, headOn, orbit, pan, type Ndc } from "./viewControls";
import type { Vec3 } from "./viewPose";

// Orbit sensitivity, radians per screen pixel, for both workspaces' orbit: a
// drag across a 1600 px window is a bit over a half turn, which is enough to
// see round a prop without a level swinging past under a nudge. One constant,
// so a turn feels the same whichever workspace it is made in.
export const ORBIT_RADIANS_PER_PX = 0.006;
// How far one unit of wheel delta dollies, as a natural log of the distance
// (dimensionless per wheel unit): the rate the Level workspace's wheel zooms
// at (`exp(-deltaY * 0.001)`), so a notch of the wheel is the same step in
// either workspace.
export const DOLLY_PER_WHEEL = 0.001;

// The mesh `+ Geometry` places in this workspace until one is chosen: a stock
// rock from the always-present `rocks.glb`, so the first click draws something
// rather than an empty holder (see `VisualsWorkspace.propMesh`).
export const DEFAULT_PROP_MESH = "rock-1";
// The size of the rect a placed prop is given, metres: the footprint the
// accepted rock props are authored at (a mesh draws at its own size; the rect
// is what its collision twin would be matched to and what the 2D view draws).
export const PROP_FOOTPRINT = 0.3;

// The parts of `Scene3D` the workspace drives. A type rather than the class so
// `cli render3d` can hand it a scene with no WebGL behind it.
export type WorkspaceScene = Pick<Scene3D, "editorLayer" | "camera" | "setViewPose" | "pick" | "pickSurface">;

export interface WorkspaceHost {
  readonly scene: WorkspaceScene;
  // The Level workspace's camera: what the pose is seeded from, and the
  // viewport the scene is drawn into (the canvas, in CSS pixels).
  camera2d(): Camera;
  // The level's lens (`lensOf(model.camera)`), which the head-on pose is framed
  // through.
  lens(): SceneLens;
  // The canvas's size in CSS pixels, for turning a pointer into NDC.
  canvasSize(): { width: number; height: number };
}

// Which navigation gesture the pointer is making: middle drag orbits, Shift +
// middle or the right button pans.
export type ViewGesture = "orbit" | "pan";

// Which guide a click means, from everything `Scene3D.pick` returned under the
// pointer, nearest first: a corner handle, else an edge's midpoint handle, else
// nothing (the click is about items, which the editor resolves by its own pick
// order). A handle anywhere in the list wins, not only a nearest one: the
// guides are drawn with the depth test off, so a handle is ON TOP wherever it
// is along the ray, and at a corner its outline's segments come back at the
// very same depth - a tie a nearest-first rule would settle by build order.
export function handleUnder(tags: readonly unknown[]): GuideTag | null {
  let mid: GuideTag | null = null;
  for (const t of tags) {
    if (!isGuideTag(t)) continue;
    if (t.guide === "vertex") return t;
    if (t.guide === "midpoint" && !mid) mid = t;
  }
  return mid;
}

// The item ids a click lands on through the guides it hit: an outline, a
// light's icon, a region, a path, a note. The spawn and the handles are the
// editor's own questions (`handleUnder`, `spawnUnder`).
export function itemsUnder(tags: readonly unknown[], into: Set<number>): Set<number> {
  for (const t of tags) {
    if (!isGuideTag(t)) continue;
    if (t.guide === "vertex" || t.guide === "midpoint" || t.guide === "spawn") continue;
    into.add(t.id);
  }
  return into;
}

export function spawnUnder(tags: readonly unknown[]): boolean {
  return tags.some((t) => isGuideTag(t) && t.guide === "spawn");
}

// Everything a draft draws from, as a string: equal strings draw the same.
function draftSignature(d: GuideDraft | null): string {
  if (!d) return "-";
  const p = (v: Vec3 | null | undefined): string => (v ? `${v.x},${v.y},${v.z}` : "~");
  return `${d.closed ? 1 : 0}${d.crossed ? 1 : 0}|${d.points.map(p).join(";")}|${p(d.cursor)}`;
}

// A box in three's frame (y up), metres.
export interface Box3 {
  min: Vec3;
  max: Vec3;
}

// The box `items` occupy, three's frame: each item's world bounds on the plane,
// at the depth it is drawn at (`guidePlaneZ`), a drawn object's extrusion depth
// either side of it. A light is its source, not its reach, as a click on it is.
export function itemsBox(model: EdModel, items: readonly EdItem[]): Box3 | null {
  if (!items.length) return null;
  const colliding = collidingBodyIds(model.items);
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const it of items) {
    const b = it.object === "light" ? { min: it.pos, max: it.pos } : itemBounds(it);
    const z = guidePlaneZ(it, colliding.has(it.bodyId));
    const half = it.object === "geometry" ? (it.visual.depth ?? it.thickness) / 2 : 0;
    min.x = Math.min(min.x, b.min.x);
    max.x = Math.max(max.x, b.max.x);
    // Sim y is down: the sim box's max is three's min.
    min.y = Math.min(min.y, threeY(b.max.y));
    max.y = Math.max(max.y, threeY(b.min.y));
    min.z = Math.min(min.z, z - half);
    max.z = Math.max(max.z, z + half);
  }
  return { min, max };
}

// The whole level's box: everything on the scene layer, and the spawn. Not the
// camera regions, which blanket the level with room to spare and would frame
// it small.
export function levelBox(model: EdModel): Box3 {
  const p = { x: model.player.pos.x, y: threeY(model.player.pos.y), z: 0 };
  const box = itemsBox(model, model.items.filter((i) => i.layer === "scene")) ?? { min: { ...p }, max: { ...p } };
  return {
    min: { x: Math.min(box.min.x, p.x), y: Math.min(box.min.y, p.y), z: Math.min(box.min.z, p.z) },
    max: { x: Math.max(box.max.x, p.x), y: Math.max(box.max.y, p.y), z: Math.max(box.max.z, p.z) },
  };
}

export class VisualsWorkspace {
  readonly guides = new Guides();
  // The mesh `+ Geometry` places here: the last one the author chose or placed
  // (the editor tells it), so dressing a ledge with ten of the same rock is ten
  // clicks rather than ten trips to the inspector.
  propMesh = DEFAULT_PROP_MESH;
  private pose: ViewPose | null = null;
  private on = false;
  private gesture: { kind: ViewGesture; last: Vec2 } | null = null;
  private draftSig = draftSignature(null);
  private draftFill: Float32Array | null = null;
  private readonly project3 = new THREE.Vector3();

  constructor(private readonly host: WorkspaceHost) {}

  get active(): boolean {
    return this.on;
  }

  // The pose the view is drawn through, or null before the workspace has ever
  // been entered.
  get view(): ViewPose | null {
    return this.pose;
  }

  // Whether the view is anything but head-on - what lights `⟲ Reset view`.
  get turned(): boolean {
    return this.pose !== null && (this.pose.yaw !== 0 || this.pose.pitch !== 0);
  }

  // Into the workspace. The first time, the pose is the Level workspace's view
  // exactly (`headOn`, to the bit), so switching changes how the view is driven
  // and not what is on screen; every later time it is the pose left behind,
  // since each workspace keeps its own view.
  enter(): void {
    if (this.on) return;
    this.on = true;
    this.pose ??= headOn(this.host.camera2d(), this.host.lens());
    this.host.scene.editorLayer.add(this.guides.group);
    this.apply();
  }

  // Out of it: the scene is handed back to the 2D camera and the guides leave
  // the scene. Removed rather than hidden, because a raycast does not skip an
  // invisible object and the Level workspace's pick must not meet them.
  leave(): void {
    if (!this.on) return;
    this.on = false;
    this.gesture = null;
    this.guides.setDraft(null);
    this.draftSig = draftSignature(null);
    this.draftFill = null;
    this.guides.group.removeFromParent();
    this.host.scene.setViewPose(null);
  }

  // Set aside for a `▶ Test` and taken up again after it, with the workspace
  // still the one that is active: a test is played through the player's
  // camera with nothing of the editor's drawn over it.
  suspend(): void {
    if (!this.on) return;
    this.gesture = null;
    this.guides.group.removeFromParent();
    this.host.scene.setViewPose(null);
  }

  resume(): void {
    if (!this.on) return;
    this.host.scene.editorLayer.add(this.guides.group);
    this.apply();
  }

  // Head on, framed as the 2D camera frames the plane: `Home` and `⟲ Reset
  // view`.
  resetView(): void {
    this.pose = headOn(this.host.camera2d(), this.host.lens());
    this.apply();
  }

  // Frame a box (three's frame) from the current direction: **F**.
  frameBox(box: Box3): void {
    if (!this.pose) return;
    this.pose = frame(this.pose, box, this.aspect());
    this.apply();
  }

  // Hand the pose to the scene for the next frame, and place its camera now:
  // a pick made between a gesture and the next frame is then answered by the
  // view the gesture left rather than the one before it. Per frame too, since
  // the canvas (and so the aspect) can change under a pose that did not.
  apply(): void {
    if (!this.on || !this.pose) return;
    const scene = this.host.scene;
    scene.setViewPose(this.pose);
    applyPose(scene.camera, this.pose, this.aspect());
    scene.camera.updateMatrixWorld();
  }

  // Rebuild the guides if the model, the selection or the layers moved (cheap
  // when nothing did), and draw a tool's draft.
  sync(view: GuideView, draft: GuideDraft | null): void {
    this.guides.sync(view);
    // A draft is rebuilt only when it changed (a click, a pointer move): it is
    // fresh geometry every time (see `DraftView.set`), which a frame loop must
    // not make sixty times a second for a pointer that is standing still.
    // A surface soup is compared by identity: the tool that collects one makes
    // a new array when it collects again.
    const sig = draftSignature(draft);
    const fill = draft?.fill ?? null;
    if (sig === this.draftSig && fill === this.draftFill) return;
    this.draftSig = sig;
    this.draftFill = fill;
    this.guides.setDraft(draft);
  }

  // --- the pointer ---------------------------------------------------------

  // A canvas position (CSS pixels) as normalised device coordinates, x right
  // and y up, which is what `Scene3D.pick` and `unprojectToPlane` take.
  ndc(scr: Vec2): Ndc {
    const { width, height } = this.host.canvasSize();
    return { x: (scr.x / (width || 1)) * 2 - 1, y: 1 - (scr.y / (height || 1)) * 2 };
  }

  // Where the pointer meets the plane `z` metres off the gameplay plane, in
  // the sim's world metres (y down), or null where the ray never reaches it.
  planePoint(scr: Vec2, z = 0): Vec2 | null {
    const n = this.ndc(scr);
    return unprojectToPlane(this.host.scene.camera, n.x, n.y, z);
  }

  // Where a world point (sim frame, `z` toward the camera) is on the canvas, in
  // CSS pixels, or null behind the camera.
  screenOf(world: Vec2, z = 0): Vec2 | null {
    const p = this.project3.set(world.x, threeY(world.y), z).project(this.host.scene.camera);
    if (p.z > 1) return null;
    const { width, height } = this.host.canvasSize();
    return new Vec2(((p.x + 1) / 2) * width, ((1 - p.y) / 2) * height);
  }

  // Everything under the pointer, models and guides, nearest first.
  tagsAt(scr: Vec2): unknown[] {
    const n = this.ndc(scr);
    return this.host.scene.pick(n.x, n.y);
  }

  // The nearest drawn surface under the pointer whose tag `accept` takes, with
  // its world point and normal in three's frame.
  surfaceAt(scr: Vec2, accept: (tag: unknown) => boolean): { tag: unknown; point: Vec3; normal: Vec3 } | null {
    const n = this.ndc(scr);
    const hit = this.host.scene.pickSurface(n.x, n.y, (t) => !isGuideTag(t) && accept(t));
    return hit ? { tag: hit.tag, point: hit.point, normal: hit.normal } : null;
  }

  // --- navigation ----------------------------------------------------------

  beginView(kind: ViewGesture, scr: Vec2): void {
    this.gesture = { kind, last: scr };
  }

  // One pointer move of the gesture begun by `beginView`.
  moveView(scr: Vec2): void {
    const g = this.gesture;
    if (!g || !this.pose) return;
    if (g.kind === "orbit") {
      // The pointer drags the SCENE, as the Level workspace's orbit reads: a
      // drag right swings the level right (the camera left), a drag down tips
      // its far side down and the camera rises to look at it.
      const d = scr.sub(g.last);
      this.pose = orbit(this.pose, -d.x * ORBIT_RADIANS_PER_PX, d.y * ORBIT_RADIANS_PER_PX);
    } else {
      this.pose = pan(this.pose, this.aspect(), this.ndc(g.last), this.ndc(scr));
    }
    g.last = scr;
    this.apply();
  }

  endView(): void {
    this.gesture = null;
  }

  // The wheel: a dolly toward what is under the pointer - the nearest model
  // surface, else the gameplay plane, else straight along the view - so the
  // point aimed at stays under the pointer and the eye never passes it.
  wheel(scr: Vec2, deltaY: number): void {
    if (!this.pose) return;
    const hit = this.surfaceAt(scr, () => true);
    let toward: Vec3 | null = hit?.point ?? null;
    if (!toward) {
      const p = this.planePoint(scr);
      toward = p ? { x: p.x, y: threeY(p.y), z: 0 } : null;
    }
    this.pose = dolly(this.pose, toward, Math.exp(deltaY * DOLLY_PER_WHEEL));
    this.apply();
  }

  private aspect(): number {
    const c = this.host.camera2d();
    return c.viewportWidth / c.viewportHeight;
  }
}
