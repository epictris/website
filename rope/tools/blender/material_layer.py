"""A library MATERIAL baked into a rock's paint UV (docs/formations.md,
"Material layers").

    blender -b ROCK.blend --factory-startup --python-exit-code 1 \
        --python tools/blender/material_layer.py -- LIBRARY.blend MATERIAL OUT_DIR [SIDE]

Run by `scripts/material-layer-build.ts` on a formation's `rock.blend` from
the store. The material comes from the library (`assets-src/materials/`,
written once by material_starter.py and authored in Blender since): any
material whose surface is a Principled BSDF. It is put on the rock and baked
by Cycles into the rock's paint UV (`scene_export.PAINT_UV`, made at
Generate), so its procedural textures are evaluated on the rock's own surface
in Blender, ambient occlusion, pointiness and all, and the game only reads
maps. Writes

    OUT_DIR/color.png    Base Color, sRGB
    OUT_DIR/surface.png  R roughness, G metallic, B height (the AOV Output
                         named `height`, 0.5 without one), linear
    OUT_DIR/normal.png   the shading normal (the Normal input: bump, normal
                         map) in tangent space of the paint UV, OpenGL (+Y)
    OUT_DIR/layer.json   {"size", "texels", "seconds", "height"}

Each channel but the normal is baked as an Emission of the socket feeding it
(EMIT, lighting-free and exact); the normal is Cycles' NORMAL bake. Every map
is filled past the islands (`scene_export.fill_background`), as the rock's
own maps are, so no mip reads background.

A rock generated before the paint UV existed stops it with a line starting
`REGENERATE:`.
"""

import json
import sys
import time
from pathlib import Path

import bpy
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# The AOV Output whose Value is the material's height.
HEIGHT_AOV = "height"
# A material without one is flat.
FLAT_HEIGHT = 0.5


def principled_of(mat):
    """The Principled BSDF the material's active output's Surface reads."""
    nt = mat.node_tree
    outs = [n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output] or \
        [n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"]
    if not outs or not outs[0].inputs["Surface"].is_linked:
        raise SystemExit(f"{mat.name}: no Material Output with a Surface")
    out = outs[0]
    bsdf = out.inputs["Surface"].links[0].from_node
    if bsdf.type != "BSDF_PRINCIPLED":
        raise SystemExit(f"{mat.name}: its Surface must be a Principled BSDF (it is a {bsdf.bl_label})")
    return out, bsdf


def height_socket(mat):
    """The socket feeding the AOV Output named `height`, or None."""
    for n in mat.node_tree.nodes:
        if n.type == "OUTPUT_AOV" and n.aov_name == HEIGHT_AOV:
            value = n.inputs["Value"]
            return value.links[0].from_socket if value.is_linked else value.default_value
    return None


def bake_image(name, side, colorspace):
    im = bpy.data.images.new(name, side, side, alpha=True)
    im.generated_color = (0, 0, 0, 0)
    im.colorspace_settings.name = colorspace
    return im


def bake_into(host, mat, image, bake_type, **args):
    """One Cycles bake of the rock into `image` through the paint UV, then
    filled past the islands."""
    import scene_export
    nt = mat.node_tree
    node = nt.nodes.new("ShaderNodeTexImage")
    node.image = image
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = scene_export.PAINT_UV
    nt.links.new(uv.outputs["UV"], node.inputs["Vector"])
    nt.nodes.active = node
    scene_export.select_only([host], host)
    bpy.ops.object.bake(type=bake_type, target="IMAGE_TEXTURES", uv_layer=scene_export.PAINT_UV, margin=0,
                        use_clear=False, **args)
    texels = scene_export.fill_background(image)
    nt.nodes.remove(node)
    nt.nodes.remove(uv)
    if not texels:
        raise SystemExit(f"the {bake_type} bake wrote no texel into {image.name}")
    return texels


def bake_emission(host, mat, out, source, image):
    """`source` (a socket or a constant) baked as an Emission of it: what the
    socket gives on the surface, no lighting."""
    nt = mat.node_tree
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = 1.0
    if isinstance(source, bpy.types.NodeSocket):
        nt.links.new(source, emit.inputs["Color"])
    else:
        v = tuple(source) if hasattr(source, "__len__") else (float(source),) * 3
        emit.inputs["Color"].default_value = (*v[:3], 1.0)
    surface = out.inputs["Surface"].links[0].from_socket
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    try:
        return bake_into(host, mat, image, "EMIT")
    finally:
        nt.links.new(surface, out.inputs["Surface"])
        nt.nodes.remove(emit)


def source_of(sock):
    """What feeds a node input: the linked socket, or its own value."""
    return sock.links[0].from_socket if sock.is_linked else sock.default_value


def pixels(im):
    w, h = im.size
    px = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(px)
    return px.reshape(h, w, 4)


def save(im, px, path):
    im.pixels.foreach_set(px.ravel())
    im.filepath_raw = str(path)
    im.file_format = "PNG"
    im.save()


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    library, name, out_dir = Path(argv[0]), argv[1], Path(argv[2])
    t0 = time.time()
    import scene_export
    from formations import curve, render
    host = bpy.data.objects.get("SceneryRock")
    if host is None:
        raise SystemExit("the rock .blend holds no SceneryRock")
    me = host.data
    if scene_export.PAINT_UV not in me.uv_layers:
        raise SystemExit("REGENERATE: this rock was generated before texture layers; Generate it again to paint one on it")
    # The rock as it is drawn (decoration_prepare.py does the same).
    if render.slate_rock(host) and render.setting(host, "export_creases"):
        curve.bend(me, scene_export.straight_creases(host, me))
    # Through the paint UV: the normal bake's tangents are the render UV's.
    for layer in me.uv_layers:
        layer.active_render = layer.name == scene_export.PAINT_UV
    me.uv_layers.active = me.uv_layers[scene_export.PAINT_UV]

    # The material named as the file is, in any case (`dirt.blend` holds `Dirt`).
    with bpy.data.libraries.load(str(library), link=False) as (src, dst):
        found = [m for m in src.materials if m.lower() == name.lower()]
        if not found:
            raise SystemExit(f"{library.name} has no material {name!r} (it has {', '.join(src.materials) or 'none'})")
        dst.materials = found[:1]
    mat = dst.materials[0]
    out, bsdf = principled_of(mat)
    me.materials.clear()
    me.materials.append(mat)
    me.polygons.foreach_set("material_index", np.zeros(len(me.polygons), np.int32))

    if len(argv) > 3:
        side = int(argv[3])
    else:
        area = np.empty(len(me.polygons))
        me.polygons.foreach_get("area", area)
        side = render.colour_maps(host, float(area.sum()))[0]

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    device = scene_export.bake_device()
    scene.cycles.device = "CPU" if device == "CPU" else "GPU"
    scene.cycles.samples = scene_export.BAKE_SAMPLES
    scene.render.bake.margin = 0

    colour = bake_image("color", side, "sRGB")
    texels = bake_emission(host, mat, out, source_of(bsdf.inputs["Base Color"]), colour)
    grey = bake_image("grey", side, "Non-Color")
    channels = []
    height = height_socket(mat)
    for source in (source_of(bsdf.inputs["Roughness"]), source_of(bsdf.inputs["Metallic"]),
                   FLAT_HEIGHT if height is None else height):
        grey.pixels.foreach_set(np.zeros(side * side * 4, np.float32))
        bake_emission(host, mat, out, source, grey)
        channels.append(pixels(grey)[..., 0].copy())
    normal = bake_image("normal", side, "Non-Color")
    bake_into(host, mat, normal, "NORMAL", normal_space="TANGENT")

    out_dir.mkdir(parents=True, exist_ok=True)
    px = pixels(colour)
    px[..., 3] = 1.0
    save(colour, px, out_dir / "color.png")
    surface = bake_image("surface", side, "Non-Color")
    save(surface, np.dstack([*channels, np.ones_like(channels[0])]), out_dir / "surface.png")
    px = pixels(normal)
    px[..., 3] = 1.0
    save(normal, px, out_dir / "normal.png")
    seconds = round(time.time() - t0, 2)
    (out_dir / "layer.json").write_text(json.dumps(
        {"size": side, "texels": texels, "seconds": seconds, "height": height is not None, "device": device}))
    print(f"[material-layer] {name}: {side}x{side}, {texels:,} texels, {device}, {seconds}s", flush=True)
    print("MATERIAL_LAYER_OK", flush=True)


main()
