"""Finding, creating and rebuilding ivy objects, the vine anchors an ivy
hangs vines from, the origin its carpet grows out from, and the panel's
operators."""

import math
import time

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

from . import build, mesh_io, migrate
from .stampbrush.brush import GROWN_PROP

COLLECTION = "Ivy"
VINE_PROP = "ivy_vine"  # on an Empty: the name of the host its vine hangs from
ORIGIN_PROP = "ivy_origin"  # on an Empty: the name of the host whose carpet grows out from it
SHADOW_PROP = "ivy_shadow"  # on a mesh: the shadow decal of the ivy it is parented to


def is_ivy(ob):
    return ob is not None and ob.type == "MESH" and ob.ivy.is_ivy


def is_shadow(ob):
    return ob is not None and ob.type == "MESH" and SHADOW_PROP in ob


def is_grown(ob):
    """Anything the add-on grows: an ivy mesh or its shadow decal. The brush
    passes through these to the rock beneath."""
    return is_ivy(ob) or is_shadow(ob)


def shadow_object(ivy):
    """The ivy object's shadow decal, if it has one."""
    for ch in ivy.children:
        if is_shadow(ch):
            return ch
    return None


def write_shadow(ivy, scene, shadow):
    """Keep the ivy object's shadow decal in step with a build: written from
    `shadow`, created when first needed, removed when the build grew none."""
    ob = shadow_object(ivy)
    if shadow is None or len(shadow.triangles) == 0:
        if ob is not None:
            me = ob.data
            bpy.data.objects.remove(ob)
            bpy.data.meshes.remove(me)
        return
    if ob is None:
        me = bpy.data.meshes.new(f"{ivy.name}.shadow")
        ob = bpy.data.objects.new(f"{ivy.name}.shadow", me)
        ob[SHADOW_PROP] = ivy.ivy.host
        ob[GROWN_PROP] = "ivy"
        _collection(scene).objects.link(ob)
        ob.parent = ivy
        ob.matrix_parent_inverse.identity()
        ob.matrix_basis.identity()
        ob.visible_shadow = False
    mesh_io.write_shadow(ob.data, shadow)


def ivy_objects(scene=None):
    obs = scene.objects if scene is not None else bpy.data.objects
    return [ob for ob in obs if is_ivy(ob)]


def ivy_for_host(host):
    for ob in bpy.data.objects:
        if is_ivy(ob) and ob.ivy.host == host.name:
            return ob
    return None


def active_ivy(context):
    """The ivy the panel shows: the active object if it is ivy, else the
    active object's ivy."""
    ob = context.active_object
    if ob is None:
        return None
    if is_ivy(ob):
        return ob
    return ivy_for_host(ob)


def _collection(scene):
    """Ivy objects live in their own collection, never in their host's, so a
    host collection replaced wholesale (the river's Cavern is, on every
    re-import) takes no paint with it."""
    coll = bpy.data.collections.get(COLLECTION)
    if coll is None:
        coll = bpy.data.collections.new(COLLECTION)
    if coll.name not in scene.collection.children and coll not in scene.collection.children_recursive:
        scene.collection.children.link(coll)
    return coll


def create_ivy(host, scene, template=None):
    me = bpy.data.meshes.new(f"{host.name}.ivy")
    ob = bpy.data.objects.new(f"{host.name}.ivy", me)
    _collection(scene).objects.link(ob)
    s = ob.ivy
    s.live = False
    if template is not None:
        s.copy_from(template.ivy)
    s.is_ivy = True
    ob[GROWN_PROP] = "ivy"  # the brushes look through it
    s.host = host.name
    s.stamps = mesh_io.new_stamps_mesh(f"{host.name}.ivy.stamps")
    s.live = True
    ob.visible_shadow = True  # the leaves cast, in Blender as in the game (since 2026-09-30): shadows between leaves
    attach(ob, host)
    return ob


def attach(ob, host):
    """Parent to the host with an identity transform: the ivy mesh is in the
    host's local frame, so moving the host moves its ivy, and a host that is
    a body's dressing carries its ivy into the game with it."""
    if ob.parent != host:
        ob.parent = host
    ob.matrix_parent_inverse.identity()
    ob.matrix_basis.identity()


def resolve_host(ob):
    host = bpy.data.objects.get(ob.ivy.host)
    if host is None or host.type != "MESH":
        return None
    attach(ob, host)
    return host


# --------------------------------------------------------------------------
# Vines. Nothing places a vine but the artist: each is an arrow Empty in the
# Ivy collection, parented to its host, pointing down, and the arrow's length
# in the world is the vine's - move it with G, lengthen it with S, delete it
# with X, as any object. A vine object is found by its `ivy_vine` property
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


# --------------------------------------------------------------------------
# The origin. A carpet grows out from one point: every leaf points away from
# it and lies over the leaf beyond it. It is a small sphere Empty in the Ivy
# collection, `<rock>.origin`, parented to the rock and carrying the rock's
# name in `ivy_origin`, placed by Set Origin and moved with G like any
# object; without one the carpet grows from the top of its paint. It only
# orients and layers the leaves - the paint alone decides where ivy grows.


def is_origin(ob):
    return ob is not None and ob.type == "EMPTY" and ORIGIN_PROP in ob


def origin_object(host):
    """This host's origin, if one is placed."""
    obs = sorted((ob for ob in bpy.data.objects if is_origin(ob) and ob[ORIGIN_PROP] == host.name), key=lambda o: o.name)
    return obs[0] if obs else None


def set_origin(host, scene, at):
    """Put the host's origin at the world point `at`, placing one if it has none."""
    ob = origin_object(host)
    if ob is None:
        ob = bpy.data.objects.new(f"{host.name}.origin", None)
        ob.empty_display_type = "SPHERE"
        ob.empty_display_size = 0.05
        ob[ORIGIN_PROP] = host.name
        _collection(scene).objects.link(ob)
        ob.parent = host
        ob.matrix_parent_inverse.identity()
    ob.matrix_world = Matrix.Translation(Vector(at))
    return ob


def read_origin(host):
    """The host's origin as the builder takes it: a host-local point, or None."""
    ob = origin_object(host)
    if ob is None:
        return None
    return np.array((host.matrix_world.inverted() @ ob.matrix_world.translation)[:], dtype=np.float64)


def rebuild(ob, depsgraph=None):
    """Grow the ivy object's mesh again from its stamps and settings. Returns
    the build result, or None when the host is missing."""
    s = ob.ivy
    host = resolve_host(ob)
    if host is None:
        s.status = f'host "{s.host}" not found'
        return None
    # An ivy saved before today's defaults may carry yesterday's as stored
    # values (the template copy stored every one); let it follow the defaults.
    live, s.live = s.live, False
    try:
        s.migrate()
    finally:
        s.live = live
    t0 = time.perf_counter()
    depsgraph = depsgraph or bpy.context.evaluated_depsgraph_get()
    ev = host.evaluated_get(depsgraph)
    host_mesh = ev.to_mesh()
    try:
        stamps = mesh_io.read_stamps(s.stamps)
        result = build.build(host_mesh, host.matrix_world, stamps, read_vines(host), read_origin(host), s.params())
    finally:
        ev.to_mesh_clear()
    mesh_io.write_result(ob.data, result)
    ob.visible_shadow = True  # an ivy made before 2026-09-30 was created not casting
    write_shadow(ob, bpy.context.scene, result.shadow)
    s.triangles = len(result.triangles)
    s.leaves = result.leaves
    s.vine_count = result.vines
    s.build_ms = (time.perf_counter() - t0) * 1000.0
    s.status = ""
    return result


def rebuild_all(scene):
    """Rebuild every ivy object in the scene. Returns [(object, result)]."""
    migrate.migrate()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    return [(ob, rebuild(ob, depsgraph)) for ob in ivy_objects(scene)]


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
        if ob is not None and is_ivy(ob):
            rebuild(ob)
    return None


# --------------------------------------------------------------------------
# A vine anchor or an origin moved, scaled, added or deleted regrows its
# host's ivy. They are plain objects, so nothing tells the add-on about
# them; after every depsgraph update their names and matrices are compared
# with the last look, and a host whose set changed is scheduled. The
# comparison walks the objects once and is far cheaper than a build; the
# build itself runs from a timer, never inside the handler.

_anchor_sig = {}


def _anchors_signature():
    sig = {}
    for ob in bpy.data.objects:
        prop = VINE_PROP if is_vine(ob) else ORIGIN_PROP if is_origin(ob) else None
        if prop is not None:
            m = ob.matrix_world
            sig.setdefault(ob[prop], []).append((ob.name, tuple(round(x, 5) for row in m for x in row), round(ob.empty_display_size, 5)))
    return {host: tuple(sorted(v)) for host, v in sig.items()}


def _on_depsgraph(scene, depsgraph):
    global _anchor_sig
    if bpy.app.background:
        return
    sig = _anchors_signature()
    if sig == _anchor_sig:
        return
    changed = {h for h in set(sig) | set(_anchor_sig) if sig.get(h) != _anchor_sig.get(h)}
    _anchor_sig = sig
    for name in changed:
        host = bpy.data.objects.get(name)
        ivy = ivy_for_host(host) if host is not None else None
        if ivy is not None and ivy.ivy.live:
            schedule_rebuild(ivy)


def _on_load(*_args):
    """A file just opened: carry a moss-era file to its ivy names (migrate.py),
    then take its anchors as the baseline, so opening a file regrows nothing."""
    global _anchor_sig
    n = migrate.migrate()
    if n:
        print(f"[ivy] carried {n} moss-era names over to ivy in {bpy.data.filepath or 'this file'}; save to keep them")
    _anchor_sig = _anchors_signature()


def register_handlers():
    if _on_depsgraph not in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.append(_on_depsgraph)
    if _on_load not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(_on_load)
    # At startup the add-on registers while bpy.data is still restricted
    # (reading objects raises), so the baseline is taken from a one-shot
    # timer once Blender is up; enabled from the preferences it runs at once.
    bpy.app.timers.register(_on_load, first_interval=0.0)


def unregister_handlers():
    if _on_depsgraph in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.remove(_on_depsgraph)
    if _on_load in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.remove(_on_load)


# --------------------------------------------------------------------------


class IVY_OT_rebuild(bpy.types.Operator):
    bl_idname = "ivy.rebuild"
    bl_label = "Rebuild"
    bl_description = "Grow this ivy again from its paint and settings"
    bl_options = {"REGISTER", "UNDO"}

    all: bpy.props.BoolProperty(name="All", default=False)

    def execute(self, context):
        targets = ivy_objects(context.scene) if self.all else [active_ivy(context)]
        n = 0
        for ob in targets:
            if ob is not None:
                if rebuild(ob) is None:
                    self.report({"WARNING"}, ob.ivy.status)
                n += 1
        self.report({"INFO"}, f"rebuilt {n} ivy object{'s' if n != 1 else ''}")
        return {"FINISHED"}


class IVY_OT_clear(bpy.types.Operator):
    bl_idname = "ivy.clear"
    bl_label = "Clear Paint"
    bl_description = "Remove every stamp of this ivy"
    bl_options = {"REGISTER", "UNDO"}

    def invoke(self, context, event):
        return context.window_manager.invoke_confirm(self, event)

    def execute(self, context):
        ob = active_ivy(context)
        if ob is None:
            return {"CANCELLED"}
        mesh_io.write_stamps(ob.ivy.stamps, build.Stamps.empty())
        rebuild(ob)
        return {"FINISHED"}


class IVY_OT_copy_settings(bpy.types.Operator):
    bl_idname = "ivy.copy_settings"
    bl_label = "Copy Settings to Selected"
    bl_description = "Give the ivy of every selected object (or every selected ivy) this ivy's settings; seeds are kept"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        src = active_ivy(context)
        if src is None:
            return {"CANCELLED"}
        n = 0
        for ob in context.selected_objects:
            dst = ob if is_ivy(ob) else ivy_for_host(ob)
            if dst is None or dst == src:
                continue
            dst.ivy.live = False
            dst.ivy.copy_from(src.ivy)
            dst.ivy.live = True
            rebuild(dst)
            n += 1
        self.report({"INFO"}, f"copied to {n}")
        return {"FINISHED"}


class IVY_OT_bake(bpy.types.Operator):
    bl_idname = "ivy.bake"
    bl_label = "Bake to Plain Mesh"
    bl_description = "Copy this ivy into a plain mesh object to hand-edit; the copy is no longer rebuilt, and the ivy object stays as it is"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        ob = active_ivy(context)
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


CLASSES = (IVY_OT_rebuild, IVY_OT_clear, IVY_OT_copy_settings, IVY_OT_bake)
