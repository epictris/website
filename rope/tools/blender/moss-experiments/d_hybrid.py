"""D. hybrid: a thin dark underlay cushion + small leaf cards in two layers + hanging strands."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C, bpy, numpy as np, random, math
from mathutils import Vector
from mathutils.bvhtree import BVHTree

DENSITY = float(os.environ.get("DENSITY", 1500)); THICK = 0.10; CARD = (0.085, 0.125)
STRANDS = int(os.environ.get("STRANDS", 6)); NAME = os.environ.get("NAME", "d_hybrid")
C.clear(); sc = C.setup_scene(); rock = C.build_rock()
V, T, FN, A, VN = C.rock_arrays(rock)
stamps = C.default_stamps(V)
rnd = random.Random(11)
# 1. underlay: a 3 cm dark cushion so a gap between leaves reads as shade, not rock
Vs, Tr, W, HN, lift = C.cushion_patch(V, T, FN, VN, stamps, thick=0.05, smooth=4, thresh=0.52)
ucol = C.tint(HN, np.full(len(Vs), 0.15), np.zeros(len(Vs)), C.tone_at(Vs))   # the same colour as an outer leaf: where it shows it IS moss
under = C.mesh_from_tris("mossUnder", Vs, Tr, HN, ucol, C.flat_moss_material("mossUnder"))
# 2. cards
P, N, S, M = C.sample_surface(V, T, FN, A, VN, stamps, DENSITY, rnd)
Q, QN, QC, QUV = [], [], [], []
def add_card(centre, hn, tilt_max, size, depth, var, base=None):
    axis = np.cross(hn, [rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1)]); axis /= np.linalg.norm(axis) + 1e-9
    ang = math.radians(rnd.uniform(0, tilt_max))
    n = hn * math.cos(ang) + np.cross(axis, hn) * math.sin(ang)
    q = C.card(centre, n, np.array([0, 0, 1.0]), size, size * rnd.uniform(0.85, 1.0), rnd)
    col = C.tint(np.repeat(hn[None], 4, 0), np.full(4, depth), np.full(4, var), None if base is None else np.repeat(base[None], 4, 0))
    Q.append(q); QN.append(np.repeat(hn[None], 4, 0)); QC.append(col); QUV.append(C.uv_cell(rnd))
for p, fn, sn, m in zip(P, N, S, M):
    hn = C.hull_normal(p, sn, radial=0.5)
    thick = THICK * (0.45 + 0.55 * m)
    base = C.tone_at(p)[0]
    n_cards = 3 if m < 0.65 else 2                     # a thicker fringe where the underlay ends
    for j in range(n_cards):
        d = 0.025 + rnd.random() ** 0.8 * (thick - 0.025)
        jit = np.random.default_rng(rnd.randrange(1 << 30)).normal(0, 0.02, 3); jit -= hn * (jit @ hn)
        add_card(p + hn * d + jit, hn, 30, rnd.uniform(*CARD), 1 - d / thick, rnd.uniform(-0.12, 0.12), base)
# 3. strands: from front-facing points at the mask's lower edge, a leafy string hangs down
bvh = BVHTree.FromObject(rock, bpy.context.evaluated_depsgraph_get())
front = [(p, s) for p, n, s, m in zip(P, N, S, M) if n[1] < -0.55 and 0.35 < m < 0.7 and p[2] > -0.1]
rnd.shuffle(front)
stem_q = []
for p, s in front[:STRANDS]:
    hn = C.hull_normal(p, s, radial=0.5)
    length = rnd.uniform(0.28, 0.6); step = 0.03; n_seg = int(length / step)
    sway = rnd.uniform(0.008, 0.02); phase = rnd.uniform(0, 6)
    pts = []
    for k in range(n_seg + 1):
        q = p + np.array([sway * math.sin(k * 0.35 + phase), -0.02 - 0.02 * k / n_seg, -k * step])
        loc, nrm, idx, dist = bvh.find_nearest(Vector(q))
        if loc is not None and (Vector(q) - loc).dot(nrm) < 0.03:      # inside or grazing the rock: push out
            q = np.array(loc + nrm * 0.03)
        pts.append(q)
    pts = np.array(pts)
    for k in range(n_seg):                                        # stem: a thin dark ribbon facing the camera
        a, b = pts[k], pts[k + 1]; side = np.array([0.002, 0, 0])
        stem_q.append((np.array([a - side, a + side, b + side, b - side]), hn))
    sbase = C.tone_at(p)[0]
    for k in range(1, n_seg + 1, 1):
        for sgn in (-1, 1):
            if rnd.random() < 0.8:
                t = k / n_seg; size = rnd.uniform(0.07, 0.09) * (1 - 0.35 * t)
                off = np.array([sgn * size * 0.3, 0, rnd.uniform(-0.01, 0.01)])
                face = np.array([0, -1.0, 0]) * 0.6 + hn * 0.4
                add_card(pts[k] + off, face / np.linalg.norm(face), 35, size, 0.2 + 0.4 * rnd.random(), rnd.uniform(-0.1, 0.1), sbase)
Q, QN, QC, QUV = map(np.array, (Q, QN, QC, QUV))
atlas = C.leaf_atlas(os.path.join(C.OUT, "leaf_atlas.png"))
cards = C.mesh_from_quads("mossCards", Q, QN, QC, QUV, C.leaf_material(atlas))
cards.visible_shadow = False        # the cards cast no shadow: the tone gradient carries the depth, as in the reference
objs = [rock, under, cards]
if stem_q:
    SQ = np.array([q for q, _ in stem_q]); SN = np.array([np.repeat(h[None], 4, 0) for _, h in stem_q])
    SC = np.tile(C.TONES[1] * 0.55, (len(SQ), 4, 1)); SU = np.zeros((len(SQ), 4, 2))
    stems = C.mesh_from_quads("mossStems", SQ, SN, SC, SU, C.flat_moss_material("mossStem"))
    objs.append(stems)
C.report(NAME, objs, {"clusters": int(len(P)), "cards": int(len(Q)), "strands": min(STRANDS, len(front))})

C.render(NAME + "_under", "under"); C.render(NAME + "_close", "close")
