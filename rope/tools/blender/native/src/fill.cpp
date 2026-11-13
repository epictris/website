// The background fill of a baked map (scene_export.py `fill_background`):
// pull-push, every texel no bake wrote (alpha 0) filled from the average of
// the baked texels around it, coarser the farther they are. The same float
// operations in the same order as the numpy it replaced, so the maps are
// the same to the bit; here on every thread, where the numpy took 0.5 s a
// 4096 map on one (2026-11-13).

#include <algorithm>
#include <cstdint>
#include <vector>

namespace {

struct Level {
    int64_t h = 0, w = 0;
    std::vector<float> c;  // h * w * 3: the colour, premultiplied by k
    std::vector<float> k;  // h * w: the weight (how many baked texels)
};

// Each 2 x 2 block summed, ((a00 + a10) + a01) + a11 as numpy summed its
// four slices; an odd last row or column is left out.
Level down(const Level& a) {
    Level o;
    o.h = a.h / 2;
    o.w = a.w / 2;
    o.c.resize(size_t(o.h * o.w * 3));
    o.k.resize(size_t(o.h * o.w));
#pragma omp parallel for schedule(static)
    for (int64_t i = 0; i < o.h; ++i) {
        for (int64_t j = 0; j < o.w; ++j) {
            const int64_t p00 = (2 * i) * a.w + 2 * j, p10 = (2 * i + 1) * a.w + 2 * j;
            const int64_t p01 = p00 + 1, p11 = p10 + 1;
            const int64_t q = i * o.w + j;
            for (int ch = 0; ch < 3; ++ch) {
                o.c[q * 3 + ch] = ((a.c[p00 * 3 + ch] + a.c[p10 * 3 + ch]) + a.c[p01 * 3 + ch]) + a.c[p11 * 3 + ch];
            }
            o.k[q] = ((a.k[p00] + a.k[p10]) + a.k[p01]) + a.k[p11];
        }
    }
    return o;
}

}  // namespace

extern "C" {

// `px`: h x w RGBA floats, row-major. Fills every texel whose alpha is not
// over 0.5, sets every alpha to 1, and returns how many texels were baked.
int64_t rk_fill_background(int64_t h, int64_t w, float* px) {
    const float eps = 1e-6f;
    std::vector<Level> levels(1);
    Level& base = levels[0];
    base.h = h;
    base.w = w;
    base.c.resize(size_t(h * w * 3));
    base.k.resize(size_t(h * w));
    int64_t count = 0;
#pragma omp parallel for schedule(static) reduction(+ : count)
    for (int64_t p = 0; p < h * w; ++p) {
        const bool known = px[p * 4 + 3] > 0.5f;
        count += known;
        const float m = known ? 1.0f : 0.0f;
        for (int ch = 0; ch < 3; ++ch) base.c[p * 3 + ch] = px[p * 4 + ch] * m;
        base.k[p] = m;
    }
    while (levels.back().h > 1 && levels.back().w > 1) levels.push_back(down(levels.back()));

    // The coarsest level, each texel its average; then back up, each texel
    // its own average where it has weight, else its parent's colour.
    const Level& top = levels.back();
    std::vector<float> color(size_t(top.h * top.w * 3));
    for (int64_t q = 0; q < top.h * top.w; ++q) {
        const float d = std::max(top.k[q], eps);
        for (int ch = 0; ch < 3; ++ch) color[q * 3 + ch] = top.c[q * 3 + ch] / d;
    }
    int64_t ch_ = top.h, cw = top.w;
    for (int64_t l = int64_t(levels.size()) - 2; l >= 0; --l) {
        const Level& L = levels[size_t(l)];
        std::vector<float> next(size_t(L.h * L.w * 3));
#pragma omp parallel for schedule(static)
        for (int64_t i = 0; i < L.h; ++i) {
            const int64_t pi = std::min(i / 2, ch_ - 1);
            for (int64_t j = 0; j < L.w; ++j) {
                const int64_t pj = std::min(j / 2, cw - 1);
                const int64_t q = i * L.w + j;
                if (L.k[q] > 0.0f) {
                    const float d = std::max(L.k[q], eps);
                    for (int ch = 0; ch < 3; ++ch) next[q * 3 + ch] = L.c[q * 3 + ch] / d;
                } else {
                    const int64_t u = pi * cw + pj;
                    for (int ch = 0; ch < 3; ++ch) next[q * 3 + ch] = color[u * 3 + ch];
                }
            }
        }
        color.swap(next);
        ch_ = L.h;
        cw = L.w;
    }
#pragma omp parallel for schedule(static)
    for (int64_t p = 0; p < h * w; ++p) {
        for (int ch = 0; ch < 3; ++ch) px[p * 4 + ch] = color[p * 3 + ch];
        px[p * 4 + 3] = 1.0f;
    }
    return count;
}

}  // extern "C"
