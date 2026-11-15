"""Run with Blender --background --factory-startup --python this_file.

Split render vertices must not turn a continuous surface into tiny lightmap
islands. Padding must preserve real black shadows and every baked value.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import bpy
import numpy as np
import native
from emission_bake import UV, unwrap_receiver, repair_lightmap_overlap, bake_field

bpy.ops.wm.read_factory_settings(use_empty=True)
vertices, faces = [], []
for y in range(20):
    for x in range(20):
        a, b, c, d = (x/10, y/10, 0), ((x+1)/10, y/10, 0), ((x+1)/10, (y+1)/10, 0), (x/10, (y+1)/10, 0)
        for tri in ((a, b, c), (a, c, d)):
            faces.append(tuple(range(len(vertices), len(vertices)+3)))
            vertices.extend(tri)
mesh = bpy.data.meshes.new("split render vertices")
mesh.from_pydata(vertices, [], faces)
ob = bpy.data.objects.new(mesh.name, mesh)
bpy.context.scene.collection.objects.link(ob)
original = mesh.uv_layers.new(name="Colour")
uvs = np.random.default_rng(17).random(len(mesh.loops)*2).astype(np.float32)
original.data.foreach_set("uv", uvs)
before = np.asarray([tuple(n.vector) for n in mesh.corner_normals])
bpy.context.scene["game_lightmap_size"] = 256
ob["game_lightmap_size"] = 512
assert unwrap_receiver(ob, bpy.context.scene) == 512
ob["game_lightmap_size"] = 8192
assert unwrap_receiver(ob, bpy.context.scene) == 8192
ob["game_lightmap_size"] = 512
assert bpy.context.scene["game_lightmap_size"] == 256
del ob["game_lightmap_size"]
assert unwrap_receiver(ob, bpy.context.scene) == 256
assert len(mesh.vertices) == len(vertices)
assert np.array_equal(np.asarray([tuple(v.co) for v in mesh.vertices]), np.asarray(vertices, dtype=np.float32))
assert np.array_equal(before, np.asarray([tuple(n.vector) for n in mesh.corner_normals]))
after = np.empty_like(uvs)
mesh.uv_layers["Colour"].data.foreach_get("uv", after)
assert np.array_equal(uvs, after)
assert mesh.uv_layers.active.name == "Colour" and mesh.uv_layers["Colour"].active_render
mesh.calc_loop_triangles()
uv = np.asarray([tuple(v.uv) for v in mesh.uv_layers[UV].data])
p = uv[np.asarray([t.loops for t in mesh.loop_triangles])]
a, b = p[:, 1]-p[:, 0], p[:, 2]-p[:, 0]
coverage = np.abs(a[:, 0]*b[:, 1]-a[:, 1]*b[:, 0]).sum()/2
assert coverage > .5, coverage
assert uv.min() >= 0 and uv.max() <= 1

# A hidden triangle projected inside a visible face used to overwrite its
# illumination. More pixels preserve this defect: the charts must separate.
overlap_mesh = bpy.data.meshes.new("overlapping lightmap")
overlap_mesh.from_pydata([(0,0,0), (1,0,0), (0,1,0),
                         (0,0,-1), (1,0,-1), (0,1,-1)], [], [(0,1,2), (3,4,5)])
overlap_ob = bpy.data.objects.new(overlap_mesh.name, overlap_mesh)
bpy.context.scene.collection.objects.link(overlap_ob)
overlap_mesh.uv_layers.new(name=UV)
overlap_mesh.uv_layers[UV].data.foreach_set("uv", np.array(
    [(0,0), (1,0), (0,1), (.2,.2), (.4,.2), (.2,.4)], np.float32).ravel())
repair_lightmap_overlap(overlap_ob, 256)
fixed = np.array([v.uv[:] for v in overlap_mesh.uv_layers[UV].data]).reshape(2,3,2)
edges = np.roll(fixed, -1, axis=1) - fixed
axes = np.stack((-edges[:,:,1], edges[:,:,0]), axis=-1).reshape(-1,2)
projected = fixed @ axes.T
assert np.any((projected[0].max(axis=0) < projected[1].min(axis=0)) |
              (projected[1].max(axis=0) < projected[0].min(axis=0))), fixed
assert len(overlap_mesh.vertices) == 6 and len(overlap_mesh.polygons) == 2
print("EMISSION_OVERLAP_REGRESSION_OK hidden and visible faces have separate texels")

pixels = np.zeros((16, 16, 4), np.float32)
pixels[3:7, 3:7] = (0, 0, 0, 1)  # Real shadow, not missing data.
pixels[9:13, 9:13] = (2, 3, 4, 1)
known = pixels[:, :, 3] == 1
baked = pixels[known].copy()
assert native.fill_background(pixels) == 32
assert np.array_equal(pixels[known], baked)
assert np.isfinite(pixels).all() and (pixels[:, :, 3] == 1).all()
print(f"EMISSION_UV_REGRESSION_OK coverage={coverage:.3f}; mesh, shading and colour UVs unchanged; shadow-safe padding")

from emission_bake import receiver_targets
for name in ('section a','section b'):
    mesh.materials.append(bpy.data.materials.new(name))
for polygon in mesh.polygons:
    polygon.material_index = int(polygon.index >= len(mesh.polygons)//2)
ob['game_lightmap_chunk_sizes'] = [256, 512]
assert receiver_targets(ob, bpy.context.scene) == [(256, [0]), (512, [1])]
mesh.uv_layers['Colour'].data.foreach_get('uv', after)
assert np.array_equal(uvs, after)
assert np.array_equal(before, np.asarray([tuple(n.vector) for n in mesh.corner_normals]))
assert len(mesh.vertices) == len(vertices)
print('EMISSION_SECTIONS_OK separate lightmap atlases preserve colour UVs, vertices and normals')

del ob['game_lightmap_chunk_sizes']
ob['game_lightmap_section_size'] = 256
assert receiver_targets(ob, bpy.context.scene) == [(256, [0]), (256, [1])]
# Atlas counts change when geometry is re-authored; no stale list to update.
mesh.materials.append(bpy.data.materials.new('section c'))
for polygon in list(mesh.polygons)[-100:]:
    polygon.material_index = 2
assert receiver_targets(ob, bpy.context.scene) == [(256, [0]), (256, [1]), (256, [2])]
print('EMISSION_SECTION_BUDGET_OK uniform budget follows changing atlas counts')

# A prepared surface already has repaired charts. Reuse them without another
# visibility pass/Smart Project, retaining independent material atlases.
import scene_export
prepared = mesh.uv_layers.new(name=scene_export.BAKE_UV)
prepared.data.foreach_set('uv', np.asarray([v.uv[:] for v in mesh.uv_layers[UV].data], np.float32).ravel())
original_unwrap = scene_export.unwrap
def no_reprojection(*args, **kwargs):
    raise AssertionError('prepared surface was projected again')
scene_export.unwrap = no_reprojection
try:
    assert receiver_targets(ob, bpy.context.scene) == [(256, [0]), (256, [1]), (256, [2])]
finally:
    scene_export.unwrap = original_unwrap
print('EMISSION_CHART_REUSE_OK existing surface charts skip reprojection')

from lightmap_denoise import LightmapDenoiser
noise = np.ones((128, 128, 4), np.float32)
noise[:, :, :3] += np.random.default_rng(13).normal(0, .1, (128, 128, 3)).astype(np.float32)
noise[60, 60, :3] = 30
before_noise = noise[:, :, :3].std()
denoiser = LightmapDenoiser()
try:
    denoiser.apply(noise)
    assert noise[:, :, :3].std() < before_noise * .3
    assert noise[60, 60, :3].max() < 3
    assert abs(noise[:, :, :3].mean()-1) < .1
    assert (noise[:, :, 3] == 1).all()
    black = np.zeros((32, 32, 4), np.float32)
    black[:, :, 3] = 1
    denoiser.apply(black)
    assert not black[:, :, :3].any()
finally:
    denoiser.close()
print("EMISSION_DENOISE_REGRESSION_OK isolated bright noise removed; mean illumination and unlit maps preserved")

# An actual Cycles bake must light dynamic receivers. A failed GPU bake can
# return FINISHED without writing pixels; an all-black SH check alone would
# confuse that failure with a legitimate unlit volume.
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 16
scene.cycles.device = 'GPU'  # bake_field temporarily uses CPU, then restores it.
scene['game_probe_min'] = [-.5, -.5, -.5]
scene['game_probe_max'] = [.5, .5, .5]
bpy.ops.mesh.primitive_uv_sphere_add(radius=.3, location=(0, 0, 1.5))
emitter = bpy.context.object
mat = bpy.data.materials.new('probe regression emitter')
bsdf = mat.node_tree.nodes.get('Principled BSDF')
bsdf.inputs['Emission Color'].default_value = (1, .5, .1, 1)
bsdf.inputs['Emission Strength'].default_value = 10
emitter.data.materials.append(mat)
field = bake_field([emitter], scene)
assert max(field['coefficients']) > .01
assert scene.cycles.device == 'GPU'
import emission_bake
original_bake = emission_bake.diffuse_bake
emission_bake.diffuse_bake = lambda objects: None
try:
    try:
        bake_field([emitter], scene)
        raise AssertionError('unwritten probe bake was accepted')
    except RuntimeError as error:
        assert 'unwritten samples' in str(error)
    assert scene.cycles.device == 'GPU'
    assert not any(ob.name.startswith('game.probe-bake') for ob in scene.objects)
finally:
    emission_bake.diffuse_bake = original_bake
print('EMISSION_PROBE_REGRESSION_OK real illumination, CPU device restoration and unwritten-bake rejection')

from lightmap_encoding import encode_lightmap, decode_lightmap
# Bright source contact must not crush dim, neutral and coloured light into
# a few sRGB code values. Include a continuous ramp to catch visible steps.
ramp = np.geomspace(.01, 194, 1000).reshape(-1, 1) * np.array([1, .7, .4])
encoded = np.round(encode_lightmap(ramp, 194) * 255) / 255
restored = decode_lightmap(encoded, 194)
assert np.max(np.abs(restored-ramp)/ramp) < .04
assert np.all(decode_lightmap(np.zeros((1,3)),194) == 0)
low = ramp[:,0] < .1
assert len(np.unique(encoded[low,0])) > 20
print('EMISSION_LOG_ENCODING_OK dim colours and gradients survive 8-bit HDR transport')

# A failed lighting bake must not leave source/runtime texture simplification
# enabled. The limit is temporary input residency, not an export quality cap.
scene.render.use_simplify = False
scene.cycles.texture_limit_render = 'OFF'
original_field_bake = emission_bake.bake_field
def interrupted_field(objects, scene):
    assert scene.render.use_simplify
    assert scene.cycles.texture_limit_render == '2048'
    raise RuntimeError('interrupted field test')
emission_bake.bake_field = interrupted_field
try:
    try:
        emission_bake.bake([emitter], set())
        raise AssertionError('interrupted bake was accepted')
    except RuntimeError as error:
        assert str(error) == 'interrupted field test'
    assert not scene.render.use_simplify
    assert scene.cycles.texture_limit_render == 'OFF'
finally:
    emission_bake.bake_field = original_field_bake
print('EMISSION_INPUT_LIMIT_OK restored after interrupted bake')
