"""Flat editor polygons -> rounded 3D scenery + authoritative 2D gameplay.

Editor/runtime coordinates are [x, y] with y up. Blender uses (x, depth, y).
Depth, bark noise and decorative branches never change the gameplay outline.
"""
import copy
import math
import numpy as np

from polygon_roots import build_decorations, decoration_mesh, validate_blockout


def cross(a, b):
    return float(a[0]*b[1]-a[1]*b[0])


def segment_distance(p, a, b):
    edge = b-a
    t = np.clip(np.dot(p-a, edge)/np.dot(edge, edge), 0, 1)
    return float(np.linalg.norm(p-a-t*edge))


def signed_area(p):
    return sum(cross(a, b) for a, b in zip(p, np.roll(p, -1, axis=0)))/2


def triangulate(p):
    """Ear clipping; return CCW triangles without reordering source edge IDs."""
    ids = list(range(len(p)))
    if signed_area(p) < 0:
        ids.reverse()
    result = []
    while len(ids) > 3:
        for j, b in enumerate(ids):
            a, c = ids[j-1], ids[(j+1) % len(ids)]
            if cross(p[b]-p[a], p[c]-p[b]) <= 1e-10:
                continue
            if any(all(cross(p[v]-p[u], p[k]-p[u]) >= -1e-10
                       for u, v in ((a,b),(b,c),(c,a)))
                   for k in ids if k not in (a,b,c)):
                continue
            result.append([a,b,c]); ids.pop(j)
            break
        else:
            raise ValueError('Cannot triangulate polygon; remove degenerate vertices.')
    result.append(ids)
    return result


def validate_shapes(data):
    if (data.get('version') != 2 or data.get('units') != 'meters' or
            data.get('up_axis') != 'Y' or data.get('gameplay') != '2D'):
        raise ValueError('Expected version 2, meters, Y-up, gameplay="2D".')
    if not data.get('roots'):
        raise ValueError('Add at least one 2D polygon.')
    names = set()
    for root in data['roots']:
        name = root.get('id')
        if not isinstance(name, str) or not name or name in names:
            raise ValueError('Use unique nonempty root IDs.')
        names.add(name)
        p = np.asarray(root.get('polygon', []), dtype=float)
        if p.ndim != 2 or p.shape[1] != 2 or len(p) < 3 or not np.isfinite(p).all():
            raise ValueError(f'{name}: supply at least three finite [x,y] points.')
        grabs = root.get('grab_edges')
        if not isinstance(grabs, list) or any(type(i) is not int or not 0 <= i < len(p) for i in grabs):
            raise ValueError(f'{name}: supply grab_edges (zero-based outline edge indices).')
        depth = root.get('depth', .38)
        if not isinstance(depth, (int,float)) or not math.isfinite(depth) or not .02 <= depth <= 5:
            raise ValueError(f'{name}: visual depth must be between .02 and 5 metres.')
        rounding=root.get('corner_rounding',0)
        if not isinstance(rounding,(int,float)) or not math.isfinite(rounding) or not 0<=rounding<=1:
            raise ValueError(f'{name}: corner_rounding must be between 0 and 1.')
        broken=root.get('broken_edges',[])
        if not isinstance(broken,list) or any(type(i) is not int or not 0<=i<len(p) for i in broken):
            raise ValueError(f'{name}: broken_edges must contain valid source edge indices.')
        for i, a in enumerate(p):
            b = p[(i+1) % len(p)]
            if np.linalg.norm(b-a) < 1e-6:
                raise ValueError(f'{name}: duplicate adjacent vertices.')
            if abs(cross(a-p[i-1], b-a)) < 1e-10:
                raise ValueError(f'{name}: remove collinear outline vertices.')
            for j in range(i+1, len(p)):
                if j == i+1 or (i == 0 and j == len(p)-1):
                    continue
                c, d = p[j], p[(j+1) % len(p)]
                touch = min(segment_distance(a,c,d), segment_distance(b,c,d),
                            segment_distance(c,a,b), segment_distance(d,a,b)) < 1e-8
                intersects = (cross(b-a,c-a)*cross(b-a,d-a) < 0 and
                              cross(d-c,a-c)*cross(d-c,b-c) < 0)
                if touch or intersects:
                    raise ValueError(f'{name}: outline must be simple, with no crossings or touching edges.')
        if abs(signed_area(p)) < 1e-8:
            raise ValueError(f'{name}: polygon has no area.')
        triangulate(p)
    return data


def extruded_source(data):
    """Internal mesh for export/debug only; never replaces the editor polygon."""
    roots = []
    for root in data['roots']:
        p = np.asarray(root['polygon'], dtype=float)
        n = len(p); h = root.get('depth', .38)/2
        triangles = triangulate(p)
        vertices = [[x, d, y] for d in (-h,h) for x,y in p]
        # CCW in XY becomes a -Y normal in Blender XZ.
        faces = triangles + [[n+i for i in reversed(t)] for t in triangles]
        grab_faces = []
        for i in range(n):
            j = (i+1) % n
            face = [i,n+i,n+j,j]
            if signed_area(p) < 0:
                face.reverse()
            if i in root['grab_edges']:
                grab_faces.append(len(faces))
            faces.append(face)
        roots.append(dict(id=root['id'],vertices=vertices,faces=faces,grab_faces=grab_faces))
    return validate_blockout(dict(version=1,units='meters',up_axis='Z',roots=roots))


def gameplay_manifest(data):
    roots = []
    for root in data['roots']:
        roots.append(dict(id=root['id'],polygon=copy.deepcopy(root['polygon']),
                          grab_edges=list(root['grab_edges']),
                          source_edges=list(root.get('source_edges',range(len(root['polygon'])))),
                          collision_triangles=triangulate(np.asarray(root['polygon'],dtype=float))))
    return dict(version=2,units='meters',up_axis='Y',gameplay='2D',plane='XY',
                render_depth_axis='Z',roots=roots,decorative_grabbable=False,
                collision_rule='Use these 2D polygons for all physics; visual meshes never define collision.')


def build_asset_2d(data, seed=1234, decoration_count=14, hand_clearance=.12):
    from sideview_surface import build_surfaces
    from sideview_outline import resolve_outlines
    validate_shapes(data)
    if type(decoration_count) is not int or not 0 <= decoration_count <= 200:
        raise ValueError('decoration_count must be an integer from 0 to 200.')
    if not math.isfinite(hand_clearance) or not .02 <= hand_clearance <= .5:
        raise ValueError('hand_clearance must be between .02 and .5 metres.')
    resolved=resolve_outlines(data)
    source = extruded_source(resolved)
    edges = [(np.asarray(r['polygon'][i]),np.asarray(r['polygon'][(i+1)%len(r['polygon'])]))
             for r in resolved['roots'] for i in r['grab_edges']]
    decorations = []
    for item in build_decorations(source,seed,decoration_count,hand_clearance):
        safe = True
        for lod in (0,1):
            v,f,_,_ = decoration_mesh(item['branch'],lod)
            triangles = v[f][:,:,[0,2]]
            centers = triangles.mean(axis=1)
            radii = np.linalg.norm(triangles-centers[:,None],axis=2).max(axis=1)
            if any(segment_distance(c,a,b)-radius < hand_clearance
                   for c,radius in zip(centers,radii) for a,b in edges):
                safe = False; break
        if safe:
            decorations.append(item)
    return dict(source=source,editor_source=copy.deepcopy(data),resolved_source=resolved,gameplay2d=gameplay_manifest(resolved),
                seed=seed,hand_clearance=hand_clearance,decorations=decorations,
                structure=build_surfaces(resolved['roots'],seed))


def make_demo_shapes():
    # Counterclockwise outlines: broad limbs, tapering tips, concave forks.
    polygons = [
        ('main_root',[[-.20,.35],[.04,.30],[.18,.80],[.12,1.20],[.31,1.70],
                      [.25,2.15],[.48,2.72],[.36,3.05],[-.04,3.08],[-.19,2.67],
                      [-.10,2.12],[-.29,1.72],[-.24,1.19],[-.34,.78]], .45),
        ('left_limb',[[-1.60,1.05],[-1.46,1.12],[-1.13,1.57],[-.71,1.76],
                     [-.36,2.15],[.06,2.47],[-.05,2.76],[-.55,2.37],
                     [-.92,1.99],[-1.34,1.76]], .32),
        ('right_limb',[[.06,1.43],[.40,1.59],[.75,1.73],[1.09,2.02],
                      [1.44,2.11],[1.38,2.24],[.95,2.24],[.60,1.99],[.23,1.96]], .28),
    ]
    return validate_shapes(dict(version=2,units='meters',up_axis='Y',gameplay='2D',
        roots=[dict(id=name,polygon=p,grab_edges=list(range(len(p))),depth=depth)
               for name,p,depth in polygons]))
