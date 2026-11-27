"""Triangulate Boolean n-gons without changing their tessellated surface.

A new diagonal can coincide with an existing edge belonging to another
face. Blender's ordinary triangulation merges them into a non-manifold
edge. Poking the entire polygon instead can fill concavities. Subdivide
only the conflicting diagonals, within their original triangles.
"""
import bpy
import numpy as np


def preserve_surface(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    co = np.empty((len(mesh.vertices), 3), dtype=np.float32)
    mesh.vertices.foreach_get('co', co.ravel())
    triangles = np.empty((len(mesh.loop_triangles), 3), dtype=np.int32)
    mesh.loop_triangles.foreach_get('vertices', triangles.ravel())
    parents = np.empty(len(triangles), dtype=np.int32)
    mesh.loop_triangles.foreach_get('polygon_index', parents)
    if not len(triangles):
        return 0
    # An interior tessellation edge occurs twice within its source polygon;
    # boundary edges occur once. Group these pairs in native array operations
    # instead of visiting millions of triangles and building Python sets.
    count = np.int64(len(co))
    a, b = triangles, triangles[:, [1, 2, 0]]
    edge_keys = (np.minimum(a, b).astype(np.int64)*count+np.maximum(a, b)).ravel()
    edge_parents = np.repeat(parents, 3)
    order = np.lexsort((edge_parents, edge_keys))
    keys, ids = edge_keys[order], edge_parents[order]
    starts = np.r_[0, np.flatnonzero((keys[1:] != keys[:-1]) | (ids[1:] != ids[:-1]))+1]
    lengths = np.diff(np.r_[starts, len(order)])
    diagonal_groups = np.flatnonzero(lengths > 1)
    diagonals = keys[starts[diagonal_groups]]
    edges = np.empty((len(mesh.edges), 2), dtype=np.int32)
    mesh.edges.foreach_get('vertices', edges.ravel())
    existing = np.minimum(edges[:, 0], edges[:, 1]).astype(np.int64)*count+np.maximum(edges[:, 0], edges[:, 1])
    bad = np.isin(diagonals, existing)
    repeated = diagonals[1:] == diagonals[:-1]
    bad[1:] |= repeated
    bad[:-1] |= repeated
    groups = np.zeros(len(starts), dtype=bool)
    groups[diagonal_groups[bad]] = True
    flagged = np.empty(len(order), dtype=bool)
    flagged[order] = np.repeat(groups, lengths)
    flagged = flagged.reshape((-1, 3))
    affected = flagged.any(axis=1)
    added, faces, materials, midpoints = [], [], [], {}
    source_materials = np.empty(len(mesh.polygons), dtype=np.int32)
    mesh.polygons.foreach_get('material_index', source_materials)
    for index in np.flatnonzero(affected):
        triangle, parent = triangles[index], parents[index]
        ring = []
        for side, (a, b) in enumerate(zip(triangle, (triangle[1], triangle[2], triangle[0]))):
            a, b = int(a), int(b)
            ring.append(a)
            if flagged[index, side]:
                key = (parent, min(a, b), max(a, b))
                if key not in midpoints:
                    midpoints[key] = len(co)+len(added)
                    added.append((co[a]+co[b])*.5)
                ring.append(midpoints[key])
        center = len(co)+len(added)
        added.append(co[triangle].mean(axis=0))
        for a, b in zip(ring, ring[1:]+ring[:1]):
            faces.append((a, b, center))
            materials.append(source_materials[parent])
    vertices = np.concatenate((co, np.asarray(added, dtype=np.float32).reshape((-1, 3))))
    faces = np.concatenate((triangles[~affected], np.asarray(faces, dtype=np.int32).reshape((-1, 3))))
    materials = np.r_[source_materials[parents[~affected]], np.asarray(materials, dtype=np.int32)]
    result = bpy.data.meshes.new(mesh.name+' triangles')
    result.vertices.add(len(vertices))
    result.vertices.foreach_set('co', vertices.ravel())
    result.loops.add(faces.size)
    result.loops.foreach_set('vertex_index', faces.ravel())
    result.polygons.add(len(faces))
    result.polygons.foreach_set('loop_start', np.arange(0, faces.size, 3, dtype=np.int32))
    result.polygons.foreach_set('loop_total', np.full(len(faces), 3, dtype=np.int32))
    for material in mesh.materials:
        result.materials.append(material)
    result.polygons.foreach_set('material_index', materials)
    result.update(calc_edges=True)
    obj.data = result
    if not mesh.users:
        bpy.data.meshes.remove(mesh)
    return int(groups.sum())
