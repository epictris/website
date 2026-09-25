"""Procedural dirt and moss materials.

Modelled on ../boulders/stylised_rocks_v5/stone_materials.py's node-graph
style, but layered for a natural earth-and-moss read instead of painted slate:

- dirt: warm earth colour at three scales, darker damp patches, a fine sandy
  grain, sparse embedded pebbles, crumbly relief and dark crevices;
- moss: tufted cushions (small rounded clumps with dark gaps), yellow-green
  lit tops shading to deep green in hollows and undersides, a fine fuzz and a
  soft sheen.

Texture coordinates are object space in metres, so detail keeps its
physical size on every block. Nothing in stone_materials.py is imported or
modified.
"""
import bpy


def _node(nodes, kind, label, x, y):
    n = nodes.new(kind)
    n.label = label
    n.location = (x, y)
    return n


def _ramp(nodes, links, label, source, stops, x, y, interp="LINEAR"):
    a = _node(nodes, "ShaderNodeValToRGB", label, x, y)
    a.color_ramp.interpolation = interp
    for i, (pos, rgb) in enumerate(stops):
        e = a.color_ramp.elements[i] if i < 2 else a.color_ramp.elements.new(pos)
        e.position = pos
        e.color = (*rgb, 1)
    links.new(source, a.inputs[0])
    return a.outputs[0]


def _noise(nodes, links, label, source, scale, detail, x, y, roughness=0.5):
    a = _node(nodes, "ShaderNodeTexNoise", label, x, y)
    a.inputs["Scale"].default_value = scale
    a.inputs["Detail"].default_value = detail
    a.inputs["Roughness"].default_value = roughness
    links.new(source, a.inputs["Vector"])
    return a


def _voronoi(nodes, links, label, source, scale, x, y, feature="F1"):
    a = _node(nodes, "ShaderNodeTexVoronoi", label, x, y)
    a.feature = feature
    a.inputs["Scale"].default_value = scale
    links.new(source, a.inputs["Vector"])
    return a


def _mix(nodes, links, label, a, b, factor, x, y, mode="MIX"):
    m = _node(nodes, "ShaderNodeMixRGB", label, x, y)
    m.blend_type = mode
    if isinstance(factor, (int, float)):
        m.inputs[0].default_value = factor
    else:
        links.new(factor, m.inputs[0])
    for v, socket in [(a, m.inputs[1]), (b, m.inputs[2])]:
        if isinstance(v, tuple):
            socket.default_value = (*v, 1)
        else:
            links.new(v, socket)
    return m.outputs[0]


def _bump(nodes, links, label, height, strength, distance, x, y, normal=None):
    b = _node(nodes, "ShaderNodeBump", label, x, y)
    b.inputs["Strength"].default_value = strength
    b.inputs["Distance"].default_value = distance
    links.new(height, b.inputs["Height"])
    if normal is not None:
        links.new(normal, b.inputs["Normal"])
    return b.outputs["Normal"]


def _set(bsdf, name, value):
    if name in bsdf.inputs:
        bsdf.inputs[name].default_value = value


def _shell(name, color, label):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*color, 1)
    n, l = mat.node_tree.nodes, mat.node_tree.links
    n.clear()
    out = _node(n, "ShaderNodeOutputMaterial", "Surface", 1900, 100)
    bs = _node(n, "ShaderNodeBsdfPrincipled", label, 1650, 100)
    l.new(bs.outputs[0], out.inputs[0])
    coord = _node(n, "ShaderNodeTexCoord", "Object space (metres)", -1800, 200).outputs["Object"]
    geo = _node(n, "ShaderNodeNewGeometry", "Surface geometry", -1800, -700)
    return mat, n, l, bs, coord, geo


def dirt_material(name, color, variation, spec=None):
    mat, n, l, bs, coord, geo = _shell(name, color, "Weathered stone")
    _set(bs, "Roughness", 0.96)
    _set(bs, "Specular IOR Level", 0.12)

    broad = _noise(n, l, "Stone strata", coord, 1.35, 4, -1550, 700)
    earth = _ramp(n, l, "Umber / grey stone / pale breaks", broad.outputs["Fac"], [
        (0.30, (0.045, 0.041, 0.036)), (0.45, (0.080, 0.073, 0.062)),
        (0.58, (0.145, 0.132, 0.112)), (0.72, (0.09, 0.081, 0.070))], -1300, 700, "EASE")
    mid = _noise(n, l, "Mottled mineral", coord, 5.5, 4, -1550, 450, 0.6)
    mid_tone = _ramp(n, l, "Mineral value", mid.outputs["Fac"], [
        (0.30, (0.55, 0.54, 0.51)), (0.70, (1.35, 1.30, 1.20))], -1300, 450)
    base = _mix(n, l, "Mottled stone", earth, mid_tone, 1.0, -1050, 600, "MULTIPLY")

    fractures = _voronoi(n, l, "Fine fractured seams", coord, 10, -1550, 20, "DISTANCE_TO_EDGE")
    fracture_tone = _ramp(n, l, "Thin dark seams", fractures.outputs["Distance"], [
        (0.005, (0.35, 0.32, 0.30)), (0.055, (1.0, 1.0, 1.0))], -1300, 20)
    base = _mix(n, l, "Fractured stone", base, fracture_tone, 0.45, -950, 650, "MULTIPLY")

    damp = _noise(n, l, "Damp patches", coord, 2.2, 2, -1550, 200)
    damp_mask = _ramp(n, l, "Where it is damp", damp.outputs["Fac"], [
        (0.50, (0, 0, 0)), (0.64, (1, 1, 1))], -1300, 200)
    base = _mix(n, l, "Damp darkening", base, (0.48, 0.51, 0.47), damp_mask, -800, 550, "MULTIPLY")

    grain = _noise(n, l, "Granular stone", coord, 110, 2, -1550, -50, 0.7)
    grain_tone = _ramp(n, l, "Grain value", grain.outputs["Fac"], [
        (0.30, (0.78, 0.76, 0.74)), (0.70, (1.14, 1.12, 1.08))], -1300, -50)
    base = _mix(n, l, "Granular surface", base, grain_tone, 0.95, -580, 500, "MULTIPLY")

    # Occasional pale mineral inclusions, broken up by the stone base.
    pebbles = _voronoi(n, l, "Pebble cells", coord, 6, -1550, -350)
    pick = _node(n, "ShaderNodeSeparateColor", "Per-cell random", -1300, -300)
    l.new(pebbles.outputs["Color"], pick.inputs[0])
    chosen = _ramp(n, l, "Only some cells hold a pebble", pick.outputs["Red"], [
        (0.87, (0, 0, 0)), (0.88, (1, 1, 1))], -1080, -300, "CONSTANT")
    core = _ramp(n, l, "Rounded pebble core", pebbles.outputs["Distance"], [
        (0.14, (1, 1, 1)), (0.22, (0, 0, 0))], -1300, -500)
    pebble_mask = _mix(n, l, "Pebble mask", chosen, core, 1.0, -850, -400, "MULTIPLY")
    pebble_colour = _ramp(n, l, "Grey-brown stone", pick.outputs["Green"], [
        (0.0, (0.16, 0.15, 0.13)), (1.0, (0.27, 0.25, 0.21))], -1080, -600)
    base = _mix(n, l, "Embedded pebbles", base, pebble_colour, pebble_mask, -350, 450)

    crease = _ramp(n, l, "Dark in concave dips", geo.outputs["Pointiness"], [
        (0.44, (0.35, 0.28, 0.24)), (0.50, (1, 1, 1))], -350, -100, "EASE")
    base = _mix(n, l, "Crevice colour", base, crease, 0.6, -100, 400, "MULTIPLY")
    ao = _node(n, "ShaderNodeAmbientOcclusion", "Occlusion", 150, 100)
    ao.inputs["Distance"].default_value = 0.3
    base = _mix(n, l, "Occluded earth", base, ao.outputs["Color"], 0.55, 400, 400, "MULTIPLY")
    base = _mix(n, l, "Block tone", base, (variation, variation, variation), 1.0, 650, 400, "MULTIPLY")
    l.new(base, bs.inputs["Base Color"])

    rough = _ramp(n, l, "Damp is less rough", damp.outputs["Fac"], [
        (0.50, (0.95, 0.95, 0.95)), (0.64, (0.78, 0.78, 0.78))], 900, 0)
    l.new(rough, bs.inputs["Roughness"])

    crumbly = _noise(n, l, "Crumbly clods", coord, 6.5, 8, 500, -300, 0.62)
    normal = _bump(n, l, "Chipped relief", crumbly.outputs["Fac"], 0.78, 0.06, 800, -300)
    normal = _bump(n, l, "Fracture grooves", fractures.outputs["Distance"], 0.30, 0.006, 900, -470, normal)
    normal = _bump(n, l, "Granular relief", grain.outputs["Fac"], 0.45, 0.005, 1050, -300, normal)
    normal = _bump(n, l, "Mineral inclusions", pebble_mask, 0.3, 0.005, 1300, -300, normal)
    l.new(normal, bs.inputs["Normal"])
    return mat


def moss_material(name, color, variation, spec=None):
    mat, n, l, bs, coord, geo = _shell(name, color, "Moss")
    _set(bs, "Roughness", 0.98)
    _set(bs, "Specular IOR Level", 0.15)
    _set(bs, "Sheen Weight", 0.22)
    _set(bs, "Sheen Roughness", 0.5)
    _set(bs, "Sheen Tint", (0.56, 0.64, 0.40, 1))

    hue = _noise(n, l, "Moss colour patches", coord, 2.6, 3, -1550, 700)
    green = _ramp(n, l, "Muted olive / green / ochre", hue.outputs["Fac"], [
        (0.30, (0.016, 0.036, 0.010)), (0.44, (0.044, 0.077, 0.020)),
        (0.58, (0.092, 0.13, 0.035)), (0.72, (0.15, 0.17, 0.060))], -1300, 700, "EASE")

    # Tufts: small rounded cushions with darker gaps between them.
    tufts = _voronoi(n, l, "Tuft cells", coord, 30, -1550, 350, "SMOOTH_F1")
    tuft_tone = _ramp(n, l, "Tuft tops light, gaps dark", tufts.outputs["Distance"], [
        (0.05, (1.12, 1.10, 0.96)), (0.45, (0.90, 0.91, 0.86)), (0.75, (0.55, 0.60, 0.49))], -1300, 350)
    base = _mix(n, l, "Tufted moss", green, tuft_tone, 1.0, -1000, 600, "MULTIPLY")

    fuzz = _noise(n, l, "Fine fuzz", coord, 240, 2, -1550, 50, 0.8)
    fuzz_tone = _ramp(n, l, "Fuzz value", fuzz.outputs["Fac"], [
        (0.30, (0.72, 0.74, 0.66)), (0.70, (1.18, 1.16, 1.02))], -1300, 50)
    base = _mix(n, l, "Fuzzy moss", base, fuzz_tone, 0.9, -750, 550, "MULTIPLY")

    up = _node(n, "ShaderNodeSeparateXYZ", "Facing", -1550, -300)
    l.new(geo.outputs["Normal"], up.inputs[0])
    facing = _ramp(n, l, "Lit yellow tops, dark undersides", up.outputs["Z"], [
        (0.0, (0.48, 0.54, 0.42)), (0.35, (0.86, 0.89, 0.80)), (0.85, (1.12, 1.10, 0.94))], -1300, -300, "EASE")
    base = _mix(n, l, "Facing shade", base, facing, 1.0, -500, 500, "MULTIPLY")

    if spec and spec.get("construction") == "sdf":
        tip = _node(n, "ShaderNodeAttribute", "Height on each clump", -1500, -800)
        tip.attribute_name = "moss_tip"
        tip_tone = _ramp(n, l, "Dark roots, yellow clump tips", tip.outputs["Fac"], [
            (0.0, (0.62, 0.70, 0.52)), (0.45, (0.94, 1.0, 0.83)),
            (1.0, (1.22, 1.20, 0.83))], -1200, -800, "EASE")
        base = _mix(n, l, "Clump height shade", base, tip_tone, 1.0, -350, 650, "MULTIPLY")
        interior = _node(n, "ShaderNodeAttribute", "Distance inside moss", -1500, -1100)
        interior.attribute_name = "moss_interior"
        fringe_tone = _ramp(n, l, "Dark fringe and stray tufts", interior.outputs["Fac"], [
            (0.0, (0.50, 0.60, 0.43)), (0.35, (0.78, 0.85, 0.66)),
            (1.0, (1.0, 1.0, 1.0))], -1200, -1100, "EASE")
        base = _mix(n, l, "Fringe shade", base, fringe_tone, 1.0, -100, 600, "MULTIPLY")

    hollow = _ramp(n, l, "Deep green in hollows", geo.outputs["Pointiness"], [
        (0.44, (0.35, 0.45, 0.30)), (0.50, (1, 1, 1))], -350, -100, "EASE")
    base = _mix(n, l, "Hollow shade", base, hollow, 0.7, -150, 450, "MULTIPLY")
    ao = _node(n, "ShaderNodeAmbientOcclusion", "Occlusion at the dirt edge", 150, 100)
    ao.inputs["Distance"].default_value = 0.15
    base = _mix(n, l, "Occluded moss", base, ao.outputs["Color"], 0.65, 400, 400, "MULTIPLY")
    base = _mix(n, l, "Patch tone", base, (variation, variation, variation), 1.0, 650, 400, "MULTIPLY")
    l.new(base, bs.inputs["Base Color"])

    invert = _node(n, "ShaderNodeMath", "Tuft height", 500, -300)
    invert.operation = "SUBTRACT"
    invert.inputs[0].default_value = 1.0
    l.new(tufts.outputs["Distance"], invert.inputs[1])
    normal = _bump(n, l, "Low moss nap", invert.outputs[0], 0.35, 0.006, 800, -300)
    normal = _bump(n, l, "Fuzz", fuzz.outputs["Fac"], 0.45, 0.0015, 1050, -300, normal)
    l.new(normal, bs.inputs["Normal"])
    return mat
