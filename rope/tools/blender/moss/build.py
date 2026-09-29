"""Moss geometry: a painted mask on a host mesh becomes a carpet of flat leaf
blobs, layered like paper cutouts, and vines of lobed leaves hang from anchors
placed on the host by hand. The look is the painted-foliage one (Genshin, Breath of the Wild, The
Witness): every blob is one flat colour, shaded by a smooth "hull" normal
borrowed from the rock, so the carpet reads as one soft mass of distinct
colour blocks. See rope/docs/blender-moss.md for the history of the choices.

Everything here is a pure function of (host mesh, host matrix, stamps, vines, params)
- no bpy state is read or written - so the add-on's live rebuild and the scene
exporter's rebuild produce the same mesh bit for bit.

THE PIPELINE (in world space, metres; the result is returned in the host's
local frame, because the moss object is parented to the host with an identity
transform):

1. The host's evaluated triangles, welded.
2. The triangles near a stamp, refined by edge bisection to `resolution`.
3. The mask: the stamps composited in painting order, and a lobed threshold.
4. The hull normal: the host's vertex normals smoothed over `rounding`, so a
   blob on a facet shades with the rock's rounded volume, not the facet.
5. The underlay: the painted part of the host, clipped on the iso-line and
   lifted 2 cm, in the leaf colour. Where blobs thin out it is moss, not rock.
6. Candidates: points on the refined triangles inside the paint, thousands per
   square metre; the layers pick from them.
7. Layers: `layers` heights from 8 mm up to `thickness`, each with three
   sub-heights 2 mm apart. Each layer lays `fill` times its area in blobs.
   A blob is a quad lying on the hull (NO random tilt: neighbours share a
   plane, so they overlap like scales and never cut through each other).
   In the outer half of the paint the blob sits on a quarter-round shoulder
   that stands against the rock at the paint's edge, so the mass rolls into
   the stone instead of ending as a shelf. Finally every blob is rotated the
   least that makes it face the game's camera (Blender -y) by `facing`, so
   the silhouette is made of blob faces, never of edges.
8. Vines: from front-facing points on the paint's edge, a thin stem hangs
   with heart-shaped leaves alternating sides and tapering to the tip. Every
   vine point is held in front of the rock's front-most surface by a ray
   cast, because a rock bulges below its shoulder.
9. Colour: a vertex colour the material multiplies into a white atlas. Three
   green tones patch across the rock by a slow noise, lit toward `light`
   where the hull faces up, darkened and cooled in the deep layers, then a
   small value jitter per blob so neighbouring blocks differ.

9. Vines: one per anchor, a 3 mm stem hanging straight down from the anchor,
   held in front of the rock by a ray cast, with lobed leaves alternating
   sides and tapering toward the tip. Nothing places a vine but the artist.

The atlas (mesh_io.atlas) is a 4 x 4 sheet of silhouettes: eight angular blob
shapes for the carpet, four lobed ivy leaves for the vines, and solid cells the
underlay and stems point at, so the whole moss is one material and one draw.
"""

import heapq
import math
import random
from collections import defaultdict
from dataclasses import dataclass

import numpy as np
from mathutils import Vector, geometry, noise
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

# Toward the game's camera. The game looks along glTF -z, which is Blender -y.
FACE = np.array((0.0, -1.0, 0.0))
UP = np.array((0.0, 0.0, 1.0))

ATLAS_CELLS = 4
BLOB_CELLS = (0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15)  # the carpet never wears a vine leaf
LEAF_CELLS = (8, 9, 10, 11)
FILL_CELL = 2  # a faceted round: alpha 1 at its centre, where the underlay and the stems sample
# A card's UV quad covers only the inner part of its cell, and the shape is
# drawn inside that: the outer ATLAS_INSET of every cell is transparent on
# both sides of every cell border, so bilinear filtering and the first mip
# levels never blend a neighbouring cell's alpha into a card's edge. Cells
# packed edge to edge drew a faint outline of every card square.
ATLAS_INSET = 0.12


@dataclass
class Params:
    """Every knob of a moss object. Lengths are metres, colours linear RGB."""

    seed: int = 0
    resolution: float = 0.04
    # Outline
    threshold: float = 0.35
    edge_noise: float = 0.15
    edge_scale: float = 0.18
    min_patch: float = 0.01  # m^2; islands smaller than this are dropped
    rounding: float = 0.12  # how far the host's creases are rounded in the hull normal
    # Carpet
    thickness: float = 0.07
    layers: int = 8
    blob_min: float = 0.07
    blob_max: float = 0.13
    fill: float = 1.8  # blob area laid per layer, as a multiple of the layer's area
    edge_fill: float = 2.5  # extra fill toward the paint's edge, where the underlay would otherwise show
    density: float = 6000.0  # candidate points per m^2 of paint
    facing: float = 0.5  # every blob faces the camera by at least acos(facing)
    shoulder: float = 0.5  # the outer share of the paint (in mask units) that rolls into the rock
    underlay: float = 0.02
    # Vines (each one is placed by hand; these are the leaves it wears)
    vine_length: float = 0.55  # the length a newly placed vine is given
    leaf_size: float = 0.15  # leaf length at the top of a vine
    leaf_tip: float = 0.045  # ... and at its tip
    # Colour (linear RGB)
    tone_a: tuple = (0.62, 0.78, 0.06)  # yellow-green
    tone_b: tuple = (0.24, 0.60, 0.06)  # leaf green
    tone_c: tuple = (0.12, 0.48, 0.20)  # blue-green
    light: tuple = (0.80, 0.84, 0.10)  # the sunward crown
    shade: tuple = (0.10, 0.36, 0.24)  # what the deep layers cool toward
    tone_scale: float = 0.22
    variation: float = 0.16
    depth_shade: float = 0.28


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
class Vines:
    """Vine anchors in the host's LOCAL frame: where each vine hangs from, and
    how long it is (world metres)."""

    position: np.ndarray  # (N, 3)
    length: np.ndarray  # (N,)

    @staticmethod
    def empty():
        return Vines(np.zeros((0, 3)), np.zeros(0))

    def __len__(self):
        return len(self.length)


@dataclass
class Result:
    vertices: np.ndarray  # (V, 3) host-local
    triangles: np.ndarray  # (T, 3)
    colors: np.ndarray  # (V, 4) linear RGBA
    uvs: np.ndarray  # (T, 3, 2) per corner
    normals: np.ndarray  # (V, 3) host-local custom normals (the hull normal)
    blobs: int = 0
    vines: int = 0
    leaves: int = 0


def _empty_result():
    return Result(np.zeros((0, 3)), np.zeros((0, 3), np.int64), np.zeros((0, 4)), np.zeros((0, 3, 2)), np.zeros((0, 3)))

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



# --------------------------------------------------------------------------
# 5. Colour


def _tone_at(P, tones, scale, seed):
    """The local green: two slow noises pick a soft mixture of the three tones."""
    off = Vector((7.1 + seed * 0.37, 3.3, 9.7))
    a = np.array([noise.noise(Vector(p) / scale) for p in P]) * 0.5 + 0.5
    b = np.array([noise.noise(Vector(p) / scale + off) for p in P]) * 0.5 + 0.5
    w = np.stack([a * a, (1 - a) * (1 - b) + 0.35, (1 - a) * b], 1)
    w /= w.sum(1, keepdims=True)
    return w @ np.asarray(tones)


def _tint(hn, depth, var, base, p):
    """Vertex colour: the local tone lit toward `light` where the hull faces up,
    darkened and cooled with depth into the carpet, then a value jitter."""
    up = np.clip(hn[..., 2] * 0.5 + 0.5, 0, 1)
    light = np.asarray(p.light)
    shade = np.asarray(p.shade)
    c = base * (0.75 + 0.45 * up[..., None]) + (light - base) * (up[..., None] ** 2) * 0.25
    c = c * (1 - depth[..., None] * p.depth_shade) + shade * depth[..., None] * (p.depth_shade * 0.65)
    c = c * (1 + var[..., None])
    return np.clip(c, 0, 1)


# --------------------------------------------------------------------------
# 6. Quads


class _Quads:
    """Cards accumulated as quads, turned into the result's triangles at the end."""

    def __init__(self):
        self.co, self.nrm, self.col, self.uv = [], [], [], []

    def add(self, corners, normal, color, uv):
        self.co.append(corners)
        self.nrm.append(np.repeat(normal[None], 4, 0))
        self.col.append(np.repeat(np.asarray(color)[None], 4, 0))
        self.uv.append(uv)

    def __len__(self):
        return len(self.co)

    def arrays(self):
        n = len(self.co)
        if n == 0:
            return np.zeros((0, 3)), np.zeros((0, 3), np.int64), np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 3, 2))
        co = np.asarray(self.co).reshape(-1, 3)
        nrm = np.asarray(self.nrm).reshape(-1, 3)
        col = np.asarray(self.col).reshape(-1, 3)
        base = np.arange(n) * 4
        tri = np.stack([np.stack([base, base + 1, base + 2], 1), np.stack([base, base + 2, base + 3], 1)], 1).reshape(-1, 3)
        uvq = np.asarray(self.uv)  # (n, 4, 2)
        uv = np.stack([uvq[:, [0, 1, 2]], uvq[:, [0, 2, 3]]], 1).reshape(-1, 3, 2)
        return co, tri, nrm, col, uv


def _quad(centre, normal, w, h, spin):
    """A w x h quad whose face normal is `normal`, spun by `spin` about it.
    Winding gives the front face toward `normal` (the material culls the back)."""
    n = normal / np.linalg.norm(normal)
    t = np.cross(n, UP)
    if np.linalg.norm(t) < 1e-4:
        t = np.cross(n, np.array((1.0, 0.0, 0.0)))
    t /= np.linalg.norm(t)
    b = np.cross(n, t)
    ca, sa = math.cos(spin), math.sin(spin)
    x = t * ca + b * sa
    y = -t * sa + b * ca
    return np.array([centre - x * w / 2 - y * h / 2, centre + x * w / 2 - y * h / 2, centre + x * w / 2 + y * h / 2, centre - x * w / 2 + y * h / 2])


def _uv_cell(idx):
    """The atlas cell's UV corners. The atlas is written top row first, so cell
    row r of the sheet is UV row (cells - 1 - r)."""
    cy, cx = divmod(idx, ATLAS_CELLS)
    cy = ATLAS_CELLS - 1 - cy
    s = 1.0 / ATLAS_CELLS
    lo, hi = ATLAS_INSET * s, (1.0 - ATLAS_INSET) * s
    return np.array([[cx * s + lo, cy * s + lo], [cx * s + hi, cy * s + lo], [cx * s + hi, cy * s + hi], [cx * s + lo, cy * s + hi]])


def _uv_solid():
    """One UV for every corner: the centre of a round blob, alpha 1 with no
    derivative, so the sampler reads mip 0 there and never leaves the blob."""
    return np.repeat(_uv_cell(FILL_CELL).mean(0, keepdims=True), 4, 0)


def _faced(n, facing):
    """`n` rotated the least that makes it face the camera by `facing`: a card
    seen nearly edge-on is a spike, not a blob. Smooth, so neighbours agree."""
    d = float(n @ FACE)
    if d >= facing:
        return n
    perp = FACE - n * d
    L = np.linalg.norm(perp)
    if L < 1e-6:
        return n
    perp /= L
    ang = math.acos(max(-1.0, min(1.0, d))) - math.acos(facing)
    m = n * math.cos(ang) + perp * math.sin(ang)
    return m / np.linalg.norm(m)


# --------------------------------------------------------------------------
# 7. Sampling the paint


def _sample(v, t, f, hn, nr, density, rng):
    """Candidate points on the refined triangles inside the paint (f > 0), in
    proportion to area, with the field, hull normal and raw normal interpolated.
    Returns P, F, HN, NR, GRAD (the field's in-plane gradient per point)."""
    A = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    cross = np.cross(A[1] - A[0], A[2] - A[0])
    area = np.linalg.norm(cross, axis=1) * 0.5
    fc = f[t].max(1)
    expect = np.where(fc > -0.05, area * density, 0.0)
    count = np.floor(expect).astype(int) + (rng.random(len(t)) < (expect % 1.0))
    if count.sum() == 0:
        return (np.zeros((0, 3)),) * 5
    tri_idx = np.repeat(np.arange(len(t)), count)
    u = rng.random(len(tri_idx))
    w = rng.random(len(tri_idx))
    flip = u + w > 1
    u[flip], w[flip] = 1 - u[flip], 1 - w[flip]
    bary = np.stack([1 - u - w, u, w], 1)
    tt = t[tri_idx]

    def interp(attr):
        return (attr[tt] * bary[..., None]).sum(1) if attr.ndim == 2 else (attr[tt] * bary).sum(1)

    P = interp(v)
    F = interp(f)
    # The field's gradient on each triangle (planar), for the shoulder's outward direction.
    e1, e2 = A[1] - A[0], A[2] - A[0]
    n = cross / np.maximum(np.linalg.norm(cross, axis=1, keepdims=True), 1e-12)
    f1, f2 = f[t[:, 1]] - f[t[:, 0]], f[t[:, 2]] - f[t[:, 0]]
    g = (np.cross(n, e1) * f2[:, None] - np.cross(n, e2) * f1[:, None]) / np.maximum(2 * area, 1e-12)[:, None]
    keep = F > 0
    return P[keep], F[keep], _normalize(interp(hn))[keep], _normalize(interp(nr))[keep], g[tri_idx][keep]


def _crowd(P, r):
    """How many candidates lie within r of each: a blob with no neighbours would float alone."""
    if len(P) == 0:
        return np.zeros(0, int)
    keys = np.floor(P / r).astype(np.int64)
    buckets = defaultdict(list)
    for i, k in enumerate(map(tuple, keys)):
        buckets[k].append(i)
    out = np.zeros(len(P), int)
    for i, k in enumerate(map(tuple, keys)):
        near = [j for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1) for j in buckets.get((k[0] + dx, k[1] + dy, k[2] + dz), ())]
        out[i] = int((np.linalg.norm(P[near] - P[i], axis=1) < r).sum())
    return out


# --------------------------------------------------------------------------
# 8. The build


def build(host_mesh, host_matrix, stamps, vines, p):
    """The moss for one host: the carpet its paint covers, and a vine at every
    anchor. `host_mesh` is the host's evaluated mesh."""
    painted = len(stamps) > 0 and bool((stamps.strength > 0).any())
    if not painted and len(vines) == 0:
        return _empty_result()
    co, tri = host_world(host_mesh, host_matrix)
    if len(tri) == 0:
        return _empty_result()
    rnd = random.Random(p.seed)
    rng = np.random.default_rng(p.seed)
    quads = _Quads()
    under = None
    n_blobs = 0
    v = np.zeros((0, 3))
    hull = np.zeros((0, 3))

    if painted:
        centres, snormals = stamps_world(stamps, host_matrix)
        radii = stamps.radius.astype(np.float64)
        res = max(p.resolution, 0.005)
        v, t = _refine(co, tri, centres, radii, res)
        if len(t):
            n_raw = _vertex_normals(v, t)
            edges = _edges(t)
            m = _mask(v, n_raw, centres, snormals, radii, stamps.strength)
            thr = np.clip(p.threshold + p.edge_noise * _fbm(v, p.edge_scale, p.seed, 1), 0.03, 0.97)
            f = m - thr  # > 0 inside the paint
            iters = int(min(200, round((p.rounding / res) ** 2)))
            hull = _normalize(_smooth_field(n_raw, edges, len(v), iters))
            # Order-independence: the helpers above may return triangles in a
            # hash order that differs between processes, and every random draw
            # below walks them in order. Sort by position so the same paint
            # always grows the same moss.
            order = np.lexsort((v[t].mean(1)[:, 2], v[t].mean(1)[:, 1], v[t].mean(1)[:, 0]))
            t = t[order]
            under = _underlay(v, t, f, hull, p)
            n_blobs = _carpet(quads, v, t, f, hull, n_raw, p, rnd, rng)

    n_vines, n_leaves = _vines(quads, co, tri, v, hull, vines, host_matrix, p, rnd)
    r = _assemble(quads, under, host_matrix)
    r.blobs, r.vines, r.leaves = n_blobs, n_vines, n_leaves
    return r


def _underlay(v, t, f, hull, p):
    """The underlay: the paint's own outline, a little INSIDE where the blobs
    start, lifted `underlay` and coloured as a leaf. None when nothing is left.
    Inside, so the carpet's silhouette is blobs and never the underlay's
    smooth edge; the blobs on the shoulder roll down to the rock outside it."""
    uv_, ut, (uh, uf) = _clip(v, t, f - 0.015, [hull, f])
    ut = _drop_islands(uv_, ut, p.min_patch)
    if len(ut) == 0:
        return None
    uv_, ut, (uh, uf) = _compact(uv_, ut, [uh, uf])
    uh = _normalize(uh)
    lift = p.underlay * _smoothstep(0.0, 0.15, uf + 0.02)
    col = _tint(uh, np.full(len(uv_), 0.15), np.zeros(len(uv_)), _tone_at(uv_, (p.tone_a, p.tone_b, p.tone_c), p.tone_scale, p.seed), p)
    return uv_ + uh * lift[:, None], ut, uh, col


def _carpet(quads, v, t, f, hull, n_raw, p, rnd, rng):
    """The layers of blobs over the paint. Returns how many were laid."""
    P, F, HN, NR, G = _sample(v, t, f, hull, n_raw, p.density, rng)
    if len(P) == 0:
        return 0
    order = np.lexsort((P[:, 2], P[:, 1], P[:, 0]))
    P, F, HN, NR, G = P[order], F[order], HN[order], NR[order], G[order]
    area = len(P) / p.density  # the painted area, from the sampling density
    Mn = np.clip(F / 0.5, 0, 1)  # 0 at the paint's edge, 1 well inside
    tones = _tone_at(P, (p.tone_a, p.tone_b, p.tone_c), p.tone_scale, p.seed)
    crowd = _crowd(P, 0.06)
    seen = (HN @ FACE >= -0.35) & (crowd >= 4)  # the game never sees the back of a rock
    # The outward direction of the paint: down the field's gradient, in the tangent plane.
    Gt = G - HN * (G * HN).sum(1, keepdims=True)
    Gl = np.linalg.norm(Gt, axis=1)
    OUT = np.where((Gl > 0.2)[:, None], -Gt / np.maximum(Gl, 1e-12)[:, None], 0.0)
    # Toward the edge a candidate is taken this much more readily: the outer
    # band is where the shoulder thins the upper layers, and a gap there shows
    # the underlay as a rim around the mass.
    edge_w = 1.0 + p.edge_fill * (1.0 - Mn) ** 2

    band = max(p.shoulder, 1e-3)
    thick = max(p.thickness, 0.012)

    def shoulder(i, dL):
        """Where a card at height dL sits in the outer band, and which way it
        faces: a quarter-round of radius `thickness`, flat on top of the mass,
        standing against the rock at the paint's edge; a card below the
        surface tilts in proportion to its depth. None when dL is above the
        mass here."""
        hn = HN[i]
        o = OUT[i]
        if Mn[i] >= band or not o.any():
            return (P[i] + hn * dL, hn) if dL <= thick else (None, None)
        x = Mn[i] / band
        phi = min(math.radians(65), math.asin(max(0.0, 1 - x)))
        h_surface = thick * math.cos(phi)
        if dL > max(h_surface, 0.012):
            return None, None
        frac = min(1.0, dL / max(h_surface, 0.012))
        a = phi * frac
        n = hn * math.cos(a) + o * math.sin(a)
        c = P[i] + hn * dL * math.cos(a) + o * dL * math.sin(a) * 0.3
        return c, n / np.linalg.norm(n)

    idx = np.flatnonzero(seen).tolist()
    layers = max(int(p.layers), 1)
    heights = [0.008 + (thick - 0.008) * i / max(layers - 1, 1) for i in range(layers)]
    subh = 0.002
    blob_mean = (p.blob_min + p.blob_max) / 2
    n_blobs = 0
    for L, dL in enumerate(heights):
        rnd.shuffle(idx)
        allowed = [i for i in idx if shoulder(i, dL)[0] is not None]
        if not allowed:
            continue
        mean_size = blob_mean * (0.6 + 0.4 * float(np.mean(Mn[allowed])))
        want = p.fill * area * (len(allowed) / len(idx)) / (math.pi * (mean_size / 2) ** 2)
        p_take = min(1.0, want / len(allowed))
        depth_L = max(0.0, 1 - L / 4)
        for j, i in enumerate(allowed):
            if rnd.random() > p_take * edge_w[i]:
                continue
            size = rnd.uniform(p.blob_min, p.blob_max) * (0.6 + 0.4 * Mn[i])
            c, n = shoulder(i, dL + subh * (j % 3))
            if c is None:
                continue
            n = _faced(n, p.facing)
            col = _tint(HN[i], np.array(depth_L * Mn[i]), np.array(rnd.uniform(-p.variation, p.variation)), tones[i], p)
            quads.add(_quad(c, n, size, size * rnd.uniform(0.85, 1.0), rnd.uniform(0, math.tau)), HN[i], col, _uv_cell(rnd.choice(BLOB_CELLS)))
            n_blobs += 1
    return n_blobs


def _vines(quads, co, tri, v, hull, vines, host_matrix, p, rnd):
    """A vine at every anchor: a stem hanging straight down, held in front of
    the rock, wearing lobed leaves that alternate sides and taper toward the
    tip. Anchors are walked in a fixed order so the draw is reproducible.
    Returns (vines, leaves)."""
    if len(vines) == 0:
        return 0, 0
    M = np.array(host_matrix, dtype=np.float64)
    origins = vines.position @ M[:3, :3].T + M[:3, 3]
    order = np.lexsort((origins[:, 2], origins[:, 1], origins[:, 0]))
    bvh = BVHTree.FromPolygons([tuple(x) for x in co], [tuple(x) for x in tri.tolist()])
    hull_kd = None
    if len(v):
        hull_kd = KDTree(len(v))
        for i, q in enumerate(v):
            hull_kd.insert(q, i)
        hull_kd.balance()
    tones = _tone_at(origins, (p.tone_a, p.tone_b, p.tone_c), p.tone_scale, p.seed)
    n_vines = n_leaves = 0
    for k_v in order.tolist():
        origin = origins[k_v]
        length = max(float(vines.length[k_v]), 0.05)
        # The normal the leaves shade with: the carpet's hull where the anchor
        # sits in paint, else the rock's own surface.
        hn = None
        if hull_kd is not None:
            _q, i, d = hull_kd.find(Vector(origin))
            if i is not None and d < 0.3:
                hn = hull[i]
        if hn is None:
            near = bvh.find_nearest(Vector(origin))
            hn = np.array(near[1]) if near[0] is not None else -FACE
            hn = _normalize(hn)
        sway = rnd.uniform(0.006, 0.015)
        phase = rnd.uniform(0, 6)

        def at(z, clear=0.02):
            """The stem's point z metres below the anchor, held in FRONT of the rock."""
            q = origin + np.array((sway * math.sin(z * 12 + phase), 0.0, -z)) + FACE * (0.02 + 0.03 * z / length)
            hit = bvh.ray_cast(Vector(q + FACE * 5.0), Vector(-FACE))
            if hit[0] is not None:
                front_y = float(np.array(hit[0]) @ FACE)  # how far toward the camera the rock reaches here
                if q @ FACE < front_y + clear:
                    q = q + FACE * (front_y + clear - q @ FACE)
            return q

        zs = np.linspace(0.0, length, max(2, int(length / 0.03) + 1))
        pts = np.array([at(z) for z in zs])
        side = np.array((0.0015, 0.0, 0.0))
        stem_col = np.asarray(p.tone_b) * 0.75
        for k in range(len(pts) - 1):
            a, b = pts[k], pts[k + 1]
            # Wound so the face looks toward the camera: the material culls the back.
            quads.add(np.array([a + side, a - side, b - side, b + side]), hn, stem_col, _uv_solid())
        vn = hn * 0.5 + FACE * 0.5
        vn /= np.linalg.norm(vn)
        vn = _faced(vn, p.facing)
        z = p.leaf_size * 0.25
        sgn = rnd.choice((-1, 1))
        k = 0
        while z < length:
            tt = z / length
            size = p.leaf_size + (p.leaf_tip - p.leaf_size) * tt
            c = at(z + size * 0.42, clear=0.03 + 0.004 * (k % 2 + 1)) + np.array((sgn * size * 0.3, 0.0, 0.0))
            spin = sgn * math.radians(rnd.uniform(18, 34))
            col = _tint(hn, np.array(0.1 + 0.4 * tt), np.array(rnd.uniform(-0.1, 0.1)), tones[k_v], p)
            quads.add(_quad(c, vn, size, size, spin), hn, col, _uv_cell(rnd.choice(LEAF_CELLS)))
            n_leaves += 1
            z += size * 0.55
            sgn = -sgn
            k += 1
        n_vines += 1
    return n_vines, n_leaves


def _assemble(quads, under, host_matrix):
    co, tri, nrm, col, uv = quads.arrays()
    if under is not None:
        under_v, under_t, under_n, under_c = under
        off = len(co)
        co = np.vstack([co, under_v])
        nrm = np.vstack([nrm, under_n])
        col = np.vstack([col, under_c])
        tri = np.vstack([tri, under_t + off])
        uv = np.vstack([uv, np.repeat(_uv_solid()[:3][None], len(under_t), 0)])
    if len(tri) == 0:
        return _empty_result()
    # Back to the host's local frame.
    M = np.array(host_matrix, dtype=np.float64)
    R = M[:3, :3]
    co_local = (co - M[:3, 3]) @ np.linalg.inv(R).T
    n_local = _normalize(nrm @ R)
    colors = np.concatenate([col, np.ones((len(col), 1))], 1)
    return Result(co_local, tri.astype(np.int64), colors, uv, n_local)
