"""C. baseline: a solid smoothed cushion (what the earlier tooling produced), no leaves."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C, bpy, numpy as np
C.clear(); sc = C.setup_scene(); rock = C.build_rock()
V, T, FN, A, VN = C.rock_arrays(rock)
Vs, Tr, W, HN, lift = C.cushion_patch(V, T, FN, VN, C.default_stamps(V), thick=0.12)
cols = C.tint(HN, 1 - lift, np.zeros(len(Vs)))
# recompute normals from the cushion itself: it is a solid surface
me_n = np.zeros_like(Vs)
for a, b, c in Tr:
    n = np.cross(Vs[b] - Vs[a], Vs[c] - Vs[a]); me_n[[a, b, c]] += n
me_n /= np.linalg.norm(me_n, axis=1, keepdims=True) + 1e-9
ob = C.mesh_from_tris("mossCushion", Vs, Tr, me_n, cols, C.flat_moss_material())
C.report("c_cushion", [rock, ob])
