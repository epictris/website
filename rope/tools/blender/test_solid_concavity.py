"""Guide-fitted stones must not hull across recesses or disconnected patches.

Run with Blender in background mode. Foreground wedge backing stays enabled.
"""
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent / 'boulders'))
from solid_chunks import reinforce_chunks
from formations import solidfit

bpy.ops.wm.read_factory_settings(use_empty=True)


def prism(name, rings):
    vertices, faces = [], []
    for ring in rings:
        start, n = len(vertices), len(ring)
        vertices.extend((x, y, z) for z in (0., .12) for x, y in ring)
        faces += [tuple(start+i for i in reversed(range(n))),
                  tuple(start+n+i for i in range(n))]
        faces += [(start+i, start+(i+1)%n, start+(i+1)%n+n, start+i+n) for i in range(n)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    bm = bmesh.new(); bm.from_mesh(mesh)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(mesh); bm.free()
    ob = bpy.data.objects.new(name, mesh)
    return ob


shapes = [
    [[(0, 0), (2, 0), (2, .5), (.5, .5), (.5, 2), (0, 2)]],
    [[(x, 0), (x+1, 0), (x+1, 1), (x, 1)] for x in (0, 3)],
]
for i, rings in enumerate(shapes):
    ob = prism('fracture_chunk_concave', rings)
    before = [v.co.copy() for v in ob.data.vertices]
    result = reinforce_chunks([ob], [{'name': ob.name, 'material': 0,
                                      'preserve_concavity': True}], {'depth': 1.5})
    assert result == [ob]
    assert [v.co[:] for v in ob.data.vertices] == [v[:] for v in before]
    tree = solidfit._tree(ob)
    gap = (1.5, 1.5, 1.) if i == 0 else (2., .5, 1.)
    assert tree.ray_cast(Vector(gap), Vector((0, 0, -1)))[0] is None
    # The historical foreground path still backs shallow wedges.
    foreground = prism('fracture_chunk_foreground', rings)
    old_volume = solidfit._volume(foreground)
    reinforce_chunks([foreground], [{'name': foreground.name, 'material': 0}], {'depth': 1.5})
    assert solidfit._volume(foreground) > old_volume * 1.1

# Exercise the actual solid-generation call site, including its edge bevel.
ob = prism('guide-fitted', shapes[0])
boulder, reinforce, _ = solidfit._boulders()
solidfit.clean([ob], 1.5, 1., boulder, reinforce, {ob: 1.})
assert solidfit._tree(ob).ray_cast(Vector((1.5, 1.5, 1)), Vector((0, 0, -1)))[0] is None
bm = bmesh.new(); bm.from_mesh(ob.data)
assert all(e.is_manifold for e in bm.edges)
bm.free()
print('SOLID_CONCAVITY_OK', flush=True)
