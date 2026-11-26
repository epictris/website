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
  itemBounds,
  type EdItem,
  type EdModel,
} from "../model";
import { Guides, guidePlaneZ, type GuideDraft, type GuideView } from "./guides";
import { isGuideTag, type GuideTag } from "./tags";
import { dolly, fly, frame, headOn, orbit, pan, refocus, type Ndc } from "./viewControls";
import { poseEye, upsideDown, withLens, type Vec3 } from "./viewPose";
import { atRest, type NdofAxes } from "../ndof";

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

// THE SPACEMOUSE'S FLY (editor/ndof.ts), all at full deflection of the cap and
// linear below it, as Blender's NDOF is. Feel knobs, unplayed.
//
// Flying speed, metres per second: the same everywhere, whatever is near
// (Tris, 2026-11-25: the speed scaled by the distance to the surface ahead was
// removed).
export const FLY_SPEED_M_PER_S = 8;
// Turning, radians per second: a quarter turn a second.
export const FLY_TURN_RAD_PER_S = Math.PI / 2;
// The 2D and Ortho views' zoom, natural log of the view's size per second: a
// full push halves or doubles the view in about 0.7 s. Their pan is screen
// relative (a view height a second), since a fixed speed in metres is a
// crawl zoomed out and a blur zoomed in on a plan.
export const FLY_ZOOM_PER_S = 1;


// The parts of `Scene3D` the workspace drives. A type rather than the class so
// `cli render3d` can hand it a scene with no WebGL behind it.
export type WorkspaceScene = Pick<Scene3D, "editorLayer" | "camera" | "setViewPose" | "pick" | "pickSurface" | "drawnSurfaceAt">;

export interface WorkspaceHost {
  readonly scene: WorkspaceScene;
  // The Level workspace's camera: what the pose is seeded from, and the
  // viewport the scene is drawn into (the canvas, in CSS pixels).
  camera2d(): Camera;
  // The lens the view is navigated through: the level's depth (`zOffset`) and
  // the editor's own field of view (`EDITOR_FOV_Y_DEG`).
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

// Everything a draft draws from, hashed: equal hashes draw the same (up to a
// 32-bit collision, which costs one frame showing the previous draft). Asked
// every frame a draft is up, so it allocates nothing: each coordinate's bits
// are mixed in through one shared scratch word, where the string it replaced
// made a few hundred bytes per frame for a pointer standing still.
const hashWord = new Float64Array(1);
const hashBits = new Uint32Array(hashWord.buffer);
function mix(h: number, x: number): number {
  hashWord[0] = x;
  h = Math.imul(h ^ hashBits[0]!, 0x9e3779b1);
  return Math.imul(h ^ hashBits[1]!, 0x85ebca6b) ^ (h >>> 15);
}
function mixPoint(h: number, v: Vec3 | null | undefined): number {
  return v ? mix(mix(mix(h, v.x), v.y), v.z) : mix(h, Number.NaN);
}
export function draftSignature(d: GuideDraft | null): number {
  if (!d) return 0;
  let h = mix(0x2545f491, (d.closed ? 1 : 0) + (d.crossed ? 2 : 0) + d.points.length * 4);
  for (let i = 0; i < d.points.length; i++) h = mixPoint(h, d.points[i]);
  return mixPoint(h, d.cursor) | 0;
}

// A box in three's frame (y up), metres.
export interface Box3 {
  min: Vec3;
  max: Vec3;
}

// The box `items` occupy, three's frame: each item's world bounds on the plane,
// at the depth it is drawn at (`guidePlaneZ`). A light is its source, not its
// reach, as a click on it is.
export function itemsBox(items: readonly EdItem[]): Box3 | null {
  if (!items.length) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const it of items) {
    const b = it.object === "light" ? { min: it.pos, max: it.pos } : itemBounds(it);
    const z = guidePlaneZ(it);
    min.x = Math.min(min.x, b.min.x);
    max.x = Math.max(max.x, b.max.x);
    // Sim y is down: the sim box's max is three's min.
    min.y = Math.min(min.y, threeY(b.max.y));
    max.y = Math.max(max.y, threeY(b.min.y));
    min.z = Math.min(min.z, z);
    max.z = Math.max(max.z, z);
  }
  return { min, max };
}

// The whole level's box: everything on the scene layer, and the spawn. Not the
// camera regions, which blanket the level with room to spare and would frame
// it small.
export function levelBox(model: EdModel): Box3 {
  const p = { x: model.player.pos.x, y: threeY(model.player.pos.y), z: 0 };
  const box = itemsBox(model.items.filter((i) => i.layer === "scene")) ?? { min: { ...p }, max: { ...p } };
  return {
    min: { x: Math.min(box.min.x, p.x), y: Math.min(box.min.y, p.y), z: Math.min(box.min.z, p.z) },
    max: { x: Math.max(box.max.x, p.x), y: Math.max(box.max.y, p.y), z: Math.max(box.max.z, p.z) },
  };
}

export class VisualsWorkspace {
  readonly guides = new Guides();
  private pose: ViewPose | null = null;
  private on = false;
  private gesture: { kind: ViewGesture; last: Vec2 } | null = null;
  private draftSig = draftSignature(null);
  // The draft last handed over, by identity: a tool that keeps its draft
  // object while nothing changed costs nothing at all.
  private draftRef: GuideDraft | null = null;
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
  // Whether the guides are drawn into the scene. The editor's one 3D view
  // draws its overlay projected through the pose instead (projectedCanvas.ts),
  // so it uses the workspace for its camera alone.
  showGuides = true;

  enter(): void {
    if (this.on) return;
    this.on = true;
    this.pose ??= headOn(this.host.camera2d(), this.host.lens());
    if (this.showGuides) this.host.scene.editorLayer.add(this.guides.group);
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
    this.draftRef = null;
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
    if (this.showGuides) this.host.scene.editorLayer.add(this.guides.group);
    this.apply();
  }

  // Head on, framed as the 2D camera frames the plane: `Home` and `⟲ Reset
  // view`.
  resetView(): void {
    this.pose = headOn(this.host.camera2d(), this.host.lens());
    this.apply();
  }

  // Take up a pose from elsewhere - the address bar's, after a reload (see
  // editor/viewUrl.ts). Drawn at once while the workspace is active, and
  // otherwise the pose `enter` starts from in place of the head-on one.
  setView(pose: ViewPose): void {
    this.pose = pose;
    this.apply();
  }

  // Frame a box (three's frame) from the current direction: **F**.
  frameBox(box: Box3): void {
    if (!this.pose) return;
    this.pose = frame(this.navigable(this.pose), box, this.aspect());
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
    if (draft === this.draftRef) return;
    this.draftRef = draft;
    const sig = draftSignature(draft);
    if (sig === this.draftSig) return;
    this.draftSig = sig;
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
      this.pose = orbit(this.navigable(this.pose), -d.x * ORBIT_RADIANS_PER_PX, d.y * ORBIT_RADIANS_PER_PX);
    } else {
      this.pose = pan(this.navigable(this.pose), this.aspect(), this.ndc(g.last), this.ndc(scr));
    }
    g.last = scr;
    this.apply();
  }

  endView(): void {
    this.gesture = null;
  }

  // The wheel: a dolly toward what is under the pointer - the nearest DRAWN
  // surface (`Scene3D.drawnSurfaceAt`), else the point of the pointer's ray at
  // the target's depth - so the point aimed at stays under the pointer and the
  // eye never passes it.
  //
  // Never the gameplay plane: it is not drawn, so over open water or a gap
  // the eye homed in on a wall nobody can see - the plane's notes growing
  // huge while the scene behind them barely moved, and no way through.
  wheel(scr: Vec2, deltaY: number): void {
    if (!this.pose) return;
    const n = this.ndc(scr);
    const scene = this.host.scene;
    let toward: Vec3 | null = scene.drawnSurfaceAt(n.x, n.y);
    if (!toward) {
      const cam = scene.camera;
      const forward = cam.getWorldDirection(this.forward);
      const t = this.pose.target;
      this.depthPlane.setFromNormalAndCoplanarPoint(forward, this.targetPoint.set(t.x, t.y, t.z));
      this.raycaster.setFromCamera(this.ndcPoint.set(n.x, n.y), cam);
      toward = this.raycaster.ray.intersectPlane(this.depthPlane, this.towardPoint);
    }
    this.pose = dolly(this.navigable(this.pose), toward, Math.exp(deltaY * DOLLY_PER_WHEEL));
    this.apply();
  }

  // One frame of the SpaceMouse (`dt` seconds): the camera flies in its own
  // frame and turns about itself (`fly`), at a fixed speed. False when nothing
  // moved.
  //
  // - Free 3D, perspective: push/pull and slide move the eye, tilt and twist
  //   turn it (roll is not a thing a level view has). When the cap comes to
  //   rest the target is put on the surface in the middle of the view
  //   (`refocus`, one ray), so the mouse's orbit afterwards pivots on what
  //   was being looked at.
  // - Orthographic: there is no depth to fly through, so push/pull zooms
  //   about the target and the slide pans.
  ndof(axes: NdofAxes, dt: number, orthographic: boolean): boolean {
    if (!this.pose) return false;
    const flat = orthographic;
    if (atRest(axes)) {
      if (!this.flown) return false;
      this.flown = false;
      if (flat) return false;
      const hit = this.host.scene.drawnSurfaceAt(0, 0);
      if (!hit) return false;
      const eye = poseEye(this.pose);
      this.pose = refocus(this.pose, Math.hypot(hit.x - eye.x, hit.y - eye.y, hit.z - eye.z));
      this.apply();
      return true;
    }
    this.flown = true;
    let pose = this.navigable(this.pose);
    const { t, r } = axes;
    // Both turns are the cap moving the SCENE rather than the camera (Tris,
    // 2026-11-25: the camera-like senses read inverted): tilting the cap's
    // top back toward the person (r.x > 0) tips the view down, a positive pose
    // pitch, and twisting it anticlockwise seen from above (r.y > 0) turns the
    // view right, a negative yaw.
    const tilt = r.x;
    const twist = -r.y;
    if (flat) {
      pose = dolly(pose, null, Math.exp(t.z * FLY_ZOOM_PER_S * dt));
      // A view height a second at full deflection: NDC spans 2 per height.
      pose = pan(pose, this.aspect(), { x: 0, y: 0 }, {
        x: (-t.x * 2 * dt) / this.aspect(),
        y: -t.y * 2 * dt,
      });
      // Over the poles as the fly goes, the twist as seen on screen (`fly`).
      const onScreen = upsideDown(pose.pitch) ? -twist : twist;
      pose = orbit(pose, onScreen * FLY_TURN_RAD_PER_S * dt, tilt * FLY_TURN_RAD_PER_S * dt, true);
    } else {
      const step = FLY_SPEED_M_PER_S * dt;
      const turn = FLY_TURN_RAD_PER_S * dt;
      pose = fly(pose, { x: t.x * step, y: t.y * step, z: t.z * step }, twist * turn, tilt * turn);
    }
    this.pose = pose;
    this.apply();
    return true;
  }
  // Whether the cap has moved the view since it was last at rest: the rest
  // after a flight refocuses once.
  private flown = false;

  // The pose a gesture starts from: the one on screen, seen through the
  // navigation lens (`WorkspaceHost.lens`) from where it stands. A view set
  // through another lens - the Game camera's, the level's own - keeps it
  // until it is moved, and the first move widens it about the eye rather than
  // jumping the eye.
  private navigable(pose: ViewPose): ViewPose {
    return withLens(pose, this.host.lens().fovYDeg);
  }

  private readonly raycaster = new THREE.Raycaster();
  private readonly depthPlane = new THREE.Plane();
  private readonly forward = new THREE.Vector3();
  private readonly targetPoint = new THREE.Vector3();
  private readonly towardPoint = new THREE.Vector3();
  private readonly ndcPoint = new THREE.Vector2();

  private aspect(): number {
    const c = this.host.camera2d();
    return c.viewportWidth / c.viewportHeight;
  }
}
