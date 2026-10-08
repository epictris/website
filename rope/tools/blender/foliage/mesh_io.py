"""Writing a grown plant into its mesh, and the one material every plant wears.

One mesh, one material, `Foliage`: the atlas's colour times the vertex colour,
alpha cut at ATLAS_CUTOFF, both sides drawn. Leaves sample their painted
piece, stems and the crown the atlas's solid white cell. One slot because
Blender 5.2's glTF exporter writes a second slot's COLOR_0 as white when it
reads the same colour attribute as the first (docs/blender-ivy.md, "Why one
material"). The game finds the material by name and dresses it as it dresses
the ivy's leaves (render3d/sceneDressing.ts): two-sided with one normal, lit
through, and finer shadow biases so a frond shades the frond below it."""

import os

import bpy
import numpy as np

from . import icons, library

COLOR = "Col"
UV = "UVMap"
MATERIAL_NAME = "Foliage"
MATERIAL_VERSION = 1
ATLAS_CUTOFF = 0.35  # below 0.5 so mip levels do not eat the leaf edges at a distance (the ivy's cutoff)


def write_result(me, arrays, matrix_world):
    """Write a builder's arrays (world space) into `me`, in the frame of the
    object whose world matrix is `matrix_world`."""
    pos, nrm, uv, col, tri = arrays
    me.clear_geometry()
    if len(tri) == 0:
        return
    m = np.array(matrix_world, dtype=np.float64)
    inv = np.linalg.inv(m)
    local = pos @ inv[:3, :3].T + inv[:3, 3]
    # A normal goes by the inverse transpose of the point's map: here A^T.
    ln = nrm @ m[:3, :3]
    ln /= np.maximum(np.linalg.norm(ln, axis=1, keepdims=True), 1e-12)
    if np.linalg.det(m[:3, :3]) < 0:
        tri = tri[:, ::-1]
    me.vertices.add(len(local))
    me.vertices.foreach_set("co", local.astype(np.float32).ravel())
    me.loops.add(len(tri) * 3)
    me.loops.foreach_set("vertex_index", tri.astype(np.int32).ravel())
    me.polygons.add(len(tri))
    me.polygons.foreach_set("loop_start", np.arange(0, len(tri) * 3, 3, dtype=np.int32))
    me.update(calc_edges=True)
    attr = me.color_attributes.get(COLOR) or me.color_attributes.new(COLOR, "FLOAT_COLOR", "POINT")
    rgba = np.concatenate([col, np.ones((len(col), 1))], axis=1)
    attr.data.foreach_set("color", rgba.astype(np.float32).ravel())
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find(COLOR)
    layer = me.uv_layers.get(UV) or me.uv_layers.new(name=UV)
    layer.data.foreach_set("uv", uv[tri.ravel()].astype(np.float32).ravel())
    me.shade_smooth()
    me.normals_split_custom_set_from_vertices(ln.astype(np.float32).tolist())
    mat = material()
    if list(me.materials) != [mat]:
        me.materials.clear()
        me.materials.append(mat)


def atlas():
    """The packed atlas, drawn into the repo from the sheets the first time
    (or when library.ATLAS_VERSION moves) and packed into the .blend, so a
    scene exports on any machine."""
    mark = "foliage_atlas"
    name = library.ATLAS_NAME
    img = bpy.data.images.get(name)
    if img is not None and img.get(mark) == library.ATLAS_VERSION:
        return img
    for stale in [i for i in bpy.data.images if i.name == name or i.get(mark) is not None]:
        bpy.data.images.remove(stale)
    path = os.path.join(library.TEXTURE_DIR, name)
    if not os.path.exists(path):
        pixels = library.draw_atlas()
        tmp = bpy.data.images.new("foliage-atlas-draw", library.ATLAS_W, library.ATLAS_H, alpha=True)
        try:
            tmp.pixels.foreach_set(pixels.astype(np.float32).ravel())
            tmp.filepath_raw = path
            tmp.file_format = "PNG"
            tmp.save()
        finally:
            bpy.data.images.remove(tmp)
    img = bpy.data.images.load(path)
    img.name = name
    img.alpha_mode = "STRAIGHT"
    img[mark] = library.ATLAS_VERSION
    img.pack()
    icons.build()  # the pickers' thumbnails, if the atlas was not there to cut them from yet
    return img


def material():
    """`Foliage`, rebuilt when MATERIAL_VERSION moves. Every node is one the
    scene exporter carries to glTF: baseColorTexture x COLOR_0, alphaMode MASK
    at ATLAS_CUTOFF, doubleSided."""
    mat = bpy.data.materials.get(MATERIAL_NAME)
    if mat is not None and mat.get("foliage_material") == MATERIAL_VERSION:
        img = atlas()
        for n in mat.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image != img:
                n.image = img
        return mat
    if mat is None:
        mat = bpy.data.materials.new(MATERIAL_NAME)
    if mat.node_tree is None:
        mat.use_nodes = True
    mat["foliage_material"] = MATERIAL_VERSION
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type not in {"BSDF_PRINCIPLED", "OUTPUT_MATERIAL"}:
            nt.nodes.remove(n)
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.9
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.15
    # Both sides, as the game draws them: a frond is seen from above and below.
    mat.use_backface_culling = False
    mat.diffuse_color = (0.25, 0.4, 0.12, 1.0)
    x, y = bsdf.location.x, bsdf.location.y
    tint = nt.nodes.new("ShaderNodeVertexColor")
    tint.layer_name = COLOR
    tint.location = (x - 600, y - 200)
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
