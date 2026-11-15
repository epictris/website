"""An isolated close view of the painted sleeper/rail assembly."""
import bpy
from mathutils import Vector
from pathlib import Path
s=bpy.context.scene
for c in s.collection.children:
 if c.name not in ['mine-rail-straight','guide.presentation']:c.hide_render=True
for o in bpy.data.collections['guide.presentation'].objects:
 if o.type not in ['CAMERA','LIGHT'] and o.name!='Display ground':o.hide_render=True
s.camera.location=(.8,-5.4,4.5)
s.camera.rotation_euler=(Vector((-1.6,-1.4,.15))-s.camera.location).to_track_quat('-Z','Y').to_euler()
s.camera.data.ortho_scale=4.5
s.render.resolution_x=1500;s.render.resolution_y=1000;s.cycles.samples=64
s.render.filepath=str(Path(__file__).resolve().parents[3]/'assets-src/studies/mineshaft/rails-detail.png')
bpy.ops.render.render(write_still=True)
