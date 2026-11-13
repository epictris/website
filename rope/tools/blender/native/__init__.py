"""The native kernels: C++17 and OpenMP (src/), called through ctypes on
numpy arrays. The export's hot loops live here, on every thread, where they
were single-threaded Python (docs/blender-scene-export-speed.md).

The library is built from the sources beside it on first use (build.py), so
a Blender never runs one built from other sources. ctypes releases the GIL
for each call, so Python threads can run kernels side by side."""

import ctypes
import threading

import numpy as np

from . import build as _build

_lib = None
_lock = threading.Lock()

_f64 = np.ctypeslib.ndpointer(dtype=np.float64, flags="C_CONTIGUOUS")
_i64p = np.ctypeslib.ndpointer(dtype=np.int64, flags="C_CONTIGUOUS")
_i32p = np.ctypeslib.ndpointer(dtype=np.int32, flags="C_CONTIGUOUS")
_u8p = np.ctypeslib.ndpointer(dtype=np.uint8, flags="C_CONTIGUOUS")
_i64 = ctypes.c_int64
_ptr = ctypes.c_void_p


def lib():
    """The loaded library, built first if its sources changed."""
    global _lib
    if _lib is not None:
        return _lib
    with _lock:
        if _lib is None:
            path = _build.build()
            loaded = ctypes.CDLL(str(path))
            loaded.rk_source_hash.restype = ctypes.c_char_p
            built = loaded.rk_source_hash().decode()
            if built != _build.source_hash():
                raise RuntimeError(f"{path.name} was built from other sources ({built})")
            _declare(loaded)
            _lib = loaded
    return _lib


def _declare(L):
    L.rk_field_new.restype = _ptr
    L.rk_field_new.argtypes = [_i64, _f64, _f64, _f64, _f64]
    L.rk_field_free.argtypes = [_ptr]
    L.rk_field_eval.argtypes = [_ptr, _i64, _f64, _f64]
    _d = ctypes.c_double
    L.rk_field_set_sizing.argtypes = [_ptr, _i64, _f64, _d, _d, _d, _d]
    L.rk_field_sizing.argtypes = [_ptr, _i64, _f64, _f64]
    L.rk_crease_rebuild.restype = _ptr
    L.rk_crease_rebuild.argtypes = [_ptr, _i64, _f64, _i64, _i64p, _i32p, ctypes.c_uint64, _f64]
    L.rk_crease_result_sizes.argtypes = [_ptr, _i64p]
    L.rk_crease_result_copy.argtypes = [_ptr, _f64, _i32p, _i64p, _i64p]
    L.rk_crease_result_free.argtypes = [_ptr]
    L.rk_bvh_new.restype = _ptr
    L.rk_bvh_new.argtypes = [_i64, _f64, _i64, _i32p]
    L.rk_bvh_free.argtypes = [_ptr]
    L.rk_seen_faces.argtypes = [_ptr, _i64, _f64, _f64, _i64p, _i32p, _i64, _f64, _u8p, _d, _d, _u8p]
    _f32p = np.ctypeslib.ndpointer(dtype=np.float32, flags="C_CONTIGUOUS")
    L.rk_detail_bake.restype = _i64
    L.rk_detail_bake.argtypes = [_i64, _i32p, _i32p, _f64, _f64, _u8p, _f64, _f64, _f64, _f64, _f64, _i32p, _i64,
                                 _i32p, _f64,
                                 _i64, _f64, _i64, _i32p, _i64, _i64p, _f64, _f64, _d, _d, _f32p, _i64p]
    L.rk_pack_islands.restype = _d
    L.rk_pack_islands.argtypes = [_i64, _f64, _i32p, _i64, _i32p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_int32,
                                  _d, _d, ctypes.c_int32, _f64]


def _points(points):
    return np.ascontiguousarray(np.asarray(points, dtype=np.float64).reshape(-1, 3))


class BowField:
    """formations/curve.py's bow field, built once per rock: `eval` gives
    each point's offset, `sizing` the triangle size there (the longest edge
    the field bends by under `tolerance` in its middle, measured by its
    second difference over `step` along `ways`, clamped to `size`)."""

    def __init__(self, a, b, bow, reach, ways, step, tolerance, size):
        a, b, bow = _points(a), _points(b), _points(bow)
        reach = np.ascontiguousarray(reach, dtype=np.float64).ravel()
        self._lib = lib()
        self._handle = self._lib.rk_field_new(len(reach), a, b, bow, reach)
        w = _points(ways)
        self._lib.rk_field_set_sizing(self._handle, len(w), w, float(step), float(tolerance),
                                      float(size[0]), float(size[1]))
        self.count = len(reach)

    def __del__(self):
        if getattr(self, "_handle", None):
            self._lib.rk_field_free(self._handle)
            self._handle = None

    def eval(self, points):
        p = _points(points)
        out = np.empty_like(p)
        self._lib.rk_field_eval(self._handle, len(p), p, out)
        return out

    def sizing(self, points):
        p = _points(points)
        out = np.empty(len(p))
        self._lib.rk_field_sizing(self._handle, len(p), p, out)
        return out


def crease_rebuild(field, co, face_start, corner_verts, seed, params):
    """formations/curve.py `rebuild` on a mesh as arrays: `co` (V x 3),
    `face_start` (F + 1 offsets into `corner_verts`). `params` in the order
    crease.cpp reads them. Returns (co, triangles (T x 3), each triangle's
    source face, each vertex's source vertex or -1, (patches rebuilt,
    patches kept, slivers folded))."""
    L = lib()
    co = _points(co)
    face_start = np.ascontiguousarray(face_start, dtype=np.int64)
    corner_verts = np.ascontiguousarray(corner_verts, dtype=np.int32)
    params = np.ascontiguousarray(params, dtype=np.float64)
    r = L.rk_crease_rebuild(field._handle, len(co), co, len(face_start) - 1, face_start, corner_verts,
                            ctypes.c_uint64(seed & 0xFFFFFFFFFFFFFFFF), params)
    try:
        sizes = np.zeros(6, dtype=np.int64)
        L.rk_crease_result_sizes(r, sizes)
        nv, nt = int(sizes[0]), int(sizes[1])
        out_co = np.empty((nv, 3))
        tris = np.empty((nt, 3), dtype=np.int32)
        face_src = np.empty(nt, dtype=np.int64)
        vert_src = np.empty(nv, dtype=np.int64)
        L.rk_crease_result_copy(r, out_co, tris, face_src, vert_src)
    finally:
        L.rk_crease_result_free(r)
    return out_co, tris, face_src, vert_src, tuple(int(x) for x in sizes[2:5])


class Bvh:
    """A BVH over triangles (`co` V x 3, `tris` T x 3) for ray tests."""

    def __init__(self, co, tris):
        co = _points(co)
        tris = np.ascontiguousarray(tris, dtype=np.int32).reshape(-1, 3)
        self._lib = lib()
        self._handle = self._lib.rk_bvh_new(len(co), co, len(tris), tris)

    def __del__(self):
        if getattr(self, "_handle", None):
            self._lib.rk_bvh_free(self._handle)
            self._handle = None


def seen_faces(bvh, centre, normal, face_start, corner_verts, dirs, facing, reach, lift):
    """scene_export.py `seen_faces`' ray test on every thread: whether a ray
    from one of each face's samples leaves the object along one of the
    directions it faces. `bvh` is built over the same vertices the corners
    index."""
    centre, normal, dirs = _points(centre), _points(normal), _points(dirs)
    face_start = np.ascontiguousarray(face_start, dtype=np.int64)
    corner_verts = np.ascontiguousarray(corner_verts, dtype=np.int32)
    facing = np.ascontiguousarray(facing, dtype=np.uint8)
    seen = np.zeros(len(centre), dtype=np.uint8)
    bvh._lib.rk_seen_faces(bvh._handle, len(centre), centre, normal, face_start, corner_verts, len(dirs), dirs,
                           facing, float(reach), float(lift), seen)
    return seen.astype(bool)


def pack_islands(uv, corner_vert, tris, side, gap, rotate=True, shares=(0.5, 0.9), steps=8):
    """Pack the UV islands of one map (pack.cpp) on the calling thread: the
    corners' `uv` (C x 2, any scale) and welded vertices, the triangles as
    corner indices (T x 3), into a square of `side` texels at least `gap`
    texels apart, turned by quarter turns if `rotate`; the scale bisected
    `steps` times between the islands covering `shares` of the square.
    Returns (each corner's UV in [0, 1], the share covered); the share is -1
    if they fit at no scale."""
    uv = np.ascontiguousarray(uv, dtype=np.float64).reshape(-1, 2)
    corner_vert = np.ascontiguousarray(corner_vert, dtype=np.int32)
    tris = np.ascontiguousarray(tris, dtype=np.int32).reshape(-1, 3)
    out = np.empty_like(uv)
    share = lib().rk_pack_islands(len(uv), uv, corner_vert, len(tris), tris, int(side), int(gap), int(rotate),
                                  float(shares[0]), float(shares[1]), int(steps), out)
    return out, share


def detail_bake(low, high, cutters, sides, cage, ray_distance):
    """The detail normal maps (detail_bake.cpp), one RGBA float array
    (side x side x 4, rows from the bottom) a map; the flat normal where no
    ray met the high poly, as Blender's bake writes it.

    `low` (object space): dict of tri_loops (T x 3), loop_vert, co (V x 3),
    vert_normal (V x 3), tri_smooth and tri_normal (T, T x 3: each
    triangle's face's), loop_normal, loop_tangent (L x 3), loop_sign (L),
    loop_uv (L x 2), tri_map (T), matrix (4 x 4 world). `high` (world): (co, tris) of the
    crumpled rock. `cutters` (world): a list of (planes (P x 4, n.x <= c
    inside), box (lo, hi)) for each convex cutter. Returns (maps, texels)."""
    L = lib()
    f64 = lambda a, *shape: np.ascontiguousarray(a, dtype=np.float64).reshape(*shape)  # noqa: E731
    i32 = lambda a, *shape: np.ascontiguousarray(a, dtype=np.int32).reshape(*shape)  # noqa: E731
    sides = np.ascontiguousarray(sides, dtype=np.int32)
    sizes = 4 * sides.astype(np.int64) ** 2
    offset = np.ascontiguousarray(np.concatenate([[0], np.cumsum(sizes)[:-1]]), dtype=np.int64)
    out = np.empty(int(sizes.sum()), dtype=np.float32)
    planes = f64(np.concatenate([p for p, _ in cutters]) if cutters else np.zeros((0, 4)), -1, 4)
    starts = np.ascontiguousarray(np.concatenate([[0], np.cumsum([len(p) for p, _ in cutters])]), dtype=np.int64)
    boxes = f64([[*lo, *hi] for _, (lo, hi) in cutters] if cutters else np.zeros((0, 6)), -1, 6)
    tri_loops = i32(low["tri_loops"], -1, 3)
    texels = L.rk_detail_bake(len(tri_loops), tri_loops, i32(low["loop_vert"], -1), f64(low["co"], -1, 3),
                              f64(low["vert_normal"], -1, 3),
                              np.ascontiguousarray(low["tri_smooth"], dtype=np.uint8).reshape(-1),
                              f64(low["tri_normal"], -1, 3),
                              f64(low["loop_normal"], -1, 3), f64(low["loop_tangent"], -1, 3),
                              f64(low["loop_sign"], -1), f64(low["loop_uv"], -1, 2), i32(low["tri_map"], -1),
                              len(sides), sides, f64(low["matrix"], 4, 4), len(high[0]), f64(high[0], -1, 3),
                              len(high[1]), i32(high[1], -1, 3), len(cutters), starts, planes, boxes,
                              float(cage), float(ray_distance), out, offset)
    maps = [out[o:o + s].reshape(side, side, 4) for o, s, side in zip(offset, sizes, sides)]
    return maps, int(texels)
