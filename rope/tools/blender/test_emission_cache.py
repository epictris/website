"""Run with Blender --background --factory-startup --python this_file."""
import sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import bpy
import numpy as np
import emission_cache as cache
from emission_bake import UV, target

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_plane_add(size=2)
ob = bpy.context.object
mat = bpy.data.materials.new('receiver')
ob.data.materials.append(mat)
key = cache.fingerprint([ob], set())
assert cache.fingerprint([ob], set()) == key
ob.location.x = 1
bpy.context.view_layer.update()
assert cache.fingerprint([ob], set()) != key
ob.location.x = 0
bpy.context.view_layer.update()
ob['game_light_samples'] = 1024
assert cache.fingerprint([ob], set()) != key
del ob['game_light_samples']
bsdf = mat.node_tree.nodes.get('Principled BSDF')
bsdf.inputs['Emission Strength'].default_value = 4
assert cache.fingerprint([ob], set()) != key
bsdf.inputs['Emission Strength'].default_value = 0
assert cache.fingerprint([ob], set()) == key
original = ob.data
ob.data = original.copy()
uv = ob.data.uv_layers.new(name=UV)
values = np.array([.1,.1,.8,.1,.8,.8,.1,.8], np.float32)
uv.data.foreach_set('uv', values)
ob.material_slots[0].material = mat.copy()
baked = ob.material_slots[0].material
image = bpy.data.images.new('test baked light', 8, 8)
image.generated_color = (.1,.5,.2,1)
image.pack()
node = target(baked, image)
bsdf = baked.node_tree.nodes.get('Principled BSDF')
baked.node_tree.links.new(node.outputs[0], bsdf.inputs['Emission Color'])
bsdf.inputs['Emission Strength'].default_value = 1
lighting = {'version':1, 'encoding':'log1p', 'range':7.5}
field = {'coefficients':[1,2,3]}
with tempfile.TemporaryDirectory() as folder:
    assert cache.restore(folder, key, [ob]) is None
    cache.save(folder, key, [ob], {baked.name:lighting}, field)
    ob.data = original
    restored, probes = cache.restore(folder, key, [ob])
    assert probes == field
    assert restored == {ob.material_slots[0].material.name:lighting}
    actual = np.empty_like(values)
    ob.data.uv_layers[UV].data.foreach_get('uv', actual)
    assert np.array_equal(actual, values)
    assert ob.data.uv_layers.active.name == original.uv_layers.active.name
    # Disk damage must never install partial/stale illumination.
    (Path(folder)/key/'uv.npz').write_bytes(b'broken')
    before = ob.data
    try:
        cache.restore(folder, key, [ob])
        raise AssertionError('corrupt entry accepted')
    except ValueError:
        pass
    assert ob.data == before
print('EMISSION_CACHE_OK stable keys; geometry, samples and emission invalidate; UV/material/probe roundtrip; corrupt cache rejected')

# Lighting/material edits do not require re-projecting unchanged receivers.
import emission_bake
with tempfile.TemporaryDirectory() as folder:
    ob.data = original.copy()
    ob['game_lightmap_size'] = 128
    prepare = cache.ReceiverUVCache(folder)
    first = prepare(ob, bpy.context.scene, print)
    ob.data = original.copy()
    original_targets = emission_bake.receiver_targets
    def forbidden(*args, **kwargs):
        raise AssertionError('unchanged receiver was unwrapped again')
    emission_bake.receiver_targets = forbidden
    try:
        assert prepare(ob, bpy.context.scene, print) == first
    finally:
        emission_bake.receiver_targets = original_targets
    ob.data = original.copy()
    ob['game_lightmap_size'] = 256
    assert prepare(ob, bpy.context.scene, print)[0][0] == 256
print('EMISSION_UV_CACHE_OK unchanged geometry reuses UVs; resolution changes invalidate')

# Exercise the public path with an actual cold bake and a freshly recreated
# scene. A hit must restore both textures and probes without calling Cycles.
def make_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene['game_light_samples'] = 8
    scene['game_lightmap_size'] = 128
    scene['game_probe_min'] = [-.2, -.2, -.2]
    scene['game_probe_max'] = [.2, .2, .2]
    bpy.ops.mesh.primitive_plane_add(size=2)
    receiver = bpy.context.object
    receiver.data.materials.append(bpy.data.materials.new('receiver'))
    bpy.ops.mesh.primitive_plane_add(size=.4, location=(0, 0, 1), rotation=(3.14159265, 0, 0))
    emitter = bpy.context.object
    mat = bpy.data.materials.new('emitter')
    emitter.data.materials.append(mat)
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Emission Color'].default_value = (.3, 1, .1, 1)
    bsdf.inputs['Emission Strength'].default_value = .22
    return [receiver, emitter]

with tempfile.TemporaryDirectory() as folder:
    cold_maps, cold_field = cache.bake(make_scene(), set(), folder)
    original_bake = emission_bake.bake
    emission_bake.bake = forbidden
    try:
        warm_maps, warm_field = cache.bake(make_scene(), set(), folder)
    finally:
        emission_bake.bake = original_bake
    assert list(cold_maps.values()) == list(warm_maps.values())
    assert cold_field == warm_field and max(warm_field['coefficients']) > 0
    key = cache.fingerprint(list(bpy.context.scene.objects), set())
    bpy.context.scene['game_probe_min'][0] = -.3
    assert cache.fingerprint(list(bpy.context.scene.objects), set()) != key
print('EMISSION_CACHE_BAKE_OK real cold bake and fresh-scene cache hit without Cycles; probe bounds invalidate')
