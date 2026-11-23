// The sculpt brushes (plans/sculpt-guides.md, "Draw", "Grab"), Blender's,
// on a working mesh (sculptMesh.ts). Pure geometry: the editor's sculpt mode
// (editor/sculpt.ts) turns pointer moves into dabs and grab moves.
//
// HOW A BRUSH FEELS IS NOT SETTLED. The rates below are first guesses, to be
// played (rope/CLAUDE.md, "Validate the behaviour before writing the cases"):
// nothing holds them yet.

import type { SculptMesh } from "./sculptMesh";

// Blender's default falloff, smooth: 1 at the centre, 0 at the radius, flat
// at both.
export function falloff(d: number, r: number): number {
  const t = d / r;
  if (t >= 1) return 0;
  if (t <= 0) return 1;
  return 1 - t * t * (3 - 2 * t);
}

// How far one Draw dab at strength 1 moves the centre, as a fraction of the
// radius. Dabs are spaced at DAB_SPACING of the radius, so a point the brush
// passes over takes about 2 / DAB_SPACING dabs at half weight on average: at
// the default strength 0.5 a pass raises the middle of its track by about a
// quarter of the radius.
export const DRAW_RATE = 0.05;
// How far one Smooth dab at strength 1 takes a vertex toward its neighbours'
// mean.
export const SMOOTH_RATE = 0.5;
// Dabs along a stroke, as a fraction of the radius (Blender's spacing, 10%).
export const DAB_SPACING = 0.1;

const scratch: number[] = [];

// The brush's area normal: the falloff-weighted mean of the vertex normals
// under it, so a dab across an edge moves both sides one way rather than
// tearing the edge apart. Null where nothing is under the brush.
export function areaNormal(mesh: SculptMesh, verts: readonly number[], c: readonly number[], r: number): number[] | null {
  let x = 0, y = 0, z = 0;
  for (const v of verts) {
    const w = falloff(dist(mesh, v, c), r);
    x += mesh.nrm[v * 3]! * w;
    y += mesh.nrm[v * 3 + 1]! * w;
    z += mesh.nrm[v * 3 + 2]! * w;
  }
  const l = Math.hypot(x, y, z);
  return l > 1e-12 ? [x / l, y / l, z / l] : null;
}

function dist(mesh: SculptMesh, v: number, c: readonly number[]): number {
  return Math.hypot(mesh.pos[v * 3]! - c[0]!, mesh.pos[v * 3 + 1]! - c[1]!, mesh.pos[v * 3 + 2]! - c[2]!);
}

// One Draw dab: the vertices within `r` of `c` pushed along the area normal
// (`sign` 1 builds up, -1 digs in: Ctrl), by strength x falloff x radius x
// DRAW_RATE.
export function drawDab(mesh: SculptMesh, c: readonly number[], r: number, strength: number, sign: 1 | -1): void {
  const verts = mesh.vertsNear(c, r, scratch);
  const n = areaNormal(mesh, verts, c, r);
  if (!n) return;
  const k = sign * strength * r * DRAW_RATE;
  for (const v of verts) {
    const w = falloff(dist(mesh, v, c), r) * k;
    if (!w) continue;
    mesh.setPos(v, mesh.pos[v * 3]! + n[0]! * w, mesh.pos[v * 3 + 1]! + n[1]! * w, mesh.pos[v * 3 + 2]! + n[2]! * w);
  }
  mesh.updateNormals();
}

// One Smooth dab: each vertex within `r` of `c` toward its neighbours' mean
// (Laplacian, all moved from the same before-positions), by strength x
// falloff x SMOOTH_RATE.
export function smoothDab(mesh: SculptMesh, c: readonly number[], r: number, strength: number): void {
  const verts = [...mesh.vertsNear(c, r, scratch)];
  const ring: number[] = [];
  const to = new Float64Array(verts.length * 3);
  verts.forEach((v, i) => {
    mesh.ring(v, ring);
    let x = 0, y = 0, z = 0;
    for (const w of ring) {
      x += mesh.pos[w * 3]!;
      y += mesh.pos[w * 3 + 1]!;
      z += mesh.pos[w * 3 + 2]!;
    }
    const k = ring.length ? falloff(dist(mesh, v, c), r) * strength * SMOOTH_RATE : 0;
    const n = ring.length || 1;
    to[i * 3] = mesh.pos[v * 3]! + (x / n - mesh.pos[v * 3]!) * k;
    to[i * 3 + 1] = mesh.pos[v * 3 + 1]! + (y / n - mesh.pos[v * 3 + 1]!) * k;
    to[i * 3 + 2] = mesh.pos[v * 3 + 2]! + (z / n - mesh.pos[v * 3 + 2]!) * k;
  });
  verts.forEach((v, i) => mesh.setPos(v, to[i * 3]!, to[i * 3 + 1]!, to[i * 3 + 2]!));
  mesh.updateNormals();
}

// The dab centres along a stroke from `a` to `b` (screen or world, any
// space), at `spacing` apart, carrying the distance left over from the last
// segment in `carry` so the dabs stay evenly spaced across pointer moves.
export function dabsAlong(a: readonly number[], b: readonly number[], spacing: number, carry: { left: number }): number[][] {
  const out: number[][] = [];
  const d = Math.hypot(...b.map((v, i) => v - a[i]!));
  if (!(spacing > 0) || !(d > 0)) return out;
  let s = carry.left;
  while (s <= d) {
    out.push(a.map((v, i) => v + ((b[i]! - v) * s) / d));
    s += spacing;
  }
  carry.left = s - d;
  return out;
}

// GRAB: at the press, the vertices within the radius of the hit taken with
// their falloff weights and where they stood; each move sets them to where
// they stood plus weight x the pointer's displacement, so a long drag never
// accumulates error. A vertex Dyntopo adds mid-grab between two taken (or one
// taken and one not) is taken too, its start and weight the mean of its
// ends' (`split`): a straight interpolation, which is what the midpoint is.
export class GrabStroke {
  private readonly taken = new Map<number, [number, number, number, number]>();

  constructor(private readonly mesh: SculptMesh, c: readonly number[], r: number) {
    for (const v of mesh.vertsNear(c, r, [])) {
      const w = falloff(dist(mesh, v, c), r);
      if (w > 0) this.taken.set(v, [mesh.pos[v * 3]!, mesh.pos[v * 3 + 1]!, mesh.pos[v * 3 + 2]!, w]);
    }
  }

  get size(): number {
    return this.taken.size;
  }

  move(delta: readonly number[]): void {
    for (const [v, [x, y, z, w]] of this.taken) {
      if (!this.mesh.vAlive[v]) continue;
      this.mesh.setPos(v, x + delta[0]! * w, y + delta[1]! * w, z + delta[2]! * w);
    }
    this.mesh.updateNormals();
  }

  // Dyntopo split edge a-b at m, given the displacement the grab has now.
  split(a: number, b: number, m: number, delta: readonly number[]): void {
    const of = (v: number): [number, number, number, number] => {
      const t = this.taken.get(v);
      if (t) return t;
      const p = this.mesh.pos;
      return [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!, 0];
    };
    const ea = of(a);
    const eb = of(b);
    if (!ea[3] && !eb[3]) return;
    const s: [number, number, number, number] = [(ea[0] + eb[0]) / 2, (ea[1] + eb[1]) / 2, (ea[2] + eb[2]) / 2, (ea[3] + eb[3]) / 2];
    this.taken.set(m, s);
    this.mesh.setPos(m, s[0] + delta[0]! * s[3], s[1] + delta[1]! * s[3], s[2] + delta[2]! * s[3]);
  }
}
