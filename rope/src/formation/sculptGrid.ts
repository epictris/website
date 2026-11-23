// The spatial index sculpting asks (plans/sculpt-guides.md): which triangles
// are near a brush, and which one a ray from the pointer meets first.
//
// A MULTI-LEVEL HASH GRID of triangles: a triangle is kept at the level whose
// cell is at least its bounding box's largest side, in the (at most 2x2x2)
// cells that box overlaps, so a 2 m face of a box primitive and a 2 cm one a
// dab has just split are each a handful of entries. A triangle that moves or
// is replaced is re-binned on its own, in O(1).
//
// A query asks each level that holds anything, in whichever way is cheaper
// there: the cells its box covers, or - where that is more cells than the
// level has triangles (a few stray small ones, under a big brush) - the
// level's triangles one by one, by the cells they cover. Measured 2026-11-23:
// walking the cells alone spent 1.15 s of a 1.3 s stroke on 4 mm cells.
//
// Why not a BVH (three-mesh-bvh, which the plan first named): Dyntopo adds
// and removes triangles on every dab, and a BVH can only be refit (bounds
// grown in place) for moved vertices, not for new triangles; a rebuild of a
// 300k-triangle BVH is ~100 ms. Blender's PBVH splits its leaf nodes as
// Dyntopo fills them for the same reason.

// Cell side at level 0, metres. Each level up doubles it. A cell index is
// held in 16 bits a side, so level 0 spans +-131 m about the origin.
const BASE = 0.004;
const LEVELS = 24;
const HALF = 32768;

const key = (level: number, i: number, j: number, k: number): number =>
  level * 281474976710656 + (i + HALF) * 4294967296 + (j + HALF) * 65536 + (k + HALF);

export class TriGrid {
  private readonly cells = new Map<number, number[]>();
  // Per triangle slot: its level and the first and last cell on each axis
  // (-1 level: not in the grid), and where it is in its level's list.
  private where = new Int32Array(0);
  private slot = new Int32Array(0);
  private readonly levels: number[][] = Array.from({ length: LEVELS }, () => []);
  private stamp = new Uint32Array(0);
  private stampNow = 1;
  // What every triangle ever binned spans (grown, never shrunk): where a ray
  // is clipped to.
  readonly min = [Infinity, Infinity, Infinity];
  readonly max = [-Infinity, -Infinity, -Infinity];

  private ensure(t: number): void {
    if (t < this.stamp.length) return;
    const n = Math.max(t + 1, this.stamp.length * 2, 1024);
    const where = new Int32Array(n * 7).fill(-1);
    where.set(this.where);
    this.where = where;
    const slot = new Int32Array(n);
    slot.set(this.slot);
    this.slot = slot;
    const stamp = new Uint32Array(n);
    stamp.set(this.stamp);
    this.stamp = stamp;
  }

  // Bin triangle `t` by its box (re-binned if it was in already).
  set(t: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.ensure(t);
    const ext = Math.max(x1 - x0, y1 - y0, z1 - z0);
    let level = ext <= BASE ? 0 : Math.ceil(Math.log2(ext / BASE));
    if (level >= LEVELS) level = LEVELS - 1;
    const cs = BASE * 2 ** level;
    const clamp = (v: number): number => Math.max(-HALF, Math.min(HALF - 1, Math.floor(v / cs)));
    const i0 = clamp(x0), j0 = clamp(y0), k0 = clamp(z0);
    const i1 = clamp(x1), j1 = clamp(y1), k1 = clamp(z1);
    const w = this.where;
    const o = t * 7;
    if (w[o] === level && w[o + 1] === i0 && w[o + 2] === j0 && w[o + 3] === k0 && w[o + 4] === i1 && w[o + 5] === j1 && w[o + 6] === k1) return;
    this.remove(t);
    w[o] = level;
    w[o + 1] = i0;
    w[o + 2] = j0;
    w[o + 3] = k0;
    w[o + 4] = i1;
    w[o + 5] = j1;
    w[o + 6] = k1;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (let k = k0; k <= k1; k++) {
          const kk = key(level, i, j, k);
          const list = this.cells.get(kk);
          if (list) list.push(t);
          else this.cells.set(kk, [t]);
        }
      }
    }
    const list = this.levels[level]!;
    this.slot[t] = list.length;
    list.push(t);
    if (x0 < this.min[0]!) this.min[0] = x0;
    if (y0 < this.min[1]!) this.min[1] = y0;
    if (z0 < this.min[2]!) this.min[2] = z0;
    if (x1 > this.max[0]!) this.max[0] = x1;
    if (y1 > this.max[1]!) this.max[1] = y1;
    if (z1 > this.max[2]!) this.max[2] = z1;
  }

  remove(t: number): void {
    if (t * 7 >= this.where.length) return;
    const w = this.where;
    const o = t * 7;
    const level = w[o]!;
    if (level < 0) return;
    for (let i = w[o + 1]!; i <= w[o + 4]!; i++) {
      for (let j = w[o + 2]!; j <= w[o + 5]!; j++) {
        for (let k = w[o + 3]!; k <= w[o + 6]!; k++) {
          const kk = key(level, i, j, k);
          const list = this.cells.get(kk);
          if (!list) continue;
          const at = list.indexOf(t);
          if (at >= 0) {
            list[at] = list[list.length - 1]!;
            list.pop();
          }
          if (!list.length) this.cells.delete(kk);
        }
      }
    }
    w[o] = -1;
    const list = this.levels[level]!;
    const at = this.slot[t]!;
    const last = list.pop()!;
    if (last !== t) {
      list[at] = last;
      this.slot[last] = at;
    }
  }

  // Every triangle whose cells meet the box, each once.
  queryBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, visit: (t: number) => void): void {
    const now = this.nextStamp();
    const w = this.where;
    for (let level = 0; level < LEVELS; level++) {
      const members = this.levels[level]!;
      if (!members.length) continue;
      const cs = BASE * 2 ** level;
      const i0 = Math.floor(x0 / cs), j0 = Math.floor(y0 / cs), k0 = Math.floor(z0 / cs);
      const i1 = Math.floor(x1 / cs), j1 = Math.floor(y1 / cs), k1 = Math.floor(z1 / cs);
      const cells = (i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1);
      if (cells > members.length) {
        // Fewer triangles than cells: each by its own cell range.
        for (const t of members) {
          const o = t * 7;
          if (w[o + 4]! < i0 || w[o + 1]! > i1 || w[o + 5]! < j0 || w[o + 2]! > j1 || w[o + 6]! < k0 || w[o + 3]! > k1) continue;
          this.stamp[t] = now;
          visit(t);
        }
        continue;
      }
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          for (let k = k0; k <= k1; k++) {
            const list = this.cells.get(key(level, i, j, k));
            if (!list) continue;
            for (const t of list) {
              if (this.stamp[t] === now) continue;
              this.stamp[t] = now;
              visit(t);
            }
          }
        }
      }
    }
  }

  // The nearest triangle a ray meets: `hit(t)` answers the ray parameter at
  // which it meets triangle t, or Infinity. Each level is walked cell by cell
  // (Amanatides & Woo) inside the grid's box, stopping once the nearest hit
  // so far is nearer than the next cell - or, where the level holds fewer
  // triangles than the walk would visit cells, its triangles are tried one by
  // one.
  raycast(o: readonly number[], d: readonly number[], hit: (t: number) => number): { t: number; tri: number } {
    let best = { t: Infinity, tri: -1 };
    // The ray clipped to the box everything stands in.
    let t0 = 0;
    let t1 = Infinity;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]!) < 1e-12) {
        if (o[a]! < this.min[a]! || o[a]! > this.max[a]!) return best;
        continue;
      }
      let ta = (this.min[a]! - o[a]!) / d[a]!;
      let tb = (this.max[a]! - o[a]!) / d[a]!;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
    }
    if (!(t0 <= t1)) return best;
    const now = this.nextStamp();
    const len = Math.hypot(d[0]!, d[1]!, d[2]!);
    for (let level = 0; level < LEVELS; level++) {
      const members = this.levels[level]!;
      if (!members.length) continue;
      const cs = BASE * 2 ** level;
      if (((t1 - t0) * len * 3) / cs > members.length) {
        for (const tri of members) {
          const th = hit(tri);
          if (th < best.t && th >= 0) best = { t: th, tri };
        }
        continue;
      }
      const s = t0;
      const p = [o[0]! + d[0]! * s, o[1]! + d[1]! * s, o[2]! + d[2]! * s];
      const cell = p.map((v) => Math.floor(v / cs));
      const step = d.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
      const tMax = [0, 1, 2].map((a) => {
        if (!step[a]) return Infinity;
        const edge = (cell[a]! + (step[a]! > 0 ? 1 : 0)) * cs;
        return s + (edge - p[a]!) / d[a]!;
      });
      const tDelta = [0, 1, 2].map((a) => (step[a] ? cs / Math.abs(d[a]!) : Infinity));
      let enter = s;
      for (let guard = 0; guard < 1 << 20; guard++) {
        if (enter > t1 || enter > best.t) break;
        const list = this.cells.get(key(level, cell[0]!, cell[1]!, cell[2]!));
        if (list) {
          for (const tri of list) {
            if (this.stamp[tri] === now) continue;
            this.stamp[tri] = now;
            const th = hit(tri);
            if (th < best.t && th >= 0) best = { t: th, tri };
          }
        }
        const a = tMax[0]! < tMax[1]! ? (tMax[0]! < tMax[2]! ? 0 : 2) : tMax[1]! < tMax[2]! ? 1 : 2;
        enter = tMax[a]!;
        cell[a] = cell[a]! + step[a]!;
        tMax[a] = tMax[a]! + tDelta[a]!;
      }
    }
    return best;
  }

  private nextStamp(): number {
    this.stampNow++;
    if (this.stampNow === 0xffffffff) {
      this.stamp.fill(0);
      this.stampNow = 1;
    }
    return this.stampNow;
  }
}
