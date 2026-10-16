"""The Game tab in the 3D viewport's sidebar (N)."""

import bpy

from . import camera, look, outlines
from .formations_addon import core


class GAME_PT_main(bpy.types.Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Game"
    bl_label = "Game"

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        busy = bool(scene.get(core.BUSY))
        cam = camera.game_camera(scene)
        box = layout.box()
        if cam is None:
            box.label(text="No game camera", icon="ERROR")
            box.label(text="Run: just scene-guide <level>")
        else:
            box.operator("game.look", icon="VIEW_CAMERA")
            row = box.row(align=True)
            row.operator("game.ride", text="", icon="PLAY_REVERSE").direction = "BACK"
            row.operator("game.ride", text="", icon="PAUSE").direction = "PAUSE"
            row.operator("game.ride", text="", icon="PLAY").direction = "FORWARD"
            row.prop(scene, "frame_current", text="Frame")
            box.label(text=str(cam.get("game_source", "")))
            row = box.row(align=True)
            row.prop(scene, "game_lighting", toggle=True)
            row.prop(scene, "game_fog", toggle=True)
            # "Depth of Field" is cut short at the sidebar's width.
            row.prop(scene, "game_dof", text="DoF", toggle=True)
            if scene.get(look.ERROR):
                box.label(text=scene[look.ERROR], icon="ERROR")
            elif look.enabled(scene):
                box.label(text="Shows in Rendered shading")
        if busy:
            layout.label(text=scene.get("formations_progress", "Working..."), icon="TIME")

        box = layout.box()
        box.enabled = not busy
        box.label(text="Depth from the game camera")
        box.prop(scene, "game_depth_step", text="Step")
        box.prop(scene, "game_depth_keep_size")
        row = box.row(align=True)
        row.operator("game.depth", text="Forward").direction = -1
        row.operator("game.depth", text="Back").direction = 1

        box = layout.box()
        box.enabled = not busy
        box.label(text="Collision outlines (reference only)")
        have = bool(outlines.collision_outlines(scene))
        row = box.row()
        row.enabled = have
        row.prop(scene, "game_show_outlines", toggle=True,
                 icon="HIDE_OFF" if scene.game_show_outlines else "HIDE_ON")
        # Only a shown outline can be picked.
        row = box.row()
        row.enabled = have and scene.game_show_outlines
        row.operator("game.guide_from_outline", icon="EYEDROPPER")


CLASSES = (GAME_PT_main,)
