"""Run only the bounded synthetic experiment, on one low-priority CPU core."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    blender = shutil.which('blender')
    if not blender:
        parser.error('Blender is required')
    if not shutil.which('bun'):
        parser.error('bun and rope/node_modules/meshoptimizer are required')
    # Children inherit the affinity, including libraries that ignore -t/OMP.
    os.sched_setaffinity(0, {min(os.sched_getaffinity(0))})
    os.nice(10)
    env = dict(os.environ, OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1',
               MKL_NUM_THREADS='1', BLIS_NUM_THREADS='1', NUMEXPR_NUM_THREADS='1')
    script = Path(__file__).with_name('demo.py')
    with tempfile.TemporaryDirectory(prefix='lod-blender-config-') as config:
        env['BLENDER_USER_CONFIG'] = config
        env['BLENDER_USER_RESOURCES'] = config
        subprocess.run([blender, '-b', '--factory-startup', '-noaudio', '-t', '1', '--python-exit-code', '1',
                        '--python', str(script), '--', '--output', str(args.output.resolve())],
                       env=env, check=True, timeout=90)


if __name__ == '__main__':
    main()
