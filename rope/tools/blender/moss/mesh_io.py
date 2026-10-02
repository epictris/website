"""Moving moss data in and out of Blender datablocks: the decimate the build asks
for, the mound mesh a moss object shows, its printed texture and its material."""

import bpy
import numpy as np

UV = "UVMap"
MATERIAL_VERSION = 1
GENERATED_BY = "tools/blender/moss/build.py"  # scene_export.py: a generated image owes no credit


def decimate(v, t, ratio):
    """Blender's collapse decimate on (vertices, triangles); the build's one use
    of bpy, passed in so build.py stays a pure function."""
    me = bpy.data.meshes.new("moss.decimate")
    _write_geometry(me, v, t)
    ob = bpy.data.objects.new("moss.decimate", me)
    bpy.context.scene.collection.objects.link(ob)
    try:
        mod = ob.modifiers.new("decimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        dg = bpy.context.evaluated_depsgraph_get()
        out = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), depsgraph=dg)
    finally:
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)
    try:
        out.calc_loop_triangles()
        co = np.empty(len(out.vertices) * 3, np.float32)
        out.vertices.foreach_get("co", co)
        tri = np.empty(len(out.loop_triangles) * 3, np.int32)
        out.loop_triangles.foreach_get("vertices", tri)
    finally:
        bpy.data.meshes.remove(out)
    return co.reshape(-1, 3).astype(np.float64), tri.reshape(-1, 3).astype(np.int64)


def _write_geometry(me, v, t):
    me.clear_geometry()
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


def write_result(ob, result):
    """The mound into the object's mesh, its print into the object's image, and
    the object's own material (one per moss: the print is its own)."""
    me = ob.data
    _write_geometry(me, result.vertices, result.triangles)
    if len(result.triangles) == 0:
        return
    uv = me.uv_layers.get(UV) or me.uv_layers.new(name=UV)
    uv.data.foreach_set("uv", result.uvs.astype(np.float32).ravel())
    me.shade_smooth()
    img = _image(ob, result.image)
    mat = material(ob, img)
    if list(me.materials) != [mat]:
        me.materials.clear()
        me.materials.append(mat)


def _image(ob, pixels):
    """The print as a packed 8-bit sRGB image named after the moss. The pixels
    of a byte image are its stored (sRGB) values, so the linear print is encoded."""
    name = f"{ob.name}.print"
    size = pixels.shape[0]
    img = bpy.data.images.get(name)
    if img is not None and tuple(img.size) != (size, size):
        bpy.data.images.remove(img)
        img = None
    if img is None:
        img = bpy.data.images.new(name, size, size, alpha=False)
    rgb = np.clip(pixels[..., :3], 0.0, 1.0)
    srgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
    out = np.ones((size, size, 4), np.float32)
    out[..., :3] = srgb
    img.pixels.foreach_set(out.ravel())
    img["generated_by"] = GENERATED_BY
    img.pack()
    return img


def material(ob, img):
    """The moss's matte material: the print as the base colour, nothing else. Every
    node is one the glTF exporter carries (baseColorTexture, roughness 1, no specular)."""
    name = f"{ob.name}"
    mat = bpy.data.materials.get(name)
    if mat is None or mat.get("moss_print_material") != MATERIAL_VERSION:
        if mat is None:
            mat = bpy.data.materials.new(name)
        if mat.node_tree is None:
            mat.use_nodes = True
        mat["moss_print_material"] = MATERIAL_VERSION
        nt = mat.node_tree
        for n in list(nt.nodes):
            if n.type not in {"BSDF_PRINCIPLED", "OUTPUT_MATERIAL"}:
                nt.nodes.remove(n)
        bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Roughness"].default_value = 1.0
        if "Specular IOR Level" in bsdf.inputs:
            bsdf.inputs["Specular IOR Level"].default_value = 0.0
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.name = "print"
        tex.location = (bsdf.location.x - 400, bsdf.location.y)
        tex.interpolation = "Linear"
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        mat.diffuse_color = (0.15, 0.25, 0.1, 1.0)
    tex = mat.node_tree.nodes.get("print")
    if tex is not None and tex.image != img:
        tex.image = img
    return mat
