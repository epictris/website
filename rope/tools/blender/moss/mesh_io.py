"""Moving moss data in and out of Blender datablocks: the decimate the build asks
for, the mound mesh a moss object shows, its printed texture and its material."""

import bpy
import numpy as np

UV = "UVMap"
MATERIAL_VERSION = 2  # 2: the printed edge (2026-10-10)
GENERATED_BY = "tools/blender/moss/build.py"  # scene_export.py: a generated image owes no credit


def decimate(v, t, ratio, attrs=None, keep=None):
    """Blender's collapse decimate on (vertices, triangles); the build's one use
    of bpy, passed in so build.py stays a pure function. `attrs` are per-vertex
    float arrays carried through (interpolated where vertices merge), returned
    as the third value; `keep` marks vertices the collapse must leave where
    they are (a vertex group at weight 0, which only prices them out: they
    still move millimetres). A planar dissolve was tried instead for the
    printed edge (2026-10-10) and dropped: at 5 degrees it kept the pile's
    curvature, 16.6k triangles on Terrace.003 against the collapse's 3.6k,
    and at 20 degrees it chorded 30 mm under the rock's facet edges."""
    me = bpy.data.meshes.new("moss.decimate")
    _write_geometry(me, v, t)
    attrs = list(attrs or [])
    for k, a in enumerate(attrs):
        layer = me.attributes.new(f"carry{k}", "FLOAT", "POINT")
        layer.data.foreach_set("value", np.asarray(a, np.float32).ravel())
    ob = bpy.data.objects.new("moss.decimate", me)
    bpy.context.scene.collection.objects.link(ob)
    try:
        if keep is not None and keep.any():
            vg = ob.vertex_groups.new(name="collapse")
            vg.add(np.nonzero(~keep)[0].tolist(), 1.0, "REPLACE")
            vg.add(np.nonzero(keep)[0].tolist(), 0.0, "REPLACE")
        mod = ob.modifiers.new("decimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        if keep is not None and keep.any():
            mod.vertex_group = "collapse"
            mod.vertex_group_factor = 1000.0
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
        carried = []
        for k in range(len(attrs)):
            a = np.empty(len(out.vertices), np.float32)
            out.attributes[f"carry{k}"].data.foreach_get("value", a)
            carried.append(a.astype(np.float64))
    finally:
        bpy.data.meshes.remove(out)
    return co.reshape(-1, 3).astype(np.float64), tri.reshape(-1, 3).astype(np.int64), carried


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
    decal = ob.moss.kind == "TEXTURE"
    kind = "decal" if decal else ("printed" if ob.moss.edge_kind == "PRINT" else "opaque")
    # A texture-only moss's decal is a preview of paint on the rock: it casts
    # no shadow (the export hides it from the bake, and never ships it).
    ob.visible_shadow = not decal
    img = _image(ob, result.image, alpha=kind != "opaque")
    mat = material(ob, img, kind)
    if list(me.materials) != [mat]:
        me.materials.clear()
        me.materials.append(mat)


def _image(ob, pixels, alpha=False):
    """The print as a packed 8-bit sRGB image named after the moss. The pixels
    of a byte image are its stored (sRGB) values, so the linear print is encoded.
    With `alpha`, the print's alpha (a decal's coverage, a printed edge's
    distance) is the image's alpha."""
    name = f"{ob.name}.print"
    size = pixels.shape[0]
    img = bpy.data.images.get(name)
    if img is not None and (tuple(img.size) != (size, size) or img.get("moss_alpha", False) != alpha):
        bpy.data.images.remove(img)
        img = None
    if img is None:
        img = bpy.data.images.new(name, size, size, alpha=alpha)
        img["moss_alpha"] = alpha
    rgb = np.clip(pixels[..., :3], 0.0, 1.0)
    srgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
    out = np.ones((size, size, 4), np.float32)
    out[..., :3] = srgb
    if alpha:
        out[..., 3] = np.clip(pixels[..., 3], 0.0, 1.0)
    img.pixels.foreach_set(out.ravel())
    img["generated_by"] = GENERATED_BY
    img.pack()
    return img


def material(ob, img, kind="opaque"):
    """The moss's matte material: the print as the base colour, nothing else. Every
    node is one the glTF exporter carries (baseColorTexture, roughness 1, no specular).
    `kind`: "opaque" (a mound with a mesh edge); "decal" (a texture-only
    moss's, blended by the print's coverage); "printed" (a mound with a
    printed edge: cut at the print's alpha 0.5, which the exporter carries as
    alphaMode MASK, and the lip's roll as a Bump node off the same alpha,
    which it does not - the game's shader does the same, mossMound.ts)."""
    name = f"{ob.name}"
    mat = bpy.data.materials.get(name)
    if mat is None or mat.get("moss_print_material") != MATERIAL_VERSION or mat.get("moss_kind") != kind:
        if mat is None:
            mat = bpy.data.materials.new(name)
        if mat.node_tree is None:
            mat.use_nodes = True
        mat["moss_print_material"] = MATERIAL_VERSION
        mat["moss_kind"] = kind
        if "moss_decal" in mat:
            del mat["moss_decal"]
        nt = mat.node_tree
        for n in list(nt.nodes):
            if n.type not in {"BSDF_PRINCIPLED", "OUTPUT_MATERIAL"}:
                nt.nodes.remove(n)
        bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Roughness"].default_value = 1.0
        if "Specular IOR Level" in bsdf.inputs:
            bsdf.inputs["Specular IOR Level"].default_value = 0.0
        x, y = bsdf.location.x, bsdf.location.y
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.name = "print"
        tex.location = (x - 900, y)
        tex.interpolation = "Linear"
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Alpha"].default_value = 1.0
        if kind == "decal":
            nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
        elif kind == "printed":
            _printed_edge_nodes(nt, tex, bsdf, x, y)
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "BLENDED" if kind == "decal" else "DITHERED"
        if kind == "printed":
            try:  # the legacy setting the glTF exporter still reads on some versions
                mat.blend_method = "CLIP"
                mat.alpha_threshold = 0.5
            except Exception:
                pass
        mat.diffuse_color = (0.15, 0.25, 0.1, 1.0)
    tex = mat.node_tree.nodes.get("print")
    if tex is not None and tex.image != img:
        tex.image = img
    return mat


def prepare_gltf():
    """Before a glTF export: unlink the lip's Bump node from every printed-edge
    material. The exporter (Blender 5.2) carries a Bump fed from an image as
    a normalTexture OF THAT IMAGE - the print's colour read as normals, which
    drew the moss black in three (2026-10-10). The game shades the lip itself
    (mossMound.ts). The export never saves the file, and a Rebuild links it
    again."""
    n = 0
    for mat in bpy.data.materials:
        if mat.get("moss_kind") != "printed" or mat.node_tree is None:
            continue
        bsdf = next((x for x in mat.node_tree.nodes if x.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            continue
        for link in list(bsdf.inputs["Normal"].links):
            mat.node_tree.links.remove(link)
            n += 1
    return n


def clear_of(ob, rock_co, rock_tri, clear):
    """`ob`'s mound cleared of a rock given as world triangles (`rock_co`,
    `rock_tri`): build._clear_of_rock on the finished mesh, its UVs carried
    (a vertex per UV it has; the pass keeps a seam's two sides one point), new
    vertices taking the interpolated UV, the print untouched. For the export's
    bent rocks (scene_export.bend_growths). Returns (vertices moved, edges
    split, triangles before, after, m2 still in the rock)."""
    from .build import _clear_of_rock, _RockDistance

    me = ob.data
    uv = me.uv_layers.get(UV)
    if uv is None or len(me.polygons) == 0:
        return 0, 0, 0, 0, 0.0
    me.calc_loop_triangles()
    n = len(me.loop_triangles)
    tri_v = np.empty(n * 3, np.int64)
    me.loop_triangles.foreach_get("vertices", tri_v)
    tri_l = np.empty(n * 3, np.int64)
    me.loop_triangles.foreach_get("loops", tri_l)
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    loop_uv = np.empty(len(me.loops) * 2)
    uv.data.foreach_get("uv", loop_uv)
    loop_uv = loop_uv.reshape(-1, 2)
    m = np.array(ob.matrix_world, dtype=np.float64)
    world = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
    # a vertex per (point, UV)
    keys = np.concatenate([tri_v[:, None].astype(np.float64), np.round(loop_uv[tri_l], 7)], axis=1)
    uniq, corner = np.unique(keys, axis=0, return_inverse=True)
    point = uniq[:, 0].astype(np.int64)
    v, t, attrs, moved, split, left, weld = _clear_of_rock(
        world[point], corner.reshape(-1, 3), [uniq[:, 1], uniq[:, 2]], _RockDistance(rock_co, rock_tri), clear, point)
    # back to one vertex per point, the UVs per corner
    ids, first, pts = np.unique(weld, return_index=True, return_inverse=True)
    inv = np.linalg.inv(m)
    local = v[first] @ inv[:3, :3].T + inv[:3, 3]
    mats = list(me.materials)
    _write_geometry(me, local, pts[t])
    if len(me.materials) == 0:
        for mat in mats:
            me.materials.append(mat)
    layer = me.uv_layers.get(UV) or me.uv_layers.new(name=UV)
    layer.data.foreach_set("uv", np.stack([attrs[0], attrs[1]], 1)[t].astype(np.float32).ravel())
    me.shade_smooth()
    return moved, split, n, len(t), left


def _in_rock(ob, depsgraph):
    """A test of moss-local points (N, 3) against the moss's rock as it grew
    on it (its hosts' surface): which are inside."""
    from .stampbrush import hosts as hosts_mod

    from .build import _RockDistance
    from .ops import hosts_of

    co, tri = hosts_mod.surface(hosts_of(ob), depsgraph)
    sdf = _RockDistance(co, tri)
    m = np.array(ob.matrix_world, dtype=np.float64)

    def inside(points):
        world = points @ m[:3, :3].T + m[:3, 3]
        return np.array([sdf.query(q)[0] < 0.0 for q in world], bool)

    return inside


def cut_for_bake(obs):
    """Before the scene's bake: every printed-edge mound in `obs` takes a mesh
    cut at its print's outline (build.cut_at_print says why), so the rock's
    occlusion sees the moss the game draws and not its apron. Returns
    [(object, its own mesh)] for `uncut`; the export never saves the file."""
    from .build import cut_at_print

    swapped = []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for ob in obs:
        me = ob.data
        mat = me.materials[0] if len(me.materials) else None
        tex = mat.node_tree.nodes.get("print") if mat is not None and mat.node_tree is not None else None
        if mat is None or mat.get("moss_kind") != "printed" or tex is None or tex.image is None:
            continue
        uv = me.uv_layers.get(UV)
        if uv is None or len(me.polygons) == 0:
            continue
        me.calc_loop_triangles()
        tri_loops = np.empty(len(me.loop_triangles) * 3, np.int32)
        me.loop_triangles.foreach_get("loops", tri_loops)
        tri_verts = np.empty(len(me.loop_triangles) * 3, np.int32)
        me.loop_triangles.foreach_get("vertices", tri_verts)
        co = np.empty(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get("co", co)
        loop_uv = np.empty(len(me.loops) * 2, np.float32)
        uv.data.foreach_get("uv", loop_uv)
        img = tex.image
        px = np.empty(img.size[0] * img.size[1] * 4, np.float32)
        img.pixels.foreach_get(px)
        alpha = px.reshape(img.size[1], img.size[0], 4)[..., 3].astype(np.float64)
        corners = co.reshape(-1, 3)[tri_verts].reshape(-1, 3, 3).astype(np.float64)
        uvs = loop_uv.reshape(-1, 2)[tri_loops].reshape(-1, 3, 2).astype(np.float64)
        inside = None
        if ob.moss.in_rock > 0.0:
            # The build could not clear all of it of the rock (the panel and
            # the export say how much): what is in the rock casts nothing.
            inside = _in_rock(ob, depsgraph)
        kept = cut_at_print(corners, uvs, alpha, inside)
        cut = bpy.data.meshes.new(f"{me.name}.bake-cut")
        _write_geometry(cut, kept.reshape(-1, 3), np.arange(len(kept) * 3).reshape(-1, 3))
        cut.materials.append(mat)
        ob.data = cut
        swapped.append((ob, me))
    return swapped


def uncut(swapped):
    """After the bake: every mound `cut_for_bake` swapped takes its own mesh back."""
    for ob, me in swapped:
        cut = ob.data
        ob.data = me
        bpy.data.meshes.remove(cut)


def _printed_edge_nodes(nt, tex, bsdf, x, y):
    """The printed edge's nodes: the cut (alpha > 0.5, as the foliage's
    material cuts its atlas, which the glTF exporter carries as MASK), and the
    lip: the alpha read back as the distance inside the outline, the roll's
    height h(d) = R sqrt(1 - (1 - d / R)^2) up to R (build.LIP_ROUND), a Bump
    node's height, Distance 1 so a metre of height is a metre."""

    def math(op, a, b, px, py, clamp=False):
        n = nt.nodes.new("ShaderNodeMath")
        n.operation = op
        n.use_clamp = clamp
        n.location = (px, py)
        for k, v in ((0, a), (1, b)):
            if isinstance(v, bpy.types.NodeSocket):
                nt.links.new(v, n.inputs[k])
            else:
                n.inputs[k].default_value = v
        return n.outputs[0]

    from .build import LIP_ROUND, SDF_RANGE

    cut = math("GREATER_THAN", tex.outputs["Alpha"], 0.5, x - 300, y - 300)
    nt.links.new(cut, bsdf.inputs["Alpha"])
    # d = (alpha - 0.5) * 2 SDF_RANGE; x = clamp(d / R); h = R sqrt(1 - (1 - x)^2)
    d = math("MULTIPLY", math("SUBTRACT", tex.outputs["Alpha"], 0.5, x - 650, y - 500), 2.0 * SDF_RANGE, x - 650, y - 650)
    xx = math("DIVIDE", d, LIP_ROUND, x - 650, y - 800, clamp=True)
    one_minus = math("SUBTRACT", 1.0, xx, x - 650, y - 950)
    sq = math("SUBTRACT", 1.0, math("MULTIPLY", one_minus, one_minus, x - 500, y - 950), x - 500, y - 1100)
    h = math("MULTIPLY", math("SQRT", sq, 0.0, x - 350, y - 1100), LIP_ROUND, x - 350, y - 1250)
    bump = nt.nodes.new("ShaderNodeBump")
    bump.name = "lip"
    bump.location = (x - 300, y - 600)
    bump.inputs["Strength"].default_value = 1.0
    bump.inputs["Distance"].default_value = 1.0
    nt.links.new(h, bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
