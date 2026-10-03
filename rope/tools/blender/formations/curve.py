"""Curved creases: no long crease of a formation runs dead straight (Tris,
2026-10-03: "Long straight edges should be slightly curved").

A formation's mesh is a planar dissolve triangulated as fans, so a long
crease is one or a few long edges with nothing inside the planes either side
to bend. `find_bows` finds the long, nearly straight convex creases;
`rebuild_mesh` triangulates the surface around them afresh, in well-shaped
triangles sized to the curve (points on the existing surface, so nothing
moves yet), and `bend` then bows each crease: every vertex near it moves along
the crease's bisector (out of the rock or into it, by the seed) by

    BOW x length x sin(pi t) x smoothstep(1 - d / reach)

where t runs 0 to 1 along the crease, d is the distance from it and reach is
REACH x its length. The ends stay put, so the corners do; the planes either
side bend into the curve instead of the crease kinking. The silhouette bends
with it, which no normal map can do.

The export rebuilds its copy of the shipped mesh (`rebuild_mesh`) before the
unwrap, bakes every map on the STRAIGHT rock, and only then bends it
(`bend`): the detail high poly (formations/detail.py) is built from the
straight rock and never bent, so it lines up with the rock exactly for the
bake, and the maps' UVs and tangent space move with the vertices. Bending
both and baking between them did not line up: each was fitted to the curve
only to within its own tolerance, the bake's rays near a crease hit the
other face of the high poly, and the edge highlight landed beside the edge
with the chips' floors as dark dashes (and, fitted coarsely, a long fold of
the high poly drew a dark diagonal band). Never on the scene file's own mesh: the rock in Blender keeps
its straight edges and its growth's planting. Collision is the editor's and is untouched.
"""

import itertools
import math
import random

import bmesh
import numpy as np
from mathutils import Vector

# A crease: an edge whose faces turn by at least CREASE degrees (convex).
CREASE = 20.0
# Edges whose direction turns less than JOIN degrees at a vertex are one crease.
JOIN = 20.0
# Creases at least LONG metres chord, and STRAIGHT chord over arc, are curved.
LONG, STRAIGHT = 0.4, 0.97
# The bow: a share of the crease's length (drawn per crease), at most MAX_BOW
# (Tris picked about 3 % over 6 and 12, then switched to about 6 %; the cap
# only stops a freak long crease, the Terrace's 2.7 m one bows about 16 cm).
BOW, MAX_BOW = (0.05, 0.07), 0.2
# How far either side of the crease the bend reaches, as a share of its length.
REACH, MIN_REACH = 0.4, 0.1
# The bent planes are shaded smooth across folds under SMOOTH_ANGLE degrees,
# sharp above it (the creases are 20 and up). Flat shaded, a bent plane's
# long sliver triangles fold by a degree or two each and the key light draws
# every fold as a line across the face.
SMOOTH_ANGLE = 5.0
# Triangles are sized so the bow bends each edge by about TOLERANCE metres in
# its middle (the Delaunay's edges run to about 1.5 sizes, so up to 6 mm on
# the Terrace). Before the rebuild (`rebuild`) the fans' edges were split
# until under it, and at 4 mm a long sliver still folded into a dark slit;
# on well-shaped triangles a few millimetres is only the curve's faceting,
# shaded smooth.
TOLERANCE = 0.002
# Slivers shorter than this are merged on the copy the creases are found on.
WELD = 0.005
# Before the split, every patch the bows reach is triangulated afresh (see
# `rebuild`): points closer than MERGE are merged first (the dissolve's
# zero-area faces); a patch is faces joined across folds under SMOOTH_ANGLE
# (the shading is smooth across them already), all within PATCH degrees of
# its largest; its triangles are about as wide as long, their size the
# longest the bow bends by under TOLERANCE, clamped to SIZE.
MERGE, PATCH, SIZE = 0.0005, 10.0, (0.04, 0.3)
# A triangle under SLIVER high over its longest edge is folded away first
# (`fold_slivers`): its far corner moves onto that edge, at most SLIVER.
SLIVER = 0.0015


def smoothstep(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def crease_runs(bm):
    """Convex creases as vertex chains, joined where the crease turns by less
    than JOIN: lists of (vert, vert, ...) with each pair an edge."""
    sharp = {e for e in bm.edges if e.is_manifold and math.degrees(e.calc_face_angle_signed(0)) >= CREASE}

    def nxt(e, v):
        d = (v.co - e.other_vert(v).co).normalized()
        best, turn = None, math.radians(JOIN)
        for f in v.link_edges:
            if f is not e and f in sharp:
                a = d.angle((f.other_vert(v).co - v.co).normalized(), math.pi)
                if a < turn:
                    best, turn = f, a
        return best

    runs, used = [], set()
    # In index order: a set's order changes from run to run, and the walk's
    # order decides how creases join and which bow draws which numbers.
    for e in sorted(sharp, key=lambda e: e.index):
        if e in used:
            continue
        # Back to one end, then forward to the other.
        ce, cv = e, e.verts[0]
        seen = {e}
        while (f := nxt(ce, cv)) is not None and f not in seen and f not in used:
            seen.add(f)
            cv = f.other_vert(cv)
            ce = f
        # cv is now the crease's far end, on ce.
        chain, edges = [cv], []
        while ce is not None and ce not in used:
            used.add(ce)
            edges.append(ce)
            cv = ce.other_vert(cv)
            chain.append(cv)
            ce = nxt(ce, cv)
        runs.append((chain, edges))
    return runs


def segment_distance(p, a, b):
    """(distance from p to segment ab, t of the nearest point in [0, 1])."""
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-12)))
    return (p - (a + ab * t)).length, t


def find_bows(mesh, seed):
    """The bows for `mesh`'s long straight creases, drawn from `seed`: a list
    of (start, end, offset at the middle, reach)."""
    rng = random.Random(seed)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=WELD)
    bm.normal_update()
    bows = []
    for chain, edges in crease_runs(bm):
        a, b = chain[0].co.copy(), chain[-1].co.copy()
        chord = (b - a).length
        arc = sum(e.calc_length() for e in edges)
        if chord < LONG or chord < STRAIGHT * arc:
            continue
        out = Vector()
        for e in edges:
            for f in e.link_faces:
                out += f.normal * e.calc_length()
        # Out of the rock along the bisector, kept square to the crease.
        u = (b - a) / chord
        out = (out - u * out.dot(u)).normalized()
        amount = min(MAX_BOW, rng.uniform(*BOW) * chord) * rng.choice((-1.0, 1.0))
        bows.append((a, b, out * amount, max(MIN_REACH, REACH * chord)))
    bm.free()
    return bows


def field(points, bows):
    """The bow field at `points` (an N x 3 array): how far the bows move each."""
    off = np.zeros_like(points)
    if not len(points):
        return off
    lo, hi = points.min(axis=0), points.max(axis=0)
    for a, b, bow, reach in bows:
        a, b, bow = np.array(a), np.array(b), np.array(bow)
        # A bow whose reach misses the points' bounds moves none of them.
        if (np.minimum(a, b) - reach > hi).any() or (np.maximum(a, b) + reach < lo).any():
            continue
        ab = b - a
        t = np.clip((points - a) @ ab / max(ab @ ab, 1e-12), 0.0, 1.0)
        d = np.linalg.norm(points - (a + t[:, None] * ab), axis=1)
        x = np.clip(1 - d / reach, 0.0, 1.0)
        off += (np.sin(np.pi * t) * x * x * (3 - 2 * x))[:, None] * bow
    return off


def sizing(points, bows):
    """The triangle size at `points` (N x 3): the longest edge the bow field
    bends by under TOLERANCE in its middle, from the field's second
    difference along the axes and the face and body diagonals (13 ways an
    edge can run; the axes alone missed the bend across them by up to 4x),
    clamped to SIZE; SIZE's top where the field is flat."""
    step = 0.02
    bend = np.zeros(len(points))
    mid = field(points, bows)
    ways = [np.array(w, dtype=float) for w in itertools.product((-1, 0, 1), repeat=3) if w > (0, 0, 0)]
    for way in ways:
        way = way / np.linalg.norm(way)
        d2 = field(points + way * step, bows) - 2 * mid + field(points - way * step, bows)
        bend = np.maximum(bend, np.linalg.norm(d2, axis=1) / step ** 2)
    # An edge of length L bends by about bend x L^2 / 8 in its middle.
    return np.clip(np.sqrt(8 * TOLERANCE / np.maximum(bend, 1e-9)), *SIZE)


def patches(bm, reached):
    """The faces in `reached` grouped into patches: grown from the largest
    face across folds under SMOOTH_ANGLE to faces within PATCH degrees of it.
    The formation's planar dissolve joins faces within 9 degrees
    (formations/fitted.py), so its fans are not flat: grouped within a
    degree, most "planes" were a single sliver, and a sliver alone cannot be
    triangulated into anything but itself."""
    fold = math.cos(math.radians(SMOOTH_ANGLE))
    limit = math.cos(math.radians(PATCH))
    planes, owner = [], set()
    for seed in sorted(reached, key=lambda f: (-f.calc_area(), f.index)):
        if seed in owner:
            continue
        plane, stack = [seed], [seed]
        owner.add(seed)
        while stack:
            f = stack.pop()
            for e in f.edges:
                for g in e.link_faces:
                    if (g in owner or g not in reached or g.normal.dot(f.normal) < fold
                            or g.normal.dot(seed.normal) < limit):
                        continue
                    owner.add(g)
                    plane.append(g)
                    stack.append(g)
        planes.append(plane)
    return planes


def fold_slivers(bm, passes=8):
    """Fold away every triangle under SLIVER high over its longest edge: its
    far corner moves onto that edge (by at most SLIVER) and the edge turns
    to run from that corner to the neighbour's (`edge_rotate`). With the
    corner on the edge the two faces either side are coplanar pieces of the
    neighbour, so the surface and the creases stay where they were; the
    sliver, which no triangulation of its patch can help (it IS the patch:
    the dissolve leaves them lying along creases, a fraction of a millimetre
    off), is gone. A needle, its far corner within SLIVER of an end of the
    edge, is welded into that end instead. Returns how many were folded."""
    folded = 0
    for _ in range(passes):
        done, touched, weld = 0, set(), {}
        for f in list(bm.faces):
            if not f.is_valid or len(f.verts) != 3 or touched & set(f.verts):
                continue
            e = max(f.edges, key=lambda e: e.calc_length())
            if len(e.link_faces) != 2:
                continue
            a, b = e.verts
            apex = next(v for v in f.verts if v is not a and v is not b)
            ab = b.co - a.co
            t = (apex.co - a.co).dot(ab) / ab.length_squared
            foot = a.co + ab * t
            if (apex.co - foot).length >= SLIVER:
                continue
            # A needle, its corner beside one end: merged into that end.
            end = a if t * ab.length < SLIVER else b if (1 - t) * ab.length < SLIVER else None
            if end is not None:
                weld[apex] = end
                touched |= {a, b, apex}
                done += 1
                continue
            other = next(g for g in e.link_faces if g is not f)
            if len(other.verts) != 3:
                continue
            x = next(v for v in other.verts if v is not a and v is not b)
            # The turned edge would be a second edge between the two.
            if bm.edges.get((apex, x)) is not None:
                continue
            was, apex.co = apex.co.copy(), foot
            if bmesh.utils.edge_rotate(e, True) is None:
                apex.co = was
                continue
            touched |= {a, b, apex, x}
            done += 1
        bmesh.ops.weld_verts(bm, targetmap=weld)
        folded += done
        if not done:
            break
    bm.normal_update()
    return folded


def rebuild(bm, bows, seed):
    """Triangulate every plane the bows reach afresh, in place. The shipped
    mesh is a planar dissolve's fans: long slivers from one corner to the far
    side, each meeting its neighbour at a fraction of a degree, and a few
    zero-area faces. Bent, the field moves a sliver's three corners by
    different amounts and the thin ones turn over (the Terrace: about 280
    visible faces turned by more than 30 degrees), each a dark or pale slit
    across the face. Splitting the fans' edges finer only cuts them into
    shorter slivers; patching them (beautify, collapsing the needles) re-cut
    edges across the creases and broke the silhouette.

    So each plane's boundary is cut into pieces no longer than `sizing`, its
    inside filled with points on a jittered grid at that size (as
    formations/detail.py's sub-facets are), and the whole constrained-
    Delaunay triangulated: no boundary point moves, so the creases and the
    silhouette are exactly what they were. A plane whose boundary touches
    itself, or whose triangulation does not come back clean, keeps its fans.
    Returns (patches rebuilt, patches kept, slivers folded)."""
    from formations import detail  # noqa: E402 (bpy-only module)
    from mathutils.bvhtree import BVHTree
    from mathutils.kdtree import KDTree
    from mathutils.geometry import delaunay_2d_cdt

    rng = random.Random(seed)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=MERGE)
    bm.normal_update()
    folded = fold_slivers(bm)

    def size_at(points):
        return sizing(np.array(points, dtype=float).reshape(-1, 3), bows)

    def reaches(points):
        return np.linalg.norm(field(np.array(points, dtype=float).reshape(-1, 3), bows), axis=1) > 1e-6

    # Cut the edges the field reaches into pieces no longer than the size at
    # them, in both faces either side, so the mesh stays closed.
    edges = [e for e in bm.edges if len(e.link_faces) == 2]
    ends = np.array([[e.verts[0].co, e.verts[1].co] for e in edges], dtype=float)
    samples = ends[:, :1] + (ends[:, 1:] - ends[:, :1]) * np.linspace(0, 1, 5)[None, :, None]
    flat = samples.reshape(-1, 3)
    hit = reaches(flat).reshape(len(edges), 5).any(axis=1)
    size = size_at(flat).reshape(len(edges), 5).min(axis=1)
    by_cuts = {}
    for e, h, s in zip(edges, hit, size):
        n = math.ceil(e.calc_length() / s) - 1
        if h and n >= 1:
            by_cuts.setdefault(n, []).append(e)
    # Only the edges: the faces either side become n-gons until their patch
    # is made again. Splitting the faces too fans each cut edge from the far
    # corner, and a quad cut along its straight side is a zero-area triangle.
    for n, cut in sorted(by_cuts.items()):
        bmesh.ops.bisect_edges(bm, edges=cut, cuts=n)
    bm.normal_update()

    faces = list(bm.faces)
    corners = [[*(v.co for v in f.verts), f.calc_center_median()] for f in faces]
    hit = reaches([p for c in corners for p in c])
    starts = np.cumsum([0] + [len(c) for c in corners[:-1]])
    # A face with a cut edge is rebuilt even where only the edge is reached:
    # left an n-gon, the triangulation below may join both ends of its cut
    # edge, a zero-area triangle and a second face on that edge.
    reached = {f for f, h in zip(faces, np.logical_or.reduceat(hit, starts)) if h or len(f.verts) > 3}
    jobs, claimed, kept = [], set(), 0
    for plane in patches(bm, reached):
        loops = detail.boundary_loops(plane)
        if loops is None:
            kept += 1
            continue
        normal = sum((f.normal * f.calc_area() for f in plane), Vector()).normalized()
        origin = sum((v.co for lp in loops for v in lp), Vector()) / sum(len(lp) for lp in loops)
        u = normal.orthogonal().normalized()
        w = normal.cross(u).normalized()

        def project(lp):
            return [((v.co - origin).dot(u), (v.co - origin).dot(w)) for v in lp]

        def signed_area(poly):
            return sum(poly[i - 1][0] * poly[i][1] - poly[i][0] * poly[i - 1][1] for i in range(len(poly)))

        # The outer loop encloses the most area; CCW in (u, w) so the new
        # faces face out.
        polys = [project(lp) for lp in loops]
        order = sorted(range(len(loops)), key=lambda i: -abs(signed_area(polys[i])))
        loops, polys = [loops[i] for i in order], [polys[i] for i in order]
        if signed_area(polys[0]) < 0:
            loops, polys = [lp[::-1] for lp in loops], [pl[::-1] for pl in polys]
        # A hole wound the same way as the outside is a boundary that folds
        # over itself once projected.
        if any(signed_area(pl) > 0 for pl in polys[1:]):
            kept += 1
            continue
        loop = [v for lp in loops for v in lp]
        h = float(size_at([v.co for v in loop] + [f.calc_center_median() for f in plane]).min())
        inside = detail.grid_points(polys[0], polys[1:], h, rng)
        # grid_points falls back to the deepest point of a plane its grid
        # misses; a plane under one size across needs no point inside.
        if inside and min(detail.edge_distance(inside[0], pl) for pl in polys) < detail.MARGIN * h:
            inside = []
        # The grid is at the patch's smallest size; where the field bends
        # less, points are thinned out to the size there (smallest first),
        # and kept MARGIN of that size clear of the boundary, whose pieces
        # are cut to the same size.
        if inside:
            local = size_at([origin + u * p[0] + w * p[1] for p in inside])
            kept_pts, tree2d = [], KDTree(len(inside))
            for i in np.argsort(local, kind="stable"):
                p, s = inside[i], float(local[i])
                if s > h and min(detail.edge_distance(p, pl) for pl in polys) < detail.MARGIN * s:
                    continue
                near = tree2d.find((p[0], p[1], 0.0)) if kept_pts else None
                if near is not None and near[2] < 0.85 * s:
                    continue
                tree2d.insert((p[0], p[1], 0.0), len(kept_pts))
                tree2d.balance()
                kept_pts.append(p)
            inside = kept_pts
        coords = [Vector(p) for pl in polys for p in pl] + [Vector(p) for p in inside]
        rings, at = [], 0
        for pl in polys:
            rings.append(list(range(at, at + len(pl))))
            at += len(pl)
        verts2d, _, faces2d, orig_verts, _, _ = delaunay_2d_cdt(coords, [], rings, 1, 1e-7)
        if len(polys) > 1:
            def centroid(face):
                return (sum(verts2d[i].x for i in face) / len(face), sum(verts2d[i].y for i in face) / len(face))
            faces2d = [f for f in faces2d if not any(detail.point_in_polygon(centroid(f), pl) for pl in polys[1:])]
        # The inside points go onto the patch's own faces, not the fitted
        # plane, so the surface stays where it was.
        starts = np.cumsum([0] + [len(f.verts) for f in plane[:-1]])
        tree = BVHTree.FromPolygons([v.co for f in plane for v in f.verts],
                                    [range(at, at + len(f.verts)) for at, f in zip(starts, plane)])
        verts, ok = [], len(orig_verts) == len(coords)
        for srcs in orig_verts if ok else ():
            if len(srcs) != 1:
                ok = False
                break
            s = srcs[0]
            if s < len(loop):
                verts.append(loop[s])
            else:
                p = inside[s - len(loop)]
                verts.append(tree.find_nearest(origin + u * p[0] + w * p[1])[0])
        in_plane = set(plane)
        new_faces, keys = [], set()
        for face in faces2d if ok else ():
            vs = [verts[i] for i in face]
            existing = [v for v in vs if isinstance(v, bmesh.types.BMVert)]
            if len(existing) == 3:
                # A triangle a neighbour already has, or will have once
                # rebuilt, would be a second face on the same three points.
                key = frozenset(existing)
                if ((old := bm.faces.get(existing)) is not None and old not in in_plane) or key in claimed:
                    ok = False
                    break
                keys.add(key)
            new_faces.append(vs)
        area = sum(abs(signed_area(project(f.verts))) / 2 for f in plane)
        made = sum(abs(signed_area([(verts2d[i].x, verts2d[i].y) for i in face])) / 2 for face in faces2d)
        if not ok or not new_faces or abs(made - area) > 1e-3 * area + 1e-6:
            kept += 1
            continue
        claimed |= keys
        # Each new face takes the attributes (the facet tone, the chamfer
        # strip), material and shading of the old face under its middle.
        under = [plane[tree.find_nearest(sum((v.co if isinstance(v, bmesh.types.BMVert) else v for v in vs),
                                             Vector()) / 3)[2]] for vs in new_faces]
        jobs.append((plane, new_faces, under))

    # Every patch goes in one delete: each delete walks the whole mesh.
    # Templates keep the old faces' attributes, which the delete frees.
    templates = {}
    for _, _, under in jobs:
        for old in under:
            if old not in templates:
                t = bm.faces.new([bm.verts.new(c) for c in ((0, 0, 0), (1, 0, 0), (0, 1, 0))], old)
                templates[old] = (t, old.smooth, old.material_index)
    template_of = {id(old): look for old, look in templates.items()}
    unders = [[id(old) for old in under] for _, _, under in jobs]
    # FACES_ONLY: a corner where only rebuilt patches meet is loose until
    # they are made again; what is still loose after is dropped below.
    bmesh.ops.delete(bm, geom=[f for plane, _, _ in jobs for f in plane], context="FACES_ONLY")
    for (_, new_faces, _), under in zip(jobs, unders):
        created = {}
        for vs, old in zip(new_faces, under):
            for v in vs:
                if not isinstance(v, bmesh.types.BMVert) and id(v) not in created:
                    created[id(v)] = bm.verts.new(v)
            template, smooth, material = template_of[old]
            f = bm.faces.new([v if isinstance(v, bmesh.types.BMVert) else created[id(v)] for v in vs], template)
            f.smooth, f.material_index = smooth, material
    bmesh.ops.delete(bm, geom=[v for t, _, _ in template_of.values() for v in t.verts], context="VERTS")
    # A kept patch's n-gons (or one the field only grazes).
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context="EDGES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.normal_update()
    return len(jobs), kept, folded


def rebuild_mesh(mesh, bows, seed, smooth=False):
    """`rebuild` on `mesh` itself, its grid drawn from `seed`. The new points
    lie on the old surface, so this moves nothing: it is done on the
    straight rock, before the unwrap, every bake and the straight copy the
    detail high poly is built from (so the high poly and the rock share every
    crease: a folded sliver moves one by up to SLIVER, and a bake whose high
    poly is that far off draws the crease as dark dashes), and `bend` moves
    the vertices afterwards. With `smooth` (the shipped rock) the mesh is
    shaded smooth across edges under SMOOTH_ANGLE and sharp across the rest.
    Returns a one-line report."""
    if not bows:
        return "no long straight creases"
    bm = bmesh.new()
    bm.from_mesh(mesh)
    faces_before = len(mesh.polygons)
    rebuilt, kept, folded = rebuild(bm, bows, seed)
    bm.to_mesh(mesh)
    bm.free()
    if smooth:
        mesh.shade_smooth()
        mesh.set_sharp_from_angle(angle=math.radians(SMOOTH_ANGLE))
    mesh.update()
    return (f"{len(bows)} creases to bow, {folded} slivers folded, {rebuilt} patches rebuilt ({kept} kept their fans), "
            f"{faces_before} -> {len(mesh.polygons)} faces")


def bend(mesh, bows):
    """Move every vertex of `mesh` by the bow field. Run after the bakes:
    the maps were baked on the straight rock, where the detail high poly
    lines up with it exactly, and their UVs and tangent space move with the
    vertices. Returns a one-line report."""
    if not bows:
        return "no long straight creases"
    co = np.empty(3 * len(mesh.vertices))
    mesh.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    off = field(co, bows)
    mesh.vertices.foreach_set("co", (co + off).ravel())
    mesh.update()
    longest = max((b - a).length for a, b, _, _ in bows)
    moved = int((np.einsum("ij,ij->i", off, off) > 1e-12).sum())
    return f"{len(bows)} creases bowed (longest {longest:.2f} m), {moved} vertices moved"
