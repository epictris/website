"""Render the updated cylinder braid for visual review."""
from pathlib import Path
import sys

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[3] / "asset-generators" / "roots"
sys.path.insert(0, str(ROOT))
from procedural_vine_braid import build

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
build(.045, 3.0, 1701)

world = bpy.context.scene.world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (.055, .067, .055, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = .8

for name, location, energy, size in (
    ("Key", (-2, -3, 3), 700, 3.0),
    ("Fill", (2, 1, 1), 450, 3.5),
):
    data = bpy.data.lights.new(name, "AREA")
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    data.energy = energy
    data.shape = "DISK"
    data.size = size

camera_data = bpy.data.cameras.new("Preview camera")
camera = bpy.data.objects.new("Preview camera", camera_data)
bpy.context.scene.collection.objects.link(camera)
camera.location = (0, -5, .05)
camera.rotation_euler = (Vector((0, 0, 0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.type = "ORTHO"
camera_data.ortho_scale = 3.55
bpy.context.scene.camera = camera

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 850
scene.render.resolution_y = 1100
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(Path(__file__).resolve().parent / "braided-vine.png")
bpy.ops.render.render(write_still=True)
