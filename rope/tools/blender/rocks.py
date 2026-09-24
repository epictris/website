"""Stratified rock from a level's rock outlines, in headless Blender.

Run by `scripts/generate-rocks.ts`, never by hand:

    blender -b --factory-startup --python tools/blender/rocks.py -- job.json out.glb

The job is what `src/render3d/rocks.ts` lays out: per rock body, its outlines in
world metres with x right and y UP, each with a depth and a z offset. This
script owns nothing about the level format - it turns polygons into stone.

Frames. The game draws in three's frame (x right, y up, z toward the camera).
Blender is z-up, and its glTF exporter maps Blender (x, y, z) to glTF (x, z, -y),
so a rock is built here with Blender x = game x, Blender z = game y, and
Blender y = -(game z): its front face, the one toward the camera, is at
NEGATIVE Blender y. Objects stay at the origin so the exported node transform
is the identity and the vertices ARE world coordinates.

Shape. The author's geometry-nodes rock (Rock_Cliff_Sharp), done with
modifiers and numpy. Its sizes are for a rock about 5 m tall; here every
length scales with ONE rock scale S (ROCK_SCALE, or the wrapper's --scale),
the same for every piece, so a 5 m wall and a 1 m ledge show the same stone:

- A shard template is a 1 x 1 x 1 cube cut 2 x 2 x 3, pushed about by a
  Voronoi texture, stretched to a tall column and tapered toward its top,
  then chamfered (and Catmull-Clark subdivided only for a remesh). A body
  builds a handful once.
- Each outline is filled with overlapping instances of them (a density that
  goes as 1/S^2), randomly scaled, spun a little about the vertical, and
  wandered by a large noise that moves them mostly up and down; seeds are
  kept by where they LAND so the edges stay covered. The whole body shares a
  small strata tilt.
- Their depth is the extrusion's: the authored depth centred on the gameplay
  plane. A share of the shards stand with their front half the depth in
  front of the plane in the middle of the outline, falling back by EDGE_FALL
  toward its edge; the rest are recessed behind them by up to RELIEF * S,
  which is where the stepped column faces come from. Every shard runs from
  its front to the back of the solid, and one prism of the whole outline
  fills in behind the deepest recess.
- Every shard reaching past the outline is intersected, on its own, with one
  prism of the concave outline pushed out by the tolerance (a per-shard float
  boolean), so the silhouette stays within a few centimetres of the collision
  outline (the outline is a GUIDE, which the author accepted). Half-plane
  clipping against convex parts came first and could not be made right: it
  cut the shards along every decomposition seam.
- The shards ship as they are (or, with --remesh, voxel-remeshed into one
  solid), warped by three smooth noises as position offsets (scalar field
  times a constant vector, never along the normal, which rounds edges off),
  stripped of the faces behind the plane that face away from the camera,
  collapse-decimated to budget unless --decimate 1, smooth shaded with the
  edges sharper than SHARP_ANGLE_DEG marked sharp, and darkened with depth.

Colour. Box-projected UVs in world metres (one texture tile per TEXTURE_TILE)
carry a tileable stone texture from `rocktex.py` when that module is present;
a body-wide dark grey in COLOR_0, darkened in the cavities by Blender's "dirty
vertex colours", multiplies it. Without the texture module the colour layer
alone is the stone.
"""

import json
import math
import os
import random
import sys
import tempfile
import time

import bpy
import bmesh
import numpy as np

# ---------------------------------------------------------------------------
# Tunables. Metres unless said otherwise; "at S" lengths are multiplied by the
# rock scale S (the author's numbers are for a 5 m rock, S = 5).

# The rock scale S, one constant for every piece: a 5 m wall and a 1 m ledge
# are cut from the same stone, so their shards, voxels and warps are the same
# size (see `piece_size`). The author's reference block is S = 5.
ROCK_SCALE = 4.0
# How many shard shapes a body builds and instances.
TEMPLATES = 6
# The template cube's cuts along x, depth and up.
TEMPLATE_CUTS = (2, 2, 3)
# The Voronoi warp of the template cube, in cube units, and its cell size.
TEMPLATE_WARP = 0.25
TEMPLATE_CELL = (0.35, 0.6)
# The base shard (x, depth, up) at S.
SHARD_BASE = (0.19, 0.19, 0.61)
# Bottom width over top width.
SHARD_TAPER = 1.76
# Random per-axis scale of an instance (x, depth, up).
SHARD_SCALE_MIN = (1.01, 1.01, 0.77)
SHARD_SCALE_MAX = (1.49, 1.49, 2.45)
# Random position offset of an instance (x, up) at S, centred.
SHARD_OFFSET = (0.41 / 5, 0.60 / 5)
# Random spin about the vertical (radians).
SHARD_SPIN = 0.21
# The template's bevel at S, its segments and angle limit (degrees).
TEMPLATE_BEVEL = 0.004
TEMPLATE_BEVEL_SEGMENTS = 2
TEMPLATE_BEVEL_ANGLE = 30.0
# Catmull-Clark levels on the template after the bevel.
TEMPLATE_SUBDIV = 2
# Shards per m^2 of plan area at S = 1 (the author's 0.765 at S = 5, and half
# again: his render shows more, narrower column faces than that number gave).
SHARD_DENSITY = 0.765 * 25 * 1.5
# ...capped per piece.
MAX_SHARDS = 1200
# The large noise that wanders the instances: amplitude (x, up) at S and the
# feature size in S.
WANDER = (0.37 / 5, 2.37 / 5)
WANDER_SCALE = 1 / 0.58
# The body's strata tilt from vertical (degrees).
BODY_TILT = 6.0
# THE DEPTH MODEL is the extrusion's: the authored `depth` is centred on the
# gameplay plane, so the rock's proudest faces stand half of it in FRONT of
# the plane, exactly where the flat extrusion's front face was, and the
# relief is carved backward from there. A first version put the proudest
# faces at the plane and everything else behind it, and the ball then looked
# as if it hovered ahead of the rock ("rendered behind the player").
#
# Toward the outline's edge the front falls back by EDGE_FALL times S (capped
# at half the depth), the rounded profile of a rock, reaching full fall at
# the edge and none BULGE_RADIUS in from it.
EDGE_FALL = 0.06
BULGE_RADIUS = 0.7
# Random in-and-out of each shard's front face, on the proud ones.
DEPTH_JITTER = 0.02
# A share of the shards (PROUD_SHARE) sit at that front and the rest are
# recessed behind it by up to RELIEF times S (capped by the depth), which is
# where the reference's stepped column faces come from: the proud faces,
# their sides, and the recessed ones in shadow.
RELIEF = 0.14
PROUD_SHARE = 0.35
# How far in front of the gameplay plane a bevelled piece's taper stops at
# the outline's edge (see `scatter`): almost at the plane, not on it.
TAPER_MARGIN = 0.05
# A bevelled piece's edge is RAGGED (see `ragged_ends`): this share of the
# shards that meet the outline end exactly on it, the rest stop short of it
# by up to the bevel; a shard is never shortened below this share of itself.
RAGGED_FLUSH = 0.4
RAGGED_MIN_LENGTH = 0.3
# A clipped shard whose remnant is thinner than this share of S, across or
# up, is dropped: a shard reaching just over the outline left a few
# centimetres of itself inside, full depth, which read as a plate floating on
# the columns.
SLIVER = 0.08
# How much brightness a face loses at the deepest recess (see depth_shade).
DEPTH_SHADE = 0.45
# The backing prism sits behind the deepest recess and is at least this
# thick, so a gap between shards shows rock rather than sky.
MIN_BACKING = 0.1
# How far past the outline a shard may reach before it is cut.
OUTLINE_TOLERANCE = 0.06
# ...and at least this share of the piece's size S, so a big rock's silhouette
# is jagged the way the author's reference is rather than shaved flat.
OUTLINE_TOLERANCE_RATIO = 0.03


def tolerance(s):
    return max(OUTLINE_TOLERANCE, OUTLINE_TOLERANCE_RATIO * s)
# Voxel size of the remesh at S, and its floor.
VOXEL_SIZE = 0.01
VOXEL_MIN = 0.02
# Surface detail after the remesh, along the normal: (texture, feature size at
# S, strength at S). Voronoi F1 for the mid and small detail, clouds for fine.
DETAIL = (
    # The author's mid and small offsets are Smooth-F1 Voronoi at smoothness
    # 0.15 and 1.0, gentle flowing warps. Blender's legacy VORONOI texture has
    # no smoothness and its hard cells covered every face in bubbles, so both
    # are smooth noise here at their feature sizes, and gentler.
    ("CLOUDS", 1 / 0.4 / 5, 0.10 / 5),
    ("CLOUDS", 1 / 2.0 / 5, 0.04 / 5),
    ("CLOUDS", 1 / 4.0 / 5, 0.02 / 5),
)
# Collapse decimation ratio of the visible faces. 0.3 ate the shard edges.
COLLAPSE_RATIO = 0.5
# Edges folding more than this (degrees) are marked sharp under smooth shading.
# The remesh spreads a corner over a voxel or two, so at 30 almost nothing
# qualified and the rock read as a blob.
SHARP_ANGLE_DEG = 18.0
# A connected island with fewer vertices than this share of the piece's
# largest is a stray sliver, dropped.
ISLAND_MIN = 0.05
# A face is back (and dropped) when its normal's +y exceeds this: it faces
# away from the camera, which is always in front of the level.
BACK_NORMAL = 0.5
# One texture tile per this many metres.
TEXTURE_TILE = 1.0
# Texture size in pixels, and its seed.
TEXTURE_SIZE = 1024
TEXTURE_SEED = 0
# The stone, as LINEAR colour (glTF COLOR_0 is linear): dark, since the texture
# carries the value; alone it reads as a mid-dark grey.
ROCK_GREY = (0.30, 0.30, 0.285)
# How much a body may wander from it: mostly in brightness, a little in hue.
SHADE_JITTER = 0.10
HUE_JITTER = 0.02


# ---------------------------------------------------------------------------
# Plane geometry: polygons as lists of (x, y).


def area(poly):
    a = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2


def bbox(poly):
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


def point_in_poly(p, poly):
    x, y = p
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if xi > x:
                inside = not inside
    return inside


def points_in_poly(pts, poly):
    """`point_in_poly` over an (N, 2) array at once."""
    x, y = pts[:, 0], pts[:, 1]
    inside = np.zeros(len(pts), dtype=bool)
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if y1 == y2:
            continue
        crosses = (y1 > y) != (y2 > y)
        xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
        inside ^= crosses & (xi > x)
    return inside


def dist_to_outline(pts, poly):
    """Distance from each of (N, 2) points to the polygon's boundary."""
    best = np.full(len(pts), np.inf)
    n = len(poly)
    for i in range(n):
        a = np.array(poly[i])
        b = np.array(poly[(i + 1) % n])
        ab = b - a
        denom = max(float(ab @ ab), 1e-12)
        t = np.clip(((pts - a) @ ab) / denom, 0, 1)
        d = np.hypot(*(pts - (a + t[:, None] * ab)).T)
        best = np.minimum(best, d)
    return best


def dedupe(poly, eps=1e-5):
    out = []
    for p in poly:
        if not out or abs(p[0] - out[-1][0]) > eps or abs(p[1] - out[-1][1]) > eps:
            out.append(p)
    if len(out) > 1 and abs(out[0][0] - out[-1][0]) <= eps and abs(out[0][1] - out[-1][1]) <= eps:
        out.pop()
    return out


def spread_seeds(poly, n, rng, margin=0.0, keep=None):
    """`n` points inside `poly` (or within `margin` of it), each the best of
    several candidates by distance to the ones already placed - cheap blue
    noise, so shards come out even. `keep(points) -> mask` filters candidates
    further (the scatter uses it to keep only seeds whose WANDERED position
    still lands on the outline)."""
    x0, y0, x1, y1 = bbox(poly)
    x0, y0, x1, y1 = x0 - margin, y0 - margin, x1 + margin, y1 + margin
    seeds = np.zeros((0, 2))
    misses = 0
    while len(seeds) < n:
        cand = np.array([(rng.uniform(x0, x1), rng.uniform(y0, y1)) for _ in range(24)])
        near = points_in_poly(cand, poly) if margin <= 0 else (points_in_poly(cand, poly) | (dist_to_outline(cand, poly) < margin))
        cand = cand[near]
        if keep is not None and len(cand) > 0:
            cand = cand[keep(cand)]
        if len(cand) == 0:
            # A small outline under a large wander is hard to land on: keep
            # trying for a while, then settle for what we have.
            misses += 1
            if misses > 60:
                break
            continue
        if len(seeds) == 0:
            best = cand[0]
        else:
            d = np.min(np.hypot(cand[:, None, 0] - seeds[None, :, 0], cand[:, None, 1] - seeds[None, :, 1]), axis=1)
            best = cand[int(np.argmax(d))]
        seeds = np.vstack([seeds, best])
    return seeds


def smoothstep(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


# ---------------------------------------------------------------------------
# Meshes.


def evaluate(obj):
    """Bake the modifier stack into the mesh."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
    old = obj.data
    obj.modifiers.clear()
    obj.data = mesh
    bpy.data.meshes.remove(old)
    return mesh


def mesh_arrays(mesh):
    """(verts N x 3, triangles M x 3) of a mesh."""
    mesh.calc_loop_triangles()
    v = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
    mesh.vertices.foreach_get("co", v)
    t = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
    mesh.loop_triangles.foreach_get("vertices", t)
    return v.reshape(-1, 3), t.reshape(-1, 3)


def mesh_from_arrays(name, chunks):
    """One triangle mesh from (verts, tris) chunks, without a Python loop."""
    vs, ts, base = [], [], 0
    for v, t in chunks:
        vs.append(v)
        ts.append(t + base)
        base += len(v)
    v = np.concatenate(vs) if vs else np.zeros((0, 3))
    t = np.concatenate(ts) if ts else np.zeros((0, 3), dtype=np.int64)
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(len(v))
    mesh.vertices.foreach_set("co", v.astype(np.float32).ravel())
    mesh.loops.add(len(t) * 3)
    mesh.loops.foreach_set("vertex_index", t.astype(np.int32).ravel())
    mesh.polygons.add(len(t))
    mesh.polygons.foreach_set("loop_start", np.arange(0, len(t) * 3, 3, dtype=np.int32))
    mesh.update(calc_edges=True)
    return mesh


def link(name, mesh):
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def remove(obj):
    data = obj.data
    bpy.data.objects.remove(obj)
    bpy.data.meshes.remove(data)


def grid_cube(bm, cuts):
    """A 1 x 1 x 1 cube centred on the origin, cut `cuts` times per axis."""
    bmesh.ops.create_cube(bm, size=1.0)
    for axis, n in enumerate(cuts):
        for k in range(1, n):
            co = [0.0, 0.0, 0.0]
            no = [0.0, 0.0, 0.0]
            co[axis] = -0.5 + k / n
            no[axis] = 1.0
            geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=no)


def shard_templates(rng, index, remesh):
    """TEMPLATES warped, tapered, bevelled columns at S = 1, their base at
    up = -0.5 * height, centred on the origin. Catmull-Clark subdivided only
    for a remesh, which wants a rounded, dense shard to fuse; unfused, a shard
    ships as it is, so it keeps the chamfered box's few faces and crisp
    corners (two subdivision levels made it thousands of triangles)."""
    out = []
    for k in range(TEMPLATES):
        # The Voronoi field is sampled in LOCAL coordinates, so a random
        # offset of the cube picks a different stretch of it.
        off = np.array([rng.uniform(-50, 50) for _ in range(3)])
        bm = bmesh.new()
        grid_cube(bm, TEMPLATE_CUTS)
        bmesh.ops.translate(bm, vec=off.tolist(), verts=bm.verts)
        mesh = bpy.data.meshes.new(f"shard-{index}-{k}")
        bm.to_mesh(mesh)
        bm.free()
        obj = link(mesh.name, mesh)

        tex = bpy.data.textures.new(f"voronoi-{index}-{k}", "VORONOI")
        tex.noise_scale = rng.uniform(*TEMPLATE_CELL)
        tex.distance_metric = "DISTANCE"
        d = obj.modifiers.new("warp", "DISPLACE")
        d.texture = tex
        d.texture_coords = "LOCAL"
        d.direction = "NORMAL"
        d.mid_level = 0.5
        d.strength = TEMPLATE_WARP
        mesh = evaluate(obj)

        # Back to the origin, onto a unit box, then the column and its taper.
        v = np.empty(len(mesh.vertices) * 3)
        mesh.vertices.foreach_get("co", v)
        v = v.reshape(-1, 3) - off
        lo, hi = v.min(axis=0), v.max(axis=0)
        v = (v - (lo + hi) / 2) / np.maximum(hi - lo, 1e-6)
        taper = 1 + (1 / SHARD_TAPER - 1) * (v[:, 2] + 0.5)
        v[:, 0] *= taper
        v[:, 1] *= taper
        v *= np.array(SHARD_BASE)
        mesh.vertices.foreach_set("co", v.ravel())
        mesh.update()

        bev = obj.modifiers.new("bevel", "BEVEL")
        bev.width = TEMPLATE_BEVEL
        bev.segments = TEMPLATE_BEVEL_SEGMENTS if remesh else 1
        bev.limit_method = "ANGLE"
        bev.angle_limit = math.radians(TEMPLATE_BEVEL_ANGLE)
        if remesh:
            sub = obj.modifiers.new("subdiv", "SUBSURF")
            sub.subdivision_type = "CATMULL_CLARK"
            sub.levels = TEMPLATE_SUBDIV
            sub.render_levels = TEMPLATE_SUBDIV
        mesh = evaluate(obj)
        out.append(mesh_arrays(mesh))
        remove(obj)
    return out


def rotation(ay, az):
    """Rotation about Blender y (the strata tilt), after one about z (spin)."""
    cy, sy = math.cos(ay), math.sin(ay)
    cz, sz = math.cos(az), math.sin(az)
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return ry @ rz


def wander(tex, p, size, offset):
    """Centred clouds noise in [-1, 1] at a plan point, for one component."""
    return 2 * (tex.evaluate((p[0] / size + offset, p[1] / size, offset)).w - 0.5)


def wandered(tex, p, size, s):
    """A plan point moved by the large wander (sideways and up)."""
    return (
        p[0] + wander(tex, p, size, 0.0) * WANDER[0] * s,
        p[1] + wander(tex, p, size, 37.0) * WANDER[1] * s,
    )


def perimeter(poly):
    n = len(poly)
    return sum(math.hypot(poly[(i + 1) % n][0] - poly[i][0], poly[(i + 1) % n][1] - poly[i][1]) for i in range(n))


def piece_size(poly):
    """The scale S every shard, voxel and warp is sized by. ONE constant for
    the whole level: it was the piece's own plan height (clamped), and a 5 m
    wall then got shards and voxels five times coarser than a 1 m ledge, which
    read as two different materials. Rock is rock; a small piece is a small
    cut of the same stone. (`poly` is kept so a per-body scale could return.)"""
    return ROCK_SCALE


def scatter(poly, piece, templates, body_tilt, wander_tex, rng):
    """The shards of one piece: a list of (centre (x, game y), verts, tris)."""
    s = piece_size(poly)
    size = WANDER_SCALE * s
    # Where a seed's shard will actually stand: the plan position after the
    # large wander. Seeds are spread over the outline grown by the wander's
    # reach and kept by where they LAND, so the wander cannot pull every shard
    # off one edge and leave the outline uncovered there (it did: the edges
    # read as torn cloth, the recessed backing showing through).
    reach = max(WANDER) * s + SHARD_BASE[0] * SHARD_SCALE_MAX[0] * s / 2
    # Strictly INSIDE. A seed allowed to land a little outside put shards
    # hanging over an edge with a few centimetres of themselves in the outline,
    # and the clip kept that as a plate lying on the columns.
    def landed(pts):
        out = np.array([wandered(wander_tex, p, size, s) for p in pts])
        return points_in_poly(out, poly)

    grown = abs(area(poly)) + reach * perimeter(poly)
    n = int(clamp(round(grown * SHARD_DENSITY / (s * s)), 1, MAX_SHARDS))
    seeds = spread_seeds(poly, n, rng, margin=reach, keep=landed)
    # A small outline under a large wander can be impossible to land on. It
    # still gets a stone: one shard at its centre, placed without the wander.
    fixed = len(seeds) == 0
    if fixed:
        seeds = np.mean(np.array(poly), axis=0)[None, :]
    dm = depth_model(piece, s)
    front_limit = dm["front"] - 0.02
    back_limit = dm["back"]
    shards = []
    for sx, sz in seeds:
        v, t = templates[rng.randrange(len(templates))]
        scale = np.array([rng.uniform(lo, hi) for lo, hi in zip(SHARD_SCALE_MIN, SHARD_SCALE_MAX)]) * s
        rot = rotation(body_tilt, rng.uniform(-SHARD_SPIN, SHARD_SPIN))
        pts = (v * scale) @ rot.T
        # The plan position is the seed, wandered by the large noise and
        # jittered; the edge fall and the recess are read where it LANDS, so a
        # shard at the outline's edge sits back whatever its seed was.
        wx, wz = (sx, sz) if fixed else wandered(wander_tex, (sx, sz), size, s)
        px = wx + rng.uniform(-SHARD_OFFSET[0], SHARD_OFFSET[0]) * s / 2
        pz = wz + rng.uniform(-SHARD_OFFSET[1], SHARD_OFFSET[1]) * s / 2
        dist = float(dist_to_outline(np.array([[px, pz]]), poly)[0])
        edge = float(smoothstep(np.array([dist / BULGE_RADIUS]))[0])
        if rng.random() < PROUD_SHARE:
            recess = rng.uniform(-DEPTH_JITTER, DEPTH_JITTER)
        else:
            # Shallower toward the edge, so the silhouette is not a ragged
            # step down to the backing.
            recess = rng.uniform(0.15, 1.0) * dm["relief"] * (0.3 + 0.7 * edge)
        # A piece's bevel is also the TAPER: within `bevel` of the outline the
        # fronts fall along a quarter-round from the full half-depth down to
        # almost the gameplay plane at the edge, the line the ball travels, so
        # the rock swells out of the plane toward its middle and meets the
        # ball at the edge rather than standing a metre in front of it.
        bevel = piece.get("bevel", 0.0)
        # Read at the shard's NEAREST extent, not its centre: a shard whose
        # centre sits a bevel in but whose body reaches the outline would
        # otherwise stand proud right at the edge and poke past it on screen.
        x0, z0 = pts[:, 0].min() + px, pts[:, 2].min() + pz
        x1, z1 = pts[:, 0].max() + px, pts[:, 2].max() + pz
        corners = np.array([[px, pz], [x0, z0], [x1, z0], [x0, z1], [x1, z1]])
        near = float(dist_to_outline(corners, poly).min())
        if not points_in_poly(corners[1:], poly).all():
            near = 0.0
        if bevel > 0.005 and near < bevel:
            u = (bevel - near) / bevel
            taper = (piece["depth"] / 2 - TAPER_MARGIN) * (1 - math.sqrt(max(0.0, 1 - u * u)))
        else:
            taper = 0.0
        front = dm["front"] + max(dm["fall"] * (1 - edge), taper) + recess
        pts += np.array([px, front - pts[:, 1].min(), pz])
        low = pts[:, 1].min()
        if low < front_limit:
            pts[:, 1] += front_limit - low
        # A shard runs from its front all the way to the back of the solid.
        # A template's own depth is a fraction of an authored depth, and left
        # at that the shards were a thin fringe in front of a flat slab, plain
        # to see on any top face ("much thinner than the actual geometry").
        # The BACK half alone is pushed to the back, so the shard is its own
        # shape in front and a straight extrusion of its midsection behind:
        # scaling the whole shard through depth turned its spin about the
        # vertical into a lean, and every slab became a feathered wedge.
        low, high = pts[:, 1].min(), pts[:, 1].max()
        if back_limit > high:
            pts[pts[:, 1] > (low + high) / 2, 1] += back_limit - high
        pts[:, 1] = np.minimum(pts[:, 1], back_limit)
        ragged_ends(pts, poly, px, pz, piece.get("bevel", 0.0), rng)
        # Filed under where it stands, which is what the clip groups by.
        shards.append(((px, pz), pts, t))
    return shards


def outline_span(poly, x, y):
    """Where the outline lies straight above and straight below the plan point
    (x, y): (below, above) as y values, None where the ray leaves the outline
    without meeting it."""
    n = len(poly)
    above, below = None, None
    for i in range(n):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % n]
        if (ax > x) == (bx > x) or ax == bx:
            continue
        cy = ay + (by - ay) * (x - ax) / (bx - ax)
        if cy > y and (above is None or cy < above):
            above = cy
        if cy < y and (below is None or cy > below):
            below = cy
    return below, above


def ragged_ends(pts, poly, px, pz, bevel, rng):
    """A piece's `bevel` (the extrusion's chamfer) as a RAGGED EDGE: a shard
    that would reach the outline above or below its plan position is
    shortened along the level's up axis, in place, so its natural tapered end
    stops a random way short of the outline, up to the bevel. The edge then
    reads as a broken skyline of shard ends rather than as the flat plane the
    clip would have cut, and nothing is sliced to get there. Most ends stay
    near the outline (RAGGED_FLUSH of them exactly on it, the rest pulled in
    by a square law), so the ball still has stone under it at the edge."""
    if bevel <= 0.005:
        return
    below, above = outline_span(poly, px, pz)
    top, bottom = pts[:, 2].max(), pts[:, 2].min()
    length = top - bottom
    if length < 1e-6:
        return

    def pull():
        return 0.0 if rng.random() < RAGGED_FLUSH else bevel * rng.random() ** 2

    if above is not None and top > above - bevel:
        new_top = above - pull()
        if new_top - bottom > RAGGED_MIN_LENGTH * length:
            pts[:, 2] = bottom + (pts[:, 2] - bottom) * ((new_top - bottom) / length)
            top = new_top
            length = top - bottom
    if below is not None and bottom < below + bevel:
        new_bottom = below + pull()
        if top - new_bottom > RAGGED_MIN_LENGTH * length:
            pts[:, 2] = top - (top - pts[:, 2]) * ((top - new_bottom) / length)


def depth_model(piece, s):
    """Where a piece's rock sits through Blender y (= -(game z), so smaller is
    nearer the camera): `front` is the proudest face, half the authored depth
    in front of the plane like the extrusion's; `fall` is how far the front
    drops toward the outline's edge and `relief` how far a recessed shard may
    sit behind it, both capped so they fit in the depth; `backing` is where
    the slab behind the shards starts and `back` where the solid ends."""
    plane = -piece["z"]
    half = piece["depth"] / 2
    front = plane - half
    fall = min(EDGE_FALL * s, half * 0.5)
    relief = min(RELIEF * s, half * 0.9)
    # With a bevel the taper takes the edge fronts almost to the plane, and
    # the backing has to sit behind those too.
    taper = half - TAPER_MARGIN if piece.get("bevel", 0.0) > 0.005 else 0.0
    backing = front + max(fall, taper) + relief + 0.02
    back = max(plane + half, backing + MIN_BACKING)
    return {"front": front, "fall": fall, "relief": relief, "backing": backing, "back": back}


def backing(poly, parts, front, back, ring=None):
    """ONE prism of the whole outline from `front` (behind the deepest recess)
    to the back, as a single (verts, tris). Its caps are triangulated through
    the convex parts, whose corners are outline corners (`decomposeConvex`
    adds none), so the front face is one surface with no internal wall along a
    seam. One prism per part had such walls, and wherever the backing showed
    between shards the cavity darkening drew each as a faint straight line.
    `ring` substitutes other coordinates for the outline's vertices, index for
    index (the clip prism is the outline pushed out by the tolerance)."""
    k = len(poly)
    pts = np.array(poly)
    coords = poly if ring is None else ring
    v = np.array([(x, front, z) for x, z in coords] + [(x, back, z) for x, z in coords])

    def index_of(p):
        return int(np.argmin(np.hypot(pts[:, 0] - p[0], pts[:, 1] - p[1])))

    tris = []
    for part in parts:
        idx = [index_of(p) for p in part]
        for i in range(1, len(idx) - 1):
            tris.append((idx[0], idx[i], idx[i + 1]))
            tris.append((k + idx[0], k + idx[i + 1], k + idx[i]))
    for i in range(k):
        j = (i + 1) % k
        tris.append((i, k + i, k + j))
        tris.append((i, k + j, j))
    return [(v, np.array(tris))]


def piece_mesh(poly, parts, piece, templates, body_tilt, wander_tex, rng, name):
    """Shards clipped to the outline plus the backing prism, as one object."""
    shards = scatter(poly, piece, templates, body_tilt, wander_tex, rng)
    s = piece_size(poly)
    dm = depth_model(piece, s)
    back = dm["back"]
    backing_front = dm["backing"]

    # THE CLIP IS A BOOLEAN. The shards and the backing go into one mesh as
    # they are, and Blender's exact boolean intersects the lot with one prism
    # of the whole concave outline pushed out by the tolerance. Clipping by
    # half-planes against the convex parts came before this and could not be
    # made right: a seam between two parts cut every shard along a straight
    # line across the rock, and at a reflex corner the seam plane's extension
    # left a flat facet that belonged to no outline edge. The boolean also
    # fuses the overlapping shards into one shell with their corners intact,
    # which is what the voxel remesh did at a thousand times the triangles.
    ring = offset_outline(poly, tolerance(s))
    clip = link(f"{name}-clip", mesh_from_arrays(f"{name}-clip", clip_solid(poly, parts, piece, dm, tolerance(s))))
    chunks = []
    for _, v, t in shards:
        # A shard whose every vertex stands inside the pushed-out outline
        # (in plan: the prism is only ever cut through by its walls) ships as
        # it is; the rest are each intersected with the prism on their own.
        # One shard is a simple closed solid, which the float (fast) solver
        # handles well and in milliseconds; the exact solver over the whole
        # overlapping soup took half a minute for one body.
        if points_in_poly(v[:, [0, 2]], ring).all():
            chunks.append((v, t))
            continue
        tmp = link(f"{name}-shard", mesh_from_arrays(f"{name}-shard", [(v, t)]))
        mod = tmp.modifiers.new("clip", "BOOLEAN")
        mod.operation = "INTERSECT"
        mod.solver = "FLOAT"
        mod.object = clip
        cut = mesh_arrays(evaluate(tmp))
        if len(cut[1]):
            extent = cut[0].max(axis=0) - cut[0].min(axis=0)
            if extent[0] >= SLIVER * s and extent[2] >= SLIVER * s:
                chunks.append(cut)
        remove(tmp)
    remove(clip)
    # On a bevelled piece the backing keeps clear of the edge band: the ragged
    # shard ends stop short of the outline there, and a slab running up to it
    # showed its thin top edge as a plate floating above them. The inset is
    # capped by the outline's clearance so a narrow arm does not fold over.
    inset = min(piece.get("bevel", 0.0), clearance(poly) * 0.4)
    chunks += backing(poly, parts, backing_front, back, ring=offset_outline(poly, -inset) if inset > 0.005 else None)
    return link(name, mesh_from_arrays(name, chunks)), len(shards)


def clip_solid(poly, parts, piece, dm, tol):
    """The solid every shard is intersected with: the outline pushed out by
    the tolerance, from just ahead of the proudest front to well behind the
    back. It is a straight prism on purpose. A piece's bevel is NOT cut into
    it: the author wants the taper to come from where the shards stand, whole,
    not from a plane sliced through them (see the fillet in `scatter`)."""
    ring = offset_outline(poly, tol)
    return backing(poly, parts, dm["front"] - 0.03, dm["back"] + 0.5, ring=ring)


def clearance(poly):
    """The outline's narrowest span: the smallest distance from an edge to a
    vertex that is not one of its own or its neighbours' ends (those sit close
    to it at any sharp corner without the outline being narrow there)."""
    n = len(poly)
    pts = np.array(poly)
    best = np.inf
    for i in range(n):
        skip = {(i - 1) % n, i, (i + 1) % n, (i + 2) % n}
        others = np.array([p for j, p in enumerate(poly) if j not in skip])
        if len(others) == 0:
            continue
        a, b = pts[i], pts[(i + 1) % n]
        ab = b - a
        denom = max(float(ab @ ab), 1e-12)
        t = np.clip(((others - a) @ ab) / denom, 0, 1)
        best = min(best, float(np.hypot(*(others - (a + t[:, None] * ab)).T).min()))
    return best if np.isfinite(best) else 0.0


def offset_outline(poly, tol):
    """The CCW outline pushed out by `tol`: each vertex moved along the
    bisector of its two outward edge normals, the mitre clamped so an acute
    corner does not spike (a thin triangle's apex once went 0.75 m out)."""
    n = len(poly)
    out = []
    for i in range(n):
        ax, ay = poly[i - 1]
        bx, by = poly[i]
        cx, cy = poly[(i + 1) % n]
        n1 = (by - ay, -(bx - ax))
        n2 = (cy - by, -(cx - bx))
        l1, l2 = math.hypot(*n1), math.hypot(*n2)
        if l1 < 1e-9 or l2 < 1e-9:
            out.append((bx, by))
            continue
        n1 = (n1[0] / l1, n1[1] / l1)
        n2 = (n2[0] / l2, n2[1] / l2)
        d = (n1[0] + n2[0], n1[1] + n2[1])
        ld = math.hypot(*d)
        if ld < 1e-6:
            out.append((bx + n1[0] * tol, by + n1[1] * tol))
            continue
        d = (d[0] / ld, d[1] / ld)
        k = tol / max(0.5, d[0] * n1[0] + d[1] * n1[1])
        out.append((bx + d[0] * k, by + d[1] * k))
    return out


def detail_texture(name, kind, size, rng):
    tex = bpy.data.textures.new(name, kind)
    tex.noise_scale = size * rng.uniform(0.9, 1.1)
    if kind == "VORONOI":
        tex.distance_metric = "DISTANCE"
        tex.noise_intensity = 1.0
    else:
        tex.noise_depth = 6
        tex.noise_basis = "ORIGINAL_PERLIN"
    return tex


def sculpt(obj, s, index, rng, remesh):
    """The optional remesh, then the detail offsets - as modifiers.

    The offsets move every vertex by the SAME vector for a given field value
    (the author's graph multiplies a scalar texture by a constant vector), so
    they warp the rock without rounding it: a shard edge is carried along
    whole. Displacing along the normal instead eroded every edge into a blob.
    Blender's Displace has no "scalar times (1, 1, 1)" direction, so it is one
    modifier per axis sharing the texture."""
    # The remesh is OPT-IN (the wrapper's --remesh). It fuses the shards into
    # one skin, but it rebuilds that skin as a uniform grid at the voxel size,
    # which is where nearly every triangle came from (a flat slab face at a
    # 2.5 cm voxel is 3200 triangles per square metre), and its rounding is
    # what the collapse then smeared. Left out, the shards stay the bevelled
    # low-poly pieces they were instanced as, with crisp corners, and the
    # warps below bend their own vertices; the overlaps are hidden inside.
    if remesh:
        rm = obj.modifiers.new("remesh", "REMESH")
        rm.mode = "VOXEL"
        rm.voxel_size = max(VOXEL_MIN, VOXEL_SIZE * s)
        rm.adaptivity = 0.0
        rm.use_smooth_shade = False

    for k, (kind, size, strength) in enumerate(DETAIL):
        tex = detail_texture(f"detail-{index}-{k}", kind, size * s, rng)
        for axis in "XYZ":
            d = obj.modifiers.new(f"detail-{k}-{axis}", "DISPLACE")
            d.texture = tex
            d.texture_coords = "GLOBAL"
            d.direction = axis
            d.mid_level = 0.5
            d.strength = strength * s


def clamp_depth(mesh, piece, s):
    """Nothing past the front cap or the back: the detail offsets and the
    collapse both push a little past where the shards were placed."""
    dm = depth_model(piece, s)
    v = np.empty(len(mesh.vertices) * 3)
    mesh.vertices.foreach_get("co", v)
    v = v.reshape(-1, 3)
    v[:, 1] = np.clip(v[:, 1], dm["front"] - 0.02, dm["back"])
    mesh.vertices.foreach_set("co", v.ravel())
    mesh.update()


def islands(mesh):
    """A component label per vertex (union-find with pointer jumping)."""
    e = np.empty(len(mesh.edges) * 2, dtype=np.int64)
    mesh.edges.foreach_get("vertices", e)
    a, b = e[0::2], e[1::2]
    lab = np.arange(len(mesh.vertices))
    while True:
        la, lb = lab[a], lab[b]
        if np.array_equal(la, lb):
            return lab
        m = np.minimum(la, lb)
        np.minimum.at(lab, la, m)
        np.minimum.at(lab, lb, m)
        while True:
            nxt = lab[lab]
            if np.array_equal(nxt, lab):
                break
            lab = nxt


def cull(obj, piece, fused):
    """Drop the faces nobody sees, those facing away from the camera behind
    the gameplay plane, and on a FUSED (remeshed) mesh the stray islands too: a
    sliver the cut left behind, voxelised on its own. Unfused, every shard is
    its own island and none of them is stray."""
    plane = -piece["z"]
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.normal_update()
    if fused:
        lab = islands(mesh)
        sizes = np.bincount(lab, minlength=len(lab))
        stray = sizes[lab] < ISLAND_MIN * sizes.max()
        bm.verts.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.nonzero(stray)[0].tolist()], context="VERTS")
    back = [f for f in bm.faces if f.normal.y > BACK_NORMAL]
    bmesh.ops.delete(bm, geom=back, context="FACES")
    bm.to_mesh(mesh)
    bm.free()


def decimate(obj, ratio):
    """Collapse decimation to `ratio` of the faces; 1 leaves the remesh as it
    is, which is how the shape is inspected (the wrapper's --decimate 1)."""
    if ratio >= 1:
        return
    dec = obj.modifiers.new("collapse", "DECIMATE")
    dec.decimate_type = "COLLAPSE"
    dec.ratio = ratio
    evaluate(obj)


def smooth_with_sharp_edges(mesh):
    """Smooth shading, with every edge folding past SHARP_ANGLE_DEG sharp.
    In numpy: a Python loop over the edges took minutes on a big body."""
    mesh.shade_smooth()
    nl = len(mesh.loops)
    if nl == 0:
        return
    edge_of_loop = np.empty(nl, dtype=np.int64)
    mesh.loops.foreach_get("edge_index", edge_of_loop)
    totals = np.empty(len(mesh.polygons), dtype=np.int64)
    mesh.polygons.foreach_get("loop_total", totals)
    poly_of_loop = np.repeat(np.arange(len(mesh.polygons)), totals)
    normals = np.empty(len(mesh.polygons) * 3)
    mesh.polygons.foreach_get("normal", normals)
    normals = normals.reshape(-1, 3)
    # The first two polygons round each edge; an edge with one (a border) or
    # more than two (a seam inside overlapping shards) stays smooth.
    order = np.argsort(edge_of_loop, kind="stable")
    edges_sorted = edge_of_loop[order]
    polys_sorted = poly_of_loop[order]
    first = np.searchsorted(edges_sorted, np.arange(len(mesh.edges)), side="left")
    last = np.searchsorted(edges_sorted, np.arange(len(mesh.edges)), side="right")
    two = (last - first) == 2
    a = polys_sorted[np.minimum(first, len(polys_sorted) - 1)]
    b = polys_sorted[np.minimum(first + 1, len(polys_sorted) - 1)]
    cos = np.einsum("ij,ij->i", normals[a], normals[b])
    sharp = two & (cos < math.cos(math.radians(SHARP_ANGLE_DEG)))
    mesh.edges.foreach_set("use_edge_sharp", sharp)
    mesh.update()


def paint_tint(mesh, rgb):
    attr = mesh.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
    n = len(mesh.loops)
    buf = np.tile(np.array([rgb[0], rgb[1], rgb[2], 1.0], dtype=np.float32), n)
    attr.data.foreach_set("color", buf)
    mesh.color_attributes.active_color = attr


def depth_shade(mesh, span):
    """Darken the colour layer with depth: a face `span` metres behind the
    proudest one loses DEPTH_SHADE of its brightness. The game looks at a rock
    head-on, lit head-on, and from there a recessed slab is exactly as bright
    as the one in front of it; this is the occlusion a real crevice would
    have, written into COLOR_0 where the shader multiplies it in."""
    attr = mesh.color_attributes.active_color
    if attr is None or span <= 0:
        return
    co = np.empty(len(mesh.vertices) * 3)
    mesh.vertices.foreach_get("co", co)
    y = co.reshape(-1, 3)[:, 1]
    t = np.clip((y - y.min()) / span, 0, 1)
    factor = 1 - DEPTH_SHADE * t
    vi = np.empty(len(mesh.loops), dtype=np.int64)
    mesh.loops.foreach_get("vertex_index", vi)
    col = np.empty(len(mesh.loops) * 4, dtype=np.float32)
    attr.data.foreach_get("color", col)
    col = col.reshape(-1, 4)
    col[:, :3] *= factor[vi][:, None]
    attr.data.foreach_set("color", col.ravel())


def box_uvs(mesh):
    """World-metre box projection, one tile per TEXTURE_TILE: the front and
    back take (x, z), the sides (y, z), the top and bottom (x, y)."""
    nl = len(mesh.loops)
    npoly = len(mesh.polygons)
    normals = np.empty(npoly * 3)
    mesh.polygons.foreach_get("normal", normals)
    normals = np.abs(normals.reshape(-1, 3))
    totals = np.empty(npoly, dtype=np.int64)
    mesh.polygons.foreach_get("loop_total", totals)
    axis = np.repeat(np.argmax(normals, axis=1), totals)
    vidx = np.empty(nl, dtype=np.int64)
    mesh.loops.foreach_get("vertex_index", vidx)
    co = np.empty(len(mesh.vertices) * 3)
    mesh.vertices.foreach_get("co", co)
    p = co.reshape(-1, 3)[vidx]
    u = np.where(axis == 0, p[:, 1], p[:, 0])
    v = np.where(axis == 2, p[:, 1], p[:, 2])
    uv = np.stack([u, v], axis=1) / TEXTURE_TILE
    layer = mesh.uv_layers.new(name="UVMap")
    layer.data.foreach_set("uv", uv.astype(np.float32).ravel())


def join(objs, name):
    """One mesh from many, keeping their layers."""
    bm = bmesh.new()
    for o in objs:
        bm.from_mesh(o.data)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for o in objs:
        remove(o)
    obj = link(name, mesh)
    if mesh.color_attributes:
        mesh.color_attributes.active_color = mesh.color_attributes[0]
    return obj


def dirty(obj):
    """Darken the cavities into the colour layer (multiplying what is there)."""
    with bpy.context.temp_override(
        active_object=obj, object=obj, selected_editable_objects=[obj], selected_objects=[obj]
    ):
        bpy.ops.paint.vertex_color_dirt(
            blur_strength=1.0,
            blur_iterations=1,
            clean_angle=math.radians(180),
            dirt_angle=0.0,
            dirt_only=True,
            normalize=True,
        )


def load_textures():
    """The tileable stone maps from `rocktex.py`, or None without it."""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import rocktex

        out_dir = tempfile.mkdtemp(prefix="rocktex-")
        return rocktex.generate(out_dir, seed=TEXTURE_SEED, size=TEXTURE_SIZE)
    except Exception as e:  # noqa: BLE001 - any failure means the flat colour
        print(f"[rocks] no texture module, flat colour ({type(e).__name__}: {e})")
        return None


def rock_material(maps):
    mat = bpy.data.materials.new("rock")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    col = nt.nodes.new("ShaderNodeVertexColor")
    col.layer_name = "Col"
    bsdf.inputs["Roughness"].default_value = 0.92
    bsdf.inputs["Specular IOR Level"].default_value = 0.3
    if maps is None:
        nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
        return mat

    def image(key, non_color):
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = bpy.data.images.load(maps[key])
        if non_color:
            node.image.colorspace_settings.name = "Non-Color"
        return node

    albedo = image("albedo", False)
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    nt.links.new(col.outputs["Color"], mix.inputs["A"])
    nt.links.new(albedo.outputs["Color"], mix.inputs["B"])
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])

    normal = image("normal", True)
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(normal.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    rough = image("roughness", True)
    nt.links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    return mat


def build_body(body, material, collapse=COLLAPSE_RATIO, remesh=False):
    index = body["index"]
    rng = random.Random(int(body["hash"], 16))
    templates = shard_templates(rng, index, remesh)
    body_tilt = math.radians(rng.uniform(-BODY_TILT, BODY_TILT))
    wander_tex = bpy.data.textures.new(f"wander-{index}", "CLOUDS")
    wander_tex.noise_scale = 1.0
    wander_tex.noise_depth = 1
    shade = rng.uniform(1 - SHADE_JITTER, 1 + SHADE_JITTER)
    tint = tuple(clamp(c * shade * rng.uniform(1 - HUE_JITTER, 1 + HUE_JITTER), 0, 1) for c in ROCK_GREY)
    objs = []
    shards = 0
    for pi, piece in enumerate(body["pieces"]):
        poly = dedupe([(v["x"], v["y"]) for v in piece["verts"]])
        if len(poly) < 3:
            continue
        if area(poly) < 0:
            poly.reverse()
        convex = [dedupe([(v["x"], v["y"]) for v in part]) for part in piece["convex"]]
        convex = [c if area(c) >= 0 else list(reversed(c)) for c in convex if len(c) >= 3]
        if not convex:
            convex = [poly]
        obj, n = piece_mesh(poly, convex, piece, templates, body_tilt, wander_tex, rng, f"b{index}-p{pi}")
        shards += n
        sculpt(obj, piece_size(poly), index, rng, remesh)
        evaluate(obj)
        cull(obj, piece, remesh)
        decimate(obj, collapse)
        clamp_depth(obj.data, piece, piece_size(poly))
        objs.append(obj)
    if not objs:
        return None, 0
    obj = join(objs, f"body-{index}")
    smooth_with_sharp_edges(obj.data)
    paint_tint(obj.data, tint)
    dirty(obj)
    spans = [depth_model(p, piece_size(dedupe([(v["x"], v["y"]) for v in p["verts"]]))) for p in body["pieces"]]
    depth_shade(obj.data, max(d["fall"] + d["relief"] for d in spans))
    box_uvs(obj.data)
    obj.data.materials.append(material)
    obj["rockIndex"] = index
    obj["rockHash"] = body["hash"]
    return obj, shards


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :]
    job_path, out_path = argv[0], argv[1]
    with open(job_path) as f:
        job = json.load(f)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    # `scale` (the wrapper's --scale) is the rock scale for this build; the
    # constant is the default. `piece_size` reads the global at call time.
    global ROCK_SCALE
    ROCK_SCALE = float(job.get("scale", ROCK_SCALE))
    print(f"[rocks] rock scale {ROCK_SCALE:g} m")
    # `flat` (the wrapper's --flat) leaves the texture out, so the shape can be
    # judged by its shading alone.
    material = rock_material(None if job.get("flat") else load_textures())

    t0 = time.time()
    tris = 0
    built = 0
    for body in job["bodies"]:
        t = time.time()
        obj, shards = build_body(
            body, material, float(job.get("decimate", COLLAPSE_RATIO)), bool(job.get("remesh"))
        )
        if obj is None:
            continue
        built += 1
        n = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        tris += n
        print(
            f"[rocks] body {body['index']}: {len(body['pieces'])} piece(s), {shards} shards, "
            f"{n} tris, {time.time() - t:.2f}s"
        )

    kwargs = dict(
        filepath=out_path,
        export_format="GLB",
        export_apply=True,
        export_extras=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
    )
    props = bpy.ops.export_scene.gltf.get_rna_type().properties
    if "export_image_format" in props.keys():
        if "WEBP" in [e.identifier for e in props["export_image_format"].enum_items]:
            kwargs["export_image_format"] = "WEBP"
    if "export_vertex_color" in props.keys():
        # The colour layer goes out as COLOR_0 however the material uses it.
        kwargs["export_vertex_color"] = "ACTIVE"
    bpy.ops.export_scene.gltf(**kwargs)
    print(f"[rocks] {built} bodies, {tris} tris, {time.time() - t0:.1f}s -> {out_path}")


main()
