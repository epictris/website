"""Regression: a large single polygon must occupy multiple nonempty atlases."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import bpy
import numpy as np
from surface_subdivision import split_large_faces
from scene_export import bake_maps, unwrap

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_plane_add(size=44)
ob = bpy.context.object
mesh = ob.data
facet = mesh.attributes.new('facet', 'FLOAT', 'FACE')
facet.data[0].value = .375
before = sum(p.area for p in mesh.polygons)
assert split_large_faces(mesh, ob) > 0
assert abs(sum(p.area for p in mesh.polygons) - before) < 1e-3
assert all(abs(v.value - .375) < 1e-6 for v in mesh.attributes['facet'].data)
for loop in mesh.loops:
    co = mesh.vertices[loop.vertex_index].co
    uv = mesh.uv_layers.active.data[loop.index].uv
    assert np.allclose(uv, (co.x / 44 + .5, co.y / 44 + .5), atol=1e-5)
assert all(np.allclose(n.vector, (0, 0, 1), atol=1e-5) for n in mesh.corner_normals)
assert all(len(p.vertices)<=4 for p in mesh.polygons)
mesh.calc_tangents(uvmap=mesh.uv_layers.active.name)
assert all(np.isfinite(tuple(loop.tangent)).all() for loop in mesh.loops)
mesh.free_tangents()
seen = np.ones(len(mesh.polygons), dtype=bool)
sides = bake_maps(mesh, ob, seen)
assigned = unwrap(ob, seen, sides, sides)
assert len(sides) > 8
assert len(np.unique(assigned)) == len(sides)
# Oblique faces cut on several axes previously produced pentagons, causing
# the full chip/normal bake to fail after its colour bake had completed.
from mathutils import Matrix,Vector
bpy.ops.mesh.primitive_plane_add(size=12)
oblique=bpy.context.object
turn=Matrix.Rotation(.37,4,'Z') @ Matrix.Rotation(.29,4,'Y')
oblique.data.transform(turn)
area=sum(p.area for p in oblique.data.polygons)
assert split_large_faces(oblique.data,oblique)>0
assert all(len(p.vertices)<=4 for p in oblique.data.polygons)
assert abs(sum(p.area for p in oblique.data.polygons)-area)<1e-3
for loop in oblique.data.loops:
    p=turn.inverted() @ oblique.data.vertices[loop.vertex_index].co
    assert np.allclose(oblique.data.uv_layers.active.data[loop.index].uv,(p.x/12+.5,p.y/12+.5),atol=1e-5)
assert all(np.allclose(n.vector,turn.to_3x3()@Vector((0,0,1)),atol=1e-5) for n in oblique.data.corner_normals)
oblique.data.calc_tangents(uvmap=oblique.data.uv_layers.active.name)
assert all(np.isfinite(tuple(loop.tangent)).all() for loop in oblique.data.loops)
oblique.data.free_tangents()
# A small face takes the no-op path, retaining its original mesh and UVs.
bpy.ops.mesh.primitive_plane_add(size=1)
small = bpy.context.object
assert split_large_faces(small.data, small) == 0
assert len(small.data.polygons) == 1
# Even an already-small n-gon needs tangent-compatible tessellation when
# there are no long creases or spatial cuts to triangulate it elsewhere.
me=bpy.data.meshes.new('small pentagon')
co=[(.3*np.cos(a),.3*np.sin(a),0) for a in np.linspace(0,2*np.pi,5,endpoint=False)]
me.from_pydata(co,[],[list(range(5))]);me.update()
uv=me.uv_layers.new(name='UVMap')
for loop in me.loops:
    p=me.vertices[loop.vertex_index].co
    uv.data[loop.index].uv=(p.x+.5,p.y+.5)
pentagon=bpy.data.objects.new('small pentagon',me);bpy.context.collection.objects.link(pentagon)
area=sum(p.area for p in me.polygons)
assert split_large_faces(me,pentagon)==2
assert abs(sum(p.area for p in me.polygons)-area)<1e-6
me.calc_tangents(uvmap='UVMap');me.free_tangents()

# A polygon folded over a neighbouring triangle (the jointed finish leaves
# them: 36 on backdrop.rock-a, 2026-11-22) tessellates into a triangle on that
# neighbour's very corners. BMesh refuses a second face there, and every solid
# rock's bake failed on it; the neighbour already draws that triangle, so the
# double is dropped, as Blender's own triangulate drops one.
me=bpy.data.meshes.new('folded pentagon')
co=[(.3*np.cos(a),.3*np.sin(a),0) for a in np.linspace(0,2*np.pi,5,endpoint=False)]
me.from_pydata(co,[],[list(range(5))]);me.update()
me.calc_loop_triangles()
fold=sorted(me.loop_triangles[0].vertices)
me=bpy.data.meshes.new('folded pentagon')
me.from_pydata(co,[],[list(range(5)),fold]);me.update()
uv=me.uv_layers.new(name='UVMap')
for loop in me.loops:
    p=me.vertices[loop.vertex_index].co
    uv.data[loop.index].uv=(p.x+.5,p.y+.5)
folded=bpy.data.objects.new('folded pentagon',me);bpy.context.collection.objects.link(folded)
split_large_faces(me,folded)
assert all(len(p.vertices)==3 for p in me.polygons)
assert len({frozenset(p.vertices) for p in me.polygons})==len(me.polygons)==3, [list(p.vertices) for p in me.polygons]
print('SURFACE_SUBDIVISION_OK area, normals and original UV interpolation; every large-plane atlas occupied; a folded polygon drops its double', flush=True)
