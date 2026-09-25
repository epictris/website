"""The generator's parameter schema (params.json), read at run time.

params.json is the one place a design knob's default is stated: the editor's
inspector, the dev server's validation and this generator all read it. A module
that used to hard-code a knob asks `param(spec, key)`, which answers from the
spec it was handed and falls back to the schema default, so a caller that
builds its own spec (the fork's dirt-moss generator, the sample specs, the
maintenance scripts) still gets the approved values without restating them.
"""
import json
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent / "params.json"
_schema = None


def schema():
    global _schema
    if _schema is None:
        _schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return _schema


def defaults():
    return {p["key"]: p["default"] for p in schema()["params"]}


def param(spec, key):
    if spec is not None and key in spec:
        return spec[key]
    values = defaults()
    if key not in values:
        raise KeyError(f"{key} is not a boulder parameter; see params.json")
    return values[key]
