"""The ivy brush and the vine placer: modal operators in the 3D viewport.

Paint Ivy and Erase Ivy are the shared stamp brush (stampbrush/brush.py, also the
moss add-on's): left-drag paints on whatever mesh is under the cursor, Ctrl+left-
drag erases, [ and ] resize, Escape (or right-click, or Enter) ends; Erase Ivy is
the same brush the other way round. Every stroke lays stamps on the selected ivy;
with none selected, or from New Ivy, the first stroke creates one with the
settings of the ivy the panel showed when painting began. The paint joins every
rock it reaches to the ivy, which grows over them as one. Anything grown (ivy or
moss) is transparent to the brush.

Place Vines: a click on a mesh hangs a vine of the selected ivy from that point
(an arrow Empty parented to the ivy, see ops.create_vine), creating an ivy if
none is selected and joining the mesh to it; Ctrl+click on an anchor removes it.

Set Origin: a click puts the selected ivy's origin, the point its carpet grows
out from, there (a sphere Empty, see ops.set_origin); Ctrl+click removes it, so
the carpet grows from the top of its paint again."""

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

    def hosts_of(self, ob):
        return ops.hosts_of(ob)

    def join(self, ob, host):
        ops.join(ob, host)

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

    def coverage_threshold(self, ob):
        return ob.ivy.threshold  # the preview leaves out the lobed edge noise


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
        self.target = self.template.name if self.template is not None else None  # by name: an undo replaces objects
        self.hover = None
        self.ctrl = False
        self.handle = bpy.types.SpaceView3D.draw_handler_add(self._draw, (context,), "WINDOW", "POST_VIEW")
        context.window_manager.modal_handler_add(self)
        self._header(context)
        return {"RUNNING_MODAL"}

    def _header(self, context):
        into = self.target or "a new ivy"
        context.area.header_text_set(f"Vines of {into}   LMB place a vine   Ctrl+LMB remove the nearest   Esc/RMB done")

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
        ivy = bpy.data.objects.get(self.target) if self.target else None
        if ivy is None:
            # A vine with no ivy selected: a new ivy holds the vine's leaves
            # and settings, with nothing painted, and is selected so the next
            # vine is its too.
            ivy = ops.create_ivy(host, context.scene, self.template)
            self.target = ivy.name
            for o in context.selected_objects:
                o.select_set(False)
            ivy.select_set(True)
            context.view_layer.objects.active = ivy
            self._header(context)
        ops.join(ivy, host)  # the vine hangs in front of the rock it is placed on
        ops.create_vine(ivy, context.scene, loc, ivy.ivy.vine_length)
        ops.rebuild(ivy)

    def _remove(self, context, loc):
        vine = ops.nearest_vine(loc, VINE_PICK)
        if vine is None:
            return
        ivy = vine.parent
        bpy.data.objects.remove(vine)
        if ops.is_ivy(ivy):
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
        "Click a mesh to put the point the selected ivy grows out from there: every leaf points away from it and "
        "lies over the leaf beyond it. Ctrl+click removes the origin (the carpet then grows from the top of its "
        "paint), Esc finishes. Afterwards move the origin with G like any object"
    )
    bl_options = {"REGISTER", "UNDO"}

    @classmethod
    def poll(cls, context):
        return brush.in_viewport(context) and ops.active_ivy(context) is not None

    def invoke(self, context, event):
        self.target = ops.active_ivy(context).name  # by name: an undo replaces objects
        self.hover = None
        self.ctrl = False
        self.handle = bpy.types.SpaceView3D.draw_handler_add(self._draw, (context,), "WINDOW", "POST_VIEW")
        context.window_manager.modal_handler_add(self)
        context.area.header_text_set(f"Origin of {self.target}   LMB set it   Ctrl+LMB remove it   Esc/RMB done")
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
            loc, _nrm, _host = hit
            ivy = bpy.data.objects.get(self.target)
            if not ops.is_ivy(ivy):
                self._finish(context)
                return {"CANCELLED"}
            if event.ctrl:
                origin = ops.origin_object(ivy)
                if origin is not None:
                    bpy.data.objects.remove(origin)
            else:
                ops.set_origin(ivy, context.scene, loc)
            ops.rebuild(ivy)
            bpy.ops.ed.undo_push(message="Ivy origin")
            return {"RUNNING_MODAL"}
        if not inside:
            return {"PASS_THROUGH"}
        return {"RUNNING_MODAL"}

    def _draw(self, context):
        if self.hover is None:
            return
        loc, nrm, _host = self.hover
        shader = gpu.shader.from_builtin("POLYLINE_UNIFORM_COLOR")
        gpu.state.blend_set("ALPHA")
        gpu.state.depth_test_set("NONE")
        shader.uniform_float("viewportSize", gpu.state.viewport_get()[2:])
        shader.uniform_float("lineWidth", 2.0)
        ivy = bpy.data.objects.get(self.target)
        current = ops.origin_object(ivy) if ops.is_ivy(ivy) else None
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
