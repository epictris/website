"""The editor's formation schema against the add-on it was read from.

    blender -b --factory-startup --python-exit-code 1 --python tools/blender/test_formation_schema.py

Holds `src/level/formationSchema.json` (written by
`formations/schema_export.py`) to:

- the worker: every recipe key of `worker.GENERATORS` is in it with the same
  default (the solid's `jointed`, `wall` and `stones` are the variant, not
  fields);
- the panel: for each generator and solid variant, the fields the schema shows
  are exactly those `params.draw` lays out, in the same order, with the same
  labels where `draw` gives one of its own;
- the exporter: the file is what `schema_export.schema()` writes now, so an
  add-on change that was not re-exported fails here.

Prints FORMATION_SCHEMA_TEST_OK.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "blender"))
sys.path.insert(0, str(ROOT / "tools" / "blender" / "formations"))

from formations import params  # noqa: E402
from formations.worker import GENERATORS  # noqa: E402
import schema_export  # noqa: E402

written = json.loads((ROOT / "src" / "level" / "formationSchema.json").read_text())
fresh = schema_export.schema()
assert written == fresh, "src/level/formationSchema.json is stale: run `just formation-schema`"

for generator, defaults in GENERATORS.items():
    fields = {f["key"]: f for f in written["generators"][generator]["fields"]}
    for key, value in defaults.items():
        if generator == "solid" and key in schema_export.VARIANT_FIELDS:
            continue
        assert key in fields, f"{generator}.{key} is not in the schema"
        assert fields[key]["default"] == value, f"{generator}.{key}: schema {fields[key]['default']} != worker {value}"


class Layout:
    """Records what `params.draw` lays out: (property, label) in order."""

    def __init__(self, shown):
        self.shown = shown
        self.use_property_split = self.use_property_decorate = False

    def prop(self, _settings, name, text=None):
        self.shown.append((name, text))

    def prop_enum(self, *_args, **_kw):
        pass

    def label(self, **_kw):
        pass

    def split(self, **_kw):
        return Layout([])

    def row(self, **_kw):
        return Layout([])


class Settings:
    def __init__(self, generator, variant=None):
        self.generator = generator
        self.jointed = variant == "cliff"
        self.wall = variant == "wall"
        self.stones = variant == "stones"
        self.faceted = variant == "faceted"


key_of = {g: {prop: key for key, prop in fields.items()} for g, fields in params.FIELDS.items()}
cases = [("fitted", None), ("boulders", None)] + [("solid", v["id"]) for v in written["generators"]["solid"]["variants"]]
for generator, variant in cases:
    shown = []
    params.draw(Layout(shown), Settings(generator, variant), generator == "solid")
    drawn = [(key_of[generator][p], text) for p, text in shown if p != "variant"]
    spec = written["generators"][generator]
    v = next((x for x in spec.get("variants", []) if x["id"] == variant), {"hidden": [], "labels": {}})
    expected = [(f["key"], v["labels"].get(f["key"])) for f in spec["fields"] if f["key"] not in v["hidden"]]
    assert drawn == expected, f"{generator}/{variant}: draw shows {drawn}, the schema {expected}"

print("FORMATION_SCHEMA_TEST_OK")
