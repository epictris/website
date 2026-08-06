// The editor's 3D transform gizmo: the red/green/blue arrows, rings and boxes
// that move, turn and size an object in the scene rather than on the plane.
//
// It exists because the overlay cannot answer the questions a prop asks. The 2D
// canvas is the gameplay plane seen head on, so it has handles for the two axes
// that lie in it and no way at all to say "10 cm toward the camera", "tipped 15°
// about x", or "a bit bigger" about a mesh whose outline is not what is drawn.
// Those are exactly the fields a level dresses itself with (`EdVisual.offsetZ`,
// `rotX`, `rotY`, `scale`), and until now every one of them was a number typed
// into the inspector and checked by looking.
//
// It is also the only thing that still works while the view is ORBITED (see
// `CameraOrbit`), which is the view those fields are judged in: the gizmo is in
// the scene, so it is drawn from wherever the camera is, and the overlay's being
// switched off costs nothing here.
//
// THE GIZMO NEVER TOUCHES THE MODEL. It moves a proxy object, and the editor
// reads that proxy and writes the model - which is what makes it survive the
// scene being rebuilt from scratch on every model revision (every drag): a
// handle attached to a visual would be attached to an object that is disposed a
// frame later, and re-attaching per frame is a gesture that cannot survive its
// own effect.

import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

export type GizmoMode = "translate" | "rotate" | "scale";
export const GIZMO_MODES: readonly GizmoMode[] = ["translate", "rotate", "scale"];

// Which handles this target offers in this mode. `null` is "this mode means
// nothing here" - a collision shape has nowhere to put a rotation about x, and a
// light has no size - and the gizmo then shows nothing rather than offering a
// handle whose effect the file cannot record.
export type GizmoAxes = { x: boolean; y: boolean; z: boolean } | null;

export interface GizmoHandlers {
  // Where the target is now, in three's frame. Read every frame the gizmo is not
  // being dragged, so the handles follow an inspector edit or a 2D drag.
  pose(): { pos: THREE.Vector3; quat: THREE.Quaternion };
  axes(mode: GizmoMode): GizmoAxes;
  // A drag is one undo step, so this is where the snapshot is taken.
  begin(mode: GizmoMode): void;
  // The proxy's transform, live. `scale` is the factor since the drag started -
  // it is reset to 1 between drags - because the model stores sizes rather than
  // a scale, and a factor against what the size was when the drag began is the
  // one reading that cannot drift as those sizes are rewritten mid-drag.
  apply(
    mode: GizmoMode,
    pos: THREE.Vector3,
    quat: THREE.Quaternion,
    scale: THREE.Vector3,
  ): void;
  end(mode: GizmoMode): void;
}

export class EditorGizmo {
  private readonly controls: TransformControls;
  // What the handles are actually attached to. It is in the scene so its world
  // matrix is kept up to date like anything else; it draws nothing.
  private readonly proxy = new THREE.Object3D();
  private handlers: GizmoHandlers | null = null;
  private currentMode: GizmoMode = "translate";

  constructor(
    private readonly scene: THREE.Scene,
    camera: THREE.Camera,
    dom: HTMLElement,
  ) {
    this.controls = new TransformControls(camera, dom);
    this.controls.size = 0.85;
    scene.add(this.proxy);
    scene.add(this.controls.getHelper());
    this.controls.attach(this.proxy);
    this.setMode("translate");
    this.controls.addEventListener("mouseDown", () => {
      this.handlers?.begin(this.currentMode);
    });
    this.controls.addEventListener("objectChange", () => this.write());
    this.controls.addEventListener("mouseUp", () => {
      this.write();
      this.handlers?.end(this.currentMode);
      // The factor is per drag, so the next one starts from 1 again.
      this.proxy.scale.set(1, 1, 1);
      this.follow();
    });
  }

  get mode(): GizmoMode {
    return this.currentMode;
  }

  // Is the pointer the gizmo's? True while a handle is being dragged AND while
  // one is merely under the pointer, because a press on a hovered handle belongs
  // to the gizmo and the editor's own press handler runs a moment later (pointer
  // events precede mouse events).
  get busy(): boolean {
    return this.controls.dragging || this.controls.axis !== null;
  }

  setMode(mode: GizmoMode): void {
    this.currentMode = mode;
    this.controls.setMode(mode);
    // World axes for a move, the object's own for a turn or a size. Moving a
    // prop is said in the level's axes ("toward the camera", "left"); turning
    // and sizing one are said in the prop's, which is also the only frame the
    // model records them in.
    this.controls.setSpace(mode === "translate" ? "world" : "local");
    this.applyAxes();
  }

  // Grid and angle snapping, mirroring the editor's own toggle so a gizmo drag
  // lands on the same grid a 2D drag does. `null` is no snapping at all.
  setSnap(translate: number | null, rotate: number | null): void {
    this.controls.translationSnap = translate;
    this.controls.rotationSnap = rotate;
  }

  attach(handlers: GizmoHandlers | null): void {
    this.handlers = handlers;
    this.proxy.scale.set(1, 1, 1);
    this.applyAxes();
    this.follow();
  }

  // Take the proxy's pose from the model. Skipped while dragging, where the
  // proxy is the authority and the model is downstream of it.
  follow(): void {
    if (this.controls.dragging || !this.handlers) return;
    const { pos, quat } = this.handlers.pose();
    this.proxy.position.copy(pos);
    this.proxy.quaternion.copy(quat);
    this.proxy.updateMatrixWorld();
  }

  dispose(): void {
    this.controls.detach();
    this.scene.remove(this.controls.getHelper());
    this.scene.remove(this.proxy);
    this.controls.dispose();
  }

  private write(): void {
    if (!this.handlers) return;
    this.handlers.apply(
      this.currentMode,
      this.proxy.position,
      this.proxy.quaternion,
      this.proxy.scale,
    );
  }

  private applyAxes(): void {
    const axes = this.handlers?.axes(this.currentMode) ?? null;
    // No target, or nothing this mode could write: the handles go away entirely.
    // `enabled` as well as `visible`, so an invisible gizmo cannot still be
    // grabbed - the picker geometry is what a press hits, and it is not the same
    // objects as the ones drawn.
    const on = axes !== null;
    this.controls.enabled = on;
    this.controls.getHelper().visible = on;
    if (!axes) return;
    this.controls.showX = axes.x;
    this.controls.showY = axes.y;
    this.controls.showZ = axes.z;
    // The plane handles are only offered where both their axes are.
    this.controls.showXY = axes.x && axes.y;
    this.controls.showYZ = axes.y && axes.z;
    this.controls.showXZ = axes.x && axes.z;
  }
}
