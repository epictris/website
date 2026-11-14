"""Build a disposable cave-foliage review scene and check its glTF materials.

blender -b --factory-startup --python tools/blender/foliage/preview_biolume.py
Outputs assets-src/studies/biolume/{preview.blend,preview.png,preview.glb}.
No level scene is opened or changed. Run with -- --no-render for checks only.
"""

import json
import math
from pathlib import Path
import struct
import sys

import bpy
import numpy as np
from mathutils import Vector

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
import foliage
import moss
from foliage import ops, mesh_io
from moss.stampbrush.stamps import Stamps, write as write_stamps

OUT = TOOLS.parents[1] / "assets-src/studies/biolume"
OUT.mkdir(parents=True, exist_ok=True)
foliage.register()
moss.register()
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene

stone = bpy.data.materials.new("Review stone")
stone.use_nodes = True
stone.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.035, 0.055, 0.085, 1)
stone.node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value = 0.9


def rock(name, pos, size):
    bpy.ops.mesh.primitive_cube_add(size=1, location=pos)
    ob = bpy.context.object
    ob.name = name
    ob.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = ob.modifiers.new("Stone bevel", "BEVEL")
    bevel.width, bevel.segments = 0.06, 1
    ob.data.materials.append(stone)
    return ob


def digest(ob):
    return (tuple(tuple(v.co) for v in ob.data.vertices),
            tuple(tuple(p.vertices) for p in ob.data.polygons),
            tuple(tuple(v.uv) for v in ob.data.uv_layers.active.data))


def label(text, pos):
    curve = bpy.data.curves.new(text, "FONT")
    curve.body = text
    curve.size = 0.095
    curve.align_x = "CENTER"
    ob = bpy.data.objects.new(text, curve)
    scene.collection.objects.link(ob)
    ob.location = pos
    ob.rotation_euler = (math.pi / 2, 0, 0)


plants, mosses = [], []
for row in range(2):
    z = (1 - row) * 1.65
    glow = (0.45, 1.0, 0.12) if row == 0 else (0.02, 0.55, 1.0)
    body = (0.055, 0.18, 0.025) if row == 0 else (0.012, 0.10, 0.17)
    for col, kind in enumerate(("MUSHROOM", "SHELF", "ORBS", "MOSS")):
        x = col * 1.4
        name = f"{'green' if row == 0 else 'blue'}-{kind.lower()}"
        label(kind.title(), (x, -0.55, z - 0.21))
        if kind == "ORBS":
            host = rock(name, (x, 0.1, z + 0.95), (1.1, 0.85, 0.2))
            at, normal = Vector((x, -0.05, z + 0.85)), Vector((0, 0, -1))
        elif kind == "SHELF":
            host = rock(name, (x, 0.25, z + 0.35), (1.1, 0.55, 0.85))
            at, normal = Vector((x, -0.025, z + 0.4)), Vector((0, -1, 0))
        else:
            host = rock(name, (x, 0.0, z - 0.08), (1.1, 0.85, 0.16))
            at, normal = Vector((x, 0, z)), Vector((0, 0, 1))
        if kind == "MOSS":
            ob = moss.ops.create_moss(host, scene)
            s = ob.moss
            s.seed = 17
            s.texel = 0.004
            s.max_texture = "512"
            s.detail = 0.65
            s.ref_depth = 0.25
            s.first_buffer = 0.008
            s.buffer = 0.008
            if row:
                s.dark, s.light = (0.015, 0.15, 0.22), (0.1, 0.8, 0.95)
            else:
                s.dark, s.light = (0.12, 0.27, 0.055), (0.68, 0.9, 0.24)
            write_stamps(s.stamps, Stamps.empty().appended([
                ((-0.17, 0, 0.08), (0, 0, 1), 0.33, 1.0),
                ((0.17, 0.04, 0.08), (0, 0, 1), 0.30, 1.0),
            ]))
            assert moss.ops.rebuild(ob) is not None, s.status
            before = digest(ob)
            s.emission_color = glow
            s.emission_strength = 2.5
            s.emission_threshold = 0.55 if row else 0.38
            assert digest(ob) == before, "Emission changed moss geometry"
            img = bpy.data.images[f"{ob.name}.emission"]
            px = np.array(img.pixels[:]).reshape(-1, 4)[:, :3]
            assert px.max() > 0.5 and (px.max(axis=1) == 0).any(), "Moss needs both emitting and matte regions"
            mosses.append(ob)
        else:
            ob = ops.create_plant("MUSHROOM" if kind == "SHELF" else kind, host, scene, at, normal, Vector((0, -1, 0)))
            s = ob.foliage
            s.live = False
            s.seed = 41 + row
            s.body_color, s.glow_color = body, glow
            if kind == "ORBS" and row:
                s.glow_color = (0.015, 0.8, 0.65)
            s.cluster_radius = 0.36 if kind in {"MUSHROOM", "SHELF"} else 0.29
            s.bio_size = 0.15 if kind in {"SHELF", "MUSHROOM"} else 0.105
            s.bio_height = 0.43
            s.cluster_count = 5
            if kind == "SHELF":
                s.mushroom_form = "SHELF"
            assert ops.rebuild(ob) is not None, (kind, s.status)
            before = digest(ob)
            assert ops.rebuild(ob) is not None
            assert digest(ob) == before, "Unstable seeded rebuild"
            assert all(np.isfinite(tuple(v.co)).all() for v in ob.data.vertices)
            assert len(ob.data.materials) == 1
            # New seed is a genuine new arrangement, and restoring it restores the mesh.
            s.seed += 1
            assert ops.rebuild(ob) is not None
            assert digest(ob) != before
            s.seed -= 1
            assert ops.rebuild(ob) is not None
            assert digest(ob) == before
            plants.append(ob)
            print(f"CHECK {name}: {s.parts} parts, {s.triangles} triangles, {s.build_ms:.1f} ms")
        # Review lighting only; Blender lights are not the game's authored lights.
        light = bpy.data.lights.new(name + " glow", "POINT")
        light.color, light.energy, light.shadow_soft_size = glow, 9, 0.18
        lamp = bpy.data.objects.new(light.name, light)
        scene.collection.objects.link(lamp)
        lamp.location = (x, -0.25, z + 0.4)

# Verify the material survives the actual Blender glTF exporter.
moss.mesh_io.prepare_gltf()
bpy.ops.export_scene.gltf(filepath=str(OUT / "preview.glb"), export_format="GLB", export_lights=False,
                          export_cameras=False, export_extras=True)
raw = (OUT / "preview.glb").read_bytes()
length = struct.unpack_from("<I", raw, 12)[0]
doc = json.loads(raw[20:20 + length])
materials = doc["materials"]
emitting = [m for m in materials if "emissiveTexture" in m]
assert len(emitting) == len(plants) + len(mosses), [m["name"] for m in emitting]
assert all(m.get("extensions", {}).get("KHR_materials_emissive_strength", {}).get("emissiveStrength", 1) > 1 for m in emitting)
assert all("baseColorTexture" in m["pbrMetallicRoughness"] for m in emitting if "pendant-orbs" in m["name"])
assert all(any("COLOR_0" in p["attributes"] for p in m["primitives"]) for m in doc["meshes"]
           if any(part in m["name"] for part in ("mushrooms", "pendant-orbs")))
print(f"CHECK glTF: {len(emitting)} emission maps with HDR strength, foliage vertex colours retained")

world = bpy.data.worlds.new("Review night")
world.use_nodes = True
world.node_tree.nodes.get("Background").inputs["Color"].default_value = (0.08, 0.12, 0.2, 1)
world.node_tree.nodes.get("Background").inputs["Strength"].default_value = 0.25
scene.world = world
key = bpy.data.lights.new("Soft fill", "AREA")
key.energy, key.shape, key.size = 250, "DISK", 7
lamp = bpy.data.objects.new(key.name, key)
scene.collection.objects.link(lamp)
lamp.location = (2, -4, 6)
lamp.rotation_euler = (Vector((2.8, 0, 1.2)) - lamp.location).to_track_quat("-Z", "Y").to_euler()
camera = bpy.data.cameras.new("Review camera")
ob = bpy.data.objects.new(camera.name, camera)
scene.collection.objects.link(ob)
ob.location = (2.1, -12, 5.0)
ob.rotation_euler = (Vector((2.1, 0, 1.35)) - ob.location).to_track_quat("-Z", "Y").to_euler()
camera.type, camera.ortho_scale = "ORTHO", 5.9
scene.camera = ob
scene.render.engine = "CYCLES"
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x, scene.render.resolution_y = 1800, 1000
scene.render.resolution_percentage = 100
scene.render.filepath = str(OUT / "preview.png")
for ob in plants:
    ob.foliage.live = True
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "preview.blend"))
if "--no-render" not in sys.argv:
    bpy.ops.render.render(write_still=True)
    if "--closeups" in sys.argv:
        # Inspect the hanging pods from below their attachment, like the reference.
        camera.ortho_scale = 1.25
        scene.render.resolution_x = scene.render.resolution_y = 1100
        scene.cycles.samples = 48
        scene.camera.location = (2.8, -4, 0.45)
        scene.camera.rotation_euler = (Vector((2.8, 0, 0.62)) - scene.camera.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(OUT / "orbs-close.png")
        bpy.ops.render.render(write_still=True)
        camera.ortho_scale = 1.25
        scene.camera.location = (1.65, -4, 1.15)
        scene.camera.rotation_euler = (Vector((1.4, 0, 0.42)) - scene.camera.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(OUT / "shelves-close.png")
        bpy.ops.render.render(write_still=True)
print(f"DONE {OUT}")
