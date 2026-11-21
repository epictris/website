"""Resume interrupted lighting and recover unwritten Cycles targets."""
import os
import sys
import tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
os.environ['SCENE_EXPORT_DEVICE'] = 'CPU'
import bpy
import numpy as np
import emission_bake as eb
from emission_cache import LightmapCheckpoint


def scene(count=9):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene['game_light_samples'] = 1
    bpy.context.scene['game_lightmap_size'] = 128
    objects = []
    for i in range(count):
        bpy.ops.mesh.primitive_plane_add(size=1, location=(i * 1.2, 0, 0))
        ob = bpy.context.object
        ob.name = f'receiver {i}'
        ob.data.materials.append(bpy.data.materials.new(ob.name))
        objects.append(ob)
    bpy.ops.mesh.primitive_plane_add(size=2, location=(0, 0, 2), rotation=(3.14159265, 0, 0))
    emitter = bpy.context.object
    mat = bpy.data.materials.new('emitter')
    emitter.data.materials.append(mat)
    mat.node_tree.nodes.get('Principled BSDF').inputs['Emission Color'].default_value = (1, .5, .1, 1)
    mat.node_tree.nodes.get('Principled BSDF').inputs['Emission Strength'].default_value = 1
    return [*objects, emitter]


original = eb.diffuse_bake
with tempfile.TemporaryDirectory() as folder:
    checkpoint = LightmapCheckpoint(folder, 'same-scene')
    calls = []
    def interrupted(objects):
        calls.append([o.name for o in objects])
        if len(calls) == 2:
            raise RuntimeError('interrupted batch')
        original(objects)
    eb.diffuse_bake = interrupted
    try:
        try:
            eb.bake(scene(), set(), surface_only=True, checkpoint=checkpoint)
            raise AssertionError('interruption missing')
        except RuntimeError as error:
            assert str(error) == 'interrupted batch'
        assert len(list(checkpoint.directory.glob('*.npy'))) == 8
        calls.clear()
        def resumed(objects):
            calls.extend(o.name for o in objects)
            # Cached targets must not light the remaining receiver.
            for ob in bpy.context.scene.objects:
                if ob.name.startswith('receiver'):
                    assert not ob.data.materials[0].node_tree.nodes.get('Principled BSDF').inputs['Emission Color'].is_linked
            original(objects)
        eb.diffuse_bake = resumed
        maps, _ = eb.bake(scene(), set(), surface_only=True, checkpoint=checkpoint)
        assert calls == ['receiver 8'], calls
        assert len(maps) == 9
    finally:
        eb.diffuse_bake = original
    image = bpy.data.images.new('checkpoint test', 2, 2, float_buffer=True)
    pixels = np.ones((2, 2, 4), np.float32)
    checkpoint.save(image, pixels)
    assert checkpoint.restore(image)
    assert not LightmapCheckpoint(folder, 'changed-scene').restore(image)
    checkpoint.path(image).write_bytes(b'corrupt')
    assert not checkpoint.restore(image)
    checkpoint.clear()
print('EMISSION_CHECKPOINT_OK eight completed targets survive interruption; resumed targets never illuminate later bakes; changed scene and corruption rejected')

objects = scene(1)
calls = []
def unwritten_once(objects):
    calls.append(bpy.context.scene.cycles.device)
    if len(calls) > 1:
        original(objects)
eb.diffuse_bake = unwritten_once
try:
    maps, _ = eb.bake(objects, set(), surface_only=True)
    assert len(maps) == 1 and len(calls) == 2 and calls[-1] == 'CPU'
finally:
    eb.diffuse_bake = original

eb.diffuse_bake = lambda objects: None
try:
    try:
        eb.bake(scene(1), set(), surface_only=True)
        raise AssertionError('unwritten retry accepted')
    except ValueError as error:
        assert 'empty lightmap bake after CPU retry' in str(error)
finally:
    eb.diffuse_bake = original
print('EMISSION_RETRY_OK unwritten result retries on CPU; unwritten retry refuses export')
