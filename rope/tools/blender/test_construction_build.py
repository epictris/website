"""Full-detail solid master in an empty file, through worker cleanup/validation."""
import json
import math
import os
from pathlib import Path
import runpy
import sys
import tempfile

HERE=Path(__file__).parent
sys.path[:0]=[str(HERE),str(HERE/'boulders')]
import bpy,bmesh
from formations import solidfit,worker,params,render,core
from mathutils import Matrix

if len(os.sched_getaffinity(0))>2:
    raise RuntimeError('Run construction checks on at most two CPU cores')
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1.5)
guide=bpy.context.object
recipe={'generator':'solid',
        'guide':{'verts':[list(v.co) for v in guide.data.vertices],
                 'faces':[list(p.vertices) for p in guide.data.polygons]},
        'params':{'seed':31,'floor':4.,'fixedScale':6.,'adaptiveDepth':True}}
with tempfile.TemporaryDirectory(prefix='construction-master-test-') as path:
    worker.prepare(recipe,Path(path))
    resolved=json.loads((Path(path)/'recipe.json').read_text())
    assert 'camera' not in resolved and 'frame' not in resolved
    assert not {'floor','fixedScale','adaptiveDepth'} & resolved['params'].keys()
    sys.argv=['assemble.py','--',path]
    runpy.run_path(str(HERE/'formations/assemble.py'),run_name='__main__')
    rock=bpy.data.objects['SceneryRock']
    assert rock[render.DEPTH_SCALE]==1
    assert core.validate_worker(rock)
    assert not core.pending(rock)
    before=core.recipe_for(rock)
    rock.matrix_world=Matrix.Translation((800,-600,300)) @ Matrix.Diagonal((2,3,4,1))
    bpy.context.scene[core.CAMERA]=json.dumps({'eye':[0,1000,0], 'distance':1})
    assert core.recipe_for(rock)==before
    assert not core.pending(rock), 'Placement/camera must not invalidate an asset master'
    assert render.detail_scale(rock)==1 and render.smallest_detail(rock,'export_chips')==0
    assert not params.changed(rock)
    print('CONSTRUCTION_MASTER_OK',len(rock.data.polygons),'faces',flush=True)
