"""Reject aliased detail triangles before removing their original surface."""
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import bmesh
import bpy
from formations import detail

source = bmesh.new()
bmesh.ops.create_cube(source, size=1.)
source.normal_update()
cdt = detail.delaunay_2d_cdt
injected = 0


def duplicate_triangle(*args, **kwargs):
    global injected
    result = list(cdt(*args, **kwargs))
    if result[2]:
        result[2] = list(result[2]) + [result[2][0]]
        injected += 1
    return tuple(result)


detail.delaunay_2d_cdt = duplicate_triangle
try:
    mesh, stats = detail.crumple(source, random.Random(31))
finally:
    detail.delaunay_2d_cdt = cdt
assert injected > 0
assert stats['rebuilt'] == 0 and stats['skipped'] >= injected
assert all(e.is_manifold for e in mesh.edges)
assert all(f.calc_area() > 1e-12 for f in mesh.faces)
assert abs(mesh.calc_volume() - source.calc_volume()) < 1e-6
mesh.free()
source.free()
# A welded detail mesh may contain two coincident triangles. Make the
# lookup's first face the patch being replaced: checking that face alone
# misses the second owner, which survives deletion of the patch.
data = bpy.data.meshes.new('coincident detail faces')
data.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [], [(0, 1, 2)] * 2)
source = bmesh.new(); source.from_mesh(data); source.normal_update()
regions, split = detail.plane_regions, detail.split_long_edges
detail.plane_regions = lambda bm, band=None: [[bm.faces.get(bm.verts[:])]]
detail.split_long_edges = lambda *args: 0
detail.delaunay_2d_cdt = lambda coords, *args: (coords, [], [[0, 1, 2]],
                                             [[i] for i in range(len(coords))], [], [])
try:
    mesh, stats = detail.crumple(source, random.Random(31))
finally:
    detail.plane_regions, detail.split_long_edges = regions, split
    detail.delaunay_2d_cdt = cdt
assert stats['rebuilt'] == 0 and stats['skipped'] == 1
assert len(mesh.faces) == 2
mesh.free(); source.free(); bpy.data.meshes.remove(data)
print('DETAIL_DUPLICATE_PATCH_OK: rejected patches retain a closed surface', flush=True)
