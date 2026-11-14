"""Run headless with --factory-startup --python-exit-code 1."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from dataclasses import replace
import bpy
import numpy as np
from mathutils import Vector
from foliage import fern, vine, mesh_io
from foliage.geometry import Builder, retained
from foliage.surface import Surface

# A broad floor and an edge the vine can descend.
bpy.ops.mesh.primitive_cube_add(size=2)
host = bpy.context.object
host.scale = (2, 2, .1)
bpy.context.view_layer.update()
surface = Surface.from_object(host, bpy.context.evaluated_depsgraph_get())
root = Vector((0, 0, .1))
normal, direction = Vector((0, 0, 1)), Vector((0, 1, 0))

for variety in ('PAINTED', 'LEAFLET', 'SPRIG'):
    p = fern.FernParams(variety=variety, fronds=5, leaflets=2 if variety=='LEAFLET' else 0)
    near, sn = fern.grow(surface, root, normal, direction, p)
    far, sf = fern.grow(surface, root, normal, direction, replace(p, lod_texel=.04))
    a, b = near.arrays(), far.arrays()
    assert sn == sf, (sn, sf)  # same growth decisions, fronds and leaves
    assert len(b[4]) < len(a[4]) and len(b[0]) < len(a[0])
    assert np.isfinite(b[0]).all() and b[4].max() < len(b[0])
    material = mesh_io.lod_material(b, .04)
    image = next(n.image for n in material.node_tree.nodes if n.type=='TEX_IMAGE')
    assert image.size[0] < 2048
    print(variety, len(a[4]), len(b[4]), tuple(image.size), flush=True)

p = vine.VineParams(length=.65)
near, sn = vine.grow(surface, root, normal, direction, p)
far, sf = vine.grow(surface, root, normal, direction, replace(p, lod_texel=.04))
a, b = near.arrays(), far.arrays()
assert sn == sf
assert len(b[4]) < len(a[4])
assert np.isfinite(b[0]).all()
print('VINE', len(a[4]), len(b[4]), sn['leaves'], flush=True)
# The full-detail material remains bound to the full-size image.
near_mat = mesh_io.material()
mesh_io.lod_material(b, .04)
assert next(n.image for n in near_mat.node_tree.nodes if n.type=='TEX_IMAGE').size[0] == 2048
# Integration: current transform changes the budget and material on rebuild.
import foliage
from foliage import ops
foliage.register()
plant = ops.create_plant('FERN', host, bpy.context.scene, root, normal, direction)
plant.foliage.live = False
plant.foliage.fronds = 5
assert ops.rebuild(plant) is not None
near_count = plant.foliage.triangles
host.location.y = 30
bpy.context.view_layer.update()
assert ops.rebuild(plant) is not None
assert plant.foliage.triangles < near_count
assert '.LOD' in plant.data.materials[0].name
print('Foliage LOD checks passed', flush=True)
