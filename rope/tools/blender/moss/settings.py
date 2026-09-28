"""The properties a moss object carries (`Object.moss`) and the brush's
(`Scene.moss_brush`). A moss object is a mesh parented to its host with an
identity transform; its mesh is output only - the stamps and these settings
are the source, and any rebuild (the panel's, or the scene exporter's)
produces it again."""

import bpy
from bpy.props import BoolProperty, FloatProperty, FloatVectorProperty, IntProperty, PointerProperty, StringProperty

from .build import Params


def _changed(self, context):
    from . import ops

    ob = self.id_data
    if isinstance(ob, bpy.types.Object) and self.is_moss and self.live:
        ops.schedule_rebuild(ob)


def _length(name, default, lo, hi, desc):
    return FloatProperty(name=name, default=default, min=lo, soft_max=hi, subtype="DISTANCE", unit="LENGTH", description=desc, update=_changed)


def _factor(name, default, desc, hi=1.0):
    return FloatProperty(name=name, default=default, min=0.0, soft_max=hi, description=desc, update=_changed)


def _color(name, default, desc):
    return FloatVectorProperty(name=name, default=default, size=3, min=0.0, max=1.0, subtype="COLOR", description=desc, update=_changed)


_D = Params()


class MossSettings(bpy.types.PropertyGroup):
    is_moss: BoolProperty(default=False, options={"HIDDEN"})
    host: StringProperty(name="Host", description="The object this moss grows on, matched by name so a re-imported host is found again")
    stamps: PointerProperty(type=bpy.types.Mesh, options={"HIDDEN"})
    live: BoolProperty(name="Live", default=True, description="Rebuild whenever a setting changes")

    seed: IntProperty(name="Seed", default=0, min=0, update=_changed)
    resolution: _length("Resolution", _D.resolution, 0.005, 0.2, "Target edge length of the moss mesh; the triangle budget goes as 1/resolution^2")

    threshold: _factor("Threshold", _D.threshold, "Paint coverage at which moss starts; higher shrinks the patch inside the painted area")
    edge_noise: _factor("Edge Noise", _D.edge_noise, "How lobed the outline is")
    edge_scale: _length("Edge Scale", _D.edge_scale, 0.01, 1.0, "Size of the outline's lobes")
    min_patch: FloatProperty(name="Min Patch", default=_D.min_patch, min=0.0, soft_max=0.2, unit="AREA", description="Islands smaller than this are dropped", update=_changed)

    thickness: _length("Thickness", _D.thickness, 0.0, 0.3, "Height of the cushion")
    edge_thickness: _length("Edge Thickness", _D.edge_thickness, 0.0, 0.02, "Height at the outline; above zero so the edge never fights the rock")
    feather: _length("Feather", _D.feather, 0.001, 0.5, "Distance over which the cushion rises from its outline")
    rounding: _length("Rounding", _D.rounding, 0.0, 0.5, "How far the rock's creases are rounded over")
    lump_amount: _factor("Lumps", _D.lump_amount, "Height variation of the cushion", 1.5)
    lump_scale: _length("Lump Scale", _D.lump_scale, 0.02, 2.0, "Size of the lumps")
    fuzz_amount: _factor("Fuzz", _D.fuzz_amount, "Fine bumpiness", 1.0)
    fuzz_scale: _length("Fuzz Scale", _D.fuzz_scale, 0.005, 0.3, "Size of the fine bumps; below twice the resolution it is lost")

    curtains: BoolProperty(name="Curtains", default=_D.curtains, description="Hang curtains where the moss runs off a drop", update=_changed)
    lip_drop: _length("Lip Drop", _D.lip_drop, 0.01, 1.0, "How far the ground must fall away beyond the moss for a curtain to hang")
    curtain_length: _length("Length", _D.curtain_length, 0.0, 3.0, "Base length of the curtain")
    length_variation: _factor("Length Variation", _D.length_variation, "Broad variation of the length along the lip", 1.0)
    finger_width: _length("Finger Width", _D.finger_width, 0.01, 1.0, "Spacing and width of the curtain's fingers")
    finger_length: _length("Finger Length", _D.finger_length, 0.0, 3.0, "Longest extra length a finger adds")
    finger_taper: FloatProperty(name="Finger Taper", default=_D.finger_taper, min=0.2, soft_max=4.0, description="Finger tip shape: below 1 rounded lobes, 1 triangular, above 1 sharp spikes", update=_changed)
    strand_density: FloatProperty(name="Strands", default=_D.strand_density, min=0.0, soft_max=20.0, description="Thin long strands per metre of lip (the feathering)", update=_changed)
    strand_length: _length("Strand Length", _D.strand_length, 0.0, 3.0, "Extra length of a strand")
    strand_width: _length("Strand Width", _D.strand_width, 0.005, 0.3, "Half-width of a strand; keep it above the resolution")
    free_keep: _factor("Free Sheet", _D.free_keep, "How much of the sheet still hangs once it is clear of the rock (off an undercut); the fingers and strands keep their full length, so a low value breaks a hanging sheet into drips")
    end_taper: _length("End Taper", _D.end_taper, 0.0, 2.0, "Distance over which a curtain shortens to nothing at the ends of its lip")
    curtain_thickness: _factor("Curtain Thickness", _D.curtain_thickness, "Thickness where it leaves the cushion, as a fraction of the cushion's", 2.0)
    thickness_taper: FloatProperty(name="Thinning", default=_D.thickness_taper, min=0.1, soft_max=4.0, description="How quickly the curtain thins towards its tips", update=_changed)
    bend_radius: _length("Bend Radius", _D.bend_radius, 0.005, 1.0, "How tightly it rolls over the lip")
    cling: _factor("Cling", _D.cling, "How strongly it is drawn back onto a wall within reach (follows undercuts)")
    cling_reach: _length("Cling Reach", _D.cling_reach, 0.0, 1.0, "How far away a wall still draws the curtain")
    hug: _length("Gap", _D.hug, 0.0, 0.05, "Gap between the curtain's back and the rock")
    sway: _length("Sway", _D.sway, 0.0, 0.3, "Sideways wander of the fingers toward their tips")

    # Tints multiply the moss texture; the defaults are Params' linear ones in sRGB.
    crown_color: _color("Crown", (1.0, 0.83, 0.72), "Tint where the cushion is full (multiplies the texture)")
    base_color: _color("Base", (0.62, 0.48, 0.54), "Tint at the outline (multiplies the texture)")
    tip_color: _color("Tips", (1.0, 0.89, 0.85), "Tint of the curtains' tips (multiplies the texture)")
    color_variation: _factor("Variation", _D.color_variation, "Brightness variation")
    texture_scale: _length("Texture Scale", _D.texture_scale, 0.05, 5.0, "Size of one tile of the moss texture")

    # Read back after a build, for the panel.
    triangles: IntProperty(options={"HIDDEN"})
    curtain_triangles: IntProperty(options={"HIDDEN"})
    build_ms: FloatProperty(options={"HIDDEN"})
    status: StringProperty(options={"HIDDEN"})

    def params(self):
        """The build's parameters. Colours go from the panel's sRGB to linear."""

        def lin(c):
            return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

        kw = {k: getattr(self, k) for k in Params.__dataclass_fields__ if hasattr(self, k)}
        for k in ("crown_color", "base_color", "tip_color"):
            kw[k] = lin(getattr(self, k))
        return Params(**kw)

    def copy_from(self, other):
        for k in Params.__dataclass_fields__:
            if k != "seed" and hasattr(other, k):
                setattr(self, k, getattr(other, k))


class MossBrush(bpy.types.PropertyGroup):
    radius: FloatProperty(name="Radius", default=0.25, min=0.005, soft_max=3.0, subtype="DISTANCE", unit="LENGTH", description="Brush radius in the world ([ and ] while painting)")
    strength: FloatProperty(name="Strength", default=0.6, min=0.01, max=1.0, subtype="FACTOR", description="Coverage one pass adds")
    spacing: FloatProperty(name="Spacing", default=0.25, min=0.05, max=2.0, description="Distance between stamps along a stroke, as a fraction of the radius")
    show_stamps: BoolProperty(name="Show Stamps", default=False, description="Draw the stamps of the moss being painted")


CLASSES = (MossSettings, MossBrush)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    bpy.types.Object.moss = PointerProperty(type=MossSettings)
    bpy.types.Scene.moss_brush = PointerProperty(type=MossBrush)


def unregister():
    del bpy.types.Scene.moss_brush
    del bpy.types.Object.moss
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
