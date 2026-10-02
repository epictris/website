"""The Formations tab in the 3D viewport's sidebar (N)."""

import bpy

from . import core, view


class FORMATIONS_PT_main(bpy.types.Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Formations"
    bl_label = "Formations"

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        layout.enabled = not scene.get("formations_busy", False)
        cam = view.game_camera(scene)
        box = layout.box()
        if cam is None:
            box.label(text="No game camera: just scene-guide <level>", icon="ERROR")
        else:
            box.operator("formations.look", icon="VIEW_CAMERA")
            box.label(text=str(cam.get("game_source", "")))
        if scene.get("formations_busy"):
            layout.label(text=scene.get("formations_progress", "Working..."), icon="TIME")

        box = layout.box()
        box.label(text="Outlines, as the game camera sees them")
        s = view.state(scene)
        if s is None:
            box.operator("formations.edit", text="Edit Outlines", icon="EDITMODE_HLT").action = "START"
            box.label(text="The selected formations, or all")
        else:
            box.label(text=f"Projected from frame {s['frame']}")
            box.label(text="G moves, Tab: points or outlines")
            row = box.row(align=True)
            row.operator("formations.polygon", text="Copy").action = "COPY"
            paste = row.row(align=True)
            paste.enabled = bool(scene.get(view.CLIPBOARD))
            paste.operator("formations.polygon", text="Paste").action = "PASTE"
            row = box.row(align=True)
            row.operator("formations.polygon", text="New").action = "NEW"
            row.operator("formations.polygon", text="Delete").action = "DELETE"
            row = box.row(align=True)
            row.operator("formations.polygon", text="Add Point").action = "ADD_POINT"
            row.operator("formations.polygon", text="Remove Points").action = "REMOVE_POINT"
            row = box.row(align=True)
            row.operator("formations.edit", text="Apply").action = "APPLY"
            row.operator("formations.edit", text="Done").action = "FINISH"
            row.operator("formations.edit", text="Discard").action = "DISCARD"
        pending = [ob for ob in core.formations() if core.pending(ob)]
        row = box.row()
        row.operator("formations.rebuild_changed", text=f"Rebuild Changed ({len(pending)})", icon="FILE_REFRESH")

        box = layout.box()
        box.label(text="Depth from the game camera")
        box.prop(scene, "formations_depth_step", text="Step")
        box.prop(scene, "formations_depth_keep_size")
        row = box.row(align=True)
        row.operator("formations.depth", text="Forward").direction = -1
        row.operator("formations.depth", text="Back").direction = 1

        box = layout.box()
        # Stale is decided by hashing each mesh, too slow for every redraw;
        # the export reports it, and Stale replants exactly those.
        box.label(text="Growth")
        row = box.row(align=True)
        row.operator("formations.plant", text="Selected").scope = "SELECTED"
        row.operator("formations.plant", text="Stale").scope = "STALE"
        row.operator("formations.plant", text="All").scope = "ALL"

        box = layout.box()
        box.label(text="Tone facets by orientation")
        row = box.row(align=True)
        row.operator("formations.tone_facets", text="Selected").scope = "SELECTED"
        row.operator("formations.tone_facets", text="All").scope = "ALL"

        layout.operator("formations.generate", text="New Formation", icon="ADD").mode = "CREATE"

        ob = context.active_object
        if core.is_formation(ob):
            box = layout.box()
            box.label(text=f"{ob.name}: {ob.get('formation_mode', 'PROCEDURAL').lower()}", icon="MESH_ICOSPHERE")
            box.prop(ob, "formation_attachment")
            box.prop(ob, "formation_moisture")
            row = box.row(align=True)
            row.operator("formations.generate", text="Rebuild").mode = "REBUILD"
            row.operator("formations.generate", text="New Variant").mode = "VARIANT"
            for key, title in (("OUTLINE", "Select Outline"), ("UNIQUE", "Make Unique"),
                               ("MANUAL", "Keep As Manual Mesh"), ("SOURCES", "Show Source Slabs"),
                               ("ASSEMBLE", "Assemble Edited Slabs")):
                box.operator("formations.action", text=title).action = key


CLASSES = (FORMATIONS_PT_main,)
