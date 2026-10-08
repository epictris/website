"""Export a level's Blender scene as the game's dressing.

    blender -b assets-src/scenes/<scene>.blend --factory-startup --python-exit-code 1 \
        --python tools/blender/scene_export.py -- out.glb meta.json [--cache DIR [--stale-occlusion]]

Run by `scripts/scene-export.ts` (`just scene <level>`), which optimises the
result and finishes the meta; see docs/blender-scenes.md.

WHAT GOES OUT. Every object in the scene that has geometry (a mesh, a curve, a
surface, a text, a metaball), except:

- one linked from another file (the level's collision guide is one, linked
  from `<scene>-guide.blend`), or an override of one;
- one in a collection whose name starts with "guide" (any case), or in a
  collection excluded from the view layer (the checkbox in the outliner);
- one hidden in RENDER (the camera icon), itself or through a collection it is
  in. Render visibility is what ships; viewport visibility is the artist's own
  business and is ignored, so a reference hidden to get it out of the way is
  still hidden from the game only if it is hidden from the render.

Lights, cameras, empties, armatures never go out: the level's own lights carry
a budget and semantics glTF cannot (see docs/lighting-and-surfaces.md), and an
empty that parents things is flattened away by the optimiser anyway.

WHAT IS KEPT. Every object's WORLD transform, because that is the whole
binding: the renderer mounts an object named like a body at Blender's pose
minus the body's rest pose and lets the body carry it (render3d/sceneDressing.ts).
Modifiers are applied. Materials go as glTF can carry them - a Principled BSDF
with image textures, a constant tint on one, alpha clipped by a threshold - and
a PROCEDURAL Base Color or Normal (noise, ramps, mixes, bumps: what the
formations' stone is) is baked by Cycles into an image of the exported copy's
own, through a fresh unwrap, and wired back in, so it goes as a
baseColorTexture or normalTexture (`bake_procedural_textures`). Everything else
glTF cannot carry is reported in `warnings`.

Frames: Blender is z-up, the exporter writes y-up (Blender x, y, z -> glTF
x, z, -y), and the game draws in glTF's frame (x right, y up, z toward the
camera). So the gameplay plane is Blender y = 0, toward the camera is Blender
-y, and a backdrop behind the level sits at positive Blender y. The guide the
level exports stands in this frame, so nothing here has to be remembered.
"""

import json
import math
import os
import re
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Vector, kdtree

# Object types with geometry the glTF exporter carries.
EXPORTABLE = {"MESH", "CURVE", "SURFACE", "FONT", "META"}

# Collections whose objects are the artist's reference and never ship.
GUIDE_PREFIX = "guide"


def log(msg):
    print(f"[scene_export] {msg}", flush=True)


def step(name, note=None):
    """Tell scene-export.ts's progress display that step `name` starts now
    (and so the one before it is done). The list of steps, their order and
    their labels are that script's (STEPS); `note` is what the display shows
    beside the step."""
    print(f"[scene_step] {json.dumps({'step': name, 'note': note})}", flush=True)


def node_name(name):
    """How three.js spells this object's node name (see `nodeNameOf` in
    render3d/scenes.ts): whitespace to `_`, then `[`, `]`, `.`, `:`, `/`
    dropped. The report compares body names through the same rule."""
    return re.sub(r"[\[\]\.:/]", "", re.sub(r"\s", "_", name))


def to_game(v):
    """Blender (x, y, z) -> the game's (x, z, -y)."""
    return [v.x, v.z, -v.y]


def excluded_collections(view_layer):
    """Every collection whose objects stay out: excluded from the view layer,
    hidden in render, named as a guide, or linked - and every collection
    inside one of those."""
    out = set()

    def walk(layer_coll, inherited):
        coll = layer_coll.collection
        skip = (
            inherited
            or layer_coll.exclude
            or coll.hide_render
            or coll.name.lower().startswith(GUIDE_PREFIX)
            or coll.library is not None
        )
        if skip:
            out.add(coll)
        for child in layer_coll.children:
            walk(child, skip)

    for child in view_layer.layer_collection.children:
        walk(child, False)
    return out


def skip_reason(ob, excluded):
    if ob.library is not None or ob.override_library is not None:
        return f"linked from {os.path.basename(ob.library.filepath) if ob.library else 'a library'}"
    data = getattr(ob, "data", None)
    if data is not None and getattr(data, "library", None) is not None:
        return f"data linked from {os.path.basename(data.library.filepath)}"
    if ob.type not in EXPORTABLE:
        kind = ob.type.lower()
        return f"{'an' if kind[0] in 'aeiou' else 'a'} {kind}"
    for coll in ob.users_collection:
        if coll in excluded:
            return f"in collection {coll.name}"
    if ob.hide_render:
        return "hidden in render"
    return None


def carries_vertex_color(node):
    """Whether a Base Color source is glTF's COLOR_0 - a Color Attribute alone,
    or one multiplied with an Image Texture (baseColorTexture x COLOR_0). This
    is the shape Blender's glTF importer builds and its exporter writes back."""
    if node.type == "VERTEX_COLOR":
        return True
    if node.type == "MIX" and node.data_type == "RGBA":
        by_id = {i.identifier: i for i in node.inputs}
        factor, inputs = by_id["Factor_Float"], [by_id["A_Color"], by_id["B_Color"]]
    elif node.type == "MIX_RGB":
        factor, inputs = node.inputs["Fac"], [node.inputs["Color1"], node.inputs["Color2"]]
    else:
        return False
    if node.blend_type != "MULTIPLY" or factor.is_linked or factor.default_value != 1.0:
        return False
    if not all(i.is_linked for i in inputs):
        return False
    kinds = sorted(i.links[0].from_node.type for i in inputs)
    return kinds == ["TEX_IMAGE", "VERTEX_COLOR"] and all(
        i.links[0].from_node.image is not None for i in inputs if i.links[0].from_node.type == "TEX_IMAGE"
    )


def carries_tint(node):
    """Whether a Base Color source is an Image Texture times a constant colour
    - a Mix (Multiply, factor 1) with one side an image and the other unlinked -
    which glTF carries as baseColorTexture x baseColorFactor."""
    if node.type != "MIX" or node.data_type != "RGBA" or node.blend_type != "MULTIPLY":
        return False
    by_id = {i.identifier: i for i in node.inputs}
    factor, a, b = by_id["Factor_Float"], by_id["A_Color"], by_id["B_Color"]
    if factor.is_linked or factor.default_value != 1.0:
        return False
    linked = [i for i in (a, b) if i.is_linked]
    return (len(linked) == 1 and linked[0].links[0].from_node.type == "TEX_IMAGE"
            and linked[0].links[0].from_node.image is not None)


def procedural_base_colors(mat):
    """The Principled BSDFs of `mat` whose Base Color glTF cannot carry."""
    if mat is None or mat.node_tree is None:
        return []
    out = []
    for node in mat.node_tree.nodes:
        if node.type != "BSDF_PRINCIPLED" or not node.inputs["Base Color"].is_linked:
            continue
        src = node.inputs["Base Color"].links[0].from_node
        if src.type != "TEX_IMAGE" and not carries_vertex_color(src) and not carries_tint(src):
            out.append(node)
    return out


def procedural_normals(mat):
    """The Principled BSDFs of `mat` whose Normal glTF cannot carry: anything
    but a Normal Map fed by an image, except a Bump of strength 0 (the boulder
    generator's stone at its default), which changes nothing."""
    if mat is None or mat.node_tree is None:
        return []
    out = []
    for node in mat.node_tree.nodes:
        if node.type != "BSDF_PRINCIPLED" or not node.inputs["Normal"].is_linked:
            continue
        src = node.inputs["Normal"].links[0].from_node
        if src.type == "NORMAL_MAP" and src.inputs["Color"].is_linked \
                and src.inputs["Color"].links[0].from_node.type == "TEX_IMAGE":
            continue
        if src.type == "BUMP" and not src.inputs["Strength"].is_linked and src.inputs["Strength"].default_value == 0:
            continue
        out.append(node)
    return out


# The UV map the bake unwraps each target into; its images read through it.
BAKE_UV = "SceneBake"
# The painted slate's edge line (a Bevel node) and crevices (Ambient
# Occlusion) are ray traced, so the bake is a render: at 4 samples the edge line
# came out as speckle that drew hairy and blurred once magnified. 32 is clean;
# 64 differed from it by 0.3 levels rms (the Terrace, 2026-10-02).
BAKE_SAMPLES = 32
# Cycles GPU backends, best first. The bake runs on the first one with a
# device and on the CPU without: the Terrace's 2k map took 3.4 s on an
# RTX 4070 SUPER (OptiX) and 24.5 s on the CPU, with the same result to
# 0.008 levels rms.
GPU_BACKENDS = ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL")


def bake_device():
    """Point Cycles at the best GPU backend that has a device, and say which;
    "CPU" when none does. `--factory-startup` leaves the preferences at their
    defaults (no compute device), so the export chooses for itself."""
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in GPU_BACKENDS:
        try:
            prefs.compute_device_type = kind
        except TypeError:
            # A backend this build of Blender does not have.
            continue
        prefs.get_devices()
        devices = [d for d in prefs.devices if d.type == kind]
        if devices:
            for d in prefs.devices:
                d.use = d.type == kind
            return f"{kind} {', '.join(d.name for d in devices)}"
    prefs.compute_device_type = "NONE"
    return "CPU"
# The maps' sizes (texels per metre, the bounds, the normal map's share, the
# unwrap's coverage) are formations/render.py's: the moss add-on's preview of
# a texture-only moss reads them too.
#
# Pixels between islands in the pack. Every texel outside the islands is
# filled afterwards (`fill_background`), so this gap is only what keeps two
# islands from sharing a texel at full resolution. It is kept at the object's
# smallest map (the normal map, render.NORMAL_SCALE), where islands 1 px apart
# would filter into each other.
PACK_GAP_PX = 2
# How far apart two vertices may be and still be one for the unwrap.
WELD_DISTANCE = 1e-5
# Faces smaller than this (square metres) get one UV for all their corners.
DEGENERATE_AREA = 1e-8
# The corner attribute that carries each corner's index through the weld.
UNWRAP_TAG = "scene_bake_corner"


def detail_scale(ob):
    """How many times further back than the gameplay plane `ob` is drawn as
    if it stood (formations/render.py)."""
    from formations import render
    return render.detail_scale(ob)


def render_setting(ob, name):
    """`ob`'s render setting `name`: its own, else what its depth decides
    (formations/render.py)."""
    from formations import render
    return render.setting(ob, name)


def bake_size(mesh, ob):
    """The side of `ob`'s colour map, baked on `mesh` (formations/render.py)."""
    from formations import render
    return render.colour_map(ob, sum(p.area for p in mesh.polygons))


def map_size(size, kind):
    """The side of an object's `kind` map ("baked colour", ...) when its colour
    map is `size` (formations/render.py)."""
    from formations import render
    return render.map_size(size, kind)


def select_only(obs, active):
    view_layer = bpy.context.view_layer
    for ob in view_layer.objects:
        try:
            ob.select_set(ob in obs)
        except RuntimeError:
            pass
    view_layer.objects.active = active


def unwrap(ob, size):
    """A fresh UV map BAKE_UV on `ob`, islands packed PACK_GAP_PX apart at
    `size`.

    The unwrap runs on a WELDED copy: a flat-shaded mesh that came in through
    glTF (the river's boulders) has every face's vertices split from its
    neighbours', and Smart UV Project then makes every face its own island -
    thousands of specks, most of the image background. Every corner is tagged
    with its index before the weld, so the UVs go back corner for corner and
    the exported mesh, its normals included, is untouched. The weld drops the
    faces it collapses (zero area, so nothing of them is ever drawn); their
    corners take the UV of the nearest welded corner. It runs on one object at
    a time, because Smart UV Project in a multi-object edit packs every object
    into one shared square."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    tag = bm.loops.layers.int.new(UNWRAP_TAG)
    i = 0
    for face in bm.faces:
        for loop in face.loops:
            loop[tag] = i
            i += 1
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=WELD_DISTANCE)
    welded = bpy.data.meshes.new(f"{ob.name} unwrap")
    bm.to_mesh(welded)
    bm.free()
    tmp = bpy.data.objects.new(f"{ob.name} unwrap", welded)
    bpy.context.scene.collection.objects.link(tmp)
    select_only([tmp], tmp)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    # Smart UV Project packs as it goes. Repacking with rotation won 7 points
    # of coverage (0.62 -> 0.69 on the Terrace) for 9 s an object; not worth it.
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=PACK_GAP_PX / size, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    n = len(welded.loops)
    uv_welded = np.empty(2 * n, dtype=np.float32)
    welded.uv_layers.active.data.foreach_get("uv", uv_welded)
    origin = np.empty(n, dtype=np.int32)
    welded.attributes[UNWRAP_TAG].data.foreach_get("value", origin)
    corner_vert = np.empty(n, dtype=np.int32)
    welded.loops.foreach_get("vertex_index", corner_vert)
    co = np.empty(3 * len(welded.vertices), dtype=np.float32)
    welded.vertices.foreach_get("co", co)
    corner_co = co.reshape(-1, 3)[corner_vert]
    bpy.data.objects.remove(tmp)
    bpy.data.meshes.remove(welded)

    uvs = np.full((len(ob.data.loops), 2), np.nan, dtype=np.float32)
    uvs[origin] = uv_welded.reshape(-1, 2)
    lost = np.flatnonzero(np.isnan(uvs[:, 0]))
    if len(lost):
        tree = kdtree.KDTree(n)
        for j, c in enumerate(corner_co):
            tree.insert(c, j)
        tree.balance()
        verts = np.empty(len(ob.data.loops), dtype=np.int32)
        ob.data.loops.foreach_get("vertex_index", verts)
        for j in lost:
            uvs[j] = uv_welded[2 * tree.find(ob.data.vertices[verts[j]].co)[1]:][:2]
    # A face with no area (the dissolve's collinear slivers) can have its
    # corners land on different islands, a streak across the atlas. Flat it
    # draws nothing; bent open after the bake (formations/curve.py) it drew
    # that streak as a pale stair-stepped band. Collapse it onto one corner
    # that came through the weld, so it takes the colour of where it sits.
    start = np.empty(len(ob.data.polygons), dtype=np.int32)
    total = np.empty(len(ob.data.polygons), dtype=np.int32)
    ob.data.polygons.foreach_get("loop_start", start)
    ob.data.polygons.foreach_get("loop_total", total)
    area = np.empty(len(ob.data.polygons))
    ob.data.polygons.foreach_get("area", area)
    found = set(range(len(uvs))) - set(lost.tolist())
    for f in np.flatnonzero(area < DEGENERATE_AREA):
        corners = range(start[f], start[f] + total[f])
        keep = next((c for c in corners if c in found), start[f])
        uvs[list(corners)] = uvs[keep]
    uv = ob.data.uv_layers.new(name=BAKE_UV)
    uv.data.foreach_set("uv", uvs.ravel())


def fill_background(im):
    """Fill every texel no island covers, so no mip level reads background
    (docs/blender-scenes.md#what-blender-cannot-carry). A margin ring is not
    enough: at a distance the GPU samples a mip where one texel averages
    dozens of the source's, and any background among them shows as a dark
    line along every seam. Pull-push: average the baked texels down a pyramid
    to one, then walk back up filling each unbaked texel from the level above.
    The bake leaves an unbaked texel's alpha at 0, which is the mask."""
    w, h = im.size
    px = np.empty(w * h * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    known = px[..., 3] > 0.5
    levels = [(px[..., :3] * known[..., None], known.astype(np.float32))]
    def down(a):
        # Each 2 x 2 block summed as four slices: a strided reshape-and-sum
        # was most of the fill's time, 18 s over the river's 4k maps.
        hh, ww = a.shape[0] // 2 * 2, a.shape[1] // 2 * 2
        return a[0:hh:2, 0:ww:2] + a[1:hh:2, 0:ww:2] + a[0:hh:2, 1:ww:2] + a[1:hh:2, 1:ww:2]

    while levels[-1][1].shape[0] > 1 and levels[-1][1].shape[1] > 1:
        c, k = levels[-1]
        levels.append((down(c), down(k)))
    color = levels[-1][0] / np.maximum(levels[-1][1], 1e-6)[..., None]
    for c, k in reversed(levels[:-1]):
        # Each texel reads its parent; an odd last row or column the one
        # before it, as the edge would be padded.
        rows = np.minimum(np.arange(k.shape[0]) // 2, color.shape[0] - 1)
        cols = np.minimum(np.arange(k.shape[1]) // 2, color.shape[1] - 1)
        up = color[rows[:, None], cols[None, :]]
        color = np.where(k[..., None] > 0, c / np.maximum(k, 1e-6)[..., None], up)
    px[..., :3] = color
    px[..., 3] = 1.0
    im.pixels.foreach_set(px.ravel())


def is_slate(mat):
    """Whether `mat` is the formations add-on's painted slate (or a `.001`
    copy an append makes): the stone that gets the detail normal map."""
    from formations import slate
    return mat is not None and (mat.name == slate.NAME or mat.name.startswith(slate.NAME + "."))


def bake_detail_normals(targets, images, straight):
    """Bake each painted slate rock's chips and sub-facets (formations/
    detail.py, built here from the rock's own mesh and removed after) into
    its normal image, one selected-to-active bake per rock, and return the
    image nodes keyed by material. The high poly is built from the rock's
    `straight` mesh (the rock is split for its bows but not yet bent, so the
    two line up exactly). It stands at the rock's world transform; the bake casts from detail.CAGE outside the rock inward to
    detail.RAY_DISTANCE."""
    from formations import detail
    scene = bpy.context.scene
    nodes = {}
    for ob in targets:
        high, report = detail.build(straight.get(ob, ob.data), seed_for(ob), scene.collection, f"{ob.name} detail")
        high.matrix_world = ob.matrix_world.copy()
        for mat in ob.data.materials:
            node = mat.node_tree.nodes.new("ShaderNodeTexImage")
            node.image = images[ob]
            uv = mat.node_tree.nodes.new("ShaderNodeUVMap")
            uv.uv_map = BAKE_UV
            mat.node_tree.links.new(uv.outputs["UV"], node.inputs["Vector"])
            mat.node_tree.nodes.active = node
            nodes[mat] = node
        select_only([high, ob], ob)
        t0 = time.time()
        bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", use_selected_to_active=True,
                            cage_extrusion=detail.CAGE, max_ray_distance=detail.RAY_DISTANCE,
                            target="IMAGE_TEXTURES", uv_layer=BAKE_UV, margin=0)
        log(f"detail {ob.name}: {report}; baked in {time.time() - t0:.1f}s")
        me = high.data
        bpy.data.objects.remove(high)
        bpy.data.meshes.remove(me)
        fill_background(images[ob])
        images[ob].pack()
    return nodes


def seed_for(ob):
    """The detail's seed: the formation's own, else a hash of the name, so
    the same rock gets the same chips on every export."""
    try:
        return int(json.loads(ob["formation_recipe"])["params"]["seed"])
    except (KeyError, TypeError, ValueError):
        return sum(ord(c) for c in ob.name)


def preparation(ob):
    """Everything besides its mesh and materials that decides how `ob` is
    prepared and baked: its detail seed and every render setting
    (formations/render.py: the depth, the strips, creases and chips, the map
    size), as the bake cache keys it."""
    from formations import render
    return seed_for(ob), [(name, render.setting(ob, name)) for name in render.SETTINGS]


def export_materials(ob, materials):
    """The export's own copy of each of `ob`'s `materials` (a slot's, or
    None), so each object's point at its own images; a painted slate on a
    rock drawn further back is repainted at its depth (formations/slate.py)."""
    out = []
    for mat in materials:
        copy = mat.copy() if mat is not None else None
        if copy is not None and is_slate(mat) and detail_scale(ob) != 1.0:
            from formations import slate
            copy[slate.SCALE_PROP] = detail_scale(ob)
            slate.paint(copy)
        out.append(copy)
    return out


def export_mesh_name(ob):
    """The name of the mesh the export prepares (or loads from the bake
    cache) for `ob`: one no mesh in the file has, so Blender never renumbers
    it, and a cached object's glTF matches a baked one's byte for byte."""
    return f"{ob.name} export"


def image_name(ob, kind):
    """The name of `ob`'s `kind` map ("baked colour", ...). No dot in it: the
    glTF exporter takes everything after the last dot for an extension, so
    "Terrace.003 baked colour" shipped as "Terrace", missed the optimiser's
    " baked colour" rule and went out as lossy WebP at 1k, a quarter of its
    texels (2026-10-04; scene-export.ts now checks every baked map is
    matched)."""
    return f"{ob.name.replace('.', '-')} {kind}"


def image_nodes(targets, images):
    """An Image Texture of its object's image in each of the targets'
    materials, read through BAKE_UV and ACTIVE (where a bake writes). Returns
    the nodes, keyed by material."""
    nodes = {}
    for ob in targets:
        for mat in ob.data.materials:
            node = mat.node_tree.nodes.new("ShaderNodeTexImage")
            node.image = images[ob]
            uv = mat.node_tree.nodes.new("ShaderNodeUVMap")
            uv.uv_map = BAKE_UV
            mat.node_tree.links.new(uv.outputs["UV"], node.inputs["Vector"])
            mat.node_tree.nodes.active = node
            nodes[mat] = node
    return nodes


def bake_pass(targets, images, bake_type, before_fill=None, **bake_args):
    """One Cycles bake of every target into its own image: each material
    gets an Image Texture of its object's image as the ACTIVE node, which is
    where a bake writes. `before_fill(ob, image)` runs on each image while its
    alpha still marks the baked texels. Returns the nodes, keyed by material."""
    nodes = image_nodes(targets, images)
    select_only(targets, targets[0])
    bpy.ops.object.bake(type=bake_type, target="IMAGE_TEXTURES", uv_layer=BAKE_UV, margin=0, **bake_args)
    if before_fill is not None:
        for ob in targets:
            before_fill(ob, images[ob])
    for im in set(images.values()):
        fill_background(im)
        im.pack()
    return nodes


def paint_moss(ob, im, paints):
    """Paint the texture-only mosses of `ob` (moss.texture_paints entries)
    into its freshly baked colour map `im`, before the background fill, so
    the fill carries the moss into the seams like any baked texel."""
    import moss

    w, h = im.size
    px = np.empty(w * h * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    me = ob.data
    me.calc_loop_triangles()
    n = len(me.loop_triangles)
    loops = np.empty(n * 3, np.int32)
    me.loop_triangles.foreach_get("loops", loops)
    verts = np.empty(n * 3, np.int32)
    me.loop_triangles.foreach_get("vertices", verts)
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers[BAKE_UV].data.foreach_get("uv", uv)
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    m = np.array(ob.matrix_world, dtype=np.float64)
    world = co.reshape(-1, 3).astype(np.float64) @ m[:3, :3].T + m[:3, 3]
    uv_px = uv.reshape(-1, 2)[loops].reshape(n, 3, 2).astype(np.float64) * (w, h)
    tri_pos = world[verts].reshape(n, 3, 3)
    for mo, _host, layers, p, _key in paints:
        t0 = time.time()
        texels = moss.paint_map(px, uv_px, tri_pos, layers(), p)
        log(f"moss {mo.name}: grown in {mo.moss.build_ms / 1000:.1f}s and painted into {im.name}, {texels} texels, {time.time() - t0:.1f}s")
    im.pixels.foreach_set(px.ravel())


def bake_procedural_textures(kept, cache_dir=None, paints=(), warnings=None, stale_occlusion=False):
    """Bake every procedural Base Color (and Normal) the kept meshes use into
    an image of the object's own, and wire it in, so glTF carries the stone as
    a baseColorTexture (and normalTexture) instead of dropping it to a flat
    default.

    Only the colour is baked - Cycles' diffuse COLOR pass, no light - so the
    game still lights the surface; a procedural normal (a bump) goes as a
    tangent-space normal map. It works on the export's own copies: each target
    gets a mesh with its modifiers applied and a fresh unwrap (BAKE_UV), its
    materials are copied so each object's point at its own images, and the file
    is never saved. The resolution is formations/render.py's (`bake_size`:
    TEXELS_PER_METRE up to BAKE_SIZE_MAX). With `cache_dir`, an object whose
    prepared mesh and maps are in the bake cache (bake_cache.py) loads them
    instead of being prepared and baked: the key is taken on the scene before
    anything is prepared, so a cached object costs neither its creases'
    rebuild nor its unwrap. With `stale_occlusion`, an object whose
    neighbours alone changed loads its last bake too (bake_cache.Cache), and
    each one is named in `warnings`. Returns how many objects were baked or
    loaded.

    `paints` (moss.texture_paints) are texture-only mosses: a rock one grows
    on has its colour baked whatever its material, and the moss painted into
    the bake (`paint_moss`); a cached map holds its moss, the moss's key
    being part of the cache key."""
    by_host = {}
    for entry in paints:
        mo, host = entry[0], entry[1]
        if host in kept and host.type == "MESH":
            by_host.setdefault(host, []).append(entry)
        elif warnings is not None:
            warnings.append(f"{mo.name}: its rock {host.name} is not exported; the moss painted on it is not either")
    targets = [ob for ob in kept if ob.type == "MESH"
               and (ob in by_host or any(procedural_base_colors(m) or procedural_normals(m) for m in ob.data.materials))]
    if not targets:
        step("bake", "nothing procedural")
        return 0
    t0 = time.time()
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()
    # Set before the cache keys, which take them in.
    scene.render.engine = "CYCLES"
    device = bake_device()
    scene.cycles.device = "CPU" if device == "CPU" else "GPU"
    scene.cycles.samples = BAKE_SAMPLES
    # Each object's own copies of its materials, so its point at its own
    # images; a far-back rock's slate repainted to its depth.
    materials = {ob: export_materials(ob, [s.material for s in ob.evaluated_get(depsgraph).material_slots])
                 for ob in targets}
    for ob in targets:
        if any(m is None for m in materials[ob]) or not materials[ob]:
            # A bake needs a material to write through on every face.
            raise SystemExit(f"{ob.name}: a procedural material shares the object with an empty material slot")
    colored = [ob for ob in targets if ob in by_host or any(procedural_base_colors(m) for m in materials[ob])]
    bumped = [ob for ob in targets if any(procedural_normals(m) for m in materials[ob])]
    # The maps each object ships, as (kind, colour space).
    ships = {ob: [k for k, among in (("baked colour", colored), ("baked normal", bumped)) if ob in among]
             for ob in targets}
    space = {"baked colour": "sRGB", "baked normal": "Non-Color"}

    # Objects whose prepared mesh and maps are cached load them and are left
    # out of the preparation and every bake. Every key is taken before
    # anything is prepared, on the scene as the file has it. A cached mesh
    # is the straight one, bent with the others after the bakes, so the
    # objects still to bake meet it as a cold export would.
    sizes, straight, bows = {}, {}, {}
    cache, keys, hits, loaded, stale = None, {}, {}, {}, []
    if cache_dir:
        import bake_cache
        cache = bake_cache.Cache(cache_dir, depsgraph, {ob: preparation(ob) for ob in targets}, stale_occlusion)
        for ob in targets:
            keys[ob] = cache.key(ob, scene, materials[ob], [entry[4] for entry in by_host.get(ob, ())])
            hit = cache.get(keys[ob], [image_name(ob, k) for k in ships[ob]])
            if hit is not None:
                hits[ob] = hit
                if hit[3] != keys[ob]:
                    stale.append(ob)
        if stale and warnings is not None:
            warnings.append(f"--stale-occlusion: {len(stale)} objects keep the occlusion of their last bake, their "
                            f"neighbours since changed: {', '.join(sorted(ob.name for ob in stale))}")
        for ob, (files, mesh_file, data, _) in hits.items():
            loaded[ob] = {k: bake_cache.load(files[image_name(ob, k)], image_name(ob, k), space[k]) for k in ships[ob]}
            ob.modifiers.clear()
            ob.data = bake_cache.load_mesh(mesh_file, materials[ob])
            ob.data.name = export_mesh_name(ob)
            if data and data.get("bows"):
                bows[ob] = [(Vector(a), Vector(b), Vector(bow), reach) for a, b, bow, reach in data["bows"]]
    step("bake", f"{len(targets) - len(loaded)} of {len(targets)} objects to bake"
         + (f", {len(loaded)} cached" if cache else ", cache off")
         + (f" ({len(stale)} with stale occlusion)" if stale else ""))

    for ob in targets:
        if ob in loaded:
            continue
        mesh = bpy.data.meshes.new_from_object(ob.evaluated_get(depsgraph), preserve_all_data_layers=True,
                                               depsgraph=depsgraph)
        mesh.name = export_mesh_name(ob)
        ob.modifiers.clear()
        ob.data = mesh
        slate_rock = any(is_slate(m) for m in mesh.materials)
        if slate_rock and render_setting(ob, "export_strips"):
            from formations import slate
            log(f"strips {ob.name}: {slate.mark_strips(mesh)} chamfer strips painted as edge line")
        if slate_rock and render_setting(ob, "export_creases"):
            # Long straight creases (formations/curve.py): split now, before
            # the unwrap; every map is baked on the straight rock, which the
            # detail high poly matches exactly, and the rock is bent after.
            from formations import curve
            bows[ob] = curve.find_bows(mesh, seed_for(ob))
            log(f"curve {ob.name}: {curve.rebuild_mesh(mesh, bows[ob], seed_for(ob), smooth=True)}")
        if slate_rock and render_setting(ob, "export_chips"):
            straight[ob] = mesh.copy()
        if len(mesh.materials) != len(materials[ob]):
            raise SystemExit(f"{ob.name}: {len(mesh.materials)} material slots on its mesh, {len(materials[ob])} on the object")
        for i, mat in enumerate(materials[ob]):
            mesh.materials[i] = mat
        sizes[ob] = bake_size(mesh, ob)
        bumps = any(procedural_normals(m) for m in mesh.materials)
        unwrap(ob, map_size(sizes[ob], "baked normal") if bumps else sizes[ob])

    def images(obs, kind, colorspace):
        out = {}
        for ob in obs:
            # With alpha, cleared to 0: the bake writes 1 where it baked, which
            # is the mask `fill_background` fills the rest by.
            side = map_size(sizes[ob], kind)
            im = bpy.data.images.new(image_name(ob, kind), side, side, alpha=True)
            im.generated_color = (0, 0, 0, 0)
            im.colorspace_settings.name = colorspace
            # Drawn by this export for this object: an original, no credit owed.
            im["generated_by"] = "tools/blender/scene_export.py"
            out[ob] = im
        return out

    fresh = {}  # ob -> the images baked for it here, to cache

    def bake_or_load(obs, kind, bake):
        """Nodes reading `kind` in every material of `obs`: baked by
        `bake(those, images)` for the objects not cached, loaded for the rest."""
        todo = [ob for ob in obs if ob not in loaded]
        nodes = {}
        if todo:
            made = images(todo, kind, space[kind])
            nodes.update(bake(todo, made))
            for ob in todo:
                fresh.setdefault(ob, []).append(made[ob])
        done = [ob for ob in obs if ob in loaded]
        nodes.update(image_nodes(done, {ob: loaded[ob][kind] for ob in done}))
        return nodes

    if colored:
        def moss_into(ob, im):
            if ob in by_host:
                paint_moss(ob, im, by_host[ob])

        nodes = bake_or_load(colored, "baked colour",
                             lambda obs, ims: bake_pass(obs, ims, "DIFFUSE", before_fill=moss_into, pass_filter={"COLOR"}))
        mossed = {m for ob in by_host for m in ob.data.materials}
        for mat, node in nodes.items():
            # A mossed rock's map replaces every Base Color, procedural or
            # not: the moss is only in the map.
            bsdfs = ([n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"] if mat in mossed
                     else procedural_base_colors(mat))
            for bsdf in bsdfs:
                mat.node_tree.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
    def wire_normal(mat, node, bsdf):
        normal_map = mat.node_tree.nodes.new("ShaderNodeNormalMap")
        normal_map.uv_map = BAKE_UV
        mat.node_tree.links.new(node.outputs["Color"], normal_map.inputs["Color"])
        mat.node_tree.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])

    # The painted slate's chips and sub-facets: a normal map baked from a
    # detail high poly (docs/rock-detail.md), put under the slate's shading
    # Bevel (slate.add_detail), so the normal pass below bakes the detail and
    # the rounded facet edges into one map. The detail map itself is a step
    # and never reaches the glTF; a cached rock needs none of it.
    from formations import slate
    detailed = [ob for ob in targets
                if any(is_slate(m) for m in ob.data.materials) and render_setting(ob, "export_chips")]
    to_detail = [ob for ob in detailed if ob not in loaded]
    if to_detail:
        nodes = bake_detail_normals(to_detail, images(to_detail, "detail normal", "Non-Color"), straight)
        for mat, node in nodes.items():
            slate.add_detail(mat, node.outputs["Color"], BAKE_UV)
    if bumped:
        nodes = bake_or_load(bumped, "baked normal",
                             lambda obs, ims: bake_pass(obs, ims, "NORMAL", normal_space="TANGENT"))
        for mat, node in nodes.items():
            for bsdf in procedural_normals(mat):
                wire_normal(mat, node, bsdf)
    if cache:
        for ob, made in fresh.items():
            # Still straight: bent below, and on every load.
            rock_bows = [[list(a), list(b), list(bow), reach] for a, b, bow, reach in bows.get(ob, ())]
            cache.put(keys[ob], made, ob.data, ob.name, {"bows": rock_bows})
        pruned = cache.prune()
    if bows:
        from formations import curve
    for ob, rock_bows in bows.items():
        # Bent only now that every map is baked (formations/curve.py).
        log(f"curve {ob.name}: {curve.bend(ob.data, rock_bows)}")
    texels = ", ".join(f"{ob.name} {sizes[ob]}" for ob in targets if ob in sizes)
    cached = (f"{len(loaded)} of {len(targets)} objects from the cache"
              + (f", {len(stale)} with stale occlusion" if stale else "") + f" ({pruned} unused entries removed)"
              if cache else "cache off")
    # scene-export.ts reads the "ships" counts: the optimiser must encode that
    # many baked maps.
    log(f"ships {len(colored)} colour and {len(bumped)} normal maps; baked {sum(ob not in loaded for ob in colored)} "
        f"colour, {len(to_detail)} detail and {sum(ob not in loaded for ob in bumped)} normal ({texels or 'none'}) "
        f"on {device}; {cached}; {time.time() - t0:.1f}s")
    return len(targets)


def carries_channel(src):
    """Whether `src` is one channel of an image, as glTF packs roughness (G)
    and metallic (B) into one: a Separate Color fed by an Image Texture, or that
    times a constant (a Math Multiply with one input unlinked). It is the graph
    Blender's own glTF importer builds for a metallic-roughness texture and
    factor, and its exporter writes it back as exactly that."""
    if src.type == "MATH" and src.operation == "MULTIPLY":
        linked = [s for s in src.inputs[:2] if s.is_linked]
        if len(linked) != 1:
            return False
        src = linked[0].links[0].from_node
    if src.type != "SEPARATE_COLOR" or not src.inputs["Color"].is_linked:
        return False
    image = src.inputs["Color"].links[0].from_node
    return image.type == "TEX_IMAGE" and image.image is not None


def material_warnings(ob):
    """What glTF cannot carry of this object's materials, one line each."""
    out = []
    data = getattr(ob, "data", None)
    slots = getattr(data, "materials", None) or []
    for mat in slots:
        if mat is None:
            continue
        # Blender 5 materials always have a node tree (`use_nodes` is
        # deprecated); one without is a legacy flat colour glTF carries as is.
        if mat.node_tree is None:
            continue
        principled = [n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"]
        if not principled:
            kinds = sorted({n.type for n in mat.node_tree.nodes if n.type.startswith("BSDF") or n.type == "EMISSION"})
            out.append(f'{ob.name}: material "{mat.name}" has no Principled BSDF ({", ".join(kinds) or "no shader"}); glTF exports a default surface')
            continue
        for node in principled:
            for socket_name in ("Base Color", "Roughness", "Metallic", "Normal", "Emission Color"):
                sock = node.inputs.get(socket_name)
                if sock is None or not sock.is_linked:
                    continue
                src = sock.links[0].from_node
                # A normal map node fed by an image is the one indirection glTF
                # understands; anything else in front of the socket is baked to
                # nothing.
                if src.type == "NORMAL_MAP" and src.inputs["Color"].is_linked:
                    src = src.inputs["Color"].links[0].from_node
                if socket_name == "Base Color" and (carries_vertex_color(src) or carries_tint(src)):
                    continue
                if socket_name in ("Roughness", "Metallic") and carries_channel(src):
                    continue
                # A bump of strength 0 (the boulder generator's stone at its
                # default) changes nothing, so losing it loses nothing.
                if (src.type == "BUMP" and not src.inputs["Strength"].is_linked
                        and src.inputs["Strength"].default_value == 0):
                    continue
                if src.type != "TEX_IMAGE":
                    out.append(
                        f'{ob.name}: material "{mat.name}" wires {socket_name} to a {src.bl_label} node, '
                        f"which glTF cannot carry; bake it to an image or use an Image Texture"
                    )
                elif src.image is None:
                    out.append(f'{ob.name}: material "{mat.name}" has an Image Texture with no image on {socket_name}')
    return out


CREDITS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "image_credits.json")


def image_credits(obs, warnings):
    """The credits of every image the exported objects' materials use, from
    image_credits.json (by image name, Blender's `.001` suffix ignored). An
    image the table does not know is a warning: shipping it uncredited is how a
    licence obligation gets lost without a trace."""
    with open(CREDITS_FILE, encoding="utf-8") as f:
        table = json.load(f)
    images = set()
    for ob in obs:
        for mat in getattr(getattr(ob, "data", None), "materials", None) or []:
            if mat is None or mat.node_tree is None:
                continue
            for n in mat.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image is not None:
                    images.add(n.image)
    credits, unknown = {}, []
    for im in sorted(images, key=lambda i: i.name):
        # An image a tool drew for one object (the moss add-on prints one per
        # rock) carries the script that drew it: an original, no credit owed,
        # and no name the table could list in advance.
        if im.get("generated_by"):
            continue
        name = re.sub(r"\.\d{3}$", "", im.name)
        entry = table["images"].get(name) or table["images"].get(os.path.basename(bpy.path.abspath(im.filepath)))
        if entry is None:
            unknown.append(im.name)
        elif isinstance(entry, str):
            credits[entry] = {"name": entry, **table["sets"][entry]}
    # A MESH that is someone else's work carries its credit on the object: a
    # `credits` custom property naming sets of the table, comma-separated. An
    # image is found by name, a model's geometry has nothing to be found by.
    for ob in obs:
        for entry in filter(None, (s.strip() for s in str(ob.get("credits", "")).split(","))):
            if entry in table["sets"]:
                credits[entry] = {"name": entry, **table["sets"][entry]}
            else:
                warnings.append(f'{ob.name}: credit "{entry}" is not a set in tools/blender/image_credits.json')
    for name in unknown:
        warnings.append(f'image "{name}" has no credit: add it to tools/blender/image_credits.json (or `generated` with the script that made it)')
    return [credits[k] for k in sorted(credits)]


def stats(ob, depsgraph):
    """Triangle count and world bounds of the object as it will export
    (modifiers applied), in the game's frame."""
    ev = ob.evaluated_get(depsgraph)
    tris = 0
    try:
        me = ev.to_mesh()
        if me is not None:
            me.calc_loop_triangles()
            tris = len(me.loop_triangles)
    except RuntimeError:
        pass
    finally:
        try:
            ev.to_mesh_clear()
        except RuntimeError:
            pass
    corners = [ev.matrix_world @ Vector(c) for c in ev.bound_box]
    pts = [to_game(c) for c in corners]
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    return tris, {"min": [round(v, 4) for v in lo], "max": [round(v, 4) for v in hi]}


def grow_painted(scene, warnings):
    """Grow every ivy and moss object from its paint and settings (the ivy and
    moss add-ons, tools/blender/ivy and tools/blender/moss, imported from the
    repo since the export runs with --factory-startup). The paint is the source;
    the mesh saved in the .blend is only the last preview, and would be stale
    against a host edited or re-imported since. One whose host is gone is hidden
    from the export. The ivy goes first: its rebuild carries a file from before
    2026-10-02 (when the ivy add-on was called moss) to the ivy names, which the
    moss add-on must not mistake for its own."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import ivy
    import moss

    def drop(ob):
        # With everything parented to it: render visibility is not inherited
        # from a parent, and an ivy's shadow decal is its child. Hiding the
        # ivy alone shipped the river's five orphaned decals, the skins of
        # deleted boulders, as ghostly shading at the level's origin
        # (2026-10-04).
        for o in [ob, *ob.children_recursive]:
            o.hide_render = True

    ivy.register()
    for ob, result in ivy.rebuild_all(scene):
        if result is None:
            warnings.append(f"{ob.name}: {ob.ivy.status}; not exported (nor its shadow)")
            drop(ob)
            continue
        cards = f"{result.leaves} clumps" if result.detail == "CLUMPS" else f"{result.leaves} leaves"
        log(f"ivy {ob.name} on {ob.ivy.host}: {len(result.triangles)} triangles ({cards}, {result.vines} vines), {ob.ivy.build_ms:.0f} ms")
    moss.register()
    for ob, what in moss.prepare_export(scene):
        s = ob.moss
        if what is None:
            warnings.append(f"{ob.name}: {s.status}; not exported")
            drop(ob)
        elif what == "texture":
            # Its decal is Blender's preview: never shipped, and out of the
            # bake's rays (3 mm off the rock, it would shade the rock's own
            # occlusion and bevel). The dabs go into the rock's colour map.
            drop(ob)
            log(f"moss {ob.name} on {s.host}: texture only, painted into the rock's colour map")
        else:
            took = f"rebuilt in {s.build_ms:.0f} ms" if what == "rebuilt" else "kept: built from this paint, rock and code"
            log(f"moss {ob.name} on {s.host}: {s.triangles} triangles, {s.dabs} dabs, print {s.texture} px, {took}")


def formation_warnings(scene, warnings):
    """Formations (the Formations add-on, tools/blender/formations) whose rock
    or growth lags their source: an outline edited and not rebuilt ships the
    old rock, and growth planted before the rock was rebuilt or moved floats
    off it or sinks into it. Both are fixed in Blender, never here: a rebuild
    is the generator's to run, and a replant may undo the artist's touch-ups."""
    if not any("formation_recipe" in ob for ob in scene.objects):
        return
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import formations
    from formations import core, growth

    formations.register()
    for ob in core.formations(scene):
        if ob.hide_render:
            continue
        try:
            if core.pending(ob):
                warnings.append(f"{ob.name}: outline or parameters edited but not rebuilt (Formations > Rebuild Changed)")
        except ValueError as e:
            warnings.append(f"{ob.name}: {e}")
        if growth.stale(ob):
            warnings.append(f"{ob.name}: rock changed since its growth was planted (Formations > Scene > Replant growth: Stale)")


def repaint_slate():
    """Rebuild every painted slate material to the formations add-on's
    current shader before baking (never saved), as the ivy and moss are
    regrown: the add-on's graph is the source, and a file saved before the
    shader last changed would otherwise ship the old stone."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from formations import slate
    n = slate.repaint()
    if n:
        log(f"repainted {n} painted slate material{'s' if n != 1 else ''} to the add-on's shader")


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :]
    usage = "usage: scene_export.py -- out.glb meta.json [--cache DIR [--stale-occlusion]]"
    stale_occlusion = "--stale-occlusion" in argv
    if stale_occlusion:
        argv.remove("--stale-occlusion")
    if len(argv) not in (2, 4) or (len(argv) == 4 and argv[2] != "--cache") or (stale_occlusion and len(argv) != 4):
        raise SystemExit(usage)
    out_glb, out_meta = argv[0], argv[1]
    cache_dir = argv[3] if len(argv) == 4 else None
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    t0 = time.time()

    scene = bpy.context.scene
    view_layer = bpy.context.view_layer
    excluded = excluded_collections(view_layer)

    kept, skipped, warnings = [], [], []
    step("grow")
    grow_painted(scene, warnings)
    step("bake")
    import moss
    paints = moss.texture_paints(scene)
    formation_warnings(scene, warnings)
    repaint_slate()
    for ob in scene.objects:
        reason = skip_reason(ob, excluded)
        if reason:
            skipped.append({"name": ob.name, "reason": reason})
            continue
        kept.append(ob)

    # An empty scene is a legitimate export - the file a level is first wired
    # to, before anything is modelled - so it ships as an empty GLB with a
    # warning rather than as a failure the first run of the loop hits.
    if not kept:
        warnings.append("nothing to export: every object is a guide, linked, hidden in render or has no geometry")

    # Select exactly the kept objects. Selection needs the object visible in
    # the view layer, so viewport hiding is lifted for the export (the file is
    # not saved).
    for ob in scene.objects:
        try:
            ob.select_set(False)
        except RuntimeError:
            pass
    for ob in kept:
        ob.hide_viewport = False
        ob.hide_set(False)
        ob.select_set(True)
    view_layer.update()

    # Baking selects its own targets; the export selection is restored after.
    if bake_procedural_textures(kept, cache_dir, paints, warnings, stale_occlusion):
        for ob in scene.objects:
            try:
                ob.select_set(ob in kept)
            except RuntimeError:
                pass
        view_layer.update()
    step("gltf")
    for ob in kept:
        warnings.extend(material_warnings(ob))

    depsgraph = bpy.context.evaluated_depsgraph_get()
    nodes = []
    for ob in kept:
        tris, bounds = stats(ob, depsgraph)
        mats = [m.name for m in (getattr(ob.data, "materials", None) or []) if m is not None]
        nodes.append(
            {
                "name": ob.name,
                "node": node_name(ob.name),
                "triangles": tris,
                "position": [round(v, 4) for v in to_game(ob.matrix_world.translation)],
                "bounds": bounds,
                "materials": mats,
            }
        )

    kwargs = dict(
        filepath=out_glb,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_normals=True,
        export_texcoords=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_extras=False,
        # No Draco: the optimiser applies meshopt afterwards (scripts/optimize-asset.ts).
        export_draco_mesh_compression_enable=False,
    )
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kwargs = {k: v for k, v in kwargs.items() if k in props}
    bpy.ops.export_scene.gltf(**kwargs)

    meta = {
        "blender": bpy.app.version_string,
        "nodes": nodes,
        "credits": image_credits(kept, warnings),
        "skipped": skipped,
        "warnings": warnings,
    }
    with open(out_meta, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    tris = sum(n["triangles"] for n in nodes)
    log(f"wrote {out_glb} ({os.path.getsize(out_glb) / 1024:.0f} KB raw): {len(nodes)} objects, {tris} triangles, "
        f"{len(skipped)} skipped, {len(warnings)} warnings, {time.time() - t0:.1f}s")


main()
