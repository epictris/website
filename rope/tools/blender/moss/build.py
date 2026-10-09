"""Painterly moss: a painted mask on a host mesh becomes a low mound of moss whose
colour is printed dab by dab, darkest at its rim and lightest in a few clumps, and
whose height follows its colour - the lighter, the taller.

It is the cave sheet study's moss (rope/tools/blender/cave-sheet-study/moss_study.py,
`grow_layers`, settled with the owner over many rounds on 2026-10-01/02; the history
is rope/docs/blender-moss.md) made into a pure function of (host mesh, host matrix,
stamps, params): no bpy state is read or written, except through the `decimate`
callable the caller passes, so the add-on's rebuild and the scene exporter's grow
the same moss.

THE PIPELINE (world space, metres; the result is returned in the host's local frame,
because the moss object is parented to the host with an identity transform):

1. The host's triangles under the stamps (and a dab's reach beyond them), refined
   to `resolution`, sorted by position so every random draw is reproducible.
2. The paint: the stamps composited into a coverage; `threshold` cuts the painted
   area. The paint decides WHERE moss grows; the dabs draw its outline.
3. Layer 0: the painted area packed with dark dabs. A dab is a rounded irregular
   blob - a polar curve r(t) = r (1 + a1 cos(t - p1) + a2 cos(2t - p2) +
   a3 cos(3t - p3)) - and always CONCAVE: a draw whose solidity (area over convex
   hull area) is above SOLIDITY_MAX (0.97) is drawn again (the owner: "the blobs look too
   round ... remove all the convex shapes").
4. The erosion field: the painted area eroded inward pass after pass by an uneven
   step (a slow noise decides where a pass bites, a fast one roughs the outline);
   a vertex scores how many passes it survives, continuously. Its ridges and
   summits are where the light belongs. The step is one fixed reference for every
   rock (`ref_depth` / `steps_deep`), so a small patch scores low and stays
   mid-green, as small patches do.
5. Layers 1..`layers`: lighter clumps grown dab by dab inside the layer below,
   seeded at the field's summits, each kept `buffer` inside the parent layer's
   extent; the first two fill to that buffer, the rest are islands holding a
   shrinking share of the parent's dabs. Clumps under `min_clump` dabs go.
6. Tone: per dab, from the field at the dab and its layer, plus a slow positional
   mottle, quantised to `levels` steps from `dark` to `light` (spaced in sRGB), so
   neighbours share a step and merge into one blotch. No per-dab randomness.
7. Height: `floor` for the darkest moss plus the tone painted onto the vertices
   times `lift` (the lightest moss stands `floor + lift` proud), the tone's share
   times how much the surface faces up (`up_floor` of it on a wall: a full pile on
   a wall faces the ground on its way down), blurred over `height_blur`. At the
   rim the mound starts `sink` under the rock and rises to that height over `rim`,
   so it crosses the rock along one line: a mound left flush with the rock across
   an area decimates into slivers with noise normals that shade a dark strip along
   the moss edge. (While the dabs were also printed on the rock, moss thinner
   than `sink` was print only; without that print it would be a hole.)
8. The mound: the refined mesh where the dabs reach (`inner_u` of a dab's outline),
   offset along the smoothed normal from the rock surface, decimated to
   `mound_density` triangles a square metre, its open edge seated `sink` under the
   rock again.
9. The print: the mound's own texture. Every mound triangle gets its own chart in
   a shelf-packed atlas at `texel` metres a texel; each texel's world position and
   normal are interpolated, and every dab is evaluated per texel - its outline in
   its tangent plane, a `print_edge` anti-aliased edge, its flat tone over what is
   below. The outline of the moss is where the mound leaves the rock.

`build` is `finish(grow(...))`: `grow` is steps 1-8 up to the decimate, `finish`
the decimate and the print. FINISH_PARAMS are the parameters only `finish`
reads, so the add-on can finish a cached growth again when only the poly count
or the texture changed.
"""

import heapq
import math
import os
import random
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import numpy as np
from mathutils import Vector, noise
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

from .stampbrush.geometry import edges as mesh_edges
from .stampbrush.geometry import kdtree, mask, normalize, refine, smooth_field, smoothstep, stamps_world, vertex_normals

# A dab must be at least this concave (area over its convex hull's). Measured over
# 2000 draws of HARMONICS: median 0.985, 5th percentile 0.956, and 18 % at or under
# 0.97 - enough of a dent to see, at about five draws a dab.
SOLIDITY_MAX = 0.97
MAX_DRAWS = 200
DEBUG = bool(os.environ.get("MOSS_DEBUG"))
HARMONICS = ((0.08, 0.3), (0.1, 0.35), (0.0, 0.18))  # a1, a2, a3 ranges
FRACS = (1.0, 1.0, 0.55, 0.3, 0.18)  # each layer's share of its parent's dabs; 1 = fill to the buffer
FILL_SEED_AREA = 0.0144  # m^2 of eligible area per extra seed in a fill layer (400 study voxels)
# The study measured every depth in hops over its 6 mm voxel remesh, a Manhattan-like
# metric: 1.42x the straight-line distance (median over 5-25 cm on the study's column,
# 2026-10-02), where paths over this refined mesh run 1.06x. Its buffers, erosion steps
# and rim were settled in that unit, so depths here are scaled to it.
STUDY_METRIC = 1.35
MOUND_LIFT_ROOM = 0.03  # how far off the slab of mound over its plane a texel may sit and still take a dab
DECAL_LIFT = 0.003  # a texture-only moss's decal stands this far off the rock (viewport only; clear of depth fighting)


@dataclass
class Params:
    """Every knob of a moss object. Lengths are metres, colours linear RGB."""

    seed: int = 0
    # "MOUND": a mound of moss with its own printed texture; "TEXTURE": no
    # geometry, the dabs painted into the rock's colour map on export.
    kind: str = "MOUND"
    resolution: float = 0.012  # edge length the host is refined to under the paint
    threshold: float = 0.35  # paint coverage at which moss starts
    # Dabs
    dab_min: float = 0.032
    dab_max: float = 0.05
    layers: int = 5
    shrink: float = 0.92  # dab radius per layer (floored at 0.65)
    buffer: float = 0.035  # how far inside the layer below a lighter layer stays
    first_buffer: float = 0.012  # ... for the first lighter layer
    min_clump: int = 6
    # Erosion field and tone
    ref_depth: float = 0.42  # a patch this deep reaches the full range (the same for every rock)
    steps_deep: float = 5.0
    erode_scale: float = 14.0  # 1/m: the fast noise that roughs each pass's outline
    field_mix: float = 0.55  # tone from the field vs from the layer
    curve: float = 1.3
    mottle: float = 0.6  # of a tone step
    mottle_scale: float = 4.0  # 1/m
    levels: int = 8
    dark: tuple = (0.0237, 0.0567, 0.0419)  # the study's darkest (sRGB 0.167, 0.264, 0.226)
    light: tuple = (0.0882, 0.1758, 0.0179)  # the study's lightest (sRGB 0.329, 0.456, 0.142)
    # Height
    floor: float = 0.008  # the darkest moss stands this proud, away from the rim
    lift: float = 0.09  # the lightest moss stands this much prouder than the darkest
    up_floor: float = 0.3  # share of the height a wall keeps
    height_blur: float = 0.027
    sink: float = 0.006
    rim: float = 0.10
    drape: float = 1.0  # the tightest the moss's sheet bends: steps and hollows tighter are bridged (0: it follows the rock)
    inner_u: float = 0.88  # the mound stops this far out in a dab's outline
    min_patch: float = 0.002  # m^2: mound islands smaller than this go
    mound_density: float = 1500.0  # triangles per m^2 of mound
    # Print
    texel: float = 0.0015
    max_texture: int = 2048
    print_edge: float = 0.002


@dataclass
class Result:
    vertices: np.ndarray  # (V, 3) host-local
    triangles: np.ndarray  # (T, 3)
    uvs: np.ndarray  # (T, 3, 2) per corner
    image: np.ndarray  # (S, S, 4) linear RGB + coverage, row 0 at the bottom (Blender's order)
    dabs: int = 0
    layers: list = field(default_factory=list)  # dabs per layer
    heights: dict = field(default_factory=dict)  # tone step -> mean mm over the rock (the check: rising)
    texel: float = 0.0  # the print's texel: `texel`, or coarser where the mound did not fit `max_texture`
    area: float = 0.0  # m^2 of mound


def empty_result():
    return Result(np.zeros((0, 3)), np.zeros((0, 3), np.int64), np.zeros((0, 3, 2)), np.zeros((0, 0, 4)))


def _lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _srgb(c):
    return c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


# --------------------------------------------------------------------------
# Dab shapes


_TH = np.linspace(0.0, 2 * math.pi, 96, endpoint=False)
_TH_K = [(j + 1) * _TH for j in range(len(HARMONICS))]  # the angles of each harmonic
_COS, _SIN = np.cos(_TH), np.sin(_TH)


def _outline(harm):
    # 35k calls a build: the angle tables are made once, the same values.
    rr = 1 + sum(a * np.cos(_TH_K[j] - ph) for j, (a, ph) in enumerate(harm))
    return np.stack([rr * _COS, rr * _SIN], 1)


def _area(pts):
    x, y = pts[:, 0], pts[:, 1]
    # np.roll(a, -1), without its overhead
    return 0.5 * abs(float(np.dot(x, np.concatenate((y[1:], y[:1]))) - np.dot(np.concatenate((x[1:], x[:1])), y)))


def _hull(pts):
    """Convex hull of a star-shaped outline already in angular order about the
    origin: one Graham pass, no sort (a sort per draw was most of a build's time)."""
    start = int(np.argmin(pts[:, 1] * 1e6 + pts[:, 0]))  # the lowest point is on the hull
    seq = [tuple(x) for x in np.roll(pts, -start, axis=0).tolist()]
    h = []
    for p in seq + [seq[0]]:
        while len(h) >= 2 and (h[-1][0] - h[-2][0]) * (p[1] - h[-2][1]) - (h[-1][1] - h[-2][1]) * (p[0] - h[-2][0]) <= 0:
            h.pop()
        h.append(p)
    return np.array(h[:-1])


def solidity(harm):
    pts = _outline(harm)
    return _area(pts) / _area(_hull(pts))


def dab_shape(rng):
    """The harmonics of a concave blob: convex (or barely dented) draws are drawn
    again, and after MAX_DRAWS the most concave seen is taken."""
    best, best_s = None, 2.0
    for _ in range(MAX_DRAWS):
        harm = tuple((rng.uniform(*r), rng.uniform(0, 2 * math.pi)) for r in HARMONICS)
        s = solidity(harm)
        if s <= SOLIDITY_MAX:
            return harm
        if s < best_s:
            best, best_s = harm, s
    return best


class Dab:
    __slots__ = ("c", "n", "r", "k", "ax", "ay", "harm", "rmax", "t", "tone", "h")

    def lay(self, c, n):
        """Move the dab to `c`, facing `n`, its outline turned as little as the
        new plane allows (where the draped sheet carries it off the rock)."""
        ax = self.ax - n * self.ax.dot(n)
        if ax.length < 1e-6:
            ax = self.ay - n * self.ay.dot(n)
        self.c, self.n = c, n
        self.ax = ax.normalized()
        self.ay = n.cross(self.ax)

    def __init__(self, c, n, r, k, rng):
        self.c, self.n, self.r, self.k = c, n, r, k
        tx = n.cross(Vector((0.3, 0.7, 0.2))).normalized()
        ty = n.cross(tx)
        a = rng.uniform(0, 2 * math.pi)
        self.ax = tx * math.cos(a) + ty * math.sin(a)
        self.ay = ty * math.cos(a) - tx * math.sin(a)
        self.harm = dab_shape(rng)
        self.rmax = r * (1 + sum(h[0] for h in self.harm))
        self.t = 0.0
        self.tone = (0.0, 0.0, 0.0)
        self.h = 0.0  # how far the mound stands over this dab's plane (for the print's search)

    def u(self, pts):
        """How far out each point is in this dab's outline (1 = on it), and the
        outline's radius there, for points (N, 3) projected on its plane."""
        d = pts - np.asarray(self.c)
        x = d @ np.asarray(self.ax)
        y = d @ np.asarray(self.ay)
        th = np.arctan2(y, x)
        rr = self.r * (1 + sum(a * np.cos((j + 1) * th - ph) for j, (a, ph) in enumerate(self.harm)))
        return np.hypot(x, y) / np.maximum(rr, 1e-9), rr


class _Grid:
    """Dabs hashed by centre, for 'is any dab within d' tests."""

    def __init__(self, cell):
        self.cell = cell
        self.cells = {}

    def _key(self, p):
        return (int(math.floor(p[0] / self.cell)), int(math.floor(p[1] / self.cell)), int(math.floor(p[2] / self.cell)))

    def add(self, d):
        self.cells.setdefault(self._key(d.c), []).append(d)

    def near(self, c, reach):
        kx, ky, kz = self._key(c)
        span = int(math.ceil(reach / self.cell))
        for x in range(kx - span, kx + span + 1):
            for y in range(ky - span, ky + span + 1):
                for z in range(kz - span, kz + span + 1):
                    yield from self.cells.get((x, y, z), ())


# --------------------------------------------------------------------------
# Graph helpers over the refined mesh


class _Graph:
    def __init__(self, v, t):
        self.n = len(v)
        e = mesh_edges(t)
        self.edges = e
        L = np.linalg.norm(v[e[:, 1]] - v[e[:, 0]], axis=1)
        adj = [[] for _ in range(self.n)]
        for (a, b), ln in zip(e.tolist(), L.tolist()):
            adj[a].append((b, ln))
            adj[b].append((a, ln))
        self.adj = adj
        # each vertex's share of the area around it
        area = 0.5 * np.linalg.norm(np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]]), axis=1)
        self.area = np.zeros(self.n)
        for k in range(3):
            np.add.at(self.area, t[:, k], area / 3.0)

    def dijkstra(self, sources, within=None):
        """Distance along the edges from the nearest source (a bool mask),
        walking only into `within` (a bool mask; everywhere when None).
        Outside it, a vertex that is not a source stays at inf."""
        dist = np.full(self.n, np.inf)
        idx = np.nonzero(sources)[0]
        dist[idx] = 0.0
        heap = [(0.0, int(i)) for i in idx]
        heapq.heapify(heap)
        adj = self.adj
        walk = np.ones(self.n, bool) if within is None else within
        while heap:
            d, i = heapq.heappop(heap)
            if d > dist[i]:
                continue
            for j, ln in adj[i]:
                nd = d + ln
                if nd < dist[j] and walk[j]:
                    dist[j] = nd
                    heapq.heappush(heap, (nd, j))
        return dist

    def flood(self, start, through):
        """Every vertex reachable from `start` (mask) through `through` (mask)."""
        seen = start.copy()
        stack = list(np.nonzero(start)[0])
        adj = self.adj
        while stack:
            i = stack.pop()
            for j, _l in adj[i]:
                if not seen[j] and through[j]:
                    seen[j] = True
                    stack.append(j)
        return seen

    def components(self, members):
        """Connected components of the vertices in `members` (mask), each a list."""
        comp = np.full(self.n, -1)
        out = []
        adj = self.adj
        for i in np.nonzero(members)[0]:
            if comp[i] >= 0:
                continue
            comp[i] = len(out)
            group, stack = [], [int(i)]
            while stack:
                a = stack.pop()
                group.append(a)
                for b, _l in adj[a]:
                    if members[b] and comp[b] < 0:
                        comp[b] = len(out)
                        stack.append(b)
            out.append(group)
        return out

    def _border(self, members):
        """The vertices of `members` with a neighbour outside it."""
        e = self.edges
        cut = members[e[:, 0]] != members[e[:, 1]]
        out = np.zeros(self.n, bool)
        out[e[cut].ravel()] = True
        return out & members

    def depth_inside(self, painted, inside):
        """How far each vertex is in from the outside of `inside`, where the
        outside is only what connects to the unpainted rock: a pocket between two
        clumps is not an edge, or every layer above would widen it. A vertex the
        walk never reaches counts as outside (it would grow specks)."""
        # Both walks start only where they can go somewhere: every unpainted
        # vertex is outside, but only one next to the paint can lead the flood
        # in, and every outside vertex is at 0, but only one next to the rest
        # can start a shortest path into it (a path through another outside
        # vertex is longer than one starting there). The same sets and
        # distances, for a fraction of the walk over the unpainted margin.
        outside = self.flood(self._border(~painted), ~inside)
        outside |= ~painted
        d = self.dijkstra(self._border(outside), within=~outside)
        d[outside] = 0.0
        d = d * STUDY_METRIC
        d[np.isinf(d)] = 0.0
        return d


def _passes(blur, res):
    """Umbrella-smoothing passes that blur a field over about `blur` metres."""
    return int(max(0, round(2.0 * (blur / max(res, 1e-6)) ** 2)))


# --------------------------------------------------------------------------
# The build


@dataclass
class Grown:
    """The moss before its low poly and its print: the dabs and the full-resolution
    mound (world space), and what `finish` measures them against. It depends on
    every parameter except FINISH_PARAMS, so a change to those finishes it again
    without growing it again. `finish` never changes it."""

    vertices: np.ndarray  # (V, 3) world, the mound at the refined resolution
    triangles: np.ndarray  # (T, 3)
    layers: list  # [[Dab]] lowest first, toned and with their heights
    bvh: BVHTree  # the host
    kd: KDTree  # the refined host's vertices
    tval: np.ndarray  # tone at each refined vertex (nan: no dab)
    host_matrix: np.ndarray  # (4, 4)


# The parameters only `finish` reads: the mound's triangle budget and the print.
FINISH_PARAMS = ("mound_density", "texel", "max_texture", "print_edge")


def build(co, tri, host_matrix, stamps, p, decimate):
    """The moss for one host, from the host's welded world triangles (`co`, `tri`:
    stampbrush.geometry.host_world). `decimate(v, t, ratio) -> (v, t)` reduces a
    mesh (the caller's Blender decimate; the build itself touches no bpy state)."""
    grown = grow(co, tri, host_matrix, stamps, p)
    return finish(grown, p, decimate) if grown is not None else empty_result()


def grow(co, tri, host_matrix, stamps, p):
    """Steps 1-8 short of the decimate: the dabs and the full-resolution mound, or
    None when there is no moss to grow."""
    if len(stamps) == 0 or not bool((stamps.strength > 0).any()):
        return None
    if len(tri) == 0:
        return None
    rng = random.Random(p.seed)
    centres, snormals = stamps_world(stamps, host_matrix)
    radii = stamps.radius.astype(np.float64)
    res = max(p.resolution, 0.004)
    reach = p.dab_max * 1.9  # a dab's outline reaches past its centre, which is in the paint
    v, t = refine(co, tri, centres, radii + reach, res)
    if len(t) == 0:
        return None
    # Canonical order: vertices and triangles by position, so the draws below
    # walk the same mesh the same way in any process.
    vo = np.lexsort((v[:, 2], v[:, 1], v[:, 0]))
    remap = np.empty(len(v), np.int64)
    remap[vo] = np.arange(len(v))
    v, t = v[vo], remap[t]
    tc = v[t].mean(1)
    t = t[np.lexsort((tc[:, 2], tc[:, 1], tc[:, 0]))]

    n_raw = vertex_normals(v, t)
    g = _Graph(v, t)
    hull = normalize(smooth_field(n_raw, g.edges, len(v), _passes(0.02, res)))
    painted = mask(v, n_raw, centres, snormals, radii, stamps.strength) >= p.threshold
    if g.area[painted].sum() < 0.002:
        return None
    P = [Vector(x) for x in v]
    N = [Vector(x) for x in hull]
    kd = kdtree(v)
    off = Vector((rng.uniform(0, 50), rng.uniform(0, 50), rng.uniform(0, 50)))

    layers = _grow(p, rng, g, P, N, kd, painted, off, res)
    _tone(p, layers, P, kd, g, painted, off, res)

    # ---- height, and the mound
    tval = np.full(len(v), np.nan)
    inner = np.zeros(len(v))
    for layer in layers:
        for d in layer:
            idx = np.array([i for (_c, i, _d) in kd.find_range(d.c, d.rmax)], dtype=np.int64)
            if len(idx) == 0:
                continue
            u, rr = d.u(v[idx])
            ok = u <= 1.0
            idx, u, rr = idx[ok], u[ok], rr[ok]
            w = smoothstep(1.0, 1.0 - 0.01 / np.maximum(rr, 1e-6), u)
            cur = tval[idx]
            tval[idx] = np.where(np.isnan(cur), d.t, cur + (d.t - np.nan_to_num(cur)) * w)
            inner[idx[u <= p.inner_u]] = 1.0
    if p.kind == "TEXTURE":
        return _grown_decal(co, tri, host_matrix, v, t, hull, g, kd, tval, layers)
    lift = _lift(p, tval, hull[:, 2], g, res)
    inner = smooth_field(inner, g.edges, len(v), max(1, _passes(0.006, res)))

    keep = inner[t].mean(1) > 0.5
    mt = t[keep]
    if len(mt) == 0:
        return None
    mt = _drop_small(v, mt, p.min_patch)
    if len(mt) == 0:
        return None
    used = np.unique(mt)
    m_remap = np.full(len(v), -1, np.int64)
    m_remap[used] = np.arange(len(used))
    mv, mt = v[used], m_remap[mt]
    mg = _Graph(mv, mt)
    boundary = _boundary(mt, len(mv))
    rimf = smoothstep(0.0, p.rim, mg.dijkstra(boundary) * STUDY_METRIC)
    if p.drape <= 0.0:
        # under the rock at the rim, and from there up to the moss's height: it
        # crosses the rock along one line and is never flush with it across an area
        offset = -p.sink + (p.sink + lift[used]) * rimf
        offset = smooth_field(offset, mg.edges, len(mv), 1)
        mv = mv + hull[used] * offset[:, None]
        _set_heights(layers, kd, lift)
    else:
        # The same height in two parts: the sheet (the rim and `floor`), draped
        # over the rock's steps and hollows, and the pile standing on it.
        sheet_h = np.minimum(lift[used], p.floor)
        base = smooth_field(-p.sink + (p.sink + sheet_h) * rimf, mg.edges, len(mv), 1)
        sheet = _drape(mv + hull[used] * base[:, None], hull[used], mt, mg, boundary, p.drape, res)
        sn = normalize(smooth_field(vertex_normals(sheet, mt), mg.edges, len(mv), _passes(0.02, res)))
        # the pile faces the way the sheet does: a step bridged by a slope
        # piles like a slope, not like the wall under it
        nz = hull[:, 2].copy()
        nz[used] = sn[:, 2]
        lift = _lift(p, tval, nz, g, res)
        pile = smooth_field((lift[used] - sheet_h) * rimf, mg.edges, len(mv), 1)
        _set_heights(layers, kd, lift)
        # a dab rides the sheet off the rock, so the print finds it over the
        # moss it colours
        moved = sheet - (mv + hull[used] * base[:, None])
        for layer in layers:
            for d in layer:
                i = m_remap[kd.find(d.c)[1]]
                if i >= 0:
                    d.lay(Vector(mv[i] + moved[i]), Vector(sn[i]))
        mv = sheet + sn * pile[:, None]

    bvh = BVHTree.FromPolygons([tuple(x) for x in co], [tuple(x) for x in tri.tolist()])
    return Grown(mv, mt, layers, bvh, kd, tval, np.array(host_matrix, dtype=np.float64))


def _grown_decal(co, tri, host_matrix, v, t, hull, g, kd, tval, layers):
    """A texture-only moss: no mound. Its dabs are painted into the rock's own
    colour map when the scene is exported (`paint_texels`, called by
    scene_export.py); in Blender they show on a decal, the refined rock under
    the dabs (and a ring of triangles more, which a dab's outline can cross
    with no vertex inside) lifted DECAL_LIFT along the smoothed normal."""
    covered = ~np.isnan(tval)
    e = g.edges
    ring = covered.copy()
    ring[e[covered[e[:, 0]], 1]] = True
    ring[e[covered[e[:, 1]], 0]] = True
    mt = t[ring[t].any(1)]
    if len(mt) == 0:
        return None
    for layer in layers:
        for d in layer:
            d.h = 0.0  # flat: the print looks for texels on the dab's own plane
    used = np.unique(mt)
    m_remap = np.full(len(v), -1, np.int64)
    m_remap[used] = np.arange(len(used))
    mv, mt = v[used] + hull[used] * DECAL_LIFT, m_remap[mt]
    bvh = BVHTree.FromPolygons([tuple(x) for x in co], [tuple(x) for x in tri.tolist()])
    return Grown(mv, mt, layers, bvh, kd, tval, np.array(host_matrix, dtype=np.float64))


def finish(grown, p, decimate):
    """Step 8's decimate and step 9's print: the moss at `mound_density` and
    `texel`, in the host's local frame. A texture-only moss's decal is not
    decimated (collapsing it would cut across the rock's creases) and its
    print carries the dabs' coverage as alpha."""
    mv, mt, layers, bvh = grown.vertices.copy(), grown.triangles, grown.layers, grown.bvh
    if p.kind == "TEXTURE":
        area = 0.5 * np.linalg.norm(np.cross(mv[mt[:, 1]] - mv[mt[:, 0]], mv[mt[:, 2]] - mv[mt[:, 0]]), axis=1).sum()
        uvs, image, texel = _print(mv, mt, layers, p)
        inv = np.linalg.inv(grown.host_matrix)
        local = mv @ inv[:3, :3].T + inv[:3, 3]
        return Result(local, mt, uvs, image, dabs=sum(len(x) for x in layers), layers=[len(x) for x in layers], heights={}, texel=texel, area=area)
    # ---- low poly, its edge back under the rock
    area = 0.5 * np.linalg.norm(np.cross(mv[mt[:, 1]] - mv[mt[:, 0]], mv[mt[:, 2]] - mv[mt[:, 0]]), axis=1).sum()
    ratio = min(1.0, max(0.005, p.mound_density * area / max(len(mt), 1)))
    if ratio < 1.0:
        mv, mt = decimate(mv, mt, ratio)
    for i in np.nonzero(_boundary(mt, len(mv)))[0]:
        on, nr, _i, _d = bvh.find_nearest(Vector(mv[i]))
        if on is not None:
            mv[i] = np.array(on - nr * p.sink)

    heights = _heights(mv, bvh, grown.kd, grown.tval, p.levels)
    uvs, image, texel = _print(mv, mt, layers, p)
    inv = np.linalg.inv(grown.host_matrix)
    local = mv @ inv[:3, :3].T + inv[:3, 3]
    return Result(local, mt, uvs, image, dabs=sum(len(x) for x in layers), layers=[len(x) for x in layers], heights=heights, texel=texel, area=area)


def _lift(p, tval, nz, g, res):
    """How far the moss stands proud of the rock at each refined vertex: `floor`,
    and the tone times `lift` times how much the moss faces up there (`nz`, the
    up component of its normal), blurred over `height_blur`."""
    up = p.up_floor + (1 - p.up_floor) * smoothstep(0.0, 0.7, nz)
    lift = np.where(np.isnan(tval), 0.0, p.floor + p.lift * np.nan_to_num(tval) * up)
    return smooth_field(lift, g.edges, len(tval), _passes(p.height_blur, res))


def _set_heights(layers, kd, lift):
    for layer in layers:
        for d in layer:
            d.h = max(0.0, float(lift[kd.find(d.c)[1]]))


DRAPE_CELL = 0.025  # m: the coarse mesh the sheet is draped on
DRAPE_WINDOW = 100  # passes
DRAPE_TOL = 2e-4  # m: the sheet is settled when under 1 % of its clusters move this far in DRAPE_WINDOW passes
DRAPE_PASSES = 20000  # ... or after this many passes


def _drape(base, nrm, tri, g, boundary, radius, res):
    """The moss's sheet, draped over the rock instead of following it into every
    corner: a sheet under tension, pressed onto `base` (the mound's vertices at
    the sheet's height over the rock, whose normals are `nrm`) so firmly that it
    bends no tighter than `radius`. Where the rock is flat, convex or curves
    more gently than that, the sheet lies on `base`; across a step or a hollow
    tighter than that it is free, and spans it in a curve of that radius - from
    a ledge's edge it slopes down to the moss below instead of dropping with the
    rock and turning a right angle at its foot. The open edge stays on `base`.

    It is the settled sheet (`_relax`), not some number of smoothing passes,
    so neither `Resolution` nor the size of the patch changes its shape. The
    vertices are free to slide along the sheet (they spread evenly down a
    slope), so it is solved as positions, not heights: a height along each
    vertex's own normal folds the sheet in a concave corner, where the wall's
    and the floor's normals cross.
    It is solved on clusters of the mesh about DRAPE_CELL across (the vertices
    in one cell connected inside it, so a thin fin's two faces stay apart),
    carried back to the vertices, and pressed there for the passes that reach
    over two cells: each cluster carries the rock's corner inside it along
    rigidly, and the pile stood on that kink folded (the 25 cm test step:
    566 flipped triangles, 16 after, all where the rim tucks under the rock)."""
    n = len(base)
    e = g.edges
    cell = max(res, DRAPE_CELL)
    key = np.floor(base / cell).astype(np.int64)
    inner = e[(key[e[:, 0]] == key[e[:, 1]]).all(1)]
    lab = np.arange(n)
    while True:
        m = np.minimum(lab[inner[:, 0]], lab[inner[:, 1]])
        new = lab.copy()
        np.minimum.at(new, inner[:, 0], m)
        np.minimum.at(new, inner[:, 1], m)
        new = new[new]
        if (new == lab).all():
            break
        lab = new
    _u, cl = np.unique(lab, return_inverse=True)
    cl = cl.reshape(-1)
    k = len(_u)
    count = np.bincount(cl, minlength=k).astype(np.float64)
    cs = np.stack([np.bincount(cl, base[:, j], k) for j in range(3)], 1) / count[:, None]
    cn = normalize(np.stack([np.bincount(cl, nrm[:, j], k) for j in range(3)], 1))
    pin = np.bincount(cl, boundary.astype(np.float64), k) > 0
    ce = np.unique(np.sort(cl[e], axis=1), axis=0)
    ce = ce[ce[:, 0] != ce[:, 1]]
    ct = cl[tri]
    ct = ct[(ct[:, 0] != ct[:, 1]) & (ct[:, 1] != ct[:, 2]) & (ct[:, 2] != ct[:, 0])]
    q = _relax(cs.copy(), cs, cn, pin, ce, DRAPE_PASSES, 1e-4 * cell, radius=radius, tri=ct)
    sheet = base + (q - cs)[cl]
    return _relax(sheet, base, nrm, boundary, e, _passes(2 * cell, res), 1e-4 * res, radius=radius, tri=tri)


def _relax(q, rest, nrm, pin, e, passes, eps, radius=None, tri=None):
    """Umbrella passes over positions `q`, each followed by the obstacle: a
    vertex less than `eps` over its `rest` along its normal is set back on it,
    as is every `pin`ned one.

    With `radius` the sheet is pressed onto the rock: along the normal of the
    sheet as it stands (from `tri`; the rest normal where it has none or it has
    turned over) a vertex goes where its edges' curvatures - each edge's rise
    off the vertex's tangent plane over half its length squared - average 1 /
    (2 `radius`), the mean curvature of a cylinder of that radius; along the
    sheet it moves to the average of its neighbours. The passes stop once no
    vertex moves DRAPE_TOL. (A pressure from the umbrella step alone, a quarter
    of the mean squared edge length over the radius, holds only on an evenly
    spaced mesh: the sheet bunches its vertices up across a corner, and the
    curve came out a third as wide as asked; on a strip free at its sides,
    twice.)"""
    n = len(q)
    deg = np.maximum(np.bincount(e.ravel(), minlength=n), 1).astype(np.float64)[:, None]
    a, b = e[:, 0], e[:, 1]
    press = radius is not None
    for _ in range(passes):
        acc = np.stack([np.bincount(a, q[b, j], n) + np.bincount(b, q[a, j], n) for j in range(3)], 1)
        new = acc / deg
        if press:
            fn = np.cross(q[tri[:, 1]] - q[tri[:, 0]], q[tri[:, 2]] - q[tri[:, 0]])
            sn = np.stack([sum(np.bincount(tri[:, c], fn[:, j], n) for c in range(3)) for j in range(3)], 1)
            ln = np.linalg.norm(sn, axis=1)
            sn = np.where(((sn * nrm).sum(1) > 0.1 * ln)[:, None], sn / np.maximum(ln, 1e-12)[:, None], nrm)
            d = q[b] - q[a]
            w = 1.0 / np.maximum(np.sum(d * d, axis=1), 1e-12)
            rise = np.bincount(a, w * (d * sn[a]).sum(1), n) - np.bincount(b, w * (d * sn[b]).sum(1), n)
            sw = np.bincount(a, w, n) + np.bincount(b, w, n)
            step = new - q
            along = step - sn * (step * sn).sum(1)[:, None]
            new = q + along + sn * ((rise - deg[:, 0] / (4.0 * radius)) / np.maximum(sw, 1e-12))[:, None]
        new = 0.5 * q + 0.5 * new
        held = (((new - rest) * nrm).sum(1) < eps) | pin
        new[held] = rest[held]
        q = new
        # Settled: measured over a window of passes, and on all but a few: a
        # cluster where the sheet meets the rock at the mound's rim can flick
        # on and off it for good (the step: 9 of 2339, a few mm each, which
        # the vertices' own relaxing smooths away).
        if press and _ % DRAPE_WINDOW == 0:
            if _ and (np.abs(q - last).max(1) > DRAPE_TOL).sum() <= 0.01 * n:
                break
            last = q.copy()
    if DEBUG and press:
        print("[moss.debug] drape: %d clusters settled in %d passes" % (n, _ + 1))
    return q


def _drop_small(v, t, min_area):
    """Triangles of the mesh islands (connected by shared vertices) of at least `min_area`."""
    parent = np.arange(len(v))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b, c in t.tolist():
        ra = find(a)
        parent[find(b)] = ra
        parent[find(c)] = ra
    roots = np.array([find(a) for a in t[:, 0].tolist()])
    area = 0.5 * np.linalg.norm(np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]]), axis=1)
    _u, inv = np.unique(roots, return_inverse=True)
    total = np.bincount(inv.reshape(-1), weights=area)
    return t[total[inv.reshape(-1)] >= min_area]


def _boundary(t, n):
    """Vertices on an open edge of the mesh."""
    e = np.sort(np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]]), axis=1)
    uk, cnt = np.unique(e, axis=0, return_counts=True)
    out = np.zeros(n, bool)
    out[uk[cnt == 1].ravel()] = True
    return out


# --------------------------------------------------------------------------
# Growth: layer 0, the erosion field, the lighter layers


def _grow(p, rng, g, P, N, kd, painted, off, res):
    n = g.n
    painted_idx = np.nonzero(painted)[0]

    # ---- layer 0: fill the painted area, packed tight (no pinholes)
    layer0 = []
    grid = _Grid(0.6 * p.dab_max)  # the packing test's reach
    # A vertex closer to a placed dab than 0.3 (dab_min + its r) fails the
    # packing test whatever r is drawn, so it is marked and later tries there
    # skip the scan (still drawing r, so the random stream is unchanged). The
    # mark keeps a margin far over float32 rounding, so it only ever claims
    # what the exact test (Vector lengths, float32) rejects. It was most of
    # layer 0's time: a try per painted vertex, nearly all of them rejected.
    blocked = np.zeros(n, bool)
    v32 = np.array([x[:] for x in P])
    for _ in range(len(painted_idx)):
        i = int(painted_idx[rng.randrange(len(painted_idx))])
        c, nr = P[i], N[i]
        r = rng.uniform(p.dab_min, p.dab_max)
        if blocked[i]:
            continue
        if any((c - d.c).length < 0.3 * (r + d.r) for d in grid.near(c, 0.3 * (r + p.dab_max))):
            continue
        d = Dab(c, nr, r, 0, rng)
        layer0.append(d)
        grid.add(d)
        sure = 0.3 * (p.dab_min + r) - 1e-6
        near = np.array([j for (_co, j, _dd) in kd.find_range(c, sure + 1e-5)], dtype=np.int64)
        if len(near):
            blocked[near[np.linalg.norm(v32[near] - v32[i], axis=1) < sure]] = True
    layers = [layer0]

    # ---- the erosion field: how many passes of uneven erosion each vertex survives
    off3 = off + Vector((4.4, 9.2, 1.7))
    hfield = np.zeros(n)
    alive = painted.copy()
    base0 = max(p.buffer, p.ref_depth / p.steps_deep)
    # The noise lookups' pass-independent part, once per painted vertex: the
    # same Vector arithmetic in the same order, so the same float32 values.
    at_slow = {i: P[i] * (p.erode_scale * 0.35) + off3 for i in painted_idx.tolist()}
    at_fast = {i: P[i] * p.erode_scale + off3 for i in painted_idx.tolist()}
    for kk in range(1, 40):
        dep = g.depth_inside(painted, alive)
        scale = rng.uniform(0.45, 1.7)
        idx = np.nonzero(alive)[0]
        if len(idx) == 0:
            break
        st = np.empty(len(idx))
        shift_slow = Vector((0, 0, 2.7 * kk))
        shift_fast = Vector((1.3, 0, 4.1 * kk))
        for j, i in enumerate(idx.tolist()):
            n_slow = min(1.0, max(0.0, 0.5 + 1.3 * noise.noise(at_slow[i] + shift_slow)))
            n_fast = min(1.0, max(0.0, 0.5 + 1.3 * noise.noise(at_fast[i] + shift_fast)))
            n01 = 0.6 * n_slow + 0.4 * n_fast
            st[j] = base0 * scale * (0.15 + 2.6 * n01 * n01)
        kept = dep[idx] >= st
        gone = idx[~kept]
        hfield[gone] = (kk - 1) + dep[gone] / np.maximum(st[~kept], 1e-6)
        if not kept.any():
            break
        alive = np.zeros(n, bool)
        alive[idx[kept]] = True
    hfield = smooth_field(hfield, g.edges, n, _passes(0.010, res))
    g.hfield = hfield

    # ---- the lighter layers, seeded at the field's summits
    for k in range(1, p.layers + 1):
        parent = layers[-1]
        inside = np.zeros(n, bool)
        for d in parent:
            idx = np.array([i for (_c, i, _d) in kd.find_range(d.c, d.rmax)], dtype=np.int64)
            if len(idx):
                inside[idx[d.u(np.array([P[i][:] for i in idx]))[0] <= 1.0]] = True
        pdepth = g.depth_inside(painted, inside)
        sh = max(p.shrink ** k, 0.65)
        r_k = (p.dab_min * sh, p.dab_max * sh)
        b_k = p.first_buffer if k == 1 else p.buffer
        frac_k = FRACS[min(k - 1, len(FRACS) - 1)]
        fill = frac_k >= 1.0
        elig = painted & (pdepth >= b_k + 1.5 * r_k[1])
        if g.area[elig].sum() < 0.0007:
            break
        seeds_at = []
        for members in g.components(elig):
            if g.area[members].sum() < 0.00036:
                continue
            level = k + 1
            mset = np.zeros(n, bool)
            mset[members] = True
            high = mset & (hfield >= level)
            if not high.any():
                high = np.zeros(n, bool)
                high[max(members, key=lambda m: hfield[m])] = True
            n_high = int(high.sum())
            for isl in g.components(high):
                if g.area[isl].sum() < 0.0002 and len(isl) < n_high:
                    continue
                seeds_at.append(max(sorted(isl), key=lambda m: (hfield[m], rng.random())))
            if fill:
                # a fill layer also seeds the component's far ends, or growth
                # from one summit takes many stalls to reach them
                ms = sorted(members)
                for _ in range(max(1, int(g.area[members].sum() / FILL_SEED_AREA))):
                    seeds_at.append(ms[rng.randrange(len(ms))])
        if not seeds_at:
            break
        if DEBUG:
            print("[moss.debug] layer %d: eligible %.3f m2 of %.3f painted, %d seeds, parent %d dabs, pdepth max %.3f" % (
                k, g.area[elig].sum(), g.area[painted].sum(), len(seeds_at), len(parent), pdepth[painted].max()))
        target = int(len(parent) * (1.3 if fill else frac_k))
        layer, queues, caps = [], [], []
        lgrid = _Grid(0.8 * r_k[1])  # the spacing test's reach
        for i in seeds_at:
            d = Dab(P[i], N[i], rng.uniform(*r_k), k, rng)
            layer.append(d)
            lgrid.add(d)
            queues.append([d])
            caps.append(10**9 if fill else int(target / len(seeds_at) * rng.uniform(0.5, 1.5)) + 1)
        stalls = 0
        spacing = 0.4
        # As in layer 0: a vertex closer to a dab of this layer than spacing
        # (r_k min + its r) fails the spacing test whatever r is drawn, so it is
        # marked and skipped (the draws before the test still happen). Most of
        # the build's time went to this test.
        lblocked = np.zeros(n, bool)

        def block(d):
            sure = spacing * (r_k[0] + d.r) - 1e-6
            near = np.array([j for (_co, j, _dd) in kd.find_range(d.c, sure + 1e-5)], dtype=np.int64)
            if len(near):
                lblocked[near[np.linalg.norm(v32[near] - np.array(d.c[:]), axis=1) < sure]] = True

        for d in layer:
            block(d)
        while len(layer) < target and stalls < (80 if fill else 400):
            grew = False
            for qi, q in enumerate(queues):
                if len(q) >= caps[qi]:
                    continue
                src = q[rng.randrange(len(q))]
                tx = src.n.cross(Vector((0.3, 0.7, 0.2))).normalized()
                ty = src.n.cross(tx)
                for _ in range(6):
                    a = rng.uniform(0, 2 * math.pi)
                    r = rng.uniform(*r_k)
                    c = src.c + (tx * math.cos(a) + ty * math.sin(a)) * (src.r + r) * spacing
                    _co, i, _dd = kd.find(c)  # snap to the rock
                    if not elig[i] or lblocked[i]:
                        continue
                    c = P[i]
                    if any((c - o.c).length < spacing * (r + o.r) for o in lgrid.near(c, spacing * (r + r_k[1]))):
                        continue
                    d = Dab(c, N[i], r, k, rng)
                    layer.append(d)
                    lgrid.add(d)
                    q.append(d)
                    block(d)
                    grew = True
                    break
            stalls = 0 if grew else stalls + 1
        if DEBUG:
            print("[moss.debug]   grew %d (target %d, stalls %d), clumps %s" % (len(layer), target, stalls, sorted((len(q) for q in queues), reverse=True)[:12]))
        layer = [d for q in queues if len(q) >= p.min_clump for d in q]
        if not layer:
            break
        layers.append(layer)
    return layers


def _tone(p, layers, P, kd, g, painted, off, res):
    """Each dab's tone step: the erosion field at the dab and its layer, a slow
    mottle, quantised. Scaled against the fixed reference, never the patch."""
    dark_s = [_srgb(c) for c in p.dark]
    light_s = [_srgb(c) for c in p.light]
    tstep = 1.0 / max(p.layers, 1)
    off2 = off + Vector((13.1, 7.7, 3.9))
    for k, layer in enumerate(layers):
        for d in layer:
            mot = p.mottle * tstep * noise.noise(d.c * p.mottle_scale + off2)
            t_layer = min(1.0, k / max(p.layers, 1))
            hf = min(1.0, g.hfield[kd.find(d.c)[1]] / p.steps_deep)
            tq = (p.field_mix * hf + (1 - p.field_mix) * t_layer) ** p.curve + mot
            tq = round(min(1.0, max(0.0, tq)) * (p.levels - 1)) / max(p.levels - 1, 1)
            d.t = tq
            d.tone = tuple(_lin(dark_s[i] + (light_s[i] - dark_s[i]) * tq) for i in range(3))


def _heights(mv, bvh, kd, tval, levels):
    """Mean height (mm) of the mound over the rock per tone step: the check that
    the light stands tallest."""
    by = {}
    for x in mv:
        on, nr, _i, _d = bvh.find_nearest(Vector(x))
        if on is None:
            continue
        tv = tval[kd.find(Vector(x))[1]]
        if np.isnan(tv):
            continue
        by.setdefault(int(round(tv * (levels - 1))), []).append((Vector(x) - on).dot(nr) * 1000.0)
    return {s: round(sum(h) / len(h), 1) for s, h in sorted(by.items())}


# --------------------------------------------------------------------------
# The print


CHART_ANGLE = 40.0  # degrees: a chart takes neighbours whose normal is within this of its first face's
CHART_PAD = 2  # texels of gutter around every chart, filled from the chart's edge
PRINT_CHUNK = 256  # dabs whose texels are found at once on the pool (bounds the memory held)
MAP_DILATE = 0.75  # texels: how far outside a triangle a rock map's texel still counts as on it


def _charts(mv, mt):
    """Group the triangles into charts of neighbours that face within CHART_ANGLE of
    the chart's first face, and project each chart flat onto that face's plane:
    per-corner 2D coordinates in metres, and each triangle's chart."""
    fn = normalize(np.cross(mv[mt[:, 1]] - mv[mt[:, 0]], mv[mt[:, 2]] - mv[mt[:, 0]]))
    e = np.concatenate([mt[:, [0, 1]], mt[:, [1, 2]], mt[:, [2, 0]]])
    e.sort(axis=1)
    owner = np.tile(np.arange(len(mt)), 3)
    order = np.lexsort((e[:, 1], e[:, 0]))
    es, os_ = e[order], owner[order]
    same = (es[1:] == es[:-1]).all(1)
    nbr = [[] for _ in range(len(mt))]
    for a, b in zip(os_[:-1][same].tolist(), os_[1:][same].tolist()):
        nbr[a].append(b)
        nbr[b].append(a)
    chart = np.full(len(mt), -1)
    cos_lim = math.cos(math.radians(CHART_ANGLE))
    seeds = []
    for f0 in range(len(mt)):
        if chart[f0] >= 0:
            continue
        c = len(seeds)
        seeds.append(f0)
        chart[f0] = c
        stack = [f0]
        while stack:
            f = stack.pop()
            for g in nbr[f]:
                if chart[g] < 0 and fn[g] @ fn[f0] >= cos_lim:
                    chart[g] = c
                    stack.append(g)
    uv = np.zeros((len(mt), 3, 2))
    for c, f0 in enumerate(seeds):
        n = fn[f0]
        a = np.array((1.0, 0.0, 0.0)) if abs(n[0]) < 0.9 else np.array((0.0, 1.0, 0.0))
        e1 = normalize(np.cross(n, a))
        e2 = np.cross(n, e1)
        fs = np.nonzero(chart == c)[0]
        pts = mv[mt[fs]]
        flat = np.stack([pts @ e1, pts @ e2], -1)
        # turned to its principal axes, so its bounding box (what is packed) is tight
        xy = flat.reshape(-1, 2)
        xy = xy - xy.mean(0)
        _w, vecs = np.linalg.eigh(xy.T @ xy)
        uv[fs] = flat @ vecs
    return uv, chart, len(seeds)


def _print(mv, mt, layers, p):
    """UVs and the texture: the mound in flat charts packed into one square, every
    dab evaluated per texel."""
    q, chart, n_charts = _charts(mv, mt)
    lo_c = np.full((n_charts, 2), np.inf)
    hi_c = np.full((n_charts, 2), -np.inf)
    np.minimum.at(lo_c, chart, q.min(1))
    np.maximum.at(hi_c, chart, q.max(1))
    pad = CHART_PAD
    texel = p.texel
    while True:
        wh = np.ceil((hi_c - lo_c) / texel).astype(np.int64) + 2 * pad
        size, place = _shelf_pack(wh, p.max_texture)
        if place is not None:
            break
        texel *= 1.2  # does not fit: coarser texels
    if DEBUG:
        print("[moss.debug] charts %d, box area %d texels (%.0f%% of %d^2), largest box %s" % (
            n_charts, int((wh[:, 0] * wh[:, 1]).sum()), 100 * (wh[:, 0] * wh[:, 1]).sum() / size ** 2, size, wh.max(0).tolist()))
    # every corner in texels of the square
    px_uv = (q - lo_c[chart][:, None, :]) / texel + (place[chart] + pad)[:, None, :]
    uvs = px_uv / size
    # vertex normals of the mound (area weighted) for the texel normal
    vn = vertex_normals(mv, mt)
    img = np.zeros((size, size, 4))
    pos = np.zeros((size, size, 3))
    nrm = np.zeros((size, size, 3))
    valid = np.zeros((size, size), bool)
    for f in range(len(mt)):
        (ax_, ay_), (bx, by_), (cx, cy) = px_uv[f]
        den = (by_ - cy) * (ax_ - cx) + (cx - bx) * (ay_ - cy)
        if abs(den) < 1e-12:
            continue
        x0 = int(math.floor(min(ax_, bx, cx)))
        y0 = int(math.floor(min(ay_, by_, cy)))
        x1 = int(math.ceil(max(ax_, bx, cx)))
        y1 = int(math.ceil(max(ay_, by_, cy)))
        ys, xs = np.mgrid[y0:y1, x0:x1]
        tx, ty = xs + 0.5, ys + 0.5
        l1 = ((by_ - cy) * (tx - cx) + (cx - bx) * (ty - cy)) / den
        l2 = ((cy - ay_) * (tx - cx) + (ax_ - cx) * (ty - cy)) / den
        lam = np.stack([l1, l2, 1 - l1 - l2], -1)
        inside = (lam >= -1e-6).all(-1)
        if not inside.any():
            continue
        lam = lam[inside]
        yy_, xx_ = ys[inside], xs[inside]
        pos[yy_, xx_] = lam @ mv[mt[f]]
        nrm[yy_, xx_] = lam @ vn[mt[f]]
        valid[yy_, xx_] = True
    # the gutter: every chart grown by `pad` texels from its own edge, so filtering
    # and the first mips at a chart's border read the chart's colour
    # (Each new texel copies its neighbour's texel directly: rolling the whole
    # position and normal images per direction was a second of a build.)
    for _ in range(pad):
        grow = np.zeros_like(valid)
        ty, tx, sy, sx = [], [], [], []
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            sh_valid = np.roll(valid, (dy, dx), axis=(0, 1))
            yy_, xx_ = np.nonzero(sh_valid & ~valid & ~grow)
            ty.append(yy_)
            tx.append(xx_)
            sy.append((yy_ - dy) % size)
            sx.append((xx_ - dx) % size)
            grow[yy_, xx_] = True
        ty, tx, sy, sx = (np.concatenate(a) for a in (ty, tx, sy, sx))
        pos[ty, tx] = pos[sy, sx]
        nrm[ty, tx] = nrm[sy, sx]
        valid |= grow
    yy, xx = np.nonzero(valid)
    col, cov = paint_texels(layers, p, pos[yy, xx], normalize(nrm[yy, xx]))
    img[yy, xx, :3] = col
    # A mound's print is opaque; a texture-only moss's decal shows the rock
    # wherever no dab reaches.
    img[yy, xx, 3] = cov if p.kind == "TEXTURE" else 1.0
    return uvs, img, texel


def paint_map(px, uv_px, tri_pos, layers, p):
    """Paint a texture-only moss into a rock's colour map, in place. `px` is
    the map (H, W, 4; sRGB-encoded colour, as a byte image's pixels read,
    row 0 at the bottom), its alpha over 0.5 where a texel was baked; `uv_px`
    (T, 3, 2) the rock's triangles in texels of the map and `tri_pos` (T, 3, 3)
    the same triangles in the world. Every baked texel of a triangle the dabs
    can reach takes the dabs' colour by their coverage. A texel counts for a
    triangle within MAP_DILATE texels of it, positions extrapolated, so the
    texels the bake rasterised on a triangle's edge are painted too; the map's
    background fill then carries the moss into the seams. Returns how many
    texels the moss covers."""
    dabs = [d for layer in layers for d in layer]
    if not dabs or len(tri_pos) == 0:
        return 0
    h, w = px.shape[:2]
    reach = max(d.rmax for d in dabs) + p.print_edge + MOUND_LIFT_ROOM
    kd = kdtree(np.array([d.c[:] for d in dabs]))
    centre = tri_pos.mean(1)
    radius = np.linalg.norm(tri_pos - centre[:, None, :], axis=2).max(1)
    fn = normalize(np.cross(tri_pos[:, 1] - tri_pos[:, 0], tri_pos[:, 2] - tri_pos[:, 0]))
    ys, xs, ps, ns = [], [], [], []
    for f in range(len(tri_pos)):
        if not kd.find_range(Vector(centre[f]), radius[f] + reach):
            continue
        (ax_, ay_), (bx, by_), (cx, cy) = uv_px[f]
        den = (by_ - cy) * (ax_ - cx) + (cx - bx) * (ay_ - cy)
        if abs(den) < 1e-12:
            continue
        x0 = max(0, int(math.floor(min(ax_, bx, cx) - MAP_DILATE)))
        y0 = max(0, int(math.floor(min(ay_, by_, cy) - MAP_DILATE)))
        x1 = min(w, int(math.ceil(max(ax_, bx, cx) + MAP_DILATE)))
        y1 = min(h, int(math.ceil(max(ay_, by_, cy) + MAP_DILATE)))
        if x1 <= x0 or y1 <= y0:
            continue
        yy, xx = np.mgrid[y0:y1, x0:x1]
        tx, ty = xx + 0.5, yy + 0.5
        l1 = ((by_ - cy) * (tx - cx) + (cx - bx) * (ty - cy)) / den
        l2 = ((cy - ay_) * (tx - cx) + (ax_ - cx) * (ty - cy)) / den
        lam = np.stack([l1, l2, 1 - l1 - l2], -1)
        # each barycentric over its height is the distance (texels) from that edge
        corners = uv_px[f]
        edge = np.array([np.linalg.norm(corners[(i + 2) % 3] - corners[(i + 1) % 3]) for i in range(3)])
        dist = lam * (abs(den) / np.maximum(edge, 1e-12))
        inside = (dist >= -MAP_DILATE).all(-1) & (px[yy, xx, 3] > 0.5)
        if not inside.any():
            continue
        ys.append(yy[inside])
        xs.append(xx[inside])
        ps.append(lam[inside] @ tri_pos[f])
        ns.append(np.broadcast_to(fn[f], (int(inside.sum()), 3)))
    if not ys:
        return 0
    ys, xs, ps, ns = (np.concatenate(a) for a in (ys, xs, ps, ns))
    # a texel two triangles claim is painted once, from the first
    _u, first = np.unique(ys * w + xs, return_index=True)
    ys, xs, ps, ns = ys[first], xs[first], ps[first], ns[first]
    col, cov = paint_texels(layers, p, ps, ns)
    hit = cov > 0
    if not hit.any():
        return 0
    ys, xs, col, cov = ys[hit], xs[hit], col[hit], cov[hit]
    s = np.clip(px[ys, xs, :3].astype(np.float64), 0.0, 1.0)
    base = np.where(s <= 0.04045, s / 12.92, ((s + 0.055) / 1.055) ** 2.4)
    out = np.clip(base + (col - base) * cov[:, None], 0.0, 1.0)
    px[ys, xs, :3] = np.where(out <= 0.0031308, out * 12.92, 1.055 * np.power(out, 1 / 2.4) - 0.055)
    return int(len(ys))


def paint_texels(layers, p, tp, tn):
    """Every dab evaluated at texels at world points `tp` facing `tn` (unit),
    lower layers first: (linear colour, coverage) per texel, the colour `dark`
    where no dab reaches. The mound's print and, on export, a texture-only
    moss's rock colour map (scene_export.py) both paint through this."""
    col = np.tile(np.array(p.dark, dtype=np.float64), (len(tp), 1))
    cov = np.zeros(len(tp))
    if len(tp) == 0:
        return col, cov
    # a spatial hash of the texels: sorted by bucket, so a dab gathers the texels
    # of every bucket its sphere touches in one numpy step
    # A bucket of one dab_max: a dab looks up ~30 of them, not ~1300 at 0.3
    # (which bucket a texel is in decides nothing: every test after is per
    # texel). Measured on mid-ledge: 0.3 x 2.35 s, 0.6 x 1.91, 1.0 x 1.71, 1.6 x 2.03.
    cell = max(0.01, p.dab_max)
    lo = tp.min(0)
    gk = np.floor((tp - lo) / cell).astype(np.int64)
    dims = gk.max(0) + 1
    key = (gk[:, 0] * dims[1] + gk[:, 1]) * dims[2] + gk[:, 2]
    order = np.argsort(key, kind="stable")
    uk, start, count = np.unique(key[order], return_index=True, return_counts=True)
    room = MOUND_LIFT_ROOM
    tp_sq = np.einsum("ij,ij->i", tp, tp)

    def texels(d, open_, open_buckets):
        """The texels a dab paints and its weight at each, or None, among the
        texels still `open_` (not yet hidden under a dab above), in the
        buckets that still hold one (`open_buckets`, per entry of `uk`). Reads only
        what is fixed while its chunk runs, so dabs run on a thread pool; their
        painting (below) stays in order, so the print does not depend on it."""
        cc = np.asarray(d.c)
        dn = np.asarray(d.n)
        # The mound stands up to `d.h` over the dab's plane here: fetch the
        # texels in a sphere about the middle of that slab, not a box as
        # tall as the tallest moss anywhere (that fetched 3x the texels).
        mid = cc + dn * (0.5 * d.h)
        half = 0.5 * d.h + room
        reach = math.sqrt((d.rmax + p.print_edge) ** 2 + half * half)
        g0 = np.maximum(np.floor((mid - reach - lo) / cell).astype(np.int64), 0)
        g1 = np.minimum(np.floor((mid + reach - lo) / cell).astype(np.int64), dims - 1)
        if (g1 < g0).any():
            return None
        gx, gy, gz = np.meshgrid(np.arange(g0[0], g1[0] + 1), np.arange(g0[1], g1[1] + 1), np.arange(g0[2], g1[2] + 1), indexing="ij")
        # buckets whose centre is within the sphere (plus a bucket's half-diagonal)
        centre = (np.stack([gx, gy, gz], -1).reshape(-1, 3) + 0.5) * cell + lo
        near = np.linalg.norm(centre - mid, axis=1) < reach + 0.87 * cell
        want = ((gx * dims[1] + gy) * dims[2] + gz).ravel()[near]
        pos = np.searchsorted(uk, want)
        ok = pos < len(uk)
        ok[ok] = uk[pos[ok]] == want[ok]  # only buckets that hold texels
        pos = pos[ok]
        pos = pos[open_buckets[pos]]  # ... and still hold an open one
        if len(pos) == 0:
            return None
        st, cn = start[pos], count[pos]
        total = int(cn.sum())
        sel = order[np.repeat(st - np.concatenate([[0], np.cumsum(cn)[:-1]]), cn) + np.arange(total)]
        sel = sel[open_[sel]]
        # cheap culls first, each on what the last left: within the slab,
        # inside the dab's outer radius, facing the dab's way (the dab's own
        # side of the rock); every test is per texel, so culling in stages
        # keeps the same texels
        pts = tp[sel]
        rel = pts @ dn - cc @ dn
        ok = (rel > -room) & (rel < d.h + room)
        sel, pts, rel = sel[ok], pts[ok], rel[ok]
        sq = tp_sq[sel] - 2.0 * (pts @ cc) + cc @ cc - rel * rel
        ok = (sq < (d.rmax + p.print_edge) ** 2) & ((tn[sel] @ dn) > 0.2)
        sel, pts = sel[ok], pts[ok]
        if len(sel) == 0:
            return None
        u, rr = d.u(pts)
        w = np.clip((rr - u * rr) / p.print_edge + 0.5, 0.0, 1.0)
        hit = w > 0
        if not hit.any():
            return None
        return sel[hit], w[hit]

    # Painted front to back. Bottom to top, each dab mixes its tone over what
    # is below by its weight w, and the first dab a texel meets lays its tone
    # whole; so a texel's colour is the sum of each dab's tone times w times
    # the (1 - w) of every dab above it, the lowest dab's taking 1 for its w.
    # Top down that is: `acc` += `see` * w * tone, `see` *= 1 - w, and at the
    # end `acc` += `see` * the lowest tone. A texel a dab covers whole (w = 1)
    # is then final: the dabs below add `see` = 0 times their tone, and their
    # coverage cannot raise `cov` past the 1 it holds. Nine in ten dab-texel
    # pairs were under such a dab (river's mid-ledge, 2026-10-05: 13.3M pairs
    # over 1.09M texels), so they are skipped before their culls and outline.
    acc = np.zeros((len(tp), 3))
    see = np.ones(len(tp))
    low = np.zeros((len(tp), 3))  # the tone of the lowest dab met so far
    dabs = [d for layer in layers for d in layer][::-1]
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        for at in range(0, len(dabs), PRINT_CHUNK):
            chunk = dabs[at : at + PRINT_CHUNK]
            open_ = see > 0.0
            open_buckets = np.add.reduceat(open_[order], start) > 0
            for d, got in zip(chunk, pool.map(lambda d: texels(d, open_, open_buckets), chunk)):
                if got is None:
                    continue
                sel, w = got
                tone = np.array(d.tone)
                acc[sel] += (see[sel] * w)[:, None] * tone
                see[sel] *= 1.0 - w
                low[sel] = tone
                cov[sel] = np.maximum(cov[sel], w)
    met = cov > 0
    col[met] = acc[met] + see[met][:, None] * low[met]
    return col, cov


def _shelf_pack(wh, max_size):
    """Place rectangles (w, h texels) on shelves in the smallest power-of-two
    square that holds them; (size, positions) or (max_size, None)."""
    order = np.lexsort((-wh[:, 0], -wh[:, 1]))  # tallest first
    total = int((wh[:, 0] * wh[:, 1]).sum())
    size = 64
    while size * size < total and size < max_size:
        size *= 2
    while size <= max_size:
        place = np.zeros((len(wh), 2), np.int64)
        x = y = shelf = 0
        ok = True
        for i in order.tolist():
            w, h = int(wh[i, 0]), int(wh[i, 1])
            if w > size:
                ok = False
                break
            if x + w > size:
                y += shelf
                x = shelf = 0
            if y + h > size:
                ok = False
                break
            place[i] = (x, y)
            x += w
            shelf = max(shelf, h)
        if ok:
            return size, place
        size *= 2
    return max_size, None
