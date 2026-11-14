"""The properties a plant carries (`Object.foliage`). A plant is a mesh object
parented to its host: its origin is the root (a fern's crown, a vine's start),
its local +Z the surface normal there and its local +Y the way it grows (the
side a fern leans open to, the way a vine sets off), and its scale scales the
plant. The mesh is output only: these settings and that transform are the
source, and any rebuild (the panel's, or the scene exporter's) grows it again."""

import bpy
from bpy.props import BoolProperty, BoolVectorProperty, EnumProperty, FloatProperty, FloatVectorProperty, IntProperty, StringProperty

from . import glowflora, library
from .fern import VARIETY_DEFAULTS, FernParams
from .vine import VineParams

KINDS = (
    ("FERN", "Fern", "A clump of fronds from one crown: painted fronds, leaflets on stems, or leaf sprigs (a bush)"),
    ("VINE", "Hanging Vine", "A stem that crawls over its rock, lets go at an overhang and hangs, with painted leaves"),
    ("MUSHROOM", "Mushrooms", "Stemmed caps or thin wall shelves with luminous rims"),
    ("ORBS", "Pendant Orbs", "Compact ceiling bulbs on individual short stalks; no vine strands"),
    ("GLOW", "Glow Flora", "A patch of glowing mushrooms, lantern blooms, ferns and reeds (the Glowshroom Generator's)"),
)
BIOLUME_KINDS = {"MUSHROOM", "ORBS"}
GLOW_KINDS = (
    ("GROVE", "Grove", "A mushroom cluster with lantern blooms, ferns and reeds around it"),
    ("MUSHROOM", "Mushrooms", "A cluster of glowing mushrooms on a mound"),
    ("LANTERN", "Lanterns", "Arched stalks with hanging glowing bulbs"),
    ("FERN", "Ferns", "Glow ferns with unfurling fiddleheads"),
    ("REED", "Reeds", "Blade tufts with glowing seed pods"),
)
GLOW_PALETTES = tuple((k.upper(), k.title(), "") for k in glowflora.PALETTES)


def glow_prop(kind, key):
    """The property holding a glow patch kind's option, e.g. glow_mushroom_count."""
    return f"glow_{kind}_{key}"
VARIETIES = (
    ("PAINTED", "Painted Fronds", "Each frond one painted card, folded down its midrib"),
    ("LEAFLET", "Leaflets", "Each frond a stem with pairs of small painted leaves"),
    ("SPRIG", "Leaf Sprigs", "Painted sprigs along each stem, set like louvres: a leafy bush"),
)


def _changed(self, context):
    from . import ops

    ob = self.id_data
    if isinstance(ob, bpy.types.Object) and self.is_plant and self.live:
        ops.schedule_rebuild(ob)


# FernParams' names for the fern's properties where the two differ (the
# vine has a length and a leaf size of its own).
FERN_PROPS = {"length": "fern_length", "leaf_size": "fern_leaf_size"}


def _variety_defaults(s):
    for k, v in VARIETY_DEFAULTS[s.variety].items():
        setattr(s, FERN_PROPS.get(k, k), v)


def _variety_changed(self, context):
    """A fern that changes variety takes that variety's starting shape (karin's varietyDefaults)."""
    live, self.live = self.live, False
    try:
        _variety_defaults(self)
    finally:
        self.live = live
    _changed(self, context)


def _length(name, default, lo, hi, desc):
    return FloatProperty(name=name, default=default, min=lo, soft_max=hi, subtype="DISTANCE", unit="LENGTH", description=desc, update=_changed)


def _factor(name, default, desc):
    return FloatProperty(name=name, default=default, min=0.0, max=1.0, subtype="FACTOR", description=desc, update=_changed)


_V = VineParams()
_F = FernParams()


class FoliageSettings(bpy.types.PropertyGroup):
    is_plant: BoolProperty(default=False, options={"HIDDEN"})
    kind: EnumProperty(name="Kind", items=KINDS, default="FERN", options={"HIDDEN"})
    host: StringProperty(name="Host", description="The object this plant grows on, matched by name so a re-imported host is found again")
    order: IntProperty(options={"HIDDEN"}, description="Plants are grown in this order; each keeps clear of the ones before it")
    live: BoolProperty(name="Live", default=True, description="Grow again whenever a setting, the plant's transform or its host's changes")
    seed: IntProperty(name="Seed", default=0, min=0, max=2147483647, update=_changed)
    paint_tint: _factor("Paint Tint", _V.paint_tint, "How far the painted pieces' own colours are moved toward the chosen greens")
    shades: BoolVectorProperty(name="Greens", size=len(library.SHADES), default=(True,) * len(library.SHADES),
                               description="The greens the leaves are tinted with", update=_changed)

    # Hanging vine.
    vine_length: _length("Length", _V.length, 0.05, 30.0, "The stem's length along the rock and down from it")
    vine_radius: _length("Stem Radius", _V.radius, 0.001, 0.06, "The stem's radius at its root; it tapers to a third at the tip")
    cling: _factor("Cling", _V.cling, "How long the stem holds to the rock over a steep side or an overhang before it lets go and hangs")
    bend: _factor("Bend", _V.bend, "How softly a hanging stem turns down")
    leaf_spacing: _length("Leaf Gap", _V.leaf_spacing, 0.04, 2.0, "Distance between leaves along the stem")
    vine_leaf_size: _length("Leaf Size", _V.leaf_size, 0.03, 1.0, "Leaf length (painted leaves keep their sizes relative to one another)")
    leaf_angle: FloatProperty(name="Leaf Spread", default=_V.leaf_angle, min=5.0, max=85.0, description="Degrees a leaf stands off the stem", update=_changed)
    variation: _factor("Variation", _V.variation, "How much leaves vary in size, angle, colour and rhythm")
    natural: BoolProperty(name="Natural Leaves", default=_V.natural,
                          description="Gravity droop, curved blades, colour and size by age; off is the flat early look", update=_changed)
    painted_leaves: BoolVectorProperty(name="Painted Leaves", size=len(library.PAINTED_LEAVES), default=(True,) * len(library.PAINTED_LEAVES),
                                       description="Painted watercolour leaves, which keep their own colours", update=_changed)
    silhouette_leaves: BoolVectorProperty(name="Silhouettes", size=len(library.SILHOUETTE_LEAVES), default=(False,) * len(library.SILHOUETTE_LEAVES),
                                          description="Brush silhouettes, tinted with the chosen greens", update=_changed)

    # Fern.
    variety: EnumProperty(name="Variety", items=VARIETIES, default=_F.variety, update=_variety_changed)
    fronds: IntProperty(name="Fronds", default=_F.fronds, min=1, max=24, description="Fronds the clump tries to fit; a tight spot fits fewer", update=_changed)
    fern_length: _length("Length", _F.length, 0.05, 3.0, "Frond length")
    length_var: _factor("Length Variation", _F.length_var, "How much the fronds' lengths vary")
    droop: _factor("Droop", _F.droop, "How far the fronds bend down toward their tips")
    spread: FloatProperty(name="Spread", default=_F.spread, min=5.0, max=85.0, description="Degrees the fronds open out from the clump's axis", update=_changed)
    lean: _factor("Lean", _F.lean, "How far the clump leans toward its open side (the plant's +Y)")
    fold: _factor("Midrib Fold", _F.fold, "How far each frond folds down its midrib")
    twist: _factor("Twist", _F.twist, "How much the fronds twist along their length")
    croziers: IntProperty(name="Fiddleheads", default=_F.croziers, min=0, max=6, description="Young coiled fronds standing in the middle", update=_changed)
    pinnae: IntProperty(name="Leaf Pairs", default=_F.pinnae, min=3, max=30, description="Pairs of leaves (or leaflet stems) along each frond", update=_changed)
    leaflets: IntProperty(name="Tiny Leaves", default=_F.leaflets, min=0, max=14,
                          description="Tiny leaves a side on each leaflet stem; 0 sets single leaves straight on the frond", update=_changed)
    fern_leaf_size: FloatProperty(name="Leaf Size", default=_F.leaf_size, min=0.3, max=2.0, description="Leaf size, as a multiple of the reference size", update=_changed)
    leaf_curve: _factor("Leaf Curve", _F.leaf_curve, "How curved the leaves are: the crease, the tip's curl and the sideways sweep")
    leaf_form: EnumProperty(name="Leaf Form", items=(("SMOOTH", "Smooth", "Leaves joined straight to the stem"),
                                                     ("CREASED", "Creased", "Deeply folded leaves, overlapping like shingles")),
                            default=_F.leaf_form, update=_changed)
    mirror_pairs: BoolProperty(name="Mirror Pairs", default=_F.mirror_pairs, description="The two leaves of a pair are mirror images, alike in size and colour", update=_changed)
    leaf_variation: _factor("Leaf Variation", _F.leaf_variation, "How much leaves vary in colour and size")
    frond_pieces: BoolVectorProperty(name="Fronds", size=len(library.FRONDS), default=(True,) * len(library.FRONDS),
                                     description="The painted fronds the clump picks from", update=_changed)

    # Solid cave plants. Lengths are metres before the object's scale.
    mushroom_form: EnumProperty(name="Form", items=(("CAP", "Stemmed Caps", "Umbrella caps with luminous gills"),
                                                     ("SHELF", "Wall Shelves", "Thin fans projecting from a wall")), update=_changed)
    cluster_count: IntProperty(name="Count", default=5, min=1, max=24, update=_changed)
    cluster_radius: _length("Cluster Radius", 0.22, 0.01, 1.5, "Area over which individual attachments are placed")
    bio_size: _length("Size", 0.12, 0.015, 0.6, "Cap radius, orb radius, or frond half-width")
    bio_height: _length("Height", 0.38, 0.03, 2.0, "Stem height or frond length; shelves and orb stalks have their own proportions")
    bio_variation: _factor("Size Variation", 0.45, "Independent seeded variation in width and height")
    shape_variation: _factor("Shape Variation", 0.7, "Variation in cap profiles, bulb proportions, stem bends and frond curls")
    surface_detail: _factor("Surface Detail", 0.7, "Cap surface markings, soft orb lobe depth, and subtle frond twist; outlines stay smooth")
    cap_dome: _factor("Cap Dome", 0.32, "Cap height relative to radius; shelves use a quarter of this")
    orb_stalk: _factor("Stalk Length", 0.65, "Short individual stalk length, as a fraction of the bulb's diameter")
    body_color: FloatVectorProperty(name="Body Colour", size=3, subtype="COLOR", min=0.0, max=1.0,
                                   default=(0.055, 0.18, 0.025), update=_changed)
    glow_color: FloatVectorProperty(name="Glow Colour", size=3, subtype="COLOR", min=0.0, max=1.0,
                                   default=(0.45, 1.0, 0.12), update=_changed)
    glow_strength: FloatProperty(name="Emission", default=2.5, min=0.0, soft_max=10.0,
                                 description="Surface brightness; nearby game lights illuminate the surroundings", update=_changed)

    # Glow flora (glowflora.py). The patch's own options are `glow_<kind>_<key>`,
    # one set per patch kind as the web generator keeps them, added below the class.
    glow_kind: EnumProperty(name="Patch", items=GLOW_KINDS, default="GROVE", update=_changed)
    glow_palette: EnumProperty(name="Palette", items=GLOW_PALETTES, default="PASTEL", update=_changed)
    glow_detail: EnumProperty(name="Detail", items=(("0", "High", "Close-up detail"), ("1", "Mid", "About half the triangles"),
                                                    ("2", "Low", "About an eighth of the triangles, for distant patches")),
                              default="0", update=_changed)
    glow_collisions: BoolProperty(name="Keep Apart", default=True, update=_changed,
                                  description="Move plants until nothing intersects another plant, the mound, the ground or itself, "
                                              "with room for the sway")
    glow_edits: StringProperty(name="Edits", default="", options={"HIDDEN"}, update=_changed,
                               description="Per-plant edits from a pasted patch (JSON): the plants as they were edited in the web generator")
    glow_items: IntProperty(options={"HIDDEN"})
    glow_remaining: IntProperty(options={"HIDDEN"})
    glow_dropped: IntProperty(options={"HIDDEN"})

    # Read back after a build, for the panel.
    triangles: IntProperty(options={"HIDDEN"})
    leaves: IntProperty(options={"HIDDEN"})
    parts: IntProperty(options={"HIDDEN"})
    build_ms: FloatProperty(options={"HIDDEN"})
    status: StringProperty(options={"HIDDEN"})

    # Everything a template hands on (Copy to Selected, a new plant from the panel's).
    SHARED = ("paint_tint", "shades")
    VINE_KEYS = ("vine_length", "vine_radius", "cling", "bend", "leaf_spacing", "vine_leaf_size", "leaf_angle", "variation",
                 "natural", "painted_leaves", "silhouette_leaves")
    FERN_KEYS = ("variety", "fronds", "fern_length", "length_var", "droop", "spread", "lean", "fold", "twist", "croziers",
                 "pinnae", "leaflets", "fern_leaf_size", "leaf_curve", "leaf_form", "mirror_pairs", "leaf_variation", "frond_pieces")
    BIO_KEYS = ("cluster_count", "cluster_radius", "bio_size", "bio_height", "bio_variation", "shape_variation", "surface_detail",
                "body_color", "glow_color", "glow_strength")

    def keys_for(self, kind):
        if kind == "GLOW":
            return GLOW_KEYS
        if kind in BIOLUME_KINDS:
            return self.BIO_KEYS + {"MUSHROOM": ("mushroom_form", "cap_dome"),
                                   "ORBS": ("orb_stalk",)}[kind]
        return self.SHARED + (self.FERN_KEYS if kind == "FERN" else self.VINE_KEYS)

    def copy_from(self, other):
        """Take the other plant's settings for this plant's kind: the values it
        has set, and the defaults where it has none (as the ivy's copy does, so
        a copy follows the defaults where its source did). The seed is kept."""
        live, self.live = self.live, False
        try:
            for k in self.keys_for(self.kind):
                if k in other:
                    setattr(self, k, getattr(other, k))
                else:
                    self.property_unset(k)
        finally:
            self.live = live

    def reset(self):
        """Back to the defaults (the variety's, for a fern); the seed is kept."""
        live, self.live = self.live, False
        try:
            variety = self.variety
            for k in self.keys_for(self.kind):
                self.property_unset(k)
            if self.kind == "FERN":
                self.variety = variety  # not live, so its update schedules nothing
                _variety_defaults(self)
        finally:
            self.live = live

    def vine_params(self, scale=1.0):
        leaves = tuple(p for p, on in zip(library.PAINTED_LEAVES, self.painted_leaves) if on)
        leaves += tuple(p for p, on in zip(library.SILHOUETTE_LEAVES, self.silhouette_leaves) if on)
        return VineParams(length=self.vine_length * scale, radius=self.vine_radius * scale, cling=self.cling, bend=self.bend,
                          leaf_spacing=self.leaf_spacing * scale, leaf_size=self.vine_leaf_size * scale, leaf_angle=self.leaf_angle,
                          variation=self.variation, seed=self.seed, natural=self.natural, paint_tint=self.paint_tint,
                          leaves=leaves, shades=tuple(self.shades))

    def fern_params(self, scale=1.0):
        return FernParams(variety=self.variety, fronds=self.fronds, length=self.fern_length * scale, length_var=self.length_var,
                          droop=self.droop, spread=self.spread, lean=self.lean, fold=self.fold, twist=self.twist,
                          croziers=self.croziers, paint_tint=self.paint_tint, seed=self.seed, pinnae=self.pinnae,
                          leaflets=self.leaflets, leaf_size=self.fern_leaf_size, leaf_curve=self.leaf_curve,
                          leaf_form=self.leaf_form, mirror_pairs=self.mirror_pairs, leaf_variation=self.leaf_variation,
                          pieces=tuple(p for p, on in zip(library.FRONDS, self.frond_pieces) if on), shades=tuple(self.shades))

    def glow_params(self):
        """The web generator's options for this patch: its kind's, the palette and the seed."""
        kind = self.glow_kind.lower()
        p = {"kind": kind, "seed": self.seed, "palette": self.glow_palette.lower()}
        for key, *_rest in glowflora.PATCH_FIELDS[kind]:
            p[key] = getattr(self, glow_prop(kind, key))
        return p

    def set_glow_params(self, params):
        """Take a pasted patch's options (not live: the caller rebuilds)."""
        kind = params["kind"]
        self.glow_kind = kind.upper()
        if str(params.get("palette", "")).upper() in {k for k, _l, _d in GLOW_PALETTES}:
            self.glow_palette = params["palette"].upper()
        self.seed = int(params.get("seed", self.seed)) & 0x7FFFFFFF
        for key, *_rest in glowflora.PATCH_FIELDS[kind]:
            if key in params:
                setattr(self, glow_prop(kind, key), params[key])

    def reach(self, scale=1.0):
        """How far from its root the plant can reach: a sphere nothing outside of
        which can change how it grows."""
        if self.kind == "GLOW":
            p = self.glow_params()
            across = p.get("spread", 0.0) + p.get("width", 0.0) * p["size"] / 0.55
            return (3.0 * p["size"] + 2.0 * across + 0.5) * scale
        if self.kind in BIOLUME_KINDS:
            return (self.cluster_radius + (self.bio_height + 7 * self.bio_size) * (1 + self.bio_variation)) * scale + 0.15
        if self.kind == "VINE":
            return self.vine_length * scale + 2.0 * self.vine_leaf_size * scale + 0.1
        return self.fern_length * scale * (1.0 + self.length_var) * 1.3 + 0.1


class FoliageScatter(bpy.types.PropertyGroup):
    count: IntProperty(name="Count", default=5, min=1, max=30, description="Ferns to scatter over the host")
    spacing: FloatProperty(name="Spacing", default=0.3, min=0.05, soft_max=3.0, subtype="DISTANCE", unit="LENGTH",
                           description="The least distance between two ferns' crowns")


def _glow_options():
    """One property per patch kind and option, ranged as the web generator's sliders."""
    keys = []
    for kind, fields in glowflora.PATCH_FIELDS.items():
        for key, label, lo, hi, step in fields:
            name = glow_prop(kind, key)
            default = glowflora.DEFAULTS[kind][key]
            if step >= 1:
                prop = IntProperty(name=label, default=int(default), min=int(lo), max=int(hi), update=_changed)
            else:
                prop = FloatProperty(name=label, default=float(default), min=float(lo), max=float(hi), step=step * 100,
                                     precision=2, update=_changed)
            FoliageSettings.__annotations__[name] = prop
            keys.append(name)
    return tuple(keys)


GLOW_KEYS = ("glow_kind", "glow_palette", "glow_detail", "glow_collisions", "glow_edits") + _glow_options()

CLASSES = (FoliageSettings, FoliageScatter)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    bpy.types.Object.foliage = bpy.props.PointerProperty(type=FoliageSettings)
    bpy.types.Scene.foliage_scatter = bpy.props.PointerProperty(type=FoliageScatter)


def unregister():
    del bpy.types.Scene.foliage_scatter
    del bpy.types.Object.foliage
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
