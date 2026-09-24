// A polygon drawn ON THE FACES of the scene's models, and the part of those
// faces it covers. The mushroom tool clicks an outline out on a rock (or any
// drawn model), and this turns it into the triangle soup the Blender patch
// generator grows mushrooms on.
//
// Everything here is in three.js WORLD space (x right, y up, z toward the
// camera, metres) and is editor-only: nothing reaches the sim.
//
// The outline is a loop of points on a curved surface, so "inside" is judged
// on its plane of best fit: every candidate face is projected along that
// plane's normal and kept where it lands inside the loop, faces toward the
// patch (so the back of a rock is not taken with its front) and lies within a
// band of the plane (so a far wall seen through the loop is not either). Faces
// are subdivided first, down to a step that scales with the outline, so a big
// low-poly facet is cut to the drawn edge rather than taken whole.
import * as THREE from "three";

export interface SurfacePoint {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  tag: unknown;
}

export interface SurfaceSelection {
  // World-space triangle soup, 9 floats per triangle.
  positions: Float32Array;
  triangles: number;
  area: number; // m²
}

export interface SurfaceOptions {
  // Steepest face kept, degrees from level ground. 90 keeps walls, and nothing
  // keeps an overhang: mushrooms grow up, so one under a ledge grows into it.
  maxSlopeDeg: number;
  maxTriangles: number;
}

interface Frame {
  origin: THREE.Vector3;
  n: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  loop: [number, number][];
  min: [number, number];
  max: [number, number];
  band: number;
  step: number;
}

// The outline's plane of best fit (Newell's method), oriented to agree with the
// surface it was clicked on, and the 2D loop on it.
function frameOf(outline: readonly SurfacePoint[]): Frame | null {
  if (outline.length < 3) return null;
  const origin = new THREE.Vector3();
  const facing = new THREE.Vector3();
  for (const p of outline) {
    origin.add(p.point);
    facing.add(p.normal);
  }
  origin.divideScalar(outline.length);
  const n = new THREE.Vector3();
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!.point;
    const b = outline[(i + 1) % outline.length]!.point;
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  if (n.lengthSq() < 1e-12) n.copy(facing);
  if (n.lengthSq() < 1e-12) return null;
  n.normalize();
  if (n.dot(facing) < 0) n.negate();
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(n.dot(u)) > 0.9) u.set(0, 1, 0);
  u.sub(n.clone().multiplyScalar(n.dot(u))).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  const loop: [number, number][] = [];
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  let dev = 0;
  const d = new THREE.Vector3();
  for (const p of outline) {
    d.subVectors(p.point, origin);
    const q: [number, number] = [d.dot(u), d.dot(v)];
    loop.push(q);
    min[0] = Math.min(min[0], q[0]);
    min[1] = Math.min(min[1], q[1]);
    max[0] = Math.max(max[0], q[0]);
    max[1] = Math.max(max[1], q[1]);
    dev = Math.max(dev, Math.abs(d.dot(n)));
  }
  const diameter = Math.hypot(max[0] - min[0], max[1] - min[1]);
  if (diameter < 1e-3) return null;
  return {
    origin,
    n,
    u,
    v,
    loop,
    min,
    max,
    band: dev + Math.max(0.05, diameter * 0.35),
    step: Math.min(0.1, Math.max(0.01, diameter / 48)),
  };
}

function insideLoop(loop: readonly [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i]!;
    const [xj, yj] = loop[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The faces of `meshes` the outline covers, cut to it.
export function selectSurface(
  meshes: readonly THREE.Mesh[],
  outline: readonly SurfacePoint[],
  opts: SurfaceOptions,
): SurfaceSelection | null {
  const f = frameOf(outline);
  if (!f) return null;
  const minUp = Math.cos(THREE.MathUtils.degToRad(Math.min(90, Math.max(0, opts.maxSlopeDeg))));
  for (let step = f.step; ; step *= 1.5) {
    const out = collect(meshes, f, step, minUp, opts.maxTriangles);
    if (out) return out.triangles ? out : null;
  }
}

function collect(
  meshes: readonly THREE.Mesh[],
  f: Frame,
  step: number,
  minUp: number,
  maxTriangles: number,
): SurfaceSelection | null {
  const soup: number[] = [];
  let area = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const coord = (p: THREE.Vector3): [number, number, number] => {
    tmp.subVectors(p, f.origin);
    return [tmp.dot(f.u), tmp.dot(f.v), tmp.dot(f.n)];
  };
  const step2 = step * step;
  let overflow = false;

  const emit = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, depth: number): void => {
    if (overflow) return;
    const longest = Math.max(p.distanceToSquared(q), q.distanceToSquared(r), r.distanceToSquared(p));
    if (longest > step2 && depth < 8) {
      const pq = p.clone().add(q).multiplyScalar(0.5);
      const qr = q.clone().add(r).multiplyScalar(0.5);
      const rp = r.clone().add(p).multiplyScalar(0.5);
      emit(p, pq, rp, depth + 1);
      emit(pq, q, qr, depth + 1);
      emit(rp, qr, r, depth + 1);
      emit(pq, qr, rp, depth + 1);
      return;
    }
    const m = p.clone().add(q).add(r).divideScalar(3);
    const [x, y, z] = coord(m);
    if (Math.abs(z) > f.band || !insideLoop(f.loop, x, y)) return;
    if (soup.length >= maxTriangles * 9) {
      overflow = true;
      return;
    }
    soup.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
    e1.subVectors(q, p);
    e2.subVectors(r, p);
    area += nrm.crossVectors(e1, e2).length() / 2;
  };

  for (const mesh of meshes) {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    mesh.updateWorldMatrix(true, false);
    const world = mesh.matrixWorld;
    const mirrored = world.determinant() < 0;
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, ia).applyMatrix4(world);
      b.fromBufferAttribute(pos, ib).applyMatrix4(world);
      c.fromBufferAttribute(pos, ic).applyMatrix4(world);
      const ca = coord(a), cb = coord(b), cc = coord(c);
      // Wholly to one side of the loop's box or the band: nothing of it is in.
      if (
        (ca[0] < f.min[0] && cb[0] < f.min[0] && cc[0] < f.min[0]) ||
        (ca[0] > f.max[0] && cb[0] > f.max[0] && cc[0] > f.max[0]) ||
        (ca[1] < f.min[1] && cb[1] < f.min[1] && cc[1] < f.min[1]) ||
        (ca[1] > f.max[1] && cb[1] > f.max[1] && cc[1] > f.max[1]) ||
        (ca[2] < -f.band && cb[2] < -f.band && cc[2] < -f.band) ||
        (ca[2] > f.band && cb[2] > f.band && cc[2] > f.band)
      ) continue;
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      nrm.crossVectors(e1, e2);
      if (nrm.lengthSq() < 1e-14) continue;
      nrm.normalize();
      if (mirrored) nrm.negate();
      // Toward the patch, and not steeper than asked (up is +y).
      if (nrm.dot(f.n) < 0.15 || nrm.y < minUp - 1e-6) continue;
      emit(a.clone(), b.clone(), c.clone(), 0);
      if (overflow) return null;
    }
  }
  return { positions: new Float32Array(soup), triangles: soup.length / 9, area };
}

// The outline and the faces it covers, drawn IN the scene so they sit on the
// model at any orbit and through either lens. Nothing here can be picked.
export class SurfaceDraftView {
  readonly group = new THREE.Group();
  private readonly line: THREE.Line;
  private readonly dots: THREE.Points;
  private readonly fill: THREE.Mesh;

  constructor() {
    const noPick = (o: THREE.Object3D): void => {
      o.raycast = () => undefined;
      o.renderOrder = 10;
      o.frustumCulled = false;
    };
    this.line = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffa640, depthTest: false, transparent: true }),
    );
    this.dots = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: 0xffd080, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }),
    );
    this.fill = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0x62e0ff,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    for (const o of [this.line, this.dots, this.fill]) {
      noPick(o);
      this.group.add(o);
    }
    this.group.name = "surface-draft";
  }

  // `cursor` is where the next vertex would go, drawn as a rubber band.
  update(
    points: readonly SurfacePoint[],
    closed: boolean,
    cursor: THREE.Vector3 | null,
    selection: SurfaceSelection | null,
  ): void {
    const lift = (p: SurfacePoint): THREE.Vector3 => p.point.clone().addScaledVector(p.normal, 0.004);
    const loop = points.map(lift);
    if (closed && loop.length) loop.push(loop[0]!.clone());
    else if (cursor && loop.length) loop.push(cursor);
    // Fresh geometry each time rather than a resized attribute: a buffer that
    // changes length after upload is not something WebGL resizes in place.
    const swap = (o: THREE.Line | THREE.Points | THREE.Mesh, geo: THREE.BufferGeometry): void => {
      o.geometry.dispose();
      o.geometry = geo;
    };
    swap(this.line, new THREE.BufferGeometry().setFromPoints(loop));
    swap(this.dots, new THREE.BufferGeometry().setFromPoints(points.map(lift)));
    const fill = new THREE.BufferGeometry();
    if (selection) fill.setAttribute("position", new THREE.BufferAttribute(selection.positions, 3));
    swap(this.fill, fill);
    this.group.visible = points.length > 0;
  }

  dispose(): void {
    for (const o of [this.line, this.dots, this.fill]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
  }
}
