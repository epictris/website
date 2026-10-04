"""Export a level's Blender scene as the game's dressing.

    blender -b assets-src/scenes/<scene>.blend --factory-startup --python-exit-code 1 \
        --python tools/blender/scene_export.py -- out.glb meta.json

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
# Texture resolution follows the surface: this many texels per metre of the
# unwrapped surface, rounded up to a power of two, between these bounds. The
# game frame shows 200 pixels a metre at the gameplay plane (BALL_ZOOM at
# 1080p), and the painted slate's edge line is a texel or two wide, so a map
# under that density draws it magnified and blurred (the Terrace at 1024 got
# 136 texels a metre). Doubled on 2026-10-03 (Tris: "about double the
# resolution"), so the edge line and the chips stay crisp up close. The top is
# the optimiser's cap for baked maps (`--baked-maps`,
# scripts/encode-textures.mjs).
TEXELS_PER_METRE = 512
BAKE_SIZE_MIN, BAKE_SIZE_MAX = 64, 4096
# The share of the image an unwrap's islands cover after packing.
UV_COVERAGE = 0.6
# Pixels between islands in the pack. Every texel outside the islands is
# filled afterwards (`fill_background`), so this gap is only what keeps two
# islands from sharing a texel at full resolution.
PACK_GAP_PX = 2
# How far apart two vertices may be and still be one for the unwrap.
WELD_DISTANCE = 1e-5
# Faces smaller than this (square metres) get one UV for all their corners.
DEGENERATE_AREA = 1e-8
# The corner attribute that carries each corner's index through the weld.
UNWRAP_TAG = "scene_bake_corner"


def bake_size(mesh):
    area = sum(p.area for p in mesh.polygons)
    side = math.sqrt(area / UV_COVERAGE) * TEXELS_PER_METRE
    return int(min(BAKE_SIZE_MAX, max(BAKE_SIZE_MIN, 2 ** math.ceil(math.log2(max(side, 1))))))


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


def bake_pass(targets, images, bake_type, **bake_args):
    """One Cycles bake of every target into its own image: each material
    gets an Image Texture of its object's image as the ACTIVE node, which is
    where a bake writes. Returns the nodes, keyed by material."""
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
    select_only(targets, targets[0])
    bpy.ops.object.bake(type=bake_type, target="IMAGE_TEXTURES", uv_layer=BAKE_UV, margin=0, **bake_args)
    for im in set(images.values()):
        fill_background(im)
        im.pack()
    return nodes


def bake_procedural_textures(kept):
    """Bake every procedural Base Color (and Normal) the kept meshes use into
    an image of the object's own, and wire it in, so glTF carries the stone as
    a baseColorTexture (and normalTexture) instead of dropping it to a flat
    default.

    Only the colour is baked - Cycles' diffuse COLOR pass, no light - so the
    game still lights the surface; a procedural normal (a bump) goes as a
    tangent-space normal map. It works on the export's own copies: each target
    gets a mesh with its modifiers applied and a fresh unwrap (BAKE_UV), its
    materials are copied so each object's point at its own images, and the file
    is never saved. The resolution is TEXELS_PER_METRE up to
    BAKE_SIZE_MAX. Returns how many objects were baked."""
    targets = [ob for ob in kept if ob.type == "MESH"
               and any(procedural_base_colors(m) or procedural_normals(m) for m in ob.data.materials)]
    if not targets:
        return 0
    t0 = time.time()
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()
    sizes, straight, bows = {}, {}, {}
    for ob in targets:
        mesh = bpy.data.meshes.new_from_object(ob.evaluated_get(depsgraph), preserve_all_data_layers=True,
                                               depsgraph=depsgraph)
        ob.modifiers.clear()
        ob.data = mesh
        if any(is_slate(m) for m in mesh.materials):
            # Long straight creases (formations/curve.py): split now, before
            # the unwrap; every map is baked on the straight rock, which the
            # detail high poly matches exactly, and the rock is bent after.
            from formations import curve, slate
            log(f"strips {ob.name}: {slate.mark_strips(mesh)} chamfer strips painted as edge line")
            bows[ob] = curve.find_bows(mesh, seed_for(ob))
            log(f"curve {ob.name}: {curve.rebuild_mesh(mesh, bows[ob], seed_for(ob), smooth=True)}")
            straight[ob] = mesh.copy()
        for i, mat in enumerate(mesh.materials):
            if mat is not None:
                mesh.materials[i] = mat.copy()
        if any(m is None for m in mesh.materials) or not mesh.materials:
            # A bake needs a material to write through on every face.
            raise SystemExit(f"{ob.name}: a procedural material shares the object with an empty material slot")
        sizes[ob] = bake_size(mesh)
        unwrap(ob, sizes[ob])
    scene.render.engine = "CYCLES"
    device = bake_device()
    scene.cycles.device = "CPU" if device == "CPU" else "GPU"
    scene.cycles.samples = BAKE_SAMPLES

    def images(obs, kind, colorspace):
        out = {}
        for ob in obs:
            # With alpha, cleared to 0: the bake writes 1 where it baked, which
            # is the mask `fill_background` fills the rest by.
            im = bpy.data.images.new(f"{ob.name} {kind}", sizes[ob], sizes[ob], alpha=True)
            im.generated_color = (0, 0, 0, 0)
            im.colorspace_settings.name = colorspace
            # Drawn by this export for this object: an original, no credit owed.
            im["generated_by"] = "tools/blender/scene_export.py"
            out[ob] = im
        return out

    colored = [ob for ob in targets if any(procedural_base_colors(m) for m in ob.data.materials)]
    if colored:
        nodes = bake_pass(colored, images(colored, "baked colour", "sRGB"), "DIFFUSE", pass_filter={"COLOR"})
        for mat, node in nodes.items():
            for bsdf in procedural_base_colors(mat):
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
    # and never reaches the glTF.
    from formations import slate
    detailed = [ob for ob in targets if any(is_slate(m) for m in ob.data.materials)]
    if detailed:
        nodes = bake_detail_normals(detailed, images(detailed, "detail normal", "Non-Color"), straight)
        for mat, node in nodes.items():
            slate.add_detail(mat, node.outputs["Color"], BAKE_UV)
    bumped = [ob for ob in targets if any(procedural_normals(m) for m in ob.data.materials)]
    if bumped:
        nodes = bake_pass(bumped, images(bumped, "baked normal", "Non-Color"), "NORMAL", normal_space="TANGENT")
        for mat, node in nodes.items():
            for bsdf in procedural_normals(mat):
                wire_normal(mat, node, bsdf)
    for ob, rock_bows in bows.items():
        # Bent only now that every map is baked (formations/curve.py).
        log(f"curve {ob.name}: {curve.bend(ob.data, rock_bows)}")
    texels = ", ".join(f"{ob.name} {sizes[ob]}" for ob in targets)
    log(f"baked {len(colored)} colour, {len(detailed)} detail and {len(bumped)} normal maps ({texels}) on {device}, {time.time() - t0:.1f}s")
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

    ivy.register()
    for ob, result in ivy.rebuild_all(scene):
        if result is None:
            warnings.append(f"{ob.name}: {ob.ivy.status}; not exported")
            ob.hide_render = True
            continue
        log(f"ivy {ob.name} on {ob.ivy.host}: {len(result.triangles)} triangles ({result.leaves} leaves, {result.vines} vines), {ob.ivy.build_ms:.0f} ms")
    moss.register()
    for ob, result in moss.rebuild_all(scene):
        if result is None:
            warnings.append(f"{ob.name}: {ob.moss.status}; not exported")
            ob.hide_render = True
            continue
        log(f"moss {ob.name} on {ob.moss.host}: {len(result.triangles)} triangles, {result.dabs} dabs, print {result.image.shape[0]} px, {ob.moss.build_ms:.0f} ms")


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
                warnings.append(f"{ob.name}: outline edited but not rebuilt (Formations > Rebuild Changed)")
        except ValueError as e:
            warnings.append(f"{ob.name}: {e}")
        if growth.stale(ob):
            warnings.append(f"{ob.name}: rock changed since its growth was planted (Formations > Growth > Stale)")


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
    if len(argv) < 2:
        raise SystemExit("usage: scene_export.py -- out.glb meta.json")
    out_glb, out_meta = argv[0], argv[1]
    t0 = time.time()

    scene = bpy.context.scene
    view_layer = bpy.context.view_layer
    excluded = excluded_collections(view_layer)

    kept, skipped, warnings = [], [], []
    grow_painted(scene, warnings)
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
    if bake_procedural_textures(kept):
        for ob in scene.objects:
            try:
                ob.select_set(ob in kept)
            except RuntimeError:
                pass
        view_layer.update()
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
