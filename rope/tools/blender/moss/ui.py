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
        col.operator("moss.paint", icon="BRUSH_DATA")
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
                box.label(text=f"{s.triangles:,} tris ({s.curtain_triangles:,} curtain), {s.build_ms:.0f} ms")
            row = box.row(align=True)
            row.prop(s, "live")
            row.operator("moss.rebuild", icon="FILE_REFRESH").all = False
            row = box.row(align=True)
            row.operator("moss.clear", icon="TRASH")
            row.operator("moss.copy_settings", text="Copy to Selected", icon="COPYDOWN")
            box.operator("moss.bake", icon="MESH_DATA")
        layout.operator("moss.rebuild", text="Rebuild All", icon="FILE_REFRESH").all = True


class _Sub:
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Moss"
    bl_parent_id = "MOSS_PT_main"

    @classmethod
    def poll(cls, context):
        return ops.active_moss(context) is not None


class MOSS_PT_surface(_Sub, bpy.types.Panel):
    bl_label = "Cushion"

    def draw(self, context):
        s = ops.active_moss(context).moss
        _grid(self.layout, s, ("seed", "resolution"))
        self.layout.label(text="Outline")
        _grid(self.layout, s, ("threshold", "edge_noise", "edge_scale", "min_patch"))
        self.layout.label(text="Shape")
        _grid(self.layout, s, ("thickness", "edge_thickness", "feather", "rounding", "lump_amount", "lump_scale", "fuzz_amount", "fuzz_scale"))


class MOSS_PT_curtains(_Sub, bpy.types.Panel):
    bl_label = "Curtains"

    def draw_header(self, context):
        self.layout.prop(ops.active_moss(context).moss, "curtains", text="")

    def draw(self, context):
        s = ops.active_moss(context).moss
        self.layout.active = s.curtains
        _grid(self.layout, s, ("lip_drop", "curtain_length", "length_variation"))
        self.layout.label(text="Feathering")
        _grid(self.layout, s, ("finger_width", "finger_length", "finger_taper", "strand_density", "strand_length", "strand_width", "free_keep", "end_taper"))
        self.layout.label(text="Drape")
        _grid(self.layout, s, ("curtain_thickness", "thickness_taper", "bend_radius", "cling", "cling_reach", "hug", "sway"))


class MOSS_PT_color(_Sub, bpy.types.Panel):
    bl_label = "Colour"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        s = ops.active_moss(context).moss
        _grid(self.layout, s, ("texture_scale", "crown_color", "base_color", "tip_color", "color_variation"))


CLASSES = (MOSS_PT_main, MOSS_PT_surface, MOSS_PT_curtains, MOSS_PT_color)
