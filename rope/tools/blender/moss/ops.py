"""Finding, creating and rebuilding moss objects, and the panel's operators."""

import time

import bpy

from . import build, mesh_io
from .stampbrush import stamps as stamp_io
from .stampbrush.brush import GROWN_PROP
from .stampbrush.geometry import host_world

COLLECTION = "Moss"


def is_moss(ob):
    return ob is not None and ob.type == "MESH" and ob.get(GROWN_PROP) == "moss"


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
    ob[GROWN_PROP] = "moss"  # what makes it moss, and what the brushes look through
    s = ob.moss
    live = template.moss.live if template is not None else False
    s.live = False
    if template is not None:
        s.copy_from(template.moss)
    s.host = host.name
    s.stamps = stamp_io.new_mesh(f"{host.name}.moss.stamps")
    s.live = live
    attach(ob, host)
    return ob


def attach(ob, host):
    """Parent to the host with an identity transform: the mound is in the host's
    local frame, so moving the host moves its moss, and a host that is a body's
    dressing carries its moss into the game with it."""
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


def rebuild(ob, depsgraph=None):
    """Grow the moss object's mound and print again from its stamps and
    settings. Returns the build result, or None when the host is missing."""
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
        co, tri = host_world(host_mesh, host.matrix_world)  # copied out before the build re-evaluates
    finally:
        ev.to_mesh_clear()
    result = build.build(co, tri, host.matrix_world, stamp_io.read(s.stamps), s.params(), mesh_io.decimate)
    mesh_io.write_result(ob, result)
    s.triangles = len(result.triangles)
    s.dabs = result.dabs
    s.layer_dabs = " ".join(str(n) for n in result.layers)
    s.heights = "  ".join(f"{k}:{v:.0f}" for k, v in result.heights.items())
    s.texture = result.image.shape[0] if result.image.size else 0
    s.build_ms = (time.perf_counter() - t0) * 1000.0
    s.status = ""
    return result


def rebuild_all(scene):
    """Rebuild every moss object in the scene. Returns [(object, result)]."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    return [(ob, rebuild(ob, depsgraph)) for ob in moss_objects(scene)]


# --------------------------------------------------------------------------
# With Live on, a settings change rebuilds after a short quiet spell, so
# dragging a slider rebuilds at the pace the build allows.

_pending = set()


def schedule_rebuild(ob):
    if bpy.app.background:
        return
    _pending.add(ob.name)
    if not bpy.app.timers.is_registered(_flush):
        bpy.app.timers.register(_flush, first_interval=0.3)


def _flush():
    names = list(_pending)
    _pending.clear()
    for name in names:
        ob = bpy.data.objects.get(name)
        if ob is not None and is_moss(ob):
            rebuild(ob)
    return None


def _legacy_ivy():
    """Objects that still hold a moss-era ivy (see the ivy add-on's migrate.py)."""
    out = []
    for ob in bpy.data.objects:
        sysp = ob.bl_system_properties_get()
        g = sysp.get("moss") if sysp is not None else None
        if g is not None and hasattr(g, "keys") and "is_moss" in g.keys():
            out.append(ob.name)
    return out


def _on_load(*_args):
    """A file from before 2026-10-02 holds its ivy under this add-on's old name;
    the ivy add-on carries it across when it loads. Without it, say so."""
    legacy = _legacy_ivy()
    if legacy and "bl_ext.user_default.ivy" not in bpy.context.preferences.addons:
        print(f"[moss] {len(legacy)} object(s) hold ivy from when the ivy add-on was called moss ({', '.join(legacy[:4])}...); "
              "install the ivy add-on (just ivy-install) and reopen the file to carry it across")


def register_handlers():
    if _on_load not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(_on_load)


def unregister_handlers():
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
        stamp_io.write(ob.moss.stamps, stamp_io.Stamps.empty())
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
            live, dst.moss.live = dst.moss.live, False
            dst.moss.copy_from(src.moss)
            dst.moss.live = live
            rebuild(dst)
            n += 1
        self.report({"INFO"}, f"copied to {n}")
        return {"FINISHED"}


CLASSES = (MOSS_OT_rebuild, MOSS_OT_clear, MOSS_OT_copy_settings)
