"""The moss brush and the vine placer: modal operators in the 3D viewport.

Paint Moss: left-drag paints on whatever mesh is under the cursor, Ctrl+left-
drag erases, [ and ] resize, Escape (or right-click, or Enter) ends. Erase
Moss is the same brush the other way round: left-drag erases, Ctrl+left-drag
paints. Navigation passes through.

Every stroke lays stamps (centre, surface normal, radius, signed strength) on
the moss object of the host it hit, creating one the first time a host is
painted - with the settings of the moss the panel showed when painting began,
so a style carries from rock to rock. Moss already grown is transparent to the
brush: the ray passes through it to the rock.

Place Vines: a click on a mesh hangs a vine from that point (an arrow Empty,
see ops.create_vine); Ctrl+click on an anchor removes it."""

import math

import bpy
import gpu
import numpy as np
from bpy_extras import view3d_utils
from gpu_extras.batch import batch_for_shader
from mathutils import Vector

from . import build, mesh_io, ops

LIVE_BUDGET_MS = 150.0  # rebuild during a stroke only while a build is this quick


def _paintable(ob):
    return (
        ob is not None
        and ob.type == "MESH"
        and not ops.is_moss(ob)
        and ob.library is None
        and ob.override_library is None
        and not any(c.name.lower().startswith("guide") or c.library is not None for c in ob.users_collection)
    )


def _cast(context, coord):
    region, rv3d = context.region, context.region_data
    origin = view3d_utils.region_2d_to_origin_3d(region, rv3d, coord)
    direction = view3d_utils.region_2d_to_vector_3d(region, rv3d, coord)
    depsgraph = context.evaluated_depsgraph_get()
    for _ in range(16):
        hit, loc, nrm, _i, ob, _m = context.scene.ray_cast(depsgraph, origin, direction)
        if not hit:
            return None
        ob = ob.original if ob is not None else None
        if _paintable(ob):
            return loc, nrm.normalized(), ob
        origin = loc + direction * 1e-4
    return None


def _circle(centre, normal, radius, n=48):
    a = Vector((1, 0, 0)) if abs(normal.x) < 0.9 else Vector((0, 1, 0))
    u = normal.cross(a).normalized()
    v = normal.cross(u)
    lift = normal * min(radius * 0.02, 0.005)
    return [centre + lift + (u * math.cos(t) + v * math.sin(t)) * radius for t in (2 * math.pi * k / n for k in range(n + 1))]


def _in_viewport(context):
    return context.area is not None and context.area.type == "VIEW_3D" and context.mode == "OBJECT"


class MOSS_OT_paint(bpy.types.Operator):
    bl_idname = "moss.paint"
    bl_label = "Paint Moss"
    bl_description = "Paint moss onto meshes in the viewport: drag to paint, Ctrl+drag to erase, [ ] radius, Esc to finish"
    bl_options = {"REGISTER", "UNDO"}

    erase: bpy.props.BoolProperty(name="Erase", default=False, options={"SKIP_SAVE"}, description="Start as the eraser: drag erases, Ctrl+drag paints")

    @classmethod
    def poll(cls, context):
        return _in_viewport(context)

    def invoke(self, context, event):
        self.template = ops.active_moss(context)
        self.hover = None
        self.stroke = None  # {"erase": bool, "last": Vector | None, "coord": (x, y)}
        self.pending = {}  # moss name -> list of stamps not yet written
        self.fresh = 0
        self.handle = bpy.types.SpaceView3D.draw_handler_add(self._draw, (context,), "WINDOW", "POST_VIEW")
        context.window_manager.modal_handler_add(self)
        self._header(context)
        return {"RUNNING_MODAL"}

    def _header(self, context):
        b = context.scene.moss_brush
        keys = "LMB erase   Ctrl+LMB paint" if self.erase else "LMB paint   Ctrl+LMB erase"
        context.area.header_text_set(f"Moss   {keys}   [ ] radius {b.radius:.3f} m   strength {b.strength:.2f}   Esc/RMB done")

    def _finish(self, context):
        self._flush(context, rebuild=True)
        bpy.types.SpaceView3D.draw_handler_remove(self.handle, "WINDOW")
        context.area.header_text_set(None)
        context.area.tag_redraw()

    def modal(self, context, event):
        brush = context.scene.moss_brush
        context.area.tag_redraw()
        if event.type in {"MIDDLEMOUSE", "WHEELUPMOUSE", "WHEELDOWNMOUSE", "TRACKPADPAN", "TRACKPADZOOM", "MOUSEROTATE", "MOUSESMARTZOOM"} or event.type.startswith(("NDOF", "NUMPAD")):
            return {"PASS_THROUGH"}
        # Only the viewport's main region paints; the header, sidebar and
        # toolbar keep working.
        region = context.region
        inside = 0 <= event.mouse_x - region.x < region.width and 0 <= event.mouse_y - region.y < region.height
        coord = (event.mouse_region_x, event.mouse_region_y)
        if event.type in {"ESC", "RIGHTMOUSE", "RET"} and event.value == "PRESS":
            self._finish(context)
            return {"FINISHED"}
        if event.type in {"LEFT_BRACKET", "RIGHT_BRACKET"} and event.value == "PRESS":
            brush.radius *= 0.8 if event.type == "LEFT_BRACKET" else 1.25
            self._header(context)
            return {"RUNNING_MODAL"}
        if event.type == "MOUSEMOVE":
            self.hover = _cast(context, coord) if inside else None
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
                bpy.ops.ed.undo_push(message="Moss stroke")
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
        hit = _cast(context, coord)
        if hit is None:
            return
        loc, nrm, host = hit
        brush = context.scene.moss_brush
        last = self.stroke["last"]
        if last is not None and (loc - last).length < brush.radius * brush.spacing:
            return
        self.stroke["last"] = loc.copy()
        moss = ops.moss_for_host(host)
        if moss is None:
            if self.stroke["erase"]:
                return
            moss = ops.create_moss(host, context.scene, self.template)
            if self.template is None:
                self.template = moss
        mw = host.matrix_world
        p = mw.inverted() @ loc
        n = (mw.to_3x3().transposed() @ nrm).normalized()
        strength = -brush.strength if self.stroke["erase"] else brush.strength
        self.pending.setdefault(moss.name, []).append((p[:], n[:], brush.radius, strength))
        self.fresh += 1

    def _flush(self, context, rebuild):
        """Write pending stamps into their moss objects. `rebuild` True always
        rebuilds, None rebuilds only a moss whose last build was quick."""
        for name, new in self.pending.items():
            ob = bpy.data.objects.get(name)
            if ob is None or not new:
                continue
            old = mesh_io.read_stamps(ob.moss.stamps)
            pos, nrm, rad, st = (np.array(x, dtype=np.float64) for x in zip(*new))
            merged = build.Stamps(
                np.concatenate([old.position, pos]),
                np.concatenate([old.normal, nrm]),
                np.concatenate([old.radius, rad]),
                np.concatenate([old.strength, st]),
            )
            mesh_io.write_stamps(ob.moss.stamps, merged)
            if rebuild or ob.moss.build_ms < LIVE_BUDGET_MS:
                ops.rebuild(ob)
        if rebuild:
            # Anything written earlier in the stroke but skipped as too slow.
            for name in list(self.pending):
                ob = bpy.data.objects.get(name)
                if ob is not None and not self.pending[name]:
                    ops.rebuild(ob)
            self.pending = {}
        else:
            self.pending = {k: [] for k in self.pending}
        self.fresh = 0

    # ----------------------------------------------------------------------

    def _draw(self, context):
        brush = context.scene.moss_brush
        shader = gpu.shader.from_builtin("POLYLINE_UNIFORM_COLOR")
        gpu.state.blend_set("ALPHA")
        # No depth test: the ring lies on the rock, and on a bumpy face (or the
        # moss already grown over it) half of it would sink out of sight.
        gpu.state.depth_test_set("NONE")
        shader.uniform_float("viewportSize", gpu.state.viewport_get()[2:])
        shader.uniform_float("lineWidth", 2.0)
        if self.hover is not None:
            loc, nrm, _ob = self.hover
            erase = self.stroke["erase"] if self.stroke else self.erase
            color = (1.0, 0.35, 0.3, 0.9) if erase else (0.7, 1.0, 0.35, 0.9)
            shader.uniform_float("color", color)
            batch_for_shader(shader, "LINE_STRIP", {"pos": _circle(loc, nrm, brush.radius)}).draw(shader)
        if brush.show_stamps:
            ob = ops.active_moss(context) or self.template
            if ob is not None:
                host = bpy.data.objects.get(ob.moss.host)
                st = mesh_io.read_stamps(ob.moss.stamps)
                if host is not None and len(st):
                    m = np.array(host.matrix_world)
                    w = st.position @ m[:3, :3].T + m[:3, 3]
                    pts = gpu.shader.from_builtin("POINT_UNIFORM_COLOR")
                    gpu.state.point_size_set(4.0)
                    pts.uniform_float("color", (0.9, 0.9, 0.3, 0.8))
                    batch_for_shader(pts, "POINTS", {"pos": [tuple(x) for x in w]}).draw(pts)
        gpu.state.depth_test_set("NONE")
        gpu.state.blend_set("NONE")


VINE_PICK = 0.25  # Ctrl+click within this (m) of an anchor removes it


class MOSS_OT_place_vines(bpy.types.Operator):
    bl_idname = "moss.place_vines"
    bl_label = "Place Vines"
    bl_description = (
        "Click a mesh to hang a vine from that point, Ctrl+click an anchor to remove it, Esc to finish. "
        "Afterwards move an anchor with G or lengthen it with S: the arrow's length is the vine's"
    )
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        return _in_viewport(context)

    def invoke(self, context, event):
        self.template = ops.active_moss(context)
        self.hover = None
        self.ctrl = False
        self.handle = bpy.types.SpaceView3D.draw_handler_add(self._draw, (context,), "WINDOW", "POST_VIEW")
        context.window_manager.modal_handler_add(self)
        context.area.header_text_set("Vines   LMB place a vine   Ctrl+LMB remove the nearest   Esc/RMB done")
        return {"RUNNING_MODAL"}

    def _finish(self, context):
        bpy.types.SpaceView3D.draw_handler_remove(self.handle, "WINDOW")
        context.area.header_text_set(None)
        context.area.tag_redraw()

    def modal(self, context, event):
        context.area.tag_redraw()
        if event.type in {"MIDDLEMOUSE", "WHEELUPMOUSE", "WHEELDOWNMOUSE", "TRACKPADPAN", "TRACKPADZOOM", "MOUSEROTATE", "MOUSESMARTZOOM"} or event.type.startswith(("NDOF", "NUMPAD")):
            return {"PASS_THROUGH"}
        region = context.region
        inside = 0 <= event.mouse_x - region.x < region.width and 0 <= event.mouse_y - region.y < region.height
        coord = (event.mouse_region_x, event.mouse_region_y)
        self.ctrl = event.ctrl
        if event.type in {"ESC", "RIGHTMOUSE", "RET"} and event.value == "PRESS":
            self._finish(context)
            return {"FINISHED"}
        if event.type == "MOUSEMOVE":
            self.hover = _cast(context, coord) if inside else None
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE" and event.value == "PRESS":
            if not inside:
                return {"PASS_THROUGH"}
            hit = _cast(context, coord)
            if hit is None:
                return {"RUNNING_MODAL"}
            loc, _nrm, host = hit
            if event.ctrl:
                self._remove(context, loc)
            else:
                self._place(context, host, loc)
            bpy.ops.ed.undo_push(message="Moss vine")
            return {"RUNNING_MODAL"}
        if not inside:
            return {"PASS_THROUGH"}
        return {"RUNNING_MODAL"}

    def _place(self, context, host, loc):
        moss = ops.moss_for_host(host)
        if moss is None:
            # A vine on a rock with no paint yet: the moss object holds the
            # vine's leaves and settings, with nothing painted.
            moss = ops.create_moss(host, context.scene, self.template)
            if self.template is None:
                self.template = moss
        ops.create_vine(host, context.scene, loc, moss.moss.vine_length)
        ops.rebuild(moss)

    def _remove(self, context, loc):
        vine = ops.nearest_vine(loc, VINE_PICK)
        if vine is None:
            return
        host = bpy.data.objects.get(vine[ops.VINE_PROP])
        bpy.data.objects.remove(vine)
        moss = ops.moss_for_host(host) if host is not None else None
        if moss is not None:
            ops.rebuild(moss)

    def _draw(self, context):
        if self.hover is None:
            return
        loc, nrm, _ob = self.hover
        shader = gpu.shader.from_builtin("POLYLINE_UNIFORM_COLOR")
        gpu.state.blend_set("ALPHA")
        gpu.state.depth_test_set("NONE")
        shader.uniform_float("viewportSize", gpu.state.viewport_get()[2:])
        shader.uniform_float("lineWidth", 2.0)
        near = ops.nearest_vine(loc, VINE_PICK) if self.ctrl else None
        if self.ctrl:
            shader.uniform_float("color", (1.0, 0.35, 0.3, 0.9))
            centre = near.matrix_world.translation if near is not None else loc
            batch_for_shader(shader, "LINE_STRIP", {"pos": _circle(centre, nrm, 0.06)}).draw(shader)
        else:
            shader.uniform_float("color", (0.7, 1.0, 0.35, 0.9))
            batch_for_shader(shader, "LINE_STRIP", {"pos": _circle(loc, nrm, 0.04)}).draw(shader)
            # The vine to come, as a plumb line.
            length = (self.template.moss.vine_length if self.template is not None else build.Params().vine_length)
            batch_for_shader(shader, "LINE_STRIP", {"pos": [loc, loc + Vector((0.0, 0.0, -length))]}).draw(shader)
        gpu.state.blend_set("NONE")


CLASSES = (MOSS_OT_paint, MOSS_OT_place_vines)
