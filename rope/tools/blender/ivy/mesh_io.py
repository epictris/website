"""Moving ivy data in and out of Blender datablocks: the stamps an ivy object
keeps, the generated mesh it shows, and the one material every ivy shares."""

import math
import os
import random

import bpy
import numpy as np

from .build import ATLAS_CELLS, ATLAS_INSET, LEAF_BASE, LEAF_SPAN
from .stampbrush.stamps import new_mesh as new_stamps_mesh  # noqa: F401 - the stamps' storage is shared
from .stampbrush.stamps import read as read_stamps  # noqa: F401
from .stampbrush.stamps import write as write_stamps  # noqa: F401

COLOR = "Col"
UV = "UVMap"


# --------------------------------------------------------------------------
# The generated mesh: one mesh, ONE material, custom normals (the hull normal
# on every corner) and a per-vertex colour. One material on purpose: Blender
# 5.2's glTF exporter, given a second material slot that reads the same colour
# attribute, records it under the attribute's name where it later looks for
# the glTF name, decides that slot does not use the colour, and writes its
# COLOR_0 as white (io_scene_gltf2 primitive_extract.py, `materials_use_vc`).
# That is how the underlay shipped white. With one slot there is nothing to
# mismatch, and the ivy is one draw call.


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
    mat = material()
    if list(me.materials) != [mat]:
        me.materials.clear()
        me.materials.append(mat)
        _purge_old_materials()


# --------------------------------------------------------------------------
# The atlas: a 4 x 4 sheet of silhouettes, the alpha as the shape and the
# colour white everywhere - the vertex colour owns the hue, no darkness is
# baked into a leaf (the owner: it comes from the shadows alone), and a black
# background under the alpha would bleed a dark fringe into every edge
# through filtering. Fifteen ivy
# leaves for the carpet and the vines - three- and five-lobed, each drawn a
# little differently in how far its lobes reach, how deep its sinuses cut, how
# blunt its tip is and which way it leans, one flat colour with no veins
# (the owner asked for the lines to go) - base at the bottom of the card
# (build.LEAF_BASE) and tip at the top (build.LEAF_TIP), and one faceted
# round the underlay and the stems sample the centre of. Every
# shape sits inside its cell's inner (1 - 2 * ATLAS_INSET), the part a card's
# UV quad covers, so there is a transparent gutter either side of every cell
# border (see build.ATLAS_INSET). Generated once into assets-src/scenes/
# textures and packed into the .blend, so a scene exports on any machine.
# Bump ATLAS_VERSION to redraw it: the file is named by version, so a stale
# sheet is never picked up.

MATERIAL_VERSION = 6
ATLAS_VERSION = 6
ATLAS_NAME = f"ivy-cutout-atlas-v{ATLAS_VERSION}.png"
ATLAS_SIZE = 1024
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


def _faceted(rnd):
    n = rnd.randint(6, 8)
    pts = []
    for i in range(n):
        a = (i + rnd.uniform(-0.2, 0.2)) / n * math.tau
        r = 0.42 * rnd.uniform(0.82, 1.0)
        pts.append((0.5 + r * math.cos(a), 0.5 + r * math.sin(a)))
    return pts


# The ivy leaf, as (u, v) along and across a unit leaf, right half from the
# base to the tip. Five lobes: a broad rounded middle lobe, two rounded side
# lobes at the widest point, a small basal lobe either side behind a sinus, a
# notched base. Three lobes: the same without the basal sinus, so the base is
# heart-shaped. |v| peaks at IVY_HALF, so the outline is scaled by
# width / (2 * IVY_HALF).
IVY_HALF = 0.55
IVY_FIVE = (
    (0.06, 0.0),
    (0.02, 0.14),
    (0.0, 0.26),
    (0.04, 0.34),
    (0.12, 0.36),
    (0.19, 0.31),  # sinus between the basal lobe and the side lobe
    (0.26, 0.42),
    (0.32, 0.52),
    (0.38, 0.55),  # the side lobe's rounded tip
    (0.45, 0.50),
    (0.50, 0.40),
    (0.54, 0.30),  # sinus between the side and middle lobes
    (0.62, 0.30),
    (0.74, 0.25),
    (0.86, 0.16),
    (0.95, 0.07),
    (1.0, 0.0),
)
IVY_THREE = (
    (0.07, 0.0),
    (0.02, 0.12),
    (0.0, 0.24),
    (0.05, 0.36),
    (0.14, 0.45),
    (0.24, 0.52),
    (0.34, 0.55),  # the side lobe's rounded tip
    (0.43, 0.50),
    (0.49, 0.40),
    (0.54, 0.30),  # sinus between the side and middle lobes
    (0.62, 0.30),
    (0.74, 0.25),
    (0.86, 0.16),
    (0.95, 0.07),
    (1.0, 0.0),
)


def _ivy_frame(cx, cy, length, width, angle, rnd):
    """(u, v) -> cell coordinates for a leaf `length` long and `width` wide,
    its base at (cx, cy), pointing along `angle`; every leaf drawn a little
    differently: how far each side lobe reaches (not the same on both sides),
    how deep its sinuses cut, how blunt its middle lobe is and how far it
    leans to one side."""
    lat = (rnd.uniform(0.92, 1.06), rnd.uniform(0.92, 1.06))
    deep = rnd.uniform(0.88, 1.12)
    blunt = rnd.uniform(0.86, 1.0)  # the middle lobe's reach past the sinus
    lean = rnd.uniform(-0.07, 0.07)
    ca, sa = math.cos(angle), math.sin(angle)

    def at(u, v):
        if 0.2 <= u <= 0.5:
            v *= lat[v >= 0]
        if abs(v) < 0.32 and 0.15 < u < 0.6:
            v /= deep
        if u > 0.54:
            u = 0.54 + (u - 0.54) * blunt
        x = (u + v * lean) * length
        y = v / (2 * IVY_HALF) * width
        return cx + x * ca - y * sa, cy + x * sa + y * ca

    return at


def _ivy_poly(at, half):
    """The leaf's outline through the frame `at`, from its right half."""
    prof = list(half) + [(u, -v) for u, v in reversed(half[1:-1])]
    return [at(u, v) for u, v in prof]


def _blur(mask, r):
    """The mask box-blurred three times by r pixels: 0.5 on its edge, 1 deep inside."""
    a = mask.astype(np.float32)
    k = np.ones(2 * r + 1, np.float32) / (2 * r + 1)
    for _ in range(3):
        a = np.apply_along_axis(lambda x: np.convolve(x, k, mode="same"), 0, a)
        a = np.apply_along_axis(lambda x: np.convolve(x, k, mode="same"), 1, a)
    return a


def _soften(mask, r):
    """Blur the mask and re-threshold it: every corner rounds by about r pixels."""
    return _blur(mask, r) > 0.5


# (A dark rim painted just inside every leaf's edge was tried on 2026-09-30
# for softer-looking edges and rejected the same hour: at game distance the
# mips turned it into a hard outline round every leaf.)


# The sheet, top row first. build.py's LEAF_CELLS and FILL_CELL index into
# this order; FILL_CELL must be the "faceted" cell (solid at its centre).
ATLAS_KINDS = (
    "five", "three", "five", "three",
    "three", "five", "three", "five",
    "five", "three", "five", "three",
    "three", "five", "three", "faceted",
)


def _inset(poly):
    """A polygon in cell units drawn into the cell's inner square, the part a
    card's UV quad covers (build.ATLAS_INSET)."""
    k = 1.0 - 2.0 * ATLAS_INSET
    return [(0.5 + (x - 0.5) * k, 0.5 + (y - 0.5) * k) for x, y in poly]


def _draw_atlas(size=ATLAS_SIZE, cells=ATLAS_CELLS, seed=9):
    """The atlas as float RGBA (rows top first)."""
    rnd = random.Random(seed)
    img = np.zeros((size, size, 4), np.float32)
    img[..., 0:3] = 1.0
    cs = size // cells
    k = 1.0 - 2.0 * ATLAS_INSET
    for i, kind in enumerate(ATLAS_KINDS):
        cy, cx = divmod(i, cells)
        cell = img[cy * cs:(cy + 1) * cs, cx * cs:(cx + 1) * cs]
        if kind == "faceted":
            inside = _soften(_raster_polygon(_inset(_faceted(rnd)), cs), int(cs * k * 0.03))
            cell[..., 3] = inside
            continue
        # A leaf, base at LEAF_BASE of the card from its bottom (the cell's y
        # runs down, so 1 - LEAF_BASE), tip at LEAF_TIP, pointing up the card.
        half = IVY_FIVE if kind == "five" else IVY_THREE
        leaf = _ivy_frame(0.5, 1.0 - LEAF_BASE, LEAF_SPAN, rnd.uniform(0.76, 0.86), -math.pi / 2, rnd)
        cell[..., 3] = _soften(_raster_polygon(_inset(_ivy_poly(leaf, half)), cs), int(cs * k * 0.018))
    return img


def atlas():
    """The packed atlas image, drawn the first time (or when ATLAS_VERSION moves)."""
    img = bpy.data.images.get(ATLAS_NAME)
    if img is not None and img.get("ivy_atlas") == ATLAS_VERSION:
        return img
    path = os.path.join(TEXTURE_DIR, ATLAS_NAME)
    # A sheet of another version, or a same-named image without the mark, goes.
    for stale in [i for i in bpy.data.images if i.name == ATLAS_NAME or i.get("ivy_atlas") is not None]:
        bpy.data.images.remove(stale)
    if not os.path.exists(path):
        os.makedirs(TEXTURE_DIR, exist_ok=True)
        pixels = _draw_atlas()
        tmp = bpy.data.images.new("ivy-atlas-draw", ATLAS_SIZE, ATLAS_SIZE, alpha=True)
        tmp.pixels.foreach_set(pixels[::-1].ravel())
        tmp.filepath_raw = path
        tmp.file_format = "PNG"
        tmp.save()
        bpy.data.images.remove(tmp)
    img = bpy.data.images.load(path)
    img.name = ATLAS_NAME
    img.alpha_mode = "STRAIGHT"
    img["ivy_atlas"] = ATLAS_VERSION
    img.pack()
    return img


# --------------------------------------------------------------------------
# The material. Every node is one the scene exporter carries to glTF:
# baseColorTexture x COLOR_0 with the alpha cut by a threshold (alphaMode
# MASK) and back faces culled. The underlay and the stems wear it too, on a
# solid cell of the atlas. It casts no shadow in the game
# (render3d/sceneDressing.ts turns casting off for a `.ivy` node); in Blender
# that is the object's `visible_shadow`, set by ops.create_ivy.

MATERIAL_NAME = "Ivy"
OLD_MATERIALS = ("MossBlobs", "MossUnder", "MossStem")  # the three slots before 2026-09-30, when the ivy was the moss add-on


def _fresh(name):
    mat = bpy.data.materials.get(name)
    if mat is not None and mat.get("ivy_material") == MATERIAL_VERSION:
        return mat, None
    if mat is None:
        mat = bpy.data.materials.new(name)
    if mat.node_tree is None:
        mat.use_nodes = True
    mat["ivy_material"] = MATERIAL_VERSION
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


def material():
    """The one material every ivy shares, rebuilt when MATERIAL_VERSION moves."""
    mat, bsdf = _fresh(MATERIAL_NAME)
    if bsdf is not None:
        nt = mat.node_tree
        mat.use_backface_culling = True
        mat.diffuse_color = (0.3, 0.45, 0.1, 1.0)
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
            mat.blend_method = "CLIP"
            mat.alpha_threshold = ATLAS_CUTOFF
        except Exception:
            pass
    return mat


# --------------------------------------------------------------------------
# The shadow decal: its own mesh and its own blended material, `IvyShadow`,
# white times the vertex colour with the vertex colour's alpha as the
# opacity - no texture, no second slot on the ivy mesh (see above for why a
# second slot is out). The exporter writes it as alphaMode BLEND with
# COLOR_0 carrying the alpha; three.js draws it transparent, depth-tested
# under the leaves, without writing depth.

SHADOW_MATERIAL_NAME = "IvyShadow"
SHADOW_MATERIAL_VERSION = 1


def write_shadow(me, shadow):
    me.clear_geometry()
    v, t = shadow.vertices, shadow.triangles
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
    attr = me.color_attributes.get(COLOR) or me.color_attributes.new(COLOR, "FLOAT_COLOR", "POINT")
    if len(attr.data) == len(shadow.colors):
        attr.data.foreach_set("color", shadow.colors.astype(np.float32).ravel())
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find(COLOR)
    me.shade_smooth()
    if len(shadow.normals) == len(v):
        me.normals_split_custom_set_from_vertices(shadow.normals.astype(np.float32).tolist())
    mat = shadow_material()
    if list(me.materials) != [mat]:
        me.materials.clear()
        me.materials.append(mat)


def shadow_material():
    mat = bpy.data.materials.get(SHADOW_MATERIAL_NAME)
    if mat is not None and mat.get("ivy_material") == SHADOW_MATERIAL_VERSION:
        return mat
    if mat is None:
        mat = bpy.data.materials.new(SHADOW_MATERIAL_NAME)
    if mat.node_tree is None:
        mat.use_nodes = True
    mat["ivy_material"] = SHADOW_MATERIAL_VERSION
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type not in {"BSDF_PRINCIPLED", "OUTPUT_MATERIAL"}:
            nt.nodes.remove(n)
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    bsdf.inputs["Roughness"].default_value = 1.0
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    tint = _tint_node(nt, bsdf)
    nt.links.new(tint.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tint.outputs["Alpha"], bsdf.inputs["Alpha"])
    mat.surface_render_method = "BLENDED"
    mat.use_backface_culling = True
    mat.show_transparent_back = False
    mat.diffuse_color = (0.02, 0.03, 0.06, 0.6)
    try:
        mat.blend_method = "BLEND"
    except Exception:
        pass
    return mat


def _purge_old_materials():
    """The three-slot materials of an older file, once nothing uses them."""
    for name in OLD_MATERIALS:
        old = bpy.data.materials.get(name)
        if old is not None and old.get("moss_material") is not None and old.users == 0:
            bpy.data.materials.remove(old)
