"""Moving moss data in and out of Blender datablocks: the stamps a moss object
keeps, the generated mesh it shows, and the one material every moss shares."""

import math
import os
import random

import bpy
import numpy as np

from .build import Stamps

COLOR = "Col"
UV = "UVMap"


# --------------------------------------------------------------------------
# Stamps live as the vertices of a face-less mesh the moss object points at
# (`moss.stamps`), in the host's local frame, in painting order. A mesh keeps
# thousands of them compactly in the .blend and reads back with foreach_get.


def read_stamps(me):
    if me is None or len(me.vertices) == 0:
        return Stamps.empty()
    n = len(me.vertices)
    pos = np.empty(n * 3, np.float32)
    me.vertices.foreach_get("co", pos)
    nrm = np.empty(n * 3, np.float32)
    me.attributes["moss_normal"].data.foreach_get("vector", nrm)
    rad = np.empty(n, np.float32)
    me.attributes["moss_radius"].data.foreach_get("value", rad)
    st = np.empty(n, np.float32)
    me.attributes["moss_strength"].data.foreach_get("value", st)
    return Stamps(
        pos.reshape(-1, 3).astype(np.float64),
        nrm.reshape(-1, 3).astype(np.float64),
        rad.astype(np.float64),
        st.astype(np.float64),
    )


def write_stamps(me, stamps):
    me.clear_geometry()
    n = len(stamps)
    for name, kind in (("moss_normal", "FLOAT_VECTOR"), ("moss_radius", "FLOAT"), ("moss_strength", "FLOAT")):
        if name not in me.attributes:
            me.attributes.new(name, kind, "POINT")
    if n == 0:
        return
    me.vertices.add(n)
    me.vertices.foreach_set("co", stamps.position.astype(np.float32).ravel())
    me.attributes["moss_normal"].data.foreach_set("vector", stamps.normal.astype(np.float32).ravel())
    me.attributes["moss_radius"].data.foreach_set("value", stamps.radius.astype(np.float32))
    me.attributes["moss_strength"].data.foreach_set("value", stamps.strength.astype(np.float32))
    me.update()


def new_stamps_mesh(name):
    me = bpy.data.meshes.new(name)
    write_stamps(me, Stamps.empty())
    return me


# --------------------------------------------------------------------------
# The generated mesh: one mesh, three material slots (blobs, underlay, stems),
# custom normals (the hull normal on every corner) and a per-vertex colour.


def write_result(me, result):
    me.clear_geometry()
    v, t = result.vertices, result.triangles
    if len(t) == 0:
        return
    me.vertices.add(len(v))
    me.vertices.foreach_set("co", v.astype(np.float32).ravel())
    me.loops.add(len(t) * 3)
    me.loops.foreach_set("vertex_index", t.astype(np.int32).ravel())
    me.polygons.add(len(t))
    me.polygons.foreach_set("loop_start", np.arange(0, len(t) * 3, 3, dtype=np.int32))
    me.update(calc_edges=True)
    me.validate(clean_customdata=False)
    me.polygons.foreach_set("material_index", result.material.astype(np.int32))
    attr = me.color_attributes.get(COLOR) or me.color_attributes.new(COLOR, "FLOAT_COLOR", "POINT")
    if len(attr.data) == len(result.colors):
        attr.data.foreach_set("color", result.colors.astype(np.float32).ravel())
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find(COLOR)
    uv = me.uv_layers.get(UV) or me.uv_layers.new(name=UV)
    uv.data.foreach_set("uv", result.uvs.astype(np.float32).ravel())
    me.shade_smooth()
    if len(result.normals) == len(v):
        me.normals_split_custom_set_from_vertices(result.normals.astype(np.float32).tolist())
    mats = materials()
    if list(me.materials) != mats:
        me.materials.clear()
        for mat in mats:
            me.materials.append(mat)


# --------------------------------------------------------------------------
# The atlas: a 3 x 3 sheet of silhouettes, white everywhere (the vertex colour
# owns the hue; a black background under the alpha bleeds a dark fringe into
# every edge through filtering) with the alpha as the shape. Six angular blob
# cells for the carpet, three heart-shaped leaves with a faint midrib for the
# vines. Generated once into assets-src/scenes/textures and packed into the
# .blend, so a scene exports on any machine. Bump ATLAS_VERSION to redraw it.

MATERIAL_VERSION = 3
ATLAS_VERSION = 1
ATLAS_NAME = "moss-cutout-atlas.png"
ATLAS_SIZE = 768
REPO = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", ".."))
TEXTURE_DIR = os.path.join(REPO, "assets-src", "scenes", "textures")
ATLAS_CUTOFF = 0.35  # alpha below this is cut; below 0.5 so mipmaps do not eat the leaf edges at a distance


def _raster_polygon(poly, cs):
    """Point-in-polygon over a cs x cs grid; poly in cell units (x right, y down)."""
    yy, xx = np.mgrid[0:cs, 0:cs].astype(np.float32) / cs + 0.5 / cs
    inside = np.zeros((cs, cs), bool)
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        cond = (yy > min(y0, y1)) & (yy <= max(y0, y1)) & (abs(y1 - y0) > 1e-9)
        xs = x0 + (yy - y0) * (x1 - x0) / (y1 - y0 + 1e-12)
        inside ^= cond & (xx < xs)
    return inside


def _spiky(rnd):
    n = rnd.randint(7, 10)
    pts = []
    for i in range(n):
        a = (i + rnd.uniform(-0.25, 0.25)) / n * math.tau
        r = 0.42 * (0.95 if i % 2 == 0 else rnd.uniform(0.72, 0.84))
        pts.append((0.5 + r * math.cos(a), 0.5 + r * math.sin(a)))
    return [pts]


def _faceted(rnd):
    n = rnd.randint(6, 8)
    pts = []
    for i in range(n):
        a = (i + rnd.uniform(-0.2, 0.2)) / n * math.tau
        r = 0.42 * rnd.uniform(0.82, 1.0)
        pts.append((0.5 + r * math.cos(a), 0.5 + r * math.sin(a)))
    return [pts]


def _leaf_poly(cx, cy, length, width, angle, notch=0.06):
    """A broad heart-shaped leaf pointing along `angle`: widest at a third, a short
    pointed tip, a small base notch."""
    prof = [(0.0, 0.0), (0.05, 0.5), (0.18, 0.85), (0.38, 1.0), (0.6, 0.88), (0.8, 0.55), (0.92, 0.22), (1.0, 0.0),
            (0.92, -0.22), (0.8, -0.55), (0.6, -0.88), (0.38, -1.0), (0.18, -0.85), (0.05, -0.5), (notch, 0.0)]
    ca, sa = math.cos(angle), math.sin(angle)
    out = []
    for u, v in prof:
        x = u * length
        y = v * width / 2
        out.append((cx + x * ca - y * sa, cy + x * sa + y * ca))
    return out


def _cluster(rnd):
    """Three to five pointed leaves fanning from one base, tips outward."""
    k = rnd.randint(3, 5)
    base = rnd.uniform(0, math.tau)
    polys = []
    for i in range(k):
        a = base + (i - (k - 1) / 2) * rnd.uniform(0.55, 0.8)
        L = rnd.uniform(0.5, 0.56)
        w = rnd.uniform(0.34, 0.42)
        polys.append(_leaf_poly(0.5 - 0.1 * math.cos(a), 0.5 - 0.1 * math.sin(a), L, w, a, notch=0.0))
    return polys


def _soften(mask, r):
    """Blur the mask and re-threshold it: every corner rounds by about r pixels."""
    a = mask.astype(np.float32)
    k = np.ones(2 * r + 1, np.float32) / (2 * r + 1)
    for _ in range(3):
        a = np.apply_along_axis(lambda x: np.convolve(x, k, mode="same"), 0, a)
        a = np.apply_along_axis(lambda x: np.convolve(x, k, mode="same"), 1, a)
    return a > 0.5


def _draw_atlas(size=ATLAS_SIZE, cells=3, seed=9):
    """The atlas as float RGBA (rows top first)."""
    rnd = random.Random(seed)
    img = np.zeros((size, size, 4), np.float32)
    img[..., 0:3] = 1.0
    cs = size // cells
    kinds = ["spiky", "cluster", "faceted", "leaf", "spiky", "cluster", "faceted", "leaf", "leaf"]
    for i, kind in enumerate(kinds):
        cy, cx = divmod(i, cells)
        if kind == "spiky":
            polys = _spiky(rnd)
        elif kind == "faceted":
            polys = _faceted(rnd)
        elif kind == "cluster":
            polys = _cluster(rnd)
        else:  # a vine leaf, tip toward the top of the cell (spun tip-down by the vine)
            polys = [_leaf_poly(0.5, 0.95, 0.9, rnd.uniform(0.74, 0.84), -math.pi / 2, notch=0.09)]
        inside = np.zeros((cs, cs), bool)
        for pl in polys:
            inside |= _raster_polygon(pl, cs)
        inside = _soften(inside, int(cs * (0.018 if kind == "cluster" else 0.03)))
        img[cy * cs:(cy + 1) * cs, cx * cs:(cx + 1) * cs, 3] = inside
        if kind == "leaf":  # a faint midrib so the leaf reads as one
            yy, xx = np.mgrid[0:cs, 0:cs].astype(np.float32) / cs
            rib = inside & (abs(xx - 0.5) < 0.012) & (yy > 0.12) & (yy < 0.9)
            img[cy * cs:(cy + 1) * cs, cx * cs:(cx + 1) * cs, 0:3][rib] = 0.86
    return img


def atlas():
    """The packed atlas image, drawn the first time (or when ATLAS_VERSION moves)."""
    img = bpy.data.images.get(ATLAS_NAME)
    if img is not None and img.get("moss_atlas") == ATLAS_VERSION:
        return img
    path = os.path.join(TEXTURE_DIR, ATLAS_NAME)
    if img is not None:
        bpy.data.images.remove(img)
    if not os.path.exists(path):
        os.makedirs(TEXTURE_DIR, exist_ok=True)
        pixels = _draw_atlas()
        tmp = bpy.data.images.new("moss-atlas-draw", ATLAS_SIZE, ATLAS_SIZE, alpha=True)
        tmp.pixels.foreach_set(pixels[::-1].ravel())
        tmp.filepath_raw = path
        tmp.file_format = "PNG"
        tmp.save()
        bpy.data.images.remove(tmp)
    img = bpy.data.images.load(path)
    img.name = ATLAS_NAME
    img.alpha_mode = "STRAIGHT"
    img["moss_atlas"] = ATLAS_VERSION
    img.pack()
    return img


# --------------------------------------------------------------------------
# The materials. Every node is one the scene exporter carries to glTF: the
# blobs are baseColorTexture x COLOR_0 with the alpha cut by a threshold
# (alphaMode MASK) and back faces culled; the underlay and stems are COLOR_0
# alone. None of them casts a shadow in the game (render3d/sceneDressing.ts
# turns casting off for a `.moss` node); in Blender that is the object's
# `visible_shadow`, set by ops.create_moss.

MATERIALS = ("MossBlobs", "MossUnder", "MossStem")  # in the result's material order


def _fresh(name):
    mat = bpy.data.materials.get(name)
    if mat is not None and mat.get("moss_material") == MATERIAL_VERSION:
        return mat, None
    if mat is None:
        mat = bpy.data.materials.new(name)
    if mat.node_tree is None:
        mat.use_nodes = True
    mat["moss_material"] = MATERIAL_VERSION
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type not in {"BSDF_PRINCIPLED", "OUTPUT_MATERIAL"}:
            nt.nodes.remove(n)
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.9
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.15
    return mat, bsdf


def _tint_node(nt, bsdf):
    tint = nt.nodes.new("ShaderNodeVertexColor")
    tint.layer_name = COLOR
    tint.location = (bsdf.location.x - 600, bsdf.location.y - 200)
    return tint


def materials():
    blobs, bsdf = _fresh(MATERIALS[0])
    if bsdf is not None:
        nt = blobs.node_tree
        blobs.use_backface_culling = True
        blobs.diffuse_color = (0.3, 0.45, 0.1, 1.0)
        x, y = bsdf.location.x, bsdf.location.y
        tint = _tint_node(nt, bsdf)
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = atlas()
        tex.location = (x - 600, y + 150)
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.location = (x - 250, y)
        by_id = {i.identifier: i for i in mix.inputs}
        by_id["Factor_Float"].default_value = 1.0
        nt.links.new(tex.outputs["Color"], by_id["A_Color"])
        nt.links.new(tint.outputs["Color"], by_id["B_Color"])
        nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
        cut = nt.nodes.new("ShaderNodeMath")
        cut.operation = "GREATER_THAN"
        cut.inputs[1].default_value = ATLAS_CUTOFF
        cut.location = (x - 250, y - 300)
        nt.links.new(tex.outputs["Alpha"], cut.inputs[0])
        nt.links.new(cut.outputs[0], bsdf.inputs["Alpha"])
        try:  # the legacy setting the glTF exporter still reads on some versions
            blobs.blend_method = "CLIP"
            blobs.alpha_threshold = ATLAS_CUTOFF
        except Exception:
            pass
    out = [blobs]
    for name in MATERIALS[1:]:
        mat, bsdf = _fresh(name)
        if bsdf is not None:
            mat.use_backface_culling = False
            mat.diffuse_color = (0.2, 0.4, 0.1, 1.0)
            tint = _tint_node(mat.node_tree, bsdf)
            mat.node_tree.links.new(tint.outputs["Color"], bsdf.inputs["Base Color"])
        out.append(mat)
    return out


def material():
    """The blobs' material (kept for callers that want one material)."""
    return materials()[0]
