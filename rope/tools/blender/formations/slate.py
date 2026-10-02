"""The painted slate: every formation's stone (docs/cave-look.md, "Surface").

Ported from `mat_plain` in cave-sheet-study/rock_study.py as Tris chose it on
2026-10-01 (`--albedo v6 --spec 0.1`): matte, a slow warm/cool drift across the
block, a slightly different tone per facet, faint grain, soft vertical stains,
crevices darkened and a pale line on the facet edges.

The per-facet tone reads a FACE float attribute `facet` (random in [0, 1));
`add_facets` writes it. The Ambient Occlusion and Bevel nodes are Cycles only:
the scene export bakes the whole Base Color to vertex colour in Cycles, so the
game gets them; EEVEE's viewport shows the stone without its crevices and edges.
"""

import random

import bpy

NAME = "Painted slate"
COOL, WARM, LINE = "#2f3546", "#3b3e4a", "#5c6070"
SPECULAR = 0.1


def srgb(h):
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))

    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return (lin(r), lin(g), lin(b), 1.0)


def add_facets(ob, seed):
    """A random value per face for the shader's per-facet tone."""
    me = ob.data
    attr = me.attributes.get("facet") or me.attributes.new("facet", "FLOAT", "FACE")
    rng = random.Random(seed)
    attr.data.foreach_set("value", [rng.random() for _ in range(len(me.polygons))])


def painted_slate(name=NAME):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    N = nt.nodes.new
    L = nt.links.new
    # Solid view: between the two albedos.
    mat.diffuse_color = tuple((a + b) / 2 for a, b in zip(srgb(COOL), srgb(WARM)))
    mat.roughness = 1.0

    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Specular IOR Level"].default_value = SPECULAR
    L(bsdf.outputs[0], out.inputs[0])

    coord = N("ShaderNodeTexCoord")
    drift = N("ShaderNodeTexNoise")
    drift.inputs["Scale"].default_value = 0.9
    drift.inputs["Detail"].default_value = 2.0
    L(coord.outputs["Object"], drift.inputs["Vector"])
    base = N("ShaderNodeMix")
    base.data_type = "RGBA"
    base.inputs[6].default_value = srgb(COOL)
    base.inputs[7].default_value = srgb(WARM)
    L(drift.outputs["Fac"], base.inputs[0])

    def scalar_mul(a, b):
        m = N("ShaderNodeMath")
        m.operation = "MULTIPLY"
        L(a, m.inputs[0])
        L(b, m.inputs[1])
        return m.outputs[0]

    facet = N("ShaderNodeAttribute")
    facet.attribute_name = "facet"
    ftone = N("ShaderNodeMapRange")
    ftone.inputs["To Min"].default_value = 0.92
    ftone.inputs["To Max"].default_value = 1.08
    L(facet.outputs["Fac"], ftone.inputs["Value"])

    grain = N("ShaderNodeTexNoise")
    grain.inputs["Scale"].default_value = 35.0
    grain.inputs["Detail"].default_value = 3.0
    L(coord.outputs["Object"], grain.inputs["Vector"])
    gtone = N("ShaderNodeMapRange")
    gtone.inputs["To Min"].default_value = 0.96
    gtone.inputs["To Max"].default_value = 1.04
    L(grain.outputs["Fac"], gtone.inputs["Value"])

    stretch = N("ShaderNodeMapping")
    stretch.inputs["Scale"].default_value = (3.0, 3.0, 0.7)
    L(coord.outputs["Object"], stretch.inputs["Vector"])
    stain = N("ShaderNodeTexNoise")
    stain.inputs["Scale"].default_value = 1.0
    stain.inputs["Detail"].default_value = 2.0
    L(stretch.outputs[0], stain.inputs["Vector"])
    stone = N("ShaderNodeMapRange")
    stone.inputs["From Min"].default_value = 0.35
    stone.inputs["From Max"].default_value = 0.65
    stone.inputs["To Min"].default_value = 0.75
    stone.inputs["To Max"].default_value = 1.0
    L(stain.outputs["Fac"], stone.inputs["Value"])

    ao = N("ShaderNodeAmbientOcclusion")
    ao.inputs["Distance"].default_value = 0.5
    ao.samples = 8
    atone = N("ShaderNodeMapRange")
    atone.inputs["To Min"].default_value = 0.55
    atone.inputs["To Max"].default_value = 1.0
    L(ao.outputs["AO"], atone.inputs["Value"])

    tone = scalar_mul(scalar_mul(scalar_mul(ftone.outputs[0], gtone.outputs[0]), atone.outputs[0]), stone.outputs[0])
    tone_rgb = N("ShaderNodeCombineColor")
    for i in range(3):
        L(tone, tone_rgb.inputs[i])
    toned = N("ShaderNodeMix")
    toned.data_type = "RGBA"
    toned.blend_type = "MULTIPLY"
    toned.inputs[0].default_value = 1.0
    L(base.outputs[2], toned.inputs[6])
    L(tone_rgb.outputs[0], toned.inputs[7])

    bev = N("ShaderNodeBevel")
    bev.samples = 8
    bev.inputs["Radius"].default_value = 0.03
    geo = N("ShaderNodeNewGeometry")
    dot = N("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    L(bev.outputs["Normal"], dot.inputs[0])
    L(geo.outputs["Normal"], dot.inputs[1])
    edge = N("ShaderNodeMapRange")
    edge.inputs["From Min"].default_value = 0.995
    edge.inputs["From Max"].default_value = 0.92
    edge.inputs["To Min"].default_value = 0.0
    edge.inputs["To Max"].default_value = 0.35
    L(dot.outputs["Value"], edge.inputs["Value"])
    edged = N("ShaderNodeMix")
    edged.data_type = "RGBA"
    edged.inputs[7].default_value = srgb(LINE)
    L(toned.outputs[2], edged.inputs[6])
    L(edge.outputs[0], edged.inputs[0])
    L(edged.outputs[2], bsdf.inputs["Base Color"])
    # The study also fed the Bevel normal to the BSDF's Normal; glTF cannot
    # carry it (the export warns), and the edge line is in the colour anyway.
    return mat
