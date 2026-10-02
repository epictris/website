"""The painted slate: every formation's stone (docs/cave-look.md, "Surface").

Flat tones, as the cave sheets paint stone: inside a facet there is no
texture at all. What varies is BETWEEN facets, by orientation - up-facing
planes light, fronts the mid slate, undersides dark - with a slightly
different tone per facet on top of that, the seams darkened and a pale line
on the facet edges.

Until 2026-10-02 the shader also carried three low-frequency noises (a
warm/cool drift, a fine grain and stretched vertical stains) and a 0.5 m
Ambient Occlusion. Baked at the export's 136 to 200 texels per metre and
bilinearly filtered, those read as cloudy blotches across every face (Tris:
"I don't like this blotchy texture"), while the per-facet step was too small
(0.92 to 1.08) for neighbouring planes to separate. The reference rocks have
no such pattern, so the noises went; the orientation ramp and a wider facet
step carry the look instead, and flat tones survive any texel density.

The per-facet tone reads a FACE float attribute `facet` in [0, 1];
`tone_facets` writes it from each face's ORIENTATION, so faces that point
almost the same way get almost the same tone. The Ambient Occlusion and Bevel
nodes are Cycles only: the scene export bakes the whole Base Color to an image
texture in Cycles, so the game gets them; EEVEE's viewport shows the stone
without its seams and edges.
"""

import random

import bpy
from mathutils import Vector, noise

NAME = "Painted slate"
# The orientation ramp's three stops: what faces down, what faces the camera
# (the 2026-10-01 v6 slate), what faces up. The game's sun lights the tops
# again on top of this, so TOP is only twice SIDE in linear light.
BOTTOM, SIDE, TOP = "#1e2230", "#2f3546", "#474c5a"
LINE = "#5c6070"
SPECULAR = 0.1
# The per-facet step: multiplies the ramp, so neighbouring facets at nearly
# the same orientation still read as two planes.
FACET_TONE = (0.85, 1.15)
# The seam darkening: how far from a concave join it reaches, and how dark.
# Only the join itself; a longer reach drew the plumes the noises were blamed for.
AO_DISTANCE = 0.12
AO_TONE = (0.6, 1.0)
# How fast the per-facet tone changes with a face's orientation: the tone is
# a smooth noise of the face normal times this. The fused rock's faces are a
# planar dissolve (fitted.py) of a remeshed surface, so one visible facet is
# many faces a few degrees apart; a random tone per face drew every one of
# them (Tris, 2026-10-02: "no significantly different colours on adjacent
# faces with almost the same orientation", flat shading and crisp edges kept).
TONE_SCALE = 1.5


def srgb(h):
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))

    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return (lin(r), lin(g), lin(b), 1.0)


def tone_facets(ob, seed):
    """Write each face's tone into the `facet` attribute as a smooth function
    of its orientation, and shade the rock flat (undoing the smooth shading a
    2026-10-02 build gave it, which Tris found too smooth).

    The tone is Perlin noise of the object-space face normal scaled by
    TONE_SCALE, offset by the seed so rocks differ, then rank-mapped onto
    [0, 1] so the tones span the shader's whole range whatever the noise's
    spread on this rock; ranking keeps the order, so near orientations stay
    near tones. No vertex moves, so the growth and rebuild state are untouched
    (core.mesh_hash). Returns the faces toned."""
    me = ob.data
    me.shade_flat()
    if me.attributes.get("sharp_edge") is not None:
        me.attributes.remove(me.attributes["sharp_edge"])
    rng = random.Random(seed)
    offset = Vector((rng.uniform(-100, 100), rng.uniform(-100, 100), rng.uniform(-100, 100)))
    raw = [noise.noise(p.normal * TONE_SCALE + offset) for p in me.polygons]
    order = sorted(range(len(raw)), key=raw.__getitem__)
    tone = [0.0] * len(raw)
    for rank, i in enumerate(order):
        tone[i] = rank / max(len(raw) - 1, 1)
    attr = me.attributes.get("facet") or me.attributes.new("facet", "FLOAT", "FACE")
    attr.data.foreach_set("value", tone)
    return len(tone)


def painted_slate(name=NAME):
    mat = bpy.data.materials.new(name)
    paint(mat)
    return mat


def repaint():
    """Rebuild every painted slate in the open file (`Painted slate` and the
    `.001`-style copies an append makes) to this module's graph, in place, so
    every slot keeps its material and the rocks need no rebuild. Returns the
    materials repainted."""
    mats = [m for m in bpy.data.materials if m.name == NAME or m.name.startswith(NAME + ".")]
    for m in mats:
        paint(m)
    return len(mats)


def paint(mat):
    """Replace `mat`'s node tree with the painted slate."""
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    N = nt.nodes.new
    L = nt.links.new
    # Solid view: the front tone.
    mat.diffuse_color = srgb(SIDE)
    mat.roughness = 1.0

    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Specular IOR Level"].default_value = SPECULAR
    L(bsdf.outputs[0], out.inputs[0])

    # The orientation ramp: the face's true (flat) normal's world Z, -1 down
    # to 1 up, onto the three stops. A flat face has one normal, so one tone.
    geo = N("ShaderNodeNewGeometry")
    nz = N("ShaderNodeSeparateXYZ")
    L(geo.outputs["True Normal"], nz.inputs[0])
    up = N("ShaderNodeMapRange")
    up.inputs["From Min"].default_value = -1.0
    up.inputs["From Max"].default_value = 1.0
    L(nz.outputs["Z"], up.inputs["Value"])
    ramp = N("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = srgb(BOTTOM)
    ramp.color_ramp.elements[1].color = srgb(TOP)
    mid = ramp.color_ramp.elements.new(0.5)
    mid.color = srgb(SIDE)
    L(up.outputs[0], ramp.inputs["Fac"])

    def scalar_mul(a, b):
        m = N("ShaderNodeMath")
        m.operation = "MULTIPLY"
        L(a, m.inputs[0])
        L(b, m.inputs[1])
        return m.outputs[0]

    facet = N("ShaderNodeAttribute")
    facet.attribute_name = "facet"
    ftone = N("ShaderNodeMapRange")
    ftone.inputs["To Min"].default_value = FACET_TONE[0]
    ftone.inputs["To Max"].default_value = FACET_TONE[1]
    L(facet.outputs["Fac"], ftone.inputs["Value"])

    ao = N("ShaderNodeAmbientOcclusion")
    ao.inputs["Distance"].default_value = AO_DISTANCE
    ao.samples = 8
    atone = N("ShaderNodeMapRange")
    atone.inputs["From Max"].default_value = 0.8
    atone.inputs["To Min"].default_value = AO_TONE[0]
    atone.inputs["To Max"].default_value = AO_TONE[1]
    L(ao.outputs["AO"], atone.inputs["Value"])

    tone = scalar_mul(ftone.outputs[0], atone.outputs[0])
    tone_rgb = N("ShaderNodeCombineColor")
    for i in range(3):
        L(tone, tone_rgb.inputs[i])
    toned = N("ShaderNodeMix")
    toned.data_type = "RGBA"
    toned.blend_type = "MULTIPLY"
    toned.inputs[0].default_value = 1.0
    L(ramp.outputs["Color"], toned.inputs[6])
    L(tone_rgb.outputs[0], toned.inputs[7])

    bev = N("ShaderNodeBevel")
    bev.samples = 8
    bev.inputs["Radius"].default_value = 0.03
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
