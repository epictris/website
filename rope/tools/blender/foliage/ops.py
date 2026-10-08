"""Plants: creating them, growing them, keeping them in step with their
transform and their neighbours, and the panel's operators.

A plant is a mesh object in the `Foliage` collection, parented to its host
(found again by name, like the ivy's). Its transform is its anchor: the
origin is the root, local +Z the surface normal there, local +Y the way it
grows, the scale its size; G, R and S are how it is placed and aimed after it
is planted, and moving one grows it again. Its mesh is in its own frame.

Plants are grown in a fixed order (`order`, then name), each keeping clear of
the plants grown before it (their meshes, sampled as spheres, as karin's
editor kept a new plant clear of those already on its rock). So a plant that
changes grows again every later plant it could have touched, and the export,
which grows them all in order, makes exactly what the panel shows."""

import math
import random
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

from . import fern, mesh_io, vine
from .stampbrush.brush import GROWN_PROP
from .surface import FORWARD, Avoid, Surface, tangent_on

COLLECTION = "Foliage"
GROWN = "foliage"
NAMES = {"FERN": "fern", "VINE": "hanging-vine"}
AVOID_SAMPLES = 600  # points sampled over an earlier plant's mesh


def is_plant(ob):
    return ob is not None and ob.type == "MESH" and ob.foliage.is_plant


def plants(scene=None):
    """Every plant, in the order they grow."""
    obs = scene.objects if scene is not None else bpy.data.objects
    return sorted((ob for ob in obs if is_plant(ob)), key=lambda o: (o.foliage.order, o.name))


def active_plant(context):
    ob = context.active_object
    return ob if is_plant(ob) else None


def _collection(scene):
    """Plants live in their own collection, never their host's, so a host
    collection replaced wholesale takes no plant with it."""
    coll = bpy.data.collections.get(COLLECTION)
    if coll is None:
        coll = bpy.data.collections.new(COLLECTION)
    if coll.name not in scene.collection.children and coll not in scene.collection.children_recursive:
        scene.collection.children.link(coll)
    return coll


def frame(at, normal, direction):
    """A rotation whose +Z is `normal` and whose +Y is `direction` in its tangent plane."""
    z = normal.normalized()
    y = tangent_on(direction, z)
    x = y.cross(z).normalized()
    return Matrix((x, y, z)).transposed()


def anchor(ob):
    """(root, normal, direction, scale) from the plant's world transform."""
    m = ob.matrix_world
    m3 = m.to_3x3()
    scale = abs(m3.determinant()) ** (1.0 / 3.0)
    return m.translation.copy(), (m3 @ Vector((0.0, 0.0, 1.0))).normalized(), (m3 @ Vector((0.0, 1.0, 0.0))).normalized(), scale


def create_plant(kind, host, scene, at, normal, direction, template=None):
    """A new plant of `kind` on `host`, rooted at the world point `at`."""
    name = f"{host.name}.{NAMES[kind]}"
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    _collection(scene).objects.link(ob)
    s = ob.foliage
    s.live = False
    s.kind = kind
    if template is not None and template.foliage.kind == kind:
        s.copy_from(template.foliage)
    s.is_plant = True
    s.host = host.name
    s.order = max((p.foliage.order for p in plants()), default=-1) + 1
    s.seed = random.randrange(2147483647)
    ob[GROWN_PROP] = GROWN  # the brushes look through it
    ob.parent = host
    ob.matrix_parent_inverse.identity()
    ob.matrix_world = Matrix.Translation(at) @ frame(at, normal, direction).to_4x4()
    # Evaluated now: the matrix as set and the matrix the depsgraph makes of it
    # (parent x basis) differ in the last float bit, and a fern grown from the
    # one is not the fern the export grows from the other.
    bpy.context.view_layer.update()
    s.live = True
    return ob


def resolve_host(ob):
    host = bpy.data.objects.get(ob.foliage.host)
    if host is None or host.type != "MESH":
        return None
    if ob.parent != host:
        # A host re-imported under its name: the plant keeps its place in the world.
        world = ob.matrix_world.copy()
        ob.parent = host
        ob.matrix_parent_inverse.identity()
        ob.matrix_world = world
    return host


def world_bounds(ob):
    """The plant's mesh's box in the world, or None when it is empty. Read
    from the mesh itself, never `bound_box`, which is the evaluated object's
    and lags a plant grown a moment ago until the depsgraph runs: the next
    plant would not see it, and growing the same plants twice would differ."""
    me = ob.data
    n = len(me.vertices)
    if n == 0:
        return None
    co = np.empty(n * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    m = np.array(ob.matrix_world, dtype=np.float64)
    w = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
    return Vector(w.min(axis=0)), Vector(w.max(axis=0))


def reach_sphere(ob):
    root, _n, _d, scale = anchor(ob)
    return root, ob.foliage.reach(scale)


def _box_meets_sphere(box, centre, radius):
    lo, hi = box
    d = Vector((max(lo.x - centre.x, 0.0, centre.x - hi.x), max(lo.y - centre.y, 0.0, centre.y - hi.y), max(lo.z - centre.z, 0.0, centre.z - hi.z)))
    return d.length <= radius


def _samples(ob):
    """Points over a plant's mesh in the world, at most AVOID_SAMPLES of them."""
    me = ob.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)[:: max(1, math.ceil(n / AVOID_SAMPLES))]
    m = np.array(ob.matrix_world, dtype=np.float64)
    return [Vector(p) for p in co @ m[:3, :3].T + m[:3, 3]]


def avoid_for(ob, everyone):
    """The plants grown before `ob` that could touch it, as spheres to keep clear of."""
    centre, radius = reach_sphere(ob)
    key = (ob.foliage.order, ob.name)
    pts = []
    for other in everyone:
        if other == ob or (other.foliage.order, other.name) >= key or other.hide_render:
            continue
        box = world_bounds(other)
        if box is not None and _box_meets_sphere(box, centre, radius):
            pts.extend(_samples(other))
    return Avoid(pts)


def rebuild(ob, depsgraph=None, surfaces=None, everyone=None):
    """Grow the plant again from its settings and transform. Returns its
    stats, or None when it could not grow (the reason is in its status)."""
    s = ob.foliage
    host = resolve_host(ob)
    if host is None:
        s.status = f'host "{s.host}" not found'
        mesh_io.write_result(ob.data, _empty(), ob.matrix_world)
        return None
    t0 = time.perf_counter()
    depsgraph = depsgraph or bpy.context.evaluated_depsgraph_get()
    surfaces = {} if surfaces is None else surfaces
    surface = surfaces.get(host.name)
    if surface is None:
        surface = surfaces[host.name] = Surface.from_object(host, depsgraph)
    everyone = plants() if everyone is None else everyone
    root, normal, direction, scale = anchor(ob)
    avoid = avoid_for(ob, everyone)
    try:
        if s.kind == "FERN":
            out, stats = fern.grow(surface, root, normal, direction, s.fern_params(scale), avoid)
            s.parts = stats["fronds"]
        else:
            out, stats = vine.grow(surface, root, normal, direction, s.vine_params(scale), avoid)
            s.parts = 1
    except (fern.FernError, vine.VineError) as e:
        s.status = str(e)
        mesh_io.write_result(ob.data, _empty(), ob.matrix_world)
        return None
    arrays = out.arrays()
    mesh_io.write_result(ob.data, arrays, ob.matrix_world)
    ob.visible_shadow = True
    s.triangles = len(arrays[4])
    s.leaves = stats["leaves"]
    s.build_ms = (time.perf_counter() - t0) * 1000.0
    s.status = ""
    return stats


def _empty():
    z = np.zeros((0, 3))
    return z, z, np.zeros((0, 2)), z, np.zeros((0, 3), dtype=np.int64)


def rebuild_all(scene):
    """Grow every plant in the scene again, in order. Returns [(object, stats)]."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    everyone = plants(scene)
    surfaces = {}
    return [(ob, rebuild(ob, depsgraph, surfaces, everyone)) for ob in everyone]


def later_touched(ob, boxes):
    """The plants after `ob` whose reach meets any of `boxes` (the plant's old
    and new extent): those whose growth `ob` can have changed."""
    key = (ob.foliage.order, ob.name)
    out = []
    for other in plants():
        if (other.foliage.order, other.name) <= key or not other.foliage.live:
            continue
        centre, radius = reach_sphere(other)
        if any(b is not None and _box_meets_sphere(b, centre, radius) for b in boxes):
            out.append(other)
    return out


# --------------------------------------------------------------------------
# A change regrows after a short quiet spell, so dragging a slider or a plant
# grows at the pace the build allows. Pending plants grow in order, each one
# queueing the later plants it may have touched.

_pending = set()
_left = []  # boxes plants were taken from (deleted), whose later neighbours regrow


def schedule_rebuild(ob):
    if bpy.app.background:
        return
    _pending.add(ob.name)
    if not bpy.app.timers.is_registered(_flush):
        bpy.app.timers.register(_flush, first_interval=0.15)


def _flush():
    global _left
    left, _left = _left, []
    for p in plants():
        if p.foliage.live:
            centre, radius = reach_sphere(p)
            if any(_box_meets_sphere(b, centre, radius) for b in left):
                _pending.add(p.name)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    surfaces = {}
    while _pending:
        queued = [bpy.data.objects.get(n) for n in _pending]
        queued = [o for o in queued if is_plant(o)]
        _pending.clear()
        if not queued:
            break
        ob = min(queued, key=lambda o: (o.foliage.order, o.name))
        _pending.update(o.name for o in queued if o != ob)
        before = world_bounds(ob)
        rebuild(ob, depsgraph, surfaces)
        for later in later_touched(ob, (before, world_bounds(ob))):
            _pending.add(later.name)
    remember()
    return None


# --------------------------------------------------------------------------
# A plant moved, turned, scaled, or deleted (or its host moved) grows again.
# Nothing tells the add-on about a transform, so after every depsgraph update
# the plants' world matrices are compared with the last look; the build runs
# from a timer, never inside the handler.

_seen = {}  # name -> (matrix signature, world bounds)


def _signature(ob):
    return tuple(round(x, 5) for row in ob.matrix_world for x in row)


def remember():
    global _seen
    _seen = {ob.name: (_signature(ob), world_bounds(ob)) for ob in bpy.data.objects if is_plant(ob)}


def _on_depsgraph(scene, depsgraph):
    if bpy.app.background:
        return
    now = {ob.name: ob for ob in bpy.data.objects if is_plant(ob)}
    changed = False
    for name, ob in now.items():
        seen = _seen.get(name)
        if seen is None or seen[0] != _signature(ob):
            changed = True
            if ob.foliage.live:
                schedule_rebuild(ob)
    for name in set(_seen) - set(now):
        changed = True
        if _seen[name][1] is not None:
            _left.append(_seen[name][1])
            if not bpy.app.timers.is_registered(_flush):
                bpy.app.timers.register(_flush, first_interval=0.15)
    if changed:
        for name, ob in now.items():
            _seen[name] = (_signature(ob), _seen.get(name, (None, world_bounds(ob)))[1])
        for name in set(_seen) - set(now):
            del _seen[name]


def _on_load(*_args):
    """A file just opened: its plants are the baseline, so opening regrows nothing."""
    remember()


def register_handlers():
    if _on_depsgraph not in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.append(_on_depsgraph)
    if _on_load not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(_on_load)
    # At startup bpy.data is still restricted while add-ons register; the
    # baseline is taken from a one-shot timer once Blender is up.
    bpy.app.timers.register(_on_load, first_interval=0.0)


def unregister_handlers():
    if _on_depsgraph in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.remove(_on_depsgraph)
    if _on_load in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.remove(_on_load)


# --------------------------------------------------------------------------
# Choosing where ferns go (karin's fernPlacement.ts): spots sampled over the
# host by area, scored for being enclosed (a crack, an inside corner) and
# facing up, spaced apart, and kept only where a quick trial fits at least
# half the fronds. The open side is the way most rays from the spot escape.


def _ray_to_rock(surface, start, d, limit):
    t = 0.0
    for _ in range(40):
        if t >= limit:
            break
        hit = surface.nearest(start + d * t, limit)
        if hit is None or hit.distance > limit:
            return math.inf
        if hit.distance < 0.008:
            return t
        t += hit.distance
    return math.inf


def open_side(surface, point, normal):
    """(score, open direction) of a fern spot: enclosed and facing up scores high."""
    ta = normal.cross(Vector((0.0, 0.0, 1.0)) if abs(normal.z) < 0.9 else Vector((1.0, 0.0, 0.0))).normalized()
    tb = normal.cross(ta).normalized()
    start = point + normal * 0.04
    open_dir = Vector()
    hits = total = 0
    for elev in (0.35, 0.95):
        for i in range(8):
            a = i / 8 * math.pi * 2.0 + elev
            d = ((ta * math.cos(a) + tb * math.sin(a)) * math.cos(elev) + normal * math.sin(elev)).normalized()
            total += 1
            if _ray_to_rock(surface, start, d, 0.6) < 0.6:
                hits += 1
            else:
                open_dir += d
    if open_dir.length_squared < 1e-6:
        open_dir = normal.copy()
    open_dir.normalize()
    score = -1.0 if normal.z < -0.2 else 0.55 * hits / total + 0.45 * max(0.0, normal.z)
    return score, open_aim(open_dir, normal)


def open_aim(open_dir, normal):
    """The way a fern at a spot leans: its open side flattened onto the
    surface. Where the spot is open all round (a flat top, where every ray
    escapes and the open side is the normal itself) karin's generator fell
    back to one fixed direction, so every fern on a flat top leaned the same
    way; here it leans toward the game's camera (Blender -y) instead."""
    side = open_dir - normal * open_dir.dot(normal)
    if side.length < 0.1:
        side = FORWARD - normal * FORWARD.dot(normal)
    return tangent_on(side if side.length_squared > 1e-8 else open_dir, normal)


def fern_spots(surface, params, existing, count, spacing, seed):
    """Up to `count` good fern spots on the surface, `spacing` apart and from `existing` roots."""
    co, tri = surface.co, surface.tri
    a, b, c = co[tri[:, 0]], co[tri[:, 1]], co[tri[:, 2]]
    cross = np.cross(b - a, c - a)
    areas = np.cumsum(0.5 * np.linalg.norm(cross, axis=1))
    state = [seed & 0xFFFFFFFF]

    def rnd():
        state[0] = (state[0] * 1664525 + 1013904223) & 0xFFFFFFFF
        return state[0] / 4294967296.0

    cands = []
    for _ in range(220):
        k = int(np.searchsorted(areas, rnd() * areas[-1]))
        k = min(k, len(tri) - 1)
        u, v = rnd(), rnd()
        if u + v > 1.0:
            u, v = 1.0 - u, 1.0 - v
        p = Vector(a[k] + (b[k] - a[k]) * u + (c[k] - a[k]) * v)
        n = Vector(cross[k]).normalized()
        if n.z < 0.15:
            continue
        score, open_dir = open_side(surface, p, n)
        cands.append((score, p, n, open_dir))
    cands.sort(key=lambda x: -x[0])
    out = []
    for score, p, n, open_dir in cands:
        if len(out) >= count:
            break
        if any((q - p).length < spacing for _s, q, _n, _o in out) or any((q - p).length < spacing for q in existing):
            continue
        trial = fern.FernParams(**{**params.__dict__, "seed": 4242 + len(out) * 97})
        try:
            _b, stats = fern.grow(surface, p, n, open_dir, trial, quick=True)
        except fern.FernError:
            continue
        if stats["fronds"] < round(params.fronds) * 0.5:
            continue
        out.append((score, p, n, open_dir))
    return [(p, n, o) for _s, p, n, o in out]


# --------------------------------------------------------------------------


class FOLIAGE_OT_rebuild(bpy.types.Operator):
    bl_idname = "foliage.rebuild"
    bl_label = "Rebuild"
    bl_description = "Grow this plant again (and the later plants it may touch)"
    bl_options = {"REGISTER", "UNDO"}

    all: bpy.props.BoolProperty(name="All", default=False)

    def execute(self, context):
        if self.all:
            results = rebuild_all(context.scene)
            failed = [ob.name for ob, r in results if r is None]
            for name in failed:
                self.report({"WARNING"}, f"{name}: {bpy.data.objects[name].foliage.status}")
            self.report({"INFO"}, f"grew {len(results)} plant{'s' if len(results) != 1 else ''}")
            remember()
            return {"FINISHED"}
        ob = active_plant(context)
        if ob is None:
            return {"CANCELLED"}
        before = world_bounds(ob)
        if rebuild(ob) is None:
            self.report({"WARNING"}, ob.foliage.status)
        for later in later_touched(ob, (before, world_bounds(ob))):
            schedule_rebuild(later)
        remember()
        return {"FINISHED"}


class FOLIAGE_OT_new_seed(bpy.types.Operator):
    bl_idname = "foliage.new_seed"
    bl_label = "New Seed"
    bl_description = "Grow the selected plants from new seeds"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        for ob in {*context.selected_objects, context.active_object}:
            if is_plant(ob):
                ob.foliage.seed = random.randrange(2147483647)
        return {"FINISHED"}


class FOLIAGE_OT_reset(bpy.types.Operator):
    bl_idname = "foliage.reset"
    bl_label = "Reset"
    bl_description = "Put this plant's settings back to the defaults (a fern's, its variety's); the seed is kept"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        ob = active_plant(context)
        if ob is None:
            return {"CANCELLED"}
        ob.foliage.reset()
        schedule_rebuild(ob)
        return {"FINISHED"}


class FOLIAGE_OT_copy_settings(bpy.types.Operator):
    bl_idname = "foliage.copy_settings"
    bl_label = "Copy Settings to Selected"
    bl_description = "Give every selected plant of the same kind this plant's settings; seeds are kept"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        src = active_plant(context)
        if src is None:
            return {"CANCELLED"}
        n = 0
        for ob in context.selected_objects:
            if is_plant(ob) and ob != src and ob.foliage.kind == src.foliage.kind:
                ob.foliage.copy_from(src.foliage)
                schedule_rebuild(ob)
                n += 1
        self.report({"INFO"}, f"copied to {n}")
        return {"FINISHED"}


class FOLIAGE_OT_leaf_set(bpy.types.Operator):
    bl_idname = "foliage.leaf_set"
    bl_label = "Leaf Set"
    bl_description = "Choose a whole set of the vine's leaves"
    bl_options = {"REGISTER", "UNDO"}

    set: bpy.props.EnumProperty(items=(("PAINTED", "Painted", ""), ("SILHOUETTES", "Silhouettes", ""), ("ALL", "All", "")))

    def execute(self, context):
        ob = active_plant(context)
        if ob is None:
            return {"CANCELLED"}
        s = ob.foliage
        live, s.live = s.live, False
        s.painted_leaves = [self.set != "SILHOUETTES"] * len(s.painted_leaves)
        s.silhouette_leaves = [self.set != "PAINTED"] * len(s.silhouette_leaves)
        s.live = live
        schedule_rebuild(ob)
        return {"FINISHED"}


class FOLIAGE_OT_snap(bpy.types.Operator):
    bl_idname = "foliage.snap"
    bl_label = "Snap to Surface"
    bl_description = "Put the selected plants' roots on the nearest point of their host, standing on its normal, keeping the way they face"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        depsgraph = context.evaluated_depsgraph_get()
        surfaces = {}
        for ob in {*context.selected_objects, context.active_object}:
            if not is_plant(ob):
                continue
            host = resolve_host(ob)
            if host is None:
                continue
            surface = surfaces.get(host.name) or surfaces.setdefault(host.name, Surface.from_object(host, depsgraph))
            root, _n, direction, scale = anchor(ob)
            hit = surface.nearest(root)
            if hit is None:
                continue
            ob.matrix_world = Matrix.Translation(hit.point) @ frame(hit.point, hit.normal, direction).to_4x4() @ Matrix.Scale(scale, 4)
        return {"FINISHED"}


class FOLIAGE_OT_bake(bpy.types.Operator):
    bl_idname = "foliage.bake"
    bl_label = "Bake to Plain Mesh"
    bl_description = "Copy this plant into a plain mesh object to hand-edit; the copy is never regrown, and the plant is hidden in render so only the copy exports"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        ob = active_plant(context)
        if ob is None:
            return {"CANCELLED"}
        baked = bpy.data.objects.new(f"{ob.name}.baked", ob.data.copy())
        for c in ob.users_collection:
            c.objects.link(baked)
        baked.parent = ob.parent
        baked.matrix_world = ob.matrix_world
        ob.hide_set(True)
        ob.hide_render = True
        self.report({"INFO"}, f"baked to {baked.name}; {ob.name} is hidden in render so only the copy exports")
        return {"FINISHED"}


class FOLIAGE_OT_scatter(bpy.types.Operator):
    bl_idname = "foliage.scatter_ferns"
    bl_label = "Scatter Ferns"
    bl_description = (
        "Plant ferns over the active object (or the active plant's host) in its best spots: cracks and inside "
        "corners that face up, kept apart, each a fern of its own to move or edit afterwards"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        ob = context.active_object
        template = ob if is_plant(ob) and ob.foliage.kind == "FERN" else None
        host = bpy.data.objects.get(ob.foliage.host) if is_plant(ob) else ob
        if host is None or host.type != "MESH" or GROWN_PROP in host:
            self.report({"WARNING"}, "select the rock to scatter ferns over (or a fern on it)")
            return {"CANCELLED"}
        sc = context.scene.foliage_scatter
        depsgraph = context.evaluated_depsgraph_get()
        surface = Surface.from_object(host, depsgraph)
        params = template.foliage.fern_params() if template is not None else fern.FernParams()
        existing = [anchor(p)[0] for p in plants() if p.foliage.host == host.name]
        spots = fern_spots(surface, params, existing, sc.count, sc.spacing, random.randrange(2147483647))
        made = []
        for p, n, open_dir in spots:
            made.append(create_plant("FERN", host, context.scene, p, n, open_dir, template))
        surfaces = {host.name: surface}
        for ob2 in made:
            rebuild(ob2, depsgraph, surfaces)
        remember()
        self.report({"INFO"}, f"planted {len(made)} of {sc.count} ferns" + ("" if len(made) == sc.count else ": the rock has no more good spots that far apart"))
        return {"FINISHED"}


CLASSES = (FOLIAGE_OT_rebuild, FOLIAGE_OT_new_seed, FOLIAGE_OT_reset, FOLIAGE_OT_copy_settings, FOLIAGE_OT_leaf_set,
           FOLIAGE_OT_snap, FOLIAGE_OT_bake, FOLIAGE_OT_scatter)
