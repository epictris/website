// The crease bow field (formations/curve.py `field` and `sizing`): a grid over
// the bows' reach boxes, so a point only measures the bows whose box it is in.
// Per point the sum runs over the bows of its cell in bow order, so a point's
// offset is the same at any thread count.
#pragma once

#include <cstdint>
#include <vector>

namespace rk {

struct Field {
    int64_t n = 0;
    std::vector<double> a, ab, ab2, bow, reach, lo, hi;  // per bow
    double origin[3] = {0, 0, 0};
    double cell = 1.0;
    int64_t dims[3] = {0, 0, 0};
    std::vector<int64_t> start;  // CSR over cells: start[c]..start[c + 1]
    std::vector<int32_t> items;  // bow indices, ascending within a cell

    // How sizing measures the field's bend (curve.py WAYS, SIZING_STEP,
    // TOLERANCE, SIZE), set by rk_field_set_sizing.
    std::vector<double> ways;
    double step = 0.02, tolerance = 0.002, size_lo = 0.04, size_hi = 0.3;
    // Optional world-depth budget: row xyz, offset, distance, tanHalf,
    // output height, maxBlur, focusBand, blurSamples, errorPixels, local scale.
    std::vector<double> depth_budget;

    Field(int64_t n, const double* a, const double* b, const double* bow, const double* reach);
    // The offset at p.
    void at(const double* p, double* out) const;
    // The triangle size at p: the longest edge the field bends by under
    // `tolerance` in its middle.
    double size(const double* p) const;
    bool reaches(const double* p) const;
};

}  // namespace rk
