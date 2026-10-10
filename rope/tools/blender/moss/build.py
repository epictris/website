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
   Before it, `strays` detached clumps of one to three small dark dabs join the
   dark base on the rock outside it, within `stray_reach` (their own random
   stream: the growth inside is the same without them).
7. Height: a sheet `floor` thick, and on it the pile: the tone painted onto the
   vertices times `lift` (the lightest moss stands `floor + lift` proud) times
   how much the surface faces up (`up_floor` of it on a wall: a full pile on a
   wall faces the ground on its way down), blurred over `height_blur` and faded
   in from the edge over `rim`.
8. The mound: the refined rock cut along the outline of the dark base (the
   union of its dabs' outlines, the strays' too), offset along the smoothed
   normal by the sheet and the pile, and decimated to `mound_density`
   triangles a square metre. The sheet is `floor` thick right to the outline.
   The sheet stands off the rock, the pile off the sheet, along normals
   smoothed in space (`_spatial_normals`), not over the mesh's edges, which on
   a coarse `resolution` was the raw normal and turned the thin triangles
   over. Grass sprigs (`grass`) stand in tufts on the up-facing top.
   The edge is drawn one of two ways (`edge_kind`):
   - "PRINT" (since 2026-10-10, the default): the mesh is cut `edge_apron`
     OUTSIDE the outline, at the rock's own resolution, and the outline is
     printed: the texture's alpha is a signed distance to the dabs' outline
     (SDF_RANGE each side; 0.5 on it), and the material cuts the moss at 0.5.
     The lobes are then as fine as the texels, the cut is anti-aliased by the
     distance's slope, and the rounded lip is shading: the alpha is a height
     map of a quarter-round roll LIP_ROUND wide, in Blender a Bump node and in
     the game the same in its shader (src/render3d/mossMound.ts, which holds
     the same two constants). The mesh costs what the mound's area costs.
   - "MESH": the rock is refined to `edge_detail` along the outline and cut
     along it exactly; its top rounds over `edge_round` down to a lip
     `overhang` over the rock, and from the lip a skirt rolls back under it in
     a quarter circle to the rock (`_bead`, `_skirt`). The edge is a cushion
     whose foot is hidden under its own lip and stands on the rock, never in
     it (until 2026-10-09 the mound rose out of the rock `sink` under it, and
     its outline was wherever the low-poly mesh met the faceted rock: long
     straight runs and facets poking through). The decimate gives it a budget
     of its own (`_edge_budget`: its rings in segments of two `edge_detail`
     along the outline), which is what it costs: hundreds of triangles a
     metre of outline, and a dab outline is long.
9. The print: the mound's own texture. Every mound triangle gets its own chart in
   a shelf-packed atlas at `texel` metres a texel; each texel's world position and
   normal are interpolated, and every dab is evaluated per texel - its outline in
   its tangent plane, a `print_edge` anti-aliased edge, its flat tone over what is
   below. With a printed edge, the dark base's dabs are evaluated once more for
   the distance to their union's outline, into the alpha.

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
from .stampbrush.geometry import clip, compact, kdtree, mask, normalize, refine, smooth_field, smoothstep, stamps_world, vertex_normals

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
# A printed edge (`edge_kind` "PRINT"). The print's alpha is the signed distance
# to the dark base's outline, positive inside, over SDF_RANGE each side:
# alpha = 0.5 + d / (2 SDF_RANGE), so 0.5 is the outline, 1 is SDF_RANGE or
# further in, 0 that far or further out. The material cuts at 0.5 and shades the
# lip as a quarter-round roll LIP_ROUND wide inside the outline: its height
# h(d) = LIP_ROUND sqrt(1 - (1 - d / LIP_ROUND)^2) for d < LIP_ROUND, as the
# "MESH" edge's `_bead` rounds its top, read as a bump. The game's shader
# (src/render3d/mossMound.ts) holds the same two numbers: change both.
SDF_RANGE = 0.02
LIP_ROUND = 0.012


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
    rim: float = 0.10
    drape: float = 1.0  # the tightest the moss's sheet bends: steps and hollows tighter are bridged (0: it follows the rock)
    # The edge: the mound ends at the dark base's outline, `floor` thick.
    # "PRINT": the outline is in the print's alpha (SDF_RANGE, LIP_ROUND) and
    # the mesh runs `edge_apron` past it; "MESH": the mesh is cut along it,
    # rounded and skirted (edge_round, overhang, edge_detail).
    edge_kind: str = "PRINT"
    edge_apron: float = 0.03  # the mesh runs this far past the outline (at least twice `resolution`), cut away by the print
    edge_round: float = 0.012  # its top rounds down to the lip over this
    overhang: float = 0.004  # the lip stands this high and its foot this far in, under it
    edge_detail: float = 0.006  # edge length of the mesh along the outline
    strays: float = 4.0  # detached clumps per metre of outline
    stray_reach: float = 0.08  # ... at most this far out
    min_patch: float = 0.002  # m^2: mound islands smaller than this go (strays stay)
    # Grass: sprigs of thin blades standing out of the moss's top
    grass: float = 6.0  # tufts per m^2 of up-facing moss
    grass_height: float = 0.045
    grass_blades: int = 10  # in a tuft, about
    grass_tip: tuple = (0.3185, 0.4179, 0.0467)  # linear (sRGB 0.6, 0.68, 0.24): the lightest tip
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
    image: np.ndarray  # (S, S, 4) linear RGB + alpha (1, a decal's coverage, or a printed edge's distance), row 0 at the bottom (Blender's order)
    dabs: int = 0
    layers: list = field(default_factory=list)  # dabs per layer
    heights: dict = field(default_factory=dict)  # tone step -> mean mm over the rock (the check: rising)
    texel: float = 0.0  # the print's texel: `texel`, or coarser where the mound did not fit `max_texture`
    area: float = 0.0  # m^2 of mound
    # A printed edge: how close to the outline the decimated mesh's open edge
    # comes (m, positive = outside it). Under SDF_RANGE, the print's cut can
    # run into the mesh's.
    apron: float = float("inf")
    # A printed edge: m2 of the mound still in the rock after
    # `_clear_of_rock` (0: none of it is).
    in_rock: float = 0.0


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
    lip: np.ndarray = None  # a mesh edge: the mound's vertices of its rounded edge and skirt, budgeted apart in the decimate
    pin: np.ndarray = None  # a printed edge: 1 at the vertices of a filled pinhole of the packing, for the print
    # a printed edge: the sheet's normal at each vertex, the one the dabs were
    # laid along, and the pile's height over the sheet there, for the print's
    # outline: a texel's foot on the sheet is its position less the pile along
    # the normal, and the dabs and their outlines are on the sheet (the
    # decimated mound's own normals swing away across a long triangle over a
    # crease, and the pile stands up to `lift` over the dabs' planes)
    sheet_n: np.ndarray = None
    pile: np.ndarray = None
    rock: tuple = None  # a printed edge: the host's (vertices, normals, triangles), for `_clear_of_rock`


# The parameters only `finish` reads: the mound's triangle budget and the print.
FINISH_PARAMS = ("mound_density", "texel", "max_texture", "print_edge", "grass", "grass_height", "grass_blades", "grass_tip")


def build(co, tri, host_matrix, stamps, p, decimate):
    """The moss for one host, from the host's welded world triangles (`co`, `tri`:
    stampbrush.geometry.host_world). `decimate(v, t, ratio, attrs, keep) -> (v, t,
    attrs)` reduces a mesh, carrying per-vertex floats and leaving `keep`
    vertices in place (the caller's Blender decimate; the build itself touches
    no bpy state)."""
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
    if p.edge_kind == "PRINT":
        # ... and a printed edge's mesh runs the apron past the outline, the
        # strays' too, which stand `stray_reach` beyond it: refined no further,
        # the mesh ended at the refined rock's edge, inside a stray's outline
        # (Terrace.003: 25 open-edge vertices up to 6 cm inside, 2026-10-10)
        reach += max(p.edge_apron, 2.0 * res + 0.01) + p.stray_reach
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
    strays = _strays(p, g, v, hull, kd, layers[0])
    _tone(p, layers, P, kd, g, painted, off, res)

    # ---- tone on the rock, and the mound
    tval = np.full(len(v), np.nan)
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
    if p.kind == "TEXTURE":
        return _grown_decal(co, tri, host_matrix, v, t, hull, g, kd, tval, layers)
    bvh = BVHTree.FromPolygons([tuple(x) for x in co], [tuple(x) for x in tri.tolist()])
    mound = _mound(p, v, t, hull, tval, layers, strays, res, g, painted, bvh)
    if mound is None:
        return None
    mv, mt, lip, pin, sheet_n, pile = mound
    rock = (co, vertex_normals(co, tri), tri) if p.edge_kind == "PRINT" else None
    return Grown(mv, mt, layers, bvh, kd, tval, np.array(host_matrix, dtype=np.float64), lip, pin, sheet_n, pile, rock)


def _mound(p, v, t, hull, tval, layers, strays, res, g, painted, bvh):
    """Step 8: the mound over the refined rock (`v`, `t`, its graph `g`,
    smoothed normals `hull`, tone `tval`, the paint `painted`), cut along the
    outline of the dark base, rounded over at its lip and tucked under it to
    the rock. Returns (vertices, triangles, lip) in the world, `lip` marking
    the vertices of the rounded edge (the rounding and the skirt), or None."""
    base = layers[0]
    printed = p.edge_kind == "PRINT"
    # A printed edge: the mesh runs `apron` past the outline, which the print
    # cuts: whole triangles with a vertex that near it. At least two refined
    # edges and a centimetre: the field is sampled at the vertices, so a
    # triangle whose vertices are all further out may still hold a lobe's tip
    # within an edge of one of them, and the decimate then pulls an open edge
    # in by up to an edge. (Cut along the interpolated field, as a mesh edge
    # is, the cut ran INSIDE the outline on Cube.004 at 5 cm: the field is
    # clamped a couple of edges out, so between a vertex just inside and one
    # clamped the interpolation crosses -apron a fraction of an edge in.)
    apron = max(p.edge_apron, 2.0 * res + 0.01) if printed else 0.0
    # The outline is the dabs' own. A mesh edge is refined to `edge_detail`
    # where it runs and across the rounding inside it, and cut along it
    # exactly, so its lobes are the dabs' curves and not the rock's triangles.
    reach = apron + 2.0 * res
    # The direction the mound stands off the rock (`lay`, below). A printed
    # edge's cut faces the dabs by it, as its print does (by `hull` the open
    # edge read 6 mm inside the outline at a crease of Terrace.003).
    lay = _spatial_normals(v, t, LAY_RADIUS)
    s = np.maximum(_union_field(base, v, lay if printed else hull, reach), -reach)
    # A gap between the dabs with no unpainted rock in it is a pinhole of the
    # packing, not a hole in the moss: filled. (Cut, Terrace.003's 23 m of
    # outline came with 150 m more round hundreds of pinholes, each with its
    # own lip and skirt folded into the moss around it.)
    pin = np.zeros(len(v))  # a printed edge carries the filled pinholes into its print
    for comp in g.components(s < 0.0):
        if painted[comp].all():
            s[comp] = 1e-4
            pin[comp] = 1.0
    # The tone's height is blurred here, over the rock refined evenly to
    # `resolution`, and carried onto the finer edge by interpolation: blurred
    # over the edge's own fine triangles, its tone steps stood as centimetre
    # cliffs a few millimetres wide, offset along normals that turn at the
    # rock's creases - folded sheets (Terrace.003: 11x the turned-over area).
    # The direction the mound stands off the rock: its faces' normals averaged
    # over LAY_RADIUS in space (`hull`, smoothed over the mesh's edges, is the
    # raw normal at a coarse `resolution`, and swung across the thin triangles
    # of a decimated rock: a flat 8 mm offset along it turned 806 cm2 of
    # Terrace.003's moss over). `hull` still orients the dabs.
    has = ~np.isnan(tval)
    passes = _passes(p.height_blur, res)
    tone = smooth_field(np.where(has, tval, 0.0), g.edges, len(v), passes)
    cover = smooth_field(has.astype(np.float64), g.edges, len(v), passes)
    # Graded: each pass halves the edges within a couple of them of the
    # outline (and of the rounding inside it), so only a thin band ends at
    # `edge_detail` (a 23 m outline refined to 6 mm across a resolution's width
    # was 330k triangles). A printed edge refines nothing: its outline is in
    # the texels.
    h, ed = res, min(p.edge_detail, res)
    while h > ed and not printed:
        h = max(0.5 * h, ed)
        # near the outline itself: inside the union, `s` dips low between
        # overlapping dabs far from any outline (refined there, the top was
        # 436k vertices, and the rounding pressed dimples all over it)
        x = _outline_distance(v, t, s)
        near = np.where(s >= 0.0, x < p.edge_round + 2.0 * h, x < 2.0 * h)
        if not near.any():
            break
        v, t, used, par = refine(v, t, v[near], np.full(int(near.sum()), 2.0 * h), h, keep_all=True, parents=True)
        hull = normalize(_carry(hull[used], par))
        lay = normalize(_carry(lay[used], par))
        tone, cover, pin = _carry(tone[used], par), _carry(cover[used], par), _carry(pin[used], par)
        # only the new vertices need the field: the others are where they were
        n0 = len(used)
        s = np.concatenate([s[used], np.maximum(_union_field(base, v[n0:], hull[n0:], 2.0 * res), -2.0 * res)])
    # No vertex within a quarter of its shortest edge of the outline, so the
    # cut crosses every edge at least that far from its ends: a crossing at a
    # vertex left slivers, a hundredth of a millimetre across, that the sheet's
    # offset turned over (Terrace.003: 16 % of the faces, 22k of them folded).
    e = np.unique(np.sort(np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]]), axis=1), axis=0)
    shortest = np.full(len(v), np.inf)
    ln = np.linalg.norm(v[e[:, 1]] - v[e[:, 0]], axis=1)
    np.minimum.at(shortest, e[:, 0], ln)
    np.minimum.at(shortest, e[:, 1], ln)
    keep_off = CUT_CLEARANCE * shortest
    if printed:
        cv, ct = v, t[(s[t] > -apron).any(1)]
        if DEBUG:
            ob_ = _boundary(ct, len(cv))
            print("[moss.debug] apron cut: %d open-edge vertices, %d of them nearer the outline than the apron (the refined rock's own edge)" % (
                int(ob_.sum()), int((ob_ & (s > -apron)).sum())))
    else:
        s = np.where(np.abs(s) < keep_off, np.where(s >= 0.0, keep_off, -keep_off), s)
        cv, ct, (lay, tone, cover, s, pin) = clip(v, t, s, [lay, tone, cover, s, pin])
        lay = normalize(lay)
    ct = _drop_small(cv, ct, p.min_patch, keep_at=strays)
    if len(ct) == 0:
        return None
    cv, ct, (lay, tone, cover, s, pin) = compact(cv, ct, [lay, tone, cover, s, pin])
    mg = _Graph(cv, ct)
    boundary = _boundary(ct, len(cv))
    # the pile fades in from the outline, which with a printed edge is
    # `apron` inside the mesh's open edge
    rimf = smoothstep(0.0, p.rim, np.maximum(mg.dijkstra(boundary) - apron, 0.0) * STUDY_METRIC)
    if printed:
        # The sheet is `floor` thick everywhere, the apron included: the cut
        # runs across it at full height, so the lip is a cliff of `floor`
        # wherever the print draws it. (The apron lowered onto the rock would
        # slope the lip from `floor` down to nothing across its last triangle.)
        x = np.full(len(cv), np.inf)
        sheet = np.full(len(cv), p.floor)
    else:
        # The sheet is `floor` thick right to the outline, its top rounded over
        # `edge_round` down to the lip; the pile stands on it, faded in over `rim`.
        x = _boundary_distance(cv, ct, boundary)
        sheet = _bead(x, p)
    sn = lay
    if p.drape <= 0.0:
        pile = _pile(p, tone, cover, lay[:, 2], rimf)
        mv = cv + lay * (sheet + pile)[:, None]
        _set_heights(layers, kdtree(cv), sheet + pile)
    else:
        # The sheet draped over the rock's steps and hollows, and the pile on it.
        laid = cv + lay * sheet[:, None]
        # A printed edge's apron is held down with the open edge: held at the
        # open edge alone, 11 cm or more out, the sheet still bridged a hollow
        # where the print cut it, and the moss hung 10 cm over the rock there
        # (Tris, 2026-10-10); with the mesh edge the open edge WAS the outline.
        held = (boundary | (s <= 0.0)) if (printed and HOLD_APRON) else boundary
        draped = _drape(laid, lay, ct, mg, held, p.drape, res, obstacle=(bvh, float(sheet.min())))
        sn = _spatial_normals(draped, ct, PILE_RADIUS)
        # the pile faces the way the sheet does: a step bridged by a slope
        # piles like a slope, not like the wall under it
        pile = _pile(p, tone, cover, sn[:, 2], rimf)
        kdm = kdtree(cv)
        _set_heights(layers, kdm, sheet + pile)
        # a dab rides the sheet off the rock, so the print finds it over the
        # moss it colours
        moved = draped - laid
        for layer in layers:
            for d in layer:
                i = kdm.find(d.c)[1]
                d.lay(Vector(cv[i] + moved[i]), Vector(sn[i]))
        mv = draped + sn * pile[:, None]
    if printed:
        return mv, ct, None, pin, sn, pile
    lip = (x < p.edge_round) | boundary
    return (*_skirt(mv, ct, cv, lay, sheet, boundary, lip), None, None, None)


def _outline_distance(v, t, s):
    """Each vertex's distance to the outline, the zero of `s` (to the nearest
    point where an edge crosses it: within half an edge of the true one)."""
    e = np.sort(np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]]), axis=1)
    e = np.unique(e, axis=0)
    a, b = e[:, 0], e[:, 1]
    cross = (s[a] >= 0.0) != (s[b] >= 0.0)
    a, b = a[cross], b[cross]
    if len(a) == 0:
        return np.full(len(v), np.inf)
    k = (s[a] / (s[a] - s[b]))[:, None]
    kd = kdtree(v[a] + (v[b] - v[a]) * k)
    return np.array([kd.find(Vector(x))[2] for x in v])


def _boundary_distance(v, t, boundary):
    """Each vertex's distance to the mesh's open edge (its vertices and the
    middles of its edges: within a sixteenth of an edge of the true one)."""
    e = np.sort(np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]]), axis=1)
    uk, cnt = np.unique(e, axis=0, return_counts=True)
    ob = uk[cnt == 1]
    if len(ob) == 0:
        return np.full(len(v), np.inf)
    kd = kdtree(np.concatenate([v[boundary], 0.5 * (v[ob[:, 0]] + v[ob[:, 1]])]))
    return np.array([kd.find(Vector(x))[2] for x in v])


LAY_RADIUS = 0.03  # m: the mound's sheet stands off the rock along its normal smoothed over this
PILE_RADIUS = 0.08  # m: ... and the pile, up to `floor + lift` tall, off the sheet along the sheet's
# smoothed over this: smoothed over less than its height, the pile folded in a crevice


def _grid_field(src, val, cell, at):
    """`val` (N, k) at the points `src` splatted into a sparse grid of `cell`,
    blurred [1 2 1] / 4 once along each axis, and read back at `at`, all
    trilinear: a field continuous in space, so points close together read
    close values whatever mesh they are on. Returns the sums read at `at`."""
    lo = np.minimum(src.min(0), at.min(0)) - 2.0 * cell
    hi = np.maximum(src.max(0), at.max(0))
    dims = np.floor((hi - lo) / cell).astype(np.int64) + 4

    def corners(pts):
        g = (pts - lo) / cell
        i0 = np.floor(g).astype(np.int64)
        f = g - i0
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                    yield ((i0[:, 0] + dx) * dims[1] + i0[:, 1] + dy) * dims[2] + i0[:, 2] + dz, w

    keys, ws = zip(*corners(src))
    uk, inv = np.unique(np.concatenate(keys), return_inverse=True)
    grid = np.zeros((len(uk), val.shape[1]))
    np.add.at(grid, inv.reshape(-1), np.concatenate([val * w[:, None] for w in ws]))
    for step in (dims[1] * dims[2], dims[2], 1):
        out = 2.0 * grid
        for sgn in (-1, 1):
            j = np.minimum(np.searchsorted(uk, uk + sgn * step), len(uk) - 1)
            hit = uk[j] == uk + sgn * step
            out[hit] += grid[j[hit]]
        grid = 0.25 * out
    acc = np.zeros((len(at), val.shape[1]))
    for k, w in corners(at):
        j = np.minimum(np.searchsorted(uk, k), len(uk) - 1)
        hit = uk[j] == k
        acc[hit] += grid[j[hit]] * w[hit, None]
    return acc


def _spatial_normals(v, t, radius):
    """Each vertex's normal smoothed over about `radius` in space: the faces'
    area-weighted normals through `_grid_field` at `radius` / 2 cells, so
    vertices close together have close normals however thin the triangles
    between them. Where the field turns against a vertex's own normal (the
    two faces of a fin thinner than the radius cancel) it keeps its own."""
    own = vertex_normals(v, t)
    fn = np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]])
    out = normalize(_grid_field(v[t].mean(1), fn, 0.5 * radius, v))
    bad = (out * own).sum(1) < 0.2
    out[bad] = own[bad]
    return out


def _pile(p, tone, cover, nz, rimf):
    """The pile over the sheet: the blurred tone (`tone`, over the blurred
    share of moss around, `cover`) times `lift`, times how much the moss
    faces up there (`nz`, the up component of its normal; `up_floor` of it on
    a wall), faded in from the edge by `rimf`."""
    up = p.up_floor + (1 - p.up_floor) * smoothstep(0.0, 0.7, nz)
    return np.maximum(p.floor * (cover - 1.0) + p.lift * tone * up, 0.0) * rimf


def _carry(f, par):
    """A per-vertex field carried onto refine's new vertices, each the mean of
    its two parents (`par`, in order). Nan (no tone) carries as nan."""
    out = np.concatenate([f, np.zeros((len(par),) + f.shape[1:])])
    n0 = len(f)
    # A parent always comes before its child, so a generation at a time.
    todo = np.arange(len(par))
    known = np.zeros(len(out), bool)
    known[:n0] = True
    while len(todo):
        ok = known[par[todo, 0]] & known[par[todo, 1]]
        k = todo[ok]
        out[n0 + k] = 0.5 * (out[par[k, 0]] + out[par[k, 1]])
        known[n0 + k] = True
        todo = todo[~ok]
    return out


def _union_field(dabs, pts, nrm, reach, slab=None):
    """How far inside the union of `dabs` each point is (m, negative outside),
    measured in each dab's plane along its radius: the largest over the dabs
    that face the point's way. -inf further than `reach` outside every dab.
    With `slab` (lo, hi), only points that far over a dab's plane count for
    it: a point down a wall under a dab's edge is not under the dab."""
    s = np.full(len(pts), -np.inf)
    if not dabs:
        return s
    kd = kdtree(pts)
    for d in dabs:
        radius = d.rmax + reach if slab is None else math.hypot(d.rmax + reach, max(abs(slab[0]), abs(slab[1])))
        idx = np.array([i for (_c, i, _d) in kd.find_range(d.c, radius)], dtype=np.int64)
        if len(idx) == 0:
            continue
        dn = np.asarray(d.n)
        idx = idx[nrm[idx] @ dn > 0.2]
        if len(idx) and slab is not None:
            rel = (pts[idx] - np.asarray(d.c)) @ dn
            idx = idx[(rel > slab[0]) & (rel < slab[1])]
        if len(idx) == 0:
            continue
        u, rr = d.u(pts[idx])
        s[idx] = np.maximum(s[idx], rr * (1.0 - u))
    return s


def _bead(s, p):
    """The sheet's height over the rock `s` in from the outline: `floor`,
    its top rounded down over `edge_round` to the lip, `overhang` up, where
    it meets the outline standing straight up (a quarter ellipse)."""
    f = p.floor
    o = min(p.overhang, 0.5 * f)
    if p.edge_round <= 0.0:
        return np.where(s > 0.0, f, o)
    x = np.clip(s / p.edge_round, 0.0, 1.0)
    return o + (f - o) * np.sqrt(np.maximum(0.0, 1.0 - (1.0 - x) ** 2))


SKIRT_RINGS = 3  # rings of the skirt under the lip, the last on the rock
CUT_CLEARANCE = 0.25  # the outline crosses an edge at least this far from its ends


def _skirt(mv, mt, rock, nrm, sheet, boundary, lip):
    """The skirt: from the lip (each open-edge vertex, `sheet` over the rock
    point `rock` along `nrm`) a quarter circle of that radius back under it,
    down to the rock that far inside the outline, so the edge is a rolled
    cushion whose foot is hidden under its own overhang and stands on the
    rock, never in it. Returns (vertices, triangles, lip mask)."""
    e = np.concatenate([mt[:, [0, 1]], mt[:, [1, 2]], mt[:, [2, 0]]])
    owner = np.tile(np.arange(len(mt)), 3)
    key = np.sort(e, axis=1)
    _u, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    open_ = cnt[inv.reshape(-1)] == 1
    be, bo = e[open_], owner[open_]  # open edges as their triangle winds them
    if len(be) == 0:
        return mv, mt, lip
    # inward: in the tangent plane, square to the edge, toward its triangle
    n_e = normalize(nrm[be[:, 0]] + nrm[be[:, 1]])
    along = mv[be[:, 1]] - mv[be[:, 0]]
    t_in = normalize(np.cross(n_e, along))
    mid = 0.5 * (mv[be[:, 0]] + mv[be[:, 1]])
    flip = ((mv[mt[bo]].mean(1) - mid) * t_in).sum(1) < 0
    t_in[flip] *= -1
    inward = np.zeros_like(mv)
    for k in range(2):
        np.add.at(inward, be[:, k], t_in)
    bi = np.nonzero(boundary)[0]
    tn = inward[bi] - nrm[bi] * (inward[bi] * nrm[bi]).sum(1)[:, None]
    tn = normalize(tn)
    ring_of = np.full(len(mv), -1, np.int64)
    ring_of[bi] = np.arange(len(bi))
    verts, tris = [mv], [mt]
    prev = None
    n0 = len(mv)
    for k in range(1, SKIRT_RINGS + 1):
        phi = -0.5 * math.pi * k / SKIRT_RINGS
        o = sheet[bi]
        pos = rock[bi] + nrm[bi] * (o * (1.0 + math.sin(phi)))[:, None] + tn * (o * (1.0 - math.cos(phi)))[:, None]
        base_k = n0 + (k - 1) * len(bi)
        verts.append(pos)
        up_a = be[:, 0] if prev is None else prev + ring_of[be[:, 0]]
        up_b = be[:, 1] if prev is None else prev + ring_of[be[:, 1]]
        lo_a, lo_b = base_k + ring_of[be[:, 0]], base_k + ring_of[be[:, 1]]
        # the open edge runs a -> b in its triangle: the skirt runs b -> a
        tris.append(np.stack([up_b, up_a, lo_a], 1))
        tris.append(np.stack([up_b, lo_a, lo_b], 1))
        prev = base_k
    out_v = np.concatenate(verts)
    lip_all = np.concatenate([lip, np.ones(len(out_v) - len(mv), bool)])
    return out_v, np.concatenate(tris).astype(np.int64), lip_all


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
        uvs, image, texel, _swatch = _print(mv, mt, layers, p)
        inv = np.linalg.inv(grown.host_matrix)
        local = mv @ inv[:3, :3].T + inv[:3, 3]
        return Result(local, mt, uvs, image, dabs=sum(len(x) for x in layers), layers=[len(x) for x in layers], heights={}, texel=texel, area=area)
    # ---- low poly, its edge back under the rock
    printed = p.edge_kind == "PRINT"
    tri_area = 0.5 * np.linalg.norm(np.cross(mv[mt[:, 1]] - mv[mt[:, 0]], mv[mt[:, 2]] - mv[mt[:, 0]]), axis=1)
    area = tri_area.sum()
    # the rest comes down to `mound_density`, and a mesh edge's rounding and
    # skirt (`lip`) keep triangles enough for their lobes (`_edge_budget`)
    lip = grown.lip if grown.lip is not None else np.zeros(len(mv), bool)
    edge_t = lip[mt].all(1)
    pin, sheet_n, pile = grown.pin, grown.sheet_n, grown.pile
    if printed:
        # the apron (the mesh past the outline, cut away by the print) at a
        # quarter of the density: it is never seen, and the collapse takes
        # the rest from wherever it costs least
        inside_t = _union_field(layers[0], mv[mt].mean(1), vertex_normals(mv, mt)[mt].mean(1), 0.0) >= 0.0
        area_in = tri_area[inside_t].sum()
        target = p.mound_density * (area_in + APRON_DENSITY * (area - area_in))
        ratio = min(1.0, max(0.005, target / max(len(mt), 1)))
        attrs = [pin, sheet_n[:, 0], sheet_n[:, 1], sheet_n[:, 2], pile]
        if ratio < 1.0:
            # The open edge stays where the cut put it: collapsing the apron
            # freely chained the collapses, and the open edge came 6 cm INSIDE
            # the outline on Terrace.003 (an 11 cm apron); a weight of 0 only
            # prices a vertex out (6 mm in), so what still moved goes back
            # onto the ring the cut made. The apron is never seen.
            ring = _open_edges(mv, mt)
            mv, mt, attrs = decimate(mv, mt, ratio, attrs, _boundary(mt, len(mv)))
            _snap_to_ring(mv, _boundary(mt, len(mv)), ring)
        # On the rock, never in it, triangle interiors included (`_clear_of_rock`:
        # the sheet sags through a convex crease, the collapse chords long
        # triangles under facet edges, and the rock poked through; Tris,
        # 2026-10-10).
        clear = 0.5 * p.floor
        rv, _rn, rt = grown.rock
        mv, mt, attrs, lifted, split, in_rock, _weld = _clear_of_rock(mv, mt, attrs, _RockDistance(rv, rt), clear)
        if DEBUG:
            print("[moss.debug] clear of the rock: %d vertices lifted, %d edges split, %.1f cm2 still in it; pinhole mark %d vertices before, %.2f max / %d over %.2f after" % (
                lifted, split, in_rock * 1e4, int((pin > 0.5).sum()), float(attrs[0].max()), int((attrs[0] > PIN_FILL).sum()), PIN_FILL))
        pin = attrs[0]
        sheet_n = normalize(np.stack(attrs[1:4], 1))
        pile = attrs[4]
    else:
        target = p.mound_density * tri_area[~edge_t].sum() + _edge_budget(mv, mt, p)
        ratio = min(1.0, max(0.005, target / max(len(mt), 1)))
        if ratio < 1.0:
            mv, mt, _carried = decimate(mv, mt, ratio)
    apron = float("inf")
    if not printed:
        in_rock = 0.0
    if printed:
        # How far outside the outline the open edge still is, at its closest:
        # the print cuts at the outline, so the mesh must reach past it.
        bi = np.nonzero(_boundary(mt, len(mv)))[0]
        if len(bi):
            # as the print reads a texel: facing by the sheet's normal (the
            # decimated mesh's own, at the open edge down a wall under a
            # dab's edge, faced the dab, and the edge read 9 mm inside)
            out = _union_field(layers[0], mv[bi], sheet_n[bi], SDF_RANGE, slab=(-SDF_SLAB, SDF_SLAB))
            apron = float(-out.max()) if np.isfinite(out).any() else float("inf")
    else:
        # the skirt's foot on the rock: on it, never in it
        for i in np.nonzero(_boundary(mt, len(mv)))[0]:
            on, _nr, _i, _d = bvh.find_nearest(Vector(mv[i]))
            if on is not None:
                mv[i] = np.array(on)

    heights = _heights(mv, bvh, grown.kd, grown.tval, p.levels)
    gv, gt, guv = _grass(mv, mt, bvh, grown.kd, grown.tval, p, layers[0] if printed else None)
    uvs, image, texel, swatch = _print(mv, mt, layers, p, swatch=len(gt) > 0, pin=pin, sheet_n=sheet_n, pile=pile)
    if len(gt):
        # the blades read their colour from the swatch: a column per tip, root to tip up it
        size = image.shape[0]
        (x0, y0), (cols, rows) = swatch
        px = np.stack([x0 + 0.5 + guv[..., 0] * (cols - 1), y0 + 0.5 + guv[..., 1] * (rows - 1)], -1)
        uvs = np.concatenate([uvs, px / size])
        mt = np.concatenate([mt, gt + len(mv)])
        mv = np.concatenate([mv, gv])
    inv = np.linalg.inv(grown.host_matrix)
    local = mv @ inv[:3, :3].T + inv[:3, 3]
    return Result(local, mt, uvs, image, dabs=sum(len(x) for x in layers), layers=[len(x) for x in layers], heights=heights, texel=texel, area=area, apron=apron, in_rock=in_rock)


EDGE_SEGMENT = 2.0  # the edge's triangles run this many `edge_detail` along the outline
APRON_DENSITY = 0.25  # a printed edge's apron is decimated to this share of `mound_density`


def _edge_budget(mv, mt, p):
    """The triangles the rounded edge is given on top of `mound_density`:
    its rings (the rounding, the lip, the skirt) in segments EDGE_SEGMENT
    `edge_detail` long along the outline (the skirt's foot, the open edge).
    The decimate places them, so the lobes' tight curves keep more."""
    e = np.sort(np.concatenate([mt[:, [0, 1]], mt[:, [1, 2]], mt[:, [2, 0]]]), axis=1)
    uk, cnt = np.unique(e, axis=0, return_counts=True)
    ob = uk[cnt == 1]
    length = np.linalg.norm(mv[ob[:, 1]] - mv[ob[:, 0]], axis=1).sum()
    return 2.0 * (SKIRT_RINGS + 2) * length / (EDGE_SEGMENT * p.edge_detail)


GRASS_SEGMENTS = 3  # a blade's segments, root to tip
GRASS_SWATCH = (8, 32)  # texels of the print the blades read: a column per tip colour, root to tip up the rows
GRASS_ROOT = 0.35  # the root's colour: this far from `dark` to `light`
GRASS_WIDTH = 0.1  # a blade's width at its root, of its height


def _grass(mv, mt, bvh, kd, tval, p, base=None):
    """Grass sprigs: `grass` tufts a square metre of the moss's up-facing top,
    more where the moss is lighter, each about `grass_blades` blades up to
    `grass_height` tall, leaning out and curling over a little. A blade is a
    tapered strip of GRASS_SEGMENTS quads and a tip (its material is
    two-sided), rooted 3 mm into the moss. Returns the vertices, triangles and
    per-corner (column, height) in the swatch, both 0..1. Drawn from their own
    random stream, after the decimate, so they do not move the moss. With
    `base` (a printed edge's dark dabs) only faces inside their outline, by
    the lip's roll, grow any: the mesh runs on past it, cut away."""
    empty = (np.zeros((0, 3)), np.zeros((0, 3), np.int64), np.zeros((0, 3, 2)))
    if p.grass <= 0.0 or p.grass_height <= 0.0 or p.grass_blades < 1 or len(mt) == 0:
        return empty
    rng = random.Random(p.seed * 7919 + 2)
    a, b, c = (mv[mt[:, k]] for k in range(3))
    fn = np.cross(b - a, c - a)
    area = 0.5 * np.linalg.norm(fn, axis=1)
    fn = normalize(fn)
    centre = (a + b + c) / 3.0
    on_top = np.zeros(len(mt))
    tone = np.zeros(len(mt))
    for f in range(len(mt)):
        on, nr, _i, _d = bvh.find_nearest(Vector(centre[f]))
        if on is not None and (Vector(centre[f]) - on).dot(nr) >= 0.8 * p.floor:
            on_top[f] = 1.0
        tv = tval[kd.find(Vector(centre[f]))[1]]
        tone[f] = 0.0 if np.isnan(tv) else tv
    if base is not None:
        on_top *= _union_field(base, centre, fn, 0.0) >= LIP_ROUND
    up_area = area * on_top * smoothstep(0.2, 0.7, fn[:, 2])
    if up_area.sum() <= 0.0:
        return empty
    want = int(p.grass * up_area.sum() + rng.random())
    w = up_area * (0.25 + tone)
    cum = np.cumsum(w) / w.sum()
    zup = np.array((0.0, 0.0, 1.0))
    verts, tris, uvw = [], [], []
    for _ in range(want):
        f = min(int(np.searchsorted(cum, rng.random())), len(mt) - 1)
        r1, r2 = rng.random(), rng.random()
        if r1 + r2 > 1.0:
            r1, r2 = 1.0 - r1, 1.0 - r2
        root0 = a[f] + (b[f] - a[f]) * r1 + (c[f] - a[f]) * r2
        n = fn[f]
        tx = normalize(np.cross(n, (0.3, 0.7, 0.2)))
        ty = np.cross(n, tx)
        for _k in range(max(1, int(round(p.grass_blades * rng.uniform(0.5, 1.5))))):
            ang = rng.uniform(0.0, 2.0 * math.pi)
            out = tx * math.cos(ang) + ty * math.sin(ang)
            root = root0 + out * rng.uniform(0.0, 0.012) - n * 0.003
            up = normalize(n * 0.35 + zup * 0.65 + out * rng.uniform(0.1, 0.45))
            h = p.grass_height * rng.uniform(0.45, 1.0)
            curl = out * (h * rng.uniform(0.15, 0.4))
            side = normalize(np.cross(up, out))
            width = h * GRASS_WIDTH
            col = rng.random()
            base = sum(len(x) for x in verts)
            ring = []
            for j in range(GRASS_SEGMENTS):
                t = j / GRASS_SEGMENTS
                ctr = root + up * (h * t) + curl * (t * t)
                half = 0.5 * width * (1.0 - t) ** 0.9
                ring.append(np.stack([ctr - side * half, ctr + side * half]))
                uvw.append(((col, t), (col, t)))
            ring.append((root + up * h + curl)[None, :])
            uvw.append(((col, 1.0),))
            verts.append(np.concatenate(ring))
            for j in range(GRASS_SEGMENTS - 1):
                l0, r0, l1, r1_ = base + 2 * j, base + 2 * j + 1, base + 2 * j + 2, base + 2 * j + 3
                tris.extend(((l0, r0, r1_), (l0, r1_, l1)))
            tip = base + 2 * GRASS_SEGMENTS
            tris.append((base + 2 * (GRASS_SEGMENTS - 1), base + 2 * (GRASS_SEGMENTS - 1) + 1, tip))
    if not verts:
        return empty
    gv = np.concatenate(verts)
    gt = np.array(tris, dtype=np.int64)
    flat = np.array([x for ring in uvw for x in ring], dtype=np.float64)
    return gv, gt, flat[gt]


def _swatch_colours(p):
    """The grass swatch (rows, cols, 3), linear: each column runs from the root
    colour up to its tip, the columns from `light` to `grass_tip`."""
    cols, rows = GRASS_SWATCH
    dark_s = np.array([_srgb(x) for x in p.dark])
    light_s = np.array([_srgb(x) for x in p.light])
    tip_s = np.array([_srgb(x) for x in p.grass_tip])
    root = dark_s + (light_s - dark_s) * GRASS_ROOT
    tips = light_s + (tip_s - light_s) * np.linspace(0.0, 1.0, cols)[:, None]
    t = ((np.arange(rows) + 0.5) / rows) ** 0.5
    srgb = root[None, None, :] + (tips[None, :, :] - root[None, None, :]) * t[:, None, None]
    return np.vectorize(_lin)(srgb)


def _set_heights(layers, kd, lift):
    for layer in layers:
        for d in layer:
            d.h = max(0.0, float(lift[kd.find(d.c)[1]]))


DRAPE_CELL = 0.025  # m: the coarse mesh the sheet is draped on
DRAPE_WINDOW = 100  # passes
DRAPE_TOL = 2e-4  # m: the sheet is settled when under 1 % of its clusters move this far in DRAPE_WINDOW passes
DRAPE_PASSES = 20000  # ... or after this many passes
OBSTACLE_EVERY = 10  # passes between the rock's clamps on the clusters
HOLD_APRON = True  # a printed edge's apron is held down with the open edge


def _drape(base, nrm, tri, g, boundary, radius, res, obstacle=None):
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
    q = _relax(cs.copy(), cs, cn, pin, ce, DRAPE_PASSES, 1e-4 * cell, radius=radius, tri=ct, obstacle=obstacle)
    # Carried back as a field continuous in space, each cluster's move
    # weighted by its vertices: carried back rigidly, a cluster's step against
    # its neighbour's folded the sheet where the edge refines it finer than a
    # cluster (Terrace.003: 65 cm2 turned over 1-10 cm in from the edge).
    acc = _grid_field(cs, np.concatenate([(q - cs) * count[:, None], count[:, None]], 1), cell, base)
    move = acc[:, :3] / np.maximum(acc[:, 3:], 1e-12)
    move[boundary] = 0.0
    sheet = base + move
    # the vertices' own pass has no obstacle: a query a vertex a pass is
    # minutes at a fine resolution, and `_clear_of_rock` clears them after
    return _relax(sheet, base, nrm, boundary, e, _passes(2 * cell, res), 1e-4 * res, radius=radius, tri=tri)


def _relax(q, rest, nrm, pin, e, passes, eps, radius=None, tri=None, obstacle=None):
    """Umbrella passes over positions `q`, each followed by the obstacle: a
    vertex less than `eps` over its `rest` along its normal is set back on it,
    as is every `pin`ned one. With `obstacle` (the rock's BVH, the height the
    sheet stands over it) the rock itself is the obstacle as well: a vertex
    under that height over its nearest rock point is set there. The rest
    plane alone let the sheet cut a convex corner (a cluster at a cube's
    edge, its normal the two faces' mean, slid 34 mm into the cube along a
    plane that is inside both faces: Cube.004, 2026-10-10).

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
    on_rock = np.zeros(n, bool)
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
        if obstacle is not None and _ % OBSTACLE_EVERY == 0:
            # every OBSTACLE_EVERY passes, not every one: a query a cluster a
            # pass in Python is most of a pass, and a few passes into the rock
            # between clamps are smoothed away by the clamps
            # A cluster that would be in the rock goes back to where the sheet
            # was laid, not onto the nearest face: a cluster astride a convex
            # edge set on a face leaves the crease, and the triangles across
            # it chord the corner (Cube.004: 12 % of the samples in the rock).
            bvh, clear = obstacle
            on_rock = np.zeros(n, bool)
            for i in np.nonzero(~held)[0].tolist():
                on, nr, _i, _d = bvh.find_nearest(Vector(new[i]))
                if on is not None and (Vector(new[i]) - on).dot(nr) < clear:
                    new[i] = rest[i]
                    on_rock[i] = True
        q = new
        # Settled: measured over a window of passes, and on all but a few: a
        # cluster where the sheet meets the rock at the mound's rim can flick
        # on and off it for good (the step: 9 of 2339, a few mm each, which
        # the vertices' own relaxing smooths away). A cluster the rock holds
        # is settled whatever the pull does to it between the clamps (Cube.004
        # ran every pass otherwise, 2026-10-10).
        if press and _ % DRAPE_WINDOW == 0:
            moving = int(((np.abs(q - last).max(1) > DRAPE_TOL) & ~on_rock).sum()) if _ else n
            if DEBUG and _ % (10 * DRAPE_WINDOW) == 0:
                print("[moss.debug] drape: pass %d, %d of %d clusters moving, %d on the rock" % (_, moving, n, int(on_rock.sum())), flush=True)
            if _ and moving <= 0.01 * n:
                break
            last = q.copy()
    if DEBUG and press:
        print("[moss.debug] drape: %d clusters settled in %d passes" % (n, _ + 1))
    return q


def _drop_small(v, t, min_area, keep_at=()):
    """Triangles of the mesh islands (connected by shared vertices) of at least
    `min_area`, and of every island nearest a point of `keep_at` (a stray
    clump is a small island on purpose)."""
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
    inv = inv.reshape(-1)
    total = np.bincount(inv, weights=area)
    keep = total >= min_area
    if len(keep_at):
        verts = np.unique(t)
        kd = kdtree(v[verts])
        for c in keep_at:
            keep[np.searchsorted(_u, find(int(verts[kd.find(c)[1]])))] = True
    return t[keep[inv]]


def _open_edges(v, t):
    """The open edges of the mesh as segments (E, 2, 3)."""
    e = np.sort(np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]]), axis=1)
    uk, cnt = np.unique(e, axis=0, return_counts=True)
    ob = uk[cnt == 1]
    return v[ob]


class _Shell:
    """One closed shell of the rock: its own BVH, face normals and the
    pseudonormals of its edges and vertices, and its box."""

    def __init__(self, co, tri):
        self.co, self.tri = co, tri
        self.bvh = BVHTree.FromPolygons([tuple(x) for x in co], [tuple(x) for x in tri.tolist()])
        self.lo, self.hi = co.min(0), co.max(0)
        a, b, c = co[tri[:, 0]], co[tri[:, 1]], co[tri[:, 2]]
        self.fn = normalize(np.cross(b - a, c - a))
        vn = np.zeros_like(co)
        for k in range(3):
            p, q, r = co[tri[:, k]], co[tri[:, (k + 1) % 3]], co[tri[:, (k + 2) % 3]]
            u, w = normalize(q - p), normalize(r - p)
            ang = np.arccos(np.clip(np.einsum("ij,ij->i", u, w), -1.0, 1.0))
            np.add.at(vn, tri[:, k], self.fn * ang[:, None])
        self.vn = vn
        self.en = {}
        for f, (i, j, k) in enumerate(tri.tolist()):
            for e in ((i, j), (j, k), (k, i)):
                key = (min(e), max(e))
                self.en[key] = self.en.get(key, 0.0) + self.fn[f]

    def query(self, q):
        on, _nr, f, d = self.bvh.find_nearest(Vector(q))
        if on is None:
            return float("inf"), None, None
        on = np.array(on)
        i, j, k = self.tri[f]
        a, b, c = self.co[i], self.co[j], self.co[k]
        # barycentrics of the nearest point: which feature it is on
        v0, v1, v2 = b - a, c - a, on - a
        d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
        d20, d21 = v2 @ v0, v2 @ v1
        den = d00 * d11 - d01 * d01
        pn = self.fn[f]
        if den > 0.0:
            wb = (d11 * d20 - d01 * d21) / den
            wc = (d00 * d21 - d01 * d20) / den
            w = (1.0 - wb - wc, wb, wc)
            zero = [x < 1e-7 for x in w]
            if sum(zero) >= 2:
                pn = self.vn[(i, j, k)[w.index(max(w))]]
            elif sum(zero) == 1:
                o = (i, j, k)
                m = zero.index(True)
                e = (o[(m + 1) % 3], o[(m + 2) % 3])
                pn = self.en[(min(e), max(e))]
        off = q - on
        s = 1.0 if off @ pn >= 0.0 else -1.0
        if s < 0.0 and d > PARITY_BELOW and not self.inside(q):
            # the pseudonormal says in, the rays say out: the rays (a few
            # points by a non-manifold edge or a sliver read in by mm,
            # Terrace.002 and .003, 2026-10-10)
            s = 1.0
        out = off * (s / d) if d > 1e-9 else pn / max(np.linalg.norm(pn), 1e-12)
        return s * d, on, out

    def inside(self, q):
        """Ray parity, the majority of PARITY_RAYS: is `q` inside the shell?"""
        votes = 0
        for ray in PARITY_DIRS:
            o, n = Vector(q), 0
            for _ in range(1000):
                loc, _nr, _f, _d = self.bvh.ray_cast(o, ray)
                if loc is None:
                    break
                n += 1
                o = loc + ray * 1e-6
            votes += n % 2
        return votes * 2 > len(PARITY_DIRS)


PARITY_BELOW = 1e-4  # m: a point read in the rock by more than this is checked by ray parity
# odd directions, so a ray seldom runs along an edge or a face
PARITY_DIRS = [Vector(d).normalized() for d in ((0.5257, 0.1847, 0.8304), (-0.7071, 0.6124, 0.3536), (0.2113, -0.9361, 0.2810))]


ROCK_REACH = 0.25  # m: a shell further than this (by its box) is not asked about a point
SHELL_VOLUME_MIN = 1e-6  # m3: a shell of the rock enclosing less (or facing inward) is left out of its distance


class _RockDistance:
    """The rock's signed distance (positive outside) at any point, as the
    game sees the rock: the union of its closed shells, the least of their
    distances. Each shell's is its nearest point signed by the angle-weighted
    pseudonormal of the feature it lies on (Baerentzen and Aanaes, "Signed
    distance computation using the angle weighted pseudonormal", 2005) - the
    face's normal inside a face, the sum of its two faces' normals on an
    edge, the angle-weighted normal at a vertex.

    Both halves were measured wrong first (2026-10-10): the face's normal
    alone misreads a point outside a sharp convex edge as inside; and
    Cube.004's own triangles are 31 closed shells, rock chunks overlapping,
    where the nearest surface can be a buried shell's and a point deep inside
    the rock reads as outside it (ray parity split 2-3 of 5 on 61 % of the
    points the old clamp had cleared). The growth's surface is now the union
    of such shells (stampbrush/hosts.py), so the shells here seldom overlap;
    the least distance still holds where they do. Only outward shells count
    (SHELL_VOLUME_MIN). `co`, `tri`: the host's welded, consistently wound
    world triangles."""

    def __init__(self, co, tri):
        parent = np.arange(len(co))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for a, b, c in tri.tolist():
            for u, w in ((a, b), (b, c)):
                ru, rw = find(u), find(w)
                if ru != rw:
                    parent[ru] = rw
        roots = np.array([find(i) for i in tri[:, 0]])
        self.shells = []
        for r in np.unique(roots):
            st = tri[roots == r]
            used, local = np.unique(st, return_inverse=True)
            sc = co[used]
            a, b, c = sc[local.reshape(-1, 3)[:, 0]], sc[local.reshape(-1, 3)[:, 1]], sc[local.reshape(-1, 3)[:, 2]]
            # outward shells only: one with no volume (a stray flat piece)
            # encloses nothing, and one facing inward is a void the union
            # left - inside the rock, where no moss is, but in the open air
            # round it every point reads inside it (Terrace.002 + Cube.001's
            # union leaves three such slivers, 10-16 triangles, and 27 mound
            # triangles beside them read 6 mm deep where ray parity found
            # them clear, 2026-10-10)
            if np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0 < SHELL_VOLUME_MIN:
                continue
            self.shells.append(_Shell(sc, local.reshape(-1, 3)))

    def query(self, q):
        """(signed distance, nearest point, the outward direction there) at `q` (3,), of the nearest shell (the one it is deepest in)."""
        best = (float("inf"), None, None)
        for sh in self.shells:
            if (q < sh.lo - ROCK_REACH).any() or (q > sh.hi + ROCK_REACH).any():
                continue
            r = sh.query(q)
            if r[0] < best[0]:
                best = r
        return best


CLEAR_ROUNDS = 64  # rounds of raising and splitting what still meets the rock, at most
CLEAR_RAISE = 0.004  # m: how much higher than `clear` a vertex may be raised to take a chord off a crease, before its triangle is split instead
CLEAR_SPLIT_MIN = 0.002  # m: an edge shorter than this is not split again (the rock's own detail; what is left is reported)
CLEAR_SAMPLE = 0.005  # m: what is left in the rock is measured on points this far apart
LIFT_TRIES = 6  # a vertex lifted clear of one shell and standing in another is lifted again, this many times at most


def _clear_of_rock(v, t, attrs, rock, clear, weld=None):
    """The mound out of the rock, triangle interiors included. Every vertex
    is set at least `clear` off the rock (one nearer, or in it, goes to that
    far off its nearest point, along the outward direction there); a vertex
    standing clear of the rock, a triangle is out of it exactly when it meets
    none of the rock's triangles, which the BVHs answer exactly (no samples
    to fall between). A triangle that still meets the rock has its vertices
    raised (each round higher, CLEAR_RAISE over `clear` at most: a chord
    across a shallow crease comes off it for a millimetre or two, at no
    cost), and once they are as high as they may go, its longest edge split
    at the midpoint, the new vertex set clear in turn; until none meets it
    (CLEAR_ROUNDS at most). An edge is split, not a triangle: every triangle
    on it is cut at the same point, so no crack opens (a point inside one
    triangle, as a fan split puts it, is a T-junction on its neighbour's
    edge). The splits gather where the rock bends too sharply for a raise,
    along its creases, where the mesh must bend with it.

    Until 2026-10-10 `_lift_chords` split the worst triangles round a new
    vertex over the offending rock point, two rounds and only past 3 mm,
    against the rock's own triangles (whose buried shells it took for
    surface): it left 5,967 cm2 of Cube.004's 4.2 m2 mound in the rock, 56 mm
    deep at worst, the moss clipped through the rock and the bake shaded the
    rock above it (the owner's jagged patch). Samples 1 cm apart, tried next,
    reported nothing left on Terrace.003 where a 7.5 mm census found 30 cm2.

    `rock` is the host's _RockDistance; `attrs` per-vertex arrays,
    interpolated at new vertices. `weld`, when given, names each vertex's
    point (a mesh split at its UV seams has two vertices at one point): the
    vertices of a point are raised together, and an edge between two points
    is split in every triangle on it, so no seam opens. Returns (v, t,
    attrs, vertices moved, edges split, m2 of mound still in the rock)."""
    sdf = rock
    v = np.asarray(v, np.float64).copy()
    t = np.asarray(t, np.int64).copy()
    attrs = [np.asarray(a, np.float64).copy() for a in attrs]
    height = np.full(len(v), clear)  # what each vertex stands off the rock
    top = clear + CLEAR_RAISE
    moved = np.zeros(len(v), bool)
    stuck = np.zeros(len(v), bool)  # still in the rock after LIFT_TRIES
    weld = np.arange(len(v)) if weld is None else np.asarray(weld, np.int64).copy()

    def lift(idx):
        for i in idx:
            for _ in range(LIFT_TRIES):
                d, on, out = sdf.query(v[i])
                if d >= height[i] - 1e-6 or on is None:
                    break
                v[i] = on + out * height[i]
                moved[i] = True
            stuck[i] = sdf.query(v[i])[0] < 0.0

    lift(range(len(v)))
    split = 0
    for _round in range(CLEAR_ROUNDS + 1):
        bad = _meets_rock(v, t, sdf) | stuck[t].any(1)
        if DEBUG:
            print(f"[moss.debug] clear round {_round}: {len(t)} triangles, {int(bad.sum())} meet the rock", flush=True)
        if not bad.any() or _round == CLEAR_ROUNDS:
            break
        corners = np.unique(t[bad])
        low = corners[height[corners] < top - 1e-9]
        low = np.nonzero(np.isin(weld, weld[low]))[0]  # every vertex of those points
        if len(low):
            height[low] = np.minimum(top, 2.0 * height[low] + 0.0005)
            lift(low)
        # split the triangles whose corners are all as high as they may go
        full = bad & (height[t] >= top - 1e-9).all(1)
        if not full.any():
            continue
        tri_e = np.stack([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]], 1)  # (T, 3, 2)
        length = np.linalg.norm(v[tri_e[..., 0]] - v[tri_e[..., 1]], axis=2)
        pick = np.argmax(length, axis=1)
        cand = full & (length[np.arange(len(t)), pick] > CLEAR_SPLIT_MIN)
        if not cand.any():
            if not len(low):
                break
            continue
        chosen = tri_e[np.nonzero(cand)[0], pick[cand]]
        # by point: the same edge's other copy across a seam is split too
        point_e = np.sort(weld[tri_e], axis=2).reshape(-1, 2)
        want = np.sort(weld[chosen], axis=1)
        span = int(weld.max()) + 1
        hit = np.isin(point_e[:, 0] * span + point_e[:, 1], want[:, 0] * span + want[:, 1])
        edges = np.unique(np.sort(tri_e.reshape(-1, 2)[hit], axis=1), axis=0)
        pe = np.sort(weld[edges], axis=1)
        _u, which = np.unique(pe, axis=0, return_inverse=True)
        v, t, attrs, new, _kept = _split_edges(v, t, attrs, edges)
        weld = np.concatenate([weld, weld.max() + 1 + which.reshape(-1)])
        height = np.concatenate([height, np.full(len(new), clear)])
        moved = np.concatenate([moved, np.zeros(len(new), bool)])
        stuck = np.concatenate([stuck, np.zeros(len(new), bool)])
        split += len(edges)
        lift(new)
    bad = _meets_rock(v, t, sdf) | stuck[t].any(1)
    return v, t, attrs, int(moved.sum()), split, _area_in_rock(v, t[bad], sdf), weld


def _meets_rock(v, t, sdf):
    """Which triangles of the mesh meet a triangle of the rock (BVHTree.overlap: exact triangle pairs)."""
    mound = BVHTree.FromPolygons([tuple(x) for x in v], [tuple(x) for x in t.tolist()])
    bad = np.zeros(len(t), bool)
    for sh in sdf.shells:
        for i, _j in mound.overlap(sh.bvh):
            bad[i] = True
    return bad


def _area_in_rock(v, t, sdf):
    """m2 of the triangles `t` in the rock, on points CLEAR_SAMPLE apart."""
    if len(t) == 0:
        return 0.0
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    longest = np.max(np.stack([np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1), np.linalg.norm(a - c, axis=1)]), axis=0)
    n = np.clip(np.ceil(longest / CLEAR_SAMPLE), 1, 32).astype(np.int64)
    total = 0.0
    for k in np.unique(n):
        w, _tris = _bary_grid(int(k))
        idx = np.nonzero(n == k)[0]
        at = np.einsum("pk,tkc->tpc", w, v[t[idx]])
        for row, f in enumerate(idx):
            total += area[f] * np.mean([sdf.query(q)[0] < 0.0 for q in at[row]])
    return float(total)


def _split_edges(v, t, attrs, edges):
    """Split every one of `edges` (E, 2), sorted vertex pairs, at its
    midpoint; every triangle on a split edge is cut there (one split edge:
    two triangles; two: three, the quad by its shorter diagonal; three:
    four). Returns (v, t, attrs, the new vertices' indices, the indices of
    the triangles left whole, which come first in `t`, in order)."""
    base = len(v)
    mid = {(int(i), int(j)): base + k for k, (i, j) in enumerate(edges)}
    v = np.concatenate([v, 0.5 * (v[edges[:, 0]] + v[edges[:, 1]])])
    attrs = [np.concatenate([a, 0.5 * (a[edges[:, 0]] + a[edges[:, 1]])]) for a in attrs]
    whole, out = [], []
    for f, (i, j, k) in enumerate(t.tolist()):
        m = [mid.get((min(p, q), max(p, q))) for p, q in ((i, j), (j, k), (k, i))]
        cnt = sum(x is not None for x in m)
        if cnt == 0:
            whole.append(f)
            continue
        # rotate so the corners are (a, b, c) with the split edges first
        o, ms = (i, j, k), m
        if cnt == 1:
            r = ms.index(next(x for x in ms if x is not None))
        elif cnt == 2:
            r = ms.index(None)
            r = (r + 1) % 3
        else:
            r = 0
        a, b, c = o[r], o[(r + 1) % 3], o[(r + 2) % 3]
        mab, mbc, mca = ms[r], ms[(r + 1) % 3], ms[(r + 2) % 3]
        if cnt == 1:  # ab split
            out += [(a, mab, c), (mab, b, c)]
        elif cnt == 2:  # ab and bc split, ca whole
            out.append((mab, b, mbc))
            if np.linalg.norm(v[a] - v[mbc]) <= np.linalg.norm(v[mab] - v[c]):
                out += [(a, mab, mbc), (a, mbc, c)]
            else:
                out += [(a, mab, c), (mab, mbc, c)]
        else:
            out += [(a, mab, mca), (mab, b, mbc), (mca, mbc, c), (mab, mbc, mca)]
    kept = np.array(whole, dtype=np.int64)
    t = np.concatenate([t[kept], np.array(out, dtype=np.int64).reshape(-1, 3)])
    return v, t, attrs, np.arange(base, len(v)), kept


def _snap_to_ring(v, boundary, ring):
    """Move the `boundary` vertices of `v` (in place) onto the nearest point
    of the `ring` segments (E, 2, 3)."""
    bi = np.nonzero(boundary)[0]
    if len(bi) == 0 or len(ring) == 0:
        return
    a, b = ring[:, 0], ring[:, 1]
    ab = b - a
    ab2 = np.maximum(np.einsum("ij,ij->i", ab, ab), 1e-12)
    # candidates by the segments' midpoints, then the exact nearest point on each
    kd = kdtree(0.5 * (a + b))
    for i in bi.tolist():
        p = v[i]
        near = [k for (_c, k, _d) in kd.find_n(Vector(p), 8)]
        if not near:
            continue
        s = np.clip(((p - a[near]) * ab[near]).sum(1) / ab2[near], 0.0, 1.0)
        q = a[near] + ab[near] * s[:, None]
        v[i] = q[np.argmin(np.linalg.norm(q - p, axis=1))]


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


STRAY_SIZE = (0.35, 0.7)  # a stray dab's radius, of `dab_min`
STRAY_CLUMP = (1, 1, 1, 2, 2, 3)  # dabs in a stray clump, drawn from these


def _strays(p, g, v, hull, kd, base):
    """Detached clumps: `strays` a metre of outline, each one to three small
    dark dabs on the rock outside the dark base (`base`, which they join),
    most of them close to it and none further than `stray_reach` or nearer
    than a quarter of `dab_min`, so each is a cushion of its own. Drawn from
    their own random stream, so the growth inside is the same with or without
    them. Returns their centres."""
    if p.strays <= 0.0 or p.stray_reach <= 0.0 or not base:
        return []
    rng = random.Random(p.seed * 7919 + 1)
    out = -_union_field(base, v, hull, p.stray_reach)
    idx = np.nonzero((out > 0.0) & (out <= p.stray_reach))[0]
    if len(idx) == 0:
        return []
    length = g.area[idx].sum() / p.stray_reach  # of outline, about
    want = int(p.strays * length + rng.random())
    w = np.exp(-out[idx] / (0.4 * p.stray_reach)) * g.area[idx]
    cum = np.cumsum(w) / w.sum()
    gap = 0.25 * p.dab_min
    made, centres = [], []

    def fits(d):
        o = out[kd.find(d.c)[1]]
        return o > d.rmax + gap and all((d.c - e.c).length > d.rmax + e.rmax + gap for e in made)

    for _ in range(want * 6):
        if len(centres) >= want:
            break
        i = int(idx[min(int(np.searchsorted(cum, rng.random())), len(idx) - 1)])
        c, n = Vector(v[i]), Vector(hull[i])
        d = Dab(c, n, p.dab_min * rng.uniform(*STRAY_SIZE), 0, rng)
        if not fits(d):
            continue
        clump = [d]
        tx = n.cross(Vector((0.3, 0.7, 0.2))).normalized()
        ty = n.cross(tx)
        for _k in range(rng.choice(STRAY_CLUMP) - 1):
            a = rng.uniform(0, 2 * math.pi)
            r = p.dab_min * rng.uniform(*STRAY_SIZE)
            _co, j, _dd = kd.find(c + (tx * math.cos(a) + ty * math.sin(a)) * (d.r + r) * 0.55)
            e = Dab(Vector(v[j]), Vector(hull[j]), r, 0, rng)
            if Vector(hull[j]).dot(n) > 0.7 and fits(e):
                clump.append(e)
        made.extend(clump)
        centres.append(np.array(c[:]))
    base.extend(made)
    if DEBUG:
        print("[moss.debug] strays: %d clumps (%d dabs) of %d wanted over %.2f m of outline" % (len(centres), len(made), want, length))
    return centres


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
# ... and for a printed edge, whose alpha is cut at 0.5: a chart's apron (alpha
# 0) packed beside another chart's inside (1) averages to a hole at the seam in
# any mip that reaches across the gutter (dots along a seam at mip 1-2 at a
# grazing angle, 2026-10-10). Eight texels keep mips 0-3 inside their chart.
CHART_PAD_PRINTED = 8
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


def _print(mv, mt, layers, p, swatch=False, pin=None, sheet_n=None, pile=None):
    """UVs and the texture: the mound in flat charts packed into one square, every
    dab evaluated per texel. With `swatch`, the grass swatch is packed beside
    them and returned as ((x, y), (cols, rows)) in texels, else None. `pin`,
    `sheet_n` and `pile` (a printed edge) are the mound's per-vertex
    filled-pinhole mark, sheet normal and pile height, read per texel into
    the outline's distance."""
    q, chart, n_charts = _charts(mv, mt)
    lo_c = np.full((n_charts, 2), np.inf)
    hi_c = np.full((n_charts, 2), -np.inf)
    np.minimum.at(lo_c, chart, q.min(1))
    np.maximum.at(hi_c, chart, q.max(1))
    pad = CHART_PAD_PRINTED if (p.kind != "TEXTURE" and p.edge_kind == "PRINT") else CHART_PAD
    texel = p.texel
    while True:
        wh = np.ceil((hi_c - lo_c) / texel).astype(np.int64) + 2 * pad
        if swatch:
            wh = np.concatenate([wh, [[GRASS_SWATCH[0] + 2 * pad, GRASS_SWATCH[1] + 2 * pad]]])
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
    pinned = np.zeros((size, size))
    sheet = np.zeros((size, size, 3))
    piled = np.zeros((size, size))
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
            # A triangle thinner than a texel holds no texel centre: it gets
            # the texel under its centre, else its atlas box was filled from
            # whatever chart lay beside it, a streak across the moss (the
            # slivers the open edge's snap and the chord splits leave, 2026-10-10).
            cx_, cy_ = int(min(max(px_uv[f][:, 0].mean(), 0), size - 1)), int(min(max(px_uv[f][:, 1].mean(), 0), size - 1))
            inside = (ys == cy_) & (xs == cx_)
            lam = np.full(inside.shape + (3,), 1.0 / 3.0)
            if not inside.any():
                continue
        lam = lam[inside]
        yy_, xx_ = ys[inside], xs[inside]
        pos[yy_, xx_] = lam @ mv[mt[f]]
        nrm[yy_, xx_] = lam @ vn[mt[f]]
        if pin is not None:
            pinned[yy_, xx_] = lam @ pin[mt[f]]
        if sheet_n is not None:
            sheet[yy_, xx_] = lam @ sheet_n[mt[f]]
        if pile is not None:
            piled[yy_, xx_] = lam @ pile[mt[f]]
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
        pinned[ty, tx] = pinned[sy, sx]
        sheet[ty, tx] = sheet[sy, sx]
        piled[ty, tx] = piled[sy, sx]
        valid |= grow
    yy, xx = np.nonzero(valid)
    tp, tn = pos[yy, xx], normalize(nrm[yy, xx])
    hash_ = _TexelHash(tp, p) if len(tp) else None
    col, cov = paint_texels(layers, p, tp, tn, hash_)
    img[yy, xx, :3] = col
    # A texture-only moss's decal shows the rock wherever no dab reaches; a
    # mound with a printed edge carries the outline's distance; a mound with
    # a mesh edge is opaque.
    if p.kind == "TEXTURE":
        img[yy, xx, 3] = cov
    elif p.edge_kind == "PRINT":
        # each texel's foot on the sheet, where the dabs and their outlines are
        tsn = normalize(sheet[yy, xx]) if sheet_n is not None else tn
        foot = tp - tsn * piled[yy, xx][:, None] if pile is not None else tp
        sd = outline_texels(layers[0], p, foot, tsn, None, pinned[yy, xx] if pin is not None else None, texel)
        img[yy, xx, 3] = np.clip(0.5 + sd / (2.0 * SDF_RANGE), 0.0, 1.0)
    else:
        img[yy, xx, 3] = 1.0
    if p.kind != "TEXTURE" and p.edge_kind == "PRINT":
        # The cut reads the alpha through mipmaps and the optimiser's
        # resize, which average across a chart's 2-texel gutter into the
        # empty atlas round it (alpha 0): a chart seam seen at a grazing
        # angle was a dotted line of holes (2026-10-10, three.js, mip 1-2).
        # Every chart grows into the empty atlas by DILATE texels, as the
        # baked rock maps fill their background, so the first five mips at a
        # seam average the chart's own values.
        img = _dilate(img, valid, DILATE)
    if not swatch:
        return uvs, img, texel, None
    # the swatch, its gutter the edge texels repeated
    (sx, sy), (cols, rows) = place[-1] + pad, GRASS_SWATCH
    sw = _swatch_colours(p)
    ry = np.clip(np.arange(-pad, rows + pad), 0, rows - 1)
    rx = np.clip(np.arange(-pad, cols + pad), 0, cols - 1)
    img[sy - pad : sy + rows + pad, sx - pad : sx + cols + pad, :3] = sw[ry][:, rx]
    img[sy - pad : sy + rows + pad, sx - pad : sx + cols + pad, 3] = 1.0
    return uvs, img, texel, ((int(sx), int(sy)), (cols, rows))


DILATE = 32  # texels a printed-edge atlas's charts grow into the empty atlas round them (mips 1-5 at a seam)


def _dilate(img, valid, passes):
    """`img` with every empty texel (not `valid`) within `passes` of a
    chart taking its nearest chart texel's values, a texel a pass in the four
    directions (as the gutter is grown, but on the painted values: nothing
    is evaluated). A chart never grows over another's texels."""
    img = img.copy()
    valid = valid.copy()
    size = valid.shape[0]
    for _ in range(passes):
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
        if len(ty) == 0:
            break
        img[ty, tx] = img[sy, sx]
        valid |= grow
    return img


CUT_STEP = 2.0  # texels: the side of the pieces a triangle across a printed outline is cut into for the bake
CUT_MAX = 64  # at most this many pieces along a triangle's side


def _bary_grid(n):
    """A triangle cut into n^2 pieces: the corners' barycentric weights
    (P, 3) and the pieces as corner indices (n^2, 3)."""
    ij = [(i, j) for i in range(n + 1) for j in range(n + 1 - i)]
    index = {c: k for k, c in enumerate(ij)}
    w = np.array([((n - i - j) / n, i / n, j / n) for i, j in ij])
    tris = []
    for i in range(n):
        for j in range(n - i):
            tris.append((index[i, j], index[i + 1, j], index[i, j + 1]))
            if i + j < n - 1:
                tris.append((index[i + 1, j], index[i + 1, j + 1], index[i, j + 1]))
    return w, np.array(tris)


def _bilinear(img, x, y):
    """`img` (H, W) at texel coordinates (texel centres at integer + 0.5), clamped at the border."""
    h, w = img.shape
    x = np.clip(x - 0.5, 0.0, w - 1.0)
    y = np.clip(y - 0.5, 0.0, h - 1.0)
    x0 = np.minimum(np.floor(x).astype(np.int64), w - 2) if w > 1 else np.zeros_like(x, np.int64)
    y0 = np.minimum(np.floor(y).astype(np.int64), h - 2) if h > 1 else np.zeros_like(y, np.int64)
    fx, fy = x - x0, y - y0
    x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
    top = img[y0, x0] * (1 - fx) + img[y0, x1] * fx
    bottom = img[y1, x0] * (1 - fx) + img[y1, x1] * fx
    return top * (1 - fy) + bottom * fy


def cut_at_print(corners, uvs, alpha, in_rock=None):
    """The printed mound as the game draws it, for the bake: `corners`
    (T, 3, 3) its triangles, `uvs` (T, 3, 2) their corners' UVs, `alpha`
    (H, W) the print's alpha, row 0 at the bottom. A triangle wholly inside
    the outline (alpha >= 0.5 at every piece) is kept, one wholly outside is
    dropped, and one across it is cut into pieces CUT_STEP texels across, of
    which those whose centre is inside are kept. `in_rock`, when given, takes
    (N, 3) points and says which are in the rock: those triangles are dropped
    too (the game never shows moss in the rock, and its shadow on the rock
    over it was the owner's jagged patch). Returns the kept triangles
    (K, 3, 3), unwelded.

    The bake's occlusion (the painted slate's Ambient Occlusion node) treats
    every surface as opaque, alpha 0 included: measured 2026-10-10, a plane
    of alpha 0 over a baked one darkened it to 0.049 of its open value,
    exactly as an opaque one did. The apron, which the game cuts away, baked
    the rock black under it in a band as jagged as its triangles (the owner's
    "jagged black lines around the moss")."""
    h, w = alpha.shape
    px = uvs * np.array([w, h], np.float64)
    longest = np.max(np.linalg.norm(px - np.roll(px, 1, axis=1), axis=2), axis=1)
    pieces = np.clip(np.ceil(longest / CUT_STEP), 1, CUT_MAX).astype(np.int64)
    out = []
    for n in np.unique(pieces):
        group = np.nonzero(pieces == n)[0]
        wts, tris = _bary_grid(int(n))
        centre = wts[tris].mean(axis=1)  # (S, 3)
        at = np.einsum("sk,tkc->tsc", centre, px[group])  # (G, S, 2)
        inside = _bilinear(alpha, at[..., 0], at[..., 1]) >= 0.5  # (G, S)
        whole = inside.all(axis=1)
        out.append(corners[group[whole]])
        part = ~whole & inside.any(axis=1)
        if part.any():
            pos = np.einsum("pk,tkc->tpc", wts, corners[group[part]])  # (G', P, 3)
            g, s = np.nonzero(inside[part])
            out.append(pos[g[:, None], tris[s]])
    kept = np.concatenate(out) if out else np.zeros((0, 3, 3))
    if in_rock is not None and len(kept):
        kept = kept[~in_rock(kept.mean(axis=1))]
    return kept


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


class _TexelHash:
    """A spatial hash of texels at world points `tp`: sorted by bucket, so a
    dab gathers the texels of every bucket its sphere touches in one numpy
    step. A bucket of one dab_max: a dab looks up ~30 of them, not ~1300 at
    0.3 (which bucket a texel is in decides nothing: every test after is per
    texel). Measured on mid-ledge: 0.3 x 2.35 s, 0.6 x 1.91, 1.0 x 1.71, 1.6 x 2.03."""

    def __init__(self, tp, p):
        self.tp = tp
        self.cell = cell = max(0.01, p.dab_max)
        self.lo = lo = tp.min(0)
        gk = np.floor((tp - lo) / cell).astype(np.int64)
        self.dims = dims = gk.max(0) + 1
        key = (gk[:, 0] * dims[1] + gk[:, 1]) * dims[2] + gk[:, 2]
        self.order = np.argsort(key, kind="stable")
        self.uk, self.start, self.count = np.unique(key[self.order], return_index=True, return_counts=True)
        self.tp_sq = np.einsum("ij,ij->i", tp, tp)

    def buckets(self, mid, reach):
        """The buckets (as positions into `uk`) that hold texels and whose
        centre is within `reach` of `mid`, plus a bucket's half-diagonal."""
        lo, cell, dims, uk = self.lo, self.cell, self.dims, self.uk
        g0 = np.maximum(np.floor((mid - reach - lo) / cell).astype(np.int64), 0)
        g1 = np.minimum(np.floor((mid + reach - lo) / cell).astype(np.int64), dims - 1)
        if (g1 < g0).any():
            return np.zeros(0, np.int64)
        gx, gy, gz = np.meshgrid(np.arange(g0[0], g1[0] + 1), np.arange(g0[1], g1[1] + 1), np.arange(g0[2], g1[2] + 1), indexing="ij")
        centre = (np.stack([gx, gy, gz], -1).reshape(-1, 3) + 0.5) * cell + lo
        near = np.linalg.norm(centre - mid, axis=1) < reach + 0.87 * cell
        want = ((gx * dims[1] + gy) * dims[2] + gz).ravel()[near]
        pos = np.searchsorted(uk, want)
        ok = pos < len(uk)
        ok[ok] = uk[pos[ok]] == want[ok]  # only buckets that hold texels
        return pos[ok]

    def texels(self, pos):
        """The texels of the buckets at `pos`."""
        st, cn = self.start[pos], self.count[pos]
        total = int(cn.sum())
        return self.order[np.repeat(st - np.concatenate([[0], np.cumsum(cn)[:-1]]), cn) + np.arange(total)]

    def within(self, centre, reach):
        """The texels within `reach` of `centre` (a sphere) and their points."""
        pos = self.buckets(centre, reach)
        if len(pos) == 0:
            return np.zeros(0, np.int64), np.zeros((0, 3))
        sel = self.texels(pos)
        pts = self.tp[sel]
        ok = self.tp_sq[sel] - 2.0 * (pts @ centre) + centre @ centre < reach * reach
        return sel[ok], pts[ok]


OUTLINE_STEP = 0.001  # m: the dark base's outlines are sampled this far apart for the print's distance
# The slab over and under a dab's plane its outline reaches for the print's
# distance: generous, because a texel's foot is on the decimated mound, whose
# long triangles (up to 40 cm on Terrace.003) chord under the sheet by
# centimetres, and a foot outside the slab had no outline at all: a binary
# alpha, a stair-stepped cut (2026-10-10). The facing test keeps a thin rock's
# far face out.
SDF_SLAB = 0.08
COPLANAR = 0.9  # cos: a dab facing a texel's sheet this closely measures its distance in its own plane (a chord's sag is not distance), else in 3D (a crease's)
PINHOLE_REACH = 0.4  # of dab_min: a gap between dabs surrounded by dabs this close is a pinhole of the packing, filled
ENCLOSED_GAP = math.radians(175.0)  # a point with no gap this wide among the directions to the dabs about it is surrounded
PIN_FILL = 0.05  # the mesh's filled-pinhole mark, read per texel, counts from here (it is interpolated)
OUTLINE_LOOK = 0.008  # m: an outline sample needs a texel outside the moss this close (at least two texels)


def _enclosed(pts, nrm, near_dabs):
    """Whether each of `pts` (facing `nrm`) is surrounded by dabs: among the
    directions in its plane to the centres of `near_dabs[i]` (the dabs within
    PINHOLE_REACH of it), no gap of ENCLOSED_GAP or wider. A point on a true
    outline has every dab behind it, in a half plane; a point in a pinhole of
    the packing has them all round."""
    out = np.zeros(len(pts), bool)
    if len(pts) == 0:
        return out
    ti = np.repeat(np.arange(len(pts)), [len(x) for x in near_dabs])
    if len(ti) == 0:
        return out
    cc = np.array([np.asarray(d.c) for ds in near_dabs for d in ds])
    rel = cc - pts[ti]
    n = nrm[ti]
    rel = rel - n * (rel * n).sum(1)[:, None]
    # a tangent basis per point
    a = np.where(np.abs(nrm[:, :1]) < 0.9, np.array([[1.0, 0.0, 0.0]]), np.array([[0.0, 1.0, 0.0]]))
    e1 = normalize(np.cross(nrm, a))
    e2 = np.cross(nrm, e1)
    ang = np.arctan2((rel * e2[ti]).sum(1), (rel * e1[ti]).sum(1))
    o = np.lexsort((ang, ti))
    ti, ang = ti[o], ang[o]
    first = np.r_[True, ti[1:] != ti[:-1]]
    last = np.r_[ti[1:] != ti[:-1], True]
    gap = np.empty(len(ti))
    gap[:-1] = ang[1:] - ang[:-1]
    # the wrap: from the last direction round to the first
    starts = np.nonzero(first)[0]
    ends = np.nonzero(last)[0]
    gap[ends] = 2.0 * math.pi - (ang[ends] - ang[starts])
    widest = np.zeros(len(pts))
    np.maximum.at(widest, ti, gap)
    counted = np.bincount(ti, minlength=len(pts))
    out[counted > 0] = widest[counted > 0] < ENCLOSED_GAP
    return out


def outline_texels(base, p, tp, tn, hash_=None, pinned=None, texel=None):
    """A printed edge: the signed distance (m, positive inside) from every texel
    to the outline of the union of the `base` dabs, clipped to SDF_RANGE each
    side. Not the dabs' own field (`_union_field`, which is each dab's
    distance to its own outline, so it dips to nothing at every edge between
    overlapping dabs and in every pinhole of the packing): the outlines are
    sampled OUTLINE_STEP apart, the samples inside another dab or facing a
    pinhole dropped, and each texel takes the nearest sample left, measured
    in its dab's plane. A texel with no sample within range is SDF_RANGE
    inside or outside by the field's sign, a pinhole's texels inside.

    A pinhole is a gap between dabs the moss fills: one surrounded by dabs
    within PINHOLE_REACH (`_enclosed`), or one the mound's mesh filled as a
    gap with no unpainted rock in it (`pinned`, the mesh's mark read per
    texel; the mesh is refined to `resolution`, so on a coarse rock its dabs,
    one try per vertex, leave gaps wider than any reach). Every texel in one
    is inside, and the outline samples facing one are dropped, so the lip's
    roll is not drawn round it.

    `tp` and `tn` are each texel's FOOT on the sheet (its position less the
    pile along the sheet's normal) and the sheet's normal there, which is
    where the dabs and their outlines are: measured on the mound's top, a
    texel high on a pile sat a pile's height from its outline, and the
    distance was taken in each dab's plane, so the outline on a rock's
    chamfer cast a valley of distance across the moss on the top above it,
    a grey wedge along the crease that cut through (Cube.004, 2026-10-10).
    Here the distance is the plain 3D distance from the foot to the sample,
    which on the sheet is the surface distance as near as the dabs are."""
    sd = np.full(len(tp), SDF_RANGE)
    if len(tp) == 0 or not base:
        return sd
    hash_ = hash_ or _TexelHash(tp, p)
    room = MOUND_LIFT_ROOM
    rmax_all = max(d.rmax for d in base)
    grid = _Grid(2.0 * p.dab_max)
    for d in base:
        grid.add(d)
    reach_pin = PINHOLE_REACH * p.dab_min
    texel = texel or p.texel

    def slab(d, reach):
        """The texels within `reach` of the dab's outline in its plane, within
        the slab of mound over it, facing its way: (indices, points, height
        over the plane)."""
        cc, dn = np.asarray(d.c), np.asarray(d.n)
        sel, pts = hash_.within(cc, math.hypot(d.rmax + reach, SDF_SLAB))
        if len(sel) == 0:
            return sel, pts, np.zeros(0)
        rel = pts @ dn - cc @ dn
        ok = (np.abs(rel) < SDF_SLAB) & ((tn[sel] @ dn) > 0.2)
        return sel[ok], pts[ok], rel[ok]

    def facing_near(pts, nrm, reach):
        """For each point, the base dabs facing its way whose outline is within
        `reach` of it (in the dab's plane)."""
        out = [[] for _ in range(len(pts))]
        kd = kdtree(pts)
        for d in base:
            idx = np.array([i for (_c, i, _d) in kd.find_range(d.c, math.hypot(d.rmax + reach, SDF_SLAB))], dtype=np.int64)
            if len(idx) == 0:
                continue
            idx = idx[nrm[idx] @ np.asarray(d.n) > 0.2]
            if len(idx) == 0:
                continue
            u, rr = d.u(pts[idx])
            for i in idx[rr * (1.0 - u) > -reach].tolist():
                out[i].append(d)
        return out

    # ---- the outline: each dab's, sampled, where no other dab covers it
    samples = []  # (dab, its kept samples (S, 3))
    for d in base:
        n = max(8, int(math.ceil(2.0 * math.pi * d.rmax / OUTLINE_STEP)))
        th = (np.arange(n) + 0.5) * (2.0 * math.pi / n)
        rr = d.r * (1 + sum(a * np.cos((j + 1) * th - ph) for j, (a, ph) in enumerate(d.harm)))
        q = np.asarray(d.c) + np.outer(rr * np.cos(th), np.asarray(d.ax)) + np.outer(rr * np.sin(th), np.asarray(d.ay))
        covered = np.zeros(n, bool)
        for e in grid.near(d.c, d.rmax + rmax_all):
            if e is d or np.asarray(e.n) @ np.asarray(d.n) <= 0.2:
                continue
            u, _rr = e.u(q)
            covered |= u < 1.0
        if not covered.all():
            samples.append((d, q[~covered]))
    if not samples:
        return sd
    sp = np.concatenate([q for _d, q in samples])
    sn = np.concatenate([np.tile(np.asarray(d.n), (len(q), 1)) for d, q in samples])
    # a sample facing a pinhole is no outline: one surrounded by dabs
    keep = ~_enclosed(sp, sn, facing_near(sp, sn, reach_pin))
    # ---- the texels: the field's sign (a pinhole's texels inside)
    field = np.full(len(tp), -np.inf)
    for d in base:
        sel, pts, _h = slab(d, reach_pin)
        if len(sel) == 0:
            continue
        u, rr = d.u(pts)
        field[sel] = np.maximum(field[sel], rr * (1.0 - u))
    inside = field >= 0.0
    if pinned is not None:
        inside |= pinned > PIN_FILL
    gap = np.nonzero(~inside & (field > -reach_pin))[0]
    if len(gap):
        inside[gap[_enclosed(tp[gap], tn[gap], facing_near(tp[gap], tn[gap], reach_pin))]] = True
    if DEBUG:
        print("[moss.debug] outline: texels inside %d of %d (%d by the mesh's fill, %d surrounded)" % (
            int(inside.sum()), len(tp), int(((field < 0.0) & (pinned > PIN_FILL)).sum()) if pinned is not None else 0, int((inside[gap]).sum()) if len(gap) else 0))
    # A sample is an outline only where the moss ends: one with no texel
    # OUTSIDE within OUTLINE_LOOK of it (in its dab's plane, within the slab)
    # is dropped. Across a crease the dabs of the two faces do not overlap in
    # each other's planes, so a crease dab's far arc was uncovered and read
    # as an outline, and the lip's roll ran as a dark streak along every
    # crease inside the moss (Tris, 2026-10-10); a sample facing a gap the
    # mesh filled has no outside texel either.
    look = max(2.0 * texel + OUTLINE_STEP, OUTLINE_LOOK)
    at = 0
    for d, q in samples:
        sel, pts, _h = slab(d, look)
        if len(sel):
            cc, ax, ay = np.asarray(d.c), np.asarray(d.ax), np.asarray(d.ay)
            rel = pts - cc
            txy = np.stack([rel @ ax, rel @ ay], 1)
            rq = q - cc
            sxy = np.stack([rq @ ax, rq @ ay], 1)
            near = ((sxy[:, None, :] - txy[None, :, :]) ** 2).sum(-1) < look * look
            keep[at : at + len(q)] &= (near & ~inside[sel][None, :]).any(1)
        else:
            keep[at : at + len(q)] = False
        at += len(q)
    at = 0
    kept = []
    for d, q in samples:
        k = keep[at : at + len(q)]
        at += len(q)
        if k.any():
            kept.append((d, q[k]))
    if DEBUG:
        print("[moss.debug] outline: %d samples, %d dropped (surrounded, or no outside texel near), %d dabs on it" % (len(keep), int((~keep).sum()), len(kept)))
    dist = np.full(len(tp), np.inf)
    for d, q in kept:
        sel, pts, h = slab(d, SDF_RANGE)
        if len(sel) == 0:
            continue
        # the texels (T, 3) against its samples (S, 3): in the dab's plane
        # where the texel's sheet faces as the dab does (the foot's height
        # over the plane is a chord's sag, not distance), in the world
        # otherwise (across a crease the height is distance)
        dn = np.asarray(d.n)
        flat = (tn[sel] @ dn) > COPLANAR
        pts = pts - np.outer(np.where(flat, h, 0.0), dn)
        step = max(1, int(3_000_000 // max(len(q), 1)))
        for a in range(0, len(pts), step):
            dd = np.sqrt(((pts[a : a + step, None, :] - q[None, :, :]) ** 2).sum(-1)).min(1)
            np.minimum.at(dist, sel[a : a + step], dd)
    dist = np.minimum(dist, SDF_RANGE)
    return np.where(inside, dist, -dist)


def paint_texels(layers, p, tp, tn, hash_=None):
    """Every dab evaluated at texels at world points `tp` facing `tn` (unit),
    lower layers first: (linear colour, coverage) per texel, the colour `dark`
    where no dab reaches. The mound's print and, on export, a texture-only
    moss's rock colour map (scene_export.py) both paint through this."""
    col = np.tile(np.array(p.dark, dtype=np.float64), (len(tp), 1))
    cov = np.zeros(len(tp))
    if len(tp) == 0:
        return col, cov
    hash_ = hash_ or _TexelHash(tp, p)
    uk, start, count, order = hash_.uk, hash_.start, hash_.count, hash_.order
    room = MOUND_LIFT_ROOM
    tp_sq = hash_.tp_sq

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
        pos = hash_.buckets(mid, reach)
        pos = pos[open_buckets[pos]]  # ... and still hold an open one
        if len(pos) == 0:
            return None
        sel = hash_.texels(pos)
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
