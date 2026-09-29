// A tool's DRAFT in the 3D scene: the outline a tool is clicking out, drawn
// where the clicks landed. The Visuals workspace has no 2D overlay to draw a
// `polyDraft` on (see editor/render.ts), so it is drawn here, in the scene,
// through the camera the clicks were made through. The loop may be a crossed
// one the tool will refuse, said in the overlay's warning colour.
//
// Never picked: a draft is what the pointer is doing, and a click that landed
// on the line it is drawing would be a click on itself.

import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { DRAFT_CROSSED, SELECT } from "../render";
import type { Vec3 } from "./viewPose";

// One placed point of a draft, three's frame (y up), metres.
export type DraftPoint = Vec3;

export interface GuideDraft {
  readonly points: readonly DraftPoint[];
  // Whether the loop is closed; an open draft runs on to `cursor`.
  readonly closed: boolean;
  // Where the next point would go, drawn as a rubber band from the last one.
  readonly cursor?: Vec3 | null;
  // The loop crosses itself, which the tool will not take as drawn.
  readonly crossed?: boolean;
}

// Screen pixels: the draft line's width and the placed points' dot size. A
// little heavier than an outline (1.5 px), because it is the thing being done.
const DRAFT_LINE_PX = 2;
const DRAFT_DOT_PX = 6;
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
    this.quiet(this.dots);
    this.group.add(this.dots);
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
    const placed = draft.points;
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
    this.group.removeFromParent();
  }
}
