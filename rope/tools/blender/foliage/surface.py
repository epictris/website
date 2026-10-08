"""The rock a plant grows on, as the generators ask about it, and the helpers
both generators share: the seeded hash, the tangent plane, and the other
plants a new one keeps clear of.

The generators are ports of karin-lu's three.js generators (hangingVine.ts and
fern.ts), whose world is y-up. Here the world is Blender's, z-up, and every
constant direction is mapped by three (x, y, z) -> Blender (x, -z, y), a
rotation, so every cross product and turn carries over unchanged."""

import math

import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

UP = Vector((0.0, 0.0, 1.0))
DOWN = Vector((0.0, 0.0, -1.0))
FORWARD = Vector((0.0, -1.0, 0.0))  # three's +z: toward the game's camera
X_AXIS = Vector((1.0, 0.0, 0.0))

_M32 = 0xFFFFFFFF


def _imul(a, b):
    return ((a & _M32) * (b & _M32)) & _M32


def rand(seed, i, salt=0):
    """A number in [0, 1) from the seed, an index and a salt: karin's hash,
    bit for bit (Math.imul is a 32-bit product, which masking reproduces)."""
    n = ((seed & _M32) ^ _imul(i + 1, 374761393) ^ _imul(salt + 1, 668265263)) & _M32
    n = _imul(n ^ (n >> 13), 1274126177)
    return ((n ^ (n >> 16)) & _M32) / 4294967296.0


def tangent_on(direction, normal):
    """`direction` flattened onto the plane of `normal`, normalised; a
    direction along the normal falls back to a fixed one in the plane."""
    t = direction - normal * direction.dot(normal)
    if t.length_squared < 1e-8:
        t = normal.cross(FORWARD if abs(normal.y) < 0.9 else UP)
    return t.normalized()


def lerp(a, b, t):
    return a + (b - a) * t


def jround(x):
    """JavaScript's Math.round: halves round up, not to even."""
    return math.floor(x + 0.5)


def sign(x):
    """JavaScript's Math.sign: 0 for 0."""
    return 1.0 if x > 0.0 else -1.0 if x < 0.0 else 0.0


def smoothstep(x, lo, hi):
    if x <= lo:
        return 0.0
    if x >= hi:
        return 1.0
    x = (x - lo) / (hi - lo)
    return x * x * (3.0 - 2.0 * x)


def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


class Contact:
    __slots__ = ("point", "normal", "distance", "signed")

    def __init__(self, point, normal, distance, signed):
        self.point = point
        self.normal = normal
        self.distance = distance
        self.signed = signed


class Surface:
    """The host's triangles in the world, for nearest-point questions: a
    Blender BVH, asked the questions karin's VineSurface answered."""

    def __init__(self, co, tri):
        a, b, c = co[tri[:, 0]], co[tri[:, 1]], co[tri[:, 2]]
        area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
        tri = tri[area > 1e-12]
        if len(tri) == 0:
            raise ValueError("the host has no usable faces")
        self.bvh = BVHTree.FromPolygons(co.tolist(), tri.tolist(), all_triangles=True)
        self.co = co
        self.tri = tri

    @classmethod
    def from_object(cls, host, depsgraph):
        """The host's evaluated mesh in the world, wound so its normals point out
        even under a mirroring transform."""
        ev = host.evaluated_get(depsgraph)
        me = ev.to_mesh()
        try:
            me.calc_loop_triangles()
            n = len(me.vertices)
            co = np.empty(n * 3, dtype=np.float64)
            me.vertices.foreach_get("co", co)
            tri = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
            me.loop_triangles.foreach_get("vertices", tri)
        finally:
            ev.to_mesh_clear()
        m = np.array(host.matrix_world, dtype=np.float64)
        co = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
        tri = tri.reshape(-1, 3)
        if np.linalg.det(m[:3, :3]) < 0:
            tri = tri[:, ::-1]
        return cls(co, np.ascontiguousarray(tri))

    def nearest(self, p, max_dist=math.inf):
        loc, face_normal, _i, dist = self.bvh.find_nearest(p, max_dist if max_dist != math.inf else 1.0e18)
        if loc is None or dist >= max_dist:
            return None
        delta = p - loc
        side = delta.dot(face_normal)
        # At a convex corner the separating vector; a flat face keeps its normal.
        normal = delta / dist if side >= 0.0 and dist > 1e-8 else face_normal.copy()
        return Contact(loc, normal, dist, -dist if side < -1e-7 else dist)

    def project(self, p, clearance):
        """`p` pushed out until it is `clearance` off the surface."""
        p = p.copy()
        for _ in range(4):
            hit = self.nearest(p)
            if hit is None or hit.signed >= clearance - 1e-7:
                break
            p = hit.point + hit.normal * clearance
        return p

    def clear(self, a, b, clearance):
        """Whether the segment a-b keeps `clearance` from the surface along its length."""
        count = max(2, math.ceil((a - b).length / max(clearance * 1.5, 0.008)))
        for i in range(count + 1):
            p = a.lerp(b, i / count)
            hit = self.nearest(p, clearance * 3.0)
            if hit is not None and hit.signed < clearance * 0.82:
                return False
        return True

    def inside(self, p, pad):
        """Whether `p` is within `pad` of the surface, or behind it."""
        hit = self.nearest(p, pad * 3.0)
        return hit is not None and hit.signed < pad


class Avoid:
    """Other plants a new one keeps clear of: points sampled over their meshes,
    each a sphere of RADIUS, as karin's editor sampled the plants already on a
    rock."""

    RADIUS = 0.018

    def __init__(self, points):
        self.n = len(points)
        self.kd = KDTree(max(self.n, 1))
        for i, p in enumerate(points):
            self.kd.insert(p, i)
        self.kd.balance()

    def hits(self, p, pad=0.0):
        """Whether `p` (padded by `pad`) lies in one of the spheres."""
        if self.n == 0:
            return False
        _co, _i, d = self.kd.find(p)
        return d is not None and d <= self.RADIUS + pad

    def hits_any(self, pts):
        """Whether any of `pts` lies inside a sphere (a leaf's blade against them)."""
        if self.n == 0:
            return False
        for p in pts:
            _co, _i, d = self.kd.find(p)
            if d is not None and d < self.RADIUS:
                return True
        return False


NO_AVOID = Avoid([])
