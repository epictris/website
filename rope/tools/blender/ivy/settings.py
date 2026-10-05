"""The properties an ivy object carries (`Object.ivy`) and the brush's
(`Scene.ivy_brush`). An ivy object is a mesh parented to its host with an
identity transform; its mesh is output only - the stamps and these settings
are the source, and any rebuild (the panel's, or the scene exporter's)
produces it again."""

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, FloatVectorProperty, IntProperty, PointerProperty, StringProperty

from .build import Params


def _changed(self, context):
    from . import ops

    ob = self.id_data
    if isinstance(ob, bpy.types.Object) and self.is_ivy and self.live:
        ops.schedule_rebuild(ob)


def _length(name, default, lo, hi, desc):
    return FloatProperty(name=name, default=default, min=lo, soft_max=hi, subtype="DISTANCE", unit="LENGTH", description=desc, update=_changed)


def _factor(name, default, desc, hi=1.0):
    return FloatProperty(name=name, default=default, min=0.0, soft_max=hi, description=desc, update=_changed)


def _color(name, default, desc):
    return FloatVectorProperty(name=name, default=default, size=3, min=0.0, max=1.0, subtype="COLOR", description=desc, update=_changed)


_D = Params()


class IvySettings(bpy.types.PropertyGroup):
    is_ivy: BoolProperty(default=False, options={"HIDDEN"})
    host: StringProperty(name="Host", description="The object this ivy grows on, matched by name so a re-imported host is found again")
    stamps: PointerProperty(type=bpy.types.Mesh, options={"HIDDEN"})
    live: BoolProperty(name="Live", default=True, description="Rebuild whenever a setting changes")

    seed: IntProperty(name="Seed", default=0, min=0, update=_changed)
    detail: EnumProperty(
        name="Detail",
        items=(
            ("LEAVES", "Leaves", "A card per leaf, in sheets that shade one another: ivy near the gameplay plane"),
            ("CLUMPS", "Clumps", "A card per clump of leaves: ivy on the backdrop, at a fraction of the cards"),
        ),
        default=_D.detail,
        update=_changed,
    )
    resolution: _length("Resolution", _D.resolution, 0.005, 0.2, "Edge length the host is refined to under the paint; the underlay's and the candidates' resolution")

    threshold: _factor("Threshold", _D.threshold, "Paint coverage at which ivy starts; higher shrinks the patch inside the painted area")
    edge_noise: _factor("Edge Noise", _D.edge_noise, "How lobed the outline is")
    edge_scale: _length("Edge Scale", _D.edge_scale, 0.01, 1.0, "Size of the outline's lobes")
    min_patch: FloatProperty(name="Min Patch", default=_D.min_patch, min=0.0, soft_max=0.2, unit="AREA", description="Islands smaller than this are dropped", update=_changed)
    rounding: _length("Rounding", _D.rounding, 0.0, 0.5, "How far the rock's creases are rounded over in the normal the leaves shade with")

    # The carpet grows out from the origin (Set Origin): every leaf points
    # away from it and lies over the leaf beyond it.
    thickness: _length("Thickness", _D.thickness, 0.0, 0.3, "How high the leaves stand over the underlay at the origin; they slope down to the rock at the far end of the carpet")
    # `sheets` and `leaf_fill`, not the blob carpet's `layers` and `fill`: a
    # file saved with 8 layers of blobs would grow 8 sheets 3 cm apart.
    sheets: IntProperty(name="Sheets", default=_D.sheets, min=1, soft_max=6, description="Sheets of leaves stacked 3 cm apart, each shading the next", update=_changed)
    leaf_min: _length("Leaf Min", _D.leaf_min, 0.01, 0.5, "Shortest leaf")
    leaf_max: _length("Leaf Max", _D.leaf_max, 0.01, 0.5, "Longest leaf")
    leaf_fill: _factor("Fill", _D.leaf_fill, "Leaf area laid over the paint, as a multiple of the paint's area, shared by the sheets", 8.0)
    edge_fill: _factor("Edge Fill", _D.edge_fill, "Extra fill toward the paint's edge, so the underlay never shows as a rim", 4.0)
    density: FloatProperty(name="Candidates", default=_D.density, min=100.0, soft_max=20000.0, description="Candidate points per square metre the sheets pick leaves from", update=_changed)
    # `edge_round` is a distance, not `shoulder`'s share of the paint's coverage (2026-10-05).
    edge_round: _length("Edge Round", _D.edge_round, 0.0, 1.0, "Distance in from the paint's edge over which the carpet curves down onto the rock: shorter is a steeper edge")
    underlay: _length("Underlay", _D.underlay, 0.0, 0.1, "Height of the solid green skin under the leaves")
    tilt: FloatProperty(name="Tilt", default=_D.tilt, min=0.0, soft_max=30.0, description="Degrees a leaf pitches tip-up off the rock, so its tip rides over the leaf beyond it", update=_changed)
    spread: FloatProperty(name="Spread", default=_D.spread, min=0.0, max=180.0, description="Degrees a leaf may stray from pointing straight away from the origin", update=_changed)
    taper: _factor("Taper", _D.taper, "How much smaller the leaves at the far end of the carpet are than those at the origin")

    # Detail "Clumps" only.
    clump_min: _length("Clump Min", _D.clump_min, 0.05, 2.0, "Smallest clump card")
    clump_max: _length("Clump Max", _D.clump_max, 0.05, 2.0, "Largest clump card")
    clump_fill: _factor("Fill", _D.clump_fill, "Clump area laid over the paint, as a multiple of the paint's area", 4.0)

    # A vine is placed by hand (Place Vines); each is an arrow empty parented
    # to the host, and the arrow's length is the vine's.
    vine_length: _length("New Length", _D.vine_length, 0.05, 3.0, "Length a newly placed vine is given; scale its arrow (S) to change one")
    leaf_size: _length("Leaf Size", _D.leaf_size, 0.01, 0.5, "Leaf length at the top of a vine")
    leaf_tip: _length("Leaf Tip", _D.leaf_tip, 0.005, 0.3, "Leaf length at the tip of a vine")

    # Colours in the panel are sRGB; params() makes them linear.
    # The panel's sRGB of build.Params' linear defaults (well under the study's
    # brightness, so the leaves neither clip in the game nor lose their shadows).
    tone_a: _color("Yellow-green", (0.42, 0.53, 0.10), "The first of three tones that patch across the carpet")
    tone_b: _color("Leaf green", (0.27, 0.47, 0.10), "The second tone")
    tone_c: _color("Blue-green", (0.19, 0.42, 0.20), "The third tone")
    light: _color("Crown", (0.48, 0.54, 0.14), "What a leaf turns toward where the rock faces up")
    shade: _color("Shade", (0.17, 0.37, 0.22), "What the lower sheets cool toward")
    tone_scale: _length("Tone Scale", _D.tone_scale, 0.02, 2.0, "Size of the tone patches")
    variation: _factor("Variation", _D.variation, "Brightness variation between neighbouring leaves")
    depth_shade: _factor("Depth Shade", _D.depth_shade, "How much darker the lower sheets are")

    # The shadow decal on the rock under and around the carpet.
    shadow_strength: _factor("Strength", _D.shadow_strength, "Opacity of the shadow under the carpet; 0 grows none")
    shadow_reach: _length("Reach", _D.shadow_reach, 0.0, 1.0, "How far beside the paint's edge the shadow fades out")
    shadow_drop: _factor("Drop", _D.shadow_drop, "How much further the shadow reaches below the paint than beside it", 4.0)
    shadow_color: _color("Shadow Colour", (0.12, 0.19, 0.27), "The shadow's colour")

    # Read back after a build, for the panel.
    triangles: IntProperty(options={"HIDDEN"})
    leaves: IntProperty(options={"HIDDEN"})
    vine_count: IntProperty(options={"HIDDEN"})
    build_ms: FloatProperty(options={"HIDDEN"})
    status: StringProperty(options={"HIDDEN"})

    def params(self):
        """The build's parameters. Colours go from the panel's sRGB to linear."""

        def lin(c):
            return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

        kw = {k: getattr(self, k) for k in Params.__dataclass_fields__ if hasattr(self, k)}
        for k in ("tone_a", "tone_b", "tone_c", "light", "shade", "shadow_color"):
            kw[k] = lin(getattr(self, k))
        return Params(**kw)

    def copy_from(self, other):
        """Take the other ivy's settings: the values it has set, and the
        defaults where it has none. (Copying every value stored every default
        of the day on the copy, and a copy made in the blob carpet's time
        kept that carpet's greens when the defaults moved.)"""
        for k in Params.__dataclass_fields__:
            if k == "seed" or not hasattr(other, k):
                continue
            if k in other:
                setattr(self, k, getattr(other, k))
            else:
                self.property_unset(k)

    # What the defaults were before 2026-09-30's ivy: a stored value equal to
    # one of these was never chosen, only copied, and goes back to following
    # the default. The blob carpet's own properties are dropped with it.
    OLD_DEFAULTS = {
        "tone_a": (0.81, 0.90, 0.28),
        "tone_b": (0.53, 0.80, 0.28),
        "tone_c": (0.38, 0.72, 0.48),
        "light": (0.91, 0.93, 0.35),
        "shade": (0.35, 0.63, 0.52),
        "depth_shade": 0.28,
        "thickness": 0.07,
        "edge_fill": 2.5,
    }
    STALE_KEYS = ("layers", "fill", "blob_min", "blob_max", "shoulder")

    def migrate(self):
        """Forget stored values that are only an old default. Returns how many."""
        n = 0
        for k, old in self.OLD_DEFAULTS.items():
            if k not in self:
                continue
            v = getattr(self, k)
            same = abs(v - old) < 1e-4 if isinstance(old, float) else all(abs(a - b) < 1e-3 for a, b in zip(v, old))
            if same:
                self.property_unset(k)
                n += 1
        for k in self.STALE_KEYS:
            if k in self:
                del self[k]
                n += 1
        return n


class IvyBrush(bpy.types.PropertyGroup):
    radius: FloatProperty(name="Radius", default=0.25, min=0.005, soft_max=3.0, subtype="DISTANCE", unit="LENGTH", description="Brush radius in the world ([ and ] while painting)")
    strength: FloatProperty(name="Strength", default=0.6, min=0.01, max=1.0, subtype="FACTOR", description="Coverage one pass adds")
    spacing: FloatProperty(name="Spacing", default=0.25, min=0.05, max=2.0, description="Distance between stamps along a stroke, as a fraction of the radius")
    show_stamps: BoolProperty(name="Show Stamps", default=False, description="Draw the stamps of the ivy being painted")


CLASSES = (IvySettings, IvyBrush)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    bpy.types.Object.ivy = PointerProperty(type=IvySettings)
    bpy.types.Scene.ivy_brush = PointerProperty(type=IvyBrush)


def unregister():
    del bpy.types.Scene.ivy_brush
    del bpy.types.Object.ivy
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
