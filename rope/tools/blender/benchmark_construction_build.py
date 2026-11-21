"""Bounded real formation rebuild into a separate output directory.

Blender arguments: -- SCENE.blend OBJECT OUTPUT_DIR [--legacy]
Use two low-priority CPU cores, Blender -t 2, OMP_NUM_THREADS=2, a timeout,
and --disable-autoexec. The source scene is only read. Output includes the
ordinary worker rock.blend/health.json and per-stage timings.json.
"""
import json
import os
from pathlib import Path
import resource
import runpy
import sys
import time

HERE=Path(__file__).parent
sys.path[:0]=[str(HERE),str(HERE/'boulders')]
import bpy
from formations import core, worker, solidfit, construction_lod

if len(os.sched_getaffinity(0))>2:
    raise RuntimeError('This check is limited to two CPU cores')
args=sys.argv[sys.argv.index('--')+1:]
source,name,directory=args[:3]
out=Path(directory).resolve();out.mkdir(parents=True,exist_ok=True)
if (out/'rock.blend').resolve()==Path(source).resolve():
    raise ValueError('Output must not overwrite the source scene')
bpy.ops.wm.open_mainfile(filepath=str(Path(source).resolve()),load_ui=False)
recipe=core.recipe_for(bpy.data.objects[name])
if recipe['generator']!='solid':
    raise ValueError('This benchmark is for a solid guide formation')
if '--legacy' in args:recipe['params']['adaptiveDepth']=False
worker.prepare(recipe,out)
stages=[]
original_init=solidfit.Cells.__init__
def init(self,*a,**kw):
    print('CONSTRUCTION_STAGE cells',flush=True)
    original_init(self,*a,**kw)
    print('CONSTRUCTION_CELLS',len(self.f),flush=True)
    if len(self.f)>800:raise RuntimeError('This check is limited to 800 cells')
solidfit.Cells.__init__=init
original_finish=construction_lod.finish
def finish(ob,*a,**kw):
    start=time.perf_counter()
    print('CONSTRUCTION_STAGE remesh',ob.name,flush=True)
    result=original_finish(ob,*a,**kw)
    report={**(result or {}),'name':ob.name,'seconds':time.perf_counter()-start}
    stages.append(report);print('CONSTRUCTION_REMESH',json.dumps(report),flush=True)
    return result
construction_lod.finish=finish
started=time.perf_counter()
sys.argv=['assemble.py','--',str(out)]
runpy.run_path(str(HERE/'formations/assemble.py'),run_name='__main__')
report={'source':str(Path(source).resolve()),'object':name,
        'adaptive':recipe['params'].get('adaptiveDepth',True),
        'seconds':time.perf_counter()-started,'peakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        'cpuCores':2,'stages':stages,
        'scope':'Complete construction, no scene export or texture bake. Legacy overrides can change stone layout and quality.'}
(out/'timings.json').write_text(json.dumps(report,indent=2))
print('CONSTRUCTION_BENCHMARK_OK',json.dumps(report),flush=True)
