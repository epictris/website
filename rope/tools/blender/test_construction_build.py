"""Small complete solid build, including old-recipe migration and mesh health."""
import json,math,os,sys,time,tempfile,runpy
from pathlib import Path
HERE=Path(__file__).parent
sys.path[:0]=[str(HERE),str(HERE/'boulders')]
import bpy,bmesh
from formations import solidfit,worker,params,render
from mathutils import Matrix

if len(os.sched_getaffinity(0))>2:
    raise RuntimeError('Run construction checks on at most two CPU cores')
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2)
guide=bpy.context.object
for v in guide.data.vertices:
    v.co.x*=.8;v.co.y=(v.co.y+1)*6;v.co.z*=.55
recipe={'generator':'solid','frame':[list(row) for row in Matrix.Identity(4)],
        'camera':{'eye':[0,-10,0],'distance':10,'tanHalf':12/70},
        'guide':{'verts':[list(v.co) for v in guide.data.vertices],
                 'faces':[list(p.vertices) for p in guide.data.polygons]},
        'params':{'seed':31,'floor':4.,'fixedScale':6.}}
guide['formation_recipe']=json.dumps(recipe)
assert params.changed(guide), 'Old construction did not become pending for regeneration'
with tempfile.TemporaryDirectory(prefix='construction-lod-test-') as path:
    worker.prepare(recipe,Path(path))
    recipe=json.loads((Path(path)/'recipe.json').read_text())
assert recipe['params']['adaptiveDepth'] is True
guide['formation_recipe']=json.dumps(recipe)
assert not params.changed(guide)
assert params.FIELDS['solid']['adaptiveDepth']=='adaptive_depth'
legacy='--legacy' in sys.argv
if legacy:recipe['params'].update(adaptiveDepth=False,floor=0.,fixedScale=1.)
for name in ('build_core','grown','clean'):
    original=getattr(solidfit,name)
    def report(*args,_name=name,_fn=original,**kw):
        print('CONSTRUCTION_STAGE',_name,flush=True)
        return _fn(*args,**kw)
    setattr(solidfit,name,report)
t=time.perf_counter()
with tempfile.TemporaryDirectory(prefix='construction-worker-test-') as path:
    worker.prepare(recipe,Path(path))
    # Exercise the actual worker's microscopic-face cleanup and validation,
    # which also run for legacy geometry before it can replace a formation.
    sys.argv=['assemble.py','--',path]
    runpy.run_path(str(HERE/'formations/assemble.py'),run_name='__main__')
    rock=bpy.data.objects['SceneryRock']
scale=rock[render.DEPTH_SCALE]
bm=bmesh.new();bm.from_mesh(rock.data)
assert all(e.is_manifold for e in bm.edges)
assert abs(bm.calc_volume())>0
assert all(f.calc_area()>1e-12 for f in bm.faces)
assert all(math.isfinite(c) for v in bm.verts for c in v.co)
bm.free()
if legacy:
    assert scale==1., 'Explicit legacy construction changed its fixed scale'
else:
    assert 1<scale<2.5, 'Legacy fixedScale/floor leaked into automatic construction'
print('CONSTRUCTION_BUILD_OK',json.dumps({'faces':len(rock.data.polygons),'scale':scale,
      'legacy':legacy,'seconds':time.perf_counter()-t}),flush=True)
