"""Rock detail: the chips and sub-facets a painted slate rock carries in
its normal map (docs/rock-detail.md).

The game keeps the formation's low poly. At export, scene_export.py builds
a Blender-only HIGH poly from it with `build` and bakes the high poly's
normals onto the low poly's unwrap, so the rock gets:

- SUB-FACETS: every visible plane retriangulated into roughly even triangles
  about SPACING across, each stepped a hair in or out so neighbours tilt
  against each other by TILT degrees. Under the key light each triangle is a
  flat tone; the planes read as a few flat patches the way the reference's
  do, and the shade side stays quiet (facets, below).
- CHIPS: flakes knocked off the convex creases, a boolean cut each, many
  small and few large (chips, below).

Everything here is the 2026-10-03 rock detail study's approved subset
(tools/blender/rock-detail-study: chips.py cycles 1-3, facets.py cycles
10-13), with the numbers Tris picked; the study scripts keep the rejected
branches (chains, bends, cracks, edge wear). The build is deterministic in
the seed: the same low poly and seed give the same high poly.
"""
import math
import random
import time

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import delaunay_2d_cdt
from mathutils.kdtree import KDTree

# ------------------------------------------------------------- sub-facets
# Faces within this angle of a plane's running normal belong to it, degrees.
PLANE_ANGLE = 10.0
# Planes smaller than this (square metres) are left alone.
MIN_AREA = 0.02
# Sub-facet size: the grid's point spacing and the longest boundary stretch
# left unsplit, metres (Tris, cycle 13: 10 cm; 2026-10-03 night: 20 cm, more
# spaced out). Smaller planes get a finer grid down to SPACING_MIN. Grid points jitter by JITTER of the spacing and
# stay MARGIN of it clear of the boundary; a narrow plane the grid misses
# gets one point at its deepest spot if that is DEEPEST clear.
SPACING, SPACING_MIN = 0.20, 0.10
JITTER, MARGIN, DEEPEST = 0.3, 0.45, 0.04
# How far neighbouring triangles tilt against each other, degrees (Tris,
# cycle 13: 0.5 to 1): a point's height is half the spacing times tan(TILT),
# a full step in or out, never a spread (a spread left most neighbours under
# a degree apart and the structure vanished).
TILT = (0.5, 1.0)
# How far out a point may go, metres: the bake's cage is CAGE outside the
# low poly. Any height is allowed inward.
PROUD_MAX = 0.004

# ------------------------------------------------------------------ chips
# Creases: chips start at CREASE_MIN degrees and reach full density at
# CREASE_FULL (the planar dissolve leaves many 20-45 degree edges inside what
# reads as one plane, so the ramp starts well above them).
CREASE_MIN, CREASE_FULL = 18.0, 40.0
# Chips per metre of fully sharp crease, scattered.
DENSITY = 8.0
# Chip length along the crease, metres: a truncated power law, many small
# and few large (Tris, cycle 2: half the first size).
SIZE_MIN, SIZE_MAX, SIZE_POWER = 0.03, 0.175, 1.2
# A chip never runs longer than this times its smaller face's size.
FACE_CAP = 3.0
# The least angle, degrees, between a chip's plane and either face it cuts,
# and the least share of the crease angle on either side (cycle 25: at the
# 8 degree minimum alone, a chip biased toward one face left a sliver a
# quarter as wide as its length on the other, dark along every lit crease;
# with both sides at least BIAS_MIN of the crease the narrow side is about a
# third of the wide one and the flake reads as a notch). The bias toward
# one face stays, up to BIAS_MAX of the crease on the near side: a plane at
# the bisector is a bevel and reads as rounding.
MIN_BITE = 8.0
BIAS_MIN, BIAS_MAX = 0.25, 0.4
# The chip's width on its wider side, as a fraction of its length.
WIDE = (0.4, 0.7)
# A crease folding inward by more than this, degrees, is a valley no chip
# may reach (the cut would leave a wall, a pit).
VALLEY = 3.0

# ------------------------------------------------------------------- bake
# The bake casts from CAGE outside the low poly inward; every chip lies
# inside it, the deepest a few cm, so RAY_DISTANCE only has to cover that.
CAGE, RAY_DISTANCE = 0.005, 0.08


# ================================================================ sub-facets
def plane_regions(bm):
    """Faces grouped into visible planes: grown from the largest face out
    across edges whose far face is within PLANE_ANGLE of the region's
    area-weighted normal; a small region bordered by one large one only (a
    bump or sliver inside a plane) joins it."""
    limit = math.cos(math.radians(PLANE_ANGLE))
    regions, owner = [], {}
    for seed in sorted(bm.faces, key=lambda f: -f.calc_area()):
        if seed in owner:
            continue
        region = [seed]
        owner[seed] = len(regions)
        normal = seed.normal * seed.calc_area()
        stack = [seed]
        while stack:
            f = stack.pop()
            for e in f.edges:
                for g in e.link_faces:
                    if g in owner or g is f:
                        continue
                    if g.normal.dot(normal.normalized()) < limit:
                        continue
                    owner[g] = len(regions)
                    region.append(g)
                    normal += g.normal * g.calc_area()
                    stack.append(g)
        regions.append(region)
    changed = True
    while changed:
        changed = False
        for i, region in enumerate(regions):
            if not region or sum(f.calc_area() for f in region) >= MIN_AREA:
                continue
            around = {owner[g] for f in region for e in f.edges for g in e.link_faces if owner[g] != i}
            if len(around) != 1:
                continue
            j = next(iter(around))
            if sum(f.calc_area() for f in regions[j]) < MIN_AREA:
                continue
            for f in region:
                owner[f] = j
            regions[j].extend(region)
            regions[i] = []
            changed = True
    return [r for r in regions if r]


def boundary_loops(region):
    """The region's boundary as ordered vert lists, one per loop (the outer
    loop and any holes), or None when the region touches itself at a vertex."""
    faces = set(region)
    step = {}
    for f in region:
        for loop in f.loops:
            if sum(1 for g in loop.edge.link_faces if g in faces) == 1:
                a, b = loop.vert, loop.link_loop_next.vert
                if a in step:
                    return None
                step[a] = b
    if not step:
        return None
    loops, seen = [], set()
    for start in step:
        if start in seen:
            continue
        out, v = [], start
        while v is not None and v not in seen:
            seen.add(v)
            out.append(v)
            v = step.get(v)
        if v is not start:
            return None
        loops.append(out)
    return loops


def point_in_polygon(p, poly):
    x, y = p
    inside = False
    for i in range(len(poly)):
        (x0, y0), (x1, y1) = poly[i - 1], poly[i]
        if (y0 > y) != (y1 > y):
            t = (y - y0) / (y1 - y0)
            if x < x0 + t * (x1 - x0):
                inside = not inside
    return inside


def edge_distance(p, poly):
    best = math.inf
    px, py = p
    for i in range(len(poly)):
        (x0, y0), (x1, y1) = poly[i - 1], poly[i]
        dx, dy = x1 - x0, y1 - y0
        ln2 = dx * dx + dy * dy
        t = 0.0 if ln2 == 0 else max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / ln2))
        best = min(best, math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)))
    return best


def grid_points(poly, holes, spacing, rng):
    """Points inside `poly` and outside its `holes` on a hexagonal grid at
    `spacing`, randomly turned and jittered, MARGIN of a spacing clear of the
    boundary; a plane the grid misses gets its deepest point."""
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    lo, hi = (min(xs), min(ys)), (max(xs), max(ys))
    theta = rng.uniform(0, math.pi)
    ca, sa = math.cos(theta), math.sin(theta)
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    reach = math.hypot(hi[0] - lo[0], hi[1] - lo[1]) / 2 + spacing
    rows = int(reach / (spacing * math.sqrt(3) / 2)) + 1
    cols = int(reach / spacing) + 1
    rings = [poly] + holes
    points = []
    for j in range(-rows, rows + 1):
        for i in range(-cols, cols + 1):
            gx = (i + (0.5 if j % 2 else 0.0)) * spacing + rng.uniform(-JITTER, JITTER) * spacing
            gy = j * spacing * math.sqrt(3) / 2 + rng.uniform(-JITTER, JITTER) * spacing
            c = (cx + gx * ca - gy * sa, cy + gx * sa + gy * ca)
            if not point_in_polygon(c, poly) or any(point_in_polygon(c, h) for h in holes):
                continue
            if min(edge_distance(c, r) for r in rings) < MARGIN * spacing:
                continue
            points.append(c)
    if not points:
        best, depth = None, DEEPEST
        for _ in range(300):
            c = (rng.uniform(lo[0], hi[0]), rng.uniform(lo[1], hi[1]))
            if not point_in_polygon(c, poly) or any(point_in_polygon(c, h) for h in holes):
                continue
            d = min(edge_distance(c, r) for r in rings)
            if d > depth:
                best, depth = c, d
        if best is not None:
            points.append(best)
    return points


def split_long_edges(bm, spacing):
    """Cut every edge longer than 1.5 spacings into pieces no longer than a
    spacing, in both faces it borders, so the mesh stays closed and no
    boundary stretch fans into long thin triangles."""
    by_cuts = {}
    for e in bm.edges:
        n = int(e.calc_length() / spacing)
        if e.calc_length() > 1.5 * spacing and n >= 1:
            by_cuts.setdefault(n, []).append(e)
    for n, edges in by_cuts.items():
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=n, use_grid_fill=False)
    return sum(len(v) for v in by_cuts.values())


def crumple(src, rng):
    """A copy of `src` whose visible planes are retriangulated into tilted
    sub-facets; returns (bmesh, stats dict)."""
    bm = src.copy()
    stats = {"planes": 0, "rebuilt": 0, "points": 0, "skipped": 0, "area": 0.0, "skipped_area": 0.0}
    stats["split"] = split_long_edges(bm, SPACING)
    bm.normal_update()
    jobs = []
    for region in plane_regions(bm):
        area = sum(f.calc_area() for f in region)
        stats["area"] += area
        if area < MIN_AREA:
            continue
        stats["planes"] += 1
        loops = boundary_loops(region)
        if loops is None:
            stats["skipped"] += 1
            stats["skipped_area"] += area
            continue
        normal = sum((f.normal * f.calc_area() for f in region), Vector()).normalized()
        jobs.append((region, loops, area, normal))

    for region, loops, area, normal in jobs:
        origin = sum((v.co for lp in loops for v in lp), Vector()) / sum(len(lp) for lp in loops)
        u = normal.orthogonal().normalized()
        w = normal.cross(u).normalized()

        def project(lp):
            return [((v.co - origin).dot(u), (v.co - origin).dot(w)) for v in lp]

        def signed_area(poly):
            return sum(poly[i - 1][0] * poly[i][1] - poly[i][0] * poly[i - 1][1] for i in range(len(poly)))

        # The outer loop encloses the most area; make it CCW in (u, w) so
        # u x w = normal and the new faces face outward.
        polys = [project(lp) for lp in loops]
        order = sorted(range(len(loops)), key=lambda i: -abs(signed_area(polys[i])))
        loops, polys = [loops[i] for i in order], [polys[i] for i in order]
        if signed_area(polys[0]) < 0:
            loops, polys = [lp[::-1] for lp in loops], [pl[::-1] for pl in polys]
        poly, holes = polys[0], polys[1:]
        loop = [v for lp in loops for v in lp]
        spacing = max(min(SPACING_MIN, SPACING), min(SPACING, 0.5 * math.sqrt(area)))
        points = grid_points(poly, holes, spacing, rng)
        if not points:
            stats["skipped"] += 1
            stats["skipped_area"] += area
            continue
        boundary = [Vector(p) for pl in polys for p in pl]
        coords = boundary + [Vector(p) for p in points]
        rings, at = [], 0
        for pl in polys:
            rings.append(list(range(at, at + len(pl))))
            at += len(pl)
        verts2d, _, faces2d, orig_verts, _, _ = delaunay_2d_cdt(coords, [], rings, 1, 1e-7)
        if holes:
            def centroid(face):
                return (sum(verts2d[i].x for i in face) / len(face), sum(verts2d[i].y for i in face) / len(face))
            faces2d = [f for f in faces2d if not any(point_in_polygon(centroid(f), h) for h in holes)]
        if not faces2d:
            stats["skipped"] += 1
            stats["skipped_area"] += area
            continue
        new_pts = {}
        for i, p in enumerate(points):
            tilt = math.radians(rng.uniform(*TILT))
            depth = rng.choice((-1.0, 1.0)) * 0.5 * spacing * math.tan(tilt)
            new_pts[len(boundary) + i] = origin + u * p[0] + w * p[1] + normal * min(depth, PROUD_MAX)
        # A boundary that crosses itself once projected (a zigzag of
        # sub-millimetre dissolve slivers) makes the CDT invent crossing
        # vertices (no source) or triangles a neighbour already owns; such a
        # plane is left as it is.
        in_region = set(region)
        verts, ok = [], True
        for srcs in orig_verts:
            if not srcs:
                ok = False
                break
            s = srcs[0]
            verts.append(loop[s] if s < len(boundary) else new_pts[s])
        new_faces = []
        if ok:
            for face in faces2d:
                vs = [verts[i] for i in face]
                if len(set(map(id, vs))) < 3:
                    continue
                existing = [v for v in vs if isinstance(v, bmesh.types.BMVert)]
                if len(existing) == 3:
                    old = bm.faces.get(existing)
                    if old is not None and old not in in_region:
                        ok = False
                        break
                new_faces.append(vs)
        if not ok or not new_faces:
            stats["skipped"] += 1
            stats["skipped_area"] += area
            continue
        bmesh.ops.delete(bm, geom=region, context="FACES")
        created = {}
        for vs in new_faces:
            bm.faces.new([v if isinstance(v, bmesh.types.BMVert) else created.setdefault(id(v), bm.verts.new(v)) for v in vs])
        stats["rebuilt"] += 1
        stats["points"] += len(points)
    bm.normal_update()
    return bm, stats


# ===================================================================== chips
def power_size(rng):
    a = SIZE_POWER
    u = rng.random()
    lo, hi = SIZE_MIN ** -a, SIZE_MAX ** -a
    return (lo + u * (hi - lo)) ** (-1 / a)


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def inside(bvh, pt):
    loc, normal, _, _ = bvh.find_nearest(pt)
    return loc is not None and (pt - loc).dot(normal) < 0


def add_hull(bm, pts):
    """Add the convex hull of `pts` to `bm` as one closed piece."""
    one = bmesh.new()
    for q in pts:
        one.verts.new(q)
    hull = bmesh.ops.convex_hull(one, input=one.verts)
    loose = {g for g in hull["geom_interior"] + hull["geom_unused"] if isinstance(g, bmesh.types.BMVert)}
    bmesh.ops.delete(one, geom=list(loose), context="VERTS")
    index = {}
    for v in one.verts:
        index[v] = bm.verts.new(v.co)
    for f in one.faces:
        bm.faces.new([index[v] for v in f.verts])
    one.free()


def cutter(bm, bvh, valleys, p, n, d, a1, a2, wide, h):
    """One flake: the part of the rock above BOTH of two planes through the
    chip's deepest point (p - n h), each tipped along the crease so it comes
    back out of the rock at one end (a1 toward +d, a2 toward -d), so the chip
    closes at both ends with no walls. The cutter is a box clipped by the two
    planes, as a convex hull. Returns False, adding nothing, when it would
    reach into another part of the rock or into a valley."""
    b = n.cross(d).normalized()
    deep = p - n * h
    n1 = (n - d * (h / a1)).normalized()
    n2 = (n + d * (h / a2)).normalized()
    W = wide * 1.6 + h
    L = max(a1, a2) * 1.3
    H = h + max(a1, a2)
    pts = [deep + d * x + b * y + n * z for x in (-L, L) for y in (-W, W) for z in (-h * 0.5, H)]
    planes = [(n1, n1.dot(deep)), (n2, n2.dot(deep))]
    for nn, c in planes:
        out = [q for q in pts if nn.dot(q) >= c - 1e-9]
        for i, q1 in enumerate(pts):
            for q2 in pts[i + 1:]:
                d1, d2 = nn.dot(q1) - c, nn.dot(q2) - c
                if (d1 < 0) != (d2 < 0):
                    out.append(q1.lerp(q2, d1 / (d1 - d2)))
        pts = out
    pts = [q for q in pts if all(nn.dot(q) >= c - 1e-6 for nn, c in planes)]
    probes = [q for q in pts if n.dot(q - p) > 0]
    if len(pts) < 4 or any(inside(bvh, q) for q in probes):
        return False
    for q, _, _ in valleys.find_range(deep, math.hypot(L, W, H)):
        r = q - deep
        if (all(nn.dot(q) > c + 1e-5 for nn, c in planes)
                and abs(r.dot(d)) < L and abs(r.dot(b)) < W and -h * 0.5 < r.dot(n) < H):
            return False
    add_hull(bm, pts)
    return True


def valley_points(bm, step=0.01):
    """Points every `step` m along every concave crease folding in by more
    than VALLEY degrees, in a KD tree."""
    pts = []
    for e in bm.edges:
        if e.is_manifold and math.degrees(e.calc_face_angle_signed(0)) < -VALLEY:
            v0, v1 = e.verts[0].co, e.verts[1].co
            k = max(1, int(e.calc_length() / step))
            pts.extend(v0.lerp(v1, i / k) for i in range(k + 1))
    tree = KDTree(len(pts))
    for i, q in enumerate(pts):
        tree.insert(q, i)
    tree.balance()
    return tree


def build_cutters(rock_bm, rng):
    """Chips on the convex creases, as one bmesh of closed cutters. Each chip
    keeps its ends on its crease, never reaches a concave crease, and never
    overlaps a chip from another crease (a deeper chip in a shallower one
    digs a pocket). Returns (cutters, placed, rejected)."""
    rock_bm.edges.index_update()
    bvh = BVHTree.FromBMesh(rock_bm)
    valleys = valley_points(rock_bm)
    cut = bmesh.new()
    count = rejected = 0
    placed = []
    for e in rock_bm.edges:
        if not e.is_manifold:
            continue
        ang = math.degrees(e.calc_face_angle_signed(0))
        weight = smoothstep(CREASE_MIN, CREASE_FULL, ang)
        if weight <= 0:
            continue
        length = e.calc_length()
        f1, f2 = e.link_faces
        cap = FACE_CAP * min(math.sqrt(f1.calc_area()), math.sqrt(f2.calc_area()))
        v0, v1 = e.verts[0].co, e.verts[1].co
        d = (v1 - v0).normalized()
        phi = math.radians(ang)
        lo = min(0.5, max(BIAS_MIN, math.radians(MIN_BITE) / phi))
        expected = length * DENSITY * weight
        for _ in range(int(expected) + (1 if rng.random() < expected % 1 else 0)):
            s = min(power_size(rng), cap * 2)
            if s > length or s < SIZE_MIN * 0.7:
                continue
            x0 = rng.uniform(0, length - s)
            a2 = s * rng.uniform(0.25, 0.75)
            a1 = s - a2
            p = v0 + d * (x0 + a2)
            # Biased toward one face: a plane near the bisector is a bevel
            # and reads as rounding, not as a flake knocked off.
            t = rng.uniform(lo, max(lo, BIAS_MAX))
            if rng.random() < 0.5:
                t = 1 - t
            n = f1.normal.slerp(f2.normal, t).normalized()
            theta = min(t, 1 - t) * phi
            wide = s * rng.uniform(*WIDE)
            h = wide * math.sin(theta)
            reach = max(a1, a2, wide)
            if any(i != e.index and (p - q).length < reach + r for q, r, i in placed):
                rejected += 1
                continue
            if cutter(cut, bvh, valleys, p, n, d, a1, a2, wide, h):
                placed.append((p, reach, e.index))
                count += 1
            else:
                rejected += 1
    return cut, count, rejected


def loose_parts(bm):
    """One bmesh per connected piece of `bm`."""
    bm.faces.index_update()
    parts, seen = [], set()
    for f in bm.faces:
        if f.index in seen:
            continue
        group, stack = [], [f]
        while stack:
            g = stack.pop()
            if g.index in seen:
                continue
            seen.add(g.index)
            group.append(g)
            stack.extend(h for e in g.edges for h in e.link_faces)
        one = bmesh.new()
        index = {}
        for g in group:
            for v in g.verts:
                if v not in index:
                    index[v] = one.verts.new(v.co)
            one.faces.new([index[v] for v in g.verts])
        parts.append(one)
    return parts


def mesh_object(name, bm, coll):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    return ob


def subtract(bm, cutter_bm, coll, name):
    """`bm` minus every cutter, each its own object (joined, overlapping
    cutters made a self-intersecting mesh and the solver left fragments
    standing in the chips), with the manifold boolean solver. Returns the
    result as an object in `coll` (its temporaries removed)."""
    cutters = bpy.data.collections.new(f"{name} cutters")
    parts = loose_parts(cutter_bm)
    for i, part in enumerate(parts):
        mesh_object(f"{name} cutter {i}", part, cutters)
        part.free()
    ob = mesh_object(name, bm, coll)
    if parts:
        mod = ob.modifiers.new(name, "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "MANIFOLD"
        mod.operand_type = "COLLECTION"
        mod.collection = cutters
        coll.children.link(cutters)
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        coll.children.unlink(cutters)
        ob.modifiers.clear()
        old = ob.data
        ob.data = me
        bpy.data.meshes.remove(old)
    for c in list(cutters.objects):
        me = c.data
        bpy.data.objects.remove(c)
        bpy.data.meshes.remove(me)
    bpy.data.collections.remove(cutters)
    return ob


# ===================================================================== build
def build(mesh, seed, coll, name="detail"):
    """The detail high poly of `mesh` (a Mesh, in its own local space): the
    sub-facets, then the chips cut into them along the ORIGINAL creases.
    Returns (object linked in `coll`, a one-line report). The caller sets
    its transform and removes it after the bake."""
    t0 = time.time()
    low = bmesh.new()
    low.from_mesh(mesh)
    # A rock that came in through glTF is split at every face; the chips
    # need creases, so weld the bake source (the shipped mesh is untouched).
    bmesh.ops.remove_doubles(low, verts=low.verts, dist=1e-5)
    low.normal_update()
    rng = random.Random(seed)
    cut, placed, rejected = build_cutters(low, random.Random(seed))
    crumpled, stats = crumple(low, random.Random(seed + 3000))
    high = subtract(crumpled, cut, coll, name)
    for poly in high.data.polygons:
        poly.use_smooth = False
    crumpled.free()
    cut.free()
    low.free()
    flat = 100 * stats["skipped_area"] / max(stats["area"], 1e-9)
    report = (f"{stats['rebuilt']} of {stats['planes']} planes into {stats['points']} sub-facet points "
              f"({flat:.0f}% of the surface left flat), {placed} chips ({rejected} rejected), "
              f"{len(high.data.polygons)} faces, {time.time() - t0:.1f}s")
    return high, report
