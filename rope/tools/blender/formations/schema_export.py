"""The formation generators' parameters as JSON, for the level editor.

    blender -b --factory-startup --python-exit-code 1 \
        --python tools/blender/formations/schema_export.py -- OUT.json

Read off the add-on itself, so the editor's Formation panel offers what the
Blender panel offers and nothing it does not: the recipe keys and their panel
order (`params.FIELDS`), each field's label, description, type, default and
bounds (`params.FormationParams`), the defaults the worker builds with
(`worker.GENERATORS`, which win where the two differ: the field's default is
only where a fresh Blender field starts), the solid variants, the recipe's
version, and the visibility rules `params.draw` applies, written as data.

`tools/blender/test_formation_schema.py` holds the written file to the add-on:
every recipe key of `worker.GENERATORS` is in it with the same default, and
the rules show exactly the fields `params.draw` shows for every variant.

The output is `src/level/formationSchema.json` (`just formation-schema`);
it is generated, never edited by hand.
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from formations import params  # noqa: E402
from formations.worker import GENERATORS, RECIPE_VERSION, SOLID_VARIANTS  # noqa: E402

# Fields `params.draw` never shows as themselves: the solid variant sets them.
VARIANT_FIELDS = {"jointed", "wall"}

# `params.draw`'s rules for which solid fields show, by variant, and the label
# one takes under a variant. Checked against `draw` by the Blender test.
HIDDEN = {"wall": {"knub", "curveTurn"}, "boulder": {"jointAspect"}}
LABELS = {"wall": {"jointAspect": "Slab height / width"}}


def prop_of(name):
    """The deferred property `name` of FormationParams. params.py has
    `from __future__ import annotations`, so its annotations are source text,
    evaluated here in its own namespace as Blender evaluates them."""
    prop = params.FormationParams.__annotations__[name]
    return eval(prop, vars(params)) if isinstance(prop, str) else prop


def field_spec(key, prop_name, default):
    """One recipe key's field: what the add-on's property says of itself."""
    prop = prop_of(prop_name)
    kind = prop.function.__name__
    kw = dict(prop.keywords)
    spec = {"key": key, "label": kw.get("name", key), "description": kw.get("description", "")}
    if kind == "BoolProperty":
        spec["type"] = "bool"
    elif kind == "IntProperty":
        spec["type"] = "int"
    elif kind == "FloatProperty":
        spec["type"] = "float"
        if kw.get("subtype") == "DISTANCE":
            spec["unit"] = "m"
        if "precision" in kw:
            spec["precision"] = kw["precision"]
    else:
        raise SystemExit(f"{prop_name}: a {kind} has no editor field")
    for bound in ("min", "max", "soft_min", "soft_max"):
        if bound in kw:
            spec[bound.replace("soft_", "soft")] = kw[bound]
    spec["default"] = default if default is not None else kw.get("default")
    return spec


def schema():
    out = {"version": RECIPE_VERSION, "generators": {}}
    for generator, fields in params.FIELDS.items():
        defaults = GENERATORS[generator]
        specs = []
        for key, prop_name in fields.items():
            if generator == "solid" and key in VARIANT_FIELDS:
                continue
            specs.append(field_spec(key, prop_name, defaults.get(key)))
        items = prop_of("generator").keywords["items"]
        out["generators"][generator] = {"label": next(label for ident, label, _ in items if ident == generator),
                                        "fields": specs}
    out["generators"]["solid"]["variants"] = [
        {"id": ident, "label": label, "description": desc,
         "hidden": sorted(HIDDEN.get(ident, ())), "labels": LABELS.get(ident, {})}
        for ident, label, desc in SOLID_VARIANTS]
    # What a guide offers: an outline the two outline generators, a solid the one.
    out["outline"] = ["fitted", "boulders"]
    out["solid"] = ["solid"]
    return out


if __name__ == "__main__":
    target = Path(sys.argv[sys.argv.index("--") + 1])
    target.write_text(json.dumps(schema(), indent=2) + "\n")
    print("FORMATION_SCHEMA_OK", target)
