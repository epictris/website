"""Show the three individually placeable assets from their saved library files."""
import bpy
from pathlib import Path
from mathutils import Vector
root=Path(__file__).resolve().parents[3]
s=bpy.context.scene
for c in s.collection.children:
 if c.name!='guide.presentation':c.hide_render=True
for o in bpy.data.collections['guide.presentation'].objects:
 if o.type not in ['CAMERA','LIGHT'] and o.name!='Display ground':o.hide_render=True
for i,name in enumerate(['mine-sleeper-a','mine-sleeper-b','mine-sleeper-c']):
 with bpy.data.libraries.load(str(root/'assets-src/models'/(name+'.blend')),link=False) as (src,dst):dst.collections=[name]
 c=dst.collections[0];c.asset_clear();s.collection.children.link(c)
 for o in c.objects:o.location.x=i*.75-.75
s.camera.location=(2.7,-3.5,3.5);s.camera.rotation_euler=(Vector((0,0,.05))-s.camera.location).to_track_quat('-Z','Y').to_euler();s.camera.data.ortho_scale=3.6
s.render.resolution_x=1400;s.render.resolution_y=1100;s.cycles.samples=48
s.render.filepath=str(root/'assets-src/studies/mineshaft/sleeper-assets.png');bpy.ops.render.render(write_still=True)
