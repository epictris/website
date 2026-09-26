// A tool's DRAFT in the 3D scene: the outline a tool is clicking out, drawn
// where the clicks landed. The Visuals workspace has no 2D overlay to draw a
// `polyDraft` on (see editor/render.ts), and the one tool that clicks onto
// model surfaces rather than the plane - the mushroom loop - has no plane to
// draw it on at all, so both are drawn here, in the scene, through the camera
// the clicks were made through.
//
// Ported from the fork's `SurfaceDraftView` (karin_website,
// rope/src/editor/surfacePatch.ts) and generalised: a point may carry a
// surface normal (a surface tool) or not (a plane tool), and the loop may be a
// crossed one the tool will refuse, said in the overlay's warning colour.
//
// Never picked: a draft is what the pointer is doing, and a click that landed
// on the line it is drawing would be a click on itself.

import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { DRAFT_CROSSED, SELECT } from "../render";
import type { Vec3 } from "./viewPose";

// One placed point of a draft, three's frame (y up), metres. A surface tool's
// points carry the face normal they were clicked on, and are drawn lifted off
// the surface along it so the line is not buried in the face it lies on.
export interface DraftPoint extends Vec3 {
  readonly normal?: Vec3;
}

export interface GuideDraft {
  readonly points: readonly DraftPoint[];
  // Whether the loop is closed; an open draft runs on to `cursor`.
  readonly closed: boolean;
  // Where the next point would go, drawn as a rubber band from the last one.
  readonly cursor?: Vec3 | null;
  // The loop crosses itself, which the tool will not take as drawn.
  readonly crossed?: boolean;
  // A triangle soup (xyz per vertex, three's frame) shaded over what the loop
  // encloses - the mushroom tool's collected surface.
  readonly fill?: Float32Array | null;
}

// Metres a surface point is lifted along its normal, so the line clears the
// face it lies on without visibly floating off it.
const DRAFT_LIFT = 0.004;
// Screen pixels: the draft line's width and the placed points' dot size. A
// little heavier than an outline (1.5 px), because it is the thing being done.
const DRAFT_LINE_PX = 2;
const DRAFT_DOT_PX = 6;
// The collected surface's tint, as the fork drew it: cyan, distinct from the
// selection orange the loop itself is drawn in.
const DRAFT_FILL = "#62e0ff";
const DRAFT_FILL_OPACITY = 0.4;
// Drawn after the scene and the other guides.
const DRAFT_RENDER_ORDER = 1100;

export class DraftView {
  readonly group = new THREE.Group();
  private readonly lineMaterial = new LineMaterial({
    color: SELECT,
    linewidth: DRAFT_LINE_PX,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  });
  private line: Line2 | null = null;
  private readonly dots: THREE.Points;
  private readonly fill: THREE.Mesh;

  constructor() {
    this.group.name = "guide-draft";
    this.dots = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        color: SELECT,
        size: DRAFT_DOT_PX,
        sizeAttenuation: false,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        // Guides are the editor's colours, not lit scene: neither the tone
        // curve nor the level's fog may shift them.
        toneMapped: false,
        fog: false,
      }),
    );
    this.fill = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: DRAFT_FILL,
        transparent: true,
        opacity: DRAFT_FILL_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        toneMapped: false,
        fog: false,
      }),
    );
    for (const o of [this.dots, this.fill]) this.quiet(o);
    this.group.add(this.fill, this.dots);
    this.group.visible = false;
  }

  // Unpickable and drawn last, whatever it is.
  private quiet(o: THREE.Object3D): void {
    o.raycast = () => undefined;
    o.renderOrder = DRAFT_RENDER_ORDER;
    o.frustumCulled = false;
  }

  // Redraw from scratch. Called when the draft changes - a click, a pointer
  // move - never per frame, so it builds fresh geometry rather than resizing
  // buffers in place (a buffer that changes length after upload is not
  // something WebGL resizes).
  set(draft: GuideDraft | null): void {
    if (!draft || draft.points.length === 0) {
      this.group.visible = false;
      return;
    }
    const lift = (p: DraftPoint): Vec3 =>
      p.normal
        ? { x: p.x + p.normal.x * DRAFT_LIFT, y: p.y + p.normal.y * DRAFT_LIFT, z: p.z + p.normal.z * DRAFT_LIFT }
        : p;
    const placed = draft.points.map(lift);
    const run = [...placed];
    if (draft.closed) run.push(placed[0]!);
    else if (draft.cursor) run.push(draft.cursor);

    if (this.line) {
      this.group.remove(this.line);
      this.line.geometry.dispose();
      this.line = null;
    }
    if (run.length >= 2) {
      const geo = new LineGeometry();
      geo.setPositions(run.flatMap((p) => [p.x, p.y, p.z]));
      this.line = new Line2(geo, this.lineMaterial);
      this.quiet(this.line);
      this.group.add(this.line);
    }
    this.lineMaterial.color.set(draft.crossed ? DRAFT_CROSSED : SELECT);
    (this.dots.material as THREE.PointsMaterial).color.set(draft.crossed ? DRAFT_CROSSED : SELECT);

    this.dots.geometry.dispose();
    this.dots.geometry = new THREE.BufferGeometry().setFromPoints(
      placed.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
    );
    this.fill.geometry.dispose();
    const fill = new THREE.BufferGeometry();
    if (draft.fill) fill.setAttribute("position", new THREE.BufferAttribute(draft.fill, 3));
    this.fill.geometry = fill;
    this.group.visible = true;
  }

  // The draft line's material, so the owner can size it with the rest.
  get material(): LineMaterial {
    return this.lineMaterial;
  }

  // How many segments of line and placed points are drawn, for the cases.
  counts(): { segments: number; points: number } {
    const segs = this.line ? (this.line.geometry as LineGeometry).attributes["instanceStart"]!.count : 0;
    return { segments: this.group.visible ? segs : 0, points: this.group.visible ? this.dots.geometry.attributes["position"]?.count ?? 0 : 0 };
  }

  dispose(): void {
    this.line?.geometry.dispose();
    this.lineMaterial.dispose();
    this.dots.geometry.dispose();
    (this.dots.material as THREE.Material).dispose();
    this.fill.geometry.dispose();
    (this.fill.material as THREE.Material).dispose();
    this.group.removeFromParent();
  }
}
