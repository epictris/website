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
        # Here as well as in the Vines panel, which only shows for a moss: a
        # bare rock gets its first vine from here.
        layout.operator("moss.place_vines", icon="CURVE_PATH")

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
                box.label(text=f"{s.triangles:,} tris, {s.leaves:,} leaves, {s.vine_count} vines, {s.build_ms:.0f} ms")
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
    bl_label = "Carpet"

    def draw(self, context):
        ob = ops.active_moss(context)
        s = ob.moss
        _grid(self.layout, s, ("seed", "resolution"))
        self.layout.label(text="Outline")
        _grid(self.layout, s, ("threshold", "edge_noise", "edge_scale", "min_patch", "rounding"))
        self.layout.label(text="Growth")
        host = bpy.data.objects.get(s.host)
        origin = ops.origin_object(host) if host is not None else None
        self.layout.operator("moss.set_origin", icon="EMPTY_AXIS")
        if origin is None:
            self.layout.label(text="No origin: the carpet grows from the top of its paint", icon="INFO")
        else:
            self.layout.label(text=f"{origin.name}; move it (G) or delete it (X)", icon="EMPTY_DATA")
        _grid(self.layout, s, ("thickness", "tilt", "spread", "taper"))
        self.layout.label(text="Leaves")
        _grid(self.layout, s, ("sheets", "leaf_min", "leaf_max", "leaf_fill", "edge_fill", "density", "facing", "shoulder", "underlay"))


class MOSS_PT_vines(_Sub, bpy.types.Panel):
    bl_label = "Vines"

    def draw(self, context):
        ob = ops.active_moss(context)
        s = ob.moss
        host = bpy.data.objects.get(s.host)
        n = len(ops.vine_objects(host)) if host is not None else 0
        self.layout.operator("moss.place_vines", icon="CURVE_PATH")
        self.layout.label(text=f"{n} placed; move (G), lengthen (S) or delete (X) an anchor", icon="EMPTY_SINGLE_ARROW")
        _grid(self.layout, s, ("vine_length", "leaf_size", "leaf_tip"))


class MOSS_PT_color(_Sub, bpy.types.Panel):
    bl_label = "Colour"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        s = ops.active_moss(context).moss
        _grid(self.layout, s, ("tone_a", "tone_b", "tone_c", "light", "shade", "tone_scale", "variation", "depth_shade"))


class MOSS_PT_shadow(_Sub, bpy.types.Panel):
    bl_label = "Shadow"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        s = ops.active_moss(context).moss
        self.layout.label(text="A soft decal on the rock under and around the carpet", icon="LIGHT_SUN")
        _grid(self.layout, s, ("shadow_strength", "shadow_reach", "shadow_drop", "shadow_color"))


CLASSES = (MOSS_PT_main, MOSS_PT_surface, MOSS_PT_vines, MOSS_PT_color, MOSS_PT_shadow)
