"""blender -b --factory-startup --python-exit-code 1 --python tools/blender/glowing_foliage_lod_check.py"""
import sys, json, struct
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
import bpy
from mathutils import Vector
import foliage
from foliage import ops, glowflora, glowgrow
foliage.register()
bpy.ops.mesh.primitive_cube_add(size=2)
host = bpy.context.object
host.scale = (3, 3, .1)
bpy.context.view_layer.update()

for kind, form in (('MUSHROOM', 'STALK'), ('MUSHROOM', 'SHELF'), ('ORBS', None)):
    host.location.y = 0
    bpy.context.view_layer.update()
    underside = kind == 'ORBS'
    at = Vector((0, 0, -.1 if underside else .1))
    n = Vector((0, 0, -1 if underside else 1))
    plant = ops.create_plant(kind, host, bpy.context.scene, at, n, Vector((0, 1, 0)))
    s = plant.foliage
    s.live = False
    s.cluster_count = 1
    s.seed = 17
    if form:
        # The standing enum is inspected below by its default, shelf explicit.
        if form == 'SHELF':
            s.mushroom_form = 'SHELF'
    near = ops.rebuild(plant, everyone=[])
    assert near is not None, s.status
    nt = s.triangles
    mat = plant.data.materials[0]
    strength = next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED').inputs['Emission Strength'].default_value
    image_sizes = [tuple(n.image.size) for n in mat.node_tree.nodes if n.type=='TEX_IMAGE']
    def emission_mean():
        image = mat.node_tree.nodes['emission'].image
        px = np.empty(image.size[0]*image.size[1]*4, np.float32)
        image.pixels.foreach_get(px)
        rgb = px.reshape(-1,4)[:,:3]
        return np.where(rgb <= .04045, rgb/12.92, ((rgb+.055)/1.055)**2.4).mean(axis=0)
    near_emission = emission_mean()
    host.location.y = 30
    bpy.context.view_layer.update()
    far = ops.rebuild(plant, everyone=[])
    assert far == near, (near, far, s.status)
    assert 0 < s.triangles < nt
    ft = s.triangles
    assert next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED').inputs['Emission Strength'].default_value == strength
    if kind=='ORBS':
        assert np.allclose(emission_mean(), near_emission, atol=.002)
        assert max(n.image.size[0] for n in mat.node_tree.nodes if n.type=='TEX_IMAGE') < max(x[0] for x in image_sizes)
    host.location.y = 0
    bpy.context.view_layer.update()
    assert ops.rebuild(plant, everyone=[]) == near and s.triangles == nt
    print(kind, form, nt, ft, 'near restored', flush=True)

# Every glow variety and authored detail; generation data must stay unchanged.
for kind in ('mushroom', 'lantern', 'fern', 'reed', 'grove'):
    patch = glowflora.generate_patch(dict(kind=kind, seed=4, count=2, mushrooms=2, ferns=1, reeds=1, lanterns=1), collisions=False)
    saved = json.dumps(patch, sort_keys=True)
    for detail in (0, 1, 2):
        near, nr = glowflora.build(patch, detail)
        zero, zr = glowflora.build(patch, detail, lambda _: 0)
        assert near.p == zero.p and near.i == zero.i and near.gi == zero.gi
        far, fr = glowflora.build(patch, detail, lambda _: .05)
        assert len(far.i) <= len(near.i)
        if detail==0:
            assert len(far.i) < len(near.i)
            print('GLOW', kind, len(near.i), len(far.i), flush=True)
        assert len(fr) == len(nr) == len(patch['items'])
        assert len(far.p)==len(far.c)==len(far.g)==len(far.gi)==len(far.s)
        assert np.isfinite(np.asarray(far.p)).all()
        assert max(max(t) for t in far.i) < len(far.p)
    assert json.dumps(patch, sort_keys=True) == saved

# World-space budget, transformed patch, custom attributes and glTF export.
host.location.y = 0
bpy.context.view_layer.update()
plant = ops.create_plant('GLOW', host, bpy.context.scene, Vector((0, 0, .1)), Vector((0, 0, 1)), Vector((0, 1, 0)))
s = plant.foliage
s.live = False
s.glow_collisions = False
s.set_glow_params(dict(kind='mushroom', seed=4, count=2))
near = ops.rebuild(plant, everyone=[])
assert near is not None, s.status
nt = s.triangles
host.location.y = 30
plant.scale = (1.2, .8, 1.1)
bpy.context.view_layer.update()
far = ops.rebuild(plant, everyone=[])
assert far is not None and s.triangles < nt, s.status
for name in ('_GLOW', '_GILL', '_SWAY', '_EXTRA'):
    assert len(plant.data.attributes[name].data)==len(plant.data.vertices)
extra = np.empty(len(plant.data.vertices)*2, np.float32)
plant.data.attributes['_EXTRA'].data.foreach_get('vector', extra)
assert (extra.reshape(-1,2)[:,0] < 0).any()
bpy.ops.object.select_all(action='DESELECT')
plant.select_set(True)
bpy.context.view_layer.objects.active = plant
path = '/tmp/glowing-foliage-lod-check.glb'
bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_attributes=True, export_lights=False, export_cameras=False)
data = Path(path).read_bytes()
length = struct.unpack_from('<I',data,12)[0]
gltf = json.loads(data[20:20+length])
attrs = gltf['meshes'][0]['primitives'][0]['attributes']
assert {'_GLOW','_GILL','_SWAY','_EXTRA'} <= set(attrs), attrs
# A fully blurred closed rim still has a valid path, not coincident endpoints.
from foliage.geometry import Builder
from mathutils import Vector
import math
rim = Builder(10.0)
rim.tube([Vector((math.cos(i*math.tau/8), math.sin(i*math.tau/8), 0)) for i in range(9)], .02, lambda _: (1,1,1))
a = rim.arrays()
area = np.linalg.norm(np.cross(a[0][a[4][:,1]]-a[0][a[4][:,0]], a[0][a[4][:,2]]-a[0][a[4][:,0]]), axis=1)
assert area.max() > .001
print('Glowing foliage LOD checks passed', flush=True)
