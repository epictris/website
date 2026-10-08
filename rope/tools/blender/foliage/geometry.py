"""What a generator writes into: one mesh of triangles with a colour, a UV
and (where the generator chooses one) a normal per vertex, all in the world.
Leaves sample their piece of the atlas; stems and the crown sample its solid
white cell, so the vertex colour alone is their colour."""

import math

import numpy as np
from mathutils import Matrix, Vector

from . import library
from .surface import tangent_on


class Builder:
    def __init__(self):
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
        for r in range(rows):
            for c in range(cols):
                a = offset + r * (cols + 1) + c
                b = a + cols + 1
                self.tri.append((a, a + 1, b))
                self.tri.append((a + 1, b + 1, b))

    def tube(self, path, radius, colour_at, sides=8, tip=0.3):
        """A swept, tapering tube along `path` with closed ends: rings carried
        along by parallel transport so it never twists at a near-vertical bend,
        tapering to `tip` of its radius. `colour_at(f)` colours the ring a
        fraction f along the path (karin's tubeGeometry, without the seam
        column a texture needed: the tube samples the solid cell)."""
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
            bmesh.ops.create_icosphere(bm, subdivisions=2, radius=radius)
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
        return pos, nrm, uv, col, tri


def card_uv(piece, u, v):
    """The atlas UV of (u, v) on a piece (u across, v from its base end)."""
    ru, rv, rw, rh = piece.rect
    if piece.mirrored:
        u = 1.0 - u
    return (ru + u * rw, rv + v * rh)
