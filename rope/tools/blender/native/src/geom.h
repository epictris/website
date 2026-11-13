// Small geometry helpers shared by the kernels.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

namespace rk {

struct V3 {
    double x = 0, y = 0, z = 0;
    V3() = default;
    V3(double x_, double y_, double z_) : x(x_), y(y_), z(z_) {}
    explicit V3(const double* p) : x(p[0]), y(p[1]), z(p[2]) {}
    V3 operator+(const V3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    V3 operator-(const V3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    V3 operator*(double s) const { return {x * s, y * s, z * s}; }
    V3 operator/(double s) const { return {x / s, y / s, z / s}; }
    V3& operator+=(const V3& o) { x += o.x; y += o.y; z += o.z; return *this; }
    double dot(const V3& o) const { return x * o.x + y * o.y + z * o.z; }
    V3 cross(const V3& o) const { return {y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x}; }
    double len2() const { return dot(*this); }
    double len() const { return std::sqrt(len2()); }
    V3 normalized() const { double l = len(); return l > 0 ? *this / l : V3(); }
    const double* data() const { return &x; }
};

struct V2 {
    double x = 0, y = 0;
};

// Blender's Vector.orthogonal (ortho_v3_v3): a vector square to v.
inline V3 orthogonal(const V3& v) {
    double ax = std::fabs(v.x), ay = std::fabs(v.y), az = std::fabs(v.z);
    if (ax >= ay && ax >= az) return {-v.y - v.z, v.x, v.x};
    if (ay >= az) return {v.y, -v.x - v.z, v.y};
    return {v.z, v.z, -v.x - v.y};
}

// A polygon's Newell vector: its normal times twice its area.
template <class Get>
V3 newell(int64_t n, Get&& co) {
    V3 s;
    for (int64_t i = 0; i < n; ++i) {
        const V3& a = co(i);
        const V3& b = co((i + 1) % n);
        s.x += (a.y - b.y) * (a.z + b.z);
        s.y += (a.z - b.z) * (a.x + b.x);
        s.z += (a.x - b.x) * (a.y + b.y);
    }
    return s;
}

inline double signed_area2(const std::vector<V2>& poly) {
    double s = 0;
    for (size_t i = 0; i < poly.size(); ++i) {
        const V2& a = poly[(i + poly.size() - 1) % poly.size()];
        const V2& b = poly[i];
        s += a.x * b.y - b.x * a.y;
    }
    return s;
}

// formations/detail.py point_in_polygon: the crossing test, edge by edge.
inline bool point_in_polygon(double x, double y, const std::vector<V2>& poly) {
    bool inside = false;
    size_t n = poly.size();
    for (size_t i = 0; i < n; ++i) {
        const V2& p0 = poly[(i + n - 1) % n];
        const V2& p1 = poly[i];
        if ((p0.y > y) != (p1.y > y)) {
            double t = (y - p0.y) / (p1.y - p0.y);
            if (x < p0.x + t * (p1.x - p0.x)) inside = !inside;
        }
    }
    return inside;
}

// formations/detail.py edge_distance: to the nearest edge of the ring.
inline double edge_distance(double px, double py, const std::vector<V2>& poly) {
    double best = std::numeric_limits<double>::infinity();
    size_t n = poly.size();
    for (size_t i = 0; i < n; ++i) {
        const V2& p0 = poly[(i + n - 1) % n];
        const V2& p1 = poly[i];
        double dx = p1.x - p0.x, dy = p1.y - p0.y;
        double l2 = dx * dx + dy * dy;
        double t = l2 == 0 ? 0.0 : std::max(0.0, std::min(1.0, ((px - p0.x) * dx + (py - p0.y) * dy) / l2));
        double ex = px - (p0.x + t * dx), ey = py - (p0.y + t * dy);
        best = std::min(best, ex * ex + ey * ey);
    }
    return std::sqrt(best);
}

inline double ring_distance(double x, double y, const std::vector<std::vector<V2>>& rings) {
    double best = std::numeric_limits<double>::infinity();
    for (const auto& r : rings) best = std::min(best, edge_distance(x, y, r));
    return best;
}

// The point of triangle abc nearest p (Ericson, Real-Time Collision Detection 5.1.5).
inline V3 closest_on_triangle(const V3& p, const V3& a, const V3& b, const V3& c) {
    V3 ab = b - a, ac = c - a, ap = p - a;
    double d1 = ab.dot(ap), d2 = ac.dot(ap);
    if (d1 <= 0 && d2 <= 0) return a;
    V3 bp = p - b;
    double d3 = ab.dot(bp), d4 = ac.dot(bp);
    if (d3 >= 0 && d4 <= d3) return b;
    double vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return a + ab * (d1 / (d1 - d3));
    V3 cp = p - c;
    double d5 = ab.dot(cp), d6 = ac.dot(cp);
    if (d6 >= 0 && d5 <= d6) return c;
    double vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return a + ac * (d2 / (d2 - d6));
    double va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6)));
    double denom = 1.0 / (va + vb + vc);
    double v = vb * denom, w = vc * denom;
    return a + ab * v + ac * w;
}

// Counter-based random numbers: a stream per (seed, key), so what an element
// draws does not depend on the order or thread it is handled in.
struct Rng {
    uint64_t state;
    static uint64_t mix(uint64_t z) {
        z += 0x9e3779b97f4a7c15ull;
        z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull;
        z = (z ^ (z >> 27)) * 0x94d049bb133111ebull;
        return z ^ (z >> 31);
    }
    Rng(uint64_t seed, uint64_t key) : state(mix(mix(seed) ^ (key * 0xd1b54a32d192ed03ull))) {}
    uint64_t next() { return mix(state += 0x9e3779b97f4a7c15ull); }
    double uniform() { return (double)(next() >> 11) * (1.0 / 9007199254740992.0); }
    double uniform(double a, double b) { return a + (b - a) * uniform(); }
};

}  // namespace rk
