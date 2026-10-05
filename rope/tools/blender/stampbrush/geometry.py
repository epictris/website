"""Mesh helpers the painted growths share (tools/blender/ivy and tools/blender/moss):
the host's welded world triangles, the brush stamps in world space, refinement of
the host under the paint, the stamps composited into a coverage, clipping on an
iso-line, island and compaction helpers, smoothing and geodesic distance over the
mesh edges. Pure functions of numpy arrays: no bpy state is read or written.

Moved verbatim out of the ivy's build.py on 2026-10-02 when the moss add-on was
written, so both grow from the same paint the same way; the ivy's output was
checked bit-identical across the move."""

import heapq
import math

import numpy as np
from mathutils import Vector, geometry
from mathutils.kdtree import KDTree


def normalize(v):
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-12)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def kdtree(points):
    """A balanced KDTree of `points`, point i under index i. They go in in a
    fixed shuffled order: Blender's balance degrades on sorted input, and the
    builds sort their vertices by position (300k points: 9 s sorted, 0.04 s
    shuffled; 2026-10-05)."""
    pts = np.asarray(points, dtype=np.float64)
    kd = KDTree(len(pts))
    for i in np.random.default_rng(0).permutation(len(pts)).tolist():
        kd.insert(pts[i], i)
    kd.balance()
    return kd


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
    nrm = normalize(stamps.normal @ np.linalg.inv(m[:3, :3]))
    return pos, nrm


def refine(co, tri, centres, radii, res, keep_all=False):
    """Triangles within reach of a stamp, bisected until every edge in reach is
    at most `res` long. Returns (vertices, triangles) as arrays. With
    `keep_all` every input triangle is kept (only those in reach are still
    refined): the second pass over a mesh the first pass already trimmed."""
    # Which host triangles can a stamp touch: bounding sphere against stamp sphere.
    c = co[tri].mean(axis=1)
    rb = np.linalg.norm(co[tri] - c[:, None, :], axis=2).max(axis=1)
    near = np.zeros(len(tri), bool)
    for s in range(0, len(centres), 64):
        d = np.linalg.norm(c[:, None, :] - centres[None, s : s + 64, :], axis=2)
        near |= (d - rb[:, None] - radii[None, s : s + 64] < 0).any(axis=1)
    sel = tri if keep_all else tri[near]
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


def vertex_normals(v, t):
    fn = np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]])  # area weighted
    n = np.zeros_like(v)
    for k in range(3):
        np.add.at(n, t[:, k], fn)
    return normalize(n)


def edges(t):
    e = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]])
    e.sort(axis=1)
    return np.unique(e, axis=0)


def smooth_field(field, edges, n, iterations):
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


def geodesic(v, edges, sources, drop=0.0, start=None):
    """Distance from the nearest of `sources` (vertex indices) to every vertex
    along the mesh edges (Dijkstra), each source starting at its `start`
    distance (0 when None), so a line that runs between the vertices can be a
    source. A vertex the edges do not reach (another island of the paint)
    takes its straight-line distance to the first source instead. With `drop` > 0 the metric is squashed downward: an edge going
    down counts shorter and one going up longer, by drop / (1 + drop) of its
    rise, so a threshold on the distance reaches (1 + drop) times further
    straight down than sideways."""
    n = len(v)
    adj = [[] for _ in range(n)]
    d3 = v[edges[:, 1]] - v[edges[:, 0]]
    L = np.linalg.norm(d3, axis=1)
    k = drop / (1.0 + drop)
    floor = 0.15 * L
    # The cost of walking the edge a -> b, and b -> a.
    ab = np.maximum(L + k * d3[:, 2], floor)
    ba = np.maximum(L - k * d3[:, 2], floor)
    for (a, b), cab, cba in zip(edges.tolist(), ab.tolist(), ba.tolist()):
        adj[a].append((b, cab))
        adj[b].append((a, cba))
    dist = np.full(n, np.inf)
    heap = []
    sources = np.atleast_1d(sources)
    start = np.zeros(len(sources)) if start is None else np.asarray(start, dtype=np.float64)
    for s, d0 in zip(sources.tolist(), start.tolist()):
        if d0 < dist[s]:
            dist[s] = d0
            heap.append((d0, s))
    heapq.heapify(heap)
    while heap:
        d, i = heapq.heappop(heap)
        if d > dist[i]:
            continue
        for j, l in adj[i]:
            nd = d + l
            if nd < dist[j]:
                dist[j] = nd
                heapq.heappush(heap, (nd, j))
    far = np.isinf(dist)
    if far.any():
        dist[far] = np.linalg.norm(v[far] - v[int(np.atleast_1d(sources)[0])], axis=1)
    return dist


def mask(v, n, centres, snormals, radii, strength):
    """Stamps composited in painting order at every vertex."""
    m = np.zeros(len(v))
    order = np.argsort(v[:, 0], kind="stable")
    composite(m, v, n, order, v[order, 0], centres, snormals, radii, strength)
    return m


def composite(m, v, n, order, xs, centres, snormals, radii, strength):
    """Composite stamps, in order, onto the coverage `m` (in place). `order`
    sorts the points by x and `xs` is their sorted x. Painting is sequential,
    so later stamps can be composited onto an earlier result: the brush's
    preview adds a stroke's stamps without compositing the rest again."""
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
        w = smoothstep(0.0, 1.0, 1.0 - d / r)
        # A stamp on a ledge's top does not paint the ledge's underside.
        w *= smoothstep(-0.2, 0.35, n[idx] @ sn)
        aw = abs(a) * w
        if a >= 0:
            m[idx] += (1.0 - m[idx]) * aw
        else:
            m[idx] *= 1.0 - aw


def clip(v, t, f, attrs):
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


def drop_islands(v, t, min_area):
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


def compact(v, t, attrs):
    used = np.unique(t)
    remap = np.full(len(v), -1, np.int64)
    remap[used] = np.arange(len(used))
    return v[used], remap[t], [x[used] for x in attrs]

