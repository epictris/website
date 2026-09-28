"""Finding, creating and rebuilding moss objects, and the panel's operators."""

import time

import bpy

from . import build, mesh_io

COLLECTION = "Moss"


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
        result = build.build(host_mesh, host.matrix_world, stamps, s.params())
    finally:
        ev.to_mesh_clear()
    mesh_io.write_result(ob.data, result)
    s.triangles = len(result.triangles)
    s.curtain_triangles = result.curtain_triangles
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
