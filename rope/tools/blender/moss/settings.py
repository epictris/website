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
    resolution: _length("Resolution", _D.resolution, 0.005, 0.2, "Edge length the host is refined to under the paint; the underlay's and the candidates' resolution")

    threshold: _factor("Threshold", _D.threshold, "Paint coverage at which moss starts; higher shrinks the patch inside the painted area")
    edge_noise: _factor("Edge Noise", _D.edge_noise, "How lobed the outline is")
    edge_scale: _length("Edge Scale", _D.edge_scale, 0.01, 1.0, "Size of the outline's lobes")
    min_patch: FloatProperty(name="Min Patch", default=_D.min_patch, min=0.0, soft_max=0.2, unit="AREA", description="Islands smaller than this are dropped", update=_changed)
    rounding: _length("Rounding", _D.rounding, 0.0, 0.5, "How far the rock's creases are rounded over in the normal the blobs shade with")

    thickness: _length("Thickness", _D.thickness, 0.012, 0.3, "How far the carpet stands off the rock")
    layers: IntProperty(name="Layers", default=_D.layers, min=1, soft_max=16, description="Sheets of blobs between the rock and the top of the carpet", update=_changed)
    blob_min: _length("Blob Min", _D.blob_min, 0.01, 0.5, "Smallest blob")
    blob_max: _length("Blob Max", _D.blob_max, 0.01, 0.5, "Largest blob")
    fill: _factor("Fill", _D.fill, "Blob area laid per layer, as a multiple of the layer's area", 4.0)
    density: FloatProperty(name="Candidates", default=_D.density, min=100.0, soft_max=20000.0, description="Candidate points per square metre the layers pick blobs from", update=_changed)
    facing: _factor("Facing", _D.facing, "Every blob faces the game's camera by at least this (cosine); a blob seen edge-on is a spike")
    shoulder: _factor("Shoulder", _D.shoulder, "The outer share of the paint that rolls into the rock, in coverage units")
    underlay: _length("Underlay", _D.underlay, 0.0, 0.1, "Height of the solid green skin under the blobs")

    vines: BoolProperty(name="Vines", default=_D.vines, description="Hang vines of leaves from the paint's front edge", update=_changed)
    vine_density: FloatProperty(name="Vines per m²", default=_D.vine_density, min=0.0, soft_max=30.0, description="Vines per square metre of paint", update=_changed)
    vine_length: _length("Length", _D.vine_length, 0.05, 3.0, "Length of a vine")
    vine_variation: _factor("Length Variation", _D.vine_variation, "Variation of the length between vines")
    leaf_size: _length("Leaf Size", _D.leaf_size, 0.01, 0.3, "Leaf length at the top of a vine")
    leaf_tip: _length("Leaf Tip", _D.leaf_tip, 0.005, 0.2, "Leaf length at the tip of a vine")

    # Colours in the panel are sRGB; params() makes them linear.
    tone_a: _color("Yellow-green", (0.81, 0.90, 0.28), "The first of three tones that patch across the carpet")
    tone_b: _color("Leaf green", (0.53, 0.80, 0.28), "The second tone")
    tone_c: _color("Blue-green", (0.38, 0.72, 0.48), "The third tone")
    light: _color("Crown", (0.91, 0.93, 0.35), "What a blob turns toward where the rock faces up")
    shade: _color("Shade", (0.35, 0.63, 0.52), "What the deep layers cool toward")
    tone_scale: _length("Tone Scale", _D.tone_scale, 0.02, 2.0, "Size of the tone patches")
    variation: _factor("Variation", _D.variation, "Brightness variation between neighbouring blobs")
    depth_shade: _factor("Depth Shade", _D.depth_shade, "How much darker the deep layers are")

    # Read back after a build, for the panel.
    triangles: IntProperty(options={"HIDDEN"})
    blobs: IntProperty(options={"HIDDEN"})
    vine_count: IntProperty(options={"HIDDEN"})
    build_ms: FloatProperty(options={"HIDDEN"})
    status: StringProperty(options={"HIDDEN"})

    def params(self):
        """The build's parameters. Colours go from the panel's sRGB to linear."""

        def lin(c):
            return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

        kw = {k: getattr(self, k) for k in Params.__dataclass_fields__ if hasattr(self, k)}
        for k in ("tone_a", "tone_b", "tone_c", "light", "shade"):
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
