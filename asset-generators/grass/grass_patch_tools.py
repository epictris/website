"""Grass Patch tools: grow low-poly grass tufts on a surface, bake a game asset.

Same method as the mushroom patch: a Geometry Nodes group scatters points on the
faces of a mesh, every decision about a blade is made once per point and stored
on it, and the blades are built from those attributes. Bake freezes the result
into one static mesh sharing a single material (M_Grass) and one small texture.

Blades are flat, tapered ribbons (one quad per segment, a point at the tip)
curved on an arc that leans away from the middle of their tuft, shaded flat so
every segment catches the light on its own. Texture layout: U runs base -> tip,
V is one random row per blade (its own tone and hue).

Run from Blender's Scripting tab, or through editor_patch.py.
"""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix

GROUP = "GrassPatch"
MATERIAL = "M_Grass"
ALBEDO = "T_Grass_Albedo"
UV = "UVMap"
TEX_W, TEX_H = 128, 64
ROUGHNESS = 0.78
MAX_TOTAL_BEND = 1.5     # radians from vertical the tip may reach (~86 degrees)


# ==========================================================================
# Node-building helpers. Sockets in 5.x retype when a node's data_type
# changes, so always configure the node first and look sockets up by name.
# ==========================================================================
class Builder:
    def __init__(self, tree):
        self.nodes = tree.nodes
        self.links = tree.links

    def new(self, kind, **props):
        n = self.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    @staticmethod
    def sock(sockets, key):
        if isinstance(key, int):
            return sockets[key]
        found = [s for s in sockets if s.name == key]
        live = [s for s in found if s.enabled]
        return (live or found)[0]

    def feed(self, target, value):
        if isinstance(value, bpy.types.NodeSocket):
            self.links.new(value, target)
        elif value is not None:
            target.default_value = value

    def node(self, kind, inputs=None, out=0, **props):
        n = self.new(kind, **props)
        for k, v in (inputs or {}).items():
            self.feed(self.sock(n.inputs, k), v)
        return self.sock(n.outputs, out) if out is not None else n

    def m(self, op, a, b=None, c=None):
        n = self.new("ShaderNodeMath", operation=op)
        for i, v in enumerate((a, b, c)):
            self.feed(n.inputs[i], v)
        return n.outputs[0]

    def lerp(self, a, b, f):
        return self.m("MULTIPLY_ADD", f, self.m("SUBTRACT", b, a), a)

    def v(self, op, a, b=None, scale=None):
        n = self.new("ShaderNodeVectorMath", operation=op)
        self.feed(n.inputs[0], a)
        self.feed(n.inputs[1], b)
        if scale is not None:
            self.feed(self.sock(n.inputs, "Scale"), scale)
        return n.outputs["Value" if op in ("LENGTH", "DOT_PRODUCT") else "Vector"]

    def xyz(self, x=0.0, y=0.0, z=0.0):
        return self.node("ShaderNodeCombineXYZ", {"X": x, "Y": y, "Z": z})

    def sep(self, vec):
        n = self.node("ShaderNodeSeparateXYZ", {"Vector": vec}, out=None)
        return n.outputs["X"], n.outputs["Y"], n.outputs["Z"]


# ==========================================================================
# Geometry Nodes: faces -> grass
# ==========================================================================
def build_group():
    old = bpy.data.node_groups.get(GROUP)
    if old:
        bpy.data.node_groups.remove(old)
    ng = bpy.data.node_groups.new(GROUP, "GeometryNodeTree")
    ng.is_modifier = True
    b = Builder(ng)
    I = ng.interface

    def param(name, stype, default, lo=None, hi=None, sub=None, tip=""):
        s = I.new_socket(name, in_out="INPUT", socket_type=stype)
        s.default_value = default
        if lo is not None:
            s.min_value = lo
        if hi is not None:
            s.max_value = hi
        if sub:
            s.subtype = sub
        s.description = tip
        return s

    I.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    I.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    param("Density", "NodeSocketFloat", 1100.0, 0.0, 30000.0,
          tip="Blades per square metre inside the middle of a tuft")
    param("Seed", "NodeSocketInt", 0, tip="Re-rolls tuft placement, sizes and angles")
    param("Clumping", "NodeSocketFloat", 0.7, 0.0, 1.0, "FACTOR",
          "0 = an even lawn, 1 = separate tufts with bare ground between them")
    param("Tuft Size", "NodeSocketFloat", 0.35, 0.02, 5.0, "DISTANCE",
          "Rough spacing between the middles of neighbouring tufts")
    param("Height", "NodeSocketFloat", 0.3, 0.005, 10.0, "DISTANCE",
          "Length of a typical blade in the middle of a tuft")
    param("Width", "NodeSocketFloat", 1.0, 0.2, 3.0, tip="Blade width multiplier")
    param("Lean", "NodeSocketFloat", 0.85, 0.0, 1.4, "ANGLE",
          "How far the outer blades of a tuft lean away from its middle")
    param("Bend", "NodeSocketFloat", 1.05, 0.0, 1.5, "ANGLE",
          "How much a blade curves over toward its tip")
    param("Twist", "NodeSocketFloat", 0.9, 0.0, 3.0, "ANGLE",
          "How far a blade twists about its own length")
    param("Detail", "NodeSocketFloat", 0.25, 0.0, 1.0, "FACTOR",
          "Segments per blade: 0 = 3 (6 triangles), 1 = 7 (14 triangles)")
    param("Show Area", "NodeSocketBool", False, tip="Also output the source faces")
    I.new_socket("Material", in_out="INPUT", socket_type="NodeSocketMaterial")

    gi = b.new("NodeGroupInput")
    go = b.new("NodeGroupOutput")
    P = gi.outputs
    seed = P["Seed"]

    def rand(lo, hi, k):
        return b.node("FunctionNodeRandomValue",
                      {"Min": lo, "Max": hi, "Seed": b.m("ADD", seed, 101 * k)},
                      data_type="FLOAT")

    def store(geo, name, value, dtype="FLOAT", domain="POINT"):
        return b.node("GeometryNodeStoreNamedAttribute",
                      {"Geometry": geo, "Name": name, "Value": value},
                      data_type=dtype, domain=domain)

    def attr(name, dtype="FLOAT"):
        return b.node("GeometryNodeInputNamedAttribute", {"Name": name},
                      out="Attribute", data_type=dtype)

    def clamp01(x):
        return b.m("MINIMUM", b.m("MAXIMUM", x, 0.0), 1.0)

    # --- area: mesh faces, or closed curves filled into n-gons -------------
    filled = b.node("GeometryNodeFillCurve", {"Curve": P["Geometry"]})
    area = b.node("GeometryNodeJoinGeometry", out=None)
    b.links.new(filled, area.inputs[0])
    b.links.new(P["Geometry"], area.inputs[0])
    area = area.outputs[0]

    pos = b.node("GeometryNodeInputPosition")

    # --- tufts: a 2D Voronoi lattice over the ground plane -----------------
    # Each cell is one tuft. F1 gives, per point, the distance to its tuft's
    # middle (radius), the middle itself (so every blade knows which way is
    # outward) and a random colour we use as a per-tuft random number.
    size = P["Tuft Size"]
    lattice = b.v("ADD", b.v("DIVIDE", pos, b.xyz(size, size, size)),
                  b.xyz(b.m("MULTIPLY", seed, 17.13), b.m("MULTIPLY", seed, 9.71), 0.0))
    vor = b.node("ShaderNodeTexVoronoi",
                 {"Vector": lattice, "Scale": 1.0, "Randomness": 1.0},
                 out=None, voronoi_dimensions="2D", feature="F1")
    tuft_rand, _, _ = b.sep(vor.outputs["Color"])
    radius = b.node("ShaderNodeMapRange",
                    {"Value": vor.outputs["Distance"], "From Min": 0.0, "From Max": 0.7,
                     "To Min": 0.0, "To Max": 1.0}, data_type="FLOAT", clamp=True)
    # a tuft thins out toward its rim; a few tufts are skipped altogether
    rim = b.node("ShaderNodeMapRange",
                 {"Value": radius, "From Min": 0.45, "From Max": 0.95,
                  "To Min": 1.0, "To Max": 0.0},
                 data_type="FLOAT", interpolation_type="SMOOTHSTEP", clamp=True)
    present = b.node("ShaderNodeMapRange",
                     {"Value": tuft_rand, "From Min": 0.06, "From Max": 0.2,
                      "To Min": 0.0, "To Max": 1.0}, data_type="FLOAT", clamp=True)
    keep = b.lerp(1.0, b.m("MULTIPLY", rim, present), P["Clumping"])

    dist = b.new("GeometryNodeDistributePointsOnFaces", distribute_method="RANDOM")
    b.links.new(area, dist.inputs["Mesh"])
    for k, v in (("Density", P["Density"]), ("Seed", seed)):
        b.feed(b.sock(dist.inputs, k), v)
    pts = b.node("GeometryNodeDeleteGeometry",
                 {"Geometry": dist.outputs["Points"],
                  "Selection": b.m("GREATER_THAN", rand(0.0, 1.0, 30), keep)},
                 domain="POINT")

    # --- per-blade parameters, decided once and stored on the point --------
    # Middle blades are longest and stand straight; outer blades are shorter and
    # lean away from the middle. A few slender "hero" blades shoot up out of the
    # middle of a tuft.
    tuft_h = b.lerp(0.65, 1.15, tuft_rand)
    edge_h = b.m("SUBTRACT", 1.0, b.m("MULTIPLY", b.m("POWER", radius, 1.3), 0.5))
    hero = b.m("LESS_THAN", rand(0.0, 1.0, 2), b.m("MULTIPLY", b.m("SUBTRACT", 1.4, radius), 0.16))
    height = b.m("MULTIPLY", b.m("MULTIPLY", P["Height"], b.m("MULTIPLY", tuft_h, edge_h)),
                 rand(0.65, 1.1, 1))
    height = b.m("MULTIPLY", height, b.m("MULTIPLY_ADD", b.m("MULTIPLY", hero, rand(0.6, 1.0, 3)), 0.55, 1.0))
    calm = b.m("SUBTRACT", 1.0, b.m("MULTIPLY", hero, 0.5))     # hero blades stay upright

    lean = b.m("MULTIPLY", b.m("MULTIPLY", P["Lean"], b.m("POWER", radius, 0.85)),
               b.m("MULTIPLY", rand(0.55, 1.15, 4), calm))
    lean = b.m("ADD", lean, rand(0.0, 0.08, 5))
    curl = b.m("MULTIPLY", b.m("MULTIPLY", P["Bend"], rand(0.45, 1.2, 6)), calm)
    curl = b.m("MAXIMUM", b.m("MINIMUM", curl, b.m("SUBTRACT", MAX_TOTAL_BEND, lean)), 0.05)

    away_x, away_y, _ = b.sep(b.v("SUBTRACT", lattice, vor.outputs["Position"]))
    scatter = b.m("MULTIPLY_ADD", b.m("POWER", b.m("SUBTRACT", 1.0, radius), 2.0), 1.5, 0.35)
    azimuth = b.m("ADD", b.m("ARCTAN2", away_y, away_x),
                  b.m("MULTIPLY", rand(-1.0, 1.0, 7), scatter))

    half_width = b.m("MULTIPLY", b.m("MULTIPLY", height, rand(0.034, 0.066, 8)), P["Width"])
    twist = b.m("MULTIPLY", rand(-1.0, 1.0, 9), P["Twist"])

    for name, val, dt in (("g_o", pos, "FLOAT_VECTOR"), ("g_h", height, "FLOAT"),
                          ("g_a0", lean, "FLOAT"), ("g_a1", curl, "FLOAT"),
                          ("g_psi", azimuth, "FLOAT"), ("g_w", half_width, "FLOAT"),
                          ("g_tw", twist, "FLOAT"), ("g_row", rand(0.02, 0.98, 10), "FLOAT")):
        pts = store(pts, name, val, dt)

    # --- blades: one flat grid prototype, instanced at every point ---------
    # The grid is 2 wide (x = -1..1 across the blade) and 1 long (y = 0..1 up it);
    # its own coordinates ride along as g_s / g_t so every vertex can find its
    # place on the blade after the instances are realised.
    segments = b.m("ROUND", b.m("MULTIPLY_ADD", P["Detail"], 4.0, 3.0))
    grid = b.node("GeometryNodeMeshGrid",
                  {"Size X": 2.0, "Size Y": 1.0, "Vertices X": 2,
                   "Vertices Y": b.m("ADD", segments, 1.0)}, out=None)
    gx, gy, _ = b.sep(b.node("GeometryNodeInputPosition"))
    proto = store(grid.outputs["Mesh"], "g_t", b.m("ADD", gy, 0.5))
    proto = store(proto, "g_s", gx)
    blades = b.node("GeometryNodeInstanceOnPoints", {"Points": pts, "Instance": proto})
    blades = b.node("GeometryNodeRealizeInstances", {"Geometry": blades})

    t, s = attr("g_t"), attr("g_s")
    H, a0, a1 = attr("g_h"), attr("g_a0"), attr("g_a1")
    psi, w, tw = attr("g_psi"), attr("g_w"), attr("g_tw")
    # Heading, from vertical, is a0 + a1*t; integrating sin and cos of it gives
    # the arc's horizontal and vertical reach in closed form.
    heading = b.m("MULTIPLY_ADD", a1, t, a0)
    reach = b.m("MULTIPLY", H, b.m("DIVIDE", b.m("SUBTRACT", b.m("COSINE", a0), b.m("COSINE", heading)), a1))
    rise = b.m("MULTIPLY", H, b.m("DIVIDE", b.m("SUBTRACT", b.m("SINE", heading), b.m("SINE", a0)), a1))
    cos_p, sin_p = b.m("COSINE", psi), b.m("SINE", psi)
    sin_h = b.m("SINE", heading)
    centre = b.v("ADD", attr("g_o", "FLOAT_VECTOR"),
                 b.xyz(b.m("MULTIPLY", cos_p, reach), b.m("MULTIPLY", sin_p, reach),
                       b.m("SUBTRACT", rise, b.m("MULTIPLY", H, 0.03))))   # sunk in a little
    tangent = b.xyz(b.m("MULTIPLY", cos_p, sin_h), b.m("MULTIPLY", sin_p, sin_h), b.m("COSINE", heading))
    across = b.xyz(b.m("MULTIPLY", sin_p, -1.0), cos_p, 0.0)
    turn = b.m("MULTIPLY", tw, t)
    side = b.v("ADD", b.v("SCALE", across, scale=b.m("COSINE", turn)),
               b.v("SCALE", b.v("CROSS_PRODUCT", tangent, across), scale=b.m("SINE", turn)))
    # widest a little way up, then tapering to a point at the tip
    flare = b.m("MULTIPLY_ADD", b.m("SINE", b.m("MULTIPLY", b.m("MINIMUM", b.m("DIVIDE", t, 0.3), 1.0), math.pi / 2)),
                0.45, 0.55)
    thick = b.m("MULTIPLY", b.m("MULTIPLY", w, flare), b.m("POWER", b.m("MAXIMUM", b.m("SUBTRACT", 1.0, t), 0.0), 0.85))
    blades = b.node("GeometryNodeSetPosition",
                    {"Geometry": blades,
                     "Position": b.v("ADD", centre, b.v("SCALE", side, scale=b.m("MULTIPLY", s, thick)))})
    blades = b.node("GeometryNodeSetShadeSmooth", {"Mesh": blades, "Shade Smooth": False}, domain="FACE")
    blades = store(blades, UV,
                   b.xyz(b.m("MULTIPLY_ADD", attr("g_t"), 0.96, 0.02), attr("g_row"), 0.0),
                   "FLOAT2", "CORNER")
    for name in ("g_o", "g_h", "g_a0", "g_a1", "g_psi", "g_w", "g_tw", "g_row", "g_t", "g_s"):
        blades = b.node("GeometryNodeRemoveAttribute", {"Geometry": blades, "Name": name})
    blades = b.node("GeometryNodeSetMaterial", {"Geometry": blades, "Material": P["Material"]})

    shown_area = b.node("GeometryNodeSwitch", {"Switch": P["Show Area"], "True": area},
                        input_type="GEOMETRY")
    out = b.node("GeometryNodeJoinGeometry", out=None)
    b.links.new(blades, out.inputs[0])
    b.links.new(shown_area, out.inputs[0])
    b.links.new(out.outputs[0], go.inputs[0])

    ng.asset_mark()
    ng.asset_data.description = "Procedural low-poly grass tufts on a polygon or closed curve"
    return ng


# ==========================================================================
# Colour: a base -> tip gradient, one row of tone per blade, blended in OKLab
# ==========================================================================
# sRGB 0-255 stops along the blade: dark rooted green up to a bright lime tip.
STOPS = [(0.0, (26, 68, 13)), (0.2, (38, 106, 17)), (0.5, (66, 152, 28)),
         (0.82, (112, 192, 46)), (1.0, (156, 218, 70))]
# The game lights every level with a strong sun through ACES tone mapping, which
# pushes a bright green toward yellow; the albedo is kept in the darker range real
# foliage has (linear reflectance) so it stays green under that light.
ALBEDO_GAIN = 0.6
ROW_LIGHTNESS = 0.045      # +- OKLab lightness between rows
ROW_HUE = (-9.0, 13.0)     # degrees, growing toward the tip so bases stay green
ROW_CHROMA = (0.85, 1.12)

_M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
                [0.2119034982, 0.6806995451, 0.1073969566],
                [0.0883024619, 0.2817188376, 0.6299787005]])
_M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                [1.9779984951, -2.4285922050, 0.4505937099],
                [0.0259040371, 0.7827717662, -0.8086757660]])


def _s2l(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _l2s(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def _to_oklab(srgb):
    return np.cbrt(_s2l(np.asarray(srgb, float)) @ _M1.T) @ _M2.T


def _from_oklab(lab):
    return _l2s(((lab @ np.linalg.inv(_M2).T) ** 3) @ np.linalg.inv(_M1).T)


def texture_pixels():
    """HxWx3 float sRGB array: U base -> tip, each row V its own blade's tone."""
    u = (np.arange(TEX_W) + 0.5) / TEX_W
    pos = np.array([p for p, _ in STOPS])
    lab = np.array([_to_oklab(np.array(c) / 255.0) for _, c in STOPS])
    i = np.clip(np.searchsorted(pos, u, side="right") - 1, 0, len(pos) - 2)
    f = (u - pos[i]) / (pos[i + 1] - pos[i])
    f = f * f * (3 - 2 * f)
    ramp = lab[i] + (lab[i + 1] - lab[i]) * f[:, None]                      # (W, 3)

    rng = np.random.default_rng(7)
    rows = TEX_H
    d_light = rng.uniform(-1, 1, rows) * ROW_LIGHTNESS
    hue = np.radians(rng.uniform(*ROW_HUE, rows))
    chroma = rng.uniform(*ROW_CHROMA, rows)
    toward_tip = np.clip((u - 0.25) / 0.75, 0, 1) ** 1.5                    # (W,)
    h = hue[:, None] * toward_tip[None, :]                                  # (rows, W)
    a, bb = ramp[None, :, 1], ramp[None, :, 2]
    k = chroma[:, None]
    lab_rows = np.stack([ramp[None, :, 0] + d_light[:, None],
                         (a * np.cos(h) - bb * np.sin(h)) * k,
                         (a * np.sin(h) + bb * np.cos(h)) * k], axis=-1)     # (rows, W, 3)
    return _l2s(_s2l(np.clip(_from_oklab(lab_rows), 0.0, 1.0)) * ALBEDO_GAIN)


def build_texture():
    rgb = texture_pixels()
    img = bpy.data.images.get(ALBEDO)
    if img is None or tuple(img.size) != (TEX_W, TEX_H):
        if img:
            bpy.data.images.remove(img)
        img = bpy.data.images.new(ALBEDO, TEX_W, TEX_H, alpha=False)
    rgba = np.concatenate([rgb, np.ones(rgb.shape[:2] + (1,))], axis=2).astype(np.float32)
    img.pixels.foreach_set(rgba.ravel())
    img.update()
    img.pack()
    return img


def build_material():
    img = build_texture()
    mat = bpy.data.materials.get(MATERIAL) or bpy.data.materials.new(MATERIAL)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    mat.use_backface_culling = False          # a blade is one sheet: both sides show
    nt = mat.node_tree
    nt.nodes.clear()
    b = Builder(nt)
    uv = b.node("ShaderNodeUVMap", uv_map=UV)
    tex = b.node("ShaderNodeTexImage", {"Vector": uv}, image=img, extension="EXTEND")
    bsdf = b.new("ShaderNodeBsdfPrincipled")
    b.feed(bsdf.inputs["Base Color"], tex)
    b.feed(bsdf.inputs["Roughness"], ROUGHNESS)
    b.feed(bsdf.inputs["Metallic"], 0.0)
    outn = b.new("ShaderNodeOutputMaterial")
    nt.links.new(bsdf.outputs[0], outn.inputs["Surface"])
    return mat


def ensure_assets():
    ng = bpy.data.node_groups.get(GROUP) or build_group()
    mat = bpy.data.materials.get(MATERIAL) or build_material()
    return ng, mat


# ==========================================================================
# Patch workflow
# ==========================================================================
def set_input(mod, name, value):
    ident = mod.node_group.interface.items_tree[name].identifier
    props = getattr(mod, "properties", None)          # 5.x typed modifier inputs
    if props is not None:
        cur = getattr(props.inputs, ident)
        if hasattr(cur, "value"):
            cur.value = value
        else:
            setattr(props.inputs, ident, value)
    else:                                              # 4.x ID-property inputs
        mod[ident] = value


def patch_modifier(obj):
    for mod in obj.modifiers:
        if mod.type == "NODES" and mod.node_group and mod.node_group.name.startswith(GROUP):
            return mod
    return None


def make_patch(obj):
    ng, mat = ensure_assets()
    mod = patch_modifier(obj)
    if mod is None:
        mod = obj.modifiers.new(GROUP, "NODES")
        mod.node_group = ng
    set_input(mod, "Material", mat)
    return mod


def bake_patch(obj, context):
    """Freeze a patch into a static mesh named SM_GrassPatch, pivot at the origin."""
    mod = patch_modifier(obj)
    if mod is None:
        raise ValueError(f"{obj.name} has no {GROUP} modifier")
    set_input(mod, "Show Area", False)
    obj.update_tag()
    dg = context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg),
                                         preserve_all_data_layers=True, depsgraph=dg)
    loc, rot, scale = obj.matrix_world.decompose()
    me.transform(rot.to_matrix().to_4x4() @ Matrix.Diagonal(scale).to_4x4())
    if UV in me.uv_layers:
        me.uv_layers.active = me.uv_layers[UV]
    for a in [a.name for a in me.attributes if a.name.startswith("g_") or a.name == "id"]:
        me.attributes.remove(me.attributes[a])
    me.name = "SM_GrassPatch"
    baked = bpy.data.objects.new("SM_GrassPatch", me)
    baked.location = loc
    context.scene.collection.objects.link(baked)
    return baked


def export_glb(baked, path, context):
    """One self-contained GLB with the gradient texture embedded."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for o in context.view_layer.objects:
        o.select_set(False)
    baked.location = (0, 0, 0)
    baked.select_set(True)
    context.view_layer.objects.active = baked
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True)
    return path


def add_area_from_soup(positions):
    """three.js (x, y up, z out) -> Blender (x, -z, y up); one face per triangle."""
    me = bpy.data.meshes.new("GrassArea")
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
    ob = bpy.data.objects.new("GrassArea", me)
    bpy.context.scene.collection.objects.link(ob)
    return ob
