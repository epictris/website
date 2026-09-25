"""Grow a glowing mushroom patch on a surface picked in the level editor.

    blender -b --factory-startup --python editor_patch.py -- --spec patch.json --out DIR

`patch.json` holds the faces the editor selected, as a flat triangle soup in the
game's three.js frame relative to the patch origin (x right, y up, z toward the
camera, metres), plus the growth settings:

    {"positions": [x, y, z, ...], "seed": 0, "density": 150, "height": 0.16,
     "clumping": 0.75, "spacing": 0.02, "detail": 0.5}

Writes DIR/mushrooms.glb in the same frame (the glTF exporter's +Y up undoes the
axis swap below), so the editor can place it at the patch origin unchanged.
"""
import argparse
import json
import os
import sys

import bmesh
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mushroom_patch_tools as mpt  # noqa: E402

SETTINGS = {  # spec key -> (modifier input, cast)
    "seed": ("Seed", int),
    "density": ("Density", float),
    "height": ("Height", float),
    "clumping": ("Clumping", float),
    "spacing": ("Spacing", float),
    "detail": ("Detail", float),
}


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

    bpy.ops.wm.read_factory_settings(use_empty=True)
    area = area_from_soup(spec["positions"])
    if not area.data.polygons:
        raise SystemExit("MUSHROOMS: the selected surface has no faces")
    mod = mpt.make_patch(area)
    for key, (name, cast) in SETTINGS.items():
        if key in spec:
            mpt.set_input(mod, name, cast(spec[key]))
    area.update_tag()

    ctx = bpy.context
    baked = mpt.bake_patch(area, ctx)
    tris = sum(len(p.vertices) - 2 for p in baked.data.polygons)
    if tris == 0:
        raise SystemExit("MUSHROOMS: no mushrooms fit this surface; raise the density or select more area")
    baked.name = "mushrooms"
    os.makedirs(args.out, exist_ok=True)
    mpt.export_asset(baked, args.out, "GLB", ctx)
    print(f"MUSHROOMS: {tris} triangles -> {os.path.join(args.out, 'mushrooms.glb')}")


if __name__ == "__main__":
    main()
