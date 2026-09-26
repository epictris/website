"""Blender-side mesh assembly, procedural material, preview rendering and export."""
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


sys.path.insert(0, str(Path(__file__).resolve().parent))
from stone_materials import stone_material, worn_edge_color


def object_from_part(part, collection, materials):
    mesh = bpy.data.meshes.new(part["name"])
    mesh.from_pydata(part["vertices"], [], part["faces"])
    mesh.update()
    obj = bpy.data.objects.new(part["name"], mesh)
    collection.objects.link(obj)
    for mat in materials:
        mesh.materials.append(mat)
    for face in mesh.polygons:
        face.material_index = part["material"]
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    return obj


def mesh_health(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    result = {
        "vertices": len(bm.verts), "faces": len(bm.faces),
        "boundary_edges": sum(e.is_boundary for e in bm.edges),
        "nonmanifold_edges": sum(not e.is_manifold for e in bm.edges),
        "invalid_edge_face_counts": [len(e.link_faces) for e in bm.edges if not e.is_manifold][:20],
        "volume": abs(bm.calc_volume(signed=True)),
    }
    remaining = set(bm.verts)
    components = 0
    while remaining:
        components += 1
        queue = [remaining.pop()]
        while queue:
            v = queue.pop()
            for edge in v.link_edges:
                other = edge.other_vert(v)
                if other in remaining:
                    remaining.remove(other)
                    queue.append(other)
    result["connected_components"] = components
    bm.free()
    return result


def assemble_rock(rock, destination, source_collection, materials):
    spec = rock["spec"]
    pieces = [object_from_part(part, source_collection, materials) for part in rock["parts"]]
    if "clip" in rock:
        envelope = object_from_part(rock["clip"], source_collection, materials)
        for piece, part in zip(pieces, rock["parts"]):
            if not part.get("clip_to_outline"):
                continue
            bpy.context.view_layer.objects.active = piece
            cut = piece.modifiers.new("Camera silhouette constraint", "BOOLEAN")
            cut.operation = "INTERSECT"
            cut.solver = "MANIFOLD"
            cut.object = envelope
            bpy.ops.object.modifier_apply(modifier=cut.name)
            if part.get('chunk_bevel') and len(piece.data.polygons):
                bevel=piece.modifiers.new('Broad broken chunk corners','BEVEL')
                bevel.width=part['chunk_bevel']; bevel.segments=(1 if spec.get('game_low_poly') else
                    2 if spec.get('soften_thin_edges') else 1)
                bevel.limit_method='ANGLE'; bevel.angle_limit=math.radians(22)
                bpy.ops.object.modifier_apply(modifier=bevel.name)
                for face in piece.data.polygons:
                    face.material_index=part['material']
        bpy.data.objects.remove(envelope, do_unlink=True)
    if spec.get('hybrid_faces'):
        from hybrid_geometry import taper_chunk
        for piece,part in zip(pieces,rock['parts']):
            taper_chunk(piece,spec,part['name'].startswith('buried_'),part['name'])
        if spec.get('solid_chunk_edges'):
            from solid_chunks import reinforce_chunks
            pieces=reinforce_chunks(pieces,rock['parts'],spec)
        # Constrain any oblique displaced corners before unioning the chunks.
        guard=object_from_part(rock['clip'],source_collection,materials)
        for piece in pieces:
            bpy.context.view_layer.objects.active=piece
            cut=piece.modifiers.new('Keep tilted chunk inside playable envelope','BOOLEAN')
            cut.operation='INTERSECT'; cut.solver='MANIFOLD'; cut.object=guard
            bpy.ops.object.modifier_apply(modifier=cut.name)
            if spec.get('game_low_poly') and piece.name.startswith('fracture_chunk_'):
                clip_pointed_game_chunk_tips(piece,spec)
        bpy.data.objects.remove(guard,do_unlink=True)
        if spec.get('soften_thin_edges'):
            # Round acute projecting lips locally; protect the gameplay band.
            for piece in pieces[1:]:
                bm=bmesh.new(); bm.from_mesh(piece.data); bm.normal_update()
                sharp=[e for e in bm.edges if e.is_manifold and e.is_convex
                    and e.calc_face_angle(0)>math.radians(70)
                    and all(abs(v.co.z)>spec['depth']*.065 for v in e.verts)]
                if sharp:
                    bmesh.ops.bevel(bm,geom=sharp,offset=.045,
                        segments=1 if spec.get('game_low_poly') else 3,
                        affect='EDGES',clamp_overlap=True,loop_slide=True)
                bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
                bm.to_mesh(piece.data); bm.free()

    core = pieces[0]
    result = core.copy()
    result.data = core.data.copy()
    destination.objects.link(result)
    result.name = spec["name"]
    cutters = bpy.data.collections.new("Union temporary")
    bpy.context.scene.collection.children.link(cutters)
    for obj in pieces[1:]:
        cutters.objects.link(obj)
    bpy.context.view_layer.objects.active = result
    result.select_set(True)
    modifier = result.modifiers.new("Join fractured slabs into one solid", "BOOLEAN")
    modifier.operation = "UNION"
    modifier.operand_type = "COLLECTION"
    modifier.collection = cutters
    modifier.solver = "MANIFOLD"
    modifier.use_self = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    print(f"After union: {mesh_health(result)}", flush=True)
    bpy.data.collections.remove(cutters)
    if spec.get("construction") == "volume":
        keep_main_body(result)
        # Voxel consolidation regularizes tiny intersection slivers between
        # genuinely overlapping 3D slabs. Resolution is tied to fit tolerance;
        # the final projected mesh is checked after this operation.
        if spec["tolerance"] <= 0:
            raise ValueError("The volume generator requires a positive silhouette tolerance for remeshing.")
        remesh = result.modifiers.new("Consolidate overlapping rock volume", "REMESH")
        remesh.mode = "VOXEL"
        remesh.voxel_size = spec["tolerance"] * .30 / math.sqrt(max(1,spec["detail"]))
        if spec.get('balanced_hybrid'):
            # The previous 0.0065 m voxel pass made hundreds of thousands of
            # temporary polygons before the facets were simplified again.
            # Keep enough resolution for the rounded chunk edges and outline.
            remesh.voxel_size=min(remesh.voxel_size,.012)
        elif spec.get('chunked_sides'):
            remesh.voxel_size=min(remesh.voxel_size,.0065 if spec.get('broad_side_chunks') else .0045)
        remesh.adaptivity = .06
        remesh.use_smooth_shade = True
        bpy.ops.object.modifier_apply(modifier=remesh.name)
        keep_main_body(result)
    bevel = result.modifiers.new("Small fractured edge rounding", "BEVEL")
    bevel.width = (0 if spec.get("construction") == "volume" else
                   min(spec["tolerance"] * 0.12, spec["depth"] * 0.006))
    bevel.segments = 2
    bevel.limit_method = "ANGLE"
    bevel.angle_limit = math.radians(35)
    if bevel.width > 0:
        bpy.ops.object.modifier_apply(modifier=bevel.name)
    else:
        result.modifiers.remove(bevel)
    print(f"After bevel: {mesh_health(result)}", flush=True)
    # Weld numerical coincidences, consistently orient faces, triangulate export.
    bm = bmesh.new()
    bm.from_mesh(result.data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method="FIXED", ngon_method="EAR_CLIP")
    bm.to_mesh(result.data)
    bm.free()
    result.data.update()
    smooth = result.modifiers.new("Remove tiny voxel ridges", "SMOOTH")
    smooth.factor = .65
    smooth.iterations = 2 if spec.get('chunked_sides') else 5
    bpy.context.view_layer.objects.active = result
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    if spec.get('join_undercuts'):
        from solid_chunks import close_narrow_recesses
        close_narrow_recesses(result,spec)
        guard=object_from_part(rock['clip'],source_collection,materials)
        bpy.context.view_layer.objects.active=result
        cut=result.modifiers.new('Retain the playable outline','BOOLEAN')
        cut.operation='INTERSECT'; cut.solver='MANIFOLD'; cut.object=guard
        bpy.ops.object.modifier_apply(modifier=cut.name)
        bpy.data.objects.remove(guard,do_unlink=True)
        keep_main_body(result)
        weld=result.modifiers.new('Consolidate the blended joins','REMESH')
        weld.mode='VOXEL'; weld.voxel_size=.008; weld.adaptivity=.02
        bpy.ops.object.modifier_apply(modifier=weld.name)
        keep_main_body(result)
    # Simplify the smooth voxel union into larger sculpted planes.
    dec = result.modifiers.new("Broad sculpted facets", "DECIMATE")
    if spec.get('game_low_poly'):
        # Keep broad face placement and the validated gameplay outline, but
        # budget far fewer triangles before the final edge treatment.
        dec.ratio=min(1.0, 3000/max(1,len(result.data.polygons)))
    elif spec.get('balanced_hybrid'):
        # Preserve the broad faces and two-segment rock bevel, while budgeting
        # the surface before the bevel expands its edge loops.
        dec.ratio=min(1.0, 7000/max(1,len(result.data.polygons)))
    else:
        dec.ratio = .18 if spec.get('join_undercuts') else (.085 if spec.get('broad_side_chunks') else (.045 if spec.get('hybrid_faces') else .075))
    bpy.context.view_layer.objects.active = result
    bpy.ops.object.modifier_apply(modifier=dec.name)
    if rock.get('chunk_seeds'):
        from mathutils.bvhtree import BVHTree
        result.data.update()
        source_vertices=[]; source_faces=[]; source_materials=[]
        for piece in pieces:
            offset=len(source_vertices)
            source_vertices.extend([v.co.copy() for v in piece.data.vertices])
            for face in piece.data.polygons:
                source_faces.append([offset+i for i in face.vertices])
                source_materials.append(face.material_index)
        surface=BVHTree.FromPolygons(source_vertices,source_faces)
        for face in result.data.polygons:
            hit=surface.find_nearest(face.center)
            if hit[2] is not None:
                face.material_index=source_materials[hit[2]]
    bevel = result.modifiers.new("Chipped light-catching edges", "BEVEL")
    bevel.width = (.018 if spec.get('game_low_poly') else
                   .020 if spec.get('soften_thin_edges') else .012)
    bevel.segments = (1 if spec.get('game_low_poly') else
                      2 if spec.get('soften_thin_edges') else 1)
    bevel.limit_method = "ANGLE"
    bevel.angle_limit = math.radians(36 if spec.get('game_low_poly') else 27)
    # Paint only the actual bevel bands. Mesh Pointiness is unstable after
    # remeshing and decimation and draws highlights across triangle junctions.
    bevel.material = len(result.data.materials) - 1
    if spec.get('join_undercuts'):
        result.modifiers.remove(bevel)
    else:
        bpy.ops.object.modifier_apply(modifier=bevel.name)
    tri = result.modifiers.new("Export triangles", "TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=tri.name)
    # Boolean/decimation can leave wire edges with no incident surface faces.
    bm=bmesh.new(); bm.from_mesh(result.data)
    # Remove bevel-generated dangling triangles attached to an otherwise
    # closed edge; these have two open edges and one edge with three faces.
    flaps=[f for f in bm.faces if sum(e.is_boundary for e in f.edges)>=2
           and any(len(e.link_faces)>2 for e in f.edges)]
    if flaps: bmesh.ops.delete(bm,geom=flaps,context='FACES_ONLY')
    loose=[e for e in bm.edges if not e.link_faces]
    if loose: bmesh.ops.delete(bm,geom=loose,context='EDGES')
    isolated=[v for v in bm.verts if not v.link_faces]
    if isolated: bmesh.ops.delete(bm,geom=isolated,context='VERTS')
    bm.to_mesh(result.data); bm.free()
    # (screen x, screen up, depth) -> (world X, -world Y, world Z).
    # Rotation preserves handedness and normal orientation.
    side_rotation = (Matrix(spec["camera_basis"]).to_4x4() if "camera_basis" in spec
                     else Matrix.Rotation(math.pi / 2, 4, "X"))
    result.data.transform(side_rotation)
    result.data.update()
    for piece in pieces:
        piece.data.transform(side_rotation)
        piece.data.update()
    for face in result.data.polygons:
        # Only the narrow worn bevels interpolate normals. Larger rock planes
        # remain faceted and readable at the lower game mesh budget.
        face.use_smooth = bool(spec.get('game_low_poly') and face.material_index == len(result.data.materials)-1)
    result["input_polygon"] = json.dumps({"outer": spec["outer"], "holes": spec["holes"]})
    result["seed"] = spec["seed"]
    result["depth"] = spec["depth"]
    result["input_plane"] = "Fixed-camera side silhouette"
    result["boundary_tolerance"] = spec["tolerance"]
    result['fit_mode']=spec.get('fit_mode','projected_silhouette')
    if spec.get('fit_mode') in ['centre_plane','playable_perimeter']:
        result['gameplay_plane']='Depth 0 in camera_basis coordinates; use gameplay_collision.json for 2D collision'
    result["generator"] = "Polygon Rock / rockgen.py"
    result.select_set(False)
    return result


def keep_main_body(obj):
    """Remove isolated chips and sealed interior shells after volume clipping."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    remaining = set(bm.verts)
    groups = []
    while remaining:
        component = {remaining.pop()}
        queue = list(component)
        while queue:
            v = queue.pop()
            for e in v.link_edges:
                other = e.other_vert(v)
                if other in remaining:
                    remaining.remove(other)
                    component.add(other)
                    queue.append(other)
        groups.append(component)
    if len(groups) > 1:
        groups.sort(key=lambda group: sum(f.calc_area() for f in {f for v in group for f in v.link_faces}), reverse=True)
        bmesh.ops.delete(bm, geom=[v for group in groups[1:] for v in group], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()


def clip_pointed_game_chunk_tips(obj,spec):
    """Cap isolated upper/lower depth tips left by clipping structural chunks.

    In the generator's local frame Y is screen-up and Z is visual depth. A
    short diagonal support band whose X span is tiny compared with its parent
    chunk identifies a point instead of a broad ridge. Cut only that extreme,
    well away from the protected gameplay depth plane.
    """
    bm=bmesh.new(); bm.from_mesh(obj.data)
    if not bm.faces:
        bm.free(); return
    cuts=0
    width=max(v.co.x for v in bm.verts)-min(v.co.x for v in bm.verts)
    band=min(.022,spec['depth']*.015)
    inset=min(.14,spec['depth']*.09)
    for up in (-1,1):
        for toward in (-1,1):
            normal=Vector((0,up,toward)).normalized()
            top=max(v.co.dot(normal) for v in bm.verts)
            extreme=[v for v in bm.verts if v.co.dot(normal)>=top-band]
            if len(extreme)<2:
                continue
            span=max(v.co.x for v in extreme)-min(v.co.x for v in extreme)
            if span>min(.15,width*.25):
                continue
            threshold=top-inset
            removed=[v for v in bm.verts if v.co.dot(normal)>threshold]
            if not removed or any(abs(v.co.z)<spec['depth']*.065 for v in removed):
                continue
            band_limit=spec['depth']*.065
            crosses_band=False
            for edge in bm.edges:
                a,b=(v.co for v in edge.verts)
                for depth_plane in (-band_limit,band_limit):
                    if (a.z-depth_plane)*(b.z-depth_plane)<0:
                        t=(depth_plane-a.z)/(b.z-a.z)
                        if (a+(b-a)*t).dot(normal)>threshold:
                            crosses_band=True
                            break
                if crosses_band:
                    break
            if crosses_band:
                continue
            bmesh.ops.bisect_plane(bm,geom=list(bm.verts)+list(bm.edges)+list(bm.faces),
                dist=1e-6,plane_co=normal*threshold,plane_no=normal,
                clear_outer=True,clear_inner=False)
            open_edges=[e for e in bm.edges if e.is_boundary]
            if open_edges:
                bmesh.ops.holes_fill(bm,edges=open_edges,sides=0)
            cuts+=1
    if cuts:
        bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
        bm.to_mesh(obj.data)
        obj.data.update()
        print(f'Capped {cuts} pointed tips on {obj.name}',flush=True)
    bm.free()


def inside_ring(x, y, ring):
    inside = False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        if (a[1] > y) != (b[1] > y):
            if x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
                inside = not inside
    return inside


def distance_to_edges(x, y, edges):
    best = float("inf")
    for ax, ay, bx, by in edges:
        dx, dy = bx-ax, by-ay
        length = dx*dx+dy*dy
        t = max(0, min(1, ((x-ax)*dx+(y-ay)*dy)/length)) if length else 0
        best = min(best, (x-ax-t*dx)**2+(y-ay-t*dy)**2)
    return math.sqrt(best)


def add_surface_relief(obj, spec):
    """Small real surface displacement, preserving protected silhouette samples."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    # Limit subdivisions by physical edge length; no smoothing/shrinkage.
    for _ in range(2):
        long_edges = [e for e in bm.edges if e.calc_length() > 0.12 / spec["detail"]]
        if long_edges:
            bmesh.ops.subdivide_edges(bm, edges=long_edges, cuts=1, use_grid_fill=True)
    bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method="FIXED", ngon_method="EAR_CLIP")
    # Bevel triangulation can produce a coincident, oppositely oriented pair on
    # an extremely short edge. Remove that zero-thickness flap, then orphaned
    # edges/vertices, without joining separate surface vertices.
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    groups = {}
    for face in bm.faces:
        groups.setdefault(tuple(sorted(v.index for v in face.verts)), []).append(face)
    duplicate_faces = []
    for faces in groups.values():
        if len(faces) == 2:
            duplicate_faces.extend(faces)
        elif len(faces) > 2:
            raise RuntimeError("Unexpected repeated faces after subdivision")
    if duplicate_faces:
        bmesh.ops.delete(bm, geom=duplicate_faces, context="FACES_ONLY")
    wires = [e for e in bm.edges if not e.link_faces]
    if wires:
        bmesh.ops.delete(bm, geom=wires, context="EDGES")
    loose = [v for v in bm.verts if not v.link_edges]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.normal_update()
    edges = [(*a, *b) for ring in [spec["outer"], *spec["holes"]]
             for a, b in zip(ring, ring[1:] + ring[:1])]
    offset = Vector((spec["seed"] * 0.37, spec["seed"] * 0.71, spec["seed"] * 0.19))
    amplitude = min(spec["depth"] * 0.006, 0.007) * spec.get("weathering",.7)
    basis = Matrix(spec.get("camera_basis", [[1,0,0],[0,0,-1],[0,1,0]]))
    for vertex in bm.verts:
        original = vertex.co.copy()
        sample = basis @ original + offset
        # Shape relief follows the rock's vertical geology on front AND back.
        # Broad planes remain readable; small strata are layered over them.
        broad = noise.noise(Vector((sample.x*6,sample.y*6,sample.z*2)), noise_basis="PERLIN_ORIGINAL")
        warp = noise.noise(sample*1.8,noise_basis="PERLIN_ORIGINAL")
        layer = noise.noise(Vector((sample.x*4,sample.y*4,sample.z*24+warp*1.3)),noise_basis="PERLIN_ORIGINAL")
        value = broad + .35*spec.get("strata",.65)*layer
        distance = distance_to_edges(original.x,original.y,edges)
        protection = min(1,distance/max(spec["tolerance"]*1.5,1e-8))
        protection = protection*protection*(3-2*protection)
        proposed = original + vertex.normal * (value * amplitude * protection)
        # Protect a small band along input edges, including concave corners and
        # hole boundaries. Vertical relief is allowed within that band.
        if (distance_to_edges(original.x, original.y, edges) < 1e-4
                or not inside_ring(proposed.x, proposed.y, spec["outer"])
                or any(inside_ring(proposed.x, proposed.y, ring) for ring in spec["holes"])):
            proposed.x, proposed.y = original.x, original.y
        vertex.co = proposed
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def look_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def add_area(name, position, power, size, color, target):
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.shape, data.size, data.color = power, "DISK", size, color
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    look_at(obj, target)
    return obj


def make_stage(samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.denoising_use_gpu = False
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 4
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -0.6
    scene.world.color = (0.16, 0.16, 0.16)
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.18, 0.21, 0.26, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.2
    camera_data = bpy.data.cameras.new("Inspection camera")
    camera = bpy.data.objects.new("Inspection camera", camera_data)
    scene.collection.objects.link(camera)
    camera_data.type = "ORTHO"
    scene.camera = camera
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.015))
    ground = bpy.context.object
    ground.name = "Studio ground"
    mat = bpy.data.materials.new("Warm charcoal ground")
    mat.diffuse_color = (0.045, 0.046, 0.048, 1)
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.045, 0.046, 0.048, 1)
    mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.93
    ground.data.materials.append(mat)
    return scene, camera, ground


def bake_color(obj, path):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=.015)
    bpy.ops.object.mode_set(mode="OBJECT")
    image=bpy.data.images.new(obj.name+"_BaseColor",width=2048,height=2048)
    restore=[]
    for mat in obj.data.materials:
        nodes,links=mat.node_tree.nodes,mat.node_tree.links
        out=next(n for n in nodes if n.type=='OUTPUT_MATERIAL')
        bs=next(n for n in nodes if n.type=='BSDF_PRINCIPLED')
        original=out.inputs['Surface'].links[0].from_socket
        emission=nodes.new('ShaderNodeEmission')
        links.new(bs.inputs['Base Color'].links[0].from_socket,emission.inputs['Color'])
        links.new(emission.outputs[0],out.inputs['Surface'])
        target=nodes.new('ShaderNodeTexImage'); target.image=image
        nodes.active=target; target.select=True
        restore.append((mat,out,original,emission))
    scene=bpy.context.scene
    old_samples=scene.cycles.samples
    scene.cycles.samples=8
    bpy.ops.object.bake(type='EMIT',margin=8)
    scene.cycles.samples=old_samples
    path.parent.mkdir(exist_ok=True)
    image.filepath_raw=str(path); image.file_format='PNG'; image.save(); image.pack()
    for mat,out,original,emission in restore:
        mat.node_tree.links.new(original,out.inputs['Surface'])
        mat.node_tree.nodes.remove(emission)
    normal=bpy.data.images.new(obj.name+'_Normal',width=2048,height=2048)
    normal.colorspace_settings.name='Non-Color'
    for mat in obj.data.materials:
        target=mat.node_tree.nodes.new('ShaderNodeTexImage'); target.image=normal
        mat.node_tree.nodes.active=target
    scene.cycles.samples=8
    bpy.ops.object.bake(type='NORMAL',normal_space='TANGENT',margin=12)
    scene.cycles.samples=old_samples
    normal.filepath_raw=str(path.parent/(obj.name+'_Normal.png'))
    normal.file_format='PNG'; normal.save(); normal.pack()
    original_mats=list(obj.data.materials)
    baked=bpy.data.materials.new(obj.name+' / portable painted slate')
    baked.use_nodes=True
    baked.diffuse_color=(.13,.15,.18,1)
    bs=baked.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Roughness'].default_value=.86
    target=baked.node_tree.nodes.new('ShaderNodeTexImage'); target.image=image
    baked.node_tree.links.new(target.outputs['Color'],bs.inputs['Base Color'])
    normal_tex=baked.node_tree.nodes.new('ShaderNodeTexImage'); normal_tex.image=normal
    normal_node=baked.node_tree.nodes.new('ShaderNodeNormalMap')
    baked.node_tree.links.new(normal_tex.outputs['Color'],normal_node.inputs['Color'])
    baked.node_tree.links.new(normal_node.outputs['Normal'],bs.inputs['Normal'])
    indices=[p.material_index for p in obj.data.polygons]
    obj.data.materials.clear(); obj.data.materials.append(baked)
    return original_mats,indices


def export_model(obj, path):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    original_mats,indices=bake_color(obj,path.parent.parent/'textures'/(obj.name+'_BaseColor.png'))
    bpy.ops.export_scene.gltf(filepath=str(path.with_suffix(".glb")), export_format="GLB",
                              use_selection=True, export_materials="EXPORT", export_yup=True,
                              export_extras=True)
    bpy.ops.wm.obj_export(filepath=str(path.with_suffix(".obj")), export_selected_objects=True,
                          export_materials=True, forward_axis="NEGATIVE_Y", up_axis="Z")
    mtl=path.with_suffix('.mtl')
    if mtl.exists():
        lines=mtl.read_text().splitlines()
        mtl.write_text('\n'.join(
            ('map_Kd ../textures/'+obj.name+'_BaseColor.png' if line.startswith('map_Kd ') else
             'map_Bump -bm 1.0 ../textures/'+obj.name+'_Normal.png' if line.startswith('map_Bump ') else line)
            for line in lines)+'\n')
    obj.data.materials.clear()
    for mat in original_mats:
        obj.data.materials.append(mat)
    for face,index in zip(obj.data.polygons,indices):
        face.material_index=index
    obj.select_set(False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--no-render", action="store_true")
    parser.add_argument('--preview-only',action='store_true')
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
        scene.render.resolution_x=600; scene.render.resolution_y=600
    objects = []
    for rock in data["rocks"]:
        spec = rock["spec"]
        print(f"Assembling {spec['name']}...", flush=True)
        collection = bpy.data.collections.new(spec["name"])
        scene.collection.children.link(collection)
        sources = bpy.data.collections.new(spec["name"] + " / editable source slabs")
        scene.collection.children.link(sources)
        mats = [stone_material(spec["name"] + f" / stone {i}", spec["color"], (0.88+i*.055 if spec.get('broad_side_chunks') else (0.78+i*.11 if spec.get('chunked_sides') else 0.91+i*.045)), spec) for i in range(5)]
        mats.append(stone_material(spec["name"] + " / worn bevels",
                                   worn_edge_color(spec["color"]), 1, spec))
        start = time.monotonic()
        if spec.get("engine")=="nodes":
            from geometry_nodes import assemble_nodes
            obj=assemble_nodes(rock,collection,sources,mats)
        else:
            obj = assemble_rock(rock, collection, sources, mats)
        sources.hide_render = True
        sources.hide_viewport = True
        health = mesh_health(obj)
        health["assembly_seconds"] = round(time.monotonic() - start, 3)
        if health["nonmanifold_edges"] or health["connected_components"] != 1 or health["volume"] <= 0:
            (out / "debug_invalid.json").write_text(json.dumps({"vertices": [list(v.co) for v in obj.data.vertices], "faces": [list(p.vertices) for p in obj.data.polygons]}))
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
            if args.render_only and spec["name"]!=args.render_only:
                continue
            obj.hide_render = False
            bpy.context.view_layer.update()
            points = [Vector(c) for c in obj.bound_box]
            mins = Vector(tuple(min(p[i] for p in points) for i in range(3)))
            maxs = Vector(tuple(max(p[i] for p in points) for i in range(3)))
            center = (mins + maxs) / 2
            span = max(maxs.x - mins.x, maxs.y - mins.y, maxs.z - mins.z)
            ground.location.z = mins.z - 0.018
            basis = Matrix(spec.get("camera_basis", [[1,0,0],[0,0,-1],[0,1,0]]))
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
            camera.data.ortho_scale = max(vmax.x-vmin.x, vmax.y-vmin.y) * 1.16
            look_at(camera, view_center)
            ground.hide_render = True
            scene.render.filepath = str(out / "renders" / (spec["name"] + "_side.png"))
            bpy.ops.render.render(write_still=True)
            ground.hide_render = False
            obj.hide_render = True

    # Arrange a usable overview in the saved scene; each exported asset stays
    # in its original input coordinates. Source slabs remain in local space.
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
    scene["Generator help"] = "Edit polygons.json and run rockgen.py; see README.md."
    if data['rocks'][0]['spec'].get('fit_mode') in ['centre_plane','playable_perimeter']:
        guides=bpy.data.collections.new('Gameplay centre-plane guides - toggle visibility')
        scene.collection.children.link(guides)
        orange=bpy.data.materials.new('Gameplay outline orange')
        orange.diffuse_color=(1,.25,.025,1)
        for rock,(obj,spec) in zip(data['rocks'],objects):
            guide=object_from_part(rock['gameplay_section'],guides,[orange])
            guide.name=spec['name']+' / gameplay plane'
            guide.data.transform(Matrix(spec['camera_basis']).to_4x4())
            guide.location=obj.location
            guide.display_type='WIRE'; guide.show_in_front=True; guide.hide_render=True
        guides.hide_viewport=True; guides.hide_render=True
        scene['Generator help']='See gameplay_collision.json and the validation reports for the gameplay slice and visible outline. Hidden guide collection marks the gameplay plane.'
    suffix="_nodes" if data["rocks"][0]["spec"].get("engine")=="nodes" else ""
    if suffix:
        from geometry_nodes import make_editable_scenes
        manifest=make_editable_scenes(scene,objects)
        (out / "nodes_manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
    bpy.ops.wm.save_as_mainfile(filepath=str(out / ("polygon_rocks_v5"+suffix+".blend")))
    print("BLENDER_BUILD_COMPLETE", flush=True)


if __name__ == "__main__":
    main()
