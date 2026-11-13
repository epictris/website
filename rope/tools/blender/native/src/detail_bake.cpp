// The detail normal bake (scene_export.py `bake_detail_normals`) without a
// boolean or Cycles: each texel's normal straight from the detail high poly
// (formations/detail.py), which is the crumpled rock minus the chip cutters.
//
// Blender's selected-to-active bake is reproduced step for step
// (render_bake.cc and bake.cc, Blender 5.2): each texel's point on the low
// poly, extruded `cage` along its interpolated normal, casts a ray back along
// it; the nearest surface of the high poly within `ray_distance` is the hit,
// its flat normal turned to face the ray (Cycles shades a back face so); and
// that normal goes into the low poly's tangent space from the interpolated
// corner normals and MikkTSpace tangents, as Blender converts it. The high
// poly's surface along a ray is found as solid geometry: the intervals inside
// the crumpled rock minus each cutter's (a convex piece, one interval), so
// the boolean is never built. Before this, the boolean took 427 s and the 31
// detail bakes most of 571 s of a 3 h river export (2026-11-13).
//
// Texels are filled a row tile at a time, every tile's triangles in index
// order (a later triangle wins a texel two share, as Blender's rasteriser
// does), so the maps are the same at any thread count.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <vector>

#include "bvh.h"
#include "geom.h"
#include "kernels.h"

namespace rk {
namespace {

struct Cutter {
    int64_t first, last;  // its planes
    double lo[3], hi[3];
};

struct Surface {
    int kind = 0;  // 0 none, 1 a high poly triangle, 2 a cutter plane
    int64_t index = -1;
};

struct Span {
    double a, b;
    Surface sa, sb;
};

// The cutters near a ray: a grid over their boxes.
struct CutterGrid {
    std::vector<Cutter> cutters;
    double origin[3] = {0, 0, 0}, cell = 1;
    int64_t dims[3] = {1, 1, 1};
    std::vector<int64_t> start;
    std::vector<int32_t> items;

    void build() {
        if (cutters.empty()) return;
        double gl[3] = {INFINITY, INFINITY, INFINITY}, gh[3] = {-INFINITY, -INFINITY, -INFINITY};
        std::vector<double> ext;
        for (const Cutter& c : cutters) {
            double big = 0;
            for (int k = 0; k < 3; ++k) {
                gl[k] = std::min(gl[k], c.lo[k]), gh[k] = std::max(gh[k], c.hi[k]);
                big = std::max(big, c.hi[k] - c.lo[k]);
            }
            ext.push_back(big);
        }
        std::nth_element(ext.begin(), ext.begin() + ext.size() / 2, ext.end());
        cell = std::max(ext[ext.size() / 2], 1e-3);
        double volume = (gh[0] - gl[0]) * (gh[1] - gl[1]) * (gh[2] - gl[2]);
        cell = std::max(cell, std::cbrt(volume / (double)(1 << 22)));
        for (int k = 0; k < 3; ++k) {
            origin[k] = gl[k];
            dims[k] = std::max<int64_t>(1, (int64_t)std::ceil((gh[k] - gl[k]) / cell));
        }
        int64_t cells = dims[0] * dims[1] * dims[2];
        start.assign(cells + 1, 0);
        auto each = [&](const double* lo, const double* hi, auto&& fn) {
            int64_t l[3], h[3];
            for (int k = 0; k < 3; ++k) {
                l[k] = clampi(lo[k], k);
                h[k] = clampi(hi[k], k);
            }
            for (int64_t z = l[2]; z <= h[2]; ++z)
                for (int64_t y = l[1]; y <= h[1]; ++y)
                    for (int64_t x = l[0]; x <= h[0]; ++x) fn((z * dims[1] + y) * dims[0] + x);
        };
        for (const Cutter& c : cutters) each(c.lo, c.hi, [&](int64_t id) { ++start[id + 1]; });
        for (int64_t c = 0; c < cells; ++c) start[c + 1] += start[c];
        items.resize(start[cells]);
        std::vector<int64_t> fill(start.begin(), start.end() - 1);
        for (int32_t i = 0; i < (int32_t)cutters.size(); ++i)
            each(cutters[i].lo, cutters[i].hi, [&](int64_t id) { items[fill[id]++] = i; });
    }
    int64_t clampi(double x, int k) const {
        int64_t i = (int64_t)std::floor((x - origin[k]) / cell);
        return std::min<int64_t>(dims[k] - 1, std::max<int64_t>(0, i));
    }
    // Every cutter whose cell the segment's box touches, each once, ascending.
    void near(const V3& a, const V3& b, std::vector<int32_t>& out) const {
        out.clear();
        if (cutters.empty()) return;
        double lo[3] = {std::min(a.x, b.x), std::min(a.y, b.y), std::min(a.z, b.z)};
        double hi[3] = {std::max(a.x, b.x), std::max(a.y, b.y), std::max(a.z, b.z)};
        int64_t l[3], h[3];
        for (int k = 0; k < 3; ++k) {
            if (hi[k] < origin[k] || lo[k] > origin[k] + dims[k] * cell) return;
            l[k] = clampi(lo[k], k);
            h[k] = clampi(hi[k], k);
        }
        for (int64_t z = l[2]; z <= h[2]; ++z)
            for (int64_t y = l[1]; y <= h[1]; ++y)
                for (int64_t x = l[0]; x <= h[0]; ++x) {
                    int64_t id = (z * dims[1] + y) * dims[0] + x;
                    for (int64_t s = start[id]; s < start[id + 1]; ++s) out.push_back(items[s]);
                }
        std::sort(out.begin(), out.end());
        out.erase(std::unique(out.begin(), out.end()), out.end());
    }
};

struct Low {
    const double* co;
    const int32_t* tri_loops;
    const int32_t* loop_vert;
    const double* loop_normal;
    const double* loop_tangent;
    const double* loop_sign;
    const double* loop_uv;
    double m[3][3], t[3];  // world = m p + t
    double nm[3][3];       // normals to the world: the inverse transpose of m
};

}  // namespace
}  // namespace rk

using namespace rk;

extern "C" {

// Bake the detail normals of a low poly (object space: `co`, triangles as
// corner indices `tri_loops`, each corner's vertex, normal, MikkTSpace tangent
// and sign, and UV; each triangle's map `tri_map`; `matrix` its 4 x 4 world
// matrix, row major) from the high poly (world space: the crumpled rock's
// triangles `hco`/`htri`, and the cutters as planes (nx, ny, nz, c) with
// n.x <= c inside, cutter i being planes [cut_start[i], cut_start[i + 1]) in
// the box `cut_box[i]` (lo xyz, hi xyz)). Writes each map's RGBA
// floats into `out` at `out_offset[map]` and returns the texels whose ray met
// the high poly. Every other texel, in an island or not, is the flat normal
// (0.5, 0.5, 1) at alpha 1, as Blender writes a texel with no hit. A smooth
// triangle (`tri_smooth`) casts along its interpolated vertex normals
// (`vert_normal`) and turns the hit's normal by its corner normals; a flat
// one uses its own normal (`tri_normal`) for both.
int64_t rk_detail_bake(int64_t ntris, const int32_t* tri_loops, const int32_t* loop_vert, const double* co,
                       const double* vert_normal, const uint8_t* tri_smooth, const double* tri_normal,
                       const double* loop_normal, const double* loop_tangent, const double* loop_sign,
                       const double* loop_uv, const int32_t* tri_map, int64_t nmaps, const int32_t* map_side,
                       const double* matrix, int64_t hverts, const double* hco, int64_t htris, const int32_t* htri,
                       int64_t ncut, const int64_t* cut_start, const double* planes, const double* cut_box,
                       double cage, double ray_distance, float* out, const int64_t* out_offset) {
    Low L{co, tri_loops, loop_vert, loop_normal, loop_tangent, loop_sign, loop_uv, {}, {}, {}};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) L.m[i][j] = matrix[4 * i + j];
        L.t[i] = matrix[4 * i + 3];
    }
    {
        // Inverse transpose of m by cofactors.
        const double(&a)[3][3] = L.m;
        double c[3][3] = {{a[1][1] * a[2][2] - a[1][2] * a[2][1], a[1][2] * a[2][0] - a[1][0] * a[2][2],
                           a[1][0] * a[2][1] - a[1][1] * a[2][0]},
                          {a[0][2] * a[2][1] - a[0][1] * a[2][2], a[0][0] * a[2][2] - a[0][2] * a[2][0],
                           a[0][1] * a[2][0] - a[0][0] * a[2][1]},
                          {a[0][1] * a[1][2] - a[0][2] * a[1][1], a[0][2] * a[1][0] - a[0][0] * a[1][2],
                           a[0][0] * a[1][1] - a[0][1] * a[1][0]}};
        double det = a[0][0] * c[0][0] + a[0][1] * c[0][1] + a[0][2] * c[0][2];
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j) L.nm[i][j] = c[i][j] / det;
    }
    auto world = [&](const V3& p) {
        return V3(L.m[0][0] * p.x + L.m[0][1] * p.y + L.m[0][2] * p.z + L.t[0],
                  L.m[1][0] * p.x + L.m[1][1] * p.y + L.m[1][2] * p.z + L.t[1],
                  L.m[2][0] * p.x + L.m[2][1] * p.y + L.m[2][2] * p.z + L.t[2]);
    };
    auto world_dir = [&](const V3& n) {
        return V3(L.nm[0][0] * n.x + L.nm[0][1] * n.y + L.nm[0][2] * n.z,
                  L.nm[1][0] * n.x + L.nm[1][1] * n.y + L.nm[1][2] * n.z,
                  L.nm[2][0] * n.x + L.nm[2][1] * n.y + L.nm[2][2] * n.z);
    };
    // World to object for a normal as Blender's bake does it: the transpose
    // of the matrix (mul_transposed_mat3_m4_v3).
    auto to_object = [&](const V3& n) {
        return V3(L.m[0][0] * n.x + L.m[1][0] * n.y + L.m[2][0] * n.z,
                  L.m[0][1] * n.x + L.m[1][1] * n.y + L.m[2][1] * n.z,
                  L.m[0][2] * n.x + L.m[1][2] * n.y + L.m[2][2] * n.z);
    };

    Bvh high(hverts, hco, htris, htri);
    CutterGrid grid;
    for (int64_t i = 0; i < ncut; ++i) {
        Cutter c{cut_start[i], cut_start[i + 1], {}, {}};
        for (int k = 0; k < 3; ++k) c.lo[k] = cut_box[6 * i + k], c.hi[k] = cut_box[6 * i + 3 + k];
        grid.cutters.push_back(c);
    }
    grid.build();

    // Tiles of 16 rows in every map, each with the triangles reaching it.
    constexpr int32_t TILE = 16;
    struct Tile {
        int64_t map;
        int32_t y0, y1;
        std::vector<int32_t> tris;
    };
    std::vector<Tile> tiles;
    std::vector<int64_t> first_tile(nmaps + 1, 0);
    for (int64_t k = 0; k < nmaps; ++k) {
        first_tile[k] = (int64_t)tiles.size();
        for (int32_t y = 0; y < map_side[k]; y += TILE) tiles.push_back({k, y, std::min(map_side[k], y + TILE), {}});
    }
    first_tile[nmaps] = (int64_t)tiles.size();
    for (int32_t t = 0; t < (int32_t)ntris; ++t) {
        int64_t k = tri_map[t];
        if (k < 0 || k >= nmaps) continue;
        double ly = INFINITY, hy = -INFINITY;
        for (int c = 0; c < 3; ++c) {
            double v = loop_uv[2 * tri_loops[3 * t + c] + 1] * map_side[k];
            ly = std::min(ly, v), hy = std::max(hy, v);
        }
        int32_t a = std::max(0, (int32_t)std::floor(ly - 0.5)), b = std::min(map_side[k] - 1, (int32_t)std::ceil(hy));
        for (int32_t tile = a / TILE; tile <= b / TILE; ++tile) tiles[first_tile[k] + tile].tris.push_back(t);
    }
    for (int64_t k = 0; k < nmaps; ++k) {
        float* img = out + out_offset[k];
        for (size_t i = 0; i < (size_t)map_side[k] * map_side[k]; ++i)
            img[4 * i] = 0.5f, img[4 * i + 1] = 0.5f, img[4 * i + 2] = 1.0f, img[4 * i + 3] = 1.0f;
    }

    int64_t baked = 0;
#pragma omp parallel for schedule(dynamic, 1) reduction(+ : baked)
    for (int64_t ti = 0; ti < (int64_t)tiles.size(); ++ti) {
        const Tile& tile = tiles[ti];
        int32_t side = map_side[tile.map];
        float* img = out + out_offset[tile.map];
        std::vector<std::pair<double, int32_t>> hits;
        std::vector<int32_t> nearby;
        std::vector<Span> solid, cuts, kept;
        for (int32_t t : tile.tris) {
            int32_t lp[3] = {tri_loops[3 * t], tri_loops[3 * t + 1], tri_loops[3 * t + 2]};
            V2 uv[3];
            for (int c = 0; c < 3; ++c) uv[c] = {loop_uv[2 * lp[c]] * side, loop_uv[2 * lp[c] + 1] * side};
            double area = (uv[1].x - uv[0].x) * (uv[2].y - uv[0].y) - (uv[1].y - uv[0].y) * (uv[2].x - uv[0].x);
            if (area == 0) continue;
            double lx = std::min({uv[0].x, uv[1].x, uv[2].x}), hx = std::max({uv[0].x, uv[1].x, uv[2].x});
            double ly = std::min({uv[0].y, uv[1].y, uv[2].y}), hy = std::max({uv[0].y, uv[1].y, uv[2].y});
            int32_t x0 = std::max(0, (int32_t)std::floor(lx - 0.5)), x1 = std::min(side - 1, (int32_t)std::ceil(hx));
            int32_t y0 = std::max(tile.y0, (int32_t)std::floor(ly - 0.5)), y1 = std::min(tile.y1 - 1, (int32_t)std::ceil(hy));
            V3 P[3], N[3], VN[3], T[3];
            double S[3];
            bool smooth = tri_smooth[t] != 0;
            V3 FN(&tri_normal[3 * t]);
            for (int c = 0; c < 3; ++c) {
                P[c] = V3(&co[3 * loop_vert[lp[c]]]);
                N[c] = V3(&loop_normal[3 * lp[c]]);
                VN[c] = V3(&vert_normal[3 * loop_vert[lp[c]]]);
                T[c] = V3(&loop_tangent[3 * lp[c]]);
                S[c] = loop_sign[lp[c]];
            }
            for (int32_t y = y0; y <= y1; ++y)
                for (int32_t x = x0; x <= x1; ++x) {
                    double px = x + 0.5, py = y + 0.5;
                    // Barycentric weights of the texel's centre.
                    double w0 = ((uv[1].x - px) * (uv[2].y - py) - (uv[1].y - py) * (uv[2].x - px)) / area;
                    double w1 = ((uv[2].x - px) * (uv[0].y - py) - (uv[2].y - py) * (uv[0].x - px)) / area;
                    double w2 = 1.0 - w0 - w1;
                    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                    V3 p = P[0] * w0 + P[1] * w1 + P[2] * w2;
                    V3 n = smooth ? N[0] * w0 + N[1] * w1 + N[2] * w2 : FN;
                    V3 tan = T[0] * w0 + T[1] * w1 + T[2] * w2;
                    double sign = S[0] * w0 + S[1] * w1 + S[2] * w2 < 0 ? -1.0 : 1.0;
                    // The ray: from the cage back along the vertex normals (not
                    // the corner normals: the cage is not split at sharp edges),
                    // in the world (calc_point_from_barycentric_extrusion).
                    V3 nn = smooth ? (VN[0] * w0 + VN[1] * w1 + VN[2] * w2).normalized() : FN.normalized();
                    V3 o = world(p + nn * cage);
                    V3 d = world_dir(nn * -1.0).normalized();
                    // Inside the crumpled rock along it, from every crossing
                    // to the far side: a plane crumple fitted across a fold
                    // stands up to 24 mm off the rock (Terrace.007, 2026-11-13),
                    // outside the cage, so a ray can start inside, and Blender's
                    // then meets the first surface past it (a chip's floor).
                    high.hits(o, d, std::numeric_limits<double>::infinity(), hits);
                    std::sort(hits.begin(), hits.end());
                    solid.clear();
                    bool in = !hits.empty() && high.normal(hits[0].second).dot(d) > 0;
                    Span cur{0, 0, {}, {}};
                    for (const auto& [ht, tri] : hits) {
                        bool enters = high.normal(tri).dot(d) < 0;
                        if (enters && !in) cur = {ht, 0, {1, tri}, {}}, in = true;
                        else if (!enters && in) cur.b = ht, cur.sb = {1, tri}, solid.push_back(cur), in = false;
                    }
                    if (in) cur.b = std::numeric_limits<double>::infinity(), solid.push_back(cur);
                    if (solid.empty()) continue;
                    // Each cutter's interval, sorted.
                    grid.near(o, o + d * ray_distance, nearby);
                    cuts.clear();
                    for (int32_t ci : nearby) {
                        const Cutter& c = grid.cutters[ci];
                        double tin = -INFINITY, tout = INFINITY;
                        int64_t pin = -1, pout = -1;
                        bool miss = false;
                        for (int64_t pl = c.first; pl < c.last && !miss; ++pl) {
                            V3 pn(&planes[4 * pl]);
                            double den = pn.dot(d), num = planes[4 * pl + 3] - pn.dot(o);
                            if (den == 0) {
                                miss = num < 0;
                                continue;
                            }
                            double tt = num / den;
                            if (den < 0) {
                                if (tt > tin) tin = tt, pin = pl;
                            } else if (tt < tout) {
                                tout = tt, pout = pl;
                            }
                        }
                        if (miss || tin >= tout || tout <= 0) continue;
                        cuts.push_back({tin, tout, {2, pin}, {2, pout}});
                    }
                    std::sort(cuts.begin(), cuts.end(), [](const Span& a, const Span& b) { return a.a < b.a; });
                    // The solid less the cutters; its first end past the start is the hit.
                    double hit = INFINITY;
                    Surface at;
                    for (const Span& s : solid) {
                        double cur_a = s.a;
                        Surface cur_s = s.sa;
                        bool done = false;
                        for (const Span& c : cuts) {
                            if (c.b <= cur_a) continue;
                            if (c.a >= s.b) break;
                            if (c.a > cur_a) {
                                // [cur_a, c.a] is solid.
                                double first = cur_a > 1e-12 ? cur_a : c.a;
                                Surface fs = cur_a > 1e-12 ? cur_s : c.sa;
                                hit = first, at = fs, done = true;
                                break;
                            }
                            cur_a = c.b, cur_s = c.sb;
                            if (cur_a >= s.b) break;
                        }
                        if (done) break;
                        if (cur_a < s.b) {
                            hit = cur_a > 1e-12 ? cur_a : s.b;
                            at = cur_a > 1e-12 ? cur_s : s.sb;
                            break;
                        }
                    }
                    if (!(hit <= ray_distance) || at.kind == 0) continue;
                    V3 hn = at.kind == 1 ? high.normal((int32_t)at.index) : V3(&planes[4 * at.index]).normalized();
                    if (hn.dot(d) > 0) hn = hn * -1.0;
                    // Into the low poly's tangent space (RE_bake_normal_world_to_tangent).
                    V3 bin = n.cross(tan) * sign;
                    V3 no = to_object(hn);
                    // Solve [tan bin n] c = no.
                    double det = tan.dot(bin.cross(n));
                    if (det == 0) continue;
                    V3 c3(no.dot(bin.cross(n)) / det, tan.dot(no.cross(n)) / det, tan.dot(bin.cross(no)) / det);
                    c3 = c3.normalized();
                    float* px4 = &img[4 * ((size_t)y * side + x)];
                    px4[0] = (float)(c3.x * 0.5 + 0.5);
                    px4[1] = (float)(c3.y * 0.5 + 0.5);
                    px4[2] = (float)(c3.z * 0.5 + 0.5);
                    px4[3] = 1.0f;
                    ++baked;
                }
        }
    }
    return baked;
}

}  // extern "C"
