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
    filled = (np.abs(base[..., :3] - marker).max(axis=2) > 0.02) & (base[..., :3].max(axis=2) > 0.03)
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


def low_poly(high, name, tris, scale):
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
    remesh(low, voxel)
    smooth(low, 2, 0.5)
    mod = low.modifiers.new("planar", "DECIMATE")
    mod.decimate_type = "DISSOLVE"
    mod.angle_limit = math.radians(LOW_DISSOLVE_DEG)
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
    filled = (np.abs(base[..., :3] - marker).max(axis=2) > 0.02) & (base[..., :3].max(axis=2) > 0.03)
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


def build(job, out_path, flags):
    t0 = time.time()
    name = job["name"]
    seed = int(job.get("seed", 0))
    rng = random.Random(seed * 7919 + 17)
    depth = float(flags.get("depth") or job["depth"])

    poly = [(float(p["x"]), float(p["y"])) for p in job["outline"]]
    poly = dedupe(poly)
    if signed_area(poly) < 0:
        poly.reverse()
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    poly = [(x - cx, y - cy) for (x, y) in poly]
    width, height = max(xs) - min(xs), max(ys) - min(ys)
    size = max(width, height)
    scale = size / 1.0  # detail constants are authored for a 1 m rock
    log(f"{name}: outline {len(poly)} verts, {width:.2f} x {height:.2f} m, depth {depth:.2f}, origin at world ({cx:.3f}, {cy:.3f})")

    clear_scene()
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"

    # 1. One rounded mass of the outline.
    half = depth / 2
    rock = prism(name, poly, half, max(RIM_BEVEL * half, 0.02), SIDE_BEVEL * scale)
    voxel = VOXEL * scale
    remesh(rock, voxel)
    smooth(rock, SMOOTH_ITER)
    log(f"mass at voxel {voxel*100:.1f} cm: {len(rock.data.polygons)} faces ({time.time()-t0:.1f}s)")

    # 2. Chisel facets, then rebuild a uniform skin over them.
    cuts = chisel(rock, rng, int(flags.get("cuts") or CUTS), CUT_DEPTH, CUT_MIN_Y, scale)
    remesh(rock, voxel)
    log(f"chiselled {cuts} facets ({time.time()-t0:.1f}s)")

    # 3. Authored cracks.
    cracks = [[(float(p["x"]), float(p["y"])) for p in line] for line in job.get("cracks", [])]
    if cracks:
        moved = carve_cracks(rock, cracks, CRACK_RADIUS, CRACK_DEPTH, CRACK_WOBBLE, rng, scale)
        log(f"carved {len(cracks)} cracks over {moved} verts")
    moved = pull_into_outline(rock, poly, 0.004)
    if moved:
        log(f"{moved} verts pulled back onto the outline")

    # 4. The high mesh is this dense skin as it is: the chisel planes are flat
    # already, the remesh has rounded every edge by a voxel, and a planar
    # dissolve or a bevel here only chops the curved groove walls into strips
    # (streaks and lumps in every crack of the bake).
    smooth(rock, 1, 0.3)
    bpy.ops.object.select_all(action="DESELECT")
    rock.select_set(True)
    bpy.context.view_layer.objects.active = rock
    bpy.ops.object.shade_smooth()
    tris = sum(len(p.vertices) - 2 for p in rock.data.polygons)
    log(f"high: {tris} tris ({time.time()-t0:.1f}s)")

    # 5. The low mesh, its atlas, and the bake from the high.
    high = rock
    high.name = f"{name}-high"
    low = low_poly(high, name, int(flags.get("tris") or LOW_TRIS), scale)
    low_tris = sum(len(p.vertices) - 2 for p in low.data.polygons)
    log(f"low: {low_tris} tris")
    unwrap(low)
    textures = job.get("textures")
    do_bake = textures is not None and not flags.get("no_bake")
    if do_bake:
        tile = float(flags.get("tile") or TEXTURE_TILE)
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
        # The bake source, for a look at what the low is standing in for.
        high.data.materials.clear()
        high.data.materials.append(clay_material())
        rock = high
        bpy.data.objects.remove(low)
    else:
        rock = low
        bpy.data.objects.remove(high)

    # Export: the rock alone, at the origin.
    for o in list(scene.objects):
        if o is not rock:
            bpy.data.objects.remove(o)
    rock.location = (0, 0, 0)
    rock["rockName"] = name
    rock["rockOrigin"] = [cx, cy]
    bpy.ops.object.select_all(action="DESELECT")
    rock.select_set(True)
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

    # Previews.
    render_dir = flags.get("render")
    if render_dir:
        os.makedirs(render_dir, exist_ok=True)
        if not do_bake:
            pass
        setup_world(0.6)
        samples = int(flags.get("samples") or RENDER_SAMPLES)
        wire = outline_wire(poly, -half - 0.05, 0.004 * scale)
        extent = size * 1.25
        # Head-on, orthographic: the game's view, the outline drawn in red.
        render(os.path.join(render_dir, f"{name}-front.png"), (0, -10, 0), (0, 0, 0), extent, RENDER_SIZE, samples)
        bpy.data.objects.remove(wire)
        # Three-quarter perspective from above-left.
        d = size * 2.6
        render(os.path.join(render_dir, f"{name}-quarter.png"), (-d * 0.7, -d * 0.75, d * 0.55), (0, 0, 0), extent, RENDER_SIZE, samples, perspective=True)
        # From the other side, lower, to see the grooves.
        render(os.path.join(render_dir, f"{name}-quarter2.png"), (d * 0.75, -d * 0.6, d * 0.3), (0, 0, 0), extent, RENDER_SIZE, samples, perspective=True)
        log(f"rendered previews into {render_dir} ({time.time()-t0:.1f}s)")


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
    build(job, out_path, flags)
