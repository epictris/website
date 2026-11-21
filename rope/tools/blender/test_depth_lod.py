"""Retired depth settings must not coarsen a full-detail formation master."""
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).parent))
import bpy
from mathutils import Matrix
from formations import depth_lod, render, core, curve
from scene_export import preparation

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2)
ob=bpy.context.object
ob['formation_recipe']='{}'
ob['formation_depth_scale']=8.
ob['export_depth_lod']=True  # saved legacy file: no longer an active setting
original=core.mesh_hash(ob.data)
sharp=curve.find_bows(ob.data,41,0.)
for depth in (-100,0,30,1000):
    ob.matrix_world=Matrix.Translation((0,depth,0))
    bpy.context.scene[render.CAMERA]=json.dumps({'distance':10,'tanHalf':.2,'eye':[0,-10,0]})
    bpy.context.view_layer.update()
    assert render.detail_scale(ob)==1
    assert render.smallest_detail(ob,'export_chips')==0
    assert render.setting(ob,'export_depth_lod') is False
    assert depth_lod.policy(ob) is None and depth_lod.field(ob) is None
    assert depth_lod.partition(ob.data,ob)==0
    assert core.mesh_hash(ob.data)==original
    assert len(curve.find_bows(ob.data,41,render.smallest_detail(ob,'export_creases')))==len(sharp)
print('FULL_DETAIL_INDEPENDENT_OF_DEPTH_OK',flush=True)
