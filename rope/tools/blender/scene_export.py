"""Export a level's Blender scene as the game's dressing.

    blender -b assets-src/scenes/<scene>.blend --factory-startup --python-exit-code 1 \
        --python tools/blender/scene_export.py -- out.glb meta.json

Run by `scripts/scene-export.ts` (`just scene <level>`), which optimises the
result and finishes the meta; see docs/blender-scenes.md.

WHAT GOES OUT. Every object in the scene that has geometry (a mesh, a curve, a
surface, a text, a metaball), except:

- one linked from another file (the level's collision guide is one, linked
  from `<scene>-guide.blend`), or an override of one;
- one in a collection whose name starts with "guide" (any case), or in a
  collection excluded from the view layer (the checkbox in the outliner);
- one hidden in RENDER (the camera icon), itself or through a collection it is
  in. Render visibility is what ships; viewport visibility is the artist's own
  business and is ignored, so a reference hidden to get it out of the way is
  still hidden from the game only if it is hidden from the render.

Lights, cameras, empties, armatures never go out: the level's own lights carry
a budget and semantics glTF cannot (see docs/lighting-and-surfaces.md), and an
empty that parents things is flattened away by the optimiser anyway.

WHAT IS KEPT. Every object's WORLD transform, because that is the whole
binding: the renderer mounts an object named like a body at Blender's pose
minus the body's rest pose and lets the body carry it (render3d/sceneDressing.ts).
Modifiers are applied. Materials go as glTF can carry them - a Principled BSDF
with image textures, a constant tint on one, alpha clipped by a threshold - and
a PROCEDURAL Base Color (noise, ramps, mixes: what the formations' stone is) is
baked by Cycles into a vertex colour on the exported copy and wired back in, so
it goes as `COLOR_0` (`bake_procedural_color`). Everything else glTF cannot
carry is reported in `warnings`.

Frames: Blender is z-up, the exporter writes y-up (Blender x, y, z -> glTF
x, z, -y), and the game draws in glTF's frame (x right, y up, z toward the
camera). So the gameplay plane is Blender y = 0, toward the camera is Blender
-y, and a backdrop behind the level sits at positive Blender y. The guide the
level exports stands in this frame, so nothing here has to be remembered.
"""

import json
import os
import re
import sys
import time

import bpy
from mathutils import Vector

# Object types with geometry the glTF exporter carries.
EXPORTABLE = {"MESH", "CURVE", "SURFACE", "FONT", "META"}

# Collections whose objects are the artist's reference and never ship.
GUIDE_PREFIX = "guide"


def log(msg):
    print(f"[scene_export] {msg}", flush=True)


def node_name(name):
    """How three.js spells this object's node name (see `nodeNameOf` in
    render3d/scenes.ts): whitespace to `_`, then `[`, `]`, `.`, `:`, `/`
    dropped. The report compares body names through the same rule."""
    return re.sub(r"[\[\]\.:/]", "", re.sub(r"\s", "_", name))


def to_game(v):
    """Blender (x, y, z) -> the game's (x, z, -y)."""
    return [v.x, v.z, -v.y]


def excluded_collections(view_layer):
    """Every collection whose objects stay out: excluded from the view layer,
    hidden in render, named as a guide, or linked - and every collection
    inside one of those."""
    out = set()

    def walk(layer_coll, inherited):
        coll = layer_coll.collection
        skip = (
            inherited
            or layer_coll.exclude
            or coll.hide_render
            or coll.name.lower().startswith(GUIDE_PREFIX)
            or coll.library is not None
        )
        if skip:
            out.add(coll)
        for child in layer_coll.children:
            walk(child, skip)

    for child in view_layer.layer_collection.children:
        walk(child, False)
    return out


def skip_reason(ob, excluded):
    if ob.library is not None or ob.override_library is not None:
        return f"linked from {os.path.basename(ob.library.filepath) if ob.library else 'a library'}"
    data = getattr(ob, "data", None)
    if data is not None and getattr(data, "library", None) is not None:
        return f"data linked from {os.path.basename(data.library.filepath)}"
    if ob.type not in EXPORTABLE:
        kind = ob.type.lower()
        return f"{'an' if kind[0] in 'aeiou' else 'a'} {kind}"
    for coll in ob.users_collection:
        if coll in excluded:
            return f"in collection {coll.name}"
    if ob.hide_render:
        return "hidden in render"
    return None


def carries_vertex_color(node):
    """Whether a Base Color source is glTF's COLOR_0 - a Color Attribute alone,
    or one multiplied with an Image Texture (baseColorTexture x COLOR_0). This
    is the shape Blender's glTF importer builds and its exporter writes back."""
    if node.type == "VERTEX_COLOR":
        return True
    if node.type == "MIX" and node.data_type == "RGBA":
        by_id = {i.identifier: i for i in node.inputs}
        factor, inputs = by_id["Factor_Float"], [by_id["A_Color"], by_id["B_Color"]]
    elif node.type == "MIX_RGB":
        factor, inputs = node.inputs["Fac"], [node.inputs["Color1"], node.inputs["Color2"]]
    else:
        return False
    if node.blend_type != "MULTIPLY" or factor.is_linked or factor.default_value != 1.0:
        return False
    if not all(i.is_linked for i in inputs):
        return False
    kinds = sorted(i.links[0].from_node.type for i in inputs)
    return kinds == ["TEX_IMAGE", "VERTEX_COLOR"] and all(
        i.links[0].from_node.image is not None for i in inputs if i.links[0].from_node.type == "TEX_IMAGE"
    )


def carries_tint(node):
    """Whether a Base Color source is an Image Texture times a constant colour
    - a Mix (Multiply, factor 1) with one side an image and the other unlinked -
    which glTF carries as baseColorTexture x baseColorFactor."""
    if node.type != "MIX" or node.data_type != "RGBA" or node.blend_type != "MULTIPLY":
        return False
    by_id = {i.identifier: i for i in node.inputs}
    factor, a, b = by_id["Factor_Float"], by_id["A_Color"], by_id["B_Color"]
    if factor.is_linked or factor.default_value != 1.0:
        return False
    linked = [i for i in (a, b) if i.is_linked]
    return (len(linked) == 1 and linked[0].links[0].from_node.type == "TEX_IMAGE"
            and linked[0].links[0].from_node.image is not None)


def procedural_base_colors(mat):
    """The Principled BSDFs of `mat` whose Base Color glTF cannot carry."""
    if mat is None or mat.node_tree is None:
        return []
    out = []
    for node in mat.node_tree.nodes:
        if node.type != "BSDF_PRINCIPLED" or not node.inputs["Base Color"].is_linked:
            continue
        src = node.inputs["Base Color"].links[0].from_node
        if src.type != "TEX_IMAGE" and not carries_vertex_color(src) and not carries_tint(src):
            out.append(node)
    return out


# The colour attribute a procedural Base Color is baked into.
BAKED_COLOR = "SceneBaseColor"
BAKE_SAMPLES = 4


def bake_procedural_color(kept):
    """Bake every procedural Base Color the kept meshes use into a vertex
    colour, and wire it into Base Color, so glTF carries the stone's colour as
    COLOR_0 instead of dropping it to a flat default.

    Only the colour is baked - Cycles' diffuse COLOR pass, no light - so the
    game still lights the surface. It works on the export's own copies: each
    target gets a mesh with its modifiers applied (the attribute has to match
    the topology that is written), and the file is never saved. The resolution
    is the mesh's: a colour field finer than the vertices is averaged away.
    Returns how many objects were baked."""
    targets = [ob for ob in kept if ob.type == "MESH"
               and any(procedural_base_colors(m) for m in ob.data.materials)]
    if not targets:
        return 0
    t0 = time.time()
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for ob in targets:
        mesh = bpy.data.meshes.new_from_object(ob.evaluated_get(depsgraph), preserve_all_data_layers=True,
                                               depsgraph=depsgraph)
        ob.modifiers.clear()
        ob.data = mesh
        mesh.color_attributes.active_color = mesh.color_attributes.new(BAKED_COLOR, "BYTE_COLOR", "CORNER")
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = BAKE_SAMPLES
    scene.render.bake.target = "VERTEX_COLORS"
    for ob in scene.objects:
        try:
            ob.select_set(ob in targets)
        except RuntimeError:
            pass
    bpy.context.view_layer.objects.active = targets[0]
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, target="VERTEX_COLORS")
    for mat in {m for ob in targets for m in ob.data.materials if m is not None}:
        for node in procedural_base_colors(mat):
            attr = mat.node_tree.nodes.new("ShaderNodeVertexColor")
            attr.layer_name = BAKED_COLOR
            mat.node_tree.links.new(attr.outputs["Color"], node.inputs["Base Color"])
    log(f"baked the procedural colour of {len(targets)} objects into {BAKED_COLOR}, {time.time() - t0:.1f}s")
    return len(targets)


def material_warnings(ob):
    """What glTF cannot carry of this object's materials, one line each."""
    out = []
    data = getattr(ob, "data", None)
    slots = getattr(data, "materials", None) or []
    for mat in slots:
        if mat is None:
            continue
        # Blender 5 materials always have a node tree (`use_nodes` is
        # deprecated); one without is a legacy flat colour glTF carries as is.
        if mat.node_tree is None:
            continue
        principled = [n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"]
        if not principled:
            kinds = sorted({n.type for n in mat.node_tree.nodes if n.type.startswith("BSDF") or n.type == "EMISSION"})
            out.append(f'{ob.name}: material "{mat.name}" has no Principled BSDF ({", ".join(kinds) or "no shader"}); glTF exports a default surface')
            continue
        for node in principled:
            for socket_name in ("Base Color", "Roughness", "Metallic", "Normal", "Emission Color"):
                sock = node.inputs.get(socket_name)
                if sock is None or not sock.is_linked:
                    continue
                src = sock.links[0].from_node
                # A normal map node fed by an image is the one indirection glTF
                # understands; anything else in front of the socket is baked to
                # nothing.
                if src.type == "NORMAL_MAP" and src.inputs["Color"].is_linked:
                    src = src.inputs["Color"].links[0].from_node
                if socket_name == "Base Color" and (carries_vertex_color(src) or carries_tint(src)):
                    continue
                # A bump of strength 0 (the boulder generator's stone at its
                # default) changes nothing, so losing it loses nothing.
                if (src.type == "BUMP" and not src.inputs["Strength"].is_linked
                        and src.inputs["Strength"].default_value == 0):
                    continue
                if src.type != "TEX_IMAGE":
                    out.append(
                        f'{ob.name}: material "{mat.name}" wires {socket_name} to a {src.bl_label} node, '
                        f"which glTF cannot carry; bake it to an image or use an Image Texture"
                    )
                elif src.image is None:
                    out.append(f'{ob.name}: material "{mat.name}" has an Image Texture with no image on {socket_name}')
    return out


CREDITS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "image_credits.json")


def image_credits(obs, warnings):
    """The credits of every image the exported objects' materials use, from
    image_credits.json (by image name, Blender's `.001` suffix ignored). An
    image the table does not know is a warning: shipping it uncredited is how a
    licence obligation gets lost without a trace."""
    with open(CREDITS_FILE, encoding="utf-8") as f:
        table = json.load(f)
    images = set()
    for ob in obs:
        for mat in getattr(getattr(ob, "data", None), "materials", None) or []:
            if mat is None or mat.node_tree is None:
                continue
            for n in mat.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image is not None:
                    images.add(n.image)
    credits, unknown = {}, []
    for im in sorted(images, key=lambda i: i.name):
        name = re.sub(r"\.\d{3}$", "", im.name)
        entry = table["images"].get(name) or table["images"].get(os.path.basename(bpy.path.abspath(im.filepath)))
        if entry is None:
            unknown.append(im.name)
        elif isinstance(entry, str):
            credits[entry] = {"name": entry, **table["sets"][entry]}
    for name in unknown:
        warnings.append(f'image "{name}" has no credit: add it to tools/blender/image_credits.json (or `generated` with the script that made it)')
    return [credits[k] for k in sorted(credits)]


def stats(ob, depsgraph):
    """Triangle count and world bounds of the object as it will export
    (modifiers applied), in the game's frame."""
    ev = ob.evaluated_get(depsgraph)
    tris = 0
    try:
        me = ev.to_mesh()
        if me is not None:
            me.calc_loop_triangles()
            tris = len(me.loop_triangles)
    except RuntimeError:
        pass
    finally:
        try:
            ev.to_mesh_clear()
        except RuntimeError:
            pass
    corners = [ev.matrix_world @ Vector(c) for c in ev.bound_box]
    pts = [to_game(c) for c in corners]
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    return tris, {"min": [round(v, 4) for v in lo], "max": [round(v, 4) for v in hi]}


def grow_moss(scene, warnings):
    """Grow every moss object from its paint and settings (the moss add-on,
    tools/blender/moss, imported from the repo since the export runs with
    --factory-startup). The paint is the source; the mesh saved in the .blend
    is only the last preview, and would be stale against a host edited or
    re-imported since. A moss whose host is gone is hidden from the export."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import moss

    moss.register()
    for ob, result in moss.rebuild_all(scene):
        if result is None:
            warnings.append(f"{ob.name}: {ob.moss.status}; not exported")
            ob.hide_render = True
            continue
        log(f"moss {ob.name} on {ob.moss.host}: {len(result.triangles)} triangles ({result.blobs} blobs, {result.vines} vines), {ob.moss.build_ms:.0f} ms")


def formation_warnings(scene, warnings):
    """Formations (the Formations add-on, tools/blender/formations) whose rock
    or growth lags their source: an outline edited and not rebuilt ships the
    old rock, and growth planted before the rock was rebuilt or moved floats
    off it or sinks into it. Both are fixed in Blender, never here: a rebuild
    is the generator's to run, and a replant may undo the artist's touch-ups."""
    if not any("formation_recipe" in ob for ob in scene.objects):
        return
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import formations
    from formations import core, growth

    formations.register()
    for ob in core.formations(scene):
        if ob.hide_render:
            continue
        try:
            if core.pending(ob):
                warnings.append(f"{ob.name}: outline edited but not rebuilt (Formations > Rebuild Changed)")
        except ValueError as e:
            warnings.append(f"{ob.name}: {e}")
        if growth.stale(ob):
            warnings.append(f"{ob.name}: rock changed since its growth was planted (Formations > Growth > Stale)")


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :]
    if len(argv) < 2:
        raise SystemExit("usage: scene_export.py -- out.glb meta.json")
    out_glb, out_meta = argv[0], argv[1]
    t0 = time.time()

    scene = bpy.context.scene
    view_layer = bpy.context.view_layer
    excluded = excluded_collections(view_layer)

    kept, skipped, warnings = [], [], []
    grow_moss(scene, warnings)
    formation_warnings(scene, warnings)
    for ob in scene.objects:
        reason = skip_reason(ob, excluded)
        if reason:
            skipped.append({"name": ob.name, "reason": reason})
            continue
        kept.append(ob)

    # An empty scene is a legitimate export - the file a level is first wired
    # to, before anything is modelled - so it ships as an empty GLB with a
    # warning rather than as a failure the first run of the loop hits.
    if not kept:
        warnings.append("nothing to export: every object is a guide, linked, hidden in render or has no geometry")

    # Select exactly the kept objects. Selection needs the object visible in
    # the view layer, so viewport hiding is lifted for the export (the file is
    # not saved).
    for ob in scene.objects:
        try:
            ob.select_set(False)
        except RuntimeError:
            pass
    for ob in kept:
        ob.hide_viewport = False
        ob.hide_set(False)
        ob.select_set(True)
    view_layer.update()

    # Baking selects its own targets; the export selection is restored after.
    if bake_procedural_color(kept):
        for ob in scene.objects:
            try:
                ob.select_set(ob in kept)
            except RuntimeError:
                pass
        view_layer.update()
    for ob in kept:
        warnings.extend(material_warnings(ob))

    depsgraph = bpy.context.evaluated_depsgraph_get()
    nodes = []
    for ob in kept:
        tris, bounds = stats(ob, depsgraph)
        mats = [m.name for m in (getattr(ob.data, "materials", None) or []) if m is not None]
        nodes.append(
            {
                "name": ob.name,
                "node": node_name(ob.name),
                "triangles": tris,
                "position": [round(v, 4) for v in to_game(ob.matrix_world.translation)],
                "bounds": bounds,
                "materials": mats,
            }
        )

    kwargs = dict(
        filepath=out_glb,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_normals=True,
        export_texcoords=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_extras=False,
        # No Draco: the optimiser applies meshopt afterwards (scripts/optimize-asset.ts).
        export_draco_mesh_compression_enable=False,
    )
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kwargs = {k: v for k, v in kwargs.items() if k in props}
    bpy.ops.export_scene.gltf(**kwargs)

    meta = {
        "blender": bpy.app.version_string,
        "nodes": nodes,
        "credits": image_credits(kept, warnings),
        "skipped": skipped,
        "warnings": warnings,
    }
    with open(out_meta, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    tris = sum(n["triangles"] for n in nodes)
    log(f"wrote {out_glb} ({os.path.getsize(out_glb) / 1024:.0f} KB raw): {len(nodes)} objects, {tris} triangles, "
        f"{len(skipped)} skipped, {len(warnings)} warnings, {time.time() - t0:.1f}s")


main()
