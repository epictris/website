"""The fitted slate generator: recipe F rocks of many sizes, fitted to an
outline and fused into one mass of rock.

Recipe F (docs/cave-look.md, "Geometry, recipe F"; chosen by Tris on
2026-10-01 in cave-sheet-study/rock_study.py) builds a rock from a box:

1. corner cuts - 14 planes knock the corners off, the base kept flat;
2. pillow - an 8 percent bevel, a 2.5 cm voxel remesh, 4 smoothing passes;
3. chisel - 80 shallow plane cuts per metre, the tops mostly spared, softened
   by a 2 cm remesh and 2 smoothing passes;
4. relief - a 5 cm noise at scale 1.5 and 4 mm of grit along the normals;
5. facets - collapse to about 1200 triangles per 0.8 m, planar dissolve at 9
   degrees, flat shading.

The study placed its boxes by hand. A formation has an outline, so `fit`
places the rocks (Tris, 2026-10-02: "generate rocks of varying sizes, then
automatically rotate/translate them so that they fit closely to the
collision mesh, then fuse them together"). Over a grid of the outline as the
game camera sees it (rock-local X/Z), it repeatedly finds the deepest part of
the outline no rock covers yet, builds a rock about that size, and tries it
there at a handful of spots and turns about the view axis; the pose that
covers the most uncovered outline, less what spills past it and a little for
what other rocks already cover, is kept. Big rocks go in first because the
deepest gap is biggest first; smaller ones fill what is left.

Behind the rocks `build_core` puts the outline extruded, rounded and shrunk
a little inside it, so there is no hole through the rock and the collision
outline itself is never seen: the silhouette is the rocks'. `fuse` then
remeshes rocks and
core together into ONE mass ("it can be composed of intersecting rocks but
it should still read as a single mass", as the boulder generator's slabs
do), and the facets are cut over the whole. Nothing is clipped to the
outline ("that looks artificial"), so the rock follows it with the rocks' own
variance.

Rock-local frame, as every formation: the outline in X/Z (Z up), the depth
along Y, centred on Y = 0, its front at -Y. `fit` needs only numpy, so it can
be checked outside Blender with any `make_rock`; `build` runs in the worker's
headless Blender (assemble.py).
"""

import math
import random

import numpy as np

# The fit. A rock's size is the gap it fills (Tris: "large areas should be
# filled by large rocks"), between the recipe's `smallestRock` and
# `largestRock`, both long half-lengths in metres.
CELL = 1 / 4              # grid cell, in smallest rocks
FIT = (1.1, 1.6)          # a rock's long half against the gap's depth: past it, so
                          # rocks run into their neighbours (1.4 to 2.0 made a few
                          # huge rocks spilling a metre past the outline)
ASPECT = (0.45, 0.9)      # a rock's short half (up) against its long half
DEPTH_HALF = (0.35, 0.5)  # a rock's half-depth, in depths
MIN_THICK = 0.5           # ...but at least this much of its short half
DEPTH_SHIFT = 0.1         # a rock's centre, either way along the depth, in depths
TURNS = 12                # turns about the view axis tried, over half a turn
SPOTS = 6                 # spots tried: the deepest gap and others nearly as deep
NUDGE = 0.25              # a spot moves up to this (in the rock's short half)
SPILL = 2.0               # a cell past the outline costs this many covered ones: low
                          # enough that edge rocks reach the outline (the core does not)
OVERLAP = 0.05            # a cell another rock already covers costs this much: next
                          # to nothing, since the rocks are one mass (Tris: "the
                          # rocks should be allowed to overlap more")
ACCEPT = 0.25             # a pose must cover this share of the rock with new outline
DONE = 0.06               # the share of the outline left to the core
SMALLEST_GAP = 0.8        # gaps shallower than this (in smallest rocks) are the
                          # core's: a sliver filled with tiny rocks reads as rubble
MISSES = 8                # rejected rocks in a row that end the fit
MAX_ROCKS = 2000
# Front of the rock is -Y. The CORE is the outline itself, extruded and set
# back inside the depth, weathered as a rock is but not cut: a gap between
# rocks shows recessed stone in shadow - a fissure - and never the background,
# and where the rocks fall short of the outline the core's edge is the outline.
# (Tried first and dropped: rocks in fixed tiers, which read as a pile of
# stones; backing layers of bigger stones, whose seams met the front's and
# left holes; a core held inside the outline, which left the silhouette short.)
CORE_Y = (-0.2, 0.45)     # the core's front and back, as fractions of the depth from
                          # its centre (the rocks' fronts are near -0.5), before...
CORE_INSET = 0.3          # ...it shrinks this many metres inside the outline (0.15
                          # still showed as a band along a slanted top)

# Recipe F's treatment, the study's chosen flags.
CORNERS, CORNER_DEPTH, CORNER_TILT = 14, 0.6, 0.5
BEVEL, ROUND = 0.08, 4
CUT_DEPTH, CUT_TILT, CUT_SOFT = 0.025, 0.15, 2
# The study's 80 cuts per metre of a stone's long half came to about 6 per
# square metre of its surface (rock-b's column: 69 cuts over 12 m2), each
# reaching across its ~1 m stone; see `_chisel`.
CUT_DENSITY = 6.0         # cuts per square metre
CUT_REACH = (0.2, 0.5)    # metres either way of the point a cut reaches
CUT_CLEAR = 0.3           # metres a cut's box stands out past its plane, plus its reach
BIG, BIG_SCALE, GRIT = 0.05, 1.5, 0.004
# Facets: the study's 1200 triangles per 0.8 m of a stone's long half came to
# about 120 per square metre of its surface (rock-b's column: 1290 over
# 11 m2), so the fused mass is collapsed to that density, then dissolved.
FACETS_PER_M2, ANGLE = 120, 9.0
# The fusion into one mass, at the rocks' own remesh scale.
FUSE_VOXEL, FUSE_SMOOTH = 0.025, 2


def _crossings(outline, x):
    """Where the vertical line at `x` crosses the outline, as inside spans."""
    zs = []
    n = len(outline)
    for i in range(n):
        (ax, az), (bx, bz) = outline[i], outline[(i + 1) % n]
        if (ax <= x < bx) or (bx <= x < ax):
            zs.append(az + (x - ax) / (bx - ax) * (bz - az))
    zs.sort()
    return list(zip(zs[0::2], zs[1::2]))


def hull(points):
    """The convex hull of (x, z) points, counter-clockwise (monotone chain)."""
    pts = sorted(set(map(tuple, np.round(np.asarray(points, float), 4).tolist())))
    if len(pts) < 3:
        return np.array(pts)

    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and ((out[-1][0] - out[-2][0]) * (p[1] - out[-2][1])
                                     - (out[-1][1] - out[-2][1]) * (p[0] - out[-2][0])) <= 0:
                out.pop()
            out.append(p)
        return out

    lower, upper = half(pts), half(reversed(pts))
    return np.array(lower[:-1] + upper[:-1])


class Grid:
    """The outline as the camera sees it, in cells: what is inside, what a
    rock covers."""

    def __init__(self, outline, cell, margin):
        xs = [p[0] for p in outline]
        zs = [p[1] for p in outline]
        self.cell = cell
        self.x0, self.z0 = min(xs) - margin, min(zs) - margin
        nx = math.ceil((max(xs) - min(xs) + 2 * margin) / cell)
        nz = math.ceil((max(zs) - min(zs) + 2 * margin) / cell)
        self.cx = self.x0 + (np.arange(nx) + 0.5) * cell
        self.cz = self.z0 + (np.arange(nz) + 0.5) * cell
        self.inside = np.zeros((nz, nx), bool)
        for i, x in enumerate(self.cx):
            for a, b in _crossings(outline, x):
                self.inside[(self.cz >= a) & (self.cz < b), i] = True
        self.covered = np.zeros_like(self.inside)

    def gaps(self):
        """How deep each uncovered inside cell sits in its gap, in cells: one
        at a gap's edge, more toward its middle."""
        cur = self.inside & ~self.covered
        depth = np.zeros(cur.shape, int)
        while cur.any():
            depth += cur
            e = cur.copy()
            e[1:, :] &= cur[:-1, :]
            e[:-1, :] &= cur[1:, :]
            e[:, 1:] &= cur[:, :-1]
            e[:, :-1] &= cur[:, 1:]
            e[0, :] = e[-1, :] = e[:, 0] = e[:, -1] = False
            cur = e
        return depth

    def window(self, poly):
        """The cells under a convex polygon (counter-clockwise, metres): the
        slices of the grid it spans and the mask within them, or None."""
        lo, hi = poly.min(0), poly.max(0)
        i0 = max(0, int((lo[0] - self.x0) / self.cell))
        i1 = min(len(self.cx), int((hi[0] - self.x0) / self.cell) + 1)
        j0 = max(0, int((lo[1] - self.z0) / self.cell))
        j1 = min(len(self.cz), int((hi[1] - self.z0) / self.cell) + 1)
        if i1 <= i0 or j1 <= j0:
            return None
        X, Z = np.meshgrid(self.cx[i0:i1], self.cz[j0:j1])
        mask = np.ones(X.shape, bool)
        for a, b in zip(poly, np.roll(poly, -1, axis=0)):
            mask &= (b[0] - a[0]) * (Z - a[1]) - (b[1] - a[1]) * (X - a[0]) >= 0
        return (slice(j0, j1), slice(i0, i1)), mask

    def score(self, poly):
        w = self.window(poly)
        if w is None:
            return None
        win, mask = w
        inside, covered = self.inside[win], self.covered[win]
        new = np.count_nonzero(mask & inside & ~covered)
        spill = np.count_nonzero(mask & ~inside)
        again = np.count_nonzero(mask & covered)
        return new - SPILL * spill - OVERLAP * again, new, np.count_nonzero(mask), w


def _turned(points, turn):
    """(x, z) points turned by `turn` about the view axis, as
    Matrix.Rotation(turn, 4, "Y") turns them."""
    c, s = math.cos(turn), math.sin(turn)
    return np.stack([points[:, 0] * c + points[:, 1] * s, -points[:, 0] * s + points[:, 1] * c], axis=1)


def fit(outline, depth, smallest, largest, seed, make_rock, discard=lambda rock: None):
    """Place rocks over the outline. `make_rock(half (x, y, z), seed)` builds a
    rock centred on the origin and returns (rock, its vertices' (x, z));
    `discard(rock)` drops one that fitted nowhere. Returns [(rock, turn,
    (x, y, z)), ...]: each rock turned about Y, then moved."""
    rng = random.Random(seed)
    grid = Grid(outline, CELL * smallest, largest)
    total = np.count_nonzero(grid.inside)
    blocked = np.zeros_like(grid.inside)
    placed, misses = [], 0
    while len(placed) < MAX_ROCKS and misses < MISSES:
        uncovered = grid.inside & ~grid.covered
        if np.count_nonzero(uncovered) <= DONE * total:
            break
        gaps = np.where(blocked, 0, grid.gaps())
        deepest = int(gaps.max())
        if deepest * grid.cell < SMALLEST_GAP * smallest:
            break
        long = min(max(deepest * grid.cell * rng.uniform(*FIT), smallest), largest)
        short = long * rng.uniform(*ASPECT)
        # Never a slab much thinner than it is tall: recipe F's cuts are
        # scaled to the rock, and a thin one is cut through.
        half = (long, max(depth * rng.uniform(*DEPTH_HALF), MIN_THICK * short), short)
        rock, points = make_rock(half, rng.randrange(1 << 30))
        shape = hull(points)
        deep = np.argwhere(gaps >= max(1, int(0.7 * deepest)))
        spots = [np.unravel_index(int(np.argmax(gaps)), gaps.shape)]
        spots += [tuple(deep[rng.randrange(len(deep))]) for _ in range(SPOTS - 1)]
        best = None
        for j, i in spots:
            for k in range(TURNS):
                turn = (k + rng.random()) * math.pi / TURNS
                at = np.array([grid.cx[i], grid.cz[j]]) + [rng.uniform(-1, 1) * NUDGE * half[2] for _ in range(2)]
                result = grid.score(_turned(shape, turn) + at)
                if result and (best is None or result[0] > best[0][0]):
                    best = (result, turn, at)
        if best is None or best[0][0] <= 0 or best[0][1] < ACCEPT * best[0][2]:
            discard(rock)
            misses += 1
            j, i = spots[0]
            r = max(1, deepest)
            blocked[max(0, j - r):j + r + 1, max(0, i - r):i + r + 1] = True
            continue
        (_, _, _, (win, mask)), turn, at = best
        grid.covered[win] |= mask
        blocked[:] = False
        misses = 0
        placed.append((rock, turn, (float(at[0]), rng.uniform(-1, 1) * DEPTH_SHIFT * depth, float(at[1]))))
    return placed


# ---------------------------------------------------------------- Blender
# Ported from rock_study.py with its chosen flags fixed; the study keeps every
# stage switchable for comparison, this keeps only recipe F.

def _bpy():
    import bmesh
    import bpy
    from mathutils import Matrix, Vector, noise
    return bmesh, bpy, Matrix, Vector, noise


def _unit_vector(rng, Vector):
    """A seeded random direction (the noise module's own is per-process)."""
    while True:
        v = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        if 1e-3 < v.length <= 1.0:
            return v.normalized()


def _apply_modifiers(ob):
    _, bpy, *_ = _bpy()
    dg = bpy.context.evaluated_depsgraph_get()
    final = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), depsgraph=dg)
    ob.modifiers.clear()
    old = ob.data
    ob.data = final
    bpy.data.meshes.remove(old)


def _box(name, centre, half, yaw, collection):
    bmesh, bpy, Matrix, Vector, _ = _bpy()
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * half[0], v.co.y * half[1], v.co.z * half[2]))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    collection.objects.link(ob)
    # Baked into the mesh: the cuts and the relief work in the stone's frame
    # as the study's did in world space, and the slab sits where it is drawn.
    me.transform(Matrix.Translation(Vector(centre)) @ Matrix.Rotation(yaw, 4, "Z"))
    return ob


def _cut(bm, co, n):
    bmesh, *_ = _bpy()
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=n, clear_outer=True)
    cut = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
    if cut:
        bmesh.ops.holes_fill(bm, edges=cut, sides=0)
        # A capped hole can be wound inside out; the next cut through it would
        # face inward and delete the stone.
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])


def _corner_cuts(ob, half, seed):
    bmesh, _, _, Vector, _ = _bpy()
    rng = random.Random(seed)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    smallest = min(half)
    done = tries = 0
    while done < CORNERS and tries < CORNERS * 6:
        tries += 1
        bm.verts.ensure_lookup_table()
        c = sum((v.co for v in bm.verts), Vector()) / len(bm.verts)
        v = rng.choice(bm.verts)
        n = v.co - c
        if n.z < -0.4 * n.length:
            continue  # the underside stays flat, so the stone sits
        n = (n.normalized() + _unit_vector(rng, Vector) * rng.uniform(0.3, 1.0) * CORNER_TILT).normalized()
        d = rng.uniform(CORNER_DEPTH * 0.4, CORNER_DEPTH) * smallest
        _cut(bm, v.co - n * d, n)
        done += 1
    bm.to_mesh(ob.data)
    bm.free()


def _pillow(ob, voxel, iters, bevel=0.0):
    if bevel > 0:
        bv = ob.modifiers.new("bevel", "BEVEL")
        bv.width = bevel
        bv.segments = 6
        bv.limit_method = "ANGLE"
        bv.angle_limit = math.radians(30)
    rm = ob.modifiers.new("remesh", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = voxel
    sm = ob.modifiers.new("smooth", "SMOOTH")
    sm.factor = 1.0
    sm.iterations = iters
    _apply_modifiers(ob)


def _chisel(ob, seed, scale=1.0):
    """Recipe F's chisel at its own scale on a rock of any size: CUT_DENSITY
    shallow cuts per square metre, each a plane CUT_DEPTH under a point of the
    surface, tilted off its normal by up to CUT_TILT, the tops mostly spared.
    `scale` multiplies every length (a backdrop stone far back, worked as
    finely on screen as one on the gameplay plane: solidfit.py).

    The study sliced each plane right through its ~1 m stones, so a cut's
    wedge grew with the stone (2.5 cm deep at the point, about 17 cm at the
    far side); across a 3 m face the same cut would take 45 cm. Here a cut
    takes only what lies outside its plane within CUT_REACH of the point - a
    box standing on the plane - so a chisel blow is the same size on every
    rock, and its edge is a crisp step. All of a rock's boxes go in one
    Manifold boolean (cutting one by one, as the study did, is a full pass
    over the mesh per cut)."""
    bmesh, bpy, Matrix, Vector, _ = _bpy()
    rng = random.Random(seed)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    faces = list(bm.faces)  # a voxel remesh: about even faces, so a uniform pick is by area
    count = round(CUT_DENSITY * sum(f.calc_area() for f in faces) / scale ** 2)
    cutters = bpy.data.collections.new("Chisel")
    bpy.context.scene.collection.children.link(cutters)
    made = tries = 0
    while made < count and tries < count * 4:
        tries += 1
        f = rng.choice(faces)
        n = f.normal.copy()
        if n.z > 0.85 and rng.random() < 0.6:
            continue  # spare most of the top, so it stays a shelf
        n = (n + _unit_vector(rng, Vector) * rng.uniform(0.3, 1.0) * CUT_TILT).normalized()
        d = rng.uniform(CUT_DEPTH * 0.4, CUT_DEPTH) * scale
        reach = rng.uniform(*CUT_REACH) * scale
        # The box's local Z is the plane's normal; it stands from the plane
        # out past anything the surface can raise within its reach.
        frame = n.to_track_quat("Z", "Y").to_matrix().to_4x4()
        frame.translation = f.calc_center_median() - n * d
        tall = CUT_CLEAR * scale + reach
        box = bmesh.new()
        bmesh.ops.create_cube(box, size=1.0)
        bmesh.ops.transform(box, verts=box.verts, matrix=frame @ Matrix.Translation((0, 0, tall / 2))
                            @ Matrix.Diagonal((2 * reach, 2 * reach, tall, 1)))
        me = bpy.data.meshes.new("chisel")
        box.to_mesh(me)
        box.free()
        cutters.objects.link(bpy.data.objects.new("chisel", me))
        made += 1
    bm.free()
    if made:
        mod = ob.modifiers.new("chisel", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.operand_type = "COLLECTION"
        mod.collection = cutters
        mod.solver = "MANIFOLD"
        _apply_modifiers(ob)
    for c in list(cutters.objects):
        me = c.data
        bpy.data.objects.remove(c)
        bpy.data.meshes.remove(me)
    bpy.data.collections.remove(cutters)


def _relief(ob, seed, scale=1.0):
    bmesh, _, _, Vector, noise = _bpy()
    rng = random.Random(seed)
    off = Vector((rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100)))
    off2 = Vector((rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100)))
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    moves = []
    for v in bm.verts:
        p = v.co / scale
        moves.append(v.normal * scale
                     * (BIG * noise.noise((p + off2) * BIG_SCALE) + GRIT * noise.noise((p + off) * 25.0)))
    for v, d in zip(bm.verts, moves):
        v.co += d
    bm.to_mesh(ob.data)
    bm.free()


def _facets(ob, target, angle=None):
    ob.data.calc_loop_triangles()
    ratio = min(1.0, target / max(len(ob.data.loop_triangles), 1))
    if ratio < 1.0:
        d1 = ob.modifiers.new("collapse", "DECIMATE")
        d1.decimate_type = "COLLAPSE"
        d1.ratio = ratio
        d1.use_collapse_triangulate = True
    d2 = ob.modifiers.new("planar", "DECIMATE")
    d2.decimate_type = "DISSOLVE"
    d2.angle_limit = math.radians(ANGLE if angle is None else angle)
    d2.use_dissolve_boundaries = True
    _apply_modifiers(ob)
    # The planar dissolve can leave a loose edge behind (1 stone in 27 on
    # dark-rock-4): no face uses it, but the rock is not watertight with it.
    bmesh, *_ = _bpy()
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    loose = [e for e in bm.edges if not e.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context="EDGES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        bm.to_mesh(ob.data)
    bm.free()
    for p in ob.data.polygons:
        p.use_smooth = False


def build_stone(name, half, seed, collection):
    """One recipe F rock centred on the origin, at its real size, up to its
    relief: the facets come once, on the fused mass. Its form (corner cuts,
    bevel) is in proportion to the rock; its detail (the remeshes, the chisel,
    the relief) is in metres, so a big rock is as finely worked as a small one
    (Tris, 2026-10-02: scaling a small rock up would look weird; better
    geometry over a constant build cost)."""
    ob = _box(name, (0, 0, 0), half, 0.0, collection)
    weather(ob, half, seed)
    return ob


def weather(ob, half, seed, scale=1.0):
    """Recipe F up to its relief on a stone of half-size `half` (its corner
    cuts and bevel in proportion to it), its detail lengths times `scale`."""
    _corner_cuts(ob, half, seed + 70)
    _pillow(ob, voxel=0.025 * scale, iters=ROUND, bevel=BEVEL * min(half))
    _chisel(ob, seed + 50, scale)
    _pillow(ob, voxel=0.02 * scale, iters=CUT_SOFT)
    _relief(ob, seed + 60, scale)


def fuse(stones, name):
    """The stones as ONE mass (Tris, 2026-10-02: intersecting rocks, but read
    as a single mass, as the boulder generator's slabs are): a voxel remesh of
    all of them together is their union, so where they intersect there is one
    surface and their seams are creases, not gaps; a light smoothing softens
    the creases, and the facets are cut over the whole. Needs the boulder
    generator's directory on sys.path (assemble.py puts it there)."""
    bmesh, bpy, *_ = _bpy()
    bm = bmesh.new()
    for s in stones:
        bm.from_mesh(s.data)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    _pillow(ob, voxel=FUSE_VOXEL, iters=FUSE_SMOOTH)
    # As the boulder generator does after its union: one body, no stray chip
    # and no sealed shell inside.
    from blender_build import keep_main_body
    keep_main_body(ob)
    _facets(ob, FACETS_PER_M2 * sum(p.area for p in ob.data.polygons))
    bpy.context.scene.collection.objects.unlink(ob)
    return ob


def build_core(outline, depth, seed, collection):
    """The outline extruded through CORE_Y of the depth, rounded, then shrunk
    CORE_INSET inside it all round: it backs every gap between the rocks but
    is never their silhouette (Tris, 2026-10-02: the collision outline itself
    must not be visible - where it showed, it was a flat end and a straight
    edge). The rocks' own variance is the silhouette."""
    bmesh, bpy, _, Vector, _ = _bpy()
    y0, y1 = CORE_Y[0] * depth, CORE_Y[1] * depth
    bm = bmesh.new()
    face = bm.faces.new([bm.verts.new((x, y0, z)) for x, z in outline])
    # A new face's normal is zero until updated (scene_guide.py met it).
    face.normal_update()
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    bmesh.ops.translate(bm, verts=[v for v in ext["geom"] if isinstance(v, bmesh.types.BMVert)],
                        vec=Vector((0, y1 - y0, 0)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new("Core")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("Core", me)
    collection.objects.link(ob)
    _pillow(ob, voxel=0.025, iters=ROUND, bevel=BEVEL * (y1 - y0) / 2)
    # In along the normals of the rounded, remeshed surface: an erosion, so
    # concave corners stay inside too; the fusion's remesh tidies any fold.
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    moves = [v.normal * -CORE_INSET for v in bm.verts]
    for v, d in zip(bm.verts, moves):
        v.co += d
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def build(outline, params, collection):
    """The rock (unlinked) and its pieces - the rocks and the core - each its
    own object in `collection`."""
    _, bpy, Matrix, Vector, _ = _bpy()
    count = [0]

    def make_rock(half, seed):
        ob = build_stone(f"Rock {count[0]}", half, seed, collection)
        count[0] += 1
        co = np.empty(len(ob.data.vertices) * 3)
        ob.data.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        return ob, co[:, [0, 2]]

    def discard(ob):
        me = ob.data
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)

    smallest, largest = params["smallestRock"], params["largestRock"]
    placed = fit(outline, params["depth"], smallest, largest, params["seed"], make_rock, discard)
    rocks = []
    for ob, turn, at in placed:
        ob.data.transform(Matrix.Translation(Vector(at)) @ Matrix.Rotation(turn, 4, "Y"))
        rocks.append(ob)
    core = build_core(outline, params["depth"], params["seed"] * 1000 - 1, collection)
    return fuse(rocks + [core], "SceneryRock"), rocks + [core]
