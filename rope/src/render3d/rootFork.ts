// A continuous woody surface at forks. Smooth-union the branch sweeps on a
// sparse grid, retaining a separate draw/picking mesh for each authored object.
// Only branched bodies pay for this; single roots use the direct ring mesh.
import * as THREE from "three";
import { edgeTable, triTable } from "three/addons/objects/MarchingCubes.js";

interface Segment {
  branch: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  radiiA: number[];
  radiiB: number[];
  s: number;
  endV: number;
  length: number;
}
interface Sample { d: number; branch: number; u: number; v: number; age: number; join: number }
interface Vertex { p: THREE.Vector3; n: THREE.Vector3; sample: Sample }

export function fuseRootForks(inputs: Map<number, THREE.BufferGeometry>, parents: ReadonlyMap<number, number> = new Map()): Map<number, THREE.BufferGeometry> {
  if (inputs.size < 2) return inputs;
  const sides = 40, stride = sides + 1;
  const segments: Segment[] = [];
  interface Ring { c: THREE.Vector3; radii: number[]; s: number }
  const branches = new Map<number, Ring[]>();
  const junctions = new Map<number, { parent: number; base: THREE.Vector3; side: THREE.Vector3; radius: number }>();
  const bounds = new THREE.Box3();
  let girth = Infinity;
  for (const [branch, geometry] of inputs) {
    const pos = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    const rings: Ring[] = [];
    branches.set(branch, rings);
    let previous: Ring | undefined;
    for (let i = 0; i < pos.count; i += stride) {
      const c = new THREE.Vector3();
      for (let k = 0; k < sides; k++) c.add(new THREE.Vector3().fromBufferAttribute(pos, i + k));
      c.multiplyScalar(1 / sides);
      const radii = Array.from({ length: sides }, (_, k) => new THREE.Vector3().fromBufferAttribute(pos, i + k).distanceTo(c));
      const s = uv.getY(i);
      if (previous) {
        const length = c.distanceTo(previous.c);
        if (length > 1e-6) segments.push({ branch, a: previous.c, b: c, radiiA: previous.radii, radiiB: radii, s: previous.s, endV: s, length });
      }
      previous = { c, radii, s };
      rings.push(previous);
    }
    geometry.computeBoundingBox();
    bounds.union(geometry.boundingBox!);
    girth = Math.min(girth, geometry.boundingBox!.max.z - geometry.boundingBox!.min.z);
  }
  if (!segments.length) return inputs;
  // Register grain at the actual junction, parent first. Random UV offsets
  // belong to trunks; a lateral inherits the parent's phase instead of looking
  // like a separately wrapped stick. The end of the lateral stays authored.
  const ready = new Set<number>(), visiting = new Set<number>();
  const prepare = (child: number): void => {
    if (ready.has(child) || visiting.has(child)) return;
    visiting.add(child);
    const parent = parents.get(child), rings = branches.get(child);
    if (parent !== undefined && parent !== child && branches.has(parent) && rings && rings.length > 6) {
      prepare(parent);
      const base = rings[5]!; // five base-cap rings precede the first path ring
      const direction = rings[6]!.c.clone().sub(base.c).normalize();
      let nearest: Segment | undefined, station = 0, distance = Infinity;
      for (const seg of segments) if (seg.branch === parent) {
        const delta = seg.b.clone().sub(seg.a);
        const t = THREE.MathUtils.clamp(base.c.clone().sub(seg.a).dot(delta) / delta.lengthSq(), 0, 1);
        const d = seg.a.clone().addScaledVector(delta, t).distanceToSquared(base.c);
        if (d < distance) { nearest = seg; station = t; distance = d; }
      }
      if (nearest) {
        const tangent = nearest.b.clone().sub(nearest.a).normalize();
        const sign = tangent.dot(direction) < 0 ? -1 : 1;
        const attach = nearest.a.clone().lerp(nearest.b, station);
        const radius = Math.max(0.0025, ...base.radii);
        const parentV = THREE.MathUtils.lerp(nearest.s, nearest.endV, station);
        const baseV = base.s, oldBase = base.c.clone();
        const parentRadius = Math.max(...nearest.radiiA);
        const reach = radius * 4 + parentRadius;
        const side = direction.clone().addScaledVector(tangent, -direction.dot(tangent)).normalize();
        junctions.set(child, { parent, base: attach, side, radius });
        const total = Math.max(0.001, (rings[rings.length - 6]!.s - baseV) * 0.65);
        for (const ring of rings) {
          const s = Math.max(0, (ring.s - baseV) * 0.65);
          const fade = Math.exp(-s / reach) * Math.pow(Math.max(0, 1 - s / total), 2);
          ring.c.addScaledVector(attach.clone().sub(oldBase), fade)
            .addScaledVector(tangent.clone().multiplyScalar(sign).sub(direction), s * fade);
        }
        for (const seg of segments) if (seg.branch === child) {
          seg.s = parentV + (seg.s - baseV) * sign;
          seg.endV = parentV + (seg.endV - baseV) * sign;
          seg.length = seg.a.distanceTo(seg.b);
        }
      }
    }
    visiting.delete(child); ready.add(child);
  };
  for (const child of inputs.keys()) prepare(child);
  // Include the longer shoulders in the sparse grid's bounds.
  for (const seg of segments) {
    const r = Math.max(...seg.radiiA, ...seg.radiiB) * 2;
    bounds.expandByPoint(seg.a.clone().addScalar(r));
    bounds.expandByPoint(seg.a.clone().addScalar(-r));
  }
  const step = THREE.MathUtils.clamp(girth / 6, 0.006, 0.011);
  bounds.expandByScalar(step * 4);
  const origin = bounds.min;
  const nx = Math.ceil((bounds.max.x - origin.x) / step) + 2;
  const ny = Math.ceil((bounds.max.y - origin.y) / step) + 2;
  const key = (x: number, y: number, z: number): number => x + nx * (y + ny * z);
  const decode = (id: number): THREE.Vector3 => {
    const x = id % nx, yz = Math.floor(id / nx), y = yz % ny, z = Math.floor(yz / ny);
    return new THREE.Vector3(origin.x + x * step, origin.y + y * step, origin.z + z * step);
  };
  // XY bins are enough: every centreline lies in the gameplay plane. They
  // keep a long root from testing every segment at every voxel.
  const binSize = 0.16;
  // The sampler is the whole cost of a fork (hundreds of thousands of calls
  // per body), so it does no allocation per segment, and it bounds each
  // segment before paying for its angle: the radius anywhere on a segment is
  // between the least and the greatest of its two rings', so the distance to
  // its axis less those two radii brackets the distance to its surface. A
  // segment whose nearest possible surface is further than another segment
  // of the same branch's furthest is never that branch's nearest, and it is
  // not evaluated. The ones that are evaluated are in their original order,
  // so a tie resolves as it always did and the field is the same to the bit.
  // The bounds are widened by a part in 1e9 to stay on the safe side of the
  // radius interpolation's rounding.
  const branchIds = [...inputs.keys()];
  const branchSlot = new Map(branchIds.map((b, i) => [b, i]));
  const spans = segments.map(seg => {
    const radii = [...seg.radiiA, ...seg.radiiB];
    return {
      seg, slot: branchSlot.get(seg.branch)!,
      dx: seg.b.x - seg.a.x, dy: seg.b.y - seg.a.y,
      high: Math.max(...radii) * (1 + 1e-9), low: Math.min(...radii) * (1 - 1e-9),
    };
  });
  type Span = (typeof spans)[number];
  // Bins on a flat grid over the spans' own reach (a point outside it has no
  // candidates, as it had none in the keyed bins).
  let binX0 = Infinity, binY0 = Infinity, binX1 = -Infinity, binY1 = -Infinity;
  const reachOf = (seg: Segment): { lo: THREE.Vector3; hi: THREE.Vector3 } => {
    const r = Math.max(...seg.radiiA, ...seg.radiiB) * 2 + step * 2;
    return { lo: seg.a.clone().min(seg.b).addScalar(-r), hi: seg.a.clone().max(seg.b).addScalar(r) };
  };
  // The grid's depth: deep enough for the cells' far corners.
  let nz = Math.ceil((bounds.max.z - origin.z) / step) + 2;
  for (const seg of segments) {
    const { lo, hi } = reachOf(seg);
    binX0 = Math.min(binX0, Math.floor(lo.x / binSize)); binY0 = Math.min(binY0, Math.floor(lo.y / binSize));
    binX1 = Math.max(binX1, Math.floor(hi.x / binSize)); binY1 = Math.max(binY1, Math.floor(hi.y / binSize));
    nz = Math.max(nz, Math.ceil((hi.z - origin.z) / step) + 2);
  }
  const binsX = binX1 - binX0 + 1, binsY = binY1 - binY0 + 1;
  const bins: Span[][] = Array.from({ length: binsX * binsY }, () => []);
  // The cells to march, in the order they were first reached (which is the
  // order the triangles come out in), and a mark per grid point to find them
  // by; the grid is a million-odd points, so flat arrays rather than hashes.
  const points = nx * ny * nz;
  const reached = new Uint8Array(points);
  const cells: number[] = [];
  spans.forEach((span) => {
    const { lo, hi } = reachOf(span.seg);
    for (let y = Math.floor(lo.y / binSize); y <= Math.floor(hi.y / binSize); y++) {
      for (let x = Math.floor(lo.x / binSize); x <= Math.floor(hi.x / binSize); x++) bins[(x - binX0) + binsX * (y - binY0)]!.push(span);
    }
    const low = lo.sub(origin).divideScalar(step).floor();
    const high = hi.sub(origin).divideScalar(step).ceil();
    // Only a narrow neighbourhood of the sweeps, not the body's empty box.
    for (let z = Math.max(0, low.z); z < high.z; z++) for (let y = Math.max(0, low.y); y < Math.min(ny - 1, high.y); y++) {
      for (let x = Math.max(0, low.x); x < Math.min(nx - 1, high.x); x++) {
        const cell = key(x, y, z);
        if (!reached[cell]) { reached[cell] = 1; cells.push(cell); }
      }
    }
  });
  const noCandidates: Span[] = [];
  const candidatesAt = (p: THREE.Vector3): Span[] => {
    const x = Math.floor(p.x / binSize) - binX0, y = Math.floor(p.y / binSize) - binY0;
    return x < 0 || y < 0 || x >= binsX || y >= binsY ? noCandidates : bins[x + binsX * y]!;
  };
  // Per-call scratch: each candidate's station and offset from its axis, and
  // each branch's best upper bound, nearest sample and first appearance.
  const most = Math.max(0, ...bins.map(b => b.length));
  const stations = new Float64Array(most), offsetsX = new Float64Array(most), offsetsY = new Float64Array(most), axial = new Float64Array(most);
  const bestHigh = new Float64Array(branchIds.length);
  const nearestOf: (Sample | undefined)[] = new Array(branchIds.length);
  const seenAt = new Int32Array(branchIds.length).fill(-1);
  const seen: number[] = [];
  let calls = 0;
  // The field's bracket at the last point `bracket` was asked about: no
  // segment's surface is nearer than `lowest`, and some branch's is no
  // further than `highest`.
  let lowest = Infinity, highest = Infinity;
  const bracket = (p: THREE.Vector3, candidates: readonly Span[]): void => {
    const call = calls++;
    seen.length = 0;
    lowest = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const { seg, dx, dy, slot, low, high } = candidates[i]!;
      const t = THREE.MathUtils.clamp(((p.x - seg.a.x) * dx + (p.y - seg.a.y) * dy) / (seg.length * seg.length), 0, 1);
      const rx = p.x - seg.a.x - t * dx, ry = p.y - seg.a.y - t * dy;
      const off = Math.hypot(rx, ry, p.z);
      stations[i] = t; offsetsX[i] = rx; offsetsY[i] = ry; axial[i] = off;
      if (seenAt[slot] !== call) { seenAt[slot] = call; seen.push(slot); bestHigh[slot] = Infinity; nearestOf[slot] = undefined; }
      bestHigh[slot] = Math.min(bestHigh[slot]!, off - low);
      lowest = Math.min(lowest, off - high);
    }
    highest = Infinity;
    for (const slot of seen) highest = Math.min(highest, bestHigh[slot]!);
  };
  // The most the fork blend below can take off the nearest branch's distance
  // for each other branch it meets: a quarter of the widest blend and the
  // saddle ridge at full strength (h = 1, tanh = 1, sin = 1).
  const blendDepth = Math.max(0.024 * 0.25, ...[...junctions.values()].map(j => j.radius * (2.75 * 0.25 + 0.07)))
    * (1 + 1e-6) + 1e-12;
  // Whether the field is negative at a grid point. Marching cubes needs only
  // the sign at a corner, and the value only at the two ends of an edge the
  // surface crosses, so a point the bracket decides - inside every bound, or
  // beyond the deepest the blend can reach - never has its field evaluated.
  // Most of the grid is that: deep in the wood or well clear of it.
  const toFork = new THREE.Vector3();
  const sample = (p: THREE.Vector3, bracketed = false): Sample => {
    const candidates = candidatesAt(p);
    if (!bracketed) bracket(p, candidates);
    for (let i = 0; i < candidates.length; i++) {
      const { seg, dx, dy, slot, high } = candidates[i]!;
      const old = nearestOf[slot];
      // The first candidate of a branch is always evaluated, as it was the
      // one that set the branch's sample before anything was compared.
      if (old && axial[i]! - high > bestHigh[slot]!) continue;
      const t = stations[i]!, rx = offsetsX[i]!, ry = offsetsY[i]!;
      // Tube frame: its in-plane axis is (dy,-dx), matching rootMesh.
      const angle = Math.atan2(p.z, (rx * dy - ry * dx) / seg.length);
      const u = (angle / (2 * Math.PI) + 1) % 1;
      const side = u * sides, k = Math.floor(side), f = side - k, k1 = (k + 1) % sides;
      const r = (seg.radiiA[k]! * (1 - f) + seg.radiiA[k1]! * f) * (1 - t) + (seg.radiiB[k]! * (1 - f) + seg.radiiB[k1]! * f) * t;
      const d = axial[i]! - r;
      if (!old || d < old.d) nearestOf[slot] = { d, branch: seg.branch, u, v: THREE.MathUtils.lerp(seg.s, seg.endV, t), age: THREE.MathUtils.smoothstep(r, 0.005, 0.04), join: 0 };
    }
    const ordered = seen.map(slot => nearestOf[slot]!).sort((a, b) => a.d - b.d);
    const nearest = ordered[0];
    if (!nearest) return { d: 1, branch: 0, u: 0, v: 0, age: 0, join: 0 };
    let { d, u, v, age } = nearest;
    let join = 0;
    for (let o = 1; o < ordered.length; o++) {
      const other = ordered[o]!;
      const a = junctions.get(nearest.branch), b = junctions.get(other.branch);
      const fork = a?.parent === other.branch ? a : b?.parent === nearest.branch ? b : undefined;
      // More wood under the lateral, less in the inner crotch: never a circular
      // collar. Girth sets the length scale, including on very fine branches.
      const side = fork ? toFork.copy(p).sub(fork.base).dot(fork.side) / fork.radius : 0;
      const blend = fork ? fork.radius * (2.1 - 0.65 * Math.tanh(side)) : 0.024;
      const h = Math.max(blend - Math.abs(d - other.d), 0) / blend;
      // Interpolate coordinates, not painted colours: this bends the ridges
      // through the fork without dissolving them into a blurry crossfade.
      const weight = h * h * (3 - 2 * h) * 0.5;
      const du = other.u - u - Math.round(other.u - u);
      u += du * weight;
      v = THREE.MathUtils.lerp(v, other.v, weight);
      age = THREE.MathUtils.lerp(age, other.age, weight);
      join = Math.max(join, h);
      d = Math.min(d, other.d) - h * h * blend * 0.25;
      // A slight uneven bark ridge follows the saddle, not the circumference.
      if (fork) d -= h * h * fork.radius * 0.07 * Math.max(0, Math.tanh(side)) * (0.8 + 0.2 * Math.sin(v * 23));
    }
    return { ...nearest, d, u: (u + 1) % 1, v, age, join };
  };
  const values = new Map<number, number>();
  const value = (id: number): number => {
    let v = values.get(id);
    if (v === undefined) { v = sample(decode(id)).d; values.set(id, v); }
    return v;
  };
  // A cube of grid points is decided at once where it can be: within one bin
  // every point has the same candidates, and the bracket over a fixed set of
  // segments moves no faster than the point does (each bound is a distance
  // to a segment's axis, less a constant), so the bracket at the cube's
  // centre, widened by its half-diagonal, holds for every point in it.
  // Coarse cubes first, finer ones where a coarse one straddles the surface.
  // A cube's state is 0 not yet asked, 1 inside, 2 straddling or undecided,
  // 3 outside.
  const blocks = [8, 4, 2].map(size => {
    const across = Math.ceil(nx / size) + 1, down = Math.ceil(ny / size) + 1;
    return { size, across, down, state: new Uint8Array(across * down * (Math.ceil(nz / size) + 1)) };
  });
  const blockCentre = new THREE.Vector3();
  // The bin a grid coordinate falls in, by the arithmetic `decode` places it.
  const binOf = (from: number, at: number): number => Math.floor((from + at * step) / binSize);
  const blockSign = (block: (typeof blocks)[number], x: number, y: number, z: number): number => {
    const { size } = block;
    const bx = Math.floor(x / size), by = Math.floor(y / size), bz = Math.floor(z / size);
    const id = bx + block.across * (by + block.down * bz);
    let state = block.state[id]!;
    if (state) return state;
    state = 2;
    const x0 = bx * size, y0 = by * size, z0 = bz * size, last = size - 1;
    if (binOf(origin.x, x0) === binOf(origin.x, x0 + last) && binOf(origin.y, y0) === binOf(origin.y, y0 + last)) {
      const half = last / 2;
      blockCentre.set(origin.x + (x0 + half) * step, origin.y + (y0 + half) * step, origin.z + (z0 + half) * step);
      bracket(blockCentre, candidatesAt(decode(key(x0, y0, z0))));
      const reach = half * step * Math.sqrt(3) * (1 + 1e-9) + 1e-12;
      if (highest + reach < 0) state = 1;
      else if (lowest - reach - blendDepth * Math.max(0, seen.length - 1) > 0) state = 3;
    }
    block.state[id] = state;
    return state;
  };
  // Per grid point: 0 not yet asked, 1 inside, 2 outside.
  const signs = new Uint8Array(points);
  const negative = (id: number): boolean => {
    const known = signs[id];
    if (known) return known === 1;
    const x = id % nx, yz = Math.floor(id / nx), y = yz % ny, z = Math.floor(yz / ny);
    let inside: boolean | undefined;
    for (const block of blocks) {
      const state = blockSign(block, x, y, z);
      if (state !== 2) { inside = state === 1; break; }
    }
    if (inside === undefined) {
      const p = decode(id);
      bracket(p, candidatesAt(p));
      // The blend only ever deepens the nearest branch's distance, so a point
      // with a branch surface beyond it is inside whatever the blend does.
      if (highest < 0) inside = true;
      else if (lowest - blendDepth * Math.max(0, seen.length - 1) > 0) inside = false;
      else {
        const v = sample(p, true).d;
        values.set(id, v);
        inside = v < 0;
      }
    }
    signs[id] = inside ? 1 : 2;
    return inside;
  };
  // An edge of the grid by its lower end and its axis.
  const vertices = new Map<number, Vertex>();
  const vertex = (a: number, b: number): Vertex => {
    const lo = Math.min(a, b), span = Math.abs(b - a);
    const id = lo * 3 + (span === 1 ? 0 : span === nx ? 1 : 2);
    const cached = vertices.get(id); if (cached) return cached;
    const va = value(a), vb = value(b);
    const p = decode(a).lerp(decode(b), va / (va - vb));
    const h = step * 0.4;
    const n = new THREE.Vector3();
    for (const axis of ["x", "y", "z"] as const) {
      const q = p.clone(); q[axis] += h; const plus = sample(q).d;
      q[axis] -= 2 * h; n[axis] = plus - sample(q).d;
    }
    n.normalize();
    const out = { p, n, sample: sample(p) }; vertices.set(id, out); return out;
  };
  // Each branch's mesh, indexed: a crossing is one vertex wherever it is
  // used, but for the copy a triangle across the bark's wrap takes with its U
  // carried past 1, so the wrap stays a seam rather than a smear.
  interface Output { p: number[]; n: number[]; uv: number[]; age: number[]; join: number[]; index: number[]; slots: Map<Vertex, number>; wrapped: Map<Vertex, number> }
  const output = new Map<number, Output>();
  const corners = [0, 1, nx + 1, nx, nx * ny, nx * ny + 1, nx * ny + nx + 1, nx * ny + nx];
  const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const ids = new Array<number>(8);
  const crossings = new Array<Vertex | undefined>(12);
  const tri = new Array<Vertex>(3);
  const center = new THREE.Vector3(), face = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (const cell of cells) {
    let cube = 0;
    for (let i = 0; i < 8; i++) {
      ids[i] = cell + corners[i]!;
      if (negative(ids[i]!)) cube |= 1 << i;
    }
    const crossed = edgeTable[cube]!;
    if (!crossed) continue;
    for (let i = 0; i < 12; i++) crossings[i] = crossed & (1 << i) ? vertex(ids[edges[i]![0]!]!, ids[edges[i]![1]!]!) : undefined;
    for (let t = cube * 16; triTable[t] !== -1; t += 3) {
      tri[0] = crossings[triTable[t]!]!; tri[1] = crossings[triTable[t + 1]!]!; tri[2] = crossings[triTable[t + 2]!]!;
      center.set(0, 0, 0).add(tri[0].p).add(tri[1].p).add(tri[2].p).divideScalar(3);
      face.crossVectors(ab.copy(tri[1].p).sub(tri[0].p), ac.copy(tri[2].p).sub(tri[0].p));
      if (face.dot(tri[0].n) < 0) { const swap = tri[1]; tri[1] = tri[2]; tri[2] = swap; }
      const owner = sample(center).branch;
      let out = output.get(owner);
      if (!out) output.set(owner, out = { p: [], n: [], uv: [], age: [], join: [], index: [], slots: new Map(), wrapped: new Map() });
      const us = [tri[0].sample.u, tri[1].sample.u, tri[2].sample.u];
      const seam = Math.max(...us) - Math.min(...us) > 0.5;
      for (const v of tri) {
        const wraps = seam && v.sample.u < 0.5;
        const slots = wraps ? out.wrapped : out.slots;
        let slot = slots.get(v);
        if (slot === undefined) {
          slot = out.age.length;
          slots.set(v, slot);
          out.p.push(v.p.x, v.p.y, v.p.z); out.n.push(v.n.x, v.n.y, v.n.z);
          out.uv.push(v.sample.u + (wraps ? 1 : 0), v.sample.v);
          out.age.push(v.sample.age);
          out.join.push(v.sample.join);
        }
        out.index.push(slot);
      }
    }
  }
  const result = new Map<number, THREE.BufferGeometry>();
  for (const [owner, out] of output) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(out.p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(out.n, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(out.uv, 2));
    g.setAttribute("rootAge", new THREE.Float32BufferAttribute(out.age, 1));
    g.setAttribute("rootJoin", new THREE.Float32BufferAttribute(out.join, 1));
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(out.p.length).fill(1), 3));
    g.setIndex(out.index);
    g.computeBoundingSphere(); result.set(owner, g);
  }
  for (const g of inputs.values()) g.dispose();
  return result;
}
