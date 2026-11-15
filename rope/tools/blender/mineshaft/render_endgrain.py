"""Inspect the crosscut faces on the independently placeable sleeper variants."""
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
    with bpy.data.libraries.load(str(root/'assets-src/models'/(name+'.blend')),link=False) as (src,dst):
        dst.collections=[name]
    c=dst.collections[0];c.asset_clear();s.collection.children.link(c)
    for o in c.objects:o.location.x=i*.60-.60
target=Vector((0,-.84,.10))
s.camera.location=(.7,-3.7,1.05)
s.camera.rotation_euler=(target-s.camera.location).to_track_quat('-Z','Y').to_euler()
s.camera.data.ortho_scale=2.2
s.render.resolution_x=1600;s.render.resolution_y=800;s.cycles.samples=48
s.render.filepath=str(root/'assets-src/studies/mineshaft/endgrain-detail.png')
bpy.ops.render.render(write_still=True)
