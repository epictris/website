"""Flatten small crease folds against adjacent, substantially planar facets.

Run on the export copy, after choosing the broad crease bows and before
retessellation and baking. Choosing bows after this repair reshuffles their
random sequence and changes unrelated parts of the formation.
"""
import json
import math

import bmesh
import numpy as np
from mathutils import Matrix, Vector


def applies(ob):
    try:
        recipe = json.loads(ob.get('formation_recipe', '{}'))
    except (TypeError, ValueError):
        return False
    return (recipe.get('generator') == 'solid'
            and recipe.get('params', {}).get('adaptiveDepth', True))


def stone_scale(ob):
    """Small authored stones need proportionally smaller repair tolerances."""
    recipe = json.loads(ob.get('formation_recipe', '{}'))
    return min(1., max(.01, float(recipe.get('params', {}).get('stoneSize', 1.))))


def repair(mesh, frame=None, scale=1.):
    """Repair centimetre-scale folds without a remesh or added geometry.

    Small faces between broad facets can fold sideways into little teeth.
    Nearby facet planes locate the intended crease (two planes) or corner
    (three). Only use facets flat to within 1 cm, search four local edge
    rings within 12 cm, and reject corrections over 5 cm. These are physical
    surface-cleanup tolerances, independent of the depth sampling policy.
    For Stone size below one, shrink the distances and support areas with
    that size so cleaning a crease does not flatten a small authored stone.

    Keep 5% of the old offset so thin bevel strips do not collapse to zero;
    the existing crease rebuild folds their remaining microscopic slivers.
    The input's face attributes and topology are retained.
    """
    bm = bmesh.new()
    scale = min(1., max(.01, float(scale)))
    try:
        bm.from_mesh(mesh)
        matrix = Matrix(frame) if frame is not None else Matrix.Identity(4)
        inverse = matrix.inverted()
        bm.transform(matrix)
        bm.normal_update()
        areas = {f: f.calc_area() for f in bm.faces}
        planes = {}
        for face, area in areas.items():
            if area <= .02*scale**2:
                continue
            normal, centre = face.normal.copy(), face.calc_center_median()
            if max(abs(normal.dot(v.co - centre)) for v in face.verts) < .01*scale:
                planes[face] = normal, centre
        original, proposals = {}, {}
        distinct = math.cos(math.radians(20))
        for vertex in bm.verts:
            reached, front, nearby = {vertex}, {vertex}, set()
            for _ in range(4):
                nearby.update(f for v in front for f in v.link_faces if f in planes)
                neighbours = {e.other_vert(v) for v in front for e in v.link_edges} - reached
                front = {v for v in neighbours if (v.co - vertex.co).length < .12*scale}
                reached.update(front)
            supports = []
            for face in sorted(nearby, key=lambda f: (-areas[f], f.index)):
                normal, centre = planes[face]
                if all(abs(normal.dot(n)) < distinct for n, _ in supports):
                    supports.append((normal, centre))
                if len(supports) == 3:
                    break
            if len(supports) < 2:
                continue
            normals = np.array([n[:] for n, _ in supports])
            distances = np.array([n.dot(vertex.co - c) for n, c in supports])
            gram = normals @ normals.T
            if abs(np.linalg.det(gram)) < .02:
                continue
            offset = normals.T @ np.linalg.solve(gram, distances)
            if np.linalg.norm(offset) > .05*scale:
                continue
            original[vertex] = vertex.co.copy()
            proposals[vertex] = vertex.co - Vector(offset) * .95
        for vertex, point in proposals.items():
            vertex.co = point
        # Float precision can erase an already microscopic triangle. Restore
        # affected vertices, monotonically, rather than passing new zero-area
        # faces to the exporter. No topology changes or whole-mesh copies.
        for _ in range(32):
            bad = {v for f in bm.faces if areas[f] > 1e-12 and f.calc_area() <= 1e-12
                   for v in f.verts if v in proposals}
            if not bad:
                break
            for vertex in bad:
                vertex.co = original[vertex]
                del proposals[vertex]
        else:
            for vertex in proposals:
                vertex.co = original[vertex]
            proposals.clear()
        bm.transform(inverse)
        bm.normal_update()
        bm.to_mesh(mesh)
        mesh.update()
        return f'{len(proposals)} crease vertices fitted to neighbouring facets'
    finally:
        bm.free()
