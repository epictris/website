// Bounded convex-cell corners. Same three-plane intersections/tolerances as
// solidfit.halfspaces, without allocating/solving thousands of tiny matrices.
#include "kernels.h"
#include <cmath>
#include <algorithm>
#include "bvh.h"

namespace {
struct V { double x, y, z; };
V cross(V a, V b) { return {a.y*b.z-a.z*b.y, a.z*b.x-a.x*b.z, a.x*b.y-a.y*b.x}; }
double dot(V a, V b) { return a.x*b.x+a.y*b.y+a.z*b.z; }
V normal(const double* p) { return {p[0], p[1], p[2]}; }
}

extern "C" int64_t rk_cell_corners(int64_t count, const double* planes, double* out) {
    int64_t found = 0;
    for (int64_t i=0; i<count; ++i) for (int64_t j=i+1; j<count; ++j) {
        const auto a=normal(planes+4*i), b=normal(planes+4*j);
        const auto ab=cross(a,b);
        for (int64_t k=j+1; k<count; ++k) {
            const auto c=normal(planes+4*k);
            const double determinant=dot(ab,c);
            if (std::abs(determinant)<=1e-12) continue;
            const auto bc=cross(b,c), ca=cross(c,a);
            const double u=planes[4*i+3], v=planes[4*j+3], w=planes[4*k+3];
            const V x{(u*bc.x+v*ca.x+w*ab.x)/determinant,
                      (u*bc.y+v*ca.y+w*ab.y)/determinant,
                      (u*bc.z+v*ca.z+w*ab.z)/determinant};
            bool inside=true;
            for (int64_t q=0; q<count; ++q) {
                if (dot(normal(planes+4*q),x)>planes[4*q+3]+1e-7) { inside=false; break; }
            }
            if (inside) { out[3*found]=x.x; out[3*found+1]=x.y; out[3*found+2]=x.z; ++found; }
        }
    }
    return found;
}

extern "C" int32_t rk_cell_meets_surface(const void* handle, int64_t count, const double* planes,
                                         const double* lo, const double* hi) {
    const auto& tree=*static_cast<const rk::Bvh*>(handle);
    if (tree.nodes.empty()) return 0;
    constexpr double padding=1e-4;
    std::vector<int32_t> stack{0};
    std::vector<rk::V3> poly, next;
    poly.reserve(count+3); next.reserve(count+3);
    while (!stack.empty()) {
        const auto node=tree.nodes[stack.back()]; stack.pop_back();
        bool outside=false;
        for (int axis=0; axis<3; ++axis)
            outside |= node.hi[axis]<lo[axis]-padding || node.lo[axis]>hi[axis]+padding;
        if (outside) continue;
        if (node.left>=0) { stack.push_back(node.left); stack.push_back(node.left+1); continue; }
        for (int j=0; j<node.count; ++j) {
            const int tri=tree.order[node.first+j];
            poly.clear();
            for (int k=0; k<3; ++k) poly.push_back(tree.co[tree.tris[3*tri+k]]);
            for (int64_t p=0; p<count && !poly.empty(); ++p) {
                const rk::V3 n(planes+4*p);
                const double offset=planes[4*p+3]+padding;
                next.clear();
                auto a=poly.back(); double da=n.dot(a)-offset;
                for (const auto& b:poly) {
                    const double db=n.dot(b)-offset;
                    if ((da<=0)!=(db<=0)) next.push_back(a+(b-a)*(da/(da-db)));
                    if (db<=0) next.push_back(b);
                    a=b; da=db;
                }
                poly.swap(next);
            }
            if (!poly.empty()) return 1;
        }
    }
    return 0;
}
