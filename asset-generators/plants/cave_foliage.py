"""
Procedural Cave Foliage for Blender (4.0 – 5.x)
================================================
Generates a painterly cave-grotto plant set:
  * Alocasia / elephant-ear clumps (big heart leaves on long petioles)
  * Bird's-nest fern rosettes (wavy strap leaves)
  * Arching sword ferns (serrated pinnae on curved rachis)
  * Hanging ivy / pothos curtains dropping from the cave ceiling
  * Creeping ivy scattered over rock tops
  * Little pale mushroom clusters
  * Displaced rocks with a normal-based moss material

HOW TO RUN
  Scripting workspace -> Text > Open -> this file -> Run Script (Alt+P).
  RUN = "scene"  : builds the demo grotto into the "CaveFoliage" collection.
  RUN = "export" : builds low-poly game variants into "CaveFoliage_Assets"
                   and writes one .glb for three.js / any glTF engine.
  Change SEED for a new variation. Every build_* function can also be
  called on its own to drop single plants anywhere.

GAME EXPORT NOTES
  * All procedural shading is baked to vertex colours (COLOR_0), so one
    shared vertex-colour material = one draw call per plant.
  * Foliage carries a custom attribute _SWAY (0 at the base, 1 at leaf tips)
    that three.js loads as geometry.attributes._sway for wind shaders.
  * Every asset's pivot is at its base (ivy vines: pivot at the top anchor).
"""

import bpy, bmesh, math, random
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree

# ---------------------------------------------------------------- settings
SEED = 7
COLL_NAME = "CaveFoliage"
IVY_CLUMPS = 16          # clumps of hanging vines along the cave lip
CREEPER_CLUSTERS = 70    # leaf clusters scattered on the main rock
BUILD_DEMO_SCENE = True  # camera, sun, world, ground

RUN = "scene"            # "scene" or "export"
EXPORT_PATH = "//cave_foliage_assets.glb"   # "//" = next to the .blend
EXPORT_DETAIL = 0.5      # mesh resolution multiplier for game assets
VARIANTS = 3             # variants per plant type in the export

# internal state (set by export_assets)
DETAIL = 1.0
GAME_MODE = False
_GAME_MATS = {}

GOLDEN = math.pi * (3 - math.sqrt(5))
UP = Vector((0, 0, 1))


# ================================================================ helpers
def hexcol(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return (*lin, 1.0)


LEAF_PALETTES = {  # dark, mid, pale, vein  (sRGB hex, sampled from the painting)
    'alocasia': ("#2F4028", "#5E7148", "#8C9A6C", "#B9C094"),
    'ivy': ("#34482A", "#6A7E48", "#98A770", "#C0C79A"),
    'fern': ("#3A5226", "#6F8A45", "#9DB06A", "#B8C58A"),
    'birdsnest': ("#3C5128", "#71884A", "#A3B377", "#C9CFA0"),
}
LEAF_STOPS = (0.0, 0.42, 0.7, 1.0)
CAP_STOPS = [(0.0, '#D9CDB5'), (0.5, '#EEE8DA'), (0.74, '#E2D9C6'), (0.82, '#B3A58A'), (1.0, '#9E9078')]
ROCK_STOPS = [(0.0, '#3F3E39'), (0.42, '#8A877C'), (0.56, '#48552E'), (1.0, '#7F8B52')]
FLAT_COLS = {'stem': '#56663F', 'mstem': '#E8E1D2'}


def ramp_eval(stops, f):
    """Linear colour-ramp evaluation in linear RGB (matches Blender's ramp)."""
    f = min(max(f, 0.0), 1.0)
    if f <= stops[0][0]:
        return hexcol(stops[0][1])
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        if f <= p1:
            r = (f - p0) / max(p1 - p0, 1e-9)
            a, b = hexcol(c0), hexcol(c1)
            return tuple(a[i] + (b[i] - a[i]) * r for i in range(4))
    return hexcol(stops[-1][1])


def bake_color(key, u, v, r):
    """CPU version of the node materials, used for vertex-colour baking."""
    if key in LEAF_PALETTES:
        nz = noise.noise(Vector((u * 4.0, v * 4.0, r * 37.0))) * 0.5 + 0.5
        var = 0.5 * r + 0.25 * v + 0.25 * nz
        vein = 1 - min(abs(u - 0.5) / 0.035, 1.0)
        stops = list(zip(LEAF_STOPS, LEAF_PALETTES[key]))
        return ramp_eval(stops, var * 0.8 + vein * 0.12)
    if key == 'cap':
        return ramp_eval(CAP_STOPS, v)
    if key in FLAT_COLS:
        return hexcol(FLAT_COLS[key])
    return (0.5, 0.5, 0.5, 1.0)


def rock_color(co, nrm, moss_lo=0.35):
    n1 = noise.noise(co * 1.8) * 0.5 + 0.5
    n2 = noise.noise(co * 7.0) * 0.5 + 0.5
    mz = (n1 - 0.5) * 0.8 + nrm.z
    mask = min(max((mz - moss_lo) / 0.15, 0.0), 1.0)
    return ramp_eval(ROCK_STOPS, mask * 0.56 + n2 * 0.44)


def frame(forward, up, roll=0.0):
    """3x3 matrix mapping local +Y -> forward, +Z -> up (orthogonalised)."""
    y = forward.normalized()
    x = y.cross(up)
    if x.length < 1e-6:
        x = y.orthogonal()
    x.normalize()
    z = x.cross(y).normalized()
    M = Matrix((x, y, z)).transposed()
    if roll:
        M = Matrix.Rotation(roll, 3, y) @ M
    return M


def bezier(p0, p1, p2, n):
    out = []
    for i in range(n):
        t = i / (n - 1)
        out.append((1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t * t * p2)
    return out


def arc(length, bend, n=32, power=1.5):
    """Planar curve in the YZ plane that curls downward (-Z) as it goes."""
    pts, angs = [Vector((0, 0, 0))], [0.0]
    y = z = 0.0
    dl = length / n
    for i in range(1, n + 1):
        am = bend * ((i - 0.5) / n) ** power
        y += math.cos(am) * dl
        z -= math.sin(am) * dl
        pts.append(Vector((0, y, z)))
        angs.append(bend * (i / n) ** power)
    return pts, angs


def arc_at(pts, angs, t):
    n = len(pts) - 1
    f = min(max(t, 0.0), 1.0) * n
    i = min(int(f), n - 1)
    r = f - i
    return pts[i].lerp(pts[i + 1], r), angs[i] + (angs[i + 1] - angs[i]) * r


def polyline_at(pts, cum, d):
    for i in range(1, len(pts)):
        if cum[i] >= d:
            seg = max(cum[i] - cum[i - 1], 1e-9)
            r = (d - cum[i - 1]) / seg
            return pts[i - 1].lerp(pts[i], r), (pts[i] - pts[i - 1]).normalized()
    return pts[-1], (pts[-1] - pts[-2]).normalized()


# ================================================================ geometry
class MeshBuilder:
    """Accumulates parts, then writes one mesh with UVs, a per-part random
    attribute ('leaf_rand') and per-face material indices."""

    def __init__(self):
        self.verts, self.faces, self.uvs, self.rand, self.mats = [], [], [], [], []
        self.vmats = []

    def add(self, verts, faces, uvs, rand, mat=0):
        off = len(self.verts)
        self.verts += verts
        self.uvs += uvs
        self.rand += [rand] * len(verts)
        self.vmats += [mat] * len(verts)
        self.faces += [tuple(i + off for i in f) for f in faces]
        self.mats += [mat] * len(faces)

    def build(self, name, materials, coll, location=(0, 0, 0), sway=1.0):
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(v) for v in self.verts], [], self.faces)
        me.update()
        uvl = me.uv_layers.new(name="UVMap")
        lv = [0] * len(me.loops)
        me.loops.foreach_get("vertex_index", lv)
        flat = []
        for vi in lv:
            flat.extend(self.uvs[vi])
        uvl.data.foreach_set("uv", flat)
        at = me.attributes.new("leaf_rand", 'FLOAT', 'POINT')
        at.data.foreach_set("value", self.rand)

        # baked vertex colour (same look as the node materials)
        keys = [m.get("cf_key", "") for m in materials]
        cols = []
        for (u, v), r, mi in zip(self.uvs, self.rand, self.vmats):
            cols.extend(bake_color(keys[mi] if mi < len(keys) else "", u, v, r))
        ca = me.color_attributes.new("Color", 'FLOAT_COLOR', 'POINT')
        ca.data.foreach_set("color", cols)
        try:
            me.color_attributes.active_color = ca
        except Exception:
            pass

        # wind weight: 0 at the pivot, 1 at the farthest point
        dists = [v.length for v in self.verts]
        md = max(dists) if dists else 1.0
        sw = me.attributes.new("_sway", 'FLOAT', 'POINT')
        sw.data.foreach_set("value", [sway * (d / md) ** 1.5 for d in dists])

        if GAME_MODE:
            materials = [game_material("CF_GameFoliage", double_sided=True)]
            me.polygons.foreach_set("material_index", [0] * len(me.polygons))
        else:
            me.polygons.foreach_set("material_index", self.mats)
        me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
        for m in materials:
            me.materials.append(m)
        me.update()
        ob = bpy.data.objects.new(name, me)
        coll.objects.link(ob)
        ob.location = location
        return ob


def tube(points, r0, r1, sides=6):
    """Tapered tube along a polyline, parallel-transport frames."""
    sides = max(3, round(sides * DETAIL))
    n = len(points)
    tangents = []
    for i in range(n):
        a, b = points[max(i - 1, 0)], points[min(i + 1, n - 1)]
        tangents.append((b - a).normalized())
    nrm = tangents[0].orthogonal().normalized()
    verts, faces, uvs = [], [], []
    for i in range(n):
        if i > 0:
            nrm = tangents[i - 1].rotation_difference(tangents[i]) @ nrm
        bi = tangents[i].cross(nrm).normalized()
        t = i / (n - 1)
        r = r0 + (r1 - r0) * t
        for k in range(sides):
            a = 2 * math.pi * k / sides
            verts.append(points[i] + (nrm * math.cos(a) + bi * math.sin(a)) * r)
            uvs.append((k / sides, t))
    for i in range(n - 1):
        for k in range(sides):
            a, b = i * sides + k, i * sides + (k + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    return verts, faces, uvs


def lathe(profile, seg=12):
    seg = max(6, round(seg * DETAIL))
    verts, faces, uvs = [], [], []
    m = len(profile)
    for k in range(seg):
        a = 2 * math.pi * k / seg
        for j, (r, z) in enumerate(profile):
            verts.append(Vector((r * math.cos(a), r * math.sin(a), z)))
            uvs.append((k / seg, j / (m - 1)))
    for k in range(seg):
        k2 = (k + 1) % seg
        for j in range(m - 1):
            faces.append((k * m + j, k2 * m + j, k2 * m + j + 1, k * m + j + 1))
    return verts, faces, uvs


# leaf outline: width fraction along the length (t = 0 base, 1 tip)
SHAPES = {
    'heart': lambda t: math.sin(math.pi * (0.18 + 0.82 * t)) ** 0.75,
    'lance': lambda t: math.sin(math.pi * t) ** 0.55,
    'strap': lambda t: math.sin(math.pi * (0.02 + 0.96 * t ** 1.3)) ** 0.4,
}


def leaf_geo(length, width, shape='heart', rows=10, cols=6, notch=0.0,
             fold=0.25, bend=0.5, wave=0.0, waves=3.0, serrate=0.0, teeth=6,
             rng=None):
    """Single leaf in local space: +Y along blade, +Z = upper face.
    Origin is the petiole attachment point.
      notch  : heart sinus depth (0..0.3)   fold : V-fold along the midrib
      bend   : curl of the blade (radians)  wave : edge ripple amplitude
      serrate: lobing of the margin"""
    rows = max(2, round(rows * DETAIL))
    cols = max(2, 2 * round(cols * DETAIL / 2))
    wf = SHAPES[shape]
    sp, angs = arc(length, bend, 40, 1.5)
    ph = rng.random() * 6.283 if rng else 0.0
    verts, uvs = [], []
    for i in range(rows + 1):
        t = i / rows
        for j in range(cols + 1):
            s = -1 + 2 * j / cols
            tn = notch * (1 - abs(s)) ** 1.5
            tt = tn + t * (1 - tn)
            w = width * 0.5 * wf(tt)
            if serrate:
                w *= 1 - serrate * abs(math.sin(tt * math.pi * teeth))
            x = s * w
            p, a = arc_at(sp, angs, tt)
            nrm = Vector((0, math.sin(a), math.cos(a)))
            h = fold * abs(x)
            if wave:
                h += wave * width * math.sin(tt * waves * 6.283 + ph + (0 if s > 0 else 1.9)) * abs(s) ** 2
            verts.append(Vector((x, p.y, p.z)) + nrm * h)
            uvs.append(((s + 1) / 2, tt))
    c = cols + 1
    faces = [(i * c + j, i * c + j + 1, i * c + j + 1 + c, i * c + j + c)
             for i in range(rows) for j in range(cols)]
    att, _ = arc_at(sp, angs, notch)
    return [v - att for v in verts], faces, uvs


# ================================================================ materials
def new_mat(name):
    old = bpy.data.materials.get(name)
    if old:
        bpy.data.materials.remove(old)
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    m.node_tree.nodes.clear()
    return m, m.node_tree


def set_in(node, names, val):
    for n in names:
        s = node.inputs.get(n)
        if s is not None:
            s.default_value = val
            return


def mnode(nt, op, a, b=None, c=None):
    n = nt.nodes.new('ShaderNodeMath')
    n.operation = op
    for i, v in enumerate((a, b, c)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def ramp_node(nt, stops):
    r = nt.nodes.new('ShaderNodeValToRGB')
    els = r.color_ramp.elements
    els[0].position, els[0].color = stops[0][0], hexcol(stops[0][1])
    els[1].position, els[1].color = stops[-1][0], hexcol(stops[-1][1])
    for p, h in stops[1:-1]:
        els.new(p).color = hexcol(h)
    return r


def leaf_material(name, dark, mid, pale, vein, transl=0.25):
    """Colour = per-leaf random + base->tip gradient + painterly noise,
    pale midrib, mixed with translucency for backlit glow."""
    m, nt = new_mat(name)
    N, L = nt.nodes, nt.links
    out = N.new('ShaderNodeOutputMaterial')
    bsdf = N.new('ShaderNodeBsdfPrincipled')
    tr = N.new('ShaderNodeBsdfTranslucent')
    mix = N.new('ShaderNodeMixShader')
    tc = N.new('ShaderNodeTexCoord')
    sep = N.new('ShaderNodeSeparateXYZ')
    at = N.new('ShaderNodeAttribute')
    at.attribute_name = 'leaf_rand'
    nz = N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 4.0
    L.new(tc.outputs['UV'], sep.inputs[0])
    L.new(tc.outputs['UV'], nz.inputs['Vector'])

    u, v = sep.outputs['X'], sep.outputs['Y']
    var = mnode(nt, 'MULTIPLY', at.outputs['Fac'], 0.5)
    var = mnode(nt, 'MULTIPLY_ADD', v, 0.25, var)
    var = mnode(nt, 'MULTIPLY_ADD', nz.outputs['Fac'], 0.25, var)
    dist = mnode(nt, 'ABSOLUTE', mnode(nt, 'SUBTRACT', u, 0.5))
    vein_m = mnode(nt, 'SUBTRACT', 1.0, mnode(nt, 'MINIMUM', mnode(nt, 'DIVIDE', dist, 0.035), 1.0))
    f = mnode(nt, 'MULTIPLY_ADD', var, 0.72, mnode(nt, 'MULTIPLY', vein_m, 0.28))

    ramp = ramp_node(nt, [(0.0, dark), (0.42, mid), (0.7, pale), (1.0, vein)])
    L.new(f, ramp.inputs['Fac'])
    L.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    L.new(ramp.outputs['Color'], tr.inputs['Color'])
    bsdf.inputs['Roughness'].default_value = 0.65
    set_in(bsdf, ['Specular IOR Level', 'Specular'], 0.25)
    mix.inputs[0].default_value = transl
    L.new(bsdf.outputs[0], mix.inputs[1])
    L.new(tr.outputs[0], mix.inputs[2])
    L.new(mix.outputs[0], out.inputs['Surface'])
    return m


def flat_material(name, col, rough=0.7):
    m, nt = new_mat(name)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    b.inputs['Base Color'].default_value = hexcol(col)
    b.inputs['Roughness'].default_value = rough
    set_in(b, ['Specular IOR Level', 'Specular'], 0.2)
    nt.links.new(b.outputs[0], out.inputs['Surface'])
    return m


def gradient_material(name, stops, rough=0.6):
    """Colour ramp driven by UV V (used for mushroom caps: top -> gills)."""
    m, nt = new_mat(name)
    N = nt.nodes
    out = N.new('ShaderNodeOutputMaterial')
    b = N.new('ShaderNodeBsdfPrincipled')
    tc = N.new('ShaderNodeTexCoord')
    sep = N.new('ShaderNodeSeparateXYZ')
    r = ramp_node(nt, stops)
    nt.links.new(tc.outputs['UV'], sep.inputs[0])
    nt.links.new(sep.outputs['Y'], r.inputs['Fac'])
    nt.links.new(r.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = rough
    nt.links.new(b.outputs[0], out.inputs['Surface'])
    return m


def rock_material(name, moss_lo=0.35):
    """Stone with moss on upward-facing surfaces, broken up by noise."""
    m, nt = new_mat(name)
    N, L = nt.nodes, nt.links
    out = N.new('ShaderNodeOutputMaterial')
    b = N.new('ShaderNodeBsdfPrincipled')
    tc = N.new('ShaderNodeTexCoord')
    geo = N.new('ShaderNodeNewGeometry')
    sepn = N.new('ShaderNodeSeparateXYZ')
    L.new(geo.outputs['Normal'], sepn.inputs[0])
    n1 = N.new('ShaderNodeTexNoise')
    n1.inputs['Scale'].default_value = 1.8
    n1.inputs['Detail'].default_value = 4.0
    n2 = N.new('ShaderNodeTexNoise')
    n2.inputs['Scale'].default_value = 7.0
    n2.inputs['Detail'].default_value = 6.0
    L.new(tc.outputs['Object'], n1.inputs['Vector'])
    L.new(tc.outputs['Object'], n2.inputs['Vector'])

    mz = mnode(nt, 'MULTIPLY_ADD', mnode(nt, 'SUBTRACT', n1.outputs['Fac'], 0.5), 0.8, sepn.outputs['Z'])
    mr = N.new('ShaderNodeMapRange')
    L.new(mz, mr.inputs[0])
    mr.inputs[1].default_value = moss_lo
    mr.inputs[2].default_value = moss_lo + 0.15
    mr.inputs[3].default_value = 0.0
    mr.inputs[4].default_value = 1.0
    f = mnode(nt, 'MULTIPLY_ADD', mr.outputs[0], 0.56, mnode(nt, 'MULTIPLY', n2.outputs['Fac'], 0.44))
    ramp = ramp_node(nt, ROCK_STOPS)
    L.new(f, ramp.inputs['Fac'])
    L.new(ramp.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.9
    set_in(b, ['Specular IOR Level', 'Specular'], 0.15)
    bump = N.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.35
    L.new(n2.outputs['Fac'], bump.inputs['Height'])
    L.new(bump.outputs['Normal'], b.inputs['Normal'])
    L.new(b.outputs[0], out.inputs['Surface'])
    return m


def game_material(name, double_sided=True, rough=0.85):
    """Vertex-colour-only material; exports to glTF as COLOR_0 * white."""
    if name in _GAME_MATS:
        return _GAME_MATS[name]
    m, nt = new_mat(name)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = "Color"
    nt.links.new(vc.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = rough
    set_in(b, ['Specular IOR Level', 'Specular'], 0.2)
    nt.links.new(b.outputs[0], out.inputs['Surface'])
    m.use_backface_culling = not double_sided
    _GAME_MATS[name] = m
    return m


def make_materials():
    mats = {k: leaf_material("CF_" + k.capitalize(), *LEAF_PALETTES[k], t)
            for k, t in (('alocasia', 0.25), ('ivy', 0.3), ('fern', 0.3), ('birdsnest', 0.25))}
    mats['stem'] = flat_material("CF_Stem", FLAT_COLS['stem'], 0.7)
    mats['cap'] = gradient_material("CF_MushroomCap", CAP_STOPS)
    mats['mstem'] = flat_material("CF_MushroomStem", FLAT_COLS['mstem'], 0.6)
    mats['rock'] = rock_material("CF_Rock", 0.35)
    mats['ground'] = rock_material("CF_Ground", 0.97)
    for k, m in mats.items():
        m["cf_key"] = k
    return mats


# ================================================================ plants
def build_alocasia(name, loc, seed, coll, mats, size=1.0):
    """Elephant-ear clump: long petioles, big drooping heart leaves."""
    rng = random.Random(seed)
    mb = MeshBuilder()
    for i in range(rng.randint(7, 11)):
        az = i * GOLDEN + rng.uniform(-0.3, 0.3)
        out = Vector((math.cos(az), math.sin(az), 0))
        h = rng.uniform(0.3, 0.95) * size
        reach = rng.uniform(0.2, 0.55) * size
        base = Vector((rng.uniform(-0.05, 0.05), rng.uniform(-0.05, 0.05), 0))
        p2 = base + UP * h + out * reach
        pts = bezier(base, base + UP * h * 0.7 + out * reach * 0.15, p2, 8)
        mb.add(*tube(pts, 0.02 * size, 0.011 * size, 6), rng.random(), 1)
        Lg = rng.uniform(0.5, 0.9) * size
        lv, lf, lu = leaf_geo(Lg, Lg * rng.uniform(0.85, 1.0), 'heart', rows=12, cols=8,
                              notch=0.22, fold=0.3, bend=rng.uniform(0.3, 0.8),
                              wave=0.03, waves=2.5, rng=rng)
        pitch = rng.uniform(-0.6, 0.25)
        fwd = out * math.cos(pitch) + UP * math.sin(pitch)
        M = frame(fwd, UP, rng.uniform(-0.3, 0.3))
        mb.add([p2 + M @ v for v in lv], lf, lu, rng.random(), 0)
    return mb.build(name, [mats['alocasia'], mats['stem']], coll, loc)


def build_birds_nest(name, loc, seed, coll, mats, size=1.0):
    """Rosette of long, wavy strap leaves arching outward."""
    rng = random.Random(seed)
    mb = MeshBuilder()
    for i in range(rng.randint(10, 16)):
        az = i * GOLDEN + rng.uniform(-0.2, 0.2)
        out = Vector((math.cos(az), math.sin(az), 0))
        elev = rng.uniform(0.5, 1.2)
        fwd = out * math.cos(elev) + UP * math.sin(elev)
        Lg = rng.uniform(0.5, 0.9) * size
        lv, lf, lu = leaf_geo(Lg, Lg * rng.uniform(0.2, 0.26), 'strap', rows=16, cols=6,
                              fold=0.35, bend=rng.uniform(0.6, 1.4), wave=0.025, waves=5, rng=rng)
        M = frame(fwd, UP, rng.uniform(-0.2, 0.2))
        base = out * 0.03 * size
        mb.add([base + M @ v for v in lv], lf, lu, rng.random(), 0)
    return mb.build(name, [mats['birdsnest'], mats['stem']], coll, loc)


def add_frond(mb, Mf, origin, L, rng):
    """One fern frond: arching rachis with paired, serrated pinnae."""
    pts, angs = arc(L, rng.uniform(0.9, 1.8), 24, 1.3)
    mb.add(*tube([origin + Mf @ p for p in pts], 0.006, 0.0015, 4), rng.random(), 1)
    stipe = 0.15
    density = max(0.6, DETAIL)          # fewer, bigger pinnae at low detail
    npairs = max(6, round(rng.randint(16, 24) * density))
    X = Vector((1, 0, 0))
    for k in range(npairs):
        tl = (k + 0.5) / npairs
        p, a = arc_at(pts, angs, stipe + (1 - stipe) * tl)
        T = Vector((0, math.cos(a), -math.sin(a)))
        Nn = Vector((0, math.sin(a), math.cos(a)))
        sz = L * 0.2 * max(0.12, math.sin(math.pi * (0.2 + 0.8 * tl)) ** 0.8) / density ** 0.5
        r = rng.random()
        for side in (-1, 1):
            ang = rng.uniform(0.95, 1.25)
            Mp = frame(X * side * math.sin(ang) + T * math.cos(ang), Nn)
            pv, pf, pu = leaf_geo(sz, sz * 0.32, 'lance', rows=8, cols=4, fold=0.25,
                                  bend=0.35, serrate=0.3, teeth=4, rng=rng)
            base = p + T * 0.004 * side
            mb.add([origin + Mf @ (base + Mp @ q) for q in pv], pf, pu, r, 0)


def build_fern(name, loc, seed, coll, mats, size=1.0):
    rng = random.Random(seed)
    mb = MeshBuilder()
    for i in range(rng.randint(7, 12)):
        az = i * GOLDEN + rng.uniform(-0.25, 0.25)
        out = Vector((math.cos(az), math.sin(az), 0))
        elev = rng.uniform(0.45, 1.15)
        Mf = frame(out * math.cos(elev) + UP * math.sin(elev), UP, rng.uniform(-0.25, 0.25))
        add_frond(mb, Mf, out * 0.02, size * rng.uniform(0.55, 0.95), rng)
    return mb.build(name, [mats['fern'], mats['stem']], coll, loc)


def add_ivy_vine(mb, anchor, length, face, rng, leaf_size=0.085, spacing=0.055):
    """Hanging vine: wandering stem with alternating heart leaves facing `face`."""
    n = max(6, int(length / 0.05))
    off = Vector((rng.uniform(0, 500), rng.uniform(0, 500), rng.uniform(0, 500)))
    side_axis = face.cross(UP).normalized()
    pts = []
    for i in range(n + 1):
        t = i / n
        sx = noise.noise(off + Vector((t * 2.0, 0, 0)))
        sy = noise.noise(off + Vector((0, t * 2.0, 7.3)))
        pts.append(anchor + Vector((0, 0, -length * t)) + side_axis * sx * 0.18 * t
                   + face * (0.06 * math.sin(math.pi * t) + sy * 0.06 * t))
    mb.add(*tube(pts, 0.006, 0.0025, 4), rng.random(), 1)

    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + (pts[i] - pts[i - 1]).length)
    total = cum[-1]
    d = rng.uniform(0.02, spacing)
    sgn = 1
    while d < total:
        t = d / total
        P, _ = polyline_at(pts, cum, d)
        sgn = -sgn
        side = side_axis * sgn
        sz = leaf_size * (1.0 - 0.45 * t) * rng.uniform(0.75, 1.2)
        pet_dir = (side * 0.7 + face * 0.6 + UP * 0.2).normalized()
        pet_end = P + pet_dir * sz * 0.45
        pet = [P, P.lerp(pet_end, 0.5) + UP * sz * 0.08, pet_end]
        mb.add(*tube(pet, 0.0025, 0.0018, 3), rng.random(), 1)
        fwd = (-UP * rng.uniform(0.5, 1.0) + side * rng.uniform(0.2, 0.6)
               + face * rng.uniform(0.1, 0.5)).normalized()
        up = (face + UP * 0.3 + side * rng.uniform(-0.3, 0.3)).normalized()
        lv, lf, lu = leaf_geo(sz, sz * rng.uniform(0.8, 0.95), 'heart', rows=6, cols=4,
                              notch=0.14, fold=0.22, bend=rng.uniform(0.1, 0.5), rng=rng)
        M = frame(fwd, up, rng.uniform(-0.4, 0.4))
        mb.add([pet_end + M @ v for v in lv], lf, lu, rng.random(), 0)
        d += spacing * rng.uniform(0.7, 1.3)


def build_ivy_curtain(name, loc, anchors, seed, coll, mats,
                      face=Vector((0, -1, 0)), min_len=0.6, max_len=2.4):
    rng = random.Random(seed)
    mb = MeshBuilder()
    for a in anchors:
        add_ivy_vine(mb, a, rng.uniform(min_len, max_len), face, rng)
    return mb.build(name, [mats['ivy'], mats['stem']], coll, loc)


def build_creepers(name, loc, faces, seed, coll, mats, clusters=60):
    """Small ivy leaves hugging the upward-facing parts of a rock."""
    rng = random.Random(seed)
    mb = MeshBuilder()
    cands = [f for f in faces if f[1].z > 0.35]
    if not cands:
        return None
    picks = rng.choices(cands, weights=[f[2] for f in cands], k=clusters)
    for center, n, _ in picks:
        for _ in range(rng.randint(4, 9)):
            tang = Matrix.Rotation(rng.uniform(0, 6.283), 3, n) @ n.orthogonal().normalized()
            pos = center + tang * rng.uniform(0, 0.08) + n * 0.015
            fwd = (tang + n * rng.uniform(0.1, 0.6)).normalized()
            sz = rng.uniform(0.04, 0.08)
            lv, lf, lu = leaf_geo(sz, sz * 0.9, 'heart', rows=5, cols=4, notch=0.14,
                                  fold=0.2, bend=0.3, rng=rng)
            M = frame(fwd, n, rng.uniform(-0.3, 0.3))
            mb.add([pos + M @ v for v in lv], lf, lu, rng.random(), 0)
    return mb.build(name, [mats['ivy'], mats['stem']], coll, loc, sway=0.3)


def build_mushrooms(name, loc, seed, coll, mats, count=None):
    rng = random.Random(seed)
    mb = MeshBuilder()
    for _ in range(count or rng.randint(3, 6)):
        off = Vector((rng.gauss(0, 0.05), rng.gauss(0, 0.05), 0))
        h = rng.uniform(0.06, 0.16)
        lean = Vector((rng.gauss(0, 0.3), rng.gauss(0, 0.3), 1)).normalized()
        pts = bezier(off, off + UP * h * 0.6, off + lean * h, 6)
        rs = rng.uniform(0.007, 0.011)
        mb.add(*tube(pts, rs, rs * 0.8, 8), rng.random(), 1)
        tan = (pts[-1] - pts[-2]).normalized()
        R = rng.uniform(0.025, 0.05)
        H = R * rng.uniform(0.45, 0.8)
        prof = [(R * math.sin(f), H * math.cos(f))
                for f in (k / 8 * math.pi / 2 * 1.08 for k in range(9))]
        prof += [(R * 0.85, -H * 0.12), (R * 0.45, -H * 0.08), (rs * 1.1, -H * 0.02)]
        cv, cf, cu = lathe(prof, 14)
        M = frame(tan.orthogonal(), tan, rng.uniform(0, 6.283))
        top = pts[-1] - tan * H * 0.1
        mb.add([top + M @ v for v in cv], cf, cu, rng.random(), 0)
    return mb.build(name, [mats['cap'], mats['mstem']], coll, loc, sway=0.0)


def build_rock(name, loc, scale, seed, coll, mat, flat=-0.2, grounded=True, subdiv=5):
    """Noise-displaced icosphere with a flattened base.
    Returns (object, BVH in local space, [(center, normal, area), ...])."""
    rng = random.Random(seed)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
    off = Vector((rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100)))
    for v in bm.verts:
        d = noise.fractal(v.co * 1.2 + off, 0.8, 2.0, 5)
        co = v.co.normalized() * (1 + 0.35 * d)
        co = Vector((co.x * scale.x, co.y * scale.y, max(co.z, flat) * scale.z))
        v.co = co
    for f in bm.faces:
        f.smooth = True
    bm.normal_update()
    faces = [(f.calc_center_median(), f.normal.copy(), f.calc_area()) for f in bm.faces]
    vcols = []
    for v in bm.verts:
        vcols.extend(rock_color(v.co, v.normal))
    bvh = BVHTree.FromBMesh(bm)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ca = me.color_attributes.new("Color", 'FLOAT_COLOR', 'POINT')
    ca.data.foreach_set("color", vcols)
    me.materials.append(game_material("CF_GameRock", double_sided=False, rough=0.95) if GAME_MODE else mat)
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    ob.location = loc + (Vector((0, 0, -flat * scale.z - 0.05)) if grounded else Vector())
    return ob, bvh, faces


def on_surface(rock, bvh, x, y):
    hit = bvh.ray_cast(Vector((x, y, 50)), Vector((0, 0, -1)))[0]
    return rock.location + (hit if hit is not None else Vector((x, y, 0)))


def build_plane(name, size, mat, coll):
    mb = MeshBuilder()
    s = size / 2
    mb.add([Vector((-s, -s, 0)), Vector((s, -s, 0)), Vector((s, s, 0)), Vector((-s, s, 0))],
           [(0, 1, 2, 3)], [(0, 0), (1, 0), (1, 1), (0, 1)], 0.5, 0)
    return mb.build(name, [mat], coll)


# ================================================================ scene
def get_collection(name):
    coll = bpy.data.collections.get(name)
    if coll:
        for o in list(coll.objects):
            bpy.data.objects.remove(o, do_unlink=True)
    else:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    return coll


def setup_scene(coll):
    scene = bpy.context.scene
    cd = bpy.data.cameras.new("CF_Camera")
    cd.lens = 28
    cam = bpy.data.objects.new("CF_Camera", cd)
    coll.objects.link(cam)
    cam.location = Vector((0, -7.8, 1.7))
    cam.rotation_euler = (Vector((0, 0.3, 1.6)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam

    ld = bpy.data.lights.new("CF_Sun", 'SUN')
    ld.energy = 4.5
    ld.color = (1.0, 0.93, 0.8)
    ld.angle = 0.15
    sun = bpy.data.objects.new("CF_Sun", ld)
    coll.objects.link(sun)
    sun.rotation_euler = Vector((0.45, -0.25, -0.85)).to_track_quat('-Z', 'Y').to_euler()

    try:
        world = scene.world or bpy.data.worlds.new("CF_World")
        scene.world = world
        try:
            world.use_nodes = True
        except Exception:
            pass
        bg = world.node_tree.nodes.get('Background')
        if bg:
            bg.inputs['Color'].default_value = hexcol('#A7B09A')
            bg.inputs['Strength'].default_value = 1.4
    except Exception as e:
        print("World setup skipped:", e)

    scene.render.resolution_x = 2400
    scene.render.resolution_y = 900


def main():
    rng = random.Random(SEED)
    coll = get_collection(COLL_NAME)
    mats = make_materials()

    build_plane("CF_Ground", 16, mats['ground'], coll)
    rock, rbvh, rfaces = build_rock("CF_Rock_Main", Vector((0.3, 0.7, 0)), Vector((1.5, 1.2, 1.3)),
                                    SEED, coll, mats['rock'])
    rock2, r2bvh, r2faces = build_rock("CF_Rock_Left", Vector((-2.6, 0.4, 0)), Vector((1.1, 0.9, 0.8)),
                                       SEED + 1, coll, mats['rock'])
    ceil, cbvh, _ = build_rock("CF_Rock_Ceiling", Vector((0, 1.2, 3.9)), Vector((5.5, 2.4, 1.0)),
                               SEED + 2, coll, mats['rock'], grounded=False)

    back, _, _ = build_rock("CF_Rock_Back", Vector((0, 4.2, 0)), Vector((7.5, 1.6, 4.2)),
                            SEED + 3, coll, mats['rock'])
    build_birds_nest("CF_BirdsNest", on_surface(rock, rbvh, 0.2, 0.0), SEED + 10, coll, mats, size=1.3)
    build_alocasia("CF_Alocasia_1", on_surface(rock, rbvh, 0.7, 0.35), SEED + 11, coll, mats)
    build_alocasia("CF_Alocasia_2", Vector((3.3, 0.3, 0)), SEED + 12, coll, mats, size=1.4)
    build_alocasia("CF_Alocasia_3", on_surface(rock2, r2bvh, 0.2, 0.2), SEED + 13, coll, mats, size=0.9)
    build_alocasia("CF_Alocasia_4", Vector((-4.2, 0.9, 0)), SEED + 14, coll, mats, size=1.5)
    build_fern("CF_Fern_1", Vector((-1.2, -0.5, 0)), SEED + 20, coll, mats)
    build_fern("CF_Fern_2", Vector((1.9, -0.3, 0)), SEED + 21, coll, mats, size=1.2)
    build_fern("CF_Fern_3", on_surface(rock, rbvh, -0.6, -0.3), SEED + 22, coll, mats, size=0.8)
    build_fern("CF_Fern_4", Vector((-3.8, -0.4, 0)), SEED + 23, coll, mats, size=1.1)
    build_mushrooms("CF_Mushrooms_1", on_surface(rock, rbvh, -0.1, -0.75), SEED + 30, coll, mats)
    build_mushrooms("CF_Mushrooms_2", Vector((-1.9, -0.9, 0)), SEED + 31, coll, mats)
    build_creepers("CF_Creepers_Main", rock.location.copy(), rfaces, SEED + 40, coll, mats, CREEPER_CLUSTERS)
    build_creepers("CF_Creepers_Left", rock2.location.copy(), r2faces, SEED + 41, coll, mats, CREEPER_CLUSTERS // 2)

    # hang vines from the actual underside of the ceiling rock
    anchors = []
    for _ in range(IVY_CLUMPS):
        cx, cy = rng.uniform(-4.5, 4.5), rng.uniform(-1.6, -0.4)
        for _ in range(rng.randint(1, 4)):
            x, y = cx + rng.gauss(0, 0.12), cy + rng.gauss(0, 0.08)
            hit = cbvh.ray_cast(Vector((x, y, -10)), Vector((0, 0, 1)))[0]
            if hit is not None:
                anchors.append(hit + Vector((0, 0, 0.02)))
    build_ivy_curtain("CF_Ivy_Curtain", ceil.location.copy(), anchors, SEED + 50, coll, mats)

    if BUILD_DEMO_SCENE:
        setup_scene(coll)
    print(f"Cave foliage built: {len(coll.objects)} objects in '{COLL_NAME}'")


# ================================================================ game export
def _export_glb(path, objs):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
              export_yup=True, export_normals=True, export_texcoords=False,
              export_attributes=True, export_vertex_color='MATERIAL', export_colors=True,
              export_materials='EXPORT', export_cameras=False, export_lights=False)
    while True:  # drop options this Blender version doesn't know
        try:
            bpy.ops.export_scene.gltf(**kw)
            return
        except TypeError as e:
            bad = [k for k in kw if f'"{k}"' in str(e) or f"'{k}'" in str(e)]
            if not bad:
                raise
            for k in bad:
                kw.pop(k)


def export_assets():
    """Build game-ready variants (pivot at base, low poly, baked colours)
    laid out on a grid, then export them all into one GLB."""
    global DETAIL, GAME_MODE
    DETAIL, GAME_MODE = EXPORT_DETAIL, True
    _GAME_MATS.clear()
    try:
        coll = get_collection(COLL_NAME + "_Assets")
        mats = make_materials()
        O = Vector()
        rows = []
        for i in range(VARIANTS):
            L = chr(65 + i)
            rows.append([
                build_alocasia(f"Alocasia_{L}", O, SEED + 100 + i, coll, mats, size=1.0),
                build_birds_nest(f"BirdsNest_{L}", O, SEED + 110 + i, coll, mats),
                build_fern(f"Fern_{L}", O, SEED + 120 + i, coll, mats),
                build_mushrooms(f"Mushrooms_{L}", O, SEED + 130 + i, coll, mats),
            ])
            # creeper patch: fake a flat patch of ground for the scatterer
            prng = random.Random(SEED + 140 + i)
            pts = [(Vector((prng.uniform(-0.35, 0.35), prng.uniform(-0.35, 0.35), 0)), UP.copy(), 1.0)
                   for _ in range(12)]
            rows[-1].append(build_creepers(f"Creepers_{L}", O, pts, SEED + 150 + i, coll, mats, 8))
            rock, _, _ = build_rock(f"Rock_{L}", O, Vector((1.0, 0.8, 0.7)), SEED + 160 + i,
                                    coll, mats['rock'], subdiv=4)
            rows[-1].append(rock)
        vines = []
        for i, length in enumerate((0.8, 1.3, 1.8, 2.4)):
            mb = MeshBuilder()
            add_ivy_vine(mb, Vector(), length, Vector((0, -1, 0)), random.Random(SEED + 170 + i))
            vines.append(mb.build(f"IvyVine_{chr(65 + i)}", [mats['ivy'], mats['stem']], coll, O))
        rows.append(vines)

        objs = []
        for r, row in enumerate(rows):          # bake offsets, then lay out for preview
            for c, ob in enumerate(row):
                ob.data.transform(Matrix.Translation(ob.location))
                ob.location = (c * 2.2, r * 2.2, 0.0 if r < len(rows) - 1 else 2.6)
                objs.append(ob)

        path = EXPORT_PATH
        if path.startswith("//") and not bpy.data.filepath:
            import os
            path = os.path.join(os.path.expanduser("~"), path[2:])
        path = bpy.path.abspath(path)
        _export_glb(path, objs)
        tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
        print(f"Exported {len(objs)} assets ({tris} triangles total) -> {path}")
        for o in objs:
            print(f"  {o.name:14s} {sum(len(p.vertices) - 2 for p in o.data.polygons):6d} tris")
    finally:
        DETAIL, GAME_MODE = 1.0, False


if __name__ == "__main__":
    export_assets() if RUN == "export" else main()
