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
}
FITTED = GENERATORS["fitted"]


class FormationParams(bpy.types.PropertyGroup):
    loaded: BoolProperty(description="The fields hold this rock's parameters")
    generator: EnumProperty(name="Generator", items=[
        ("fitted", "Fitted slate", "Recipe F rocks sized and turned to fit the outline, fused into one mass: "
                                   "the cave look (docs/cave-look.md)"),
        ("boulders", "Boulder generator", "The fork's slab generator, cut to the outline"),
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
    voxel_cap: FloatProperty(name="Voxel cap", description="Largest remesh voxel, whatever the outline",
                             default=DEFAULT_PARAMS["voxelCap"], min=.002, max=.1, precision=3, subtype="DISTANCE")


def draw(layout, settings):
    layout.use_property_split = True
    layout.use_property_decorate = False
    layout.prop(settings, "generator")
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


CLASSES = (FormationParams,)
