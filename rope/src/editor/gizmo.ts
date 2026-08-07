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
// ALL THREE HANDLE SETS ARE ON SCREEN AT ONCE. `TransformControls` is a modal
// control - one instance draws one mode - so this is three of them sharing one
// proxy, nested by size: the scale boxes inside, the move arrows through them,
// the rotation rings around the outside. A mode toggle is a thing to remember
// and to get wrong: reaching for the ring and turning up a move arrow because
// the toolbar was on `move` is an edit that looks like the level and is not it,
// which is the same mistake "selected first, moved second" exists to prevent on
// the plane. Nested, the answer to "what will this drag do" is what is drawn
// under the pointer.
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
// light has no size - and that mode's handles then go away entirely rather than
// offering a handle whose effect the file cannot record.
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

// How large each mode's handles are drawn, as `TransformControls.size`. The
// three sets share one origin and one set of axes, so the only thing that can
// keep them apart is their RADIUS, and these are read off the geometry three
// actually builds: an axis handle sits at 0.5 x size with a picker cone reaching
// 0.6, and a rotation ring is drawn at 0.5 with a picker tube 0.1 thick. So the
// scale boxes land at 0.225 and their pickers stop at 0.27, the move arrows at
// 0.45 stopping at 0.54, and the rings at 0.70 with their pickers starting at
// 0.56 - nested in that order, with nothing of one set drawn over another.
//
// The move arrows set the floor on all of it. Their heads are a 0.04 cone, so at
// the 0.85 the single-mode gizmo used they are already only about eight pixels;
// shrinking them to buy room for the rings outside makes the commonest handle in
// the editor a speck. Everything else is sized around that, which is why the
// whole thing has a wider footprint than one mode's worth of handles - it is
// three modes' worth.
const HANDLE_SIZE: Record<GizmoMode, number> = {
  scale: 0.45,
  translate: 0.9,
  rotate: 1.4,
};

// Which set a press belongs to where two of them are under the pointer. Their
// PICKERS overlap even though their handles do not: an axis picker is a cone
// widest AT THE ORIGIN, so the scale box's cone lies wholly inside the move
// arrow's and both cover the centre. Innermost first is what the eye reads - at
// the scale box's radius the box is what is drawn there and the arrow is only
// passing through - with one exception, in `winner`.
const PICK_ORDER: readonly GizmoMode[] = ["scale", "translate", "rotate"];

// The handle every axis picker's cone has its base on top of. Uniform scale is
// drawn at the origin, so it is reachable only by beating the axes that all
// start there, and it is the handle a MESH actually has: its `scale` is one
// number, which makes the centre drag exact and every single axis an
// approximation of it.
const CENTRE_HANDLE = "XYZ";

// Take one handle out of a control's gizmo for good.
//
// The `showX`/`showY`/`showZ` flags cannot express it: three names its centre
// handle `XYZ`, so it is gated on all three axis flags at once and there is no
// way to drop it without dropping the arrows with it. Reaching into `_gizmo` is
// what that costs, and this is written to be inert rather than fatal if a three
// upgrade ever renames the field - a handle that stays is a handle in the way,
// not a crash.
function dropHandle(controls: TransformControls, mode: GizmoMode, name: string): void {
  const groups = (
    controls as unknown as {
      _gizmo?: {
        gizmo?: Record<string, THREE.Object3D | undefined>;
        picker?: Record<string, THREE.Object3D | undefined>;
      };
    }
  )._gizmo;
  for (const group of [groups?.gizmo?.[mode], groups?.picker?.[mode]]) {
    if (!group) continue;
    for (const child of [...group.children]) if (child.name === name) group.remove(child);
  }
}

export class EditorGizmo {
  private readonly controls: Record<GizmoMode, TransformControls>;
  // What the handles are actually attached to. It is in the scene so its world
  // matrix is kept up to date like anything else; it draws nothing.
  private readonly proxy = new THREE.Object3D();
  private handlers: GizmoHandlers | null = null;
  // The set a drag is currently in, so the model is written under the mode that
  // is actually being dragged rather than a mode a toolbar was left on.
  private active: GizmoMode | null = null;
  // The sets held off for the duration of one press (see `PICK_ORDER`). Kept as
  // state rather than restored inline because `applyAxes` may run in between and
  // would otherwise switch them back on mid-drag.
  private readonly suspended = new Set<GizmoMode>();

  constructor(
    private readonly scene: THREE.Scene,
    camera: THREE.Camera,
    private readonly dom: HTMLElement,
  ) {
    scene.add(this.proxy);
    const make = (mode: GizmoMode): TransformControls => {
      const c = new TransformControls(camera, dom);
      c.setMode(mode);
      c.size = HANDLE_SIZE[mode];
      // World axes for a move, the object's own for a turn or a size. Moving a
      // prop is said in the level's axes ("toward the camera", "left"); turning
      // and sizing one are said in the prop's, which is also the only frame the
      // model records them in.
      c.setSpace(mode === "translate" ? "world" : "local");
      scene.add(c.getHelper());
      c.attach(this.proxy);
      c.addEventListener("mouseDown", () => {
        this.active = mode;
        this.handlers?.begin(mode);
      });
      c.addEventListener("objectChange", () => this.write(mode));
      c.addEventListener("mouseUp", () => {
        this.write(mode);
        this.handlers?.end(mode);
        this.active = null;
        // The factor is per drag, so the next one starts from 1 again.
        this.proxy.scale.set(1, 1, 1);
        this.follow();
      });
      return c;
    };
    this.controls = {
      translate: make("translate"),
      rotate: make("rotate"),
      scale: make("scale"),
    };

    // The handles the three sets would otherwise duplicate or bury.
    //
    // The centre belongs to uniform scale (see `CENTRE_HANDLE`), so the move
    // gizmo's own centre handle - a free drag in the view plane - goes; its `XY`
    // plane handle already covers the gameplay plane, which is what that one was
    // wanted for. Rotation's free-rotation ball goes for the plainer reason that
    // it is a quarter-radius sphere sitting exactly where the move and scale
    // handles are, and scale's plane handles because two axes at once is what
    // the MOVE gizmo means and a squashed shape is rarely what was wanted.
    dropHandle(this.controls.translate, "translate", CENTRE_HANDLE);
    this.controls.rotate.showXYZE = false;
    this.controls.scale.showXY = false;
    this.controls.scale.showYZ = false;
    this.controls.scale.showXZ = false;

    // Both listeners are on the WINDOW, and the phase is what makes each work:
    // three's own handlers are on the canvas, so a capturing listener runs
    // before them and a bubbling one after.
    //
    // After the hover pass, so the highlight can be corrected once every set has
    // had its say - two lit handles under one pointer is the gizmo saying it
    // does not know what a press would do.
    dom.ownerDocument.defaultView?.addEventListener("pointermove", this.onHover);
    // Before the press, because three re-runs its own hover inside its
    // `pointerdown` and would overwrite anything the pass above decided. Held
    // off rather than corrected: a disabled control does not look at the press
    // at all.
    window.addEventListener("pointerdown", this.onPressCapture, true);
    window.addEventListener("pointerup", this.onRelease);

    // Nothing is selected yet, so nothing is on screen yet. It has to be said
    // HERE rather than left to the first `attach`: the editor attaches only when
    // what is selected changes, and an empty selection at startup is not a
    // change from the empty one it begins with - so a gizmo built visible stays
    // visible, in full, over a level nobody has clicked on.
    this.applyAxes();
  }

  // Is the pointer the gizmo's? True while a handle is being dragged AND while
  // one is merely under the pointer, because a press on a hovered handle belongs
  // to the gizmo and the editor's own press handler runs a moment later (pointer
  // events precede mouse events).
  get busy(): boolean {
    return GIZMO_MODES.some((m) => this.controls[m].dragging || this.controls[m].axis !== null);
  }

  // Follow the scene's camera when the editor switches lens (see
  // `ViewProjection`). `TransformControls` reads it for the handle sizing and
  // for the raycast a press is picked with, so a gizmo left on the old camera is
  // one whose handles are drawn where they cannot be grabbed. Guarded so this
  // can be called every frame: the property is reactive and setting it re-runs
  // the helper's whole update.
  setCamera(camera: THREE.Camera): void {
    for (const m of GIZMO_MODES) {
      if (this.controls[m].camera !== camera) this.controls[m].camera = camera;
    }
  }

  // Grid and angle snapping, mirroring the editor's own toggle so a gizmo drag
  // lands on the same grid a 2D drag does. `null` is no snapping at all. A size
  // is not snapped here - the editor rounds the dimensions it writes, which is
  // the same grid applied to the number the file actually records.
  setSnap(translate: number | null, rotate: number | null): void {
    this.controls.translate.translationSnap = translate;
    this.controls.rotate.rotationSnap = rotate;
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
    if (this.active !== null) return;
    // The handle SET is re-asked here too, not only when the selection changes,
    // and BEFORE the "is there a target at all" test rather than after it. Two
    // reasons, and the second is why it is not merely tidier: what a target can
    // record is a property of the target, and an edit can change it without
    // changing what is selected (the inspector's `collision` tick turns a
    // collision shape into a geometry object, which gains a rotation about x and
    // a depth); and asked unconditionally, what is on screen is a pure function
    // of what is selected, so no missed `attach` can leave handles standing over
    // nothing. Every write is guarded on the value actually differing (three's
    // own reactive properties), so a frame that changed nothing costs three
    // lookups.
    this.applyAxes();
    if (!this.handlers) return;
    const { pos, quat } = this.handlers.pose();
    this.proxy.position.copy(pos);
    this.proxy.quaternion.copy(quat);
    this.proxy.updateMatrixWorld();
  }

  dispose(): void {
    this.dom.ownerDocument.defaultView?.removeEventListener("pointermove", this.onHover);
    window.removeEventListener("pointerdown", this.onPressCapture, true);
    window.removeEventListener("pointerup", this.onRelease);
    for (const m of GIZMO_MODES) {
      const c = this.controls[m];
      c.detach();
      this.scene.remove(c.getHelper());
      c.dispose();
    }
    this.scene.remove(this.proxy);
  }

  // The set the pointer is over, where more than one claims it.
  private winner(): GizmoMode | null {
    const claims = PICK_ORDER.filter((m) => this.controls[m].axis !== null);
    return (
      claims.find((m) => this.controls[m].axis === CENTRE_HANDLE) ?? claims[0] ?? null
    );
  }

  private readonly onHover = (): void => {
    const keep = this.active ?? this.winner();
    for (const m of GIZMO_MODES) {
      if (m !== keep && this.controls[m].axis !== null) this.controls[m].axis = null;
    }
  };

  private readonly onPressCapture = (e: PointerEvent): void => {
    if (e.button !== 0 || this.active !== null) return;
    const keep = this.winner();
    if (keep === null) return;
    for (const m of GIZMO_MODES) if (m !== keep) this.suspended.add(m);
    this.applyAxes();
  };

  private readonly onRelease = (): void => {
    if (!this.suspended.size) return;
    this.suspended.clear();
    this.applyAxes();
  };

  private write(mode: GizmoMode): void {
    if (!this.handlers) return;
    this.handlers.apply(mode, this.proxy.position, this.proxy.quaternion, this.proxy.scale);
  }

  private applyAxes(): void {
    for (const mode of GIZMO_MODES) {
      const c = this.controls[mode];
      const axes = this.handlers?.axes(mode) ?? null;
      // No target, or nothing this mode could write: this set's handles go away
      // entirely. `enabled` as well as `visible`, so an invisible gizmo cannot
      // still be grabbed - the picker geometry is what a press hits, and it is
      // not the same objects as the ones drawn.
      const on = axes !== null && !this.suspended.has(mode);
      c.enabled = on;
      c.getHelper().visible = axes !== null;
      if (!on) {
        // The handles going away must take the POINTER STATE with them.
        // `TransformControls` records which handle the pointer is over in
        // `axis`, and its hover listener returns early while disabled - so an
        // axis the pointer happened to be on when the target went is one nothing
        // ever clears. `busy` then reports the pointer as the gizmo's for ever
        // and the editor's own press handler returns early on every press: after
        // deleting a body with the pointer resting on an arrow, nothing selects,
        // pans, orbits or draws again, and there is no gesture that recovers it.
        c.axis = null;
        c.dragging = false;
        continue;
      }
      c.showX = axes!.x;
      c.showY = axes!.y;
      c.showZ = axes!.z;
      // The plane handles are only offered where both their axes are - and only
      // the move gizmo has them at all (see the constructor).
      if (mode === "translate") {
        c.showXY = axes!.x && axes!.y;
        c.showYZ = axes!.y && axes!.z;
        c.showXZ = axes!.x && axes!.z;
      }
    }
  }
}
