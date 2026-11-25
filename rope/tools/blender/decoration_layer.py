"""A painted TEXTURE LAYER as a map in its rock's paint UV (docs/formations.md,
"Texture layers").

    blender -b PREPARED.blend --factory-startup --python-exit-code 1 \
        --python tools/blender/decoration_layer.py -- OUT_DIR

Run by `scripts/decoration-build.ts` on what `decoration_prepare.py` made, in
place of the scene export a grown decoration goes through: a texture layer
grows no mesh. Today that is a texture-only moss; the moss add-on grows its
dabs exactly as the export grows them for a rock's colour map
(`moss.texture_paints`), and `moss.build.layer_map` paints them into a map of
their own, laid out by the rock's paint UV (`scene_export.PAINT_UV`, made at
Generate by formation_export.py), which the game lays over the rock's colour,
unbaked or baked. Writes

    OUT_DIR/layer.png    the dabs' colour (sRGB) and their coverage (alpha),
                         straight alpha, one map at the rock's colour map side
    OUT_DIR/layer.json   {"size", "texels", "seconds"}

A rock generated before the paint UV existed stops it with a line starting
`REGENERATE:`: there is nothing to lay a layer out by until it is generated
again.
"""

import json
import sys
import time
from pathlib import Path

import bpy
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main():
    out = Path(sys.argv[sys.argv.index("--") + 1:][0])
    t0 = time.time()
    import scene_export
    from formations import render
    host = bpy.data.objects.get("formation")
    if host is None:
        raise SystemExit("the prepared .blend holds no `formation` rock")
    me = host.data
    if scene_export.PAINT_UV not in me.uv_layers:
        raise SystemExit("REGENERATE: this rock was generated before texture layers; Generate it again to paint one on it")
    import moss
    moss.register()
    scene = bpy.context.scene
    moss.prepare_texture_paints(scene, {host.name})
    entries = [e for e in moss.texture_paints(scene) if e[1] == host]
    if not entries:
        raise SystemExit("no texture-only moss on the rock")
    _moss, _host, layers, p, _key = entries[0]

    area = np.empty(len(me.polygons))
    me.polygons.foreach_get("area", area)
    side = render.colour_maps(host, float(area.sum()))[0]
    me.calc_loop_triangles()
    n = len(me.loop_triangles)
    loops = np.empty(n * 3, np.int32)
    me.loop_triangles.foreach_get("loops", loops)
    verts = np.empty(n * 3, np.int32)
    me.loop_triangles.foreach_get("vertices", verts)
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers[scene_export.PAINT_UV].data.foreach_get("uv", uv)
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    m = np.array(host.matrix_world, dtype=np.float64)
    world = co.reshape(-1, 3).astype(np.float64) @ m[:3, :3].T + m[:3, 3]
    uv_px = uv.reshape(-1, 2)[loops].reshape(n, 3, 2).astype(np.float64) * (side, side)
    tri_pos = world[verts].reshape(n, 3, 3)

    from moss import build
    px, texels = build.layer_map(uv_px, tri_pos, layers(), p, side, side)
    if not texels:
        raise SystemExit("the paint covers none of the rock")
    image = bpy.data.images.new("layer", side, side, alpha=True)
    image.alpha_mode = "STRAIGHT"
    image.pixels.foreach_set(px.ravel())
    image.filepath_raw = str(out / "layer.png")
    image.file_format = "PNG"
    image.save()
    seconds = round(time.time() - t0, 2)
    (out / "layer.json").write_text(json.dumps({"size": side, "texels": texels, "seconds": seconds}))
    print(f"[decoration-layer] {side}x{side}, {texels:,} texels covered, {seconds}s", flush=True)
    print("DECORATION_LAYER_OK", flush=True)


main()
