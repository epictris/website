// UV island packing (scene_export.py `unwrap`): the islands Smart UV Project
// cut, packed as large as they fit into one square, at least `gap` texels
// apart, each turned by a quarter turn where that packs it tighter.
//
// Blender's packer ran on one thread for 20 s on one of Terrace.002's maps,
// 97 % of its unwrap (2026-11-13). xatlas's was tried first and rejected: its
// packs overlapped (1,372 texels on Terrace.002's 2k map with turns, 6
// without), where Blender's never do.
//
// The packer works on texels. At a trial scale each island is rasterised
// conservatively (every texel its triangles touch) in each quarter turn, and
// a copy is dilated so that no texel of another island can come within `gap`
// texels of it, measured between the texels' squares, not their centres (a
// disc of centres let two islands' corners come 2.8 texels apart for a gap of
// 4). Islands go in largest first, each at its lowest, then leftmost, place
// over the turns where its dilated copy meets nothing placed (bottom-left
// first fit). A collision skips the island past the run of taken texels it
// hit, and a row whose longest free run is shorter than one of the island's
// rows is passed over, so no fit is ever missed. The scale is the largest
// that fits, by bisection.
//
// One call runs on one thread: the export packs its maps side by side, and
// within one map the searches were too small to share (the threads spent
// thirty times the work waiting on each other).

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <numeric>
#include <string>
#include <unordered_map>
#include <vector>

#include "geom.h"
#include "kernels.h"

namespace rk {
namespace {

// A bitmap: rows of 64-bit words, bit k of word j is column 64 j + k.
struct Mask {
    int32_t w = 0, h = 0, words = 0;
    std::vector<uint64_t> bits;
    void init(int32_t w_, int32_t h_) {
        w = w_, h = h_, words = (w + 63) / 64;
        bits.assign((size_t)words * h, 0);
    }
    uint64_t* row(int32_t y) { return &bits[(size_t)y * words]; }
    const uint64_t* row(int32_t y) const { return &bits[(size_t)y * words]; }
    void set_span(int32_t y, int32_t x0, int32_t x1) {  // [x0, x1)
        uint64_t* r = row(y);
        for (int32_t x = x0; x < x1;) {
            int32_t j = x / 64, b = x % 64, n = std::min(64 - b, x1 - x);
            r[j] |= (n == 64 ? ~0ull : ((1ull << n) - 1)) << b;
            x += n;
        }
    }
};

// The longest run of `value` bits in a row of `width` bits.
int32_t longest_run(const uint64_t* row, int32_t width, bool value) {
    int32_t best = 0, run = 0;
    for (int32_t x = 0; x < width;) {
        int32_t j = x / 64, b = x % 64;
        uint64_t v = (value ? row[j] : ~row[j]) >> b;
        int32_t room = std::min(64 - b, width - x);
        uint64_t all = room == 64 ? ~0ull : ((1ull << room) - 1);
        v &= all;
        if (v == all) {
            run += room;
            x += room;
            continue;
        }
        int32_t ones = __builtin_ctzll(~v);
        best = std::max(best, run + ones);
        run = 0;
        x += ones + 1;
    }
    return std::max(best, run);
}

struct Island {
    std::vector<V2> tris;  // 3 a triangle, UV units, of the triangles with area
    double area = 0;
    int64_t pixels = 0;    // at the trial scale, unturned
    // At the trial scale, per quarter turn: the island and its dilated copy
    // (the same size), where the island's UV origin lands in them, and the
    // dilated copy's rows, widest run first, as (row, run).
    Mask solid[4], wide[4];
    double ox[4], oy[4];
    std::vector<std::pair<int32_t, int32_t>> runs[4];
};

V2 turn(V2 p, int q) {
    switch (q) {
        case 1: return {-p.y, p.x};
        case 2: return {-p.x, -p.y};
        case 3: return {p.y, -p.x};
        default: return p;
    }
}

// The x extent of the triangle within row band [y, y + 1].
bool band(const V2* t, double y, double& x0, double& x1) {
    x0 = INFINITY, x1 = -INFINITY;
    for (int k = 0; k < 3; ++k) {
        V2 a = t[k], b = t[(k + 1) % 3];
        double lo = std::max(y, std::min(a.y, b.y)), hi = std::min(y + 1, std::max(a.y, b.y));
        if (lo > hi) continue;
        if (a.y == b.y) {
            x0 = std::min({x0, a.x, b.x});
            x1 = std::max({x1, a.x, b.x});
            continue;
        }
        for (double yy : {lo, hi}) {
            double x = a.x + (b.x - a.x) * (yy - a.y) / (b.y - a.y);
            x0 = std::min(x0, x);
            x1 = std::max(x1, x);
        }
    }
    return x0 <= x1;
}

// How far either side of a taken texel, in row dy from it, another island's
// texel may not be: texels whose squares are under `gap` apart, that is
// (|dx| - 1)+^2 + (|dy| - 1)+^2 < gap^2, so |dx| up to ceil(r) for
// r = sqrt(gap^2 - (|dy| - 1)^2). -1 in a row past its reach.
int32_t reach(int32_t gap, int32_t dy) {
    int32_t a = std::abs(dy) - 1;
    if (a <= 0) return gap;
    if (a >= gap) return -1;
    return (int32_t)std::ceil(std::sqrt((double)gap * gap - (double)a * a));
}

// The island at `scale` texels a unit, turned by q quarter turns, `gap`
// texels in from its masks' edges: `solid` every texel it touches, `wide`
// every texel no other island may take.
void rasterise(Island& is, double scale, int32_t gap, int q) {
    double lx = INFINITY, ly = INFINITY, hx = -INFINITY, hy = -INFINITY;
    for (V2 p : is.tris) {
        V2 r = turn(p, q);
        lx = std::min(lx, r.x), ly = std::min(ly, r.y), hx = std::max(hx, r.x), hy = std::max(hy, r.y);
    }
    int32_t w = (int32_t)std::ceil((hx - lx) * scale) + 1 + 2 * gap;
    int32_t h = (int32_t)std::ceil((hy - ly) * scale) + 1 + 2 * gap;
    is.ox[q] = gap - lx * scale;
    is.oy[q] = gap - ly * scale;
    Mask& s = is.solid[q];
    s.init(w, h);
    for (size_t t = 0; t < is.tris.size(); t += 3) {
        V2 p[3];
        double ty0 = INFINITY, ty1 = -INFINITY;
        for (int k = 0; k < 3; ++k) {
            V2 r = turn(is.tris[t + k], q);
            p[k] = {r.x * scale + is.ox[q], r.y * scale + is.oy[q]};
            ty0 = std::min(ty0, p[k].y), ty1 = std::max(ty1, p[k].y);
        }
        for (int32_t y = std::max(0, (int32_t)std::floor(ty0)); y < h && y <= (int32_t)std::floor(ty1); ++y) {
            double x0, x1;
            if (!band(p, y, x0, x1)) continue;
            int32_t a = std::max(0, (int32_t)std::floor(x0)), b = std::min(w, (int32_t)std::floor(x1) + 1);
            if (a < b) s.set_span(y, a, b);
        }
    }
    Mask& d = is.wide[q];
    d.init(w, h);
    std::vector<uint64_t> spread(s.words);
    for (int32_t dy = -gap; dy <= gap; ++dy) {
        int32_t hw = reach(gap, dy);
        if (hw < 0) continue;
        for (int32_t y = 0; y < h; ++y) {
            int32_t yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            const uint64_t* src = s.row(y);
            bool any = false;
            for (int32_t j = 0; j < s.words && !any; ++j) any = src[j] != 0;
            if (!any) continue;
            std::fill(spread.begin(), spread.end(), 0);
            for (int32_t sh = -hw; sh <= hw; ++sh)
                for (int32_t j = 0; j < s.words; ++j) {
                    uint64_t v = src[j];
                    if (!v) continue;
                    if (sh >= 0) {
                        spread[j] |= v << sh;
                        if (sh && j + 1 < s.words) spread[j + 1] |= v >> (64 - sh);
                    } else {
                        int32_t k = -sh;
                        spread[j] |= v >> k;
                        if (j > 0) spread[j - 1] |= v << (64 - k);
                    }
                }
            uint64_t* dst = d.row(yy);
            for (int32_t j = 0; j < s.words; ++j) dst[j] |= spread[j];
        }
    }
    if (w % 64)
        for (int32_t y = 0; y < h; ++y) d.row(y)[d.words - 1] &= (1ull << (w % 64)) - 1;
    auto& runs = is.runs[q];
    runs.clear();
    for (int32_t y = 0; y < h; ++y) {
        int32_t r = longest_run(d.row(y), w, true);
        if (r) runs.push_back({y, r});
    }
    std::stable_sort(runs.begin(), runs.end(), [](auto& a, auto& b) { return a.second > b.second; });
    if (q == 0) {
        is.pixels = 0;
        for (uint64_t v : s.bits) is.pixels += __builtin_popcountll(v);
    }
}

// The square's texels taken so far.
struct Atlas {
    int32_t side, words;
    std::vector<uint64_t> bits;
    std::vector<int32_t> free_run;  // each row's longest run of free texels
    explicit Atlas(int32_t s) : side(s), words((s + 63) / 64), bits((size_t)words * s, 0), free_run(s, s) {}
    const uint64_t* row(int32_t y) const { return &bits[(size_t)y * words]; }
    uint64_t* row(int32_t y) { return &bits[(size_t)y * words]; }
    // Whether a mask whose rows need these runs could sit at row y at all.
    bool room(int32_t y, const std::vector<std::pair<int32_t, int32_t>>& runs) const {
        for (const auto& [r, need] : runs)
            if (free_run[y + r] < need) return false;
        return true;
    }
    // 64 texels of row y from column x (columns past the side read as taken).
    uint64_t window(int32_t y, int64_t x) const {
        const uint64_t* r = row(y);
        int64_t j = x / 64, b = x % 64;
        uint64_t lo = j < words ? r[j] : ~0ull;
        if (!b) return lo;
        uint64_t hi = j + 1 < words ? r[j + 1] : ~0ull;
        return (lo >> b) | (hi << (64 - b));
    }
    // The first free texel of row y at or after x (side if none).
    int64_t next_free(int32_t y, int64_t x) const {
        const uint64_t* r = row(y);
        while (x < side) {
            int64_t j = x / 64, b = x % 64;
            uint64_t free = ~r[j] >> b;
            if (free) return std::min<int64_t>(side, x + __builtin_ctzll(free));
            x = (j + 1) * 64;
        }
        return side;
    }
    void take(const Mask& s, int32_t y0, int64_t x0) {
        for (int32_t r = 0; r < s.h; ++r) {
            const uint64_t* sr = s.row(r);
            uint64_t* ar = row(y0 + r);
            for (int32_t j = 0; j < s.words; ++j) {
                uint64_t v = sr[j];
                if (!v) continue;
                int64_t x = x0 + 64 * j, w = x / 64, b = x % 64;
                ar[w] |= v << b;
                if (b && w + 1 < words) ar[w + 1] |= v >> (64 - b);
            }
            free_run[y0 + r] = longest_run(ar, side, false);
        }
    }
};

// Where `m` first fits in row y: its column, or -1. A collision moves it past
// the taken run it met.
int64_t fit_in_row(const Atlas& at, const Mask& m, int32_t y) {
    int64_t x = 0, last = at.side - m.w;
    while (x <= last) {
        int64_t skip = -1;
        for (int32_t r = 0; r < m.h && skip < 0; ++r) {
            const uint64_t* mr = m.row(r);
            for (int32_t j = 0; j < m.words; ++j) {
                if (!mr[j]) continue;
                uint64_t hit = mr[j] & at.window(y + r, x + 64 * j);
                if (!hit) continue;
                int64_t c = 64 * j + __builtin_ctzll(hit);  // the mask's column that hit
                skip = at.next_free(y + r, x + c) - c;
                break;
            }
        }
        if (skip < 0) return x;
        x = skip;
    }
    return -1;
}

struct Place {
    int32_t y = std::numeric_limits<int32_t>::max();
    int64_t x = 0;
    int q = -1;
};

// One trial: every island placed at `scale`, or false.
bool pack_at(std::vector<Island>& islands, double scale, int32_t side, int32_t gap, int turns,
             std::vector<Place>& placed) {
    std::vector<size_t> order;
    for (size_t i = 0; i < islands.size(); ++i) {
        if (islands[i].tris.empty()) continue;
        for (int q = 0; q < turns; ++q) rasterise(islands[i], scale, gap, q);
        order.push_back(i);
    }
    std::stable_sort(order.begin(), order.end(),
                     [&](size_t a, size_t b) { return islands[a].pixels > islands[b].pixels; });
    Atlas at(side);
    placed.assign(islands.size(), Place());
    for (size_t i : order) {
        Island& is = islands[i];
        Place best;
        for (int q = 0; q < turns; ++q) {
            const Mask& m = is.wide[q];
            if (m.w > side || m.h > side) continue;
            // Lowest row first; a later turn only wins lower down or further left.
            for (int32_t y = 0; y <= side - m.h && y <= best.y; ++y) {
                if (!at.room(y, is.runs[q])) continue;
                int64_t x = fit_in_row(at, m, y);
                if (x < 0) continue;
                if (y < best.y || (y == best.y && x < best.x)) best = {y, x, q};
                break;
            }
        }
        if (best.q < 0) return false;
        placed[i] = best;
        at.take(is.solid[best.q], best.y, best.x);
    }
    return true;
}

}  // namespace
}  // namespace rk

using namespace rk;

extern "C" {

// Pack the islands of a UV map: corners with their UV (`uv`, 2 a corner) and
// welded vertex (`corner_vert`), as triangles of corners (`tri_corners`).
// Corners sharing a vertex and a UV are one point, so an island is the
// triangles joined through them. Into a square of `side` texels, `gap` texels
// apart, turned by quarter turns if `rotate`, with `steps` bisections of the
// scale between the islands covering `lo_share` and `hi_share` of it. Writes
// each corner's UV in [0, 1] (`out`) and returns the share of the square the
// islands cover, or -1 if they fit at no scale.
double rk_pack_islands(int64_t ncorners, const double* uv, const int32_t* corner_vert, int64_t ntris,
                       const int32_t* tri_corners, uint32_t side, uint32_t gap, int32_t rotate, double lo_share,
                       double hi_share, int32_t steps, double* out) {
    // Points: corners on one vertex at one UV.
    std::vector<int32_t> point(ncorners);
    std::unordered_map<std::string, int32_t> seen;
    int32_t npoints = 0;
    for (int64_t c = 0; c < ncorners; ++c) {
        char key[20];
        std::memcpy(key, &corner_vert[c], 4);
        std::memcpy(key + 4, &uv[2 * c], 16);
        auto it = seen.emplace(std::string(key, 20), npoints);
        if (it.second) ++npoints;
        point[c] = it.first->second;
    }
    std::vector<int32_t> parent(npoints);
    std::iota(parent.begin(), parent.end(), 0);
    auto find = [&](int32_t x) {
        while (parent[x] != x) x = parent[x] = parent[parent[x]];
        return x;
    };
    for (int64_t t = 0; t < ntris; ++t) {
        int32_t a = find(point[tri_corners[3 * t]]);
        for (int k = 1; k < 3; ++k) {
            int32_t b = find(point[tri_corners[3 * t + k]]);
            if (a != b) parent[std::max(a, b)] = std::min(a, b), a = std::min(a, b);
        }
    }
    // An island of no area takes no room (`pack_at` passes it by): its
    // corners go where a corner of theirs with room went, and Python
    // collapses its faces.
    std::vector<int32_t> island_of(npoints, -1), corner_island(ncorners, -1);
    std::vector<Island> islands;
    double area = 0;
    for (int64_t t = 0; t < ntris; ++t) {
        int32_t root = find(point[tri_corners[3 * t]]);
        if (island_of[root] < 0) island_of[root] = (int32_t)islands.size(), islands.emplace_back();
        Island& is = islands[island_of[root]];
        V2 p[3];
        for (int k = 0; k < 3; ++k) {
            int32_t c = tri_corners[3 * t + k];
            p[k] = {uv[2 * c], uv[2 * c + 1]};
            corner_island[c] = island_of[root];
        }
        double a = std::fabs((p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[1].y - p[0].y) * (p[2].x - p[0].x)) / 2;
        if (a <= 0) continue;
        is.area += a;
        area += a;
        is.tris.insert(is.tris.end(), p, p + 3);
    }
    if (area <= 0) return -1;

    double s = side;
    int turns = rotate ? 4 : 1;
    // Texels a UV unit at which the islands would cover `share` of the square.
    auto at_share = [&](double share) { return s * std::sqrt(share / area); };
    double lo = at_share(lo_share), hi = at_share(hi_share);
    std::vector<Place> placed, best_placed;
    bool ok = pack_at(islands, lo, (int32_t)side, (int32_t)gap, turns, placed);
    for (int shrink = 0; !ok && shrink < 16; ++shrink) {
        hi = lo;
        lo *= 0.75;
        ok = pack_at(islands, lo, (int32_t)side, (int32_t)gap, turns, placed);
    }
    if (!ok) return -1;
    double best = lo;
    best_placed = placed;
    for (int i = 0; i < steps; ++i) {
        double mid = std::sqrt(lo * hi);
        if (pack_at(islands, mid, (int32_t)side, (int32_t)gap, turns, placed)) {
            lo = best = mid;
            best_placed = placed;
        } else {
            hi = mid;
        }
    }
    // Each corner by its island's turn and place at the winning scale.
    std::vector<char> done(ncorners, 0);
    for (size_t i = 0; i < islands.size(); ++i) {
        if (islands[i].tris.empty()) continue;
        rasterise(islands[i], best, (int32_t)gap, best_placed[i].q);
    }
    for (int64_t c = 0; c < ncorners; ++c) {
        int32_t i = corner_island[c];
        if (i < 0 || islands[i].tris.empty()) continue;
        const Place& p = best_placed[i];
        V2 r = turn({uv[2 * c], uv[2 * c + 1]}, p.q);
        out[2 * c] = (r.x * best + p.x + islands[i].ox[p.q]) / s;
        out[2 * c + 1] = (r.y * best + p.y + islands[i].oy[p.q]) / s;
        done[c] = 1;
    }
    // A corner of a no-area island takes a placed corner of a triangle it is in.
    for (int pass = 0; pass < 4; ++pass)
        for (int64_t t = 0; t < ntris; ++t)
            for (int k = 0; k < 3; ++k) {
                int32_t c = tri_corners[3 * t + k];
                if (done[c]) continue;
                for (int j = 1; j < 3; ++j) {
                    int32_t o = tri_corners[3 * t + (k + j) % 3];
                    if (!done[o]) continue;
                    out[2 * c] = out[2 * o], out[2 * c + 1] = out[2 * o + 1], done[c] = 1;
                    break;
                }
            }
    for (int64_t c = 0; c < ncorners; ++c)
        if (!done[c]) out[2 * c] = out[2 * c + 1] = 0;
    return area * (best / s) * (best / s);
}

}  // extern "C"
