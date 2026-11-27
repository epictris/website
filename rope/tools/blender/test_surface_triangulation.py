"""Conflicting diagonals must preserve the polygon surface and manifold."""
from pathlib import Path
import sys
import bpy
import bmesh
import numpy as np

sys.path.insert(0, str(Path(__file__).parent / 'boulders'))
from triangulation import preserve_surface

bpy.ops.wm.read_factory_settings(use_empty=True)
# A cap over two chambers has a diagonal already used by the lower ridge.
# Ordinary triangulation merges that ridge with the cap's new diagonal.
vertices = [(-1., -1., 0.), (1., -1., 0.), (1., 1., 0.), (-1., 1., 0.)]
mesh = bpy.data.meshes.new('Chambers')
mesh.from_pydata(vertices, [], [(0, 1, 2, 3)])
mesh.calc_loop_triangles()
caps = [list(t.vertices) for t in mesh.loop_triangles]
faces = [(0, 1, 2, 3)]
for tri in caps:
    center = np.mean(np.array(vertices)[tri], axis=0)
    center[2] = -1.
    index = len(vertices)
    vertices.append(center.tolist())
    faces.extend((b, a, index) for a, b in zip(tri, tri[1:]+tri[:1]))
mesh.clear_geometry()
mesh.from_pydata(vertices, [], faces)
obj = bpy.data.objects.new('Chambers', mesh)
bpy.context.scene.collection.objects.link(obj)

def measure():
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    assert all(e.is_manifold for e in bm.edges)
    volume = bm.calc_volume(signed=True)
    area = sum(f.calc_area() for f in bm.faces)
    bm.free()
    return volume, area

before = measure()
assert preserve_surface(obj) > 0, 'Fixture must exercise a conflicting diagonal'
assert np.allclose(before, measure(), atol=1e-6)
assert all(len(p.vertices) == 3 for p in obj.data.polygons)
assert preserve_surface(obj) == 0
assert np.allclose(before, measure(), atol=1e-6)
print('SURFACE_TRIANGULATION_OK: conflicting diagonals, unchanged surface, manifold, idempotent', flush=True)
