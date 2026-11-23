"""The iteration mesh splits a solid rock's n-gons as Blender tessellates them.

    blender -b --factory-startup --python tools/blender/test_tessellate.py

A planar dissolve leaves n-gons bent up to its angle; the growths grow on
`loop_triangles` and the glTF exporter ships them, so `formation_export`'s
own triangulation must be that one too (docs/formations.md, "Decorations").
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import bmesh
import bpy
import numpy as np

import formation_export


def bent_mesh():
    """A closed slab whose top is one bent 12-gon, a bent quad and a concave
    7-gon, each face toned by the `facet` attribute."""
    verts, faces = [], []
    n = 12
    ring = [(math.cos(2 * math.pi * i / n), math.sin(2 * math.pi * i / n), 0.06 * (-1) ** i) for i in range(n)]
    verts += ring + [(x, y, -1.0) for x, y, _z in ring]
    faces.append(list(range(n)))
    faces.append(list(range(2 * n - 1, n - 1, -1)))
    faces += [[i, n + i, n + (i + 1) % n, (i + 1) % n][::-1] for i in range(n)]
    b = len(verts)
    verts += [(3, 0, 0), (4, 0, 0.1), (4, 1, 0), (3, 1, 0.12)]
    faces.append([b, b + 1, b + 2, b + 3])
    c = len(verts)
    verts += [(6, 0, 0), (8, 0, 0.05), (8, 2, 0), (7.6, 0.7, 0.08), (7, 1.0, -0.04), (6.4, 0.7, 0.07), (6, 2, 0)]
    faces.append(list(range(c, c + 7)))
    me = bpy.data.meshes.new("bent")
    me.from_pydata(verts, [], faces)
    me.update()
    tone = me.attributes.new("facet", "FLOAT", "FACE")
    tone.data.foreach_set("value", [0.1 * (i + 1) for i in range(len(me.polygons))])
    return me


def triangles(bm):
    return {frozenset(v.index for v in f.verts) for f in bm.faces}


me = bent_mesh()
me.calc_loop_triangles()
want = {frozenset(lt.vertices) for lt in me.loop_triangles}
owner_tone = {frozenset(lt.vertices): me.attributes["facet"].data[lt.polygon_index].value for lt in me.loop_triangles}
owner_normal = {frozenset(lt.vertices): me.polygons[lt.polygon_index].normal.copy() for lt in me.loop_triangles}

bm = bmesh.new()
bm.from_mesh(me)
formation_export.tessellate(bm, me)
assert all(len(f.verts) == 3 for f in bm.faces)
got = triangles(bm)
assert got == want, f"{len(got - want)} triangles split another way than Blender's tessellation"
# The face attribute rides along to every piece.
layer = bm.faces.layers.float["facet"]
for f in bm.faces:
    k = frozenset(v.index for v in f.verts)
    assert math.isclose(f[layer], owner_tone[k], abs_tol=1e-6), (sorted(k), f[layer], owner_tone[k])
    # and every piece keeps its face's winding
    assert f.normal.dot(owner_normal[k]) > 0, sorted(k)
bm.free()

# The case this guards: bmesh's BEAUTY split is another surface on bent n-gons.
bm = bmesh.new()
bm.from_mesh(me)
bmesh.ops.triangulate(bm, faces=bm.faces[:])
assert triangles(bm) != want, "BEAUTY now agrees with the tessellation: this test no longer tells them apart"
bm.free()

# Through edge_attributes, the iteration mesh's path, on a copy.
drawn = me.copy()
formation_export.edge_attributes(drawn)
drawn.calc_loop_triangles()
assert {frozenset(lt.vertices) for lt in drawn.loop_triangles} == want
assert np.isclose(sum(p.area for p in drawn.polygons), sum(lt.area for lt in me.loop_triangles))
print("test_tessellate: OK")
