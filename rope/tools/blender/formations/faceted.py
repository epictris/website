"""The Faceted variant of a solid formation: simple geometry for the backdrop.

Tris's references (2026-11-23, the river's background rocks): one rounded
mass cut into a few dozen broad planes, matte slate, no chips, no chisel, no
stones - a far rock reads by its silhouette and the tone step between its
facets, and anything finer is lost in the fog and the depth of field.

From the guide, in its local frame:

1. round - a morphological opening of the guide's distance field, every
   convex edge rounded to Edge radius (`edgeRadius`, metres; 0 keeps the
   guide's corners), meshed at an eighth of the facet size;
2. bulge - a noise along the normals, Bulge x RELIEF facets deep and Bulge
   size (`bulgeSize`, metres) across, so the planes do not follow the guide
   exactly: a small size dents a face, a large one leans it whole;
3. facets - Greg Zaal's two decimates as recipe F uses them: collapse to
   about TRIS_PER_FACET triangles per facet of area, then planar dissolve at
   Merge angle (`mergeAngle`, degrees) so neighbours nearly in one plane
   merge into one polygon; flat shading.

Facet size (the Stone size field) sets the facets' density and the bulge's
depth; the edge radius and bulge size are lengths of their own (until
2026-11-23 they were 1.5 and 2 facets, so a larger facet rounded the rock
more; Tris wanted broad planes with crisp edges, his cave reference). The
surface is the shared painted slate. The export keeps the facets' edges
straight and adds no chips (`surfaceFinish`, assemble.py).
"""

import math
import random

# At Stone size 1, metres.
FACET = 0.7               # a facet's typical width (0.55 with 2.2 triangles a
                          # facet drew twice the references' facets, reading wavy)
RELIEF = 0.4              # the bulge at Surface relief 1, in facets: enough that a
                          # flat face of the guide breaks into planes too (at 0.35 x
                          # 3 facets a box's faces stayed one plane each, its facets
                          # all on the rounded edges)
TRIS_PER_FACET = 1.6      # triangles the collapse keeps per facet of area
MAX_VOXELS = 250          # the remesh voxel is at least the guide's extent over this
RADIUS_VOXELS = 12        # ...and at least the edge radius over this: the old
                          # 1.5 facets over a voxel of facet / 8
KEEP = 0.5                # a rounding that leaves less of the guide's volume is redone smaller


def build(solid, camera, parameters, collection):
    """The rock (unlinked from `collection`). Same signature and return as
    solidfit.build: (rock, parts, depth scale, report)."""
    import bmesh
    import bpy
    from mathutils import Vector, noise
    from . import fitted
    size = float(parameters["stoneSize"])
    facet = FACET * size
    rng = random.Random(int(parameters["seed"]))
    co = [v.co for v in solid.data.vertices]
    extent = max(max(c[i] for c in co) - min(c[i] for c in co) for i in range(3))
    voxel = max(facet / 8, extent / MAX_VOXELS)
    ob = bpy.data.objects.new("Faceted", solid.data.copy())
    collection.objects.link(ob)
    # Never past the guide's half-thickness: an opening by more than that takes
    # the whole guide away (2026-11-23, a 3.5 m deep cliff at Facet size 2).
    # The grid's depth is a city-block distance, which can overstate the true
    # one, so a rounding that leaves too little is tried again smaller.
    from .stones import inside_grid
    grid = inside_grid(solid, facet / 0.07 / 4)
    radius = min(float(parameters["edgeRadius"]), 0.9 * grid.gaps(grid.inside).max() * grid.cell)
    # The opening's cost goes with the radius in voxels (its band), so the
    # voxel grows with a radius past RADIUS_VOXELS of them: what is finer
    # than the radius is rounded away anyway. Unbounded, Edge radius 0.525 m
    # at Facet size 0.25 took 16 s against 2 s (2026-11-23).
    voxel = max(voxel, radius / RADIUS_VOXELS)
    guide = ob.data.copy()
    whole = abs(_volume(guide))
    floor = min(c[2] for c in co)
    while True:
        _round(ob, voxel, radius)
        if ob.data.polygons and abs(_volume(ob.data)) >= KEEP * whole:
            break
        radius *= 0.7
        if radius < 2 * voxel:
            raise ValueError("the guide is too thin to round at this Edge radius")
        old = ob.data
        ob.data = guide.copy()
        bpy.data.meshes.remove(old)
    bpy.data.meshes.remove(guide)

    relief = RELIEF * facet * float(parameters["surfaceRelief"])
    if relief > 0:
        off = Vector((rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100)))
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bm.normal_update()
        period = float(parameters["bulgeSize"])
        moves = [v.normal * relief * noise.noise(v.co / period + off) for v in bm.verts]
        for v, d in zip(bm.verts, moves):
            v.co += d
        bm.to_mesh(ob.data)
        bm.free()

    area = sum(p.area for p in ob.data.polygons)
    fitted._facets(ob, TRIS_PER_FACET * area / facet ** 2, angle=float(parameters["mergeAngle"]))
    # Cut after the facets, not before: the facets run on down past the floor
    # and the plane slices them clean. Cut first, the collapse worked against
    # the cap's ring and left a zig-zag band of fan triangles round the base.
    flat_base(ob, floor)
    from blender_build import keep_main_body
    keep_main_body(ob)
    collection.objects.unlink(ob)
    ob.name = "SceneryRock"
    return ob, [], 1.0, {"faces": len(ob.data.polygons), "voxel": round(voxel, 4),
                         "round": round(radius, 3), "facet": round(facet, 3)}


def _volume(mesh):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(mesh)
    v = bm.calc_volume(signed=True)
    bm.free()
    return v


def _round(ob, voxel, radius):
    """Round every convex corner and edge of `ob` to `radius`: a
    morphological opening of its signed distance field (OpenVDB, through
    geometry nodes): shrunk by the radius, grown back by it, meshed at the
    zero level. Thin parts narrower than twice the radius go, as they would
    weathered. A volume-preserving Laplacian smooth was tried first
    (2026-11-23): on a voxel mesh's flat faces it moved nothing, and a box
    guide came out a box with chamfered edges."""
    import bpy
    from . import fitted
    tree = bpy.data.node_groups.new("Faceted round", "GeometryNodeTree")
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    n = tree.nodes
    given, out = n.new("NodeGroupInput"), n.new("NodeGroupOutput")
    sdf, below = n.new("GeometryNodeMeshToSDFGrid"), n.new("GeometryNodeMeshToSDFGrid")
    for grid in (sdf, below):
        grid.inputs["Voxel Size"].default_value = voxel
        # The band must hold the distances the offsets reach, and 6 voxels
        # more: at radius 0 a band of 3 or 4 meshed to nothing and 5 was
        # marginal (2026-11-23, 0.5 % off the volume 6 and 7 agree on).
        grid.inputs["Band Width"].default_value = math.ceil(radius / voxel) + 6
    # The guide again, a radius and a bit lower, in union with it: the base
    # carries on down, so the opening rounds no bottom edge and the cut at
    # the guide's floor (`flat_base`) leaves it flat.
    lower = n.new("GeometryNodeTransform")
    lower.inputs["Translation"].default_value = (0, 0, -(radius + 2 * voxel))
    union = n.new("GeometryNodeSDFGridBoolean")
    union.operation = "UNION"
    shrink, grow = n.new("GeometryNodeSDFGridOffset"), n.new("GeometryNodeSDFGridOffset")
    # A positive distance grows the surface (measured 2026-11-23: these the
    # other way round filleted a cliff guide's inner corner and left its
    # outer ones sharp).
    shrink.inputs["Distance"].default_value = -radius
    grow.inputs["Distance"].default_value = radius
    mesh = n.new("GeometryNodeGridToMesh")
    link = tree.links.new
    link(given.outputs[0], sdf.inputs["Mesh"])
    link(given.outputs[0], lower.inputs["Geometry"])
    link(lower.outputs[0], below.inputs["Mesh"])
    # A union takes every grid on its one multi-input (its "Grid 1" is off).
    link(sdf.outputs[0], union.inputs["Grid 2"])
    link(below.outputs[0], union.inputs["Grid 2"])
    link(union.outputs[0], shrink.inputs["Grid"])
    link(shrink.outputs[0], grow.inputs["Grid"])
    link(grow.outputs[0], mesh.inputs["Grid"])
    link(mesh.outputs[0], out.inputs[0])
    mod = ob.modifiers.new("round", "NODES")
    mod.node_group = tree
    fitted._apply_modifiers(ob)
    bpy.data.node_groups.remove(tree)


def flat_base(ob, floor):
    """Cut `ob` at height `floor`, dropping what is below, and cap the cut:
    the rock stands on the guide's floor, as a background rock stands in the
    water or the ground (the references), and as recipe F keeps its bases."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    cut = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, floor), plane_no=(0, 0, 1), clear_inner=True)
    edges = [e for e in cut["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
    if edges:
        bmesh.ops.holes_fill(bm, edges=edges, sides=0)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data)
    bm.free()
