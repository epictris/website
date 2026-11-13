// formations/curve.py `rebuild`, end to end: every plane the crease bows
// reach is triangulated afresh in well-shaped triangles sized to the bend,
// with no point of its boundary moved. The steps and their reasons are
// curve.py's (its docstrings); this is the same algorithm on arrays, with the
// patches cut and triangulated on every thread.
//
// Each patch draws its grid from its own random stream (its seed and its
// place in the patch order), so a seed gives the same rock at any thread count.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iterator>
#include <numeric>
#include <string>
#include <unordered_map>
#include <vector>

#include "CDT.h"
#include "field.h"
#include "geom.h"
#include "kernels.h"

namespace rk {
namespace {

struct Poly {
    std::vector<int32_t> v;
    int64_t src;  // the input face it came from
};

inline uint64_t edge_key(int32_t a, int32_t b) {
    if (a > b) std::swap(a, b);
    return ((uint64_t)(uint32_t)a << 32) | (uint32_t)b;
}

// Every face on every edge, sorted by edge: an edge's faces are a range.
struct EdgeFaces {
    std::vector<std::pair<uint64_t, int32_t>> e;
    void build(const std::vector<Poly>& faces) {
        e.clear();
        for (int32_t f = 0; f < (int32_t)faces.size(); ++f) {
            const auto& v = faces[f].v;
            for (size_t i = 0; i < v.size(); ++i) e.emplace_back(edge_key(v[i], v[(i + 1) % v.size()]), f);
        }
        std::sort(e.begin(), e.end());
    }
    std::pair<const std::pair<uint64_t, int32_t>*, const std::pair<uint64_t, int32_t>*> of(int32_t a,
                                                                                           int32_t b) const {
        uint64_t k = edge_key(a, b);
        auto lo = std::lower_bound(e.begin(), e.end(), std::make_pair(k, INT32_MIN));
        auto hi = lo;
        while (hi != e.end() && hi->first == k) ++hi;
        return {e.data() + (lo - e.begin()), e.data() + (hi - e.begin())};
    }
    int count(int32_t a, int32_t b) const {
        auto r = of(a, b);
        return (int)(r.second - r.first);
    }
};

struct Params {
    double merge, sliver, smooth_angle, patch_angle, margin, jitter, deepest;
    int64_t passes;
};

struct Mesh {
    std::vector<V3> co;
    std::vector<Poly> faces;
};

// --------------------------------------------------------------- weld
uint64_t cell_hash(int64_t x, int64_t y, int64_t z) {
    return Rng::mix((uint64_t)x * 0x9e3779b97f4a7c15ull ^ Rng::mix((uint64_t)y ^ Rng::mix((uint64_t)z)));
}

// A face's corners with repeats in a row dropped, and a face that passes a
// corner twice (pinched there once welded) split at it into the loops either
// side; loops under three corners dropped.
void split_pinched(std::vector<int32_t> v, int64_t src, std::vector<Poly>& out) {
    std::vector<int32_t> w;
    for (int32_t x : v)
        if (w.empty() || w.back() != x) w.push_back(x);
    while (w.size() > 1 && w.front() == w.back()) w.pop_back();
    if (w.size() < 3) return;
    for (size_t i = 0; i < w.size(); ++i)
        for (size_t j = i + 1; j < w.size(); ++j)
            if (w[i] == w[j]) {
                split_pinched(std::vector<int32_t>(w.begin() + i, w.begin() + j), src, out);
                std::vector<int32_t> rest(w.begin() + j, w.end());
                rest.insert(rest.end(), w.begin(), w.begin() + i);
                split_pinched(std::move(rest), src, out);
                return;
            }
    out.push_back({std::move(w), src});
}

// A face's corners turned to start at its lowest vertex: two faces on the
// same corners in the same winding come out equal.
std::vector<int32_t> canonical(const std::vector<int32_t>& v) {
    size_t k = std::min_element(v.begin(), v.end()) - v.begin();
    std::vector<int32_t> out(v.begin() + k, v.end());
    out.insert(out.end(), v.begin(), v.begin() + k);
    return out;
}

// Faces with each vertex replaced by map[v] (split_pinched), and the faces
// the weld laid on the same corners settled: one of a pair wound the same way
// is a copy and goes; a pair wound opposite ways is a pocket with nothing
// inside, back to back (Terrace.002: two 0.4 mm triangles, 2026-11-13), and
// both go. Keeping one of the pocket left its edges with three faces, and the
// detail high poly's sub-facets failed on the face it then made twice.
void remap_faces(Mesh& m, const std::vector<int32_t>& map) {
    std::vector<Poly> out;
    out.reserve(m.faces.size());
    for (auto& f : m.faces) {
        std::vector<int32_t> v;
        v.reserve(f.v.size());
        for (int32_t x : f.v) v.push_back(map[x]);
        split_pinched(std::move(v), f.src, out);
    }
    std::unordered_map<std::string, std::vector<size_t>> by_corners;
    for (size_t i = 0; i < out.size(); ++i) {
        std::vector<int32_t> key = out[i].v;
        std::sort(key.begin(), key.end());
        by_corners[std::string((const char*)key.data(), key.size() * sizeof(int32_t))].push_back(i);
    }
    std::vector<char> drop(out.size(), 0);
    for (auto& [key, group] : by_corners) {
        if (group.size() < 2) continue;
        // Keep one face a winding, then cancel a pair wound opposite ways.
        std::vector<size_t> kept;
        std::vector<std::vector<int32_t>> windings;
        for (size_t i : group) {
            std::vector<int32_t> c = canonical(out[i].v);
            if (std::find(windings.begin(), windings.end(), c) != windings.end()) {
                drop[i] = 1;
                continue;
            }
            windings.push_back(c);
            kept.push_back(i);
        }
        if (kept.size() == 2) {
            std::vector<int32_t> r = out[kept[1]].v;
            std::reverse(r.begin(), r.end());
            if (canonical(r) == windings[0]) drop[kept[0]] = drop[kept[1]] = 1;
        }
    }
    std::vector<Poly> settled;
    settled.reserve(out.size());
    for (size_t i = 0; i < out.size(); ++i)
        if (!drop[i]) settled.push_back(std::move(out[i]));
    m.faces.swap(settled);
}

// bmesh.ops.remove_doubles, but transitive: every vertex within `dist` of
// another is one point, at the lowest index's place. Greedy merging (Blender
// takes them in order of x + y + z, each taking the later ones within reach)
// leaves a chain's far end apart: a vertex 0.4 mm from one that merged away,
// which the rebuild turned into a needle and a T-junction.
void remove_doubles(Mesh& m, double dist) {
    int32_t n = (int32_t)m.co.size();
    std::vector<std::pair<uint64_t, int32_t>> cells(n);
    auto cell = [&](const V3& p, int64_t* c) {
        c[0] = (int64_t)std::floor(p.x / dist);
        c[1] = (int64_t)std::floor(p.y / dist);
        c[2] = (int64_t)std::floor(p.z / dist);
    };
    for (int32_t i = 0; i < n; ++i) {
        int64_t c[3];
        cell(m.co[i], c);
        cells[i] = {cell_hash(c[0], c[1], c[2]), i};
    }
    std::sort(cells.begin(), cells.end());
    std::vector<int32_t> parent(n);
    std::iota(parent.begin(), parent.end(), 0);
    auto find = [&](int32_t x) {
        while (parent[x] != x) x = parent[x] = parent[parent[x]];
        return x;
    };
    double d2 = dist * dist;
    for (int32_t i = 0; i < n; ++i) {
        int64_t c[3];
        cell(m.co[i], c);
        for (int dz = -1; dz <= 1; ++dz)
            for (int dy = -1; dy <= 1; ++dy)
                for (int dx = -1; dx <= 1; ++dx) {
                    uint64_t h = cell_hash(c[0] + dx, c[1] + dy, c[2] + dz);
                    auto it = std::lower_bound(cells.begin(), cells.end(), std::make_pair(h, INT32_MIN));
                    for (; it != cells.end() && it->first == h; ++it) {
                        int32_t j = it->second;
                        if (j <= i || (m.co[j] - m.co[i]).len2() > d2) continue;
                        int32_t a = find(i), b = find(j);
                        if (a != b) parent[std::max(a, b)] = std::min(a, b);
                    }
                }
    }
    std::vector<int32_t> map(n);
    for (int32_t i = 0; i < n; ++i) map[i] = find(i);
    remap_faces(m, map);
}

// --------------------------------------------------------------- slivers
// curve.py fold_slivers. A pass's folds touch disjoint vertices, so each is
// decided on the mesh as the pass found it and all are applied after.
int64_t fold_slivers(Mesh& m, const Params& P) {
    int64_t folded = 0;
    for (int64_t pass = 0; pass < P.passes; ++pass) {
        EdgeFaces ef;
        ef.build(m.faces);
        int32_t nv = (int32_t)m.co.size();
        // Each vertex's neighbours (across its faces' edges).
        std::vector<std::vector<int32_t>> ring(nv);
        for (const auto& f : m.faces)
            for (size_t i = 0; i < f.v.size(); ++i) {
                int32_t a = f.v[i], b = f.v[(i + 1) % f.v.size()];
                ring[a].push_back(b);
                ring[b].push_back(a);
            }
        for (auto& r : ring) {
            std::sort(r.begin(), r.end());
            r.erase(std::unique(r.begin(), r.end()), r.end());
        }
        auto collapsible = [&](int32_t v, int32_t w) {
            auto r = ef.of(v, w);
            if (r.second - r.first != 2) return false;
            for (auto* p = r.first; p != r.second; ++p)
                if (m.faces[p->second].v.size() != 3) return false;
            std::vector<int32_t> shared;
            std::set_intersection(ring[v].begin(), ring[v].end(), ring[w].begin(), ring[w].end(),
                                  std::back_inserter(shared));
            return shared.size() == 2;
        };
        std::vector<char> touched(nv, 0);
        std::vector<int32_t> weld(nv);
        std::iota(weld.begin(), weld.end(), 0);
        bool any_weld = false;
        int64_t done = 0;
        for (int32_t fi = 0; fi < (int32_t)m.faces.size(); ++fi) {
            Poly& f = m.faces[fi];
            if (f.v.size() != 3 || touched[f.v[0]] || touched[f.v[1]] || touched[f.v[2]]) continue;
            int k = 0;
            double longest = -1;
            for (int i = 0; i < 3; ++i) {
                double l = (m.co[f.v[(i + 1) % 3]] - m.co[f.v[i]]).len();
                if (l > longest) longest = l, k = i;
            }
            int32_t a = f.v[k], b = f.v[(k + 1) % 3], apex = f.v[(k + 2) % 3];
            auto r = ef.of(a, b);
            if (r.second - r.first != 2) continue;
            V3 ab = m.co[b] - m.co[a];
            double t = (m.co[apex] - m.co[a]).dot(ab) / ab.len2();
            V3 foot = m.co[a] + ab * t;
            if ((m.co[apex] - foot).len() >= P.sliver) continue;
            double L = ab.len();
            int32_t end = t * L < P.sliver ? a : (1 - t) * L < P.sliver ? b : -1;
            if (end >= 0) {
                // A needle, its corner beside one end: merged into that end.
                if (!collapsible(apex, end)) continue;
                weld[apex] = end;
                any_weld = true;
                touched[a] = touched[b] = touched[apex] = 1;
                for (int32_t x : ring[apex]) touched[x] = 1;
                for (int32_t x : ring[end]) touched[x] = 1;
                ++done;
                continue;
            }
            int32_t oi = r.first->second == fi ? (r.first + 1)->second : r.first->second;
            Poly& o = m.faces[oi];
            if (o.v.size() != 3) continue;
            int32_t x = -1;
            for (int32_t v : o.v)
                if (v != a && v != b) x = v;
            if (x < 0 || ef.count(apex, x)) continue;
            // f runs a -> b -> apex, o runs b -> a -> x: the quad a, x, b, apex
            // split along apex - x, the apex on the edge a - b.
            m.co[apex] = foot;
            int64_t src = o.src;
            f.v = {a, x, apex};
            f.src = src;
            o.v = {x, b, apex};
            touched[a] = touched[b] = touched[apex] = touched[x] = 1;
            ++done;
        }
        if (any_weld) remap_faces(m, weld);
        folded += done;
        if (!done) break;
    }
    return folded;
}

// --------------------------------------------------------------- patches
struct FaceInfo {
    V3 normal, median;
    double area;
};

FaceInfo face_info(const Mesh& m, const Poly& f) {
    auto get = [&](int64_t i) -> const V3& { return m.co[f.v[i]]; };
    V3 nw = newell((int64_t)f.v.size(), get);
    FaceInfo fi;
    fi.area = nw.len() / 2;
    fi.normal = nw.normalized();
    V3 s;
    for (int32_t v : f.v) s += m.co[v];
    fi.median = s / (double)f.v.size();
    return fi;
}

// A face's triangles: a constrained Delaunay of its outline in its own plane,
// a fan where that fails.
void triangulate(const Mesh& m, const Poly& f, std::vector<std::array<int32_t, 3>>& out) {
    size_t n = f.v.size();
    if (n == 3) {
        out.push_back({f.v[0], f.v[1], f.v[2]});
        return;
    }
    auto get = [&](int64_t i) -> const V3& { return m.co[f.v[i]]; };
    V3 nrm = newell((int64_t)n, get).normalized();
    V3 u = orthogonal(nrm).normalized(), w = nrm.cross(u).normalized();
    std::vector<CDT::V2d<double>> verts;
    std::vector<CDT::Edge> edges;
    for (size_t i = 0; i < n; ++i) {
        verts.push_back(CDT::V2d<double>(m.co[f.v[i]].dot(u), m.co[f.v[i]].dot(w)));
        edges.emplace_back((CDT::VertInd)i, (CDT::VertInd)((i + 1) % n));
    }
    try {
        CDT::Triangulation<double> cdt(CDT::VertexInsertionOrder::Auto, CDT::IntersectingConstraintEdges::NotAllowed,
                                       0.0);
        cdt.insertVertices(verts);
        cdt.insertEdges(edges);
        cdt.eraseOuterTrianglesAndHoles();
        if (cdt.vertices.size() == n && cdt.pieceToOriginals.empty() && cdt.triangles.size() == n - 2) {
            for (const auto& t : cdt.triangles) out.push_back({f.v[t.vertices[0]], f.v[t.vertices[1]], f.v[t.vertices[2]]});
            return;
        }
    } catch (const std::exception&) {
    }
    // Its outline crosses itself once projected (a strongly bent n-gon): ear
    // clipping, each time the best-shaped ear that is convex and holds no
    // other corner, so no ear along a straight run of cut points has zero area.
    std::vector<int32_t> idx(n);
    std::iota(idx.begin(), idx.end(), 0);
    auto P = [&](int32_t i) { return V2{verts[i].x, verts[i].y}; };
    auto cross = [&](V2 a, V2 b, V2 c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); };
    auto min_angle = [&](V2 a, V2 b, V2 c) {
        auto ang = [](V2 p, V2 q, V2 r) {
            double ux = p.x - q.x, uy = p.y - q.y, wx = r.x - q.x, wy = r.y - q.y;
            return std::fabs(std::atan2(ux * wy - uy * wx, ux * wx + uy * wy));
        };
        return std::min({ang(c, a, b), ang(a, b, c), ang(b, c, a)});
    };
    while (idx.size() > 3) {
        size_t k = idx.size(), best = k;
        double score = -1, widest = -INFINITY;
        size_t widest_at = 0;
        for (size_t i = 0; i < k; ++i) {
            V2 a = P(idx[(i + k - 1) % k]), b = P(idx[i]), c = P(idx[(i + 1) % k]);
            double cr = cross(a, b, c);
            if (cr > widest) widest = cr, widest_at = i;
            if (cr <= 0) continue;
            bool holds = false;
            for (size_t j = 0; j < k && !holds; ++j) {
                if (j == i || j == (i + 1) % k || j == (i + k - 1) % k) continue;
                V2 p = P(idx[j]);
                holds = cross(a, b, p) > 0 && cross(b, c, p) > 0 && cross(c, a, p) > 0;
            }
            if (holds) continue;
            double sc = min_angle(a, b, c);
            if (sc > score) score = sc, best = i;
        }
        if (best == k) best = widest_at;
        out.push_back({f.v[idx[(best + k - 1) % k]], f.v[idx[best]], f.v[idx[(best + 1) % k]]});
        idx.erase(idx.begin() + best);
    }
    out.push_back({f.v[idx[0]], f.v[idx[1]], f.v[idx[2]]});
}

// A patch rebuilt: its new points (3D) and triangles, each corner an existing
// vertex (>= 0) or a new point (-1 - index), and the face under each.
struct Rebuilt {
    bool ok = false;
    std::vector<V3> points;
    std::vector<std::array<int32_t, 3>> tris;
    std::vector<int32_t> under;
    std::vector<uint64_t> keys;  // hashes of the triangles on three existing vertices
    std::vector<std::array<int32_t, 3>> key_tris;
};

uint64_t tri_hash(int32_t a, int32_t b, int32_t c) {
    int32_t s[3] = {a, b, c};
    std::sort(s, s + 3);
    return Rng::mix(((uint64_t)(uint32_t)s[0] << 32 | (uint32_t)s[1]) ^ Rng::mix((uint64_t)(uint32_t)s[2]));
}

// formations/detail.py grid_points: a jittered hexagonal grid at `spacing`
// inside `rings[0]`, outside the holes, `margin` spacings clear of every ring;
// a plane the grid misses gets its deepest point.
std::vector<V2> grid_points(const std::vector<std::vector<V2>>& rings, double spacing, const Params& P, Rng& rng) {
    const auto& poly = rings[0];
    double lx = INFINITY, ly = INFINITY, hx = -INFINITY, hy = -INFINITY;
    for (const V2& p : poly) {
        lx = std::min(lx, p.x), ly = std::min(ly, p.y);
        hx = std::max(hx, p.x), hy = std::max(hy, p.y);
    }
    auto inside = [&](double x, double y) {
        if (!point_in_polygon(x, y, poly)) return false;
        for (size_t h = 1; h < rings.size(); ++h)
            if (point_in_polygon(x, y, rings[h])) return false;
        return true;
    };
    double theta = rng.uniform(0, M_PI);
    double ca = std::cos(theta), sa = std::sin(theta);
    double cx = (lx + hx) / 2, cy = (ly + hy) / 2;
    double reach = std::hypot(hx - lx, hy - ly) / 2 + spacing;
    int64_t rows = (int64_t)(reach / (spacing * std::sqrt(3.0) / 2)) + 1;
    int64_t cols = (int64_t)(reach / spacing) + 1;
    std::vector<V2> out;
    for (int64_t j = -rows; j <= rows; ++j)
        for (int64_t i = -cols; i <= cols; ++i) {
            double jx = rng.uniform(-P.jitter, P.jitter), jy = rng.uniform(-P.jitter, P.jitter);
            double gx = ((double)i + ((j % 2 != 0) ? 0.5 : 0.0)) * spacing + jx * spacing;
            double gy = (double)j * spacing * std::sqrt(3.0) / 2 + jy * spacing;
            double x = cx + gx * ca - gy * sa, y = cy + gx * sa + gy * ca;
            if (x < lx || x > hx || y < ly || y > hy) continue;
            if (!inside(x, y) || ring_distance(x, y, rings) < P.margin * spacing) continue;
            out.push_back({x, y});
        }
    if (out.empty()) {
        double best = -INFINITY;
        V2 deepest;
        for (int k = 0; k < 300; ++k) {
            double x = rng.uniform(lx, hx), y = rng.uniform(ly, hy);
            if (!inside(x, y)) continue;
            double d = ring_distance(x, y, rings);
            if (d > best) best = d, deepest = {x, y};
        }
        if (best > P.deepest) out.push_back(deepest);
    }
    return out;
}

struct Context {
    const Mesh& m;
    const Field& field;
    const Params& P;
    const std::vector<FaceInfo>& info;
    const EdgeFaces& ef;
    const std::vector<int32_t>& owner;  // each face's patch, or -1
    const std::unordered_map<uint64_t, int32_t>& tri_of;  // existing triangles by tri_hash
    uint64_t seed;
};

// The patch's boundary as vertex loops, or false where it touches itself.
bool boundary_loops(const Context& C, int32_t pid, const std::vector<int32_t>& plane,
                    std::vector<std::vector<int32_t>>& loops) {
    std::unordered_map<int32_t, int32_t> step;
    std::vector<int32_t> order;
    for (int32_t f : plane) {
        const auto& v = C.m.faces[f].v;
        for (size_t i = 0; i < v.size(); ++i) {
            int32_t a = v[i], b = v[(i + 1) % v.size()];
            auto r = C.ef.of(a, b);
            int in = 0;
            for (auto* p = r.first; p != r.second; ++p) in += C.owner[p->second] == pid;
            if (in != 1) continue;
            if (!step.emplace(a, b).second) return false;
            order.push_back(a);
        }
    }
    if (step.empty()) return false;
    std::unordered_map<int32_t, char> seen;
    for (int32_t start : order) {
        if (seen.count(start)) continue;
        std::vector<int32_t> out;
        int32_t v = start;
        bool closed = false;
        while (true) {
            if (seen.count(v)) {
                closed = v == start;
                break;
            }
            seen[v] = 1;
            out.push_back(v);
            auto it = step.find(v);
            if (it == step.end()) break;
            v = it->second;
        }
        if (!closed) return false;
        loops.push_back(std::move(out));
    }
    return true;
}

Rebuilt rebuild_patch(const Context& C, int32_t pid, const std::vector<int32_t>& plane) {
    Rebuilt R;
    const Mesh& m = C.m;
    std::vector<std::vector<int32_t>> loops;
    if (!boundary_loops(C, pid, plane, loops)) return R;
    V3 normal;
    for (int32_t f : plane) normal += C.info[f].normal * C.info[f].area;
    normal = normal.normalized();
    V3 origin;
    int64_t count = 0;
    for (const auto& lp : loops)
        for (int32_t v : lp) origin += m.co[v], ++count;
    origin = origin / (double)count;
    V3 u = orthogonal(normal).normalized();
    V3 w = normal.cross(u).normalized();
    auto project = [&](const V3& p) { V3 d = p - origin; return V2{d.dot(u), d.dot(w)}; };
    std::vector<std::vector<V2>> polys;
    for (const auto& lp : loops) {
        std::vector<V2> pl;
        for (int32_t v : lp) pl.push_back(project(m.co[v]));
        polys.push_back(std::move(pl));
    }
    // The outer loop encloses the most area; CCW so the new faces face out.
    std::vector<size_t> order(loops.size());
    std::iota(order.begin(), order.end(), 0);
    std::stable_sort(order.begin(), order.end(),
                     [&](size_t i, size_t j) { return std::fabs(signed_area2(polys[i])) > std::fabs(signed_area2(polys[j])); });
    {
        std::vector<std::vector<int32_t>> l2;
        std::vector<std::vector<V2>> p2;
        for (size_t i : order) l2.push_back(loops[i]), p2.push_back(polys[i]);
        loops.swap(l2);
        polys.swap(p2);
    }
    if (signed_area2(polys[0]) < 0)
        for (size_t i = 0; i < loops.size(); ++i) {
            std::reverse(loops[i].begin(), loops[i].end());
            std::reverse(polys[i].begin(), polys[i].end());
        }
    // A hole wound like the outside is a boundary that folds over itself.
    for (size_t i = 1; i < polys.size(); ++i)
        if (signed_area2(polys[i]) > 0) return R;
    std::vector<int32_t> loop;
    for (const auto& lp : loops) loop.insert(loop.end(), lp.begin(), lp.end());
    double h = INFINITY;
    for (int32_t v : loop) h = std::min(h, C.field.size(m.co[v].data()));
    for (int32_t f : plane) h = std::min(h, C.field.size(C.info[f].median.data()));

    Rng rng(C.seed, (uint64_t)pid);
    std::vector<V2> inside = grid_points(polys, h, C.P, rng);
    // The deepest-point fallback, on a plane under one size across.
    if (!inside.empty() && ring_distance(inside[0].x, inside[0].y, polys) < C.P.margin * h) inside.clear();
    // Thinned to the size where the field bends less (smallest first), kept
    // MARGIN of that size clear of the boundary.
    if (!inside.empty()) {
        std::vector<double> local(inside.size()), clear(inside.size());
        for (size_t i = 0; i < inside.size(); ++i) {
            V3 p = origin + u * inside[i].x + w * inside[i].y;
            local[i] = C.field.size(p.data());
            clear[i] = ring_distance(inside[i].x, inside[i].y, polys);
        }
        std::vector<size_t> idx(inside.size());
        std::iota(idx.begin(), idx.end(), 0);
        std::stable_sort(idx.begin(), idx.end(), [&](size_t i, size_t j) { return local[i] < local[j]; });
        // Kept points in a grid of cells h across: no two are under 0.85 h apart.
        std::unordered_map<uint64_t, std::vector<V2>> grid;
        auto key = [&](int64_t x, int64_t y) { return Rng::mix((uint64_t)x * 0x9e3779b97f4a7c15ull ^ (uint64_t)y); };
        std::vector<V2> kept;
        for (size_t i : idx) {
            V2 p = inside[i];
            double s = local[i];
            if (s > h && clear[i] < C.P.margin * s) continue;
            double r = 0.85 * s;
            int64_t cx = (int64_t)std::floor(p.x / h), cy = (int64_t)std::floor(p.y / h);
            int64_t span = (int64_t)std::ceil(r / h);
            bool near = false;
            for (int64_t y = cy - span; y <= cy + span && !near; ++y)
                for (int64_t x = cx - span; x <= cx + span && !near; ++x) {
                    auto it = grid.find(key(x, y));
                    if (it == grid.end()) continue;
                    for (const V2& q : it->second)
                        if (std::hypot(q.x - p.x, q.y - p.y) < r) {
                            near = true;
                            break;
                        }
                }
            if (near) continue;
            grid[key(cx, cy)].push_back(p);
            kept.push_back(p);
        }
        inside.swap(kept);
    }

    // Constrained Delaunay of the rings and the inside points, the outside
    // and the holes erased.
    std::vector<CDT::V2d<double>> verts;
    std::vector<CDT::Edge> edges;
    for (const auto& pl : polys) {
        CDT::VertInd at = (CDT::VertInd)verts.size();
        for (size_t i = 0; i < pl.size(); ++i) {
            verts.push_back(CDT::V2d<double>(pl[i].x, pl[i].y));
            edges.emplace_back(at + (CDT::VertInd)i, at + (CDT::VertInd)((i + 1) % pl.size()));
        }
    }
    for (const V2& p : inside) verts.push_back(CDT::V2d<double>(p.x, p.y));
    CDT::Triangulation<double> cdt(CDT::VertexInsertionOrder::Auto, CDT::IntersectingConstraintEdges::NotAllowed, 0.0);
    try {
        cdt.insertVertices(verts);
        cdt.insertEdges(edges);
        cdt.eraseOuterTrianglesAndHoles();
    } catch (const std::exception&) {
        return R;
    }
    // A boundary point on another boundary edge splits it: the boundary
    // touches itself, and the patch keeps its faces.
    if (cdt.vertices.size() != verts.size() || !cdt.pieceToOriginals.empty() || cdt.triangles.empty()) return R;

    // The inside points go onto the patch's own faces (nearest), so the
    // surface stays where it was.
    struct Tri {
        V3 a, b, c, lo, hi;
        int32_t face;
    };
    // An n-gon as its own triangles (`triangulate`): a fan of a concave one
    // covers ground outside it, and points snapped there sat off the rock
    // (the river's roof: 160 more slivers and 3 m2 of surface, 2026-11-13).
    std::vector<Tri> tris;
    std::vector<std::array<int32_t, 3>> pieces;
    for (int32_t f : plane) {
        pieces.clear();
        triangulate(m, m.faces[f], pieces);
        for (const auto& pc : pieces) {
            Tri t{m.co[pc[0]], m.co[pc[1]], m.co[pc[2]], {}, {}, f};
            t.lo = {std::min({t.a.x, t.b.x, t.c.x}), std::min({t.a.y, t.b.y, t.c.y}), std::min({t.a.z, t.b.z, t.c.z})};
            t.hi = {std::max({t.a.x, t.b.x, t.c.x}), std::max({t.a.y, t.b.y, t.c.y}), std::max({t.a.z, t.b.z, t.c.z})};
            tris.push_back(t);
        }
    }
    auto nearest = [&](const V3& p, V3* at) {
        double best = INFINITY;
        int32_t face = -1;
        for (const Tri& t : tris) {
            double dx = std::max({t.lo.x - p.x, 0.0, p.x - t.hi.x});
            double dy = std::max({t.lo.y - p.y, 0.0, p.y - t.hi.y});
            double dz = std::max({t.lo.z - p.z, 0.0, p.z - t.hi.z});
            if (dx * dx + dy * dy + dz * dz >= best) continue;
            V3 q = closest_on_triangle(p, t.a, t.b, t.c);
            double d = (q - p).len2();
            if (d < best) {
                best = d;
                face = t.face;
                if (at) *at = q;
            }
        }
        return face;
    };
    size_t nloop = loop.size();
    std::vector<int32_t> vid(verts.size());
    std::vector<V3> pos(verts.size());
    for (size_t i = 0; i < verts.size(); ++i) {
        if (i < nloop) {
            vid[i] = loop[i];
            pos[i] = m.co[loop[i]];
        } else {
            const V2& p = inside[i - nloop];
            V3 at;
            nearest(origin + u * p.x + w * p.y, &at);
            vid[i] = -1 - (int32_t)R.points.size();
            pos[i] = at;
            R.points.push_back(at);
        }
    }
    double area = 0, made = 0;
    for (int32_t f : plane) {
        std::vector<V2> pl;
        for (int32_t v : m.faces[f].v) pl.push_back(project(m.co[v]));
        area += std::fabs(signed_area2(pl)) / 2;
    }
    std::unordered_map<int32_t, char> in_plane;
    for (int32_t f : plane) in_plane[f] = 1;
    for (const auto& t : cdt.triangles) {
        int32_t a = (int32_t)t.vertices[0], b = (int32_t)t.vertices[1], c = (int32_t)t.vertices[2];
        made += std::fabs(signed_area2({{verts[a].x, verts[a].y}, {verts[b].x, verts[b].y}, {verts[c].x, verts[c].y}})) / 2;
        std::array<int32_t, 3> tri = {vid[a], vid[b], vid[c]};
        if (tri[0] >= 0 && tri[1] >= 0 && tri[2] >= 0) {
            // A triangle a neighbour already has would be a second face on
            // the same three points.
            uint64_t k = tri_hash(tri[0], tri[1], tri[2]);
            auto it = C.tri_of.find(k);
            if (it != C.tri_of.end() && !in_plane.count(it->second)) {
                std::array<int32_t, 3> s = tri, o = {m.faces[it->second].v[0], m.faces[it->second].v[1],
                                                     m.faces[it->second].v[2]};
                std::sort(s.begin(), s.end());
                std::sort(o.begin(), o.end());
                if (s == o) return R;
            }
            R.keys.push_back(k);
            std::array<int32_t, 3> s = tri;
            std::sort(s.begin(), s.end());
            R.key_tris.push_back(s);
        }
        R.tris.push_back(tri);
        R.under.push_back(nearest((pos[a] + pos[b] + pos[c]) / 3.0, nullptr));
    }
    if (std::fabs(made - area) > 1e-3 * area + 1e-6) return R;
    R.ok = true;
    return R;
}

struct Result {
    std::vector<double> co;
    std::vector<int32_t> tris;
    std::vector<int64_t> face_src;
    std::vector<int64_t> vert_src;
    int64_t stats[4] = {0, 0, 0, 0};  // rebuilt, kept, folded, faces before
};

}  // namespace
}  // namespace rk

using namespace rk;

extern "C" {

// curve.py rebuild on a mesh given as arrays (vertex coordinates; faces as
// starts into a corner-vertex array). params: merge, sliver, smooth angle and
// patch angle (degrees), margin, jitter, deepest, fold passes.
void* rk_crease_rebuild(const void* field_handle, int64_t nverts, const double* co, int64_t nfaces,
                        const int64_t* face_start, const int32_t* corner_verts, uint64_t seed, const double* params) {
    const Field& field = *static_cast<const Field*>(field_handle);
    Params P{params[0], params[1], params[2], params[3], params[4], params[5], params[6], (int64_t)params[7]};
    Mesh m;
    m.co.resize(nverts);
    for (int64_t i = 0; i < nverts; ++i) m.co[i] = V3(&co[3 * i]);
    m.faces.resize(nfaces);
    for (int64_t f = 0; f < nfaces; ++f) {
        m.faces[f].v.assign(corner_verts + face_start[f], corner_verts + face_start[f + 1]);
        m.faces[f].src = f;
    }
    auto* R = new Result();
    R->stats[3] = nfaces;
    remove_doubles(m, P.merge);
    R->stats[2] = fold_slivers(m, P);

    // Cut the edges the field reaches into pieces no longer than the size at
    // them, in both faces either side.
    EdgeFaces ef;
    ef.build(m.faces);
    std::vector<std::pair<int32_t, int32_t>> manifold;  // each edge once, in the order the faces meet it
    {
        std::vector<uint64_t> keys;
        for (size_t i = 0; i < ef.e.size();) {
            size_t j = i;
            while (j < ef.e.size() && ef.e[j].first == ef.e[i].first) ++j;
            if (j - i == 2) keys.push_back(ef.e[i].first);
            i = j;
        }
        manifold.resize(keys.size());
        for (size_t i = 0; i < keys.size(); ++i)
            manifold[i] = {(int32_t)(keys[i] >> 32), (int32_t)(keys[i] & 0xffffffffu)};
    }
    std::vector<int32_t> cuts(manifold.size(), 0);
#pragma omp parallel for schedule(dynamic, 256)
    for (int64_t i = 0; i < (int64_t)manifold.size(); ++i) {
        const V3& a = m.co[manifold[i].first];
        const V3& b = m.co[manifold[i].second];
        bool hit = false;
        double size = INFINITY;
        for (int s = 0; s < 5; ++s) {
            V3 p = a + (b - a) * (s / 4.0);
            hit |= field.reaches(p.data());
            size = std::min(size, field.size(p.data()));
        }
        int32_t n = (int32_t)std::ceil((b - a).len() / size) - 1;
        cuts[i] = hit && n >= 1 ? n : 0;
    }
    std::unordered_map<uint64_t, std::pair<int32_t, int32_t>> cut_at;  // edge -> (first new vertex, count)
    for (size_t i = 0; i < manifold.size(); ++i) {
        if (!cuts[i]) continue;
        auto [a, b] = manifold[i];
        int32_t first = (int32_t)m.co.size();
        for (int32_t k = 1; k <= cuts[i]; ++k) m.co.push_back(m.co[a] + (m.co[b] - m.co[a]) * ((double)k / (cuts[i] + 1)));
        cut_at[edge_key(a, b)] = {first, cuts[i]};
    }
    for (auto& f : m.faces) {
        std::vector<int32_t> v;
        for (size_t i = 0; i < f.v.size(); ++i) {
            int32_t a = f.v[i], b = f.v[(i + 1) % f.v.size()];
            v.push_back(a);
            auto it = cut_at.find(edge_key(a, b));
            if (it == cut_at.end()) continue;
            auto [first, n] = it->second;
            // The new points run from the edge's lower vertex to its higher.
            if (a < b)
                for (int32_t k = 0; k < n; ++k) v.push_back(first + k);
            else
                for (int32_t k = n - 1; k >= 0; --k) v.push_back(first + k);
        }
        f.v.swap(v);
    }
    ef.build(m.faces);

    std::vector<FaceInfo> info(m.faces.size());
    std::vector<char> reached(m.faces.size(), 0);
#pragma omp parallel for schedule(dynamic, 256)
    for (int64_t f = 0; f < (int64_t)m.faces.size(); ++f) {
        info[f] = face_info(m, m.faces[f]);
        // A face with a cut edge is rebuilt even where only the edge is reached.
        bool r = m.faces[f].v.size() > 3 || field.reaches(info[f].median.data());
        for (int32_t v : m.faces[f].v) r = r || field.reaches(m.co[v].data());
        reached[f] = r;
    }

    // Patches: grown from the largest face across folds under the smooth
    // angle to faces within the patch angle of it.
    double fold = std::cos(P.smooth_angle * M_PI / 180), limit = std::cos(P.patch_angle * M_PI / 180);
    std::vector<int32_t> seeds;
    for (int32_t f = 0; f < (int32_t)m.faces.size(); ++f)
        if (reached[f]) seeds.push_back(f);
    std::stable_sort(seeds.begin(), seeds.end(), [&](int32_t a, int32_t b) { return info[a].area > info[b].area; });
    std::vector<int32_t> owner(m.faces.size(), -1);
    std::vector<std::vector<int32_t>> planes;
    for (int32_t s : seeds) {
        if (owner[s] >= 0) continue;
        int32_t pid = (int32_t)planes.size();
        std::vector<int32_t> plane = {s}, stack = {s};
        owner[s] = pid;
        while (!stack.empty()) {
            int32_t f = stack.back();
            stack.pop_back();
            const auto& v = m.faces[f].v;
            for (size_t i = 0; i < v.size(); ++i) {
                auto r = ef.of(v[i], v[(i + 1) % v.size()]);
                for (auto* p = r.first; p != r.second; ++p) {
                    int32_t g = p->second;
                    if (owner[g] >= 0 || !reached[g] || info[g].normal.dot(info[f].normal) < fold ||
                        info[g].normal.dot(info[s].normal) < limit)
                        continue;
                    owner[g] = pid;
                    plane.push_back(g);
                    stack.push_back(g);
                }
            }
        }
        planes.push_back(std::move(plane));
    }
    std::unordered_map<uint64_t, int32_t> tri_of;
    for (int32_t f = 0; f < (int32_t)m.faces.size(); ++f)
        if (m.faces[f].v.size() == 3) tri_of[tri_hash(m.faces[f].v[0], m.faces[f].v[1], m.faces[f].v[2])] = f;

    Context C{m, field, P, info, ef, owner, tri_of, seed};
    std::vector<Rebuilt> done(planes.size());
#pragma omp parallel for schedule(dynamic, 1)
    for (int64_t p = 0; p < (int64_t)planes.size(); ++p) done[p] = rebuild_patch(C, (int32_t)p, planes[p]);

    // In patch order: a patch whose triangle another already made keeps its faces.
    std::unordered_map<uint64_t, std::vector<std::array<int32_t, 3>>> claimed;
    std::vector<char> accepted(planes.size(), 0);
    for (size_t p = 0; p < planes.size(); ++p) {
        Rebuilt& r = done[p];
        if (!r.ok || r.tris.empty()) {
            ++R->stats[1];
            continue;
        }
        bool clash = false;
        for (size_t k = 0; k < r.keys.size() && !clash; ++k) {
            auto it = claimed.find(r.keys[k]);
            if (it != claimed.end())
                for (const auto& t : it->second) clash = clash || t == r.key_tris[k];
        }
        if (clash) {
            ++R->stats[1];
            continue;
        }
        for (size_t k = 0; k < r.keys.size(); ++k) claimed[r.keys[k]].push_back(r.key_tris[k]);
        accepted[p] = 1;
        ++R->stats[0];
    }

    // The mesh: every face not in a rebuilt patch (triangulated), then each
    // rebuilt patch's triangles; only the vertices a face uses.
    std::vector<std::array<int32_t, 3>> tris;
    std::vector<int64_t> src;
    std::vector<V3> co_all = m.co;
    std::vector<int64_t> vsrc(m.co.size());
    for (size_t i = 0; i < m.co.size(); ++i) vsrc[i] = i < (size_t)nverts ? (int64_t)i : -1;
    for (size_t f = 0; f < m.faces.size(); ++f) {
        if (owner[f] >= 0 && accepted[owner[f]]) continue;
        size_t before = tris.size();
        triangulate(m, m.faces[f], tris);
        src.insert(src.end(), tris.size() - before, m.faces[f].src);
    }
    for (size_t p = 0; p < planes.size(); ++p) {
        if (!accepted[p]) continue;
        const Rebuilt& r = done[p];
        int32_t base = (int32_t)co_all.size();
        co_all.insert(co_all.end(), r.points.begin(), r.points.end());
        vsrc.insert(vsrc.end(), r.points.size(), -1);
        for (size_t t = 0; t < r.tris.size(); ++t) {
            std::array<int32_t, 3> tri;
            for (int k = 0; k < 3; ++k) tri[k] = r.tris[t][k] >= 0 ? r.tris[t][k] : base + (-1 - r.tris[t][k]);
            tris.push_back(tri);
            src.push_back(m.faces[r.under[t]].src);
        }
    }
    std::vector<int32_t> remap(co_all.size(), -1);
    for (auto& t : tris)
        for (int k = 0; k < 3; ++k) {
            if (remap[t[k]] < 0) {
                remap[t[k]] = (int32_t)(R->co.size() / 3);
                R->co.insert(R->co.end(), {co_all[t[k]].x, co_all[t[k]].y, co_all[t[k]].z});
                R->vert_src.push_back(vsrc[t[k]]);
            }
            R->tris.push_back(remap[t[k]]);
        }
    R->face_src = std::move(src);
    return R;
}

int64_t rk_crease_result_sizes(const void* r, int64_t* out) {
    const Result* R = static_cast<const Result*>(r);
    out[0] = (int64_t)R->co.size() / 3;
    out[1] = (int64_t)R->tris.size() / 3;
    for (int k = 0; k < 4; ++k) out[2 + k] = R->stats[k];
    return 0;
}

void rk_crease_result_copy(const void* r, double* co, int32_t* tris, int64_t* face_src, int64_t* vert_src) {
    const Result* R = static_cast<const Result*>(r);
    std::memcpy(co, R->co.data(), R->co.size() * sizeof(double));
    std::memcpy(tris, R->tris.data(), R->tris.size() * sizeof(int32_t));
    std::memcpy(face_src, R->face_src.data(), R->face_src.size() * sizeof(int64_t));
    std::memcpy(vert_src, R->vert_src.data(), R->vert_src.size() * sizeof(int64_t));
}

void rk_crease_result_free(void* r) { delete static_cast<Result*>(r); }

}  // extern "C"
