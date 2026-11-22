"""Wide flat guides must use their surface normal and retain real relief.

Run with factory background Blender, as the other formation tests.
"""
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

sys.path[:0] = [str(Path(__file__).parent), str(Path(__file__).parent / 'boulders')]
from formations import solidfit

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
guide = bpy.context.object
for v in guide.data.vertices:
    v.co.x *= 5
    v.co.z *= 3
guide.data.update()
cells = solidfit.Cells(guide, solidfit._tree(guide), None,
                      solidfit.resolved({'seed': 31}), solidfit._boulders()[0],
                      np.random.default_rng(31), {}, guide=guide)
# The nearest face CENTRE here is the right cap, but the actual surface is
# the front. Check all quadrants, outside the central face-centre region.
for x in (-4.6, -3., 3., 4.6):
    for z in (-2.6, 0., 2.6):
        n = cells._normal(Vector((x, -1., z)), .2)
        assert np.allclose(n, (0, -1, 0)), (x, z, n)

# Relief is independent of the old shared ridge, deterministic, bounded,
# and scales physically with the stone size.
taper = cells._taper(np.array([3., -.95, 0.]), np.random.default_rng(9))
points = np.array([[3+x, -1., z] for x in (-.4, 0., .4) for z in (-.4, 0., .4)])
shallow = dict(taper, relief=0)
delta = solidfit.sink(taper, points) - solidfit.sink(shallow, points)
assert np.ptp(delta) > .05, delta
assert delta.min() < -.1, delta
# At the default 0.5 the shared roof field is fully gone, including far
# outside this cell: the guard can rely on bounded cleavage displacement.
extreme = np.array([[x, -1., z] for x in (-100., 100.) for z in (-100., 100.)])
bounded = solidfit.sink(taper, extreme)
assert bounded.min() >= -taper['relief']*taper['k']
assert bounded.max() <= .35*taper['relief']*taper['k']
scaled = dict(taper, centre=taper['centre']*2, k=taper['k']*2, r=taper['r']*2)
assert np.allclose(solidfit.sink(scaled, points*2), solidfit.sink(taper, points)*2)
print('SOLID_RELIEF_OK: wide-guide normals, depth variation, bounds and physical scaling', flush=True)
