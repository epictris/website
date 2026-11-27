"""Boulder slabs: shared primitive, surface orientation, overlap and asset scale."""
from pathlib import Path
import sys

import bpy
import bmesh
import numpy as np
from mathutils.bvhtree import BVHTree

sys.path[:0] = [str(Path(__file__).parent), str(Path(__file__).parent / 'boulders')]
from formations import surface_slabs, solidfit
from slab_geometry import Mesh, make_block


def assert_no_crossings(part):
    faces = part['faces']
    tree = BVHTree.FromPolygons(part['vertices'], faces, all_triangles=True)
    crossings = [(a, b) for a, b in tree.overlap(tree)
                 if a < b and not set(faces[a]).intersection(faces[b])]
    assert not crossings, (part['name'], crossings[:5])


# Broad, shallow slabs used to fold their end caps through each other.
# A closed manifold and positive volume alone do not catch that defect.
for seed in range(200):
    rng = np.random.default_rng(seed)
    width, thickness = rng.uniform(1.13, 1.87), rng.uniform(1.4, 2.8)
    yaw = np.radians(rng.uniform(-28, 28))
    slab = make_block(np.zeros(3), width, thickness, .5, yaw, rng, seed,
                      np.eye(3), Mesh, weathering=.38, min_end_separation=.25)
    assert_no_crossings(slab)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
guide = bpy.context.object
for v in guide.data.vertices:
    v.co *= 2
    v.co.z *= .25
guide.data.update()
p = solidfit.resolved({'jointed': False, 'seed': 31})
first, report = surface_slabs.geometry(guide, p)
assert first == surface_slabs.geometry(guide, p)[0]
assert report['slabs'] > 20
samples = surface_slabs.placements(guide, 1., 31)
floors, ratios = [], []
for part, (_, point, normal) in zip(first['parts'][1:], samples):
    assert_no_crossings(part)
    co = np.array(part['vertices'])
    local = (co-point) @ surface_slabs.frame(normal).T
    # The same shallow, buried-root construction works on floor, wall and
    # ceiling; it cannot turn upright on a floor like the Wall variant.
    outward = -local[:, 1]
    assert -.350001 <= outward.min() < -.349999
    assert .029999 <= outward.max() <= .230001
    me = bpy.data.meshes.new('Slab check')
    me.from_pydata(part['vertices'], [], part['faces'])
    bm = bmesh.new(); bm.from_mesh(me)
    assert all(e.is_manifold for e in bm.edges)
    assert bm.calc_volume(signed=True) > 0
    bm.free(); bpy.data.meshes.remove(me)
    if normal[2] > .99:
        floors.append(co)
        ratios.append(np.ptp(local[:, 2])/np.ptp(local[:, 0]))
assert len(floors) > 8
assert min(ratios) < 1.1 and max(ratios) > 1.6, ratios
assert np.ptp(ratios) > .6, ratios
assert any(np.all(np.minimum(a.max(0), b.max(0)) > np.maximum(a.min(0), b.min(0)))
           for i, a in enumerate(floors) for b in floors[i+1:]), 'Independent slabs must overlap'
# Placement belongs to the asset, not its camera or world transform.
guide.location = (71, -23, 15)
guide.rotation_euler = (.3, .2, .8)
assert surface_slabs.geometry(guide, p)[0] == first
assert surface_slabs.geometry(guide, dict(p, seed=105))[0] != first
for v in guide.data.vertices:
    v.co *= 2
guide.data.update()
scaled, scaled_report = surface_slabs.geometry(guide, dict(p, stoneSize=2))
assert scaled_report == report
for a, b in zip(first['parts'], scaled['parts']):
    assert np.allclose(np.array(a['vertices'])*2, b['vertices'], atol=1e-6)
# Opposite slabs must remain buried in a thin guide, rather than poking
# their roots through its other face.
for v in guide.data.vertices:
    v.co.z *= .075
guide.data.update()
thin, _ = surface_slabs.geometry(guide, p)
for part in thin['parts'][1:]:
    normal = np.array(part['surface_normal'])
    if abs(normal[2]) > .99:
        outward = (np.array(part['vertices'])-part['surface_point'])@normal
        assert -.120001 <= outward.min() <= -.119999
print('BOULDER_SHAPES_OK: overlapping irregular slabs, floor/wall orientation, bounded relief, deterministic asset scale', flush=True)
