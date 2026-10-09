"""The properties a moss object carries (`Object.moss`) and the brush's
(`Scene.moss_brush`). A moss object is a mesh parented to its host (the
first it was painted on) with an identity transform, and grows on that host and
every one it has joined since; its mesh and its print are output only - the stamps and
these settings are the source, and any rebuild (the panel's, or the scene
exporter's) produces them again.

`Object.moss` was the ivy's slot until 2026-10-02; a file from before then keeps
the ivy's settings there (with `is_moss` set) until the ivy add-on migrates it.
A moss object is told apart by `grown_by == "moss"`, never by this group."""

import bpy
from bpy.props import BoolProperty, CollectionProperty, EnumProperty, FloatProperty, FloatVectorProperty, IntProperty, PointerProperty, StringProperty

from .build import Params


def _changed(self, context):
    from . import ops

    ob = self.id_data
    if isinstance(ob, bpy.types.Object) and ops.is_moss(ob) and self.live:
        ops.schedule_rebuild(ob)


def _length(name, default, lo, hi, desc):
    return FloatProperty(name=name, default=default, min=lo, soft_max=hi, subtype="DISTANCE", unit="LENGTH", description=desc, update=_changed)


def _factor(name, default, desc, hi=1.0):
    return FloatProperty(name=name, default=default, min=0.0, soft_max=hi, description=desc, update=_changed)


def _srgb(c):
    return tuple(round(x * 12.92 if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055, 3) for x in c)


_D = Params()

# What Detail coarsens: the moss's grain and nothing that places its colour.
# At Detail d the dabs, the refinement and the print's texel and dab edge are
# 1/d as big, the mound's triangles per m² and the smallest clump's dab count
# d² as many. Reference Depth, the buffers, the erosion noise and the mottle
# stay as authored: they are measured against the painted area, which Detail
# does not change. Scaling them too (2026-10-07, "Scale") took mid-ledge's
# mean tone from 0.46 to 0.21 at 1/3 - the light was lost (Tris: "reducing
# the amount of bright colors"). Coarsened as here, the share of the area at
# each tone stays within what changing the seed moves it by: mean tone over
# seeds 0.46-0.51 at 1 and 0.43-0.48 at 1/3 on mid-ledge, 0.20-0.27 and
# 0.13-0.27 on the backdrop pool; coarse dabs vary more from seed to seed.
# Keeping the lighter layers' room on the authored dab size as well
# (`build`'s inset) held mid-ledge but took the pool to 0.28-0.47.
# Build time goes with the dab count, so with 1/d²: mid-ledge grew in 21.7 s
# at 1 and about 4 s at 1/3. For moss whose dabs are a few texels of what
# draws them: at 1 the river backdrop's came to 1-2 texels across on
# left-shelf and left-wall (5.9 cm texels) but 8-13 on mid-ledge (7.7 mm), so
# Detail is each moss's own.
COARSENED_LENGTHS = ("resolution", "dab_min", "dab_max", "texel", "print_edge", "edge_detail")


class MossHost(bpy.types.PropertyGroup):
    """A host joined to a moss, by its `name` (every PropertyGroup has one)."""


class MossSettings(bpy.types.PropertyGroup):
    host: StringProperty(name="Host", description="The object this moss is parented to and its paint is stored against; "
                                                  "matched by name so a re-imported host is found again")
    # The other objects it grows on (stampbrush/hosts.py), joined by the brush
    # as the paint reaches them; matched by name like `host`.
    joined: CollectionProperty(type=MossHost, options={"HIDDEN"})
    stamps: PointerProperty(type=bpy.types.Mesh, options={"HIDDEN"})
    # Off by default: a build takes seconds, too long to follow a slider.
    live: BoolProperty(name="Live", default=False, description="Rebuild whenever a setting changes (a build takes seconds)")

    kind: EnumProperty(
        name="Kind", default=_D.kind, update=_changed,
        items=[("MOUND", "Mound", "A low mound of moss with its own printed texture", 0),
               ("TEXTURE", "Texture Only", "No geometry: the dabs are painted into the rock's colour map when the scene is "
                                           "exported (Blender shows them on a decal that is not exported)", 1)],
        description="Grow a mound of moss, or only paint its colour onto the rock")
    seed: IntProperty(name="Seed", default=0, min=0, update=_changed)
    detail: FloatProperty(name="Detail", default=1.0, min=0.1, max=1.0, update=_changed,
                          description="How fine the moss is grown: at 0.5 the dabs and texels are twice as big and a "
                                      "build takes about a quarter of the time. Where the colours fall is kept. "
                                      "Lower it for moss far in the background")
    resolution: _length("Resolution", _D.resolution, 0.004, 0.05, "Edge length the rock is refined to under the paint")
    threshold: _factor("Threshold", _D.threshold, "Paint coverage at which moss starts")

    dab_min: _length("Dab Min", _D.dab_min, 0.005, 0.2, "Smallest dab radius")
    dab_max: _length("Dab Max", _D.dab_max, 0.005, 0.2, "Largest dab radius")
    layers: IntProperty(name="Layers", default=_D.layers, min=0, max=8, description="Lighter layers grown inside the dark base", update=_changed)
    shrink: _factor("Shrink", _D.shrink, "Dab radius from one layer to the next (floored at 0.65)")
    buffer: _length("Buffer", _D.buffer, 0.0, 0.2, "How far inside the layer below a lighter layer stays")
    first_buffer: _length("First Buffer", _D.first_buffer, 0.0, 0.2, "How far inside the dark base the first lighter layer stays")
    min_clump: IntProperty(name="Min Clump", default=_D.min_clump, min=1, soft_max=30, description="Clumps of fewer dabs are dropped", update=_changed)

    ref_depth: _length("Reference Depth", _D.ref_depth, 0.05, 2.0, "A patch this deep reaches the lightest tone; shallower patches stay mid-green")
    steps_deep: FloatProperty(name="Steps", default=_D.steps_deep, min=1.0, soft_max=12.0, description="Erosion passes across the reference depth", update=_changed)
    erode_scale: FloatProperty(name="Erosion Noise", default=_D.erode_scale, min=0.5, soft_max=60.0, description="1/m: how finely each erosion pass's outline is roughened", update=_changed)
    field_mix: _factor("Field Mix", _D.field_mix, "Tone from the erosion field (1) or from the layer (0)")
    curve: FloatProperty(name="Curve", default=_D.curve, min=0.2, soft_max=4.0, description="Tone curve: above 1 keeps the light to the summits", update=_changed)
    mottle: _factor("Mottle", _D.mottle, "Slow positional variation, in tone steps", 3.0)
    mottle_scale: FloatProperty(name="Mottle Scale", default=_D.mottle_scale, min=0.1, soft_max=30.0, description="1/m: size of the mottle", update=_changed)
    levels: IntProperty(name="Levels", default=_D.levels, min=2, soft_max=16, description="Tone steps from darkest to lightest", update=_changed)
    # Colours in the panel are sRGB; params() makes them linear.
    dark: FloatVectorProperty(name="Dark", default=_srgb(_D.dark), size=3, min=0.0, max=1.0, subtype="COLOR", description="The darkest moss: the base and the rim", update=_changed)
    light: FloatVectorProperty(name="Light", default=_srgb(_D.light), size=3, min=0.0, max=1.0, subtype="COLOR", description="The lightest moss: the summits", update=_changed)

    floor: _length("Floor", _D.floor, 0.0, 0.05, "How proud of the rock the darkest moss stands, away from the rim")
    lift: _length("Lift", _D.lift, 0.0, 0.3, "How much prouder the lightest moss stands than the darkest: the lighter, the taller")
    up_floor: _factor("Wall Share", _D.up_floor, "The share of its height moss keeps on a wall (a full pile on a wall faces the ground)")
    height_blur: _length("Height Blur", _D.height_blur, 0.0, 0.2, "How far the height is smoothed, so blotches are pillows, not terraces")
    rim: _length("Rim", _D.rim, 0.0, 0.5, "Distance over which the height fades in from the mound's edge")
    drape: _length("Drape", _D.drape, 0.0, 3.0, "The tightest curve the moss bends in: across a step or hollow tighter than this it "
                                                "slopes from the edge down to the moss below instead of following the rock's corner. "
                                                "0 follows the rock")
    edge_round: _length("Edge Round", _D.edge_round, 0.0, 0.05, "How far in from its outline the moss's top rounds down to its lip")
    overhang: _length("Overhang", _D.overhang, 0.0, 0.02, "How high the lip stands over the rock and how far its foot is tucked in under it "
                                                        "(at most half of Floor)")
    edge_detail: _length("Edge Detail", _D.edge_detail, 0.001, 0.03, "Edge length of the mesh along the outline: the smaller, the rounder its lobes")
    strays: FloatProperty(name="Strays", default=_D.strays, min=0.0, soft_max=30.0, update=_changed,
                          description="Detached clumps of moss on the rock beyond the outline, per metre of outline")
    stray_reach: _length("Stray Reach", _D.stray_reach, 0.0, 0.3, "How far beyond the outline a stray clump may be")

    grass: FloatProperty(name="Grass", default=_D.grass, min=0.0, soft_max=60.0, update=_changed,
                         description="Tufts of grass blades per square metre of the moss's up-facing top, more where it is lighter")
    grass_height: _length("Grass Height", _D.grass_height, 0.0, 0.3, "How tall the tallest blades stand")
    grass_blades: IntProperty(name="Blades", default=_D.grass_blades, min=1, soft_max=20, description="Blades in a tuft, about", update=_changed)
    grass_tip: FloatVectorProperty(name="Grass Tip", default=_srgb(_D.grass_tip), size=3, min=0.0, max=1.0, subtype="COLOR",
                                   description="The lightest blade tip; the tips run from Light to this", update=_changed)

    min_patch: FloatProperty(name="Min Patch", default=_D.min_patch, min=0.0, soft_max=0.1, unit="AREA", description="Mound islands smaller than this are dropped (stray clumps are kept)", update=_changed)

    # Quality: what build.finish reads (build.FINISH_PARAMS), so a change here
    # remakes the mesh and the print from the last growth, without growing again.
    mound_density: FloatProperty(name="Triangles / m²", default=_D.mound_density, min=50.0, soft_max=20000.0,
                                 description="Poly count: the mound is decimated to this many triangles per square metre "
                                             "(at most what Resolution gives)", update=_changed)
    texel: _length("Texel Size", _D.texel, 0.0003, 0.02, "Texture quality: the size of a texel of the print in the world; smaller is sharper")
    # The item's number is the size, so a file from when this was an int keeps its value.
    max_texture: EnumProperty(name="Max Texture", default=str(_D.max_texture),
                              items=[(str(n), str(n), f"At most {n} x {n} px", n) for n in (256, 512, 1024, 2048, 4096)],
                              description="Largest side of the print; where the mound does not fit at Texel Size, its texels grow. "
                                          "The export encodes at most 4096", update=_changed)
    print_edge: _length("Dab Edge", _D.print_edge, 0.0, 0.02, "Anti-aliased width of a dab's edge in the print")

    # Read back after a build, for the panel.
    triangles: IntProperty(options={"HIDDEN"})
    dabs: IntProperty(options={"HIDDEN"})
    layer_dabs: StringProperty(options={"HIDDEN"})
    heights: StringProperty(options={"HIDDEN"})
    texture: IntProperty(options={"HIDDEN"})
    texel_used: FloatProperty(options={"HIDDEN"})
    area: FloatProperty(options={"HIDDEN"})
    reused: BoolProperty(options={"HIDDEN"})  # the last rebuild finished a cached growth
    build_ms: FloatProperty(options={"HIDDEN"})
    status: StringProperty(options={"HIDDEN"})
    # ops._build_key of the build the saved mesh and print came from, so the
    # scene export keeps them while nothing that made them has changed.
    built_key: StringProperty(options={"HIDDEN"})

    def params(self):
        """The build's parameters. Colours go from the panel's sRGB to linear,
        and the grain is coarsened by Detail (COARSENED_LENGTHS); at 1 every
        value is the panel's own, bit for bit."""

        def lin(c):
            return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

        kw = {k: getattr(self, k) for k in Params.__dataclass_fields__ if hasattr(self, k)}
        kw["dark"] = lin(self.dark)
        kw["light"] = lin(self.light)
        kw["grass_tip"] = lin(self.grass_tip)
        kw["max_texture"] = int(self.max_texture)
        if self.detail != 1.0:
            d = self.detail
            for n in COARSENED_LENGTHS:
                kw[n] /= d
            kw["mound_density"] *= d * d
            kw["min_clump"] = max(1, round(self.min_clump * d * d))
        return Params(**kw)

    def migrate_scale(self):
        """Carry a moss saved with Scale (its first form, 2026-10-07, which also
        moved its colours) to Detail, 1/scale. Returns whether it held one."""
        if "scale" not in self:
            return False
        scale = float(self["scale"])
        del self["scale"]
        self.detail = min(1.0, max(0.1, 1.0 / scale)) if scale > 0 else 1.0
        return True

    def copy_from(self, other):
        """Take the other moss's settings: the values it has set, and the defaults
        where it has none (copying every value would store the day's defaults)."""
        for k in [*Params.__dataclass_fields__, "detail"]:
            if k == "seed" or not hasattr(other, k):
                continue
            if k in other:
                setattr(self, k, getattr(other, k))
            else:
                self.property_unset(k)


class MossBrush(bpy.types.PropertyGroup):
    radius: FloatProperty(name="Radius", default=0.25, min=0.005, soft_max=3.0, subtype="DISTANCE", unit="LENGTH", description="Brush radius in the world ([ and ] while painting)")
    strength: FloatProperty(name="Strength", default=0.6, min=0.01, max=1.0, subtype="FACTOR", description="Coverage one pass adds")
    spacing: FloatProperty(name="Spacing", default=0.25, min=0.05, max=2.0, description="Distance between stamps along a stroke, as a fraction of the radius")
    show_stamps: BoolProperty(name="Show Stamps", default=False, description="Draw the stamps of the moss being painted")


CLASSES = (MossHost, MossSettings, MossBrush)


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
