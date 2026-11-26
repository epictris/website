"""The STARTER material of the material library (docs/formations.md,
"Material layers"): writes `assets-src/materials/dirt.blend`, a Principled
BSDF node tree to open in Blender and author further by hand.

    blender -b --factory-startup --python-exit-code 1 \
        --python tools/blender/material_starter.py -- OUT.blend

Only a starting point: once the file exists it is the source, edited in
Blender, and this script is not run over it again (it refuses to overwrite).

A library material is any material whose surface is a Principled BSDF. The
bake (material_layer.py) reads Base Color, Roughness, Metallic and the
shading normal from it, and its HEIGHT from an AOV Output named `height`
(0 low, 1 high), which the game blends layers by. Texture coordinates should
be Object (metres on the rock), so a pattern runs on across the paint UV's
seams.

The look is Tris's dirt reference (plans/dirt-paint.md "The look"): flat,
hand-painted dark brown clods, darker cracks between them, a few pale
pebbles gathered along the cracks.
"""

import sys
from pathlib import Path

import bpy

NAME = "Dirt"


def linear(hex_srgb):
    """An sRGB hex colour as the linear RGBA a node socket takes."""
    def ch(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    h = hex_srgb.lstrip("#")
    return (ch(int(h[0:2], 16)), ch(int(h[2:4], 16)), ch(int(h[4:6], 16)), 1.0)


def build(mat):
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    x = [0]

    def node(kind, col, row, **props):
        n = nt.nodes.new(kind)
        n.location = (col * 220, -row * 180)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def link(a, b):
        nt.links.new(a, b)

    def math(op, col, row, a=None, b=None, label=None):
        n = node("ShaderNodeMath", col, row, operation=op)
        if label:
            n.label = label
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                link(v, n.inputs[i])
        return n.outputs[0]

    coord = node("ShaderNodeTexCoord", 0, 0)
    # A soft warp so the clods are not straight-edged Voronoi cells.
    warp = node("ShaderNodeTexNoise", 1, 2, label="Warp")
    warp.inputs["Scale"].default_value = 6.0
    warp.inputs["Detail"].default_value = 2.0
    link(coord.outputs["Object"], warp.inputs["Vector"])
    warp_amount = node("ShaderNodeVectorMath", 2, 2, operation="SCALE")
    warp_amount.inputs["Scale"].default_value = 0.025
    link(warp.outputs["Color"], warp_amount.inputs[0])
    warped = node("ShaderNodeVectorMath", 3, 1, operation="ADD")
    link(coord.outputs["Object"], warped.inputs[0])
    link(warp_amount.outputs[0], warped.inputs[1])

    # Clods: cells about 10 cm across, each its own tone.
    clods = node("ShaderNodeTexVoronoi", 4, 0, label="Clods", voronoi_dimensions="3D", feature="F1")
    clods.inputs["Scale"].default_value = 10.0
    link(warped.outputs[0], clods.inputs["Vector"])
    edges = node("ShaderNodeTexVoronoi", 4, 2, label="Cracks", voronoi_dimensions="3D", feature="DISTANCE_TO_EDGE")
    edges.inputs["Scale"].default_value = 10.0
    link(warped.outputs[0], edges.inputs["Vector"])

    tone_of = node("ShaderNodeSeparateColor", 5, 0)
    link(clods.outputs["Color"], tone_of.inputs["Color"])
    tones = node("ShaderNodeMix", 6, 0, data_type="RGBA", label="Clod tone")
    tones.inputs["A"].default_value = linear("#45291a")
    tones.inputs["B"].default_value = linear("#56391f")
    link(tone_of.outputs["Red"], tones.inputs["Factor"])

    # A crack: darkest on the cell edge, gone a third of a clod's radius in.
    crack = node("ShaderNodeMapRange", 5, 2, label="Crack width")
    crack.inputs["From Min"].default_value = 0.0
    crack.inputs["From Max"].default_value = 0.09
    crack.inputs["To Min"].default_value = 1.0
    crack.inputs["To Max"].default_value = 0.0
    link(edges.outputs["Distance"], crack.inputs["Value"])
    crack_col = node("ShaderNodeMix", 7, 1, data_type="RGBA", label="Crack colour")
    crack_col.inputs["B"].default_value = linear("#2e1a0a")
    link(tones.outputs["Result"], crack_col.inputs["A"])
    link(crack.outputs["Result"], crack_col.inputs["Factor"])

    # Pebbles: a finer grid of cells, a few of which hold a stone, nearer
    # the cracks than not. `Density` is the share of cells with one.
    pebbles = node("ShaderNodeTexVoronoi", 4, 4, label="Pebbles", voronoi_dimensions="3D", feature="F1")
    pebbles.inputs["Scale"].default_value = 45.0
    link(coord.outputs["Object"], pebbles.inputs["Vector"])
    pick = node("ShaderNodeSeparateColor", 5, 4)
    link(pebbles.outputs["Color"], pick.inputs["Color"])
    density = node("ShaderNodeValue", 5, 5, label="Pebble density")
    density.outputs[0].default_value = 0.06
    near_crack = math("MULTIPLY", 6, 5, crack.outputs["Result"], density.outputs[0])
    chance = math("ADD", 7, 5, near_crack, density.outputs[0])
    has = math("LESS_THAN", 8, 4, pick.outputs["Red"], chance, label="Has a pebble")
    radius = node("ShaderNodeMapRange", 6, 3, label="Pebble size")
    radius.inputs["From Min"].default_value = 0.22
    radius.inputs["From Max"].default_value = 0.32
    radius.inputs["To Min"].default_value = 1.0
    radius.inputs["To Max"].default_value = 0.0
    link(pebbles.outputs["Distance"], radius.inputs["Value"])
    pebble = math("MULTIPLY", 9, 4, radius.outputs["Result"], has, label="Pebble")
    pebble_rim = math("PINGPONG", 9, 5, pebble, 0.5)
    pebble_col = node("ShaderNodeMix", 10, 3, data_type="RGBA", label="Pebble colour")
    pebble_col.inputs["A"].default_value = linear("#3a2614")
    pebble_col.inputs["B"].default_value = linear("#7a6150")
    link(pebble_rim, pebble_col.inputs["Factor"])
    rim = math("GREATER_THAN", 10, 5, pebble, 0.02)
    colour = node("ShaderNodeMix", 11, 1, data_type="RGBA", label="Colour")
    link(crack_col.outputs["Result"], colour.inputs["A"])
    link(pebble_col.outputs["Result"], colour.inputs["B"])
    link(rim, colour.inputs["Factor"])

    # Height: each clod a low dome, sunk at its cracks; a pebble stands on it.
    dome = node("ShaderNodeMapRange", 6, 7, label="Clod dome")
    dome.inputs["From Min"].default_value = 0.0
    dome.inputs["From Max"].default_value = 0.25
    dome.inputs["To Min"].default_value = 0.0
    dome.inputs["To Max"].default_value = 0.7
    link(edges.outputs["Distance"], dome.inputs["Value"])
    stone = math("MULTIPLY", 9, 7, math("SQRT", 8, 7, pebble), 0.3)
    height = math("ADD", 10, 7, dome.outputs["Result"], stone, label="Height")
    height = math("MINIMUM", 11, 7, height, 1.0)
    aov = node("ShaderNodeOutputAOV", 12, 8, aov_name="height")
    link(height, aov.inputs["Value"])

    bump = node("ShaderNodeBump", 12, 6)
    bump.inputs["Strength"].default_value = 0.6
    bump.inputs["Distance"].default_value = 0.01
    link(height, bump.inputs["Height"])

    bsdf = node("ShaderNodeBsdfPrincipled", 13, 1)
    link(colour.outputs["Result"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.95
    bsdf.inputs["Metallic"].default_value = 0.0
    link(bump.outputs["Normal"], bsdf.inputs["Normal"])
    out = node("ShaderNodeOutputMaterial", 14, 1)
    link(bsdf.outputs["BSDF"], out.inputs["Surface"])


def main():
    out = Path(sys.argv[sys.argv.index("--") + 1:][0]).resolve()
    if out.exists():
        raise SystemExit(f"{out} exists: it is the source now; edit it in Blender")
    for m in list(bpy.data.materials):
        bpy.data.materials.remove(m)
    mat = bpy.data.materials.new(NAME)
    build(mat)
    mat.use_fake_user = True
    # A sphere to look at it on, metres across as the rocks are.
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, segments=64, ring_count=32)
    bpy.context.object.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    out.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(out))
    print(f"MATERIAL_STARTER_OK {out}", flush=True)


main()
