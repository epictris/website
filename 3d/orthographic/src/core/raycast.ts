// Rays through the camera frame and what they hit: picking in the editor, and
// measuring on the server. Pure; meshes come from the caller (the editor's
// installed meshes, or ones built on the server).

import { cameraMatrices } from "./camera";
import { vec } from "./math";
import type { Mesh } from "./mesher";
import { type ImageSize, imageToFrame, overlayGeometry } from "./overlay";
import type { Camera, EditorState, Point, SceneObject, Vec3 } from "./types";

export interface Ray {
  origin: Vec3;
  /** Unit length. */
  dir: Vec3;
}

export type MeshOf = (e: SceneObject) => Mesh | undefined;

/**
 * The ray through a point of the camera frame: (px, py) in pixels of a frame
 * width x height pixels, origin top-left (a pixel's centre is at +0.5).
 */
export function frameRay(camera: Camera, px: number, py: number, width: number, height: number): Ray {
  const m = cameraMatrices(camera);
  const p = m.projection;
  const nx = (2 * px) / width - 1;
  const ny = 1 - (2 * py) / height;
  // View-space direction for NDC (nx, ny) at z = -1, off-axis terms included.
  const vx = (nx + p[8]) / p[0];
  const vy = (ny + p[9]) / p[5];
  const dir = vec.norm(vec.add(m.forward, vec.add(vec.mul(m.right, vx), vec.mul(m.up, vy))));
  return { origin: [...camera.position], dir };
}

/** Where a world point lands in a frame of width x height pixels, and its depth along the view axis (null behind the camera). */
export function projectPoint(camera: Camera, p: Vec3, width: number, height: number): [number, number, number] | null {
  const vp = cameraMatrices(camera).vp;
  const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  if (w <= 1e-12) return null;
  const x = (vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / w;
  const y = (vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / w;
  return [(x * 0.5 + 0.5) * width, (-y * 0.5 + 0.5) * height, w];
}

/** Entry distance of a ray into the unit box, or null when it misses. */
function rayBox(origin: Vec3, dir: Vec3): number | null {
  let lo = 0;
  let hi = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dir[a]) < 1e-12) {
      if (origin[a] < 0 || origin[a] > 1) return null;
    } else {
      let x = -origin[a] / dir[a];
      let y = (1 - origin[a]) / dir[a];
      if (x > y) [x, y] = [y, x];
      lo = Math.max(lo, x);
      hi = Math.min(hi, y);
      if (lo > hi) return null;
    }
  }
  return lo;
}

/** Distance along the ray to a triangle (Möller-Trumbore), Infinity on a miss. */
function rayTriangle(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const e1 = vec.sub(b, a);
  const e2 = vec.sub(c, a);
  const p = vec.cross(d, e2);
  const det = vec.dot(e1, p);
  if (Math.abs(det) < 1e-18) return Infinity;
  const inv = 1 / det;
  const tv = vec.sub(o, a);
  const u = vec.dot(tv, p) * inv;
  if (u < 0 || u > 1) return Infinity;
  const q = vec.cross(tv, e1);
  const v = vec.dot(d, q) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t = vec.dot(e2, q) * inv;
  return t > 0 ? t : Infinity;
}

export interface Hit {
  id: string;
  /** Distance from the ray's origin, metres. */
  distance: number;
  point: Vec3;
  /** The surface's outward normal, unit length. */
  normal: Vec3;
}

/** The nearest surface a ray meets within [near, far], or null. */
export function raycast(objects: SceneObject[], meshOf: MeshOf, ray: Ray, near = 0, far = Infinity): Hit | null {
  let best: Hit | null = null;
  let nearest = far;
  for (const e of objects) {
    // The ray in the object's unit box, where the quantised vertices live; t is the same in both.
    const o = ray.origin.map((x, i) => (x - e.min[i]) / e.size[i]) as Vec3;
    const d = ray.dir.map((x, i) => x / e.size[i]) as Vec3;
    const tBox = rayBox(o, d);
    if (tBox === null || tBox > nearest) continue;
    const mesh = meshOf(e);
    if (!mesh) continue;
    const p = mesh.pos;
    const idx = mesh.indices;
    const vtx = (i: number): Vec3 => [p[i * 3] / 65535, p[i * 3 + 1] / 65535, p[i * 3 + 2] / 65535];
    for (let j = 0; j < idx.length; j += 3) {
      const a = vtx(idx[j]);
      const b = vtx(idx[j + 1]);
      const c = vtx(idx[j + 2]);
      const t = rayTriangle(o, d, a, b, c);
      if (t < nearest && t >= near) {
        nearest = t;
        // Unit-box normal to world: divide by the box's size.
        const n = vec.cross(vec.sub(b, a), vec.sub(c, a)).map((x, i) => x / e.size[i]) as Vec3;
        best = {
          id: e.id,
          distance: t,
          point: vec.add(ray.origin, vec.mul(ray.dir, t)),
          normal: vec.norm(n),
        };
      }
    }
  }
  return best;
}

// ---- Measuring the picture ---------------------------------------------------------------

export type PixelSpace = "frame" | "reference";

export interface FrameHit extends Hit {
  /** Distance along the camera's view axis, metres. */
  depth: number;
}

/**
 * A pixel as a point of the camera frame: `frame` pixels are the camera
 * frame's (camera.frame wide), `reference` pixels the perspective reference
 * image's own. Null when there is no reference to place them by.
 */
export function framePixel(s: EditorState, p: Point, space: PixelSpace, image: ImageSize | undefined): Point | null {
  if (space === "frame") return p;
  const ref = s.references.perspective;
  if (!ref || !image) return null;
  return imageToFrame(overlayGeometry(s.camera.frame[0], s.camera.frame[1], ref, image), image, p);
}

/** What a frame pixel sees: the nearest visible surface, or null. */
export function hitAt(s: EditorState, meshOf: MeshOf, p: Point, objects = s.objects.filter((e) => e.visible)) {
  const c = s.camera;
  const ray = frameRay(c, p[0], p[1], c.frame[0], c.frame[1]);
  const hit = raycast(objects, meshOf, ray, 0, c.far);
  if (!hit) return null;
  const forward = cameraMatrices(c).forward;
  return { ...hit, depth: hit.distance * vec.dot(ray.dir, forward) } as FrameHit;
}

/** The world point on a frame pixel's ray at a depth along the view axis. */
export function pointAtDepth(s: EditorState, p: Point, depth: number): Vec3 {
  const c = s.camera;
  const ray = frameRay(c, p[0], p[1], c.frame[0], c.frame[1]);
  const along = vec.dot(ray.dir, cameraMatrices(c).forward);
  return vec.add(ray.origin, vec.mul(ray.dir, depth / along));
}
