"""Mushroom Patch tools: draw a polygon, grow glowing mushrooms, export a game asset.

Install: Edit > Preferences > Add-ons > (v) Install from Disk... > this file.
Then View3D sidebar (N) > "Mushrooms" tab:

  * Add Patch Area      - new editable polygon at the 3D cursor, already growing.
  * Make Patch          - turn the selected meshes / closed curves into patches.
  * Bake Game Asset     - freeze the selected patches into static meshes
                          (SM_MushroomPatch_<name>) and export FBX and/or GLB
                          plus the shared textures.

Everything the engine needs is plain data: one UV map, one material
(M_Mushroom) and three small textures (T_Mushroom_Albedo / _Emissive / _ORM)
shared by every patch, so any number of patches is a single material.
Texture layout (U): 0.0-0.5 stem base->top, 0.5-1.0 cap gills->rim->crown;
cap V is split into CAP_VARIANTS bands (one pale shade each), V runs around
the cap inside its band; stem V is a random per-mushroom row.
"""
bl_info = {
    "name": "Mushroom Patch",
    "author": "Karin",
    "version": (2, 0, 0),
    "blender": (4, 2, 0),
    "location": "View3D > Sidebar > Mushrooms",
    "description": "Procedural glowing mushroom patches on polygons, bakeable to game assets",
    "category": "Add Mesh",
}

import math
import os
import re

import bmesh
import bpy
import numpy as np
from mathutils import Matrix

GROUP = "MushroomPatch"
MATERIAL = "M_Mushroom"
ALBEDO = "T_Mushroom_Albedo"
EMISSIVE = "T_Mushroom_Emissive"
ORM = "T_Mushroom_ORM"          # R occlusion, G roughness, B metallic
UV = "UVMap"
TEX_W, TEX_H = 512, 1024      # tall: each of the 8 cap bands needs room for stripes
CAP_VARIANTS = 8        # pale shade variants, stacked as V bands in the cap half
GLOW = 2.0              # emission strength; exported as KHR_materials_emissive_strength


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
# Geometry Nodes: polygon -> mushrooms
# ==========================================================================
def resolve_overlaps(b, pts, store, attr, enabled, gap):
    """Greedy, size-ordered culling: points are sorted largest cap first, then a
    repeat zone visits them in that order and every smaller survivor that would
    intersect the visited one is removed. Exact pairwise (no neighbour limit),
    so nothing is missed; cost grows with the square of the mushroom count.

    Shapes are the analytic ones the builders use: stem centreline
    o + L*h*(t - c*t^2/2) + (0,0,h*t), and each cap as an upright cylinder
    around its tip (radius R + lumps, height from gills to crown incl. point).
    A small mushroom fully under a big cap is allowed - that looks natural."""
    pts = store(pts, "m_alive", 1.0)
    pts = b.node("GeometryNodeSortElements",
                 {"Geometry": pts, "Sort Weight": b.m("MULTIPLY", attr("m_R"), -1.0)}, domain="POINT")
    count = b.node("GeometryNodeAttributeDomainSize", {"Geometry": pts},
                   out="Point Count", component="POINTCLOUD")

    rin = b.new("GeometryNodeRepeatInput")
    rout = b.new("GeometryNodeRepeatOutput")
    rin.pair_with_output(rout)
    b.links.new(pts, rin.inputs["Geometry"])
    b.links.new(b.m("MULTIPLY", count, enabled), rin.inputs["Iterations"])
    geo, j = rin.outputs["Geometry"], rin.outputs["Iteration"]

    def mushroom(get):
        m = {k: get(k, "FLOAT") for k in ("m_h", "m_c", "m_rs", "m_R", "m_ch", "m_pt", "m_alive")}
        m.update({k: get(k, "FLOAT_VECTOR") for k in ("m_o", "m_L", "m_tip")})
        _, _, tz = b.sep(m["m_tip"])
        # cap cylinder: gills sit 0.2*ch below the tip, crown at ch*(1+pointy) above
        m["cz"] = b.m("ADD", tz, b.m("MULTIPLY", m["m_ch"], b.m("MULTIPLY_ADD", m["m_pt"], 0.5, 0.4)))
        m["hz"] = b.m("MULTIPLY", m["m_ch"], b.m("MULTIPLY_ADD", m["m_pt"], 0.5, 0.6))
        m["rc"] = b.m("MULTIPLY", m["m_R"], 1.07)            # + lump displacement
        m["oz"] = b.sep(m["m_o"])[2]
        return m

    def this(name, dt):
        return attr(name, dt)

    def other(name, dt):
        return b.node("GeometryNodeSampleIndex",
                      {"Geometry": geo, "Value": attr(name, dt), "Index": j},
                      data_type=dt, domain="POINT")

    A, B = mushroom(this), mushroom(other)

    def dxy(p, q):
        return b.v("LENGTH", b.v("MULTIPLY", b.v("SUBTRACT", p, q), (1.0, 1.0, 0.0)))

    def stem_at(m, t):
        arc = b.m("SUBTRACT", t, b.m("MULTIPLY", b.m("MULTIPLY", m["m_c"], 0.5), b.m("MULTIPLY", t, t)))
        return b.v("ADD", m["m_o"], b.v("SCALE", m["m_L"], scale=b.m("MULTIPLY", m["m_h"], arc)))

    def lt(x, y):
        return b.m("LESS_THAN", x, y)

    def both(*xs):
        out = xs[0]
        for x in xs[1:]:
            out = b.m("MULTIPLY", out, x)
        return out

    def either(*xs):
        out = xs[0]
        for x in xs[1:]:
            out = b.m("MAXIMUM", out, x)
        return out

    # cap vs cap: footprints overlap AND height ranges overlap
    cap_cap = both(lt(dxy(A["m_tip"], B["m_tip"]), b.m("ADD", b.m("ADD", A["rc"], B["rc"]), gap)),
                   lt(b.m("ABSOLUTE", b.m("SUBTRACT", A["cz"], B["cz"])),
                      b.m("ADD", b.m("ADD", A["hz"], B["hz"]), gap)))

    # stem of S vs cap of C: stem position at the cap's height, near its tip
    def stem_cap(S, C):
        t = b.m("MINIMUM", b.m("MAXIMUM", b.m("DIVIDE", b.m("SUBTRACT", C["cz"], S["oz"]), S["m_h"]), 0.0), 1.0)
        top = b.m("ADD", S["oz"], S["m_h"])
        vertical = both(lt(b.m("SUBTRACT", C["cz"], C["hz"]), top),
                        lt(S["oz"], b.m("ADD", C["cz"], C["hz"])))
        reach = b.m("ADD", b.m("ADD", C["rc"], b.m("MULTIPLY", S["m_rs"], 1.2)), gap)
        return both(vertical, lt(dxy(stem_at(S, t), C["m_tip"]), reach))

    # stem vs stem at three shared heights (bases are already Poisson-spaced)
    low = b.m("MINIMUM", A["m_h"], B["m_h"])
    stem_stem = []
    for k in (0.35, 0.7, 1.0):
        z = b.m("MULTIPLY", low, k)
        d = dxy(stem_at(A, b.m("DIVIDE", z, A["m_h"])), stem_at(B, b.m("DIVIDE", z, B["m_h"])))
        stem_stem.append(lt(d, b.m("ADD", b.m("ADD", A["m_rs"], B["m_rs"]), gap)))

    hit = either(cap_cap, stem_cap(A, B), stem_cap(B, A), *stem_stem)
    index = b.node("GeometryNodeInputIndex")
    kill = both(B["m_alive"], b.m("GREATER_THAN", index, j), hit)   # only smaller ones die
    geo = store(geo, "m_alive", b.m("MULTIPLY", A["m_alive"], b.m("SUBTRACT", 1.0, kill)))
    b.links.new(geo, rout.inputs["Geometry"])

    return b.node("GeometryNodeDeleteGeometry",
                  {"Geometry": rout.outputs["Geometry"], "Selection": lt(attr("m_alive"), 0.5)},
                  domain="POINT")


def build_group(look=None):
    look = resolve_look(look)
    # The cap bands in use and the texture height they are squeezed into (px).
    variants = int(look["capVariants"])
    tex_h = 2 * int(look["textureSize"])
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
    param("Density", "NodeSocketFloat", 150.0, 0.0, 5000.0,
          tip="Mushrooms per square metre inside the densest clumps")
    param("Seed", "NodeSocketInt", 0, tip="Re-rolls placement, sizes and angles")
    param("Spacing", "NodeSocketFloat", 0.02, 0.0, 1.0, "DISTANCE",
          "Minimum distance between stems")
    param("No Overlaps", "NodeSocketBool", True,
          tip="Remove mushrooms whose cap or stem would cut into a larger one")
    param("Gap", "NodeSocketFloat", 0.003, 0.0, 1.0, "DISTANCE",
          "Minimum clearance kept between neighbouring mushrooms")
    param("Clumping", "NodeSocketFloat", 0.75, 0.0, 1.0, "FACTOR",
          "0 = even carpet, 1 = tight separate clusters")
    param("Clump Size", "NodeSocketFloat", 0.2, 0.01, 10.0, "DISTANCE",
          "Rough diameter of one cluster")
    param("Height", "NodeSocketFloat", 0.16, 0.001, 10.0, "DISTANCE",
          "Stem height of the largest mushroom")
    param("Size Min", "NodeSocketFloat", 0.3, 0.01, 1.0, "FACTOR")
    param("Size Max", "NodeSocketFloat", 1.0, 0.01, 1.0, "FACTOR")
    param("Max Tilt", "NodeSocketFloat", math.radians(15), 0.0, math.radians(80), "ANGLE",
          "Largest lean of a stem away from vertical")
    param("Bend", "NodeSocketFloat", 0.7, 0.0, 1.0, "FACTOR",
          "How much leaning stems curve back upright toward the cap")
    param("Cap Size", "NodeSocketFloat", 1.0, 0.1, 3.0, tip="Cap width multiplier")
    param("Detail", "NodeSocketFloat", 0.5, 0.0, 1.0, "FACTOR",
          "Polygon budget: 0 ~ 90 tris per mushroom, 0.5 ~ 520, 1 ~ 1300")
    param("Show Area", "NodeSocketBool", False, tip="Also output the source polygon")
    I.new_socket("Material", in_out="INPUT", socket_type="NodeSocketMaterial")

    gi = b.new("NodeGroupInput")
    go = b.new("NodeGroupOutput")
    P = gi.outputs

    def ires(base, span):                       # Detail -> integer resolution
        return b.m("ROUND", b.m("MULTIPLY_ADD", P["Detail"], span, base))

    # --- area: mesh faces, or closed curves filled into n-gons -------------
    filled = b.node("GeometryNodeFillCurve", {"Curve": P["Geometry"]})
    area = b.node("GeometryNodeJoinGeometry", out=None)
    b.links.new(filled, area.inputs[0])
    b.links.new(P["Geometry"], area.inputs[0])
    area = area.outputs[0]

    pos = b.node("GeometryNodeInputPosition")
    seed = P["Seed"]

    def rand(lo, hi, k):
        return b.node("FunctionNodeRandomValue",
                      {"Min": lo, "Max": hi, "Seed": b.m("ADD", seed, 101 * k)},
                      data_type="FLOAT")

    # --- clump mask: low-frequency noise, sharpened by Clumping ------------
    noise_co = b.v("DIVIDE", pos, b.xyz(P["Clump Size"], P["Clump Size"], P["Clump Size"]))
    cn = b.node("ShaderNodeTexNoise",
                {"Vector": noise_co, "W": b.m("MULTIPLY", seed, 7.31),
                 "Scale": 1.0, "Detail": 1.0, "Roughness": 0.4},
                noise_dimensions="4D")
    hard = b.node("ShaderNodeMapRange",
                  {"Value": cn, "From Min": 0.42, "From Max": 0.62,
                   "To Min": 0.0, "To Max": 1.0},
                  data_type="FLOAT", clamp=True)
    hard = b.m("MULTIPLY", hard, hard)
    mask = b.lerp(1.0, hard, P["Clumping"])

    dist = b.new("GeometryNodeDistributePointsOnFaces", distribute_method="POISSON")
    b.links.new(area, dist.inputs["Mesh"])
    for k, v in (("Distance Min", P["Spacing"]), ("Density Max", P["Density"]),
                 ("Density Factor", mask), ("Seed", seed)):
        b.feed(b.sock(dist.inputs, k), v)
    pts = dist.outputs["Points"]

    # --- per-mushroom parameters (evaluated on the scattered points) -------
    # size: biased toward small, and smaller at the thin edges of clumps
    size = b.lerp(P["Size Min"], P["Size Max"], b.m("POWER", rand(0, 1, 1), 1.7))
    size = b.m("MULTIPLY", size, b.lerp(1.0, b.m("MULTIPLY_ADD", mask, 0.55, 0.45), P["Clumping"]))
    small = b.m("SUBTRACT", 1.0, size)                       # 0 big .. ~0.7 tiny
    h = b.m("MULTIPLY", b.m("MULTIPLY", P["Height"], size), rand(0.8, 1.2, 2))

    ang = rand(0, 2 * math.pi, 3)
    lean = b.m("TANGENT", b.m("MULTIPLY", P["Max Tilt"], b.m("POWER", rand(0, 1, 4), 2.0)))
    L = b.xyz(b.m("MULTIPLY", b.m("COSINE", ang), lean), b.m("MULTIPLY", b.m("SINE", ang), lean), 0.0)
    bend = b.m("MULTIPLY", P["Bend"], rand(0.4, 1.0, 5))

    stem_r = b.m("MULTIPLY", h, b.m("MULTIPLY_ADD", small, 0.035, rand(0.042, 0.055, 6)))
    cap_r = b.m("MULTIPLY", b.m("MULTIPLY", h, b.m("MULTIPLY_ADD", small, 0.2, 0.25)),
                b.m("MULTIPLY", rand(0.85, 1.15, 7), P["Cap Size"]))
    cap_h = b.m("MULTIPLY", cap_r, rand(0.55, 0.9, 8))
    # cap sits on the stem tip, facing along the tip tangent (see stems below)
    tip = b.v("ADD", b.v("ADD", pos, b.v("SCALE", L, scale=b.m("MULTIPLY", h, b.m("SUBTRACT", 1.0, b.m("MULTIPLY", bend, 0.5))))),
              b.xyz(0, 0, b.m("MULTIPLY", h, 0.96)))
    jitter = b.xyz(rand(-0.05, 0.05, 10), rand(-0.05, 0.05, 11), 0.0)
    tangent = b.v("ADD", b.v("ADD", b.v("SCALE", L, scale=b.m("SUBTRACT", 1.0, bend)), b.xyz(0, 0, 1)), jitter)
    # about half the caps get a raised crown, of varying sharpness
    pointy = b.m("MAXIMUM", rand(-0.4, 0.45, 14), 0.0)

    def store(geo, name, value, dtype="FLOAT", domain="POINT"):
        return b.node("GeometryNodeStoreNamedAttribute",
                      {"Geometry": geo, "Name": name, "Value": value},
                      data_type=dtype, domain=domain)

    # Everything that shapes a mushroom is decided here, once, and stored on its
    # point: the overlap pass and the mesh builders below all read these values.
    temp_attrs = ("m_h", "m_L", "m_c", "m_rs", "m_R", "m_o", "m_t", "m_sv",
                  "m_pk", "m_ax", "m_ch", "m_pt", "m_band", "m_tip", "m_alive")
    for name, val, dt in (("m_h", h, "FLOAT"), ("m_L", L, "FLOAT_VECTOR"),
                          ("m_sv", rand(0.02, 0.98, 12), "FLOAT"),
                          ("m_c", bend, "FLOAT"), ("m_rs", stem_r, "FLOAT"),
                          ("m_R", cap_r, "FLOAT"), ("m_o", pos, "FLOAT_VECTOR"),
                          ("m_tip", tip, "FLOAT_VECTOR"),
                          ("m_ax", b.v("NORMALIZE", tangent), "FLOAT_VECTOR"),
                          ("m_ch", cap_h, "FLOAT"), ("m_pt", pointy, "FLOAT"),
                          ("m_band", b.m("FLOOR", rand(0, variants - 0.001, 13)), "FLOAT")):
        pts = store(pts, name, val, dt)

    def attr(name, dtype="FLOAT"):
        return b.node("GeometryNodeInputNamedAttribute", {"Name": name},
                      out="Attribute", data_type=dtype)

    pts = resolve_overlaps(b, pts, store, attr, P["No Overlaps"], P["Gap"])

    # --- stems: a curve per point, bent analytically, swept into a tube ----
    # centreline(t) = o + L*h*(t - c*t^2/2) + (0, 0, h*t - sink)
    # so the tip tangent is (L*(1-c), 1): leaning stems curve back upright.
    line = b.node("GeometryNodeCurvePrimitiveLine",
                  {"Start": (0, 0, 0), "End": (0, 0, 1)})
    line = b.node("GeometryNodeResampleCurve", {"Curve": line, "Count": ires(5, 9)})
    stems = b.node("GeometryNodeInstanceOnPoints", {"Points": pts, "Instance": line})
    stems = b.node("GeometryNodeRealizeInstances", {"Geometry": stems})

    t = b.node("GeometryNodeSplineParameter", out="Factor")
    sh, sL, sc, so = attr("m_h"), attr("m_L", "FLOAT_VECTOR"), attr("m_c"), attr("m_o", "FLOAT_VECTOR")
    arc = b.m("SUBTRACT", t, b.m("MULTIPLY", b.m("MULTIPLY", sc, 0.5), b.m("MULTIPLY", t, t)))
    xy = b.v("SCALE", sL, scale=b.m("MULTIPLY", sh, arc))
    z = b.xyz(0, 0, b.m("MULTIPLY", sh, b.m("SUBTRACT", t, 0.04)))
    # organic wobble, zero at both ends so the base stays put and the cap fits
    wn = b.node("ShaderNodeTexNoise",
                {"Vector": b.v("ADD", b.v("SCALE", so, scale=23.0), b.xyz(0, 0, t)),
                 "Scale": 1.3, "Detail": 0.0}, out="Color", noise_dimensions="3D")
    wamp = b.m("MULTIPLY", b.m("MULTIPLY", sh, 0.35), b.m("MULTIPLY", t, b.m("SUBTRACT", 1.0, t)))
    wob = b.v("MULTIPLY", b.v("SUBTRACT", wn, (0.5, 0.5, 0.5)), b.xyz(wamp, wamp, 0.0))
    stems = b.node("GeometryNodeSetPosition",
                   {"Geometry": stems, "Position": b.v("ADD", b.v("ADD", so, xy), b.v("ADD", z, wob))})
    # tube radius: flared foot, slight taper toward the cap
    foot = b.m("POWER", b.m("SUBTRACT", 1.0, t), 5.0)
    rad = b.m("MULTIPLY", attr("m_rs"),
              b.m("MULTIPLY", b.m("MULTIPLY_ADD", foot, 0.7, 1.0), b.m("MULTIPLY_ADD", t, -0.2, 1.0)))
    stems = store(stems, "m_t", t)
    prof = b.node("GeometryNodeCurvePrimitiveCircle", {"Resolution": ires(5, 7), "Radius": 1.0})
    stems = b.node("GeometryNodeCurveToMesh",
                   {"Curve": stems, "Profile Curve": prof, "Scale": rad, "Fill Caps": True})
    # stem UVs: U 0.01..0.49 base->top; V is one random texture row per mushroom
    # (constant around the stem, so no seam), which varies its dirt line and tone
    stems = store(stems, UV, b.xyz(b.m("MULTIPLY_ADD", attr("m_t"), 0.48, 0.01), attr("m_sv"), 0.0),
                  "FLOAT2", "CORNER")

    # --- caps: one squashed-sphere prototype, instanced at each stem tip ---
    sphere = b.node("GeometryNodeMeshUVSphere",
                    {"Segments": ires(8, 24), "Rings": ires(4, 12), "Radius": 1.0}, out=None)
    px, py, pz = b.sep(pos)
    su, _, _ = b.sep(sphere.outputs["UV Map"])
    # cap UVs: U 0.51..0.99 gill centre -> rim -> crown, V around the cap (seam-safe)
    proto = store(sphere.outputs["Mesh"], UV,
                  b.xyz(b.m("MULTIPLY_ADD", b.m("ADD", pz, 1.0), 0.24, 0.51), su, 0.0),
                  "FLOAT2", "CORNER")
    # peak weight for pointy caps: 1 at the crown, 0 at the rim and underneath
    ring_r = b.v("LENGTH", b.xyz(px, py, 0.0))
    peak = b.m("MULTIPLY", b.m("POWER", b.m("SUBTRACT", 1.0, b.m("MINIMUM", ring_r, 1.0)), 1.4),
               b.m("GREATER_THAN", pz, 0.0))
    proto = store(proto, "m_pk", peak)
    # flatten the underside into a shallow gill plate; the dome stays round
    flat_z = b.m("ADD", b.m("MAXIMUM", pz, 0.0), b.m("MULTIPLY", b.m("MINIMUM", pz, 0.0), 0.2))
    proto = b.node("GeometryNodeSetPosition", {"Geometry": proto, "Position": b.xyz(px, py, flat_z)})

    rot = b.node("FunctionNodeAlignRotationToVector",
                 {"Vector": attr("m_ax", "FLOAT_VECTOR")}, axis="Z")
    cap_pts = b.node("GeometryNodeSetPosition",
                     {"Geometry": pts, "Position": attr("m_tip", "FLOAT_VECTOR")})
    caps = b.node("GeometryNodeInstanceOnPoints",
                  {"Points": cap_pts, "Instance": proto, "Rotation": rot,
                   "Scale": b.xyz(attr("m_R"), attr("m_R"), attr("m_ch"))})
    caps = b.node("GeometryNodeRealizeInstances", {"Geometry": caps})
    # raise the crown along each cap's own axis
    caps = b.node("GeometryNodeSetPosition",
                  {"Geometry": caps,
                   "Offset": b.v("SCALE", attr("m_ax", "FLOAT_VECTOR"),
                                 scale=b.m("MULTIPLY", b.m("MULTIPLY", attr("m_ch"), attr("m_pt")), attr("m_pk")))})
    # colour variant: squeeze the cap's V into its own horizontal band of the
    # texture (with a pixel of margin so bands don't bleed into each other)
    margin = 1.5 / (tex_h / variants)
    cu, cv, _ = b.sep(b.node("GeometryNodeInputNamedAttribute", {"Name": UV},
                             out="Attribute", data_type="FLOAT_VECTOR"))
    band_v = b.m("DIVIDE", b.m("ADD", attr("m_band"), b.m("MULTIPLY_ADD", cv, 1.0 - 2 * margin, margin)),
                 float(variants))
    caps = store(caps, UV, b.xyz(cu, band_v, 0.0), "FLOAT2", "CORNER")
    # hand-sculpted lumpiness, proportional to each cap's own size
    lump = b.node("ShaderNodeTexNoise", {"Vector": pos, "Scale": 90.0, "Detail": 2.0})
    nrm = b.node("GeometryNodeInputNormal")
    caps = b.node("GeometryNodeSetPosition",
                  {"Geometry": caps,
                   "Offset": b.v("SCALE", nrm, scale=b.m("MULTIPLY", b.m("SUBTRACT", lump, 0.5), b.m("MULTIPLY", attr("m_R"), 0.12)))})

    shrooms = b.node("GeometryNodeJoinGeometry", out=None)
    b.links.new(caps, shrooms.inputs[0])
    b.links.new(stems, shrooms.inputs[0])
    shrooms = b.node("GeometryNodeSetShadeSmooth", {"Mesh": shrooms.outputs[0]})
    for name in temp_attrs:                    # keep the exported mesh clean
        shrooms = b.node("GeometryNodeRemoveAttribute", {"Geometry": shrooms, "Name": name})
    shrooms = b.node("GeometryNodeSetMaterial", {"Geometry": shrooms, "Material": P["Material"]})

    shown_area = b.node("GeometryNodeSwitch", {"Switch": P["Show Area"], "True": area},
                        input_type="GEOMETRY")
    out = b.node("GeometryNodeJoinGeometry", out=None)
    b.links.new(shrooms, out.inputs[0])
    b.links.new(shown_area, out.inputs[0])
    b.links.new(out.outputs[0], go.inputs[0])

    ng.asset_mark()
    ng.asset_data.description = "Procedural glowing mushroom patch on a polygon or closed curve"
    return ng


# ==========================================================================
# Colour: gradient textures, blended in OKLab so blue->purple stays clean
# ==========================================================================
# sRGB 0-255 stops at full saturation; `paleness` lifts them toward white.
# Stem: natural, like a real mushroom - soil-stained foot, light beige, pale
# grey toward the cap. These are final colours: Paleness does not apply to them.
# Positions are on a remapped axis where 0.2 is always that stem's dirt line.
STEM_STOPS = [(0.0, (112, 92, 70)), (0.1, (142, 120, 94)), (0.2, (180, 163, 138)),
              (0.42, (206, 196, 180)), (0.75, (218, 215, 208)), (1.0, (226, 224, 219))]
# gills (0) -> rim (0.5) -> crown (1). The purple now fades in over the whole
# upper third through a periwinkle midpoint instead of a hard-edged cap.
CAP_STOPS = [(0.0, (255, 185, 75)), (0.45, (255, 190, 85)), (0.50, (70, 140, 210)),
             (0.62, (100, 180, 232)), (0.72, (110, 185, 236)), (0.84, (140, 165, 238)),
             (0.93, (175, 115, 230)), (1.0, (188, 90, 224))]
# One pale shade per cap band: (hue shift deg, lightness shift, chroma scale), in
# OKLab. Base, lavender, aqua, milky, lilac, deeper blue, soft periwinkle, mint.
CAP_SHADES = [(0, 0.0, 1.0), (14, 0.01, 1.0), (-12, 0.0, 1.0), (0, 0.03, 0.8),
              (26, 0.0, 0.9), (-6, -0.025, 1.05), (8, 0.02, 0.85), (-20, 0.01, 0.9)]
assert len(CAP_SHADES) == CAP_VARIANTS
# Radial stripe count per shade band (integers so they tile around the cap),
# and how much darker a stripe is at the rim, in OKLab lightness.
CAP_STRIPES = [10, 12, 9, 11, 12, 10, 11, 9]
STRIPE_DARKEN = 0.14
assert len(CAP_STRIPES) == CAP_VARIANTS
GLOW_RGB = (255, 200, 110)
# Roughness per region (0 = mirror). Glossy caps, satin stems, matte gills.
ROUGH_CAP, ROUGH_GILLS, ROUGH_STEM, ROUGH_DIRT = 0.15, 0.6, 0.55, 0.8

# The look's knobs under the level editor's schema names (params.json). The
# add-on installs as this one file, so its own defaults stay here; the editor's
# generator hands every knob in from the schema (editor_patch.py), and
# test_params.py fails when the two disagree. textureSize is the width (px);
# the maps are twice as tall. capVariants uses the first n shade/stripe rows.
LOOK = {"paleness": 0.5, "glow": GLOW, "capVariants": CAP_VARIANTS,
        "stripeDarken": STRIPE_DARKEN, "capRoughness": ROUGH_CAP,
        "gillRoughness": ROUGH_GILLS, "stemRoughness": ROUGH_STEM, "dirtRoughness": ROUGH_DIRT,
        "textureSize": TEX_W}


def resolve_look(look=None, paleness=None):
    """LOOK with a caller's overrides; a bare paleness is the add-on UI's slider."""
    resolved = dict(LOOK)
    resolved.update((k, v) for k, v in (look or {}).items() if k in LOOK)
    if paleness is not None:
        resolved["paleness"] = paleness
    if not 1 <= int(resolved["capVariants"]) <= CAP_VARIANTS:
        raise ValueError(f"capVariants must be 1..{CAP_VARIANTS}, one per shade row")
    return resolved


def _s2l(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _l2s(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


_M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
                [0.2119034982, 0.6806995451, 0.1073969566],
                [0.0883024619, 0.2817188376, 0.6299787005]])
_M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                [1.9779984951, -2.4285922050, 0.4505937099],
                [0.0259040371, 0.7827717662, -0.8086757660]])


def _to_oklab(srgb):
    lms = np.cbrt(_s2l(np.asarray(srgb, float)) @ _M1.T)
    return lms @ _M2.T


def _from_oklab(lab):
    lms = (lab @ np.linalg.inv(_M2).T) ** 3
    return _l2s(lms @ np.linalg.inv(_M1).T)


def _pale(rgb, paleness):
    c = np.asarray(rgb, float) / 255.0
    return c + (1.0 - c) * paleness


def _ramp_lab(stops, x, paleness):
    pos = np.array([p for p, _ in stops])
    lab = np.array([_to_oklab(_pale(c, paleness)) for _, c in stops])
    x = np.clip(x, pos[0], pos[-1])
    i = np.clip(np.searchsorted(pos, x, side="right") - 1, 0, len(pos) - 2)
    f = (x - pos[i]) / (pos[i + 1] - pos[i])
    f = f * f * (3 - 2 * f)                                  # smoothstep between stops
    return lab[i] + (lab[i + 1] - lab[i]) * f[..., None]


def _ramp(stops, x, paleness):
    return _from_oklab(_ramp_lab(stops, x, paleness))


def _shade(lab, hue_deg, d_light, chroma, amount):
    """Rotate hue / nudge lightness / scale chroma in OKLab, blended by `amount`.
    Chroma never rises much, so shifted caps stay as pale as the base palette."""
    a, b = lab[..., 1], lab[..., 2]
    h = np.radians(hue_deg) * amount
    k = 1.0 + (chroma - 1.0) * amount
    out = np.stack([lab[..., 0] + d_light * amount,
                    (a * np.cos(h) - b * np.sin(h)) * k,
                    (a * np.sin(h) + b * np.cos(h)) * k], axis=-1)
    return out


def _smooth(e0, e1, x):
    f = np.clip((x - e0) / (e1 - e0), 0, 1)
    return f * f * (3 - 2 * f)


def _wave_noise(u, v, n, freq_v, freq_u, seed):
    """Sum of sines, integer frequency in V so it tiles around the cap seam."""
    rng = np.random.default_rng(seed)
    out = np.zeros_like(u)
    for _ in range(n):
        kv = rng.integers(freq_v[0], freq_v[1])
        ku = rng.uniform(*freq_u)
        out += np.sin(2 * np.pi * (kv * v + ku * u) + rng.uniform(0, 2 * np.pi)) / kv
    return out / np.abs(out).max()


def texture_pixels(paleness=None, look=None):
    """Returns (albedo, emissive, orm) as HxWx3 float arrays; the first two sRGB,
    orm linear (R occlusion = 1, G roughness, B metallic = 0; glTF / Unreal packing)."""
    look = resolve_look(look, paleness)
    paleness = look["paleness"]
    variants = int(look["capVariants"])
    width = int(look["textureSize"])                          # px; twice as tall
    u = (np.arange(width) + 0.5) / width
    v = (np.arange(2 * width) + 0.5) / (2 * width)
    U, V = np.meshgrid(u, v)
    stem = U < 0.5
    t = np.clip((U - 0.01) / 0.48, 0, 1)                     # stem base -> top
    s = np.clip((U - 0.51) / 0.48, 0, 1)                     # cap gills -> crown

    # caps: V holds `variants` bands (one shade per band); vl runs 0..1 around
    # the cap inside each band, so noise with integer V frequency tiles per band
    band = np.minimum((V * variants).astype(int), variants - 1)
    vl = V * variants - band

    # soft, painterly irregularity only where blue meets purple, kept small so
    # the transition reads as a blend rather than blotches
    wobble = _wave_noise(s, vl, 10, (2, 9), (0.0, 3.0), 1) * 0.025 * _smooth(0.6, 0.8, s)
    grain = 1.0 + 0.035 * np.where(stem, _wave_noise(U * 4, V, 14, (6, 24), (4.0, 20.0), 2),
                                   _wave_noise(U * 4, vl, 14, (6, 24), (4.0, 20.0), 2))

    # stems: each row (= one mushroom) gets its own dirt-line height and tone;
    # remap t so that row's dirt line lands on 0.2 of the STEM_STOPS axis
    row = _wave_noise(np.zeros_like(V), V, 8, (1, 5), (0.0, 0.0), 3)       # -1..1 per row
    dirt = 0.16 + 0.08 * row + 0.03 * _wave_noise(t, V, 6, (3, 11), (2.0, 6.0), 4)
    ts = np.where(t < dirt, 0.2 * t / dirt, 0.2 + 0.8 * (t - dirt) / (1.0 - dirt))
    tone = 1.0 + 0.035 * _wave_noise(np.zeros_like(V), V, 8, (2, 9), (0.0, 0.0), 5)
    stem_alb = _ramp(STEM_STOPS, ts, 0.0) * tone[..., None]

    cap_lab = _ramp_lab(CAP_STOPS, s + wobble, paleness)
    upper = _smooth(0.47, 0.53, s)                 # shade the top only; gills stay amber
    for k, (hue, dl, chroma) in enumerate(CAP_SHADES[:variants]):
        in_band = band == k
        cap_lab[in_band] = _shade(cap_lab[in_band], hue, dl, chroma, upper[in_band])
    # radial stripes on top: darkest at the rim, fading toward the crown, each a
    # few shades darker (OKLab L) than that cap's own colour
    stripes = np.zeros_like(s)
    for k, n in enumerate(CAP_STRIPES[:variants]):
        m = band == k
        rng = np.random.default_rng(100 + k)
        length, width, strength = (rng.uniform(0.55, 1.0, n), rng.uniform(0.55, 0.85, n),
                                   rng.uniform(0.6, 1.0, n))
        x = vl[m] * n + 0.2 * _wave_noise(s, vl, 6, (1, 4), (0.5, 2.0), 7)[m]   # slight curve
        i = np.floor(x).astype(int) % n
        d = np.abs(x - np.floor(x) - 0.5) * 2.0          # 0 stripe centre .. 1 between stripes
        across = 1.0 - _smooth(width[i] * 0.25, width[i], d)
        along = (1.0 - _smooth(0.5, 0.5 + 0.5 * length[i], s[m])) * _smooth(0.49, 0.53, s[m])
        stripes[m] = across * along * strength[i]
    cap_lab[..., 0] -= look["stripeDarken"] * stripes
    cap_lab[..., 1:] *= (1.0 + 0.12 * stripes)[..., None]     # keep dark lines from greying
    alb = np.where(stem[..., None], stem_alb, _from_oklab(cap_lab))
    alb = np.clip(alb * grain[..., None], 0, 1)

    glow_mask = np.where(stem, 0.0, 1.0 - _smooth(0.42, 0.50, s))   # gills only
    glow = _l2s(_s2l(_pale(GLOW_RGB, paleness)) * glow_mask[..., None])

    rough_cap, rough_gills, rough_stem = look["capRoughness"], look["gillRoughness"], look["stemRoughness"]
    rough_dirt = look["dirtRoughness"]
    rough = np.where(stem, rough_stem + (rough_dirt - rough_stem) * (1.0 - _smooth(0.1, 0.3, ts)),
                     rough_gills + (rough_cap - rough_gills) * _smooth(0.47, 0.53, s))
    rough = np.clip(rough * (1.0 + 2.0 * (grain - 1.0)), 0.05, 1.0)   # +-7% breakup
    orm = np.stack([np.ones_like(rough), rough, np.zeros_like(rough)], axis=-1)
    return alb, glow, orm


def _write_image(name, rgb, non_color=False):
    height, width = rgb.shape[:2]
    img = bpy.data.images.get(name)
    if img is None or tuple(img.size) != (width, height):
        if img:
            bpy.data.images.remove(img)
        img = bpy.data.images.new(name, width, height, alpha=False)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    rgba = np.concatenate([rgb, np.ones(rgb.shape[:2] + (1,))], axis=2).astype(np.float32)
    img.pixels.foreach_set(rgba.ravel())
    img.update()
    img.pack()
    return img


def build_textures(paleness=None, look=None):
    alb, glow, orm = texture_pixels(paleness, look)
    return (_write_image(ALBEDO, alb), _write_image(EMISSIVE, glow),
            _write_image(ORM, orm, non_color=True))


def build_material(paleness=None, look=None):
    look = resolve_look(look, paleness)
    alb_img, glow_img, orm_img = build_textures(look=look)
    mat = bpy.data.materials.get(MATERIAL) or bpy.data.materials.new(MATERIAL)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    nt = mat.node_tree
    nt.nodes.clear()
    b = Builder(nt)
    uv = b.node("ShaderNodeUVMap", uv_map=UV)
    alb = b.node("ShaderNodeTexImage", {"Vector": uv}, image=alb_img, extension="EXTEND")
    glow = b.node("ShaderNodeTexImage", {"Vector": uv}, image=glow_img, extension="EXTEND")
    orm = b.node("ShaderNodeTexImage", {"Vector": uv}, image=orm_img, extension="EXTEND")
    # G -> roughness, B -> metallic: the layout the glTF exporter recognises
    rgb = b.node("ShaderNodeSeparateColor", {"Color": orm}, out=None)
    bsdf = b.new("ShaderNodeBsdfPrincipled")
    b.feed(bsdf.inputs["Base Color"], alb)
    b.feed(bsdf.inputs["Roughness"], rgb.outputs["Green"])
    b.feed(bsdf.inputs["Metallic"], rgb.outputs["Blue"])
    b.feed(bsdf.inputs["Emission Color"], glow)
    b.feed(bsdf.inputs["Emission Strength"], look["glow"])
    outn = b.new("ShaderNodeOutputMaterial")
    nt.links.new(bsdf.outputs[0], outn.inputs["Surface"])
    return mat


def ensure_assets(paleness=None, look=None):
    look = resolve_look(look, paleness)
    ng = bpy.data.node_groups.get(GROUP) or build_group(look)
    mat = bpy.data.materials.get(MATERIAL) or build_material(look=look)
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


def get_input(mod, name):
    ident = mod.node_group.interface.items_tree[name].identifier
    props = getattr(mod, "properties", None)
    if props is not None:
        cur = getattr(props.inputs, ident)
        return cur.value if hasattr(cur, "value") else cur
    return mod[ident]


def patch_modifier(obj):
    for mod in obj.modifiers:
        if mod.type == "NODES" and mod.node_group and mod.node_group.name.startswith(GROUP):
            return mod
    return None


def make_patch(obj, paleness=None, look=None):
    ng, mat = ensure_assets(paleness, look)
    mod = patch_modifier(obj)
    if mod is None:
        mod = obj.modifiers.new(GROUP, "NODES")
        mod.node_group = ng
    set_input(mod, "Material", mat)
    return mod


def add_area(context, radius=0.4, sides=10):
    me = bpy.data.meshes.new("MushroomArea")
    bm = bmesh.new()
    verts = [bm.verts.new((radius * math.cos(2 * math.pi * i / sides),
                           radius * math.sin(2 * math.pi * i / sides), 0.0))
             for i in range(sides)]
    bm.faces.new(verts)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("MushroomArea", me)
    ob.location = context.scene.cursor.location
    context.collection.objects.link(ob)
    return ob


def _asset_name(obj):
    return "SM_MushroomPatch_" + re.sub(r"[^A-Za-z0-9_]+", "_", obj.name).strip("_")


def bake_patch(obj, context, no_overlaps=True):
    """Freeze a patch into a static mesh. Rotation/scale are baked into the
    vertices; the pivot stays at the polygon's origin."""
    mod = patch_modifier(obj)
    if mod is None:
        raise ValueError(f"{obj.name} has no {GROUP} modifier")
    # exported assets never intersect, even if No Overlaps was switched off for
    # faster previews while blocking out a large area; the level editor's
    # noOverlaps parameter is the one way to bake them overlapping
    saved = {k: get_input(mod, k) for k in ("Show Area", "No Overlaps")}
    set_input(mod, "Show Area", False)
    set_input(mod, "No Overlaps", bool(no_overlaps))
    obj.update_tag()
    dg = context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg),
                                         preserve_all_data_layers=True, depsgraph=dg)
    for k, v in saved.items():
        set_input(mod, k, v)
    obj.update_tag()

    loc, rot, scale = obj.matrix_world.decompose()
    me.transform(rot.to_matrix().to_4x4() @ Matrix.Diagonal(scale).to_4x4())
    if UV in me.uv_layers:
        me.uv_layers.active = me.uv_layers[UV]
    for a in [a.name for a in me.attributes if a.name.startswith("m_") or a.name == "id"]:
        me.attributes.remove(me.attributes[a])

    name = _asset_name(obj)
    old = bpy.data.objects.get(name)
    if old:
        old_me = old.data
        bpy.data.objects.remove(old)
        if old_me.users == 0:
            bpy.data.meshes.remove(old_me)
    me.name = name
    baked = bpy.data.objects.new(name, me)
    baked.location = loc
    coll = bpy.data.collections.get("Mushroom Assets")
    if coll is None:
        coll = bpy.data.collections.new("Mushroom Assets")
        context.scene.collection.children.link(coll)
    coll.objects.link(baked)
    return baked


def export_asset(baked, folder, fmt, context):
    """fmt: 'FBX', 'GLB' or 'BOTH'. Writes next to it the shared PNGs
    (albedo, emissive, ORM with roughness in G),
    written next to it: albedo, emissive and ORM (roughness in G), which the FBX references by bare filename (Unreal picks them up on import)."""
    folder = bpy.path.abspath(folder)
    os.makedirs(folder, exist_ok=True)
    for img_name in (ALBEDO, EMISSIVE, ORM):
        img = bpy.data.images[img_name]
        width, height = img.size
        px = np.empty(width * height * 4, np.float32)
        img.pixels.foreach_get(px)
        out = bpy.data.images.new("_tmp_export", width, height, alpha=False)
        out.pixels.foreach_set(px)
        out.filepath_raw = os.path.join(folder, img_name + ".png")
        out.file_format = "PNG"
        out.save()
        bpy.data.images.remove(out)

    written = []
    context.view_layer.update()        # drop entries for assets replaced by a re-bake
    prev_sel = [o for o in context.view_layer.objects if o and o.select_get()]
    prev_active = context.view_layer.objects.active
    loc = baked.location.copy()
    baked.location = (0, 0, 0)                        # asset pivot = polygon origin
    try:
        for o in prev_sel:
            o.select_set(False)
        baked.select_set(True)
        context.view_layer.objects.active = baked
        if fmt in ("FBX", "BOTH"):
            path = os.path.join(folder, baked.name + ".fbx")
            bpy.ops.export_scene.fbx(filepath=path, use_selection=True, object_types={"MESH"},
                                     mesh_smooth_type="FACE", path_mode="STRIP")
            written.append(path)
        if fmt in ("GLB", "BOTH"):
            path = os.path.join(folder, baked.name + ".glb")
            bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True)
            written.append(path)
    finally:
        baked.location = loc
        baked.select_set(False)
        for o in prev_sel:
            o.select_set(True)
        context.view_layer.objects.active = prev_active
    return written


# ==========================================================================
# UI
# ==========================================================================
def _paleness_changed(self, context):
    if bpy.data.images.get(ALBEDO):
        build_textures(self.mushroom_paleness)


class MUSHROOM_OT_add_area(bpy.types.Operator):
    bl_idname = "mushroom.add_area"
    bl_label = "Add Patch Area"
    bl_description = "Add an editable polygon at the 3D cursor that grows mushrooms"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        ob = add_area(context)
        make_patch(ob, context.scene.mushroom_paleness)
        for o in context.selected_objects:
            o.select_set(False)
        ob.select_set(True)
        context.view_layer.objects.active = ob
        return {"FINISHED"}


class MUSHROOM_OT_make_patch(bpy.types.Operator):
    bl_idname = "mushroom.make_patch"
    bl_label = "Make Patch"
    bl_description = "Grow mushrooms on the selected meshes / closed curves"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        obs = [o for o in context.selected_objects if o.type in {"MESH", "CURVE"}]
        if not obs:
            self.report({"WARNING"}, "Select a mesh polygon or closed curve")
            return {"CANCELLED"}
        for o in obs:
            make_patch(o, context.scene.mushroom_paleness)
        return {"FINISHED"}


class MUSHROOM_OT_bake_asset(bpy.types.Operator):
    bl_idname = "mushroom.bake_asset"
    bl_label = "Bake Game Asset"
    bl_description = "Freeze selected patches to static meshes and export them"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        sc = context.scene
        obs = [o for o in context.selected_objects if patch_modifier(o)]
        if not obs:
            self.report({"WARNING"}, "Select one or more mushroom patches")
            return {"CANCELLED"}
        if sc.mushroom_export and not bpy.data.filepath and sc.mushroom_export_dir.startswith("//"):
            self.report({"ERROR"}, "Save the .blend first, or set an absolute export folder")
            return {"CANCELLED"}
        files, tris = [], 0
        for o in obs:
            baked = bake_patch(o, context)
            tris += sum(len(p.vertices) - 2 for p in baked.data.polygons)
            if sc.mushroom_export:
                files += export_asset(baked, sc.mushroom_export_dir, sc.mushroom_export_format, context)
        msg = f"Baked {len(obs)} patch(es), {tris:,} triangles"
        if files:
            msg += f"; exported {len(files)} file(s) to {bpy.path.abspath(sc.mushroom_export_dir)}"
        self.report({"INFO"}, msg)
        return {"FINISHED"}


class MUSHROOM_PT_panel(bpy.types.Panel):
    bl_label = "Mushroom Patch"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Mushrooms"

    def draw(self, context):
        sc = context.scene
        col = self.layout.column(align=True)
        col.operator("mushroom.add_area", icon="MESH_CIRCLE")
        col.operator("mushroom.make_patch", icon="MODIFIER")
        ob = context.active_object
        mod = patch_modifier(ob) if ob else None
        if mod:
            box = self.layout.box()
            box.label(text=f"{ob.name}  (Tab: edit the outline)")
            box.label(text="Density, seed, tilt... are on the modifier")
            box.label(text="Big area slow? Untick No Overlaps; bake re-enables it")
        self.layout.prop(sc, "mushroom_paleness", slider=True)
        box = self.layout.box()
        box.prop(sc, "mushroom_export")
        sub = box.column()
        sub.enabled = sc.mushroom_export
        sub.prop(sc, "mushroom_export_dir", text="")
        sub.prop(sc, "mushroom_export_format", expand=True)
        box.operator("mushroom.bake_asset", icon="EXPORT")


CLASSES = (MUSHROOM_OT_add_area, MUSHROOM_OT_make_patch, MUSHROOM_OT_bake_asset, MUSHROOM_PT_panel)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    S = bpy.types.Scene
    S.mushroom_paleness = bpy.props.FloatProperty(
        name="Paleness", default=0.5, min=0.0, max=1.0, subtype="FACTOR",
        description="Lift every colour toward white (0 = full saturation)",
        update=_paleness_changed)
    S.mushroom_export = bpy.props.BoolProperty(name="Export files", default=True)
    S.mushroom_export_dir = bpy.props.StringProperty(
        name="Export Folder", default="//mushroom_export/", subtype="DIR_PATH")
    S.mushroom_export_format = bpy.props.EnumProperty(
        name="Format", default="FBX",
        items=[("FBX", "FBX", "Unreal / Unity"), ("GLB", "GLB", "Godot / web / Unreal 5"),
               ("BOTH", "Both", "")])


def unregister():
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
    for p in ("mushroom_paleness", "mushroom_export", "mushroom_export_dir", "mushroom_export_format"):
        delattr(bpy.types.Scene, p)


if __name__ == "__main__":
    register()
