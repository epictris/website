"""Temporary visual verification of the root generator; run in Blender."""
import json
from pathlib import Path
import sys
import bpy
from mathutils import Vector

REPO = Path(__file__).resolve().parents[2]
ROOTS = REPO / "asset-generators" / "roots"
sys.path.insert(0, str(ROOTS))
from blender_polygon_roots import build_from_editor, create_generated, export_asset

source = REPO / "rope" / "public" / "generated-roots" / "10c84455-4c74-4da3-b7cc-1fb253807d1d"
out = REPO / "rope" / "plans" / "root-fix-preview"
out.mkdir(exist_ok=True)
data = json.loads((source / "blockout.json").read_text())

def clear_meshes():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

def render_views(prefix):
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH" and
            (prefix == "before" or
             o.get("root_role") == "visual" and o.name.endswith("LOD0"))]
    for obj in bpy.context.scene.objects:
        obj.hide_render = obj not in objs and obj.type == "MESH"
    lo = Vector((min((o.matrix_world @ v.co)[i] for o in objs for v in o.data.vertices)
                 for i in range(3)))
    hi = Vector((max((o.matrix_world @ v.co)[i] for o in objs for v in o.data.vertices)
                 for i in range(3)))
    center = (lo + hi) / 2
    camera_data = bpy.data.cameras.new("Root verification camera")
    camera = bpy.data.objects.new("Root verification camera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = max(hi.x-lo.x, hi.z-lo.z, 1) * 1.25
    bpy.context.scene.camera = camera
    for name,offset in (
        ("front",Vector((0,-6,0))),
        ("overhead",Vector((0,0,6))),
        ("oblique",Vector((3,-5,3))),
    ):
        camera.location = center + offset
        direction = center-camera.location
        camera.rotation_euler = direction.to_track_quat("-Z","Y").to_euler()
        bpy.context.scene.render.filepath = str(out / f"{prefix}-{name}.png")
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(camera, do_unlink=True)

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 768
scene.render.resolution_y = 768
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.world.color = (.5,.5,.5)
scene.view_settings.view_transform = "Standard"
scene.view_settings.exposure = 3.0
scene.render.film_transparent = False
for i,location in enumerate(((2,-3,5),(-2,2,3))):
    light_data = bpy.data.lights.new(f"Verification light {i}","AREA")
    light_data.energy = 550
    light_data.shape = "DISK"
    light_data.size = 5
    light = bpy.data.objects.new(light_data.name,light_data)
    scene.collection.objects.link(light)
    light.location = location
    light.rotation_euler = (-light.location).to_track_quat("-Z","Y").to_euler()

clear_meshes()
bpy.ops.import_scene.gltf(filepath=str(source / "roots_LOD0.glb"))
render_views("before")
clear_meshes()
asset = build_from_editor(data,seed=4321,decoration_count=0)
collections = create_generated(asset)
export_asset(asset,collections,out)
render_views("after")
print("Verification files:", out)
