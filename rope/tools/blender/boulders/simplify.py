"""Bounded-error simplification of the solid Boulder's dense sampling mesh."""
import json
from pathlib import Path
import subprocess
import tempfile

import bpy
import numpy as np


def simplify(obj, target, error):
    mesh = obj.data
    mesh.calc_loop_triangles()
    positions = np.empty((len(mesh.vertices), 3), dtype=np.float32)
    mesh.vertices.foreach_get('co', positions.ravel())
    triangles = np.empty((len(mesh.loop_triangles), 3), dtype=np.uint32)
    mesh.loop_triangles.foreach_get('vertices', triangles.ravel())
    with tempfile.TemporaryDirectory(prefix='boulder-simplify-') as directory:
        folder = Path(directory)
        positions.tofile(folder / 'positions.bin')
        triangles.tofile(folder / 'indices.bin')
        process = subprocess.run(['bun', str(Path(__file__).with_suffix('.mjs')),
                                  directory, str(max(4, int(target))), str(error)],
                                 check=True, capture_output=True, text=True)
        indices = np.fromfile(folder / 'result.bin', dtype=np.uint32)
        stats = json.loads(process.stdout)
    if not len(indices) or len(indices) % 3 or indices.max() >= len(positions):
        raise ValueError('Surface simplifier returned invalid triangles')
    used, compact = np.unique(indices, return_inverse=True)
    result = bpy.data.meshes.new(mesh.name+' simplified')
    result.vertices.add(len(used))
    result.vertices.foreach_set('co', positions[used].ravel())
    result.loops.add(len(compact))
    result.loops.foreach_set('vertex_index', compact.astype(np.int32))
    result.polygons.add(len(compact)//3)
    result.polygons.foreach_set('loop_start', np.arange(0, len(compact), 3, dtype=np.int32))
    result.polygons.foreach_set('loop_total', np.full(len(compact)//3, 3, dtype=np.int32))
    for material in mesh.materials:
        result.materials.append(material)
    result.update(calc_edges=True)
    obj.data = result
    if not mesh.users:
        bpy.data.meshes.remove(mesh)
    return stats
