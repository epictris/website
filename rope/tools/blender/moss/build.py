"""Moss geometry: a painted mask on a host mesh becomes a cushion of moss, with
curtains hanging wherever the moss reaches a drop.

Everything here is a pure function of (host mesh, host matrix, stamps, params,
seed) - no bpy state is read or written - so the add-on's live rebuild and the
scene exporter's rebuild produce the same mesh bit for bit.

THE PIPELINE (all in world space, metres; the result is returned in the host's
local frame, because the moss object is parented to the host with an identity
transform):

1. The host's evaluated triangles, welded (a glTF import splits vertices at
   every hard edge, and the moss must not crack along them).
2. The triangles near a stamp, refined by edge bisection until every edge near
   the paint is shorter than `resolution`. Far from the paint nothing is split,
   so a 5 m cavern facet costs nothing where no moss is.
3. The mask: the stamps composited in the order they were painted (paint lays
   `m += (1 - m) a w`, erase `m *= 1 - a w`), `w` a smooth radial falloff times
   how far the vertex faces the way the stamp's surface did.
4. The outline: triangles clipped on the iso-line `m = threshold + noise`, so
   the edge is lobed at `edge_scale` whatever the host's facets are.
5. The cushion: every vertex lifted along a smoothed normal (the rock's creases
   rounded over at `rounding`) by `thickness`, ramped up from the outline over
   `feather` and modulated by two octaves of lumps.
6. The curtains: outline vertices where the moss runs off a drop (the ground
   falls away beyond a top, or the outline runs downhill on a wall) grow
   columns that crawl over the lip and hang, pushed out of the rock, to a
   length shaped per column by fingers, strands and an end taper; neighbouring
   columns are zipped into one sheet whose top row IS the cushion's outline.
7. Vertex colour: base at the outline to crown at full thickness, curtains
   from the crown's colour to the tip colour, all varied by a low noise.
"""

import heapq
import math
import random
from dataclasses import dataclass

import numpy as np
from mathutils import Vector, geometry, noise
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

DOWN = np.array((0.0, 0.0, -1.0))


@dataclass
class Params:
    """Every knob of a moss object. Lengths are metres, angles radians."""

    seed: int = 0
    resolution: float = 0.04
    # Outline
    threshold: float = 0.45
    edge_noise: float = 0.3
    edge_scale: float = 0.18
    min_patch: float = 0.01  # m^2; islands smaller than this are dropped
    # Cushion
    thickness: float = 0.06
    edge_thickness: float = 0.004
    feather: float = 0.12
    rounding: float = 0.12
    lump_amount: float = 0.6
    lump_scale: float = 0.25
    fuzz_amount: float = 0.25
    fuzz_scale: float = 0.05
    # Curtains
    curtains: bool = True
    lip_drop: float = 0.1
    curtain_length: float = 0.22
    length_variation: float = 0.5
    finger_width: float = 0.12
    finger_length: float = 0.5
    finger_taper: float = 1.2
    strand_density: float = 4.0  # per metre of lip
    strand_length: float = 0.6
    strand_width: float = 0.04
    free_keep: float = 0.25  # of the sheet that still hangs once off the rock
    end_taper: float = 0.25
    curtain_thickness: float = 0.8  # of the cushion's thickness where it leaves
    thickness_taper: float = 1.3
    bend_radius: float = 0.05
    hug: float = 0.004
    cling: float = 0.5  # per step, toward a wall within cling_reach
    cling_reach: float = 0.25
    sway: float = 0.03
    # Tint (linear RGB): the vertex colour, which the material multiplies with
    # the moss texture (grass_05, mean sRGB (0.41, 0.69, 0.29)); the defaults
    # pull that bright green down to the olive of the reference.
    crown_color: tuple = (1.0, 0.65, 0.48)
    base_color: tuple = (0.34, 0.19, 0.25)
    tip_color: tuple = (1.0, 0.76, 0.68)
    color_variation: float = 0.25
    texture_scale: float = 0.6  # metres per texture tile


@dataclass
class Stamps:
    """Brush stamps in the host's LOCAL frame, in painting order."""

    position: np.ndarray  # (S, 3)
    normal: np.ndarray  # (S, 3)
    radius: np.ndarray  # (S,) world metres
    strength: np.ndarray  # (S,) > 0 paints, < 0 erases

    @staticmethod
    def empty():
        return Stamps(np.zeros((0, 3)), np.zeros((0, 3)), np.zeros(0), np.zeros(0))

    def __len__(self):
        return len(self.radius)


@dataclass
class Result:
    vertices: np.ndarray  # (V, 3) host-local
    triangles: np.ndarray  # (T, 3)
    colors: np.ndarray  # (V, 4) linear RGBA
    uvs: np.ndarray  # (T, 3, 2) per corner
    cushion_triangles: int = 0
    curtain_triangles: int = 0
    lip_vertices: int = 0


def _empty_result():
    return Result(np.zeros((0, 3)), np.zeros((0, 3), np.int64), np.zeros((0, 4)), np.zeros((0, 3, 2)))


def _normalize(v):
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-12)


def _smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _seed_offset(seed, salt):
    rng = random.Random(seed * 7919 + salt)
    return Vector((rng.uniform(-500, 500), rng.uniform(-500, 500), rng.uniform(-500, 500)))


def _fbm(points, scale, seed, salt, octaves=3):
    """Fractal noise in about [-1, 1] at every point, deterministic in seed."""
    off = _seed_offset(seed, salt)
    inv = 1.0 / max(scale, 1e-6)
    out = np.empty(len(points))
    fractal = noise.fractal
    for i, p in enumerate(points):
        out[i] = fractal(Vector((p[0] * inv, p[1] * inv, p[2] * inv)) + off, 0.8, 2.0, octaves, noise_basis="PERLIN_NEW")
    return out * 0.9


# --------------------------------------------------------------------------
# 1. Host


def host_world(mesh, matrix):
    """The host's triangles in world space, welded at 10 um."""
    mesh.calc_loop_triangles()
    co = np.empty(len(mesh.vertices) * 3, np.float32)
    mesh.vertices.foreach_get("co", co)
    tri = np.empty(len(mesh.loop_triangles) * 3, np.int32)
    mesh.loop_triangles.foreach_get("vertices", tri)
    co = co.reshape(-1, 3).astype(np.float64)
    m = np.array(matrix, dtype=np.float64)
    co = co @ m[:3, :3].T + m[:3, 3]
    tri = tri.reshape(-1, 3)
    if len(co) == 0 or len(tri) == 0:
        return co, tri
    key = np.round(co / 1e-5).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    co = co[first]
    tri = inv[tri]
    keep = (tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 0] != tri[:, 2])
    return co, tri[keep]


def stamps_world(stamps, matrix):
    m = np.array(matrix, dtype=np.float64)
    pos = stamps.position @ m[:3, :3].T + m[:3, 3]
    nrm = _normalize(stamps.normal @ np.linalg.inv(m[:3, :3]))
    return pos, nrm


# --------------------------------------------------------------------------
# 2. Refinement


def _refine(co, tri, centres, radii, res):
    """Triangles within reach of a stamp, bisected until every edge in reach is
    at most `res` long. Returns (vertices, triangles) as arrays."""
    # Which host triangles can a stamp touch: bounding sphere against stamp sphere.
    c = co[tri].mean(axis=1)
    rb = np.linalg.norm(co[tri] - c[:, None, :], axis=2).max(axis=1)
    near = np.zeros(len(tri), bool)
    for s in range(0, len(centres), 64):
        d = np.linalg.norm(c[:, None, :] - centres[None, s : s + 64, :], axis=2)
        near |= (d - rb[:, None] - radii[None, s : s + 64] < 0).any(axis=1)
    sel = tri[near]
    if len(sel) == 0:
        return np.zeros((0, 3)), np.zeros((0, 3), np.int64)

    kd = KDTree(len(centres))
    for i, p in enumerate(centres):
        kd.insert(p, i)
    kd.balance()
    rmax = float(radii.max())

    used, local = np.unique(sel, return_inverse=True)
    verts = [Vector(co[i]) for i in used]
    tris = [tuple(x) for x in local.reshape(-1, 3).tolist()]
    alive = [True] * len(tris)
    by_edge = {}  # (min, max) -> triangle ids

    def key(a, b):
        return (a, b) if a < b else (b, a)

    def add(t):
        i = len(tris)
        tris.append(t)
        alive.append(True)
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            by_edge.setdefault(key(a, b), []).append(i)
        return i

    def kill(i):
        alive[i] = False
        t = tris[i]
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            by_edge[key(a, b)].remove(i)

    for i, t in enumerate(tris):
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            by_edge.setdefault(key(a, b), []).append(i)

    # Rivara's longest-edge bisection with LEPP propagation: a triangle that
    # touches a stamp and is too coarse has its longest edge split, after
    # walking to the pair of neighbours that share their longest edge (the
    # "terminal" edge), so every split halves the longest edge of both of its
    # triangles. Plain edge splitting on a 5 m facet fans slivers out to the
    # far corner forever; this keeps the angles bounded and terminates. (Kept
    # off bmesh: a bmesh operator walks the whole mesh per call, and one call
    # per split made a patch take seconds.)
    closest = geometry.closest_point_on_tri

    def longest(i):
        t = tris[i]
        best, bl = None, -1.0
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            ln = (verts[a] - verts[b]).length_squared
            if ln > bl:
                best, bl = key(a, b), ln
        return best, math.sqrt(bl)

    def touches(i):
        a, b, c = (verts[k] for k in tris[i])
        mid = (a + b + c) / 3.0
        r = max((a - mid).length, (b - mid).length, (c - mid).length)
        for sc, j, _d in kd.find_range(mid, r + rmax):
            if (closest(sc, a, b, c) - sc).length < radii[j]:
                return True
        return False

    def split(e):
        a, b = e
        m = len(verts)
        verts.append((verts[a] + verts[b]) * 0.5)
        made = []
        for i in list(by_edge.get(e, ())):
            t = tris[i]
            # Rotate so the split edge is (t[0], t[1]) in the winding.
            while key(t[0], t[1]) != e:
                t = (t[1], t[2], t[0])
            kill(i)
            made.append(add((t[0], m, t[2])))
            made.append(add((m, t[1], t[2])))
        del by_edge[e]
        return made

    queue = list(range(len(tris)))
    while queue:
        i = queue.pop()
        if not alive[i]:
            continue
        e, ln = longest(i)
        if ln <= res or not touches(i):
            continue
        g = i
        for _ in range(64):
            nb = [h for h in by_edge[e] if h != g]
            if not nb:
                break
            e2, _l = longest(nb[0])
            if e2 == e:
                break
            g, e = nb[0], e2
        queue.extend(split(e))
        if alive[i]:
            queue.append(i)

    v = np.array([p[:] for p in verts], dtype=np.float64)
    t = np.array([t for t, ok in zip(tris, alive) if ok], dtype=np.int64).reshape(-1, 3)
    return v, t


# --------------------------------------------------------------------------
# Mesh helpers


def _vertex_normals(v, t):
    fn = np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]])  # area weighted
    n = np.zeros_like(v)
    for k in range(3):
        np.add.at(n, t[:, k], fn)
    return _normalize(n)


def _edges(t):
    e = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]])
    e.sort(axis=1)
    return np.unique(e, axis=0)


def _smooth_field(field, edges, n, iterations):
    """Umbrella smoothing of a per-vertex field over the mesh edges."""
    if iterations <= 0 or len(edges) == 0:
        return field
    deg = np.bincount(edges.ravel(), minlength=n).astype(np.float64)
    deg = np.maximum(deg, 1.0)
    shape = (n,) + field.shape[1:]
    for _ in range(iterations):
        acc = np.zeros(shape)
        np.add.at(acc, edges[:, 0], field[edges[:, 1]])
        np.add.at(acc, edges[:, 1], field[edges[:, 0]])
        acc /= deg.reshape((-1,) + (1,) * (field.ndim - 1))
        field = 0.5 * field + 0.5 * acc
    return field


# --------------------------------------------------------------------------
# 3. Mask


def _mask(v, n, centres, snormals, radii, strength):
    """Stamps composited in painting order at every vertex."""
    m = np.zeros(len(v))
    order = np.argsort(v[:, 0], kind="stable")
    xs = v[order, 0]
    for c, sn, r, a in zip(centres, snormals, radii, strength):
        lo, hi = np.searchsorted(xs, c[0] - r), np.searchsorted(xs, c[0] + r, side="right")
        if lo == hi:
            continue
        idx = order[lo:hi]
        d = np.linalg.norm(v[idx] - c, axis=1)
        inside = d < r
        idx, d = idx[inside], d[inside]
        if len(idx) == 0:
            continue
        w = _smoothstep(0.0, 1.0, 1.0 - d / r)
        # A stamp on a ledge's top does not paint the ledge's underside.
        w *= _smoothstep(-0.2, 0.35, n[idx] @ sn)
        aw = abs(a) * w
        if a >= 0:
            m[idx] += (1.0 - m[idx]) * aw
        else:
            m[idx] *= 1.0 - aw
    return m


# --------------------------------------------------------------------------
# 4. Clipping


def _clip(v, t, f, attrs):
    """Keep the part of the mesh where f >= 0 (marching triangles). `attrs`
    are per-vertex arrays interpolated onto the new vertices. Winding kept."""
    f = np.where(np.abs(f) < 1e-7, 1e-7, f)
    inside = f >= 0
    cnt = inside[t].sum(axis=1)
    full = t[cnt == 3]

    # Canonical rotation: the odd vertex first.
    part = t[(cnt == 1) | (cnt == 2)]
    pin = inside[part]
    pc = pin.sum(axis=1)
    odd = np.where(pc[:, None] == 1, pin, ~pin)
    k = np.argmax(odd, axis=1)
    idx = (np.arange(3)[None, :] + k[:, None]) % 3
    rot = np.take_along_axis(part, idx, axis=1)
    one, two = rot[pc == 1], rot[pc == 2]

    # Crossing edges and their new vertices, shared between neighbours.
    cross = np.concatenate([one[:, [0, 1]], one[:, [0, 2]], two[:, [0, 1]], two[:, [0, 2]]])
    key = np.sort(cross, axis=1)
    uk, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    a, b = uk[:, 0], uk[:, 1]
    s = f[a] / (f[a] - f[b])
    base = len(v)
    new_v = v[a] + (v[b] - v[a]) * s[:, None]
    new_attrs = [np.concatenate([x, x[a] + (x[b] - x[a]) * s.reshape((-1,) + (1,) * (x.ndim - 1))]) for x in attrs]
    ids = base + inv
    n1, n2 = len(one), len(two)
    e01_one, e02_one = ids[:n1], ids[n1 : 2 * n1]
    e01_two, e02_two = ids[2 * n1 : 2 * n1 + n2], ids[2 * n1 + n2 :]

    tris = [full, np.stack([one[:, 0], e01_one, e02_one], axis=1)]
    # (o, i1, i2): quad i1, i2, p(o,i2), p(o,i1)
    tris.append(np.stack([two[:, 1], two[:, 2], e02_two], axis=1))
    tris.append(np.stack([two[:, 1], e02_two, e01_two], axis=1))
    out_t = np.concatenate(tris).astype(np.int64)
    out_v = np.concatenate([v, new_v])

    used = np.unique(out_t)
    remap = np.full(len(out_v), -1, np.int64)
    remap[used] = np.arange(len(used))
    return out_v[used], remap[out_t], [x[used] for x in new_attrs]


def _drop_islands(v, t, min_area):
    if len(t) == 0:
        return t
    parent = list(range(len(v)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b, c in t.tolist():
        ra, rb, rc = find(a), find(b), find(c)
        parent[rb] = ra
        parent[find(rc)] = ra
    roots = np.array([find(a) for a in t[:, 0].tolist()])
    area = 0.5 * np.linalg.norm(np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]]), axis=1)
    _, inv = np.unique(roots, return_inverse=True)
    total = np.bincount(inv.reshape(-1), weights=area)
    return t[total[inv.reshape(-1)] >= min_area]


def _compact(v, t, attrs):
    used = np.unique(t)
    remap = np.full(len(v), -1, np.int64)
    remap[used] = np.arange(len(used))
    return v[used], remap[t], [x[used] for x in attrs]


# --------------------------------------------------------------------------
# 5. Outline, lips and distance


def _boundary_loops(t):
    """Directed boundary edges chained into loops (or open chains at a
    non-manifold vertex). Each loop is a list of vertex indices, following the
    triangles' winding."""
    directed = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]])
    third = np.concatenate([t[:, 2], t[:, 0], t[:, 1]])
    key = np.sort(directed, axis=1)
    _, inv, counts = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    inv = inv.reshape(-1)
    bmask = counts[inv] == 1
    bedges, bthird = directed[bmask], third[bmask]
    nxt = {}
    for (a, b), c in zip(bedges.tolist(), bthird.tolist()):
        nxt.setdefault(a, []).append((b, c))
    loops, used = [], set()
    for (a0, b0), _c in zip(bedges.tolist(), bthird.tolist()):
        if (a0, b0) in used:
            continue
        loop = [a0]
        a, b = a0, b0
        while (a, b) not in used:
            used.add((a, b))
            loop.append(b)
            cands = [e for e in nxt.get(b, []) if (b, e[0]) not in used]
            if not cands:
                break
            a, b = b, cands[0][0]
        closed = loop[-1] == loop[0] and len(loop) > 2
        if closed:
            loop.pop()
        loops.append((loop, closed))
    return loops, bedges, bthird


def _outward(v, n, bedges, bthird):
    """Per boundary vertex: the direction off the moss, in its tangent plane."""
    out = {}
    for (a, b), c in zip(bedges.tolist(), bthird.tolist()):
        e = v[b] - v[a]
        mid = (v[a] + v[b]) * 0.5
        d = mid - v[c]
        el = e / max(np.linalg.norm(e), 1e-12)
        d = d - el * (d @ el)
        for i in (a, b):
            out[i] = out.get(i, 0.0) + d
    res = {}
    for i, d in out.items():
        d = d - n[i] * (d @ n[i])
        ln = np.linalg.norm(d)
        res[i] = d / ln if ln > 1e-12 else np.zeros(3)
    return res


def _geodesic(v, edges, sources, cap):
    """Distance along the mesh from the source vertices, capped (vertices
    further than `cap` read `cap`)."""
    dist = np.full(len(v), cap)
    adj = [[] for _ in range(len(v))]
    lengths = np.linalg.norm(v[edges[:, 0]] - v[edges[:, 1]], axis=1)
    for (a, b), ln in zip(edges.tolist(), lengths.tolist()):
        adj[a].append((b, ln))
        adj[b].append((a, ln))
    heap = []
    for s in sources:
        dist[s] = 0.0
        heap.append((0.0, s))
    heapq.heapify(heap)
    while heap:
        d, a = heapq.heappop(heap)
        if d > dist[a]:
            continue
        for b, ln in adj[a]:
            nd = d + ln
            if nd < dist[b]:
                dist[b] = nd
                heapq.heappush(heap, (nd, b))
    return dist


# --------------------------------------------------------------------------
# 6. Curtains


def _column_lengths(s, total, closed, p, rng):
    """Curtain length at each arc position `s` along a lip of length `total`,
    as (sheet, fingers): the continuous sheet's part and the part the fingers
    and strands add below it."""
    base = p.curtain_length * np.maximum(
        0.0, 1.0 + p.length_variation * _fbm(np.stack([s, np.zeros_like(s), np.zeros_like(s)], axis=1), p.finger_width * 4, p.seed, 11 + rng.randrange(1000), 2)
    )
    extra = np.zeros_like(s)
    fw = max(p.finger_width, 1e-3)
    c = -rng.uniform(0, fw)
    while c < total + fw:
        width = fw * rng.uniform(0.4, 1.6)
        length = p.finger_length * rng.random() ** 0.7
        extra = np.maximum(extra, length * np.clip(1.0 - np.abs(s - c) / width, 0.0, 1.0) ** p.finger_taper)
        c += fw * rng.uniform(0.6, 1.4)
    for _ in range(int(round(p.strand_density * total))):
        c = rng.uniform(0, total)
        width = max(p.strand_width, 1e-3)
        length = p.strand_length * rng.uniform(0.5, 1.0)
        extra = np.maximum(extra, length * np.clip(1.0 - np.abs(s - c) / width, 0.0, 1.0))
    if not closed and p.end_taper > 0:
        taper = _smoothstep(0.0, p.end_taper, np.minimum(s, total - s))
        base, extra = base * taper, extra * taper
    return base, extra


def _hang(bvh, start, direction, normal, sheet, fingers, p):
    """March one curtain column from `start`: over the lip, down under gravity,
    pushed out of the rock, for `sheet + fingers`. Once it hangs clear of any
    wall only `free_keep` of the sheet goes on (the fingers keep all of
    theirs), so a sheet off an undercut breaks up into drips. Returns
    (backs, normals, ts)."""
    length = sheet + fingers
    h = p.resolution
    pos = np.array(start, dtype=np.float64)
    d = np.array(direction, dtype=np.float64)
    nrm = np.array(normal, dtype=np.float64)
    backs, normals, ts = [pos.copy()], [nrm.copy()], [0.0]
    t = 0.0
    turn = h / max(p.bend_radius, 1e-3)
    descended = 0.0
    crawl = 0.0
    while t < length - 1e-9:
        step = min(h, length - t)
        d = d + DOWN * turn
        d /= np.linalg.norm(d)
        q = pos + d * step
        hit, hn, _i, dist = bvh.find_nearest(Vector(q))
        if hit is not None:
            hit, hn = np.array(hit), np.array(hn)
            side = (q - hit) @ hn
            if side < p.hug:
                q = hit + hn * p.hug
                dn = d @ hn
                if dn < 0:
                    d = d - hn * dn
                    ln = np.linalg.norm(d)
                    d = d / ln if ln > 1e-9 else -DOWN * 0 + DOWN
                nrm = hn
                # Resting on ground that faces up: before the lip it may crawl
                # a little; after having hung it has landed.
                if hn[2] > 0.6:
                    if descended > 2 * h:
                        break
                    crawl += step
                    if crawl > 3 * h + 0.05:
                        break
            elif dist is not None and dist < p.cling_reach and hn[2] > -0.3:
                # A wall within reach draws the sheet back onto it: moss
                # follows an undercut rather than hanging out over it. A
                # ceiling does not - the underside of the overhang it just
                # came over is always within reach, and is not a wall.
                target = hit + hn * p.hug
                q = q + (target - q) * p.cling
                nrm = hn
            elif descended > 2 * h:
                length = min(length, t + sheet * p.free_keep + fingers)
        elif descended > 2 * h:
            length = min(length, t + sheet * p.free_keep + fingers)
        descended += max(0.0, pos[2] - q[2])
        t += step
        pos = q
        backs.append(pos.copy())
        normals.append(nrm.copy())
        ts.append(t)
    return np.array(backs), np.array(normals), np.array(ts)


def _zip(a_idx, a_t, b_idx, b_t):
    """Triangles between two neighbouring columns of different lengths."""
    tris = []
    i = j = 0
    while i < len(a_idx) - 1 or j < len(b_idx) - 1:
        adv_a = j >= len(b_idx) - 1 or (i < len(a_idx) - 1 and a_t[i + 1] <= b_t[j + 1])
        if adv_a:
            tris.append((a_idx[i], b_idx[j], a_idx[i + 1]))
            i += 1
        else:
            tris.append((a_idx[i], b_idx[j], b_idx[j + 1]))
            j += 1
    return tris


# --------------------------------------------------------------------------


def build(host_mesh, host_matrix, stamps, p):
    """The moss for one host. `host_mesh` is the host's evaluated mesh."""
    if len(stamps) == 0 or not (stamps.strength > 0).any():
        return _empty_result()
    co, tri = host_world(host_mesh, host_matrix)
    if len(tri) == 0:
        return _empty_result()
    centres, snormals = stamps_world(stamps, host_matrix)
    radii = stamps.radius.astype(np.float64)
    res = max(p.resolution, 0.005)

    v, t = _refine(co, tri, centres, radii, res)
    if len(t) == 0:
        return _empty_result()
    n_raw = _vertex_normals(v, t)
    edges = _edges(t)

    m = _mask(v, n_raw, centres, snormals, radii, stamps.strength)
    thr = np.clip(p.threshold + p.edge_noise * _fbm(v, p.edge_scale, p.seed, 1), 0.03, 0.97)
    iters = int(min(200, round((p.rounding / res) ** 2)))
    n_smooth = _normalize(_smooth_field(n_raw, edges, len(v), iters))

    v, t, (n_s, n_r) = _clip(v, t, m - thr, [n_smooth, n_raw])
    t = _drop_islands(v, t, p.min_patch)
    if len(t) == 0:
        return _empty_result()
    v, t, (n_s, n_r) = _compact(v, t, [n_s, n_r])
    n_s, n_r = _normalize(n_s), _normalize(n_r)
    edges = _edges(t)

    bvh = BVHTree.FromPolygons([tuple(x) for x in co], [tuple(x) for x in tri.tolist()])

    # Lips: outline vertices the moss runs off.
    loops, bedges, bthird = _boundary_loops(t)
    out = _outward(v, n_r, bedges, bthird)
    lip = np.zeros(len(v), bool)
    if p.curtains:
        for i, o in out.items():
            nz = n_r[i][2]
            if nz < 0.5 and o @ DOWN > 0.5:
                lip[i] = True  # the outline runs downhill on a wall
            elif nz > 0.3:
                q = v[i] + o * (2 * res + 0.02) + n_r[i] * 0.02
                hit, hn, _k, dist = bvh.find_nearest(Vector(q))
                if hit is not None and (q - np.array(hit)) @ np.array(hn) <= 0:
                    continue  # the probe is inside the rock: a wall rises there
                hit, _hn, _k, dist = bvh.ray_cast(Vector(q), Vector(DOWN))
                if hit is None or dist > p.lip_drop:
                    lip[i] = True  # the ground falls away beyond a top
        # Lips are runs, not specks: close one-vertex gaps, drop singletons.
        for loop, closed in loops:
            k = len(loop)
            flags = [lip[i] for i in loop]
            for _pass in range(2):
                new = flags[:]
                for j in range(k):
                    prv = flags[j - 1] if (closed or j > 0) else flags[j]
                    nxt = flags[(j + 1) % k] if (closed or j < k - 1) else flags[j]
                    if not flags[j] and prv and nxt:
                        new[j] = True
                    elif flags[j] and not prv and not nxt:
                        new[j] = False
                flags = new
            for i, f in zip(loop, flags):
                lip[i] = f

    boundary = np.zeros(len(v), bool)
    boundary[bedges.ravel()] = True
    sources = np.nonzero(boundary & ~lip)[0].tolist()
    cap = max(p.feather, 1e-4)
    dist = _geodesic(v, edges, sources, cap) if sources else np.full(len(v), cap)
    profile = _smoothstep(0.0, cap, dist)

    lumps = 1.0 + p.lump_amount * _fbm(v, p.lump_scale, p.seed, 2, 2) + p.fuzz_amount * _fbm(v, p.fuzz_scale, p.seed, 3, 1)
    lumps = np.maximum(lumps, 0.2)
    offset = p.edge_thickness + (p.thickness - p.edge_thickness) * profile * lumps
    offset[boundary & ~lip] = p.edge_thickness
    top = v + n_s * offset[:, None]

    shade = _fbm(v, 0.35, p.seed, 4, 2) * p.color_variation
    crown, basec, tip = (np.array(c, dtype=np.float64) for c in (p.crown_color, p.base_color, p.tip_color))
    glow = np.clip(profile * (0.75 + 0.25 * (lumps - 1.0) / max(p.lump_amount, 1e-3)), 0.0, 1.0)
    colors = basec + (crown - basec) * glow[:, None]
    colors *= (1.0 + shade)[:, None]

    verts = [top]
    cols = [colors]
    tris_out = [t]
    cushion_tris = len(t)
    next_index = len(top)
    curtain_tris = []
    curtain_uv = {}  # vertex -> (along the lip, down the curtain), metres

    if p.curtains and lip.any():
        rng = random.Random(p.seed * 104729 + 17)
        for loop, closed in loops:
            flags = [lip[i] for i in loop]
            if not any(flags):
                continue
            # Runs of lip vertices; a closed loop all lip is one closed run.
            k = len(loop)
            if closed and all(flags):
                runs = [(loop[:], True)]
            else:
                start = 0
                if closed:
                    start = next(j for j in range(k) if not flags[j])
                    order = loop[start + 1 :] + loop[: start + 1]
                    oflags = flags[start + 1 :] + flags[: start + 1]
                else:
                    order, oflags = loop, flags
                runs, cur = [], []
                for i, f in zip(order, oflags):
                    if f:
                        cur.append(i)
                    elif cur:
                        runs.append((cur, False))
                        cur = []
                if cur:
                    runs.append((cur, False))
            for run, run_closed in runs:
                if len(run) < 2:
                    continue
                pts = v[run]
                seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
                s = np.concatenate([[0.0], np.cumsum(seg)])
                total = s[-1] + (np.linalg.norm(pts[0] - pts[-1]) if run_closed else 0.0)
                sheets, fingers = _column_lengths(s, max(total, 1e-6), run_closed, p, rng)
                tangent = _normalize(np.gradient(pts, axis=0)) if len(run) > 2 else _normalize(np.repeat((pts[1] - pts[0])[None], 2, 0))
                cols_idx, cols_t = [], []
                for j, i in enumerate(run):
                    backs, nrms, ts = _hang(bvh, v[i], out[i], n_r[i], sheets[j], fingers[j], p)
                    ln = ts[-1] if len(ts) else 0.0
                    th0 = offset[i] * p.curtain_thickness
                    idx = [i]
                    curtain_uv[i] = (s[j], 0.0)
                    for r in range(1, len(ts)):
                        u = ts[r] / max(ln, 1e-9)
                        th = th0 * max(0.0, 1.0 - u) ** p.thickness_taper
                        sway = p.sway * u * noise.noise(Vector((s[j] * 6.0, ts[r] * 4.0, p.seed * 1.37)))
                        front = backs[r] + nrms[r] * (p.hug + th) + tangent[j] * sway
                        # The first rows ease out of the cushion's own surface
                        # (its smoothed normal) into the rock-hugging sheet.
                        if r <= 2:
                            w = r / 3.0
                            front = top[i] * (1.0 - w) + front * w
                        verts.append(front[None])
                        col = crown + (tip - crown) * _smoothstep(0.3, 1.0, u)
                        col = col * (1.0 + shade[i] + 0.1 * noise.noise(Vector((s[j] * 3.0, ts[r] * 3.0, 7.0 + p.seed))))
                        cols.append(col[None] * (1.0 - 0.35 * (1 - u) * (1 - glow[i])))
                        curtain_uv[next_index] = (s[j], ts[r])
                        idx.append(next_index)
                        next_index += 1
                    cols_idx.append(idx)
                    cols_t.append(ts)
                pairs = list(zip(range(len(run) - 1), range(1, len(run))))
                if run_closed:
                    pairs.append((len(run) - 1, 0))
                for a, b in pairs:
                    curtain_tris.extend(_zip(cols_idx[a], cols_t[a], cols_idx[b], cols_t[b]))

    V = np.concatenate(verts)
    C = np.concatenate(cols)
    if curtain_tris:
        ct = np.array(curtain_tris, dtype=np.int64)
        # Face the sheet out of the rock: compare each triangle's normal with
        # the direction from the rock (cushion vertices use their normal).
        fn = np.cross(V[ct[:, 1]] - V[ct[:, 0]], V[ct[:, 2]] - V[ct[:, 0]])
        centre = V[ct].mean(axis=1)
        away = np.zeros_like(centre)
        for k, c in enumerate(centre):
            hit, hn, _i, _d = bvh.find_nearest(Vector(c))
            away[k] = np.array(hn) if hit is not None else (0, 0, 1)
        flip = (fn * away).sum(axis=1) < 0
        ct[flip] = ct[flip][:, [0, 2, 1]]
        area = np.linalg.norm(fn, axis=1)
        ct = ct[area > 1e-12]
        tris_out.append(ct)
    T = np.concatenate(tris_out)

    # UVs, per corner. The cushion is projected along the axis its triangle
    # faces most (the moss texture is noise, so the seams where the axis
    # changes do not read); a curtain is unrolled - along its lip and down
    # its length - so its fingers are never stretched.
    inv_tile = 1.0 / max(p.texture_scale, 1e-3)
    ctri = T[:cushion_tris]
    face_n = np.abs(n_r[ctri].sum(axis=1))
    axis = np.argmax(face_n, axis=1)
    drop = np.array([[1, 2], [0, 2], [0, 1]])[axis]  # the two axes kept
    pos = V[ctri]  # (C, 3, 3)
    uvs = np.empty((len(T), 3, 2))
    uvs[:cushion_tris, :, 0] = np.take_along_axis(pos, drop[:, None, 0:1].repeat(3, 1), axis=2)[..., 0]
    uvs[:cushion_tris, :, 1] = np.take_along_axis(pos, drop[:, None, 1:2].repeat(3, 1), axis=2)[..., 0]
    if len(T) > cushion_tris:
        cu = np.zeros((len(V), 2))
        keys = np.fromiter(curtain_uv.keys(), dtype=np.int64)
        cu[keys] = np.array(list(curtain_uv.values()))
        cu[:, 1] *= -1.0  # down the curtain is down the texture
        uvs[cushion_tris:] = cu[T[cushion_tris:]]
    uvs *= inv_tile

    # Back into the host's frame.
    mw = np.array(host_matrix, dtype=np.float64)
    inv = np.linalg.inv(mw)
    local = V @ inv[:3, :3].T + inv[:3, 3]
    rgba = np.concatenate([np.clip(C, 0.0, 1.0), np.ones((len(C), 1))], axis=1)
    return Result(
        local,
        T,
        rgba,
        uvs,
        cushion_triangles=cushion_tris,
        curtain_triangles=len(T) - cushion_tris,
        lip_vertices=int(lip.sum()),
    )
