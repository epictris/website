"""A. leaf-card clusters scattered by the stamp mask, shaded with hull normals."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C, bpy, numpy as np, random, math

DENSITY = float(os.environ.get("DENSITY", 520))   # clusters per m^2 at full mask
THICK = 0.13                                       # collar thickness at full mask
CARD = (0.075, 0.11)                               # leaf clump size range (m)
RADIAL = float(os.environ.get("RADIAL", 0.5))

C.clear(); sc = C.setup_scene(); rock = C.build_rock()
V, T, FN, A, VN = C.rock_arrays(rock)
rnd = random.Random(7)
P, N, S, M = C.sample_surface(V, T, FN, A, VN, C.default_stamps(V), DENSITY, rnd)
print("clusters", len(P))
Q, QN, QC, QUV = [], [], [], []
for p, fn, sn, m in zip(P, N, S, M):
    hn = C.hull_normal(p, sn, radial=RADIAL)
    thick = THICK * (0.4 + 0.6 * m)
    k = 2 + (rnd.random() < 0.6)
    for j in range(k):
        d = rnd.random() ** 0.7 * thick                     # more leaves toward the outside
        jitter = np.random.default_rng(rnd.randrange(1 << 30)).normal(0, 0.025, 3)
        jitter -= hn * (jitter @ hn)
        centre = p + hn * (0.02 + d) + jitter
        # the card faces roughly outward, tilted a random amount
        axis = np.cross(hn, [rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1)]); axis /= np.linalg.norm(axis) + 1e-9
        ang = math.radians(rnd.uniform(0, 60))
        n = hn * math.cos(ang) + np.cross(axis, hn) * math.sin(ang)
        s = rnd.uniform(*CARD)
        q = C.card(centre, n, np.array([0, 0, 1.0]), s, s * rnd.uniform(0.8, 1.0), rnd)
        depth = 1 - d / thick
        col = C.tint(np.repeat(hn[None], 4, 0), np.full(4, depth), np.full(4, rnd.uniform(-0.12, 0.12)))
        Q.append(q); QN.append(np.repeat(hn[None], 4, 0)); QC.append(col); QUV.append(C.uv_cell(rnd))
Q, QN, QC, QUV = map(np.array, (Q, QN, QC, QUV))
atlas = C.leaf_atlas(os.path.join(C.OUT, "leaf_atlas.png"))
moss = C.mesh_from_quads("mossCards", Q, QN, QC, QUV, C.leaf_material(atlas))
C.report(os.environ.get("NAME", "a_cards"), [rock, moss], {"clusters": int(len(P)), "cards": int(len(Q))})
