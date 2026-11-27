"""The outline generator's independent slabs fitted to a closed 3D guide.

The guide backs the seams. Slabs overlap in a surface frame, including on
floors and ceilings; no Voronoi cells determine their visible outlines.
The shared make_block primitive supplies its eight-sided, five-ring shape,
unequal ends, lean and edge drift. Its broad ends face out of the guide;
orientation and depth are fitted to shallow relief.
"""
import itertools
import math
from time import perf_counter

import bpy
import bmesh
import numpy as np
from mathutils import Quaternion, Vector

from blender_build import assemble_rock
from slab_geometry import Mesh, make_block
from . import solidfit as sf


def frame(normal):
    """Surface basis rows: across, inward and along, in asset coordinates."""
    along = sf.along(normal)
    return np.array([np.cross(along, normal), -normal, along])


def placements(solid, size, seed, density=1.):
    """Area samples spaced in each surface's tangent frame, in asset metres."""
    solid.data.calc_loop_triangles()
    triangles = list(solid.data.loop_triangles)
    areas = np.array([t.area for t in triangles])
    if not len(areas) or areas.sum() <= 0:
        raise ValueError('Boulder guide has no surface')
    rng = np.random.default_rng(seed)
    count = max(64, math.ceil(round(float(areas.sum())/(size*size), 8)*70*density))
    spacing = size / math.sqrt(density)
    ids = rng.choice(len(triangles), count, p=areas/areas.sum())
    co = np.array([v.co[:] for v in solid.data.vertices])
    corners = co[np.array([triangles[i].vertices[:] for i in ids])]
    uv = rng.random((count, 2))
    uv[uv.sum(axis=1) > 1] = 1-uv[uv.sum(axis=1) > 1]
    points = corners[:, 0]+uv[:, :1]*(corners[:, 1]-corners[:, 0])+uv[:, 1:]*(corners[:, 2]-corners[:, 0])
    normals = np.array([triangles[i].normal[:] for i in ids])
    bins, chosen = {}, []
    neighbours = list(itertools.product((-1, 0, 1), repeat=3))
    for identity, (point, normal) in enumerate(zip(points, normals)):
        basis = frame(normal)
        cell = np.floor(point/(1.15*spacing)).astype(int)
        nearby = (j for offset in neighbours for j in bins.get(tuple(cell+offset), ()))
        if any(normal@chosen[j][2] > .35 and
               np.linalg.norm(((point-chosen[j][1])@basis.T)/(np.array([.75, .75, 1.15])*spacing)) < 1
               for j in nearby):
            continue
        bins.setdefault(tuple(cell), []).append(len(chosen))
        chosen.append((identity, point, normal))
    return chosen


def geometry(solid, parameters):
    size = float(parameters['stoneSize'])
    relief = float(parameters['surfaceRelief'])
    seed = int(parameters['seed'])
    width_scale = float(parameters.get('slabWidth', 1.5)) / 1.5
    length_scale = float(parameters.get('slabLength', 2.1)) / 2.1
    weathering = float(parameters.get('weathering', .38))
    density = float(parameters.get('fractureDensity', 1.))
    if not math.isfinite(size) or size <= 0 or not math.isfinite(relief) or relief < 0:
        raise ValueError('Boulder size must be positive and relief finite and nonnegative')
    if not all(math.isfinite(v) and v > 0 for v in (width_scale, length_scale, density)):
        raise ValueError('Slab width, length and fracture density must be finite and positive')
    if not math.isfinite(weathering) or not 0 <= weathering <= 1:
        raise ValueError('Weathering must be between 0 and 1')
    parts = [dict(name='Boulder backing', material=0,
                  vertices=[list(v.co) for v in solid.data.vertices],
                  faces=[list(p.vertices) for p in solid.data.polygons])]
    samples = placements(solid, size, seed, density)
    surface = sf._tree(solid)
    for identity, point, normal in samples:
        # Candidate identity owns its randomness before surface pruning.
        rng = np.random.default_rng(np.random.SeedSequence([seed, identity, 104729]))
        width = size*rng.uniform(1.13, 1.87)*width_scale
        length = size*rng.uniform(1.4, 2.8)*length_scale
        part = make_block(np.zeros(3), width, length, .5*size,
                          math.radians(rng.uniform(-28, 28)), rng, identity,
                          np.eye(3), Mesh, weathering=weathering,
                          min_end_separation=.25*size)
        coords = np.asarray(part['vertices'])
        # Present the primitive's broad broken end to the surface. Its raw
        # end tilt can be almost 30 degrees: burying that at shallow relief
        # exposes just a triangular tip. Reduce that tilt before
        # fitting depth, retaining the irregular cap and five-ring shoulders.
        cap = coords[sorted({v for face in part['faces'][-8:] for v in face})]
        a, b, _ = np.linalg.lstsq(np.column_stack((cap[:, :2], np.ones(len(cap)))), cap[:, 2], rcond=None)[0]
        turn = Vector((-a, -b, 1.)).rotation_difference(Vector((0., 0., 1.)))
        coords = coords @ np.array(Quaternion().slerp(turn, .35).to_matrix()).T
        # Fit the depth of the actual slab, including its lean. Merely
        # thinning its cross-section leaves the lean projecting like a fin.
        outward = coords[:, 2]
        depth = (outward-outward.min())/np.ptp(outward)
        peak = size*relief*2*rng.uniform(.03, .23)
        # Keep the buried end inside thin guides, so ceiling slabs cannot
        # emerge through the floor (or vice versa).
        inset = .35*size
        epsilon = .0001*size
        hit, hit_normal, _, distance = surface.ray_cast(
            Vector(point-normal*epsilon), Vector(-normal))
        if hit is not None and np.dot(hit_normal, normal) < -.35:
            inset = min(inset, .8*(distance+epsilon))
        # Scale the entire depth profile on thin guides: shortening only
        # its buried end exposes too much of each cap and inflates the floor.
        peak *= inset/(.35*size)
        coords[:, 2] = -inset+depth*(inset+peak)
        basis = frame(normal)
        part['vertices'] = (coords@np.array([basis[0], basis[2], normal])+point).tolist()
        part['surface_point'] = point.tolist()
        part['surface_normal'] = normal.tolist()
        part['chunk_bevel'] = .025*size
        parts.append(part)
    spec = dict(name='Boulder', seed=seed, depth=size, outer=[], holes=[],
                construction='volume', camera_basis=np.eye(3).tolist(),
                tolerance=.04*size, detail=1., balanced_hybrid=True,
                game_low_poly=True, voxelCap=.012*size, faceBudget=3000/(size*size),
                soften_thin_edges=True, chunked_sides=True, edgeBevelWidth=0.,
                clip_union=True, defer_volume_cleanup=True, meshoptError=.012*size)
    return dict(spec=spec, parts=parts), {'slabs': len(samples)}


def fit_edges(part, surface, size):
    """Trim transverse overhangs without flattening the slab's outward face.

    A single inflated envelope lets a wall slab stick up above the floor,
    building a rail around every corner. Probe inside its source surface
    to find the neighbouring guide planes and end the slab at those edges.
    """
    normal = np.array(part['surface_normal'])
    planes = []
    for v in part['vertices']:
        probe = np.asarray(v)-normal*.3*size
        hit, n, _, _ = surface.find_nearest(Vector(probe))
        if hit is None or abs(np.dot(n, normal)) > .5 or np.dot(probe-np.asarray(hit), n) <= .001*size:
            continue
        distance = float(n.dot(hit))+.02*size
        if not any(np.dot(n, other) > .999 and abs(distance-d) < .001*size for other, d in planes):
            planes.append((n.copy(), distance))
    if not planes:
        return
    me = bpy.data.meshes.new('Slab edge fit')
    me.from_pydata(part['vertices'], [], part['faces'])
    bm = bmesh.new()
    bm.from_mesh(me)
    for normal, distance in planes:
        sf.fitted._cut(bm, normal*distance, normal)
    bm.verts.index_update()
    part['vertices'] = [list(v.co) for v in bm.verts]
    part['faces'] = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    bpy.data.meshes.remove(me)


def build(solid, camera, parameters, collection):
    started = perf_counter()
    rock, report = geometry(solid, parameters)
    size, relief = parameters['stoneSize'], parameters['surfaceRelief']
    surface = sf._tree(solid)
    for part in rock['parts'][1:]:
        fit_edges(part, surface, size)
    rock['parts'] = [part for part in rock['parts'] if len(part['faces']) >= 4]
    print(f"Boulder: placed {report['slabs']} slabs in {perf_counter()-started:.2f}s; building backing", flush=True)
    stage = perf_counter()
    # Recess the backing just enough to expose the slabs' shoulders. A thin
    # guide that cannot survive the inset retains its original backing.
    bm = bmesh.new()
    bm.from_mesh(solid.data)
    # The established core finish coarsens and cleans the inset. Passing a
    # raw dense VDB surface through the assembler's weld can pinch nearly
    # coincident vertices and make the Boolean union reject the backing.
    # This buried support has no slab detail. Fine 12–15 mm grids rebuilt
    # it thirteen times on a 1 m stone, producing millions of temporary faces.
    # Sample it at 42 mm and bound offset steps by that voxel size instead.
    backing = sf.build_core(bm, .6*size, collection, report, voxel_floor=.042*size)
    bm.free()
    if len(backing.data.polygons) and sf._volume(backing) > .5*sf._volume(solid):
        rock['parts'][0]['vertices'] = [list(v.co) for v in backing.data.vertices]
        rock['parts'][0]['faces'] = [list(p.vertices) for p in backing.data.polygons]
    backing_mesh = backing.data
    bpy.data.objects.remove(backing, do_unlink=True)
    bpy.data.meshes.remove(backing_mesh)
    print(f"Boulder: backing {perf_counter()-stage:.2f}s; building envelope", flush=True)
    stage = perf_counter()
    # A volume guard follows concavities too: slabs cannot bridge a doorway
    # or overshoot an outside corner by half their length.
    guard = sf.grown(solid, (.04+.46*relief)*size, .06*size, collection, 'Boulder guard')
    sf._modifier(guard, 'DECIMATE', decimate_type='DISSOLVE',
                 angle_limit=math.radians(2), use_dissolve_boundaries=False)
    rock['clip'] = dict(name='Boulder envelope', material=0,
                        vertices=[list(v.co) for v in guard.data.vertices],
                        faces=[list(p.vertices) for p in guard.data.polygons])
    guard_mesh = guard.data
    bpy.data.objects.remove(guard, do_unlink=True)
    bpy.data.meshes.remove(guard_mesh)
    print(f"Boulder: envelope {perf_counter()-stage:.2f}s; assembling with one combined clip", flush=True)
    stage = perf_counter()
    material = bpy.data.materials.new('Boulder assembly temporary')
    obj = assemble_rock(rock, collection, collection, [material]*6)
    for key in list(obj.keys()):
        del obj[key]
    obj.data.materials.clear()
    bpy.data.materials.remove(material)
    obj.data.polygons.foreach_set('use_smooth', [False]*len(obj.data.polygons))
    collection.objects.unlink(obj)
    print(f"Boulder: assembly {perf_counter()-stage:.2f}s; total {perf_counter()-started:.2f}s", flush=True)
    return obj, [], 1., report
