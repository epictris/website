"""Render the reference-inspired lantern from the saved kit overview."""
import bpy
from pathlib import Path
from mathutils import Vector
s=bpy.context.scene
for collection in s.collection.children:
    if collection.name!='guide.presentation': collection.hide_render=True
s.render.resolution_x=1000;s.render.resolution_y=1200;s.render.resolution_percentage=100
s.cycles.samples=64
s.camera.location=(5.1,-2.7,2.3)
s.camera.rotation_euler=(Vector((3.45,1.1,.76))-s.camera.location).to_track_quat('-Z','Y').to_euler()
s.camera.data.ortho_scale=1.9
s.render.filepath=str(Path(__file__).resolve().parents[3]/'assets-src/studies/mineshaft/lantern-detail.png')
bpy.ops.render.render(write_still=True)
# A fixed small-size study for silhouette/light readability, not a runtime capture.
s.render.resolution_x=160;s.render.resolution_y=192
s.render.filepath=str(Path(__file__).resolve().parents[3]/'assets-src/studies/mineshaft/lantern-small.png')
bpy.ops.render.render(write_still=True)
