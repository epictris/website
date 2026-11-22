"""The decoration add-ons' settings as JSON, for the level editor.

    blender -b --factory-startup --python-exit-code 1 \
        --python tools/blender/decoration_schema_export.py -- OUT.json

What the editor's Decoration panel offers for a moss, an ivy, a fern, a
hanging vine, mushrooms, pendant orbs and glow flora: the same fields the
add-ons' own sidebar panels show (moss/ui.py, ivy/ui.py, foliage/ui.py), in
the same sections and under the same conditions, with every field's label,
description, type, default, bounds, step and options read off the add-on's
registered property itself - so the editor offers what Blender offers and
nothing it does not, and a field renamed or dropped in an add-on stops this
script rather than leaving the editor writing a setting nothing reads.

The layouts below are the one place the panels are restated: a section is a
title, its fields, an optional `when` (field -> the values it must have) or
`whenNot` (field -> values it must not have), and `closed` for a panel Blender
opens closed. A field may carry its own `when`/`whenNot`.

Not offered, because they are pickers rather than values: a fern's frond
pieces, a vine's leaf sets, the greens. A decoration's seed is its own field
in the editor (`DecorationObjectData.seed`), so it is not repeated here.

The output is `src/level/decorationSchema.json` (`just decoration-schema`);
it is generated, never edited by hand.
"""

import json
import sys
from pathlib import Path

import bpy

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import moss  # noqa: E402
import ivy  # noqa: E402
import foliage  # noqa: E402
from foliage.glowflora import PATCH_FIELDS  # noqa: E402
from foliage.settings import GLOW_KINDS, glow_prop  # noqa: E402

for addon in (moss, ivy, foliage):
    addon.register()

MOUND = {"kind": ["MOUND"]}

LAYOUTS = {
    "moss": {"group": "moss", "sections": [
        {"title": "Moss", "fields": ["kind", "detail"]},
        {"title": "Quality", "when": MOUND, "fields": ["mound_density", "texel", "max_texture"]},
        {"title": "Dabs", "fields": ["resolution", "threshold", "dab_min", "dab_max", "layers", "shrink", "buffer", "first_buffer", "min_clump"]},
        {"title": "Tone", "fields": ["dark", "light", "levels", "ref_depth", "steps_deep", "erode_scale", "field_mix", "curve", "mottle", "mottle_scale"]},
        {"title": "Height", "when": MOUND, "fields": ["floor", "lift", "up_floor", "height_blur", "rim", "drape"]},
        {"title": "Bioluminescence", "when": MOUND, "fields": ["emission_strength", "emission_color", "emission_threshold"]},
        {"title": "Edge", "fields": [
            {"field": "edge_kind", "when": MOUND},
            {"field": "edge_apron", "when": {"kind": ["MOUND"], "edge_kind": ["PRINT"]}},
            {"field": "edge_round", "when": MOUND, "whenNot": {"edge_kind": ["PRINT"]}},
            {"field": "overhang", "when": MOUND, "whenNot": {"edge_kind": ["PRINT"]}},
            {"field": "edge_detail", "when": MOUND, "whenNot": {"edge_kind": ["PRINT"]}},
            "strays", "stray_reach"]},
        {"title": "Grass", "when": MOUND, "fields": ["grass", "grass_height", "grass_blades", "grass_tip"]},
        {"title": "Mesh and print", "closed": True, "fields": ["min_patch", "print_edge"]},
    ]},
    "ivy": {"group": "ivy", "sections": [
        {"title": "Carpet", "fields": ["detail", "resolution"]},
        {"title": "Outline", "fields": ["threshold", "edge_noise", "edge_scale", "min_patch", "rounding"]},
        {"title": "Growth", "fields": ["thickness", "tilt", "spread", "taper"]},
        {"title": "Clumps", "when": {"detail": ["CLUMPS"]}, "fields": ["clump_min", "clump_max", "clump_fill", "edge_fill", "edge_round", "underlay"]},
        {"title": "Leaves", "whenNot": {"detail": ["CLUMPS"]}, "fields": ["sheets", "leaf_min", "leaf_max", "leaf_fill", "edge_fill", "density", "edge_round", "underlay"]},
        {"title": "Vines", "fields": [
            "vine_length",
            {"field": "leaf_size", "whenNot": {"detail": ["CLUMPS"]}},
            {"field": "leaf_tip", "whenNot": {"detail": ["CLUMPS"]}}]},
        {"title": "Colour", "closed": True, "fields": ["tone_a", "tone_b", "tone_c", "light", "shade", "tone_scale", "variation", "depth_shade"]},
        {"title": "Shadow", "closed": True, "fields": ["shadow_strength", "shadow_reach", "shadow_drop", "shadow_color"]},
    ]},
    "fern": {"group": "foliage", "sections": [
        {"title": "Fern", "fields": ["variety", "fronds", "fern_length", "droop", "spread"]},
        {"title": "Shape", "fields": ["lean", "fold", "twist", "croziers", "length_var"]},
        {"title": "Leaves", "whenNot": {"variety": ["PAINTED"]}, "fields": [
            "pinnae",
            {"field": "leaflets", "when": {"variety": ["LEAFLET"]}},
            "fern_leaf_size", "leaf_curve", "leaf_variation",
            {"field": "leaf_form", "when": {"variety": ["LEAFLET"]}},
            "mirror_pairs"]},
        {"title": "Colour", "closed": True, "fields": ["paint_tint"]},
    ]},
    "vine": {"group": "foliage", "sections": [
        {"title": "Hanging vine", "fields": ["vine_length", "vine_leaf_size", "leaf_spacing"]},
        {"title": "Shape", "fields": ["vine_radius", "cling", "bend", "leaf_angle", "variation", "natural"]},
        {"title": "Colour", "closed": True, "fields": ["paint_tint"]},
    ]},
    "mushroom": {"group": "foliage", "sections": [
        {"title": "Mushrooms", "fields": [
            "mushroom_form", "cluster_count", "cluster_radius", "bio_size", "bio_variation", "shape_variation", "surface_detail",
            {"field": "bio_height", "when": {"mushroom_form": ["CAP"]}},
            "cap_dome"]},
        {"title": "Colour and glow", "fields": ["body_color", "glow_color", "glow_strength"]},
    ]},
    "orbs": {"group": "foliage", "sections": [
        {"title": "Pendant orbs", "fields": ["cluster_count", "cluster_radius", "bio_size", "bio_variation", "shape_variation", "surface_detail", "orb_stalk"]},
        {"title": "Colour and glow", "fields": ["body_color", "glow_color", "glow_strength"]},
    ]},
    "glow": {"group": "foliage", "sections": [
        {"title": "Glow flora", "fields": ["glow_kind", "glow_palette", "glow_detail", "glow_collisions"]},
        *[
            {"title": label, "when": {"glow_kind": [key]}, "fields": [glow_prop(key.lower(), f[0]) for f in PATCH_FIELDS[key.lower()]]}
            for key, label, _description in GLOW_KINDS
            if key.lower() in PATCH_FIELDS
        ],
    ]},
}


def group_struct(name):
    return bpy.types.Object.bl_rna.properties[name].fixed_type


def tidy(v):
    return float(f"{float(v):.6g}")


def bound(v):
    return None if abs(v) > 1e30 else (v if isinstance(v, int) else tidy(v))


def field_meta(prop):
    """One property as the editor needs it."""
    m = {"label": prop.name, "description": prop.description}
    if prop.type == "ENUM":
        m["type"] = "enum"
        m["default"] = prop.default
        m["items"] = [{"id": i.identifier, "label": i.name, "description": i.description} for i in prop.enum_items]
        return m
    if prop.type == "BOOLEAN":
        m["type"] = "bool"
        m["default"] = bool(prop.default)
        return m
    if prop.type == "STRING":
        m["type"] = "string"
        m["default"] = prop.default
        return m
    if prop.type in {"FLOAT", "INT"}:
        if getattr(prop, "is_array", False) and prop.array_length > 0:
            if prop.subtype in {"COLOR", "COLOR_GAMMA"} and prop.array_length in {3, 4}:
                m["type"] = "color"
                m["gamma"] = prop.subtype == "COLOR_GAMMA"
                m["default"] = [tidy(v) for v in prop.default_array]
                return m
            raise SystemExit(f"{prop.identifier}: an array that is not a colour is not offered")
        m["type"] = "int" if prop.type == "INT" else "float"
        m["default"] = prop.default if prop.type == "INT" else tidy(prop.default)
        # Blender's float bounds are float32: written to six figures, and a
        # side Blender leaves open (its float32 maximum) as null.
        m["min"], m["max"] = bound(prop.hard_min), bound(prop.hard_max)
        m["softMin"], m["softMax"] = bound(prop.soft_min), bound(prop.soft_max)
        if prop.type == "FLOAT":
            m["precision"] = prop.precision
            # Blender's step is in hundredths.
            m["step"] = prop.step / 100
            m["subtype"] = prop.subtype
            m["unit"] = prop.unit
        else:
            m["step"] = max(1, prop.step)
        return m
    raise SystemExit(f"{prop.identifier}: a {prop.type} is not offered")


def names_in(sections):
    for s in sections:
        for f in s["fields"]:
            yield f["field"] if isinstance(f, dict) else f
        for cond in ("when", "whenNot"):
            yield from s.get(cond, {})
        for f in s["fields"]:
            if isinstance(f, dict):
                for cond in ("when", "whenNot"):
                    yield from f.get(cond, {})


def main():
    out = Path(sys.argv[sys.argv.index("--") + 1])
    kinds, fields = {}, {}
    for kind, layout in LAYOUTS.items():
        group = layout["group"]
        struct = group_struct(group)
        meta = fields.setdefault(group, {})
        for name in names_in(layout["sections"]):
            prop = struct.properties.get(name)
            if prop is None:
                raise SystemExit(f"{kind}: the {group} settings have no {name!r} (the add-on changed: update the layout here)")
            if name not in meta:
                meta[name] = field_meta(prop)
        sections = [
            {**s, "fields": [f if isinstance(f, dict) else {"field": f} for f in s["fields"]]}
            for s in layout["sections"]
        ]
        kinds[kind] = {"group": group, "sections": sections}
    out.write_text(json.dumps({"kinds": kinds, "fields": fields}, indent=1) + "\n")
    print(f"DECORATION_SCHEMA_OK {sum(len(m) for m in fields.values())} fields, {len(kinds)} kinds -> {out}")


main()
