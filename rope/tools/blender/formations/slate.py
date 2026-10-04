"""The painted slate: every formation's stone (docs/cave-look.md, "Surface").

Since 2026-10-03 this is the cave-sheet study's painted slate v6 as Tris
picked it on 2026-10-01 (`mat_plain` in cave-sheet-study/rock_study.py, run
with --albedo v6 --spec 0.1 and the Bevel normal on), node for node: a slow
noise drifts the stone between a cool and a warm dark slate, a per-facet tone
steps neighbouring planes apart, a fine grain and soft vertical stains break
up each face, a 0.5 m ambient occlusion darkens the crevices, a pale line
runs along the facet edges and the Bevel node's normal rounds them, so the
facets shade softly into each other. The light (warm key, blue fill and
rim) does the rest; under the v6 rig this is the report's recipe F render.

What it replaced, for the record: from 2026-10-02 an orientation ramp with
a wider facet step and no noises ("blotchy" at the export's texel density),
and from the 2026-10-03 rock detail study an occlusion gradient and dots and
ticks with the edge line removed (docs/rock-detail.md). Tris put the report's
process back on 2026-10-03.

The per-facet tone reads a FACE float attribute `facet` in [0, 1]. The study
wrote a random value per face; a formation's visible plane is many faces a
few degrees apart (fitted.py's planar dissolve), so `tone_facets` writes it
from each face's ORIENTATION instead and near-parallel faces get near tones.
The Ambient Occlusion and Bevel nodes are Cycles only: the scene export bakes
the Base Color and the normal in Cycles, so the game gets them; EEVEE's
viewport shows the stone without its crevices and edges. The normal it bakes
is combined: the chips and sub-facets of the 2026-10-03 rock detail study
(formations/detail.py, baked to a map first) go in under the shading Bevel
(`add_detail`), so one map carries the detail and the rounded facet edges.
"""

import math
import random

import bpy
from mathutils import Vector, noise

NAME = "Painted slate"
# A material's custom property scaling every length of its graph (`paint`),
# and the OBJECT property it comes from at export (scene_export.py), which
# also scales the rock's texel density and its detail high poly.
SCALE_PROP, OBJECT_SCALE_PROP = "slate_scale", "detail_scale"
# The v6 albedo: the drift's two ends (dark slate blue, a hair less blue)
# and the edge line's colour.
COOL, WARM, LINE = "#2f3546", "#3b3e4a", "#5c6070"
ROUGHNESS, SPECULAR = 1.0, 0.1
# Drift: Noise scale and detail on Object coordinates.
DRIFT_SCALE, DRIFT_DETAIL = 0.9, 2.0
# Per-facet tone, multiplying the stone.
FACET_TONE = (0.92, 1.08)
# Grain: Noise scale and detail, onto a multiplier range.
GRAIN_SCALE, GRAIN_DETAIL, GRAIN_TONE = 35.0, 3.0, (0.96, 1.04)
# Stains: Noise scale 1 behind a Mapping that stretches it vertically, its
# 0.35 to 0.65 band onto a multiplier range.
STAIN_STRETCH, STAIN_BAND, STAIN_TONE = (3.0, 3.0, 0.7), (0.35, 0.65), (0.75, 1.0)
# Crevices: Ambient Occlusion reach (m) onto a multiplier range.
AO_DISTANCE, AO_TONE = 0.5, (0.55, 1.0)
# Edges: Bevel radius (m); where its normal turns from the true normal (dot
# 0.995 down to 0.92) the stone mixes toward LINE by up to EDGE_MIX.
BEVEL_RADIUS, EDGE_DOT, EDGE_MIX = 0.03, (0.995, 0.92), 0.35
# Concave creases: an Ambient Occlusion reaching CONCAVE_REACH metres; its
# CONCAVE_AO band darkens the stone onto CONCAVE_TONE, and the edge line and
# strips fade out as it falls through CONVEX_GATE (an open convex edge reads
# about 1).
CONCAVE_REACH = 0.06
CONCAVE_AO, CONCAVE_TONE = (0.5, 1.0), (0.55, 1.0)
CONVEX_GATE = (0.85, 0.97)
# The two Bevel nodes' names: the edge line's, and the one on the BSDF's
# Normal that `add_detail` feeds the detail normal map into.
LINE_BEVEL, SHADING_BEVEL = "Slate edge line bevel", "Slate shading bevel"
# How fast the per-facet tone changes with a face's orientation (tone_facets).
TONE_SCALE = 1.5
# Chamfer strips (`mark_strips`): a plane (faces within STRIP_PLANE degrees)
# that is narrow (its extent across its principal axis), at least
# STRIP_LENGTH long and
# bounded by convex creases (over STRIP_CREASE degrees) for STRIP_CONVEX of
# its border is a strip along an edge, and is painted as the edge line: fully
# up to STRIP_WIDTH[0] wide, fading out by STRIP_WIDTH[1]. Narrower than
# STRIP_MIN it is a dissolve sliver, not a strip. Such an edge is two creases
# with the strip between them; the line took the sharper one while the light
# turned dark only at the other, so the highlight looked beside the edge.
STRIP_PLANE, STRIP_CREASE, STRIP_CONVEX = 10.0, 8.0, 0.6
STRIP_MIN, STRIP_WIDTH, STRIP_LENGTH = 0.015, (0.04, 0.08), 0.3
# A strip fills at least STRIP_FILL of its length x width (a wedge about half).
STRIP_FILL = 0.25
# When a list, mark_strips appends (width cm, length m, fill) for each strip.
REPORT = None


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


def mark_strips(mesh):
    """Write each face's chamfer-strip weight into the FACE float attribute
    `strip` (0 = not a strip, 1 = a strip painted as fully as the edge
    line). Returns how many strips were found."""
    import bmesh

    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.normal_update()
    limit = math.radians(STRIP_PLANE)
    crease = math.radians(STRIP_CREASE)
    weight = [0.0] * len(bm.faces)
    seen, strips = set(), 0
    bm.faces.ensure_lookup_table()
    for f0 in bm.faces:
        if f0 in seen:
            continue
        region, stack = [f0], [f0]
        seen.add(f0)
        while stack:
            f = stack.pop()
            for e in f.edges:
                if not e.is_manifold:
                    continue
                for g in e.link_faces:
                    if g not in seen and g.normal.angle(f0.normal, 9) < limit and g.normal.angle(f.normal, 9) < limit:
                        seen.add(g)
                        region.append(g)
                        stack.append(g)
        inside = set(region)
        border = [e for f in region for e in f.edges if not all(g in inside for g in e.link_faces)]
        perimeter = sum(e.calc_length() for e in border)
        if perimeter <= 0:
            continue
        area = sum(f.calc_area() for f in region)
        convex = sum(e.calc_length() for e in border if e.is_manifold and e.calc_face_angle_signed(0) > crease)
        if convex < STRIP_CONVEX * perimeter:
            continue
        # Its extent along and across its principal axis, in its plane (a
        # chamfer is often a long wedge, its two creases meeting at one end,
        # so the widest point across is its width).
        import numpy as np

        pts = np.array([tuple(v.co) for f in region for v in f.verts])
        normal = np.array(tuple(sum((f.normal * f.calc_area() for f in region), Vector()).normalized()))
        rel = pts - pts.mean(0)
        rel -= np.outer(rel @ normal, normal)
        _, vecs = np.linalg.eigh(rel.T @ rel)
        along, across = rel @ vecs[:, 2], rel @ vecs[:, 1]
        length, width = np.ptp(along), np.ptp(across)
        # A sliver chain the dissolve left can run a long way at no width:
        # it fills a few percent of its extent, a wedge about half.
        if width < STRIP_MIN or length < STRIP_LENGTH or area < STRIP_FILL * length * width:
            continue
        if REPORT is not None:
            REPORT.append((round(width * 100, 1), round(length, 2), round(area / (length * width), 2)))
        lo, hi = STRIP_WIDTH
        t = min(1.0, max(0.0, (hi - width) / (hi - lo)))
        if t <= 0:
            continue
        strips += 1
        for f in region:
            weight[f.index] = t * t * (3 - 2 * t)
    bm.free()
    attr = mesh.attributes.get("strip") or mesh.attributes.new("strip", "FLOAT", "FACE")
    attr.data.foreach_set("value", weight)
    return strips


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
    """Replace `mat`'s node tree with the painted slate. A material carrying
    SCALE_PROP (a backdrop rock's, docs/blender-backdrop.md) has every length
    in the graph multiplied by it - the noises' periods, the occlusion reach,
    the bevels - so a rock standing that many times further back than the
    gameplay plane looks on screen as one on the plane does."""
    scale = float(mat.get(SCALE_PROP, 1.0))
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    N = nt.nodes.new
    L = nt.links.new
    # Solid view: the stone's mid tone.
    mat.diffuse_color = srgb(COOL)
    mat.roughness = ROUGHNESS

    def remap(x, lo, hi, to_lo, to_hi):
        m = N("ShaderNodeMapRange")
        m.inputs["From Min"].default_value, m.inputs["From Max"].default_value = lo, hi
        m.inputs["To Min"].default_value, m.inputs["To Max"].default_value = to_lo, to_hi
        L(x, m.inputs["Value"])
        return m.outputs[0]

    def mul(a, b):
        m = N("ShaderNodeMath")
        m.operation = "MULTIPLY"
        L(a, m.inputs[0])
        L(b, m.inputs[1])
        return m.outputs[0]

    def noise_tex(vector, scale, detail):
        t = N("ShaderNodeTexNoise")
        t.inputs["Scale"].default_value = scale
        t.inputs["Detail"].default_value = detail
        L(vector, t.inputs["Vector"])
        return t.outputs["Fac"]

    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = ROUGHNESS
    bsdf.inputs["Specular IOR Level"].default_value = SPECULAR
    L(bsdf.outputs[0], out.inputs[0])
    coord = N("ShaderNodeTexCoord").outputs["Object"]
    if scale != 1.0:
        shrink = N("ShaderNodeVectorMath")
        shrink.operation = "SCALE"
        shrink.inputs["Scale"].default_value = 1.0 / scale
        L(coord, shrink.inputs[0])
        coord = shrink.outputs[0]

    # The drift: cool to warm slate across the block.
    base = N("ShaderNodeMix")
    base.data_type = "RGBA"
    base.inputs[6].default_value = srgb(COOL)
    base.inputs[7].default_value = srgb(WARM)
    L(noise_tex(coord, DRIFT_SCALE, DRIFT_DETAIL), base.inputs[0])

    facet = N("ShaderNodeAttribute")
    facet.attribute_name = "facet"
    ftone = remap(facet.outputs["Fac"], 0.0, 1.0, *FACET_TONE)
    gtone = remap(noise_tex(coord, GRAIN_SCALE, GRAIN_DETAIL), 0.0, 1.0, *GRAIN_TONE)
    stretch = N("ShaderNodeMapping")
    stretch.inputs["Scale"].default_value = STAIN_STRETCH
    L(coord, stretch.inputs["Vector"])
    stone = remap(noise_tex(stretch.outputs[0], 1.0, 2.0), *STAIN_BAND, *STAIN_TONE)
    ao = N("ShaderNodeAmbientOcclusion")
    ao.inputs["Distance"].default_value = AO_DISTANCE * scale
    ao.samples = 8
    atone = remap(ao.outputs["AO"], 0.0, 1.0, *AO_TONE)

    # Concave creases: a short occlusion reads about 1 on an open convex
    # edge and darker in a fold, so it darkens the fold (Tris: "concave
    # edges ... should get ambient occlusion shadows") and gates the line off
    # there (below), which the Bevel alone cannot: it turns both ways.
    crease = N("ShaderNodeAmbientOcclusion")
    crease.inputs["Distance"].default_value = CONCAVE_REACH * scale
    crease.samples = 8
    shadow = remap(crease.outputs["AO"], *CONCAVE_AO, *CONCAVE_TONE)
    convex = remap(crease.outputs["AO"], *CONVEX_GATE, 0.0, 1.0)

    tone = mul(mul(mul(mul(ftone, gtone), atone), stone), shadow)
    tone_rgb = N("ShaderNodeCombineColor")
    for i in range(3):
        L(tone, tone_rgb.inputs[i])
    toned = N("ShaderNodeMix")
    toned.data_type = "RGBA"
    toned.blend_type = "MULTIPLY"
    toned.inputs[0].default_value = 1.0
    L(base.outputs[2], toned.inputs[6])
    L(tone_rgb.outputs[0], toned.inputs[7])

    # The edges: a pale line where the facets' Bevel normal turns, and a
    # second Bevel on the BSDF so the facets round into each other. They are
    # two nodes because the shading one also takes the detail normal
    # (`add_detail`): its chips and sub-facets are rounded with the facets,
    # while the line stays on the facet edges and never traces a chip.
    def bevel(name):
        b = N("ShaderNodeBevel")
        b.name = b.label = name
        b.samples = 8
        b.inputs["Radius"].default_value = BEVEL_RADIUS * scale
        return b

    line = bevel(LINE_BEVEL)
    geo = N("ShaderNodeNewGeometry")
    dot = N("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    L(line.outputs["Normal"], dot.inputs[0])
    L(geo.outputs["Normal"], dot.inputs[1])
    edged = N("ShaderNodeMix")
    edged.data_type = "RGBA"
    edged.inputs[7].default_value = srgb(LINE)
    L(toned.outputs[2], edged.inputs[6])
    # The line, or a chamfer strip painted as one (`mark_strips`).
    strip = N("ShaderNodeAttribute")
    strip.attribute_name = "strip"
    edge = N("ShaderNodeMath")
    edge.operation = "MAXIMUM"
    L(remap(dot.outputs["Value"], *EDGE_DOT, 0.0, EDGE_MIX), edge.inputs[0])
    L(remap(strip.outputs["Fac"], 0.0, 1.0, 0.0, EDGE_MIX), edge.inputs[1])
    L(mul(edge.outputs[0], convex), edged.inputs[0])
    L(edged.outputs[2], bsdf.inputs["Base Color"])
    L(bevel(SHADING_BEVEL).outputs["Normal"], bsdf.inputs["Normal"])


def add_detail(mat, color, uv_map):
    """Put a tangent-space detail normal map (the chips and sub-facets the
    export bakes from formations/detail.py) under the slate's shading Bevel:
    `color` is the map's Color socket, read through `uv_map`. The Bevel then
    rounds the facet edges starting from the detailed normal, so the stone
    shades with both. Returns the Normal Map node."""
    nt = mat.node_tree
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.uv_map = uv_map
    nt.links.new(color, nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], nt.nodes[SHADING_BEVEL].inputs["Normal"])
    return nm
