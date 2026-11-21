"""blender -b --factory-startup --python tools/blender/test_mesh_chunks.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import bpy
import numpy as np
from mesh_chunks import split_surface_chunks
from scene_export import BAKE_UV
from emission_bake import mobile, receiver_targets
from formations.render import map_sides, colour_maps

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8)
ob = bpy.context.object
ob.name = 'Large Rock'
ob.location = (10, 3, -2)
ob.scale = (2, 3, 4)
for name in ('a', 'b'):
    ob.data.materials.append(bpy.data.materials.new(name))
for p in ob.data.polygons:
    p.material_index = int(p.center.z > 0)
    p.use_smooth = True
ob.data.uv_layers.active.name = BAKE_UV
ob['game_lightmap_chunk_sizes'] = [128, 256]
bpy.context.view_layer.update()
def samples(objects):
    rows = []
    for obj in objects:
        if obj.type != 'MESH':
            continue
        for p in obj.data.polygons:
            for i in p.loop_indices:
                v = obj.data.vertices[obj.data.loops[i].vertex_index]
                rows.append((* (obj.matrix_world @ v.co), *obj.data.corner_normals[i].vector,
                             *obj.data.uv_layers[BAKE_UV].data[i].uv))
    return np.asarray(sorted(rows, key=lambda r: tuple(round(v, 4) for v in (*r[:3], *r[6:]))))
objects = [ob]
before = samples(objects)
child = bpy.data.objects.new('attached plant', None)
bpy.context.scene.collection.objects.link(child)
child.parent = ob
child.location = (1, 2, 3)
bpy.context.view_layer.update()
child_world = np.array(child.matrix_world)
split_surface_chunks(objects)
bpy.context.view_layer.update()
parts = [o for o in objects if o.type == 'MESH']
assert len(parts) == 2
assert np.allclose(before, samples(objects), atol=1e-4)
assert np.allclose(child_world, child.matrix_world)
root = bpy.data.objects['Large Rock']
assert root.type == 'EMPTY' and child.parent == root
assert all(p.parent == root and mobile(p, {'Large_Rock'}) for p in parts)
assert all(len(p.material_slots) == 1 for p in parts)
assert sorted(p['game_lightmap_size'] for p in parts) == [128, 256]
for part in parts:
    assert receiver_targets(part, bpy.context.scene)[0][0] == part['game_lightmap_size']
assert len(map_sides(2000, maps=0)) > 8
assert len(colour_maps({}, 2000)) > 8
assert len(map_sides(2000, maps=2)) == 2
assert map_sides(1, maps=0) == map_sides(1, maps=1)
# Custom boundary normals must hash by values, including after a cache load.
import hashlib
from bake_cache import mesh_digest
for part in parts:
    copied = part.data.copy()
    first, second = hashlib.sha256(), hashlib.sha256()
    mesh_digest(first, part.data)
    mesh_digest(second, copied)
    assert first.digest() == second.digest()
    bpy.data.meshes.remove(copied)
print('CHUNKS_OK geometry, normals, UVs, hierarchy, transforms, independent lightmaps and uncapped automatic atlas counts')
