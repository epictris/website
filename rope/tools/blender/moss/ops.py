"""Finding, creating and rebuilding moss objects, and the panel's operators."""

import dataclasses
import hashlib
import os
import sys
import time

import bpy
import numpy as np

from . import build, mesh_io
from .stampbrush import stamps as stamp_io
from .stampbrush.brush import GROWN_PROP
from .stampbrush.geometry import host_world
from .stampbrush.hosts import surface

COLLECTION = "Moss"


def _formations_render():
    """formations/render.py, which sizes the maps the scene export bakes, from
    the repo this add-on lives in (tools/blender, as scene_export.py imports
    it): in Blender the formations add-on is a separate extension, which the
    moss does not need enabled."""
    here = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    if here not in sys.path:
        sys.path.insert(0, here)
    from formations import render
    return render


def is_moss(ob):
    return ob is not None and ob.type == "MESH" and ob.get(GROWN_PROP) == "moss"


def moss_objects(scene=None):
    obs = scene.objects if scene is not None else bpy.data.objects
    return [ob for ob in obs if is_moss(ob)]


def host_names(s):
    """Every host a moss grows on, by name: its frame host first."""
    return [s.host, *(h.name for h in s.joined if h.name != s.host)]


def hosts_of(ob):
    """The hosts of the moss that exist, its frame host first."""
    out = []
    for name in host_names(ob.moss):
        h = bpy.data.objects.get(name)
        if h is not None and h.type == "MESH" and h not in out:
            out.append(h)
    return out


def join(ob, host):
    """Grow the moss on `host` too (the brush joins what its paint reaches)."""
    if host.name not in host_names(ob.moss):
        ob.moss.joined.add().name = host.name


def mosses_on(host):
    """Every moss growing on `host`, by name."""
    return sorted((ob for ob in bpy.data.objects if is_moss(ob) and host.name in host_names(ob.moss)), key=lambda o: o.name)


def mosses_of(ob):
    """[ob] if it is moss, else every moss growing on it."""
    if ob is None:
        return []
    return [ob] if is_moss(ob) else mosses_on(ob)


def active_moss(context):
    """The moss the panel shows and the brush paints: the active object, if
    it is moss. A rock may carry several, so a rock is never one."""
    ob = context.active_object
    return ob if is_moss(ob) else None


def selected_moss(context):
    """Every moss selected, or growing on a selected object, the active one first."""
    out = []
    for ob in [context.active_object, *context.selected_objects]:
        for m in mosses_of(ob):
            if m not in out:
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


def resolve_hosts(ob):
    """The moss's hosts, parented to the first; None when that frame host is
    missing. A joined host that is missing is left out (`missing_hosts` names
    it) and kept on the list: a rock re-imported under its name is found again."""
    host = bpy.data.objects.get(ob.moss.host)
    if host is None or host.type != "MESH":
        return None
    attach(ob, host)
    return hosts_of(ob)


def missing_hosts(ob):
    have = {h.name for h in hosts_of(ob)}
    return [n for n in host_names(ob.moss) if n not in have]


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


_code = None


def _code_digest():
    """What a build's output depends on besides its inputs: the code that
    grows, decimates and writes it, and Blender (its decimate)."""
    global _code
    if _code is None:
        h = hashlib.sha1(bpy.app.version_string.encode())
        for path in (build.__file__, mesh_io.__file__, os.path.join(os.path.dirname(build.__file__), "stampbrush", "geometry.py")):
            with open(path, "rb") as f:
                h.update(hashlib.sha1(f.read()).digest())
        _code = h.hexdigest()
    return _code


def _build_key(growth_key, p):
    """The key of a whole build: its growth, the FINISH_PARAMS and the code.
    Stored on the moss after every build (`built_key`), so the scene export
    can tell a saved mound is what a build would make now and keep it."""
    finish = repr([(k, getattr(p, k)) for k in build.FINISH_PARAMS])
    return hashlib.sha1(f"{growth_key} {finish} {_code_digest()}".encode()).hexdigest()


class _Inputs:
    """A moss's build inputs as they stand: the world triangles of what it grows
    on (one host's own, or the union of its hosts: stampbrush/hosts.py), its
    stamps and settings, and the growth key over them."""

    def __init__(self, ob, hosts, depsgraph):
        self.hosts = hosts
        self.co, self.tri = surface(hosts, depsgraph)  # copied out before the build re-evaluates
        self.matrix = hosts[0].matrix_world.copy()
        # The export registers this add-on after the file is loaded, so the
        # load handler's migration has not run there.
        ob.moss.migrate_scale()
        self.p = ob.moss.params()
        if self.p.kind == "TEXTURE" and len(self.tri):
            # The export paints a texture-only moss into each rock's baked
            # colour map, so its decal previews that: printed at the map's
            # texel (the finest of its rocks'), uncapped. Print settings only:
            # the growth and the export's paint keys never read them.
            render = _formations_render()
            texels = []
            for h in hosts:
                ev = h.evaluated_get(depsgraph)
                me = ev.to_mesh()
                try:
                    area = sum(f.area for f in me.polygons)
                    co, tri = host_world(me, h.matrix_world)
                finally:
                    ev.to_mesh_clear()
                a, b, c = (co[tri[:, i]] for i in range(3))
                world_area = 0.5 * float(np.linalg.norm(np.cross(b - a, c - a), axis=1).sum())
                texels.append(render.colour_texel(h, area, world_area))
            self.p = dataclasses.replace(self.p, texel=min(texels), max_texture=render.BAKE_SIZE_MAX)
        self.stamps = stamp_io.read(ob.moss.stamps)
        self.key = _growth_key(self.co, self.tri, self.matrix, self.stamps, self.p)


def _grow(ob, inputs, regrow=False):
    """(growth, reused): the cached growth when its key matches, else grown."""
    cached = _grown.get(ob.session_uid)
    if not regrow and cached is not None and cached[0] == inputs.key:
        return cached[1], True
    _grown.pop(ob.session_uid, None)
    grown = build.grow(inputs.co, inputs.tri, inputs.matrix, inputs.stamps, inputs.p)
    _grown[ob.session_uid] = (inputs.key, grown)
    return grown, False


def rebuild(ob, depsgraph=None, regrow=False):
    """Grow the moss object's mound and print again from its stamps and
    settings. Returns the build result, or None when its frame host is
    missing. The growth is reused when only FINISH_PARAMS changed, unless
    `regrow`."""
    s = ob.moss
    hosts = resolve_hosts(ob)
    if hosts is None:
        s.status = f'host "{s.host}" not found'
        return None
    t0 = time.perf_counter()
    inputs = _Inputs(ob, hosts, depsgraph or bpy.context.evaluated_depsgraph_get())
    p = inputs.p
    grown, reused = _grow(ob, inputs, regrow)
    result = build.finish(grown, p, mesh_io.decimate) if grown is not None else build.empty_result()
    mesh_io.write_result(ob, result)
    s.triangles = len(result.triangles)
    s.dabs = result.dabs
    s.layer_dabs = " ".join(str(n) for n in result.layers)
    s.heights = " ".join(f"{k}:{v:.0f}" for k, v in result.heights.items())
    s.texture = result.image.shape[0] if result.image.size else 0
    s.texel_used = result.texel
    s.area = result.area
    s.apron = result.apron if p.edge_kind == "PRINT" and np.isfinite(result.apron) else -1.0
    s.reused = reused
    s.built_key = _build_key(inputs.key, p)
    s.build_ms = (time.perf_counter() - t0) * 1000.0
    s.status = _missing_status(ob)
    return result


def _missing_status(ob):
    missing = missing_hosts(ob)
    return f"grown without {', '.join(missing)}: not found" if missing else ""


def rebuild_all(scene):
    """Rebuild every moss object in the scene. Returns [(object, result)]."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    return [(ob, rebuild(ob, depsgraph)) for ob in moss_objects(scene)]


# --------------------------------------------------------------------------
# The scene export (tools/blender/scene_export.py)

_export = {}  # session_uid -> _Inputs of a texture-only moss, for texture_paints


def prepare_export(scene):
    """Make every moss in the scene current for an export, doing no more work
    than that needs. Returns [(object, what)], `what` one of:

    - "kept": a mound whose saved mesh and print were built from exactly
      these inputs by this code (`built_key`); left as it is.
    - "rebuilt": a mound rebuilt (`s.build_ms` says how long it took).
    - "texture": a texture-only moss. Nothing is grown here: its decal is not
      exported, and its dabs are only needed if its rock's colour map misses
      the bake cache, whose key holds the moss's (`texture_paints`).
    - None: its frame host is missing (`s.status` says so).

    A moss grown without a joined host that is missing is exported, with
    `s.status` saying which.

    Before 2026-10-05 the export rebuilt every moss: 162 s of the river's
    380 s export, nearly all of it rebuilding mosses nobody had changed."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    out = []
    _export.clear()
    for ob in moss_objects(scene):
        s = ob.moss
        hosts = resolve_hosts(ob)
        if hosts is None:
            s.status = f'host "{s.host}" not found'
            out.append((ob, None))
            continue
        inputs = _Inputs(ob, hosts, depsgraph)
        if s.kind == "TEXTURE":
            _export[ob.session_uid] = inputs
            s.status = _missing_status(ob)
            out.append((ob, "texture"))
        elif s.built_key == _build_key(inputs.key, inputs.p) and len(ob.data.polygons) > 0:
            s.status = _missing_status(ob)
            out.append((ob, "kept"))
        else:
            out.append((ob, "rebuilt" if rebuild(ob, depsgraph) is not None else None))
    return out


def texture_paints(scene):
    """[(moss, host, layers, params, key)] for every rock of every texture-only
    moss `prepare_export` saw: what scene_export.py paints into that rock's
    colour map (build.paint_map), a moss on several rocks once for each.
    `layers()` grows the moss on its first call (only a rock that misses the
    bake cache calls it; the moss's other rocks reuse that growth); `key`
    changes with anything that changes the painting - the growth's inputs,
    the dab edge, the code - and is part of the rock's bake-cache key."""
    out = []
    for ob in moss_objects(scene):
        inputs = _export.get(ob.session_uid)
        if inputs is None:
            continue

        def layers(ob=ob, inputs=inputs):
            t0 = time.perf_counter()
            grown, _reused = _grow(ob, inputs)
            ob.moss.build_ms = (time.perf_counter() - t0) * 1000.0
            return grown.layers if grown is not None else []

        key = hashlib.sha1(f"{inputs.key} {inputs.p.print_edge!r} {_code_digest()}".encode()).hexdigest()
        for host in inputs.hosts:
            out.append((ob, host, layers, inputs.p, key))
    return out


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
    scaled = [ob.name for ob in moss_objects() if ob.moss.migrate_scale()]
    if scaled:
        print(f"[moss] {len(scaled)} moss(es) saved with Scale now have Detail 1/scale ({', '.join(scaled[:4])}...); "
              "rebuild them: Scale also moved their colours, Detail does not")
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
        ob.moss.joined.clear()  # the paint was what joined them
        rebuild(ob)
        return {"FINISHED"}


class MOSS_OT_copy_settings(bpy.types.Operator):
    bl_idname = "moss.copy_settings"
    bl_label = "Copy Settings to Selected"
    bl_description = "Give every selected moss (and every moss on a selected object) this moss's settings; seeds are kept"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        src = active_moss(context)
        if src is None:
            return {"CANCELLED"}
        n = 0
        for dst in selected_moss(context):
            if dst == src:
                continue
            live, dst.moss.live = dst.moss.live, False
            dst.moss.copy_from(src.moss)
            dst.moss.live = live
            rebuild(dst)
            n += 1
        self.report({"INFO"}, f"copied to {n}")
        return {"FINISHED"}


class MOSS_OT_merge(bpy.types.Operator):
    bl_idname = "moss.merge"
    bl_label = "Merge Selected"
    bl_description = ("Merge every other selected moss into this one: their paint and their rocks become this moss's, "
                      "grown with this moss's settings as one, and they are deleted")
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        dst = active_moss(context)
        others = [ob for ob in context.selected_objects if is_moss(ob) and ob != dst]
        if dst is None or not others:
            self.report({"WARNING"}, "select the mosses to merge, the one to keep active")
            return {"CANCELLED"}
        frame = bpy.data.objects.get(dst.moss.host)
        if frame is None:
            self.report({"WARNING"}, dst.moss.status or f'host "{dst.moss.host}" not found')
            return {"CANCELLED"}
        stamps = stamp_io.read(dst.moss.stamps)
        merged = []
        for ob in others:
            src = bpy.data.objects.get(ob.moss.host)
            if src is None:
                self.report({"WARNING"}, f'{ob.name}: host "{ob.moss.host}" not found; left out')
                continue
            stamps = stamp_io.concatenated(stamps, stamp_io.carried(stamp_io.read(ob.moss.stamps), src.matrix_world, frame.matrix_world))
            for name in host_names(ob.moss):
                if name not in host_names(dst.moss):
                    dst.moss.joined.add().name = name
            merged.append(ob.name)
            st, me = ob.moss.stamps, ob.data
            bpy.data.objects.remove(ob)
            for data in (me, st):
                if data is not None and data.users == 0:
                    bpy.data.meshes.remove(data)
        stamp_io.write(dst.moss.stamps, stamps)
        rebuild(dst)
        self.report({"INFO"}, f"merged {', '.join(merged)} into {dst.name}")
        return {"FINISHED"}


class MOSS_OT_select(bpy.types.Operator):
    bl_idname = "moss.select"
    bl_label = "Select Moss"
    bl_description = "Select this moss, to paint it or change its settings"
    bl_options = {"REGISTER", "UNDO"}

    name: bpy.props.StringProperty()

    def execute(self, context):
        ob = bpy.data.objects.get(self.name)
        if not is_moss(ob):
            return {"CANCELLED"}
        for o in context.selected_objects:
            o.select_set(False)
        ob.select_set(True)
        context.view_layer.objects.active = ob
        return {"FINISHED"}


CLASSES = (MOSS_OT_rebuild, MOSS_OT_clear, MOSS_OT_copy_settings, MOSS_OT_merge, MOSS_OT_select)
