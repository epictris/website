"""A SOLID formation: a closed guide mesh cut into stones that fit it, each
finished as the boulder generator finishes the top of an outline rock.

Two halves, each the better of two generators (Tris, 2026-11-13: "this is the
best so far ... I'm happy to switch to this new approach"; the study, with
every render it judged, is in docs/blender-backdrop.md):

- THE STONES are cut from the guide itself, as recipe F's backdrop did
  (before 2026-11-13 this file was that): every cell of a partition that
  holds any of the guide's surface is a stone, the cell and the guide
  intersected, so the stones fit the guide wherever it bends, alcoves and
  lobes included; a cell whose surface curves is split smaller, a sliver or
  a knub is merged into its neighbour, and a core, the guide shrunk inside,
  backs every fissure. The partition is the boulder generator's 3D Voronoi
  cells (its anisotropy, boulders/chunk_geometry.py), not a grid of boxes:
  boxes read as rectangular blocks in rows.
- THE SURFACE is the boulder generator's top (boulders/blender_build.py
  assemble_rock, measured stage by stage on Terrace.002): each stone sawn
  flat along the plane of its patch of the guide, given the boulder's chunk
  bevel, and sheared by hybrid_geometry.taper_chunk - every point in along
  the guide's inward normal by its distance from a ridge times the stone's
  own slope - so neighbouring stones step against each other like the
  Terrace's plates. Then the boulder's own cleanup (solid_chunks.
  reinforce_chunks, the thin-edge bevel) and finish (one union, the voxel
  remesh, smoothing, the decimation, the edge bevel). Recipe F's weathering
  (corner cuts, pillow, chisel, relief, facets) is gone.

Two departures from the boulder, both because a guide is not an outline
swept through a plane:

- The boulder's taper also sinks every piece by its slope, so its top falls
  away from the gameplay plane as a roof. On a guide that roof would repeat
  every ridge and leave a groove at each valley, so only the step between
  stones is kept: each stone's slope less the mean slope (`sink`).
- The boulder's ridge is its gameplay plane; here a ridge line runs across
  every face, RIDGE_SPACING apart, along the depth axis the boulder would use
  there (the camera's axis in the surface, screen up on a face turned to the
  camera). Its plates reach about 1.1 m from a ridge, so ridges 2 m apart
  (at the plane's scale) leave no bare core between them.

Everything is sized in SCREEN metres - lengths on the gameplay plane
`distance` in front of the eye - and multiplied by a stone's depth over that
distance, so a far stone is as big and as finely worked on screen as a near
one. The guide comes in world space, already where it stands.
"""

import math

import numpy as np

from . import fitted

# The partition: CELLS_PER_M3 cells in a cubic screen metre (times 1 /
# stoneSize^3), sampled in jittered depth-scaled strata near the surface,
# each a Voronoi cell in its anisotropic space (chunk_geometry:
# the broad side chunks). Three a cubic metre is about a metre across; 1.5
# left Cube.001 sixteen stones with big plain faces (2026-11-13).
CELLS_PER_M3 = 3.0
CELL_METRIC = (1.0, 0.65, 0.80)  # world x, y (along the view), z (up)
# chunk_geometry's anisotropy in the boulder's local frame (screen x, screen
# y, depth toward the camera), taken to the world (x, y along the view, z up).
TO_LOCAL = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], float)
CELL_T = np.array([[1, .11, .10], [0, .80, -.08], [0, 0, .65]]) @ TO_LOCAL
CELL_NEIGHBOURS = 24
# Completing a cell (`Cells`): the seeds added a pass, and the most planes a
# cell may have (`halfspaces` tries every three of them).
COMPLETE_STEP, COMPLETE_MAX = 4, 80
# A cell's taper follows the solid's normal averaged this far (screen
# metres) about the point nearest its seed.
NORMAL_REACH = 0.5
# At each joint the cell that lies higher once tapered reaches CELL_OVERLAP
# (screen metres) over its neighbour, and the lower stands CELL_GAP back.
# Both ways (solidfit's old OVERLAP), two neighbours tilted differently cut
# through each other at a grazing angle into thin blades (Tris, 2026-11-13:
# "jagged edges ... need to be fixed"); gaps every way read as cobblestones
# set in grout. Only where the step is MIN_STEP tall: a lower one is no
# shingle and may still cross.
CELL_OVERLAP, CELL_GAP, MIN_STEP = 0.12, 0.01, 0.02
# A cell whose share of the solid's surface bends is split in two across
# the screen (its longer of width and height), again and again, down to
# SMALL's sizes times Stone size: big stones on a curve came out as straight runs meeting in
# a point (Tris, 2026-10-04: the arches "should be a gradual curve"; at
# SMALL's sizes they were). Bending: its gentle bends turn it over
# CURVE_TURN (`_curved`).
SMALL_WIDTH, SMALL_HEIGHT = 0.55, 0.35
CURVE_BEND = (math.radians(2), math.radians(35))
CURVE_TURN = math.radians(60)  # PARAMS["curveTurn"] is this in degrees
# The boulder construction's depth (its `depth` parameter): D = DEPTH / 2.6
# screen metres, the length every taper is measured in.
DEPTH = 4.0
# Ridge lines this many D apart (above).
RIDGE_SPACING = 1.3
# The saw: a stone's faces on the guide grouped by direction (a face further
# than CORNER_ANGLE from a group's starts another), each group with at least
# PLANE_SHARE of the patch one plane, at most MAX_PLANES.
CORNER_ANGLE = math.radians(35)
PLANE_SHARE, MAX_PLANES = 0.12, 3
# The core: the solid shrunk this far inside (screen metres), unworked, so a
# fissure shows recessed stone and never the sky through the piece.
CORE_INSET, CORE_STEPS = 0.2, 5
# The core's facets: a remesh this coarse (screen metres, coarsened with
# depth by CORE_FALLOFF), then dissolved.
CORE_FACET, CORE_FALLOFF = 0.15, 1.0
# Parts of a shrunk core smaller than this share of its area or SCRAP_SIZE
# (screen metres) across are dropped (`drop_scraps`).
SCRAP, SCRAP_SIZE = 0.02, 0.1
# The solid is thickened away from the eye by this (screen metres), along
# the camera's rays (`thicken`).
THICKEN = 0.4
# The FACE attribute marking the core's faces in a built piece.
CORE_ATTRIBUTE = "backdrop_core"
# A stone keeps itself only if some of the solid's surface is in it, it is
# no thinner than SLIVER (screen metres) every way, and it fills at least
# FILL of its box; otherwise it is merged into its neighbour.
ON_SURFACE = 1e-4
SLIVER = 0.1
FILL = 0.3
# A piece under this share of the piece's median cell volume is joined to
# its neighbour too (a knub otherwise).
KNUB = 0.3
# No convex edge sharper than this inside, radians (Tris, 2026-10-04): the
# core is unfolded to it; backdrop_check.py reports the rock against it.
MIN_ANGLE = math.radians(80)
# The core's opening (`open_thin`): radius in screen metres, steps each way.
OPEN_RADIUS, OPEN_STEPS = 0.02, 3
# `unfold`: at most this many edge collapses, and a mesh that would keep
# less than UNFOLD_KEEP of its surface is left as it was.
UNFOLD_MAX, UNFOLD_KEEP = 60, 0.95

# What a solid formation's recipe may set (its `params`; the Formations
# panel's fields, formations/params.py), and the defaults it takes:
# - seed: the cells and every stone's taper and bevel;
# - stoneSize: every stone's size times this (CELLS_PER_M3 / stoneSize^3);
# - knub: KNUB;
# - curveTurn: CURVE_TURN, degrees;
# - adaptiveDepth: local construction/remesh budgets, on by default. Replaces
#   the two legacy controls below; they remain readable for reproducibility.
# - floor: in legacy mode, the least depth scale a stone is cut at (`Cells`);
# - fixedScale: when over 0, the depth scale EVERY stone is cut and worked
#   at, instead of its own depth over the plane's: the level of detail set by
#   hand rather than by distance from the camera.
PARAMS = {"seed": 0, "stoneSize": 1.0, "knub": KNUB, "curveTurn": 60.0,
          "adaptiveDepth": True, "floor": 0.0, "fixedScale": 0.0}


def resolved(params):
    """`params` over PARAMS, refused when a key is not one of them."""
    unknown = set(params) - set(PARAMS) - {"core"}
    if unknown:
        raise ValueError(f"unknown solid parameters: {', '.join(sorted(unknown))}")
    return {**PARAMS, **params}


def _bpy():
    import bmesh
    import bpy
    from mathutils import Matrix, Vector
    from mathutils.bvhtree import BVHTree
    return bmesh, bpy, Matrix, Vector, BVHTree


def _boulders():
    """The boulder generator's parameters and the two steps reused as they
    are (tools/blender/boulders, on sys.path in the worker's Blender)."""
    from blender_build import limit_edge_bevel
    from params import defaults
    from solid_chunks import reinforce_chunks
    return defaults(), reinforce_chunks, limit_edge_bevel


def world_matrix(ob):
    """`ob`'s world matrix from its own transform and its parents'. An object
    in a hidden collection (the backdrop's sources) is never evaluated, so
    its `matrix_world` stays the identity however it is moved."""
    m = ob.matrix_basis.copy()
    if ob.parent is not None:
        m = world_matrix(ob.parent) @ ob.matrix_parent_inverse @ m
    return m


class Camera:
    """The game camera at one pose: an eye looking along +Y (the gameplay
    plane is y = 0, the camera at -y), the plane `distance` in front."""

    def __init__(self, eye, distance, tan_half=12/70):
        self.eye = np.asarray(eye, float)
        self.distance = float(distance)
        from .depth_budget import Budget
        from .render import DOF_MAX_BLUR, DOF_FOCUS_BAND
        self.budget = Budget(self.distance,float(tan_half),DOF_MAX_BLUR,DOF_FOCUS_BAND)

    def scale(self, y):
        """How much bigger a thing at world depth `y` is than the same thing
        on screen at the gameplay plane."""
        return (y - self.eye[1]) / self.distance


# -- geometry ------------------------------------------------------------

def halfspaces(planes, lo, hi, *, fast=False):
    """The vertices of {x : n.x <= b for every (n, b)} inside the box lo..hi:
    every feasible intersection of three of the planes."""
    planes = list(planes)
    for ax in range(3):
        e = np.zeros(3)
        e[ax] = 1
        planes += [(e, hi[ax]), (-e, -lo[ax])]
    N = np.array([q[0] for q in planes], float)
    b = np.array([q[1] for q in planes], float)
    if fast:
        from native import cell_corners
        return cell_corners(N, b)
    m = len(planes)
    i, j, k = np.array([(i, j, k) for i in range(m) for j in range(i + 1, m) for k in range(j + 1, m)]).T
    A = np.stack([N[i], N[j], N[k]], axis=1)
    B = np.stack([b[i], b[j], b[k]], axis=1)
    ok = np.abs(np.linalg.det(A)) > 1e-12
    x = np.linalg.solve(A[ok], B[ok][..., None])[..., 0]
    return x[np.all(x @ N.T <= b + 1e-7, axis=1)]


def hull_mesh(points, name):
    """The convex hull of `points` as a new mesh, or None when it is flat."""
    bmesh, bpy, *_ = _bpy()
    bm = bmesh.new()
    for p in points:
        bm.verts.new(p)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    if len(bm.verts) < 4:
        bm.free()
        return None
    res = bmesh.ops.convex_hull(bm, input=bm.verts[:], use_existing_faces=False)
    loose = {g for g in res["geom_interior"] + res["geom_unused"] if isinstance(g, bmesh.types.BMVert)}
    loose |= {v for v in bm.verts if not v.link_faces}
    if loose:
        bmesh.ops.delete(bm, geom=list(loose), context="VERTS")
    if len(bm.faces) < 4:
        bm.free()
        return None
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me


def _evaluate(ob):
    """Evaluate one working piece without keeping every completed stone live."""
    _, bpy, *_ = _bpy()
    temporary = not ob.users_collection
    if temporary:
        bpy.context.scene.collection.objects.link(ob)
    try:
        fitted._apply_modifiers(ob)
    finally:
        if temporary:
            bpy.context.scene.collection.objects.unlink(ob)


def _boolean(ob, operand, operation, collection=False):
    """`ob` combined with `operand` (an object, or a collection's objects),
    the Manifold solver, applied."""
    _, bpy, *_ = _bpy()
    temporary_operand = not collection and not operand.users_collection
    if temporary_operand:
        bpy.context.scene.collection.objects.link(operand)
    mod = ob.modifiers.new("boolean", "BOOLEAN")
    mod.operation = operation
    mod.solver = "MANIFOLD"
    if collection:
        mod.operand_type = "COLLECTION"
        mod.collection = operand
    else:
        mod.object = operand
    try:
        _evaluate(ob)
    finally:
        if temporary_operand:
            bpy.context.scene.collection.objects.unlink(operand)


def _modifier(ob, kind, **settings):
    mod = ob.modifiers.new(kind.lower(), kind)
    for k, v in settings.items():
        setattr(mod, k, v)
    _evaluate(ob)


def triangulate(bm, faces, quad_method="SHORT_EDGE", ngon_method="BEAUTY"):
    """Triangulate `faces` of `bm` as the Triangulate modifier does (its
    defaults: the shorter diagonal of a quad, beauty for the rest), but never
    make an edge the mesh already has. Blender's triangulate does not ask: a
    diagonal between two corners of an n-gon that an edge outside it already
    joins was that edge again, shared by four faces (three where the n-gon
    was a sliver: a fin, `assemble.drop_fins`), and a solid rock failed
    "must be watertight" at random (where the bevel leaves such n-gons
    follows the Manifold boolean, which is not deterministic; Cube.002 and
    Cube.005, 2026-11-13: 556 of 58,571 n-gons). Those n-gons, and any two
    that share a pair of corners a diagonal could join, are poked instead,
    fanned about a new vertex at their centre: none of whose edges can be
    there already. Every other face comes out as the modifier makes it."""
    bmesh, *_ = _bpy()
    faces = [f for f in faces if len(f.verts) > 3]
    if not faces:
        return
    bm.verts.index_update()
    seen, risky = {}, set()
    for f in faces:
        vs = f.verts[:]
        n = len(vs)
        for i in range(n):
            for j in range(i + 2, n - (i == 0)):
                a, b = vs[i], vs[j]
                if any(e.other_vert(a) is b for e in a.link_edges):
                    risky.add(f)
                other = seen.setdefault((min(a.index, b.index), max(a.index, b.index)), f)
                if other is not f:
                    risky.add(f)
                    risky.add(other)
    if risky:
        bmesh.ops.poke(bm, faces=list(risky), center_mode="MEAN_WEIGHTED")
    rest = [f for f in faces if f not in risky]
    if rest:
        bmesh.ops.triangulate(bm, faces=rest, quad_method=quad_method, ngon_method=ngon_method)


def _tree(ob):
    _, _, _, _, BVHTree = _bpy()
    return BVHTree.FromPolygons([v.co for v in ob.data.vertices], [p.vertices for p in ob.data.polygons])


RAYS = ((0.5773, 0.5774, 0.5775), (-0.6131, 0.4402, -0.6561), (0.3021, -0.8460, 0.4395))


def _inside(tree, points):
    """Which `points` lie inside the closed surface `tree`: the majority of
    three rays' crossing parities, along skewed directions. One ray alone
    flipped a point now and then: through an edge it crosses one triangle or
    both, whichever the BVH finds, and its order is not the same from one run
    to the next, so a rock rebuilt from the same seed came out different."""
    _, _, _, Vector, _ = _bpy()
    rays = [Vector(d).normalized() for d in RAYS]
    out = np.zeros(len(points), bool)
    for i, p in enumerate(points):
        votes = 0
        for d in rays:
            o, n = Vector(p), 0
            for _ in range(64):
                hit = tree.ray_cast(o, d)[0]
                if hit is None:
                    break
                n += 1
                o = hit + d * 1e-5
            votes += n % 2
        out[i] = votes >= 2
    return out


def farthest(points, count, metric, rng, scales=None):
    """The boulder generator's farthest-point pick, with its jitter: indices
    of `count` of `points`, spread evenly under `metric`, each distance
    divided by the candidate's `scale` (so spread evenly in screen metres)."""
    weight = 1.0 / np.asarray(scales, float) if scales is not None else np.ones(len(points))
    chosen = [int(rng.integers(len(points)))]
    nearest = np.full(len(points), np.inf)
    for _ in range(count - 1):
        nearest = np.minimum(nearest, np.linalg.norm((points - points[chosen[-1]]) * metric, axis=1) * weight)
        nearest[chosen[-1]] = -1
        chosen.append(int(np.argmax(nearest * rng.uniform(.85, 1.15, len(points)))))
    return np.array(chosen)


def keep_main_body(ob):
    """Delete every loose part of `ob` but the largest by area."""
    bmesh, *_ = _bpy()
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    left, groups = set(bm.verts), []
    while left:
        part = {left.pop()}
        todo = list(part)
        while todo:
            v = todo.pop()
            for e in v.link_edges:
                o = e.other_vert(v)
                if o in left:
                    left.remove(o)
                    part.add(o)
                    todo.append(o)
        groups.append(part)
    if len(groups) > 1:
        groups.sort(key=lambda g: sum(f.calc_area() for f in {f for v in g for f in v.link_faces}), reverse=True)
        bmesh.ops.delete(bm, geom=[v for g in groups[1:] for v in g], context="VERTS")
    bm.to_mesh(ob.data)
    bm.free()


def grown(ob, distance, voxel, collection, name, camera=None):
    """A copy of `ob` grown `distance` along its normals in steps of at most
    four voxels, remeshed before and after each, so it stays one closed
    manifold."""
    bmesh, bpy, *_ = _bpy()
    out = bpy.data.objects.new(name, ob.data.copy())
    collection.objects.link(out)
    pillow(out, voxel, 0, camera)
    steps = max(1, math.ceil(abs(distance) / (4 * voxel))) if distance else 0
    for _ in range(steps):
        if camera:
            move_normals(out,distance/steps,camera)
        else:
            bm = bmesh.new()
            bm.from_mesh(out.data)
            bm.normal_update()
            for v in bm.verts:
                v.co += v.normal * (distance / steps)
            bm.to_mesh(out.data)
            bm.free()
        pillow(out, voxel, 0, camera)
    return out


# -- the cells ------------------------------------------------------------

def along(n):
    """The depth axis the boulder measures its taper in, lying in a surface
    of normal `n`: the camera's axis (world y) where it lies in the surface
    (a boulder's top, bottom and ends), screen up on a face turned to the
    camera, which no boulder saws."""
    view, up = np.array([0.0, 1.0, 0.0]), np.array([0.0, 0.0, 1.0])
    t = view - np.dot(view, n) * n
    if np.linalg.norm(t) < 0.5:
        t = up - np.dot(up, n) * n
    return t / np.linalg.norm(t)


def sink(taper, points):
    """How far `taper` takes `points` in along its inward normal (out where
    negative): hybrid_geometry.taper_chunk, |z| (the distance from the
    ridge along the depth axis) times the slope on that side times the
    influence, less the mean slope's share (the roof, module docstring)."""
    pts = np.atleast_2d(points)
    z = pts @ taper["t"] - taper["r"]
    slope = np.where(z < 0, taper["slopes"][0], taper["slopes"][1])
    return np.abs(z) * (slope - taper["mean"]) * taper["influence"]


class Cells:
    """The partition of a solid: the boulder's anisotropic Voronoi cells over
    it, each grown over or held back from each neighbour, with its taper
    decided before the cut (which neighbour lies higher decides the joint).
    A cell is an id; `cut` intersects it with the solid, `split` halves it."""

    def __init__(self, solid, surface, camera, p, boulder, rng, report):
        from mathutils.kdtree import KDTree
        self.camera, self.p, self.boulder, self.rng = camera, p, boulder, rng
        self.surface = surface
        # The solid's faces by centre, for the smoothed normal (`_normal`).
        polys = solid.data.polygons
        self.face_n = np.array([q.normal for q in polys]) * np.array([q.area for q in polys])[:, None]
        self.faces = KDTree(len(polys))
        for i, q in enumerate(polys):
            self.faces.insert(q.center, i)
        self.faces.balance()
        co = np.array([v.co for v in solid.data.vertices])
        self.surface_cells = None
        if p['adaptiveDepth']:
            from native import Bvh
            solid.data.calc_loop_triangles()
            self.surface_cells = Bvh(co, [t.vertices[:] for t in solid.data.loop_triangles])
        lo, hi = co.min(0), co.max(0)
        self.lo, self.hi = lo - 1.0, hi + 1.0
        tree = _tree(solid)
        if p['adaptiveDepth']:
            from .cell_sampling import surface_seeds
            seeds, candidates = surface_seeds(tree, lo, hi, self.scale, p['stoneSize'],
                                             CELLS_PER_M3, CELL_METRIC, rng, _inside)
            report['seed candidates'] = candidates
        else:
            box = rng.uniform(lo, hi, (40000, 3))
            inside = box[_inside(tree, box)]
            scales = np.array([self.scale(y) for y in inside[:, 1]])
            volume = float(np.prod(hi - lo))
            count = int(round(volume / len(box) * float(np.sum(CELLS_PER_M3 / (scales * p["stoneSize"]) ** 3))))
            count = max(4, min(count, len(inside) // 20))
            pick = farthest(inside, count, np.array(CELL_METRIC), rng, scales)
            seeds = inside[pick]
        self.planes, self.tapers, self.f = [], [], []
        tapers = [self._taper(s) for s in seeds]
        st = seeds @ CELL_T.T
        neighbours = KDTree(len(st))
        for i, point in enumerate(st):
            neighbours.insert(point, i)
        neighbours.balance()
        metric_norm = float(np.linalg.norm(CELL_T, 2))
        overlapped = 0

        def joint(i, j, f):
            """The plane cell i is cut by against cell j (n.x <= b, world),
            and whether it is grown over j rather than held back."""
            nt = st[j] - st[i]
            bt = float(nt @ (st[j] + st[i]) / 2)
            nw = CELL_T.T @ nt
            length = np.linalg.norm(nw)
            mid = (seeds[i] + seeds[j]) / 2
            # How far i lies above j at the joint (sink is inward).
            above = float(sink(tapers[j], mid)[0] - sink(tapers[i], mid)[0])
            over = bool(above > MIN_STEP * f)
            return (nw / length, bt / length + (CELL_OVERLAP if over else -CELL_GAP) * f), over

        for i, s in enumerate(st):
            depth_scale = self.scale(seeds[i][1])
            f = depth_scale * (p['stoneSize'] if p['adaptiveDepth'] else 1.)
            near = [j for _, j, _ in neighbours.find_n(s, min(len(st), CELL_NEIGHBOURS+1)) if j != i]
            if not p['adaptiveDepth']:
                near = np.argsort(np.linalg.norm(st-s, axis=1))[1:CELL_NEIGHBOURS+1]
            planes, have = [], set()
            for j in near:
                plane, over = joint(i, int(j), f)
                overlapped += over
                planes.append(plane)
                have.add(int(j))
            # The cell completed: its nearest seeds bound it only when they
            # surround it. On a seed at the edge of the cloud they all lie to
            # one side, and the cell ran to the box across whatever the solid
            # left open; on a hollow solid (Cube.005, a cave) it claimed the
            # far wall, 16 m of it, and came out one smooth slab where that
            # wall's own stones were (2026-11-13). The seeds whose planes cut
            # the cell's corners deepest are added, COMPLETE_STEP a pass, until
            # none cuts it: the cell is then exactly the seed's (offset)
            # Voronoi cell. A few a pass, because the corners of a cell run to
            # the box are cut by nearly every seed, and `halfspaces` grows as
            # the cube of its planes (all at once took 36 GB).
            while len(planes) < COMPLETE_MAX:
                v = halfspaces(planes, self.lo, self.hi, fast=p['adaptiveDepth'])
                if len(v) == 0:
                    break
                # A seed beyond twice the corner radius cannot bisect this
                # cell. Include the tightest joint offset in the bound, then
                # run the same exact plane test on this local neighbourhood.
                radius = 2*(float(np.linalg.norm(v @ CELL_T.T-s, axis=1).max())
                            + CELL_GAP*f*metric_norm) + 1e-5
                ids = np.array(sorted(j for _, j, _ in neighbours.find_range(s, radius)
                                      if j != i and j not in have), dtype=int)
                if not p['adaptiveDepth']:
                    ids = np.array([j for j in range(len(st)) if j != i and j not in have], dtype=int)
                if not len(ids):
                    break
                nt_all = st[ids] - s
                nw_all = nt_all @ CELL_T
                len_all = np.linalg.norm(nw_all, axis=1)
                b_all = (nt_all * (st[ids] + s) / 2).sum(1)
                # How far past each seed's plane (held back, the tightest
                # it can be) the cell's corners reach, deepest first.
                reach = ((v @ nw_all.T - b_all) / len_all).max(0)
                added = 0
                for index in np.argsort(-reach):
                    j = int(ids[index])
                    if reach[index] <= -CELL_GAP * f + 1e-9 or added == COMPLETE_STEP:
                        break
                    plane, over = joint(i, j, f)
                    have.add(j)
                    if (v @ plane[0] - plane[1]).max() > 1e-9:
                        overlapped += over
                        planes.append(plane)
                        added += 1
                if not added:
                    break
            else:
                report["cells left open"] = report.get("cells left open", 0) + 1
            self.planes.append(planes)
            self.tapers.append(tapers[i])
            self.f.append(depth_scale)
        report["cells"] = len(seeds)
        report["joints overlapped"] = overlapped

    def scale(self, y):
        p = self.p
        if p['adaptiveDepth']:
            return self.camera.scale(y)
        return p["fixedScale"] if p["fixedScale"] > 0 else max(self.camera.scale(y), p["floor"])

    def _taper(self, point):
        """A cell's taper: the guide's normal nearest its seed (the shear's
        outward axis), the depth axis in the surface, the nearest ridge, a
        slope each side of it and the influence of how deep the seed lies."""
        _, _, _, Vector, _ = _bpy()
        b = self.boulder
        hit = self.surface.find_nearest(Vector(point))
        k = self.scale(point[1]) * self.p["stoneSize"]
        d = DEPTH / 2.6 * k
        n = self._normal(hit[0], NORMAL_REACH * k)
        t = along(n)
        spacing = RIDGE_SPACING * d
        return {"n": n, "t": t, "r": spacing * round(float(np.dot(point, t)) / spacing),
                "slopes": self.rng.uniform(b["taperSlopeMin"], b["taperSlopeMax"], 2),
                "mean": (b["taperSlopeMin"] + b["taperSlopeMax"]) / 2,
                "influence": math.exp(-hit[3] / (d * b["taperReach"])), "k": k}

    def _normal(self, at, reach):
        """The solid's area-weighted normal over its faces within `reach` of
        `at`: the nearest face's alone is whichever of two the BVH happens to
        find at an edge, and the solid's face order (a boolean's output) is
        not the same from one run to the next."""
        near = [i for _, i, _ in self.faces.find_range(at, reach)]
        if not near:
            near = [self.faces.find(at)[1]]
        n = self.face_n[near].sum(0)
        return n / np.linalg.norm(n)

    def ids(self):
        return list(range(len(self.planes)))

    def box(self, cid):
        """The cell's bounding box: centre and half extents, or None when it
        is empty."""
        v = halfspaces(self.planes[cid], self.lo, self.hi, fast=self.p['adaptiveDepth'])
        if len(v) < 4:
            return None
        return (v.min(0) + v.max(0)) / 2, (v.max(0) - v.min(0)) / 2

    def cut(self, bm_solid, cid):
        """The solid within cell `cid`, as a new object (unlinked), or None
        when nothing is left."""
        _, bpy, *_ = _bpy()
        v = halfspaces(self.planes[cid], self.lo, self.hi, fast=self.p['adaptiveDepth'])
        if len(v) >= 4 and self.surface_cells is not None:
            if not self.surface_cells.cell_meets_surface(self.planes[cid], v.min(0), v.max(0)):
                return None
        me = hull_mesh(v, "cutter") if len(v) >= 4 else None
        if me is None:
            return None
        piece = bpy.data.meshes.new("cell")
        bm_solid.to_mesh(piece)
        ob = bpy.data.objects.new("cell", piece)
        bpy.context.scene.collection.objects.link(ob)
        cutter = bpy.data.objects.new("cutter", me)
        _boolean(ob, cutter, "INTERSECT")
        bpy.data.objects.remove(cutter)
        bpy.data.meshes.remove(me)
        bpy.context.scene.collection.objects.unlink(ob)
        if len(ob.data.polygons) < 4:
            me = ob.data
            bpy.data.objects.remove(ob)
            bpy.data.meshes.remove(me)
            return None
        return ob

    def split(self, cid):
        """Cell `cid` halved across the screen (its longer of width over
        SMALL_WIDTH and height over SMALL_HEIGHT), the halves new cells with
        its taper; None at SMALL's sizes."""
        box = self.box(cid)
        if box is None:
            return None
        centre, half = box
        depth_scale = self.scale(centre[1]-half[1]) if self.p['adaptiveDepth'] else self.f[cid]
        f = depth_scale * (self.p['stoneSize'] if self.p['adaptiveDepth'] else 1.)
        wide, tall = half[0] / (SMALL_WIDTH * f), half[2] / (SMALL_HEIGHT * f)
        if max(wide, tall) < 1:
            return None
        e = np.array([1.0, 0, 0]) if wide >= tall else np.array([0, 0, 1.0])
        out = []
        for sign in (1, -1):
            self.planes.append(self.planes[cid] + [(sign * e, float(sign * e @ centre) - CELL_GAP * f)])
            self.tapers.append(self.tapers[cid])
            self.f.append(depth_scale)
            out.append(len(self.planes) - 1)
        return out


def _curved(ob, surface, half):
    """How far the solid's surface in a cell's piece turns, radians: the
    angles of its gentle bends (CURVE_BEND, a curve meshed in segments; a
    corner is one sharp bend, not a curve) times their lengths, over the
    cell's longest side (the length a bend runs across the cell)."""
    bmesh, *_ = _bpy()
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    on = {f.index for f in bm.faces if surface.find_nearest(f.calc_center_median())[3] < ON_SURFACE}
    turn = 0.0
    for e in bm.edges:
        if len(e.link_faces) == 2 and all(f.index in on for f in e.link_faces):
            a = e.calc_face_angle(0.0)
            if CURVE_BEND[0] < a < CURVE_BEND[1]:
                turn += a * e.calc_length()
    bm.free()
    return turn / (2 * max(half))


# -- a stone ----------------------------------------------------------------

def surface_planes(ob, surface):
    """A stone's faces on the solid's surface grouped by direction, largest
    first, each group's plane (normal, offset) through its area-weighted
    centre: what saws the stone flat."""
    bmesh, *_ = _bpy()
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    faces = [(np.array(f.normal), np.array(f.calc_center_median()), f.calc_area())
             for f in bm.faces if f.calc_area()>1e-12 and f.normal.length>1e-6
             and surface.find_nearest(f.calc_center_median())[3] < 1e-3]
    bm.free()
    if not faces:
        return []
    faces.sort(key=lambda f: -f[2])
    total = sum(f[2] for f in faces)
    groups = []
    for n, c, a in faces:
        for g in groups:
            if np.dot(g["n"] / np.linalg.norm(g["n"]), n) > math.cos(CORNER_ANGLE):
                g["n"], g["c"], g["a"] = g["n"] + n * a, g["c"] + c * a, g["a"] + a
                break
        else:
            groups.append({"n": n * a, "c": c * a, "a": a})
    planes = []
    for g in sorted(groups, key=lambda g: -g["a"])[:MAX_PLANES]:
        if g["a"] >= PLANE_SHARE * total:
            n = g["n"] / np.linalg.norm(g["n"])
            offset = float(n @ (g["c"] / g["a"]))
            planes.append((n, offset))
    return planes


def work(ob, taper, surface, boulder, rng, camera=None):
    """One stone as the boulder works a piece on its top: sawn flat by its
    planes, the chunk bevel, split at its ridge and tapered (`sink`)."""
    bmesh, bpy, _, Vector, _ = _bpy()
    co = np.array([v.co for v in ob.data.vertices])
    planes = surface_planes(ob, surface)
    if planes:
        v = halfspaces(planes, co.min(0) - 0.5, co.max(0) + 0.5)
        me = hull_mesh(v, "saw") if len(v) >= 4 else None
        if me is not None:
            saw = bpy.data.objects.new("saw", me)
            _boolean(ob, saw, "INTERSECT")
            bpy.data.objects.remove(saw)
            bpy.data.meshes.remove(me)
    if len(ob.data.polygons) < 4:
        return False
    k = taper["k"]
    width = rng.uniform(boulder["chunkBevelMin"], boulder["chunkBevelMax"]) * k
    near = min(v.co.y for v in ob.data.vertices)
    blur = camera.budget.blur(near-camera.eye[1]-camera.distance) if camera else 0.
    if width >= blur:
        _modifier(ob, "BEVEL", width=width,
                  segments=int(boulder["chunkBevelSegments"]), limit_method="ANGLE",
                  angle_limit=math.radians(boulder["chunkBevelAngle"]))
    # taper_chunk splits a piece at its ridge so each side takes its slope.
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-7,
                           plane_co=Vector(taper["t"] * taper["r"]), plane_no=Vector(taper["t"]))
    bm.to_mesh(ob.data)
    bm.free()
    co = np.array([v.co for v in ob.data.vertices])
    co -= taper["n"] * sink(taper, co)[:, None]
    ob.data.vertices.foreach_set("co", co.ravel())
    ob.data.update()
    return True


def clean(stones, d, k, boulder, reinforce, scales=None):
    """The boulder's own cleanup (assemble_rock): slivers dropped and shallow
    wedges backed (reinforce_chunks), then every acute projecting edge
    bevelled (soften_thin_edges). Adaptive guide stones retain their concavity:
    their recessed core supplies backing without hulling across recesses."""
    bmesh, *_ = _bpy()
    for ob in stones:
        ob.name = "fracture_chunk_" + ob.name  # what reinforce_chunks backs
    parts = [{"name": ob.name, "material": 0} for ob in stones]
    if scales is not None:
        for part,ob in zip(parts,stones):
            part['construction_depth'] = DEPTH/2.6*scales[ob]
            part['preserve_concavity'] = True
    stones = reinforce(stones, parts, {"depth": d})
    for ob in stones:
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bm.normal_update()
        sharp = [e for e in bm.edges if e.is_manifold and e.is_convex
                 and e.calc_face_angle(0) > math.radians(boulder["thinEdgeAngle"])]
        if sharp:
            bmesh.ops.bevel(bm, geom=sharp, offset=boulder["thinEdgeOffset"] * (scales[ob] if scales else k), segments=1,
                            affect="EDGES", clamp_overlap=True, loop_slide=True)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bm.to_mesh(ob.data)
        bm.free()
    return stones


# -- the core -----------------------------------------------------------------

def pillow(ob, voxel, iters, camera=None, power=1.):
    if camera is None:
        fitted._pillow(ob,voxel=voxel,iters=iters)
    else:
        from .construction_lod import finish
        # Keep dense vertices during smoothing; between offset steps OpenVDB
        # can simplify planar areas before the next volume conversion.
        finish(ob,camera,voxel,iterations=iters,smooth=1.,power=power,
               adaptivity=.06 if iters==0 else 0.)


def build_core(bm_solid, scale, collection, report, camera=None):
    """The solid shrunk CORE_INSET (screen metres) inside: the recessed stone
    a fissure shows. It shrinks in CORE_STEPS steps along its normals with a
    voxel remesh after each, which resolves what a step folds over: in one
    step of 0.2 the core folded through itself wherever the solid is thinner
    than that, and the folds faceted into flat fins along the boulders'
    waterlines (Tris, 2026-10-04: "flat planes that jut out"). Where the
    solid is thinner than twice the inset the core is gone; the stones are
    the piece there."""
    bmesh, bpy, _, _, _ = _bpy()
    me = bpy.data.meshes.new("Core")
    bm_solid.to_mesh(me)
    ob = bpy.data.objects.new("Core", me)
    collection.objects.link(ob)
    # Physical inset follows local stone size; sampling follows the local
    # camera budget. A distant median must not erode a thin foreground roof.
    scale = 1. if camera else scale
    pillow(ob, 0.025 * scale, fitted.ROUND, camera)
    _offset(ob, -CORE_INSET * scale, 0.025 * scale, CORE_STEPS, camera)
    if len(ob.data.polygons) < 4:
        return ob
    open_thin(ob, scale, camera)
    # A coarse remesh and the planar dissolve cannot fold; their faces band
    # along the voxel grid, which on stone seen only down the fissures does
    # not show. Faces go as 1 / voxel ** 2, coarsened with depth.
    pillow(ob, CORE_FACET * scale ** (1 + CORE_FALLOFF / 2), 1, camera, 1+CORE_FALLOFF/2)
    d = ob.modifiers.new("planar", "DECIMATE")
    d.decimate_type = "DISSOLVE"
    d.angle_limit = math.radians(fitted.ANGLE)
    d.use_dissolve_boundaries = True
    fitted._apply_modifiers(ob)
    for p in ob.data.polygons:
        p.use_smooth = False
    # A voxel corner of a narrow part can still be sharp.
    unfold(ob)
    drop_scraps(ob, min(camera.scale(v.co.y) for v in ob.data.vertices) if camera and ob.data.vertices else scale)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    report["core sharp"] = len(sharp_edges(bm))
    bm.free()
    return ob


def drop_scraps(ob, scale):
    """Delete the parts of `ob` under SCRAP of its area or under SCRAP_SIZE
    (screen metres) across. Shrinking (the core's inset) leaves scraps where
    the shape narrows; one, a ball 6 cm across, floated in front of the
    waterfall cliff, too small a share of nothing to go by area alone."""
    bmesh, *_ = _bpy()
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    parts, seen = [], set()
    for f in bm.faces:
        if f in seen:
            continue
        part, stack = [], [f]
        seen.add(f)
        while stack:
            g = stack.pop()
            part.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h not in seen:
                        seen.add(h)
                        stack.append(h)
        co = np.array([v.co for g in part for v in g.verts])
        size = float(np.linalg.norm(np.ptp(co, axis=0)))
        parts.append((sum(g.calc_area() for g in part), size, part))
    total = sum(a for a, _, _ in parts)
    scraps = [g for a, size, part in parts if a < SCRAP * total or size < SCRAP_SIZE * scale for g in part]
    if scraps:
        bmesh.ops.delete(bm, geom=scraps, context="FACES")
        bm.to_mesh(ob.data)
    bm.free()


def move_normals(ob, distance, camera):
    from .construction_lod import coordinates
    co = coordinates(ob.data)
    normal = np.empty_like(co)
    ob.data.vertices.foreach_get('normal',normal.ravel())
    sizes = distance*(co[:,1]-camera.eye[1])/camera.distance
    ob.data.vertices.foreach_set('co',(co+normal*sizes[:,None]).ravel())
    ob.data.update()


def _offset(ob, distance, voxel, steps=OPEN_STEPS, camera=None):
    """Move every vertex `distance` along its normal (out if positive), in
    `steps` steps with a voxel remesh after each, which resolves whatever a
    step folds through itself."""
    bmesh, *_ = _bpy()
    if camera:
        # Bound each move by two local nominal voxels. The old fixed five
        # inset + three opening steps repeatedly rebuilt the same core even
        # for an opening radius smaller than one voxel.
        steps = max(1,math.ceil(abs(distance)/(2*voxel)))
    for _ in range(steps):
        if camera:
            move_normals(ob,distance/steps,camera)
        else:
            bm = bmesh.new()
            bm.from_mesh(ob.data)
            bm.normal_update()
            moves = [v.normal * distance / steps for v in bm.verts]
            for v, d in zip(bm.verts, moves):
                v.co += d
            bm.to_mesh(ob.data)
            bm.free()
        pillow(ob, voxel, 0, camera)
        if len(ob.data.polygons) < 4:
            return


def open_thin(ob, scale, camera=None):
    """A morphological opening: shrink by OPEN_RADIUS (screen metres) and grow
    back, so anything thinner than twice that is gone and the mass keeps its
    size."""
    voxel = 0.02 * scale
    _offset(ob, -OPEN_RADIUS * scale, voxel, camera=camera)
    if len(ob.data.polygons) >= 4:
        _offset(ob, OPEN_RADIUS * scale, voxel, camera=camera)


def sharp_edges(bm):
    """Convex edges whose inside angle is under MIN_ANGLE."""
    limit = math.pi - MIN_ANGLE
    return [e for e in bm.edges if e.is_manifold and e.calc_face_angle_signed(0) > limit]


def unfold(ob):
    """Collapse the sharpest convex edges (under MIN_ANGLE inside) to points
    until none is left, and say whether that worked: a fold is a thin fin
    jutting out (Tris, 2026-10-04), and collapsing deletes the sliver rather
    than blunting it. Each try is made on a copy and the first that stays a
    closed surface is kept; a mesh that would lose more than 1 - UNFOLD_KEEP
    of its surface is left as it was."""
    bmesh, *_ = _bpy()
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    area = sum(f.calc_area() for f in bm.faces)
    for _ in range(UNFOLD_MAX):
        bm.normal_update()
        found = sharp_edges(bm)
        if not found:
            break
        found.sort(key=lambda e: -e.calc_face_angle_signed(0))
        bm.edges.index_update()
        for index in [e.index for e in found]:
            trial = bm.copy()
            trial.edges.ensure_lookup_table()
            bmesh.ops.collapse(trial, edges=[trial.edges[index]], uvs=False)
            bmesh.ops.dissolve_degenerate(trial, dist=1e-6, edges=trial.edges[:])
            if trial.faces and all(e.is_manifold for e in trial.edges):
                bm.free()
                bm = trial
                break
            trial.free()
        else:
            break  # no fold here can be collapsed cleanly
    bm.normal_update()
    ok = (not sharp_edges(bm) and all(e.is_manifold for e in bm.edges)
          and sum(f.calc_area() for f in bm.faces) >= UNFOLD_KEEP * area)
    if ok:
        bm.to_mesh(ob.data)
        for p in ob.data.polygons:
            p.use_smooth = False
    bm.free()
    return ok


# -- merging ------------------------------------------------------------------

def _small(ob, f):
    """Whether a cell's piece is a sliver (under SLIVER across some way) or
    a wedge (under FILL of its box)."""
    bmesh, *_ = _bpy()
    co = np.array([v.co for v in ob.data.vertices])
    dims = np.ptp(co, axis=0) / 2
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    volume = bm.calc_volume()
    bm.free()
    return min(dims) < SLIVER * f or volume < FILL * 8 * float(np.prod(dims))


def _volume(ob):
    bmesh, *_ = _bpy()
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    v = bm.calc_volume()
    bm.free()
    return v


def _neighbour(ob, others, reach, bounds=None):
    """The piece among `others` whose box overlaps `ob`'s (grown by `reach`)
    the most, or None."""
    co = np.array([v.co for v in ob.data.vertices])
    lo, hi = co.min(0) - reach, co.max(0) + reach
    if bounds is not None:
        if not len(others):
            return None
        shared = np.clip(np.minimum(hi, bounds[:, 1]) - np.maximum(lo, bounds[:, 0]), 0, None).prod(1)
        index = int(np.argmax(shared))
        return others[index] if shared[index] > 0 else None
    best, most = None, 0.0
    for other in others:
        oc = np.array([v.co for v in other.data.vertices])
        shared = np.clip(np.minimum(hi, oc.max(0)) - np.maximum(lo, oc.min(0)), 0, None).prod()
        if shared > most:
            best, most = other, shared
    return best


def thicken(solid, camera, collection):
    """A copy of `solid` (world coordinates) grown away from the eye: the
    union of it and its camera-facing faces extruded THICKEN (screen metres,
    times their depth) further along their own camera rays. A point moved
    along its ray stays on its pixel, so from the start camera the
    silhouette is exactly the guide's; only the hidden back grows. Where the
    guide is a thin slanted skin seen edge on (the central rock's top left:
    2.6 m along the ray, a few centimetres across it) no stone and no core
    survived, and the outline had a hole the rock behind showed through
    (Tris, 2026-10-04: no gaps); thickened, the skin is a stone like any
    other."""
    bmesh, bpy, _, Vector, _ = _bpy()
    eye = Vector(camera.eye)
    me = solid.data.copy()
    me.transform(solid.matrix_world)
    ob = bpy.data.objects.new("Thickened", me)
    collection.objects.link(ob)
    bm = bmesh.new()
    bm.from_mesh(me)
    if bm.calc_volume(signed=True) < 0:
        raise ValueError(f"{solid.name} is wound inside out")
    bm.normal_update()
    back = [f for f in bm.faces if f.normal.dot(f.calc_center_median() - eye) >= 0]
    bmesh.ops.delete(bm, geom=back, context="FACES")
    ext = bmesh.ops.extrude_face_region(bm, geom=bm.faces[:])
    for v in (g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)):
        v.co = v.co + (v.co - eye).normalized() * THICKEN * camera.scale(v.co.y)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    sme = bpy.data.meshes.new("Thickening")
    bm.to_mesh(sme)
    bm.free()
    slab = bpy.data.objects.new("Thickening", sme)
    _boolean(ob, slab, "UNION")
    bpy.data.objects.remove(slab)
    bpy.data.meshes.remove(sme)
    return ob


def floating(stones, core, water_z=None):
    """The stones that overlap no other stone and not the core, and do not
    stand in the water: a rock hanging free of the mass (Tris, 2026-10-04:
    "there should be no floating rocks")."""
    trees = [_tree(s) for s in stones]
    bounds = []
    for stone in stones:
        co = np.array([v.co[:] for v in stone.data.vertices])
        bounds.append((co.min(0), co.max(0)))
    bounds = np.asarray(bounds)
    core_tree = _tree(core) if len(core.data.polygons) else None
    out = []
    for i, t in enumerate(trees):
        if water_z is not None and min(v.co.z for v in stones[i].data.vertices) < water_z:
            continue
        if core_tree is not None and t.overlap(core_tree):
            continue
        candidates = np.flatnonzero((np.minimum(bounds[i, 1], bounds[:, 1]) >=
                                     np.maximum(bounds[i, 0], bounds[:, 0])).all(1))
        touching = any(t.overlap(trees[j]) for j in candidates if j != i)
        if not touching:
            out.append(stones[i])
    return out


# -- the build ------------------------------------------------------------------

def build(solid, camera, params, collection, water_z=None):
    """The piece as one mesh (unlinked, world coordinates), the objects it
    was made from that are still in `collection`, and its typical scale (the
    stones' median depth over the plane's). `params`: PARAMS (`resolved`)."""
    bmesh, bpy, Matrix, Vector, BVHTree = _bpy()
    p = resolved(params)
    adaptive = camera if p['adaptiveDepth'] else None
    boulder, reinforce, limit_edge_bevel = _boulders()
    rng = np.random.default_rng(int(p["seed"]))
    solid = thicken(solid, camera, collection)
    bm_solid = bmesh.new()
    bm_solid.from_mesh(solid.data)
    surface = BVHTree.FromBMesh(bm_solid)
    report = {"merged": 0, "split": 0, "thickened open": sum(1 for e in bm_solid.edges if not e.is_manifold)}

    def drop(ob):
        me = ob.data
        if ob.name in collection.objects:
            collection.objects.unlink(ob)
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)

    # The cells' pieces of the solid, those with any of its surface.
    cells = Cells(solid, surface, camera, p, boulder, rng, report)
    pieces, curved = [], set()
    todo = cells.ids()
    while todo:
        cid = todo.pop(0)
        box = cells.box(cid)
        if box is None:
            continue
        centre, half = box
        if adaptive and surface.find_nearest(Vector(centre))[3] > float(np.linalg.norm(half)) + ON_SURFACE:
            continue  # wholly inside/outside: no surface stone to cut
        if water_z is not None and centre[2] + max(half) < water_z:
            continue  # under the pool
        ob = cells.cut(bm_solid, cid)
        if ob is None:
            continue
        if not any(surface.find_nearest(v.co)[3] < ON_SURFACE for v in ob.data.vertices):
            drop(ob)
            continue  # wholly inside: the core stands for it
        bends = _curved(ob, surface, half) > math.radians(p["curveTurn"])
        halves = cells.split(cid) if bends else None
        if halves:
            drop(ob)
            todo[:0] = halves
            report["split"] += 1
            continue
        if not adaptive:
            collection.objects.link(ob)
        ob.name = f"Stone {cid}"
        if bends:
            curved.add(ob.name)
        pieces.append((cid, ob, cells.f[cid]))
    # A sliver or a wedge of the solid in a cell would be a spike or a sheet,
    # so it is joined to the neighbour it touches most instead: left out, its
    # corner of the solid had no stone and the deep core showed (Tris,
    # 2026-10-04: no gaps). So is a piece much smaller than the rest of its
    # kind (a curve's stones are a quarter of the rest): a knub.
    volumes = [_volume(q[1]) for q in pieces]
    tiny = set()
    for kind in (True, False):
        own = [(q, v) for q, v in zip(pieces, volumes) if (q[1].name in curved) == kind]
        if own:
            least = p["knub"] * float(np.median([v for _, v in own]))
            tiny |= {id(q) for q, v in own if v < least}
    size_factor = p['stoneSize'] if adaptive else 1.
    small = [q for q in pieces if id(q) in tiny or _small(q[1], q[2]*size_factor)]
    kept = [q for q in pieces if id(q) not in tiny and not _small(q[1], q[2]*size_factor)]
    hosts = [q[1] for q in kept]
    host_indices = {ob: i for i, ob in enumerate(hosts)}
    bounds = []
    for host in hosts:
        co = np.array([v.co[:] for v in host.data.vertices])
        bounds.append((co.min(0), co.max(0)))
    bounds = np.asarray(bounds)
    for cid, ob, f in small:
        host = _neighbour(ob, hosts, CELL_OVERLAP * f * size_factor, bounds)
        if host is not None:
            _boolean(host, ob, "UNION")
            co = np.array([v.co[:] for v in host.data.vertices])
            bounds[host_indices[host]] = co.min(0), co.max(0)
            report["merged"] += 1
        drop(ob)

    # Each stone worked as the boulder works a piece on its top.
    stones, scales = [], []
    for cid, ob, f in kept:
        if work(ob, cells.tapers[cid], surface, boulder, rng, adaptive):
            stones.append(ob)
            scales.append(f)
        else:
            drop(ob)
    scale = float(np.median(scales)) if scales else camera.scale(float(np.mean([v.co.y for v in bm_solid.verts])))
    k = scale * p["stoneSize"]
    if adaptive:
        stones = clean(stones,DEPTH/2.6*k,k,boulder,reinforce,
                       {ob:f*p['stoneSize'] for ob,f in zip(stones,scales)})
    else:
        stones = clean(stones, DEPTH / 2.6 * k, k, boulder, reinforce)
    report["stones"] = len(stones)

    core = build_core(bm_solid, scale, collection, report, adaptive)
    report["floating"] = len(floating(stones, core, water_z))
    core_tree = _tree(core) if len(core.data.polygons) else None

    # The guard: the solid grown by the most a step can rise above it, the
    # half of a ridge spacing at the steepest share of the mean slope.
    rise = (RIDGE_SPACING * DEPTH / 2.6 * k / 2 * (cells.tapers[0]["mean"] - boulder["taperSlopeMin"])
            + CELL_OVERLAP * scale * size_factor) if cells.tapers else 0.0
    guard = grown(solid, rise/scale if adaptive else rise, 0.05 if adaptive else 0.05*scale,
                  collection, "Guard", adaptive)

    # One rock: the core and the stones, then the boulder's finish
    # (blender_build.assemble_rock): remesh, smooth, decimate to its face
    # budget, back inside the guard, the edge bevel.
    # Where the solid is thinner than twice the core's inset there is no
    # core: the stones are the whole piece.
    base = core if len(core.data.polygons) else stones[0]
    rock = bpy.data.objects.new("BackdropRock", base.data.copy())
    collection.objects.link(rock)
    union = bpy.data.collections.new("Stones")
    bpy.context.scene.collection.children.link(union)
    for ob in stones:
        for c in list(ob.users_collection):
            c.objects.unlink(ob)
        union.objects.link(ob)
    _boolean(rock, union, "UNION", collection=True)
    keep_main_body(rock)
    voxel = min(0.04 * 0.30, boulder["voxelCap"])
    if adaptive:
        from .construction_lod import finish, FINISH_ADAPTIVITY
        report['adaptive finish'] = finish(rock,camera,voxel,
            iterations=int(boulder['smoothIterations']),smooth=boulder['smoothFactor'],
            adaptivity=max(FINISH_ADAPTIVITY,boulder['remeshAdaptivity']),density=boulder['faceBudget']/30.)
        keep_main_body(rock)
    else:
        voxel *= scale
        _modifier(rock, "REMESH", mode="VOXEL", voxel_size=voxel, adaptivity=boulder["remeshAdaptivity"])
        keep_main_body(rock)
        _modifier(rock, "SMOOTH", factor=boulder["smoothFactor"], iterations=int(boulder["smoothIterations"]))
        area = sum(q.area for q in rock.data.polygons)
        budget = boulder["faceBudget"] * area / 30.0 / scale ** 2
        _modifier(rock, "DECIMATE", ratio=min(1.0, budget / max(1, len(rock.data.polygons))))
    _boolean(rock, guard, "INTERSECT")
    keep_main_body(rock)
    bpy.context.view_layer.objects.active = rock
    bevel = rock.modifiers.new("edge", "BEVEL")
    bevel.width, bevel.segments = boulder["edgeBevelWidth"] * (1. if adaptive else scale), int(boulder["edgeBevelSegments"])
    rock.data.materials.append(bpy.data.materials.new("rock"))
    rock.data.materials.append(bpy.data.materials.new("worn"))
    bevel.material = 1
    limit_edge_bevel(rock, bevel, math.radians(boulder["edgeBevelAngle"]))
    if adaptive:
        # The validated bevel weights can only shrink: don't spend geometry
        # on an edge strip completely below its nearest High-DOF blur.
        weights = rock.data.attributes.get('bevel_weight_edge')
        if weights:
            for edge, weight in zip(rock.data.edges,weights.data):
                near = min(rock.data.vertices[i].co.y for i in edge.vertices)
                if camera.budget.blur(near-camera.eye[1]-camera.distance) > bevel.width:
                    weight.value = 0.
    fitted._apply_modifiers(rock)
    bm = bmesh.new()
    bm.from_mesh(rock.data)
    triangulate(bm, bm.faces[:])
    bm.to_mesh(rock.data)
    bm.free()
    for q in rock.data.polygons:
        q.use_smooth = False

    # The core's faces are marked, so a check can tell a fissure (core seen)
    # from stone (docs/blender-backdrop.md, measuring the packing).
    marks = [0] * len(rock.data.polygons)
    if core_tree is not None:
        marks = [int(core_tree.find_nearest(q.center)[3] < 2 * voxel * (camera.scale(q.center.y) if adaptive else 1.))
                 for q in rock.data.polygons]
    attr = rock.data.attributes.new(CORE_ATTRIBUTE, "INT", "FACE")
    attr.data.foreach_set("value", marks)

    for ob in list(union.objects):
        drop(ob)
    bpy.data.collections.remove(union)
    for ob in (guard, core):
        drop(ob)
    tme = solid.data
    bpy.data.objects.remove(solid)
    bpy.data.meshes.remove(tme)
    bm_solid.free()
    collection.objects.unlink(rock)
    return rock, [], scale, report


def build_from_recipe(recipe, collection):
    """A solid formation's rock from its recipe (formations/worker.py): the
    guide (rock-local `verts` and `faces`) taken to the world by `frame`,
    cut and worked there, and brought back into the rock's frame. Returns
    the rock and its depth scale."""
    bmesh, bpy, Matrix, Vector, _ = _bpy()
    from . import worker
    given = worker.GENERATORS["solid"]
    if set(given) != set(PARAMS) or any(not math.isclose(given[k], v, abs_tol=1e-9) for k, v in PARAMS.items()):
        raise RuntimeError("worker.GENERATORS['solid'] and solidfit.PARAMS differ")
    frame = Matrix(recipe["frame"])
    guide = recipe["guide"]
    me = bpy.data.meshes.new("Guide")
    me.from_pydata([tuple(v) for v in guide["verts"]], [], [tuple(f) for f in guide["faces"]])
    me.transform(frame)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bm.calc_volume(signed=True) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    open_edges = sum(1 for e in bm.edges if not e.is_manifold)
    bm.to_mesh(me)
    bm.free()
    if open_edges:
        raise ValueError(f"the guide is not a closed mesh ({open_edges} non-manifold edges)")
    solid = bpy.data.objects.new("Guide", me)
    collection.objects.link(solid)
    cam = recipe["camera"]
    camera = Camera(cam["eye"], cam["distance"],cam.get('tanHalf',12/70))
    piece, parts, scale, report = build(solid, camera, recipe["params"], collection, cam.get("waterZ"))
    collection.objects.unlink(solid)
    bpy.data.objects.remove(solid)
    bpy.data.meshes.remove(me)
    print("SOLID_REPORT", report, flush=True)
    back = frame.inverted()
    piece.data.transform(back)
    for part in parts:
        part.data.transform(back)
    return piece, scale
