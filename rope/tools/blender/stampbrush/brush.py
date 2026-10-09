"""The stamp brush both painted growths use (the ivy and the moss add-ons): a modal
operator in the 3D viewport that lays stamps on whatever mesh is under the cursor.

Left-drag paints, Ctrl+left-drag erases, [ and ] resize, Escape (or right-click, or
Enter) ends; the erase variant is the same brush the other way round. Navigation
passes through. Every stroke lays stamps (centre, surface normal, radius, signed
strength) on ONE grown object, the target: the selected one when painting began,
or, with none selected (or when started as "new"), one created by the first
stamp - with the settings of the one the panel showed, so a style carries - and
selected, so the next painting carries on with it. A stamp that paints joins
every mesh it reaches (the one under the cursor, and any other whose surface is
within the brush's radius) to the target's hosts (stampbrush/hosts.py), so paint
over the seam of two rocks grows one growth over both. A rock may carry any
number of growths. Anything either add-on grows carries `GROWN_PROP` and is
transparent to the brush: the ray passes through it to the rock, so ivy can be
painted over moss and moss under ivy.

Moved out of the ivy's paint.py on 2026-10-02, when the moss add-on was written.
Until 2026-10-09 each rock had at most one growth of each kind and a stroke went
to the growth of whatever rock it hit."""

import math

import bpy
import gpu
import numpy as np
from bpy_extras import view3d_utils
from gpu_extras.batch import batch_for_shader
from mathutils import Vector

from . import stamps as stamp_io
from .geometry import composite, normalize, stamps_world
from .hosts import Reach, world_triangles

GROWN_PROP = "grown_by"  # on every object an add-on grows: "ivy" or "moss"
LIVE_BUDGET_MS = 150.0  # rebuild during a stroke only while a build is this quick
# Rebuild when a stroke ends only while a build is this quick. A slower one (a
# moss rock's build takes 5-100 s) waits for the end of painting, its object
# hidden and its paint drawn as a coverage preview, so painting never blocks.
STROKE_BUDGET_MS = 1500.0
PREVIEW_SPACING = 0.012  # metres between the preview's sample points on the host
PREVIEW_MAX_POINTS = 400_000  # coarser spacing on a host this would exceed
PREVIEW_COLOR = (0.45, 0.75, 0.25, 0.85)
NAVIGATION = {"MIDDLEMOUSE", "WHEELUPMOUSE", "WHEELDOWNMOUSE", "TRACKPADPAN", "TRACKPADZOOM", "MOUSEROTATE", "MOUSESMARTZOOM"}


def is_navigation(event):
    return event.type in NAVIGATION or event.type.startswith(("NDOF", "NUMPAD"))


def paintable(ob):
    return (
        ob is not None
        and ob.type == "MESH"
        and GROWN_PROP not in ob
        and ob.library is None
        and ob.override_library is None
        and not any(c.name.lower().startswith("guide") or c.library is not None for c in ob.users_collection)
    )


def cast(context, coord):
    """(world point, world normal, host) of the paintable mesh under the region
    coordinate, looking through anything grown; or None."""
    region, rv3d = context.region, context.region_data
    origin = view3d_utils.region_2d_to_origin_3d(region, rv3d, coord)
    direction = view3d_utils.region_2d_to_vector_3d(region, rv3d, coord)
    depsgraph = context.evaluated_depsgraph_get()
    for _ in range(16):
        hit, loc, nrm, _i, ob, _m = context.scene.ray_cast(depsgraph, origin, direction)
        if not hit:
            return None
        ob = ob.original if ob is not None else None
        if paintable(ob):
            return loc, nrm.normalized(), ob
        origin = loc + direction * 1e-4
    return None


def circle(centre, normal, radius, n=48):
    a = Vector((1, 0, 0)) if abs(normal.x) < 0.9 else Vector((0, 1, 0))
    u = normal.cross(a).normalized()
    v = normal.cross(u)
    lift = normal * min(radius * 0.02, 0.005)
    return [centre + lift + (u * math.cos(t) + v * math.sin(t)) * radius for t in (2 * math.pi * k / n for k in range(n + 1))]


def in_viewport(context):
    return context.area is not None and context.area.type == "VIEW_3D" and context.mode == "OBJECT"


def inside_region(context, event):
    region = context.region
    return 0 <= event.mouse_x - region.x < region.width and 0 <= event.mouse_y - region.y < region.height


class Coverage:
    """A grown object's paint as it would be cut: points sampled over its hosts
    (world space, area-uniform, PREVIEW_SPACING apart), the stamps composited
    at them as the build composites them at its vertices, and those at or over
    the threshold drawn. New stamps are composited onto the last coverage, so a
    stroke costs its own stamps, never the whole paint again. The hosts are
    sampled each whole, not as their union: a point buried in another rock is
    hidden by the depth test."""

    def __init__(self, hosts, frame, depsgraph):
        self.names = tuple(h.name for h in hosts)
        parts = [world_triangles(h, depsgraph) for h in hosts]
        base = np.cumsum([0] + [len(co) for co, _t in parts[:-1]])
        co = np.concatenate([co for co, _t in parts])
        tri = np.concatenate([tri + b for (_co, tri), b in zip(parts, base)]).astype(np.int64)
        self.matrix = frame.matrix_world.copy()
        a, b, c = co[tri[:, 0]], co[tri[:, 1]], co[tri[:, 2]]
        cross = np.cross(b - a, c - a)
        area = 0.5 * np.linalg.norm(cross, axis=1)
        spacing = max(PREVIEW_SPACING, math.sqrt(area.sum() / PREVIEW_MAX_POINTS))
        rng = np.random.default_rng(0)
        # Each triangle's share of points, rounded stochastically so a field of
        # small triangles still gets its due.
        want = area / (spacing * spacing)
        count = np.floor(want + rng.random(len(want))).astype(np.int64)
        f = np.repeat(np.arange(len(tri)), count)
        u, v = rng.random(len(f)), rng.random(len(f))
        flip = u + v > 1.0
        u[flip], v[flip] = 1.0 - u[flip], 1.0 - v[flip]
        fn = normalize(cross[f])
        self.normals = fn
        # Lifted off the rock so the depth test does not eat them.
        self.points = a[f] + (b[f] - a[f]) * u[:, None] + (c[f] - a[f]) * v[:, None] + fn * 0.003
        self.order = np.argsort(self.points[:, 0], kind="stable")
        self.xs = self.points[self.order, 0]
        self.m = np.zeros(len(self.points))
        self.done = 0  # stamps composited so far
        self.batch = None

    def update(self, stamps, threshold):
        """Composite the stamps not yet seen; False when the paint was not
        appended to (erased whole, undone) and the preview must start over."""
        if len(stamps) < self.done:
            return False
        if len(stamps) > self.done:
            new = stamp_io.Stamps(*(x[self.done:] for x in (stamps.position, stamps.normal, stamps.radius, stamps.strength)))
            centres, snormals = stamps_world(new, self.matrix)
            composite(self.m, self.points, self.normals, self.order, self.xs, centres, snormals, new.radius, new.strength)
            self.done = len(stamps)
            self.batch = None
        if self.batch is None:
            shader = gpu.shader.from_builtin("POINT_UNIFORM_COLOR")
            pts = self.points[self.m >= threshold].astype(np.float32)
            self.batch = (shader, batch_for_shader(shader, "POINTS", {"pos": pts}))
        return True

    def draw(self):
        if self.batch is None:
            return
        shader, batch = self.batch
        gpu.state.depth_test_set("LESS_EQUAL")
        gpu.state.point_size_set(3.0)
        shader.uniform_float("color", PREVIEW_COLOR)
        batch.draw(shader)
        gpu.state.depth_test_set("NONE")


class StampBrush:
    """Mixin for a modal paint operator. A subclass (also a bpy.types.Operator)
    names what it paints and how to reach it:

        LABEL                 the header's name, e.g. "Ivy"
        brush(context)        the brush settings: radius, strength, spacing, show_stamps
        active(context)       the grown object the panel shows (the selected one), or None
        create(host, scene, template)   a new grown object, its frame on the host
        stamps_mesh(ob)       the mesh holding the object's stamps
        host_of(ob)           the object's frame host (its stamps' frame), or None
        hosts_of(ob)          every host it grows on that exists, the frame first
        join(ob, host)        add a host to those it grows on
        rebuild(ob)           grow it again
        build_ms(ob)          how long its last build took

    and may name the paint coverage it grows from, for the preview a slow
    object shows while it waits for the end of painting (none without it):

        coverage_threshold(ob)   the coverage at which it grows
    """

    # False: never grow before the end of painting, however quick the last
    # build was (a moss's build grows with its paint, so the last one is no
    # guide: a new moss built in 0.8 s took 8.8 s three strokes on).
    GROW_WHILE_PAINTING = True

    def coverage_threshold(self, ob):
        return None

    LABEL = "Paint"
    erase: bpy.props.BoolProperty(name="Erase", default=False, options={"SKIP_SAVE"}, description="Start as the eraser: drag erases, Ctrl+drag paints")
    new: bpy.props.BoolProperty(name="New", default=False, options={"SKIP_SAVE"},
                                description="Paint a new one (with the selected one's settings) instead of painting the selected one")

    @classmethod
    def poll(cls, context):
        return in_viewport(context)

    def invoke(self, context, event):
        self.template = self.active(context)
        # By name: an undo during painting replaces every object.
        self.target = None if self.new or self.template is None else self.template.name
        self.reach = None  # Reach over the visible meshes, made at the first stamp that paints
        self.hover = None
        self.stroke = None  # {"erase": bool, "last": Vector | None, "coord": (x, y)}
        self.pending = {}  # grown object's name -> list of stamps not yet written
        self.stale = set()  # grown objects whose stamps are newer than their build
        self.previews = {}  # grown object's name -> Coverage, while its build waits
        self.hidden = set()  # grown objects hidden for their preview
        self.fresh = 0
        # Kept: a wm operator run from the modal (the redraw before the end
        # of painting's builds) leaves context.area unset.
        self.area, self.window = context.area, context.window
        self.handle = bpy.types.SpaceView3D.draw_handler_add(self._draw, (context,), "WINDOW", "POST_VIEW")
        context.window_manager.modal_handler_add(self)
        self._header(context)
        return {"RUNNING_MODAL"}

    def _header(self, context):
        b = self.brush(context)
        keys = "LMB erase   Ctrl+LMB paint" if self.erase else "LMB paint   Ctrl+LMB erase"
        into = self.target or f"a new {self.LABEL.lower()}"
        context.area.header_text_set(f"{self.LABEL} into {into}   {keys}   [ ] radius {b.radius:.3f} m   strength {b.strength:.2f}   Esc/RMB done")

    def _finish(self, context):
        if self.stale:
            self.area.header_text_set(f"{self.LABEL}   growing {len(self.stale)} object{'s' if len(self.stale) != 1 else ''}...")
            self.window.cursor_set("WAIT")
            bpy.ops.wm.redraw_timer(type="DRAW_WIN_SWAP", iterations=1)  # show the header before the builds block
        self._flush(context, "finish")
        self.window.cursor_set("DEFAULT")
        bpy.types.SpaceView3D.draw_handler_remove(self.handle, "WINDOW")
        self.area.header_text_set(None)
        self.area.tag_redraw()

    def modal(self, context, event):
        brush = self.brush(context)
        context.area.tag_redraw()
        if is_navigation(event):
            return {"PASS_THROUGH"}
        # Only the viewport's main region paints; the header, sidebar and
        # toolbar keep working.
        inside = inside_region(context, event)
        coord = (event.mouse_region_x, event.mouse_region_y)
        if event.type in {"ESC", "RIGHTMOUSE", "RET"} and event.value == "PRESS":
            self._finish(context)
            return {"FINISHED"}
        if event.type in {"LEFT_BRACKET", "RIGHT_BRACKET"} and event.value == "PRESS":
            brush.radius *= 0.8 if event.type == "LEFT_BRACKET" else 1.25
            self._header(context)
            return {"RUNNING_MODAL"}
        if event.type == "MOUSEMOVE":
            self.hover = cast(context, coord) if inside else None
            if self.stroke is not None:
                self._drag(context, coord)
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE":
            if event.value == "PRESS":
                if not inside:
                    return {"PASS_THROUGH"}
                self.stroke = {"erase": self.erase != event.ctrl, "last": None, "coord": coord}
                self._stamp_at(context, coord)
            elif event.value == "RELEASE" and self.stroke is not None:
                self.stroke = None
                self._flush(context, "stroke")
                bpy.ops.ed.undo_push(message=f"{self.LABEL} stroke")
            return {"RUNNING_MODAL"}
        if not inside:
            return {"PASS_THROUGH"}
        return {"RUNNING_MODAL"}

    # ----------------------------------------------------------------------

    def _drag(self, context, coord):
        """Stamps along the screen path since the last event, so a fast drag
        leaves no gaps."""
        x0, y0 = self.stroke["coord"]
        x1, y1 = coord
        steps = max(1, int(math.hypot(x1 - x0, y1 - y0) / 4))
        for k in range(1, steps + 1):
            f = k / steps
            self._stamp_at(context, (x0 + (x1 - x0) * f, y0 + (y1 - y0) * f))
        self.stroke["coord"] = coord
        if self.fresh >= 3:
            self._flush(context, "drag")

    def _stamp_at(self, context, coord):
        hit = cast(context, coord)
        if hit is None:
            return
        loc, nrm, host = hit
        brush = self.brush(context)
        last = self.stroke["last"]
        if last is not None and (loc - last).length < brush.radius * brush.spacing:
            return
        self.stroke["last"] = loc.copy()
        erase = self.stroke["erase"]
        ob = bpy.data.objects.get(self.target) if self.target else None
        if ob is None:
            if erase:
                return  # nothing selected to erase from
            ob = self.create(host, context.scene, self.template)
            self.target = ob.name
            if self.template is None:
                self.template = ob
            # Selected, so the panel shows it and the next painting carries on with it.
            for o in context.selected_objects:
                o.select_set(False)
            ob.select_set(True)
            context.view_layer.objects.active = ob
            self._header(context)
        if not erase:
            if self.reach is None:
                self.reach = Reach([o for o in context.visible_objects if paintable(o)], context.evaluated_depsgraph_get())
            have = {h.name for h in self.hosts_of(ob)}
            for h in [host, *self.reach.near(loc, brush.radius)]:
                if h.name not in have:
                    self.join(ob, h)
                    have.add(h.name)
        frame = self.host_of(ob)
        if frame is None:
            return
        mw = frame.matrix_world
        p = mw.inverted() @ loc
        n = (mw.to_3x3().transposed() @ nrm).normalized()
        strength = -brush.strength if erase else brush.strength
        self.pending.setdefault(ob.name, []).append((p[:], n[:], brush.radius, strength))
        self.fresh += 1

    def _flush(self, context, when):
        """Write pending stamps into their objects, then grow again what may be
        grown now: during a stroke ("drag") an object whose build is under
        LIVE_BUDGET_MS, at a stroke's end ("stroke") one under STROKE_BUDGET_MS,
        and at the end of painting ("finish") the rest. One that must wait is
        hidden and its paint previewed."""
        for name, new in self.pending.items():
            ob = bpy.data.objects.get(name)
            if ob is None or not new:
                continue
            me = self.stamps_mesh(ob)
            stamp_io.write(me, stamp_io.read(me).appended(new))
            self.stale.add(name)
        self.pending = {}
        self.fresh = 0
        budget = {"drag": LIVE_BUDGET_MS, "stroke": STROKE_BUDGET_MS, "finish": math.inf}[when]
        if not self.GROW_WHILE_PAINTING and when != "finish":
            budget = -math.inf
        for name in sorted(self.stale):
            ob = bpy.data.objects.get(name)
            if ob is None:
                self.stale.discard(name)
                self.previews.pop(name, None)
            elif self.build_ms(ob) < budget:
                self._end_preview(ob)
                self.rebuild(ob)
                self.stale.discard(name)
            elif not self.GROW_WHILE_PAINTING or self.build_ms(ob) >= STROKE_BUDGET_MS:
                self._preview(context, ob)

    def _preview(self, context, ob):
        threshold = self.coverage_threshold(ob)
        frame = self.host_of(ob)
        if threshold is None or frame is None:
            return
        hosts = self.hosts_of(ob)
        stamps = stamp_io.read(self.stamps_mesh(ob))
        cov = self.previews.get(ob.name)
        # Started over when a host joined: its points were never sampled.
        if cov is None or cov.names != tuple(h.name for h in hosts) or not cov.update(stamps, threshold):
            cov = self.previews[ob.name] = Coverage(hosts, frame, context.evaluated_depsgraph_get())
            cov.update(stamps, threshold)
        if ob.name not in self.hidden and ob.visible_get():
            ob.hide_set(True)
            self.hidden.add(ob.name)

    def _end_preview(self, ob):
        self.previews.pop(ob.name, None)
        if ob.name in self.hidden:
            ob.hide_set(False)
            self.hidden.discard(ob.name)
            if ob.name == self.target:
                ob.select_set(True)  # hiding it deselected it; the next painting carries on with it

    # ----------------------------------------------------------------------

    COLOR = (0.7, 1.0, 0.35, 0.9)
    ERASE_COLOR = (1.0, 0.35, 0.3, 0.9)

    def _draw(self, context):
        brush = self.brush(context)
        shader = gpu.shader.from_builtin("POLYLINE_UNIFORM_COLOR")
        gpu.state.blend_set("ALPHA")
        # No depth test: the ring lies on the rock, and on a bumpy face (or the
        # growth already over it) half of it would sink out of sight.
        gpu.state.depth_test_set("NONE")
        for cov in self.previews.values():
            cov.draw()
        shader.uniform_float("viewportSize", gpu.state.viewport_get()[2:])
        shader.uniform_float("lineWidth", 2.0)
        if self.hover is not None:
            loc, nrm, _ob = self.hover
            erase = self.stroke["erase"] if self.stroke else self.erase
            shader.uniform_float("color", self.ERASE_COLOR if erase else self.COLOR)
            batch_for_shader(shader, "LINE_STRIP", {"pos": circle(loc, nrm, brush.radius)}).draw(shader)
        if brush.show_stamps:
            ob = bpy.data.objects.get(self.target) if self.target else None
            if ob is not None:
                host = self.host_of(ob)
                st = stamp_io.read(self.stamps_mesh(ob))
                if host is not None and len(st):
                    m = np.array(host.matrix_world)
                    w = st.position @ m[:3, :3].T + m[:3, 3]
                    pts = gpu.shader.from_builtin("POINT_UNIFORM_COLOR")
                    gpu.state.point_size_set(4.0)
                    pts.uniform_float("color", (0.9, 0.9, 0.3, 0.8))
                    batch_for_shader(pts, "POINTS", {"pos": [tuple(x) for x in w]}).draw(pts)
        gpu.state.depth_test_set("NONE")
        gpu.state.blend_set("NONE")
