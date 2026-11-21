"""Boundary experiment; use run.py to apply the resource limits.

The detailed synthetic fixture is a test oracle, not the proposed generation
strategy. Production must partition a coarse surface BEFORE expensive detail.
Texture figures here are allocation estimates, not measured Cycles bake times.
"""
import argparse
from dataclasses import asdict
import json
import math
import os
from pathlib import Path
import resource
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).parent))
from budget import Budget, high_dof
from surface import Corner, Face, area, boundary_edges, closed_surface, normalised, pack, partition, unpack

import bpy
from mathutils import Matrix


def fixture():
    """A small closed, corrugated rock spanning 32 m of depth; < 9k triangles."""
    points, triangles = [], []
    rings, sides = 257, 16
    for j in range(rings):
        y = j * 32 / (rings - 1)
        for i in range(sides):
            a = i * math.tau / sides
            r = 1 + .13 * math.sin(y * 1.3 + .5 * math.sin(a)) + .025 * math.sin(y * 9 + a * 3)
            points.append((2 * r * math.cos(a), y, 1.5 * r * math.sin(a)))
    for j in range(rings - 1):
        for i in range(sides):
            a, b = j * sides + i, j * sides + (i + 1) % sides
            triangles += [(a, a + sides, b), (b, a + sides, b + sides)]
    for j, reverse in ((0, False), (rings - 1, True)):
        centre = len(points)
        points.append((0, j * 32 / (rings - 1), 0))
        for i in range(sides):
            tri = (centre, j * sides + i, j * sides + (i + 1) % sides)
            triangles.append(tuple(reversed(tri)) if reverse else tri)
    mesh = bpy.data.meshes.new('Reference surface')
    mesh.from_pydata(points, [], triangles)
    mesh.update()
    mesh.shade_smooth()
    # Nonidentity authored frame: cutting must use world Y, and exported
    # coordinates must still match the common original procedural frame.
    frame = Matrix.Translation((4, 0, -2)) @ Matrix.Rotation(.2, 4, 'Y') @ Matrix.Diagonal((1.2, .8, 1.1, 1))
    mesh.transform(frame.inverted())
    ob = bpy.data.objects.new('Reference (hidden)', mesh)
    bpy.context.scene.collection.objects.link(ob)
    ob.matrix_world = frame
    uv = mesh.uv_layers.new(name='Original UV')
    for loop in mesh.loops:
        p = frame @ mesh.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = (p.x / 4, p.y / 32)
    facet = mesh.attributes.new('facet', 'FLOAT', 'FACE')
    facet.data.foreach_set('value', [.375] * len(mesh.polygons))
    return ob


def read_surface(ob):
    mesh = ob.data
    mesh.calc_loop_triangles()
    normal_frame = ob.matrix_world.to_3x3().inverted().transposed()
    points = [tuple(ob.matrix_world @ v.co) for v in mesh.vertices]
    faces = []
    facet = mesh.attributes.get('facet')
    for triangle in mesh.loop_triangles:
        corners = []
        for li in triangle.loops:
            n = (normal_frame @ mesh.corner_normals[li].vector).normalized()
            uv = tuple(v for layer in mesh.uv_layers for v in layer.data[li].uv)
            corners.append(Corner(mesh.loops[li].vertex_index, (*n, *uv)))
        poly = mesh.polygons[triangle.polygon_index]
        faces.append(Face(tuple(corners), poly.material_index, facet.data[poly.index].value if facet else 0))
    return points, faces


def write_chunk(points, chunk, source, parent, index):
    used = sorted({c.vertex for f in chunk.faces for c in f.corners})
    remap = {v: i for i, v in enumerate(used)}
    back = source.matrix_world.inverted()
    mesh = bpy.data.meshes.new(f'Depth chunk {index:02d}')
    from mathutils import Vector
    mesh.from_pydata([back @ Vector(points[v]) for v in used], [],
                     [[remap[c.vertex] for c in f.corners] for f in chunk.faces])
    for material in source.data.materials:
        mesh.materials.append(material)
    mesh.update()
    mesh.shade_smooth()
    corners = [c for f in chunk.faces for c in f.corners]
    # Same source frame on every piece: no procedural-coordinate restart.
    normal_back = source.matrix_world.to_3x3().transposed()
    mesh.normals_split_custom_set([(normal_back @ Vector(normalised(c.attributes)[:3])).normalized()
                                  for c in corners])
    for i, layer in enumerate(source.data.uv_layers):
        uv = mesh.uv_layers.new(name=layer.name)
        uv.data.foreach_set('uv', [v for c in corners for v in c.attributes[3 + 2*i:5 + 2*i]])
    facet = mesh.attributes.new('facet', 'FLOAT', 'FACE')
    facet.data.foreach_set('value', [f.facet for f in chunk.faces])
    mesh.polygons.foreach_set('material_index', [f.material for f in chunk.faces])
    # The exporter must exclude these edges from chips/bevels/crease painting.
    boundary = boundary_edges(chunk.faces)
    cuts = mesh.attributes.new('lod_partition_edge', 'BOOLEAN', 'EDGE')
    cuts.data.foreach_set('value', [tuple(sorted(used[v] for v in edge.vertices)) in boundary
                                   for edge in mesh.edges])
    ob = bpy.data.objects.new(mesh.name, mesh)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    ob.matrix_world = source.matrix_world.copy()
    ob['prototype_geometry_error_m'] = chunk.band.geometry_error
    ob['prototype_texels_per_metre'] = chunk.band.texels_per_metre
    ob['prototype_depth_range'] = [chunk.band.near, chunk.band.far]
    # Diagnostic colours are viewport-only. All chunks share one material.
    palette = [(0.2, .6, .9, 1), (.2, .8, .55, 1), (.8, .75, .2, 1), (.95, .45, .2, 1), (.65, .4, .85, 1)]
    ob.color = palette[index % len(palette)]
    return ob


def seam_signature(points, chunk, plane):
    edges = {edge for edge in boundary_edges(chunk.faces)
             if all(abs(points[v][1] - plane) < 1e-7 for v in edge)}
    vertices = {v for edge in edges for v in edge}
    attrs = {}
    for face in chunk.faces:
        for corner in face.corners:
            if corner.vertex in vertices:
                attrs.setdefault(corner.vertex, set()).add(tuple(round(v, 6) for v in normalised(corner.attributes)))
    return edges, attrs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    if len(os.sched_getaffinity(0)) != 1:
        parser.error('Use run.py: this experiment must stay on one CPU core')
    args.output.mkdir(parents=True, exist_ok=True)
    if any((args.output / name).exists() for name in ('prototype.blend', 'report.json')):
        parser.error('Use a fresh output directory to retain previous comparisons')
    # --factory-startup already isolated the scene. Reloading factory settings
    # here also resets the launcher's no-audio setting on some Blender builds.
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    started = time.perf_counter()
    source = fixture()
    material = bpy.data.materials.new('Shared stone (no bake)')
    material.diffuse_color = (.16, .2, .28, 1)
    source.data.materials.append(material)
    bpy.context.view_layer.update()
    points, faces = read_surface(source)
    if len(faces) > 10000:
        raise RuntimeError('Fixture exceeded the small-test triangle limit')
    source_hash = (tuple(points), tuple(faces))
    assert closed_surface(faces), 'Reference must be a consistently oriented closed surface'
    original_triangles = len(faces)
    source_area = area(points, faces)
    fixture_seconds = time.perf_counter() - started
    budget = Budget(10, .15, *high_dof())
    t = time.perf_counter()
    bands = budget.bands(min(v[1] for v in points), max(v[1] for v in points))
    points, chunks = partition(points, faces, bands)
    split_seconds = time.perf_counter() - t
    assert abs(sum(area(points, c.faces) for c in chunks) - source_area) < 1e-6
    assert closed_surface([f for c in chunks for f in c.faces]), 'Split broke the closed source'
    packed = [pack(points, c) for c in chunks]
    t = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix='lod-boundaries-') as tmp:
        request, response = Path(tmp) / 'in.json', Path(tmp) / 'out.json'
        request.write_text(json.dumps(packed))
        subprocess.run(['bun', str(Path(__file__).with_name('simplify.mjs')), str(request), str(response)],
                       check=True, timeout=30)
        result = json.loads(response.read_text())
    simplify_seconds = time.perf_counter() - t
    simplified = [unpack(p, r['indices'], c.band) for p, r, c in zip(packed, result, chunks)]
    for before, after, measured in zip(chunks, simplified, result):
        assert boundary_edges(before.faces) == boundary_edges(after.faces), 'Simplifier changed a boundary'
        assert measured['error'] <= after.band.geometry_error * 1.0001
    seam_edges = 0
    for i in range(len(chunks) - 1):
        plane = chunks[i].band.far
        signatures = [seam_signature(points, c, plane)
                      for c in (chunks[i], chunks[i+1], simplified[i], simplified[i+1])]
        assert all(s == signatures[0] for s in signatures), 'Position/normal/UV seam changed'
        seam_edges += len(signatures[0][0])
    assert closed_surface([f for c in simplified for f in c.faces]), 'Simplification broke the closed surface'
    root = bpy.data.objects.new('One formation / adaptive depth chunks', None)
    bpy.context.scene.collection.objects.link(root)
    root['prototype_policy'] = json.dumps(asdict(budget), sort_keys=True)
    output = [write_chunk(points, c, source, root, i) for i, c in enumerate(simplified) if c.faces]
    bpy.context.view_layer.update()
    # Read the Blender objects back: transforms/custom normals/UVs survive IO.
    max_normal_error, max_uv_error = 0.0, 0.0
    for obj, expected in zip(output, [c for c in simplified if c.faces]):
        actual_points, actual_faces = read_surface(obj)
        for actual, wanted in zip(actual_faces, expected.faces):
            for a, b in zip(actual.corners, wanted.corners):
                assert max(abs(x-y) for x, y in zip(actual_points[a.vertex], points[b.vertex])) < 1e-5
                errors = [abs(x-y) for x, y in zip(a.attributes, normalised(b.attributes))]
                max_normal_error = max(max_normal_error, *errors[:3])
                max_uv_error = max(max_uv_error, *errors[3:])
    # Blender encodes custom normals relative to each vertex's local normal
    # space. Different topology can quantise the SAME requested normal slightly
    # differently. Measure that separately from exact pre-IO boundary equality.
    assert max_normal_error < .002, max_normal_error
    assert max_uv_error < 2e-6, max_uv_error
    assert read_surface(source) == (list(source_hash[0]), list(source_hash[1])), 'Source was mutated'
    source.hide_set(True)
    source.hide_render = True
    for ob in output:
        ob.select_set(True)
        ob.show_wire = True
    bpy.context.view_layer.objects.active = output[0]
    # Opening the artifact exposes the depth bands and their topology. These
    # are saved viewport settings only; no rendering is performed here.
    from mathutils import Vector
    for screen in bpy.data.screens:
        for screen_area in screen.areas:
            if screen_area.type == 'VIEW_3D':
                space = screen_area.spaces.active
                space.shading.color_type = 'OBJECT'
                space.region_3d.view_location = Vector((0, 16, 0))
                space.region_3d.view_distance = 45
                space.region_3d.view_rotation = Vector((-32, 20, -25)).to_track_quat('-Z', 'Y')
    rows = []
    for before, after, measured, packed_chunk in zip(chunks, simplified, result, packed):
        a = area(points, before.faces)
        rows.append({**asdict(before.band), 'area_m2': a,
                     'triangles_before': len(before.faces), 'triangles_after': len(after.faces),
                     'packed_vertices': len(packed_chunk['vertices']),
                     'estimated_texture_texels': math.ceil(a * before.band.texels_per_metre**2),
                     'simplifier_error_m': measured['error'], 'simplifier_ms': measured['milliseconds']})
    report = {'scope': 'Synthetic boundary prototype; not integrated with formation generation/export',
              'texture_scope': 'Area x density squared estimates only; excludes atlas padding and packing',
              'policy': asdict(budget), 'bands': rows,
              'original_triangles': original_triangles,
              'split_triangles': sum(len(c.faces) for c in chunks),
              'adaptive_triangles': sum(len(c.faces) for c in simplified),
              'estimated_uniform_texels': math.ceil(source_area * budget.base_texels**2),
              'estimated_adaptive_texels': sum(r['estimated_texture_texels'] for r in rows),
              'shared_edges_verified': seam_edges, 'closed_surface_after_simplification': True,
              'blender_max_normal_component_error': max_normal_error,
              'blender_max_uv_error': max_uv_error,
              'fixture_seconds': fixture_seconds, 'partition_seconds': split_seconds,
              'simplify_including_process_io_seconds': simplify_seconds,
              'work_seconds_before_save': time.perf_counter() - started,
              'peak_rss_mib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
              'cpu_cores_allowed': len(os.sched_getaffinity(0)), 'rendered_or_baked': False}
    (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    bpy.ops.wm.save_as_mainfile(filepath=str(args.output / 'prototype.blend'))
    print('DEPTH_LOD_OK', json.dumps({k: v for k, v in report.items() if k not in ('bands', 'policy')}), flush=True)


if __name__ == '__main__':
    main()
