"""Ivy geometry: a painted mask on a host mesh becomes a carpet of flat ivy
leaves that has grown out from one origin point, every leaf pointing away
from it and lying over the leaf beyond it, and vines of the same leaves hang
from anchors placed on the host by hand. The look is the painted-foliage one
(Genshin, Breath of the Wild, The Witness): every leaf is one flat colour,
shaded by a smooth "hull" normal borrowed from the rock, so the carpet reads
as one soft mass of distinct colour blocks. See rope/docs/blender-ivy.md for
the history of the choices.

Everything here is a pure function of (host mesh, host matrix, stamps, vines,
origin, params) - no bpy state is read or written - so the add-on's live
rebuild and the scene exporter's rebuild produce the same mesh bit for bit.

THE PIPELINE (in world space, metres; the result is returned in the host's
local frame, because the ivy object is parented to the host with an identity
transform):

1. The host's evaluated triangles, welded.
2. The triangles near a stamp, refined by edge bisection to `resolution`.
3. The mask: the stamps composited in painting order, and a lobed threshold.
   The paint is the only thing that decides WHERE ivy grows.
4. The hull normal: the host's vertex normals smoothed over `rounding`, so a
   leaf on a facet shades with the rock's rounded volume, not the facet.
5. The underlay: the painted part of the host, clipped on the iso-line and
   lifted 2 cm, in the leaf colour. Where leaves thin out it is ivy, not rock.
6. The origin and the growth field: the origin (placed by hand, else the top
   of the paint) is snapped to the refined mesh and the distance from it along
   the mesh is found (Dijkstra over the refined edges, then smoothed). Its
   gradient is the growth direction: which way the runners went.
7. Candidates: points on the refined triangles inside the paint, thousands per
   square metre, with the paint field, the growth distance and their gradients.
8. Strata: `sheets` sheets of leaves, 3 cm apart, each laying a share of
   `leaf_fill` times the paint's area in leaves. A leaf is a card lying on
   the hull with its BASE at the candidate and its tip pointing down the growth
   field (away from the origin, strayed by up to `spread`), raised `thickness`
   at the origin and sloping down to the rock at the far end of the carpet,
   and pitched tip-up by `tilt`. Cards near one another share the growth
   direction and the pitch, so they are parallel planes offset along the
   growth: a leaf's tip lies OVER the base of the leaf beyond it and never cuts
   through it. At the paint's edge the leaves tilt outer-edge-down onto the
   rock (about the field's outward gradient), so the mass rolls into the stone
   instead of ending as a shelf. Finally every card is rotated the least that
   makes it face the game's camera (Blender -y) by `facing`, so the silhouette
   is made of leaf faces, never of edges.
9. Vines: one per anchor, a 3 mm stem hanging straight down from the anchor,
   held in front of the rock by a ray cast, with ivy leaves alternating sides
   and tapering toward the tip. Nothing places a vine but the artist.
10. Colour: a vertex colour the material multiplies into a white atlas. Three
   green tones patch across the rock by a slow noise, lit toward `light`
   where the hull faces up, darkened and cooled in the lower strata, then a
   small value jitter per leaf so neighbouring blocks differ.
11. Shadow: a second mesh, a decal lying 3 mm off the rock around the paint,
   `shadow_color` at `shadow_strength` under the carpet and fading out over
   `shadow_reach` from the paint's edge - further below it than beside it by
   `shadow_drop`, as a shadow from above falls. The leaves cast real shadows
   too (Blender: visible_shadow; the game: render3d/ivyShadow.ts), but the
   game's sun biases hide a shadow within a few centimetres of the stone, and
   the decal is that near shade. Its alpha is the vertex colour's, so it is
   one blended material with no texture.

The atlas (mesh_io.atlas) is a 4 x 4 sheet of silhouettes: fifteen ivy leaves,
three- and five-lobed, each drawn a little differently, base at the bottom of
the card and tip at the top, and one faceted round the underlay and the stems
point at, so the whole ivy is one material and one draw.
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

from .stampbrush.geometry import clip as _clip
from .stampbrush.geometry import compact as _compact
from .stampbrush.geometry import drop_islands as _drop_islands
from .stampbrush.geometry import edges as _edges
from .stampbrush.geometry import geodesic as _geodesic
from .stampbrush.geometry import host_world, stamps_world
from .stampbrush.geometry import mask as _mask
from .stampbrush.geometry import normalize as _normalize
from .stampbrush.geometry import refine as _refine
from .stampbrush.geometry import smooth_field as _smooth_field
from .stampbrush.geometry import smoothstep as _smoothstep
from .stampbrush.geometry import vertex_normals as _vertex_normals
from .stampbrush.stamps import Stamps

# Toward the game's camera. The game looks along glTF -z, which is Blender -y.
FACE = np.array((0.0, -1.0, 0.0))
UP = np.array((0.0, 0.0, 1.0))

ATLAS_CELLS = 4
LEAF_CELLS = tuple(range(15))  # ivy leaves, base at the bottom of the card and tip at the top
FILL_CELL = 15  # a faceted round: alpha 1 at its centre, where the underlay and the stems sample
# Where a leaf sits in its card, as fractions of the card's height from the
# bottom: its base (the stalk) and its tip. mesh_io draws the leaves to this.
LEAF_BASE = 0.09
LEAF_TIP = 0.91
LEAF_SPAN = LEAF_TIP - LEAF_BASE  # a card is leaf length / LEAF_SPAN tall
# A card's UV quad covers only the inner part of its cell, and the shape is
# drawn inside that: the outer ATLAS_INSET of every cell is transparent on
# both sides of every cell border, so bilinear filtering and the first mip
# levels never blend a neighbouring cell's alpha into a card's edge. Cells
# packed edge to edge drew a faint outline of every card square.
ATLAS_INSET = 0.12
STRATUM_GAP = 0.03  # between the sheets of leaves: room for one to shadow the next past the game's shadow biases (render3d/ivyShadow.ts)
LEAF_CLEAR = 0.004  # the lowest sheet's height over the underlay
EDGE_TILT = math.radians(45)  # how far a leaf at the paint's very edge tilts outer-edge-down onto the rock


@dataclass
class Params:
    """Every knob of an ivy object. Lengths are metres, angles degrees, colours linear RGB."""

    seed: int = 0
    resolution: float = 0.04
    # Outline
    threshold: float = 0.35
    edge_noise: float = 0.15
    edge_scale: float = 0.18
    min_patch: float = 0.01  # m^2; islands smaller than this are dropped
    rounding: float = 0.12  # how far the host's creases are rounded in the hull normal
    # Carpet
    thickness: float = 0.04  # how high the leaves stand over the underlay at the origin; they slope to the rock at the far end
    # `sheets` and `leaf_fill` are new names (2026-09-30): the blob carpet's
    # `layers` (8, 8 mm apart) and `fill` (per layer) live on in old files, and
    # read by the ivy they made 8 sheets 3 cm apart with a thin fill - leaves
    # floating in the air. A renamed property leaves those values behind.
    sheets: int = 3  # sheets of leaves
    leaf_min: float = 0.07  # leaf length
    leaf_max: float = 0.12
    leaf_fill: float = 3.5  # leaf area laid over the paint, as a multiple of the paint's area, shared by the sheets
    edge_fill: float = 2.5  # extra fill toward the paint's edge, where the underlay would otherwise show
    density: float = 6000.0  # candidate points per m^2 of paint
    facing: float = 0.5  # every leaf faces the camera by at least acos(facing)
    shoulder: float = 0.5  # the outer share of the paint (in mask units) that rolls into the rock
    underlay: float = 0.02
    tilt: float = 8.0  # degrees a leaf pitches tip-up off the hull
    spread: float = 25.0  # degrees a leaf may stray from the growth direction
    taper: float = 0.3  # how much smaller the leaves at the far end of the carpet are
    # Vines (each one is placed by hand; these are the leaves it wears)
    vine_length: float = 0.55  # the length a newly placed vine is given
    leaf_size: float = 0.15  # leaf length at the top of a vine
    leaf_tip: float = 0.045  # ... and at its tip
    # Colour (linear RGB). Since 2026-09-30 about a third of the study's tones
    # in green and a fifth in red and blue: under the river's sun and fill the
    # old leaf (0.78 green) lit and shaded alike clipped to near-white after
    # tone mapping, and the leaves' shadows vanished with the contrast; a
    # sixth all round was "too dark", so the green came back up further than
    # the rest ("a bit more vibrant"). Real foliage sits at 0.1-0.3.
    tone_a: tuple = (0.151, 0.240, 0.010)  # yellow-green
    tone_b: tuple = (0.059, 0.184, 0.010)  # leaf green
    tone_c: tuple = (0.029, 0.147, 0.033)  # blue-green
    light: tuple = (0.196, 0.257, 0.017)  # the sunward crown
    shade: tuple = (0.025, 0.110, 0.040)  # what the deep layers cool toward
    tone_scale: float = 0.22
    variation: float = 0.16
    depth_shade: float = 0.0  # off since 2026-09-30: darkness comes from the shadows, not the sheet (the owner)
    # Shadow (the decal on the rock under and around the carpet)
    shadow_strength: float = 0.7  # opacity under the carpet; 0 grows no shadow
    shadow_reach: float = 0.25  # how far beside the paint's edge it fades out
    shadow_drop: float = 1.5  # how much further it reaches below the paint than beside it
    shadow_color: tuple = (0.012, 0.03, 0.06)  # linear RGB, a cool dark


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
    leaves: int = 0  # in the carpet
    vines: int = 0
    vine_leaves: int = 0
    shadow: "Shadow | None" = None


@dataclass
class Shadow:
    """The shadow decal, a mesh of its own: host-local vertices, triangles,
    the colour with the shadow's opacity in its alpha, and the rock's normals."""

    vertices: np.ndarray  # (V, 3)
    triangles: np.ndarray  # (T, 3)
    colors: np.ndarray  # (V, 4)
    normals: np.ndarray  # (V, 3)


def _empty_result():
    return Result(np.zeros((0, 3)), np.zeros((0, 3), np.int64), np.zeros((0, 4)), np.zeros((0, 3, 2)), np.zeros((0, 3)))

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
# 1-4. Host, refinement, mask and clipping: stampbrush.geometry (shared with
# the moss add-on), imported above under the names this file always used.


def _rotate(vec, axis, angle):
    """`vec` turned by `angle` about the unit `axis` (Rodrigues)."""
    c, s = math.cos(angle), math.sin(angle)
    return vec * c + np.cross(axis, vec) * s + axis * (axis @ vec) * (1.0 - c)


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
# 6. Cards


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


def _corners(centre, x, y, w, h):
    """A w x h card about `centre` with in-plane axes x (across) and y (base to
    tip); the winding gives the front face toward x cross y (the material
    culls the back). The corners match _uv_cell's: -y is the card's bottom."""
    return np.array([centre - x * w / 2 - y * h / 2, centre + x * w / 2 - y * h / 2, centre + x * w / 2 + y * h / 2, centre - x * w / 2 + y * h / 2])


def _quad(centre, normal, w, h, spin):
    """A w x h quad whose face normal is `normal`, spun by `spin` about it."""
    n = normal / np.linalg.norm(normal)
    t = np.cross(n, UP)
    if np.linalg.norm(t) < 1e-4:
        t = np.cross(n, np.array((1.0, 0.0, 0.0)))
    t /= np.linalg.norm(t)
    b = np.cross(n, t)
    ca, sa = math.cos(spin), math.sin(spin)
    x = t * ca + b * sa
    y = -t * sa + b * ca
    return _corners(centre, x, y, w, h)


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


def _facing_turn(n, facing):
    """The least rotation (axis, angle) that makes `n` face the camera by
    `facing`, or None when it already does: a card seen nearly edge-on is a
    spike, not a leaf. Smooth, so neighbours agree."""
    d = float(n @ FACE)
    if d >= facing:
        return None
    axis = np.cross(n, FACE)
    L = np.linalg.norm(axis)
    if L < 1e-6:
        return None
    return axis / L, math.acos(max(-1.0, min(1.0, d))) - math.acos(facing)


def _faced(n, facing):
    """`n` rotated the least that makes it face the camera by `facing`."""
    turn = _facing_turn(n, facing)
    return n if turn is None else _rotate(n, *turn)


# --------------------------------------------------------------------------
# 7. Sampling the paint


def _sample(v, t, fields, hn, nr, density, rng):
    """Candidate points on the refined triangles inside the paint (fields[0]
    > 0), in proportion to area, with every field, the hull normal and the
    raw normal interpolated. Returns P, HN, NR, [field values], [field
    in-plane gradients per point]."""
    A = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    cross = np.cross(A[1] - A[0], A[2] - A[0])
    area = np.linalg.norm(cross, axis=1) * 0.5
    fc = fields[0][t].max(1)
    expect = np.where(fc > -0.05, area * density, 0.0)
    count = np.floor(expect).astype(int) + (rng.random(len(t)) < (expect % 1.0))
    if count.sum() == 0:
        z = np.zeros((0, 3))
        return z, z, z, [np.zeros(0) for _ in fields], [z for _ in fields]
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
    vals = [interp(f) for f in fields]
    # Each field's gradient on each triangle (planar).
    e1, e2 = A[1] - A[0], A[2] - A[0]
    n = cross / np.maximum(np.linalg.norm(cross, axis=1, keepdims=True), 1e-12)
    grads = []
    for f in fields:
        f1, f2 = f[t[:, 1]] - f[t[:, 0]], f[t[:, 2]] - f[t[:, 0]]
        g = (np.cross(n, e1) * f2[:, None] - np.cross(n, e2) * f1[:, None]) / np.maximum(2 * area, 1e-12)[:, None]
        grads.append(g[tri_idx])
    keep = vals[0] > 0
    return P[keep], _normalize(interp(hn))[keep], _normalize(interp(nr))[keep], [x[keep] for x in vals], [g[keep] for g in grads]


def _crowd(P, r):
    """How many candidates lie within r of each: a leaf with no neighbours would float alone."""
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


def build(host_mesh, host_matrix, stamps, vines, origin, p):
    """The ivy for one host: the carpet its paint covers, grown out from
    `origin` (a host-local point, or None for the top of the paint), and a
    vine at every anchor. `host_mesh` is the host's evaluated mesh."""
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
    n_leaves = 0
    v = np.zeros((0, 3))
    hull = np.zeros((0, 3))

    shadow = None
    if painted:
        centres, snormals = stamps_world(stamps, host_matrix)
        radii = stamps.radius.astype(np.float64)
        res = max(p.resolution, 0.005)
        # The shadow decal reaches past the paint, further below it: refine a
        # margin around the stamps coarsely first, then the paint itself.
        margin = p.shadow_reach * (1.0 + p.shadow_drop) if p.shadow_strength > 0 else 0.0
        if margin > 0:
            v, t = _refine(co, tri, centres, radii + margin, max(res * 2.5, margin / 4))
            v, t = _refine(v, t, centres, radii, res, keep_all=True)
        else:
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
            # always grows the same ivy.
            order = np.lexsort((v[t].mean(1)[:, 2], v[t].mean(1)[:, 1], v[t].mean(1)[:, 0]))
            t = t[order]
            under = _underlay(v, t, f, hull, p)
            M = np.array(host_matrix, dtype=np.float64)
            origin_w = None if origin is None else np.asarray(origin, dtype=np.float64) @ M[:3, :3].T + M[:3, 3]
            n_leaves = _carpet(quads, v, t, edges, f, hull, n_raw, origin_w, p, rnd, rng)
            if margin > 0:
                shadow = _shadow(v, t, edges, f, n_raw, host_matrix, p)

    n_vines, n_vine_leaves = _vines(quads, co, tri, v, hull, vines, host_matrix, p, rnd)
    r = _assemble(quads, under, host_matrix)
    r.leaves, r.vines, r.vine_leaves, r.shadow = n_leaves, n_vines, n_vine_leaves, shadow
    return r


def _shadow(v, t, edges, f, n_raw, host_matrix, p):
    """The shadow decal: the part of the refined rock within `shadow_reach`
    of the paint (further below it by `shadow_drop`), lifted 3 mm off the
    rock's own surface, in `shadow_color` with an alpha of `shadow_strength`
    under the paint fading to nothing at the reach. None when there is none."""
    inside = np.flatnonzero(f > 0)
    if len(inside) == 0:
        return None
    d = _geodesic(v, edges, inside, drop=p.shadow_drop)
    reach = max(p.shadow_reach, 1e-3)
    sv, st, (sd, sn) = _clip(v, t, reach - d, [d, n_raw])
    st = _drop_islands(sv, st, p.min_patch)
    if len(st) == 0:
        return None
    sv, st, (sd, sn) = _compact(sv, st, [sd, sn])
    sn = _normalize(sn)
    alpha = p.shadow_strength * (1.0 - np.clip(sd / reach, 0.0, 1.0)) ** 2
    col = np.concatenate([np.repeat(np.asarray(p.shadow_color)[None], len(sv), 0), alpha[:, None]], 1)
    M = np.array(host_matrix, dtype=np.float64)
    R = M[:3, :3]
    return Shadow((sv + sn * 0.003 - M[:3, 3]) @ np.linalg.inv(R).T, st.astype(np.int64), col, _normalize(sn @ R))


def _underlay(v, t, f, hull, p):
    """The underlay: the paint's own outline, a little INSIDE where the leaves
    start, lifted `underlay` and coloured as a leaf. None when nothing is left.
    Inside, so the carpet's silhouette is leaves and never the underlay's
    smooth edge; the leaves at the edge roll down to the rock outside it."""
    uv_, ut, (uh, uf) = _clip(v, t, f - 0.015, [hull, f])
    ut = _drop_islands(uv_, ut, p.min_patch)
    if len(ut) == 0:
        return None
    uv_, ut, (uh, uf) = _compact(uv_, ut, [uh, uf])
    uh = _normalize(uh)
    lift = p.underlay * _underlay_ramp(uf)
    col = _tint(uh, np.full(len(uv_), 0.15), np.zeros(len(uv_)), _tone_at(uv_, (p.tone_a, p.tone_b, p.tone_c), p.tone_scale, p.seed), p)
    return uv_ + uh * lift[:, None], ut, uh, col


def _underlay_ramp(f):
    """How much of `underlay` the skin is lifted at paint field f: down to the
    rock at the paint's edge."""
    return _smoothstep(0.0, 0.15, f + 0.02)


def _carpet(quads, v, t, edges, f, hull, n_raw, origin, p, rnd, rng):
    """The sheets of leaves over the paint, grown out from the origin. Returns
    how many were laid."""
    inside = np.flatnonzero(f > 0)
    if len(inside) == 0:
        return 0
    # The origin, on the refined mesh: the placed point's nearest vertex, else
    # the top of the paint (ivy that came over the crown of the rock).
    if origin is not None:
        src = int(np.argmin(np.linalg.norm(v - origin, axis=1)))
    else:
        src = int(inside[np.argmax(v[inside, 2])])
    growth = _smooth_field(_geodesic(v, edges, src), edges, len(v), 4)
    P, HN, NR, (F, D), (GF, GD) = _sample(v, t, [f, growth], hull, n_raw, p.density, rng)
    if len(P) == 0:
        return 0
    order = np.lexsort((P[:, 2], P[:, 1], P[:, 0]))
    P, HN, NR, F, D, GF, GD = P[order], HN[order], NR[order], F[order], D[order], GF[order], GD[order]
    area = len(P) / p.density  # the painted area, from the sampling density
    Mn = np.clip(F / 0.5, 0, 1)  # 0 at the paint's edge, 1 well inside
    tones = _tone_at(P, (p.tone_a, p.tone_b, p.tone_c), p.tone_scale, p.seed)
    crowd = _crowd(P, 0.06)
    seen = (HN @ FACE >= -0.35) & (crowd >= 4)  # the game never sees the back of a rock
    idx = np.flatnonzero(seen).tolist()
    if not idx:
        return 0

    def tangent(G):
        """A field's gradient in the hull's tangent plane, unit, and its length."""
        Gt = G - HN * (G * HN).sum(1, keepdims=True)
        Gl = np.linalg.norm(Gt, axis=1)
        return Gt / np.maximum(Gl, 1e-12)[:, None], Gl

    # The outward direction of the paint: down the field's gradient.
    OUTd, OUTl = tangent(GF)
    OUT = np.where((OUTl > 0.2)[:, None], -OUTd, 0.0)
    # The growth direction: up the distance field, away from the origin. Where
    # it is degenerate (at the origin, or a flat spot of the smoothed field)
    # the leaf takes a random direction: a rosette at the origin.
    GROW, GROWl = tangent(GD)
    grown = GROWl > 0.3
    # How far along the carpet each candidate is, 0 at the origin, 1 at the far end.
    lo, hi = float(D[idx].min()), float(D[idx].max())
    T = np.clip((D - lo) / max(hi - lo, 1e-6), 0.0, 1.0)
    # Toward the edge a candidate is taken this much more readily: the outer
    # band is where the leaves thin out, and a gap there shows the underlay
    # as a rim around the mass.
    edge_w = 1.0 + p.edge_fill * (1.0 - Mn) ** 2
    band = max(p.shoulder, 1e-3)
    ramp = _smoothstep(0.0, band, Mn)  # 0 at the paint's edge, 1 inside the shoulder band
    # The height of a leaf's base over the rock: the underlay, a clearance,
    # the sheet's own step and the mound that slopes from `thickness` at the
    # origin to nothing at the far end. Near the paint's edge the mound
    # drops away too, so the origin at an edge is a rise, not a shelf.
    base_h = p.underlay * _underlay_ramp(F) + LEAF_CLEAR + p.thickness * (1.0 - T) * (0.25 + 0.75 * ramp)
    # A leaf pitches tip-up off the hull, less toward the edge, where it lies
    # down on the rock; at the very edge it tilts outer-edge-down instead.
    pitch = math.radians(p.tilt) * (0.3 + 0.7 * ramp)
    edge_tilt = EDGE_TILT * (1.0 - ramp) ** 1.5
    spread = math.radians(p.spread)

    K = max(int(p.sheets), 1)
    n_leaves = 0
    for k in range(K):
        rnd.shuffle(idx)
        mean_len = (p.leaf_min + p.leaf_max) / 2 * (1.0 - p.taper * 0.5)
        want = p.leaf_fill / K * area / (0.6 * mean_len * mean_len)  # a leaf covers about 0.6 of its card
        p_take = min(1.0, want / len(idx))
        depth_k = (1.0 - k / max(K - 1, 1)) * 0.7
        for i in idx:
            if rnd.random() > p_take * edge_w[i]:
                continue
            hn = HN[i]
            if grown[i]:
                u = GROW[i]
                stray = rnd.uniform(-spread, spread)
            else:
                u = OUTd[i] if OUTl[i] > 0.2 else np.cross(hn, UP if abs(hn[2]) < 0.9 else np.array((1.0, 0.0, 0.0)))
                u = u / np.linalg.norm(u)
                stray = rnd.uniform(0, math.tau)
            u = _rotate(u, hn, stray)
            n = hn
            # The edge tilt: the whole frame turned about the axis across the
            # outward direction, so the outer part of the leaf goes down.
            if edge_tilt[i] > 1e-4 and OUT[i].any():
                axis = np.cross(hn, OUT[i])
                axis /= np.linalg.norm(axis)
                u, n = _rotate(u, axis, edge_tilt[i]), _rotate(n, axis, edge_tilt[i])
            side = np.cross(u, n)
            # The pitch: tip up about the leaf's own side axis.
            u, n = _rotate(u, side, pitch[i]), _rotate(n, side, pitch[i])
            length = rnd.uniform(p.leaf_min, p.leaf_max) * (1.0 - p.taper * T[i]) * (0.75 + 0.25 * Mn[i])
            card_h = length / LEAF_SPAN
            card_w = card_h * rnd.uniform(0.92, 1.06)
            base = P[i] + hn * (base_h[i] + k * STRATUM_GAP + rnd.uniform(-0.001, 0.001))
            centre = base + u * (0.5 - LEAF_BASE) * card_h
            turn = _facing_turn(n, p.facing)
            if turn is not None:
                side, u, n = _rotate(side, *turn), _rotate(u, *turn), _rotate(n, *turn)
            col = _tint(hn, np.array(depth_k * Mn[i]), np.array(rnd.uniform(-p.variation, p.variation)), tones[i], p)
            quads.add(_corners(centre, side, u, card_w, card_h), hn, col, _uv_cell(rnd.choice(LEAF_CELLS)))
            n_leaves += 1
    return n_leaves


def _vines(quads, co, tri, v, hull, vines, host_matrix, p, rnd):
    """A vine at every anchor: a stem hanging straight down, held in front of
    the rock, wearing ivy leaves that alternate sides and taper toward the
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
