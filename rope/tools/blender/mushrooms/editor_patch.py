"""Grow a glowing mushroom patch on a surface picked in the level editor.

    blender -b --factory-startup --python editor_patch.py -- --spec patch.json --out DIR

`patch.json` holds the faces the editor selected, as a flat triangle soup in the
game's three.js frame relative to the patch origin (x right, y up, z toward the
camera, metres), plus the parameters that differ from params.json:

    {"kind": "mushrooms", "positions": [x, y, z, ...],
     "params": {"seed": 3, "density": 200}}

A spec with no "params" block is the fork's older flat shape
({"positions": [...], "seed": 0, "density": 150, ...}) and is read as overrides.

Writes DIR/mushrooms.glb in the same frame (the glTF exporter's +Y up undoes the
axis swap below), so the editor can place it at the patch origin unchanged.
"""
import argparse
import json
import math
import os
import sys

import bmesh
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mushroom_patch_tools as mpt  # noqa: E402

SCHEMA = os.path.join(HERE, "params.json")

# Schema key -> MushroomPatch node group input and the cast it takes. maxTilt is
# authored in degrees and the socket is an ANGLE (radians).
SOCKETS = {
    "seed": ("Seed", int),
    "density": ("Density", float),
    "spacing": ("Spacing", float),
    "noOverlaps": ("No Overlaps", bool),
    "gap": ("Gap", float),
    "clumping": ("Clumping", float),
    "clumpSize": ("Clump Size", float),
    "height": ("Height", float),
    "sizeMin": ("Size Min", float),
    "sizeMax": ("Size Max", float),
    "maxTilt": ("Max Tilt", lambda deg: math.radians(float(deg))),
    "bend": ("Bend", float),
    "capSize": ("Cap Size", float),
    "detail": ("Detail", float),
}

# Keys the level editor and the dev server act on before Blender is reached: the
# slope filter picks the faces sent, the limits bound the request.
EDITOR_SIDE = {"maxSlope", "maxTriangles", "maxEstimate"}

# The fork's flat request carried these at the top level.
LEGACY_KEYS = ("seed", "density", "height", "clumping", "spacing", "detail")

# Printed once the node group has been evaluated and frozen. The dev server lets
# a job that has said it finish even when a newer request supersedes it.
BAKE_MARKER = "GENERATOR: bake started"


def patch_values(spec):
    """params.json defaults, then the spec's overrides; unknown keys are an error."""
    with open(SCHEMA, encoding="utf-8") as f:
        values = {p["key"]: p["default"] for p in json.load(f)["params"]}
    overrides = spec.get("params")
    if overrides is None:
        overrides = {k: spec[k] for k in LEGACY_KEYS if k in spec}
    unknown = sorted(set(overrides) - set(values))
    if unknown:
        raise SystemExit(f"MUSHROOMS: unknown parameters {', '.join(unknown)}")
    values.update(overrides)
    missing = sorted(set(values) - set(SOCKETS) - set(mpt.LOOK) - EDITOR_SIDE)
    if missing:
        raise SystemExit(f"MUSHROOMS: parameters with nowhere to go: {', '.join(missing)}")
    return values


def area_from_soup(positions):
    """three.js (x, y up, z out) -> Blender (x, -z, y up)."""
    me = bpy.data.meshes.new("MushroomArea")
    bm = bmesh.new()
    for i in range(0, len(positions) - 8, 9):
        tri = []
        for k in range(3):
            x, y, z = positions[i + 3 * k: i + 3 * k + 3]
            tri.append(bm.verts.new((x, -z, y)))
        try:
            bm.faces.new(tri)
        except ValueError:
            pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("MushroomArea", me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    with open(args.spec, encoding="utf-8") as f:
        spec = json.load(f)
    values = patch_values(spec)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    area = area_from_soup(spec["positions"])
    if not area.data.polygons:
        raise SystemExit("MUSHROOMS: the selected surface has no faces")
    mod = mpt.make_patch(area, look={k: values[k] for k in mpt.LOOK})
    for key, (name, cast) in SOCKETS.items():
        mpt.set_input(mod, name, cast(values[key]))
    area.update_tag()

    ctx = bpy.context
    baked = mpt.bake_patch(area, ctx, no_overlaps=values["noOverlaps"])
    print(BAKE_MARKER, flush=True)
    tris = sum(len(p.vertices) - 2 for p in baked.data.polygons)
    if tris == 0:
        raise SystemExit("MUSHROOMS: no mushrooms fit this surface; raise the density or select more area")
    baked.name = "mushrooms"
    os.makedirs(args.out, exist_ok=True)
    mpt.export_asset(baked, args.out, "GLB", ctx)
    print(f"MUSHROOMS: {tris} triangles -> {os.path.join(args.out, 'mushrooms.glb')}")


if __name__ == "__main__":
    main()
