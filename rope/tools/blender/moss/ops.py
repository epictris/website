"""Finding, creating and rebuilding moss objects, and the panel's operators."""

import hashlib
import time

import bpy
import numpy as np

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


def moss_of(ob):
    """The object if it is moss, else the moss growing on it."""
    if ob is None:
        return None
    return ob if is_moss(ob) else moss_for_host(ob)


def active_moss(context):
    """The moss the panel shows: the active object if it is moss, else the
    active object's moss."""
    return moss_of(context.active_object)


def selected_moss(context):
    """Every moss selected, or growing on a selected object, the active one first."""
    out = []
    for ob in [context.active_object, *context.selected_objects]:
        m = moss_of(ob)
        if m is not None and m not in out:
            out.append(m)
    return out


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


# The last growth of each moss object (by session_uid), with the key of what it
# was grown from: a rebuild whose inputs differ only in build.FINISH_PARAMS (the
# triangle budget and the print) finishes the cached growth again, which takes a
# fraction of the time (2026-10-05, river's mid-ledge: 26 s whole, 7 s finish).
# Memory only; a file load clears it.
_grown = {}


def _growth_key(co, tri, matrix, stamps, p):
    h = hashlib.sha1()
    for a in (co, tri, np.array(matrix, dtype=np.float64), stamps.position, stamps.normal, stamps.radius, stamps.strength):
        a = np.ascontiguousarray(a)
        h.update(str((a.dtype, a.shape)).encode())
        h.update(a.tobytes())
    h.update(repr([(k, getattr(p, k)) for k in build.Params.__dataclass_fields__ if k not in build.FINISH_PARAMS]).encode())
    return h.hexdigest()


def rebuild(ob, depsgraph=None, regrow=False):
    """Grow the moss object's mound and print again from its stamps and
    settings. Returns the build result, or None when the host is missing.
    The growth is reused when only FINISH_PARAMS changed, unless `regrow`."""
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
    p = s.params()
    stamps = stamp_io.read(s.stamps)
    key = _growth_key(co, tri, host.matrix_world, stamps, p)
    cached = _grown.get(ob.session_uid)
    reused = not regrow and cached is not None and cached[0] == key
    if reused:
        grown = cached[1]
    else:
        _grown.pop(ob.session_uid, None)
        grown = build.grow(co, tri, host.matrix_world, stamps, p)
        _grown[ob.session_uid] = (key, grown)
    result = build.finish(grown, p, mesh_io.decimate) if grown is not None else build.empty_result()
    mesh_io.write_result(ob, result)
    s.triangles = len(result.triangles)
    s.dabs = result.dabs
    s.layer_dabs = " ".join(str(n) for n in result.layers)
    s.heights = " ".join(f"{k}:{v:.0f}" for k, v in result.heights.items())
    s.texture = result.image.shape[0] if result.image.size else 0
    s.texel_used = result.texel
    s.area = result.area
    s.reused = reused
    s.build_ms = (time.perf_counter() - t0) * 1000.0
    s.status = ""
    return result


def texture_paints(scene):
    """[(moss, host, layers, params, key)] for every texture-only moss in the
    scene grown in this session: what scene_export.py paints into the host's
    colour map (build.paint_map). `key` changes with anything that changes the
    painting - the growth's inputs, the dab edge, and build.py itself - for
    the export's bake cache."""
    with open(build.__file__, "rb") as f:
        code = hashlib.sha1(f.read()).hexdigest()
    out = []
    for ob in moss_objects(scene):
        if ob.moss.kind != "TEXTURE":
            continue
        host = resolve_host(ob)
        cached = _grown.get(ob.session_uid)
        if host is None or cached is None or cached[1] is None:
            continue
        p = ob.moss.params()
        key = hashlib.sha1(f"{cached[0]} {p.print_edge!r} {code}".encode()).hexdigest()
        out.append((ob, host, cached[1].layers, p, key))
    return out


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
    the ivy add-on carries it across when it loads. Without it, say so. A
    loaded file's objects are new, so the cached growths go."""
    _grown.clear()
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
    bl_description = ("Grow the selected moss (and the moss of the selected rocks) again from its paint and settings. "
                      "A change to Quality alone reuses the last growth and only remakes the mesh and the print")
    bl_options = {"REGISTER", "UNDO"}

    all: bpy.props.BoolProperty(name="All", default=False, description="Every moss in the scene, not only the selected")
    regrow: bpy.props.BoolProperty(name="Regrow", default=False, description="Grow from scratch even where the last growth could be reused")

    def execute(self, context):
        targets = moss_objects(context.scene) if self.all else selected_moss(context)
        if not targets:
            self.report({"WARNING"}, "no moss selected")
            return {"CANCELLED"}
        n = 0
        wm = context.window_manager
        wm.progress_begin(0, len(targets))
        try:
            for i, ob in enumerate(targets):
                if rebuild(ob, regrow=self.regrow) is None:
                    self.report({"WARNING"}, ob.moss.status)
                n += 1
                wm.progress_update(i + 1)
        finally:
            wm.progress_end()
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
