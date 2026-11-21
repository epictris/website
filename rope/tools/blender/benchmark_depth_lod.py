"""Bounded before/after generation measurements on real authored geometry.

Use a spatial sample of one rock; no scene export, baking or file save. Compare
uniform foreground-quality detail with automatic High-DOF detail on identical
inputs. The existing coarse stone assembly/remesh is outside this measurement.
"""
import json
import os
from pathlib import Path
import sys
import time
sys.path.insert(0,str(Path(__file__).parent))
import bpy
import bmesh
import numpy as np
from formations import render, depth_lod, curve, detail
from surface_subdivision import split_large_faces
import scene_export as export

if len(os.sched_getaffinity(0))>2:
    raise RuntimeError('Run this benchmark on at most two CPU cores')
args=sys.argv[sys.argv.index('--')+1:]
scene_file,report_file=map(Path,args[:2])
sample_limit=int(args[2]) if len(args)>2 else 12000
if not 1<=sample_limit<=250000:
    raise ValueError('Benchmark limit must be between 1 and 250000 faces')
bpy.ops.wm.open_mainfile(filepath=str(scene_file.resolve()),load_ui=False)
source=bpy.data.objects['Cube.005']
original_count=len(source.data.polygons)
mesh=source.data.copy()
# Spatially contiguous sample, not arbitrary every-Nth faces. Retain the
# authored depth range while bounding the Python high-poly work and memory.
bm=bmesh.new();bm.from_mesh(mesh)
ordered=sorted(bm.faces,key=lambda f:f.calc_center_median().x)
bmesh.ops.delete(bm,geom=ordered[sample_limit:],context='FACES')
bm.to_mesh(mesh);bm.free()
while mesh.uv_layers:
    mesh.uv_layers.remove(mesh.uv_layers[0])
sample_count=len(mesh.polygons)
depths=[(source.matrix_world@v.co).y for v in mesh.vertices]
results={}
for adaptive in (False,True):
    ob=source.copy();ob.data=mesh.copy();bpy.context.scene.collection.objects.link(ob)
    for key in ('detail_scale','export_maps',*render.PASSES):
        ob.pop(key,None)
    ob['export_depth_lod']=adaptive
    if not adaptive:ob['detail_scale']=1.
    ob['export_texels']=512.
    bpy.context.view_layer.update()
    label='adaptive' if adaptive else 'uniform_foreground'
    started=time.perf_counter();stages={}
    print('BENCHMARK_STAGE',label,'curves',flush=True)
    t=time.perf_counter()
    bows=curve.find_bows(ob.data,31,render.smallest_detail(ob,'export_creases'))
    crease_report=curve.rebuild_mesh(ob.data,bows,31,smooth=True)
    stages['curves']=time.perf_counter()-t
    t=time.perf_counter();depth_lod.partition(ob.data,ob);split_large_faces(ob.data,ob)
    stages['partition']=time.perf_counter()-t
    t=time.perf_counter()
    seen=export.seen_faces(ob.data,ob.matrix_world)
    maps=export.bake_maps(ob.data,ob,seen)
    stages['texturePlanning']=time.perf_counter()-t
    print('BENCHMARK_STAGE',label,'detail geometry',flush=True)
    t=time.perf_counter()
    high=detail.detail_geometry(ob.data,ob.matrix_world,31,render.smallest_detail(ob,'export_chips'))
    stages['detailGeometry']=time.perf_counter()-t
    results[label]={'seconds':time.perf_counter()-started,'stages':stages,'bows':len(bows),
                    'meshFaces':len(ob.data.polygons),'highTriangles':len(high['htri']),
                    'chips':high['placed'],'subfacetPoints':high['stats']['points'],
                    'allocatedColourTexels':sum(s*s for s in maps),'maps':maps,'creaseReport':crease_report}
    print('BENCHMARK_RESULT',label,json.dumps(results[label]),flush=True)
    del high
    data=ob.data;bpy.data.objects.remove(ob,do_unlink=True);bpy.data.meshes.remove(data)

# All-foreground control: spatial budgeting must retain the exact detail mesh.
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=.2,location=(0,.5,0))
control=bpy.context.object;control['formation_recipe']='{}'
bpy.context.view_layer.update()
sharp=detail.detail_geometry(control.data,control.matrix_world,41,0.)
depth_lod.partition(control.data,control)
adaptive=detail.detail_geometry(control.data,control.matrix_world,41,render.smallest_detail(control,'export_chips'))
assert np.array_equal(sharp['hco'],adaptive['hco'])
assert np.array_equal(sharp['htri'],adaptive['htri'])
assert sharp['placed']==adaptive['placed']
report={'source':'Cube.005','sourceFaces':original_count,'sampleFaces':sample_count,
        'worldDepthRange':[min(depths),max(depths)],
        'scope':'Spatial sample; surface geometry generation and atlas planning only, no coarse guide/remesh, UV packing or texture bake.',
        'cpuCores':2,'foregroundControl':'identical detail geometry','results':results}
report_file.write_text(json.dumps(report,indent=2))
print('DEPTH_BENCHMARK_OK',report_file,flush=True)
