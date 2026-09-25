// The `+ Mushrooms` tool's loop while it is being painted, and the loop of a
// patch opened by **Edit loop**: the state behind both, and the draft the
// guides draw for it. The editor owns the clicks (which surface is under the
// pointer, what closing the loop creates); this holds the points.
//
// A loop is painted on ONE model: its first point names the host, and every
// later click is taken only on that host, since the patch it makes grows on one
// object's surface (its key names one host).

import * as THREE from "three";
import type { DraftPoint, GuideDraft } from "./draftView";
import type { SurfacePoint } from "./surfacePatch";

export interface LoopPoint extends SurfacePoint {
  // The item the point was clicked on.
  readonly hostId: number;
}

const toDraft = (p: SurfacePoint): DraftPoint => ({
  x: p.point.x,
  y: p.point.y,
  z: p.point.z,
  normal: { x: p.normal.x, y: p.normal.y, z: p.normal.z },
});

export class SurfaceLoop {
  private pts: LoopPoint[] = [];
  private cursorAt: THREE.Vector3 | null = null;

  get points(): readonly LoopPoint[] {
    return this.pts;
  }

  // The host the loop is on, or null before the first point.
  get hostId(): number | null {
    return this.pts[0]?.hostId ?? null;
  }

  get empty(): boolean {
    return this.pts.length === 0;
  }

  // A loop needs three points to enclose anything.
  get closable(): boolean {
    return this.pts.length >= 3;
  }

  add(p: LoopPoint): void {
    this.pts = [...this.pts, p];
  }

  // Backspace: the last point goes; true when there was one.
  pop(): boolean {
    if (!this.pts.length) return false;
    this.pts = this.pts.slice(0, -1);
    return true;
  }

  clear(): void {
    this.pts = [];
    this.cursorAt = null;
  }

  // Where the next point would go (the surface under the pointer), or null off
  // the host.
  set cursor(p: THREE.Vector3 | null) {
    this.cursorAt = p ? p.clone() : null;
  }

  // The draft the guides draw: the placed points and the run on to the cursor.
  draft(): GuideDraft | null {
    if (!this.pts.length) return null;
    const c = this.cursorAt;
    return { points: this.pts.map(toDraft), closed: false, cursor: c ? { x: c.x, y: c.y, z: c.z } : null };
  }
}

// A closed loop as the guides draw it (Edit loop): the points on the surface,
// closed, and the faces they cover shaded.
export function closedDraft(points: readonly SurfacePoint[], fill: Float32Array | null): GuideDraft {
  return { points: points.map(toDraft), closed: true, fill };
}
