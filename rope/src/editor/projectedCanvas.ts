// THE OVERLAY AT ANY ANGLE. The editor's overlay (render.ts) draws the level's
// chrome - outlines, handles, regions, paths, drafts, the marquee - in world
// metres through a canvas transform. A canvas transform is affine, so it can
// only ever draw the gameplay plane seen head on; turned, every mark would sit
// somewhere the geometry is not.
//
// This draws the same calls through the 3D view instead. `ViewProjector` is
// the scene camera's projection of a world point onto the screen; a
// `ProjectedContext` stands in for the 2D context while the overlay draws in
// world units (`beginWorld`) and carries each point through it:
//
// - lines stay lines (a projection keeps them straight), arcs and rects are
//   walked as polylines first, and every segment is clipped where it passes
//   behind the camera;
// - line widths, dashes and fonts are in head-on pixels (the overlay sizes
//   them as `worldLine` multiples), so the chrome keeps its weight at any angle;
// - a GLYPH - a circle or square a few pixels across, which is what every
//   handle, icon and marker is - is drawn screen-sized at its projected centre,
//   as a 3D editor draws its overlays, rather than foreshortened into a sliver;
// - something with a depth is drawn at it (`atDepth`, a light's `z`).
//
// Screen-space drawing (labels placed with `worldToScreen`, which projects
// through the same camera when it carries a projector, see render/camera.ts)
// passes straight through to the real context.

import * as THREE from "three";
import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER } from "../engine/units";
import type { Camera } from "../render/camera";

// A circle or square at most this many head-on pixels across its radius (half
// side) is a glyph: drawn screen-sized rather than projected.
const GLYPH_PX = 14;
// Behind this clip-space w a point is behind the eye.
const NEAR_W = 1e-4;

// The scene camera's view of the world, in the overlay's terms: world metres
// with y DOWN and z toward the camera, CSS pixels with y down.
export class ViewProjector {
  private readonly m = new THREE.Matrix4();
  private readonly inv = new THREE.Matrix4();
  private readonly v = new THREE.Vector4();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  width = 1;
  height = 1;

  update(camera: THREE.Camera, width: number, height: number): void {
    camera.updateMatrixWorld();
    this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.inv.copy(this.m).invert();
    this.width = width;
    this.height = height;
  }

  // Clip coordinates of a world point (x, y down, z).
  clip(x: number, y: number, z: number, out: [number, number, number, number]): void {
    this.v.set(x, -y, z, 1).applyMatrix4(this.m);
    out[0] = this.v.x;
    out[1] = this.v.y;
    out[2] = this.v.z;
    out[3] = this.v.w;
  }

  // Clip coordinates in front of the eye onto the screen.
  screenOf(c: readonly number[]): Vec2 {
    return new Vec2(((c[0]! / c[3]! + 1) / 2) * this.width, ((1 - c[1]! / c[3]!) / 2) * this.height);
  }

  // A world point on the screen, or null behind the eye.
  project(p: Vec2, z = 0): Vec2 | null {
    const c: [number, number, number, number] = [0, 0, 0, 0];
    this.clip(p.x, p.y, z, c);
    return c[3] > NEAR_W ? this.screenOf(c) : null;
  }

  // The point of the plane at depth `z` under a screen position, or null where
  // the ray through it never meets that plane in front of the eye.
  unproject(sx: number, sy: number, z = 0): Vec2 | null {
    const nx = (sx / this.width) * 2 - 1;
    const ny = 1 - (sy / this.height) * 2;
    this.a.set(nx, ny, -1).applyMatrix4(this.inv);
    this.b.set(nx, ny, 1).applyMatrix4(this.inv);
    const dz = this.b.z - this.a.z;
    if (Math.abs(dz) < 1e-12) return null;
    const t = (z - this.a.z) / dz;
    if (t < 0) return null;
    return new Vec2(this.a.x + (this.b.x - this.a.x) * t, -(this.a.y + (this.b.y - this.a.y) * t));
  }
}

// The 2D camera made a view of the 3D one: its `worldToScreen` and
// `screenToWorld` go through the projector (render/camera.ts).
export function attachProjector(cam: Camera, projector: ViewProjector | null): void {
  if (!projector) {
    delete cam.project;
    delete cam.unproject;
    return;
  }
  cam.project = (p, z) => projector.project(p, z);
  cam.unproject = (x, y, z) => projector.unproject(x, y, z);
}

type Affine = [number, number, number, number, number, number];
type Sub =
  | { kind: "line"; pts: number[]; z: number; closed: boolean }
  | { kind: "circle"; x: number; y: number; z: number; r: number; a0: number; a1: number; ccw: boolean }
  | { kind: "square"; x: number; y: number; z: number; hw: number; hh: number };

// A path recorded in world units, for a `ProjectedContext` to draw. It is
// what `makePath` hands out in place of a `Path2D` while the overlay is
// projected: a real Path2D cannot be read back.
export class RecordedPath {
  subs: Sub[] = [];
  constructor(private readonly owner: ProjectedContext) {}
  moveTo(x: number, y: number): void {
    this.owner.recordMove(this.subs, x, y);
  }
  lineTo(x: number, y: number): void {
    this.owner.recordLine(this.subs, x, y);
  }
  closePath(): void {
    const last = this.subs[this.subs.length - 1];
    if (last?.kind === "line") last.closed = true;
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
    this.owner.recordArc(this.subs, x, y, r, a0, a1, ccw);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.owner.recordRect(this.subs, x, y, w, h);
  }
}

interface State {
  world: boolean;
  t: Affine;
  z: number;
  lineWidth: number;
  dash: number[];
  font: string;
}

export class ProjectedContext {
  private state: State = { world: false, t: [1, 0, 0, 1, 0, 0], z: 0, lineWidth: 1, dash: [], font: "10px sans-serif" };
  private readonly stack: State[] = [];
  private path: Sub[] = [];
  // Head-on pixels per world metre: what the overlay's `worldLine` is 1 / of.
  private headOn = 1;
  private readonly c0: [number, number, number, number] = [0, 0, 0, 0];
  private readonly c1: [number, number, number, number] = [0, 0, 0, 0];

  constructor(
    readonly real: CanvasRenderingContext2D,
    private readonly projector: ViewProjector,
  ) {}

  get canvas(): HTMLCanvasElement {
    return this.real.canvas;
  }

  // From here (to the matching `restore`), drawing is in world metres seen
  // through the projector; `cam` is the head-on camera the overlay sizes its
  // lines by.
  beginWorld(cam: Camera): void {
    this.state.world = true;
    this.state.t = [1, 0, 0, 1, 0, 0];
    this.headOn = cam.zoom * PIXELS_PER_METER;
  }

  // What is drawn from here sits at depth `z` (a light at its own).
  atDepth(z: number): void {
    this.state.z = z;
  }

  // --- state -----------------------------------------------------------------

  save(): void {
    this.stack.push({ ...this.state, t: [...this.state.t] as Affine, dash: [...this.state.dash] });
    this.real.save();
  }
  restore(): void {
    const s = this.stack.pop();
    if (s) this.state = s;
    this.real.restore();
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.state.world = false;
    this.real.setTransform(a, b, c, d, e, f);
  }
  translate(x: number, y: number): void {
    if (!this.state.world) return this.real.translate(x, y);
    const t = this.state.t;
    t[4] += t[0] * x + t[2] * y;
    t[5] += t[1] * x + t[3] * y;
  }
  rotate(a: number): void {
    if (!this.state.world) return this.real.rotate(a);
    const t = this.state.t;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    const [m0, m1, m2, m3] = t;
    t[0] = m0 * cs + m2 * sn;
    t[1] = m1 * cs + m3 * sn;
    t[2] = -m0 * sn + m2 * cs;
    t[3] = -m1 * sn + m3 * cs;
  }
  scale(sx: number, sy: number): void {
    if (!this.state.world) return this.real.scale(sx, sy);
    const t = this.state.t;
    t[0] *= sx;
    t[1] *= sx;
    t[2] *= sy;
    t[3] *= sy;
  }

  get lineWidth(): number {
    return this.state.lineWidth;
  }
  set lineWidth(v: number) {
    this.state.lineWidth = v;
    if (!this.state.world) this.real.lineWidth = v;
  }
  setLineDash(d: number[]): void {
    this.state.dash = [...d];
    if (!this.state.world) this.real.setLineDash(d);
  }
  getLineDash(): number[] {
    return [...this.state.dash];
  }
  get font(): string {
    return this.state.font;
  }
  set font(v: string) {
    this.state.font = v;
    this.real.font = v;
  }
  get strokeStyle(): string | CanvasGradient | CanvasPattern {
    return this.real.strokeStyle;
  }
  set strokeStyle(v: string | CanvasGradient | CanvasPattern) {
    this.real.strokeStyle = v;
  }
  get fillStyle(): string | CanvasGradient | CanvasPattern {
    return this.real.fillStyle;
  }
  set fillStyle(v: string | CanvasGradient | CanvasPattern) {
    this.real.fillStyle = v;
  }
  get globalAlpha(): number {
    return this.real.globalAlpha;
  }
  set globalAlpha(v: number) {
    this.real.globalAlpha = v;
  }
  get globalCompositeOperation(): GlobalCompositeOperation {
    return this.real.globalCompositeOperation;
  }
  set globalCompositeOperation(v: GlobalCompositeOperation) {
    this.real.globalCompositeOperation = v;
  }
  get lineCap(): CanvasLineCap {
    return this.real.lineCap;
  }
  set lineCap(v: CanvasLineCap) {
    this.real.lineCap = v;
  }
  get lineJoin(): CanvasLineJoin {
    return this.real.lineJoin;
  }
  set lineJoin(v: CanvasLineJoin) {
    this.real.lineJoin = v;
  }
  get textAlign(): CanvasTextAlign {
    return this.real.textAlign;
  }
  set textAlign(v: CanvasTextAlign) {
    this.real.textAlign = v;
  }
  get textBaseline(): CanvasTextBaseline {
    return this.real.textBaseline;
  }
  set textBaseline(v: CanvasTextBaseline) {
    this.real.textBaseline = v;
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.real.clearRect(x, y, w, h);
  }

  // --- paths -------------------------------------------------------------------

  beginPath(): void {
    this.path = [];
    if (!this.state.world) this.real.beginPath();
  }
  moveTo(x: number, y: number): void {
    if (!this.state.world) return this.real.moveTo(x, y);
    this.recordMove(this.path, x, y);
  }
  lineTo(x: number, y: number): void {
    if (!this.state.world) return this.real.lineTo(x, y);
    this.recordLine(this.path, x, y);
  }
  closePath(): void {
    if (!this.state.world) return this.real.closePath();
    const last = this.path[this.path.length - 1];
    if (last?.kind === "line") last.closed = true;
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
    if (!this.state.world) return this.real.arc(x, y, r, a0, a1, ccw);
    this.recordArc(this.path, x, y, r, a0, a1, ccw);
  }
  rect(x: number, y: number, w: number, h: number): void {
    if (!this.state.world) return this.real.rect(x, y, w, h);
    this.recordRect(this.path, x, y, w, h);
  }

  stroke(path?: RecordedPath | Path2D): void {
    if (!this.state.world) return path ? this.real.stroke(path as Path2D) : this.real.stroke();
    this.emit(path instanceof RecordedPath ? path.subs : this.path, false);
    this.styleLines();
    this.real.stroke();
  }
  fill(a?: RecordedPath | Path2D | CanvasFillRule, b?: CanvasFillRule): void {
    if (!this.state.world) {
      if (a && typeof a !== "string") return this.real.fill(a as Path2D, b);
      return this.real.fill(a as CanvasFillRule | undefined);
    }
    const subs = a instanceof RecordedPath ? a.subs : this.path;
    const rule = typeof a === "string" ? a : b;
    this.emit(subs, true);
    this.real.fill(rule);
  }
  clip(a?: RecordedPath | Path2D | CanvasFillRule, b?: CanvasFillRule): void {
    if (!this.state.world) {
      if (a && typeof a !== "string") return this.real.clip(a as Path2D, b);
      return this.real.clip(a as CanvasFillRule | undefined);
    }
    const subs = a instanceof RecordedPath ? a.subs : this.path;
    const rule = typeof a === "string" ? a : b;
    this.emit(subs, true);
    this.real.clip(rule);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    if (!this.state.world) return this.real.fillRect(x, y, w, h);
    const subs: Sub[] = [];
    this.recordRect(subs, x, y, w, h);
    this.emit(subs, true);
    this.real.fill();
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    if (!this.state.world) return this.real.strokeRect(x, y, w, h);
    const subs: Sub[] = [];
    this.recordRect(subs, x, y, w, h);
    this.emit(subs, false);
    this.styleLines();
    this.real.stroke();
  }
  fillText(text: string, x: number, y: number): void {
    if (!this.state.world) return this.real.fillText(text, x, y);
    const [wx, wy] = this.apply(x, y);
    const p = this.projector.project(new Vec2(wx, wy), this.state.z);
    if (!p) return;
    this.real.save();
    this.real.font = scaledFont(this.state.font, this.pxPerUnit());
    this.real.fillText(text, p.x, p.y);
    this.real.restore();
  }
  measureText(text: string): TextMetrics {
    if (!this.state.world) return this.real.measureText(text);
    this.real.save();
    this.real.font = scaledFont(this.state.font, this.pxPerUnit());
    const m = this.real.measureText(text);
    this.real.restore();
    const k = this.pxPerUnit();
    return { ...m, width: m.width / k } as TextMetrics;
  }

  // A path in world units the context can draw (see `RecordedPath`).
  recordedPath(): RecordedPath {
    return new RecordedPath(this);
  }

  // --- recording (world units, the current transform applied) ---------------

  recordMove(subs: Sub[], x: number, y: number): void {
    const [wx, wy] = this.apply(x, y);
    subs.push({ kind: "line", pts: [wx, wy], z: this.state.z, closed: false });
  }
  recordLine(subs: Sub[], x: number, y: number): void {
    const last = subs[subs.length - 1];
    const [wx, wy] = this.apply(x, y);
    if (last?.kind === "line" && !last.closed) last.pts.push(wx, wy);
    else subs.push({ kind: "line", pts: [wx, wy], z: this.state.z, closed: false });
  }
  recordArc(subs: Sub[], x: number, y: number, r: number, a0: number, a1: number, ccw: boolean): void {
    const k = this.unitsPerUnit();
    const px = r * k * this.headOn;
    const [cx, cy] = this.apply(x, y);
    if (px <= GLYPH_PX) {
      subs.push({ kind: "circle", x: cx, y: cy, z: this.state.z, r: px, a0, a1, ccw });
      return;
    }
    // Walked as a polyline in world units, continuing the open subpath as a
    // canvas arc does.
    let sweep = a1 - a0;
    if (!ccw && sweep < 0) sweep = (sweep % (2 * Math.PI)) + 2 * Math.PI;
    if (ccw && sweep > 0) sweep = (sweep % (2 * Math.PI)) - 2 * Math.PI;
    if (Math.abs(a1 - a0) >= 2 * Math.PI) sweep = ccw ? -2 * Math.PI : 2 * Math.PI;
    const n = Math.max(8, Math.min(256, Math.ceil((Math.abs(sweep) * px) / 6)));
    for (let i = 0; i <= n; i++) {
      const a = a0 + (sweep * i) / n;
      const lx = x + r * Math.cos(a);
      const ly = y + r * Math.sin(a);
      if (i === 0) {
        const last = subs[subs.length - 1];
        if (last?.kind === "line" && !last.closed) this.recordLine(subs, lx, ly);
        else this.recordMove(subs, lx, ly);
      } else this.recordLine(subs, lx, ly);
    }
  }
  recordRect(subs: Sub[], x: number, y: number, w: number, h: number): void {
    const k = this.unitsPerUnit() * this.headOn;
    if (Math.abs(w) * k <= 2 * GLYPH_PX && Math.abs(h) * k <= 2 * GLYPH_PX) {
      const [cx, cy] = this.apply(x + w / 2, y + h / 2);
      subs.push({ kind: "square", x: cx, y: cy, z: this.state.z, hw: (Math.abs(w) * k) / 2, hh: (Math.abs(h) * k) / 2 });
      return;
    }
    this.recordMove(subs, x, y);
    this.recordLine(subs, x + w, y);
    this.recordLine(subs, x + w, y + h);
    this.recordLine(subs, x, y + h);
    const last = subs[subs.length - 1];
    if (last?.kind === "line") last.closed = true;
  }

  // --- drawing -----------------------------------------------------------------

  private apply(x: number, y: number): [number, number] {
    const t = this.state.t;
    return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
  }
  // World metres per user unit under the current transform.
  private unitsPerUnit(): number {
    const t = this.state.t;
    return Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2]));
  }
  // Head-on pixels per user unit.
  private pxPerUnit(): number {
    return this.unitsPerUnit() * this.headOn;
  }

  private styleLines(): void {
    const k = this.pxPerUnit();
    this.real.lineWidth = this.state.lineWidth * k;
    this.real.setLineDash(this.state.dash.map((d) => d * k));
  }

  // The subpaths onto the real context as one screen-space path. A filled
  // polygon is clipped at the eye as a polygon; a stroked line as segments.
  private emit(subs: readonly Sub[], filled: boolean): void {
    const r = this.real;
    r.beginPath();
    for (const s of subs) {
      if (s.kind === "circle") {
        const p = this.projector.project(new Vec2(s.x, s.y), s.z);
        if (!p) continue;
        r.moveTo(p.x + s.r * Math.cos(s.a0), p.y + s.r * Math.sin(s.a0));
        r.arc(p.x, p.y, s.r, s.a0, s.a1, s.ccw);
      } else if (s.kind === "square") {
        const p = this.projector.project(new Vec2(s.x, s.y), s.z);
        if (!p) continue;
        r.rect(p.x - s.hw, p.y - s.hh, 2 * s.hw, 2 * s.hh);
      } else if (filled || s.closed) this.emitPolygon(s, filled);
      else this.emitPolyline(s.pts, s.z, false);
    }
  }

  // An open run of segments, each clipped in homogeneous space against the
  // eye and the guard band (`clipSegment`); consecutive kept segments are one
  // stroke, so a dash runs on across a corner as it does on a plain canvas.
  private emitPolyline(pts: readonly number[], z: number, closed: boolean): void {
    const n = pts.length / 2;
    if (n === 1) {
      const p = this.projector.project(new Vec2(pts[0]!, pts[1]!), z);
      if (p) this.real.moveTo(p.x, p.y);
      return;
    }
    const count = closed ? n : n - 1;
    let open = false;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % n;
      this.projector.clip(pts[i * 2]!, pts[i * 2 + 1]!, z, this.c0);
      this.projector.clip(pts[j * 2]!, pts[j * 2 + 1]!, z, this.c1);
      const seg = clipSegment(this.c0, this.c1);
      if (!seg) {
        open = false;
        continue;
      }
      const pa = this.projector.screenOf(seg.a);
      const pb = this.projector.screenOf(seg.b);
      if (!open || seg.cutStart) this.real.moveTo(pa.x, pa.y);
      this.real.lineTo(pb.x, pb.y);
      open = !seg.cutEnd;
    }
  }

  // A closed outline: clipped as a polygon (Sutherland-Hodgman against the
  // eye and the guard band), so a fill or a clip region never wraps through
  // infinity nor carries a coordinate too large for the canvas to keep.
  private emitPolygon(s: Extract<Sub, { kind: "line" }>, filled: boolean): void {
    const n = s.pts.length / 2;
    let ring: number[][] = [];
    for (let i = 0; i < n; i++) {
      const c: [number, number, number, number] = [0, 0, 0, 0];
      this.projector.clip(s.pts[i * 2]!, s.pts[i * 2 + 1]!, s.z, c);
      ring.push(c);
    }
    // A stroke of a ring that leaves the view must not gain the clip's own
    // edges along the guard band: stroked as segments instead.
    if (!filled && !ring.every(inside)) {
      this.emitPolyline(s.pts, s.z, true);
      return;
    }
    for (const plane of PLANES) {
      const out: number[][] = [];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        const fa = plane(a);
        const fb = plane(b);
        if (fa >= 0) out.push(a);
        if (fa >= 0 !== fb >= 0) out.push(lerp4(a, b, fa / (fa - fb)));
      }
      ring = out;
      if (ring.length < 2) return;
    }
    ring.forEach((c, i) => {
      const p = this.projector.screenOf(c);
      if (i === 0) this.real.moveTo(p.x, p.y);
      else this.real.lineTo(p.x, p.y);
    });
    this.real.closePath();
  }
}

// THE CLIP VOLUME, in clip coordinates: in front of the eye, and within a
// guard band GUARD screens wide about the view. Anything drawn is clipped to
// it first, as a GPU clips, because a point near the eye plane projects
// arbitrarily far off screen and a canvas path (a clip region above all) does
// not survive coordinates in the millions: a compound outline's padded clip
// box, tens of metres across, lost every stroke it was meant to keep once the
// view turned past ~40 degrees (rails, 2026-11-22).
const GUARD = 4;
const PLANES: ReadonlyArray<(c: readonly number[]) => number> = [
  (c) => c[3]! - NEAR_W,
  (c) => GUARD * c[3]! - c[0]!,
  (c) => GUARD * c[3]! + c[0]!,
  (c) => GUARD * c[3]! - c[1]!,
  (c) => GUARD * c[3]! + c[1]!,
];
const inside = (c: readonly number[]): boolean => PLANES.every((f) => f(c) >= 0);

// A segment clipped to the clip volume (Liang-Barsky in homogeneous
// coordinates), or null when none of it is inside; `cutStart`/`cutEnd` say
// whether either end was moved, which breaks the stroke there.
function clipSegment(a: readonly number[], b: readonly number[]): { a: number[]; b: number[]; cutStart: boolean; cutEnd: boolean } | null {
  let t0 = 0;
  let t1 = 1;
  for (const plane of PLANES) {
    const fa = plane(a);
    const fb = plane(b);
    if (fa < 0 && fb < 0) return null;
    if (fa < 0) t0 = Math.max(t0, fa / (fa - fb));
    else if (fb < 0) t1 = Math.min(t1, fa / (fa - fb));
    if (t0 > t1) return null;
  }
  return { a: lerp4(a, b, t0), b: lerp4(a, b, t1), cutStart: t0 > 0, cutEnd: t1 < 1 };
}

function lerp4(a: readonly number[], b: readonly number[], t: number): [number, number, number, number] {
  return [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t, a[3]! + (b[3]! - a[3]!) * t];
}

// A font string with its pixel size multiplied by `k`.
function scaledFont(font: string, k: number): string {
  return font.replace(/(\d+(?:\.\d+)?)px/, (_m, n: string) => `${Number(n) * k}px`);
}

// What the overlay's world-unit drawing begins with: the head-on transform on
// a plain context, or projection on a projected one.
export function beginWorld(ctx: CanvasRenderingContext2D | ProjectedContext, cam: Camera, w: number, h: number): void {
  if (ctx instanceof ProjectedContext) {
    ctx.beginWorld(cam);
    return;
  }
  ctx.translate(w / 2, h / 2);
  const scale = cam.zoom * PIXELS_PER_METER;
  ctx.scale(scale, scale);
  ctx.translate(-cam.position.x, -cam.position.y);
}

// A path to fill or stroke later: a Path2D on a plain context, a recorded one
// on a projected one (a Path2D cannot be read back to be projected).
export function makePath(ctx: CanvasRenderingContext2D): Path2D {
  const p = ctx as unknown as CanvasRenderingContext2D | ProjectedContext;
  return (p instanceof ProjectedContext ? p.recordedPath() : new Path2D()) as unknown as Path2D;
}

// Draw what follows at depth `z` (projected contexts only; the head-on
// overlay is the plane and has no depth).
export function atDepth(ctx: CanvasRenderingContext2D, z: number): void {
  const p = ctx as unknown as CanvasRenderingContext2D | ProjectedContext;
  if (p instanceof ProjectedContext) p.atDepth(z);
}
