"""Run the real-rock preview bake on two low-priority CPU cores, never the GPU."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('output',type=Path)
parser.add_argument('source',type=Path)
args=parser.parse_args()
os.sched_setaffinity(0,set(sorted(os.sched_getaffinity(0))[:2]));os.nice(10)
with tempfile.TemporaryDirectory(prefix='lod-material-config-') as config:
    env=dict(os.environ,OMP_NUM_THREADS='2',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',
             BLENDER_USER_RESOURCES=config,BLENDER_USER_CONFIG=config)
    subprocess.run([shutil.which('blender'),'-b','--factory-startup','-noaudio','-t','2','--python-exit-code','1',
                    '--python',str(Path(__file__).with_name('bake_actual.py')),'--',
                    str(args.output.resolve()),str(args.source.resolve())],env=env,check=True,timeout=600)
