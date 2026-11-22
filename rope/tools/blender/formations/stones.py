"""The Stones variant of a solid formation: recipe F's rock-b, on a 3D guide.

Recipe F (docs/cave-look.md, "Geometry, recipe F"; cave-sheet-study/
rock_study.py, picked by Tris on 2026-10-01) builds a rock as a few whole
stones, one box each, every stone worked on its own:

1. corner cuts - 14 planes knock the corners off, the base kept flat;
2. pillow - an 8 percent bevel, a 2.5 cm voxel remesh, 4 smoothing passes;
3. chisel - 80 shallow planes per metre of the stone's long half sliced
   right through it, the tops mostly spared, softened by a 2 cm remesh and
   2 smoothing passes;
4. relief - a 5 cm noise at scale 1.5 and 4 mm of grit along the normals;
5. facets - collapse to 1200 triangles per 0.8 m of long half, planar
   dissolve at 9 degrees, flat shading.

The study placed rock-b's five boxes by hand (`LAYOUT`). Here the stones are
packed into the guide: over a grid of the guide's inside, the deepest part no
stone covers yet gets a stone about that size in rock-b's proportions, built
first, then tried at a few spots and turns about the vertical, each pose
dropped onto the guide's floor or the stones below; the pose that covers the
most uncovered inside, less what spills past the guide and what other stones
already cover, is kept. The fit tests the finished stone's convex hull, not
its box: recipe F takes so much off a box that fitted boxes left the stones
hovering apart. Big stones go in first because the deepest gap is biggest
first; smaller ones fill what is left (`fit`, the 3D form of fitted.fit).
Stones only turn about the vertical, so every base stays flat as rock-b's do.

Unlike the fitted generator, the stones are NOT fused: each is its own
closed shell, so the seams between them stay fissures and every stone keeps
its own silhouette, which is what makes rock-b read as stones. A fissure
fill (`fissure_fill`) backs the narrow gaps between them, recessed into the
seams' shadow, so a wall of stones never shows the background through one.

Every length (the stones' sizes, the remeshes, the chisel, the relief, the
fill) is times Stone size; at 1 the stones are rock-b's and the treatment is
the study's to the number. The surface is the shared grey-blue painted slate
(slate.py), as every formation's: the warmth of the study's renders was its
v6 key light, not the stone.

Rock-local frame, as every solid formation: asset-local metres, Z up. `fit`
needs only numpy and the guide's inside on a grid; `build` runs in the
worker's headless Blender (assemble.py).
"""

import math
import random

import numpy as np

from . import fitted

# Sizes at Stone size 1, metres: rock-b's stones (rock_study.LAYOUT) run from
# a 0.86 m long half (the column) down to 0.22 m (the foot), a 0.16 m pebble
# beside them.
LARGEST = 0.9             # a stone's largest long half
SMALLEST = 0.2            # ...and its smallest
CELL = 0.07               # the fit's grid cell
MAX_CELLS = 4_000_000     # a larger guide gets coarser cells
# A stone's shape, from rock-b's five: its other horizontal half against its
# long one (0.68 to 1.0 there) and its vertical half against its long one
# (0.48 for the front stone to 1.43 for the column).
WIDE = (0.65, 1.0)
TALL = (0.45, 1.45)
FIT = (1.1, 1.5)          # a stone's long half against the gap's depth
SHALLOWEST = 0.35         # a gap shallower than this (m) gets no stone: the thin
                          # wedges at a guide's rim filled with pebbles read as rubble
TURNS = 8                 # turns about the vertical tried, over half a turn
SPOTS = 4                 # spots tried: the deepest gap and others nearly as deep
NUDGE = 0.25              # a spot moves up to this (in the stone's smallest half)
SPILL = 1.0               # a cell past the guide costs this many new ones: the
                          # stones, not the guide, are the silhouette
OVERLAP = 0.1             # a cell another stone already covers costs this much:
                          # rock-b's stones run into each other, so little
ACCEPT = 0.25             # a pose must cover this share of its cells with new inside
DONE = 0.05               # the share of the inside that may stay uncovered
MISSES = 8                # rejected stones in a row that end the fit
MAX_STONES = 2000
HULL_ANGLE = 4.0          # degrees: a stone's hull faces this near coplanar are one
                          # plane to the fit
# The fissure fill (`fissure_fill`), metres at Stone size 1: gaps between
# stones up to about twice FILL_REACH across are backed, FILL_RECESS behind
# the stones' faces.
FILL_REACH, FILL_RECESS = 0.21, 0.14
# Recipe F at Stone size 1 (the study's flags: --corners 14 --bevel 0.08
# --round 4 --cuts 80 --cut-depth 0.025 --cut-tilt 0.15 --big 0.05
# --big-scale 1.5 --grit 0.004 --target 1200 --angle 9).
CUTS_PER_M = 80           # chisel planes per metre of a stone's long half
CUT_DEPTH, CUT_TILT, CUT_SPARE = 0.025, 0.15, 0.6
FACETS_PER_M, ANGLE = 1200 / 0.8, 9.0


# ---------------------------------------------------------------- the fit

def _erode(mask):
    """One step of erosion by the six face neighbours; outside the grid is
    empty."""
    out = mask.copy()
    for axis in range(3):
        lo = [slice(None)] * 3
        hi = [slice(None)] * 3
        lo[axis], hi[axis] = slice(1, None), slice(None, -1)
        out[tuple(lo)] &= mask[tuple(hi)]
        out[tuple(hi)] &= mask[tuple(lo)]
        edge = [slice(None)] * 3
        edge[axis] = 0
        out[tuple(edge)] = False
        edge[axis] = -1
        out[tuple(edge)] = False
    return out


def _dilate(mask):
    """One step of dilation by the six face neighbours."""
    return ~_erode(~mask)


def fissure_fill(grid, reach, recess):
    """The backing for the fissures: the stones' cells closed by `reach` cells
    (dilated, then eroded as far), which fills every gap between stones
    narrower than about twice that and grows no outer face, kept inside the
    guide, then eroded `recess` cells so it lies back from every face a stone
    shows, in the fissure's shadow (Tris's reference: rock-b's seams read as
    dark cracks). Without it a wall of stones showed the background through a
    few of its seams (2026-11-23: 3.8 % of its front silhouette)."""
    closed = grid.covered
    for _ in range(reach):
        closed = _dilate(closed)
    for _ in range(reach):
        closed = _erode(closed)
    fill = closed & grid.inside
    for _ in range(recess):
        fill = _erode(fill)
    return fill


class Grid:
    """The guide's inside, in cells, and what the stones cover of it.
    `inside` is (nx, ny, nz); `lo` the corner of cell (0, 0, 0)."""

    def __init__(self, inside, lo, cell):
        self.inside = inside
        self.lo = np.asarray(lo, float)
        self.cell = cell
        self.covered = np.zeros_like(inside)
        self.axes = [self.lo[i] + (np.arange(inside.shape[i]) + 0.5) * cell for i in range(3)]

    def gaps(self, free):
        """How deep each free cell lies in its gap, in cells: one at a gap's
        edge (beside a covered cell or outside the guide), more inward."""
        cur = free.copy()
        depth = np.zeros(cur.shape, np.int32)
        while cur.any():
            depth += cur
            cur = _erode(cur)
        return depth

    def cells(self, centre, shape, yaw):
        """The cells inside a stone (`Shape`) turned `yaw` about Z and moved
        to `centre`: the window of the grid it spans and the mask within it,
        or None."""
        span = [(centre[0] - shape.reach, centre[0] + shape.reach), (centre[1] - shape.reach, centre[1] + shape.reach),
                (centre[2] + shape.zlo, centre[2] + shape.zhi)]
        win = []
        for axis, (a, b) in enumerate(span):
            i0 = max(0, int((a - self.lo[axis]) / self.cell))
            i1 = min(self.inside.shape[axis], int((b - self.lo[axis]) / self.cell) + 1)
            if i1 <= i0:
                return None
            win.append(slice(i0, i1))
        dx = (self.axes[0][win[0]] - centre[0])[:, None, None]
        dy = (self.axes[1][win[1]] - centre[1])[None, :, None]
        dz = (self.axes[2][win[2]] - centre[2])[None, None, :]
        c, s = math.cos(yaw), math.sin(yaw)
        u, v = dx * c + dy * s, -dx * s + dy * c
        mask = np.ones(np.broadcast_shapes(u.shape, dz.shape), bool)
        for n, d in zip(shape.normals, shape.offsets):
            mask &= u * n[0] + v * n[1] + dz * n[2] <= d
        return tuple(win), mask

    def floor(self, i, j, k):
        """The height a stone in column (i, j) above cell k comes to rest on:
        the bottom of the free run of cells it stands in (the guide's floor or
        a stone already placed)."""
        free = self.inside[i, j, :k + 1] & ~self.covered[i, j, :k + 1]
        blocked = np.flatnonzero(~free)
        return self.lo[2] + (blocked[-1] + 1 if len(blocked) else 0) * self.cell

    def score(self, centre, shape, yaw):
        w = self.cells(centre, shape, yaw)
        if w is None:
            return None
        win, mask = w
        inside, covered = self.inside[win], self.covered[win]
        new = np.count_nonzero(mask & inside & ~covered)
        spill = np.count_nonzero(mask & ~inside)
        again = np.count_nonzero(mask & covered)
        return new - SPILL * spill - OVERLAP * again, new, np.count_nonzero(mask), w


class Shape:
    """A finished stone as the fit sees it: its convex hull, centred on its
    own origin, as outward plane normals and offsets (n . p <= d inside), its
    reach about the vertical through its origin and its lowest and highest z."""

    def __init__(self, points, normals, offsets):
        points = np.asarray(points, float)
        self.normals = np.asarray(normals, float)
        self.offsets = np.asarray(offsets, float)
        self.reach = float(np.hypot(points[:, 0], points[:, 1]).max())
        self.zlo, self.zhi = float(points[:, 2].min()), float(points[:, 2].max())


def fit(grid, size, seed, make_stone, discard=lambda stone: None):
    """Place stones in the guide, as fitted.fit places rocks over an outline:
    `make_stone(half (x, y, z), seed)` builds a finished stone centred on the
    origin and returns (stone, its `Shape`); `discard(stone)` drops one that
    fitted nowhere. Returns [(stone, yaw, centre), ...], biggest first: each
    stone turned `yaw` about Z, then moved to `centre`; and a report."""
    rng = random.Random(seed)
    smallest, largest = SMALLEST * size, LARGEST * size
    total = np.count_nonzero(grid.inside)
    blocked = np.zeros_like(grid.inside)
    placed, misses, tried = [], 0, 0
    while len(placed) < MAX_STONES and misses < MISSES:
        free = grid.inside & ~grid.covered
        if np.count_nonzero(free) <= DONE * total:
            break
        gaps = np.where(blocked, 0, grid.gaps(free))
        deepest = int(gaps.max())
        # A gap's depth is the half-thickness of the free space there.
        if deepest * grid.cell < max(smallest, SHALLOWEST * size):
            break
        long = min(max(deepest * grid.cell * rng.uniform(*FIT), smallest), largest)
        wide, tall = long * rng.uniform(*WIDE), long * rng.uniform(*TALL)
        half = (long, wide, tall) if rng.random() < 0.5 else (wide, long, tall)
        stone, shape = make_stone(half, rng.randrange(1 << 30))
        tried += 1
        deep = np.argwhere(gaps >= max(1, int(0.7 * deepest)))
        spots = [np.unravel_index(int(np.argmax(gaps)), gaps.shape)]
        spots += [tuple(deep[rng.randrange(len(deep))]) for _ in range(SPOTS - 1)]
        best = None
        for spot in spots:
            for k in range(TURNS):
                yaw = (k + rng.random()) * math.pi / TURNS
                nudge = NUDGE * min(half)
                at = [grid.axes[a][spot[a]] + rng.uniform(-1, 1) * nudge for a in range(2)]
                # Dropped onto what is under it, as rock-b's stones all stand
                # on the ground or on each other.
                at.append(grid.floor(*spot) - shape.zlo)
                result = grid.score(at, shape, yaw)
                if result and (best is None or result[0] > best[0][0]):
                    best = (result, yaw, at)
        if best is None or best[0][0] <= 0 or best[0][1] < ACCEPT * best[0][2]:
            discard(stone)
            misses += 1
            r = max(1, deepest)
            spot = spots[0]
            blocked[tuple(slice(max(0, s - r), s + r + 1) for s in spot)] = True
            continue
        (_, _, _, (win, mask)), yaw, at = best
        grid.covered[win] |= mask
        blocked[:] = False
        misses = 0
        placed.append((stone, float(yaw), tuple(float(a) for a in at)))
    left = np.count_nonzero(grid.inside & ~grid.covered) / max(total, 1)
    return placed, {"stones": len(placed), "tried": tried, "cells": int(total), "cell": round(grid.cell, 4),
                    "uncovered": round(float(left), 3)}


# ---------------------------------------------------------------- Blender

def inside_grid(ob, size):
    """The guide's inside on a grid of CELL x `size` (coarser if the guide
    would need more than MAX_CELLS), by casting a ray up each column of cells
    and reading each hit's normal: an entry faces down the ray, an exit up it.
    The state is set by a hit, not toggled, so a ray restarted inside the
    triangle it just hit cannot count that triangle twice."""
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    co = np.array([v.co[:] for v in ob.data.vertices])
    lo, hi = co.min(0), co.max(0)
    extent = hi - lo
    cell = max(CELL * size, (float(np.prod(extent + 2 * CELL * size)) / MAX_CELLS) ** (1 / 3))
    # A margin of a cell all round, and centres a little off any round number
    # so no column runs exactly along a guide's edge or face.
    lo = lo - cell * (1 + 1 / math.pi)
    shape = tuple(int(math.ceil(e / cell)) + 3 for e in extent)
    grid = Grid(np.zeros(shape, bool), lo, cell)
    tree = BVHTree.FromPolygons([v.co for v in ob.data.vertices], [p.vertices for p in ob.data.polygons])
    up = Vector((0, 0, 1))
    eps = 1e-6 * max(float(extent.max()), 1.0)
    z0 = float(lo[2]) - cell
    zs = grid.axes[2]
    for i, x in enumerate(grid.axes[0]):
        for j, y in enumerate(grid.axes[1]):
            origin = Vector((float(x), float(y), z0))
            entered = None
            for _ in range(256):
                hit, normal, _, _ = tree.ray_cast(origin, up)
                if hit is None:
                    break
                if normal.z < 0:
                    entered = hit.z if entered is None else entered
                elif entered is not None:
                    grid.inside[i, j, (zs >= entered) & (zs < hit.z)] = True
                    entered = None
                origin = hit + up * eps
    return grid


def _plane_cuts(ob, half, seed, size):
    """The study's chisel (rock_study.plane_cuts at --cuts 80 --cut-depth
    0.025 --cut-tilt 0.15): CUTS_PER_M planes per metre of the long half (of
    the stone at Stone size 1), each through a point of the surface, a little
    under it and tilted off its normal, slicing off everything outside it -
    right through the stone, which is what gives rock-b its broad facets."""
    import bmesh
    from mathutils import Vector
    rng = random.Random(seed)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    count = int(CUTS_PER_M * max(half) / size)
    done = 0
    while done < count and len(bm.faces):
        f = rng.choice(bm.faces)
        n = f.normal.copy()
        if n.z > 0.85 and rng.random() < CUT_SPARE:
            continue  # spare most of the top, so it stays a shelf
        n = (n + fitted._unit_vector(rng, Vector) * rng.uniform(0.3, 1.0) * CUT_TILT).normalized()
        d = rng.uniform(CUT_DEPTH * 0.4, CUT_DEPTH) * size
        fitted._cut(bm, f.calc_center_median() - n * d, n)
        bm.normal_update()
        bm.faces.ensure_lookup_table()
        done += 1
    bm.to_mesh(ob.data)
    bm.free()


def build_stone(name, half, seed, size, collection):
    """One recipe F stone of half-size `half`, centred on the origin: rock-b's
    treatment with every length times `size`."""
    ob = fitted._box(name, (0, 0, 0), half, 0.0, collection)
    fitted._corner_cuts(ob, half, seed + 70)
    fitted._pillow(ob, voxel=0.025 * size, iters=fitted.ROUND, bevel=fitted.BEVEL * min(half))
    _plane_cuts(ob, half, seed + 50, size)
    fitted._pillow(ob, voxel=0.02 * size, iters=fitted.CUT_SOFT)
    fitted._relief(ob, seed + 60, size)
    fitted._facets(ob, FACETS_PER_M * max(half) / size, angle=ANGLE)
    return ob


def shape_of(ob):
    """The stone's `Shape`: its convex hull, near-coplanar hull faces merged
    so the fit tests a few dozen planes, not every facet."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    hull = bmesh.ops.convex_hull(bm, input=bm.verts[:], use_existing_faces=False)
    inner = set(hull["geom_interior"]) | set(hull["geom_unused"]) | set(hull["geom_holes"])
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v in inner or not v.link_faces], context="VERTS")
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(HULL_ANGLE), verts=bm.verts[:], edges=bm.edges[:])
    bm.normal_update()
    points = [v.co[:] for v in bm.verts]
    normals = [f.normal[:] for f in bm.faces]
    # Each plane through its face's farthest vertex, so the merged faces
    # bound the stone rather than cut into it.
    offsets = [max(f.normal.dot(v.co) for v in f.verts) for f in bm.faces]
    bm.free()
    return Shape(points, normals, offsets)


def build_fill(grid, mask, size, collection):
    """The fissure fill's cells as one mesh: the faces between them and the
    rest, voxel remeshed at half a cell and smoothed round, then faceted as a
    stone is; None if there is none."""
    import bpy
    if not mask.any():
        return None
    verts, faces = {}, []

    def vert(key):
        if key not in verts:
            verts[key] = len(verts)
        return verts[key]

    # Each face of a cell whose neighbour across it is empty, wound outward:
    # the corners of the face on the +axis side, counter-clockwise seen from
    # outside; the -axis side is the same square at 0, the other way round.
    plus = {0: [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)], 1: [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)],
            2: [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]}
    padded = np.pad(mask, 1)
    for axis in range(3):
        for sign in (1, -1):
            step = [0, 0, 0]
            step[axis] = sign
            beside = padded[tuple(slice(1 + s, padded.shape[a] - 1 + s) for a, s in enumerate(step))]
            corners = plus[axis] if sign > 0 else [
                tuple(c if a != axis else 0 for a, c in enumerate(q)) for q in reversed(plus[axis])]
            for i, j, k in np.argwhere(mask & ~beside):
                faces.append([vert((i + a, j + b, k + c)) for a, b, c in corners])
    co = np.zeros((len(verts), 3))
    for (i, j, k), n in verts.items():
        co[n] = grid.lo + np.array([i, j, k]) * grid.cell
    me = bpy.data.meshes.new("Fill")
    me.from_pydata(co.tolist(), [], faces)
    ob = bpy.data.objects.new("Fill", me)
    collection.objects.link(ob)
    fitted._pillow(ob, voxel=max(0.025 * size, grid.cell / 2), iters=8)
    if not ob.data.polygons:
        return None
    fitted._facets(ob, fitted.FACETS_PER_M2 * sum(p.area for p in ob.data.polygons) / size ** 2, angle=ANGLE)
    return ob


def build(solid, camera, parameters, collection):
    """The rock (unlinked from `collection`): the stones joined into one mesh
    of separate closed shells. Same signature and return as solidfit.build:
    (rock, parts, depth scale, report)."""
    import bmesh
    import bpy
    from mathutils import Matrix, Vector
    size = float(parameters["stoneSize"])
    seed = int(parameters["seed"])
    grid = inside_grid(solid, size)
    if not grid.inside.any():
        raise ValueError("the guide has no inside")
    count = [0]

    def make_stone(half, stone_seed):
        ob = build_stone(f"Stone {count[0]}", half, stone_seed, size, collection)
        count[0] += 1
        return ob, shape_of(ob)

    def discard(ob):
        data = ob.data
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(data)

    placed, report = fit(grid, size, seed, make_stone, discard)
    if not placed:
        raise ValueError("the guide is too thin for a stone of this Stone size")
    fill = build_fill(grid, fissure_fill(grid, max(1, round(FILL_REACH * size / grid.cell)),
                                         max(1, round(FILL_RECESS * size / grid.cell))), size, collection)
    report["fill"] = fill is not None
    bm = bmesh.new()
    for ob, yaw, at in placed:
        ob.data.transform(Matrix.Translation(Vector(at)) @ Matrix.Rotation(yaw, 4, "Z"))
        bm.from_mesh(ob.data)
        discard(ob)
    if fill is not None:
        bm.from_mesh(fill.data)
        discard(fill)
    me = bpy.data.meshes.new("SceneryRock")
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    return bpy.data.objects.new("SceneryRock", me), [], 1.0, report
