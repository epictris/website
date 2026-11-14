"""What a generator writes into: one mesh of triangles with a colour, a UV
and (where the generator chooses one) a normal per vertex, all in the world.
Leaves sample their piece of the atlas; stems and the crown sample its solid
white cell, so the vertex colour alone is their colour."""

import math

import numpy as np
from mathutils import Matrix, Vector

from . import library
from .surface import tangent_on


def retained(samples, tolerance):
    """Indices whose piecewise-linear interpolation stays within tolerance.

    Each sample may contain many XYZ points: a card row is tested over its
    full width. Using index interpolation also preserves the card's UV map.
    """
    a = np.asarray(samples, dtype=float)
    if tolerance <= 0 or len(a) <= 2:
        return list(range(len(a)))
    a = a.reshape(len(a), -1, 3)
    keep = {0, len(a) - 1}
    todo = [(0, len(a) - 1)]
    while todo:
        lo, hi = todo.pop()
        if hi <= lo + 1:
            continue
        f = np.arange(1, hi - lo)[:, None, None] / (hi - lo)
        error = np.linalg.norm(a[lo + 1:hi] - (a[lo] + f * (a[hi] - a[lo])), axis=-1).max(axis=1)
        k = int(np.argmax(error))
        if error[k] > tolerance:
            mid = lo + 1 + k
            keep.add(mid)
            todo.extend(((lo, mid), (mid, hi)))
    return sorted(keep)


class Builder:
    def __init__(self, tolerance=0.0):
        self.tolerance = tolerance
        self.pos = []
        self.nrm = []  # None where the vertex takes its faces' normal
        self.uv = []
        self.col = []
        self.tri = []

    def __len__(self):
        return len(self.pos)

    def vertex(self, p, uv, colour, normal=None):
        self.pos.append(p)
        self.uv.append(uv)
        self.col.append(colour)
        self.nrm.append(normal)
        return len(self.pos) - 1

    def grid(self, offset, rows, cols):
        """Two triangles per cell of a (rows + 1) x (cols + 1) vertex grid laid
        row after row from `offset`, wound toward the grid's face."""
        pts = np.asarray(self.pos[offset:offset + (rows + 1) * (cols + 1)]).reshape(rows + 1, cols + 1, 3)
        rs = retained(pts, self.tolerance / 2)
        cs = retained(pts.transpose(1, 0, 2), self.tolerance / 2)
        for r0, r1 in zip(rs, rs[1:]):
            for c0, c1 in zip(cs, cs[1:]):
                a = offset + r0 * (cols + 1) + c0
                b = offset + r1 * (cols + 1) + c0
                a1 = offset + r0 * (cols + 1) + c1
                b1 = offset + r1 * (cols + 1) + c1
                self.tri.extend(((a, a1, b), (a1, b1, b)))

    def tube(self, path, radius, colour_at, sides=8, tip=0.3):
        """A swept, tapering tube along `path` with closed ends: rings carried
        along by parallel transport so it never twists at a near-vertical bend,
        tapering to `tip` of its radius. `colour_at(f)` colours the ring a
        fraction f along the path (karin's tubeGeometry, without the seam
        column a texture needed: the tube samples the solid cell)."""
        if self.tolerance > 0:
            error = self.tolerance / 2
            if len(path) > 2 and (path[0] - path[-1]).length < 1e-8:
                # A luminous closed rim must not collapse to coincident ends.
                extent = max((v - path[0]).length for v in path)
                error = min(error, extent * 0.1)
            path = [path[i] for i in retained(path, error)]
            while sides > 3 and radius * (1 - math.cos(math.pi / (sides - 1))) <= self.tolerance / 2:
                sides -= 1
        n = len(path)
        if n < 2:
            return
        total = sum((path[i] - path[i - 1]).length for i in range(1, n))
        frame = Vector((1.0, 0.0, 0.0))
        start = len(self.pos)
        dist = 0.0
        for i in range(n):
            tangent = (path[min(i + 1, n - 1)] - path[max(0, i - 1)]).normalized()
            frame = tangent_on(frame, tangent)
            binormal = tangent.cross(frame).normalized()
            if i:
                dist += (path[i] - path[i - 1]).length
            f = dist / max(total, 1e-6)
            taper = tip + (1.0 - tip) * max(0.0, 1.0 - f) ** 0.4
            c = colour_at(f)
            for j in range(sides):
                a = j / sides * 2.0 * math.pi
                self.vertex(path[i] + frame * (math.cos(a) * radius * taper) + binormal * (math.sin(a) * radius * taper), library.SOLID_UV, c)
        for i in range(1, n):
            for j in range(sides):
                a = start + (i - 1) * sides + j
                a1 = start + (i - 1) * sides + (j + 1) % sides
                b = start + i * sides + j
                b1 = start + i * sides + (j + 1) % sides
                self.tri.append((a, a1, b))
                self.tri.append((a1, b1, b))
        end = start + (n - 1) * sides
        for j in range(1, sides - 1):
            self.tri.append((start, start + j + 1, start + j))
            self.tri.append((end, end + j, end + j + 1))

    def knot(self, centre, normal, radius, colour):
        """A flattened, flat-shaded icosphere (80 faces) squashed along `normal`:
        the dark knot at a fern's crown that hides where its fronds meet the rock."""
        import bmesh

        bm = bmesh.new()
        try:
            bmesh.ops.create_icosphere(bm, subdivisions=1 if self.tolerance >= radius * 0.2 else 2, radius=radius)
            rot = normal.to_track_quat("Z", "Y").to_matrix().to_4x4()
            m = Matrix.Translation(centre) @ rot @ Matrix.Diagonal((1.0, 1.0, 0.55, 1.0))
            for f in bm.faces:
                pts = [m @ v.co for v in f.verts]
                fn = (pts[1] - pts[0]).cross(pts[2] - pts[0]).normalized()
                i0 = len(self.pos)
                for p in pts:
                    self.vertex(p, library.SOLID_UV, colour, fn)
                for k in range(1, len(pts) - 1):
                    self.tri.append((i0, i0 + k, i0 + k + 1))
        finally:
            bm.free()

    def arrays(self):
        """(positions, normals, uvs, colours, triangles) as arrays; a vertex the
        generator gave no normal takes the area-weighted normal of its faces,
        as three's computeVertexNormals gives it."""
        pos = np.array([tuple(p) for p in self.pos], dtype=np.float64).reshape(-1, 3)
        tri = np.array(self.tri, dtype=np.int64).reshape(-1, 3)
        acc = np.zeros_like(pos)
        if len(tri):
            a, b, c = pos[tri[:, 0]], pos[tri[:, 1]], pos[tri[:, 2]]
            fn = np.cross(b - a, c - a)
            for k in range(3):
                np.add.at(acc, tri[:, k], fn)
        own = np.array([tuple(n) if n is not None else (np.nan, np.nan, np.nan) for n in self.nrm], dtype=np.float64).reshape(-1, 3)
        given = ~np.isnan(own[:, 0])
        nrm = np.where(given[:, None], own, acc)
        length = np.linalg.norm(nrm, axis=1, keepdims=True)
        nrm = np.where(length > 1e-12, nrm / np.maximum(length, 1e-12), np.array([0.0, 0.0, 1.0]))
        uv = np.array(self.uv, dtype=np.float64).reshape(-1, 2)
        col = np.array(self.col, dtype=np.float64).reshape(-1, 3)
        if self.tolerance <= 0:
            return pos, nrm, uv, col, tri
        used = np.unique(tri)
        remap = np.full(len(pos), -1, dtype=np.int64)
        remap[used] = np.arange(len(used))
        return pos[used], nrm[used], uv[used], col[used], remap[tri]


def card_uv(piece, u, v):
    """The atlas UV of (u, v) on a piece (u across, v from its base end)."""
    ru, rv, rw, rh = piece.rect
    if piece.mirrored:
        u = 1.0 - u
    return (ru + u * rw, rv + v * rh)
