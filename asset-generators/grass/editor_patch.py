"""Grow a grass patch on a surface picked in the level editor.

    blender -b --factory-startup --python editor_patch.py -- --spec patch.json --out DIR

`patch.json` holds the faces the editor selected, as a flat triangle soup in the
game's three.js frame relative to the patch origin (x right, y up, z toward the
camera, metres), plus the growth settings:

    {"positions": [x, y, z, ...], "seed": 0, "density": 700, "height": 0.3,
     "clumping": 0.7, "tuft": 0.35, "detail": 0.4}

Writes DIR/grass.glb in the same frame (the glTF exporter's +Y up undoes the
axis swap in `add_area_from_soup`), so the editor can place it at the patch
origin unchanged.
"""
import argparse
import json
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import grass_patch_tools as gpt  # noqa: E402

SETTINGS = {  # spec key -> (modifier input, cast)
    "seed": ("Seed", int),
    "density": ("Density", float),
    "height": ("Height", float),
    "clumping": ("Clumping", float),
    "tuft": ("Tuft Size", float),
    "detail": ("Detail", float),
}


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    with open(args.spec, encoding="utf-8") as f:
        spec = json.load(f)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    area = gpt.add_area_from_soup(spec["positions"])
    if not area.data.polygons:
        raise SystemExit("GRASS: the selected surface has no faces")
    mod = gpt.make_patch(area)
    for key, (name, cast) in SETTINGS.items():
        if key in spec:
            gpt.set_input(mod, name, cast(spec[key]))
    area.update_tag()

    ctx = bpy.context
    baked = gpt.bake_patch(area, ctx)
    tris = sum(len(p.vertices) - 2 for p in baked.data.polygons)
    if tris == 0:
        raise SystemExit("GRASS: no grass grew on this surface; raise the density or select more area")
    baked.name = "grass"
    out = os.path.join(args.out, "grass.glb")
    gpt.export_glb(baked, out, ctx)
    print(f"GRASS: {tris} triangles -> {out}")


if __name__ == "__main__":
    main()
