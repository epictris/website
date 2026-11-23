// The working mesh of a guide being sculpted (plans/sculpt-guides.md, "The
// working mesh"): a closed triangle mesh in the guide's own frame, edited in
// place by the brushes and by Dyntopo, and drawn straight from its arrays.
//
// - Vertices and triangles live in SLOTS: typed arrays with spare capacity, a
//   dead slot kept (a dead triangle's indices are 0, 0, 0, which the GPU
//   draws as nothing) and reused from a free list. The position, normal and
//   index arrays are the very arrays the 3D view uploads (editor/sculpt.ts),
//   with the slots written since the last upload listed in `gpu`.
// - Adjacency is each vertex's list of triangles; an edge's two triangles are
//   where its two vertices' lists meet. A closed, two-manifold mesh is assumed
//   (every stored guide is: manifold-3d made it, or validated it) and kept
//   by every operation here.
// - A JOURNAL records each slot's state before its first write in a stroke,
//   so a stroke is undone (and redone) slot by slot, whatever Dyntopo did to
//   the topology: Blender's sculpt undo, at the granularity of a slot rather
//   than a PBVH node.
// - The triangle grid (sculptGrid.ts) is kept in step: a triangle whose
//   vertex moved is re-binned before the next query (`sync`).

import type { SolidMesh } from "./meshBin";
import { TriGrid } from "./sculptGrid";

export interface SlotState {
  // Vertex slots: position and whether alive. Triangle slots: indices and
  // whether alive.
  v: Map<number, [number, number, number, number]>;
  t: Map<number, [number, number, number, number]>;
}

export interface SculptStep {
  before: SlotState;
  after: SlotState;
}

export class SculptMesh {
  pos: Float32Array;
  nrm: Float32Array;
  idx: Uint32Array;
  vAlive: Uint8Array;
  tAlive: Uint8Array;
  // How many slots are in use (alive or dead): the arrays past these are
  // spare.
  vCount = 0;
  tCount = 0;
  private vTris: number[][] = [];
  private freeV: number[] = [];
  private freeT: number[] = [];
  readonly grid = new TriGrid();
  // Triangles whose box may have changed since the grid last saw them.
  private stale = new Set<number>();
  // Slots written since the last upload; `grown` when the arrays were
  // reallocated (the view makes new buffers).
  readonly gpu = { v: new Set<number>(), t: new Set<number>(), grown: false };
  // Vertices whose normal needs recomputing (a neighbour moved).
  private normalsStale = new Set<number>();
  private journal: SlotState | null = null;

  private constructor(vCap: number, tCap: number) {
    this.pos = new Float32Array(vCap * 3);
    this.nrm = new Float32Array(vCap * 3);
    this.idx = new Uint32Array(tCap * 3);
    this.vAlive = new Uint8Array(vCap);
    this.tAlive = new Uint8Array(tCap);
  }

  // A mesh as a working mesh, its vertices as they are indexed (degenerate
  // triangles dropped). Not welded by position: every mesh handed here has
  // been through manifold-3d, which shares what is one vertex and keeps a
  // PINCH - two sheets touching at a point - as one vertex per sheet at the
  // same spot; welding those would join two fans at one vertex.
  static fromMesh(mesh: SolidMesh): SculptMesh {
    const nv = mesh.positions.length / 3;
    const nt = mesh.indices.length / 3;
    const out = new SculptMesh(Math.max(64, Math.ceil(nv * 1.5)), Math.max(64, Math.ceil(nt * 1.5)));
    for (let i = 0; i < nv; i++) out.addVertex(mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!);
    for (let t = 0; t < nt; t++) {
      const a = mesh.indices[t * 3]!, b = mesh.indices[t * 3 + 1]!, c = mesh.indices[t * 3 + 2]!;
      if (a !== b && b !== c && a !== c) out.addTri(a, b, c);
    }
    out.recomputeAllNormals();
    out.sync();
    out.gpu.grown = true;
    return out;
  }

  // The live mesh compacted: what is stored on a commit.
  toMesh(): SolidMesh {
    const map = new Int32Array(this.vCount).fill(-1);
    let nv = 0;
    for (let v = 0; v < this.vCount; v++) if (this.vAlive[v]) map[v] = nv++;
    const positions = new Float32Array(nv * 3);
    for (let v = 0; v < this.vCount; v++) {
      if (map[v]! < 0) continue;
      positions.set(this.pos.subarray(v * 3, v * 3 + 3), map[v]! * 3);
    }
    const tris: number[] = [];
    for (let t = 0; t < this.tCount; t++) {
      if (!this.tAlive[t]) continue;
      tris.push(map[this.idx[t * 3]!]!, map[this.idx[t * 3 + 1]!]!, map[this.idx[t * 3 + 2]!]!);
    }
    return { positions, indices: new Uint32Array(tris) };
  }

  get liveTriangles(): number {
    return this.tCount - this.freeT.length;
  }
  get liveVertices(): number {
    return this.vCount - this.freeV.length;
  }

  // --- the journal ------------------------------------------------------

  beginStep(): void {
    this.journal = { v: new Map(), t: new Map() };
  }
  // The stroke's step, or null if it touched nothing.
  endStep(): SculptStep | null {
    const before = this.journal;
    this.journal = null;
    if (!before || (!before.v.size && !before.t.size)) return null;
    return { before, after: this.capture(before) };
  }
  get recording(): boolean {
    return this.journal !== null;
  }
  // The current state of the slots `like` names.
  private capture(like: SlotState): SlotState {
    const out: SlotState = { v: new Map(), t: new Map() };
    for (const v of like.v.keys()) out.v.set(v, this.vState(v));
    for (const t of like.t.keys()) out.t.set(t, this.tState(t));
    return out;
  }
  private vState(v: number): [number, number, number, number] {
    return v < this.vCount ? [this.pos[v * 3]!, this.pos[v * 3 + 1]!, this.pos[v * 3 + 2]!, this.vAlive[v]!] : [0, 0, 0, 0];
  }
  private tState(t: number): [number, number, number, number] {
    return t < this.tCount ? [this.idx[t * 3]!, this.idx[t * 3 + 1]!, this.idx[t * 3 + 2]!, this.tAlive[t]!] : [0, 0, 0, 0];
  }
  private noteV(v: number): void {
    if (this.journal && !this.journal.v.has(v)) this.journal.v.set(v, this.vState(v));
  }
  private noteT(t: number): void {
    if (this.journal && !this.journal.t.has(t)) this.journal.t.set(t, this.tState(t));
  }

  // Put the slots back as `state` has them (an undo applies a step's
  // `before`, a redo its `after`).
  restore(state: SlotState): void {
    const touched = new Set<number>();
    for (const [t, s] of state.t) {
      this.ensureT(t);
      if (t < this.tCount && this.tAlive[t]) {
        for (let k = 0; k < 3; k++) touched.add(this.idx[t * 3 + k]!);
        this.unlinkTri(t);
      }
      this.idx[t * 3] = s[0];
      this.idx[t * 3 + 1] = s[1];
      this.idx[t * 3 + 2] = s[2];
      this.tAlive[t] = s[3];
      if (t >= this.tCount) this.tCount = t + 1;
      if (!s[3]) {
        this.idx.fill(0, t * 3, t * 3 + 3);
        this.grid.remove(t);
      }
      this.gpu.t.add(t);
    }
    for (const [v, s] of state.v) {
      this.ensureV(v);
      this.pos[v * 3] = s[0];
      this.pos[v * 3 + 1] = s[1];
      this.pos[v * 3 + 2] = s[2];
      this.vAlive[v] = s[3];
      if (v >= this.vCount) this.vCount = v + 1;
      if (!s[3]) this.vTris[v] = [];
      touched.add(v);
      this.gpu.v.add(v);
    }
    for (const [t, s] of state.t) {
      if (!s[3]) continue;
      for (let k = 0; k < 3; k++) {
        const v = this.idx[t * 3 + k]!;
        (this.vTris[v] ??= []).push(t);
        touched.add(v);
      }
      this.stale.add(t);
    }
    // Every vertex that moved re-bins its triangles too.
    for (const v of state.v.keys()) for (const t of this.vTris[v] ?? []) this.stale.add(t);
    this.freeV = [];
    for (let v = 0; v < this.vCount; v++) if (!this.vAlive[v]) this.freeV.push(v);
    this.freeT = [];
    for (let t = 0; t < this.tCount; t++) if (!this.tAlive[t]) this.freeT.push(t);
    for (const v of touched) this.touchNormals(v);
    this.updateNormals();
    this.sync();
  }

  // --- capacity -----------------------------------------------------------

  private ensureV(v: number): void {
    if (v < this.vAlive.length) return;
    const cap = Math.max(v + 1, this.vAlive.length * 2);
    const pos = new Float32Array(cap * 3);
    pos.set(this.pos);
    this.pos = pos;
    const nrm = new Float32Array(cap * 3);
    nrm.set(this.nrm);
    this.nrm = nrm;
    const alive = new Uint8Array(cap);
    alive.set(this.vAlive);
    this.vAlive = alive;
    this.gpu.grown = true;
  }
  private ensureT(t: number): void {
    if (t < this.tAlive.length) return;
    const cap = Math.max(t + 1, this.tAlive.length * 2);
    const idx = new Uint32Array(cap * 3);
    idx.set(this.idx);
    this.idx = idx;
    const alive = new Uint8Array(cap);
    alive.set(this.tAlive);
    this.tAlive = alive;
    this.gpu.grown = true;
  }

  // --- primitive edits (every write goes through these) -----------------

  addVertex(x: number, y: number, z: number): number {
    const v = this.freeV.length ? this.freeV.pop()! : this.vCount;
    this.noteV(v);
    this.ensureV(v);
    if (v === this.vCount) this.vCount++;
    this.pos[v * 3] = x;
    this.pos[v * 3 + 1] = y;
    this.pos[v * 3 + 2] = z;
    this.vAlive[v] = 1;
    this.vTris[v] = [];
    this.gpu.v.add(v);
    return v;
  }

  private killVertex(v: number): void {
    this.noteV(v);
    this.vAlive[v] = 0;
    this.vTris[v] = [];
    this.freeV.push(v);
    this.gpu.v.add(v);
  }

  addTri(a: number, b: number, c: number): number {
    const t = this.freeT.length ? this.freeT.pop()! : this.tCount;
    this.noteT(t);
    this.ensureT(t);
    if (t === this.tCount) this.tCount++;
    this.idx[t * 3] = a;
    this.idx[t * 3 + 1] = b;
    this.idx[t * 3 + 2] = c;
    this.tAlive[t] = 1;
    this.vTris[a]!.push(t);
    this.vTris[b]!.push(t);
    this.vTris[c]!.push(t);
    this.stale.add(t);
    this.gpu.t.add(t);
    return t;
  }

  private unlinkTri(t: number): void {
    for (let k = 0; k < 3; k++) {
      const list = this.vTris[this.idx[t * 3 + k]!];
      if (!list) continue;
      const at = list.indexOf(t);
      if (at >= 0) {
        list[at] = list[list.length - 1]!;
        list.pop();
      }
    }
  }

  private killTri(t: number): void {
    this.noteT(t);
    this.unlinkTri(t);
    this.idx.fill(0, t * 3, t * 3 + 3);
    this.tAlive[t] = 0;
    this.freeT.push(t);
    this.grid.remove(t);
    this.stale.delete(t);
    this.gpu.t.add(t);
  }

  // Triangle `t` given new corners (same slot).
  private setTri(t: number, a: number, b: number, c: number): void {
    this.noteT(t);
    this.unlinkTri(t);
    this.idx[t * 3] = a;
    this.idx[t * 3 + 1] = b;
    this.idx[t * 3 + 2] = c;
    this.vTris[a]!.push(t);
    this.vTris[b]!.push(t);
    this.vTris[c]!.push(t);
    this.stale.add(t);
    this.gpu.t.add(t);
  }

  setPos(v: number, x: number, y: number, z: number): void {
    this.noteV(v);
    this.pos[v * 3] = x;
    this.pos[v * 3 + 1] = y;
    this.pos[v * 3 + 2] = z;
    this.gpu.v.add(v);
    for (const t of this.vTris[v]!) this.stale.add(t);
    this.touchNormals(v);
  }

  // --- queries ------------------------------------------------------------

  trisOf(v: number): readonly number[] {
    return this.vTris[v] ?? [];
  }

  // The vertices sharing an edge with `v` (its one-ring), each once.
  ring(v: number, out: number[] = []): number[] {
    out.length = 0;
    for (const t of this.vTris[v]!) {
      for (let k = 0; k < 3; k++) {
        const w = this.idx[t * 3 + k]!;
        if (w !== v && !out.includes(w)) out.push(w);
      }
    }
    return out;
  }

  // The (one or two) triangles holding edge a-b.
  edgeTris(a: number, b: number): number[] {
    const out: number[] = [];
    for (const t of this.vTris[a]!) {
      const o = t * 3;
      if (this.idx[o] === b || this.idx[o + 1] === b || this.idx[o + 2] === b) out.push(t);
    }
    return out;
  }

  // The corner of triangle t that is neither a nor b.
  private opposite(t: number, a: number, b: number): number {
    for (let k = 0; k < 3; k++) {
      const w = this.idx[t * 3 + k]!;
      if (w !== a && w !== b) return w;
    }
    return -1;
  }

  // Whether triangle t runs a then b (its winding), else b then a.
  private runs(t: number, a: number, b: number): boolean {
    const o = t * 3;
    for (let k = 0; k < 3; k++) if (this.idx[o + k] === a && this.idx[o + ((k + 1) % 3)] === b) return true;
    return false;
  }

  // The (unnormalised) normal of triangle t: twice its area along it.
  triNormal(t: number, out: number[] = [0, 0, 0]): number[] {
    const p = this.pos;
    const a = this.idx[t * 3]! * 3, b = this.idx[t * 3 + 1]! * 3, c = this.idx[t * 3 + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    out[0] = uy * vz - uz * vy;
    out[1] = uz * vx - ux * vz;
    out[2] = ux * vy - uy * vx;
    return out;
  }

  edgeLength2(a: number, b: number): number {
    const p = this.pos;
    const dx = p[a * 3]! - p[b * 3]!, dy = p[a * 3 + 1]! - p[b * 3 + 1]!, dz = p[a * 3 + 2]! - p[b * 3 + 2]!;
    return dx * dx + dy * dy + dz * dz;
  }

  // --- normals --------------------------------------------------------------

  private touchNormals(v: number): void {
    this.normalsStale.add(v);
    for (const t of this.vTris[v] ?? []) for (let k = 0; k < 3; k++) this.normalsStale.add(this.idx[t * 3 + k]!);
  }

  // Area-weighted vertex normals for every vertex a write touched.
  updateNormals(): void {
    const n = [0, 0, 0];
    for (const v of this.normalsStale) {
      if (!this.vAlive[v]) continue;
      let x = 0, y = 0, z = 0;
      for (const t of this.vTris[v]!) {
        this.triNormal(t, n);
        x += n[0]!;
        y += n[1]!;
        z += n[2]!;
      }
      const l = Math.hypot(x, y, z) || 1;
      this.nrm[v * 3] = x / l;
      this.nrm[v * 3 + 1] = y / l;
      this.nrm[v * 3 + 2] = z / l;
      this.gpu.v.add(v);
    }
    this.normalsStale.clear();
  }

  recomputeAllNormals(): void {
    for (let v = 0; v < this.vCount; v++) if (this.vAlive[v]) this.normalsStale.add(v);
    this.updateNormals();
  }

  // --- the grid -------------------------------------------------------------

  // Re-bin every triangle that changed since the last query.
  sync(): void {
    const p = this.pos;
    for (const t of this.stale) {
      if (!this.tAlive[t]) continue;
      const a = this.idx[t * 3]! * 3, b = this.idx[t * 3 + 1]! * 3, c = this.idx[t * 3 + 2]! * 3;
      this.grid.set(
        t,
        Math.min(p[a]!, p[b]!, p[c]!), Math.min(p[a + 1]!, p[b + 1]!, p[c + 1]!), Math.min(p[a + 2]!, p[b + 2]!, p[c + 2]!),
        Math.max(p[a]!, p[b]!, p[c]!), Math.max(p[a + 1]!, p[b + 1]!, p[c + 1]!), Math.max(p[a + 2]!, p[b + 2]!, p[c + 2]!),
      );
    }
    this.stale.clear();
  }

  // The live triangles that come within `r` of point `c`.
  trisNear(c: readonly number[], r: number, out: number[] = []): number[] {
    this.sync();
    out.length = 0;
    const r2 = r * r;
    const q = [0, 0, 0];
    this.grid.queryBox(c[0]! - r, c[1]! - r, c[2]! - r, c[0]! + r, c[1]! + r, c[2]! + r, (t) => {
      if (!this.tAlive[t]) return;
      closestOnTri(this.pos, this.idx[t * 3]!, this.idx[t * 3 + 1]!, this.idx[t * 3 + 2]!, c, q);
      const dx = q[0]! - c[0]!, dy = q[1]! - c[1]!, dz = q[2]! - c[2]!;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(t);
    });
    return out;
  }

  // The live vertices within `r` of `c`.
  vertsNear(c: readonly number[], r: number, out: number[] = []): number[] {
    this.sync();
    out.length = 0;
    const r2 = r * r;
    const seen = new Set<number>();
    this.grid.queryBox(c[0]! - r, c[1]! - r, c[2]! - r, c[0]! + r, c[1]! + r, c[2]! + r, (t) => {
      if (!this.tAlive[t]) return;
      for (let k = 0; k < 3; k++) {
        const v = this.idx[t * 3 + k]!;
        if (seen.has(v)) continue;
        seen.add(v);
        const dx = this.pos[v * 3]! - c[0]!, dy = this.pos[v * 3 + 1]! - c[1]!, dz = this.pos[v * 3 + 2]! - c[2]!;
        if (dx * dx + dy * dy + dz * dz <= r2) out.push(v);
      }
    });
    return out;
  }

  // Where a ray first meets the surface (its parameter, the point, the
  // triangle), or null. Both faces count: a ray from inside still finds the
  // wall.
  raycast(o: readonly number[], d: readonly number[]): { t: number; point: number[]; tri: number } | null {
    this.sync();
    const hit = this.grid.raycast(o, d, (t) => (this.tAlive[t] ? rayTri(this.pos, this.idx[t * 3]!, this.idx[t * 3 + 1]!, this.idx[t * 3 + 2]!, o, d) : Infinity));
    if (hit.tri < 0) return null;
    return { t: hit.t, point: [o[0]! + d[0]! * hit.t, o[1]! + d[1]! * hit.t, o[2]! + d[2]! * hit.t], tri: hit.tri };
  }

  // The whole mesh replaced by another (a cut, a remesh), slot by slot so it
  // is one journalled step like any stroke.
  replaceWith(mesh: SolidMesh): void {
    for (let t = 0; t < this.tCount; t++) if (this.tAlive[t]) this.killTri(t);
    for (let v = 0; v < this.vCount; v++) if (this.vAlive[v]) this.killVertex(v);
    const nv = mesh.positions.length / 3;
    const map = new Int32Array(nv);
    for (let i = 0; i < nv; i++) map[i] = this.addVertex(mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!);
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = map[mesh.indices[t]!]!, b = map[mesh.indices[t + 1]!]!, c = map[mesh.indices[t + 2]!]!;
      if (a !== b && b !== c && a !== c) this.addTri(a, b, c);
    }
    for (let i = 0; i < nv; i++) this.normalsStale.add(map[i]!);
    this.updateNormals();
    this.sync();
  }

  // --- topology (Dyntopo) -------------------------------------------------

  // Split edge a-b at its midpoint: each of its two triangles becomes two.
  // Answers the new vertex, or -1 if a-b is not an edge with two triangles.
  splitEdge(a: number, b: number): number {
    const ts = this.edgeTris(a, b);
    if (ts.length !== 2) return -1;
    const p = this.pos;
    const m = this.addVertex((p[a * 3]! + p[b * 3]!) / 2, (p[a * 3 + 1]! + p[b * 3 + 1]!) / 2, (p[a * 3 + 2]! + p[b * 3 + 2]!) / 2);
    for (const t of ts) {
      // Written as (x, y, c) with x then y its winding along the edge.
      const fwd = this.runs(t, a, b);
      const x = fwd ? a : b;
      const y = fwd ? b : a;
      const c = this.opposite(t, a, b);
      this.setTri(t, x, m, c);
      this.addTri(m, y, c);
    }
    this.touchNormals(m);
    return m;
  }

  // Whether collapsing edge a-b into one vertex at `at` keeps the mesh a
  // closed two-manifold with no face turned over: the link condition (the
  // edge's two ends share exactly the two vertices opposite it), neither of
  // those left with fewer than three neighbours, and every triangle that
  // stays turned by less than 90 degrees.
  canCollapse(a: number, b: number, at: readonly number[]): boolean {
    const ts = this.edgeTris(a, b);
    if (ts.length !== 2) return false;
    const c = this.opposite(ts[0]!, a, b);
    const d = this.opposite(ts[1]!, a, b);
    if (c === d) return false;
    const ra = this.ring(a);
    const rb = this.ring(b, []);
    let shared = 0;
    for (const w of ra) if (rb.includes(w)) shared++;
    if (shared !== 2) return false;
    if (this.ring(c, []).length <= 3 || this.ring(d, []).length <= 3) return false;
    const before = [0, 0, 0];
    const p = this.pos;
    for (const v of [a, b]) {
      for (const t of this.vTris[v]!) {
        if (t === ts[0] || t === ts[1]) continue;
        this.triNormal(t, before);
        const save = [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!];
        p[v * 3] = at[0]!;
        p[v * 3 + 1] = at[1]!;
        p[v * 3 + 2] = at[2]!;
        const after = this.triNormal(t, [0, 0, 0]);
        p[v * 3] = save[0]!;
        p[v * 3 + 1] = save[1]!;
        p[v * 3 + 2] = save[2]!;
        if (before[0]! * after[0]! + before[1]! * after[1]! + before[2]! * after[2]! <= 0) return false;
      }
    }
    return true;
  }

  // Collapse edge a-b into a, standing at `at` (check `canCollapse` first).
  collapseEdge(a: number, b: number, at: readonly number[]): void {
    const ts = this.edgeTris(a, b);
    for (const t of ts) this.killTri(t);
    for (const t of [...this.vTris[b]!]) {
      const o = t * 3;
      this.setTri(t, this.idx[o] === b ? a : this.idx[o]!, this.idx[o + 1] === b ? a : this.idx[o + 1]!, this.idx[o + 2] === b ? a : this.idx[o + 2]!);
    }
    this.killVertex(b);
    this.setPos(a, at[0]!, at[1]!, at[2]!);
  }

  // Flip edge a-b to the other diagonal of its two triangles, c-d. Answers
  // false (and changes nothing) where c-d is an edge already or the flip
  // would turn a face over.
  flipEdge(a: number, b: number): boolean {
    const ts = this.edgeTris(a, b);
    if (ts.length !== 2) return false;
    const [t0, t1] = ts as [number, number];
    // t0 runs a -> b, t1 b -> a.
    const first = this.runs(t0, a, b) ? t0 : t1;
    const second = first === t0 ? t1 : t0;
    const c = this.opposite(first, a, b);
    const d = this.opposite(second, a, b);
    if (c === d || this.edgeTris(c, d).length) return false;
    // (a, b, c) and (b, a, d) become (c, d, b)... kept outward: (a, d, c) and (b, c, d).
    const n0 = this.triNormal(first, [0, 0, 0]);
    const n1 = this.triNormal(second, [0, 0, 0]);
    const sum = [n0[0]! + n1[0]!, n0[1]! + n1[1]!, n0[2]! + n1[2]!];
    const p = this.pos;
    const cross = (i: number, j: number, k: number): number[] => {
      const ux = p[j * 3]! - p[i * 3]!, uy = p[j * 3 + 1]! - p[i * 3 + 1]!, uz = p[j * 3 + 2]! - p[i * 3 + 2]!;
      const vx = p[k * 3]! - p[i * 3]!, vy = p[k * 3 + 1]! - p[i * 3 + 1]!, vz = p[k * 3 + 2]! - p[i * 3 + 2]!;
      return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    };
    const m0 = cross(a, d, c);
    const m1 = cross(b, c, d);
    const dot = (u: number[], v: number[]): number => u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
    if (dot(m0, sum) <= 0 || dot(m1, sum) <= 0) return false;
    this.setTri(first, a, d, c);
    this.setTri(second, b, c, d);
    for (const v of [a, b, c, d]) this.touchNormals(v);
    return true;
  }

  // Every edge, each once, as vertex pairs (lower slot first): for checks.
  edges(): [number, number][] {
    const out: [number, number][] = [];
    for (let t = 0; t < this.tCount; t++) {
      if (!this.tAlive[t]) continue;
      for (let k = 0; k < 3; k++) {
        const a = this.idx[t * 3 + k]!, b = this.idx[t * 3 + ((k + 1) % 3)]!;
        if (a < b) out.push([a, b]);
      }
    }
    return out;
  }

  // Whether every edge has exactly two triangles, running it opposite ways:
  // a closed, consistently wound two-manifold.
  isManifold(): boolean {
    const seen = new Map<number, number>();
    for (let t = 0; t < this.tCount; t++) {
      if (!this.tAlive[t]) continue;
      for (let k = 0; k < 3; k++) {
        const a = this.idx[t * 3 + k]!, b = this.idx[t * 3 + ((k + 1) % 3)]!;
        const kk = a * 4294967296 + b;
        seen.set(kk, (seen.get(kk) ?? 0) + 1);
      }
    }
    for (const [kk, n] of seen) {
      if (n !== 1) return false;
      const a = Math.floor(kk / 4294967296);
      const b = kk - a * 4294967296;
      if (seen.get(b * 4294967296 + a) !== 1) return false;
    }
    return true;
  }
}

// The closest point of triangle (a, b, c) to `p` (Ericson, Real-Time
// Collision Detection 5.1.5).
export function closestOnTri(pos: Float32Array, ia: number, ib: number, ic: number, p: readonly number[], out: number[]): number[] {
  const ax = pos[ia * 3]!, ay = pos[ia * 3 + 1]!, az = pos[ia * 3 + 2]!;
  const bx = pos[ib * 3]!, by = pos[ib * 3 + 1]!, bz = pos[ib * 3 + 2]!;
  const cx = pos[ic * 3]!, cy = pos[ic * 3 + 1]!, cz = pos[ic * 3 + 2]!;
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = p[0]! - ax, apy = p[1]! - ay, apz = p[2]! - az;
  const set = (x: number, y: number, z: number): number[] => {
    out[0] = x;
    out[1] = y;
    out[2] = z;
    return out;
  };
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(ax, ay, az);
  const bpx = p[0]! - bx, bpy = p[1]! - by, bpz = p[2]! - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return set(ax + abx * v, ay + aby * v, az + abz * v);
  }
  const cpx = p[0]! - cx, cpy = p[1]! - cy, cpz = p[2]! - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return set(ax + acx * w, ay + acy * w, az + acz * w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

// Where a ray meets triangle (a, b, c), either face, as its parameter, or
// Infinity (Möller-Trumbore).
export function rayTri(pos: Float32Array, ia: number, ib: number, ic: number, o: readonly number[], d: readonly number[]): number {
  const ax = pos[ia * 3]!, ay = pos[ia * 3 + 1]!, az = pos[ia * 3 + 2]!;
  const e1x = pos[ib * 3]! - ax, e1y = pos[ib * 3 + 1]! - ay, e1z = pos[ib * 3 + 2]! - az;
  const e2x = pos[ic * 3]! - ax, e2y = pos[ic * 3 + 1]! - ay, e2z = pos[ic * 3 + 2]! - az;
  const px = d[1]! * e2z - d[2]! * e2y, py = d[2]! * e2x - d[0]! * e2z, pz = d[0]! * e2y - d[1]! * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-18) return Infinity;
  const inv = 1 / det;
  const tx = o[0]! - ax, ty = o[1]! - ay, tz = o[2]! - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0]! * qx + d[1]! * qy + d[2]! * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= 0 ? t : Infinity;
}
