"""E. paper cutouts: one flat-coloured blob per card, nine silhouettes, every card facing the
game's camera so the cards are parallel planes stacked in depth and never cut through each other.
Over the same underlay and strands as D."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C, bpy, numpy as np, random, math
from mathutils import Vector
from mathutils.bvhtree import BVHTree

DENSITY = float(os.environ.get("DENSITY", 6000)); THICK = 0.07; CARD = (0.07, 0.13)
STRANDS = int(os.environ.get("STRANDS", 6)); NAME = os.environ.get("NAME", "e_cutout")
FACE = np.array([0, -1.0, 0])
C.clear(); sc = C.setup_scene(); C.game_views(sc); rock = C.build_rock()
V, T, FN, A, VN = C.rock_arrays(rock)
stamps = C.default_stamps(V)
rnd = random.Random(11)
Vs, Tr, W, HN, lift = C.cushion_patch(V, T, FN, VN, stamps, thick=0.02, smooth=4, thresh=0.33)   # out to where the cards begin: no bare rock under the shoulder
ucol = C.tint(HN, np.full(len(Vs), 0.15), np.zeros(len(Vs)), C.tone_at(Vs))
under = C.mesh_from_tris("mossUnder", Vs, Tr, HN, ucol, C.flat_moss_material("mossUnder"))
under.visible_shadow = False        # nothing in the moss casts a shadow: a lifted fold of the underlay shadowed the cards below it (a black hole)
P, N, S, M = C.sample_surface(V, T, FN, A, VN, stamps, DENSITY, rnd)
Q, QN, QC, QUV = [], [], [], []
LAYERS = [0.008 + 0.0088 * i for i in range(8)]  # card heights above the rock: 0.8 to 7 cm
SUBH = 0.002                                      # three sub-heights inside a layer, 2 mm apart
FILL = 1.8                                        # blob area laid per layer, as a multiple of the layer's area
def add_blob(centre, n, hn, size, depth, var, base, cell=None, spin=None, aspect=None):
    """one flat-coloured blob: a quad with normal n, shaded with hn."""
    q = C.card(centre, n, np.array([0, 0, 1.0]), size, size * (aspect or rnd.uniform(0.85, 1.0)), rnd, spin)
    col = C.tint(np.repeat(hn[None], 4, 0), np.full(4, depth), np.full(4, var), np.repeat(base[None], 4, 0))
    Q.append(q); QN.append(np.repeat(hn[None], 4, 0)); QC.append(col); QUV.append(C.uv_cell_index(rnd.choice(C.BLOB_CELLS) if cell is None else cell, 3))
FACING_MIN = 0.5                                  # every card faces the game's camera by at least 30 deg
def leaned(n):
    """the card's plane, rotated the least that makes it face the camera by FACING_MIN: a card seen
    nearly edge-on is a spike, not a blob. A smooth rule, so neighbours still share a plane."""
    d = float(n @ FACE)
    if d >= FACING_MIN: return n
    # rotate n toward FACE in their common plane until the dot is FACING_MIN
    perp = FACE - n * d; np_ = np.linalg.norm(perp)
    if np_ < 1e-6: return n
    perp /= np_
    ang = math.acos(max(-1.0, min(1.0, d))) - math.acos(FACING_MIN)
    m = n * math.cos(ang) + perp * math.sin(ang)
    return m / np.linalg.norm(m)
HNs = np.array([C.hull_normal(p, sn, radial=0.5) for p, sn in zip(P, S)])
Mn = np.clip((M - 0.35) / 0.5, 0, 1)                     # 0 at the painted edge, 1 well inside
# the outward direction of the paint at every candidate: down the mask's gradient, in the tangent plane
def outward(i):
    hn = HNs[i]; t1 = np.cross(hn, [0, 0, 1.0]);
    if np.linalg.norm(t1) < 1e-3: t1 = np.cross(hn, [1.0, 0, 0])
    t1 /= np.linalg.norm(t1); t2 = np.cross(hn, t1); eps = 0.02
    m0, m1, m2 = C.stamp_mask(np.array([P[i], P[i] + t1 * eps, P[i] + t2 * eps]), np.repeat(S[i][None], 3, 0), stamps)
    g = t1 * (m1 - m0) / eps + t2 * (m2 - m0) / eps
    n = np.linalg.norm(g)
    return -g / n if n > 0.2 else None
EDGE_BAND = 0.5                                   # the outer band of the paint, in mask units, is a rounded shoulder
OUT = [outward(i) if Mn[i] < EDGE_BAND else None for i in range(len(P))]
def shoulder(i, dL):
    """where a card at layer height dL sits in the outer band, and which way it faces.
    The mass's edge is a quarter-round of radius THICK: flat on top of the mass, standing against
    the rock at the paint's boundary. A card on that surface takes its normal; a card below it
    tilts in proportion to its depth, so the layers nest like the rings of a rolled edge."""
    hn = HNs[i]; o = OUT[i]
    if o is None or Mn[i] >= EDGE_BAND: return P[i] + hn * dL, hn, True
    o = o - hn * (o @ hn); no = np.linalg.norm(o)
    if no < 1e-6: return P[i] + hn * dL, hn, True
    o /= no
    x = Mn[i] / EDGE_BAND                             # 0 at the boundary, 1 where the shoulder meets the flat top
    phi = min(math.radians(65), math.asin(1 - x))     # the quarter-round's normal angle, capped: a fully vertical card is a fin seen edge-on
    h_surface = THICK * math.cos(phi)                 # the mass's height here
    if dL > max(h_surface, 0.012): return None, None, False
    f = min(1.0, dL / max(h_surface, 0.012))          # deep cards tilt less than the surface card
    a = phi * f
    n = hn * math.cos(a) + o * math.sin(a)
    c = P[i] + hn * dL * math.cos(a) + o * dL * math.sin(a) * 0.3
    return c, n / np.linalg.norm(n), True
cellsz = 0.06; keys = np.floor(P / cellsz).astype(int)
from collections import defaultdict
buckets = defaultdict(list)
for i, k in enumerate(map(tuple, keys)): buckets[k].append(i)
crowd = np.zeros(len(P), int)
for i, k in enumerate(map(tuple, keys)):
    near = [j for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1) for j in buckets.get((k[0] + dx, k[1] + dy, k[2] + dz), ())]
    crowd[i] = int((np.linalg.norm(P[near] - P[i], axis=1) < cellsz).sum())
seen = (HNs[:, 1] <= 0.35) & (crowd >= 4)                 # the game never sees the back of the rock
idx = [i for i in range(len(P)) if seen[i]]
area = len(P) / DENSITY                                   # the painted area, from the sampling density
for L, dL in enumerate(LAYERS):
    rnd.shuffle(idx)
    allowed = [i for i in idx if dL <= THICK and shoulder(i, dL)[2]]
    if not allowed: continue
    mean_size = (CARD[0] + CARD[1]) / 2 * (0.6 + 0.4 * float(np.mean(Mn[allowed])))
    want = FILL * area * (len(allowed) / len(idx)) / (math.pi * (mean_size / 2) ** 2)
    p_take = min(1.0, want / len(allowed))
    for j, i in enumerate(allowed):
        if rnd.random() > p_take: continue
        size = rnd.uniform(*CARD) * (0.6 + 0.4 * Mn[i])                # smaller blobs at the edge
        c, n, ok = shoulder(i, dL + SUBH * (j % 3))
        if not ok: continue
        n = leaned(n)
        add_blob(c, n, HNs[i], size, max(0.0, 1 - L / 4) * Mn[i], rnd.uniform(-0.16, 0.16), C.tone_at(P[i])[0])
bvh = BVHTree.FromObject(rock, bpy.context.evaluated_depsgraph_get())
front = [(p, s) for p, n, s, m in zip(P, N, S, M) if n[1] < -0.55 and 0.35 < m < 0.7 and p[2] > -0.1]
rnd.shuffle(front)
stem_q = []
for p, s in front[:STRANDS]:
    hn = C.hull_normal(p, s, radial=0.5)
    length = rnd.uniform(0.4, 0.7); sway = rnd.uniform(0.006, 0.015); phase = rnd.uniform(0, 6)
    def at(z, clear=0.02):                            # the stem's point z metres below the start, held in FRONT of the rock
        q = p + np.array([sway * math.sin(z * 12 + phase), -0.02 - 0.03 * z / length, -z])
        hit = bvh.ray_cast(Vector((q[0], -5.0, q[2])), Vector((0, 1, 0)))   # the rock's front-most surface at this x,z
        if hit[0] is not None: q[1] = min(q[1], hit[0].y - clear)
        return q
    zs = np.linspace(0.09, length, int((length - 0.09) / 0.03) + 1); pts = np.array([at(z) for z in zs])   # the stem starts below the collar
    if os.environ.get('DEBUG'): print('VINE start', np.round(p, 3), 'stem', np.round(pts[0], 3), np.round(pts[len(pts)//2], 3), np.round(pts[-1], 3))
    for k in range(len(pts) - 1):
        a, b = pts[k], pts[k + 1]; side = np.array([0.0015, 0, 0])
        stem_q.append((np.array([a - side, a + side, b + side, b - side]), hn))
    sbase = C.tone_at(p)[0]
    S0, S1 = rnd.uniform(0.07, 0.085), 0.022            # leaf length at the top and at the tip
    z = 0.07; sgn = rnd.choice([-1, 1]); i = 0
    while z < length:
        t = z / length; size = S0 + (S1 - S0) * t
        c = at(z + size * 0.42, clear=0.03 + 0.004 * (i % 2 + 1)) + np.array([sgn * size * 0.24, 0, 0])   # hangs from its base on the stem, in front of the rock
        spin = sgn * math.radians(rnd.uniform(15, 28))                                  # tip down, leaning out
        vn = hn * 0.5 + FACE * 0.5; vn /= np.linalg.norm(vn)
        add_blob(c, vn, hn, size * 0.8, 0.1 + 0.4 * t, rnd.uniform(-0.1, 0.1), sbase, cell=rnd.choice(C.LEAF_CELLS), spin=spin, aspect=1 / 0.8)
        z += size * 0.62; sgn = -sgn; i += 1
Q, QN, QC, QUV = map(np.array, (Q, QN, QC, QUV))
atlas = C.angular_atlas(os.path.join(C.OUT, "angular_atlas.png"))
cards = C.mesh_from_quads("mossCards", Q, QN, QC, QUV, C.leaf_material(atlas, "mossCutout"))
cards.visible_shadow = False
objs = [rock, under, cards]
if stem_q:
    SQ = np.array([q for q, _ in stem_q]); SN = np.array([np.repeat(h[None], 4, 0) for _, h in stem_q])
    SC = np.tile(C.TONES[1] * 0.75, (len(SQ), 4, 1)); SU = np.zeros((len(SQ), 4, 2))
    stems = C.mesh_from_quads("mossStems", SQ, SN, SC, SU, C.flat_moss_material("mossStem")); stems.visible_shadow = False
    objs.append(stems)
C.report(NAME, objs, {"clusters": int(len(P)), "cards": int(len(Q)), "strands": min(STRANDS, len(front))})
C.game_views(sc, "close"); C.render(NAME + "_close")
C.game_views(sc, "under"); C.render(NAME + "_under")
