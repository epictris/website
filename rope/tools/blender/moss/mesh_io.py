"""Moving moss data in and out of Blender datablocks: the stamps a moss object
keeps, the generated mesh it shows, and the one material every moss shares."""

import os

import bpy
import numpy as np

from .build import Stamps

# Not "Moss": the river's generated cavern already has a material of that name.
MATERIAL = "MossGrown"
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
# The generated mesh


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
    mat = material()
    if list(me.materials) != [mat]:
        me.materials.clear()
        me.materials.append(mat)


# --------------------------------------------------------------------------
# The material: the moss texture (grass_05) multiplied by the vertex colour
# tint, with its normal and roughness maps, both faces drawn. Every node in it
# is one the scene exporter carries to glTF (baseColorTexture x COLOR_0,
# normalTexture, the roughness channel, doubleSided); anything else would be
# baked to a flat colour. The maps are 1k copies of the 4k download - the
# optimiser caps a scene's textures at 1k anyway - packed into the .blend so
# the scene exports on any machine.

MATERIAL_VERSION = 2
REPO = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", ".."))
TEXTURE_SOURCE = os.path.join(REPO, "assets-src", "grass-05")
TEXTURE_1K = os.path.join(REPO, "assets-src", "scenes", "textures")
MAPS = {
    # slot: (4k source, 1k copy, colour space)
    "base": ("grass_05_basecolor_4k.png", "moss-grass05-base.png", "sRGB"),
    "normal": ("grass_05_normal_gl_4k.png", "moss-grass05-normal.png", "Non-Color"),
    "rough": ("grass_05_roughness_4k.png", "moss-grass05-rough.png", "Non-Color"),
}


def _map(slot):
    """The packed 1k image for a slot, made from the 4k source the first time.
    None when neither exists (the material then falls back to the tint)."""
    src, small, space = MAPS[slot]
    name = small
    img = bpy.data.images.get(name)
    if img is not None:
        return img
    small_path = os.path.join(TEXTURE_1K, small)
    if not os.path.exists(small_path):
        src_path = os.path.join(TEXTURE_SOURCE, src)
        if not os.path.exists(src_path):
            print(f"[moss] no {src_path}: the moss material has no {slot} map")
            return None
        os.makedirs(TEXTURE_1K, exist_ok=True)
        big = bpy.data.images.load(src_path)
        big.colorspace_settings.name = space
        big.scale(1024, 1024)
        big.filepath_raw = small_path
        big.file_format = "PNG"
        big.save()
        bpy.data.images.remove(big)
    img = bpy.data.images.load(small_path)
    img.name = name
    img.colorspace_settings.name = space
    img.pack()
    return img


def material():
    mat = bpy.data.materials.get(MATERIAL)
    if mat is not None and mat.get("moss_material") == MATERIAL_VERSION:
        return mat
    if mat is None:
        mat = bpy.data.materials.new(MATERIAL)
    if mat.node_tree is None:
        mat.use_nodes = True
    mat["moss_material"] = MATERIAL_VERSION
    mat.use_backface_culling = False
    mat.diffuse_color = (0.3, 0.38, 0.12, 1.0)
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type not in {"BSDF_PRINCIPLED", "OUTPUT_MATERIAL"}:
            nt.nodes.remove(n)
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    x, y = bsdf.location.x, bsdf.location.y
    bsdf.inputs["Roughness"].default_value = 0.95
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.2

    tint = nt.nodes.new("ShaderNodeVertexColor")
    tint.layer_name = COLOR
    tint.location = (x - 600, y - 200)
    base = _map("base")
    if base is None:
        nt.links.new(tint.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = base
        tex.location = (x - 600, y + 100)
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.location = (x - 250, y)
        by_id = {i.identifier: i for i in mix.inputs}
        by_id["Factor_Float"].default_value = 1.0
        nt.links.new(tex.outputs["Color"], by_id["A_Color"])
        nt.links.new(tint.outputs["Color"], by_id["B_Color"])
        nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    rough = _map("rough")
    if rough is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = rough
        tex.location = (x - 600, y - 450)
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Roughness"])
    normal = _map("normal")
    if normal is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = normal
        tex.location = (x - 600, y - 750)
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.location = (x - 250, y - 600)
        nt.links.new(tex.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return mat
