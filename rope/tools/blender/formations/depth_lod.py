"""Offline surface budgets for static formations; no runtime LOD or new caps.

Plan from world depth before detail generation. Keep one connected surface for
creases, occlusion and deformation; split it only into independently budgeted
texture regions. The scene export's final material split makes their draw meshes.
"""
from dataclasses import asdict
import json
import math

from .depth_budget import Budget

FACE_BAND = 'formation_lod_band'
SETTING = 'export_depth_lod'
VERSION = 1


def policy(ob):
    from . import render
    if (not ob.get(SETTING, True) or 'formation_recipe' not in ob
            or render.DETAIL_SCALE in ob or int(ob.get('export_maps', 0)) > 0):
        return None
    try:
        camera = json.loads(render.scene_of(ob)[render.CAMERA])
    except (KeyError, TypeError, ValueError):
        return None  # No known fixed lens: preserve the existing path.
    return Budget(float(camera['distance']), float(camera['tanHalf']),
                  render.DOF_MAX_BLUR, render.DOF_FOCUS_BAND,
                  base_texels=float(ob.get('export_texels', 0)) or render.TEXELS_PER_METRE)


class Field:
    """Conservative local-space feature threshold from its nearest world depth.

    `radius` covers a chip/bow's whole support, not just its centre. Divide by
    the largest singular value so nonuniform scaling cannot discard a feature
    that is still large along one direction. Panning X/Z is irrelevant.
    """
    def __init__(self, budget, matrix):
        import numpy as np
        self.budget = budget
        self.matrix = np.array(matrix, dtype=float)
        self.row = self.matrix[1, :3]
        self.offset = float(self.matrix[1, 3])
        self.scale = float(np.linalg.svd(self.matrix[:3, :3], compute_uv=False).max())
        self.depth_scale = float(np.linalg.norm(self.row))
        if self.scale <= 0:
            raise ValueError('A formation cannot have a singular transform')

    def depth(self, points, radius=0):
        return min(sum(float(p[i])*self.row[i] for i in range(3)) for p in points) + self.offset - radius*self.depth_scale

    def __call__(self, points, radius=0):
        return self.budget.blur(self.depth(points, radius))/self.scale

    def level(self, points):
        # Foreground budget levels can be negative; never treat being nearer
        # than the focus as permission to coarsen the surface.
        y = self.depth(points)
        return self.budget.level(max(y, -self.budget.distance + 1e-6))


def field(ob):
    budget = policy(ob)
    return Field(budget, ob.matrix_world) if budget else None


def threshold(value, points, radius=0):
    return value(points, radius) if callable(value) else value


def signature(ob):
    budget = policy(ob)
    return None if budget is None else (VERSION, asdict(budget))


def partition(mesh, ob):
    """Cut at the planned depth transitions, preserving all corner attributes.

    This runs after the crease rebuild (whose shared field keeps every seam
    together), before the detail high poly and texture charts. BMesh cuts the
    connected surface once per plane; it creates no internal faces or bevels.
    """
    import bmesh
    import numpy as np
    from mathutils import Vector
    local = field(ob)
    if local is None or not mesh.vertices:
        return 0
    co = np.empty((len(mesh.vertices), 3), np.float32)
    mesh.vertices.foreach_get('co', co.ravel())
    depths = co @ local.row + local.offset
    bands = local.budget.bands(float(depths.min()), float(depths.max()))
    if len(bands) == 1:
        tag = mesh.attributes.get(FACE_BAND) or mesh.attributes.new(FACE_BAND, 'INT', 'FACE')
        tag.data.foreach_set('value', np.full(len(mesh.polygons), bands[0].level, np.int32))
        return 0
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        normals = bm.loops.layers.float_vector.new('depth_lod.normal')
        for face, polygon in zip(bm.faces, mesh.polygons):
            for loop, index in zip(face.loops, polygon.loop_indices):
                loop[normals] = mesh.corner_normals[index].vector
        # Use Blender's existing tessellation for nonplanar n-gons; a different
        # triangulation could change the surface before any detail is generated.
        mesh.calc_loop_triangles()
        tess = {}
        for tri in mesh.loop_triangles:
            tess.setdefault(tri.polygon_index, []).append(tuple(tri.vertices))
        layers = [layer for kind in ('bool','color','float','float_color','float_vector','int','string')
                  for layer in getattr(bm.faces.layers,kind).values()]
        bm.verts.ensure_lookup_table()
        cuts = [b.far for b in bands[:-1]]
        for face in list(bm.faces):
            ys = [float(depths[v.index]) for v in face.verts]
            if len(face.verts) <= 3 or not any(min(ys)<y<max(ys) for y in cuts):
                continue
            loops = {l.vert.index:l for l in face.loops}
            for indices in tess[face.index]:
                fresh = bm.faces.new([bm.verts[i] for i in indices])
                fresh.material_index, fresh.smooth = face.material_index, face.smooth
                for layer in layers:
                    fresh[layer] = face[layer]
                for loop in fresh.loops:
                    loop.copy_from(loops[loop.vert.index])
            bm.faces.remove(face)
        before = len(bm.faces)
        normal = Vector(local.row)
        for y in cuts:
            point = normal*((y-local.offset)/normal.length_squared)
            bmesh.ops.bisect_plane(bm, geom=[*bm.verts,*bm.edges,*bm.faces],
                                  dist=1e-7, plane_co=point, plane_no=normal.normalized())
        tag = bm.faces.layers.int.get(FACE_BAND) or bm.faces.layers.int.new(FACE_BAND)
        for face in bm.faces:
            # Centroid selects the side of an exactly shared cut boundary.
            # The region budget itself is evaluated at its near boundary.
            face[tag] = local.level([face.calc_center_median()])
        saved = [tuple(l[normals].normalized()) for f in bm.faces for l in f.loops]
        bm.loops.layers.float_vector.remove(normals)
        added = len(bm.faces)-before
        bm.to_mesh(mesh)
        mesh.normals_split_custom_set(saved)
        return added
    finally:
        bm.free()


def map_plan(mesh, ob, seen):
    """Allocate each depth region's texels before any UV packing or baking."""
    import numpy as np
    from . import render
    budget = policy(ob)
    tag = mesh.attributes.get(FACE_BAND)
    if budget is None or tag is None:
        return None
    band = np.empty(len(mesh.polygons), np.int32)
    tag.data.foreach_get('value', band)
    # Actual world triangle areas also handle nonuniform object transforms.
    co = np.empty((len(mesh.vertices),3),np.float64)
    mesh.vertices.foreach_get('co',co.ravel())
    matrix = np.array(ob.matrix_world)
    co = co @ matrix[:3,:3].T
    mesh.calc_loop_triangles()
    tris = np.empty((len(mesh.loop_triangles),3),np.int32)
    parents = np.empty(len(tris),np.int32)
    mesh.loop_triangles.foreach_get('vertices',tris.ravel())
    mesh.loop_triangles.foreach_get('polygon_index',parents)
    v = co[tris]
    area = np.bincount(parents, np.linalg.norm(np.cross(v[:,1]-v[:,0],v[:,2]-v[:,0]),axis=1)/2,
                       minlength=len(mesh.polygons))
    area *= np.where(seen,1.0,render.HIDDEN_DENSITY**2)
    sides, map_bands = [], []
    for level in sorted(set(band.tolist())):
        # Material feature sizes remain physical; only the sampling density
        # changes. Atlas caps do not force one low-resolution map per rock.
        maps = render.map_sides(float(area[band==level].sum()), scale=1.0,
                                map_max=int(ob.get('export_map_max',0)),
                                texels=budget.base_texels/2.0**level, maps=0)
        sides.extend(maps); map_bands.extend([level]*len(maps))
    return sides, map_bands


def assign_maps(uv, islands, face_bands, map_bands, sides, face_positions, face_areas):
    """Keep a chart within its depth budget, then distribute it spatially."""
    import numpy as np
    result = np.zeros(len(face_bands),np.int32)
    for level in sorted(set(face_bands.tolist())):
        faces = np.flatnonzero(face_bands==level)
        slots = np.flatnonzero(np.array(map_bands)==level)
        if not len(slots):
            raise ValueError(f'No texture map for depth band {level}')
        own, inverse = np.unique(islands[faces],return_inverse=True)
        weight = np.bincount(inverse,face_areas[faces])
        centre = np.bincount(inverse,face_positions[faces]*face_areas[faces])/np.maximum(weight,1e-30)
        capacity = np.cumsum(np.array(sides,dtype=float)[slots]**2)
        capacity *= weight.sum()/capacity[-1]
        assigned = np.empty(len(own),np.int32)
        held, k = 0., 0
        for i in np.argsort(centre,kind='stable'):
            while k<len(slots)-1 and held+weight[i]/2>capacity[k]:
                k+=1
            assigned[i]=slots[k];held+=weight[i]
        result[faces]=assigned[inverse]
    return result
