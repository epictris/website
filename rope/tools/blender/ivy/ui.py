"""The Ivy tab in the 3D viewport's sidebar (N)."""

import bpy

from . import ops


def _grid(layout, s, names):
    col = layout.column(align=True)
    for n in names:
        col.prop(s, n)


class IVY_PT_main(bpy.types.Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Ivy"
    bl_label = "Ivy"

    def draw(self, context):
        layout = self.layout
        brush = context.scene.ivy_brush
        ob = ops.active_ivy(context)
        col = layout.column(align=True)
        if ob is None:
            op = col.operator("ivy.paint", text="Paint New Ivy", icon="BRUSH_DATA")
            op.erase, op.new = False, True
        else:
            # Paint and Erase work on the selected ivy; New Ivy starts
            # another with its settings.
            row = col.row(align=True)
            op = row.operator("ivy.paint", text="Paint Ivy", icon="BRUSH_DATA")
            op.erase, op.new = False, False
            op = row.operator("ivy.paint", text="Erase Ivy", icon="X")
            op.erase, op.new = True, False
            op = col.operator("ivy.paint", text="New Ivy", icon="ADD")
            op.erase, op.new = False, True
        col.prop(brush, "radius")
        col.prop(brush, "strength")
        col.prop(brush, "spacing")
        col.prop(brush, "show_stamps")
        # Here as well as in the Vines panel, which only shows for an ivy: with
        # none selected, the first vine starts a new one.
        layout.operator("ivy.place_vines", icon="CURVE_PATH")

        box = layout.box()
        if ob is None:
            on = ops.ivies_of(context.active_object)
            if on:
                box.label(text=f"Ivy on {context.active_object.name}:")
                for i in on:
                    box.operator("ivy.select", text=i.name, icon="RESTRICT_SELECT_OFF").name = i.name
            else:
                box.label(text="No ivy selected", icon="INFO")
        else:
            s = ob.ivy
            box.label(text=ob.name, icon="OUTLINER_OB_MESH")
            names = ops.host_names(s)
            col = box.column(align=True)
            col.label(text=f"On {names[0]}" if len(names) == 1 else f"On {len(names)} objects, as one:")
            if len(names) > 1:
                for n in names:
                    col.label(text=n, icon="DOT")
            n_sel = sum(1 for o in context.selected_objects if ops.is_ivy(o))
            if n_sel > 1:
                box.operator("ivy.merge", text=f"Merge {n_sel} Selected into This", icon="AUTOMERGE_ON")
            if s.status:
                box.label(text=s.status, icon="ERROR")
            else:
                cards = f"{s.leaves:,} clumps" if s.detail == "CLUMPS" else f"{s.leaves:,} leaves"
                box.label(text=f"{s.triangles:,} tris, {cards}, {s.vine_count} vines, {s.build_ms:.0f} ms")
            row = box.row(align=True)
            row.prop(s, "live")
            row.operator("ivy.rebuild", icon="FILE_REFRESH").all = False
            row = box.row(align=True)
            row.operator("ivy.clear", icon="TRASH")
            row.operator("ivy.copy_settings", text="Copy to Selected", icon="COPYDOWN")
            box.operator("ivy.bake", icon="MESH_DATA")
        layout.operator("ivy.rebuild", text="Rebuild All", icon="FILE_REFRESH").all = True


class _Sub:
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Ivy"
    bl_parent_id = "IVY_PT_main"

    @classmethod
    def poll(cls, context):
        return ops.active_ivy(context) is not None


class IVY_PT_surface(_Sub, bpy.types.Panel):
    bl_label = "Carpet"

    def draw(self, context):
        ob = ops.active_ivy(context)
        s = ob.ivy
        self.layout.row().prop(s, "detail", expand=True)
        _grid(self.layout, s, ("seed", "resolution"))
        self.layout.label(text="Outline")
        _grid(self.layout, s, ("threshold", "edge_noise", "edge_scale", "min_patch", "rounding"))
        self.layout.label(text="Growth")
        origin = ops.origin_object(ob)
        self.layout.operator("ivy.set_origin", icon="EMPTY_AXIS")
        if origin is None:
            self.layout.label(text="No origin: the carpet grows from the top of its paint", icon="INFO")
        else:
            self.layout.label(text=f"{origin.name}; move it (G) or delete it (X)", icon="EMPTY_DATA")
        _grid(self.layout, s, ("thickness", "tilt", "spread", "taper"))
        if s.detail == "CLUMPS":
            self.layout.label(text="Clumps")
            _grid(self.layout, s, ("clump_min", "clump_max", "clump_fill", "edge_fill", "edge_round", "underlay"))
        else:
            self.layout.label(text="Leaves")
            _grid(self.layout, s, ("sheets", "leaf_min", "leaf_max", "leaf_fill", "edge_fill", "density", "edge_round", "underlay"))


class IVY_PT_vines(_Sub, bpy.types.Panel):
    bl_label = "Vines"

    def draw(self, context):
        ob = ops.active_ivy(context)
        s = ob.ivy
        n = len(ops.vine_objects(ob))
        self.layout.operator("ivy.place_vines", icon="CURVE_PATH")
        self.layout.label(text=f"{n} placed; move (G), lengthen (S) or delete (X) an anchor", icon="EMPTY_SINGLE_ARROW")
        if s.detail == "CLUMPS":
            self.layout.label(text="Clumps: each vine is one strand", icon="INFO")
            _grid(self.layout, s, ("vine_length",))
        else:
            _grid(self.layout, s, ("vine_length", "leaf_size", "leaf_tip"))


class IVY_PT_color(_Sub, bpy.types.Panel):
    bl_label = "Colour"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        s = ops.active_ivy(context).ivy
        _grid(self.layout, s, ("tone_a", "tone_b", "tone_c", "light", "shade", "tone_scale", "variation", "depth_shade"))


class IVY_PT_shadow(_Sub, bpy.types.Panel):
    bl_label = "Shadow"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        s = ops.active_ivy(context).ivy
        self.layout.label(text="A soft decal on the rock under and around the carpet", icon="LIGHT_SUN")
        _grid(self.layout, s, ("shadow_strength", "shadow_reach", "shadow_drop", "shadow_color"))


CLASSES = (IVY_PT_main, IVY_PT_surface, IVY_PT_vines, IVY_PT_color, IVY_PT_shadow)
