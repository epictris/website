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
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor

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
    if ob.name.startswith(("game.light-preview", "game.emission-light.", "game.emission-preview")):
        return "game preview helper"
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
# 64 differed from it by 0.3 levels rms (the Terrace, 2026-10-02). 8 since
# 2026-11-13: against 32 on Terrace.002 the colour map moved 0.75 levels rms
# and the normal map 1.1, the bake calls took 7.0 s against 12.4, and Tris saw
# no difference (https://claude.ai/artifact/2j4E9oa9N15KQ5RC3h7SQL). At 1 the
# speckle came back (2.5 and 4 levels rms, single texels off by 229).
BAKE_SAMPLES = 8
# How many worker Blenders prepare and bake the objects side by side
# (`run_workers`; SCENE_EXPORT_WORKERS overrides it, 1 bakes everything here).
# Each holds the whole scene and its own Cycles session on the one GPU, and
# Blender handles a bake's every texel on one thread, so the bakes scale with
# the workers until the GPU is busy.
WORKERS = int(os.environ.get("SCENE_EXPORT_WORKERS", "0")) or 8
# How many of them may hold a Cycles session at once (SCENE_EXPORT_GPU_SLOTS
# overrides it): each holds the whole scene on the card, about 1.2 GB on the
# river, and eight at once took the 4070 SUPER to 11.6 of its 12.3 GB beside
# 1.9 GB of other programs (2026-11-13). The rest of a worker's work, its
# preparation and the detail normals, runs on the CPU and is not held back.
GPU_SLOTS = int(os.environ.get("SCENE_EXPORT_GPU_SLOTS", "0")) or 4
# Set in a worker: the directory its results go to, and the lock files of the
# GPU slots it takes a bake's turn by.
WORKER_OUT = None
# A rock with this many maps or more is split among the workers: the one
# that prepares it hands it back prepared (its mesh, then its detail's
# geometry) and each map is baked by whichever worker is free, in a Cycles
# bake of its own (`run_workers`). Terrace.012's eight 4096 maps kept one
# worker busy for 108 s alone, 225 s among the others (2026-11-13). Each
# map's bake sees the whole rock, its other maps' images 1 x 1 stand-ins, so
# its rays meet what one bake of every map would; against that bake the
# colour maps differed by one 8-bit level at most. SCENE_EXPORT_SPLIT_MAPS
# overrides it (a large number splits nothing).
SPLIT_MAPS = int(os.environ.get("SCENE_EXPORT_SPLIT_MAPS", "0")) or 2
# Set in a worker baking one map of a split rock: which.
WORKER_MAP = None
# In a worker: each object's materials as the saved scene gave them, taken
# before its first task here replaced them with the export's copies.
PRISTINE = {}


class gpu_slot:
    """In a worker, one of GPU_SLOTS lock files held for the length of a
    Cycles bake, so no more than that many bakes share the card at once; a
    no-op anywhere else."""

    def __enter__(self):
        self.held = None
        if WORKER_OUT is None:
            return self
        import fcntl
        while self.held is None:
            for i in range(GPU_SLOTS):
                f = open(os.path.join(WORKER_OUT, f"gpu-slot-{i}.lock"), "w")
                try:
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    f.close()
                    continue
                self.held = f
                break
            else:
                time.sleep(0.05)
        return self

    def __exit__(self, *exc):
        if self.held is not None:
            import fcntl
            fcntl.flock(self.held, fcntl.LOCK_UN)
            self.held.close()
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
# The grid islands are packed on, texels a side (the gap scaled to it, at
# least one): 4 to 5 times faster than packing a 4k map at 4k, for coverage
# 0.80 against 0.81 (Terrace.002, 2026-11-13).
PACK_GRID = 1024
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


def smallest_detail(ob, name):
    """The narrowest feature pass `name` adds to `ob`: what the depth of field
    leaves distinguishable where it stands (formations/render.py)."""
    from formations import render
    return render.smallest_detail(ob, name)


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


# `--all-seen`: every face counts as seen (`seen_faces`), for a model the game
# may turn to show any side of. Part of every object's bake key.
ALL_SEEN = False


def seen_faces(mesh, matrix):
    """Which faces of `mesh` (at `matrix` in the world) the game camera can
    see, as a bool per polygon: facing one of `view_directions` with one of
    its samples' rays out of the object, and then every face touching one of
    those by a vertex, so a partly seen face's neighbour that a sample missed,
    and the seam between the seen and the unseen, are seen too.

    Measured 2026-10-16 on the river (Terrace.001, 250 k triangles, 3 s):
    of its 470 m2 of pile, 231 face the camera with nothing of the rock in
    the way. The rays are cast by the native kernels (native/src/bvh.cpp) on
    every thread: one at a time through mathutils they were 617 M calls and
    1,216 s of a 3 h river export (2026-11-13)."""
    import native
    n = len(mesh.polygons)
    if ALL_SEEN:
        return np.ones(n, bool)
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
    # Blender's own triangles of each face.
    mesh.calc_loop_triangles()
    tris = np.empty(3 * len(mesh.loop_triangles), np.int32)
    mesh.loop_triangles.foreach_get("vertices", tris)
    bvh = native.Bvh(co, tris)
    centre = np.add.reduceat(co[corner], start) / total[:, None]
    normal = np.empty(n * 3)
    mesh.polygons.foreach_get("normal", normal)
    # A normal goes to the world by the inverse transpose.
    normal = normal.reshape(-1, 3) @ np.linalg.inv(m[:3, :3])
    normal /= np.maximum(np.linalg.norm(normal, axis=1), 1e-30)[:, None]
    toward = view_directions()
    facing = normal @ toward.T > 1e-3
    seen = native.seen_faces(bvh, centre, normal, np.append(start, len(corner)), corner, toward, facing,
                             SAMPLE_REACH, RAY_LIFT)
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
    # Each map's islands packed (native/src/pack.cpp), the maps side by side.
    # Turning islands by right angles took Blender's packer from 0.47 to 0.59
    # coverage on Terrace.001's five maps (2026-10); any angle packed no
    # better. Blender's packer, single-threaded, was 97 % of the unwrap; ours
    # packs on a grid of PACK_GRID texels with the gap kept between texels'
    # squares, and covered 0.75 to 0.81 of Terrace.002's and Terrace.010's
    # maps where Blender's covered 0.55 to 0.62, in 1 to 6 s a map against 9
    # to 20 (2026-11-13).
    import native
    uv = uvs()
    welded.calc_loop_triangles()
    lt = np.empty(3 * len(welded.loop_triangles), np.int32)
    welded.loop_triangles.foreach_get("loops", lt)
    lt = lt.reshape(-1, 3)
    lt_face = np.empty(len(welded.loop_triangles), np.int32)
    welded.loop_triangles.foreach_get("polygon_index", lt_face)

    def pack(k):
        faces = image == k
        mine = np.flatnonzero(faces[corner_face])
        if not len(mine):
            return mine, None, 0.0
        local = np.full(n, -1, np.int64)
        local[mine] = np.arange(len(mine))
        grid = min(PACK_GRID, gap_sides[k])
        gap = max(1, math.ceil(PACK_GAP_PX * grid / gap_sides[k]))
        out, share = native.pack_islands(uv[mine], w_vert[mine], local[lt[faces[lt_face]]], grid, gap)
        return mine, out, share

    with ThreadPoolExecutor(max_workers=len(sides)) as pool:
        packed = list(pool.map(pack, range(len(sides))))
    shares = []
    for k, (mine, out, share) in enumerate(packed):
        if out is None:
            continue
        if share < 0:
            raise SystemExit(f"{ob.name}: map {k}'s islands fit its {sides[k]} square at no scale")
        uv[mine] = out
        shares.append(share)
    put(uv)
    log(f"unwrap {ob.name}: islands cover {', '.join(f'{s:.2f}' for s in shares)} of the maps")
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
    The bake leaves an unbaked texel's alpha at 0, which is the mask.
    Returns how many texels that mask held. The pyramid is the native
    kernel's (native/src/fill.cpp: the numpy it replaced to the bit, on every
    thread); each texel reads its parent, an odd last row or column the one
    before it, as the edge would be padded."""
    import native
    w, h = im.size
    px = np.empty(w * h * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    count = native.fill_background(px.reshape(h, w, 4))
    im.pixels.foreach_set(px)
    return count


def fill_baked(ob, im, what):
    """`fill_background` a map the `what` bake just wrote for `ob`, failing
    the export when it wrote nothing. An empty mask fills to solid black, the
    glTF exporter ships an all-black map as a black base colour and no image,
    and the bake cache keeps it for every export after: Cube.003 went out a
    black rock so on 2026-10-18 (its colour map empty, its normal map whole,
    from the same bake; one bake of the same rocks later wrote it whole)."""
    if not fill_background(im):
        raise SystemExit(f"{ob.name}: the {what} bake wrote no texel into {im.name}; nothing is cached or shipped. "
                         f"Export again; Cycles' own messages are in the export's Blender log")


def is_slate(mat):
    """Whether `mat` is the formations add-on's painted slate (or a `.001`
    copy an append makes): the stone that gets the detail normal map."""
    from formations import slate
    return mat is not None and (mat.name == slate.NAME or mat.name.startswith(slate.NAME + "."))


def bake_detail_normals(targets, images, straight, geometry=None):
    """Each painted slate rock's chips and sub-facets (formations/detail.py)
    as its detail normal images, and the image nodes reading them, keyed by
    material. The detail is made from the rock's `straight` mesh (split for
    its bows but not yet bent, so it lines up with the rock exactly), and
    each texel's normal found straight from it (detail.normal_maps: the
    native kernels cast the selected-to-active bake's rays at the crumpled
    rock less the chip cutters), with no high poly built and no Cycles bake:
    the boolean and the 31 detail bakes were most of 571 s of a cold river
    export (2026-11-13). `images` holds each rock's images, one a map. They
    are a step toward the normal bake, which reads them from memory, so they
    are neither filled (every texel is written, the flat normal where no ray
    met the detail, as Blender's bake writes it) nor packed. `geometry`
    holds a rock's detail geometry made elsewhere (detail.detail_geometry;
    a split rock's, `run_workers`)."""
    from formations import detail
    nodes = image_nodes(targets, images)
    for ob in targets:
        count = len(images[ob])
        per = len(ob.data.materials) // count
        maps, texels, report = detail.normal_maps(
            ob.data, straight.get(ob, ob.data), ob.matrix_world, seed_for(ob), BAKE_UV,
            [im.size[0] for im in images[ob]], lambda slot: slot // per, smallest_detail(ob, "export_chips"),
            (geometry or {}).get(ob))
        if not texels:
            raise SystemExit(f"{ob.name}: no ray of the detail normal bake met its detail; nothing is cached or "
                             "shipped")
        for im, px in zip(images[ob], maps):
            im.pixels.foreach_set(px.ravel())
            im.update()
        log(f"detail {ob.name}: {report}")
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
    prepared and baked: its detail seed, every render setting
    (formations/render.py: the depth, the strips, creases and chips, the map
    size) and the narrowest detail each pass keeps there (the depth of
    field's blur), as the bake cache keys it."""
    from formations import render
    return seed_for(ob), [(name, render.setting(ob, name)) for name in render.SETTINGS], \
        [(name, round(render.smallest_detail(ob, name), 5)) for name in render.PASSES], ALL_SEEN


def bake_material_slots(ob, depsgraph):
    """Keep slot indices stable, but tolerate empty slots no evaluated face uses.

    Cycles needs a writable material in every bake slot. Use an existing
    material for unused holes on the export copy; never guess a material for
    a face. Read the evaluated mesh so modifiers cannot hide a used hole.
    """
    if ob.name in PRISTINE:
        # Validated before this worker first touched the mesh. Later tasks
        # see per-map slot indices, not the source mesh's material indices.
        return list(PRISTINE[ob.name])
    evaluated = ob.evaluated_get(depsgraph)
    materials = [s.material for s in evaluated.material_slots]
    used = {p.material_index for p in evaluated.data.polygons}
    missing = sorted(i for i in used if i >= len(materials) or materials[i] is None)
    if missing or not materials or not any(m is not None for m in materials):
        raise SystemExit(f"{ob.name}: faces have no material in slot(s) {missing}; assign a material before baking")
    fallback = next(m for m in materials if m is not None)
    return [m if m is not None else fallback for m in materials]


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
    # Without clearing, the bake writes only the texels it baked, whatever
    # the number of objects. Cleared (the default), a bake of one object
    # writes the whole image, every texel off its islands a flat normal at
    # alpha 1, so `fill_background` saw nothing to fill; a bake of several
    # drops the clear itself (object_bake_api.cc). A worker bakes one object
    # at a time, and its normal maps' gaps came out flat (2026-11-13).
    with gpu_slot():
        bpy.ops.object.bake(type=bake_type, target="IMAGE_TEXTURES", uv_layer=BAKE_UV, margin=0, use_clear=False,
                            **bake_args)
    if before_fill is not None:
        for ob in targets:
            for i, im in enumerate(images[ob]):
                if not im.get("stand_in"):
                    before_fill(ob, i, im)
    for ob in targets:
        for im in images[ob]:
            if not im.get("stand_in"):
                fill_baked(ob, im, bake_type)
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


def entry_name(name):
    """The directory a worker writes object `name`'s result to (escaped as the
    bake cache escapes a map's file: a name may hold a slash)."""
    return name.replace("%", "%25").replace("/", "%2F")


def work_estimate(ob):
    """How much there is to prepare and bake for `ob`, roughly: its faces and
    the texels of the colour maps its surface asks for."""
    from formations import render
    me = ob.data
    if ob.type != "MESH" or not len(me.polygons):
        return 0
    area = np.empty(len(me.polygons))
    me.polygons.foreach_get("area", area)
    texels = sum(s * s for s in render.colour_maps(ob, float(area.sum())))
    return len(me.polygons) * 50 + texels


def run_workers(todo):
    """Prepare and bake `todo` in worker Blenders side by side, largest first.

    The scene goes to the workers as it stands now (`save_as_mainfile`, a
    copy: grown, its plants hidden, its mosses cut for the bake, its cached
    objects already their prepared meshes), so each one sees what a bake here
    would. Up to WORKERS of them each take the next object off the queue
    (`worker_main`) and write its prepared mesh and maps as the bake cache
    keeps an entry (bake_cache.write_entry). Their log lines come through as
    this export's. Returns ({object: its entry's path}, the warnings they
    gave); a worker that fails fails the export, with its last lines, and
    the others are stopped.

    A rock of SPLIT_MAPS maps or more comes back from the worker that
    prepares it as `[scene_worker] split NAME COUNT`: its maps join the
    front of the queue, one task each (`NAME<tab>MAP`), and each writes its
    maps to an entry of its own, gathered here into the rock's. A worker
    with nothing to take waits while a rock it might be handed is still
    being prepared."""
    import glob
    import heapq
    import subprocess
    import tempfile
    import threading
    t0 = time.time()
    work = tempfile.mkdtemp(prefix="scene-export-workers-")
    snapshot = os.path.join(work, "scene.blend")
    bpy.ops.wm.save_as_mainfile(filepath=snapshot, copy=True, compress=False)
    log(f"workers: the scene saved for them in {time.time() - t0:.1f}s")
    count = min(WORKERS, len(todo))
    env = dict(os.environ, OMP_NUM_THREADS=str(max(1, (os.cpu_count() or count) // count)))
    # Exit status 1 on a Python error: without, a worker whose bake raised
    # exited 0, and only a missing result said anything had gone wrong.
    cmd = [bpy.app.binary_path, "-b", snapshot, "--python-exit-code", "1", "--python", os.path.abspath(__file__),
           "--", "--worker", work]
    if ALL_SEEN:
        cmd.append("--all-seen")
    lock = threading.Condition()
    # The queue: (priority, order, task); a map comes before any rock still
    # to prepare, the largest rock first. `preparing` counts the rocks taken
    # and not yet done, any of which may still split.
    queue = [(-work_estimate(ob), i, ob.name) for i, ob in enumerate(todo)]
    heapq.heapify(queue)
    state = {"preparing": 0, "order": len(queue), "failed": False}
    split = {}  # rock name -> its map count
    failures, procs = [], []

    def take():
        with lock:
            while True:
                if state["failed"]:
                    return None
                if queue:
                    task = heapq.heappop(queue)[2]
                    if "\t" not in task:
                        state["preparing"] += 1
                    return task
                if not state["preparing"]:
                    return None
                lock.wait()

    def drive(i):
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, bufsize=1, env=env)
        with lock:
            procs.append(proc)
        tail = []
        for line in proc.stdout:
            line = line.rstrip("\n")
            tail = (tail + [line])[-40:]
            if line == "[scene_worker] ready":
                task = take()
                try:
                    if task is None:
                        proc.stdin.close()
                    else:
                        proc.stdin.write(task + "\n")
                        proc.stdin.flush()
                except (BrokenPipeError, ValueError):
                    pass
            elif line.startswith("[scene_worker] split "):
                name, maps = line[len("[scene_worker] split "):].rsplit(" ", 1)
                with lock:
                    split[name] = int(maps)
                    for k in range(int(maps)):
                        heapq.heappush(queue, (float("-inf"), state["order"], f"{name}\t{k}"))
                        state["order"] += 1
                    lock.notify_all()
            elif line.startswith("[scene_worker] done "):
                if "\t" not in line:
                    with lock:
                        state["preparing"] -= 1
                        lock.notify_all()
            elif line.startswith("[scene_export] ") and not line.startswith("[scene_export] ships "):
                with lock:
                    print(line, flush=True)
        if proc.wait() != 0:
            with lock:
                if not state["failed"]:
                    failures.append(f"worker {i} (exit {proc.returncode}):\n" + "\n".join(tail))
                    state["failed"] = True
                    for other in procs:
                        if other is not proc and other.poll() is None:
                            other.terminate()
                lock.notify_all()

    threads = [threading.Thread(target=drive, args=(i,)) for i in range(count)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    if failures:
        raise SystemExit("a bake worker failed; nothing shipped:\n" + "\n".join(failures))
    # A split rock's maps into its entry, which then holds them all as an
    # unsplit rock's does.
    for name, maps in split.items():
        entry = os.path.join(work, entry_name(name))
        for k in range(maps):
            part = f"{entry}.map{k}"
            for f in os.listdir(part):
                if f.endswith(".png"):
                    os.replace(os.path.join(part, f), os.path.join(entry, f))
            shutil.rmtree(part)
        if os.path.exists(f"{entry}.detail.npz"):
            os.remove(f"{entry}.detail.npz")
    warnings = []
    for path in sorted(glob.glob(os.path.join(glob.escape(work), "*.warnings.json"))):
        with open(path) as f:
            warnings.extend(w for w in json.load(f) if w not in warnings)
    log(f"workers: {len(todo)} objects prepared and baked in {count} workers"
        f"{f' ({len(split)} split, {sum(split.values())} maps)' if split else ''} in {time.time() - t0:.1f}s")
    return {ob: os.path.join(work, entry_name(ob.name)) for ob in todo}, warnings


def worker_main(argv):
    """A bake worker (`run_workers`): in the scene the export saved, prepare
    and bake each object named on stdin, one at a time, writing its result
    under the directory after `--worker`, until stdin closes. A line
    `NAME<tab>MAP` is one map of a split rock (SPLIT_MAPS)."""
    global WORKER_OUT, ALL_SEEN, WORKER_MAP
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import emission_materials
    emission_materials.clear()
    WORKER_OUT = argv[argv.index("--worker") + 1]
    ALL_SEEN = "--all-seen" in argv
    import moss
    moss.register()
    scene = bpy.context.scene
    while True:
        print("[scene_worker] ready", flush=True)
        task = sys.stdin.readline().rstrip("\n")
        if not task:
            return
        name, _, k = task.partition("\t")
        WORKER_MAP = int(k) if k else None
        ob = bpy.data.objects[name]
        if name not in PRISTINE:
            # What the file gives it, before a task here makes it its own
            # (a split rock's maps may come to the worker that prepared it).
            # The originals: an evaluated object's are the depsgraph's
            # copies, gone at its next evaluation.
            PRISTINE[name] = [m.original for m in bake_material_slots(ob, bpy.context.evaluated_depsgraph_get())]
        moss.prepare_texture_paints(scene, {name})
        warnings = []
        # This rock's mosses only: one prepared for a rock baked before is not
        # this bake's, and would be warned of as on a rock not exported.
        paints = [entry for entry in moss.texture_paints(scene) if entry[1] == ob]
        bake_procedural_textures([ob], None, paints, warnings)
        suffix = f".map{WORKER_MAP}" if WORKER_MAP is not None else ""
        with open(os.path.join(WORKER_OUT, entry_name(name)) + suffix + ".warnings.json", "w") as f:
            json.dump(warnings, f)
        print(f"[scene_worker] done {task}", flush=True)


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
    # A worker asks of a rock it has worked on before what the file gave it
    # (`PRISTINE`): its own copies are wired to their baked maps by then.
    targets = [ob for ob in kept if ob.type == "MESH"
               and (ob in by_host or any(m is not None and (procedural_base_colors(m) or procedural_normals(m))
                                         for m in PRISTINE.get(ob.name, ob.data.materials)))]
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
    materials = {ob: export_materials(ob, bake_material_slots(ob, depsgraph))
                 for ob in targets}
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
    import bake_cache
    sizes, straight, bows = {}, {}, {}
    cache, keys, hits, loaded, stale = None, {}, {}, {}, []

    def adopt(ob, files, mesh_file, data):
        """Take `ob`'s prepared mesh and maps from an entry (the cache's, or a
        worker's) instead of preparing and baking it here."""
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

    if cache_dir:
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
            adopt(ob, files, mesh_file, data)
    todo = [ob for ob in targets if ob not in loaded]
    step("bake", f"{len(todo)} of {len(targets)} objects to bake"
         + (f", {len(loaded)} cached" if cache else ", cache off")
         + (f" ({len(stale)} with stale occlusion)" if stale else "")
         + (f", {min(WORKERS, len(todo))} workers" if WORKER_OUT is None and WORKERS > 1 and len(todo) > 1 else ""))

    # The objects to bake, prepared and baked by worker Blenders side by side
    # (`run_workers`), each handing back its mesh and maps as the cache keeps
    # them; taken here as a cached object is, then kept in the cache too.
    worked = set()
    if WORKER_OUT is None and WORKERS > 1 and len(todo) > 1:
        entries, worker_warnings = run_workers(todo)
        if warnings is not None:
            warnings.extend(worker_warnings)
        for ob in todo:
            found = bake_cache.read_entry(entries[ob], lambda data, ob=ob: image_names(ob, ships[ob], len(data.get("maps", [0]))))
            if found is None:
                raise SystemExit(f"{ob.name}: its worker handed back no whole result ({entries[ob]})")
            adopt(ob, *found)
            worked.add(ob)
            if cache:
                cache.adopt(keys[ob], entries[ob])
        shutil.rmtree(os.path.dirname(next(iter(entries.values()))), ignore_errors=True)

    prepared = set()
    if WORKER_MAP is not None:
        # One map of a split rock: the rock as the worker that prepared it
        # handed it back (below), loaded as a cached rock is, then baked
        # with every other map's images 1 x 1 stand-ins (`images`).
        for ob in targets:
            entry = os.path.join(WORKER_OUT, entry_name(ob.name))
            with open(os.path.join(entry, "meta.json")) as f:
                sizes[ob] = json.load(f)["data"]["maps"]
            materials[ob] = split_materials(materials[ob], len(sizes[ob]))
            ob.modifiers.clear()
            ob.data = bake_cache.load_mesh(os.path.join(entry, bake_cache.MESH_FILE), materials[ob])
            ob.data.name = export_mesh_name(ob)
            prepared.add(ob)

    for ob in targets:
        if ob in loaded or ob in prepared:
            continue
        mesh = bpy.data.meshes.new_from_object(ob.evaluated_get(depsgraph), preserve_all_data_layers=True,
                                               depsgraph=depsgraph)
        mesh.name = export_mesh_name(ob)
        ob.modifiers.clear()
        ob.data = mesh
        slate_rock = any(is_slate(m) for m in mesh.materials)
        if slate_rock and render_setting(ob, "export_strips"):
            from formations import slate
            log(f"strips {ob.name}: {slate.mark_strips(mesh, smallest_detail(ob, 'export_strips'))} chamfer strips "
                "painted as edge line")
        if slate_rock and render_setting(ob, "export_creases"):
            # Long straight creases (formations/curve.py): split now, before
            # the unwrap; every map is baked on the straight rock, which the
            # detail high poly matches exactly, and the rock is bent after.
            from formations import curve
            bows[ob] = curve.find_bows(mesh, seed_for(ob), smallest_detail(ob, "export_creases"))
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

    if WORKER_OUT is not None and WORKER_MAP is None:
        for ob in targets:
            if ob in loaded or len(sizes[ob]) < SPLIT_MAPS:
                continue
            # Split (SPLIT_MAPS): the prepared rock handed back now, so its
            # maps start baking in the other workers, then the geometry of its
            # detail, which a map waits for once its colour is baked.
            entry = os.path.join(WORKER_OUT, entry_name(ob.name))
            rock_bows = [[list(a), list(b), list(bow), reach] for a, b, bow, reach in bows.get(ob, ())]
            bake_cache.write_entry(entry, [], ob.data, ob.name, {"bows": rock_bows, "maps": sizes[ob]})
            print(f"[scene_worker] split {ob.name} {len(sizes[ob])}", flush=True)
            if ob in straight:
                from formations import detail
                geometry = detail.detail_geometry(straight[ob], ob.matrix_world, seed_for(ob),
                                                  smallest_detail(ob, "export_chips"))
                detail.save_geometry(f"{entry}.detail.npz", geometry)
            return len(targets)

    def images(obs, kind, colorspace):
        """Each of `obs`' `kind` images, one a map; in a worker baking one map
        of a split rock, the others' 1 x 1 stand-ins (`stand_in`)."""
        out = {}
        for ob in obs:
            out[ob] = []
            for i, size in enumerate(sizes[ob]):
                # With alpha, cleared to 0: the bake writes 1 where it baked,
                # which is the mask `fill_background` fills the rest by.
                side = map_size(size, kind) if WORKER_MAP is None or i == WORKER_MAP else 1
                im = bpy.data.images.new(image_name(ob, kind, i, len(sizes[ob])), side, side, alpha=True)
                im.generated_color = (0, 0, 0, 0)
                im.colorspace_settings.name = colorspace
                # Drawn by this export for this object: an original, no credit owed.
                im["generated_by"] = "tools/blender/scene_export.py"
                if side != map_size(size, kind):
                    im["stand_in"] = True  # neither filled, packed nor handed back
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
        geometry = {}
        if WORKER_MAP is not None:
            # The split rock's detail geometry, which the worker that
            # prepared it writes once it has handed the rock back.
            from formations import detail
            for ob in to_detail:
                path = os.path.join(WORKER_OUT, entry_name(ob.name)) + ".detail.npz"
                while not os.path.isfile(path):
                    time.sleep(0.05)
                geometry[ob] = detail.load_geometry(path)
        nodes = bake_detail_normals(to_detail, images(to_detail, "detail normal", "Non-Color"), straight, geometry)
        for mat, node in nodes.items():
            slate.add_detail(mat, node.outputs["Color"], BAKE_UV)
    if bumped:
        nodes = bake_or_load(bumped, "baked normal",
                             lambda obs, ims: bake_pass(obs, ims, "NORMAL", normal_space="TANGENT"))
        for mat, node in nodes.items():
            for bsdf in procedural_normals(mat):
                wire_normal(mat, node, bsdf)
    if WORKER_OUT is not None:
        # A worker hands each object back straight, as the cache keeps it:
        # the export bends it with the rest.
        # One map of a split rock hands back that map's images alone, which
        # `run_workers` moves into the rock's entry.
        for ob, made in fresh.items():
            if WORKER_MAP is not None:
                bake_cache.write_entry(os.path.join(WORKER_OUT, entry_name(ob.name)) + f".map{WORKER_MAP}",
                                       [im for im in made if not im.get("stand_in")], None, ob.name)
                continue
            rock_bows = [[list(a), list(b), list(bow), reach] for a, b, bow, reach in bows.get(ob, ())]
            bake_cache.write_entry(os.path.join(WORKER_OUT, entry_name(ob.name)), made, ob.data, ob.name,
                                   {"bows": rock_bows, "maps": sizes[ob]})
        return len(targets)
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
    cached = (f"{len(loaded) - len(worked)} of {len(targets)} objects from the cache"
              + (f", {len(stale)} with stale occlusion" if stale else "") + f" ({pruned} unused entries removed)"
              if cache else "cache off")
    baked_here = lambda obs: sum(ob not in loaded or ob in worked for ob in obs)  # noqa: E731
    # scene-export.ts reads the "ships" counts: the optimiser must encode that
    # many baked maps.
    log(f"ships {sum(len(sizes[ob]) for ob in colored)} colour and {sum(len(sizes[ob]) for ob in bumped)} normal "
        f"maps; baked {baked_here(colored)} colour, {len(to_detail) + sum(ob in worked for ob in detailed)} detail "
        f"and {baked_here(bumped)} normal ({texels or 'none'}) "
        f"on {device}{f', {len(worked)} objects in {min(WORKERS, len(worked))} workers' if worked else ''}; "
        f"{cached}; {time.time() - t0:.1f}s")
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
    from moss import build as moss_build
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
            try:
                with moss_build.time_limit():
                    moved, split, before, after, left = moss_mesh_io.clear_of(
                        ob, np.concatenate(co), np.concatenate(tri), 0.5 * ob.moss.params().floor)
            except moss_build.BuildError as e:
                warnings.append(f"{ob.name}: not cleared of its rock after the export bent the rock: {e}")
                continue
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


# The name a picture's image ships under (`prepare_pictures`), which is how
# scripts/encode-textures.mjs knows to keep it exactly as painted.
PICTURE_SUFFIX = " picture"


def linked_from(sock):
    """The node feeding `sock` and the output it comes out of, or (None, None)."""
    if not sock.is_linked:
        return None, None
    link = sock.links[0]
    return link.from_node, link.from_socket


def picture_node(mat):
    """The Image Texture node of a PICTURE material, or None: an image shown as
    it is, its colour and its alpha wired straight onto the surface - what
    Blender's Image as Plane builds. Two shapes: a Principled BSDF whose Base
    Color and Alpha come from one Image Texture (lit), and the "shadeless" one,
    a Mix Shader of a Transparent BSDF and an Emission of the image's colour at
    strength 1, mixed by its alpha, into the output (unlit; also with the
    image's Color straight into the Mix, which `prepare_pictures` leaves). An
    image a tool drew (the moss prints) is not a picture: it has its own
    encoding."""
    if mat is None or mat.node_tree is None:
        return None
    nodes = mat.node_tree.nodes

    def image_of(node, sock, output):
        ok = (node is not None and node.type == "TEX_IMAGE" and node.image is not None
              and sock.name == output and not node.image.get("generated_by"))
        return node if ok else None

    for node in nodes:
        if node.type != "BSDF_PRINCIPLED":
            continue
        color = image_of(*linked_from(node.inputs["Base Color"]), "Color")
        # `==`, not `is`: every access makes a new Python object of a node.
        if color is not None and color == image_of(*linked_from(node.inputs["Alpha"]), "Alpha"):
            return color
    out = next((n for n in nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
    mix = out and linked_from(out.inputs["Surface"])[0]
    if mix is None or mix.type != "MIX_SHADER":
        return None
    transparent, (shown, sock) = linked_from(mix.inputs[1])[0], linked_from(mix.inputs[2])
    if transparent is None or transparent.type != "BSDF_TRANSPARENT" or shown is None:
        return None
    if shown.type == "EMISSION":
        strength = shown.inputs["Strength"]
        if strength.is_linked or strength.default_value != 1.0:
            return None
        shown, sock = linked_from(shown.inputs["Color"])
    color = image_of(shown, sock, "Color") if shown is not None else None
    if color is not None and color == image_of(*linked_from(mix.inputs[0]), "Alpha"):
        return color
    return None


def picture_texels(src):
    """`src`'s pixels with every fully transparent texel's colour filled from
    the visible ones around it (`fill_background`'s pull-push). Straight alpha
    is filtered colour and alpha apart, so a texel just inside the outline that
    is sampled with its invisible neighbour, and every mip level, averages in
    whatever colour that neighbour has; a painted cutout is mostly black under
    its alpha, which drew a dark rim. A visible texel keeps its colour, and
    every texel its alpha."""
    w, h = src.size
    px = np.empty(w * h * 4, dtype=np.float32)
    src.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    fill = bpy.data.images.new("picture fill", w, h, alpha=True)
    try:
        fill.pixels.foreach_set(px.ravel())
        fill_background(fill)
        filled = np.empty(w * h * 4, dtype=np.float32)
        fill.pixels.foreach_get(filled)
    finally:
        bpy.data.images.remove(fill)
    hidden = px[..., 3] == 0
    px[hidden, :3] = filled.reshape(h, w, 4)[hidden, :3]
    return px


def prepare_pictures(kept):
    """Make every picture material the exported objects wear (`picture_node`)
    go out whole. Blender's glTF exporter reads the shadeless shape as a black
    surface glowing with the image, opaque - its alpha lost, the colour under
    it drawn as a black box with the encoder's blocks along the outline - while
    it carries a Mix of a Transparent BSDF and a COLOUR as KHR_materials_unlit
    blended by the Mix's factor, so the Emission between is taken out (at
    strength 1 it changes nothing). And each picture's image is swapped for a
    copy named `<image> picture` with its hidden texels filled
    (`picture_texels`), which the encoder keeps at its own size, losslessly
    (scripts/encode-textures.mjs). The file is never saved, so its own
    materials and images are left as they were. Returns how many pictures."""
    copies = {}
    for mat in {m for ob in kept for m in (getattr(ob.data, "materials", None) or []) if m is not None}:
        node = picture_node(mat)
        if node is None:
            continue
        links = mat.node_tree.links
        for out in (n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output):
            mix = linked_from(out.inputs["Surface"])[0]
            emission = mix is not None and mix.type == "MIX_SHADER" and linked_from(mix.inputs[2])[0]
            if emission and emission.type == "EMISSION":
                links.new(node.outputs["Color"], mix.inputs[2])
        src = node.image
        # One copy per file: an image loaded twice (`x.png` and `x.png.001`)
        # ships once.
        key = os.path.realpath(bpy.path.abspath(src.filepath, library=src.library)) if src.filepath else src.name
        if key not in copies:
            # No dot, as in `image_name`: the glTF exporter would cut the name
            # at the last one and the encoder's rule would miss it.
            stem = os.path.splitext(re.sub(r"\.\d{3}$", "", src.name))[0].replace(".", "-")
            w, h = src.size
            copy = bpy.data.images.new(stem + PICTURE_SUFFIX, w, h, alpha=True)
            copy.colorspace_settings.name = src.colorspace_settings.name
            copy.alpha_mode = "STRAIGHT"
            copy.pixels.foreach_set(picture_texels(src).ravel())
            copies[key] = copy
        node.image = copies[key]
    return len(copies)


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
        # An unlit picture goes as KHR_materials_unlit (`prepare_pictures`).
        if not principled and picture_node(mat) is not None:
            continue
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
    The ivy goes first: its migration carries a file from before
    2026-10-02 (when the ivy add-on was called moss) to the ivy names, which the
    moss add-on must not mistake for its own.

    The ivy and the moss that has to be rebuilt are grown side by side in
    growth workers (growth_pool.py; SCENE_EXPORT_GROWERS=1 grows them here, one
    after another), each from what it takes of the scene before any is
    written back, so none sees another's result: none ever did, each grows on
    its hosts alone."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import growth_pool
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
    ivy.migrate()
    moss.register()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    ivies = [(ob, ivy.ops.build_job(ob, depsgraph)) for ob in ivy.ops.ivy_objects(scene)]
    plan = moss.ops.export_plan(scene)
    jobs = [(ob.name, "ivy", job, ob.ivy.build_ms) for ob, job in ivies if job is not None]
    jobs += [(ob.name, "moss", inputs.job(), ob.moss.build_ms) for ob, what, inputs in plan if what == "grow"]
    if growth_pool.GROWERS > 1 and len(jobs) > 1:
        grown = growth_pool.run(jobs, log)
    else:
        grown = {}
        for key, kind, job, _est in jobs:
            t0 = time.perf_counter()
            result, why = growth_pool.grow(kind, job)
            grown[key] = (result, why, (time.perf_counter() - t0) * 1000.0)

    for ob, job in ivies:
        if job is None:
            warnings.append(f"{ob.name}: {ob.ivy.status}; not exported (nor its shadow)")
            drop(ob)
            continue
        result, _why, ms = grown[ob.name]
        ivy.ops.apply(ob, result, ms)
        if ob.ivy.status:
            warnings.append(f"{ob.name}: {ob.ivy.status}")
        cards = f"{result.leaves} clumps" if result.detail == "CLUMPS" else f"{result.leaves} leaves"
        on = " + ".join(ivy.host_names(ob.ivy))
        log(f"ivy {ob.name} on {on}: {len(result.triangles)} triangles ({cards}, {result.vines} vines), {ob.ivy.build_ms:.0f} ms")
    for ob, what, inputs in plan:
        if what == "grow":
            what = moss.ops.apply_grown(ob, inputs, *grown[ob.name])
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
            if s.kind == "GLOW" and s.glow_remaining:
                warnings.append(f"{ob.name}: {s.glow_remaining} glow plants still intersect; reduce the count or size")
            what = (f"{s.parts} fronds, {s.leaves} leaves" if s.kind == "FERN" else
                    f"{s.parts} glow plants" if s.kind == "GLOW" else f"{s.leaves} leaves")
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
    if "--worker" in argv:
        worker_main(argv)
        return
    usage = "usage: scene_export.py -- out.glb meta.json [--all-seen] [--cache DIR [--stale-occlusion]]"
    global ALL_SEEN
    ALL_SEEN = "--all-seen" in argv
    if ALL_SEEN:
        argv.remove("--all-seen")
    stale_occlusion = "--stale-occlusion" in argv
    if stale_occlusion:
        argv.remove("--stale-occlusion")
    if len(argv) not in (2, 4) or (len(argv) == 4 and argv[2] != "--cache") or (stale_occlusion and len(argv) != 4):
        raise SystemExit(usage)
    out_glb, out_meta = argv[0], argv[1]
    cache_dir = argv[3] if len(argv) == 4 else None
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import emission_materials
    emission_materials.clear()
    # Preview helpers must not contribute to any export preparation either.
    for helper in bpy.context.scene.objects:
        if helper.name.startswith(("game.emission-light.", "game.emission-preview")):
            helper.hide_render = helper.hide_viewport = True
    t0 = time.time()
    # The game's depth of field, from scripts/scene-export.ts (it reads them
    # from src/render3d/depthOfField.ts); the finer passes are budgeted by it.
    if "SCENE_EXPORT_DOF" in os.environ:
        from formations import render
        render.check_dof(json.loads(os.environ["SCENE_EXPORT_DOF"]))

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
    lighting_maps, lighting_field = {}, None
    if os.environ.get("SCENE_EXPORT_EMISSION") == "1":
        import emission_bake
        step("lighting")
        lighting_maps, lighting_field = emission_bake.bake(
            kept, set(json.loads(os.environ.get("SCENE_EXPORT_DYNAMIC", "[]"))), log)
    # Baking selects its own targets; the export selection is restored after.
    if baked or lighting_maps or lighting_field:
        for ob in scene.objects:
            try:
                ob.select_set(ob in kept)
            except RuntimeError:
                pass
        view_layer.update()
    step("gltf")
    # Credited before the pictures are swapped for copies, which have neither
    # the name nor the file the credits table knows an image by.
    credits = image_credits(kept, warnings)
    pictures = prepare_pictures(kept)
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
        use_active_scene=True,
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
        # Custom vertex attributes (names starting "_") are exported: the glow
        # flora's shader inputs (_GLOW, _GILL, _SWAY, _EXTRA; foliage/glowgrow.py).
        # Blender's own attributes never start with one, so nothing else changes.
        export_attributes=True,
        # No Draco: the optimiser applies meshopt afterwards (scripts/optimize-asset.ts).
        export_draco_mesh_compression_enable=False,
    )
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kwargs = {k: v for k, v in kwargs.items() if k in props}
    bpy.ops.export_scene.gltf(**kwargs)
    if lighting_maps or lighting_field:
        emission_bake.embed(out_glb,lighting_maps,lighting_field)

    meta = {
        "blender": bpy.app.version_string,
        "nodes": nodes,
        "credits": credits,
        "skipped": skipped,
        "warnings": warnings,
        "lighting": {"lightmaps": len(lighting_maps), "probes": math.prod(lighting_field["size"]) if lighting_field else 0},
        # Every baked map the glTF should carry, by name: scene-export.ts
        # names the ones the shipped file lacks. Not part of the scene's meta.
        "baked_maps": sorted(im.name for im in bpy.data.images
                             if im.get("generated_by") == "tools/blender/scene_export.py"
                             and im.name.endswith((" baked colour", " baked normal"))),
    }
    with open(out_meta, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    tris = sum(n["triangles"] for n in nodes)
    log(f"wrote {out_glb} ({os.path.getsize(out_glb) / 1024:.0f} KB raw): {len(nodes)} objects, {tris} triangles, "
        f"{pictures} pictures, {len(skipped)} skipped, {len(warnings)} warnings, {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
