import bpy
from mathutils import Vector
from pathlib import Path
out=Path(__file__).resolve().parents[3]/'assets-src/studies/mineshaft'
s=bpy.context.scene
for collection in s.collection.children:collection.hide_render=False
s.render.resolution_x=1500;s.render.resolution_y=1000;s.cycles.samples=32
c=s.camera
c.location=(7,-8,5.5);c.rotation_euler=(Vector((2.6,1.8,.85))-c.location).to_track_quat('-Z','Y').to_euler();c.data.ortho_scale=5.3
s.render.filepath=str(out/'props-detail.png');bpy.ops.render.render(write_still=True)
c.location=(.2,-20,5.4);c.rotation_euler=(Vector((.2,0,1.35))-c.location).to_track_quat('-Z','Y').to_euler();c.data.ortho_scale=11
s.render.filepath=str(out/'front-view.png');bpy.ops.render.render(write_still=True)
