"""Measure UV overlap, excluding shared edges and float32 rounding slivers."""
import numpy as np


def intersection_area(first, second):
    polygon = [np.asarray(p, dtype=float) for p in first]
    second = np.asarray(second, dtype=float)
    cross = lambda a, b: float(a[0]*b[1]-a[1]*b[0])
    winding = cross(second[1]-second[0], second[2]-second[0])
    if winding == 0:
        return 0.0
    sign = 1 if winding > 0 else -1
    for i in range(3):
        if not polygon:
            return 0.0
        origin, end = second[i], second[(i+1) % 3]
        edge = end-origin
        clipped = []
        previous = polygon[-1]
        before = sign*cross(edge, previous-origin)
        for current in polygon:
            after = sign*cross(edge, current-origin)
            if (before >= 0) != (after >= 0):
                clipped.append(previous+(current-previous)*(before/(before-after)))
            if after >= 0:
                clipped.append(current)
            previous, before = current, after
        polygon = clipped
    if len(polygon) < 3:
        return 0.0
    # Relative coordinates avoid cancellation for tiny patches far from zero.
    return abs(sum(cross(polygon[i]-polygon[0], polygon[i+1]-polygon[0])
                   for i in range(1, len(polygon)-1)))/2


def overlapping_faces(triangles, candidates, area_tolerance):
    """Narrow-phase check of Blender's conservative overlap selection."""
    candidates = np.asarray(candidates)
    tri = triangles[candidates]
    lower, upper = tri.min(axis=1), tri.max(axis=1)
    found = set()
    for i in range(len(tri)):
        peers = np.flatnonzero(np.all(upper[i] > lower[i+1:], axis=1)
                               & np.all(upper[i+1:] > lower[i], axis=1))+i+1
        for j in peers:
            if intersection_area(tri[i], tri[j]) > area_tolerance:
                found.update((int(candidates[i]), int(candidates[j])))
    return np.array(sorted(found), dtype=np.int64)
