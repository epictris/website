"""Recipe F on a SOLID: a backdrop piece cut into stones, each weathered as
recipe F weathers its boxes, at a scale that grows with depth.

Recipe F (docs/cave-look.md) builds a piece from stacked boxes, one stone
each, with the seams between them reading as fissures. A backdrop piece
(docs/blender-backdrop.md) is a solid from the Orthographic Studio, the
intersection of its front, top and side outlines, so here the boxes are cut
FROM the solid: it is sliced along the view into slabs, each slab into
columns, each column into strata, every joint a plane leaning a few degrees,
and every cell of that grid that holds any of the solid's surface is a stone
(cell and solid intersected, so its outer faces are the solid's). Each stone
gets recipe F's corner cuts, bevel, chisel and relief (fitted.weather), and
is faceted on its own, so its planes stay crisp; behind them the solid
itself, shrunk inside, backs every fissure.

Everything is sized in SCREEN metres - lengths on the gameplay plane
`distance` in front of the eye - and multiplied by a stone's depth over that
distance, so a far stone is as big and as finely worked on screen as a near
one (and the far wall is not a million faces). The solid comes in world
space, already where it stands.
"""

import math
import random

import numpy as np

from . import fitted

# A stone's size in screen metres: a column's width, a stratum's height, a
# slab's depth along the view (the frame is about 6.2 x 3.5).
# 1.5 times the first sizes: the backdrop should be "predominantly
# composed of large bodies, not many overlapping small bodies" (Tris,
# 2026-10-04; the roof was 154 stones). Twice them overdid it: the roof's
# arch, 6.5 m across, was two stones and came to a point.
WIDTH = (0.8, 1.6)
HEIGHT = (0.5, 1.1)
DEPTH = (0.9, 1.8)
# A cell whose share of the solid's surface bends is split in two across
# the screen (its longer of width and height), again and again, down to
# SMALL's sizes: big stones on a curve came out as straight runs meeting in
# a point (Tris, 2026-10-04: the arches "should be a gradual curve"; at
# SMALL's sizes they were). Bending: its gentle bends turn it over
# CURVE_TURN (`_curved`). Such a stone is faceted at recipe F's density.
SMALL_WIDTH, SMALL_HEIGHT = 0.55, 0.35
CURVE_BEND = (math.radians(2), math.radians(35))
# The arch's cells turn 100 to 450 degrees, the far wall's flat ones 10 to 50.
CURVE_TURN = math.radians(60)  # PARAMS["curveTurn"] is this in degrees
# The corner cuts and the bevel go as a stone's smallest half, up to this
# (screen metres; the first sizes' typical half): on bigger stones they
# carved the arch's curve into planes instead of taking the corners off.
CUT_HALF = 0.4
# Joints lean up to this off square, so the stones are not a brick wall.
LEAN = math.radians(7)
# Cells are grown this much (screen metres) every way before they cut the
# solid, so neighbouring stones overlap by about what their weathering takes
# off and the fissures stay narrow.
OVERLAP = 0.12
# A weathered stone grows back out until this percentile of its cell's solid
# surface is inside it, by at most REGROW_MAX screen metres (`regrow`).
REGROW_SHARE, REGROW_MAX = 75, 0.08
# "offset" grows along the normals (rounds every corner); "scale" scales
# each axis of the stone's box.
REGROW_MODE = "offset"
# The core: the solid shrunk this far inside (screen metres), unweathered,
# so a fissure shows recessed stone and never the sky through the piece.
# The weathering takes a stone's face back by up to about a tenth of its
# size (the bevel and four smoothing passes), so a core 0.06 in stood in
# front of the stones and its flat planes were most of what showed.
CORE_INSET, CORE_STEPS = 0.2, 5
# The core's facets: a remesh this coarse (screen metres, coarsened with
# depth like the stones' facets), then dissolved.
CORE_FACET = 0.15
# How fast the facets coarsen ON SCREEN with depth (`facets_per_m2`): the
# on-screen density falls as 1 / scale ** FACET_FALLOFF.
FACET_FALLOFF = 1.0
# The stones' facets and chisel cuts as shares of recipe F's densities:
# at recipe F's, the roof's underside was a mesh of small faces and the
# chisel's steps stood out of the stones as little plates (Tris,
# 2026-10-04: simplify, remove the small bits that jut out).
FACETS, CHISEL = 0.55, 0.25
# Parts of a shrunk core or opened stone smaller than this share of its area
# are dropped (`drop_scraps`).
SCRAP, SCRAP_SIZE = 0.02, 0.1
# The solid is thickened away from the eye by this (screen metres), along
# the camera's rays (`thicken`).
THICKEN = 0.4
# The FACE attribute marking the core's faces in a built piece.
CORE_ATTRIBUTE = "backdrop_core"
# A stone keeps itself only if some of the solid's surface is in it, it is
# no thinner than SLIVER (screen metres) every way, and it fills at least
# FILL of its box: a corner of the solid in a cell weathers into a spike,
# and a stone a few voxels thin facets into a flat sheet (0.05 left the
# central rock a two-face plane). Weathered, it must still have STONE_FACES.
ON_SURFACE = 1e-4
SLIVER = 0.1
FILL = 0.3
# The weathering's smoothing passes, after the bevel and after the chisel,
# and the planar dissolve's angle: recipe F's (fitted.ROUND 4, CUT_SOFT 2,
# ANGLE 9 degrees) left the backdrop "too blobby compared to the
# foreground rocks" (Tris, 2026-10-04) - gentle 5-20 degree folds were 60 %
# of its edge length against the Terraces' 25 %. Halved smoothing and a 15
# degree dissolve keep the packing; 20 degrees folded a large face into a
# plate standing out of a stone, no smoothing opened 27 % holes in rock-c.
ROUND, CUT_SOFT = 2, 1
FACET_ANGLE = 15.0
# A piece under this share of the piece's median cell volume is joined to
# its neighbour too (a knub otherwise).
KNUB = 0.3
STONE_FACES = 8
# No convex edge sharper than this inside, radians (Tris, 2026-10-04).
MIN_ANGLE = math.radians(80)
# The opening (`open_thin`): radius in screen metres, steps each way. Twice
# the radius is the thinnest feature a stone keeps. It rounds every convex
# edge by as much: 0.04 (10 cm at the backdrop's depth) was too round.
OPEN_RADIUS, OPEN_STEPS = 0.02, 3
# `unfold`: at most this many edge collapses, and a stone that would keep
# less than UNFOLD_KEEP of its surface is dropped rather than unfolded.
UNFOLD_MAX, UNFOLD_KEEP = 60, 0.95
# The facet densities a stone is tried at, as multiples of recipe F's.
REFACET = (1.0, 1.4, 2.0, 2.8, 4.0)

# What a solid formation's recipe may set (its `params`; the Formations
# panel's fields, formations/params.py), and the defaults it takes:
# - seed: the cell grid's jitter and every stone's weathering;
# - stoneSize: WIDTH, HEIGHT and DEPTH times this;
# - facets, chisel: FACETS and CHISEL;
# - knub: KNUB;
# - curveTurn: CURVE_TURN, degrees;
# - floor: the least depth scale a stone is cut at (`cells`);
# - fixedScale: when over 0, the depth scale EVERY stone is cut, weathered
#   and faceted at, instead of its own depth over the plane's: the level of
#   detail set by hand rather than by distance from the camera;
# - facetFalloff: FACET_FALLOFF, how much coarser on screen the facets get
#   per unit of depth scale (0: as fine on screen at any depth).
PARAMS = {"seed": 0, "stoneSize": 1.0, "facets": FACETS, "chisel": CHISEL, "knub": KNUB,
          "curveTurn": 60.0, "floor": 0.0, "fixedScale": 0.0,
          "facetFalloff": FACET_FALLOFF}


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

    def __init__(self, eye, distance):
        self.eye = np.asarray(eye, float)
        self.distance = float(distance)

    def scale(self, y):
        """How much bigger a thing at world depth `y` is than the same thing
        on screen at the gameplay plane."""
        return (y - self.eye[1]) / self.distance


def _intervals(lo, hi, size, rng):
    """Cut [lo, hi] into pieces of `size(centre)` (a random draw each)."""
    cuts = [lo]
    while cuts[-1] < hi:
        cuts.append(cuts[-1] + size(cuts[-1]))
    # The last piece takes up the slack rather than leaving a sliver.
    if len(cuts) > 2 and hi - cuts[-2] < 0.5 * (cuts[-1] - cuts[-2]):
        cuts.pop(-2)
    cuts[-1] = hi
    return list(zip(cuts[:-1], cuts[1:]))


def _cell(bm_solid, box, seed):
    """`bm_solid` within the box (centre, half, rotation), as a new mesh, or
    None when nothing is left: the Manifold boolean of the two."""
    bmesh, bpy, Matrix, Vector, _ = _bpy()
    centre, half, rot = box
    me = bpy.data.meshes.new("cell")
    bm_solid.to_mesh(me)
    ob = bpy.data.objects.new("cell", me)
    bpy.context.scene.collection.objects.link(ob)
    cb = bmesh.new()
    bmesh.ops.create_cube(cb, size=2.0)
    m = Matrix.Translation(Vector(centre)) @ rot.to_4x4() @ Matrix.Diagonal((*half, 1))
    bmesh.ops.transform(cb, verts=cb.verts, matrix=m)
    cme = bpy.data.meshes.new("cutter")
    cb.to_mesh(cme)
    cb.free()
    cutter = bpy.data.objects.new("cutter", cme)
    mod = ob.modifiers.new("cell", "BOOLEAN")
    mod.operation = "INTERSECT"
    mod.object = cutter
    mod.solver = "MANIFOLD"
    fitted._apply_modifiers(ob)
    bpy.data.objects.remove(cutter)
    bpy.data.meshes.remove(cme)
    bpy.context.scene.collection.objects.unlink(ob)
    if len(ob.data.polygons) < 4:
        me = ob.data
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)
        return None
    return ob


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


def _split(centre, half, rot, f):
    """The cell in two across the screen (its longer of width over
    SMALL_WIDTH and height over SMALL_HEIGHT), or None at SMALL's sizes."""
    from mathutils import Vector
    grow = OVERLAP * f
    inner = [h - grow for h in half]
    wide, tall = inner[0] / (SMALL_WIDTH * f), inner[2] / (SMALL_HEIGHT * f)
    if max(wide, tall) < 1:
        return None  # halves would be under SMALL's least sizes
    axis = 0 if wide >= tall else 2
    step = [0.0, 0.0, 0.0]
    step[axis] = inner[axis] / 2
    child = tuple(inner[i] / 2 + grow if i == axis else half[i] for i in range(3))
    off = rot @ Vector(step)
    return [(tuple(Vector(centre) + sign * off), child, rot, f) for sign in (-1, 1)]


def corner_cuts(ob, half, seed, smallest):
    """Recipe F's corner cuts (fitted._corner_cuts) on a stone of any shape.
    The study's stones were boxes, every vertex a corner, so it cut at a
    random vertex; a stone cut from a curved solid has hundreds, bunched
    along the curve, and their average sits off centre, so a cut aimed at a
    vertex near it took the stone in half (most of a stone gone in 10 cuts,
    measured on the central rock). Here a cut aims at a corner of the
    stone's box and stands its depth inside the stone's furthest point that
    way, which on a box is exactly the study's cut.

    Each cut is a box standing outside its plane, and all of a stone's go
    in one Manifold boolean, as the chisel's do. The study's bisect and
    hole fill could not cap the cut loops of a cell cut from a thickened
    solid (1275 open edges on rock-b's front stone), the remesh after read
    the open stone as a thin shell, and the stone vanished (3.2 m3 to
    0.02). `smallest` sizes the cuts, as the box's smallest half does in
    the study."""
    bmesh, bpy, Matrix, Vector, _ = _bpy()
    rng = random.Random(seed)
    co = [v.co.copy() for v in ob.data.vertices]
    size = 4 * max(half)
    cutters = bpy.data.collections.new("Corner cuts")
    bpy.context.scene.collection.children.link(cutters)
    done = tries = 0
    while done < fitted.CORNERS and tries < fitted.CORNERS * 6:
        tries += 1
        corner = Vector((rng.choice((-1, 1)) * half[0], rng.choice((-1, 1)) * half[1], rng.choice((-1, 1)) * half[2]))
        if corner.z < 0 and rng.random() < 0.8:
            continue  # the underside stays mostly flat, as the study's
        n = (corner.normalized() + fitted._unit_vector(rng, Vector) * rng.uniform(0.3, 1.0)
             * fitted.CORNER_TILT).normalized()
        reach = max(c.dot(n) for c in co)
        d = rng.uniform(fitted.CORNER_DEPTH * 0.4, fitted.CORNER_DEPTH) * smallest
        frame = n.to_track_quat("Z", "Y").to_matrix().to_4x4()
        frame.translation = n * (reach - d)
        box = bmesh.new()
        bmesh.ops.create_cube(box, size=1.0)
        bmesh.ops.transform(box, verts=box.verts,
                            matrix=frame @ Matrix.Translation((0, 0, size / 2)) @ Matrix.Diagonal((size, size, size, 1)))
        me = bpy.data.meshes.new("corner cut")
        box.to_mesh(me)
        box.free()
        cutters.objects.link(bpy.data.objects.new("corner cut", me))
        done += 1
    if done:
        mod = ob.modifiers.new("corners", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.operand_type = "COLLECTION"
        mod.collection = cutters
        mod.solver = "MANIFOLD"
        fitted._apply_modifiers(ob)
    for c in list(cutters.objects):
        me = c.data
        bpy.data.objects.remove(c)
        bpy.data.meshes.remove(me)
    bpy.data.collections.remove(cutters)


def closed(ob):
    """Whether `ob` is a closed surface (no edge with a face on one side only)."""
    bmesh, *_ = _bpy()
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    # An edge four faces share is two lobes touching, still a closed solid
    # (the boolean leaves one now and then; the remesh after resolves it).
    bad = [e for e in bm.edges if e.is_boundary or e.is_wire]
    bm.free()
    return not bad


def weather(ob, half, seed, scale, chisel=CHISEL):
    """fitted.weather with corner_cuts for the study's. The cuts must leave
    a closed stone: a remesh reads an open one as a thin shell, and the
    stone is lost without a word."""
    if not closed(ob):
        raise RuntimeError(f"{ob.name}: open before weathering")
    # The cuts' and the bevel's size: recipe F's, on a stone no bigger than
    # the first sizes'.
    size = min(min(half), CUT_HALF * scale)
    corner_cuts(ob, half, seed + 70, size)
    if not closed(ob):
        raise RuntimeError(f"{ob.name}: the corner cuts left it open")
    fitted._pillow(ob, voxel=0.025 * scale, iters=ROUND, bevel=fitted.BEVEL * size)
    fitted._chisel(ob, seed + 50, scale, fitted.CUT_DENSITY * chisel)
    if not closed(ob):
        raise RuntimeError(f"{ob.name}: the chisel left it open")
    fitted._pillow(ob, voxel=0.02 * scale, iters=CUT_SOFT)
    fitted._relief(ob, seed + 60, scale)


def _lean(rng, axis):
    from mathutils import Matrix
    return Matrix.Rotation(rng.uniform(-LEAN, LEAN), 3, axis)


def cells(solid, camera, seed, floor=0.0, size=1.0, fixed=0.0):
    """The grid of boxes over the solid: (centre, half, rotation, scale).
    `floor` is the least scale a cell takes: a part of a piece no camera
    sees at the plane's distance (the roof's ceiling run forward to the
    level, backdrop.extend) is cut and worked as the rest of the piece,
    not into stones a third the size (196 of them on the roof). `fixed`,
    over 0, is every cell's scale, whatever its depth."""
    rng = random.Random(seed)
    def scale(y):
        return fixed if fixed > 0 else max(camera.scale(y), floor)
    co = np.array([solid.matrix_world @ v.co for v in solid.data.vertices])
    lo, hi = co.min(0), co.max(0)
    out = []
    for y0, y1 in _intervals(lo[1], hi[1], lambda y: rng.uniform(*DEPTH) * size * scale(y), rng):
        f = scale((y0 + y1) / 2)
        for x0, x1 in _intervals(lo[0], hi[0], lambda x: rng.uniform(*WIDTH) * size * f, rng):
            # A column's strata are its own, so the joints do not line up
            # across the face.
            for z0, z1 in _intervals(lo[2], hi[2], lambda z: rng.uniform(*HEIGHT) * size * f, rng):
                grow = OVERLAP * f
                half = ((x1 - x0) / 2 + grow, (y1 - y0) / 2 + grow, (z1 - z0) / 2 + grow)
                rot = _lean(rng, "Y") @ _lean(rng, "X")
                out.append((((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), half, rot, f))
    return out


def build_core(bm_solid, scale, collection, report, falloff=FACET_FALLOFF):
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
    fitted._pillow(ob, voxel=0.025 * scale, iters=fitted.ROUND)
    _offset(ob, -CORE_INSET * scale, 0.025 * scale, CORE_STEPS)
    if len(ob.data.polygons) < 4:
        return ob
    open_thin(ob, scale)
    # Not recipe F's collapse: on a mass this size it folds in places no
    # unfolding saves (the roof's, 116 edges). A coarse remesh and the planar
    # dissolve cannot fold; their faces band along the voxel grid, which on
    # stone seen only down the fissures does not show.
    # Faces go as 1 / voxel ** 2: coarsened as the stones' facets are.
    fitted._pillow(ob, voxel=CORE_FACET * scale ** (1 + falloff / 2), iters=1)
    d = ob.modifiers.new("planar", "DECIMATE")
    d.decimate_type = "DISSOLVE"
    d.angle_limit = math.radians(fitted.ANGLE)
    d.use_dissolve_boundaries = True
    fitted._apply_modifiers(ob)
    for p in ob.data.polygons:
        p.use_smooth = False
    # A voxel corner of a narrow part can still be sharp.
    unfold(ob)
    drop_scraps(ob, scale)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    report["core sharp"] = len(sharp_edges(bm))
    bm.free()
    return ob


def drop_scraps(ob, scale):
    """Delete the parts of `ob` under SCRAP of its area or under SCRAP_SIZE
    (screen metres) across. Shrinking (the core's inset, a stone's opening)
    leaves scraps where the shape narrows; one, a ball 6 cm across, floated
    in front of the waterfall cliff, too small a share of nothing to go by
    area alone."""
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


def _offset(ob, distance, voxel, steps=OPEN_STEPS):
    """Move every vertex `distance` along its normal (out if positive), in
    `steps` steps with a voxel remesh after each, which resolves whatever a
    step folds through itself."""
    bmesh, *_ = _bpy()
    for _ in range(steps):
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bm.normal_update()
        moves = [v.normal * distance / steps for v in bm.verts]
        for v, d in zip(bm.verts, moves):
            v.co += d
        bm.to_mesh(ob.data)
        bm.free()
        fitted._pillow(ob, voxel=voxel, iters=0)
        if len(ob.data.polygons) < 4:
            return


def open_thin(ob, scale):
    """A morphological opening: shrink the stone by OPEN_RADIUS (screen
    metres) and grow it back, so anything thinner than twice that - a lip a
    chisel box left along an edge, a fin the relief folded up, a sliver of
    a cell - is gone, and the mass keeps its size (Tris, 2026-10-04: the
    flat planes jutting out and the pointy curves; chamfering their tips
    left them jutting out, blunt)."""
    voxel = 0.02 * scale
    _offset(ob, -OPEN_RADIUS * scale, voxel)
    if len(ob.data.polygons) >= 4:
        _offset(ob, OPEN_RADIUS * scale, voxel)


def sharp_edges(bm):
    """Convex edges whose inside angle is under MIN_ANGLE."""
    limit = math.pi - MIN_ANGLE
    return [e for e in bm.edges if e.is_manifold and e.calc_face_angle_signed(0) > limit]


def unfold(ob):
    """Take out the folds recipe F's facets leave, and say whether the stone
    survived it. The Decimate Collapse to ~120 triangles a square metre
    turns a sliver of triangles back over itself here and there (measured:
    20 convex edges under 80 degrees over 35 stones, at any target), and a
    fold is a thin fin that juts out of the face (Tris, 2026-10-04). Each
    fold's sharpest edge is collapsed to a point, which deletes the sliver
    rather than blunting it (a chamfer left the fin standing; a voxel remesh
    before the dissolve folds nothing but bands every face along the grid).
    33 of those 35 stones lost under 2 % of their surface; a stone that would
    lose more than 1 - UNFOLD_KEEP (one collapsed to 4 %) is reported lost,
    and its place is the core's."""
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
        # The sharpest edge first; an edge whose ends share more neighbours
        # than its two triangles' far corners pinches the surface when
        # collapsed (non-manifold: it cost 17 stones, rock-b's only one), so
        # each try is made on a copy and the first that stays a closed
        # surface is kept.
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


def facets_per_m2(scale, facets=FACETS, falloff=FACET_FALLOFF):
    """Triangles a WORLD square metre for a stone `scale` times further back
    than the gameplay plane: recipe F's FACETS_PER_M2 a screen square metre
    (which is 1 / scale ** 2 of it a world one), thinned once more by
    scale ** FACET_FALLOFF, so the further back a rock stands the coarser it
    is on screen too (Tris, 2026-10-04: lower the backdrop's face counts by
    how far they are from the gameplay plane). Screen-constant, the roof
    alone was 59k faces."""
    return facets * fitted.FACETS_PER_M2 / scale ** (2 + falloff)


def regrow(ob, targets, scale):
    """Grow a weathered stone back out to the solid's surface it was cut
    with. `targets` are points of that surface (the cell's own, before the
    weathering); the stone grows along its normals by how far they now lie
    outside it (REGROW_SHARE of them reached, at most REGROW_MAX screen
    metres), with a voxel remesh per step so nothing folds.

    The corner cuts, the bevel, the smoothing and the opening take a stone
    in from its cell all round, so stones cut edge to edge stood apart with
    the core and the sky between them and the outline the studio scene was
    traced for shrank (measured from the start camera: 10.8 % of the solids'
    silhouettes not covered, a boulder 25 %; Tris, 2026-10-04: "the rocks
    should pack tightly together - overlapping if necessary to avoid
    gaps"). Scaling a stone back to its cell's box was tried first and
    helped the walls but not the boulders, whose cuts eat a rounded outline
    (rock-a 38 %). Grown back, the stone keeps its chamfers in proportion and
    meets its neighbours, overlapping them by the cells' OVERLAP."""
    _, _, Matrix, Vector, BVHTree = _bpy()
    if not len(targets):
        return 0.0
    if REGROW_MODE == "scale":
        # Scaled about the box's centre until the cell's surface points fit
        # it again, each axis on its own: no corner is rounded by it.
        co = np.array([v.co for v in ob.data.vertices])
        lo, hi = co.min(0), co.max(0)
        centre, now = (lo + hi) / 2, np.maximum((hi - lo) / 2, 1e-9)
        want = np.percentile(np.abs(targets - centre), REGROW_SHARE, axis=0)
        factor = np.clip(want / now, 1.0, 1.0 + REGROW_MAX * scale / now)
        ob.data.transform(Matrix.Translation(Vector(centre)) @ Matrix.Diagonal((*factor, 1.0))
                          @ Matrix.Translation(Vector(-centre)))
        return float(np.max(factor))
    tree = BVHTree.FromPolygons([v.co for v in ob.data.vertices], [p.vertices for p in ob.data.polygons])
    outside = []
    for p in targets:
        q, n, _, d = tree.find_nearest(Vector(p))
        outside.append(d if q is not None and (Vector(p) - q).dot(n) > 0 else 0.0)
    grow = min(float(np.percentile(outside, REGROW_SHARE)), REGROW_MAX * scale)
    if grow > 0:
        _offset(ob, grow, 0.02 * scale)
    return grow


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


def _neighbour(ob, others, reach):
    """The piece among `others` whose box overlaps `ob`'s (grown by `reach`)
    the most, or None."""
    co = np.array([v.co for v in ob.data.vertices])
    lo, hi = co.min(0) - reach, co.max(0) + reach
    best, most = None, 0.0
    for other in others:
        oc = np.array([v.co for v in other.data.vertices])
        shared = np.clip(np.minimum(hi, oc.max(0)) - np.maximum(lo, oc.min(0)), 0, None).prod()
        if shared > most:
            best, most = other, shared
    return best


def _union(host, ob):
    """`host` with `ob` added (a Manifold boolean union)."""
    mod = host.modifiers.new("merge", "BOOLEAN")
    mod.operation = "UNION"
    mod.object = ob
    mod.solver = "MANIFOLD"
    fitted._apply_modifiers(host)


def thicken(solid, camera, collection):
    """A copy of `solid` (world coordinates) grown away from the eye: the
    union of it and its camera-facing faces extruded THICKEN (screen metres,
    times their depth) further along their own camera rays. A point moved
    along its ray stays on its pixel, so from the start camera the
    silhouette is exactly the studio's; only the hidden back grows (copies
    pushed back and unioned would not do: a few centimetres of skin and a
    copy 13 cm behind it do not meet). Where the studio's solid is a thin slanted skin seen edge on (the
    central rock's top left: 2.6 m along the ray, a few centimetres across
    it) no stone and no core survived the opening and the 80 degree rule,
    and the outline had a hole the rock behind showed through (Tris,
    2026-10-04: no gaps); thickened, the skin is a stone like any other."""
    bmesh, bpy, _, Vector, _ = _bpy()
    eye = Vector(camera.eye)
    me = solid.data.copy()
    me.transform(solid.matrix_world)
    ob = bpy.data.objects.new("Thickened", me)
    collection.objects.link(ob)
    # The slab behind the camera-facing faces.
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
    mod = ob.modifiers.new("thicken", "BOOLEAN")
    mod.operation = "UNION"
    mod.object = slab
    mod.solver = "MANIFOLD"
    fitted._apply_modifiers(ob)
    bpy.data.objects.remove(slab)
    bpy.data.meshes.remove(sme)
    return ob


def _tree(ob):
    _, _, _, _, BVHTree = _bpy()
    return BVHTree.FromPolygons([v.co for v in ob.data.vertices], [p.vertices for p in ob.data.polygons])


def floating(stones, core, water_z=None):
    """The stones that overlap no other stone and not the core, and do not
    stand in the water: a rock hanging free of the mass (Tris, 2026-10-04:
    "there should be no floating rocks")."""
    trees = [_tree(s) for s in stones]
    core_tree = _tree(core) if len(core.data.polygons) else None
    out = []
    for i, t in enumerate(trees):
        if water_z is not None and min(v.co.z for v in stones[i].data.vertices) < water_z:
            continue
        touching = any(t.overlap(u) for j, u in enumerate(trees) if j != i)
        if not touching and not (core_tree is not None and t.overlap(core_tree)):
            out.append(stones[i])
    return out


def build(solid, camera, params, collection, water_z=None):
    """The piece as one mesh (unlinked, world coordinates), its stones and
    core (each its own object in `collection`) and its typical scale (the
    stones' median depth over the plane's). `params`: PARAMS (`resolved`),
    and `core` (default True) to leave the core out when inspecting the
    stones."""
    bmesh, bpy, Matrix, Vector, BVHTree = _bpy()
    p = resolved(params)
    seed = p["seed"]
    solid = thicken(solid, camera, collection)
    bm_solid = bmesh.new()
    bm_solid.from_mesh(solid.data)
    surface = BVHTree.FromBMesh(bm_solid)
    stones, scales = [], []
    report = {"lost to folds": 0, "merged": 0, "split": 0,
              "thickened open": sum(1 for e in bm_solid.edges if not e.is_manifold)}

    def drop(ob):
        me = ob.data
        if ob.name in collection.objects:
            collection.objects.unlink(ob)
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)

    # The cells' pieces of the solid, those with any of its surface.
    pieces = []
    curved = set()  # the pieces split for a curve, by name
    todo = list(cells(solid, camera, seed, p["floor"], p["stoneSize"], p["fixedScale"]))
    n = -1
    while todo:
        centre, half, rot, f = todo.pop(0)
        n += 1
        if water_z is not None and centre[2] + max(half) < water_z:
            continue  # under the pool
        ob = _cell(bm_solid, (centre, half, rot), seed)
        if ob is None:
            continue
        if not any(surface.find_nearest(v.co)[3] < ON_SURFACE for v in ob.data.vertices):
            drop(ob)
            continue  # wholly inside: the core stands for it
        bends = _curved(ob, surface, half) > math.radians(p["curveTurn"])
        halves = _split(centre, half, rot, f) if bends else None
        if halves:
            drop(ob)
            todo[:0] = halves
            report["split"] += 1
            continue
        collection.objects.link(ob)
        ob.name = f"Stone {n}"
        if bends:
            curved.add(ob.name)
        pieces.append((n, ob, f))
    # A sliver or a wedge of the solid in a cell weathers into a spike or a
    # sheet, so it is joined to the neighbour it touches most instead: left
    # out, its corner of the solid had no stone and the deep core showed
    # (Tris, 2026-10-04: no gaps).
    # So is a piece much smaller than the rest: a chunk of the solid's edge
    # in a cell's corner weathers into a little stone of its own and stuck
    # out of the big one beside it as a knub (Tris, 2026-10-04).
    # Measured against their own kind: a curve's stones are a quarter of
    # the rest, and would all be knubs by the big ones' median.
    volumes = [_volume(p[1]) for p in pieces]
    tiny = set()
    for kind in (True, False):
        own = [(p, v) for p, v in zip(pieces, volumes) if (p[1].name in curved) == kind]
        if own:
            least = p["knub"] * float(np.median([v for _, v in own]))
            tiny |= {id(p) for p, v in own if v < least}
    small = [p for p in pieces if id(p) in tiny or _small(p[1], p[2])]
    kept = [p for p in pieces if id(p) not in tiny and not _small(p[1], p[2])]
    for n, ob, f in small:
        host = _neighbour(ob, [k[1] for k in kept], OVERLAP * f)
        if host is not None:
            _union(host, ob)
            report["merged"] += 1
        drop(ob)
    for n, ob, f in kept:
        dims = np.ptp(np.array([v.co for v in ob.data.vertices]), axis=0) / 2
        # recipe F works on a stone about its own centre
        mid = Vector(np.array([v.co for v in ob.data.vertices]).mean(0))
        # The solid's surface in this cell: where `regrow` brings it back to.
        points = [p.center for p in ob.data.polygons] + [v.co for v in ob.data.vertices]
        targets = np.array([p - mid for p in points if surface.find_nearest(p)[3] < ON_SURFACE]).reshape(-1, 3)
        ob.data.transform(Matrix.Translation(-mid))
        weather(ob, tuple(dims), seed + 7919 * n, f, p["chisel"])
        open_thin(ob, f)
        if len(ob.data.polygons) < 4:
            drop(ob)
            continue
        regrow(ob, targets, f)
        # Where the folds cannot be taken out, a finer collapse folds
        # elsewhere or not at all: try a little finer before giving up.
        smooth = ob.data.copy()
        area = sum(p.area for p in smooth.polygons)
        for finer in REFACET:
            density = facets_per_m2(f, 1.0 if ob.name in curved else p["facets"], p["facetFalloff"])
            fitted._facets(ob, finer * density * area, FACET_ANGLE)
            if unfold(ob):
                break
            old, ob.data = ob.data, smooth.copy()
            bpy.data.meshes.remove(old)
        else:
            bpy.data.meshes.remove(smooth)
            report["lost to folds"] += 1
            drop(ob)
            continue
        bpy.data.meshes.remove(smooth)
        drop_scraps(ob, f)
        if len(ob.data.polygons) < STONE_FACES:
            drop(ob)
            continue
        ob.data.transform(Matrix.Translation(mid))
        stones.append(ob)
        scales.append(f)
    scale = float(np.median(scales)) if scales else camera.scale(float(np.mean([v.co.y for v in bm_solid.verts])))
    core = build_core(bm_solid, scale, collection, report, p["facetFalloff"])
    tme = solid.data
    bpy.data.objects.remove(solid)
    bpy.data.meshes.remove(tme)
    bm_solid.free()
    report["floating"] = len(floating(stones, core, water_z))
    # The core's faces are marked, so a check can tell a gap (core seen) from
    # stone (docs/blender-backdrop.md, measuring the packing).
    marks = core.data.attributes.new(CORE_ATTRIBUTE, "INT", "FACE")
    marks.data.foreach_set("value", [1] * len(core.data.polygons))
    bm = bmesh.new()
    for s in stones + ([core] if params.get("core", True) else []):
        bm.from_mesh(s.data)
    me = bpy.data.meshes.new("BackdropRock")
    bm.to_mesh(me)
    bm.free()
    piece = bpy.data.objects.new("BackdropRock", me)
    for p in piece.data.polygons:
        p.use_smooth = False
    return piece, stones + [core], scale, report


def build_from_recipe(recipe, collection):
    """A solid formation's rock from its recipe (formations/worker.py): the
    guide (rock-local `verts` and `faces`) taken to the world by `frame`,
    cut and weathered there, and brought back into the rock's frame, with
    its stones and core in `collection`. Returns the rock and its depth
    scale."""
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
    camera = Camera(cam["eye"], cam["distance"])
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
