"""Partition a coarse triangle surface once, before expensive per-band work.

No caps, booleans, remesh or Blender dependency. Shared intersections are
computed once. Corner attributes stay separate (hard normals and UV seams).
Cost follows input triangles and cut intersections, not mesh size x bands.
"""
from bisect import bisect_left
from dataclasses import dataclass, field
import math


@dataclass(frozen=True)
class Corner:
    vertex: int
    # First three values are an unnormalised interpolated normal, then UVs.
    attributes: tuple


@dataclass(frozen=True)
class Face:
    corners: tuple
    material: int = 0
    facet: float = 0.0


@dataclass
class Chunk:
    band: object
    faces: list = field(default_factory=list)


def normalised(attributes):
    length = math.sqrt(sum(x * x for x in attributes[:3]))
    if length < 1e-12:
        raise ValueError("Cannot interpolate a zero surface normal")
    return tuple(x / length for x in attributes[:3]) + tuple(attributes[3:])


def partition(positions, faces, bands):
    """Return shared positions and uncapped chunks; leave inputs unchanged.

    Input is triangulated already, including non-planar Blender n-gons, so
    clipping never changes the surface. Coplanar faces belong to one band.
    """
    if not bands:
        raise ValueError("At least one band is required")
    cuts = [b.far for b in bands[:-1]]
    if any(a.far != b.near for a, b in zip(bands, bands[1:])):
        raise ValueError("Bands must be contiguous")
    if any(b.far < b.near for b in bands) or any(a >= b for a, b in zip(cuts, cuts[1:])):
        raise ValueError("Bands must be ordered")
    points = list(positions)
    chunks = [Chunk(band) for band in bands]
    intersections = {}

    def intersection(a, b, plane, cut):
        va, vb = a.vertex, b.vertex
        if points[va][1] == plane:
            return a
        if points[vb][1] == plane:
            return b
        # Same orientation on every incident face, even at hard/UV seams.
        if va > vb:
            a, b, va, vb = b, a, vb, va
        pa, pb = points[va], points[vb]
        t = (plane - pa[1]) / (pb[1] - pa[1])
        key = (va, vb, cut)
        if key not in intersections:
            intersections[key] = len(points)
            points.append((pa[0] + t * (pb[0] - pa[0]), plane, pa[2] + t * (pb[2] - pa[2])))
        attrs = tuple(x + t * (y - x) for x, y in zip(a.attributes, b.attributes))
        return Corner(intersections[key], attrs)

    def emit(polygon, chunk, original):
        # A plane through an existing vertex can repeat it in a clipped ring.
        ring = []
        for corner in polygon:
            if not ring or ring[-1].vertex != corner.vertex:
                ring.append(corner)
        if len(ring) > 1 and ring[0].vertex == ring[-1].vertex:
            ring.pop()
        for i in range(1, len(ring) - 1):
            tri = (ring[0], ring[i], ring[i + 1])
            chunk.faces.append(Face(tri, original.material, original.facet))

    for face in faces:
        if len(face.corners) != 3:
            raise ValueError("Partition expects triangles")
        polygon = list(face.corners)
        ys = [points[c.vertex][1] for c in polygon]
        if min(ys) < bands[0].near - 1e-6 or max(ys) > bands[-1].far + 1e-6:
            raise ValueError("Surface is outside the planned depth range")
        index = bisect_left(cuts, min(ys))
        while index < len(cuts) and max(ys) > cuts[index]:
            plane = cuts[index]
            front, back = [], []
            for a, b in zip(polygon, polygon[1:] + polygon[:1]):
                da, db = points[a.vertex][1] - plane, points[b.vertex][1] - plane
                if da <= 0:
                    front.append(a)
                if da >= 0:
                    back.append(a)
                if da * db < 0:
                    corner = intersection(a, b, plane, index)
                    front.append(corner)
                    back.append(corner)
            emit(front, chunks[index], face)
            polygon = back
            index += 1
        emit(polygon, chunks[index], face)
    return points, chunks


def area(points, faces):
    total = 0.0
    for face in faces:
        a, b, c = (points[v.vertex] for v in face.corners)
        u, v = [b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)]
        cross = (u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0])
        total += math.sqrt(sum(x*x for x in cross)) / 2
    return total


def boundary_edges(faces):
    counts = {}
    for face in faces:
        ids = [c.vertex for c in face.corners]
        for a, b in zip(ids, ids[1:] + ids[:1]):
            key = tuple(sorted((a, b)))
            counts[key] = counts.get(key, 0) + 1
    return {edge for edge, count in counts.items() if count == 1}


def closed_surface(faces):
    """Every edge has exactly two incident triangles, with opposite winding."""
    edges = {}
    for face in faces:
        ids = [c.vertex for c in face.corners]
        for a, b in zip(ids, ids[1:] + ids[:1]):
            key = tuple(sorted((a, b)))
            edges.setdefault(key, []).append(1 if a < b else -1)
    return bool(edges) and all(len(v) == 2 and sum(v) == 0 for v in edges.values())


def pack(points, chunk):
    """Weld compatible corners, retain hard edges, UV seams and facet tone."""
    vertices, indices, lookup = [], [], {}
    for face in chunk.faces:
        for corner in face.corners:
            attrs = normalised(corner.attributes)
            key = (corner.vertex, tuple(round(v, 7) for v in attrs), face.material, face.facet)
            if key not in lookup:
                lookup[key] = len(vertices)
                vertices.append({"source": corner.vertex, "position": points[corner.vertex],
                                 "attributes": attrs, "material": face.material, "facet": face.facet})
            indices.append(lookup[key])
    return {"vertices": vertices, "indices": indices, "error": chunk.band.geometry_error}


def unpack(packed, indices, band):
    vertices = packed["vertices"]
    faces = []
    for i in range(0, len(indices), 3):
        tri = [vertices[j] for j in indices[i:i + 3]]
        if len({(v['material'], v['facet']) for v in tri}) != 1:
            raise ValueError("Simplification crossed a material or facet boundary")
        faces.append(Face(tuple(Corner(v["source"], tuple(v["attributes"])) for v in tri),
                          tri[0]["material"], tri[0]["facet"]))
    return Chunk(band, faces)
