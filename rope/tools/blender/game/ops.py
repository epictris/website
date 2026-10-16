"""The Game panel's operators."""

from __future__ import annotations

import bpy
from bpy.props import EnumProperty, FloatProperty, StringProperty

from . import camera, depth, outlines
from .formations_addon import ops as formation_ops


def redraw(context):
    for window in context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()


class GAME_OT_look(bpy.types.Operator):
    """Make the game camera the scene camera and look through it from the start of its route"""
    bl_idname = "game.look"
    bl_label = "Look Through Game Camera"

    def execute(self, context):
        try:
            cam = camera.look_from_start(context)
            self.report({"INFO"}, f"Game camera: {cam.get('game_source', '')}")
            return {"FINISHED"}
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


class GAME_OT_ride(bpy.types.Operator):
    """Move the game camera along its route at the game's pace, or pause it"""
    bl_idname = "game.ride"
    bl_label = "Ride Game Camera"

    direction: EnumProperty(items=[("BACK", "Back", "Back along the route"), ("PAUSE", "Pause", "Hold the camera"),
                                   ("FORWARD", "Forward", "Forward along the route")])

    @classmethod
    def description(cls, context, properties):
        return {"BACK": "Ride the game camera back along its route", "PAUSE": "Pause the game camera",
                "FORWARD": "Ride the game camera forward along its route"}[properties.direction]

    def execute(self, context):
        camera.ride(context, {"BACK": -1, "PAUSE": 0, "FORWARD": 1}[self.direction])
        return {"FINISHED"}


class GAME_OT_guide_from_outline(bpy.types.Operator):
    """Copy one of the level's collision outlines into a new guide, to edit and build a formation from.
    Click an outline in the viewport; Shift+click for more, Esc or right-click ends"""
    bl_idname = "game.guide_from_outline"
    bl_label = "Create Guide from Outline"
    bl_options = {"REGISTER", "UNDO"}

    outline: StringProperty(name="Collision outline",
                            description="The outline to copy, by name; empty picks one in the viewport")

    def made(self, context, outline):
        guide = outlines.guide_from_outline(outline)
        if not self._made:
            if context.mode != "OBJECT":
                bpy.ops.object.mode_set(mode="OBJECT")
            bpy.ops.object.select_all(action="DESELECT")
        guide.select_set(True)
        context.view_layer.objects.active = guide
        self._made.append(guide.name)

    def execute(self, context):
        self._made = []
        try:
            ob = next((o for o in outlines.collision_outlines(context.scene) if o.name == self.outline), None)
            if ob is None:
                raise ValueError("No collision outline called " + repr(self.outline))
            self.made(context, ob)
            self.report({"INFO"}, "Guide created; edit it, then New Formation (Formations panel) builds from it")
            return {"FINISHED"}
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}

    def invoke(self, context, event):
        if self.outline:
            return self.execute(context)
        if not outlines.collision_outlines(context.scene):
            self.report({"ERROR"}, "No collision outlines: run `just scene-guide <level>` and reopen the file")
            return {"CANCELLED"}
        if not outlines.outlines_shown(context.scene):
            self.report({"ERROR"}, "The collision outlines are hidden: Show Collision Outlines first")
            return {"CANCELLED"}
        self._made, self._hover = [], ""
        self._draw = bpy.types.SpaceView3D.draw_handler_add(outlines.draw_hover, (self,), "WINDOW", "POST_PIXEL")
        context.window_manager.modal_handler_add(self)
        context.workspace.status_text_set("Click a collision outline to copy it into a guide   "
                                          "Shift+click: and keep picking   Esc / right-click: done")
        return {"RUNNING_MODAL"}

    def end(self, context):
        bpy.types.SpaceView3D.draw_handler_remove(self._draw, "WINDOW")
        context.workspace.status_text_set(None)
        redraw(context)
        if not self._made:
            return {"CANCELLED"}
        self.report({"INFO"}, f"Created {len(self._made)} guides; edit them, then New Formation builds from one")
        return {"FINISHED"}

    def modal(self, context, event):
        if event.type in {"MOUSEMOVE", "INBETWEEN_MOUSEMOVE"}:
            hover = outlines.outline_at(context, event.mouse_x, event.mouse_y)
            name = hover.name if hover else ""
            if name != self._hover:
                self._hover = name
                redraw(context)
            return {"PASS_THROUGH"}
        if event.value != "PRESS":
            return {"PASS_THROUGH"}
        if event.type in {"ESC", "RIGHTMOUSE"}:
            return self.end(context)
        if event.type != "LEFTMOUSE":
            return {"PASS_THROUGH"}
        if outlines.view_region_at(context, event.mouse_x, event.mouse_y) is None:
            # A click on the panel or elsewhere ends the pick and goes on.
            self.end(context)
            return {"FINISHED", "PASS_THROUGH"} if self._made else {"CANCELLED", "PASS_THROUGH"}
        outline = outlines.outline_at(context, event.mouse_x, event.mouse_y)
        if outline is None:
            self.report({"WARNING"}, "No collision outline there")
            return {"RUNNING_MODAL"}
        try:
            self.made(context, outline)
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"RUNNING_MODAL"}
        return {"RUNNING_MODAL"} if event.shift else self.end(context)


class GAME_OT_depth(bpy.types.Operator):
    """Move the selected formations away from or toward the game camera"""
    bl_idname = "game.depth"
    bl_label = "Move Depth"
    bl_options = {"REGISTER", "UNDO"}

    direction: FloatProperty(default=1)

    def execute(self, context):
        try:
            rocks = formation_ops.selected_formations(context)
            delta = self.direction * context.scene.game_depth_step
            count = depth.move_depth(context, rocks, delta, context.scene.game_depth_keep_size)
            redraw(context)
            self.report({"INFO"}, f"Moved {count} formations {'back' if delta > 0 else 'forward'}; replant their growth")
            return {"FINISHED"}
        except ValueError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


CLASSES = (GAME_OT_look, GAME_OT_ride, GAME_OT_guide_from_outline, GAME_OT_depth)
