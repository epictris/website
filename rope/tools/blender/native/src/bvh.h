// A bounding volume hierarchy over triangles (binned SAH), for any-hit ray
// tests on every thread.
#pragma once

#include <cstdint>
#include <vector>

#include "geom.h"

namespace rk {

struct Bvh {
    struct Node {
        double lo[3], hi[3];
        int32_t left;   // inner: the first child (the second is left + 1); leaf: -1
        int32_t first;  // leaf: the first triangle in `order`
        int32_t count;  // leaf: how many
    };
    std::vector<V3> co;
    std::vector<int32_t> tris;   // 3 a triangle
    std::vector<int32_t> order;  // triangles in leaf order
    std::vector<Node> nodes;

    Bvh(int64_t nverts, const double* co, int64_t ntris, const int32_t* tris);
    // Whether the ray from `o` along `d` hits any triangle at t > 0.
    bool occluded(const V3& o, const V3& d) const;
    // Every triangle the ray from `o` along `d` (unit) hits at 0 < t <= tmax,
    // as (t, triangle), in no order.
    void hits(const V3& o, const V3& d, double tmax, std::vector<std::pair<double, int32_t>>& out) const;
    // A triangle's normal by its winding (unit).
    V3 normal(int32_t t) const {
        const V3& a = co[tris[3 * t]];
        return (co[tris[3 * t + 1]] - a).cross(co[tris[3 * t + 2]] - a).normalized();
    }
};

}  // namespace rk
