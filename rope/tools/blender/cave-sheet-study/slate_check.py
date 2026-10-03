"""Render the SHIPPED painted slate (formations/slate.py) the way the cave-sheet
study rendered its v6 pick, so the two can be compared pixel for pixel.

    # the study's own recipe F rocks, their material swapped for slate.py's
    blender -b out/rock/pillow_v6.blend --python slate_check.py -- --out DIR
    # a formation from a scene file, on the study's stage under the v6 rig
    blender -b ../../../assets-src/scenes/river.blend --python slate_check.py -- --out DIR --rock "Terrace / new"

Without --rock the open file is the saved study scene (stage, v6 lights,
camera); with it the file only lends the rock: the scene is reset to the
study's (cave_features.build_stage + rock_study.light_v6) and the rock is
copied in centred, standing on the ground. Nothing is saved.
"""
import argparse
import json
import math
import os
import sys
import time

import bmesh
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, ".."))
import cave_features as cf  # noqa: E402
import rock_study  # noqa: E402
from formations import curve, detail, slate  # noqa: E402

# Azimuth, elevation (degrees) and framing (cave_features.aim_camera's pad:
# 0.78 frames the whole rock, smaller is closer on its centre).
VIEWS = {"3q": (-38, 22, 0.78), "front": (0, 10, 0.78), "left3q": (38, 22, 0.78), "low": (-38, 6, 0.78),
         "high": (-38, 45, 0.78), "close3q": (-38, 22, 0.3), "closefront": (0, 10, 0.3)}


SPACE = ["TANGENT"]
# As scene_export.py: texels per metre of unwrapped surface, power of two.
TEXELS_PER_METRE, BAKE_SIZE_MAX, UV_COVERAGE = 256, 2048, 0.6


# Edges turning more than this (radians) are written by --mark-creases.
CREASE_MARK = math.radians(5)


def write_creases(sc, ob, path):
    """The rock's visible edges turning more than CREASE_MARK, as image
    pixel segments from the scene camera with their signed angle in degrees,
    for an overlay."""
    from bpy_extras.object_utils import world_to_camera_view
    import bmesh as _bm
    bm = _bm.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    w, h = sc.render.resolution_x, sc.render.resolution_y
    dg = bpy.context.evaluated_depsgraph_get()
    eye = sc.camera.matrix_world.translation

    def seen(p):
        d = p - eye
        hit, loc, *_ = sc.ray_cast(dg, eye, d.normalized(), distance=d.length + 1.0)
        return hit and (loc - p).length < 0.01
    segs = []
    for e in bm.edges:
        mid = ob.matrix_world @ ((e.verts[0].co + e.verts[1].co) / 2)
        if e.is_manifold and abs(e.calc_face_angle_signed(0)) > CREASE_MARK and seen(mid):
            pts = []
            for v in e.verts:
                c = world_to_camera_view(sc, sc.camera, ob.matrix_world @ v.co)
                pts.append((c.x * w, (1 - c.y) * h, c.z))
            if all(p[2] > 0 for p in pts):
                segs.append([pts[0][:2], pts[1][:2], round(math.degrees(e.calc_face_angle_signed(0)), 1)])
    bm.free()
    with open(path, "w") as f:
        json.dump(segs, f)


def show_high(sc, ob, high, straight):
    """Swap the rock for its detail high poly, flat, a random grey per face;
    a face whose three corners are all vertices of the `straight` rock (a
    plane detail.py left as it was) is red."""
    import random as _r
    rng = _r.Random(0)
    me = high.data
    old = {tuple(round(c, 5) for c in v.co) for v in straight.vertices}
    col = me.color_attributes.new("tri", "FLOAT_COLOR", "FACE")
    untouched = 0
    for i, p in enumerate(me.polygons):
        g = rng.uniform(0.25, 0.75)
        kept = all(tuple(round(c, 5) for c in me.vertices[k].co) in old for k in p.vertices)
        untouched += kept
        col.data[i].color = (0.8, 0.15 * g, 0.1 * g, 1.0) if kept else (g, g, g, 1.0)
    print(f"[slate_check] high poly: {untouched} of {len(me.polygons)} faces untouched (red)")
    for p in me.polygons:
        p.use_smooth = False
    m = bpy.data.materials.new("triangles")
    m.use_nodes = True
    nt = m.node_tree
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "tri"
    nt.links.new(attr.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    me.materials.clear()
    me.materials.append(m)
    ob.hide_render = True


def bake_detail(sc, ob, mat, seed, straight, bows, keep_high=False):
    """The export's detail bake, short: unwrap, build the high poly from the
    rock (formations/detail.py), bake its normals onto the rock in tangent
    space, and feed the map to the slate's shading Bevel. The high poly is
    built from the `straight` rock; the rock is still straight here (it is
    bent after the bake), so the two line up exactly."""
    t0 = time.time()
    area = sum(p.area for p in ob.data.polygons)
    size = int(min(BAKE_SIZE_MAX, 2 ** math.ceil(math.log2(math.sqrt(area / UV_COVERAGE) * TEXELS_PER_METRE))))
    for o in bpy.context.view_layer.objects:
        o.select_set(o == ob)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=2 / size, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    uv = ob.data.uv_layers.active.name
    high, report = detail.build(straight, seed, sc.collection, "detail")
    high.matrix_world = ob.matrix_world.copy()
    im = bpy.data.images.new("detail normal", size, size)
    im.colorspace_settings.name = "Non-Color"
    nt = mat.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = im
    nt.nodes.active = tex
    high.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.bake(type="NORMAL", normal_space=SPACE[0], use_selected_to_active=True,
                        cage_extrusion=detail.CAGE, max_ray_distance=detail.RAY_DISTANCE,
                        target="IMAGE_TEXTURES", uv_layer=uv, margin=8)
    nm = slate.add_detail(mat, tex.outputs["Color"], uv)
    nm.space = SPACE[0]
    if keep_high:
        show_high(sc, ob, high, straight)
    else:
        me = high.data
        bpy.data.objects.remove(high)
        bpy.data.meshes.remove(me)
    print(f"[slate_check] detail: {report}; {size}px baked in {time.time() - t0:.1f}s")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--rock", help="a formation object in the open file; omitted = the study scene as saved")
    p.add_argument("--views", default="3q")
    p.add_argument("--samples", type=int, default=64)
    p.add_argument("--size", type=int, default=640)
    p.add_argument("--tag", default="")
    p.add_argument("--detail", type=int, default=1, help="with --rock: 1 = bake the chips and sub-facets (formations/detail.py) and put them under the shading Bevel, as the export does")
    p.add_argument("--curve", type=int, default=1, help="with --rock: 1 = bow the long straight creases (formations/curve.py), as the export does")
    p.add_argument("--bow", type=float, nargs=2, help="override curve.BOW: the bow's share of a crease's length, low high")
    p.add_argument("--max-bow", type=float, help="override curve.MAX_BOW, metres")
    p.add_argument("--spacing", type=float, help="override detail.SPACING, the sub-facet size, metres")
    p.add_argument("--smooth", type=int, default=1, help="with --curve: 1 = shade the bent rock smooth below curve.SMOOTH_ANGLE (as the export), 0 = flat")
    p.add_argument("--show-high", action="store_true", help="with --rock: render the detail high poly itself, one random grey per triangle, instead of the baked rock (to see its triangulation)")
    p.add_argument("--cage", type=float, help="override detail.CAGE, metres: how far outside the rock the bake looks for the high poly")
    p.add_argument("--space", default="TANGENT", choices=("TANGENT", "OBJECT"), help="normal map space of the detail bake (diagnostic)")
    p.add_argument("--tolerance", type=float, help="override curve.TOLERANCE (the shipped rock's fit), metres")
    p.add_argument("--edge-mix", type=float, help="override slate.EDGE_MIX, the pale edge line's strength (0 = no line)")
    p.add_argument("--mark-creases", action="store_true", help="also write each view's visible edges over 5 degrees (with their angles) in image pixels, as <render>_creases.json, for an overlay")
    p.add_argument("--shade-radius", type=float, help="radius of the slate's SHADING Bevel only (the rounding), metres; 0 = no rounding; the edge line keeps its own")
    p.add_argument("--strips", type=int, default=1, help="with --rock: 1 = paint narrow chamfer strips as the edge line (slate.mark_strips), as the export does")
    p.add_argument("--mask", action="store_true", help="also render each view with the ground held out on a transparent film: its alpha is the rock mask slate_measure.py samples by")
    a = p.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    if a.spacing:
        detail.SPACING = a.spacing
    if a.cage:
        detail.CAGE = a.cage
    SPACE[0] = a.space
    if a.edge_mix is not None:
        slate.EDGE_MIX = a.edge_mix
    if a.tolerance:
        curve.TOLERANCE = a.tolerance
    if a.bow:
        curve.BOW = tuple(a.bow)
    if a.max_bow:
        curve.MAX_BOW = a.max_bow

    if a.rock:
        src = bpy.data.objects[a.rock]
        try:
            seed = int(json.loads(src["formation_recipe"])["params"]["seed"])
        except (KeyError, TypeError, ValueError):
            seed = sum(ord(c) for c in src.name)
        bm = bmesh.new()
        bm.from_mesh(src.data)
        bmesh.ops.transform(bm, matrix=src.matrix_world, verts=bm.verts)
        lo = Vector((min(v.co.x for v in bm.verts), min(v.co.y for v in bm.verts), min(v.co.z for v in bm.verts)))
        hi = Vector((max(v.co.x for v in bm.verts), max(v.co.y for v in bm.verts), max(v.co.z for v in bm.verts)))
        # Centred on the stage, standing on the ground (the formation's own
        # base sits under the river's floor, so its lowest point is a hair low).
        bmesh.ops.translate(bm, verts=bm.verts, vec=Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z)))
        # The study's reset reloads factory settings and frees every
        # datablock, so the rock waits in the bmesh until after it.
        cf.reset_scene()
        me = bpy.data.meshes.new("rock")
        bm.to_mesh(me)
        bm.free()
        sc = bpy.context.scene
        cam = cf.build_stage()
        rock_study.light_v6()
        if a.strips:
            print(f"[slate_check] strips: {slate.mark_strips(me)} chamfer strips painted as edge line")
        # The detail is built from the straight rock and bent after (curve.py).
        bows = curve.find_bows(me, seed) if a.curve else []
        if bows:
            print(f"[slate_check] curve: {curve.rebuild_mesh(me, bows, seed, smooth=bool(a.smooth))}")
        straight = me.copy()
        ob = cf.new_object("rock", me)
        if not bows or not a.smooth:
            for poly in me.polygons:
                poly.use_smooth = False
        if me.attributes.get("facet") is None:
            slate.tone_facets(ob, 1)
        rocks = [ob]
        print(f"[slate_check] {a.rock}: {len(me.polygons)} faces, {hi - lo} m")
    else:
        sc = bpy.context.scene
        cam = sc.camera
        rocks = [ob for ob in bpy.data.objects if ob.type == "MESH" and ob.name != "ground"]

    mat = slate.painted_slate()
    if a.shade_radius is not None:
        bev = mat.node_tree.nodes[slate.SHADING_BEVEL]
        if a.shade_radius > 0:
            bev.inputs["Radius"].default_value = a.shade_radius
        else:
            bev.inputs["Radius"].default_value = 0.0
    for ob in rocks:
        ob.data.materials.clear()
        ob.data.materials.append(mat)
    if a.rock and a.detail:
        bake_detail(sc, rocks[0], mat, seed, straight, bows, keep_high=a.show_high)
    if a.rock and bows:
        # After the bake, as the export does (curve.py).
        print(f"[slate_check] bend: {curve.bend(rocks[0].data, bows)}")
    sc.cycles.samples = a.samples
    sc.render.resolution_x = sc.render.resolution_y = a.size
    for name in a.views.split(","):
        cf.aim_camera(cam, rocks, *VIEWS[name])
        t0 = time.time()
        cf.render(os.path.join(a.out, f"slate{a.tag}_{name}.png"))
        print(f"[slate_check] {name} in {time.time() - t0:.1f}s")
        if a.mark_creases:
            write_creases(sc, rocks[0], os.path.join(a.out, f"slate{a.tag}_{name}_creases.json"))
        if a.mask:
            ground = bpy.data.objects.get("ground")
            ground.is_holdout, sc.render.film_transparent = True, True
            cf.render(os.path.join(a.out, f"slate{a.tag}_{name}_mask.png"))
            ground.is_holdout, sc.render.film_transparent = False, False


main()
