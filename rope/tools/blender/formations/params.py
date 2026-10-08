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

from .worker import DEFAULT_PARAMS, GENERATORS

# Lengths show three significant digits: Blender's unit display counts
# precision in them, and at its default 1.05 m reads as "1 m".
# Recipe key -> field, per generator, in the order the panel shows them.
FIELDS = {
    "fitted": {"seed": "seed", "depth": "depth", "smallestRock": "smallest_rock", "largestRock": "largest_rock"},
    "boulders": {"seed": "seed", "depth": "depth", "slabsPerArea": "slabs_per_area", "weathering": "weathering",
                 "faceBudget": "face_budget", "detail": "detail", "voxelCap": "voxel_cap"},
    "solid": {"seed": "seed", "stoneSize": "stone_size", "facets": "facets", "chisel": "chisel", "knub": "knub",
              "curveTurn": "curve_turn", "floor": "floor", "fixedScale": "fixed_scale",
              "facetFalloff": "facet_falloff"},
}
FITTED = GENERATORS["fitted"]
SOLID = GENERATORS["solid"]


class FormationParams(bpy.types.PropertyGroup):
    loaded: BoolProperty(description="The fields hold this rock's parameters")
    generator: EnumProperty(name="Generator", items=[
        ("fitted", "Fitted slate", "Recipe F rocks sized and turned to fit the outline, fused into one mass: "
                                   "the cave look (docs/cave-look.md)"),
        ("boulders", "Boulder generator", "The fork's slab generator, cut to the outline"),
        ("solid", "Solid guide", "Recipe F stones cut from a closed guide mesh, sized by their depth from the "
                                 "game's start camera: the backdrop (docs/blender-backdrop.md)"),
    ])
    seed: IntProperty(name="Seed", default=FITTED["seed"], min=0)
    depth: FloatProperty(name="Thickness", default=1.05, min=.02, max=50, precision=3, subtype="DISTANCE")
    smallest_rock: FloatProperty(name="Smallest rock", description="A rock's smallest long half-length",
                                 default=FITTED["smallestRock"], min=.05, max=10, precision=3, subtype="DISTANCE")
    largest_rock: FloatProperty(name="Largest rock", description="A rock's largest long half-length",
                                default=FITTED["largestRock"], min=.1, max=50, precision=3, subtype="DISTANCE")
    slabs_per_area: FloatProperty(name="Fractures", description="Slabs per square metre of outline (2 to 100 in all)",
                                  default=DEFAULT_PARAMS["slabsPerArea"], min=.5, max=100)
    weathering: FloatProperty(name="Weathering", description="How irregular each slab's corners and long edges are",
                              default=DEFAULT_PARAMS["weathering"], min=0, max=1)
    face_budget: IntProperty(name="Face budget", description="Faces kept per 8.5 m of outline perimeter",
                             default=DEFAULT_PARAMS["faceBudget"], min=200, max=100000, soft_max=10000)
    detail: FloatProperty(name="Remesh detail", description="Remesh resolution: finer as it rises",
                          default=DEFAULT_PARAMS["detail"], min=.25, max=4)
    stone_size: FloatProperty(name="Stone size", description="Every stone's size times this (on screen, so the "
                              "same at any depth); stones on a curve still split down to the small sizes",
                              default=SOLID["stoneSize"], min=.25, max=4)
    facets: FloatProperty(name="Facets", description="Facet density on flat stones, as a share of recipe F's "
                          "(stones on a curve take its full density)", default=SOLID["facets"], min=.05, max=2)
    chisel: FloatProperty(name="Chisel", description="Chisel cuts, as a share of recipe F's: the small steps "
                          "on a stone's faces", default=SOLID["chisel"], min=0, max=2)
    knub: FloatProperty(name="Merge small", description="A stone under this share of its kind's median volume "
                        "is joined to its neighbour instead of standing as a knub", default=SOLID["knub"], min=0, max=1)
    curve_turn: FloatProperty(name="Curve split", description="Degrees a cell's surface must turn in gentle bends "
                              "before it splits into smaller stones; lower keeps more curves round",
                              default=SOLID["curveTurn"], min=5, max=1000)
    floor: FloatProperty(name="Depth floor", description="The least depth scale a stone is cut at: 0 sizes every "
                         "stone by its own depth; above it, a part near the gameplay plane is cut as if this far "
                         "back (the roof's ceiling, run forward to the level)", default=SOLID["floor"], min=0, max=20)
    fixed_scale: FloatProperty(name="Fixed LOD", description="When over 0, every stone is cut, weathered and "
                               "faceted as if it stood this many times the gameplay plane's distance from the eye, "
                               "whatever its depth: the level of detail set by hand (0: from each stone's depth)",
                               default=SOLID["fixedScale"], min=0, max=20)
    facet_falloff: FloatProperty(name="Facet falloff", description="How much coarser on screen the facets get per "
                                 "unit of depth scale: 0 keeps them as fine on screen at any depth",
                                 default=SOLID["facetFalloff"], min=0, max=3)
    voxel_cap: FloatProperty(name="Voxel cap", description="Largest remesh voxel, whatever the outline",
                             default=DEFAULT_PARAMS["voxelCap"], min=.002, max=.1, precision=3, subtype="DISTANCE")


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
    for field in FIELDS[settings.generator].values():
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
    given = recipe["params"]
    params = {k: given.get(k, GENERATORS[generator].get(k)) for k in FIELDS[generator]}
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


def load_all():
    from . import core
    for ob in bpy.data.objects:
        if core.is_formation(ob) and ob.is_editable and not ob.formation_params.loaded:
            try:
                load(ob)
            except (KeyError, TypeError, ValueError):
                pass  # A broken recipe is reported where it is built from.


@persistent
def on_load(_):
    load_all()
    from . import core
    core.stow_helpers()


CLASSES = (FormationParams,)
