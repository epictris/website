"""Planar simplification must not merge two crease paths into one edge."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import bpy
import bmesh
from formations import fitted

mesh = bpy.data.meshes.new('two narrow crease paths')
mesh.from_pydata([(0, 0, 0), (1, 0, 0), (.5, 0, .02), (.5, 0, -.02),
                  (.5, 1, .1), (.5, -1, .1)], [],
                 [(0, 2, 1, 4), (1, 2, 0, 5), (0, 4, 1, 3), (1, 5, 0, 3)])
bm = bmesh.new(); bm.from_mesh(mesh)
assert all(e.is_manifold for e in bm.edges)
# Both paths have the same endpoints: simplify only one of them.
assert fitted._dissolve_crease_vertices(bm) == 1
assert all(e.is_manifold for e in bm.edges)
assert all(f.calc_area() > 1e-12 for f in bm.faces)
assert abs(bm.calc_volume()) > 1e-12
# The remaining path now has an existing edge between its ends: retain it.
assert fitted._dissolve_crease_vertices(bm) == 0
bm.free(); bpy.data.meshes.remove(mesh)

# Ordinary planar faces should still simplify completely.
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
ob = bpy.context.object
bm = bmesh.new(); bm.from_mesh(ob.data)
bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=4, use_grid_fill=True)
bmesh.ops.triangulate(bm, faces=bm.faces[:])
bm.to_mesh(ob.data); bm.free()
fitted._facets(ob, len(ob.data.polygons), preserve_topology=True)
bm = bmesh.new(); bm.from_mesh(ob.data)
assert len(bm.verts) == 8 and len(bm.faces) == 6
assert all(e.is_manifold for e in bm.edges)
assert abs(bm.calc_volume() - 8.) < 1e-6
bm.free()
print('FACET_TOPOLOGY_OK: crease collisions guarded, broad planes retained', flush=True)
