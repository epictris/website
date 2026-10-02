"""The ivy brush and the vine placer: modal operators in the 3D viewport.

Paint Ivy and Erase Ivy are the shared stamp brush (stampbrush/brush.py, also the
moss add-on's): left-drag paints on whatever mesh is under the cursor, Ctrl+left-
drag erases, [ and ] resize, Escape (or right-click, or Enter) ends; Erase Ivy is
the same brush the other way round. Every stroke lays stamps on the ivy object of
the host it hit, creating one the first time a host is painted - with the settings
of the ivy the panel showed when painting began, so a style carries from rock to
rock. Anything grown (ivy or moss) is transparent to the brush.

Place Vines: a click on a mesh hangs a vine from that point (an arrow Empty,
see ops.create_vine); Ctrl+click on an anchor removes it.

Set Origin: a click on a mesh puts the origin its carpet grows out from there
(a sphere Empty, see ops.set_origin); Ctrl+click removes it, so the carpet
grows from the top of its paint again."""

import bpy
import gpu
from gpu_extras.batch import batch_for_shader
from mathutils import Vector

from . import build, ops
from .stampbrush import brush
from .stampbrush.brush import StampBrush


class IVY_OT_paint(StampBrush, bpy.types.Operator):
    bl_idname = "ivy.paint"
    bl_label = "Paint Ivy"
    bl_description = "Paint ivy onto meshes in the viewport: drag to paint, Ctrl+drag to erase, [ ] radius, Esc to finish"
    bl_options = {"REGISTER", "UNDO"}

    LABEL = "Ivy"

    def brush(self, context):
        return context.scene.ivy_brush

    def active(self, context):
        return ops.active_ivy(context)

    def grown_for(self, host):
        return ops.ivy_for_host(host)

    def create(self, host, scene, template):
        return ops.create_ivy(host, scene, template)

    def stamps_mesh(self, ob):
        return ob.ivy.stamps

    def host_of(self, ob):
        return bpy.data.objects.get(ob.ivy.host)

    def rebuild(self, ob):
        ops.rebuild(ob)

    def build_ms(self, ob):
        return ob.ivy.build_ms


VINE_PICK = 0.25  # Ctrl+click within this (m) of an anchor removes it


class IVY_OT_place_vines(bpy.types.Operator):
    bl_idname = "ivy.place_vines"
    bl_label = "Place Vines"
    bl_description = (
        "Click a mesh to hang a vine from that point, Ctrl+click an anchor to remove it, Esc to finish. "
        "Afterwards move an anchor with G or lengthen it with S: the arrow's length is the vine's"
    )
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        return brush.in_viewport(context)

    def invoke(self, context, event):
        self.template = ops.active_ivy(context)
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
        if brush.is_navigation(event):
            return {"PASS_THROUGH"}
        inside = brush.inside_region(context, event)
        coord = (event.mouse_region_x, event.mouse_region_y)
        self.ctrl = event.ctrl
        if event.type in {"ESC", "RIGHTMOUSE", "RET"} and event.value == "PRESS":
            self._finish(context)
            return {"FINISHED"}
        if event.type == "MOUSEMOVE":
            self.hover = brush.cast(context, coord) if inside else None
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE" and event.value == "PRESS":
            if not inside:
                return {"PASS_THROUGH"}
            hit = brush.cast(context, coord)
            if hit is None:
                return {"RUNNING_MODAL"}
            loc, _nrm, host = hit
            if event.ctrl:
                self._remove(context, loc)
            else:
                self._place(context, host, loc)
            bpy.ops.ed.undo_push(message="Ivy vine")
            return {"RUNNING_MODAL"}
        if not inside:
            return {"PASS_THROUGH"}
        return {"RUNNING_MODAL"}

    def _place(self, context, host, loc):
        ivy = ops.ivy_for_host(host)
        if ivy is None:
            # A vine on a rock with no paint yet: the ivy object holds the
            # vine's leaves and settings, with nothing painted.
            ivy = ops.create_ivy(host, context.scene, self.template)
            if self.template is None:
                self.template = ivy
        ops.create_vine(host, context.scene, loc, ivy.ivy.vine_length)
        ops.rebuild(ivy)

    def _remove(self, context, loc):
        vine = ops.nearest_vine(loc, VINE_PICK)
        if vine is None:
            return
        host = bpy.data.objects.get(vine[ops.VINE_PROP])
        bpy.data.objects.remove(vine)
        ivy = ops.ivy_for_host(host) if host is not None else None
        if ivy is not None:
            ops.rebuild(ivy)

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
            batch_for_shader(shader, "LINE_STRIP", {"pos": brush.circle(centre, nrm, 0.06)}).draw(shader)
        else:
            shader.uniform_float("color", (0.7, 1.0, 0.35, 0.9))
            batch_for_shader(shader, "LINE_STRIP", {"pos": brush.circle(loc, nrm, 0.04)}).draw(shader)
            # The vine to come, as a plumb line.
            length = (self.template.ivy.vine_length if self.template is not None else build.Params().vine_length)
            batch_for_shader(shader, "LINE_STRIP", {"pos": [loc, loc + Vector((0.0, 0.0, -length))]}).draw(shader)
        gpu.state.blend_set("NONE")


class IVY_OT_set_origin(bpy.types.Operator):
    bl_idname = "ivy.set_origin"
    bl_label = "Set Origin"
    bl_description = (
        "Click a painted mesh to put the point its ivy grows out from there: every leaf points away from it and "
        "lies over the leaf beyond it. Ctrl+click removes the origin (the carpet then grows from the top of its "
        "paint), Esc finishes. Afterwards move the origin with G like any object"
    )
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        return brush.in_viewport(context)

    def invoke(self, context, event):
        self.hover = None
        self.ctrl = False
        self.handle = bpy.types.SpaceView3D.draw_handler_add(self._draw, (context,), "WINDOW", "POST_VIEW")
        context.window_manager.modal_handler_add(self)
        context.area.header_text_set("Origin   LMB set the origin of the ivy under the cursor   Ctrl+LMB remove it   Esc/RMB done")
        return {"RUNNING_MODAL"}

    def _finish(self, context):
        bpy.types.SpaceView3D.draw_handler_remove(self.handle, "WINDOW")
        context.area.header_text_set(None)
        context.area.tag_redraw()

    def modal(self, context, event):
        context.area.tag_redraw()
        if brush.is_navigation(event):
            return {"PASS_THROUGH"}
        inside = brush.inside_region(context, event)
        coord = (event.mouse_region_x, event.mouse_region_y)
        self.ctrl = event.ctrl
        if event.type in {"ESC", "RIGHTMOUSE", "RET"} and event.value == "PRESS":
            self._finish(context)
            return {"FINISHED"}
        if event.type == "MOUSEMOVE":
            self.hover = brush.cast(context, coord) if inside else None
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE" and event.value == "PRESS":
            if not inside:
                return {"PASS_THROUGH"}
            hit = brush.cast(context, coord)
            if hit is None:
                return {"RUNNING_MODAL"}
            loc, _nrm, host = hit
            ivy = ops.ivy_for_host(host)
            if ivy is None:
                self.report({"WARNING"}, f"{host.name} has no ivy: paint it first")
                return {"RUNNING_MODAL"}
            if event.ctrl:
                origin = ops.origin_object(host)
                if origin is not None:
                    bpy.data.objects.remove(origin)
            else:
                ops.set_origin(host, context.scene, loc)
            ops.rebuild(ivy)
            bpy.ops.ed.undo_push(message="Ivy origin")
            return {"RUNNING_MODAL"}
        if not inside:
            return {"PASS_THROUGH"}
        return {"RUNNING_MODAL"}

    def _draw(self, context):
        if self.hover is None:
            return
        loc, nrm, host = self.hover
        shader = gpu.shader.from_builtin("POLYLINE_UNIFORM_COLOR")
        gpu.state.blend_set("ALPHA")
        gpu.state.depth_test_set("NONE")
        shader.uniform_float("viewportSize", gpu.state.viewport_get()[2:])
        shader.uniform_float("lineWidth", 2.0)
        current = ops.origin_object(host)
        if self.ctrl:
            shader.uniform_float("color", (1.0, 0.35, 0.3, 0.9))
            centre = current.matrix_world.translation if current is not None else loc
            batch_for_shader(shader, "LINE_STRIP", {"pos": brush.circle(centre, nrm, 0.06)}).draw(shader)
        else:
            shader.uniform_float("color", (0.7, 1.0, 0.35, 0.9))
            batch_for_shader(shader, "LINE_STRIP", {"pos": brush.circle(loc, nrm, 0.04)}).draw(shader)
            # Spokes: the way the leaves will grow out from here.
            for tip in brush.circle(loc, nrm, 0.16, n=8)[:-1]:
                batch_for_shader(shader, "LINE_STRIP", {"pos": [loc + nrm * 0.003, tip]}).draw(shader)
        gpu.state.blend_set("NONE")


CLASSES = (IVY_OT_paint, IVY_OT_place_vines, IVY_OT_set_origin)
