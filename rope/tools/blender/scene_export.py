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
- one hidden in RENDER (the camera icon). Render visibility is what ships;
  viewport visibility is the artist's own business and is ignored, so a
  reference hidden to get it out of the way is still hidden from the game only
  if it is hidden from the render.

Lights, cameras, empties, armatures never go out: the level's own lights carry
a budget and semantics glTF cannot (see docs/lighting-and-surfaces.md), and an
empty that parents things is flattened away by the optimiser anyway.

WHAT IS KEPT. Every object's WORLD transform, because that is the whole
binding: the renderer mounts an object named like a body at Blender's pose
minus the body's rest pose and lets the body carry it (render3d/sceneDressing.ts).
Modifiers are applied. Materials go as glTF can carry them - a Principled BSDF
with image textures - and everything else is reported in `warnings`: a Base
Color wired to anything but an Image Texture exports as a flat colour.

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
    named as a guide, or linked - and every collection inside one of those."""
    out = set()

    def walk(layer_coll, inherited):
        coll = layer_coll.collection
        skip = (
            inherited
            or layer_coll.exclude
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
        return f"a {ob.type.lower()}"
    for coll in ob.users_collection:
        if coll in excluded:
            return f"in collection {coll.name}"
    if ob.hide_render:
        return "hidden in render"
    return None


def material_warnings(ob):
    """What glTF cannot carry of this object's materials, one line each."""
    out = []
    data = getattr(ob, "data", None)
    slots = getattr(data, "materials", None) or []
    for mat in slots:
        if mat is None:
            continue
        if not mat.use_nodes or mat.node_tree is None:
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
                if src.type != "TEX_IMAGE":
                    out.append(
                        f'{ob.name}: material "{mat.name}" wires {socket_name} to a {src.bl_label} node, '
                        f"which glTF cannot carry; bake it to an image or use an Image Texture"
                    )
                elif src.image is None:
                    out.append(f'{ob.name}: material "{mat.name}" has an Image Texture with no image on {socket_name}')
    return out


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
    for ob in scene.objects:
        reason = skip_reason(ob, excluded)
        if reason:
            skipped.append({"name": ob.name, "reason": reason})
            continue
        kept.append(ob)
        warnings.extend(material_warnings(ob))

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
        "skipped": skipped,
        "warnings": warnings,
    }
    with open(out_meta, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    tris = sum(n["triangles"] for n in nodes)
    log(f"wrote {out_glb} ({os.path.getsize(out_glb) / 1024:.0f} KB raw): {len(nodes)} objects, {tris} triangles, "
        f"{len(skipped)} skipped, {len(warnings)} warnings, {time.time() - t0:.1f}s")


main()
