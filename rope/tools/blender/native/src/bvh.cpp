// The triangle BVH (bvh.h) and the export's visibility test on it
// (scene_export.py `seen_faces`): which faces the game camera can see, by
// rays from each face toward it that leave the object without hitting it
// again. The Python test cast them one at a time through mathutils, 617 M
// calls and 1,216 s of a 3 h river export (2026-11-13).

#include "bvh.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <numeric>

#include "kernels.h"

namespace rk {
namespace {

constexpr int BINS = 16;
constexpr int LEAF = 4;
// Past this depth a node is halved, so no tree runs deeper than this plus
// log2 of its triangles (under 128 for 2^31), and the traversal's stack
// (STACK) holds every path.
constexpr int MAX_SAH_DEPTH = 96;
constexpr int STACK = 256;

struct Box {
    double lo[3] = {INFINITY, INFINITY, INFINITY}, hi[3] = {-INFINITY, -INFINITY, -INFINITY};
    void grow(const double* p) {
        for (int k = 0; k < 3; ++k) lo[k] = std::min(lo[k], p[k]), hi[k] = std::max(hi[k], p[k]);
    }
    void grow(const Box& b) {
        for (int k = 0; k < 3; ++k) lo[k] = std::min(lo[k], b.lo[k]), hi[k] = std::max(hi[k], b.hi[k]);
    }
    double area() const {
        double d[3];
        for (int k = 0; k < 3; ++k) d[k] = std::max(0.0, hi[k] - lo[k]);
        return 2 * (d[0] * d[1] + d[1] * d[2] + d[2] * d[0]);
    }
};

}  // namespace

Bvh::Bvh(int64_t nverts, const double* c, int64_t ntris, const int32_t* t) {
    co.resize(nverts);
    for (int64_t i = 0; i < nverts; ++i) co[i] = V3(&c[3 * i]);
    tris.assign(t, t + 3 * ntris);
    order.resize(ntris);
    std::iota(order.begin(), order.end(), 0);
    if (!ntris) return;
    std::vector<Box> box(ntris);
    std::vector<V3> centre(ntris);
    for (int64_t i = 0; i < ntris; ++i) {
        for (int k = 0; k < 3; ++k) box[i].grow(co[tris[3 * i + k]].data());
        centre[i] = V3((box[i].lo[0] + box[i].hi[0]) / 2, (box[i].lo[1] + box[i].hi[1]) / 2,
                       (box[i].lo[2] + box[i].hi[2]) / 2);
    }
    nodes.reserve(2 * ntris / LEAF + 1);
    nodes.push_back({});
    struct Job {
        int32_t node, first, count, depth;
    };
    std::vector<Job> stack = {{0, 0, (int32_t)ntris, 0}};
    while (!stack.empty()) {
        Job j = stack.back();
        stack.pop_back();
        Box b, cb;
        for (int32_t i = j.first; i < j.first + j.count; ++i) {
            b.grow(box[order[i]]);
            cb.grow(centre[order[i]].data());
        }
        Node& n = nodes[j.node];
        std::memcpy(n.lo, b.lo, sizeof n.lo);
        std::memcpy(n.hi, b.hi, sizeof n.hi);
        n.left = -1, n.first = j.first, n.count = j.count;
        if (j.count <= LEAF) continue;
        // The cheapest split of the centres' box into BINS along any axis.
        double best = INFINITY;
        int axis = -1, cut = 0;
        for (int k = 0; k < 3; ++k) {
            double ext = cb.hi[k] - cb.lo[k];
            if (ext <= 0) continue;
            Box bins[BINS];
            int32_t counts[BINS] = {0};
            for (int32_t i = j.first; i < j.first + j.count; ++i) {
                int bi = std::min(BINS - 1, (int)(BINS * (centre[order[i]].data()[k] - cb.lo[k]) / ext));
                bins[bi].grow(box[order[i]]);
                ++counts[bi];
            }
            double right_area[BINS];
            int32_t right_count[BINS];
            Box acc;
            int32_t cnt = 0;
            for (int i = BINS - 1; i > 0; --i) {
                acc.grow(bins[i]);
                cnt += counts[i];
                right_area[i] = acc.area();
                right_count[i] = cnt;
            }
            acc = Box();
            cnt = 0;
            for (int i = 0; i < BINS - 1; ++i) {
                acc.grow(bins[i]);
                cnt += counts[i];
                if (!cnt || !right_count[i + 1]) continue;
                double cost = acc.area() * cnt + right_area[i + 1] * right_count[i + 1];
                if (cost < best) best = cost, axis = k, cut = i + 1;
            }
        }
        int32_t mid;
        if (axis < 0 || j.depth >= MAX_SAH_DEPTH) {
            // Every centre in one place, or deep enough that the traversal's
            // stack must be kept in reach: halved.
            mid = j.first + j.count / 2;
        } else {
            double ext = cb.hi[axis] - cb.lo[axis];
            auto it = std::partition(order.begin() + j.first, order.begin() + j.first + j.count, [&](int32_t i) {
                int bi = std::min(BINS - 1, (int)(BINS * (centre[i].data()[axis] - cb.lo[axis]) / ext));
                return bi < cut;
            });
            mid = (int32_t)(it - order.begin());
        }
        int32_t left = (int32_t)nodes.size();
        nodes.push_back({});
        nodes.push_back({});
        nodes[j.node].left = left;
        stack.push_back({left, j.first, mid - j.first, j.depth + 1});
        stack.push_back({left + 1, mid, j.first + j.count - mid, j.depth + 1});
    }
}

bool Bvh::occluded(const V3& o, const V3& d) const {
    if (nodes.empty()) return false;
    double inv[3] = {1.0 / d.x, 1.0 / d.y, 1.0 / d.z};
    const double* od = o.data();
    int32_t stack[STACK];
    int sp = 0;
    stack[sp++] = 0;
    while (sp) {
        const Node& n = nodes[stack[--sp]];
        double t0 = 0, t1 = INFINITY;
        for (int k = 0; k < 3; ++k) {
            double a = (n.lo[k] - od[k]) * inv[k], b = (n.hi[k] - od[k]) * inv[k];
            if (a > b) std::swap(a, b);
            t0 = std::max(t0, a);
            t1 = std::min(t1, b);
        }
        if (t0 > t1) continue;
        if (n.left >= 0) {
            stack[sp++] = n.left;
            stack[sp++] = n.left + 1;
            continue;
        }
        for (int32_t i = n.first; i < n.first + n.count; ++i) {
            int32_t t = order[i];
            // Moller-Trumbore.
            const V3& a = co[tris[3 * t]];
            V3 e1 = co[tris[3 * t + 1]] - a, e2 = co[tris[3 * t + 2]] - a;
            V3 p = d.cross(e2);
            double det = e1.dot(p);
            if (det == 0) continue;
            double id = 1.0 / det;
            V3 s = o - a;
            double u = s.dot(p) * id;
            if (u < 0 || u > 1) continue;
            V3 q = s.cross(e1);
            double v = d.dot(q) * id;
            if (v < 0 || u + v > 1) continue;
            if (e2.dot(q) * id > 0) return true;
        }
    }
    return false;
}

void Bvh::hits(const V3& o, const V3& d, double tmax, std::vector<std::pair<double, int32_t>>& out) const {
    out.clear();
    if (nodes.empty()) return;
    double inv[3] = {1.0 / d.x, 1.0 / d.y, 1.0 / d.z};
    const double* od = o.data();
    int32_t stack[STACK];
    int sp = 0;
    stack[sp++] = 0;
    while (sp) {
        const Node& n = nodes[stack[--sp]];
        double t0 = 0, t1 = tmax;
        for (int k = 0; k < 3; ++k) {
            double a = (n.lo[k] - od[k]) * inv[k], b = (n.hi[k] - od[k]) * inv[k];
            if (a > b) std::swap(a, b);
            t0 = std::max(t0, a);
            t1 = std::min(t1, b);
        }
        if (t0 > t1) continue;
        if (n.left >= 0) {
            stack[sp++] = n.left;
            stack[sp++] = n.left + 1;
            continue;
        }
        for (int32_t i = n.first; i < n.first + n.count; ++i) {
            int32_t t = order[i];
            const V3& a = co[tris[3 * t]];
            V3 e1 = co[tris[3 * t + 1]] - a, e2 = co[tris[3 * t + 2]] - a;
            V3 p = d.cross(e2);
            double det = e1.dot(p);
            if (det == 0) continue;
            double id = 1.0 / det;
            V3 s = o - a;
            double u = s.dot(p) * id;
            if (u < 0 || u > 1) continue;
            V3 q = s.cross(e1);
            double v = d.dot(q) * id;
            if (v < 0 || u + v > 1) continue;
            double tt = e2.dot(q) * id;
            if (tt > 0 && tt <= tmax) out.emplace_back(tt, t);
        }
    }
}

}  // namespace rk

using rk::Bvh;
using rk::V3;

extern "C" {

void* rk_bvh_new(int64_t nverts, const double* co, int64_t ntris, const int32_t* tris) {
    return new Bvh(nverts, co, ntris, tris);
}

void rk_bvh_free(void* bvh) { delete static_cast<Bvh*>(bvh); }

// scene_export.py seen_faces: a face is seen when a ray from one of its
// samples (its centre, and its corners pulled `reach` of the way out from
// it), lifted `lift` off it along its normal, leaves the object along one of
// the directions it faces (`facing`, F x D) without hitting it.
void rk_seen_faces(const void* handle, int64_t nfaces, const double* centre, const double* normal,
                   const int64_t* face_start, const int32_t* corner_verts, int64_t ndirs, const double* dirs,
                   const uint8_t* facing, double reach, double lift, uint8_t* seen) {
    const Bvh& bvh = *static_cast<const Bvh*>(handle);
#pragma omp parallel for schedule(dynamic, 64)
    for (int64_t f = 0; f < nfaces; ++f) {
        seen[f] = 0;
        const uint8_t* ways = &facing[f * ndirs];
        bool any = false;
        for (int64_t j = 0; j < ndirs; ++j) any |= ways[j] != 0;
        if (!any) continue;
        V3 c(&centre[3 * f]), up = V3(&normal[3 * f]) * lift;
        for (int64_t s = -1; s < face_start[f + 1] - face_start[f] && !seen[f]; ++s) {
            V3 p = s < 0 ? c : c + (bvh.co[corner_verts[face_start[f] + s]] - c) * reach;
            p += up;
            for (int64_t j = 0; j < ndirs; ++j)
                if (ways[j] && !bvh.occluded(p, V3(&dirs[3 * j]))) {
                    seen[f] = 1;
                    break;
                }
        }
    }
}

}  // extern "C"
