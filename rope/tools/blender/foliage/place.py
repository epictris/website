"""Planting by hand, and the overlay that shows how a plant is aimed.

Add Fern / Add Hanging Vine: press on a mesh where the plant's root goes,
drag to aim it (the way a fern leans open, the way a vine sets off) and
release; a click without a drag takes a sensible aim (a fern opens to the side
most rays escape to, a vine sets off downhill). Ctrl+click on a plant's root
removes it, Escape or right-click ends. Afterwards a plant is moved with G,
turned with R (about its own Z to re-aim it) and sized with S like any object.

The overlay draws every selected plant's root, normal and aim, so turning one
with R shows where it is pointed before it has grown again."""

import bpy
import gpu
from bpy_extras import view3d_utils
from gpu_extras.batch import batch_for_shader
from mathutils.geometry import intersect_line_plane

from . import ops
from .stampbrush import brush
from .surface import DOWN, FORWARD, Surface, tangent_on

PICK = 0.25  # Ctrl+click within this (m) of a root removes the plant
DRAG = 0.02  # a drag shorter than this (m) on the surface is a click
AIM = (0.75, 1.0, 0.4, 0.95)
REMOVE = (1.0, 0.35, 0.3, 0.9)


def nearest_plant(at, within):
    best, bd = None, within
    for ob in ops.plants():
        d = (ob.matrix_world.translation - at).length
        if d < bd:
            best, bd = ob, d
    return best


def default_aim(kind, host, at, normal, context):
    """A fern opens to its spot's open side; a vine sets off downhill (or toward
    the camera on a flat top)."""
    if kind == "FERN":
        surface = Surface.from_object(host, context.evaluated_depsgraph_get())
        _score, aim = ops.open_side(surface, at, normal)
    else:
        aim = DOWN - normal * DOWN.dot(normal)
        if aim.length_squared < 0.01:
            aim = FORWARD - normal * FORWARD.dot(normal)
    return aim.normalized() if aim.length_squared > 1e-8 else tangent_on(FORWARD, normal)


class FOLIAGE_OT_place(bpy.types.Operator):
    bl_idname = "foliage.place"
    bl_label = "Add Plant"
    bl_description = (
        "Press on a mesh where the plant's root goes, drag to aim it and release; Ctrl+click a root to remove "
        "its plant; Esc to finish. Afterwards move (G), turn (R) or size (S) a plant like any object"
    )
    bl_options = {"REGISTER", "UNDO"}

    kind: bpy.props.EnumProperty(items=(("FERN", "Fern", ""), ("VINE", "Hanging Vine", "")))

    @classmethod
    def poll(cls, context):
        return brush.in_viewport(context)

    def invoke(self, context, event):
        active = ops.active_plant(context)
        self.template = active if active is not None and active.foliage.kind == self.kind else None
        self.hover = None
        self.press = None  # (point, normal, host) where the button went down
        self.aim = None
        self.ctrl = False
        self.handle = bpy.types.SpaceView3D.draw_handler_add(self._draw, (context,), "WINDOW", "POST_VIEW")
        context.window_manager.modal_handler_add(self)
        name = "Fern" if self.kind == "FERN" else "Hanging vine"
        context.area.header_text_set(f"{name}   LMB press at the root, drag to aim, release   Ctrl+LMB remove a plant   Esc/RMB done")
        return {"RUNNING_MODAL"}

    def _finish(self, context):
        bpy.types.SpaceView3D.draw_handler_remove(self.handle, "WINDOW")
        context.area.header_text_set(None)
        context.area.tag_redraw()

    def _aim_at(self, context, coord):
        """Where the cursor's ray meets the pressed point's tangent plane, as a
        direction in that plane, or None for no drag."""
        at, normal, _host = self.press
        region, rv3d = context.region, context.region_data
        origin = view3d_utils.region_2d_to_origin_3d(region, rv3d, coord)
        ray = view3d_utils.region_2d_to_vector_3d(region, rv3d, coord)
        hit = intersect_line_plane(origin, origin + ray, at, normal)
        if hit is None:
            return None
        d = hit - at
        d -= normal * d.dot(normal)
        return d if d.length > DRAG else None

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
            if self.press is not None:
                self.aim = self._aim_at(context, coord)
            else:
                self.hover = brush.cast(context, coord) if inside else None
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE" and event.value == "PRESS":
            if not inside:
                return {"PASS_THROUGH"}
            hit = brush.cast(context, coord)
            if event.ctrl:
                at = hit[0] if hit is not None else None
                plant = nearest_plant(at, PICK) if at is not None else None
                if plant is not None:
                    me = plant.data
                    bpy.data.objects.remove(plant)
                    if me.users == 0:
                        bpy.data.meshes.remove(me)
                    bpy.ops.ed.undo_push(message="Remove plant")
                return {"RUNNING_MODAL"}
            if hit is not None:
                self.press = hit
                self.aim = None
            return {"RUNNING_MODAL"}
        if event.type == "LEFTMOUSE" and event.value == "RELEASE" and self.press is not None:
            at, normal, host = self.press
            aim = self.aim if self.aim is not None else default_aim(self.kind, host, at, normal, context)
            ob = ops.create_plant(self.kind, host, context.scene, at, normal, aim, self.template)
            if self.template is None:
                self.template = ob
            if ops.rebuild(ob) is None:
                self.report({"WARNING"}, f"{ob.name}: {ob.foliage.status}")
            for later in ops.later_touched(ob, (ops.world_bounds(ob),)):
                ops.schedule_rebuild(later)
            ops.remember()
            for o in context.selected_objects:
                o.select_set(False)
            ob.select_set(True)
            context.view_layer.objects.active = ob
            bpy.ops.ed.undo_push(message="Add plant")
            self.press = self.aim = None
            return {"RUNNING_MODAL"}
        if not inside:
            return {"PASS_THROUGH"}
        return {"RUNNING_MODAL"}

    def _draw(self, context):
        shader = gpu.shader.from_builtin("POLYLINE_UNIFORM_COLOR")
        gpu.state.blend_set("ALPHA")
        gpu.state.depth_test_set("NONE")
        shader.uniform_float("viewportSize", gpu.state.viewport_get()[2:])
        shader.uniform_float("lineWidth", 2.0)
        if self.press is not None:
            at, normal, _host = self.press
            shader.uniform_float("color", AIM)
            _ring(shader, at, normal, 0.04)
            if self.aim is not None:
                _arrow(shader, at, normal, self.aim.normalized(), max(0.12, self.aim.length))
        elif self.hover is not None:
            at, normal, _host = self.hover
            if self.ctrl:
                near = nearest_plant(at, PICK)
                shader.uniform_float("color", REMOVE)
                _ring(shader, near.matrix_world.translation if near is not None else at, normal, 0.06)
            else:
                shader.uniform_float("color", AIM)
                _ring(shader, at, normal, 0.04)
                _line(shader, at, at + normal * 0.08)
        gpu.state.blend_set("NONE")


def _line(shader, a, b):
    batch_for_shader(shader, "LINE_STRIP", {"pos": [a, b]}).draw(shader)


def _ring(shader, centre, normal, radius):
    batch_for_shader(shader, "LINE_STRIP", {"pos": brush.circle(centre, normal, radius)}).draw(shader)


def _arrow(shader, at, normal, d, length):
    tip = at + d * length
    side = d.cross(normal).normalized() * (length * 0.12)
    _line(shader, at + normal * 0.003, tip)
    _line(shader, tip, tip - d * (length * 0.18) + side)
    _line(shader, tip, tip - d * (length * 0.18) - side)


# --------------------------------------------------------------------------
# The overlay: each selected plant's root ring, its normal and its aim.

_overlay = None


def _draw_overlay():
    context = bpy.context
    if context.mode != "OBJECT":
        return
    chosen = [ob for ob in context.selected_objects if ops.is_plant(ob)]
    if not chosen:
        return
    shader = gpu.shader.from_builtin("POLYLINE_UNIFORM_COLOR")
    gpu.state.blend_set("ALPHA")
    gpu.state.depth_test_set("NONE")
    shader.uniform_float("viewportSize", gpu.state.viewport_get()[2:])
    shader.uniform_float("lineWidth", 2.0)
    shader.uniform_float("color", AIM)
    for ob in chosen:
        at, normal, aim, scale = ops.anchor(ob)
        size = 0.15 * scale
        _ring(shader, at, normal, size * 0.25)
        _line(shader, at, at + normal * size * 0.6)
        _arrow(shader, at, normal, aim, size)
    gpu.state.blend_set("NONE")


def register_overlay():
    global _overlay
    if _overlay is None and not bpy.app.background:
        _overlay = bpy.types.SpaceView3D.draw_handler_add(_draw_overlay, (), "WINDOW", "POST_VIEW")


def unregister_overlay():
    global _overlay
    if _overlay is not None:
        bpy.types.SpaceView3D.draw_handler_remove(_overlay, "WINDOW")
        _overlay = None


CLASSES = (FOLIAGE_OT_place,)
