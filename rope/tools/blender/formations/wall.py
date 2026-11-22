"""One skin of intersecting outline-generator slabs over a closed 3D guide.

The guide is the buried backing. Independent stones overlap each other and
the backing; the existing boulder Boolean/remesh/edge finish fuses the mass.
No Voronoi partition, camera projection or scene-dependent sizing is used.
"""
import itertools
import math

import bpy
import numpy as np

from blender_build import assemble_rock
from slab_geometry import Mesh, make_block


def placements(solid, size, aspect, seed):
    """Seeded surface sampling in a vertically elongated physical metric."""
    solid.data.calc_loop_triangles()
    triangles = list(solid.data.loop_triangles)
    areas = np.array([t.area for t in triangles])
    if not len(areas) or areas.sum() <= 0:
        raise ValueError('Wall guide has no surface')
    rng = np.random.default_rng(seed)
    count = max(64, math.ceil(areas.sum() / (size * size * aspect) * 90))
    ids = rng.choice(len(triangles), count, p=areas / areas.sum())
    co = np.array([v.co[:] for v in solid.data.vertices])
    corners = co[np.array([triangles[i].vertices[:] for i in ids])]
    uv = rng.random((count, 2))
    uv[uv.sum(axis=1) > 1] = 1 - uv[uv.sum(axis=1) > 1]
    points = corners[:, 0] + uv[:, :1]*(corners[:, 1]-corners[:, 0]) + uv[:, 1:]*(corners[:, 2]-corners[:, 0])
    normals = np.array([triangles[i].normal[:] for i in ids])
    spacing = size * .85
    metric = np.array([1., 1., 1. / aspect]) / spacing
    bins, chosen = {}, []
    neighbours = list(itertools.product((-1, 0, 1), repeat=3))
    for point, normal in zip(points, normals):
        q = point * metric
        cell = np.floor(q).astype(int)
        nearby = (j for offset in neighbours for j in bins.get(tuple(cell+offset), ()))
        if any(np.linalg.norm(q-chosen[j][0]*metric) < 1 and normal@chosen[j][1] > .35 for j in nearby):
            continue
        bins.setdefault(tuple(cell), []).append(len(chosen))
        chosen.append((point, normal))
    return chosen


def geometry(solid, parameters):
    size = float(parameters.get('stoneSize', 1.))
    aspect = float(parameters.get('jointAspect', 2.8))
    relief = float(parameters.get('surfaceRelief', .5))
    seed = int(parameters.get('seed', 0))
    if not math.isfinite(size) or size <= 0 or not math.isfinite(aspect) or not math.isfinite(relief) or relief < 0:
        raise ValueError('Wall dimensions must be finite and stone size positive')
    aspect = max(1.5, aspect)
    rng = np.random.default_rng(seed+104729)
    parts = [dict(name='Wall backing', material=0,
                  vertices=[list(v.co) for v in solid.data.vertices],
                  faces=[list(p.vertices) for p in solid.data.polygons])]
    guide_z = np.array(parts[0]['vertices'])[:, 2]
    zmin, zmax = guide_z.min(), guide_z.max()
    samples = placements(solid, size, aspect, seed)
    for index, (point, normal) in enumerate(samples):
        cap = abs(normal[2]) > .7
        up = np.array([0., 0., 1.])
        if cap:
            # Upright broken ends continue the face's vertical grain. Laying
            # a slab on a horizontal cap creates a projecting horizontal rail.
            frame = np.eye(3)
        else:
            up -= normal * (up @ normal)
            up /= np.linalg.norm(up)
            right = np.cross(up, normal)
            # Local -Y is the broad outward face; Z follows the wall.
            frame = np.array([right, -normal, up])
        width = size*rng.uniform(1.45, 2.05)
        length = width*aspect*rng.uniform(.78, 1.15)
        thickness = size*(.22 + relief*.95)*rng.uniform(.8, 1.3)
        part = make_block(np.zeros(3), width, thickness, length,
                          math.radians(rng.uniform(-14, 14)), rng, index,
                          np.eye(3), Mesh, weathering=.38)
        # Roots sit in the backing; neighbours overlap in this same layer.
        coords = np.asarray(part['vertices']) @ frame
        coords += point + normal * (-length*.45 if cap else -thickness*.12)
        # Fit the whole stone's natural ends, never saw a planar cap through
        # it. Long edge stones otherwise overshoot the wall by half a slab.
        margin = size*.22
        span = np.ptp(coords[:, 2])
        if span > zmax-zmin+2*margin:
            coords[:, 2] = (coords[:, 2]-coords[:, 2].mean())*((zmax-zmin+2*margin)/span) + point[2]
        coords[:, 2] += max(0., zmin-margin-coords[:, 2].min())
        coords[:, 2] -= max(0., coords[:, 2].max()-zmax-margin)
        part['vertices'] = coords.tolist()
        part.pop('clip_to_outline', None)
        parts.append(part)
    spec = dict(name='Wall', seed=seed, depth=size, outer=[], holes=[],
                construction='volume', camera_basis=np.eye(3).tolist(),
                tolerance=.06*size, detail=1., balanced_hybrid=True,
                game_low_poly=True, voxelCap=.012*size, faceBudget=3000/(size*size),
                edgeBevelWidth=.0002*size)
    return dict(spec=spec, parts=parts), {'slabs': len(samples), 'aspect': aspect}


def build(solid, camera, parameters, collection):
    rock, report = geometry(solid, parameters)
    # The standard assembler needs a material slot for its narrow edge strips.
    material = bpy.data.materials.new('Wall assembly temporary')
    obj = assemble_rock(rock, collection, collection, [material]*6)
    for key in list(obj.keys()):
        del obj[key]  # Outline-only metadata does not describe this solid guide.
    obj.data.materials.clear()
    bpy.data.materials.remove(material)
    obj.data.polygons.foreach_set('use_smooth', [False]*len(obj.data.polygons))
    collection.objects.unlink(obj)
    return obj, [], 1., report
