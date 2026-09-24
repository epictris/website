"""One stylised rock asset from a 2D side-profile outline.

    blender -b --factory-startup --python tools/blender/rock_asset.py -- job.json out.glb [flags]

The job (written by `scripts/rock-asset.ts`, or by hand) is

    {"name": "ball-196",
     "outline": [{"x": 0.0, "y": 0.0}, ...],   # metres, x right, y UP, in the side view
     "depth": 2.0,                              # authored solid depth through the plane
     "seed": 0,
     "textures": {"basecolor": path, "normal": path, "roughness": path, "ao": path}}

Flags: --no-bake (clay only, quick), --render DIR (preview PNGs into DIR),
--chunk M (chunk size in metres), --depth M (override the authored depth),
--samples N (render samples), --bake-size N.

How a rock is made (see docs/rock-assets.md):

1. The outline is split into a handful of Voronoi chunks (2D, seeds a `chunk`
   apart), each extruded through its own random depth, bevelled hard on the
   front and back rims and lightly on the sides so it is a rounded block.
   The band at the gameplay plane keeps the outline exactly; the rounding is in
   depth.
2. The chunks are fused by a voxel remesh, smoothed, and warped by a soft noise.
   Vertices the warp pushed out of the outline are pulled back onto it.
3. Planar decimation turns the smooth blob into large flat facets, a bevel
   softens their edges, and smooth shading with sharp edges finishes the clay
   look of the reference (rounded chunks, soft grooves between them).
4. A Smart UV unwrap, and the tileable stylised rock set is box-projected onto
   the rock and baked into that atlas: base colour, normal, roughness and AO.

Frames: the game draws in three's frame (x right, y up, z toward the camera).
Blender is z-up and its glTF exporter maps Blender (x, y, z) to glTF (x, z, -y),
so here Blender x = game x, Blender z = game y, Blender y = -(game z): the
front of the rock, the face toward the camera, is at NEGATIVE Blender y.
The mesh is built about the outline's bounding-box centre so the exported
node's origin is the point a level places it by.
"""

import json
import math
import os
import random
import sys
import time

import bpy
import bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

# ---------------------------------------------------------------- parameters
# Detail constants are authored for a 1 m rock and scaled by the rock's size.

RIM_BEVEL = 0.5        # front/back rim rounding, share of the half depth
SIDE_BEVEL = 0.07      # silhouette corner rounding, metres
BEVEL_SEGMENTS = 6
VOXEL = 0.012          # remesh voxel, metres
SMOOTH_ITER = 3
CUTS = 34              # chisel cuts: flat planes shaved off the blob
CUT_MIN_Y = 0.45       # a cut's normal has at least this much depth component,
                       # so it faces the camera or away and spares the outline
CUT_DEPTH = (0.03, 0.09)  # how deep a cut shaves, metres
CRACK_RADIUS = 0.06    # half width of a carved crack, metres
CRACK_DEPTH = 0.022    # metres, at the crack's centre line
CRACK_WOBBLE = 0.03    # noise on the crack line, metres
TEXTURE_TILE = 1.6     # metres per repeat of the rock set
NORMAL_STRENGTH = 0.7  # exported normalTexture scale: the game lights a rock
                       # nearly head-on with little fill, so a full-strength
                       # groove wall goes black (a harsh, jagged band)
BAKE_SIZE = 1024
AO_SAMPLES = 64
RENDER_SAMPLES = 96
RENDER_SIZE = 900
LOW_TRIS = 2500        # the shipped mesh's triangle budget (`--tris`)
# A `kind: "moss"` job: the outline of a moss BODY (its own collision; the hook
# attaches to moss, not rock) with a `rock` reference to the rock job it grows
# on. The moss is the rock's own high surface inside the moss outline, pushed
# out into a thick skin, so it wraps over the top and down the faces like a
# growth, with a rounded lip, a scalloped edge and drips. Moving the moss body
# means regenerating the moss.
MOSS_THICKNESS = 0.05  # metres, the skin over a face
MOSS_TOP_EXTRA = 0.4   # share more on faces that face up
MOSS_FILL_MAX = 0.05   # metres: the skin grows out toward its own outline, up to
                       # this (0.3 made a blob whose top copied the outline's
                       # corners as ridges and whose thin ends went to spikes)
MOSS_LIP = 0.03        # the thinnest the skin gets, at its edge
MOSS_CLEARANCE = 0.04  # the moss stays at least this far outside the DRAWN rock
MOSS_FALLOFF = 0.08    # metres in from the edge over which it thickens
MOSS_EDGE_WOBBLE = 0.04  # lobes on the edge, metres
MOSS_EDGE_SCALE = 0.3    # lobe spacing, metres
MOSS_DRIP = 0.05       # how far the lower edge is eaten back between lobes, metres
MOSS_DRIP_FRONT = 0.12 # ...on the face toward the camera, where the lobes should
                       # read as moss drooping down the rock
MOSS_DRIP_SCALE = 0.3  # lobe wavelength along the edge, metres
MOSS_CLUMP = 0.2       # bulge size, metres (soft noise, not cells)
MOSS_CLUMP_AMOUNT = 0.12 # share of the thickness the bulges modulate: a carpet
                         # drapes and droops, it does not bulge outward
MOSS_SMOOTH = 8
MOSS_BASE_VOXEL = 0.03   # the rock copy the skin grows from is remeshed at this
MOSS_BASE_SMOOTH = 12    # and smoothed this much: facets and cracks go
MOSS_VOXEL = 0.02      # the closed skin is remeshed at this, then smoothed: soft
MOSS_FIELD_SMOOTH = 25  # Laplacian passes over the thickness field
MOSS_TILE = 0.5
MOSS_TRIS = 1800
LOW_REMESH_OVER = 2.5  # the low's remesh aims this factor over the budget
LOW_DISSOLVE_DEG = 10.0


def log(msg):
    print(f"[rock] {msg}", flush=True)


# ------------------------------------------------------------------ geometry


def signed_area(pts):
    a = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        a += x1 * y2 - x2 * y1
    return a / 2


def point_in_poly(pt, poly):
    x, y = pt
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < xi:
                inside = not inside
    return inside


def dedupe(poly, eps=1e-5):
    out = []
    for p in poly:
        if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > eps:
            out.append(p)
    if len(out) > 1 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) <= eps:
        out.pop()
    return out


def nearest_on_outline(pt, poly):
    """Closest point on the polygon boundary to `pt` (2D)."""
    best = None
    bd = float("inf")
    n = len(poly)
    for i in range(n):
        a = poly[i]
        b = poly[(i + 1) % n]
        ex, ey = b[0] - a[0], b[1] - a[1]
        l2 = ex * ex + ey * ey or 1e-12
        t = ((pt[0] - a[0]) * ex + (pt[1] - a[1]) * ey) / l2
        t = max(0.0, min(1.0, t))
        q = (a[0] + ex * t, a[1] + ey * t)
        d = math.hypot(pt[0] - q[0], pt[1] - q[1])
        if d < bd:
            bd, best = d, q
    return best, bd


def polyline_distance(px, py, line):
    """Distance from a 2D point to a polyline."""
    bd = float("inf")
    for i in range(len(line) - 1):
        a, b = line[i], line[i + 1]
        ex, ey = b[0] - a[0], b[1] - a[1]
        l2 = ex * ex + ey * ey or 1e-12
        t = max(0.0, min(1.0, ((px - a[0]) * ex + (py - a[1]) * ey) / l2))
        d = math.hypot(px - (a[0] + ex * t), py - (a[1] + ey * t))
        if d < bd:
            bd = d
    return bd


# ------------------------------------------------------------------- blender


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def new_object(name, verts, faces):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def apply_all(obj):
    bpy.context.view_layer.objects.active = obj
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def prism(name, poly, half, rim_bevel, side_bevel):
    """The outline extruded through the depth (Blender y = -half .. +half), the
    front and back rims bevelled by `rim_bevel` and the silhouette corners by
    `side_bevel` (bevel weights, one modifier), so it is a rounded block whose
    band at the gameplay plane is exactly the outline."""
    n = len(poly)
    verts = [(x, -half, z) for (x, z) in poly] + [(x, half, z) for (x, z) in poly]
    faces = [list(range(n))[::-1], [n + i for i in range(n)]]
    for i in range(n):
        j = (i + 1) % n
        faces.append([i, j, n + j, n + i])
    obj = new_object(name, verts, faces)
    bpy.context.view_layer.objects.active = obj
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    layer = bm.edges.layers.float.get("bevel_weight_edge") or bm.edges.layers.float.new("bevel_weight_edge")
    for e in bm.edges:
        a, b = e.verts
        e[layer] = side_bevel / rim_bevel if abs(a.co.y - b.co.y) > 1e-6 else 1.0
    bm.to_mesh(obj.data)
    bm.free()
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = rim_bevel
    mod.segments = BEVEL_SEGMENTS
    mod.limit_method = "WEIGHT"
    mod.use_clamp_overlap = True
    mod.profile = 0.55
    apply_all(obj)
    return obj


def remesh(obj, voxel):
    mod = obj.modifiers.new("remesh", "REMESH")
    mod.mode = "VOXEL"
    mod.voxel_size = voxel
    mod.use_smooth_shade = False
    apply_all(obj)


def chisel(obj, rng, count, depth_range, min_y, scale):
    """Shave `count` flat facets off the blob: each is a plane whose normal
    points mostly toward or away from the camera (|y| >= min_y), placed a cut
    depth inside the blob's support point along that normal, the outer part
    removed and the cut filled. Chisel-flat planes meeting at crisp edges are
    the reference's look; the depth bias keeps the outline uncut."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    cuts = 0
    for _ in range(count):
        while True:
            v = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1)))
            if v.length < 1e-6:
                continue
            v.normalize()
            if abs(v.y) >= min_y:
                break
        support = max(vv.co.dot(v) for vv in bm.verts)
        d = rng.uniform(*depth_range) * scale
        co = v * (support - d)
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        ret = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=v, clear_outer=True, clear_inner=False, dist=1e-5)
        edges = [e for e in ret["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        if edges:
            bmesh.ops.holes_fill(bm, edges=edges, sides=0)
            cuts += 1
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return cuts


def carve_cracks(obj, cracks, radius, depth, wobble, rng, scale):
    """Carve V grooves along authored crack lines (2D, the side view, in the
    rock's frame). A crack is a curtain through the depth: every vertex within
    `radius` of the line in the side view moves inward along its normal by up
    to `depth`, so the groove wraps over the front, the top and the back."""
    me = obj.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    nrm = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("normal", nrm)
    nrm = nrm.reshape(n, 3)
    tex = bpy.data.textures.new("crack-wobble", "CLOUDS")
    tex.noise_scale = 0.3 * scale
    tex.noise_depth = 0
    r = radius * scale
    moved = 0
    for i in range(n):
        x, y, z = co[i]
        w = (tex.evaluate((x, 0.0, z))[3] - 0.5) * 2 * wobble * scale
        d = min(polyline_distance(x, z, line) for line in cracks) + w
        if d >= r:
            continue
        t = 1 - d / r
        push = depth * scale * (t * t)
        co[i] -= nrm[i] * push
        moved += 1
    me.vertices.foreach_set("co", co.reshape(-1))
    me.update()
    return moved


def smooth(obj, iterations, factor=0.5):
    mod = obj.modifiers.new("smooth", "SMOOTH")
    mod.iterations = iterations
    mod.factor = factor
    apply_all(obj)


def noise_displace(obj, size, strength, seed, scale):
    tex = bpy.data.textures.new(f"clouds-{seed}", "CLOUDS")
    tex.noise_scale = size * scale
    tex.noise_depth = 2
    tex.noise_basis = "BLENDER_ORIGINAL"
    empty = bpy.data.objects.new(f"noise-origin-{seed}", None)
    bpy.context.collection.objects.link(empty)
    empty.location = (seed * 7.31, seed * 3.17, seed * 1.93)
    mod = obj.modifiers.new("displace", "DISPLACE")
    mod.texture = tex
    mod.texture_coords = "OBJECT"
    mod.texture_coords_object = empty
    mod.direction = "NORMAL"
    mod.strength = strength * scale
    mod.mid_level = 0.5
    apply_all(obj)
    bpy.data.objects.remove(empty)


def pull_into_outline(obj, poly, margin):
    """Any vertex the warp pushed outside the outline (in the side view) goes
    back onto it; margin lets a few millimetres through."""
    me = obj.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    moved = 0
    for i in range(n):
        p = (float(co[i, 0]), float(co[i, 2]))
        if point_in_poly(p, poly):
            continue
        q, d = nearest_on_outline(p, poly)
        if d <= margin:
            continue
        co[i, 0], co[i, 2] = q[0], q[1]
        moved += 1
    me.vertices.foreach_set("co", co.reshape(-1))
    me.update()
    return moved


def unwrap(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.select_all(action="SELECT")
    try:
        bpy.ops.uv.pack_islands(margin=0.004, rotate=True)
    except TypeError:
        bpy.ops.uv.pack_islands(margin=0.004)
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def ray_to_outline(p, d, poly):
    """Distance along the 2D ray p + t d (t > 0) to the first outline edge."""
    best = None
    n = len(poly)
    for i in range(n):
        a = poly[i]
        b = poly[(i + 1) % n]
        ex, ey = b[0] - a[0], b[1] - a[1]
        den = d[0] * ey - d[1] * ex
        if abs(den) < 1e-9:
            continue
        t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den
        u = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den
        if t > 0 and 0 <= u <= 1 and (best is None or t < best):
            best = t
    return best


def rock_cap(real, region, clearance, name, scale):
    """A shell over the DRAWN rock inside the moss cover: its faces there,
    pushed out by `clearance` and closed inward. Fused into the moss by the
    remesh it guarantees the moss encloses every rock peak, which no
    vertex-by-vertex lift can (a peak comes up between the moss's vertices)."""
    me = real.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    nrm = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("normal", nrm)
    nrm = nrm.reshape(n, 3)
    w = cover_weights(co, nrm, region, scale)
    faces = [list(p.vertices) for p in me.polygons if w[list(p.vertices)].mean() > 0.3]
    if not faces:
        return None
    used = sorted({v for f in faces for v in f})
    remap = {v: i for i, v in enumerate(used)}
    # Feathered by the cover: at full cover the cap stands the clearance off
    # the rock, toward the edge it sinks under the skin, so its boundary
    # never emerges as a ledge (a notch on the moss surface).
    verts = [tuple(me.vertices[v].co + me.vertices[v].normal * (clearance * float(w[v]))) for v in used]
    obj = new_object(name, verts, [[remap[v] for v in f] for f in faces])
    bpy.context.view_layer.objects.active = obj
    # Nothing of the cap outside the moss outline in the side view.
    pull_into_outline(obj, region, 0.002)
    mod = obj.modifiers.new("close", "SOLIDIFY")
    mod.thickness = -(clearance + 0.06)
    mod.offset = 1.0
    mod.use_rim = True
    apply_all(obj)
    return obj


def lift_clear(obj, real, clearance):
    """Hold the finished moss solid's OUTER surface at least `clearance`
    outside the real rock: the remesh and smoothing after the skin was closed
    sag it under the rock's sharp peaks, which then poke through. Only verts
    whose normal agrees with the rock's are outer surface; the underside and
    the rim, which are meant to be inside, are left alone."""
    tree = BVHTree.FromObject(real, bpy.context.evaluated_depsgraph_get())
    me = obj.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    nrm = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("normal", nrm)
    nrm = nrm.reshape(n, 3)
    lifted = 0
    for i in range(n):
        v = Vector(co[i])
        loc, rn, _, _ = tree.find_nearest(v)
        if loc is None or rn.dot(Vector(nrm[i])) < 0.3:
            continue
        gap = (v - loc).dot(rn)
        if gap < clearance:
            co[i] = loc + rn * clearance
            lifted += 1
    me.vertices.foreach_set("co", co.reshape(-1))
    me.update()
    return lifted


def cover_weights(co, nrm, region, scale):
    """Per-vertex cover of the moss outline, 0..1: strictly inside the outline
    in the side view, fading in over MOSS_FALLOFF from an edge that is
    scalloped inward and, toward the camera, droops in lobes along its lower
    edge. Shared by the skin and the rock cap so both stop at the same edge."""
    n = len(co)
    wob = bpy.data.textures.new("moss-wobble", "CLOUDS")
    wob.noise_scale = MOSS_EDGE_SCALE * scale
    wob.noise_depth = 0
    drip = bpy.data.textures.new("moss-drip", "CLOUDS")
    drip.noise_scale = MOSS_DRIP_SCALE * scale
    drip.noise_depth = 0
    w = np.zeros(n, dtype=np.float32)
    for i in range(n):
        x, y, z = (float(v) for v in co[i])
        q, d = nearest_on_outline((x, z), region)
        if not point_in_poly((x, z), region):
            # Strictly inside the moss collider: the editor's outline is where
            # the moss ends, and the droop is drawn into that outline.
            continue
        # Scallops and the lobes' gaps only ever eat INTO the outline.
        d -= abs(wob.evaluate((x, y, z))[3] - 0.5) * 2 * MOSS_EDGE_WOBBLE * scale
        if z > q[1]:
            # The nearest outline point is BELOW this one, so it is near the
            # lower edge (the earlier test had this the wrong way round and
            # the droop never applied to anything inside the outline).
            # Toward the camera (Blender -y) the lower edge droops in lobes: a
            # sinusoid along the edge (zero retreat at a lobe's centre, full
            # between lobes), so the edge is a gradual curve by construction; a
            # thresholded noise gave tongues a few centimetres wide however
            # wide its features were. The noise only varies the amplitude.
            front = smoothstep(0.2, 0.7, -float(nrm[i, 1]))
            reach = (MOSS_DRIP + (MOSS_DRIP_FRONT - MOSS_DRIP) * front) * scale
            wave = 0.5 - 0.5 * math.cos(2 * math.pi * x / (MOSS_DRIP_SCALE * scale))
            amp = 0.75 + 0.5 * drip.evaluate((x, 0.0, 0.0))[3]
            d -= wave * amp * reach
        cover = smoothstep(0.0, MOSS_FALLOFF * scale, d)
        w[i] = cover
    return w


def moss_from_rock(rock, name, region, seed, scale, real=None):
    """The moss skin: every face of the rock's high mesh whose side-view
    position lies inside the moss outline (scalloped, with drips hanging off
    its lower edges) is copied and pushed out along its normal by the skin's
    thickness, thin at the edge, thicker on top, modulated by rounded clumps;
    the copy is closed underneath into the rock and remeshed into one solid
    with a rounded lip."""
    me = rock.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    nrm = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("normal", nrm)
    nrm = nrm.reshape(n, 3)
    w = cover_weights(co, nrm, region, scale)
    faces = [list(p.vertices) for p in me.polygons if w[list(p.vertices)].mean() > 0.03]
    if not faces:
        raise RuntimeError("the moss outline covers no face of the rock")
    used = sorted({v for f in faces for v in f})
    remap = {v: i for i, v in enumerate(used)}
    # Bulges from a soft noise: Voronoi domes creased where cells met.
    clumps = bpy.data.textures.new("moss-bulges", "CLOUDS")
    clumps.noise_scale = MOSS_CLUMP * scale
    clumps.noise_depth = 0
    thick = MOSS_THICKNESS * scale
    lip = MOSS_LIP * scale
    # The thickness field: the skin over a face, more on top, and where the
    # normal has a side-view direction the skin grows out to the moss outline
    # itself (straight up on top faces, sideways on side faces, so the visible
    # moss is the editor's moss shape and the hook lands on what is drawn).
    # The field is then smoothed over the mesh: per-vertex rays gave
    # neighbours wildly different reaches and a spiky skin.
    idx = {v: i for i, v in enumerate(used)}
    t = np.zeros(len(used), dtype=np.float32)
    for v in used:
        x, y, z = (float(c) for c in co[v])
        nx, nz = float(nrm[v, 0]), float(nrm[v, 2])
        up = max(0.0, nz)
        ti = thick * (1 + MOSS_TOP_EXTRA * up)
        if point_in_poly((x, z), region):
            if nz > 0.35:
                reach = ray_to_outline((x, z), (0.0, 1.0), region)
                if reach is not None:
                    ti = max(ti, min(reach, MOSS_FILL_MAX * scale) * nz)
            elif abs(nx) > 0.6:
                reach = ray_to_outline((x, z), (1.0 if nx > 0 else -1.0, 0.0), region)
                if reach is not None:
                    ti = max(ti, min(reach, MOSS_FILL_MAX * scale) * abs(nx))
        t[idx[v]] = ti
    neighbours = [set() for _ in used]
    for f in faces:
        for i in range(len(f)):
            a, b = idx[f[i]], idx[f[(i + 1) % len(f)]]
            neighbours[a].add(b)
            neighbours[b].add(a)
    for _ in range(MOSS_FIELD_SMOOTH):
        t = np.array([0.5 * t[i] + 0.5 * np.mean(t[list(nb)]) if nb else t[i] for i, nb in enumerate(neighbours)], dtype=np.float32)
    verts = []
    for v in used:
        x, y, z = (float(c) for c in co[v])
        dome = min(1.0, max(0.0, (clumps.evaluate((x, y, z))[3] - 0.3) / 0.4))
        ti = lip + (float(t[idx[v]]) - lip) * w[v]
        ti *= (1 - MOSS_CLUMP_AMOUNT) + MOSS_CLUMP_AMOUNT * dome
        verts.append(tuple(co[v] + nrm[v] * ti))
    if real is not None:
        # The skin grows from a SOFTENED rock, whose smoothing sits below the
        # real rock's sharp peaks; a peak then pokes through the moss. Every
        # skin vertex is held at least MOSS_CLEARANCE outside the real rock.
        tree = BVHTree.FromObject(real, bpy.context.evaluated_depsgraph_get())
        clearance = MOSS_CLEARANCE * scale
        pushed = 0
        for i, v in enumerate(verts):
            loc, nrm_r, _, _ = tree.find_nearest(Vector(v))
            if loc is None:
                continue
            gap = (Vector(v) - loc).dot(nrm_r)
            if gap < clearance:
                verts[i] = tuple(loc + nrm_r * clearance)
                pushed += 1
        log(f"moss: {pushed} skin verts lifted clear of the rock")
    obj = new_object(name, verts, [[remap[v] for v in f] for f in faces])
    bpy.context.view_layer.objects.active = obj
    # The skin's thickness may push it past the collider on top or at the
    # sides; in the side view the moss must stay inside its outline exactly,
    # so anything outside is pulled back onto it (a flat cap where it clips).
    pulled = pull_into_outline(obj, region, 0.002)
    if pulled:
        log(f"moss: {pulled} skin verts clipped to the outline")
    mod = obj.modifiers.new("close", "SOLIDIFY")
    # Deep enough that the smoothing after the remesh cannot lift the
    # underside out of the rock at the lip (a dark slot between the two).
    mod.thickness = -(lip + 0.09 * scale)
    mod.offset = 1.0
    mod.use_rim = True
    apply_all(obj)
    remesh(obj, MOSS_VOXEL * scale)
    smooth(obj, MOSS_SMOOTH, 0.5)
    return obj, len(faces)


# ------------------------------------------------------------------ material


def load_image(path, colorspace):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = colorspace
    return img


# Where each projection axis reads the tile, in tile units. Blender's own box
# projection reads one mapping for all three, so a rock about one tile across
# shows the same feature on its front and its side at the same height (a pale
# wedge of this set read as a stamp); three offsets make the faces differ.
TRIPLANAR_OFFSETS = ((0.37, 0.11), (0.0, 0.0), (0.72, 0.53))


def triplanar(nodes, links, img, tile, name):
    """Three flat projections of `img` (down x, y and z) blended by the
    geometry normal, sharpened by a power so a facet reads one projection."""
    coord = nodes.new("ShaderNodeTexCoord")
    xyz = nodes.new("ShaderNodeSeparateXYZ")
    links.new(coord.outputs["Object"], xyz.inputs["Vector"])
    geo = nodes.new("ShaderNodeNewGeometry")
    nxyz = nodes.new("ShaderNodeSeparateXYZ")
    links.new(geo.outputs["Normal"], nxyz.inputs["Vector"])
    # Weights |n_i|^4 / sum.
    powers = []
    for axis in ("X", "Y", "Z"):
        ab = nodes.new("ShaderNodeMath")
        ab.operation = "ABSOLUTE"
        links.new(nxyz.outputs[axis], ab.inputs[0])
        pw = nodes.new("ShaderNodeMath")
        pw.operation = "POWER"
        pw.inputs[1].default_value = 4.0
        links.new(ab.outputs[0], pw.inputs[0])
        powers.append(pw)
    s1 = nodes.new("ShaderNodeMath")
    s1.operation = "ADD"
    links.new(powers[0].outputs[0], s1.inputs[0])
    links.new(powers[1].outputs[0], s1.inputs[1])
    s2 = nodes.new("ShaderNodeMath")
    s2.operation = "ADD"
    links.new(s1.outputs[0], s2.inputs[0])
    links.new(powers[2].outputs[0], s2.inputs[1])
    # The three samples: x faces read (y, z), y faces (x, z), z faces (x, y).
    planes = (("Y", "Z"), ("X", "Z"), ("X", "Y"))
    acc = None
    for i, ((u, v), (ou, ov)) in enumerate(zip(planes, TRIPLANAR_OFFSETS)):
        comb = nodes.new("ShaderNodeCombineXYZ")
        links.new(xyz.outputs[u], comb.inputs["X"])
        links.new(xyz.outputs[v], comb.inputs["Y"])
        mapping = nodes.new("ShaderNodeMapping")
        mapping.inputs["Scale"].default_value = (1 / tile, 1 / tile, 1 / tile)
        mapping.inputs["Location"].default_value = (ou, ov, 0)
        links.new(comb.outputs["Vector"], mapping.inputs["Vector"])
        tex = nodes.new("ShaderNodeTexImage")
        tex.name = f"{name}-{i}"
        tex.image = img
        tex.projection = "FLAT"
        tex.interpolation = "Linear"
        links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
        w = nodes.new("ShaderNodeMath")
        w.operation = "DIVIDE"
        links.new(powers[i].outputs[0], w.inputs[0])
        links.new(s2.outputs[0], w.inputs[1])
        scaled = nodes.new("ShaderNodeVectorMath")
        scaled.operation = "SCALE"
        links.new(tex.outputs["Color"], scaled.inputs[0])
        links.new(w.outputs[0], scaled.inputs["Scale"])
        if acc is None:
            acc = scaled
        else:
            add = nodes.new("ShaderNodeVectorMath")
            add.operation = "ADD"
            links.new(acc.outputs["Vector"], add.inputs[0])
            links.new(scaled.outputs["Vector"], add.inputs[1])
            acc = add
    return acc.outputs["Vector"]


def source_material(textures, tile):
    """The look, triplanar in world metres; what the bake reads."""
    mat = bpy.data.materials.new("rock-source")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    base = triplanar(nodes, links, load_image(textures["basecolor"], "sRGB"), tile, "base")
    links.new(base, bsdf.inputs["Base Color"])
    rough = triplanar(nodes, links, load_image(textures["roughness"], "Non-Color"), tile, "rough")
    links.new(rough, bsdf.inputs["Roughness"])
    nrm = triplanar(nodes, links, load_image(textures["normal"], "Non-Color"), tile, "nrm")
    nmap = nodes.new("ShaderNodeNormalMap")
    nmap.space = "TANGENT"
    nmap.inputs["Strength"].default_value = 0.8
    links.new(nrm, nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Specular IOR Level"].default_value = 0.3
    return mat, bsdf, nmap


def bake_material(name, size, atlas_targets):
    """The low mesh's material during the bake: it only holds the targets."""
    imgs = {}
    for key, colorspace in atlas_targets:
        img = bpy.data.images.new(f"{name}-{key}", size, size, alpha=False, float_buffer=False)
        img.colorspace_settings.name = colorspace
        imgs[key] = img
    mat = bpy.data.materials.new(f"{name}-bake")
    mat.use_nodes = True
    return mat, imgs


MARKER = (1.0, 0.0, 1.0, 1.0)  # what a texel nobody baked still shows


def clear_to_marker(img):
    w, h = img.size
    px = np.tile(np.array(MARKER, dtype=np.float32), w * h)
    img.pixels.foreach_set(px)


def flood_background(imgs, coverage_from, normal_from=None, steps=48):
    """Fill every atlas texel the bake did not write from its nearest written
    neighbour (a few dozen one-texel dilations, then the mean for what is
    left). Thin islands, the groove walls, otherwise read the clear colour
    through the texture filtering: black specks in every crack."""
    w, h = coverage_from.size
    base = np.empty(w * h * 4, dtype=np.float32)
    coverage_from.pixels.foreach_get(base)
    base = base.reshape(h, w, 4)
    marker = np.array(MARKER[:3], dtype=np.float32)
    # Unwritten texels still show the marker; a ray that hit a back face of
    # the high wrote black, which no texel of a rock is, so both are refilled.
    magenta = (base[..., 0] > 0.45) & (base[..., 1] < 0.35) & (base[..., 2] > 0.45)
    filled = (~magenta) & (base[..., :3].max(axis=2) > 0.03)
    if normal_from is not None:
        # A ray that hit a back face wrote a normal pointing INTO the low
        # surface (tangent-space blue near 0), which shades as a dark dot.
        nrm = np.empty(w * h * 4, dtype=np.float32)
        normal_from.pixels.foreach_get(nrm)
        filled &= nrm.reshape(h, w, 4)[..., 2] > 0.35
    for img in imgs:
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(h, w, 4)
        f = filled.copy()
        for _ in range(steps):
            if f.all():
                break
            acc = np.zeros_like(px)
            cnt = np.zeros((h, w), dtype=np.float32)
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                sf = np.roll(f, (dy, dx), axis=(0, 1))
                sp = np.roll(px, (dy, dx), axis=(0, 1))
                acc += sp * sf[..., None]
                cnt += sf
            grow = (~f) & (cnt > 0)
            px[grow] = acc[grow] / cnt[grow][:, None]
            f |= grow
        if not f.all():
            px[~f] = px[f].mean(axis=0)
        img.pixels.foreach_set(px.reshape(-1))
        img.update()


def low_poly(high, name, tris, scale, max_voxel=None, dissolve_deg=None):
    """The shipped mesh. Not a collapse of the high: quadric collapse merges the
    two walls of a groove into jagged bridging triangles (lumps and teeth in
    every crack). Instead a COARSE voxel remesh of the high, whose skin is a
    clean shallow valley across each groove, a light smooth, a planar dissolve
    (moves no vertex) and only then a mild collapse down to the budget."""
    low = high.copy()
    low.data = high.data.copy()
    low.name = name
    bpy.context.collection.objects.link(low)
    bpy.context.view_layer.objects.active = low
    area = sum(p.area for p in high.data.polygons)
    # Triangles scale with 1/voxel^2; the dissolve then folds the flat facets
    # up, so aim the remesh a factor over the budget.
    voxel = math.sqrt(2.0 * area / (LOW_REMESH_OVER * tris))
    if max_voxel is not None:
        voxel = min(voxel, max_voxel)
    remesh(low, voxel)
    smooth(low, 2, 0.5)
    mod = low.modifiers.new("planar", "DECIMATE")
    mod.decimate_type = "DISSOLVE"
    mod.angle_limit = math.radians(dissolve_deg or LOW_DISSOLVE_DEG)
    apply_all(low)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.quads_convert_to_tris(quad_method="BEAUTY", ngon_method="BEAUTY")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    have = sum(len(p.vertices) - 2 for p in low.data.polygons)
    log(f"low: remesh at {voxel*100:.1f} cm, dissolved to {have} tris")
    if have > tris:
        mod = low.modifiers.new("collapse", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = tris / have
        mod.use_collapse_triangulate = True
        apply_all(low)
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    bpy.ops.object.shade_smooth()
    return low


# ------------------------------------------------------------------ material


def load_image(path, colorspace):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = colorspace
    return img


def box_tex_node(nodes, links, img, tile, mapping_out, name):
    tex = nodes.new("ShaderNodeTexImage")
    tex.name = name
    tex.image = img
    tex.projection = "BOX"
    tex.projection_blend = 0.25
    tex.interpolation = "Linear"
    links.new(mapping_out, tex.inputs["Vector"])
    return tex


def source_material(textures, tile):
    """The look, triplanar in world metres; what the bake reads."""
    mat = bpy.data.materials.new("rock-source")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    base = triplanar(nodes, links, load_image(textures["basecolor"], "sRGB"), tile, "base")
    links.new(base, bsdf.inputs["Base Color"])
    rough = triplanar(nodes, links, load_image(textures["roughness"], "Non-Color"), tile, "rough")
    links.new(rough, bsdf.inputs["Roughness"])
    nrm = triplanar(nodes, links, load_image(textures["normal"], "Non-Color"), tile, "nrm")
    nmap = nodes.new("ShaderNodeNormalMap")
    nmap.space = "TANGENT"
    nmap.inputs["Strength"].default_value = 0.8
    links.new(nrm, nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Specular IOR Level"].default_value = 0.3
    return mat, bsdf, nmap


def bake_material(name, size, atlas_targets):
    """The low mesh's material during the bake: it only holds the targets."""
    imgs = {}
    for key, colorspace in atlas_targets:
        img = bpy.data.images.new(f"{name}-{key}", size, size, alpha=False, float_buffer=False)
        img.colorspace_settings.name = colorspace
        imgs[key] = img
    mat = bpy.data.materials.new(f"{name}-bake")
    mat.use_nodes = True
    return mat, imgs


MARKER = (1.0, 0.0, 1.0, 1.0)  # what a texel nobody baked still shows


def clear_to_marker(img):
    w, h = img.size
    px = np.tile(np.array(MARKER, dtype=np.float32), w * h)
    img.pixels.foreach_set(px)


def flood_background(imgs, coverage_from, normal_from=None, steps=48):
    """Fill every atlas texel the bake did not write from its nearest written
    neighbour (a few dozen one-texel dilations, then the mean for what is
    left). Thin islands, the groove walls, otherwise read the clear colour
    through the texture filtering: black specks in every crack."""
    w, h = coverage_from.size
    base = np.empty(w * h * 4, dtype=np.float32)
    coverage_from.pixels.foreach_get(base)
    base = base.reshape(h, w, 4)
    marker = np.array(MARKER[:3], dtype=np.float32)
    # Unwritten texels still show the marker; a ray that hit a back face of
    # the high wrote black, which no texel of a rock is, so both are refilled.
    magenta = (base[..., 0] > 0.45) & (base[..., 1] < 0.35) & (base[..., 2] > 0.45)
    filled = (~magenta) & (base[..., :3].max(axis=2) > 0.03)
    if normal_from is not None:
        # A ray that hit a back face wrote a normal pointing INTO the low
        # surface (tangent-space blue near 0), which shades as a dark dot.
        nrm = np.empty(w * h * 4, dtype=np.float32)
        normal_from.pixels.foreach_get(nrm)
        filled &= nrm.reshape(h, w, 4)[..., 2] > 0.35
    for img in imgs:
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(h, w, 4)
        f = filled.copy()
        for _ in range(steps):
            if f.all():
                break
            acc = np.zeros_like(px)
            cnt = np.zeros((h, w), dtype=np.float32)
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                sf = np.roll(f, (dy, dx), axis=(0, 1))
                sp = np.roll(px, (dy, dx), axis=(0, 1))
                acc += sp * sf[..., None]
                cnt += sf
            grow = (~f) & (cnt > 0)
            px[grow] = acc[grow] / cnt[grow][:, None]
            f |= grow
        if not f.all():
            px[~f] = px[f].mean(axis=0)
        img.pixels.foreach_set(px.reshape(-1))
        img.update()


def bake(low, high, bake_mat, imgs, samples, scale):
    """Bake the high mesh (wearing the source material) onto the low mesh's
    atlas: selected-to-active, rays cast from a cage a little outside the low
    surface, so the atlas carries the high's facets, cracks and detail normal."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.use_denoising = False
    bk = scene.render.bake
    bk.margin = 8
    bk.use_clear = True
    bk.use_selected_to_active = True
    bk.cage_extrusion = 0.012 * scale
    bk.max_ray_distance = 0.06 * scale
    nodes = bake_mat.node_tree.nodes
    bpy.ops.object.select_all(action="DESELECT")
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low

    def target(img):
        tex = nodes.new("ShaderNodeTexImage")
        tex.name = "bake-target"
        tex.image = img
        for n in nodes:
            n.select = False
        nodes.active = tex
        tex.select = True
        return tex

    scene.cycles.samples = 1
    clear_to_marker(imgs["basecolor"])
    t = target(imgs["basecolor"])
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_clear=False, margin=16, use_selected_to_active=True, cage_extrusion=bk.cage_extrusion, max_ray_distance=bk.max_ray_distance)
    nodes.remove(t)
    t = target(imgs["roughness"])
    bpy.ops.object.bake(type="ROUGHNESS", use_clear=True, margin=16, use_selected_to_active=True, cage_extrusion=bk.cage_extrusion, max_ray_distance=bk.max_ray_distance)
    nodes.remove(t)
    t = target(imgs["normal"])
    bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", use_clear=True, margin=16, use_selected_to_active=True, cage_extrusion=bk.cage_extrusion, max_ray_distance=bk.max_ray_distance)
    nodes.remove(t)
    scene.cycles.samples = samples
    scene.world.light_settings.distance = 0.6 * scale
    t = target(imgs["ao"])
    bpy.ops.object.bake(type="AO", use_clear=True, margin=16, use_selected_to_active=True, cage_extrusion=bk.cage_extrusion, max_ray_distance=bk.max_ray_distance)
    nodes.remove(t)
    flood_background([imgs["roughness"], imgs["ao"], imgs["basecolor"], imgs["normal"]], imgs["basecolor"], imgs["normal"])


def final_material(name, imgs, textures):
    mat = bpy.data.materials.new(f"{name}-rock")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    uv = nodes.new("ShaderNodeUVMap")
    uv.uv_map = "UVMap"

    def tex(img):
        t = nodes.new("ShaderNodeTexImage")
        t.image = img
        links.new(uv.outputs["UV"], t.inputs["Vector"])
        return t

    base = tex(imgs["basecolor"])
    links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    rough = tex(imgs["roughness"])
    links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    nrm = tex(imgs["normal"])
    nmap = nodes.new("ShaderNodeNormalMap")
    nmap.inputs["Strength"].default_value = NORMAL_STRENGTH
    links.new(nrm.outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    # glTF occlusion: the exporter reads a "glTF Material Output" group node
    # if present; otherwise packs ORM from a separate node. Keep it simple:
    # the settings node.
    ao = tex(imgs["ao"])
    group = bpy.data.node_groups.get("glTF Material Output")
    if group is None:
        group = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    gnode = nodes.new("ShaderNodeGroup")
    gnode.node_tree = group
    links.new(ao.outputs["Color"], gnode.inputs["Occlusion"])
    bsdf.inputs["Specular IOR Level"].default_value = 0.3
    return mat


def clay_material():
    mat = bpy.data.materials.new("clay")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.62, 0.62, 0.6, 1)
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Specular IOR Level"].default_value = 0.2
    return mat


# -------------------------------------------------------------------- render


def outline_wire(poly, y, radius, name="outline-wire"):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 2
    spline = curve.splines.new("POLY")
    spline.points.add(len(poly) - 1)
    for i, (x, z) in enumerate(poly):
        spline.points[i].co = (x, y, z, 1)
    spline.use_cyclic_u = True
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    mat = bpy.data.materials.new("outline-red")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    em = nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (1, 0.05, 0.05, 1)
    em.inputs["Strength"].default_value = 4
    mat.node_tree.links.new(em.outputs["Emission"], out.inputs["Surface"])
    curve.materials.append(mat)
    # Seen by the camera only, so it never tints the rock.
    obj.visible_diffuse = False
    obj.visible_glossy = False
    obj.visible_transmission = False
    obj.visible_volume_scatter = False
    obj.visible_shadow = False
    return obj


def setup_world(strength=0.6):
    scene = bpy.context.scene
    world = bpy.data.worlds.new("world")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.55, 0.6, 0.66, 1)
    bg.inputs["Strength"].default_value = strength
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 1.6
    sun.angle = math.radians(8)
    so = bpy.data.objects.new("sun", sun)
    scene.collection.objects.link(so)
    # From the front, high and to the left, like the game's key light.
    so.rotation_euler = (math.radians(55), math.radians(-20), math.radians(-35))
    return so


def render(path, cam_pos, look_at, ortho_scale, size, samples, perspective=False):
    scene = bpy.context.scene
    cam = bpy.data.cameras.new("cam")
    cam_obj = bpy.data.objects.new("cam", cam)
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj
    cam_obj.location = cam_pos
    direction = Vector(look_at) - Vector(cam_pos)
    cam_obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    if perspective:
        cam.type = "PERSP"
        cam.lens = 50
    else:
        cam.type = "ORTHO"
        cam.ortho_scale = ortho_scale
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "Standard"
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam_obj)


# ---------------------------------------------------------------------- main


def framed(job, flags):
    """The job's outline centred on its bounding box, with the frame."""
    poly = dedupe([(float(p["x"]), float(p["y"])) for p in job["outline"]])
    if signed_area(poly) < 0:
        poly.reverse()
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    # The frame's origin is the BODY's position when the job carries one (the
    # mesh object then sits at the body's own origin, so an outline edit in
    # the editor only means regenerating, never re-placing), else the
    # outline's bounding-box centre.
    if job.get("origin"):
        cx, cy = float(job["origin"]["x"]), float(job["origin"]["y"])
    else:
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    width, height = max(xs) - min(xs), max(ys) - min(ys)
    depth = float(flags.get("depth") or job["depth"])
    return [(x - cx, y - cy) for (x, y) in poly], cx, cy, width, height, depth


def rock_high(job, name, poly, depth, scale, rng, flags, t0):
    """Stages 1-3 of a rock: the rounded mass, the chisel facets, the cracks."""
    half = depth / 2
    voxel = VOXEL * scale
    rock = prism(name, poly, half, max(RIM_BEVEL * half, 0.02), SIDE_BEVEL * scale)
    remesh(rock, voxel)
    smooth(rock, SMOOTH_ITER)
    log(f"mass at voxel {voxel*100:.1f} cm: {len(rock.data.polygons)} faces ({time.time()-t0:.1f}s)")
    cuts = chisel(rock, rng, int(flags.get("cuts") or CUTS), CUT_DEPTH, CUT_MIN_Y, scale)
    remesh(rock, voxel)
    log(f"chiselled {cuts} facets ({time.time()-t0:.1f}s)")
    cracks = [[(float(p["x"]), float(p["y"])) for p in line] for line in job.get("cracks", [])]
    if cracks:
        moved = carve_cracks(rock, cracks, CRACK_RADIUS, CRACK_DEPTH, CRACK_WOBBLE, rng, scale)
        log(f"carved {len(cracks)} cracks over {moved} verts")
    moved = pull_into_outline(rock, poly, 0.004)
    if moved:
        log(f"{moved} verts pulled back onto the outline")
    smooth(rock, 1, 0.3)
    return rock


def build(job, out_path, flags, job_dir="."):
    t0 = time.time()
    name = job["name"]
    seed = int(job.get("seed", 0))
    rng = random.Random(seed * 7919 + 17)
    poly, cx, cy, width, height, depth = framed(job, flags)
    size = max(width, height)
    half = depth / 2
    scale = size / 1.0  # detail constants are authored for a 1 m rock
    log(f"{name}: outline {len(poly)} verts, {width:.2f} x {height:.2f} m, depth {depth:.2f}, origin at world ({cx:.3f}, {cy:.3f})")

    clear_scene()
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"

    kind = job.get("kind", "rock")
    occluders = []
    if kind == "moss":
        # The rock it grows on, rebuilt exactly as its own job builds it (same
        # seed, same flags-free depth), then moved into the moss's frame.
        with open(os.path.join(job_dir, job["rock"])) as f:
            rjob = json.load(f)
        rpoly, rcx, rcy, rw, rh, rdepth = framed(rjob, {})
        rscale = max(rw, rh) / 1.0
        rrng = random.Random(int(rjob.get("seed", 0)) * 7919 + 17)
        base = rock_high(rjob, f"{name}-rock", rpoly, rdepth, rscale, rrng, {}, t0)
        base.location = (rcx - cx, 0, rcy - cy)
        bpy.ops.object.select_all(action="DESELECT")
        base.select_set(True)
        bpy.context.view_layer.objects.active = base
        bpy.ops.object.transform_apply(location=True)
        # The skin grows from a SOFTENED copy of the rock: an offset of the
        # real surface inherits every chisel facet and crack as a bump, and a
        # dent where a groove runs under the moss; real moss smooths over them.
        # ...and built from the rock job with its CRACKS stripped: a groove's
        # end under the moss survived the softening as a dimple in the carpet.
        uncracked = {k: v for k, v in rjob.items() if k != "cracks"}
        soft = rock_high(uncracked, f"{name}-soft", rpoly, rdepth, rscale, random.Random(int(rjob.get("seed", 0)) * 7919 + 17), {}, t0)
        soft.location = (rcx - cx, 0, rcy - cy)
        bpy.ops.object.select_all(action="DESELECT")
        soft.select_set(True)
        bpy.context.view_layer.objects.active = soft
        bpy.ops.object.transform_apply(location=True)
        remesh(soft, MOSS_BASE_VOXEL * rscale)
        smooth(soft, MOSS_BASE_SMOOTH, 0.5)
        rock, nfaces = moss_from_rock(soft, name, poly, seed, scale, real=base)
        bpy.data.objects.remove(soft)
        # Clear of the rock AS THE GAME DRAWS IT: its low mesh, built exactly
        # as the rock job builds it, which the remesh moves by up to a voxel
        # from the high (a peak of the low came through the moss lifted only
        # clear of the high).
        rock_ref = low_poly(base, f"{name}-rockref", int(rjob.get("tris") or LOW_TRIS), rscale)
        # The cap's source is a DENSE uniform copy of the drawn rock, not the
        # low itself: the low's dissolved facets are long thin triangles, and
        # one whose centre is inside the cover reaches far outside it (two
        # tongues hung below the moss). The remesh moves the surface by up to
        # half a voxel, which the clearance covers.
        dense = rock_ref.copy()
        dense.data = rock_ref.data.copy()
        dense.name = f"{name}-rockdense"
        bpy.context.collection.objects.link(dense)
        bpy.context.view_layer.objects.active = dense
        remesh(dense, MOSS_VOXEL * scale)
        cap = rock_cap(dense, poly, (MOSS_CLEARANCE + MOSS_VOXEL) * scale, f"{name}-cap", scale)
        bpy.data.objects.remove(dense)
        if cap is not None:
            bpy.ops.object.select_all(action="DESELECT")
            cap.select_set(True)
            rock.select_set(True)
            bpy.context.view_layer.objects.active = rock
            bpy.ops.object.join()
            rock = bpy.context.view_layer.objects.active
            remesh(rock, MOSS_VOXEL * scale)
            smooth(rock, 4, 0.5)
            bpy.ops.object.shade_smooth()
            log(f"moss: fused with the rock cap, {sum(len(p.vertices) - 2 for p in rock.data.polygons)} tris")
        log(f"moss: {lift_clear(rock, rock_ref, MOSS_CLEARANCE * scale)} finished verts lifted clear of the rock's low")
        log(f"moss skin over {nfaces} softened rock faces ({time.time()-t0:.1f}s)")
        # The rock stays in the scene through the bake so the moss's own
        # occlusion sees it (dark under the lip), then goes.
        occluders.append(base)
    else:
        rock = rock_high(job, name, poly, depth, scale, rng, flags, t0)

    # 4. The high mesh is this dense skin as it is: the chisel planes are flat
    # already, the remesh has rounded every edge by a voxel, and a planar
    # dissolve or a bevel here only chops the curved groove walls into strips
    # (streaks and lumps in every crack of the bake).
    bpy.ops.object.select_all(action="DESELECT")
    rock.select_set(True)
    bpy.context.view_layer.objects.active = rock
    bpy.ops.object.shade_smooth()
    tris = sum(len(p.vertices) - 2 for p in rock.data.polygons)
    log(f"high: {tris} tris ({time.time()-t0:.1f}s)")

    # 5. The low mesh, its atlas, and the bake from the high.
    high = rock
    high.name = f"{name}-high"
    budget = int(flags.get("tris") or job.get("tris") or (MOSS_TRIS if kind == "moss" else LOW_TRIS))
    if kind == "moss":
        # A skin at least MOSS_LIP + 9 cm thick: a 3 cm voxel is safe, and a
        # gentle dissolve keeps its curves (the collapse left spikes and holes).
        low = low_poly(high, name, budget, scale, max_voxel=0.03 * scale, dissolve_deg=6.0)
        # The low's own remesh and smoothing flatten a lifted bump straight
        # back under a peak, so the shipped mesh is lifted once more, last.
        log(f"moss: {lift_clear(low, rock_ref, MOSS_CLEARANCE * scale)} low verts lifted clear of the rock's low")
        bpy.data.objects.remove(rock_ref)
    else:
        low = low_poly(high, name, budget, scale)
    low_tris = sum(len(p.vertices) - 2 for p in low.data.polygons)
    log(f"low: {low_tris} tris")
    unwrap(low)
    textures = job.get("textures")
    do_bake = textures is not None and not flags.get("no_bake")
    if do_bake:
        tile = float(flags.get("tile") or job.get("tile") or (MOSS_TILE if kind == "moss" else TEXTURE_TILE))
        src, bsdf, nmap = source_material(textures, tile)
        high.data.materials.clear()
        high.data.materials.append(src)
        bake_mat, imgs = bake_material(name, int(flags.get("bake_size") or BAKE_SIZE), [("basecolor", "sRGB"), ("roughness", "Non-Color"), ("normal", "Non-Color"), ("ao", "Non-Color")])
        low.data.materials.clear()
        low.data.materials.append(bake_mat)
        setup_world(0.0)
        tb = time.time()
        bake(low, high, bake_mat, imgs, AO_SAMPLES, scale)
        log(f"baked 4 maps at {imgs['basecolor'].size[0]} from {tris} onto {low_tris} tris ({time.time()-tb:.1f}s)")
        low.data.materials.clear()
        low.data.materials.append(final_material(name, imgs, textures))
        for img in imgs.values():
            img.pack()
    else:
        low.data.materials.clear()
        low.data.materials.append(clay_material())
    if flags.get("high"):
        # The bake source, for a look at what the low stands in for.
        high.data.materials.clear()
        high.data.materials.append(clay_material())
        rock = high
        bpy.data.objects.remove(low)
    else:
        rock = low
        bpy.data.objects.remove(high)
    shipped = [rock]

    # Previews.
    render_dir = flags.get("render")
    if render_dir:
        os.makedirs(render_dir, exist_ok=True)
        if not do_bake:
            pass
        setup_world(0.6)
        for o in occluders:
            # What the moss grows on, as clay, so the wrap can be judged.
            o.data.materials.clear()
            o.data.materials.append(clay_material())
        samples = int(flags.get("samples") or RENDER_SAMPLES)
        wire = outline_wire(poly, -half - 0.05, 0.004 * scale)
        extent = size * 1.25
        # The outline's centre: the frame's origin may be the body's, metres away.
        ox = sum(p[0] for p in poly) / len(poly)
        oz = sum(p[1] for p in poly) / len(poly)
        look = (ox, 0, oz)
        # Head-on, orthographic: the game's view, the outline drawn in red.
        render(os.path.join(render_dir, f"{name}-front.png"), (ox, -10, oz), look, extent, RENDER_SIZE, samples)
        bpy.data.objects.remove(wire)
        # Three-quarter perspective from above-left.
        d = size * 2.6
        render(os.path.join(render_dir, f"{name}-quarter.png"), (ox - d * 0.7, -d * 0.75, oz + d * 0.55), look, extent, RENDER_SIZE, samples, perspective=True)
        # From the other side, lower, to see the grooves.
        render(os.path.join(render_dir, f"{name}-quarter2.png"), (ox + d * 0.75, -d * 0.6, oz + d * 0.3), look, extent, RENDER_SIZE, samples, perspective=True)
        log(f"rendered previews into {render_dir} ({time.time()-t0:.1f}s)")

    # Export: the shipped meshes alone, at the origin.
    for o in list(scene.objects):
        if o not in shipped:
            bpy.data.objects.remove(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in shipped:
        o.location = (0, 0, 0)
        o["rockName"] = name
        o["rockOrigin"] = [cx, cy]
        o.select_set(True)
    kwargs = dict(
        filepath=out_path,
        export_format="GLB",
        use_selection=True,
        export_extras=True,
        export_yup=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_apply=True,
    )
    props = bpy.ops.export_scene.gltf.get_rna_type().properties
    if "export_image_format" in props.keys():
        kwargs["export_image_format"] = "AUTO"
    bpy.ops.export_scene.gltf(**kwargs)
    log(f"wrote {out_path} ({os.path.getsize(out_path)/1024:.0f} KB, {time.time()-t0:.1f}s)")

def parse_flags(argv):
    flags = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--no-bake":
            flags["no_bake"] = True
        elif a == "--high":
            flags["high"] = True
        elif a in ("--render", "--cuts", "--depth", "--samples", "--bake-size", "--tile", "--tris"):
            flags[a[2:].replace("-", "_")] = argv[i + 1]
            i += 1
        else:
            raise SystemExit(f"unknown flag {a}")
        i += 1
    return flags


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:]
    job_path, out_path = argv[0], argv[1]
    flags = parse_flags(argv[2:])
    with open(job_path) as f:
        job = json.load(f)
    build(job, out_path, flags, os.path.dirname(os.path.abspath(job_path)))
