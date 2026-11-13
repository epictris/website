// The crease bow field (formations/curve.py `field` and `sizing`), on every
// thread. The Python field scanned every bow that could reach a block of
// points, once per patch, and that was 5,833 s of a 3 h export (2026-11-13).

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

#include "field.h"
#include "kernels.h"

namespace rk {

Field::Field(int64_t n_, const double* a_, const double* b, const double* bow_, const double* reach_) : n(n_) {
    a.assign(a_, a_ + 3 * n);
    bow.assign(bow_, bow_ + 3 * n);
    reach.assign(reach_, reach_ + n);
    ab.resize(3 * n);
    ab2.resize(n);
    lo.resize(3 * n);
    hi.resize(3 * n);
    if (!n) return;
    double gl[3] = {INFINITY, INFINITY, INFINITY}, gh[3] = {-INFINITY, -INFINITY, -INFINITY};
    std::vector<double> extent(n);
    for (int64_t i = 0; i < n; ++i) {
        double len2 = 0, big = 0;
        for (int k = 0; k < 3; ++k) {
            double d = b[3 * i + k] - a[3 * i + k];
            ab[3 * i + k] = d;
            len2 += d * d;
            lo[3 * i + k] = std::min(a[3 * i + k], b[3 * i + k]) - reach[i];
            hi[3 * i + k] = std::max(a[3 * i + k], b[3 * i + k]) + reach[i];
            gl[k] = std::min(gl[k], lo[3 * i + k]);
            gh[k] = std::max(gh[k], hi[3 * i + k]);
            big = std::max(big, hi[3 * i + k] - lo[3 * i + k]);
        }
        ab2[i] = std::max(len2, 1e-12);
        extent[i] = big;
    }
    // Cells about half a typical box across, and no more than 2^22 of them.
    std::nth_element(extent.begin(), extent.begin() + n / 2, extent.end());
    cell = std::max(extent[n / 2] * 0.5, 1e-3);
    double volume = (gh[0] - gl[0]) * (gh[1] - gl[1]) * (gh[2] - gl[2]);
    cell = std::max(cell, std::cbrt(volume / (double)(1 << 22)));
    for (int k = 0; k < 3; ++k) {
        origin[k] = gl[k];
        dims[k] = std::max<int64_t>(1, (int64_t)std::ceil((gh[k] - gl[k]) / cell));
    }
    int64_t cells = dims[0] * dims[1] * dims[2];
    start.assign(cells + 1, 0);
    auto cell_of = [&](double x, int k) {
        int64_t i = (int64_t)std::floor((x - origin[k]) / cell);
        return std::min<int64_t>(dims[k] - 1, std::max<int64_t>(0, i));
    };
    auto each_cell = [&](int64_t i, auto&& fn) {
        int64_t l[3], h[3];
        for (int k = 0; k < 3; ++k) {
            l[k] = cell_of(lo[3 * i + k], k);
            h[k] = cell_of(hi[3 * i + k], k);
        }
        for (int64_t z = l[2]; z <= h[2]; ++z)
            for (int64_t y = l[1]; y <= h[1]; ++y)
                for (int64_t x = l[0]; x <= h[0]; ++x) fn((z * dims[1] + y) * dims[0] + x);
    };
    for (int64_t i = 0; i < n; ++i) each_cell(i, [&](int64_t c) { ++start[c + 1]; });
    for (int64_t c = 0; c < cells; ++c) start[c + 1] += start[c];
    items.resize(start[cells]);
    std::vector<int64_t> fill(start.begin(), start.end() - 1);
    for (int64_t i = 0; i < n; ++i) each_cell(i, [&](int64_t c) { items[fill[c]++] = (int32_t)i; });
}

void Field::at(const double* p, double* out) const {
    out[0] = out[1] = out[2] = 0.0;
    if (!n) return;
    int64_t c[3];
    for (int k = 0; k < 3; ++k) {
        double x = (p[k] - origin[k]) / cell;
        if (!(x >= 0 && x < (double)dims[k])) return;  // past every box
        c[k] = (int64_t)x;
    }
    int64_t id = (c[2] * dims[1] + c[1]) * dims[0] + c[0];
    for (int64_t s = start[id]; s < start[id + 1]; ++s) {
        int64_t b = items[s];
        const double* lb = &lo[3 * b];
        const double* hb = &hi[3 * b];
        if (p[0] < lb[0] || p[0] > hb[0] || p[1] < lb[1] || p[1] > hb[1] || p[2] < lb[2] || p[2] > hb[2])
            continue;  // further than the reach: exactly 0
        const double* d = &ab[3 * b];
        double rel[3] = {p[0] - a[3 * b], p[1] - a[3 * b + 1], p[2] - a[3 * b + 2]};
        double t = (rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2]) / ab2[b];
        t = std::min(1.0, std::max(0.0, t));
        double dx = rel[0] - t * d[0], dy = rel[1] - t * d[1], dz = rel[2] - t * d[2];
        double x = std::min(1.0, std::max(0.0, 1.0 - std::sqrt(dx * dx + dy * dy + dz * dz) / reach[b]));
        double w = std::sin(M_PI * t) * x * x * (3.0 - 2.0 * x);
        if (w == 0.0) continue;
        out[0] += w * bow[3 * b];
        out[1] += w * bow[3 * b + 1];
        out[2] += w * bow[3 * b + 2];
    }
}

bool Field::reaches(const double* p) const {
    double o[3];
    at(p, o);
    return std::sqrt(o[0] * o[0] + o[1] * o[1] + o[2] * o[2]) > 1e-6;
}

double Field::size(const double* p) const {
    double mid[3];
    at(p, mid);
    double bend = 0.0;
    int64_t nways = (int64_t)ways.size() / 3;
    for (int64_t w = 0; w < nways; ++w) {
        double q[3], plus[3], minus[3];
        for (int k = 0; k < 3; ++k) q[k] = p[k] + ways[3 * w + k] * step;
        at(q, plus);
        for (int k = 0; k < 3; ++k) q[k] = p[k] - ways[3 * w + k] * step;
        at(q, minus);
        double s = 0;
        for (int k = 0; k < 3; ++k) {
            double d2 = plus[k] - 2 * mid[k] + minus[k];
            s += d2 * d2;
        }
        bend = std::max(bend, std::sqrt(s) / (step * step));
    }
    // An edge of length L bends by about bend x L^2 / 8 in its middle.
    double size = std::sqrt(8 * tolerance / std::max(bend, 1e-9));
    return std::min(size_hi, std::max(size_lo, size));
}

}  // namespace rk

using rk::Field;

extern "C" {

void* rk_field_new(int64_t n, const double* a, const double* b, const double* bow, const double* reach) {
    return new Field(n, a, b, bow, reach);
}

void rk_field_free(void* f) { delete static_cast<Field*>(f); }

void rk_field_set_sizing(void* handle, int64_t nways, const double* ways, double step, double tolerance,
                         double size_lo, double size_hi) {
    Field* f = static_cast<Field*>(handle);
    f->ways.assign(ways, ways + 3 * nways);
    f->step = step;
    f->tolerance = tolerance;
    f->size_lo = size_lo;
    f->size_hi = size_hi;
}

// Few points are not worth waking the thread team for (about 100 us).
static constexpr int64_t SERIAL = 512;

void rk_field_eval(const void* handle, int64_t count, const double* points, double* out) {
    const Field* f = static_cast<const Field*>(handle);
#pragma omp parallel for schedule(dynamic, 4096) if (count > SERIAL)
    for (int64_t i = 0; i < count; ++i) f->at(&points[3 * i], &out[3 * i]);
}

void rk_field_sizing(const void* handle, int64_t count, const double* points, double* out) {
    const Field* f = static_cast<const Field*>(handle);
#pragma omp parallel for schedule(dynamic, 256) if (count > SERIAL / 16)
    for (int64_t i = 0; i < count; ++i) out[i] = f->size(&points[3 * i]);
}

}  // extern "C"
