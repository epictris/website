"""The Game tab in the 3D viewport's sidebar (N)."""

import bpy

from . import camera, edit, look, outlines
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
        box.label(text="Guides, as the game camera sees them")
        s = edit.state(scene)
        if s is None:
            box.operator("game.edit", text="Edit Guides", icon="EDITMODE_HLT").action = "START"
            box.label(text="The selected formations, or all")
        else:
            box.label(text=f"Projected from frame {s['frame']}")
            box.label(text="G moves, Tab: points or guides")
            row = box.row(align=True)
            row.operator("game.polygon", text="Copy").action = "COPY"
            paste = row.row(align=True)
            paste.enabled = bool(scene.get(edit.CLIPBOARD))
            paste.operator("game.polygon", text="Paste").action = "PASTE"
            row = box.row(align=True)
            row.operator("game.polygon", text="New").action = "NEW"
            row.operator("game.polygon", text="Delete").action = "DELETE"
            row = box.row(align=True)
            row.operator("game.polygon", text="Add Point").action = "ADD_POINT"
            row.operator("game.polygon", text="Remove Points").action = "REMOVE_POINT"
            row = box.row(align=True)
            row.operator("game.edit", text="Apply").action = "APPLY"
            row.operator("game.edit", text="Done").action = "FINISH"
            row.operator("game.edit", text="Discard").action = "DISCARD"
        # Formations' own: it applies the edits above first.
        pending = [ob for ob in core.formations() if core.pending(ob)]
        box.operator("formations.rebuild_changed", text=f"Rebuild Changed ({len(pending)})", icon="FILE_REFRESH")

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
