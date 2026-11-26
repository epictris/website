// THE VIEW CUBE (docs/editor.md, "The view cube"): the navigation gizmo in the
// top right of the viewport, as Blender's, Fusion's and Unity's are. A cube
// turned with the view, one labelled face per axis; a click on a face swings
// the camera to look at the level from that side. Under it, the lens:
// Perspective or Orthographic. Every workspace has it, 2D too since its
// head-on lock went (2026-11-26).
//
// Drawn on its own small canvas with the 2D context: six quads projected
// orthographically through the view's own basis (`poseBasis`), painted back to
// front, each label laid on its face by an affine transform so it turns and
// foreshortens with the cube.

import type { ViewProjection } from "../render3d/space";
import { poseBasis, type Vec3 } from "./visuals/viewPose";

export type CubeFace = "front" | "back" | "left" | "right" | "top" | "bottom";

// Each face's outward normal, the directions its label reads along (u to the
// right, v down, as the face is seen from outside, upright in its own view),
// and the view it stands for: the camera on that side looking back at the
// target. Front is the gameplay plane head on (three's +z is toward the
// camera); Top looks straight down with the front at the bottom of the
// screen, as Blender's top view does.
export const CUBE_FACES: readonly {
  face: CubeFace;
  label: string;
  n: Vec3;
  u: Vec3;
  v: Vec3;
  yaw: number;
  pitch: number;
}[] = [
  { face: "front", label: "Front", n: { x: 0, y: 0, z: 1 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: -1, z: 0 }, yaw: 0, pitch: 0 },
  { face: "back", label: "Back", n: { x: 0, y: 0, z: -1 }, u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: -1, z: 0 }, yaw: Math.PI, pitch: 0 },
  { face: "right", label: "Right", n: { x: 1, y: 0, z: 0 }, u: { x: 0, y: 0, z: -1 }, v: { x: 0, y: -1, z: 0 }, yaw: Math.PI / 2, pitch: 0 },
  { face: "left", label: "Left", n: { x: -1, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: -1, z: 0 }, yaw: -Math.PI / 2, pitch: 0 },
  { face: "top", label: "Top", n: { x: 0, y: 1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 }, yaw: 0, pitch: Math.PI / 2 },
  { face: "bottom", label: "Bottom", n: { x: 0, y: -1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: -1 }, yaw: 0, pitch: -Math.PI / 2 },
];

// The canvas's size, CSS pixels, and the cube's half side in them.
const SIZE = 104;
const HALF = 27;

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

// A clickable region: a face of the cube, or an arrow to one.
interface Hit {
  face: CubeFace;
  poly: [number, number][];
  arrow?: boolean;
}

export interface ViewCubeHost {
  // A face clicked: the view to swing to.
  face(face: CubeFace): void;
  projection(p: ViewProjection): void;
}

export class ViewCube {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly lensBtns = new Map<ViewProjection, HTMLButtonElement>();
  private yaw = NaN;
  private pitch = NaN;
  private hover: Hit | null = null;
  // Each visible face's outline on the canvas, front-most first, after the
  // arrows: what a pointer is tested against.
  private hits: Hit[] = [];

  constructor(private readonly host: ViewCubeHost) {
    this.el = document.createElement("div");
    this.el.className = "ed-viewnav";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "ed-viewcube";
    this.canvas.style.width = `${SIZE}px`;
    this.canvas.style.height = `${SIZE}px`;
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "View cube: click a face to look from that side");
    this.ctx = this.canvas.getContext("2d")!;
    this.canvas.addEventListener("pointermove", (e) => this.setHover(this.hitAt(e)));
    this.canvas.addEventListener("pointerleave", () => this.setHover(null));
    this.canvas.addEventListener("pointerdown", (e) => {
      // Never the editor's: a press here is not a click on the level.
      e.stopPropagation();
      e.preventDefault();
    });
    this.canvas.addEventListener("click", (e) => {
      const h = this.hitAt(e);
      if (h) this.host.face(h.face);
    });
    const seg = document.createElement("div");
    seg.className = "ed-seg ed-lens";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Lens");
    for (const [p, label, title] of [
      ["perspective", "Persp", "Perspective: the lens the level is played through (O toggles)"],
      ["orthographic", "Ortho", "Orthographic: no perspective, so geometry at any depth is drawn at the plane's scale and lines up exactly (O toggles)"],
    ] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ed-btn";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", () => this.host.projection(p));
      this.lensBtns.set(p, b);
      seg.appendChild(b);
    }
    this.el.append(this.canvas, seg);
  }

  setProjection(p: ViewProjection): void {
    for (const [k, b] of this.lensBtns) {
      b.classList.toggle("active", k === p);
      b.setAttribute("aria-pressed", String(k === p));
    }
  }

  // Per frame: redrawn only when the view has turned.
  setView(yaw: number, pitch: number): void {
    if (yaw === this.yaw && pitch === this.pitch) return;
    this.yaw = yaw;
    this.pitch = pitch;
    this.draw();
  }

  private setHover(h: Hit | null): void {
    if (h?.face === this.hover?.face && !!h?.arrow === !!this.hover?.arrow) return;
    this.hover = h;
    this.canvas.style.cursor = h ? "pointer" : "";
    this.canvas.title = h ? `${CUBE_FACES.find((c) => c.face === h.face)!.label} view` : "";
    this.draw();
  }

  private hitAt(e: MouseEvent): Hit | null {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return this.hits.find((h) => inside(h.poly, x, y)) ?? null;
  }

  private draw(): void {
    if (!Number.isFinite(this.yaw)) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(SIZE * dpr);
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    const { right, up, back } = poseBasis({ target: { x: 0, y: 0, z: 0 }, yaw: this.yaw, pitch: this.pitch, halfHeight: 1, fovYDeg: 60 });
    const c = SIZE / 2;
    // A point of the unit cube on the canvas (orthographic, y down).
    const at = (p: Vec3): [number, number] => [c + dot(p, right) * HALF, c - dot(p, up) * HALF];
    const vis = CUBE_FACES.map((f) => ({ f, facing: dot(f.n, back) }))
      .filter((v) => v.facing > 1e-3)
      .sort((a, b) => a.facing - b.facing);
    this.hits = [];
    // FACE ON, the other five faces are edge-on and cannot be clicked, so four
    // arrows round the cube (Fusion's ViewCube) each go to the face next to it
    // that way: the face whose normal is nearest the screen's right, left, up
    // or down.
    const aligned = vis.length > 0 && vis[vis.length - 1]!.facing > 0.97;
    const arrows: { face: CubeFace; poly: [number, number][] }[] = [];
    if (aligned) {
      const down = { x: -up.x, y: -up.y, z: -up.z };
      const left = { x: -right.x, y: -right.y, z: -right.z };
      const toward = (d: Vec3): CubeFace => CUBE_FACES.reduce((a, b) => (dot(b.n, d) > dot(a.n, d) ? b : a)).face;
      const R = HALF + 13;
      const W = 7;
      const H = 7;
      // Each arrow: its tip at R + H from the centre along the screen axis.
      for (const [sx, sy, d] of [[1, 0, right], [-1, 0, left], [0, -1, up], [0, 1, down]] as const) {
        const tip: [number, number] = [c + sx * (R + H), c + sy * (R + H)];
        const b1: [number, number] = [c + sx * R - sy * W, c + sy * R + sx * W];
        const b2: [number, number] = [c + sx * R + sy * W, c + sy * R - sx * W];
        arrows.push({ face: toward(d), poly: [tip, b1, b2] });
      }
    }
    for (const { f, facing } of vis) {
      // The face's corners: n ± u ± v.
      const corner = (su: number, sv: number): Vec3 => ({
        x: f.n.x + su * f.u.x + sv * f.v.x,
        y: f.n.y + su * f.u.y + sv * f.v.y,
        z: f.n.z + su * f.u.z + sv * f.v.z,
      });
      const poly = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].map(at);
      this.hits.unshift({ face: f.face, poly });
      const hovered = this.hover?.face === f.face && !this.hover.arrow;
      // Lit by how squarely it faces the viewer, so the cube reads as a solid.
      const shade = 0.55 + 0.45 * facing;
      ctx.beginPath();
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = hovered ? "#3d5a86" : `rgb(${Math.round(37 * shade + 10)}, ${Math.round(51 * shade + 12)}, ${Math.round(72 * shade + 16)})`;
      ctx.fill();
      ctx.strokeStyle = hovered ? "#96beff" : "#5a6f8f";
      ctx.lineWidth = 1;
      ctx.stroke();
      // The label, laid on the face: its u and v carried onto the canvas.
      if (facing < 0.25) continue;
      const [ox, oy] = at(f.n);
      const ux = dot(f.u, right) * HALF;
      const uy = -dot(f.u, up) * HALF;
      const vx = dot(f.v, right) * HALF;
      const vy = -dot(f.v, up) * HALF;
      ctx.save();
      ctx.transform(ux, uy, vx, vy, ox, oy);
      // In face units (the face is -1..1 each way).
      ctx.scale(1 / HALF, 1 / HALF);
      ctx.globalAlpha = Math.min(1, (facing - 0.25) / 0.35);
      ctx.fillStyle = hovered ? "#cee1ff" : "#cbccc6";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // The editor's own family (studio.css), small enough for "Bottom".
      ctx.font = `600 ${f.label.length > 5 ? 10 : 11}px ${getComputedStyle(this.canvas).fontFamily}`;
      ctx.fillText(f.label, 0, 0.5);
      ctx.restore();
    }
    for (const a of arrows) {
      const hovered = this.hover?.face === a.face && !!this.hover.arrow;
      ctx.beginPath();
      a.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = hovered ? "#96beff" : "#5a6f8f";
      ctx.fill();
    }
    // Arrows first: they lie outside the cube, and nothing else is there.
    this.hits.unshift(...arrows.map((a) => ({ ...a, arrow: true })));
  }
}

// Even-odd point in polygon.
function inside(poly: readonly [number, number][], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
