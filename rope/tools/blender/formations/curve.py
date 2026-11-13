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
import native
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


def find_bows(mesh, seed, smallest=0.0):
    """The bows for `mesh`'s long straight creases, drawn from `seed`: a list
    of (start, end, offset at the middle, reach). A bow under `smallest`
    (metres: the depth of field's blur there, formations/render.py
    `detail_blur`) is left out."""
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
        if abs(amount) < smallest:
            continue
        bows.append((a, b, out * amount, max(MIN_REACH, REACH * chord)))
    bm.free()
    return bows


class Bows:
    """`find_bows`'s list as a native field (tools/blender/native, bows.cpp),
    built once per rock: a uniform grid over the bows' reach boxes, so a
    point measures only the bows that can reach it, on every thread. The
    numpy field before it scanned every bow near a block of points on each
    call, and the rebuild calls it once a patch: 754 k calls and 5,833 s of
    a 3 h river export (2026-11-13). Same field to 1e-16."""

    def __init__(self, bows):
        a = np.array([a for a, _, _, _ in bows], dtype=float).reshape(-1, 3)
        b = np.array([b for _, b, _, _ in bows], dtype=float).reshape(-1, 3)
        bow = np.array([bow for _, _, bow, _ in bows], dtype=float).reshape(-1, 3)
        reach = np.array([r for _, _, _, r in bows], dtype=float)
        self.native = native.BowField(a, b, bow, reach, WAYS, SIZING_STEP, TOLERANCE, SIZE)

    def __len__(self):
        return self.native.count


def field(points, bows):
    """The bow field at `points` (an N x 3 array): how far the bows move each.
    `bows` is `find_bows`'s list or a `Bows`. A point moves by

        sum over bows of  bow x sin(pi t) x smoothstep(1 - d / reach)

    with t its place along the bow's chord (clamped to its ends) and d its
    distance from it."""
    if not isinstance(bows, Bows):
        bows = Bows(bows)
    return bows.native.eval(points)


# The 13 ways an edge can run (the axes and the face and body diagonals), and
# the step the field's second difference is taken over.
WAYS = np.array([w for w in itertools.product((-1, 0, 1), repeat=3) if w > (0, 0, 0)], dtype=float)
WAYS /= np.linalg.norm(WAYS, axis=1)[:, None]
SIZING_STEP = 0.02


def sizing(points, bows):
    """The triangle size at `points` (N x 3): the longest edge the bow field
    bends by under TOLERANCE in its middle, from the field's second
    difference along the WAYS (the axes alone missed the bend across them by
    up to 4x), clamped to SIZE; SIZE's top where the field is flat. An edge
    of length L bends by about bend x L^2 / 8 in its middle."""
    if not isinstance(bows, Bows):
        bows = Bows(bows)
    return bows.native.sizing(points)


# The rebuild's own settings (tools/blender/native/src/crease.cpp reads them in
# this order): sliver folding passes, and the jittered grid's JITTER, MARGIN
# and DEEPEST, which are formations/detail.py's sub-facet grid's.
FOLD_PASSES = 8


def rebuild_params():
    from formations import detail  # noqa: E402 (bpy-only module)
    return [MERGE, SLIVER, SMOOTH_ANGLE, PATCH, detail.MARGIN, detail.JITTER, detail.DEEPEST, FOLD_PASSES]


# How each attribute type is read and written through foreach_get/set: its
# property and how many numbers an element holds.
ATTRIBUTE_FIELDS = {"FLOAT": ("value", 1, float), "INT": ("value", 1, np.int32), "BOOLEAN": ("value", 1, bool),
                    "INT8": ("value", 1, np.int8), "FLOAT2": ("vector", 2, float), "FLOAT_VECTOR": ("vector", 3, float),
                    "FLOAT_COLOR": ("color", 4, float), "BYTE_COLOR": ("color", 4, float),
                    "INT32_2D": ("value", 2, np.int32), "QUATERNION": ("value", 4, float)}


def _read_attribute(a, count):
    prop, width, dtype = ATTRIBUTE_FIELDS[a.data_type]
    values = np.empty(count * width, dtype=dtype)
    a.data.foreach_get(prop, values)
    return values.reshape(count, width)


def rebuild_mesh(mesh, bows, seed, smooth=False):
    """Triangulate every plane the bows reach afresh, in place, its grid drawn
    from `seed`; the native kernel (tools/blender/native/src/crease.cpp) does
    the work on every thread.

    The shipped mesh is a planar dissolve's fans: long slivers from one
    corner to the far side, each meeting its neighbour at a fraction of a
    degree, and a few zero-area faces. Bent, the field moves a sliver's three
    corners by different amounts and the thin ones turn over (the Terrace:
    about 280 visible faces turned by more than 30 degrees), each a dark or
    pale slit across the face. Splitting the fans' edges finer only cuts them
    into shorter slivers; patching them (beautify, collapsing the needles)
    re-cut edges across the creases and broke the silhouette. So:

    - points closer than MERGE are merged (the dissolve's zero-area faces);
    - every triangle under SLIVER high over its longest edge is folded away:
      its far corner moves onto that edge and the edge turns to run from it
      to the neighbour's corner, so the faces either side are coplanar pieces
      of the neighbour; a needle (its corner within SLIVER of an end) is
      welded into that end where the weld keeps the surface closed (the link
      condition: the ends share no neighbour but the two far corners; the
      river's Terrace once opened 14 holes the detail high poly failed on);
    - every edge the field reaches is cut into pieces no longer than `sizing`
      there, in both faces either side, so the mesh stays closed;
    - the faces the field reaches are grouped into patches, grown from the
      largest face across folds under SMOOTH_ANGLE to faces within PATCH
      degrees of it (the planar dissolve joins faces within 9 degrees, so its
      fans are not flat, and grouped within a degree most "planes" were a
      single sliver, which cannot be triangulated into anything but itself);
    - each patch's inside is filled with points on a jittered grid at its
      smallest size (formations/detail.py's sub-facet grid), thinned to the
      size where the field bends less, and the whole is constrained-Delaunay
      triangulated: no boundary point moves, so the creases and the
      silhouette are exactly what they were, and the inside points go onto
      the patch's own faces, not its fitted plane. A patch whose boundary
      touches itself or folds over once projected, whose triangulation does
      not come back clean or covers another area, or that would make a
      triangle a neighbour already has, keeps its faces.

    Each new face takes the attributes, material and shading of the old face
    under its middle. The new points lie on the old surface, so this moves
    nothing: it is done on the straight rock, before the unwrap, every bake
    and the straight copy the detail high poly is built from (so the high
    poly and the rock share every crease: a folded sliver moves one by up to
    SLIVER, and a bake whose high poly is that far off draws the crease as
    dark dashes), and `bend` moves the vertices afterwards. With `smooth`
    (the shipped rock) the mesh is shaded smooth across edges under
    SMOOTH_ANGLE and sharp across the rest. Returns a one-line report."""
    if not bows:
        return "no long straight creases"
    bows = Bows(bows)
    nv, nf, nl = len(mesh.vertices), len(mesh.polygons), len(mesh.loops)
    co = np.empty(3 * nv)
    mesh.vertices.foreach_get("co", co)
    face_start = np.empty(nf + 1, dtype=np.int64)
    starts = np.empty(nf, dtype=np.int32)
    mesh.polygons.foreach_get("loop_start", starts)
    face_start[:-1], face_start[-1] = starts, nl
    if nf and np.any(np.diff(face_start) < 3):
        raise ValueError(f"{mesh.name}: faces out of corner order")
    corner_verts = np.empty(nl, dtype=np.int32)
    mesh.loops.foreach_get("vertex_index", corner_verts)
    # What the new faces, vertices and edges carry over.
    sizes = {"POINT": nv, "EDGE": len(mesh.edges), "FACE": nf}
    carried = []
    for a in mesh.attributes:
        if a.name.startswith(".") or a.name == "position":
            continue
        if a.domain not in sizes or a.data_type not in ATTRIBUTE_FIELDS:
            raise ValueError(f"{mesh.name}: the crease rebuild cannot carry {a.domain} attribute {a.name!r} "
                             f"({a.data_type})")
        carried.append((a.name, a.domain, a.data_type, _read_attribute(a, sizes[a.domain])))
    old_edges = np.empty(2 * len(mesh.edges), dtype=np.int64)
    mesh.edges.foreach_get("vertices", old_edges)
    old_edges = np.sort(old_edges.reshape(-1, 2), axis=1)

    out_co, tris, face_src, vert_src, (rebuilt, kept, folded) = native.crease_rebuild(
        bows.native, co, face_start, corner_verts, seed, rebuild_params())

    mesh.clear_geometry()
    mesh.vertices.add(len(out_co))
    mesh.vertices.foreach_set("co", out_co.ravel())
    mesh.loops.add(3 * len(tris))
    mesh.loops.foreach_set("vertex_index", tris.ravel())
    mesh.polygons.add(len(tris))
    mesh.polygons.foreach_set("loop_start", np.arange(0, 3 * len(tris), 3, dtype=np.int32))
    mesh.update(calc_edges=True)
    new_edges = np.empty(2 * len(mesh.edges), dtype=np.int64)
    mesh.edges.foreach_get("vertices", new_edges)
    # An edge between two old vertices that were joined before keeps its values.
    ends = vert_src[new_edges.reshape(-1, 2)]
    ends.sort(axis=1)
    edge_src = np.full(len(ends), -1, dtype=np.int64)
    if len(old_edges):
        old_keys = old_edges[:, 0] * (nv + 1) + old_edges[:, 1]
        new_keys = ends[:, 0] * (nv + 1) + ends[:, 1]
        order = np.argsort(old_keys)
        at = np.minimum(np.searchsorted(old_keys[order], new_keys), len(order) - 1)
        match = (ends[:, 0] >= 0) & (old_keys[order][at] == new_keys)
        edge_src[match] = order[at[match]]
    picks = {"POINT": vert_src, "EDGE": edge_src, "FACE": face_src}
    for name, domain, data_type, values in carried:
        a = mesh.attributes.get(name) or mesh.attributes.new(name, data_type, domain)
        pick = picks[domain]
        out = np.zeros((len(pick), values.shape[1]), dtype=values.dtype)
        has = pick >= 0
        out[has] = values[pick[has]]
        a.data.foreach_set(ATTRIBUTE_FIELDS[data_type][0], out.ravel())
    if smooth:
        mesh.shade_smooth()
        mesh.set_sharp_from_angle(angle=math.radians(SMOOTH_ANGLE))
    mesh.update()
    return (f"{len(bows)} creases to bow, {folded} slivers folded, {rebuilt} patches rebuilt ({kept} kept their fans), "
            f"{nf} -> {len(mesh.polygons)} faces")


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
