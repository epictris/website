// The native kernels' C interface (tools/blender/native/__init__.py binds it
// through ctypes). Arrays are C-contiguous; points are rows of 3 doubles.
#pragma once

#include <cstdint>

extern "C" {

// The build's source hash, compiled in by build.py: the loader refuses a
// library built from other sources.
const char* rk_source_hash();

// cells.cpp: feasible intersections of every three normalized planes.
// out holds at most count*(count-1)*(count-2)/6 points.
int64_t rk_cell_corners(int64_t count, const double* planes, double* out);
int32_t rk_cell_meets_surface(const void* bvh, int64_t count, const double* planes,
                             const double* lo, const double* hi);

// bows.cpp: the crease bow field (formations/curve.py).
void* rk_field_new(int64_t n, const double* a, const double* b, const double* bow, const double* reach);
void rk_field_free(void* field);
void rk_field_eval(const void* field, int64_t count, const double* points, double* out);
void rk_field_set_sizing(void* field, int64_t nways, const double* ways, double step, double tolerance,
                         double size_lo, double size_hi);
void rk_field_sizing(const void* field, int64_t count, const double* points, double* out);
void rk_field_set_depth_budget(void* field, const double* budget);

// crease.cpp: formations/curve.py `rebuild` on arrays.
void* rk_crease_rebuild(const void* field, int64_t nverts, const double* co, int64_t nfaces, const int64_t* face_start,
                        const int32_t* corner_verts, uint64_t seed, const double* params);
int64_t rk_crease_result_sizes(const void* result, int64_t* out);
void rk_crease_result_copy(const void* result, double* co, int32_t* tris, int64_t* face_src, int64_t* vert_src);
void rk_crease_result_free(void* result);

// bvh.cpp: a triangle BVH, and scene_export.py `seen_faces` on it.
void* rk_bvh_new(int64_t nverts, const double* co, int64_t ntris, const int32_t* tris);
void rk_bvh_free(void* bvh);
void rk_seen_faces(const void* bvh, int64_t nfaces, const double* centre, const double* normal,
                   const int64_t* face_start, const int32_t* corner_verts, int64_t ndirs, const double* dirs,
                   const uint8_t* facing, double reach, double lift, uint8_t* seen);

// detail_bake.cpp: the detail normal bake straight from the high poly.
int64_t rk_detail_bake(int64_t ntris, const int32_t* tri_loops, const int32_t* loop_vert, const double* co,
                       const double* vert_normal, const uint8_t* tri_smooth, const double* tri_normal,
                       const double* loop_normal, const double* loop_tangent, const double* loop_sign,
                       const double* loop_uv, const int32_t* tri_map, int64_t nmaps, const int32_t* map_side,
                       const double* matrix, int64_t hverts, const double* hco, int64_t htris, const int32_t* htri,
                       int64_t ncut, const int64_t* cut_start, const double* planes, const double* cut_box,
                       double cage, double ray_distance, float* out, const int64_t* out_offset);

// pack.cpp: UV islands packed into one square map.
double rk_pack_islands(int64_t ncorners, const double* uv, const int32_t* corner_vert, int64_t ntris,
                       const int32_t* tri_corners, uint32_t side, uint32_t gap, int32_t rotate, double lo_share,
                       double hi_share, int32_t steps, double* out);
}
