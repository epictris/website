"""Bounded Blender integration checks for offline formation depth budgets."""
import json
from pathlib import Path
import sys
import time
sys.path.insert(0,str(Path(__file__).parent))

import bpy
import bmesh
import numpy as np
from mathutils import Matrix
from formations import depth_lod, render, slate, curve
from scene_export import bake_maps, unwrap, preparation, BAKE_UV

bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene
camera={'distance':10.2375,'tanHalf':12/70,'eye':[0,-10.2375,0]}
scene[render.CAMERA]=json.dumps(camera)
bpy.ops.mesh.primitive_cube_add(size=2)
ob=bpy.context.object
ob.name='Depth budget regression'
ob['formation_recipe']='{}'
ob['formation_depth_scale']=4.
ob['export_map_max']=512
ob['export_texels']=32.
# World depths span sharp foreground to blurred background. The object is
# rotated and nonuniformly scaled; local Y is deliberately not world depth.
ob.matrix_world=Matrix.Translation((3,10,1)) @ Matrix.Rotation(.32,4,'Z') @ Matrix.Diagonal((2,12,1,1))
bpy.context.view_layer.update()
mesh=ob.data
mesh.materials.append(slate.painted_slate())
facet=mesh.attributes.new('facet','FLOAT','FACE')
facet.data.foreach_set('value',np.full(len(mesh.polygons),.375,np.float32))
before=sum(p.area for p in mesh.polygons)
vertices=len(mesh.vertices)
assert render.detail_scale(ob)==1
assert callable(render.smallest_detail(ob,'export_chips'))
ob['export_chips']=True
assert render.smallest_detail(ob,'export_chips')==0
del ob['export_chips']
key=preparation(ob)
scene[render.CAMERA]=json.dumps({**camera,'distance':camera['distance']*.9})
assert preparation(ob)!=key
scene[render.CAMERA]=json.dumps(camera)
for prop,value in [('detail_scale',2.),('export_maps',1),('export_depth_lod',False)]:
    ob[prop]=value
    assert depth_lod.policy(ob) is None
    del ob[prop]
t=time.perf_counter()
added=depth_lod.partition(mesh,ob)
assert added>0 and len(mesh.vertices)>vertices
assert abs(sum(p.area for p in mesh.polygons)-before)<1e-5
assert all(abs(v.value-.375)<1e-6 for v in mesh.attributes['facet'].data)
bm=bmesh.new();bm.from_mesh(mesh)
assert all(e.is_manifold for e in bm.edges), 'Depth cuts opened the surface'
bm.free()
assert all(np.isfinite(n.vector).all() for n in mesh.corner_normals)
seen=np.ones(len(mesh.polygons),bool)
adaptive=bake_maps(mesh,ob,seen)
map_bands=np.array(ob['formation_lod_map_bands'])
assert len(set(map_bands))>=3
assigned=unwrap(ob,seen,adaptive,adaptive)
band=np.array([d.value for d in mesh.attributes[depth_lod.FACE_BAND].data])
assert np.array_equal(map_bands[assigned],band), 'UV atlas mixed depth budgets'
assert np.isfinite([tuple(v.uv) for v in mesh.uv_layers[BAKE_UV].data]).all()
f=depth_lod.field(ob)
# A feature spanning sharp and blurred depths takes its nearest depth.
inv=ob.matrix_world.inverted()
from mathutils import Vector
near=inv@Vector((3,0,1));far=inv@Vector((3,30,1))
assert f([near,far])==0 and f([far])>0
scene[render.CAMERA]=json.dumps({**camera,'eye':[100,-camera['distance'],200]})
assert preparation(ob)==key, 'Panning invalidated the offline policy'
print('DEPTH_LOD_OK',{'bands':map_bands.tolist(),'maps':adaptive,'partitionAndUnwrapSeconds':time.perf_counter()-t},flush=True)

# One connected real-style mesh at two depths: bows must be omitted before
# their expensive triangulation, without changing the near feature threshold.
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,30,0))
far_ob=bpy.context.object;far_ob['formation_recipe']='{}'
bpy.context.view_layer.update()
sharp=curve.find_bows(far_ob.data,41,0.)
blurred=curve.find_bows(far_ob.data,41,render.smallest_detail(far_ob,'export_creases'))
assert len(sharp)>len(blurred)
print('DEPTH_FEATURE_SKIP_OK',len(sharp),len(blurred),flush=True)

# Retained large bends use fewer triangles in the distance, but the same
# displacement field. A near support keeps exactly the original sizing.
budget=depth_lod.policy(far_ob)
samples=np.array([[0.,0.,0.],[.25,0.,0.]])
bow=(Vector((-1,0,0)),Vector((1,0,0)),Vector((0,0,.18)),2.)
uniform=curve.Bows([bow])
near_bows=curve.BowList(depth_lod.Field(budget,Matrix.Identity(4)));near_bows.append(bow)
far_bows=curve.BowList(depth_lod.Field(budget,Matrix.Translation((0,30,0))));far_bows.append(bow)
near_native,far_native=curve.Bows(near_bows),curve.Bows(far_bows)
assert np.array_equal(uniform.native.sizing(samples),near_native.native.sizing(samples))
assert (far_native.native.sizing(samples)>uniform.native.sizing(samples)).all()
assert np.array_equal(uniform.native.eval(samples),far_native.native.eval(samples))
print('DEPTH_TESSELLATION_OK',flush=True)
