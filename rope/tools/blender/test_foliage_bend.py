"""Blender --background --factory-startup --python-exit-code 1 --python this_file."""
import sys
from pathlib import Path
import bpy
from mathutils import Vector, Matrix

sys.path.insert(0, str(Path(__file__).parent))
import foliage
import ivy
import moss
import scene_export
from formations import curve

foliage.register()
ivy.register()
moss.register()
bpy.ops.wm.read_factory_settings(use_empty=True)


def mesh(name, points):
    data = bpy.data.meshes.new(name)
    data.from_pydata(points, [], [(0, 1, 2)])
    ob = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(ob)
    return ob


host = mesh('rock', [(-1, 0, 0), (1, 0, 0), (0, 0, 0)])
host.matrix_world = (Matrix.Translation((3, -2, 5)) @ Matrix.Rotation(.4, 4, 'Y')
                     @ Matrix.Diagonal((1.3, .8, 1.1, 1)))
host['scene_bows'] = [[-1, 0, 0, 1, 0, 0, 0, 0, .15, .8]]
plant = mesh('mushrooms', [(0, 0, 0), (.02, 0, 0), (0, 0, 1)])
plant['grown_by'] = 'foliage'
plant.foliage.host = host.name
plant.matrix_world = host.matrix_world.copy()
unrelated = mesh('unattached mesh', [(0, 0, 0), (.02, 0, 0), (0, 0, 1)])
before = [v.co.copy() for v in unrelated.data.vertices]
bows = [(Vector((-1, 0, 0)), Vector((1, 0, 0)), Vector((0, 0, .15)), .8)]
curve.bend(host.data, bows)
bpy.context.view_layer.update()
scene_export.bend_growths([host, plant, unrelated], [])
root = plant.matrix_world @ plant.data.vertices[0].co
surface = host.matrix_world @ host.data.vertices[2].co
gap = (root - surface).length
assert gap < 1e-6, gap
assert all(a == b.co for a, b in zip(before, unrelated.data.vertices))
print('FOLIAGE_BEND_OK root remains attached under translated, rotated, scaled host; unrelated mesh unchanged')
