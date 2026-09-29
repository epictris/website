"""Finding, creating and rebuilding moss objects, the vine anchors a moss
hangs vines from, and the panel's operators."""

import math
import time

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

from . import build, mesh_io

COLLECTION = "Moss"
VINE_PROP = "moss_vine"  # on an Empty: the name of the host its vine hangs from


def is_moss(ob):
    return ob is not None and ob.type == "MESH" and ob.moss.is_moss


def moss_objects(scene=None):
    obs = scene.objects if scene is not None else bpy.data.objects
    return [ob for ob in obs if is_moss(ob)]


def moss_for_host(host):
    for ob in bpy.data.objects:
        if is_moss(ob) and ob.moss.host == host.name:
            return ob
    return None


def active_moss(context):
    """The moss the panel shows: the active object if it is moss, else the
    active object's moss."""
    ob = context.active_object
    if ob is None:
        return None
    if is_moss(ob):
        return ob
    return moss_for_host(ob)


def _collection(scene):
    """Moss objects live in their own collection, never in their host's, so a
    host collection replaced wholesale (the river's Cavern is, on every
    re-import) takes no paint with it."""
    coll = bpy.data.collections.get(COLLECTION)
    if coll is None:
        coll = bpy.data.collections.new(COLLECTION)
    if coll.name not in scene.collection.children and coll not in scene.collection.children_recursive:
        scene.collection.children.link(coll)
    return coll


def create_moss(host, scene, template=None):
    me = bpy.data.meshes.new(f"{host.name}.moss")
    ob = bpy.data.objects.new(f"{host.name}.moss", me)
    _collection(scene).objects.link(ob)
    s = ob.moss
    s.live = False
    if template is not None:
        s.copy_from(template.moss)
    s.is_moss = True
    s.host = host.name
    s.stamps = mesh_io.new_stamps_mesh(f"{host.name}.moss.stamps")
    s.live = True
    ob.visible_shadow = False  # the moss casts no shadow, in Blender as in the game: a cast shadow between leaves reads as a hole
    attach(ob, host)
    return ob


def attach(ob, host):
    """Parent to the host with an identity transform: the moss mesh is in the
    host's local frame, so moving the host moves its moss, and a host that is
    a body's dressing carries its moss into the game with it."""
    if ob.parent != host:
        ob.parent = host
    ob.matrix_parent_inverse.identity()
    ob.matrix_basis.identity()


def resolve_host(ob):
    host = bpy.data.objects.get(ob.moss.host)
    if host is None or host.type != "MESH":
        return None
    attach(ob, host)
    return host


# --------------------------------------------------------------------------
# Vines. Nothing places a vine but the artist: each is an arrow Empty in the
# Moss collection, parented to its host, pointing down, and the arrow's length
# in the world is the vine's - move it with G, lengthen it with S, delete it
# with X, as any object. A vine object is found by its `moss_vine` property
# (the host's name), so it survives the host being re-imported, like the paint.


def is_vine(ob):
    return ob is not None and ob.type == "EMPTY" and VINE_PROP in ob


def vine_objects(host):
    """This host's vine anchors, in a fixed order so a build is reproducible."""
    return sorted((ob for ob in bpy.data.objects if is_vine(ob) and ob[VINE_PROP] == host.name), key=lambda o: o.name)


def vine_length(ob):
    """The arrow's length in the world."""
    return (ob.matrix_world.to_3x3() @ Vector((0.0, 0.0, ob.empty_display_size))).length


def create_vine(host, scene, at, length):
    """An anchor at the world point `at`, hanging a vine `length` long."""
    ob = bpy.data.objects.new(f"{host.name}.vine", None)
    ob.empty_display_type = "SINGLE_ARROW"
    ob.empty_display_size = max(length, 0.05)
    ob[VINE_PROP] = host.name
    _collection(scene).objects.link(ob)
    ob.parent = host
    ob.matrix_parent_inverse.identity()
    # The arrow is +z; turned over it hangs the way the vine will.
    ob.matrix_world = Matrix.LocRotScale(Vector(at), Euler((math.pi, 0.0, 0.0)), Vector((1.0, 1.0, 1.0)))
    return ob


def read_vines(host):
    """The host's anchors as the builder takes them: host-local positions and
    world lengths."""
    obs = vine_objects(host)
    if not obs:
        return build.Vines.empty()
    inv = host.matrix_world.inverted()
    pos = np.array([(inv @ ob.matrix_world.translation)[:] for ob in obs], dtype=np.float64)
    return build.Vines(pos, np.array([vine_length(ob) for ob in obs], dtype=np.float64))


def nearest_vine(at, within):
    """The anchor closest to the world point `at`, if one is within `within`."""
    best, bd = None, within
    for ob in bpy.data.objects:
        if is_vine(ob):
            d = (ob.matrix_world.translation - Vector(at)).length
            if d < bd:
                best, bd = ob, d
    return best


def rebuild(ob, depsgraph=None):
    """Grow the moss object's mesh again from its stamps and settings. Returns
    the build result, or None when the host is missing."""
    s = ob.moss
    host = resolve_host(ob)
    if host is None:
        s.status = f'host "{s.host}" not found'
        return None
    t0 = time.perf_counter()
    depsgraph = depsgraph or bpy.context.evaluated_depsgraph_get()
    ev = host.evaluated_get(depsgraph)
    host_mesh = ev.to_mesh()
    try:
        stamps = mesh_io.read_stamps(s.stamps)
        result = build.build(host_mesh, host.matrix_world, stamps, read_vines(host), s.params())
    finally:
        ev.to_mesh_clear()
    mesh_io.write_result(ob.data, result)
    s.triangles = len(result.triangles)
    s.blobs = result.blobs
    s.vine_count = result.vines
    s.build_ms = (time.perf_counter() - t0) * 1000.0
    s.status = ""
    return result


def rebuild_all(scene):
    """Rebuild every moss object in the scene. Returns [(object, result)]."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    return [(ob, rebuild(ob, depsgraph)) for ob in moss_objects(scene)]


# --------------------------------------------------------------------------
# A settings change rebuilds after a short quiet spell, so dragging a slider
# rebuilds at the pace the build allows rather than on every step.

_pending = set()


def schedule_rebuild(ob):
    if bpy.app.background:
        return
    _pending.add(ob.name)
    if not bpy.app.timers.is_registered(_flush):
        bpy.app.timers.register(_flush, first_interval=0.15)


def _flush():
    names = list(_pending)
    _pending.clear()
    for name in names:
        ob = bpy.data.objects.get(name)
        if ob is not None and is_moss(ob):
            rebuild(ob)
    return None


# --------------------------------------------------------------------------
# A vine anchor moved, scaled, added or deleted regrows its host's moss. The
# anchors are plain objects, so nothing tells the add-on about them; after
# every depsgraph update the anchors' names and matrices are compared with
# the last look, and a host whose set changed is scheduled. The comparison
# walks the objects once and is far cheaper than a build; the build itself
# runs from a timer, never inside the handler.

_vine_sig = {}


def _vines_signature():
    sig = {}
    for ob in bpy.data.objects:
        if is_vine(ob):
            m = ob.matrix_world
            sig.setdefault(ob[VINE_PROP], []).append((ob.name, tuple(round(x, 5) for row in m for x in row), round(ob.empty_display_size, 5)))
    return {host: tuple(sorted(v)) for host, v in sig.items()}


def _on_depsgraph(scene, depsgraph):
    global _vine_sig
    if bpy.app.background:
        return
    sig = _vines_signature()
    if sig == _vine_sig:
        return
    changed = {h for h in set(sig) | set(_vine_sig) if sig.get(h) != _vine_sig.get(h)}
    _vine_sig = sig
    for name in changed:
        host = bpy.data.objects.get(name)
        moss = moss_for_host(host) if host is not None else None
        if moss is not None and moss.moss.live:
            schedule_rebuild(moss)


def _on_load(*_args):
    """A file just opened: take its anchors as the baseline, so opening a file
    regrows nothing."""
    global _vine_sig
    _vine_sig = _vines_signature()


def register_handlers():
    if _on_depsgraph not in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.append(_on_depsgraph)
    if _on_load not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(_on_load)
    _on_load()


def unregister_handlers():
    if _on_depsgraph in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.remove(_on_depsgraph)
    if _on_load in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.remove(_on_load)


# --------------------------------------------------------------------------


class MOSS_OT_rebuild(bpy.types.Operator):
    bl_idname = "moss.rebuild"
    bl_label = "Rebuild"
    bl_description = "Grow this moss again from its paint and settings"
    bl_options = {"REGISTER", "UNDO"}

    all: bpy.props.BoolProperty(name="All", default=False)

    def execute(self, context):
        targets = moss_objects(context.scene) if self.all else [active_moss(context)]
        n = 0
        for ob in targets:
            if ob is not None:
                if rebuild(ob) is None:
                    self.report({"WARNING"}, ob.moss.status)
                n += 1
        self.report({"INFO"}, f"rebuilt {n} moss object{'s' if n != 1 else ''}")
        return {"FINISHED"}


class MOSS_OT_clear(bpy.types.Operator):
    bl_idname = "moss.clear"
    bl_label = "Clear Paint"
    bl_description = "Remove every stamp of this moss"
    bl_options = {"REGISTER", "UNDO"}

    def invoke(self, context, event):
        return context.window_manager.invoke_confirm(self, event)

    def execute(self, context):
        ob = active_moss(context)
        if ob is None:
            return {"CANCELLED"}
        mesh_io.write_stamps(ob.moss.stamps, build.Stamps.empty())
        rebuild(ob)
        return {"FINISHED"}


class MOSS_OT_copy_settings(bpy.types.Operator):
    bl_idname = "moss.copy_settings"
    bl_label = "Copy Settings to Selected"
    bl_description = "Give the moss of every selected object (or every selected moss) this moss's settings; seeds are kept"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        src = active_moss(context)
        if src is None:
            return {"CANCELLED"}
        n = 0
        for ob in context.selected_objects:
            dst = ob if is_moss(ob) else moss_for_host(ob)
            if dst is None or dst == src:
                continue
            dst.moss.live = False
            dst.moss.copy_from(src.moss)
            dst.moss.live = True
            rebuild(dst)
            n += 1
        self.report({"INFO"}, f"copied to {n}")
        return {"FINISHED"}


class MOSS_OT_bake(bpy.types.Operator):
    bl_idname = "moss.bake"
    bl_label = "Bake to Plain Mesh"
    bl_description = "Copy this moss into a plain mesh object to hand-edit; the copy is no longer rebuilt, and the moss object stays as it is"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        ob = active_moss(context)
        if ob is None:
            return {"CANCELLED"}
        me = ob.data.copy()
        baked = bpy.data.objects.new(f"{ob.name}.baked", me)
        for c in ob.users_collection:
            c.objects.link(baked)
        baked.matrix_world = ob.matrix_world
        ob.hide_set(True)
        ob.hide_render = True
        self.report({"INFO"}, f"baked to {baked.name}; {ob.name} is hidden in render so only the copy exports")
        return {"FINISHED"}


CLASSES = (MOSS_OT_rebuild, MOSS_OT_clear, MOSS_OT_copy_settings, MOSS_OT_bake)
