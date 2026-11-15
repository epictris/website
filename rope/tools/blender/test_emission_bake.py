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
from emission_bake import UV, unwrap_receiver

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

pixels = np.zeros((16, 16, 4), np.float32)
pixels[3:7, 3:7] = (0, 0, 0, 1)  # Real shadow, not missing data.
pixels[9:13, 9:13] = (2, 3, 4, 1)
known = pixels[:, :, 3] == 1
baked = pixels[known].copy()
assert native.fill_background(pixels) == 32
assert np.array_equal(pixels[known], baked)
assert np.isfinite(pixels).all() and (pixels[:, :, 3] == 1).all()
print(f"EMISSION_UV_REGRESSION_OK coverage={coverage:.3f}; mesh, shading and colour UVs unchanged; shadow-safe padding")

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
