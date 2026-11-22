"""The Game tab in the 3D viewport's sidebar (N)."""

import bpy

from . import camera, look, model_preview, outlines
from .formations_addon import core


class GAME_PT_main(bpy.types.Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Game"
    bl_label = "Game"

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        busy = core.busy()
        cam = camera.game_camera(scene)
        box = layout.box()
        box.label(text="Model lighting")
        river = model_preview.is_river(scene) and scene.game_lighting
        box.operator("game.preview_river_lighting", icon="SHADING_RENDERED",
                     text="Refresh River Lighting" if river else "Preview River Lighting")
        if river:
            box.label(text="River (ball) environment")
            box.operator("game.restore_scene_lighting", icon="LOOP_BACK")
        if scene.get(look.ERROR):
            box.label(text=scene[look.ERROR], icon="ERROR")
        if cam is not None:
            box = layout.box()
            box.operator("game.look", icon="VIEW_CAMERA")
            row = box.row(align=True)
            row.operator("game.ride", text="", icon="PLAY_REVERSE").direction = "BACK"
            row.operator("game.ride", text="", icon="PAUSE").direction = "PAUSE"
            row.operator("game.ride", text="", icon="PLAY").direction = "FORWARD"
            row.prop(scene, "frame_current", text="Frame")
            box.label(text=str(cam.get("game_source", "")))
            row = box.row(align=True)
            row.prop(scene, "game_lighting", text="River lighting" if model_preview.is_river(scene) else "Lighting", toggle=True)
            row.prop(scene, "game_fog", toggle=True)
            # "Depth of Field" is cut short at the sidebar's width.
            row.prop(scene, "game_dof", text="DoF", toggle=True)
            box.operator("game.bake_emission_preview", icon="SHADING_RENDERED")
            box.label(text="Cycles: actual mesh emission")
            if scene.get(look.ERROR):
                box.label(text=scene[look.ERROR], icon="ERROR")
            elif look.enabled(scene):
                box.label(text="Use Rendered shading for Cycles")
                if scene.game_fog:
                    box.label(text="Fog: game camera view only")
                    if context.space_data.region_3d.view_perspective != "CAMERA":
                        box.label(text="Click Look Through Game Camera", icon="INFO")
        if busy:
            layout.label(text=core.rebuild_progress, icon="TIME")

        if cam is None and not outlines.collision_outlines(scene):
            return
        box = layout.box()
        box.enabled = not busy and cam is not None
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
        row.prop(scene, "game_outline_opacity", slider=True)
        # Only a shown outline can be picked.
        row = box.row()
        row.enabled = have and scene.game_outline_opacity > 0
        row.operator("game.guide_from_outline", icon="EYEDROPPER")


CLASSES = (GAME_PT_main,)
