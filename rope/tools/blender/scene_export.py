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
from mathutils.bvhtree import BVHTree

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


def bake_maps(mesh, ob, seen):
    """The sides of `ob`'s colour maps, baked on `mesh`, whose faces the
    camera can see where `seen` holds (formations/render.py)."""
    from formations import render
    area = np.empty(len(mesh.polygons))
    mesh.polygons.foreach_get("area", area)
    return render.colour_maps(ob, float(area[seen].sum() + render.HIDDEN_DENSITY ** 2 * area[~seen].sum()))


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


# The game camera, as `seen_faces` tests a face against it: always head-on
# (looking along Blender +y), a 70 mm lens on a 24 mm tall frame of 16:9
# (src/render3d/space.ts: every level's `camera.focalLength`, Tris
# 2026-10-16), over a grid of VIEW_GRID x VIEW_GRID directions spanning the
# frame and VIEW_MARGIN past its edges. A face is seen if a ray from it to the
# camera along one of them leaves the object without hitting it again. Its own
# surface is all that occludes: another object's moving would otherwise
# change which faces are seen without changing this one's bake key, and a
# face counted seen is only finer.
FOCAL_LENGTH_MM, FRAME_HALF_HEIGHT_MM, FRAME_ASPECT = 70.0, 12.0, 16 / 9
VIEW_GRID, VIEW_MARGIN = 5, 1.1
# How far a face's samples (its centre, and its corners pulled this share of
# the way out from it) and their rays start off it, metres.
SAMPLE_REACH, RAY_LIFT = 0.8, 1e-4
# Vertices this close are one, for growing the seen faces by a ring.
SEEN_WELD = 1e-5
# The longest an island may run, as a share of its map's side (`cut_islands`).
# At a quarter, the cuts cost Terrace.003 more coverage (0.62 -> 0.56) than
# they won; at a half, 0.63.
ISLAND_SHARE = 0.5


def view_directions():
    """The directions `seen_faces` looks from the surface toward the camera
    (world space, unit)."""
    tan_y = FRAME_HALF_HEIGHT_MM / FOCAL_LENGTH_MM * VIEW_MARGIN
    tan_x = tan_y * FRAME_ASPECT
    steps = np.linspace(-1.0, 1.0, VIEW_GRID)
    d = np.array([(-x * tan_x, -1.0, -z * tan_y) for x in steps for z in steps])
    return d / np.linalg.norm(d, axis=1)[:, None]


def seen_faces(mesh, matrix):
    """Which faces of `mesh` (at `matrix` in the world) the game camera can
    see, as a bool per polygon: facing one of `view_directions` with one of
    its samples' rays out of the object, and then every face touching one of
    those by a vertex, so a partly seen face's neighbour that a sample missed,
    and the seam between the seen and the unseen, are seen too.

    Measured 2026-10-16 on the river (Terrace.001, 250 k triangles, 3 s):
    of its 470 m2 of pile, 231 face the camera with nothing of the rock in
    the way."""
    n = len(mesh.polygons)
    m = np.array(matrix, dtype=np.float64)
    co = np.empty(len(mesh.vertices) * 3)
    mesh.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
    start = np.empty(n, np.int32)
    total = np.empty(n, np.int32)
    mesh.polygons.foreach_get("loop_start", start)
    mesh.polygons.foreach_get("loop_total", total)
    corner = np.empty(len(mesh.loops), np.int32)
    mesh.loops.foreach_get("vertex_index", corner)
    tris = [corner[a:a + b].tolist() for a, b in zip(start.tolist(), total.tolist())]
    bvh = BVHTree.FromPolygons(co.tolist(), tris)
    centre = np.add.reduceat(co[corner], start) / total[:, None]
    normal = np.empty(n * 3)
    mesh.polygons.foreach_get("normal", normal)
    # A normal goes to the world by the inverse transpose.
    normal = normal.reshape(-1, 3) @ np.linalg.inv(m[:3, :3])
    normal /= np.maximum(np.linalg.norm(normal, axis=1), 1e-30)[:, None]
    toward = view_directions()
    facing = normal @ toward.T > 1e-3
    seen = np.zeros(n, bool)
    ray = bvh.ray_cast
    dirs = [tuple(d) for d in toward.tolist()]
    for f in np.flatnonzero(facing.any(axis=1)).tolist():
        lift = normal[f] * RAY_LIFT
        c = centre[f]
        ways = [dirs[j] for j in np.flatnonzero(facing[f]).tolist()]
        samples = [c] + [c + SAMPLE_REACH * (co[v] - c) for v in tris[f]]
        if any(ray(tuple(p + lift), d)[0] is None for p in samples for d in ways):
            seen[f] = True
    # One ring more, by welded position: a mesh split at its seams (flat
    # shaded, or come in through glTF) has no shared vertices to walk.
    weld = np.unique(np.round(co / SEEN_WELD).astype(np.int64), axis=0, return_inverse=True)[1].ravel()
    hot = np.zeros(weld.max() + 1 if len(weld) else 0, bool)
    hot[weld[corner[np.repeat(seen, total)]]] = True
    return np.logical_or.reduceat(hot[weld[corner]], start) if n else seen


def unwrap(ob, seen, sides, gap_sides):
    """A fresh UV map BAKE_UV on `ob`, its surface over one image a side in
    `sides`, islands packed PACK_GAP_PX apart at that image's `gap_sides`.
    Returns the image each face is in, an array over the polygons.

    The faces `seen` (`seen_faces`) and the rest are unwrapped apart, so no
    island holds both, and every island is scaled to its surface, the
    unseen ones by HIDDEN_DENSITY: one image's texels go to what the camera
    sees. With more than one image the islands are dealt out in order along
    the object's longest side, each image taking its share of the surface
    by its side squared, so each image's faces lie together (three.js culls
    each by its own box) and no island is cut.

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
    from formations import render
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
    n = len(welded.loops)
    origin = np.empty(n, dtype=np.int32)
    welded.attributes[UNWRAP_TAG].data.foreach_get("value", origin)
    w_start = np.empty(len(welded.polygons), dtype=np.int32)
    w_total = np.empty(len(welded.polygons), dtype=np.int32)
    welded.polygons.foreach_get("loop_start", w_start)
    welded.polygons.foreach_get("loop_total", w_total)
    o_start = np.empty(len(ob.data.polygons), dtype=np.int32)
    ob.data.polygons.foreach_get("loop_start", o_start)
    # Each welded face is the face its first corner came from.
    w_seen = seen[np.searchsorted(o_start, origin[w_start], side="right") - 1]
    w_area = np.empty(len(welded.polygons))
    welded.polygons.foreach_get("area", w_area)

    tool = bpy.context.scene.tool_settings
    sync, select_mode = tool.use_uv_select_sync, tuple(tool.mesh_select_mode)
    tool.use_uv_select_sync = True
    tool.mesh_select_mode = (False, False, True)
    corner_face = np.repeat(np.arange(len(welded.polygons)), w_total)
    select_only([tmp], tmp)

    w_vert = np.empty(n, dtype=np.int32)
    welded.loops.foreach_get("vertex_index", w_vert)
    w_edge = np.empty(n, dtype=np.int32)
    welded.loops.foreach_get("edge_index", w_edge)

    def select(faces):
        # Faces, their edges and their vertices, in face select mode, so
        # entering edit mode flushes nothing away.
        bpy.ops.object.mode_set(mode="OBJECT")
        mine = faces[corner_face]
        verts = np.zeros(len(welded.vertices), bool)
        verts[w_vert[mine]] = True
        edges = np.zeros(len(welded.edges), bool)
        edges[w_edge[mine]] = True
        welded.vertices.foreach_set("select", verts)
        welded.edges.foreach_set("select", edges)
        welded.polygons.foreach_set("select", faces)
        bpy.ops.object.mode_set(mode="EDIT")

    def uvs():
        bpy.ops.object.mode_set(mode="OBJECT")
        out = np.empty(2 * n, dtype=np.float64)
        welded.uv_layers.active.data.foreach_get("uv", out)
        return out.reshape(-1, 2)

    def put(uv):
        bpy.ops.object.mode_set(mode="OBJECT")
        welded.uv_layers.active.data.foreach_set("uv", uv.astype(np.float32).ravel())

    if not welded.uv_layers:
        welded.uv_layers.new(name=BAKE_UV)
    uv = np.zeros((n, 2))
    for faces, density in ((w_seen, 1.0), (~w_seen, render.HIDDEN_DENSITY)):
        if not faces.any():
            continue
        select(faces)
        # The packing below sets the margins.
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0, scale_to_bounds=False)
        part = uvs()
        mine = faces[corner_face]
        # Metres of the surface, times its density.
        scale = density * math.sqrt(w_area[faces].sum() / max(face_uv_area(part, w_start, w_total)[faces].sum(), 1e-30))
        uv[mine] = part[mine] * scale
    # No island longer than ISLAND_SHARE of the largest map's side, which
    # holds its share of the surface (side squared over all the sides'), at
    # UV_COVERAGE.
    largest = max(sides) ** 2 / sum(side * side for side in sides)
    longest = math.sqrt(face_uv_area(uv, w_start, w_total).sum() * largest / render.UV_COVERAGE) * ISLAND_SHARE
    uv, cut = cut_islands(uv, uv_islands(w_vert, uv, w_start, w_total, corner_face), w_start, w_total,
                          corner_face, longest)
    put(uv)
    if cut:
        log(f"unwrap {ob.name}: {cut} islands over {longest:.2f} m cut")
    if len(sides) == 1:
        image = np.zeros(len(welded.polygons), dtype=np.int32)
    else:
        image = deal_islands(welded, uv, uv_islands(w_vert, uv, w_start, w_total, corner_face),
                             w_start, w_total, corner_face, sides)
    for k, (side, gap) in enumerate(zip(sides, gap_sides)):
        faces = image == k
        if not faces.any():
            continue
        # Into the unit square first: the packer packs into the UDIM tile
        # nearest the islands.
        uv = uvs()
        mine = faces[corner_face]
        lo = uv[mine].min(axis=0)
        uv[mine] = (uv[mine] - lo) / max(float((uv[mine] - lo).max()), 1e-30) * 0.999
        put(uv)
        select(faces)
        # Turning islands by right angles took the coverage from 0.47 to
        # 0.59 on Terrace.001's five maps (385 -> 430 texels a metre seen;
        # without, it would take a sixth map) for 85 s of packing against
        # 39 s; on Terrace.003, 0.63 -> 0.69 for 10 s against 7. Any angle
        # packed no better than right angles, slower.
        bpy.ops.uv.pack_islands(udim_source="CLOSEST_UDIM", rotate=True, rotate_method="CARDINAL", scale=True,
                                margin_method="FRACTION", margin=PACK_GAP_PX / gap, shape_method="CONCAVE")
        uv = uvs()
        lo = np.floor(uv[mine].min(axis=0) + 1e-6)
        if lo.any():
            uv[mine] -= lo
            put(uv)
    bpy.ops.object.mode_set(mode="OBJECT")
    tool.use_uv_select_sync, tool.mesh_select_mode = sync, select_mode
    uv_welded = uvs().astype(np.float32).ravel()
    corner_vert = np.empty(n, dtype=np.int32)
    welded.loops.foreach_get("vertex_index", corner_vert)
    co = np.empty(3 * len(welded.vertices), dtype=np.float32)
    welded.vertices.foreach_get("co", co)
    corner_co = co.reshape(-1, 3)[corner_vert]
    corner_image = image[corner_face]
    bpy.data.objects.remove(tmp)
    bpy.data.meshes.remove(welded)

    uvs_out = np.full((len(ob.data.loops), 2), np.nan, dtype=np.float32)
    uvs_out[origin] = uv_welded.reshape(-1, 2)
    loop_image = np.full(len(ob.data.loops), -1, dtype=np.int32)
    loop_image[origin] = corner_image
    lost = np.flatnonzero(np.isnan(uvs_out[:, 0]))
    if len(lost):
        tree = kdtree.KDTree(n)
        for j, c in enumerate(corner_co):
            tree.insert(c, j)
        tree.balance()
        verts = np.empty(len(ob.data.loops), dtype=np.int32)
        ob.data.loops.foreach_get("vertex_index", verts)
        for j in lost:
            near = tree.find(ob.data.vertices[verts[j]].co)[1]
            uvs_out[j] = uv_welded[2 * near:][:2]
            loop_image[j] = corner_image[near]
    # A face with no area (the dissolve's collinear slivers) can have its
    # corners land on different islands, a streak across the atlas. Flat it
    # draws nothing; bent open after the bake (formations/curve.py) it drew
    # that streak as a pale stair-stepped band. Collapse it onto one corner
    # that came through the weld, so it takes the colour of where it sits.
    # So too a face whose corners came back in different images (the weld
    # collapsed it, and its corners took their nearest neighbours').
    start = np.empty(len(ob.data.polygons), dtype=np.int32)
    total = np.empty(len(ob.data.polygons), dtype=np.int32)
    ob.data.polygons.foreach_get("loop_start", start)
    ob.data.polygons.foreach_get("loop_total", total)
    area = np.empty(len(ob.data.polygons))
    ob.data.polygons.foreach_get("area", area)
    found = np.ones(len(uvs_out), bool)
    found[lost] = False
    split = np.maximum.reduceat(loop_image, start) != np.minimum.reduceat(loop_image, start)
    for f in np.flatnonzero((area < DEGENERATE_AREA) | split):
        corners = range(start[f], start[f] + total[f])
        keep = next((c for c in corners if found[c]), start[f])
        uvs_out[list(corners)] = uvs_out[keep]
        loop_image[list(corners)] = loop_image[keep]
    uv_map = ob.data.uv_layers.new(name=BAKE_UV)
    uv_map.data.foreach_set("uv", uvs_out.ravel())
    return loop_image[start]


def uv_islands(corner_vert, uv, start, total, corner_face):
    """Each face's island: the faces joined by edges whose two corners
    share UVs on both sides (`uv`, a corner's). Numbered from 0."""
    nf = len(start)
    nxt = np.arange(len(corner_face)) + 1
    nxt[start + total - 1] = start
    a, b = corner_vert, corner_vert[nxt]
    q = np.round(uv / 1e-6).astype(np.int64)
    flip = a > b
    lo_v, hi_v = np.where(flip, b, a), np.where(flip, a, b)
    lo_uv, hi_uv = np.where(flip[:, None], q[nxt], q), np.where(flip[:, None], q, q[nxt])
    _, edge = np.unique(np.column_stack([lo_v, hi_v, lo_uv, hi_uv]), axis=0, return_inverse=True)
    edge = edge.ravel()
    order = np.argsort(edge, kind="stable")
    parent = list(range(nf))

    def root(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i in np.flatnonzero(edge[order][1:] == edge[order][:-1]).tolist():
        f, g = root(int(corner_face[order[i]])), root(int(corner_face[order[i + 1]]))
        if f != g:
            parent[f] = g
    return np.unique([root(f) for f in range(nf)], return_inverse=True)[1].ravel()


def face_uv_area(uv, start, total):
    """Each face's area in UV, by the shoelace over its corners."""
    nxt = np.arange(len(uv)) + 1
    nxt[start + total - 1] = start
    return np.abs(np.add.reduceat(uv[:, 0] * uv[nxt, 1] - uv[nxt, 0] * uv[:, 1], start) / 2)


def cut_islands(uv, island, start, total, corner_face, longest):
    """`uv` with every island longer than `longest` either way cut into
    squares that long, each moved a hair off its neighbours so it packs as
    an island of its own. Smart UV Project keeps a run of near-coplanar
    faces whole however far it runs: on Terrace.001 one ran the width of a
    map, and the packer, shrinking every island until it fit, filled 9 %
    of it."""
    uv = uv.copy()
    centre = np.add.reduceat(uv, start) / total[:, None]
    lo = np.full((island.max() + 1, 2), np.inf)
    hi = np.full((island.max() + 1, 2), -np.inf)
    np.minimum.at(lo, island[corner_face], uv)
    np.maximum.at(hi, island[corner_face], uv)
    long = ((hi - lo) > longest).any(axis=1)
    faces = long[island]
    if not faces.any():
        return uv, 0
    cell = np.floor((centre - lo[island]) / longest)
    shift = np.where(faces[:, None], cell * 1e-3, 0.0)
    uv += shift[corner_face]
    return uv, int(long.sum())


def deal_islands(mesh, uv, island, start, total, corner_face, sides):
    """The image each face of `mesh` goes in, for `uv` (a corner's UV, in
    metres times its density): its `island`'s, the islands dealt out along
    the mesh's longest side so each image's share of their area is its side
    squared over all the sides'."""
    corner_vert = np.empty(len(corner_face), dtype=np.int32)
    mesh.loops.foreach_get("vertex_index", corner_vert)
    co = np.empty(3 * len(mesh.vertices))
    mesh.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    axis = int(np.argmax(co.max(axis=0) - co.min(axis=0)))
    face_pos = np.add.reduceat(co[corner_vert, axis], start) / total
    face_area = face_uv_area(uv, start, total)
    count = island.max() + 1
    weight = np.bincount(island, face_area, count)
    pos = np.bincount(island, face_area * face_pos, count) / np.maximum(weight, 1e-30)
    share = np.cumsum(np.array(sides, dtype=np.float64) ** 2)
    share = share / share[-1] * weight.sum()
    out = np.zeros(count, dtype=np.int32)
    held, k = 0.0, 0
    for i in np.argsort(pos, kind="stable").tolist():
        # An island goes where its middle falls.
        while k < len(sides) - 1 and held + weight[i] / 2 > share[k]:
            k += 1
        out[i] = k
        held += weight[i]
    return out[island]


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
    detail.RAY_DISTANCE. `images` holds each rock's images, one a map."""
    from formations import detail
    scene = bpy.context.scene
    nodes = image_nodes(targets, images)
    for ob in targets:
        high, report = detail.build(straight.get(ob, ob.data), seed_for(ob), scene.collection, f"{ob.name} detail")
        high.matrix_world = ob.matrix_world.copy()
        select_only([high, ob], ob)
        t0 = time.time()
        bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", use_selected_to_active=True,
                            cage_extrusion=detail.CAGE, max_ray_distance=detail.RAY_DISTANCE,
                            target="IMAGE_TEXTURES", uv_layer=BAKE_UV, margin=0)
        log(f"detail {ob.name}: {report}; baked in {time.time() - t0:.1f}s")
        me = high.data
        bpy.data.objects.remove(high)
        bpy.data.meshes.remove(me)
        for im in images[ob]:
            fill_background(im)
            im.pack()
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


def image_name(ob, kind, i=0, count=1):
    """The name of `ob`'s `kind` map ("baked colour", ...), the `i`th of its
    `count`. No dot in it: the glTF exporter takes everything after the last
    dot for an extension, so "Terrace.003 baked colour" shipped as "Terrace",
    missed the optimiser's " baked colour" rule and went out as lossy WebP at
    1k, a quarter of its texels (2026-10-04; scene-export.ts now checks every
    baked map is matched)."""
    base = ob.name.replace('.', '-')
    return f"{base} {kind}" if count == 1 else f"{base} map {i + 1} {kind}"


def image_names(ob, kinds, count):
    return [image_name(ob, k, i, count) for k in kinds for i in range(count)]


def map_of(ob, slot, count):
    """Which of `ob`'s `count` maps its material `slot` draws from: the
    export gives each map its own copy of every material (`split_materials`),
    map by map."""
    return slot // (len(ob.data.materials) // count)


def split_materials(materials, count):
    """`materials` (one an object's slot) for an object over `count` maps:
    the first map's are these, every other map's copies of them, slot for
    slot, so each map's faces point at their own images."""
    return [m if i == 0 else m.copy() for i in range(count) for m in materials]


def image_nodes(targets, images):
    """An Image Texture of its map's image (`images`: each object's, one a
    map) in each of the targets' materials, read through BAKE_UV and ACTIVE
    (where a bake writes). Returns the nodes, keyed by material."""
    nodes = {}
    for ob in targets:
        for slot, mat in enumerate(ob.data.materials):
            node = mat.node_tree.nodes.new("ShaderNodeTexImage")
            node.image = images[ob][map_of(ob, slot, len(images[ob]))]
            uv = mat.node_tree.nodes.new("ShaderNodeUVMap")
            uv.uv_map = BAKE_UV
            mat.node_tree.links.new(uv.outputs["UV"], node.inputs["Vector"])
            mat.node_tree.nodes.active = node
            nodes[mat] = node
    return nodes


def bake_pass(targets, images, bake_type, before_fill=None, **bake_args):
    """One Cycles bake of every target into its own images: each material
    gets an Image Texture of its map's image as the ACTIVE node, which is
    where a bake writes. `before_fill(ob, i, image)` runs on each object's
    `i`th image while its alpha still marks the baked texels. Returns the
    nodes, keyed by material."""
    nodes = image_nodes(targets, images)
    select_only(targets, targets[0])
    bpy.ops.object.bake(type=bake_type, target="IMAGE_TEXTURES", uv_layer=BAKE_UV, margin=0, **bake_args)
    if before_fill is not None:
        for ob in targets:
            for i, im in enumerate(images[ob]):
                before_fill(ob, i, im)
    for ob in targets:
        for im in images[ob]:
            fill_background(im)
            im.pack()
    return nodes


def paint_moss(ob, im, paints, i=0, count=1):
    """Paint the texture-only mosses of `ob` (moss.texture_paints entries)
    into its freshly baked colour map `im`, the `i`th of its `count`, before
    the background fill, so the fill carries the moss into the seams like
    any baked texel. Only that map's triangles are painted."""
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
    if count > 1:
        slot = np.empty(n, np.int32)
        me.loop_triangles.foreach_get("material_index", slot)
        mine = np.repeat(slot // (len(me.materials) // count) == i, 3)
        loops, verts = loops[mine], verts[mine]
        n = len(loops) // 3
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
    is never saved. The resolution is formations/render.py's (`map_sides`:
    TEXELS_PER_METRE up to BAKE_SIZE_MAX, a painted slate rock that outgrows
    that split over several maps, each with its own copies of the materials;
    the faces the camera never sees, `seen_faces`, at HIDDEN_DENSITY). With
    `cache_dir`, an object whose
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
            hit = cache.get(keys[ob], lambda data, ob=ob: image_names(ob, ships[ob], len(data.get("maps", [0]))))
            if hit is not None:
                hits[ob] = hit
                if hit[3] != keys[ob]:
                    stale.append(ob)
        if stale and warnings is not None:
            warnings.append(f"--stale-occlusion: {len(stale)} objects keep the occlusion of their last bake, their "
                            f"neighbours since changed: {', '.join(sorted(ob.name for ob in stale))}")
        for ob, (files, mesh_file, data, _) in hits.items():
            sizes[ob] = data["maps"]
            count = len(sizes[ob])
            loaded[ob] = {k: [bake_cache.load(files[image_name(ob, k, i, count)], image_name(ob, k, i, count), space[k])
                              for i in range(count)] for k in ships[ob]}
            materials[ob] = split_materials(materials[ob], count)
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
        seen = seen_faces(mesh, ob.matrix_world)
        sizes[ob] = bake_maps(mesh, ob, seen)
        bumps = any(procedural_normals(m) for m in mesh.materials)
        in_map = unwrap(ob, seen, sizes[ob], [map_size(side, "baked normal") if bumps else side for side in sizes[ob]])
        if len(sizes[ob]) > 1:
            # Each map's faces on their own copies of the materials.
            slots = len(materials[ob])
            materials[ob] = split_materials(materials[ob], len(sizes[ob]))
            for mat in materials[ob][slots:]:
                mesh.materials.append(mat)
            slot = np.empty(len(mesh.polygons), np.int32)
            mesh.polygons.foreach_get("material_index", slot)
            mesh.polygons.foreach_set("material_index", (slot + in_map * slots).astype(np.int32))
        area = np.empty(len(mesh.polygons))
        mesh.polygons.foreach_get("area", area)
        log(f"unwrap {ob.name}: {area[seen].sum():.1f} of {area.sum():.1f} m2 seen, "
            f"maps {' + '.join(str(side) for side in sizes[ob])}")

    def images(obs, kind, colorspace):
        """Each of `obs`' `kind` images, one a map."""
        out = {}
        for ob in obs:
            out[ob] = []
            for i, size in enumerate(sizes[ob]):
                # With alpha, cleared to 0: the bake writes 1 where it baked,
                # which is the mask `fill_background` fills the rest by.
                side = map_size(size, kind)
                im = bpy.data.images.new(image_name(ob, kind, i, len(sizes[ob])), side, side, alpha=True)
                im.generated_color = (0, 0, 0, 0)
                im.colorspace_settings.name = colorspace
                # Drawn by this export for this object: an original, no credit owed.
                im["generated_by"] = "tools/blender/scene_export.py"
                out[ob].append(im)
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
                fresh.setdefault(ob, []).extend(made[ob])
        done = [ob for ob in obs if ob in loaded]
        nodes.update(image_nodes(done, {ob: loaded[ob][kind] for ob in done}))
        return nodes

    if colored:
        def moss_into(ob, i, im):
            if ob in by_host:
                paint_moss(ob, im, by_host[ob], i, len(sizes[ob]))

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
            cache.put(keys[ob], made, ob.data, ob.name, {"bows": rock_bows, "maps": sizes[ob]})
        pruned = cache.prune()
    if bows:
        from formations import curve
    for ob, rock_bows in bows.items():
        # Bent only now that every map is baked (formations/curve.py).
        log(f"curve {ob.name}: {curve.bend(ob.data, rock_bows)}")
        # ... and what grows on it is bent the same way after (`bend_growths`)
        # One flat row of 10 floats per bow (a, b, bow, reach): an ID
        # property array can't nest vectors beside a float.
        ob["scene_bows"] = [[*a, *b, *bow, reach] for a, b, bow, reach in rock_bows]
    texels = ", ".join(f"{ob.name} {' + '.join(map(str, sizes[ob]))}" for ob in targets if ob in sizes)
    cached = (f"{len(loaded)} of {len(targets)} objects from the cache"
              + (f", {len(stale)} with stale occlusion" if stale else "") + f" ({pruned} unused entries removed)"
              if cache else "cache off")
    # scene-export.ts reads the "ships" counts: the optimiser must encode that
    # many baked maps.
    log(f"ships {sum(len(sizes[ob]) for ob in colored)} colour and {sum(len(sizes[ob]) for ob in bumped)} normal "
        f"maps; baked {sum(ob not in loaded for ob in colored)} colour, {len(to_detail)} detail and "
        f"{sum(ob not in loaded for ob in bumped)} normal ({texels or 'none'}) "
        f"on {device}; {cached}; {time.time() - t0:.1f}s")
    return len(targets)


def bend_growths(kept, warnings):
    """Bend every ivy, moss and formation growth piece in `kept` with the
    rocks it grows on. The bake
    bends a painted slate rock's long straight creases into bows after its
    maps (formations/curve.py, `ob["scene_bows"]`), but a growth was grown,
    and cleared of the rock, on the straight rock: on the bent one a bow
    bulged over the moss, which hid behind the rock face while the contact
    shadow baked beside it showed on the rock (the owner's jagged patch on
    Terrace.003, 2026-10-10: 8,059 cm2 of its mound in the bent rock). Each
    vertex moves by its hosts' bow field, as the rock's surface under it did,
    so it keeps its clearance (Terrace.003: the median vertex's changed by
    0.02 mm); but a bow curves across the faces between the vertices, and
    5,262 cm2 still chorded through. So a moss mound is then cleared again on
    the bent rock (moss/mesh_io.py `clear_of`: the build's `_clear_of_rock`
    on the finished mesh, its UVs carried; Terrace.003 0.5 s, 3,679 to 4,491
    triangles, none left in the rock), and what it could not clear is a
    warning."""
    from formations import curve
    from moss import mesh_io as moss_mesh_io
    from moss import ops as moss_ops
    from ivy import ops as ivy_ops

    for ob in kept:
        if ob.type != "MESH":
            continue
        if moss_ops.is_moss(ob):
            names = moss_ops.host_names(ob.moss)
        elif ivy_ops.is_ivy(ob):
            names = ivy_ops.host_names(ob.ivy)
        elif ob.get("formation_growth_owner") is not None:
            # formations/growth.py: planted on the straight rock too
            owner = ob["formation_growth_owner"]
            names = [r.name for r in kept if r.get("formation_id") == owner]
        else:
            continue
        hosts = [h for h in (bpy.data.objects.get(n) for n in names) if h is not None and h.get("scene_bows")]
        if not hosts:
            continue
        for part in [ob, *(c for c in ob.children_recursive if c.type == "MESH")]:
            me = part.data
            co = np.empty(3 * len(me.vertices))
            me.vertices.foreach_get("co", co)
            m = np.array(part.matrix_world, dtype=np.float64)
            world = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
            moved = np.zeros_like(world)
            for h in hosts:
                hm = np.array(h.matrix_world, dtype=np.float64)
                inv = np.linalg.inv(hm)
                local = world @ inv[:3, :3].T + inv[:3, 3]
                bows = [(Vector(r[0:3]), Vector(r[3:6]), Vector(r[6:9]), r[9])
                        for r in (list(row) for row in h["scene_bows"])]
                moved += curve.field(local, bows) @ hm[:3, :3].T
            world = world + moved
            inv = np.linalg.inv(m)
            me.vertices.foreach_set("co", (world @ inv[:3, :3].T + inv[:3, 3]).ravel())
            me.update()
            log(f"bend {part.name}: {int((np.einsum('ij,ij->i', moved, moved) > 1e-12).sum())} vertices moved with {', '.join(h.name for h in hosts)}")
        if moss_ops.is_moss(ob) and len(ob.data.polygons):
            # The bows bulge between the mound's vertices (up to 12 cm over a
            # crease, curving across its faces): moved with the field, 5,262
            # cm2 of Terrace.003's mound still chorded through the bent rock.
            # Cleared again on it, as the build cleared it on the straight one.
            co, tri = [], []
            for h in hosts_of_names(names):
                hc, ht = world_mesh(h)
                tri.append(ht + sum(len(c) for c in co))
                co.append(hc)
            moved, split, before, after, left = moss_mesh_io.clear_of(
                ob, np.concatenate(co), np.concatenate(tri), 0.5 * ob.moss.params().floor)
            log(f"bend {ob.name}: cleared of the bent rock, {moved} vertices moved, {split} edges split, {before} -> {after} triangles")
            if left > 0.0:
                warnings.append(f"{ob.name}: {left * 1e4:.1f} cm2 of moss in its rock after the export bent the rock")


def hosts_of_names(names):
    return [h for h in (bpy.data.objects.get(n) for n in names) if h is not None and h.type == "MESH"]


def world_mesh(ob):
    """(co, tri): `ob`'s own mesh, triangulated, in world space."""
    me = ob.data
    me.calc_loop_triangles()
    co = np.empty(3 * len(me.vertices))
    me.vertices.foreach_get("co", co)
    tri = np.empty(3 * len(me.loop_triangles), np.int32)
    me.loop_triangles.foreach_get("vertices", tri)
    m = np.array(ob.matrix_world, dtype=np.float64)
    return co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3], tri.reshape(-1, 3).astype(np.int64)


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
    """Grow every ivy and moss object from its paint and settings, and every
    plant from its settings and placement (the ivy, moss and foliage add-ons,
    tools/blender/ivy, moss and foliage, imported from the repo since the
    export runs with --factory-startup). The paint and the settings are the
    source; the mesh saved in the .blend is only the last preview, and would be
    stale against a host edited or re-imported since. One whose host is gone
    (or a plant that cannot grow where it stands) is hidden from the export.
    The ivy goes first: its rebuild carries a file from before
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
        if ob.ivy.status:
            warnings.append(f"{ob.name}: {ob.ivy.status}")
        cards = f"{result.leaves} clumps" if result.detail == "CLUMPS" else f"{result.leaves} leaves"
        on = " + ".join(ivy.host_names(ob.ivy))
        log(f"ivy {ob.name} on {on}: {len(result.triangles)} triangles ({cards}, {result.vines} vines), {ob.ivy.build_ms:.0f} ms")
    moss.register()
    for ob, what in moss.prepare_export(scene):
        s = ob.moss
        on = " + ".join(moss.host_names(s))
        if what is None:
            warnings.append(f"{ob.name}: {s.status}; not exported")
            drop(ob)
            continue
        if s.status:
            warnings.append(f"{ob.name}: {s.status}")
        if what == "texture":
            # Its decal is Blender's preview: never shipped, and out of the
            # bake's rays (3 mm off the rock, it would shade the rock's own
            # occlusion and bevel). The dabs go into the rock's colour map.
            drop(ob)
            log(f"moss {ob.name} on {on}: texture only, painted into the rock's colour map")
        else:
            took = f"rebuilt in {s.build_ms:.0f} ms" if what == "rebuilt" else "kept: built from this paint, rock and code"
            if s.in_rock > 0.0:
                # the moss clips through the rock there, and the bake shades
                # the rock over it (moss/build.py `_clear_of_rock`)
                warnings.append(f"{ob.name}: {s.in_rock * 1e4:.1f} cm2 of moss could not be cleared of its rock")
            left = f", {s.in_rock * 1e4:.2f} cm2 in the rock" if s.in_rock > 0.0 else ""
            log(f"moss {ob.name} on {on}: {s.triangles} triangles, {s.dabs} dabs, print {s.texture} px{left}, {took}")
    # Plants (the foliage add-on, tools/blender/foliage) grow after the ivy and
    # moss, in their own order, each clear of the plants before it.
    if any(ob.type == "MESH" and ob.get("grown_by") == "foliage" for ob in scene.objects):
        import foliage

        foliage.register()
        for ob, result in foliage.rebuild_all(scene):
            s = ob.foliage
            if result is None:
                warnings.append(f"{ob.name}: {s.status}; not exported")
                drop(ob)
                continue
            what = f"{s.parts} fronds, {s.leaves} leaves" if s.kind == "FERN" else f"{s.leaves} leaves"
            log(f"foliage {ob.name} on {s.host}: {s.triangles} triangles ({what}), {s.build_ms:.0f} ms")


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

    # Plants (the foliage add-on) stay out of the bake: hidden in render, a
    # neighbour is neither in Cycles' rays nor in a rock's cache key, so a fern
    # edited on a rock re-bakes nothing, and no leaf card is baked into the
    # stone's occlusion. The game's own shadows shade the rock under a plant.
    plants = [ob for ob in kept if ob.get("grown_by") == "foliage"]
    for ob in plants:
        ob.hide_render = True
    # A printed-edge moss's lip is a Bump node the exporter would carry as a
    # normal map of the print itself (black moss in the game); the game
    # shades the lip (src/render3d/mossMound.ts). Unlinked before the bake,
    # which would otherwise take the Bump for a procedural normal and bake the
    # mound a normal map the unlink then cut off again (2026-10-09: "ships 30
    # normal maps", 28 encoded).
    moss.prepare_gltf()
    # A printed-edge moss's mesh runs past its outline, cut away by the print's
    # alpha, but the slate's occlusion treats alpha 0 as solid and baked the
    # rock black under that apron. The bake sees each mound cut at its outline
    # (moss/build.py `cut_at_print`); the export gets its own mesh back.
    cut = moss.cut_for_bake(kept)
    view_layer.update()
    try:
        baked = bake_procedural_textures(kept, cache_dir, paints, warnings, stale_occlusion)
    finally:
        moss.uncut(cut)
        view_layer.update()
        for ob in plants:
            ob.hide_render = False
    bend_growths(kept, warnings)
    view_layer.update()
    # Baking selects its own targets; the export selection is restored after.
    if baked:
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
