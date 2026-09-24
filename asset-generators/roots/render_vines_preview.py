"""Render a quick orthographic contact sheet of the LOD0 vine variants."""
from pathlib import Path
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import procedural_vines


bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for index, name in enumerate(procedural_vines.VARIANTS):
    collection = procedural_vines.build(name, 0)
    for obj in collection.objects:
        obj.location.x = (index - 1) * 3.65

world = bpy.context.scene.world
world.color = (.12, .12, .12)
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (.035, .052, .035, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = .7

light_data = bpy.data.lights.new("Large softbox", "AREA")
light_obj = bpy.data.objects.new("Large softbox", light_data)
bpy.context.scene.collection.objects.link(light_obj)
light_obj.location = (-3, -4, 4)
light_data.energy = 1400
light_data.shape = "RECTANGLE"
light_data.size = 8
light_data.size_y = 5

camera_data = bpy.data.cameras.new("Preview camera")
camera = bpy.data.objects.new("Preview camera", camera_data)
bpy.context.scene.collection.objects.link(camera)
camera.location = (0, -14, -1.55)
target = Vector((0, 0, -1.55))
camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.type = "ORTHO"
camera_data.ortho_scale = 11.8
bpy.context.scene.camera = camera

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1400
scene.render.resolution_y = 600
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(Path(__file__).resolve().parent / "vine_output" / "vine_preview.png")
bpy.ops.render.render(write_still=True)

# A closer view of the middle curtain strand makes the blade volume and braid
# legible without changing the asset itself.
camera.location = (-3.65, -6, -1.35)
target = Vector((-3.65, 0, -1.35))
camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.ortho_scale = 3.6
scene.render.resolution_x = 800
scene.render.resolution_y = 1000
scene.render.filepath = str(Path(__file__).resolve().parent / "vine_output" / "vine_detail.png")
bpy.ops.render.render(write_still=True)
