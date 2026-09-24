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
  straight prism of the concave outline (a per-shard float boolean), so the
  rock's side walls stand EXACTLY on the outline: the author wants the faces
  perpendicular to the camera flat on the outline at the gameplay plane, and
  the collision outline fitted to the rock afterwards from its silhouette.
  Half-plane clipping against convex parts came first and could not be made
  right: it cut the shards along every decomposition seam.
- A piece's TAPER (`taperStart`, `taperAngle`) is honoured by placement, not
  by cutting: from `taperStart` in front of the plane the surface leans in
  from the outline wall by `taperAngle`, and every shard's front is set so the
  whole shard stands under that surface (see `taper_top`), so the chamfer is
  a staircase of whole column ends rather than a plane sliced through them.
- The shards ship as they are (or, with --remesh, voxel-remeshed into one
  solid), warped by three smooth noises as position offsets (scalar field
  times a constant vector, never along the normal, which rounds edges off),
  stripped of the faces behind the plane that face away from the camera,
  collapse-decimated to budget unless --decimate 1, smooth shaded with the
  edges sharper than SHARP_ANGLE_DEG marked sharp, and darkened with depth.

Surface. The GLB carries no colour: the look is composed at runtime by
`render3d/rockMaterial.ts` from tileable detail sets and the MASKS this script
bakes (docs/rocks.md, "The rock material"):
- TEXCOORD_0 is a box projection in world metres (V is world up on every face
  that has one), for the detail tiles.
- TEXCOORD_1 is a per-body atlas (Smart UV Project) carrying the baked
  ambient occlusion, exported as the glTF material's occlusionTexture, which
  three reads as `aoMap` on channel 1. `--flat` skips the bake.
- COLOR_0 is masks, not colour: r = cavity (Blender's dirty vertex colours,
  1 open, 0 deep), g = depth shade (1 at the proudest face, 1 - DEPTH_SHADE at
  the deepest recess), b = a per-shard random, a = 1.
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
# How far from square-on a column's end facet may lean (degrees).
TEMPLATE_CAP_TILT = 15.0
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
# THE TAPER is the piece's own (`taperStart` metres in front of its plane,
# `taperAngle` degrees leaned in from the outline wall; 0 = no taper, 90 = a
# flat cap at the start), read in `taper_top`. It has no tunable here on
# purpose: the author sets it per geometry object in the editor.
# A taper angle under this is no taper, and over 90 minus this a flat cap.
TAPER_EPSILON = 0.05
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
# There is deliberately NO tolerance past the outline: the clip prism is the
# outline itself, so the faces perpendicular to the camera are flat on the
# collision line (a 6 + 3 % of S tolerance stood the walls 12 cm out at S = 2,
# which the author read as the rock not matching its outline). The detail
# noise still moves that wall by a few centimetres either way, which is what
# the editor's fit of the collision outline to the rock's silhouette absorbs.
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
# Without `--decimate`, the faces are PLANAR-dissolved: neighbouring faces
# within this angle become one, which folds the boolean's many coplanar
# triangles back into facets and moves no vertex, so the crisp corners stay
# and the buried-face pass stays valid. `--decimate R` is a collapse to R of
# the faces instead (1 = none), which smears; 0.3 ate the shard edges.
DISSOLVE_ANGLE_DEG = 2.0
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
# TEXCOORD_0 is world metres: one unit per this many metres, and the runtime
# material sets each detail tile's repeat from its own life size.
TEXTURE_TILE = 1.0
# THE AMBIENT OCCLUSION BAKE (Cycles, CPU): texels per metre of the body's
# surface (the atlas is the power of two nearest sqrt(area) * this, clamped),
# the samples per texel, how far a face looks for occluders, and the margin
# the bake bleeds past each island so filtering never reads the void.
AO_TEXELS = 48
AO_SIZE_MIN = 128
AO_SIZE_MAX = 1024
AO_SAMPLES = 32
AO_DISTANCE = 1.5
AO_MARGIN_PX = 4
# THE BURIED FACES ARE DELETED before the shards are joined: they overlap,
# so most of a body's faces lie inside neighbouring shards, where nobody
# sees them. A face is buried when the point this far outside it (along its
# normal) is inside another shard's solid (see `drop_buried`). Left in, they
# were most of the atlas, all of it black, and the small visible caps packed
# beside them read black through the filtering ("a hole in the top face");
# and they were half the triangles. An occlusion test came first and took
# the faces at the bottom of narrow slits too, which ARE seen straight down
# the slit: the background showed through.
BURIED_EPSILON = 0.002
# ...and it has to be buried DEEPER than the detail noise can move a face,
# as a share of S: the noise displaces the buried face and the face covering
# it by different amounts, and a face buried by less than that poked out
# through its cover after the sculpt, a sky-coloured triangle in the rock.
# The three DETAIL offsets sum to 0.032 S per axis, half of it either way.
BURIED_MARGIN_RATIO = 0.03
# How far, at most, a clipped shard's cut face is set in from the outline
# wall (see `inset_wall`); each shard draws its own amount in a quarter of
# this to all of it, so no two cut faces share a plane.
RIM_INSET = 0.006
# The unwrap's spacing between islands, as a share of the atlas, and the
# angle between neighbouring faces under which they stay in one island. A
# body is tens of thousands of small faces, so the margin has to be tiny: at
# 0.02 the packer shrank every island to a dot to honour it and the atlas
# was 2 % covered.
# Two texels at the largest atlas, so bilinear filtering never reads across
# into a neighbouring island.
AO_ISLAND_MARGIN = 0.002
AO_ISLAND_ANGLE = 80.0


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
    """One triangle mesh from chunks, without a Python loop. A chunk is a
    (verts, tris) pair or a `chunk` dict; a dict's
    - `mark` becomes the per-vertex float attribute "shard" (the per-shard
      variation the runtime material reads out of COLOR_0.b),
    - `sid` the per-vertex int attribute "shard_id" (PROVENANCE, below),
    - `prov` (one value per triangle) the per-face int attribute "provenance";
    all three ride through the modifiers and the join like any layer."""
    chunks = [c if isinstance(c, dict) else {"v": c[0], "t": c[1]} for c in chunks]
    vs, ts, base = [], [], 0
    for c in chunks:
        vs.append(c["v"])
        ts.append(c["t"] + base)
        base += len(c["v"])
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
    if not len(v):
        return mesh
    counts = [len(c["v"]) for c in chunks]
    if all("mark" in c for c in chunks):
        attr = mesh.attributes.new("shard", "FLOAT", "POINT")
        attr.data.foreach_set("value", np.repeat(np.array([c["mark"] for c in chunks], dtype=np.float32), counts))
    if all("sid" in c for c in chunks):
        attr = mesh.attributes.new("shard_id", "INT", "POINT")
        attr.data.foreach_set("value", np.repeat(np.array([c["sid"] for c in chunks], dtype=np.int32), counts))
    if all("prov" in c for c in chunks):
        attr = mesh.attributes.new("provenance", "INT", "FACE")
        attr.data.foreach_set("value", np.concatenate([c["prov"] for c in chunks]).astype(np.int32))
    return mesh


# PROVENANCE: which step last made or altered each face, carried as the int
# face attribute "provenance" through the build and exported (unless the
# wrapper's --no-debug-attributes) as the glTF attribute _PROVENANCE, one value
# per corner, beside _SHARD, the chunk's id (see `debug_attributes`). A hole on
# screen then reads "shard 143, a float-clip face" rather than "a hole"
# (docs/rocks.md, "Diagnosing"). A step that deletes faces cannot mark them;
# those are counted in the build report instead.
PROV_TEMPLATE = 1
PROV_FLOAT_CLIP = 2
PROV_EXACT_CLIP = 3
PROV_FILL = 4
PROV_BACKING = 5
PROV_RIM = 6
PROV_DISSOLVE = 7
PROV_NAMES = {
    PROV_TEMPLATE: "template",
    PROV_FLOAT_CLIP: "float clip",
    PROV_EXACT_CLIP: "exact clip",
    PROV_FILL: "hole fill",
    PROV_BACKING: "backing",
    PROV_RIM: "rim inset",
    PROV_DISSOLVE: "planar dissolve",
}


def debug_attributes(mesh):
    """The build's "shard_id" and "provenance" as the exported _SHARD (per
    vertex) and _PROVENANCE (per corner: glTF has no per-face attribute, and
    the exporter's own face-domain path is a Python loop over every polygon).
    Blender's glTF exporter writes an attribute whose name starts with an
    underscore when `export_attributes` is on, as a float accessor (glTF has
    no signed int attribute), which three exposes as `_shard`/`_provenance`."""
    if "shard_id" in mesh.attributes:
        sid = np.empty(len(mesh.vertices), dtype=np.int32)
        mesh.attributes["shard_id"].data.foreach_get("value", sid)
        mesh.attributes.new("_SHARD", "INT", "POINT").data.foreach_set("value", sid)
    if "provenance" in mesh.attributes:
        prov = np.empty(len(mesh.polygons), dtype=np.int32)
        mesh.attributes["provenance"].data.foreach_get("value", prov)
        totals = np.empty(len(mesh.polygons), dtype=np.int64)
        mesh.polygons.foreach_get("loop_total", totals)
        mesh.attributes.new("_PROVENANCE", "INT", "CORNER").data.foreach_set("value", np.repeat(prov, totals))


def face_ints(mesh, name, default=0):
    out = np.full(len(mesh.polygons), default, dtype=np.int32)
    if name in mesh.attributes:
        mesh.attributes[name].data.foreach_get("value", out)
    return out


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
        # Where each vertex started, to find the end caps after the warp (a
        # deform modifier keeps the vertex order).
        base = np.array([vert.co[:] for vert in bm.verts])
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
        # THE END CAPS ARE ONE PLANE EACH. The cap is cut into four quads by
        # the grid, and the warp moved their shared centre and edge vertices
        # by different amounts, folding every column end into a crown of
        # notches ("weirdly angled tops"). A column end is a single facet,
        # so the cap's vertices are put back on one plane through their
        # centroid, tilted a random way by up to TEMPLATE_CAP_TILT.
        for sign in (1.0, -1.0):
            cap = base[:, 2] * sign > 0.49
            if not cap.any():
                continue
            tilt = math.tan(math.radians(rng.uniform(0, TEMPLATE_CAP_TILT)))
            phi = rng.uniform(0, 2 * math.pi)
            centre = v[cap].mean(axis=0)
            v[cap, 2] = centre[2] + tilt * (math.cos(phi) * (v[cap, 0] - centre[0]) + math.sin(phi) * (v[cap, 1] - centre[1]))
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
        out.append(outward(*mesh_arrays(mesh)))
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
        # THE TAPER: the shard's front is set under the tapered surface (see
        # `taper_top`) read at the shard's NEAREST extent, not its centre, so
        # the WHOLE shard stands under the surface - a shard whose centre sits
        # well inside but whose body reaches the outline would otherwise stand
        # proud right at the edge and poke past the collision line on screen
        # ("geometry in thin air"). The chamfer is therefore a staircase of
        # whole column ends, one step per shard, never a plane cut through
        # them, which is what the author asked for.
        x0, z0 = pts[:, 0].min() + px, pts[:, 2].min() + pz
        x1, z1 = pts[:, 0].max() + px, pts[:, 2].max() + pz
        corners = np.array([[px, pz], [x0, z0], [x1, z0], [x0, z1], [x1, z1]])
        near = float(dist_to_outline(corners, poly).min())
        if not points_in_poly(corners[1:], poly).all():
            near = 0.0
        taper = piece["depth"] / 2 - taper_top(piece, near)
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
        # The stretch is along the shard's OWN depth axis, about its front-most
        # point: an affine map, so every face stays planar. Scaling world y
        # sheared the spun shards into a lean, and shifting only the back
        # half by a step folded every cap that spanned the shard's depth into
        # a V (the "weirdly angled tops" came back as creases).
        axis = rot @ np.array([0.0, 1.0, 0.0])
        along = pts @ axis
        span = along.max() - along.min()
        need = back_limit - pts[:, 1].max()
        if need > 0 and span > 1e-6 and abs(axis[1]) > 0.5:
            pts += np.outer((along - along.min()) * (need / (span * axis[1])), axis)
        pts[:, 1] = np.minimum(pts[:, 1], back_limit)
        # Filed under where it stands, which is what the clip groups by.
        shards.append(((px, pz), pts, t))
    return shards


def taper_top(piece, near):
    """The TAPERED SURFACE: the game z (relative to the piece's plane, + toward
    the camera) the rock may reach `near` metres inside the outline. Below
    `taperStart` the side walls stand on the outline; from there the surface
    leans in from the wall by `taperAngle`, a straight chamfer, so the rise
    per metre inward is 1/tan(angle), until it reaches the proudest front at
    half the depth. An angle of 0 is no taper (the surface is the front
    everywhere), 90 a flat cap at the start. The start may sit behind the
    plane, in which case the edge shards stand behind the ball's line; it is
    clamped to the solid. A quarter-round came before this and was rejected:
    its profile is vertical at the outline, so a strip of the edge showed no
    taper however the margin was set."""
    half = piece["depth"] / 2
    angle = float(piece.get("taperAngle", 0.0))
    if angle <= TAPER_EPSILON:
        return half
    start = clamp(float(piece.get("taperStart", 0.0)), -half, half)
    if angle >= 90 - TAPER_EPSILON:
        return start
    return min(half, start + max(near, 0.0) / math.tan(math.radians(angle)))


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
    # The taper takes the edge fronts down to its start, and the backing has
    # to sit behind those too.
    taper = half - taper_top(piece, 0.0)
    backing = front + max(fall, taper) + relief + 0.02
    back = max(plane + half, backing + MIN_BACKING)
    return {"front": front, "fall": fall, "relief": relief, "backing": backing, "back": back}


def backing(poly, parts, front, back):
    """ONE prism of the whole outline from `front` (behind the deepest recess)
    to the back, as a single (verts, tris). Its caps are triangulated through
    the convex parts, whose corners are outline corners (`decomposeConvex`
    adds none), so the front face is one surface with no internal wall along a
    seam. One prism per part had such walls, and wherever the backing showed
    between shards the cavity darkening drew each as a faint straight line.
    The clip solid is the same prism, longer through depth."""
    k = len(poly)
    pts = np.array(poly)
    v = np.array([(x, front, z) for x, z in poly] + [(x, back, z) for x, z in poly])

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


def piece_mesh(poly, parts, piece, templates, body_tilt, wander_tex, rng, name, sid_base, stages):
    """Shards clipped to the outline plus the backing prism, as one object.
    Every shard is chunk `sid_base + k` (k its index in the scatter, so a
    shard keeps its id through every stage whether or not it survives the
    clip) and the backing is the id after the last shard. Returns the object,
    the shard count and this piece's build report; `stages`, when dumping,
    collects the chunks before the clip, after it and after the buried pass."""
    shards = scatter(poly, piece, templates, body_tilt, wander_tex, rng)
    s = piece_size(poly)
    dm = depth_model(piece, s)
    back = dm["back"]
    backing_front = dm["backing"]
    backing_sid = sid_base + len(shards)
    report = {
        "piece": name,
        "shards": len(shards),
        "ids": [sid_base, backing_sid],
        "clipped": 0,
        "slivers": 0,
        "exact": 0,
        "filled": 0,
        "rejected": 0,
        "dropped": 0,
        "rewound": 0,
        "open": 0,
        "openIds": [],
        "buried": 0,
    }

    # THE CLIP IS A BOOLEAN. Each shard reaching past the outline is
    # intersected with one straight prism of the whole concave outline, so
    # every cut face lies exactly on the collision line. Clipping by
    # half-planes against the convex parts came before this and could not be
    # made right: a seam between two parts cut every shard along a straight
    # line across the rock, and at a reflex corner the seam plane's extension
    # left a flat facet that belonged to no outline edge.
    clip = link(f"{name}-clip", mesh_from_arrays(f"{name}-clip", clip_solid(poly, parts, dm)))
    chunks = []
    for k, (_, v, t) in enumerate(shards):
        sid = sid_base + k
        # Drawn for every shard, kept or not, so the random stream (and so
        # every later shard) is the same whatever the clip decides.
        mark = rng.random()
        # A shard whose every vertex stands inside the outline (in plan: the
        # prism is only ever cut through by its walls) ships as it is; the
        # rest are each intersected with the prism on their own. One shard is
        # a simple closed solid, which the float (fast) solver handles well
        # and in milliseconds; the exact solver over the whole overlapping
        # soup took half a minute for one body.
        if points_in_poly(v[:, [0, 2]], poly).all():
            chunks.append({"v": v, "t": t, "prov": np.full(len(t), PROV_TEMPLATE), "sid": sid, "mark": mark})
            continue
        report["clipped"] += 1
        cut = clip_shard(name, v, t, clip, report, sid)
        # Drawn even under --no-inset, for the same reason as the mark.
        inset = rng.uniform(RIM_INSET * 0.25, RIM_INSET)
        if not FLAGS["noInset"]:
            cut = inset_wall(cut, poly, inset)
        kept = False
        if len(cut["t"]):
            extent = cut["v"].max(axis=0) - cut["v"].min(axis=0)
            if extent[0] >= SLIVER * s and extent[2] >= SLIVER * s:
                cut.update(sid=sid, mark=mark)
                chunks.append(cut)
                kept = True
            else:
                report["slivers"] += 1
    remove(clip)
    # The backing is one chunk; it takes the middle of the variation range.
    for v, t in backing(poly, parts, backing_front, back):
        chunks.append({"v": v, "t": t, "prov": np.full(len(t), PROV_BACKING), "sid": backing_sid, "mark": 0.5})
    # A chunk still open here is a hole in the rock: the buried pass below
    # opens chunks on purpose, so this is the last point closedness means
    # anything. The wrapper fails the build on any.
    for c in chunks:
        if not is_closed(c["t"]):
            report["open"] += 1
            report["openIds"].append(int(c["sid"]))
    if stages is not None:
        stages["scatter"].append(
            [{"v": v, "t": t, "prov": np.full(len(t), PROV_TEMPLATE), "sid": sid_base + k, "mark": 0.5} for k, (_, v, t) in enumerate(shards)]
            + [c for c in chunks if c["sid"] == backing_sid]
        )
        stages["clipped"].append([dict(c) for c in chunks])
    t = time.time()
    if FLAGS["noBuried"]:
        gone = 0
    else:
        chunks, gone = drop_buried(chunks, s)
    report["buried"] = gone
    if stages is not None:
        stages["buried"].append(chunks)
    print(f"[rocks] {name}: {gone} buried triangles dropped, {time.time() - t:.1f}s")
    return link(name, mesh_from_arrays(name, chunks)), len(shards), report


def clip_solid(poly, parts, dm):
    """The solid every shard is intersected with: the outline itself, from
    just ahead of the proudest front to well behind the back. It is a
    straight prism on purpose. A piece's taper is NOT cut into it: the author
    wants the taper to come from where the shards stand, whole, not from a
    plane sliced through them (see `taper_top` and `scatter`)."""
    return backing(poly, parts, dm["front"] - 0.03, dm["back"] + 0.5)


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
        # Made (and its random size drawn) even under --no-detail, so the
        # random stream after it is the same as a build with the detail.
        tex = detail_texture(f"detail-{index}-{k}", kind, size * s, rng)
        if FLAGS["noDetail"]:
            continue
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
    its own island and none of them is stray. Returns how many faces went."""
    mesh = obj.data
    if FLAGS["noCull"]:
        return 0
    before = len(mesh.polygons)
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
    return before - len(mesh.polygons)


def decimate(obj, ratio):
    """`ratio` None: planar dissolve (see DISSOLVE_ANGLE_DEG). A number:
    collapse to that share of the faces, 1 leaving the mesh as it is, which
    is how the shape is inspected (the wrapper's --decimate 1)."""
    if ratio is None:
        dec = obj.modifiers.new("dissolve", "DECIMATE")
        dec.decimate_type = "DISSOLVE"
        dec.angle_limit = math.radians(DISSOLVE_ANGLE_DEG)
        dec.use_dissolve_boundaries = False
        mesh = evaluate(obj)
        # Every face is a triangle going in, so a polygon of more than three
        # corners coming out is triangles the dissolve merged.
        totals = np.empty(len(mesh.polygons), dtype=np.int64)
        mesh.polygons.foreach_get("loop_total", totals)
        if "provenance" in mesh.attributes:
            prov = face_ints(mesh, "provenance")
            prov[totals > 3] = PROV_DISSOLVE
            mesh.attributes["provenance"].data.foreach_set("value", prov)
        return
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


def white_layer(mesh):
    """The colour layer the dirt pass darkens, starting white."""
    # FLOAT, not byte: a byte colour layer is stored as sRGB and the exporter
    # linearises it, which would hand the shader every mask raised to 2.2.
    attr = mesh.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="CORNER")
    attr.data.foreach_set("color", np.tile(np.array([1.0, 1.0, 1.0, 1.0], dtype=np.float32), len(mesh.loops)))
    mesh.color_attributes.active_color = attr


def masks(mesh, span):
    """COLOR_0 as the MASKS the runtime material composes the colour from
    (docs/rocks.md, "The rock material"): r = cavity, the dirt pass's value
    (1 open, 0 deep); g = depth shade, 1 at the proudest face falling to
    1 - DEPTH_SHADE at `span` behind it (the game looks at a rock head-on, lit
    head-on, and from there a recessed slab is exactly as bright as the one
    in front of it, so this is the crevice's occlusion said in a number);
    b = the per-shard random from the "shard" attribute; a = 1."""
    attr = mesh.color_attributes.active_color
    nl = len(mesh.loops)
    col = np.empty(nl * 4, dtype=np.float32)
    attr.data.foreach_get("color", col)
    col = col.reshape(-1, 4)
    cavity = col[:, 0].copy()
    vi = np.empty(nl, dtype=np.int64)
    mesh.loops.foreach_get("vertex_index", vi)
    co = np.empty(len(mesh.vertices) * 3)
    mesh.vertices.foreach_get("co", co)
    y = co.reshape(-1, 3)[:, 1]
    depth = np.ones(len(mesh.vertices))
    if span > 0:
        depth = 1 - DEPTH_SHADE * np.clip((y - y.min()) / span, 0, 1)
    shard = np.full(len(mesh.vertices), 0.5, dtype=np.float32)
    if "shard" in mesh.attributes:
        mesh.attributes["shard"].data.foreach_get("value", shard)
    col[:, 0] = cavity
    col[:, 1] = depth[vi]
    col[:, 2] = np.clip(shard[vi], 0, 1)
    col[:, 3] = 1
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


def gltf_output_group():
    """The node group the glTF exporter reads extra channels from: a group
    named "glTF Material Output" with an "Occlusion" input becomes the
    material's occlusionTexture."""
    grp = bpy.data.node_groups.get("glTF Material Output")
    if grp is None:
        grp = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        grp.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
        grp.nodes.new("NodeGroupInput")
    return grp


def rock_material(index, ao_image):
    """One material per body: a plain grey Principled the runtime replaces,
    carrying the baked AO on the "AO" UV layer as the glTF occlusionTexture
    (so three mounts it as `aoMap`, channel 1). The image node is the
    material's active node, which is where Cycles' bake writes."""
    mat = bpy.data.materials.new(f"rock-{index}")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.3, 0.3, 0.3, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.9
    if ao_image is None:
        return mat
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "AO"
    img = nt.nodes.new("ShaderNodeTexImage")
    img.image = ao_image
    ao_image.colorspace_settings.name = "Non-Color"
    nt.links.new(uv.outputs["UV"], img.inputs["Vector"])
    out = nt.nodes.new("ShaderNodeGroup")
    out.node_tree = gltf_output_group()
    nt.links.new(img.outputs["Color"], out.inputs["Occlusion"])
    # Last, because adding a node makes it the active one, and the bake
    # writes into the ACTIVE AND SELECTED image node's image. Activating
    # clears the selection, so the select comes after.
    nt.nodes.active = img
    img.select = True
    return mat


def ao_size(mesh):
    """The AO atlas side: the power of two nearest AO_TEXELS per metre of the
    body's surface, clamped."""
    areas = np.empty(len(mesh.polygons))
    mesh.polygons.foreach_get("area", areas)
    px = math.sqrt(max(areas.sum(), 1e-6)) * AO_TEXELS
    size = 2 ** int(round(math.log2(max(px, 1))))
    return int(clamp(size, AO_SIZE_MIN, AO_SIZE_MAX))


def ao_uvs(obj):
    """A second UV layer "AO": the body unwrapped into an atlas by Smart UV
    Project. The box projection stays the active (first) layer."""
    mesh = obj.data
    layer = mesh.uv_layers.new(name="AO")
    mesh.uv_layers.active = layer
    bpy.context.view_layer.objects.active = obj
    # This body ALONE: every selected mesh enters edit mode with the active
    # one, and the unwrap then ran over the previous body too, replacing its
    # box projection (the level build's detail tiles all read through the
    # atlas).
    for o in bpy.context.scene.objects:
        o.select_set(o is obj)
    with bpy.context.temp_override(active_object=obj, object=obj, selected_objects=[obj], selected_editable_objects=[obj]):
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(AO_ISLAND_ANGLE), island_margin=AO_ISLAND_MARGIN, scale_to_bounds=False)
        # Repacked by the island packer proper: Smart UV Project's own packing
        # of thousands of small islands left most of the atlas empty.
        bpy.ops.uv.pack_islands(margin=AO_ISLAND_MARGIN, rotate=True)
        bpy.ops.object.mode_set(mode="OBJECT")
    uv = np.empty(len(mesh.loops) * 2)
    mesh.uv_layers["AO"].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    print(f"[rocks] AO uvs: {len(uv)} loops, u {uv[:, 0].min():.2f}..{uv[:, 0].max():.2f}, v {uv[:, 1].min():.2f}..{uv[:, 1].max():.2f}")
    mesh.uv_layers.active = mesh.uv_layers["UVMap"]
    # The share of the atlas the islands cover (they do not overlap once
    # packed, so it is the summed area of the UV triangles): the number that
    # read 2 % when the island margin starved the packer.
    mesh.calc_loop_triangles()
    lt = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
    mesh.loop_triangles.foreach_get("loops", lt)
    a, b, c = (uv[lt.reshape(-1, 3)[:, k]] for k in range(3))
    return float(np.abs(np.cross(b - a, c - a)).sum() / 2)


def bake_alone(obj, samples, **kwargs):
    """Cycles ambient occlusion of the body ALONE: every other object is
    hidden from the render, so a rock is not darkened by whichever neighbour
    happened to be built already (the extrusion-drawn bodies are not in the
    scene at all, so occlusion between bodies would be inconsistent).
    `kwargs` go to the bake operator (the target and its layer)."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    if scene.world is None:
        scene.world = bpy.data.worlds.new("world")
    light = getattr(scene.world, "light_settings", None)
    if light is not None:
        light.distance = AO_DISTANCE
    scene.render.bake.use_selected_to_active = False
    others = [o for o in scene.objects if o is not obj]
    hidden = [(o, o.hide_render) for o in others]
    for o in others:
        o.hide_render = True
    bpy.context.view_layer.objects.active = obj
    for o in scene.objects:
        o.select_set(o is obj)
    try:
        with bpy.context.temp_override(active_object=obj, object=obj, selected_objects=[obj], selected_editable_objects=[obj]):
            bpy.ops.object.bake(type="AO", use_clear=True, **kwargs)
    finally:
        for o, was in hidden:
            o.hide_render = was


def inset_wall(chunk, poly, amount):
    """The clipped chunk with the vertices it has ON the outline moved
    `amount` inward, along the inward normal of the nearest outline edge.
    Every clipped shard's cut face lies in the same prism wall plane, and
    where shards overlap those coincident faces z-fought on screen, a jagged
    dark pattern all along the rim; a different inset per shard stacks them a
    few millimetres apart instead, with the backing's wall (never inset) as
    the outermost, clean face. Every face with a moved corner is marked
    PROV_RIM."""
    v, t = chunk["v"], chunk["t"]
    if len(v) == 0:
        return chunk
    pts = v[:, [0, 2]]
    n = len(poly)
    best = np.full(len(pts), np.inf)
    normal = np.zeros((len(pts), 2))
    for i in range(n):
        a = np.array(poly[i])
        b = np.array(poly[(i + 1) % n])
        ab = b - a
        length = math.hypot(*ab)
        if length < 1e-9:
            continue
        t_ = np.clip(((pts - a) @ ab) / (length * length), 0, 1)
        d = np.hypot(*(pts - (a + t_[:, None] * ab)).T)
        closer = d < best
        best[closer] = d[closer]
        # Counter-clockwise outline: the inward normal is the edge turned left.
        normal[closer] = np.array([-ab[1], ab[0]]) / length
    on = best < 1e-4
    if not on.any():
        return chunk
    v = v.copy()
    v[on, 0] += normal[on, 0] * amount
    v[on, 2] += normal[on, 1] * amount
    prov = chunk["prov"].copy()
    prov[on[t].any(axis=1)] = PROV_RIM
    return {**chunk, "v": v, "prov": prov}


def is_closed(t):
    """Whether every edge of the triangle soup is shared by exactly two
    triangles: a watertight solid."""
    if len(t) == 0:
        return True
    e = np.sort(np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]]), axis=1)
    _, counts = np.unique(e, axis=0, return_counts=True)
    return bool((counts == 2).all())


def fill_holes(v, t):
    """The soup with its boundary loops filled and triangulated, and which of
    its triangles are new (a boolean per triangle). Vertices keep their order
    (the fill adds none), so a triangle is original when its vertex set is one
    of the input's."""
    bm = bmesh.new()
    verts = [bm.verts.new(p.tolist()) for p in v]
    for a, b, c in t.tolist():
        try:
            bm.faces.new((verts[a], verts[b], verts[c]))
        except ValueError:
            pass
    bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=0)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new("filled")
    bm.to_mesh(mesh)
    bm.free()
    fv, ft = mesh_arrays(mesh)
    bpy.data.meshes.remove(mesh)
    before = {tuple(sorted(tri)) for tri in t.tolist()}
    new = np.array([tuple(sorted(tri)) not in before for tri in ft.tolist()], dtype=bool)
    return fv, ft, new


def clip_shard(name, v, t, clip, report, sid):
    """One shard intersected with the clip prism, WATERTIGHT: the float
    solver's result is taken when it is closed, otherwise the exact solver's,
    and a result still open after that has its holes filled. The float
    solver returned 8 of body 150's 275 shards with triangles missing, open
    shells whose missing faces were holes in the rock ("the missing face at
    the bottom of the column"). Returns a chunk dict whose `prov` says which
    solver (or the fill) made each triangle; `report` counts what it took.
    Under --no-repair the float result is taken as it comes, open or inside
    out, which reproduces both boolean failures on demand."""
    # An intersection lies inside the shard. A result that does not is the
    # solver handing back the wrong operand: the exact solver once returned
    # the CLIP PRISM for a shard it could not cut, closed and body-sized, and
    # that slab stood at the front of body 110 hiding every real shard behind
    # it ("why does it look like a smooth wall").
    lo = v.min(axis=0) - 1e-3
    hi = v.max(axis=0) + 1e-3

    def within(cut):
        return len(cut[0]) == 0 or (bool((cut[0] >= lo).all()) and bool((cut[0] <= hi).all()))

    def chunk(cv, ct, prov):
        return {"v": cv, "t": ct, "prov": np.full(len(ct), prov) if np.isscalar(prov) else prov}

    first = None
    for solver in ("FLOAT", "EXACT"):
        tmp = link(f"{name}-shard", mesh_from_arrays(f"{name}-shard", [(v, t)]))
        mod = tmp.modifiers.new("clip", "BOOLEAN")
        mod.operation = "INTERSECT"
        mod.solver = solver
        if solver == "EXACT":
            mod.use_self = False
        mod.object = clip
        cut = mesh_arrays(evaluate(tmp))
        remove(tmp)
        prov = PROV_FLOAT_CLIP if solver == "FLOAT" else PROV_EXACT_CLIP
        if FLAGS["noRepair"]:
            return chunk(cut[0], cut[1], prov)
        if not within(cut):
            report["rejected"] += 1
            continue
        if first is None:
            first = (cut, prov)
        if is_closed(cut[1]):
            if solver == "EXACT":
                report["exact"] += 1
            return chunk(*outward(*cut, report), prov)
    if first is None:
        # Neither solver produced anything inside the shard: no shard.
        report["dropped"] += 1
        return chunk(v[:0], t[:0], PROV_TEMPLATE)
    report["filled"] += 1
    (cv, ct), prov = first
    fv, ft, new = fill_holes(cv, ct)
    fv, ft = outward(fv, ft, report)
    return chunk(fv, ft, np.where(new, PROV_FILL, prov))


def outward(v, t, report=None):
    """(v, t) with its triangles wound so the normals point OUT: the float
    boolean now and then returns a shard inside out (3 of 275 on body 150),
    and an inside-out shard has its front faces taken by the back-face cull
    and its back faces kept, a hollow shell showing its far wall from inside
    ("a hole in the top face"). The sign of the enclosed volume says which
    way a closed solid is wound. A re-wind is counted in `report`."""
    if len(t) == 0:
        return v, t
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    volume = np.einsum("ij,ij->i", a, np.cross(b, c)).sum()
    if volume >= 0:
        return v, t
    if report is not None:
        report["rewound"] += 1
    return v, t[:, [0, 2, 1]]


def drop_buried(chunks, s):
    """The chunks of one piece with their buried triangles removed (see
    BURIED_EPSILON): a triangle whose centre, pushed just outside its own
    solid along its normal, lies at least BURIED_MARGIN_RATIO of S inside
    another chunk.
    Inside is the HALF-SPACE test, behind every face plane of the other
    chunk. For a convex chunk that is exact, and for a concave one (a shard
    clipped by the concave outline) the intersection of the half-spaces is a
    subset of the solid, so the test can only keep a face it could have
    dropped, never drop one it should have kept. Ray parity came first and
    double-counted rays through shared edges of the many coplanar triangle
    pairs, and the rock came out riddled with gaps. The chunks a point can
    be inside are prefiltered by bounding box. Returns the chunks and how
    many triangles went."""
    planes = []
    bounds = []
    for c in chunks:
        v, t = c["v"], c["t"]
        a, b, cc = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
        n = np.cross(b - a, cc - a)
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        planes.append((n, np.einsum("ij,ij->i", n, a)))
        bounds.append((v.min(axis=0), v.max(axis=0)))
    lo = np.array([b[0] for b in bounds])[None, :, :] - BURIED_EPSILON
    hi = np.array([b[1] for b in bounds])[None, :, :] + BURIED_EPSILON
    out = []
    gone = 0
    for i, c in enumerate(chunks):
        v, t = c["v"], c["t"]
        n, _ = planes[i]
        a, b, cc = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
        probe = (a + b + cc) / 3 + n * BURIED_EPSILON
        within = np.all((probe[:, None, :] >= lo) & (probe[:, None, :] <= hi), axis=2)
        within[:, i] = False
        buried = np.zeros(len(t), dtype=bool)
        for j in np.nonzero(within.any(axis=0))[0]:
            rows = np.nonzero(within[:, j] & ~buried)[0]
            if len(rows) == 0:
                continue
            nj, dj = planes[j]
            behind = (probe[rows] @ nj.T - dj[None, :]) <= -BURIED_MARGIN_RATIO * s
            buried[rows[behind.all(axis=1)]] = True
        gone += int(buried.sum())
        out.append({**c, "t": t[~buried], "prov": c["prov"][~buried]})
    return out, gone


def bake_ao(obj, image):
    """Cycles ambient occlusion into `image` through the "AO" layer."""
    bpy.context.scene.render.bake.margin = AO_MARGIN_PX
    bake_alone(obj, AO_SAMPLES, margin=AO_MARGIN_PX, uv_layer="AO", target="IMAGE_TEXTURES")
    px = np.empty(image.size[0] * image.size[1] * 4, dtype=np.float32)
    image.pixels.foreach_get(px)
    mean = float(px.reshape(-1, 4)[:, 0].mean())
    print(f"[rocks] AO image mean {mean:.3f}")
    # Saved to disk so the exporter has bytes to embed (a generated image has
    # pixels but no file, and the exporter converts from the file).
    image.filepath_raw = os.path.join(tempfile.gettempdir(), f"{image.name}.png")
    image.file_format = "PNG"
    image.save()
    return mean


STAGES = ("scatter", "clipped", "buried", "sculpted", "culled", "final")


def stage_object(name, mesh=None, chunks=None):
    """A stage dump's object: a copy of `mesh`, or a mesh of `chunks`."""
    data = mesh.copy() if mesh is not None else mesh_from_arrays(name, chunks)
    return link(name, data)


def dump_stages(index, stages, out_dir):
    """One GLB per body, `body-<i>.stages.glb`, one node per stage named
    `<stage>-body-<i>`, each carrying _SHARD and _PROVENANCE, so a face picked
    in the game is found in every stage by its shard id and the first stage it
    is missing from is the step that removed it (`cli rocks-check <dump>
    --shard N`). The objects are removed again, so the level file never sees
    them."""
    objs = []
    for stage in STAGES:
        parts = stages[stage]
        if not parts:
            continue
        name = f"{stage}-body-{index}"
        if all(isinstance(p, list) for p in parts):
            obj = stage_object(name, chunks=[c for p in parts for c in p])
        else:
            obj = join([stage_object(f"{name}-{k}", mesh=p) for k, p in enumerate(parts)], name)
        debug_attributes(obj.data)
        obj["stage"] = stage
        obj["rockIndex"] = index
        objs.append(obj)
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    path = os.path.join(out_dir, f"body-{index}.stages.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_extras=True,
        export_yup=True,
        export_normals=True,
        export_attributes=True,
        export_materials="NONE",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
    )
    for o in objs:
        remove(o)
    print(f"[rocks] body {index}: stages -> {path}")


def build_body(body, flat, collapse=None, remesh=False):
    """The body's object, its shard count and its build report."""
    index = body["index"]
    t_body = time.time()
    # The body's hash seeds every random choice, so the same outline builds
    # the same rock, and the author's `rockSeed` (in the hash too, mixed in
    # here as well) turns it into a different one to look at. The wrapper's
    # --seed overrides every body's for one build (an A/B, never shipped).
    seed = FLAGS["seed"] if FLAGS["seed"] is not None else int(body.get("seed", 0))
    rng = random.Random(int(body["hash"], 16) ^ (seed * 0x9E3779B1))
    templates = shard_templates(rng, index, remesh)
    body_tilt = math.radians(rng.uniform(-BODY_TILT, BODY_TILT))
    wander_tex = bpy.data.textures.new(f"wander-{index}", "CLOUDS")
    wander_tex.noise_scale = 1.0
    wander_tex.noise_depth = 1
    stages = {k: [] for k in STAGES} if FLAGS["dumpStages"] else None
    report = {"index": index, "hash": body["hash"], "seed": seed, "pieces": [], "culled": 0}
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
        obj, n, piece_report = piece_mesh(
            poly, convex, piece, templates, body_tilt, wander_tex, rng, f"b{index}-p{pi}", shards + pi, stages
        )
        report["pieces"].append(piece_report)
        shards += n
        sculpt(obj, piece_size(poly), index, rng, remesh)
        evaluate(obj)
        if stages is not None:
            stages["sculpted"].append(obj.data.copy())
        report["culled"] += cull(obj, piece, remesh)
        if stages is not None:
            stages["culled"].append(obj.data.copy())
        decimate(obj, collapse)
        clamp_depth(obj.data, piece, piece_size(poly))
        objs.append(obj)
    if not objs:
        return None, 0, report
    obj = join(objs, f"body-{index}")
    report["faces"] = len(obj.data.polygons)
    smooth_with_sharp_edges(obj.data)
    white_layer(obj.data)
    dirty(obj)
    spans = [depth_model(p, piece_size(dedupe([(v["x"], v["y"]) for v in p["verts"]]))) for p in body["pieces"]]
    masks(obj.data, max(d["fall"] + d["relief"] for d in spans))
    box_uvs(obj.data)
    if stages is not None:
        stages["final"].append(obj.data.copy())
        dump_stages(index, stages, FLAGS["dumpStages"])
        for stage in ("sculpted", "culled", "final"):
            for m in stages[stage]:
                bpy.data.meshes.remove(m)
    if FLAGS["debugAttributes"]:
        debug_attributes(obj.data)
    ao_image = None
    if not flat:
        report["aoCoverage"] = round(ao_uvs(obj), 4)
        size = ao_size(obj.data)
        report["aoSize"] = size
        ao_image = bpy.data.images.new(f"ao-{index}", size, size, alpha=False)
    obj.data.materials.append(rock_material(index, ao_image))
    if ao_image is not None:
        t = time.time()
        report["aoMean"] = round(bake_ao(obj, ao_image), 4)
        print(f"[rocks] body {index}: AO {size}x{size}, {report['aoCoverage'] * 100:.0f}% covered, {time.time() - t:.1f}s")
    obj["rockIndex"] = index
    obj["rockHash"] = body["hash"]
    report["tris"] = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    report["seconds"] = round(time.time() - t_body, 2)
    return obj, shards, report


# The job's switches (see `main`), read by the steps they turn off.
FLAGS = {
    "noBuried": False,
    "noCull": False,
    "noDetail": False,
    "noInset": False,
    "noRepair": False,
    "seed": None,
    "dumpStages": None,
    "debugAttributes": True,
}


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :]
    job_path, out_path = argv[0], argv[1]
    report_path = argv[2] if len(argv) > 2 else None
    with open(job_path) as f:
        job = json.load(f)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    # `scale` (the wrapper's --scale) is the rock scale for this build; the
    # constant is the default. `piece_size` reads the global at call time.
    global ROCK_SCALE
    ROCK_SCALE = float(job.get("scale", ROCK_SCALE))
    print(f"[rocks] rock scale {ROCK_SCALE:g} m")
    # `flat` (the wrapper's --flat) skips the ambient-occlusion bake, the slow
    # step, so the shape can be iterated on quickly.
    flat = bool(job.get("flat"))
    # The A/B switches and the debug outputs (docs/rocks.md, "Diagnosing"),
    # echoed so a build log and its report say what the file is.
    for key in FLAGS:
        if key in job:
            FLAGS[key] = job[key]
    if FLAGS["dumpStages"]:
        os.makedirs(FLAGS["dumpStages"], exist_ok=True)
    changed = {k: v for k, v in FLAGS.items() if k in job and v not in (False, None)}
    print(f"[rocks] flags: {json.dumps(changed) if changed else 'none'}")

    t0 = time.time()
    tris = 0
    built = 0
    bodies = []
    for body in job["bodies"]:
        t = time.time()
        ratio = job.get("decimate")
        obj, shards, report = build_body(body, flat, None if ratio is None else float(ratio), bool(job.get("remesh")))
        bodies.append(report)
        if obj is None:
            continue
        built += 1
        n = report["tris"]
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
        export_attributes=bool(FLAGS["debugAttributes"]),
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
    # The level the file was built from and how, as the scene's glTF extras,
    # for `cli rocks-check` to hash the bodies against.
    scene = bpy.context.scene
    scene["rockLevel"] = job.get("level", "")
    scene["rockFlags"] = json.dumps(
        {
            "scale": ROCK_SCALE,
            "flat": flat,
            "remesh": bool(job.get("remesh")),
            "decimate": job.get("decimate"),
            **{k: FLAGS[k] for k in FLAGS if k != "dumpStages"},
        }
    )
    for o in scene.objects:
        o.select_set(True)
    bpy.ops.export_scene.gltf(**kwargs)
    total = {k: sum(p[k] for b in bodies for p in b["pieces"]) for k in ("exact", "filled", "rejected", "dropped", "rewound", "open")}
    print(
        f"[rocks] open clips closed: {total['exact']} by the exact solver, {total['filled']} by filling; "
        f"{total['rejected']} results outside their shard rejected, {total['dropped']} shards dropped for it; "
        f"{total['rewound']} re-wound, {total['open']} chunks still open"
    )
    print(f"[rocks] {built} bodies, {tris} tris, {time.time() - t0:.1f}s -> {out_path}")
    if report_path:
        with open(report_path, "w") as f:
            json.dump(
                {
                    "level": job.get("level", ""),
                    "scale": ROCK_SCALE,
                    "flat": flat,
                    "decimate": job.get("decimate"),
                    "remesh": bool(job.get("remesh")),
                    "flags": {k: FLAGS[k] for k in FLAGS},
                    "bodies": bodies,
                },
                f,
                indent=1,
            )


main()
