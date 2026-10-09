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
        ob = ops.active_moss(context)
        col = layout.column(align=True)
        if ob is None:
            op = col.operator("moss.paint", text="Paint New Moss", icon="BRUSH_DATA")
            op.erase, op.new = False, True
        else:
            # Paint and Erase work on the selected moss; New Moss starts
            # another with its settings.
            row = col.row(align=True)
            op = row.operator("moss.paint", text="Paint Moss", icon="BRUSH_DATA")
            op.erase, op.new = False, False
            op = row.operator("moss.paint", text="Erase Moss", icon="X")
            op.erase, op.new = True, False
            op = col.operator("moss.paint", text="New Moss", icon="ADD")
            op.erase, op.new = False, True
        col.prop(brush, "radius")
        col.prop(brush, "strength")
        col.prop(brush, "spacing")
        col.prop(brush, "show_stamps")

        box = layout.box()
        if ob is None:
            on = ops.mosses_of(context.active_object)
            if on:
                box.label(text=f"Moss on {context.active_object.name}:")
                for m in on:
                    box.operator("moss.select", text=m.name, icon="RESTRICT_SELECT_OFF").name = m.name
            else:
                box.label(text="No moss selected", icon="INFO")
        else:
            s = ob.moss
            box.label(text=ob.name, icon="OUTLINER_OB_MESH")
            names = ops.host_names(s)
            col = box.column(align=True)
            col.label(text=f"On {names[0]}" if len(names) == 1 else f"On {len(names)} objects, as one:")
            if len(names) > 1:
                for n in names:
                    col.label(text=n, icon="DOT")
            n_sel = sum(1 for o in context.selected_objects if ops.is_moss(o))
            if n_sel > 1:
                box.operator("moss.merge", text=f"Merge {n_sel} Selected into This", icon="AUTOMERGE_ON")
            if s.status:
                box.label(text=s.status, icon="ERROR")
            box.row(align=True).prop(s, "kind", expand=True)
            if s.kind == "TEXTURE":
                box.label(text="Painted into the rock on export", icon="TEXTURE")
            col = box.column(align=True)
            col.prop(s, "detail", slider=True)
            if s.detail != 1.0:
                col.label(text=f"Dabs {s.dab_min / s.detail * 100:.1f}-{s.dab_max / s.detail * 100:.1f} cm at this detail")
            if not s.status:
                took = f"{s.build_ms / 1000:.1f} s" + (", growth reused" if s.reused else "")
                col = box.column(align=True)
                if s.kind == "TEXTURE":
                    col.label(text=f"{s.dabs:,} dabs")
                    col.label(text=f"Rock map texels: {s.texel_used * 1000:.1f} mm")
                else:
                    col.label(text=f"{s.triangles:,} tris, {s.dabs:,} dabs, {s.texture} px")
                col.label(text=took)
                if s.layer_dabs:
                    col.label(text="Dabs per layer:")
                    col.label(text=s.layer_dabs)
                if s.heights:
                    col.label(text="Height (mm) by tone:")
                    col.label(text=s.heights)
            n = len(ops.selected_moss(context))
            row = box.row(align=True)
            row.prop(s, "live")
            op = row.operator("moss.rebuild", text="Rebuild" if n < 2 else f"Rebuild ({n})", icon="FILE_REFRESH")
            op.all = False
            op.regrow = False
            row = box.row(align=True)
            row.operator("moss.clear", icon="TRASH")
            row.operator("moss.copy_settings", text="Copy to Selected", icon="COPYDOWN")
        op = layout.operator("moss.rebuild", text="Rebuild All", icon="FILE_REFRESH")
        op.all = True
        op.regrow = False


class _Sub:
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Moss"
    bl_parent_id = "MOSS_PT_main"

    @classmethod
    def poll(cls, context):
        return ops.active_moss(context) is not None


class MOSS_PT_quality(_Sub, bpy.types.Panel):
    bl_label = "Quality"

    # A texture-only moss has no mesh, and its print is the rock's baked
    # colour map, whose texel the decal previews (ops._Inputs): nothing here
    # applies to it.
    @classmethod
    def poll(cls, context):
        ob = ops.active_moss(context)
        return ob is not None and ob.moss.kind == "MOUND"

    def draw(self, context):
        layout = self.layout
        s = ops.active_moss(context).moss
        col = layout.column(align=True)
        col.prop(s, "mound_density")
        if s.triangles and s.area > 0:
            col.label(text=f"{s.triangles:,} tris, {s.triangles / s.area:,.0f} / m²")
        col = layout.column(align=True)
        col.prop(s, "texel")
        col.label(text="Max Texture")
        col.row(align=True).prop(s, "max_texture", expand=True)
        if s.texture and s.texel_used > 0:
            col.label(text=f"{s.texture} px, {s.texel_used * 1000:.2f} mm texels")
            if s.texel_used > s.texel * 1.001:
                col.label(text="Capped: raise Max Texture", icon="INFO")


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

    @classmethod
    def poll(cls, context):
        ob = ops.active_moss(context)
        return ob is not None and ob.moss.kind == "MOUND"

    def draw(self, context):
        s = ops.active_moss(context).moss
        _grid(self.layout, s, ("floor", "lift", "up_floor", "height_blur", "rim", "drape"))


class MOSS_PT_edge(_Sub, bpy.types.Panel):
    bl_label = "Edge"

    def draw(self, context):
        s = ops.active_moss(context).moss
        if s.kind == "MOUND":
            _grid(self.layout, s, ("edge_round", "overhang", "edge_detail"))
        _grid(self.layout, s, ("strays", "stray_reach"))


class MOSS_PT_grass(_Sub, bpy.types.Panel):
    bl_label = "Grass"

    @classmethod
    def poll(cls, context):
        ob = ops.active_moss(context)
        return ob is not None and ob.moss.kind == "MOUND"

    def draw(self, context):
        s = ops.active_moss(context).moss
        _grid(self.layout, s, ("grass", "grass_height", "grass_blades", "grass_tip"))


class MOSS_PT_mesh(_Sub, bpy.types.Panel):
    bl_label = "Mesh and Print"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        s = ops.active_moss(context).moss
        _grid(self.layout, s, ("min_patch", "print_edge"))


CLASSES = (MOSS_PT_main, MOSS_PT_quality, MOSS_PT_dabs, MOSS_PT_tone, MOSS_PT_height, MOSS_PT_edge, MOSS_PT_grass, MOSS_PT_mesh)
