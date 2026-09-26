"""Blender-side mesh assembly, moss growth, procedural material, preview
rendering and export for dirt-and-moss blocks.

Modelled on ../boulders/stylised_rocks_v5/blender_build.py. Generic helpers
(object_from_part, mesh_health, keep_main_body, make_stage, add_area,
look_at) are imported from there unmodified. bake_color/export_model are
NOT imported: the boulder version names its baked material "portable
painted slate", so a small local variant is written here instead of
editing blender_build.py.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys
import time

import bpy
import bmesh
from mathutils import Matrix, Vector, noise
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parent
BOULDER_ROOT = ROOT.parent / "boulders" / "stylised_rocks_v5"
sys.path.insert(0, str(BOULDER_ROOT))
sys.path.insert(0, str(ROOT))

from blender_build import object_from_part, mesh_health, keep_main_body, make_stage, add_area, look_at  # noqa: E402
from dirt_materials import dirt_material, moss_material  # noqa: E402

DIRT_SLOT, MOSS_SLOT = 0, 1


def assemble_dirt_base(block, source_collection, materials):
    """Union the buried support and pillowed chunks into one soft, bevelled
    solid. Returns the assembled object, still in local camera-frame
    coordinates (no side_rotation applied yet)."""
    spec = block["spec"]
    pieces = [object_from_part(part, source_collection, materials) for part in block["parts"]]
    envelope = object_from_part(block["clip"], source_collection, materials)
    for piece, part in zip(pieces, block["parts"]):
        if not part.get("clip_to_outline"):
            continue
        bpy.context.view_layer.objects.active = piece
        # Round the raw halfspace-intersection chunk toward a sphere before
        # clipping. Without this, a chunk whose cell touched one of the
        # bounding-box planes used to close the Voronoi diagram keeps a
        # perfectly flat cap there; with several such chunks side by side
        # (there are only ever 2-24 of them), those flat caps read as one
        # smooth extruded slab instead of individual rounded clods. Casting
        # every chunk toward a partial sphere turns every face -- including
        # any leftover flat ones -- into part of one rounded "big soft
        # potato" blob.
        cast = piece.modifiers.new("Round chunk toward a blob", "CAST")
        cast.cast_type = "SPHERE"
        cast.factor = 0.42
        cast.use_x = cast.use_y = cast.use_z = True
        bpy.ops.object.modifier_apply(modifier=cast.name)
        cut = piece.modifiers.new("Outline envelope clip", "BOOLEAN")
        cut.operation, cut.solver, cut.object = "INTERSECT", "MANIFOLD", envelope
        bpy.ops.object.modifier_apply(modifier=cut.name)
        if part.get("chunk_bevel") and len(piece.data.polygons):
            bevel = piece.modifiers.new("Soft chunk shoulder", "BEVEL")
            bevel.width, bevel.segments = part["chunk_bevel"], 3
            bevel.limit_method, bevel.angle_limit = "ANGLE", math.radians(25)
            bpy.ops.object.modifier_apply(modifier=bevel.name)
            for face in piece.data.polygons:
                face.material_index = part["material"]
    bpy.data.objects.remove(envelope, do_unlink=True)

    core = pieces[0]
    result = core.copy()
    result.data = core.data.copy()
    source_collection.objects.link(result)
    result.name = spec["name"] + "_dirt_base"
    cutters = bpy.data.collections.new("Union temporary (dirt)")
    bpy.context.scene.collection.children.link(cutters)
    for obj in pieces[1:]:
        cutters.objects.link(obj)
    bpy.context.view_layer.objects.active = result
    result.select_set(True)
    modifier = result.modifiers.new("Join chunks into one solid", "BOOLEAN")
    modifier.operation, modifier.operand_type = "UNION", "COLLECTION"
    modifier.collection, modifier.solver, modifier.use_self = cutters, "MANIFOLD", True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.collections.remove(cutters)
    for piece in pieces:
        bpy.data.objects.remove(piece, do_unlink=True)
    keep_main_body(result)

    remesh = result.modifiers.new("Consolidate the chunky solid", "REMESH")
    remesh.mode, remesh.adaptivity, remesh.use_smooth_shade = "VOXEL", 0.04, True
    # Fine enough to keep the grooves the per-chunk bevel carved between
    # neighbouring clods; too coarse a voxel bridges straight over them.
    remesh.voxel_size = max(0.005, spec["tolerance"] * 0.24 / math.sqrt(max(1, spec["detail"])))
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    keep_main_body(result)

    bm = bmesh.new()
    bm.from_mesh(result.data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method="FIXED", ngon_method="EAR_CLIP")
    bm.to_mesh(result.data)
    bm.free()
    result.data.update()

    # No crisp final chipped-edge bevel: the wide per-chunk bevel plus this
    # remesh/smooth pass is what gives the soft, rounded-groove look. Kept
    # much lighter than the first pass at this (0.7, 7 iterations): that
    # smoothed the grooves between chunks away almost entirely, leaving one
    # smooth slab instead of visibly separate clods.
    smooth = result.modifiers.new("Soften voxel ridges", "SMOOTH")
    smooth.factor, smooth.iterations = 0.35, 3
    bpy.context.view_layer.objects.active = result
    bpy.ops.object.modifier_apply(modifier=smooth.name)

    dec = result.modifiers.new("Broad sculpted facets", "DECIMATE")
    dec.ratio = min(1.0, 8000 / max(1, len(result.data.polygons)))
    bpy.ops.object.modifier_apply(modifier=dec.name)

    round_off = result.modifiers.new("Round off decimate facets", "SMOOTH")
    round_off.factor, round_off.iterations = 0.5, 2
    bpy.ops.object.modifier_apply(modifier=round_off.name)

    tri = result.modifiers.new("Triangulate", "TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=tri.name)
    _clean_dangling_geometry(result)
    for face in result.data.polygons:
        face.material_index = DIRT_SLOT
    return result


def _clean_dangling_geometry(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    flaps = [f for f in bm.faces if sum(e.is_boundary for e in f.edges) >= 2
             and any(len(e.link_faces) > 2 for e in f.edges)]
    if flaps:
        bmesh.ops.delete(bm, geom=flaps, context="FACES_ONLY")
    loose = [e for e in bm.edges if not e.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context="EDGES")
    isolated = [v for v in bm.verts if not v.link_faces]
    if isolated:
        bmesh.ops.delete(bm, geom=isolated, context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def _simplify_protecting_material(obj, protected_slot, target_faces):
    """Simplify the mesh toward target_faces total triangles.

    A bmesh material-delimited limited dissolve was tried here first (never
    merging across the dirt/moss seam), but on this voxel-remeshed organic
    surface it periodically produced non-planar ngons that EAR_CLIP
    triangulation turned into duplicate/overlapping triangles -- a
    non-manifold, multi-component mesh. The plain DECIMATE modifier (used
    everywhere else in this file) is far more robust, at the cost of not
    being material-aware: it can eat a little moss area right at the seam.
    The now-generous whole-surface moss placement/measurement (see
    _face_visible, _cover_mask) has enough margin to absorb that without
    a retry loop."""
    bpy.context.view_layer.objects.active = obj
    if len(obj.data.polygons) > target_faces:
        dec = obj.modifiers.new("Cap combined triangle budget", "DECIMATE")
        dec.ratio = min(1.0, target_faces / max(1, len(obj.data.polygons)))
        bpy.ops.object.modifier_apply(modifier=dec.name)
    # A light pass to round off the decimate's low-poly facets, most
    # visible on the moss cushions, without moving the mesh enough to
    # threaten the outline tolerance.
    smooth = obj.modifiers.new("Round off decimate facets", "SMOOTH")
    smooth.factor, smooth.iterations = 0.5, 2
    bpy.ops.object.modifier_apply(modifier=smooth.name)


def _face_visible(normal):
    """The whole exterior surface except a clearly downward-facing
    underside (resting on the ground, never actually seen). Deliberately
    NOT restricted to camera-facing front/top: an earlier version only
    grew moss on front+top faces, which made it read as a flat plate
    stuck to the camera-facing plane instead of patches scattered over the
    whole visible form (front, top, AND sides)."""
    return normal.y > -0.35


def _noise_value(point, seed):
    offset = Vector((seed * 0.61, seed * 0.29, seed * 0.83))
    sample = point * 1.15 + offset
    broad = noise.noise(sample, noise_basis="PERLIN_ORIGINAL")
    fine = noise.noise(sample * 2.3 + Vector((7.1, -3.4, 2.2)), noise_basis="PERLIN_ORIGINAL")
    return broad + 0.4 * fine


def _cover_mask(dirt_obj, spec):
    """Area-weighted-quantile cover mask over the whole visible surface
    (see _face_visible), from low-frequency seeded noise, so moss patches
    are scattered evenly rather than biased to any one facing direction.

    Directly targets `moss` with no correction factor: since placement and
    measurement now use the same broad "not underside" definition of
    visible (see measure_moss_coverage), the quantile footprint's area
    fraction and the final measured coverage track each other closely
    enough that the multi-attempt boost search this generator used to need
    is no longer necessary."""
    seed = int(spec["seed"])
    faces = dirt_obj.data.polygons
    values = [_noise_value(face.center, seed) for face in faces]
    visible = [f.index for f in faces if _face_visible(f.normal)]
    if not visible:
        return set(), 0.0
    total_visible_area = sum(faces[i].area for i in visible)
    target_fraction = float(spec["moss"])
    if target_fraction <= 0:
        return set(), total_visible_area
    if target_fraction >= 1:
        return set(visible), total_visible_area
    ranked = sorted(visible, key=lambda i: values[i], reverse=True)
    covered = set()
    accumulated = 0.0
    target_area = target_fraction * total_visible_area
    for i in ranked:
        covered.add(i)
        accumulated += faces[i].area
        if accumulated >= target_area:
            break
    return _drop_tiny_islands(faces, covered), total_visible_area


def _drop_tiny_islands(faces, covered, min_faces=10):
    """Discard small disconnected fragments of the cover mask. A patch of a
    handful of faces is thin/fragile relative to the moss lip and voxel
    resolution and can vanish almost entirely in the union/remesh (or get
    nearest-matched back to dirt), which made the boost search flip
    between near-zero and a large overshoot on some outlines/seeds for a
    fraction of a percent change in the quantile threshold."""
    edge_to_faces = {}
    for i in covered:
        for ek in faces[i].edge_keys:
            edge_to_faces.setdefault(ek, []).append(i)
    adjacency = {i: set() for i in covered}
    for flist in edge_to_faces.values():
        if len(flist) == 2:
            a, b = flist
            adjacency[a].add(b)
            adjacency[b].add(a)
    seen, keep = set(), set()
    for i in covered:
        if i in seen:
            continue
        stack, comp = [i], set()
        while stack:
            f = stack.pop()
            if f in comp:
                continue
            comp.add(f)
            stack.extend(adjacency[f] - comp)
        seen |= comp
        if len(comp) >= min_faces:
            keep |= comp
    return keep


def _smoothed_cover_weight(dirt_obj, covered, iterations=10):
    """Laplacian-smooth a 0/1 seed (1 on covered faces' vertices) into a
    soft field. Used both for the moss thickness falloff AND (now) for
    where to cut the moss skin's own boundary: cutting at a smoothed-field
    threshold instead of the raw per-face quantile selection is what turns
    a jagged, mesh-resolution-scale boundary into a soft rounded one."""
    bm = bmesh.new()
    bm.from_mesh(dirt_obj.data)
    bm.faces.ensure_lookup_table()
    bm.verts.ensure_lookup_table()
    weight = {v.index: 0.0 for v in bm.verts}
    for i in covered:
        for v in bm.faces[i].verts:
            weight[v.index] = 1.0
    for _ in range(iterations):
        new_weight = dict(weight)
        for v in bm.verts:
            neighbours = [weight[e.other_vert(v).index] for e in v.link_edges]
            if neighbours:
                new_weight[v.index] = weight[v.index] * 0.35 + (sum(neighbours) / len(neighbours)) * 0.65
        weight = new_weight
    bm.free()
    return weight


def grow_moss(dirt_obj, spec, source_collection):
    """Build the moss skin: a softened copy of the dirt, cut down to where
    a smoothed cover field is non-negligible (a rounded boundary, not the
    raw jagged per-face quantile selection), pushed out along vertex
    normals by that same smoothed field as a thickness, clipped to the
    outline and solidified so it can be boolean-unioned into the dirt.
    Returns the moss object, or None if coverage is zero."""
    covered, total_visible_area = _cover_mask(dirt_obj, spec)
    if not covered:
        return None
    weight = _smoothed_cover_weight(dirt_obj, covered)

    moss_obj = dirt_obj.copy()
    moss_obj.data = dirt_obj.data.copy()
    moss_obj.name = spec["name"] + "_moss_skin"
    source_collection.objects.link(moss_obj)
    # A softened copy: chisel-scale facets should not survive as bumps in
    # the moss skin.
    soften = moss_obj.modifiers.new("Soften copy before growth", "SMOOTH")
    soften.factor, soften.iterations = 0.8, 4
    bpy.context.view_layer.objects.active = moss_obj
    bpy.ops.object.modifier_apply(modifier=soften.name)

    bm = bmesh.new()
    bm.from_mesh(moss_obj.data)
    bm.faces.ensure_lookup_table()
    bm.normal_update()
    # Cut at a low threshold of the already-smoothed cover field, not the
    # raw per-face quantile selection: the smoothed field's zero-crossing
    # is a soft rounded curve, so the moss patch this leaves has a rounded
    # edge that drapes over the dirt's own forms, instead of a jagged
    # staircase boundary following individual noise-ranked faces.
    threshold = 0.10
    keep_faces = [f for f in bm.faces
                  if sum(weight.get(v.index, 0.0) for v in f.verts) / len(f.verts) > threshold]
    keep_set = set(keep_faces)
    drop_faces = [f for f in bm.faces if f not in keep_set]
    if drop_faces:
        bmesh.ops.delete(bm, geom=drop_faces, context="FACES_ONLY")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    if not bm.faces:
        bm.free()
        bpy.data.objects.remove(moss_obj, do_unlink=True)
        return None
    lip = spec["depth"] * 0.045
    thickness_range = spec["depth"] * 0.110
    # A little clump-scale noise keeps patch centres from reading perfectly
    # flat; kept small per the brief ("the bulges small").
    clump_seed = int(spec["seed"]) + 991
    for v in bm.verts:
        w = weight.get(v.index, 0.0)
        clump = 0.5 + 0.5 * noise.noise(v.co * 6.0 + Vector((clump_seed, -clump_seed, clump_seed * 0.5)))
        thickness = lip + w * thickness_range * (0.75 + 0.25 * clump)
        v.co += v.normal * thickness
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(moss_obj.data)
    bm.free()
    moss_obj.data.update()

    solidify = moss_obj.modifiers.new("Solidify into the dirt", "SOLIDIFY")
    solidify.thickness = -(lip + 0.09) if spec["depth"] > 0.2 else -(lip + spec["depth"] * 0.25)
    solidify.offset = -1
    bpy.ops.object.modifier_apply(modifier=solidify.name)
    return moss_obj


def clip_to_envelope(obj, block, source_collection, materials):
    envelope = object_from_part(block["clip"], source_collection, materials)
    bpy.context.view_layer.objects.active = obj
    cut = obj.modifiers.new("Outline envelope clip (moss)", "BOOLEAN")
    cut.operation, cut.solver, cut.object = "INTERSECT", "MANIFOLD", envelope
    bpy.ops.object.modifier_apply(modifier=cut.name)
    bpy.data.objects.remove(envelope, do_unlink=True)


def union_moss(dirt_obj, moss_obj):
    cutters = bpy.data.collections.new("Union temporary (moss)")
    bpy.context.scene.collection.children.link(cutters)
    cutters.objects.link(moss_obj)
    bpy.context.view_layer.objects.active = dirt_obj
    modifier = dirt_obj.modifiers.new("Fuse moss cushions onto the dirt", "BOOLEAN")
    modifier.operation, modifier.operand_type = "UNION", "COLLECTION"
    modifier.collection, modifier.solver, modifier.use_self = cutters, "MANIFOLD", True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.collections.remove(cutters)
    keep_main_body(dirt_obj)


def reassign_materials(result, dirt_source, moss_source):
    dirt_verts = [v.co.copy() for v in dirt_source.data.vertices]
    dirt_faces = [list(f.vertices) for f in dirt_source.data.polygons]
    combined_verts, combined_faces, combined_materials = list(dirt_verts), list(dirt_faces), [DIRT_SLOT] * len(dirt_faces)
    if moss_source is not None:
        offset = len(combined_verts)
        combined_verts.extend(v.co.copy() for v in moss_source.data.vertices)
        for f in moss_source.data.polygons:
            combined_faces.append([offset + i for i in f.vertices])
            combined_materials.append(MOSS_SLOT)
    surface = BVHTree.FromPolygons(combined_verts, combined_faces)
    for face in result.data.polygons:
        hit = surface.find_nearest(face.center)
        if hit[2] is not None:
            face.material_index = combined_materials[hit[2]]


def measure_moss_coverage(result):
    """Area fraction of the whole visible surface (see _face_visible --
    everything except a clearly downward-facing underside) that is moss,
    by material, on the final mesh. Both moss and dirt faces are tested by
    their own final normal, symmetrically -- no per-material special
    case -- since _face_visible's broad "not underside" definition does
    not have the narrow-facing-cone problem a strict front/top test had
    (where a pillowed cushion's own normals spread over a hemisphere and
    got undercounted for reasons unrelated to how much moss actually grew
    there)."""
    visible_area, moss_area = 0.0, 0.0
    for face in result.data.polygons:
        if not _face_visible(face.normal):
            continue
        visible_area += face.area
        if face.material_index == MOSS_SLOT:
            moss_area += face.area
    return (moss_area / visible_area) if visible_area > 0 else 0.0


def assemble_dirt(block, destination, source_collection, materials):
    spec = block["spec"]
    target = float(spec["moss"])
    dirt_obj = assemble_dirt_base(block, source_collection, materials)
    moss_obj = grow_moss(dirt_obj, spec, source_collection)

    result = dirt_obj.copy()
    result.data = dirt_obj.data.copy()
    destination.objects.link(result)
    result.name = spec["name"]

    if moss_obj is not None:
        clip_to_envelope(moss_obj, block, source_collection, materials)
        if len(moss_obj.data.polygons):
            union_moss(result, moss_obj)
            remesh = result.modifiers.new("Fuse moss and dirt", "REMESH")
            remesh.mode, remesh.adaptivity, remesh.use_smooth_shade = "VOXEL", 0.05, True
            # Tied to the moss lip thickness, not just the outline tolerance:
            # a voxel coarser than the lip erases it outright.
            lip = spec["depth"] * 0.045
            remesh.voxel_size = min(max(0.005, spec["tolerance"] * 0.24), lip * 0.6)
            bpy.context.view_layer.objects.active = result
            bpy.ops.object.modifier_apply(modifier=remesh.name)
            keep_main_body(result)
            bm = bmesh.new()
            bm.from_mesh(result.data)
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method="FIXED", ngon_method="EAR_CLIP")
            bm.to_mesh(result.data)
            bm.free()
            result.data.update()
            # Material is reassigned here, right after the fresh remesh and
            # before smoothing/decimation, while triangle centres are still
            # close to their true dirt/moss source surface.
            reassign_materials(result, dirt_obj, moss_obj)
            smooth = result.modifiers.new("Soft moss cushions", "SMOOTH")
            smooth.factor, smooth.iterations = 0.30, 2
            bpy.ops.object.modifier_apply(modifier=smooth.name)
            _simplify_protecting_material(result, MOSS_SLOT, target_faces=18000)
            _clean_dangling_geometry(result)
        else:
            moss_obj = None
    if moss_obj is None:
        reassign_materials(result, dirt_obj, None)
    moss_coverage = measure_moss_coverage(result)

    health = mesh_health(result)
    solid = health["nonmanifold_edges"] == 0 and health["connected_components"] == 1 and health["volume"] > 0
    diff = abs(moss_coverage - target)
    on_target = diff <= 0.05 or target <= 0 or target >= 1
    print(f"{spec['name']}: moss_coverage={moss_coverage:.3f} target={target:.3f} solid={solid}", flush=True)
    # A single direct area-weighted quantile pass, no multi-attempt search:
    # placement and measurement now share the same broad "not underside"
    # visibility definition, so the quantile footprint fraction and the
    # final measured coverage track closely enough not to need one.
    if not on_target:
        raise RuntimeError(
            f"{spec['name']}: measured moss_coverage {moss_coverage:.3f} is outside "
            f"+/-0.05 of the requested moss {target:.3f}."
        )
    if not solid:
        raise RuntimeError(f"{spec['name']}: could not produce a solid, single-component mesh: {health}")

    # Camera-frame local axes -> world axes.
    side_rotation = Matrix(spec["camera_basis"]).to_4x4()
    result.data.transform(side_rotation)
    result.data.update()
    for face in result.data.polygons:
        face.use_smooth = False
    result["input_polygon"] = json.dumps({"outer": spec["outer"], "holes": spec["holes"]})
    result["seed"] = spec["seed"]
    result["depth"] = spec["depth"]
    result["input_plane"] = "Fixed-camera side silhouette"
    result["boundary_tolerance"] = spec["tolerance"]
    result["fit_mode"] = spec.get("fit_mode", "projected_silhouette")
    result["gameplay_plane"] = "Depth 0 in camera_basis coordinates; use gameplay_collision.json for 2D collision"
    result["generator"] = "Dirt and moss block / dirtgen.py"
    result["moss_coverage"] = moss_coverage
    result.select_set(False)
    return result, moss_coverage


def _visible_sdf(normal):
    # Same rule as dirt_sdf.visible: not the unseen back, not the underside.
    return normal.z > -0.25 and normal.y > -0.70


def _transfer_moss_shade(mesh, source_vertices, source_faces, source_shade):
    """Project SDF clump hints onto the final mesh after repair and decimation.

    Voxel remesh does not preserve point attributes, so sample the original
    surface only once all topology-changing modifiers have finished.
    """
    triangles = []
    for face in source_faces:
        triangles.extend((face[0], face[i], face[i + 1]) for i in range(1, len(face) - 1))
    points = [Vector(co) for co in source_vertices]
    tree = BVHTree.FromPolygons(points, triangles)
    tip = mesh.attributes.new(name="moss_tip", type="FLOAT", domain="POINT")
    interior = mesh.attributes.new(name="moss_interior", type="FLOAT", domain="POINT")
    for vertex in mesh.vertices:
        hit, _, triangle_index, _ = tree.find_nearest(vertex.co)
        if triangle_index is None:
            continue
        a, b, c = (points[i] for i in triangles[triangle_index])
        v0, v1, v2 = b - a, c - a, hit - a
        d00, d01, d11 = v0.dot(v0), v0.dot(v1), v1.dot(v1)
        d20, d21 = v2.dot(v0), v2.dot(v1)
        denom = d00 * d11 - d01 * d01
        if abs(denom) < 1e-12:
            weights = (1.0, 0.0, 0.0)
        else:
            wb = (d11 * d20 - d01 * d21) / denom
            wc = (d00 * d21 - d01 * d20) / denom
            weights = (1.0 - wb - wc, wb, wc)
        indices = triangles[triangle_index]
        tip.data[vertex.index].value = sum(weights[i] * source_shade[indices[i]][0] for i in range(3))
        interior.data[vertex.index].value = sum(weights[i] * source_shade[indices[i]][1] for i in range(3))


def assemble_sdf(block, destination, materials):
    """Build the surface-nets mesh from dirt_sdf.py, keep its per-face moss
    flag, and reduce it to the triangle budget."""
    spec = block["spec"]
    data = block["mesh"]
    mesh = bpy.data.meshes.new(spec["name"])
    mesh.from_pydata(data["vertices"], [], data["faces"])
    mesh.update()
    obj = bpy.data.objects.new(spec["name"], mesh)
    destination.objects.link(obj)
    for mat in materials:
        mesh.materials.append(mat)
    mesh.polygons.foreach_set("material_index", data["materials"])
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method="BEAUTY", ngon_method="BEAUTY")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    bpy.context.view_layer.objects.active = obj
    health = mesh_health(obj)
    if health["nonmanifold_edges"] or health["connected_components"] != 1:
        # Surface nets can pinch at an ambiguous voxel; a voxel remesh at the
        # same resolution repairs it, and the moss flag is copied back.
        print(f"{spec['name']}: repairing surface nets {health}", flush=True)
        source = obj.copy()
        source.data = obj.data.copy()
        destination.objects.link(source)
        remesh = obj.modifiers.new("Repair surface nets", "REMESH")
        remesh.mode, remesh.voxel_size, remesh.adaptivity = "VOXEL", float(spec.get("voxel", 0.02)) * 0.8, 0
        bpy.ops.object.modifier_apply(modifier=remesh.name)
        keep_main_body(obj)
        tree = BVHTree.FromObject(source, bpy.context.evaluated_depsgraph_get())
        flags = [p.material_index for p in source.data.polygons]
        for face in obj.data.polygons:
            hit = tree.find_nearest(face.center)
            face.material_index = flags[hit[2]] if hit[2] is not None else DIRT_SLOT
        bpy.data.objects.remove(source, do_unlink=True)
    smooth = obj.modifiers.new("Soften voxel steps", "SMOOTH")
    smooth.factor, smooth.iterations = 0.5, 2
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    # Triangulate first: the repair remesh leaves quads, and the budget is
    # in triangles.
    tri = obj.modifiers.new("Triangulate", "TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=tri.name)
    dec = obj.modifiers.new("Triangle budget", "DECIMATE")
    dec.ratio = min(1.0, 18000 / max(1, len(obj.data.polygons)))
    bpy.ops.object.modifier_apply(modifier=dec.name)
    tri = obj.modifiers.new("Triangulate", "TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=tri.name)
    _clean_dangling_geometry(obj)
    _transfer_moss_shade(mesh, data["vertices"], data["faces"], data["shade"])
    seen = moss = 0.0
    for face in obj.data.polygons:
        if _visible_sdf(face.normal):
            seen += face.area
            if face.material_index == MOSS_SLOT:
                moss += face.area
    coverage = moss / seen if seen else 0.0
    target = float(spec["moss"])
    print(f"{spec['name']}: moss_coverage={coverage:.3f} target={target:.3f}", flush=True)
    if abs(coverage - target) > 0.05 and 0 < target < 1:
        raise RuntimeError(f"{spec['name']}: moss_coverage {coverage:.3f} is outside +/-0.05 of {target:.3f}")
    obj.data.transform(Matrix(spec["camera_basis"]).to_4x4())
    obj.data.update()
    for face in obj.data.polygons:
        face.use_smooth = True
    obj["input_polygon"] = json.dumps({"outer": spec["outer"], "holes": spec["holes"]})
    obj["seed"] = spec["seed"]
    obj["depth"] = spec["depth"]
    obj["boundary_tolerance"] = spec["tolerance"]
    obj["fit_mode"] = spec.get("fit_mode", "playable_perimeter")
    obj["generator"] = "Dirt and moss block / dirtgen.py"
    obj["moss_coverage"] = coverage
    return obj, coverage


def bake_color(obj, path):
    """Local variant of blender_build.bake_color: same emission-bake
    technique, but the baked material is named for dirt-and-moss instead of
    "portable painted slate"."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.015)
    bpy.ops.object.mode_set(mode="OBJECT")
    image = bpy.data.images.new(obj.name + "_BaseColor", width=2048, height=2048)
    restore = []
    for mat in obj.data.materials:
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        out = next(n for n in nodes if n.type == "OUTPUT_MATERIAL")
        bs = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
        original = out.inputs["Surface"].links[0].from_socket
        emission = nodes.new("ShaderNodeEmission")
        links.new(bs.inputs["Base Color"].links[0].from_socket, emission.inputs["Color"])
        links.new(emission.outputs[0], out.inputs["Surface"])
        target = nodes.new("ShaderNodeTexImage")
        target.image = image
        nodes.active = target
        target.select = True
        restore.append((mat, out, original, emission))
    scene = bpy.context.scene
    old_samples = scene.cycles.samples
    scene.cycles.samples = 8
    bpy.ops.object.bake(type="EMIT", margin=8)
    scene.cycles.samples = old_samples
    path.parent.mkdir(exist_ok=True)
    image.filepath_raw = str(path)
    image.file_format = "PNG"
    image.save()
    image.pack()
    for mat, out, original, emission in restore:
        mat.node_tree.links.new(original, out.inputs["Surface"])
        mat.node_tree.nodes.remove(emission)
    normal = bpy.data.images.new(obj.name + "_Normal", width=2048, height=2048)
    normal.colorspace_settings.name = "Non-Color"
    for mat in obj.data.materials:
        target = mat.node_tree.nodes.new("ShaderNodeTexImage")
        target.image = normal
        mat.node_tree.nodes.active = target
    scene.cycles.samples = 8
    bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", margin=12)
    scene.cycles.samples = old_samples
    normal.filepath_raw = str(path.parent / (obj.name + "_Normal.png"))
    normal.file_format = "PNG"
    normal.save()
    normal.pack()
    original_mats = list(obj.data.materials)
    baked = bpy.data.materials.new(obj.name + " / portable dirt and moss")
    baked.use_nodes = True
    baked.diffuse_color = (0.45, 0.35, 0.22, 1)
    bs = baked.node_tree.nodes.get("Principled BSDF")
    bs.inputs["Roughness"].default_value = 0.92
    target = baked.node_tree.nodes.new("ShaderNodeTexImage")
    target.image = image
    baked.node_tree.links.new(target.outputs["Color"], bs.inputs["Base Color"])
    normal_tex = baked.node_tree.nodes.new("ShaderNodeTexImage")
    normal_tex.image = normal
    normal_node = baked.node_tree.nodes.new("ShaderNodeNormalMap")
    baked.node_tree.links.new(normal_tex.outputs["Color"], normal_node.inputs["Color"])
    baked.node_tree.links.new(normal_node.outputs["Normal"], bs.inputs["Normal"])
    indices = [p.material_index for p in obj.data.polygons]
    obj.data.materials.clear()
    obj.data.materials.append(baked)
    return original_mats, indices


def export_model(obj, path):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    original_mats, indices = bake_color(obj, path.parent.parent / "textures" / (obj.name + "_BaseColor.png"))
    bpy.ops.export_scene.gltf(filepath=str(path.with_suffix(".glb")), export_format="GLB",
                               use_selection=True, export_materials="EXPORT", export_yup=True,
                               export_extras=True)
    obj.data.materials.clear()
    for mat in original_mats:
        obj.data.materials.append(mat)
    for face, index in zip(obj.data.polygons, indices):
        face.material_index = index
    obj.select_set(False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--no-render", action="store_true")
    parser.add_argument("--preview-only", action="store_true")
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--render-only")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    source = Path(args.source)
    out = source.parent
    for directory in ["models", "renders", "evaluated"]:
        (out / directory).mkdir(exist_ok=True)
    data = json.loads(source.read_text(encoding="utf-8"))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene, camera, ground = make_stage(args.samples)
    if args.preview_only:
        scene.render.resolution_x = 600
        scene.render.resolution_y = 600
    objects = []
    for block in data["blocks"]:
        spec = block["spec"]
        print(f"Assembling {spec['name']}...", flush=True)
        collection = bpy.data.collections.new(spec["name"])
        scene.collection.children.link(collection)
        sources = bpy.data.collections.new(spec["name"] + " / editable source solids")
        scene.collection.children.link(sources)
        materials = [
            dirt_material(spec["name"] + " / dirt", spec["dirt_color"], 1.0, spec),
            moss_material(spec["name"] + " / moss", spec["moss_color"], 1.0, spec),
        ]
        start = time.monotonic()
        if "mesh" in block:
            obj, moss_coverage = assemble_sdf(block, collection, materials)
        else:
            obj, moss_coverage = assemble_dirt(block, collection, sources, materials)
        sources.hide_render = True
        sources.hide_viewport = True
        health = mesh_health(obj)
        health["assembly_seconds"] = round(time.monotonic() - start, 3)
        health["moss_coverage"] = moss_coverage
        if health["nonmanifold_edges"] or health["connected_components"] != 1 or health["volume"] <= 0:
            (out / "debug_invalid.json").write_text(json.dumps(
                {"vertices": [list(v.co) for v in obj.data.vertices],
                 "faces": [list(p.vertices) for p in obj.data.polygons]}))
            raise RuntimeError(f"{spec['name']}: solid-mesh validation failed: {health}")
        (out / "evaluated" / (spec["name"] + ".json")).write_text(json.dumps({
            "spec": spec,
            "health": health,
            "vertices": [list(v.co) for v in obj.data.vertices],
            "triangles": [list(p.vertices) for p in obj.data.polygons],
        }, separators=(",", ":")), encoding="utf-8")
        print(f"Health: {health}", flush=True)
        if not args.preview_only:
            export_model(obj, out / "models" / spec["name"])
        obj.hide_render = True
        objects.append((obj, spec))

    scene.render.threads = 8
    key = add_area("Large soft key", (1, -4, 7), 1350, 5.0, (1, 0.90, 0.79), (0, 0, 1))
    fill = add_area("Cool fill", (-5, -1, 3), 420, 4, (0.74, 0.84, 1), (0, 0, 1))
    rim = add_area("Upper rim", (2, 4, 6), 1900, 3, (1, 0.97, 0.92), (0, 0, 1))
    if not args.no_render:
        for obj, spec in objects:
            if args.render_only and spec["name"] != args.render_only:
                continue
            obj.hide_render = False
            bpy.context.view_layer.update()
            points = [Vector(c) for c in obj.bound_box]
            mins = Vector(tuple(min(p[i] for p in points) for i in range(3)))
            maxs = Vector(tuple(max(p[i] for p in points) for i in range(3)))
            center = (mins + maxs) / 2
            span = max(maxs.x - mins.x, maxs.y - mins.y, maxs.z - mins.z)
            ground.location.z = mins.z - 0.018
            basis = Matrix(spec.get("camera_basis", [[1, 0, 0], [0, 0, -1], [0, 1, 0]]))
            view_right, view_up, view_toward = (basis.col[i].to_3d() for i in range(3))
            camera.location = center + (view_toward + view_right * .22 + view_up * .08).normalized() * span * 3
            camera.data.ortho_scale = span * 1.3
            look_at(camera, center)
            scene.render.filepath = str(out / "renders" / (spec["name"] + ".png"))
            bpy.ops.render.render(write_still=True)
            projected = [basis.transposed() @ v.co for v in obj.data.vertices]
            vmin = Vector(tuple(min(p[i] for p in projected) for i in range(3)))
            vmax = Vector(tuple(max(p[i] for p in projected) for i in range(3)))
            view_center = basis @ ((vmin + vmax) / 2)
            camera.location = view_center + view_toward * span * 3
            camera.data.ortho_scale = max(vmax.x - vmin.x, vmax.y - vmin.y) * 1.16
            look_at(camera, view_center)
            ground.hide_render = True
            scene.render.filepath = str(out / "renders" / (spec["name"] + "_side.png"))
            bpy.ops.render.render(write_still=True)
            ground.hide_render = False
            obj.hide_render = True

    for i, (obj, spec) in enumerate(objects):
        obj.hide_render = False
        lowest_z = min(v.co.z for v in obj.data.vertices)
        obj.location = ((i % 3 - 1) * 4.2, (i // 3) * 4.6, -lowest_z)
    ground.location.z = -0.018
    camera.location = (10, -17, 15)
    camera.data.ortho_scale = 16 if len(objects) > 1 else 6
    look_at(camera, (0, 1.8 if len(objects) > 1 else 0, 1.0))
    if len(objects) == 1:
        objects[0][0].location = (0, 0, 0)
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                area.spaces.active.region_3d.view_distance = 17
                area.spaces.active.region_3d.view_location = (0, 2, 1)
                area.spaces.active.shading.type = "MATERIAL"
    scene["Generator help"] = "Edit polygons.json and run dirtgen.py; see README.md."
    guides = bpy.data.collections.new("Gameplay centre-plane guides - toggle visibility")
    scene.collection.children.link(guides)
    orange = bpy.data.materials.new("Gameplay outline orange")
    orange.diffuse_color = (1, .25, .025, 1)
    for block, (obj, spec) in zip(data["blocks"], objects):
        guide = object_from_part(block["gameplay_section"], guides, [orange])
        guide.name = spec["name"] + " / gameplay plane"
        guide.data.transform(Matrix(spec["camera_basis"]).to_4x4())
        guide.location = obj.location
        guide.display_type = "WIRE"
        guide.show_in_front = True
        guide.hide_render = True
    guides.hide_viewport = True
    guides.hide_render = True
    scene["Generator help"] = "See gameplay_collision.json and the validation reports for the gameplay slice and visible outline. Hidden guide collection marks the gameplay plane."
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "dirt_moss_blocks.blend"))
    print("BLENDER_BUILD_COMPLETE", flush=True)


if __name__ == "__main__":
    main()
