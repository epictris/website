"""Wall construction: shared slabs, repeatability, vertical grain and asset scale."""
import sys
from pathlib import Path
import bpy
import numpy as np

sys.path[:0] = [str(Path(__file__).parent), str(Path(__file__).parent/'boulders')]
from formations import wall, worker

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
guide = bpy.context.object
for v in guide.data.vertices:
    v.co.x *= 3
    v.co.z *= 2
guide.data.update()
p = dict(worker.GENERATORS['solid'], wall=True, jointed=False, seed=31)
first, report = wall.geometry(guide, p)
again, _ = wall.geometry(guide, p)
assert first == again
assert report['slabs'] > 10
assert 'clip' not in first
# The broad front/back slabs extend vertically. Stones intersect their
# backing and one another, instead of occupying a disjoint cell partition.
front = []
for part in first['parts'][1:]:
    co = np.array(part['vertices'])
    if abs(co[:, 1].mean()) > .8 and abs(co[:, 0].mean()) < 2.6 and abs(co[:, 2].mean()) < 1.8:
        front.append(co)
assert len(front) > 5
assert np.median([np.ptp(c[:, 2])/np.ptp(c[:, 0]) for c in front]) > 1.5
assert any(np.all(np.minimum(a.max(0), b.max(0)) > np.maximum(a.min(0), b.min(0)))
           for i, a in enumerate(front) for b in front[i+1:])
# Caps have upright broken ends, never horizontal slabs forming a shelf.
samples = wall.placements(guide, 1., p['jointAspect'], p['seed'])
for part, (_, normal) in zip(first['parts'][1:], samples):
    if abs(normal[2]) > .99:
        co = np.array(part['vertices'])
        assert np.ptp(co[:, 2]) > np.ptp(co[:, 0])*1.5
for part in first['parts'][1:]:
    z = np.array(part['vertices'])[:, 2]
    assert z.min() >= -2.220001 and z.max() <= 2.220001
# The stone metric scales with the geometry, independent of object placement.
guide.location = (71, -23, 15)
guide.rotation_euler = (.3, .2, .8)
assert wall.geometry(guide, p)[0] == first
for v in guide.data.vertices:
    v.co *= 2
guide.data.update()
scaled, scaled_report = wall.geometry(guide, dict(p, stoneSize=2))
assert scaled_report == report
for a, b in zip(first['parts'], scaled['parts']):
    assert np.allclose(np.array(a['vertices'])*2, b['vertices'], atol=1e-6)
print('WALL_ROCK_OK: shared overlapping slabs, deterministic vertical grain, physical scale', flush=True)
