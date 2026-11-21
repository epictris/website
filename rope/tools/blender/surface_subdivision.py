"""Cut oversized bake faces without changing their surface or shader inputs."""
import math
import bmesh
import numpy as np


def split_large_faces(mesh, ob):
    from formations import render
    from formations import depth_lod
    scale = render.detail_scale(ob)
    cap = 2 ** math.floor(math.log2(
        render.setting(ob, 'export_map_max') or render.BAKE_SIZE_MAX / max(scale, 1)))
    density = render.setting(ob, 'export_texels') or render.TILE_TEXELS_PER_METRE / scale
    # Several face-sized pieces per atlas, so island assignment can balance
    # its area. Whole large polygons cannot be divided by UV seam assignment.
    span = cap / density * math.sqrt(render.UV_COVERAGE) / 2
    if not mesh.polygons:
        return 0
    local = depth_lod.field(ob)
    band_attr = mesh.attributes.get(depth_lod.FACE_BAND) if local else None
    spans = np.full(len(mesh.polygons),span)
    if band_attr is not None:
        levels = np.empty(len(mesh.polygons),np.int32)
        band_attr.data.foreach_get('value',levels)
        span = cap/local.budget.base_texels*math.sqrt(render.UV_COVERAGE)/2/local.scale
        spans = span*np.power(2.,levels)
    # Most rock faces are already small. Avoid constructing a BMesh and
    # copying hundreds of thousands of normals for that common no-op case.
    positions = np.empty((len(mesh.vertices), 3), np.float32)
    mesh.vertices.foreach_get('co', positions.ravel())
    vertices = np.empty(len(mesh.loops), np.int32)
    mesh.loops.foreach_get('vertex_index', vertices)
    starts = np.empty(len(mesh.polygons), np.int32)
    mesh.polygons.foreach_get('loop_start', starts)
    corners = positions[vertices]
    extents = np.maximum.reduceat(corners, starts) - np.minimum.reduceat(corners, starts)
    if not np.any(extents > spans[:,None]) and all(p.loop_total<=4 for p in mesh.polygons):
        return 0
    bm = bmesh.new()
    bm.from_mesh(mesh)
    normal = bm.loops.layers.float_vector.new('bake.split-normal')
    normals = iter(mesh.corner_normals)
    for face in bm.faces:
        for loop in face.loops:
            loop[normal] = next(normals).vector
    before = len(bm.faces)
    band = bm.faces.layers.int.get(depth_lod.FACE_BAND) if band_attr is not None else None
    face_span = lambda f: span*2.**f[band] if band is not None else span
    large = [f for f in bm.faces if any(
        max(v.co[a] for v in f.verts) - min(v.co[a] for v in f.verts) > face_span(f)
        for a in range(3))]
    if not large and all(len(f.verts)<=4 for f in bm.faces):
        bm.free()
        return 0
    # Triangulate using Blender's existing tessellation, so even a nonplanar
    # polygon retains the exact rendered surface when the planes cut it.
    mesh.calc_loop_triangles()
    triangles = {}
    for tri in mesh.loop_triangles:
        triangles.setdefault(tri.polygon_index, []).append(tuple(tri.vertices))
    bm.verts.ensure_lookup_table()
    face_layers = [layer for kind in ('bool', 'color', 'float', 'float_color',
                                      'float_vector', 'int', 'string')
                   for layer in getattr(bm.faces.layers, kind).values()]
    for face in large:
        if len(face.verts) <= 3:
            continue
        loops = {loop.vert.index: loop for loop in face.loops}
        for indices in triangles[face.index]:
            new = bm.faces.new([bm.verts[i] for i in indices])
            new.material_index = face.material_index
            new.smooth = face.smooth
            for layer in face_layers:
                new[layer] = face[layer]
            for loop in new.loops:
                loop.copy_from(loops[loop.vert.index])
        bm.faces.remove(face)
    for axis in range(3):
        low = min(v.co[axis] for v in bm.verts)
        high = max(v.co[axis] for v in bm.verts)
        step_span = float(spans.min())
        for step in range(1, math.ceil((high - low) / step_span)):
            plane = low + step * step_span
            faces = [f for f in bm.faces
                     if max(v.co[axis] for v in f.verts) - min(v.co[axis] for v in f.verts) > face_span(f)
                     and min(v.co[axis] for v in f.verts) < plane < max(v.co[axis] for v in f.verts)]
            if not faces:
                continue
            edges = {e for f in faces for e in f.edges}
            verts = {v for f in faces for v in f.verts}
            co, no = [0., 0., 0.], [0., 0., 0.]
            co[axis], no[axis] = plane, 1.
            bmesh.ops.bisect_plane(bm, geom=[*verts, *edges, *faces],
                                  dist=1e-6, plane_co=co, plane_no=no)
    # Cuts on several axes can make pentagons. Blender's tangent baker only
    # accepts triangles/quads. Use its existing tessellation, carrying each
    # corner's UVs and saved normal, before either surface map is baked.
    ngons={f for f in bm.faces if len(f.verts)>4}
    if ngons:
        tess=[loops for loops in bm.calc_loop_triangles() if loops[0].face in ngons]
        for loops in tess:
            source=loops[0].face
            new=bm.faces.new([loop.vert for loop in loops])
            new.material_index,new.smooth=source.material_index,source.smooth
            for layer in face_layers:new[layer]=source[layer]
            for dst,src in zip(new.loops,loops):dst.copy_from(src)
        for face in ngons:bm.faces.remove(face)
    normals = [tuple(loop[normal].normalized()) for face in bm.faces for loop in face.loops]
    added = len(bm.faces) - before
    bm.loops.layers.float_vector.remove(normal)
    bm.to_mesh(mesh)
    bm.free()
    mesh.normals_split_custom_set(normals)
    return added
