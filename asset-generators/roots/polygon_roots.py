"""Polygon-authored climbing roots. Metres, right-handed, Z up.

The input surface is authoritative: marked faces are never displaced.
This module needs only NumPy; Blender authoring/export lives in
blender_polygon_roots.py. See POLYGON_ROOTS.md for the input contract.
"""
import hashlib
import json
import math
import random
from pathlib import Path

import numpy as np

from procedural_roots import Branch, grow_branch, tube, variant


def stable_seed(text):
    return int.from_bytes(hashlib.sha256(str(text).encode('utf8')).digest()[:8], 'little')


def normalize(v):
    v = np.asarray(v, dtype=float)
    return v / max(float(np.linalg.norm(v)), 1e-12)


def face_normal(points):
    return normalize(np.cross(points, np.roll(points, -1, axis=0)).sum(axis=0))


def validate_blockout(data):
    """Reject ambiguous input instead of silently changing the climbing route."""
    if data.get('version') != 1 or data.get('units') != 'meters' or data.get('up_axis') != 'Z':
        raise ValueError('Expected version=1, units="meters", up_axis="Z".')
    roots = data.get('roots', [])
    if not roots:
        raise ValueError('The blockout has no roots.')
    seen = set()
    for root in roots:
        name = root.get('id')
        if not isinstance(name, str) or not name or name in seen:
            raise ValueError('Each root must have a unique nonempty string id.')
        seen.add(name)
        v = np.asarray(root.get('vertices', []), dtype=float)
        if v.ndim != 2 or v.shape[1] != 3 or len(v) < 4 or not np.isfinite(v).all():
            raise ValueError(f'{name}: expected finite 3D vertices.')
        faces = root.get('faces', [])
        grabs = root.get('grab_faces', [])
        if 'grab_faces' not in root or not faces or any(type(i) is not int or not 0 <= i < len(faces) for i in grabs):
            raise ValueError(f'{name}: supply grab_faces with valid face indices (or an empty list).')
        edges = {}
        volume = 0.0
        for fi, face in enumerate(faces):
            if (len(face) < 3 or len(set(face)) != len(face) or
                    any(type(i) is not int or not 0 <= i < len(v) for i in face)):
                raise ValueError(f'{name}: invalid polygon {fi}.')
            p = v[face]
            n = face_normal(p)
            if np.linalg.norm(n) < .99 or np.max(np.abs((p-p[0]) @ n)) > 1e-6:
                raise ValueError(f'{name}: face {fi} must be planar and nonzero.')
            # Every vertex must lie in every edge's inner half-plane.
            # This also rejects collinear and self-crossing polygons.
            for a, b in zip(p, np.roll(p, -1, axis=0)):
                if np.linalg.norm(b-a) < 1e-7:
                    raise ValueError(f'{name}: zero-length edge on face {fi}.')
                side = np.cross(b-a, p-a) @ n
                if side.min() < -1e-7:
                    raise ValueError(f'{name}: face {fi} must be convex with ordered vertices.')
            for a, b in zip(face, face[1:]+face[:1]):
                edges.setdefault(tuple(sorted((a, b))), []).append((a, b))
            for j in range(1, len(p)-1):
                area = np.linalg.norm(np.cross(p[j]-p[0], p[j+1]-p[0]))
                if area < 1e-10:
                    raise ValueError(f'{name}: degenerate triangulation on face {fi}.')
                volume += np.dot(p[0], np.cross(p[j], p[j+1])) / 6
        if any(len(e) != 2 or e[0] != e[1][::-1] for e in edges.values()):
            raise ValueError(f'{name}: use a closed mesh with consistently outward faces.')
        if volume <= 1e-9:
            raise ValueError(f'{name}: face winding is inward or volume is zero.')
    return data


def source_triangles(data, only_grab=False):
    triangles, ids = [], []
    for root in data['roots']:
        verts = np.asarray(root['vertices'], dtype=float)
        for fi, face in enumerate(root['faces']):
            if only_grab and fi not in root['grab_faces']:
                continue
            for j in range(1, len(face)-1):
                triangles.append(verts[[face[0], face[j], face[j+1]]])
                ids.append((root['id'], fi))
    return np.asarray(triangles, dtype=float).reshape(-1, 3, 3), ids


def closest_points(point, triangles):
    """Closest point on each triangle, including its boundary (vectorized)."""
    t = np.asarray(triangles, dtype=float).reshape(-1, 3, 3)
    if not len(t):
        return np.empty((0, 3))
    a, b, c = t[:, 0], t[:, 1], t[:, 2]
    ab, ac = b-a, c-a
    normal = np.cross(ab, ac)
    normal /= np.maximum(np.linalg.norm(normal, axis=1)[:, None], 1e-15)
    p = np.asarray(point, dtype=float)
    projected = p - np.sum((p-a)*normal, axis=1)[:, None]*normal
    candidates = [projected]
    inside = np.ones(len(t), dtype=bool)
    for start, end in ((a, b), (b, c), (c, a)):
        edge = end-start
        inside &= np.sum(np.cross(edge, projected-start)*normal, axis=1) >= -1e-10
        alpha = np.sum((p-start)*edge, axis=1)/np.maximum(np.sum(edge*edge, axis=1), 1e-15)
        candidates.append(start+np.clip(alpha, 0, 1)[:, None]*edge)
    candidates = np.stack(candidates, axis=1)
    distance = np.sum((candidates-p)**2, axis=2)
    distance[~inside, 0] = np.inf
    return candidates[np.arange(len(t)), distance.argmin(axis=1)]


def clearance_ok(vertices, faces, grab_triangles, clearance):
    """Conservative triangle-sphere bound: no missed crossings between vertices.

    A complete triangle fits in the sphere centered at its centroid with radius
    equal to its farthest vertex. If that sphere clears the marked surfaces,
    the triangle does too. This can reject some otherwise-safe decorations.
    """
    if not len(grab_triangles):
        return True
    triangles = vertices[faces]
    centers = triangles.mean(axis=1)
    radii = np.linalg.norm(triangles-centers[:, None], axis=2).max(axis=1)
    for center, radius in zip(centers, radii):
        closest = closest_points(center, grab_triangles)
        if np.linalg.norm(closest-center, axis=1).min()-radius < clearance:
            return False
    return True


def _subdivide_triangle(p, resolution):
    """Barycentric coordinates for uniformly subdivided triangles."""
    coords, index = [], {}
    for i in range(resolution+1):
        for j in range(resolution+1-i):
            index[i, j] = len(coords)
            coords.append([1-(i+j)/resolution, i/resolution, j/resolution])
    faces = []
    for i in range(resolution):
        for j in range(resolution-i):
            faces.append((index[i,j], index[i+1,j], index[i,j+1]))
            if i+j < resolution-1:
                faces.append((index[i+1,j], index[i+1,j+1], index[i,j+1]))
    bary = np.asarray(coords)
    return bary @ p, np.asarray(faces, dtype=int), bary


def continuous_bark_uv(root):
    """Use shared cage vertices so grain cannot reset at polygon boundaries.

    Horizontal station rings follow the authored bends. Other cages use a
    principal-axis cylindrical projection. The wrap seam is unwrapped per face.
    """
    points=np.asarray(root['vertices'],float)
    levels=np.unique(points[:,2])
    if len(levels)>1 and all(np.sum(points[:,2]==z)>=3 for z in levels):
        centers=np.array([points[points[:,2]==z].mean(axis=0) for z in levels])
        station=np.searchsorted(levels,points[:,2])
        lengths=np.r_[0,np.cumsum(np.linalg.norm(np.diff(centers,axis=0),axis=1))]
        delta=points-centers[station]
        around=np.arctan2(delta[:,1],delta[:,0])/(2*np.pi)
        along=lengths[station]
    else:
        center=points.mean(axis=0)
        _,_,axes=np.linalg.svd(points-center,full_matrices=False)
        axis=axes[0]
        if axis[2]<0: axis=-axis
        across=axes[1]; depth=np.cross(axis,across)
        delta=points-center
        around=np.arctan2(delta@depth,delta@across)/(2*np.pi)
        along=delta@axis
    return np.column_stack((around%1,along*.7))


def build_structure(data, seed=1234, subdivisions=4, bark_depth=.006):
    result = []
    for root in data['roots']:
        vertices, faces, uv, mask, source, materials = [], [], [], [], [], []
        original = np.asarray(root['vertices'], dtype=float)
        shared_uv = continuous_bark_uv(root)
        for fi, polygon in enumerate(root['faces']):
            p = original[polygon]
            n = face_normal(p)
            face_uv=shared_uv[polygon].copy()
            if np.ptp(face_uv[:,0])>.5:
                face_uv[face_uv[:,0]<.5,0]+=1
            # Both sides of the cylindrical seam sample matching band edges.
            face_uv[:,0]=(1+face_uv[:,0])/4
            is_grab = fi in root['grab_faces']
            rng = np.random.default_rng(stable_seed(f'{seed}:{root["id"]}:{fi}'))
            for j in range(1, len(p)-1):
                v, f, bary = _subdivide_triangle(p[[0,j,j+1]], subdivisions)
                if not is_grab:
                    # Pin every edge; adjacent faces and triangulation seams stay joined.
                    envelope = np.prod(bary, axis=1)*27
                    v += n*(rng.uniform(-bark_depth, bark_depth, len(v))*envelope)[:, None]
                tex = bary @ face_uv[[0,j,j+1]]
                offset = len(vertices)
                vertices.extend(v); faces.extend(f+offset); uv.extend(tex)
                mask.extend([float(is_grab)]*len(v))
                source.extend([fi]*len(f)); materials.extend([int(is_grab)]*len(f))
        result.append(dict(id=root['id'], vertices=np.asarray(vertices),
                           faces=np.asarray(faces), uv=np.asarray(uv),
                           grab=np.asarray(mask), source_faces=np.asarray(source),
                           materials=np.asarray(materials)))
    return result


def build_decorations(data, seed=1234, count=14, clearance=.12):
    rng = random.Random(stable_seed(f'{seed}:decoration'))
    grab_triangles, _ = source_triangles(data, only_grab=True)
    candidates = []
    for root in data['roots']:
        v = np.asarray(root['vertices'])
        for fi, face in enumerate(root['faces']):
            p = v[face]
            n = face_normal(p)
            if fi not in root['grab_faces'] and n[1] > -.65:
                for j in range(1, len(p)-1):
                    tri = p[[0, j, j+1]]
                    area = np.linalg.norm(np.cross(tri[1]-tri[0], tri[2]-tri[0]))/2
                    candidates.append((root['id'], fi, tri, n, area))
    if not candidates:
        return []
    cfg = variant('stragglers')
    cfg.update(nodes=10, wander=.12, gravity=.11, hug=0, max_depth=0, flare=0)
    branches = []
    for _ in range(count*60):
        if len(branches) >= count:
            break
        root_id, fi, p, n, _ = rng.choices(candidates, weights=[c[-1] for c in candidates])[0]
        a, b = rng.random(), rng.random()
        if a+b > 1:
            a, b = 1-a, 1-b
        origin = p[0]*(1-a-b)+p[1]*a+p[2]*b-n*.008
        direction = normalize(n*.9 + np.array([rng.uniform(-.6,.6), .15, -.6]))
        branch, _ = grow_branch(rng, origin, direction, rng.uniform(.25,.65),
                                rng.uniform(.014,.032), 2, cfg)
        # Check every exported LOD, since reducing nodes creates longer chords.
        levels = [decoration_mesh(branch, lod) for lod in (0,1)]
        if all(clearance_ok(v, f, grab_triangles, clearance) for v,f,_,_ in levels):
            branches.append(dict(id=f'twig_{len(branches):03}', root_id=root_id,
                                 source_face=fi, branch=branch))
    return branches


def decoration_mesh(branch, lod):
    if lod == 0:
        return tube(branch, 6)
    indices = list(range(0, len(branch.points)-1, 2))+[len(branch.points)-1]
    small = Branch([branch.points[i] for i in indices], [branch.radii[i] for i in indices],
                   branch.depth, branch.band, branch.v_offset)
    return tube(small, 4)


def build_asset(data, seed=1234, subdivisions=4, bark_depth=.006,
                decoration_count=14, hand_clearance=.12):
    validate_blockout(data)
    if not isinstance(subdivisions, int) or not 1 <= subdivisions <= 16:
        raise ValueError('subdivisions must be an integer from 1 to 16.')
    if not 0 <= bark_depth <= .02:
        raise ValueError('bark_depth must be between 0 and .02 metres.')
    if not isinstance(decoration_count, int) or not 0 <= decoration_count <= 200:
        raise ValueError('decoration_count must be between 0 and 200.')
    if not .02 <= hand_clearance <= .5:
        raise ValueError('hand_clearance must be between .02 and .5 metres.')
    return dict(source=data, seed=seed, hand_clearance=hand_clearance,
                structure=build_structure(data, seed, subdivisions, bark_depth),
                decorations=build_decorations(data, seed, decoration_count, hand_clearance))


def grab_manifest(asset):
    """Authoritative Z-up grab data; independent of mesh triangle ordering/LOD."""
    faces = []
    for root in asset['source']['roots']:
        v = np.asarray(root['vertices'])
        for fi in sorted(set(root['grab_faces'])):
            points = v[root['faces'][fi]]
            faces.append(dict(root_id=root['id'], source_face=fi,
                              polygon=points.tolist(), normal=face_normal(points).tolist()))
    return dict(version=1, units='meters', up_axis='Z',
                coordinate_space='baked blockout world space',
                gltf_conversion='GLB is Y-up: (x, y, z) -> (x, z, -y)',
                hand_clearance=asset['hand_clearance'], faces=faces,
                decorative_grabbable=False,
                collision_rule='Use original closed meshes for solid collision; marked face nodes for grab queries only.')


def query_grab(asset, hand_position, max_distance=.25, hand_radius=.055,
               extra_obstacles=None):
    """Reference nearest safe grab in Z-up blockout coordinates, or None.

    Inset the full original polygon by the hand radius, not each triangle.
    Reject back-side approaches and hand-volume overlap with structure/twigs.
    A game must additionally test reach/visibility against its level colliders.
    extra_obstacles can contain those triangles in the same coordinate space.
    """
    if max_distance < 0 or hand_radius <= 0:
        raise ValueError('Use nonnegative reach and positive hand radius.')
    p = np.asarray(hand_position, dtype=float)
    if p.shape != (3,) or not np.isfinite(p).all():
        raise ValueError('hand_position must be a finite 3D point.')
    solid, _ = source_triangles(asset['source'])
    decoration = []
    for item in asset['decorations']:
        v,f,_,_ = decoration_mesh(item['branch'], 0)
        decoration.extend(v[f])
    obstacles = [solid, np.asarray(decoration).reshape(-1,3,3)]
    if extra_obstacles is not None:
        obstacles.append(np.asarray(extra_obstacles).reshape(-1,3,3))
    obstacle_triangles = np.concatenate(obstacles)
    best = None
    for face in grab_manifest(asset)['faces']:
        polygon, n = np.asarray(face['polygon']), np.asarray(face['normal'])
        distance = float(np.dot(p-polygon[0], n))
        if distance < -1e-6 or distance > max_distance:
            continue
        point = p-n*distance
        # A disk centered at the contact must fit inside the convex polygon.
        if any(np.dot(np.cross(b-a, point-a), n)/np.linalg.norm(b-a) < hand_radius
               for a,b in zip(polygon, np.roll(polygon,-1,axis=0))):
            continue
        center = point+n*hand_radius
        nearest = closest_points(center, obstacle_triangles)
        if np.linalg.norm(nearest-center, axis=1).min() < hand_radius-1e-6:
            continue
        # Reject approaches crossing another face or twig on the way to contact.
        delta = p-point
        if np.linalg.norm(delta) > 1e-8:
            # At a line/plane intersection, the closest triangle point is identical.
            normals = np.cross(obstacle_triangles[:,1]-obstacle_triangles[:,0],
                               obstacle_triangles[:,2]-obstacle_triangles[:,0])
            denom = normals @ delta
            valid = np.abs(denom) > 1e-12
            t = np.full(len(normals), -1.)
            t[valid] = np.sum(normals[valid]*(obstacle_triangles[valid,0]-point),axis=1)/denom[valid]
            blocked = False
            for tri, value in zip(obstacle_triangles[(t>1e-5)&(t<1-1e-5)], t[(t>1e-5)&(t<1-1e-5)]):
                hit = point+delta*value
                if np.linalg.norm(closest_points(hit, tri[None])[0]-hit) < 1e-7:
                    blocked = True
                    break
            if blocked:
                continue
        if best is None or distance < best['distance']:
            best = dict(root_id=face['root_id'], source_face=face['source_face'],
                        point=point.tolist(), normal=n.tolist(), distance=distance)
    return best


def make_demo_blockout():
    """An editable polygon cage, not a random centerline-generated climbing route."""
    roots = []
    for name, stations in [
        ('main_root', [(0,.12,2.8,.24),(.14,.31,2.25,.23),(-.10,.37,1.65,.20),
                       (.06,.32,1.05,.18),(.28,.22,.45,.13)]),
        ('side_root', [(.03,.14,2.7,.25),(-.48,.29,2.3,.26),(-.93,.35,1.98,.24),
                       (-1.36,.22,1.5,.085)])]:
        vertices = []
        sides = 8
        for x,y,z,r in stations:
            for j in range(sides):
                angle = 2*math.pi*j/sides
                vertices.append([x+r*math.cos(angle), y+r*math.sin(angle), z])
        # Stations descend in Z. These side windings point outward.
        faces = [list(range(sides))]
        grab_faces = []
        for ring in range(len(stations)-1):
            for j in range(sides):
                faces.append([ring*sides+j, (ring+1)*sides+j,
                              (ring+1)*sides+(j+1)%sides, ring*sides+(j+1)%sides])
                # Wide forward-facing panels; bottom narrow tips are not grabbable.
                if j in (1,2) and ring < len(stations)-2:
                    grab_faces.append(len(faces)-1)
        faces.append(list(reversed(range((len(stations)-1)*sides,len(vertices)))))
        roots.append(dict(id=name, vertices=vertices, faces=faces, grab_faces=grab_faces))
    return validate_blockout(dict(version=1, units='meters', up_axis='Z', roots=roots))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, help='Polygon blockout JSON; defaults to demo.')
    parser.add_argument('--out', type=Path, default=Path(__file__).parent/'polygon_output')
    parser.add_argument('--seed', type=int, default=1234)
    args = parser.parse_args()
    data = json.loads(args.input.read_text()) if args.input else make_demo_blockout()
    asset = build_asset(data, seed=args.seed)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out/'blockout.json').write_text(json.dumps(data, indent=2))
    (args.out/'roots.grab.json').write_text(json.dumps(grab_manifest(asset), indent=2))
    print(f'{len(asset["structure"])} structural roots, {len(asset["decorations"])} decorative branches; grab manifest saved.')
