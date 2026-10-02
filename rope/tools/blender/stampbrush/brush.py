"""The stamp brush both painted growths use (the ivy and the moss add-ons): a modal
operator in the 3D viewport that lays stamps on whatever mesh is under the cursor.

Left-drag paints, Ctrl+left-drag erases, [ and ] resize, Escape (or right-click, or
Enter) ends; the erase variant is the same brush the other way round. Navigation
passes through. Every stroke lays stamps (centre, surface normal, radius, signed
strength) on the grown object of the host it hit, creating one the first time a
host is painted - with the settings of the one the panel showed when painting
began, so a style carries from rock to rock. Anything either add-on grows carries
`GROWN_PROP` and is transparent to the brush: the ray passes through it to the
rock, so ivy can be painted over moss and moss under ivy.

Moved out of the ivy's paint.py on 2026-10-02, when the moss add-on was written."""

import math

import bpy
import gpu
import numpy as np
from bpy_extras import view3d_utils
from gpu_extras.batch import batch_for_shader
from mathutils import Vector

from . import stamps as stamp_io

GROWN_PROP = "grown_by"  # on every object an add-on grows: "ivy" or "moss"
LIVE_BUDGET_MS = 150.0  # rebuild during a stroke only while a build is this quick
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


class StampBrush:
    """Mixin for a modal paint operator. A subclass (also a bpy.types.Operator)
    names what it paints and how to reach it:

        LABEL                 the header's name, e.g. "Ivy"
        brush(context)        the brush settings: radius, strength, spacing, show_stamps
        active(context)       the grown object the panel shows, or None
        grown_for(host)       the host's grown object, or None
        create(host, scene, template)   a new grown object for the host
        stamps_mesh(ob)       the mesh holding the object's stamps
        host_of(ob)           the object's host, or None
        rebuild(ob)           grow it again
        build_ms(ob)          how long its last build took
    """

    LABEL = "Paint"
    erase: bpy.props.BoolProperty(name="Erase", default=False, options={"SKIP_SAVE"}, description="Start as the eraser: drag erases, Ctrl+drag paints")

    @classmethod
    def poll(cls, context):
        return in_viewport(context)

    def invoke(self, context, event):
        self.template = self.active(context)
        self.hover = None
        self.stroke = None  # {"erase": bool, "last": Vector | None, "coord": (x, y)}
        self.pending = {}  # grown object's name -> list of stamps not yet written
        self.fresh = 0
        self.handle = bpy.types.SpaceView3D.draw_handler_add(self._draw, (context,), "WINDOW", "POST_VIEW")
        context.window_manager.modal_handler_add(self)
        self._header(context)
        return {"RUNNING_MODAL"}

    def _header(self, context):
        b = self.brush(context)
        keys = "LMB erase   Ctrl+LMB paint" if self.erase else "LMB paint   Ctrl+LMB erase"
        context.area.header_text_set(f"{self.LABEL}   {keys}   [ ] radius {b.radius:.3f} m   strength {b.strength:.2f}   Esc/RMB done")

    def _finish(self, context):
        self._flush(context, rebuild=True)
        bpy.types.SpaceView3D.draw_handler_remove(self.handle, "WINDOW")
        context.area.header_text_set(None)
        context.area.tag_redraw()

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
                self._flush(context, rebuild=True)
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
            self._flush(context, rebuild=None)

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
        ob = self.grown_for(host)
        if ob is None:
            if self.stroke["erase"]:
                return
            ob = self.create(host, context.scene, self.template)
            if self.template is None:
                self.template = ob
        mw = host.matrix_world
        p = mw.inverted() @ loc
        n = (mw.to_3x3().transposed() @ nrm).normalized()
        strength = -brush.strength if self.stroke["erase"] else brush.strength
        self.pending.setdefault(ob.name, []).append((p[:], n[:], brush.radius, strength))
        self.fresh += 1

    def _flush(self, context, rebuild):
        """Write pending stamps into their objects. `rebuild` True always
        rebuilds, None rebuilds only an object whose last build was quick."""
        for name, new in self.pending.items():
            ob = bpy.data.objects.get(name)
            if ob is None or not new:
                continue
            me = self.stamps_mesh(ob)
            stamp_io.write(me, stamp_io.read(me).appended(new))
            if rebuild or self.build_ms(ob) < LIVE_BUDGET_MS:
                self.rebuild(ob)
        if rebuild:
            # Anything written earlier in the stroke but skipped as too slow.
            for name in list(self.pending):
                ob = bpy.data.objects.get(name)
                if ob is not None and not self.pending[name]:
                    self.rebuild(ob)
            self.pending = {}
        else:
            self.pending = {k: [] for k in self.pending}
        self.fresh = 0

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
        shader.uniform_float("viewportSize", gpu.state.viewport_get()[2:])
        shader.uniform_float("lineWidth", 2.0)
        if self.hover is not None:
            loc, nrm, _ob = self.hover
            erase = self.stroke["erase"] if self.stroke else self.erase
            shader.uniform_float("color", self.ERASE_COLOR if erase else self.COLOR)
            batch_for_shader(shader, "LINE_STRIP", {"pos": circle(loc, nrm, brush.radius)}).draw(shader)
        if brush.show_stamps:
            ob = self.active(context) or self.template
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
