"""Small closed crease fixture: remove teeth, preserve faces and attributes."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
import bpy
import bmesh
import numpy as np
from mathutils import Matrix
from formations import crease_cleanup


def coordinates(mesh):
    out = np.empty((len(mesh.vertices), 3))
    mesh.vertices.foreach_get('co', out.ravel())
    return out


bpy.ops.wm.read_factory_settings(use_empty=True)
# Two large planar faces joined by a narrow, uneven bevel. The middle
# section's extra setback produces the little triangular crease faces.
points = []
for z, width in zip((-1., -.5, 0., .5, 1.), (.005, .005, .025, .005, .005)):
    points.extend((x, y, z) for x, y in
                  ((-1, -1), (1-width, -1), (1, -1+width), (1, 1), (-1, 1)))
faces = [tuple(reversed(range(5))), tuple(range(20, 25))]
faces += [(5*k+i, 5*k+(i+1)%5, 5*(k+1)+(i+1)%5, 5*(k+1)+i)
          for k in range(4) for i in range(5)]
mesh = bpy.data.meshes.new('crease with a tooth')
mesh.from_pydata(points, [], faces)
bm = bmesh.new(); bm.from_mesh(mesh)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
bmesh.ops.dissolve_limit(bm, angle_limit=1e-5, verts=bm.verts[:], edges=bm.edges[:])
bm.to_mesh(mesh); bm.free(); mesh.update()
tag = mesh.attributes.new('facet', 'FLOAT', 'FACE')
values = np.linspace(0, 1, len(mesh.polygons), dtype=np.float32)
tag.data.foreach_set('value', values)
original = mesh.copy()
before = coordinates(mesh)
counts = (len(mesh.vertices), len(mesh.polygons))
crease = (before[:, 0] > .9) & (before[:, 1] < -.9) & (abs(before[:, 2]) < .6)
assert crease.any()
report = crease_cleanup.repair(mesh)
after = coordinates(mesh)
assert np.max(np.linalg.norm(after-before, axis=1)) <= .047501
assert np.max(abs(after[crease, 0]-1)) < .002
assert np.max(abs(after[crease, 1]+1)) < .002
assert np.array_equal(before[~crease], after[~crease]) or np.allclose(before[~crease], after[~crease], atol=.005)
assert counts == (len(mesh.vertices), len(mesh.polygons))
assert np.allclose([d.value for d in mesh.attributes['facet'].data], values)
bm = bmesh.new(); bm.from_mesh(mesh)
assert all(e.is_manifold for e in bm.edges)
assert all(f.calc_area() > 1e-12 for f in bm.faces)
assert bm.calc_volume() > 0
bm.free()
# Repair uses world metres even for a formation authored in a scaled frame.
frame = Matrix.Diagonal((2., .5, 3., 1.))
framed = original.copy(); framed.transform(frame.inverted())
crease_cleanup.repair(framed, frame); framed.transform(frame)
assert np.allclose(coordinates(framed), after, atol=2e-5)
small = original.copy(); small.transform(Matrix.Scale(.25, 4))
crease_cleanup.repair(small, scale=.25)
assert np.allclose(coordinates(small)/.25, after, atol=2e-5)
assert crease_cleanup.stone_scale({'formation_recipe': '{"params":{"stoneSize":2}}'}) == 1.
assert crease_cleanup.stone_scale({'formation_recipe': '{"params":{"stoneSize":0.25}}'}) == .25
# A broad but warped polygon cannot be used as a supporting plane.
warped = bpy.data.meshes.new('warped support')
warped.from_pydata([(0,0,-1),(0,0,1),(-1,0,1),(-1,.1,-1),(0,1,1),(0,1,-1)],
                   [], [(0,1,2,3),(1,0,5,4)])
warped.update()
untouched = coordinates(warped)
crease_cleanup.repair(warped)
assert np.array_equal(coordinates(warped), untouched)
assert crease_cleanup.applies({'formation_recipe': json.dumps({'generator': 'solid', 'params': {}})})
assert not crease_cleanup.applies({'formation_recipe': json.dumps({'generator': 'solid', 'params': {'adaptiveDepth': False}})})
assert not crease_cleanup.applies({'formation_recipe': '{'})
assert not crease_cleanup.applies({'formation_recipe': json.dumps({'generator': 'boulders'})})
print('CREASE_CLEANUP_OK', report, 'closed surface, bounded movement, attributes and world frame preserved', flush=True)
