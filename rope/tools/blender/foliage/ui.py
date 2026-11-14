"""The Foliage tab in the 3D viewport's sidebar (N)."""

import bpy

from . import icons, library, ops
from .glowflora import PATCH_FIELDS
from .settings import BIOLUME_KINDS, KINDS, glow_prop


def _col(layout, s, names):
    col = layout.column(align=True)
    for n in names:
        col.prop(s, n)
    return col


def _picker(layout, s, prop, pieces, per_row=7):
    """A toggle for each of a set of pieces, under its thumbnail when there is one."""
    grid = layout.grid_flow(row_major=True, columns=per_row, even_columns=True)
    for i, piece in enumerate(pieces):
        col = grid.column(align=True)
        ic = icons.icon(piece.id)
        if ic:
            col.template_icon(icon_value=ic, scale=1.6)
            col = col.row(align=True)
            col.scale_y = 0.4  # a bar under the thumbnail, lit when the piece is chosen
        col.prop(s, prop, index=i, text="" if ic else piece.id.split("-")[-1], toggle=True)


class FOLIAGE_PT_main(bpy.types.Panel):
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Foliage"
    bl_label = "Foliage"

    def draw(self, context):
        layout = self.layout
        row = layout.row(align=True)
        row.operator("foliage.place", text="Add Fern", icon="OUTLINER_OB_POINTCLOUD").kind = "FERN"
        row.operator("foliage.place", text="Add Vine", icon="CURVE_PATH").kind = "VINE"
        for kind, label, _description in KINDS[2:]:
            layout.operator("foliage.place", text=f"Add {label}", icon="ADD").kind = kind
        sc = context.scene.foliage_scatter
        box = layout.box()
        row = box.row(align=True)
        row.prop(sc, "count")
        row.prop(sc, "spacing")
        box.operator("foliage.scatter_ferns", icon="STICKY_UVS_DISABLE")

        ob = ops.active_plant(context)
        box = layout.box()
        if ob is None:
            box.label(text="Add a plant, or select one", icon="INFO")
        else:
            s = ob.foliage
            name = next(label for key, label, _description in KINDS if key == s.kind)
            box.label(text=f"{name} on {s.host}", icon="OUTLINER_OB_MESH")
            if s.status:
                box.label(text=s.status, icon="ERROR")
            elif s.kind == "FERN":
                box.label(text=f"{s.triangles:,} tris, {s.parts} fronds, {s.leaves} leaves, {s.build_ms:.0f} ms")
            elif s.kind == "GLOW":
                box.label(text=f"{s.triangles:,} tris, {s.glow_items} plants, {s.build_ms:.0f} ms")
                if s.glow_remaining:
                    box.label(text=f"{s.glow_remaining} still intersecting", icon="ERROR")
                if s.glow_dropped:
                    box.label(text=f"{s.glow_dropped} did not fit on the host", icon="INFO")
            elif s.kind in BIOLUME_KINDS:
                box.label(text=f"{s.triangles:,} tris, {s.parts} parts, {s.build_ms:.0f} ms")
            else:
                box.label(text=f"{s.triangles:,} tris, {s.leaves} leaves, {s.build_ms:.0f} ms")
            row = box.row(align=True)
            row.prop(s, "live")
            row.operator("foliage.rebuild", icon="FILE_REFRESH").all = False
            row = box.row(align=True)
            row.prop(s, "seed")
            row.operator("foliage.new_seed", text="", icon="FILE_REFRESH")
            row = box.row(align=True)
            row.operator("foliage.snap", text="Snap", icon="SNAP_ON")
            row.operator("foliage.reset", icon="LOOP_BACK")
            col = box.column(align=True)
            col.operator("foliage.copy_settings", icon="COPYDOWN")
            col.operator("foliage.bake", icon="MESH_DATA")
            box.label(text="G moves, R turns (Z aims it), S sizes", icon="ORIENTATION_GIMBAL")
        layout.operator("foliage.rebuild", text="Rebuild All", icon="FILE_REFRESH").all = True


class _Sub:
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Foliage"
    bl_parent_id = "FOLIAGE_PT_main"


class FOLIAGE_PT_fern(_Sub, bpy.types.Panel):
    bl_label = "Fern"

    @classmethod
    def poll(cls, context):
        ob = ops.active_plant(context)
        return ob is not None and ob.foliage.kind == "FERN"

    def draw(self, context):
        s = ops.active_plant(context).foliage
        layout = self.layout
        layout.prop(s, "variety", text="")
        _col(layout, s, ("fronds", "fern_length", "droop", "spread"))
        layout.label(text="Shape")
        _col(layout, s, ("lean", "fold", "twist", "croziers", "length_var"))
        if s.variety == "PAINTED":
            layout.label(text="Fronds")
            _picker(layout, s, "frond_pieces", library.FRONDS, per_row=5)
        else:
            layout.label(text="Leaves")
            names = ["pinnae"] + (["leaflets"] if s.variety == "LEAFLET" else []) + ["fern_leaf_size", "leaf_curve", "leaf_variation"]
            _col(layout, s, names)
            if s.variety == "LEAFLET":
                layout.prop(s, "leaf_form", expand=True)
            layout.prop(s, "mirror_pairs")


class FOLIAGE_PT_vine(_Sub, bpy.types.Panel):
    bl_label = "Hanging Vine"

    @classmethod
    def poll(cls, context):
        ob = ops.active_plant(context)
        return ob is not None and ob.foliage.kind == "VINE"

    def draw(self, context):
        s = ops.active_plant(context).foliage
        layout = self.layout
        _col(layout, s, ("vine_length", "vine_leaf_size", "leaf_spacing"))
        layout.label(text="Shape")
        _col(layout, s, ("vine_radius", "cling", "bend", "leaf_angle", "variation"))
        layout.prop(s, "natural")
        layout.label(text="Leaves")
        row = layout.row(align=True)
        row.operator("foliage.leaf_set", text="Painted").set = "PAINTED"
        row.operator("foliage.leaf_set", text="Silhouettes").set = "SILHOUETTES"
        row.operator("foliage.leaf_set", text="All").set = "ALL"
        layout.label(text="Painted (keep their colours)")
        _picker(layout, s, "painted_leaves", library.PAINTED_LEAVES)
        layout.label(text="Silhouettes (tinted)")
        _picker(layout, s, "silhouette_leaves", library.SILHOUETTE_LEAVES, per_row=8)


class FOLIAGE_PT_colour(_Sub, bpy.types.Panel):
    bl_label = "Colour"
    bl_options = {"DEFAULT_CLOSED"}

    @classmethod
    def poll(cls, context):
        ob = ops.active_plant(context)
        return ob is not None and ob.foliage.kind in {"FERN", "VINE"}

    def draw(self, context):
        s = ops.active_plant(context).foliage
        layout = self.layout
        layout.prop(s, "paint_tint")
        layout.label(text="Greens")
        grid = layout.grid_flow(row_major=True, columns=3, even_columns=True, align=True)
        for i, (_id, name, _hex) in enumerate(library.SHADES):
            grid.prop(s, "shades", index=i, text=name, toggle=True)


class FOLIAGE_PT_biolume(_Sub, bpy.types.Panel):
    bl_label = "Cave Foliage"

    @classmethod
    def poll(cls, context):
        ob = ops.active_plant(context)
        return ob is not None and ob.foliage.kind in BIOLUME_KINDS

    def draw(self, context):
        s = ops.active_plant(context).foliage
        layout = self.layout
        if s.kind == "MUSHROOM":
            layout.prop(s, "mushroom_form", expand=True)
        _col(layout, s, ("cluster_count", "cluster_radius", "bio_size", "bio_variation", "shape_variation", "surface_detail"))
        if s.kind == "MUSHROOM" and s.mushroom_form == "CAP":
            layout.prop(s, "bio_height")
        if s.kind == "MUSHROOM":
            layout.prop(s, "cap_dome")
        elif s.kind == "ORBS":
            layout.prop(s, "orb_stalk")
            layout.label(text="Place on an underside or overhang")
        _col(layout, s, ("body_color", "glow_color", "glow_strength"))
        layout.label(text="Add nearby lights in the level editor", icon="LIGHT")


class FOLIAGE_PT_glow(_Sub, bpy.types.Panel):
    bl_label = "Glow Flora"

    @classmethod
    def poll(cls, context):
        ob = ops.active_plant(context)
        return ob is not None and ob.foliage.kind == "GLOW"

    def draw(self, context):
        s = ops.active_plant(context).foliage
        layout = self.layout
        grid = layout.grid_flow(row_major=True, columns=3, even_columns=True, align=True)
        grid.prop(s, "glow_kind", expand=True)
        row = layout.row(align=True)
        row.prop(s, "glow_palette", text="")
        row.prop(s, "glow_detail", expand=True)
        layout.prop(s, "glow_collisions")
        kind = s.glow_kind.lower()
        col = layout.column(align=True)
        for key, *_rest in PATCH_FIELDS[kind]:
            col.prop(s, glow_prop(kind, key))
        box = layout.box()
        box.label(text="Glowshroom Generator")
        row = box.row(align=True)
        row.operator("foliage.glow_paste", icon="PASTEDOWN")
        row.operator("foliage.glow_copy", icon="COPYDOWN")
        if s.glow_edits:
            row = box.row()
            row.label(text="Plants edited there are kept", icon="LOCKED")
            row.operator("foliage.glow_clear_edits", text="", icon="X")
        layout.label(text="Light the patch in the level editor", icon="LIGHT")


CLASSES = (FOLIAGE_PT_main, FOLIAGE_PT_fern, FOLIAGE_PT_vine, FOLIAGE_PT_colour, FOLIAGE_PT_biolume, FOLIAGE_PT_glow)
