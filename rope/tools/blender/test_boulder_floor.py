"""Boulder floors: shallow slate relief through the real worker and cleanup.

blender -b --factory-startup -t 8 --python-exit-code 1 \
  --python tools/blender/test_boulder_floor.py
"""
import json
from pathlib import Path
import runpy
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Vector

HERE = Path(__file__).parent
sys.path[:0] = [str(HERE), str(HERE / 'boulders')]
from formations import solidfit, worker

for seed, size, opening, thickness, controls in (
        (31, 1., False, 1., {}), (105, .65, False, 1., {}),
        (31, 1., True, 1., {}), (34, 1., False, .15, {}),
        (31, 1., True, 1., {'slabWidth': 2., 'slabLength': 3., 'weathering': 1., 'fractureDensity': 1.5})):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cube_add()
    guide = bpy.context.object
    for v in guide.data.vertices:
        v.co.x *= 2
        v.co.y *= 1.5
        v.co.z = (v.co.z - 1) * .5 * thickness
    guide.data.update()
    if opening:
        bpy.ops.mesh.primitive_cube_add(location=(0, 0, -.5))
        cutter = bpy.context.object
        cutter.scale = (.7, .7, 2.)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        solidfit._boolean(guide, cutter, 'DIFFERENCE')
        bpy.data.objects.remove(cutter, do_unlink=True)
    recipe = {'generator': 'solid', 'variant': 'boulder',
              'guide': {'verts': [list(v.co) for v in guide.data.vertices],
                        'faces': [list(p.vertices) for p in guide.data.polygons]},
              'params': {'seed': seed, 'stoneSize': size, **controls}}
    with tempfile.TemporaryDirectory(prefix='boulder-floor-') as folder:
        worker.prepare(recipe, Path(folder))
        sys.argv = ['assemble.py', '--', folder]
        runpy.run_path(str(HERE / 'formations/assemble.py'), run_name='__main__')
        # assemble.py validates the finished mesh; also guard against islands
        # and open seams after the union, remesh and facet dissolve.
        health = json.loads((Path(folder) / 'health.json').read_text())
        master = json.loads(bpy.data.objects['SceneryRock']['formation_recipe'])
        for key, value in controls.items():
            assert master['params'][key] == value
        assert 'export_creases' in master['surfaceFinish'], 'Slabs already own their surface finish'
        assert health['connected_components'] == 1, health
        assert health['nonmanifold_edges'] == health['boundary_edges'] == 0, health
        tree = solidfit._tree(bpy.data.objects['SceneryRock'])
        if opening:
            for x in (-.3, 0., .3):
                for y in (-.3, 0., .3):
                    assert tree.ray_cast(Vector((x, y, 2)), Vector((0, 0, -1)))[0] is None, 'Slabs bridged the guide opening'
        heights = []
        for x in np.linspace(-1.5, 1.5, 40):
            for y in np.linspace(-1., 1., 30):
                if opening and abs(x) < .9 and abs(y) < .9:
                    continue
                hit = tree.ray_cast(Vector((x, y, 2)), Vector((0, 0, -1)))
                assert hit[0] is not None, (seed, x, y)
                heights.append(hit[0].z / size)
        low, median, high = np.percentile(heights, [10, 50, 95])
        assert median < .12 and high < .22, (seed, low, median, high)
        # Keep actual uneven stone, rather than flattening everything onto
        # the guide or hiding the geometry with interpolated normals. Thin
        # guides scale the entire depth profile to fit their buried roots.
        depth_scale = min(1., .8*thickness/(.35*size))
        assert high - low > .04*depth_scale, (seed, low, median, high)
        print('BOULDER_FLOOR_OK', seed, size, thickness, 'opening' if opening else 'floor',
              (low, median, high), flush=True)
