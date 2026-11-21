"""Bounded geometry and policy regression; run with Blender on two CPU cores."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
import numpy as np
import bpy,bmesh
from formations.solidfit import Camera, Cells, PARAMS, _modifier
from formations.construction_lod import Warp, resolution, finish, coordinates

camera=Camera((0,-10,0),10,12/70)
co=np.array([[x,y,z] for x in (-1.,1.) for y in (0.,30.) for z in (-.6,.6)])
warp=Warp.plan(co,camera,.012)
assert warp.slope>0
rng=np.random.default_rng(14)
points=rng.uniform(co.min(0),co.max(0),(5000,3))
assert np.allclose(warp.inverse(warp.forward(points)),points,atol=1e-12)
# A complete large polygon stays planar without pre-subdivision.
plane=points.copy();plane[:,2]=.3
q=warp.forward(plane)
assert np.linalg.svd(q-q.mean(0),compute_uv=False)[-1]<1e-10
assert (warp.voxel*warp.stretch(points[:,1]) <= resolution(camera,points[:,1],.012)+1e-12).all()
assert warp.voxel*warp.stretch(30)>2*warp.voxel*warp.stretch(0)
# Panning the camera cannot alter world-depth construction budgets.
panned=Camera((100,-10,200),10,12/70)
other=Warp.plan(co,panned,.012)
assert other.slope==warp.slope and other.voxel==warp.voxel
# Legacy controls no longer influence automatic stone construction.
cells=Cells.__new__(Cells);cells.camera=camera;cells.p={**PARAMS,'floor':5.,'fixedScale':8.}
assert cells.scale(0)==1 and cells.scale(30)==4
cells.p['adaptiveDepth']=False
assert cells.scale(0)==8

bpy.ops.wm.read_factory_settings(use_empty=True)
mesh=bpy.data.meshes.new('roof beam')
mesh.from_pydata(co.tolist(),[],[(0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)])
bm=bmesh.new();bm.from_mesh(mesh);bmesh.ops.recalc_face_normals(bm,faces=bm.faces[:]);bm.to_mesh(mesh);bm.free()
ob=bpy.data.objects.new('roof beam',mesh);bpy.context.scene.collection.objects.link(ob)
import time,json
t=time.perf_counter();report=finish(ob,camera,.04,iterations=1,density=200)
elapsed=time.perf_counter()-t
mesh=ob.data
bm=bmesh.new();bm.from_mesh(mesh)
assert all(e.is_manifold for e in bm.edges)
assert bm.calc_volume()>0
bm.free()
out=coordinates(mesh)
assert np.isfinite(out).all()
assert np.max(np.abs(out.min(0)-co.min(0)))<.15
assert np.max(np.abs(out.max(0)-co.max(0)))<.3
print('CONSTRUCTION_LOD_OK',json.dumps({**report,'seconds':elapsed}),flush=True)

