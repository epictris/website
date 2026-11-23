"""A formation's generator parameters, as fields on the rock.

`formation_recipe` records what BUILT the mesh; `Object.formation_params` is
what the next build will use, edited in the panel. They start equal (`load`,
when a rock comes in or a file opens) and part when a field is changed, which
makes the formation pending until it is regenerated. A rock whose fields were
never loaded (appended from another file, or the add-on not registered, as in
the scene exporter) builds from its recipe.

The generator's defaults are worker.GENERATORS; the fields only name them.
"""

from __future__ import annotations

import json
import math
import re

import bpy
from bpy.app.handlers import persistent
from bpy.props import BoolProperty, EnumProperty, FloatProperty, IntProperty

from .worker import DEFAULT_PARAMS, GENERATORS, LEGACY_THICKNESS, SOLID_VARIANTS, legacy_slab_size, solid_parameters

# Lengths show three significant digits: Blender's unit display counts
# precision in them, and at its default 1.05 m reads as "1 m".
# Recipe key -> field, per generator, in the order the panel shows them.
FIELDS = {
    "fitted": {"seed": "seed", "depth": "depth", "smallestRock": "smallest_rock", "largestRock": "largest_rock"},
    "boulders": {"seed": "seed", "depth": "depth", "slabsPerArea": "slabs_per_area", "slabWidth": "slab_width",
                 "slabLength": "slab_length", "weathering": "weathering",
                 "faceBudget": "face_budget", "detail": "detail", "voxelCap": "voxel_cap",
                 "edgeBevelWidth": "edge_bevel"},
    "solid": {"seed": "seed", "stoneSize": "stone_size", "surfaceRelief": "surface_relief",
              "jointed": "jointed", "wall": "wall", "stones": "stones", "faceted": "faceted",
              "jointAspect": "joint_aspect", "knub": "knub", "curveTurn": "curve_turn"},
}
# The solid fields the variant sets, never shown as themselves.
VARIANT_FIELDS = {"jointed", "wall", "stones", "faceted"}
# The solid fields a variant does not use, by its field name.
HIDDEN = {"wall": {"knub", "curve_turn"}, "boulder": {"joint_aspect"},
          "stones": {"knub", "curve_turn", "joint_aspect", "surface_relief"},
          "faceted": {"knub", "curve_turn", "joint_aspect"}}
# The label a solid field takes under a variant, by its field name.
LABELS = {"wall": {"joint_aspect": "Slab height / width"},
          "faceted": {"stone_size": "Facet size", "surface_relief": "Bulge"}}
FITTED = GENERATORS["fitted"]
SOLID = GENERATORS["solid"]


def _variant_get(settings):
    if settings.faceted:
        return 4
    if settings.stones:
        return 3
    if settings.wall:
        return 2
    return 1 if settings.jointed else 0


def _variant_set(settings, value):
    settings.jointed = value == 1
    settings.wall = value == 2
    settings.stones = value == 3
    settings.faceted = value == 4


class FormationParams(bpy.types.PropertyGroup):
    loaded: BoolProperty(description="The fields hold this rock's parameters")
    # Fields saved before 2026-10-16 hold a boulder rock's construction depth
    # in `depth`, not its thickness; `load_all` converts them once.
    real_thickness: BoolProperty(description="Thickness is the rock's own, front to back")
    # Fields saved before 2026-10-16 have no slab width or length; `load_all`
    # gives them the ones the rock was built with, once.
    slab_sizes: BoolProperty(description="Slab width and length are the rock's own")
    generator: EnumProperty(name="Generator", items=[
        ("fitted", "Fitted slate", "Recipe F rocks sized and turned to fit the outline, fused into one mass: "
                                   "the cave look (docs/cave-look.md)"),
        ("boulders", "Boulder generator", "The fork's slab generator, cut to the outline"),
        ("solid", "Solid guide", "Stones cut from a closed guide mesh, each worked as the boulder generator works "
                                 "its top, at full detail in the asset's local coordinates "
                                 "(docs/blender-backdrop.md)"),
    ])
    seed: IntProperty(name="Seed", default=FITTED["seed"], min=0)
    depth: FloatProperty(name="Thickness", description="The rock's thickness through the gameplay plane, front to "
                         "back", default=1.05, min=.02, max=50, precision=3, subtype="DISTANCE")
    smallest_rock: FloatProperty(name="Smallest rock", description="A rock's smallest long half-length",
                                 default=FITTED["smallestRock"], min=.05, max=10, precision=3, subtype="DISTANCE")
    largest_rock: FloatProperty(name="Largest rock", description="A rock's largest long half-length",
                                default=FITTED["largestRock"], min=.1, max=50, precision=3, subtype="DISTANCE")
    slabs_per_area: FloatProperty(name="Fractures", description="Slabs per square metre of outline (at least "
                                  "2): how densely they overlap",
                                  default=DEFAULT_PARAMS["slabsPerArea"], min=.5, max=100)
    slab_width: FloatProperty(name="Slab width", description="A slab's width across the outline, about its middle "
                              "(75 to 125 %): the same at any outline size", default=DEFAULT_PARAMS["slabWidth"],
                              min=.05, max=20, precision=3, subtype="DISTANCE")
    slab_length: FloatProperty(name="Slab length", description="A slab's length up the outline, about its middle "
                               "(61 to 139 %): the same at any outline size", default=DEFAULT_PARAMS["slabLength"],
                               min=.05, max=20, precision=3, subtype="DISTANCE")
    weathering: FloatProperty(name="Weathering", description="How irregular each slab's corners and long edges are",
                              default=DEFAULT_PARAMS["weathering"], min=0, max=1)
    face_budget: IntProperty(name="Face budget", description="Faces kept per 30 m² of rock surface",
                             default=DEFAULT_PARAMS["faceBudget"], min=200, max=100000, soft_max=10000)
    detail: FloatProperty(name="Remesh detail", description="Remesh resolution: finer as it rises",
                          default=DEFAULT_PARAMS["detail"], min=.25, max=4)
    stone_size: FloatProperty(name="Stone size", description="Every stone's physical size times this, "
                              "including its steps, bevels, curvature-split minimum and "
                              "small-fragment threshold", default=SOLID["stoneSize"], min=.25, max=4)
    knub: FloatProperty(name="Merge small", description="A stone under this share of its kind's median volume "
                        "is joined to its neighbour instead of standing as a knub", default=SOLID["knub"], min=0, max=1)
    surface_relief: FloatProperty(name="Surface relief", description="Depth of projecting cleavage planes and "
                                  "offset folds, as a share of Stone size; zero keeps the shallow roof taper",
                                  default=SOLID["surfaceRelief"], min=0, max=1.5)
    jointed: BoolProperty(name="Jointed rock", default=SOLID['jointed'],
                         description="Long primary fractures and clustered secondary breaks in one rock mass")
    wall: BoolProperty(default=False, description="Build overlapping vertical slabs on the guide")
    stones: BoolProperty(default=False, description="Pack whole recipe F stones into the guide")
    faceted: BoolProperty(default=False, description="Round the guide and cut it into broad planes")
    variant: EnumProperty(name="Variant", items=SOLID_VARIANTS,
                          get=_variant_get, set=_variant_set,
                          description="Rock generation style; existing size and relief settings are retained")
    joint_aspect: FloatProperty(name="Joint length", default=SOLID['jointAspect'], min=1, max=6,
                               description="Primary fracture length along local Z, relative to stone width")
    curve_turn: FloatProperty(name="Curve split", description="Degrees a cell's surface must turn in gentle bends "
                              "before it splits into smaller stones; lower keeps more curves round",
                              default=SOLID["curveTurn"], min=5, max=1000)
    voxel_cap: FloatProperty(name="Voxel cap", description="Largest remesh voxel, whatever the outline",
                             default=DEFAULT_PARAMS["voxelCap"], min=.002, max=.1, precision=3, subtype="DISTANCE")
    edge_bevel: FloatProperty(name="Edge bevel", description="Width of the bevel on every sharp edge: well under a "
                              "millimetre it draws a fine highlight along each crease; 0 leaves the edges sharp",
                              default=DEFAULT_PARAMS["edgeBevelWidth"], min=0, max=.05, precision=5, step=.001,
                              subtype="DISTANCE")


def draw(layout, settings, solid):
    """The fields for a rock built from a guide mesh (`solid`) or from an
    outline: neither can take the other's generator, so only the outline's
    two are offered, and a solid rock's one is not."""
    layout.use_property_split = True
    layout.use_property_decorate = False
    if not solid:
        # Laid out as a split property's row: a label, then the two choices.
        split = layout.split(factor=.4, align=True)
        label = split.row()
        label.alignment = "RIGHT"
        label.label(text="Generator")
        row = split.row(align=True)
        row.use_property_split = False
        row.prop_enum(settings, "generator", "fitted", text="Fitted slate")
        row.prop_enum(settings, "generator", "boulders", text="Boulders")
    else:
        layout.prop(settings, 'variant')
    variant = SOLID_VARIANTS[_variant_get(settings)][0]
    for field in FIELDS[settings.generator].values():
        if field in VARIANT_FIELDS:
            continue
        if solid and field in HIDDEN.get(variant, ()):
            continue
        label = LABELS.get(variant, {}).get(field) if solid else None
        if label:
            layout.prop(settings, field, text=label)
        else:
            layout.prop(settings, field)


def from_settings(settings):
    """The recipe's `generator` and `params` the fields ask for. Fields are
    single precision; six significant digits give back what was typed."""
    params = {}
    for key, field in FIELDS[settings.generator].items():
        value = getattr(settings, field)
        params[key] = value if isinstance(value, int) else float(f"{value:.6g}")
    return settings.generator, params


def generator_of(recipe):
    """A recipe's generator. A recipe without one is the boulder generator's,
    and Karin's pipeline (the grotto's rocks) recorded the generator's
    directory, `C:\\...\\tools\\blender\\boulders`."""
    name = re.split(r"[\\/]", recipe.get("generator", "boulders"))[-1]
    if name not in FIELDS:
        raise ValueError(f"Unknown generator {recipe['generator']!r}")
    return name


def built(ob):
    """The generator and parameters the mesh was built with, defaults filled."""
    recipe = json.loads(ob["formation_recipe"])
    generator = generator_of(recipe)
    given = solid_parameters(recipe) if generator == 'solid' else recipe["params"]
    params = {k: given.get(k, GENERATORS[generator].get(k)) for k in FIELDS[generator]}
    if generator == "boulders" and recipe.get("version", 1) < 2:
        # Built when its depth was the construction's and its slabs were
        # shares of its outline (worker.RECIPE_VERSION).
        if params["depth"] is not None:
            params["depth"] *= LEGACY_THICKNESS
        params["slabWidth"], params["slabLength"] = legacy_slab_size(recipe["outline"])
    return generator, params


def editable(ob):
    settings = getattr(ob, "formation_params", None)
    return settings if settings is not None and settings.loaded else None


def validate(settings):
    if settings.generator == "fitted" and settings.smallest_rock > settings.largest_rock:
        raise ValueError("The smallest rock is larger than the largest")


def current(ob):
    """The generator and parameters the next build of `ob` uses."""
    settings = editable(ob)
    if settings is None:
        return built(ob)
    validate(settings)
    # A guide mesh is no outline, and an outline no guide.
    if (settings.generator == "solid") != (built(ob)[0] == "solid"):
        raise ValueError(ob.name + ": a formation built from a guide mesh stays a Solid guide, and one built "
                                   "from an outline cannot become one")
    return from_settings(settings)


def changed(ob):
    settings = editable(ob)
    recipe = json.loads(ob['formation_recipe'])
    if settings is None:
        return False
    (want, asked), (had, used) = from_settings(settings), built(ob)
    return want != had or any(v is None or not math.isclose(asked[k], v, rel_tol=1e-5, abs_tol=1e-9)
                              for k, v in used.items())


def load(ob):
    """Set the fields to the parameters the mesh was built with."""
    settings = ob.formation_params
    generator, params = built(ob)
    settings.generator = generator
    for key, field in FIELDS[generator].items():
        if params[key] is not None:
            setattr(settings, field, params[key])
    settings.loaded = True
    settings.real_thickness = True
    settings.slab_sizes = True


def load_all():
    from . import core
    for ob in bpy.data.objects:
        if not core.is_formation(ob) or not ob.is_editable:
            continue
        settings = ob.formation_params
        if not settings.loaded:
            try:
                load(ob)
            except (KeyError, TypeError, ValueError):
                pass  # A broken recipe is reported where it is built from.
            continue
        if not settings.real_thickness:
            if settings.generator == "boulders":
                settings.depth *= LEGACY_THICKNESS
            settings.real_thickness = True
        if not settings.slab_sizes:
            try:
                generator, params = built(ob)
            except (KeyError, TypeError, ValueError):
                continue
            if generator == "boulders":
                settings.slab_width, settings.slab_length = params["slabWidth"], params["slabLength"]
            settings.slab_sizes = True


@persistent
def on_load(_):
    load_all()
    from . import core
    core.guide_worlds.clear()
    core.remove_source_slabs()
    core.stow_helpers()
    core.style_guides()
    for scene in bpy.data.scenes:
        for key in core.STALE_BUSY_KEYS:
            scene.pop(key, None)


CLASSES = (FormationParams,)
