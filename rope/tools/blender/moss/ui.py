"""The Moss tab in the 3D viewport's sidebar (N)."""

import bpy

from . import ops


def _grid(layout, s, names):
    col = layout.column(align=True)
    for n in names:
        col.prop(s, n)


class MOSS_PT_main(bpy.types.Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Moss"
    bl_label = "Moss"

    def draw(self, context):
        layout = self.layout
        brush = context.scene.moss_brush
        col = layout.column(align=True)
        row = col.row(align=True)
        row.operator("moss.paint", text="Paint Moss", icon="BRUSH_DATA").erase = False
        row.operator("moss.paint", text="Erase Moss", icon="X").erase = True
        col.prop(brush, "radius")
        col.prop(brush, "strength")
        col.prop(brush, "spacing")
        col.prop(brush, "show_stamps")

        ob = ops.active_moss(context)
        box = layout.box()
        if ob is None:
            box.label(text="Paint a mesh, or select a moss or its host", icon="INFO")
        else:
            s = ob.moss
            box.label(text=s.host, icon="OUTLINER_OB_MESH")
            if s.status:
                box.label(text=s.status, icon="ERROR")
            else:
                box.label(text=f"{s.triangles:,} tris, {s.dabs:,} dabs, print {s.texture} px, {s.build_ms / 1000:.1f} s")
                if s.layer_dabs:
                    box.label(text=f"dabs per layer: {s.layer_dabs}")
                if s.heights:
                    box.label(text=f"mm over the rock by tone: {s.heights}")
            row = box.row(align=True)
            row.prop(s, "live")
            row.operator("moss.rebuild", icon="FILE_REFRESH").all = False
            row = box.row(align=True)
            row.operator("moss.clear", icon="TRASH")
            row.operator("moss.copy_settings", text="Copy to Selected", icon="COPYDOWN")
        layout.operator("moss.rebuild", text="Rebuild All", icon="FILE_REFRESH").all = True


class _Sub:
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Moss"
    bl_parent_id = "MOSS_PT_main"

    @classmethod
    def poll(cls, context):
        return ops.active_moss(context) is not None


class MOSS_PT_dabs(_Sub, bpy.types.Panel):
    bl_label = "Dabs"

    def draw(self, context):
        s = ops.active_moss(context).moss
        _grid(self.layout, s, ("seed", "resolution", "threshold"))
        _grid(self.layout, s, ("dab_min", "dab_max", "layers", "shrink", "buffer", "first_buffer", "min_clump"))


class MOSS_PT_tone(_Sub, bpy.types.Panel):
    bl_label = "Tone"

    def draw(self, context):
        s = ops.active_moss(context).moss
        _grid(self.layout, s, ("dark", "light", "levels"))
        _grid(self.layout, s, ("ref_depth", "steps_deep", "erode_scale", "field_mix", "curve", "mottle", "mottle_scale"))


class MOSS_PT_height(_Sub, bpy.types.Panel):
    bl_label = "Height"

    def draw(self, context):
        s = ops.active_moss(context).moss
        _grid(self.layout, s, ("floor", "lift", "up_floor", "height_blur", "sink", "rim", "inner_u"))


class MOSS_PT_mesh(_Sub, bpy.types.Panel):
    bl_label = "Mesh and Print"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        s = ops.active_moss(context).moss
        _grid(self.layout, s, ("mound_density", "min_patch", "texel", "max_texture", "print_edge"))


CLASSES = (MOSS_PT_main, MOSS_PT_dabs, MOSS_PT_tone, MOSS_PT_height, MOSS_PT_mesh)
