"""Temporary sibling joins preserve geometry, targets and baked illumination."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import bpy
import numpy as np
import emission_bake as eb
from mesh_chunks import split_surface_chunks
from scene_export import BAKE_UV

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8)
ob = bpy.context.object
ob.name = 'Rock'
ob.location = (4, 3, 2)
ob.rotation_euler = (.2, .1, .3)
ob.scale = (1, 2, .7)
for name in ('upper', 'lower'):
    ob.data.materials.append(bpy.data.materials.new(name))
for polygon in ob.data.polygons:
    polygon.material_index = int(polygon.center.z > 0)
    polygon.use_smooth = True
ob.data.uv_layers.active.name = BAKE_UV
objects = [ob]
split_surface_chunks(objects)
parts = [ob for ob in objects if ob.type == 'MESH']
for ob in parts:
    ob.data.uv_layers.active.name = eb.UV
bpy.context.view_layer.update()
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 32
scene.world = bpy.data.worlds.new('uniform environment')
scene.world.node_tree.nodes.get('Background').inputs['Color'].default_value = (1, 1, 1, 1)

def geometry(objects):
    result = []
    for ob in objects:
        normal_matrix = ob.matrix_world.to_3x3().inverted().transposed()
        for polygon in ob.data.polygons:
            mat = ob.data.materials[polygon.material_index].name
            for index in polygon.loop_indices:
                loop = ob.data.loops[index]
                position = ob.matrix_world @ ob.data.vertices[loop.vertex_index].co
                normal = (normal_matrix @ ob.data.corner_normals[index].vector).normalized()
                uv = ob.data.uv_layers[eb.UV].data[index].uv
                result.append((mat, tuple(round(v, 4) for v in position), tuple(normal), tuple(uv)))
    return sorted(result, key=lambda r: (r[0], r[1], r[3]))

before = geometry(parts)
def targets(label):
    images = []
    for ob in parts:
        image = bpy.data.images.new(ob.name + label, 128, 128, float_buffer=True)
        image.generated_color = (0, 0, 0, 0)
        eb.target(ob.data.materials[0], image)
        images.append(image)
    return images

separate = targets(' separate')
for ob in parts:
    eb.diffuse_bake([ob])
separate_pixels = [eb.lightmap_pixels(image) for image in separate]
joined = targets(' joined')
original_select = eb.select
observed = []
def inspect(objects):
    original_select(objects)
    if len(objects) == 1 and objects[0].name.startswith('game.lightmap-batch'):
        observed.append(geometry(objects))
eb.select = inspect
try:
    eb.diffuse_bake(parts)
finally:
    eb.select = original_select
assert len(observed) == 1
for original, combined in zip(before, observed[0]):
    assert original[:2] == combined[:2]
    assert np.allclose(original[2], combined[2], atol=1e-5)
    assert np.allclose(original[3], combined[3], atol=1e-6)
assert geometry(parts) == before
assert all(not ob.hide_render for ob in parts)
assert not any(ob.name.startswith('game.lightmap-batch') for ob in bpy.data.objects)
for original, image in zip(separate_pixels, joined):
    combined = eb.lightmap_pixels(image)
    known = original[:, :, 3] > .5
    assert np.array_equal(known, combined[:, :, 3] > .5)
    assert np.mean(np.abs(original[known, :3] - combined[known, :3])) < .02
print('EMISSION_CHUNK_BATCH_OK one bake target retains separate images, transformed geometry, boundary normals, UVs and illumination; temporary data removed')
