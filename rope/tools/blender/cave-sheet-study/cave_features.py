"""Replicate the cave asset sheet look feature by feature, headless.

    blender -b --python cave_features.py -- --out out [--samples 96] [--size 640]

Builds one rock-b-like set piece (stacked faceted chunks) and dresses it in
stages, rendering the 3/4 view after every stage, then a four-view sheet:

  1_facets      faceted rock mass, flat grey matte
  2_surface     + mosaic stone shader with edge highlight
  3_moss        + moss carpet (shell mesh + leaf-clump shader)
  4_vines       + hanging vines
  5_plants      + ferns, clover, broadleaf
  6_mushrooms   + mushrooms
  7_sheet_*     full dressing, front / top / side / 3/4

Everything is deterministic (seeded random, no physics).
"""
import argparse
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector, noise

# ---------------------------------------------------------------- palette
# sRGB bytes sampled from the sheets, converted to linear for the shaders.
def srgb(h):
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b), 1.0)

PAL = {
    "ground": "#222d36",
    "rock": "#7d8b9b",       # albedo of a lit facet, before light
    "rock_cool": "#55657a",
    "rock_warm": "#6d7682",
    "rock_seam": "#97a4b2",
    "moss_lit": "#9fba40",
    "moss_mid": "#8aa63a",
    "moss_shade": "#52702a",
    "vine": "#a7c45a",
    "vine_tip": "#c6d86a",
    "fern": "#6fb0a4",
    "fern_dark": "#4d8f85",
    "clover": "#6fae7c",
    "broad": "#5a9a8c",
    "mush_cream": "#e3d9bf",
    "mush_blue": "#b7c3d9",
    "stem": "#d9d2c0",
}


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- scene
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "OPTIX"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == "OPTIX"
    sc.cycles.device = "GPU"
    sc.cycles.use_denoising = True
    sc.cycles.denoiser = "OPTIX"
    sc.cycles.transparent_max_bounces = 32
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Base Contrast"
    sc.view_settings.exposure = 0.0
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = "PNG"
    return sc


def new_object(name, mesh, collection=None):
    ob = bpy.data.objects.new(name, mesh)
    (collection or bpy.context.scene.collection).objects.link(ob)
    return ob


def evaluated_mesh(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
    return me


# ---------------------------------------------------------------- materials
def _nodes(mat):
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    return nt


def mat_flat(name, hexcol, rough=0.95):
    mat = bpy.data.materials.new(name)
    nt = _nodes(mat)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = srgb(hexcol)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Specular IOR Level"].default_value = 0.15
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    return mat


def mat_rock(name):
    """Mosaic stone: Voronoi cells with per-cell tone, light seams on the cell
    borders, a slow warm/cool drift, and a pale line on every mesh edge from
    the Bevel node (Cycles only)."""
    mat = bpy.data.materials.new(name)
    nt = _nodes(mat)
    N = nt.nodes.new
    L = nt.links.new
    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.92
    bsdf.inputs["Specular IOR Level"].default_value = 0.12
    L(bsdf.outputs[0], out.inputs[0])

    coord = N("ShaderNodeTexCoord")
    # warp the cell lattice a little so the mosaic is not a regular honeycomb
    warp = N("ShaderNodeTexNoise")
    warp.inputs["Scale"].default_value = 6.0
    warp.inputs["Detail"].default_value = 2.0
    L(coord.outputs["Object"], warp.inputs["Vector"])
    warpmix = N("ShaderNodeMix")
    warpmix.data_type = "VECTOR"
    warpmix.inputs["Factor"].default_value = 0.015
    L(coord.outputs["Object"], warpmix.inputs[4])
    L(warp.outputs["Color"], warpmix.inputs[5])

    cells = N("ShaderNodeTexVoronoi")
    cells.feature = "F1"
    cells.inputs["Scale"].default_value = 12.0   # ~8 cm cells
    cells.inputs["Randomness"].default_value = 1.0
    L(warpmix.outputs[1], cells.inputs["Vector"])

    seams = N("ShaderNodeTexVoronoi")
    seams.feature = "DISTANCE_TO_EDGE"
    seams.inputs["Scale"].default_value = 12.0
    seams.inputs["Randomness"].default_value = 1.0
    L(warpmix.outputs[1], seams.inputs["Vector"])
    seam_ramp = N("ShaderNodeMapRange")
    seam_ramp.inputs["From Min"].default_value = 0.0
    seam_ramp.inputs["From Max"].default_value = 0.028
    seam_ramp.inputs["To Min"].default_value = 1.0
    seam_ramp.inputs["To Max"].default_value = 0.0
    L(seams.outputs["Distance"], seam_ramp.inputs["Value"])

    # per-cell tone: the Voronoi colour output is a random colour per cell;
    # take one channel as a value and map it to a narrow range
    cell_val = N("ShaderNodeSeparateColor")
    L(cells.outputs["Color"], cell_val.inputs["Color"])
    tone = N("ShaderNodeMapRange")
    tone.inputs["To Min"].default_value = 0.88
    tone.inputs["To Max"].default_value = 1.08
    L(cell_val.outputs["Red"], tone.inputs["Value"])

    # slow drift between a cool and a warm grey across the rock
    drift = N("ShaderNodeTexNoise")
    drift.inputs["Scale"].default_value = 1.2
    drift.inputs["Detail"].default_value = 1.0
    L(coord.outputs["Object"], drift.inputs["Vector"])
    base = N("ShaderNodeMix")
    base.data_type = "RGBA"
    base.inputs[6].default_value = srgb(PAL["rock_cool"])
    base.inputs[7].default_value = srgb(PAL["rock_warm"])
    L(drift.outputs["Fac"], base.inputs[0])

    toned = N("ShaderNodeMix")
    toned.data_type = "RGBA"
    toned.blend_type = "MULTIPLY"
    toned.inputs[0].default_value = 1.0
    L(base.outputs[2], toned.inputs[6])
    tone_rgb = N("ShaderNodeCombineColor")
    L(tone.outputs[0], tone_rgb.inputs[0])
    L(tone.outputs[0], tone_rgb.inputs[1])
    L(tone.outputs[0], tone_rgb.inputs[2])
    L(tone_rgb.outputs[0], toned.inputs[7])

    seamed = N("ShaderNodeMix")
    seamed.data_type = "RGBA"
    seamed.inputs[7].default_value = srgb(PAL["rock_seam"])
    L(toned.outputs[2], seamed.inputs[6])
    seam_w = N("ShaderNodeMath")
    seam_w.operation = "MULTIPLY"
    seam_w.inputs[1].default_value = 0.6
    L(seam_ramp.outputs[0], seam_w.inputs[0])
    L(seam_w.outputs[0], seamed.inputs[0])

    # edge highlight: where the bevelled normal departs from the true normal
    bev = N("ShaderNodeBevel")
    bev.samples = 8
    bev.inputs["Radius"].default_value = 0.05
    geo = N("ShaderNodeNewGeometry")
    dot = N("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    L(bev.outputs["Normal"], dot.inputs[0])
    L(geo.outputs["Normal"], dot.inputs[1])
    edge = N("ShaderNodeMapRange")
    edge.inputs["From Min"].default_value = 0.995
    edge.inputs["From Max"].default_value = 0.90
    edge.inputs["To Min"].default_value = 0.0
    edge.inputs["To Max"].default_value = 0.5
    L(dot.outputs["Value"], edge.inputs["Value"])
    edged = N("ShaderNodeMix")
    edged.data_type = "RGBA"
    edged.inputs[7].default_value = srgb("#c3ccd6")
    L(seamed.outputs[2], edged.inputs[6])
    L(edge.outputs[0], edged.inputs[0])
    L(edged.outputs[2], bsdf.inputs["Base Color"])
    # also shade with the bevelled normal so the chamfer catches light softly
    L(bev.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def mat_moss(name):
    """Moss: leaf-clump mosaic (small Voronoi cells, darker between cells),
    yellow-green where the shell faces up and olive where it faces sideways."""
    mat = bpy.data.materials.new(name)
    nt = _nodes(mat)
    N = nt.nodes.new
    L = nt.links.new
    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.05
    L(bsdf.outputs[0], out.inputs[0])

    coord = N("ShaderNodeTexCoord")
    clumps = N("ShaderNodeTexVoronoi")
    clumps.feature = "SMOOTH_F1"
    clumps.inputs["Scale"].default_value = 45.0  # ~2 cm leaf clumps
    clumps.inputs["Smoothness"].default_value = 0.3
    L(coord.outputs["Object"], clumps.inputs["Vector"])
    gaps = N("ShaderNodeTexVoronoi")
    gaps.feature = "DISTANCE_TO_EDGE"
    gaps.inputs["Scale"].default_value = 45.0
    L(coord.outputs["Object"], gaps.inputs["Vector"])
    gap_ramp = N("ShaderNodeMapRange")
    gap_ramp.inputs["From Max"].default_value = 0.006
    gap_ramp.inputs["To Min"].default_value = 0.72
    gap_ramp.inputs["To Max"].default_value = 1.0
    L(gaps.outputs["Distance"], gap_ramp.inputs["Value"])

    sep = N("ShaderNodeSeparateColor")
    L(clumps.outputs["Color"], sep.inputs[0])
    tone = N("ShaderNodeMapRange")
    tone.inputs["To Min"].default_value = 0.85
    tone.inputs["To Max"].default_value = 1.15
    L(sep.outputs["Red"], tone.inputs["Value"])

    # up-facing factor from the (smooth) normal
    geo = N("ShaderNodeNewGeometry")
    sepn = N("ShaderNodeSeparateXYZ")
    L(geo.outputs["Normal"], sepn.inputs[0])
    up = N("ShaderNodeMapRange")
    up.inputs["From Min"].default_value = -0.2
    up.inputs["From Max"].default_value = 0.9
    L(sepn.outputs["Z"], up.inputs["Value"])
    col = N("ShaderNodeMix")
    col.data_type = "RGBA"
    col.inputs[6].default_value = srgb(PAL["moss_shade"])
    col.inputs[7].default_value = srgb(PAL["moss_lit"])
    L(up.outputs[0], col.inputs[0])

    t1 = N("ShaderNodeMath")
    t1.operation = "MULTIPLY"
    L(tone.outputs[0], t1.inputs[0])
    L(gap_ramp.outputs[0], t1.inputs[1])
    tone_rgb = N("ShaderNodeCombineColor")
    for i in range(3):
        L(t1.outputs[0], tone_rgb.inputs[i])
    mul = N("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs[0].default_value = 1.0
    L(col.outputs[2], mul.inputs[6])
    L(tone_rgb.outputs[0], mul.inputs[7])
    L(mul.outputs[2], bsdf.inputs["Base Color"])

    # true displacement from the clumps so the carpet's silhouette is leafy
    disp = N("ShaderNodeDisplacement")
    disp.inputs["Scale"].default_value = 0.022
    disp.inputs["Midlevel"].default_value = 0.5
    L(clumps.outputs["Distance"], disp.inputs["Height"])
    L(disp.outputs[0], out.inputs["Displacement"])
    mat.displacement_method = "BOTH"
    return mat


def mat_leaf(name, hex_a, hex_b, two_sided=True):
    """Flat leaf colour, varied per leaf by a 'rand' attribute, no gloss."""
    mat = bpy.data.materials.new(name)
    nt = _nodes(mat)
    N = nt.nodes.new
    L = nt.links.new
    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.05
    L(bsdf.outputs[0], out.inputs[0])
    attr = N("ShaderNodeAttribute")
    attr.attribute_name = "rand"
    mix = N("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs[6].default_value = srgb(hex_a)
    mix.inputs[7].default_value = srgb(hex_b)
    L(attr.outputs["Fac"], mix.inputs[0])
    L(mix.outputs[2], bsdf.inputs["Base Color"])
    mat.use_backface_culling = not two_sided
    return mat


# ---------------------------------------------------------------- rock chunks
def make_chunk(name, center, size, rot_z, seed, points=34, boxiness=2.4):
    """A convex faceted stone: hull of points inside a superellipsoid, planar
    decimation to merge near-coplanar faces, a chamfer, flat shading."""
    rng = random.Random(seed)
    bm = bmesh.new()
    pts = []
    while len(pts) < points:
        v = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        if sum(abs(c) ** boxiness for c in v) <= 1.0:
            pts.append(v)
    for p in pts:
        bm.verts.new((p.x * size[0], p.y * size[1], p.z * size[2]))
    bm.verts.ensure_lookup_table()
    res = bmesh.ops.convex_hull(bm, input=bm.verts)
    inside = [g for g in res["geom_interior"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.delete(bm, geom=inside, context="VERTS")
    # flatten the base so the stone sits
    for v in bm.verts:
        if v.co.z < -size[2] * 0.82:
            v.co.z = -size[2] * 0.82
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = new_object(name, me)
    ob.location = center
    ob.rotation_euler = (0, 0, rot_z)
    dec = ob.modifiers.new("planar", "DECIMATE")
    dec.decimate_type = "DISSOLVE"
    dec.angle_limit = math.radians(15)
    bev = ob.modifiers.new("chamfer", "BEVEL")
    bev.width = 0.015
    bev.segments = 1
    bev.limit_method = "ANGLE"
    bev.angle_limit = math.radians(25)
    # bake the modifiers so later passes read the final shape
    final = evaluated_mesh(ob)
    ob.modifiers.clear()
    ob.data = final
    for p in final.polygons:
        p.use_smooth = False
    return ob


def build_cluster():
    """rock-b: a two-tier boulder cluster, 2.68 x 1.84 x 1.56 m."""
    spec = [
        # name, centre, half-size, rot, seed
        ("base", (0.15, 0.05, 0.45), (1.10, 0.85, 0.55), 0.08, 1),
        ("tier", (-0.35, 0.10, 1.05), (0.75, 0.70, 0.60), -0.25, 2),
        ("crown", (-0.40, 0.20, 1.50), (0.50, 0.46, 0.30), 0.35, 3),
        ("shoulder", (0.60, -0.05, 0.85), (0.58, 0.52, 0.36), 0.5, 4),
        ("front", (0.40, -0.75, 0.22), (0.44, 0.32, 0.27), -0.4, 5),
        ("pebble", (-1.10, -0.50, 0.15), (0.26, 0.22, 0.18), 0.9, 6),
        ("pebble2", (1.25, -0.40, 0.13), (0.24, 0.20, 0.16), 0.2, 7),
    ]
    chunks = []
    for name, c, s, r, seed in spec:
        ob = make_chunk(name, Vector(c), s, r, seed)
        chunks.append(ob)
    return chunks


# ---------------------------------------------------------------- moss shell
def moss_shell(chunk, seed, thick=0.075):
    """A copy of the stone, voxel-remeshed to a fine grid, kept where a
    mask says moss grows, pushed out along the normal, then smoothed."""
    rng = random.Random(seed)
    off = Vector((rng.uniform(0, 50), rng.uniform(0, 50), rng.uniform(0, 50)))
    src = bpy.data.objects.new("tmp", chunk.data.copy())
    bpy.context.scene.collection.objects.link(src)
    src.matrix_world = chunk.matrix_world.copy()
    rm = src.modifiers.new("remesh", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = 0.015
    rm.use_smooth_shade = True
    sm = src.modifiers.new("smooth", "SMOOTH")
    sm.factor = 0.8
    sm.iterations = 6
    me = evaluated_mesh(src)
    bpy.data.objects.remove(src)

    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    bm.verts.ensure_lookup_table()
    M = chunk.matrix_world
    zs = [(M @ v.co).z for v in bm.verts]
    ztop = max(zs)
    zbot = min(zs)
    h = ztop - zbot
    mask = {}
    mlay = bm.verts.layers.float.new("m")
    tlay = bm.verts.layers.float.new("t")
    for v in bm.verts:
        p = M @ v.co
        n = (M.to_3x3() @ v.normal).normalized()
        up = smoothstep(0.0, 0.7, n.z)
        lobes = 0.5 + 0.5 * noise.noise(p * 2.2 + off)
        lobes = smoothstep(0.25, 0.55, lobes)
        # tongues down the sides just under the lip: a vertically stretched
        # noise so the sag runs in streaks
        lip = smoothstep(0.42, 0.02, (ztop - p.z) / max(h, 1e-3))
        streak = 0.5 + 0.5 * noise.noise(Vector((p.x * 7, p.y * 7, p.z * 1.6)) + off)
        tongue = 1.5 * (1 - up) * lip * smoothstep(0.48, 0.62, streak)
        rag = 0.25 * noise.noise(p * 40 + off)
        m = up * lobes + tongue + rag
        mask[v.index] = (m, tongue)
        v[mlay] = m
        v[tlay] = tongue
    keep = set()
    for f in bm.faces:
        ms = [mask[v.index][0] for v in f.verts]
        if sum(ms) / len(ms) > 0.5:
            keep.add(f.index)
    bm.faces.ensure_lookup_table()
    kill = [f for f in bm.faces if f.index not in keep]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    # drop crumbs: islands with few faces
    bm.faces.ensure_lookup_table()
    seen = set()
    for f in bm.faces:
        if f in seen:
            continue
        isl, stack = [], [f]
        while stack:
            g = stack.pop()
            if g in seen:
                continue
            seen.add(g)
            isl.append(g)
            for e in g.edges:
                stack.extend(e.link_faces)
        if len(isl) < 40:
            bmesh.ops.delete(bm, geom=isl, context="FACES")
    bm.verts.ensure_lookup_table()
    # hops from the carpet's boundary, so the shell domes down to the stone
    hops = {}
    frontier = [v for v in bm.verts if any(e.is_boundary for e in v.link_edges)]
    for v in frontier:
        hops[v] = 0
    d = 0
    while frontier:
        d += 1
        nxt = []
        for v in frontier:
            for e in v.link_edges:
                o = e.other_vert(v)
                if o not in hops:
                    hops[o] = d
                    nxt.append(o)
        frontier = nxt
    for v in bm.verts:
        m, tongue = v[mlay], v[tlay]
        rim = smoothstep(0.0, 4.0, hops.get(v, 9))
        amt = thick * (0.25 + 0.75 * smoothstep(0.45, 0.9, m)) * rim
        v.co += v.normal * amt
        v.co.z -= 0.035 * tongue * rim
    for _ in range(3):
        bmesh.ops.smooth_vert(bm, verts=bm.verts[:], factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    out = bpy.data.meshes.new(chunk.name + ".moss")
    bm.to_mesh(out)
    bm.free()
    for p in out.polygons:
        p.use_smooth = True
    ob = new_object(chunk.name + ".moss", out)
    ob.matrix_world = chunk.matrix_world.copy()
    return ob


# ---------------------------------------------------------------- leaves
def leaf_card(bm, origin, axis, side, length, width, rand, droop=0.0, tip=1.0):
    """One pointed-oval leaf card as a fan of quads. axis = base→tip direction,
    side = width direction. Returns the new verts."""
    axis = axis.normalized()
    side = side.normalized()
    up = axis.cross(side).normalized()
    if droop:
        axis = (axis * math.cos(droop) - up * math.sin(droop)).normalized()
        up = axis.cross(side).normalized()
    rows = 6
    prev = None
    verts = []
    for i in range(rows + 1):
        t = i / rows
        w = width * math.sin(math.pi * t) ** 0.8 * (1 - 0.35 * t * tip)
        sag = -0.25 * length * t * t
        c = origin + axis * (length * t) + up * sag
        if i == 0 or i == rows:
            row = [bm.verts.new(c)]
        else:
            row = [bm.verts.new(c - side * w), bm.verts.new(c + side * w)]
        for v in row:
            v[bm.verts.layers.float["rand"]] = rand
        verts.extend(row)
        if prev:
            if len(prev) == 1 and len(row) == 2:
                bm.faces.new((prev[0], row[0], row[1]))
            elif len(prev) == 2 and len(row) == 2:
                bm.faces.new((prev[0], row[0], row[1], prev[1]))
            else:
                bm.faces.new((prev[0], row[0], prev[1]))
        prev = row
    return verts


def new_leaf_bmesh():
    bm = bmesh.new()
    bm.verts.layers.float.new("rand")
    return bm


def finish_leaf_mesh(bm, name, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = new_object(name, me)
    ob.data.materials.append(mat)
    return ob


# ---------------------------------------------------------------- vines
def lip_points(chunk, rng, want_down=False):
    """Points on edges where an up-facing (or down-facing) facet meets a
    steep one: the lips a vine hangs from."""
    me = chunk.data
    M = chunk.matrix_world
    R = M.to_3x3()
    pts = []
    for e in me.edges:
        faces = [p for p in me.polygons if e.index in p.edge_keys and False]
    # faster: build edge→faces map
    edge_faces = {}
    for p in me.polygons:
        for ek in p.edge_keys:
            edge_faces.setdefault(tuple(sorted(ek)), []).append(p)
    for ek, fs in edge_faces.items():
        if len(fs) != 2:
            continue
        n0 = (R @ fs[0].normal).normalized()
        n1 = (R @ fs[1].normal).normalized()
        if want_down:
            ok = (n0.z < -0.5 and abs(n1.z) < 0.35) or (n1.z < -0.5 and abs(n0.z) < 0.35)
        else:
            ok = (n0.z > 0.55 and abs(n1.z) < 0.3) or (n1.z > 0.55 and abs(n0.z) < 0.3)
        if not ok:
            continue
        steep = n1 if abs(n0.z) > abs(n1.z) else n0
        a = M @ me.vertices[ek[0]].co
        b = M @ me.vertices[ek[1]].co
        L = (b - a).length
        k = max(1, int(L / 0.12))
        for i in range(k):
            t = (i + rng.random()) / k
            p = a.lerp(b, t)
            out = Vector((steep.x, steep.y, 0)).normalized()
            pts.append((p, out))
    return pts


def build_vines(chunks, seed, count_per=(3, 5, 3, 3, 2, 0, 0)):
    rng = random.Random(seed)
    bm = new_leaf_bmesh()
    stems = []
    for chunk, count in zip(chunks, count_per):
        pts = lip_points(chunk, rng)
        rng.shuffle(pts)
        chosen = []
        for p, out in pts:
            if len(chosen) >= count:
                break
            if all((p - q).length > 0.18 for q, _ in chosen):
                chosen.append((p, out))
        for p, out in chosen:
            length = rng.uniform(0.45, 1.1)
            start = p + out * 0.04 + Vector((0, 0, 0.02))
            pts_line = []
            nseg = int(length / 0.03)
            phase = rng.uniform(0, 6.28)
            for i in range(nseg + 1):
                t = i / nseg
                sway = 0.03 * math.sin(phase + t * 2.3) * t
                q = start + Vector((0, 0, -length * t)) + out * (0.01 + 0.03 * t) + out.cross(Vector((0, 0, 1))) * sway
                pts_line.append(q)
            stems.append(pts_line)
            # leaves alternate sides, taper to the tip
            spacing = 0.03
            n_leaves = int(length / spacing)
            right = out.cross(Vector((0, 0, 1))).normalized()
            for j in range(n_leaves):
                t = (j + 0.5) / n_leaves
                idx = min(nseg, int(t * nseg))
                base = pts_line[idx]
                sgn = 1 if j % 2 == 0 else -1
                size = lerp(0.07, 0.035, t)
                side_dir = (right * sgn + out * rng.uniform(-0.2, 0.5)).normalized()
                axis = (side_dir * 0.3 + Vector((0, 0, -1)) * 1.0).normalized()
                leaf_card(bm, base, axis, out.cross(axis), size, size * 0.55, rng.random())
    ob = finish_leaf_mesh(bm, "vine_leaves", mat_leaf("VineLeaf", PAL["vine"], PAL["vine_tip"]))
    # stems as a bevelled curve
    cu = bpy.data.curves.new("vine_stems", "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = 0.005
    cu.bevel_resolution = 2
    for line in stems:
        sp = cu.splines.new("POLY")
        sp.points.add(len(line) - 1)
        for pt, q in zip(sp.points, line):
            pt.co = (q.x, q.y, q.z, 1)
    stem_ob = new_object("vine_stems", cu)
    stem_ob.data.materials.append(mat_flat("VineStem", "#6f8a3a"))
    return [ob, stem_ob]


# ---------------------------------------------------------------- plants
def fern(bm, base, rng, fronds=6, scale=1.0):
    for k in range(fronds):
        az = rng.uniform(0, 2 * math.pi)
        d = Vector((math.cos(az), math.sin(az), 0))
        length = rng.uniform(0.42, 0.6) * scale
        rise = rng.uniform(0.6, 1.0)
        n = 14
        prev = base
        for i in range(1, n + 1):
            t = i / n
            p = base + d * (length * t) + Vector((0, 0, length * rise * math.sin(math.pi * t * 0.85) * (1 - 0.3 * t)))
            axis = (p - prev).normalized()
            side = axis.cross(Vector((0, 0, 1))).normalized()
            size = 0.1 * scale * math.sin(math.pi * (0.15 + 0.85 * t)) ** 0.7 * (1.1 - t * 0.6)
            for sgn in (1, -1):
                la = (side * sgn * 0.8 + axis * 0.45).normalized()
                leaf_card(bm, p, la, la.cross(Vector((0, 0, 1)) + side * 0.2), size, size * 0.5, rng.random(), droop=0.5, tip=0.2)
            prev = p
        # the rachis itself is thin; a slim card along it
        leaf_card(bm, base, (prev - base).normalized(), d.cross(Vector((0, 0, 1))), length * 1.05, 0.004, 0.5)


def clover(bm, base, rng, leaves=7, scale=1.0):
    for k in range(leaves):
        az = rng.uniform(0, 2 * math.pi)
        d = Vector((math.cos(az), math.sin(az), 0))
        h = rng.uniform(0.06, 0.14) * scale
        r = rng.uniform(0.04, 0.12) * scale
        c = base + d * r + Vector((0, 0, h))
        # stalk
        leaf_card(bm, base, (c - base).normalized(), d.cross(Vector((0, 0, 1))), (c - base).length, 0.003, 0.5)
        # five lobes
        s = rng.uniform(0.06, 0.09) * scale
        for i in range(5):
            a = az + i * 2 * math.pi / 5 + rng.uniform(-0.2, 0.2)
            la = Vector((math.cos(a), math.sin(a), 0.25)).normalized()
            leaf_card(bm, c, la, la.cross(Vector((0, 0, 1))), s, s * 0.45, rng.random(), droop=0.3)


def broadleaf(bm, base, rng, leaves=6, scale=1.0):
    for k in range(leaves):
        az = rng.uniform(0, 2 * math.pi)
        d = Vector((math.cos(az), math.sin(az), 0))
        la = (d + Vector((0, 0, rng.uniform(0.6, 1.3)))).normalized()
        size = rng.uniform(0.18, 0.26) * scale
        leaf_card(bm, base, la, la.cross(Vector((0, 0, 1))), size, size * 0.3, rng.random(), droop=0.9)


def surface_point(x, y, z_from=4.0):
    """Drop a ray from above and return the hit on any rock."""
    sc = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    ok, loc, nrm, idx, ob, M = sc.ray_cast(dg, Vector((x, y, z_from)), Vector((0, 0, -1)))
    return (loc, nrm) if ok else (Vector((x, y, 0)), Vector((0, 0, 1)))


def base_point(angle, rng, chunks):
    """Walk in from far away toward the cluster at ankle height and stop just
    outside the first stone hit."""
    sc = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    d = Vector((math.cos(angle), math.sin(angle), 0))
    origin = Vector((0.1, -0.1, 0)) + d * 4 + Vector((0, 0, 0.06))
    ok, loc, nrm, idx, ob, M = sc.ray_cast(dg, origin, -d)
    if ok and ob in chunks:
        return loc + d * rng.uniform(0.04, 0.12)
    return None


def build_plants(chunks, seed):
    rng = random.Random(seed)
    bm_fern = new_leaf_bmesh()
    bm_clover = new_leaf_bmesh()
    bm_broad = new_leaf_bmesh()
    # ring of plants around the foot, denser at the front
    angles = [-1.9, -1.45, -1.05, -0.7, -0.25, 0.25, 0.75, 2.6, 3.4, 3.9]
    kinds = ["fern", "clover", "broad", "clover", "fern", "clover", "fern", "clover", "fern", "clover"]
    for a, kind in zip(angles, kinds):
        p = base_point(a, rng, chunks)
        if p is None:
            continue
        p.z = 0.0
        if kind == "fern":
            fern(bm_fern, p, rng, fronds=rng.randint(5, 7))
        elif kind == "clover":
            clover(bm_clover, p, rng, leaves=rng.randint(6, 10))
        else:
            broadleaf(bm_broad, p, rng)
    # crevice plants on the tiers (dropped from above)
    for (x, y, kind) in [(0.05, -0.35, "clover"), (-0.05, 0.35, "fern"), (0.95, -0.35, "clover"), (-0.9, 0.2, "clover"), (0.4, 0.25, "fern")]:
        loc, n = surface_point(x, y)
        if kind == "fern":
            fern(bm_fern, loc, rng, fronds=5, scale=0.75)
        else:
            clover(bm_clover, loc, rng, leaves=6, scale=0.9)
    objs = [
        finish_leaf_mesh(bm_fern, "ferns", mat_leaf("Fern", PAL["fern_dark"], PAL["fern"])),
        finish_leaf_mesh(bm_clover, "clover", mat_leaf("Clover", PAL["clover"], PAL["broad"])),
        finish_leaf_mesh(bm_broad, "broadleaf", mat_leaf("Broadleaf", PAL["broad"], PAL["clover"])),
    ]
    return objs


# ---------------------------------------------------------------- mushrooms
def build_mushrooms(seed):
    rng = random.Random(seed)
    objs = []
    cap_mat = mat_flat("MushCap", PAL["mush_cream"], rough=0.8)
    stem_mat = mat_flat("MushStem", PAL["stem"], rough=0.9)
    spots = [(-0.62, 0.05), (0.3, -0.05)]
    for sx, sy in spots:
        for k in range(3):
            x, y = sx + rng.uniform(-0.06, 0.06), sy + rng.uniform(-0.06, 0.06)
            loc, n = surface_point(x, y)
            h = rng.uniform(0.04, 0.07)
            r = rng.uniform(0.04, 0.06)
            bm = bmesh.new()
            bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=r)
            for v in bm.verts:
                v.co.z = max(v.co.z, -r * 0.25) * 0.75
            bmesh.ops.translate(bm, verts=bm.verts[:], vec=(0, 0, h))
            me = bpy.data.meshes.new("cap")
            bm.to_mesh(me)
            bm.free()
            for p in me.polygons:
                p.use_smooth = True
            cap = new_object("cap", me)
            cap.location = loc
            cap.data.materials.append(cap_mat)
            bm = bmesh.new()
            bmesh.ops.create_cone(bm, segments=10, radius1=r * 0.28, radius2=r * 0.2, depth=h)
            bmesh.ops.translate(bm, verts=bm.verts[:], vec=(0, 0, h / 2))
            me = bpy.data.meshes.new("stem")
            bm.to_mesh(me)
            bm.free()
            for p in me.polygons:
                p.use_smooth = True
            st = new_object("stem", me)
            st.location = loc
            st.data.materials.append(stem_mat)
            objs += [cap, st]
    return objs


# ---------------------------------------------------------------- lighting + camera
def build_stage():
    sc = bpy.context.scene
    # world: very dark, slightly blue
    w = bpy.data.worlds.new("World")
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.004, 0.006, 0.009, 1)
    bg.inputs[1].default_value = 1.0
    # ground
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=20)
    me = bpy.data.meshes.new("ground")
    bm.to_mesh(me)
    bm.free()
    g = new_object("ground", me)
    g.data.materials.append(mat_flat("Ground", PAL["ground"], rough=1.0))

    def area(name, loc, aim, size, power, col):
        ld = bpy.data.lights.new(name, "AREA")
        ld.size = size
        ld.energy = power
        ld.color = col
        ob = new_object(name, ld)
        ob.location = loc
        ob.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        return ob

    area("key", (-3.2, -4.5, 5.5), (0, 0, 0.8), 3.0, 650, (1.0, 0.97, 0.92))
    area("fill", (4.5, -3.5, 2.5), (0, 0, 0.8), 5.0, 120, (0.72, 0.84, 1.0))
    area("rim", (1.0, 4.5, 4.0), (0, 0, 0.8), 3.0, 220, (0.85, 0.92, 1.0))

    cam_d = bpy.data.cameras.new("cam")
    cam_d.lens = 60
    cam = new_object("cam", cam_d)
    sc.camera = cam
    return cam


def aim_camera(cam, objs, az_deg, el_deg, pad=0.78):
    """Place the camera on a sphere around the dressed object's bounds."""
    import itertools
    pts = []
    for ob in objs:
        if ob.type != "MESH":
            continue
        for c in ob.bound_box:
            pts.append(ob.matrix_world @ Vector(c))
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    centre = (lo + hi) / 2
    radius = (hi - lo).length / 2
    az = math.radians(az_deg)
    el = math.radians(el_deg)
    d = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    fov = 2 * math.atan(cam.data.sensor_width / (2 * cam.data.lens))
    dist = radius * pad / math.tan(fov / 2)
    cam.location = centre + d * dist
    cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()


def render(path):
    sc = bpy.context.scene
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("[render]", path)


# ---------------------------------------------------------------- main
def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out")
    ap.add_argument("--samples", type=int, default=96)
    ap.add_argument("--size", type=int, default=640)
    ap.add_argument("--only", default="")
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)

    sc = reset_scene()
    sc.cycles.samples = args.samples
    sc.render.resolution_x = sc.render.resolution_y = args.size
    cam = build_stage()

    chunks = build_cluster()
    rock_mat = mat_rock("Stone")
    grey = mat_flat("Grey", PAL["rock"], rough=0.95)
    for c in chunks:
        c.data.materials.append(grey)

    moss_mat = mat_moss("Moss")
    mosses = []
    for i, c in enumerate(chunks):
        if c.name.startswith("pebble"):
            continue
        m = moss_shell(c, seed=100 + i)
        m.data.materials.append(moss_mat)
        mosses.append(m)
    vines = build_vines(chunks, seed=7)
    plants = build_plants(chunks, seed=11)
    shrooms = build_mushrooms(seed=5)

    groups = {"moss": mosses, "vines": vines, "plants": plants, "shrooms": shrooms}

    def show(*names):
        for g, obs in groups.items():
            for ob in obs:
                ob.hide_render = g not in names

    view_objs = chunks + mosses + vines + plants
    stages = [
        ("1_facets", (), grey),
        ("2_surface", (), rock_mat),
        ("3_moss", ("moss",), rock_mat),
        ("4_vines", ("moss", "vines"), rock_mat),
        ("5_plants", ("moss", "vines", "plants"), rock_mat),
        ("6_mushrooms", ("moss", "vines", "plants", "shrooms"), rock_mat),
    ]
    only = [s for s in args.only.split(",") if s]
    for name, shown, mat in stages:
        if only and name not in only:
            continue
        for c in chunks:
            c.data.materials[0] = mat
        show(*shown)
        aim_camera(cam, view_objs, -38, 22)
        render(os.path.join(args.out, name + ".png"))

    if not only or "sheet" in only:
        for c in chunks:
            c.data.materials[0] = rock_mat
        show("moss", "vines", "plants", "shrooms")
        for name, az, el in [("front", 0, 10), ("top", -15, 68), ("side", 90, 10), ("3q", -38, 22)]:
            aim_camera(cam, view_objs, az, el)
            render(os.path.join(args.out, "7_sheet_" + name + ".png"))

    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.out, "cave_features.blend"))


if __name__ == "__main__":
    main()
