"""Moss carpet study: a painterly moss carpet over rock-b.

The rock is recipe F with the painted slate shader under the v6 rig (docs/cave-look.md),
built by rock_study.py; this script grows the carpet and tries surfaces on it.

    blender -b --python moss_study.py -- --surface paint --views 3q,top
    blender -b --python moss_study.py -- --surface all

Geometry (`--geom`):
    cushion   a smooth shell over the painted mask, thickness tapering to a quarter-round
              shoulder, scalloped edge, small islands kept near the edge
    mound     cushion plus 15 cm pillow lumps and a thicker centre
Surface (`--surface`, comma list or `all`):
    sludge    cave_features.mat_moss: the 2 cm Voronoi displacement of the first pass (the baseline)
    paint     no relief; colour = up-facing ramp (shade / mid / lit greens sampled from the
              reference) x posterised noise patches x soft value dabs; matte
    sss       paint + subsurface scattering and sheen (Cycles only), the soft cushion read
    toon      paint colour with the light gradient painted in: emission ramped by the key direction
    dabs      paint shell under ~3000/m2 small flat tangent cards, one flat palette tone each
    shells    paint shell + 5 offset shells thinned by a noise threshold (shell-textured fuzz)
    kuwahara  paint shell, then the compositor's anisotropic Kuwahara over the moss pixels only
"""
import argparse
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cave_features as cf  # noqa: E402
import rock_study as rs  # noqa: E402

# the reference's moss, sampled by brightness band (mid_ledge top, 2026-10-01):
# shade (64, 85, 54)  mid (102, 129, 72)  lit (148, 172, 86); hue runs from
# blue-green in the shade to yellow-green in the light.
MOSS = {
    "shade": "#40553a",
    "mid": "#668148",
    "lit": "#94ac56",
    "yellow": "#b4c45e",   # the yellowest dabs on the lit crown
    "teal": "#4a6e5a",     # the bluest dabs in the shade
    # the second reference (rock-a's crown, Tris's crop), by brightness band:
    "r_darkest": "#3d5135",
    "r_dark": "#50673d",
    "r_mid": "#688044",
    "r_light": "#80974a",
    "r_lightest": "#99a94e",
}

# Under the v6 key (1.0, 0.74, 0.45) the reference greens render olive: round 1's mid band
# came out (125, 133, 62) against the reference's (102, 128, 72). The albedo is corrected
# by that ratio in linear light, the lesson of the rock study (a warm key times a green).
# Round 3 (the three-layer paint, no posterised darkening) measured (123, 148, 92) with the
# first correction in; the second factor is that step, so the product is what the albedo wears.
def _ratio(target, measured):
    return tuple(((t / 255) ** 2.2) / ((m / 255) ** 2.2) for t, m in zip(target, measured))


_C1 = _ratio((102, 128, 72), (125, 133, 62))
_C2 = _ratio((102, 128, 72), (123, 148, 92))
# Round 4's lit band was still pale, (171, 188, 129), and a gain of 0.6 barely moved it: the
# slate's albedo is about 0.04 and its lit tops already render at 177, so under the 3600 W key
# anything brighter than the rock sits on AgX's shoulder, where albedo hardly registers. The
# moss has to be as dark as the rock in red and blue: gain 0.3 measured (92, 114, 49) mid and
# (130, 149, 72) lit, the reference's hue at last; 0.35 with the blue eased back is the pick.
_GAIN = 0.35
_CORR = tuple(a * b * _GAIN * k for a, b, k in zip(_C1, _C2, (1.0, 1.0, 1.25)))


def moss_col(name, corr=True, gain=None):
    c = cf.srgb(MOSS[name])
    if not corr:
        return c
    if gain is not None:
        g = gain if isinstance(gain, (tuple, list)) else (gain, gain, gain)
        return tuple(min(1.0, c[i] * g[i]) for i in range(3)) + (1.0,)
    return tuple(min(1.0, c[i] * _CORR[i]) for i in range(3)) + (1.0,)


RECIPE_F = dict(corners=14, corner_depth=0.6, corner_tilt=0.5, bevel=0.08, round=4,
                cuts=80, cut_depth=0.025, cut_tilt=0.15, cut_soft=2,
                dome=0.0, cell=0.5, big=0.05, big_scale=1.5, grit=0.004,
                target=1200, angle=9.0)

# how much of each stone wears moss: added to the coverage before the threshold
MOSS_BIAS = {"column": 0.12, "tier": 0.18, "boulder": 0.08, "front": 0.0, "foot": -0.08, "pebble": -2.0}


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- the carpet
def coverage(p, n, off, bias, lip):
    """The painted mask: up-facing, in metre-scale lobes, hanging over the lip
    in wide rounded tongues, with a scalloped edge. Returns (m, m_smooth): the
    second has no scallop noise, for the thickness profile."""
    up = smoothstep(0.0, 0.75, n.z)
    lobes = smoothstep(0.30, 0.62, 0.5 + 0.5 * noise.noise(p * 1.1 + off))
    # tongues: just under the lip, where a slow noise says so, fading down
    tongue = lip * smoothstep(0.45, 0.65, 0.5 + 0.5 * noise.noise(Vector((p.x * 2.6, p.y * 2.6, p.z * 0.8)) + off))
    base = max(up, 0.9 * tongue) * lobes + bias
    # the edge: round bubbles 5 cm across (a Voronoi cell's inside), so the
    # outline is convex lobes, not torn bites
    d0 = noise.voronoi(p * 26 + off)[0][0]
    bubble = 0.14 * smoothstep(0.62, 0.30, d0)
    ripple = 0.05 * noise.noise(p * 22 + off)
    return base + bubble + ripple - 0.06, base


def grow_carpet(rock, seed, geom="cushion", voxel=0.012, thick=0.06, shoulder=0.08, min_island=30):
    bias = MOSS_BIAS.get(rock.name, 0.0)
    if bias < -1:
        return None
    rng = random.Random(seed)
    off = Vector((rng.uniform(0, 50), rng.uniform(0, 50), rng.uniform(0, 50)))
    src = bpy.data.objects.new("tmp", rock.data.copy())
    bpy.context.scene.collection.objects.link(src)
    src.matrix_world = rock.matrix_world.copy()
    rm = src.modifiers.new("remesh", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = voxel
    rm.use_smooth_shade = True
    sm = src.modifiers.new("smooth", "SMOOTH")
    sm.factor = 0.8
    sm.iterations = 4
    me = cf.evaluated_mesh(src)
    bpy.data.objects.remove(src)

    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    bm.normal_update()
    bm.verts.ensure_lookup_table()
    M = rock.matrix_world
    R = M.to_3x3()
    mlay = bm.verts.layers.float.new("m")
    slay = bm.verts.layers.float.new("ms")
    zs = [(M @ v.co).z for v in bm.verts]
    ztop, zbot = max(zs), min(zs)
    h = max(ztop - zbot, 1e-3)
    for v in bm.verts:
        p = M @ v.co
        n = (R @ v.normal).normalized()
        lip = smoothstep(0.30, 0.06, (ztop - p.z) / h)   # 1 at the crown, 0 a third of the way down
        m, ms = coverage(p, n, off, bias, lip)
        v[mlay] = m
        v[slay] = ms
    kill = [f for f in bm.faces if sum(v[mlay] for v in f.verts) / len(f.verts) <= 0.5]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    # islands: drop crumbs under min_island faces (the rest are the edge's specks)
    seen = set()
    for f in bm.faces:
        if f in seen:
            continue
        isl, stack = [], [f]
        while stack:
            g = stack.pop()
            if g in seen:
                continue
            seen.add(g)
            isl.append(g)
            for e in g.edges:
                stack.extend(e.link_faces)
        if len(isl) < min_island:
            bmesh.ops.delete(bm, geom=isl, context="FACES")
    if not bm.faces:
        bm.free()
        return None
    # distance from the carpet's boundary in hops, for the shoulder
    hops = {}
    frontier = [v for v in bm.verts if any(e.is_boundary for e in v.link_edges)]
    for v in frontier:
        hops[v] = 0
    d = 0
    while frontier:
        d += 1
        nxt = []
        for v in frontier:
            for e in v.link_edges:
                o = e.other_vert(v)
                if o not in hops:
                    hops[o] = d
                    nxt.append(o)
        frontier = nxt
    # round the cut edge before it is pushed out: the voxel stairs and the
    # scallop's corners both go
    for _ in range(4):
        bmesh.ops.smooth_vert(bm, verts=bm.verts[:], factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.normal_update()
    for v in bm.verts:
        dist = hops.get(v, 999) * voxel
        t = min(1.0, dist / shoulder)
        rim = t * t * (3 - 2 * t)                            # feathers to the rock at the edge
        dome = 0.45 + 0.55 * smoothstep(0.0, 0.30, dist)       # and a pillow rising toward the middle
        prof = 0.5 + 0.5 * smoothstep(0.5, 0.95, v[slay])     # thicker where the paint is deep
        amt = thick * prof * rim * dome
        if geom == "mound":
            p = M @ v.co
            amt = (thick * 1.4) * prof * rim * dome + 0.015 * noise.noise(p * 6.5 + off) * rim
        v.co += v.normal * amt
    for _ in range(3):
        bmesh.ops.smooth_vert(bm, verts=bm.verts[:], factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    out = bpy.data.meshes.new(rock.name + ".moss")
    bm.to_mesh(out)
    bm.free()
    for p in out.polygons:
        p.use_smooth = True
    ob = cf.new_object(rock.name + ".moss", out)
    ob.matrix_world = rock.matrix_world.copy()
    ob.pass_index = 2
    return ob


# ---------------------------------------------------------------- the clump carpet
def blur_field(bm, layer, passes):
    """Average a vertex scalar over its neighbours `passes` times: thin streaks and
    voxel stairs in the field go before it is thresholded."""
    for _ in range(passes):
        nxt = {}
        for v in bm.verts:
            acc, n = v[layer], 1
            for e in v.link_edges:
                acc += e.other_vert(v)[layer]
                n += 1
            nxt[v] = acc / n
        for v, val in nxt.items():
            v[layer] = val


def grow_clumps(rock, seed, voxel=0.012, thick=0.09, taper=0.35, dab=0.3, fingers=0.10,
                min_island=30, light_reach=0.5, flat=False, gain=None, spread=0.2, big_r=(0.06, 0.13), small_r=(0.03, 0.055),
                big_density=160, small_density=120):
    """The second reference's carpet, painted in dabs.

    Mask: up-facing, in metre lobes, with rounded 7 cm bubbles on the edge, blurred over
    the mesh before the cut, so the outline is blobby. Height: a 2 mm skin at the rim
    rising over `taper` m to `thick`. Colour: round dabs (big ones `big_r`, small ones
    `small_r` on top), each ONE flat tone drawn from the dark-to-light continuum at a
    lightness that rises from the rim toward the centre (`light_reach` of the patch's
    depth) plus the dab's own draw (`spread`), so the shades are many and the fade is
    dab by dab; every dab is also a low dome (`dab` of its radius) so the relief
    follows the colour. Baked as the `col` attribute."""
    from mathutils.kdtree import KDTree
    bias = MOSS_BIAS.get(rock.name, 0.0)
    if bias < -1:
        return None
    rng = random.Random(seed)
    off = Vector((rng.uniform(0, 50), rng.uniform(0, 50), rng.uniform(0, 50)))
    src = bpy.data.objects.new("tmp", rock.data.copy())
    bpy.context.scene.collection.objects.link(src)
    src.matrix_world = rock.matrix_world.copy()
    rm = src.modifiers.new("remesh", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = voxel
    rm.use_smooth_shade = True
    sm = src.modifiers.new("smooth", "SMOOTH")
    sm.factor = 0.8
    sm.iterations = 4
    me = cf.evaluated_mesh(src)
    bpy.data.objects.remove(src)

    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    bm.normal_update()
    M = rock.matrix_world
    R = M.to_3x3()
    mlay = bm.verts.layers.float.new("m")
    zs = [(M @ v.co).z for v in bm.verts]
    ztop, zbot = max(zs), min(zs)
    h = max(ztop - zbot, 1e-3)
    for v in bm.verts:
        p = M @ v.co
        n = (R @ v.normal).normalized()
        lip = smoothstep(0.30, 0.06, (ztop - p.z) / h)
        up = smoothstep(0.0, 0.75, n.z)
        lobes = smoothstep(0.30, 0.62, 0.5 + 0.5 * noise.noise(p * 1.1 + off))
        tongue = lip * smoothstep(0.45, 0.65, 0.5 + 0.5 * noise.noise(Vector((p.x * 2.0, p.y * 2.0, p.z * 0.7)) + off))
        base = max(up, 0.75 * tongue) * lobes + bias
        d0 = noise.voronoi(p * 14 + off)[0][0]
        bubble = 0.22 * smoothstep(0.70, 0.25, d0)       # rounded 7 cm lobes on the outline
        v[mlay] = base + bubble - 0.08
    blur_field(bm, mlay, 5)
    kill = [f for f in bm.faces if sum(v[mlay] for v in f.verts) / len(f.verts) <= 0.5]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    seen = set()
    islands = []
    for f in bm.faces:
        if f in seen:
            continue
        isl, stack = [], [f]
        while stack:
            g = stack.pop()
            if g in seen:
                continue
            seen.add(g)
            isl.append(g)
            for e in g.edges:
                stack.extend(e.link_faces)
        if len(isl) < min_island:
            bmesh.ops.delete(bm, geom=isl, context="FACES")
        else:
            islands.append(isl)
    if not bm.faces:
        bm.free()
        return None
    for _ in range(6):
        bmesh.ops.smooth_vert(bm, verts=bm.verts[:], factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.normal_update()

    def bfs(seeds):
        d = {v: 0 for v in seeds}
        frontier = list(seeds)
        k = 0
        while frontier:
            k += 1
            nxt = []
            for v in frontier:
                for e in v.link_edges:
                    o = e.other_vert(v)
                    if o not in d:
                        d[o] = k
                        nxt.append(o)
            frontier = nxt
        return d

    edge_hops = bfs([v for v in bm.verts if any(e.is_boundary for e in v.link_edges)])
    patch = {}
    for isl in islands:
        verts = {v for f in isl for v in f.verts}
        c = max(verts, key=lambda v: (edge_hops.get(v, 0), (M @ v.co).z))
        dmax = max(edge_hops.get(v, 0) for v in verts) * voxel
        cw = M @ c.co
        for v in verts:
            patch[v] = (cw, dmax)

    gd = (gain if isinstance(gain, dict) else {"dark": gain, "light": gain})["dark"]
    gl = (gain if isinstance(gain, dict) else {"dark": gain, "light": gain})["light"]
    dark = moss_col("r_darkest", gain=gd)
    light = moss_col("r_lightest", gain=gl)

    def to_srgb(c):
        return c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055

    def to_lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    dark_s = [to_srgb(c) for c in dark[:3]]
    light_s = [to_srgb(c) for c in light[:3]]

    def tone(t):
        """The shade `t` of the way from dark to light, spaced as the eye sees it."""
        t = min(1.0, max(0.0, t))
        return tuple(to_lin(dark_s[i] + (light_s[i] - dark_s[i]) * t) for i in range(3))

    # the lightness field: 0 at the rim, 1 `light_reach` of the depth in, pulled by fingers
    bm.verts.index_update()
    verts = bm.verts[:]
    P = [M @ v.co for v in verts]
    N = [(R @ v.normal).normalized() for v in verts]
    field = [0.0] * len(verts)
    hn = [0.0] * len(verts)
    for i, v in enumerate(verts):
        dist = edge_hops.get(v, 999) * voxel
        cw, dmax = patch.get(v, (P[i], 1.0))
        ang = math.atan2(P[i].y - cw.y, P[i].x - cw.x)
        fing = noise.noise(Vector((math.cos(ang) * 2.2, math.sin(ang) * 2.2, dist * 3.0)) + off)
        big = smoothstep(0.10, 0.22, dmax)
        field[i] = smoothstep(0.0, max(light_reach * dmax, 0.05), dist + fingers * fing) * big
        hh = smoothstep(0.0, taper, dist)
        hn[i] = hh * hh * (3 - 2 * hh)

    # the dabs: area-weighted on the carpet, big ones first, small ones on top
    kd = KDTree(len(verts))
    for i, p in enumerate(P):
        kd.insert(p, i)
    kd.balance()
    faces = bm.faces[:]
    areas = [f.calc_area() for f in faces]
    total = sum(areas)
    cum = []
    acc = 0.0
    for a in areas:
        acc += a
        cum.append(acc)
    import bisect

    def sample_point():
        f = faces[min(bisect.bisect(cum, rng.random() * total), len(faces) - 1)]
        vs = f.verts
        r1, r2 = rng.random(), rng.random()
        if r1 + r2 > 1:
            r1, r2 = 1 - r1, 1 - r2
        a, b, c = (M @ vs[0].co), (M @ vs[1].co), (M @ vs[-1].co)
        return a + (b - a) * r1 + (c - a) * r2

    dabs = []   # (radius, centre, tone, [(sub-centre, sub-radius), ...]): a dab is a main disc with lobes
    for density, rr in ((big_density, big_r), (small_density, small_r)):
        for _ in range(int(total * density)):
            c = sample_point()
            i = kd.find(c)[1]
            f = field[i]
            t = 0.06 + 0.80 * (f ** 1.3) + rng.gauss(0, spread)
            dist_c = edge_hops.get(verts[i], 999) * voxel
            t *= 0.3 + 0.7 * smoothstep(0.0, 0.12, dist_c)      # a broad band of the darkest at the rim
            r = rng.uniform(*rr)
            n = N[i]
            tx = n.cross(Vector((0.3, 0.7, 0.2))).normalized()
            ty = n.cross(tx)
            lobes = [(c, r)]
            for _k in range(rng.randint(2, 4)):                  # leafy: lobes bulge off the main disc
                a = rng.uniform(0, 2 * math.pi)
                lobes.append((c + (tx * math.cos(a) + ty * math.sin(a)) * r * rng.uniform(0.45, 0.75), r * rng.uniform(0.45, 0.7)))
            dabs.append((r, c, tone(t), lobes))
    dabs.sort(key=lambda d: -d[0])
    col = [None] * len(verts)
    lift = [0.0] * len(verts)
    for r, c, tn, lobes in dabs:
        cover = {}
        for (lc, lr) in lobes:
            for (co, i, d) in kd.find_range(lc, lr):
                w = smoothstep(lr, lr - 0.012, d)
                dome = lr * math.sqrt(max(0.0, 1 - (d / lr) ** 2))
                if w > cover.get(i, (0.0, 0.0))[0]:
                    cover[i] = (w, dome)
                elif i in cover:
                    cover[i] = (cover[i][0], max(cover[i][1], dome))
        for i, (w, dome) in cover.items():
            col[i] = tn if col[i] is None else tuple(col[i][k] + (tn[k] - col[i][k]) * w for k in range(3))
            if not flat:
                lift[i] = max(lift[i], dab * dome * w * hn[i])
    # a vertex no dab reached takes its nearest dab's tone
    kd2 = KDTree(len(dabs))
    for j, (r, c, tn, lobes) in enumerate(dabs):
        kd2.insert(c, j)
    kd2.balance()
    for i in range(len(verts)):
        if col[i] is None:
            col[i] = dabs[kd2.find(P[i])[1]][2]
    for i, v in enumerate(verts):
        v.co += v.normal * (0.002 + thick * hn[i] + lift[i])
    for _ in range(2):
        bmesh.ops.smooth_vert(bm, verts=bm.verts[:], factor=0.4, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    out = bpy.data.meshes.new(rock.name + ".moss")
    bm.to_mesh(out)
    bm.free()
    attr = out.attributes.new("col", "FLOAT_COLOR", "POINT")
    attr.data.foreach_set("color", [c for cc in col for c in (cc[0], cc[1], cc[2], 1.0)])
    for pg in out.polygons:
        pg.use_smooth = True
    ob = cf.new_object(rock.name + ".moss", out)
    ob.matrix_world = rock.matrix_world.copy()
    ob.pass_index = 2
    print("[build] %s: %d dabs" % (ob.name, len(dabs)))
    return ob


# ---------------------------------------------------------------- the layered carpet
def grow_layers(rock, seed, voxel=0.012, layers=5, base_r=(0.032, 0.05), shrink=0.92, frac=0.6,
                seeds=10.0, step=0.006, dab=0.18, min_island=30, gain=None, jitter=0.1, spacing=0.4, buffer=0.035, clump_jitter=0.1,
                min_clump=6, curve=1.3, mottle=0.6, mottle_scale=4.0, erode_noise=0.9, erode_scale=14.0, steps_deep=5.0, min_k=4, first_buffer=0.012,
                fracs=(1.0, 1.0, 0.55, 0.3, 0.18), field_mix=0.55, edge=0.010, cblur=0, levels=8,
                ref_depth=0.42, ref_layers=5, inner_u=0.88, decimate=0.01, card_lift=0.004, bake_px=1024):
    """Tris's construction (2026-10-01): the carpet is dabs all the way down.

    Layer 0 fills the painted area with dark dabs, and the geometry is their union, so
    the outline is dab-shaped. Layer k grows `seeds[k-1]` connected clumps of dabs, each
    a step lighter, seeded deep inside layer k-1 and only ever placed inside it, until the
    layer holds `frac` of the dabs below it; dabs shrink by `shrink` a layer. A dab is a
    main disc with 2-4 lobes. Height: 2 mm skin, `step` per layer, plus each dab's dome
    (`dab` of its radius), so the carpet mounds where the light is. Colour baked as `col`."""
    from mathutils.kdtree import KDTree
    bias = MOSS_BIAS.get(rock.name, 0.0)
    if bias < -1:
        return None
    rng = random.Random(seed)
    off = Vector((rng.uniform(0, 50), rng.uniform(0, 50), rng.uniform(0, 50)))
    src = bpy.data.objects.new("tmp", rock.data.copy())
    bpy.context.scene.collection.objects.link(src)
    src.matrix_world = rock.matrix_world.copy()
    rm = src.modifiers.new("remesh", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = voxel
    rm.use_smooth_shade = True
    sm = src.modifiers.new("smooth", "SMOOTH")
    sm.factor = 0.8
    sm.iterations = 4
    me = cf.evaluated_mesh(src)
    bpy.data.objects.remove(src)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    bm.normal_update()
    M = rock.matrix_world
    R = M.to_3x3()
    bm.verts.index_update()
    ilay = bm.verts.layers.int.new("orig")      # deleting faces re-indexes: keep the original index
    for v in bm.verts:
        v[ilay] = v.index
    verts = bm.verts[:]
    P = [M @ v.co for v in verts]
    N = [(R @ v.normal).normalized() for v in verts]
    zs = [p.z for p in P]
    ztop, zbot = max(zs), min(zs)
    h = max(ztop - zbot, 1e-3)
    # the painted area (smooth; the dabs draw its outline)
    paint = []
    for p, n in zip(P, N):
        lip = smoothstep(0.30, 0.06, (ztop - p.z) / h)
        up = smoothstep(0.0, 0.75, n.z)
        lobes = smoothstep(0.30, 0.62, 0.5 + 0.5 * noise.noise(p * 1.1 + off))
        tongue = lip * smoothstep(0.45, 0.65, 0.5 + 0.5 * noise.noise(Vector((p.x * 2.0, p.y * 2.0, p.z * 0.7)) + off))
        paint.append(max(up, 0.75 * tongue) * lobes + bias - 0.08)
    kd = KDTree(len(verts))
    for i, p in enumerate(P):
        kd.insert(p, i)
    kd.balance()
    painted = [i for i in range(len(verts)) if paint[i] > 0.5]
    if len(painted) < 50:
        bm.free()
        return None
    adj = [[e.other_vert(v).index for e in v.link_edges] for v in verts]
    # the painted patches: each connected painted region, with its depth (how far its
    # deepest vertex is from unpainted rock, over the mesh); the erosion step scales with it
    depth0 = [None] * len(verts)
    frontier = [i for i in range(len(verts)) if paint[i] <= 0.5]
    for i in frontier:
        depth0[i] = 0
    hop = 0
    while frontier:
        hop += 1
        nxt = []
        for i in frontier:
            for j in adj[i]:
                if depth0[j] is None:
                    depth0[j] = hop
                    nxt.append(j)
        frontier = nxt
    patch = {}
    comp = [None] * len(verts)
    for i in painted:
        if comp[i] is not None:
            continue
        members, stack = [], [i]
        comp[i] = i
        while stack:
            a = stack.pop()
            members.append(a)
            for b in adj[a]:
                if paint[b] > 0.5 and comp[b] is None:
                    comp[b] = i
                    stack.append(b)
        dmax = max((depth0[m] or 0) for m in members) * voxel
        cw = P[max(members, key=lambda m: (depth0[m] or 0))]
        for m in members:
            patch[verts[m]] = (cw, dmax)

    gd = (gain if isinstance(gain, dict) else {"dark": gain, "light": gain})["dark"]
    gl = (gain if isinstance(gain, dict) else {"dark": gain, "light": gain})["light"]
    dark = moss_col("r_darkest", gain=gd)
    light = moss_col("r_lightest", gain=gl)

    def to_srgb(c):
        return c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055

    def to_lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    dark_s = [to_srgb(c) for c in dark[:3]]
    light_s = [to_srgb(c) for c in light[:3]]

    def tone(t):
        """The shade `t` of the way from dark to light, spaced as the eye sees it."""
        t = min(1.0, max(0.0, t))
        return tuple(to_lin(dark_s[i] + (light_s[i] - dark_s[i]) * t) for i in range(3))

    def make_dab(c, n, r, k):
        """A dab is a rounded irregular blob: its outline is a polar curve
        r(theta) = r (1 + a1 cos(theta - p1) + a2 cos(2 theta - p2) + a3 cos(3 theta - p3)),
        three random harmonics, so it is never a circle and never has a corner."""
        tx = n.cross(Vector((0.3, 0.7, 0.2))).normalized()
        ty = n.cross(tx)
        a = rng.uniform(0, 2 * math.pi)
        ax = tx * math.cos(a) + ty * math.sin(a)
        ay = ty * math.cos(a) - tx * math.sin(a)
        harm = ((rng.uniform(0.08, 0.3), rng.uniform(0, 2 * math.pi)),
                (rng.uniform(0.1, 0.35), rng.uniform(0, 2 * math.pi)),
                (rng.uniform(0.0, 0.18), rng.uniform(0, 2 * math.pi)))
        rmax = r * (1 + sum(h[0] for h in harm))
        return {"c": c, "n": n, "r": r, "k": k, "ax": ax, "ay": ay, "harm": harm, "rmax": rmax}

    def dab_u(d, co):
        """how far `co` is out from the dab's centre as a fraction of the outline there"""
        v = co - d["c"]
        x, y = v.dot(d["ax"]), v.dot(d["ay"])
        dist = math.hypot(x, y)
        th = math.atan2(y, x)
        rr = d["r"] * (1 + sum(a * math.cos((j + 1) * th - ph) for j, (a, ph) in enumerate(d["harm"])))
        return dist / max(rr, 1e-6), rr

    # ---- layer 0: fill the painted area, Poisson-ish
    layer0 = []
    placed = []
    tries = len(painted)
    for _ in range(tries):
        i = painted[rng.randrange(len(painted))]
        c, n = P[i], N[i]
        r = rng.uniform(*base_r)
        if any((c - d["c"]).length < 0.3 * (r + d["r"]) for d in placed):    # packed tight: no pinholes
            continue
        d = make_dab(c, n, r, 0)
        d["clump"] = 0.0
        d["patch"] = tuple(patch.get(verts[i], (P[i], 0.0))[0])
        layer0.append(d)
        placed.append(d)
    all_layers = [layer0]

    # ---- layers 1..: connected clumps grown inside the layer below, `buffer` metres in

    def depth_of(inside_v):
        """distance (m) of every vertex in from the outside of a coverage, over the mesh"""
        # the outside is only the uncovered region that connects to the unpainted rock:
        # a pocket between two clumps is not an edge, or every layer above would widen it
        outside = [False] * len(verts)
        frontier = [i for i in range(len(verts)) if paint[i] <= 0.5]
        for i in frontier:
            outside[i] = True
        while frontier:
            nxt = []
            for i in frontier:
                for j in adj[i]:
                    if not outside[j] and not inside_v[j]:
                        outside[j] = True
                        nxt.append(j)
            frontier = nxt
        depth = [None] * len(verts)
        frontier = [i for i in range(len(verts)) if outside[i]]
        for i in frontier:
            depth[i] = 0
        hop = 0
        while frontier:
            hop += 1
            nxt = []
            for i in frontier:
                for j in adj[i]:
                    if depth[j] is None:
                        depth[j] = hop
                        nxt.append(j)
            frontier = nxt
        # a vertex the walk never reached is on a sliver of the remesh with no edge of
        # its own: count it as outside, not as infinitely deep (it grew light specks)
        return [((d if d is not None else 0) * voxel) for d in depth]

    def layer_depth(layer):
        inside_v = [False] * len(verts)
        for d in layer:
            for (co, i, dist) in kd.find_range(d["c"], d["rmax"]):
                if dab_u(d, co)[0] <= 1.0:
                    inside_v[i] = True
        return depth_of(inside_v)

    def step_at(i, kk, base):
        """the uneven erosion step at vertex i for pass kk: a per-pass scale times a slow
        noise (where the pass bites) and a fast one (the outline); noise.noise is -1..1
        and rarely past +-0.5, so it is stretched"""
        n_slow = min(1.0, max(0.0, 0.5 + 1.3 * noise.noise(P[i] * (erode_scale * 0.35) + off3 + Vector((0, 0, 2.7 * kk)))))
        n_fast = min(1.0, max(0.0, 0.5 + 1.3 * noise.noise(P[i] * erode_scale + off3 + Vector((1.3, 0, 4.1 * kk)))))
        n01 = 0.6 * n_slow + 0.4 * n_fast
        return base * (0.15 + 2.6 * n01 * n01)

    off3 = off + Vector((4.4, 9.2, 1.7))
    # ---- the erosion field: how many passes of uneven erosion each vertex survives.
    # Its ridges and summits are where the light belongs; the seeded growth below takes
    # its seeds from them (Tris's hybrid, 2026-10-02)
    # The field is continuous: a vertex eroded in pass kk scores kk-1 plus how far into
    # that pass's step it sat, so a shallow patch grades smoothly instead of in 3 jumps.
    # The step is the same everywhere (the rock's deepest patch / steps_deep), so a small
    # patch scores low and stays mid-green, as the reference's small patches do.
    hfield = [0.0] * len(verts)
    alive = [paint[i] > 0.5 for i in range(len(verts))]
    rock_depth = ref_depth            # one step for every rock, from a fixed reference depth
    for kk in range(1, 40):
        dep = depth_of(alive)
        scale = rng.uniform(0.45, 1.7)
        kept = [False] * len(verts)
        n_kept = 0
        for i in range(len(verts)):
            if not alive[i]:
                continue
            base = max(buffer, rock_depth / steps_deep) * scale
            st = step_at(i, kk, base)
            if dep[i] >= st:
                kept[i] = True
                n_kept += 1
            else:
                hfield[i] = (kk - 1) + dep[i] / max(st, 1e-6)
        if n_kept == 0:
            break
        alive = kept

    for k in range(1, layers + 1):
        parent = all_layers[-1]
        pdepth = layer_depth(parent)
        sh = max(shrink ** k, 0.65)
        r_k = (base_r[0] * sh, base_r[1] * sh)
        b_k = first_buffer if k == 1 else buffer
        frac_k = fracs[min(k - 1, len(fracs) - 1)]
        fill = frac_k >= 1.0
        elig = [False] * len(verts)
        n_elig = 0
        for i in range(len(verts)):
            if paint[i] > 0.5 and pdepth[i] >= b_k + 1.5 * r_k[1]:
                elig[i] = True
                n_elig += 1
        if n_elig < 20:
            break
        # the eligible region's components, and inside each the field's summits: the
        # components of {field >= k+1}, each seeded at its highest vertex
        comp = [None] * len(verts)
        comps = []
        for i in range(len(verts)):
            if not elig[i] or comp[i] is not None:
                continue
            members, stack = [], [i]
            comp[i] = len(comps)
            while stack:
                a = stack.pop()
                members.append(a)
                for b in adj[a]:
                    if elig[b] and comp[b] is None:
                        comp[b] = comp[i]
                        stack.append(b)
            comps.append(members)
        seeds_at = []
        for members in comps:
            if len(members) < 10:
                continue
            level = k + 1
            high = [m for m in members if hfield[m] >= level]
            if not high:
                high = [max(members, key=lambda m: hfield[m])]
            hs = set(high)
            seen = set()
            for m0 in high:
                if m0 in seen:
                    continue
                isl, stack = [], [m0]
                seen.add(m0)
                while stack:
                    a = stack.pop()
                    isl.append(a)
                    for b in adj[a]:
                        if b in hs and b not in seen:
                            seen.add(b)
                            stack.append(b)
                if len(isl) < 6 and len(isl) < len(high):
                    continue
                seeds_at.append(max(isl, key=lambda m: (hfield[m], rng.random())))
            if fill:
                # a fill layer also seeds the component's far ends, or growth from one
                # summit takes many stalls to reach them
                for _ in range(max(1, len(members) // 400)):
                    seeds_at.append(members[rng.randrange(len(members))])
        if not seeds_at:
            break
        target = int(len(parent) * (1.3 if fill else frac_k))
        layer = []
        lk = None
        queues = []
        caps = []
        for i in seeds_at:
            d = make_dab(P[i], N[i], rng.uniform(*r_k), k)
            d["clump"] = rng.gauss(0, clump_jitter)
            d["patch"] = tuple(patch.get(verts[i], (P[i], 0.0))[0])
            layer.append(d)
            queues.append([d])
            caps.append(10 ** 6 if fill else int(target / len(seeds_at) * rng.uniform(0.5, 1.5)) + 1)
        stalls = 0
        while len(layer) < target and stalls < (80 if fill else 400):
            grew = False
            for qi, q in enumerate(queues):
                if not q or len(q) >= caps[qi]:
                    continue
                src_d = q[rng.randrange(len(q))]
                for _ in range(6):
                    a = rng.uniform(0, 2 * math.pi)
                    n = src_d["n"]
                    tx = n.cross(Vector((0.3, 0.7, 0.2))).normalized()
                    ty = n.cross(tx)
                    r = rng.uniform(*r_k)
                    c = src_d["c"] + (tx * math.cos(a) + ty * math.sin(a)) * (src_d["r"] + r) * spacing
                    co, i, _ = kd.find(c)          # snap to the rock
                    c, n = P[i], N[i]
                    if not elig[i]:
                        continue
                    if any((c - d["c"]).length < spacing * (r + d["r"]) for d in layer[-400:]):
                        continue
                    if lk is not None and any((c - layer[j]["c"]).length < spacing * (r + layer[j]["r"]) for (_co, j, _d) in lk.find_range(c, 2 * r_k[1])):
                        continue
                    d = make_dab(c, n, r, k)
                    d["clump"] = src_d["clump"]
                    d["patch"] = src_d["patch"]
                    layer.append(d)
                    q.append(d)
                    grew = True
                    if len(layer) % 200 == 0:
                        lk = KDTree(len(layer))
                        for j, dd in enumerate(layer):
                            lk.insert(dd["c"], j)
                        lk.balance()
                    break
            stalls = 0 if grew else stalls + 1
        layer = [d for q in queues if len(q) >= min_clump for d in q]
        if not layer:
            break
        all_layers.append(layer)
        print("[layers] k=%d %s: %d seeds, %d dabs" % (k, "fill" if fill else "islands", len(seeds_at), len(layer)))

    # ---- paint and lift: lower layers first, higher on top
    col = [None] * len(verts)
    lift = [0.0] * len(verts)
    covered = [0.0] * len(verts)
    inner = [0.0] * len(verts)
    # the tone climbs to the lightest over each patch's own layers (a patch that only
    # managed a few stays mid-green)
    kmax = {}
    for k, layer in enumerate(all_layers):
        for d in layer:
            kmax[d["patch"]] = max(kmax.get(d["patch"], 0), k)
    flay = bm.verts.layers.float.new("hf")
    for v in bm.verts:
        v[flay] = hfield[v[ilay]]
    blur_field(bm, flay, 6)
    for v in bm.verts:
        hfield[v[ilay]] = v[flay]
    # the field and the layers are scaled against a FIXED reference (a patch `ref_depth`
    # deep reaches `steps_deep` passes and `ref_layers` layers), the same for every rock,
    # so a small patch grades gently and stops at a mid-green instead of being stretched
    # to the full range by its own two layers
    hmax_all = float(steps_deep)
    kmax_all = ref_layers
    tstep = 1.0 / ref_layers
    jitter = jitter * tstep
    clump_scale = tstep
    off2 = off + Vector((13.1, 7.7, 3.9))
    for k, layer in enumerate(all_layers):
        for d in layer:
            # a slow mottle over position: blobs of a few dabs share a shade, so even the
            # base layer is patchy, and never a lone dab
            mot = mottle * tstep * noise.noise(d["c"] * mottle_scale + off2)   # -1..1
            # the layer sets the floor of a dab's tone; the erosion field at the dab lifts it,
            # so within one layer the shade keeps changing dab by dab (a band of one flat
            # tone was the "large stretches of uniform colour")
            t_layer = min(1.0, k / kmax_all)
            hf = min(1.0, hfield[kd.find(d["c"])[1]] / hmax_all)
            t = (field_mix * hf + (1 - field_mix) * t_layer)
            # the tone is quantised to `levels` steps, and the per-dab draw is small, so
            # neighbours land on the same step and merge into one larger blotch
            # no per-dab randomness: the step comes from smooth fields alone (erosion field,
            # layer, a coarse mottle), so it changes only along a curve that many dabs share
            tq = t ** curve + mot
            tq = round(min(1.0, max(0.0, tq)) * (levels - 1)) / (levels - 1)
            tn = tone(tq)
            d["tone"] = tn
            cover = {}
            for (co, i, dist) in kd.find_range(d["c"], d["rmax"]):
                u, rr = dab_u(d, co)
                if u > 1.0:
                    continue
                w = smoothstep(1.0, 1.0 - edge / rr, u)
                cover[i] = (w, u)
            for i, (w, u) in cover.items():
                col[i] = tn if col[i] is None else tuple(col[i][q] + (tn[q] - col[i][q]) * w for q in range(3))
                lift[i] = max(lift[i], k * step)
                covered[i] = max(covered[i], w)
                if u <= inner_u:                      # the shell is cut inside the dab fringe;
                    inner[i] = 1.0                    # the edge cards draw the fringe

    llay = bm.verts.layers.float.new("lift")
    clay = bm.verts.layers.float.new("cov")
    rl, gll, bl = (bm.verts.layers.float.new(n) for n in ("cr", "cg", "cb"))
    for v in bm.verts:
        v[llay] = lift[v[ilay]]
        v[clay] = inner[v[ilay]]
        c = col[v[ilay]] or dark
        v[rl], v[gll], v[bl] = c[0], c[1], c[2]
    for lay in (rl, gll, bl):
        blur_field(bm, lay, cblur)   # the vertex grid's staircase on every blotch edge goes
    for v in bm.verts:
        col[v[ilay]] = (v[rl], v[gll], v[bl])
    blur_field(bm, llay, 12)           # a smooth mound: no dab shows in the geometry
    blur_field(bm, clay, 2)            # closes the pinholes between three dabs, keeps the lobes
    for v in bm.verts:
        lift[v[ilay]] = v[llay]
        inner[v[ilay]] = v[clay]
    # ---- the geometry is the union of the dabs
    kill = [f for f in bm.faces if sum(inner[v[ilay]] for v in f.verts) / len(f.verts) <= 0.5]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    seen = set()
    for f in bm.faces:
        if f in seen:
            continue
        isl, stack = [], [f]
        while stack:
            g = stack.pop()
            if g in seen:
                continue
            seen.add(g)
            isl.append(g)
            for e in g.edges:
                stack.extend(e.link_faces)
        if len(isl) < min_island:
            bmesh.ops.delete(bm, geom=isl, context="FACES")
    if not bm.faces:
        bm.free()
        return None
    for _ in range(3):
        bmesh.ops.smooth_vert(bm, verts=bm.verts[:], factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.normal_update()
    # the rim feathers: the skin is 2 mm at the edge, the dab lift fades in over 4 cm
    edge = {v: 0 for v in bm.verts if any(e.is_boundary for e in v.link_edges)}
    frontier = list(edge)
    kk = 0
    while frontier:
        kk += 1
        nxt = []
        for v in frontier:
            for e in v.link_edges:
                o = e.other_vert(v)
                if o not in edge:
                    edge[o] = kk
                    nxt.append(o)
        frontier = nxt
    for v in bm.verts:
        rimf = smoothstep(0.0, 0.04, edge.get(v, 99) * voxel)
        v.co += v.normal * (0.002 + lift[v[ilay]] * rimf)
    for _ in range(2):
        bmesh.ops.smooth_vert(bm, verts=bm.verts[:], factor=0.4, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    keep = [v[ilay] for v in bm.verts]
    out = bpy.data.meshes.new(rock.name + ".moss")
    bm.to_mesh(out)
    bm.free()
    attr = out.attributes.new("col", "FLOAT_COLOR", "POINT")
    flat = []
    for i in keep:
        c = col[i] or dark
        flat += [c[0], c[1], c[2], 1.0]
    attr.data.foreach_set("color", flat)
    for pg in out.polygons:
        pg.use_smooth = True
    ob = cf.new_object(rock.name + ".moss", out)
    ob.matrix_world = rock.matrix_world.copy()
    ob.pass_index = 2
    if decimate < 1.0:
        # the colour lives on the fine mesh's vertices; a decimated shell would smear it
        # across 3 cm triangles, so bake it to a texture on the low-poly shell instead
        fine = bpy.data.objects.new(ob.name + ".fine", ob.data.copy())
        bpy.context.scene.collection.objects.link(fine)
        fine.matrix_world = ob.matrix_world.copy()
        fine.data.materials.clear()
        fine.data.materials.append(mat_vcol("MossVcolBake"))
        dm = ob.modifiers.new("decimate", "DECIMATE")
        dm.ratio = decimate
        rs.apply_modifiers(ob)
        for pg in ob.data.polygons:
            pg.use_smooth = True
        bake_colour(ob, fine, bake_px)
    ob.data.calc_loop_triangles()
    print("[build] %s: layers %s, shell %d tris" % (ob.name, [len(l) for l in all_layers], len(ob.data.loop_triangles)))
    # ---- the edge cards: one alpha card per layer-0 dab near the carpet's edge, carrying
    # a blob silhouette from the atlas in the dab's tone, tangent to the rock, just above it
    dep0 = layer_depth(all_layers[0])
    cards = []
    tone_of = {}
    for layer in all_layers:
        for d in layer:
            tone_of[id(d)] = d.get("tone")
    for d in all_layers[0]:
        i = kd.find(d["c"])[1]
        if dep0[i] < d["rmax"] * 0.9:
            cards.append(d)
    if cards:
        card_bm = bmesh.new()
        uv_lay = card_bm.loops.layers.uv.new("uv")
        tones = []
        cols_n = ATLAS_N
        for d in cards:
            c, n, ax, ay = d["c"], d["n"], d["ax"], d["ay"]
            R = d["rmax"] * 1.1
            lift_c = card_lift
            vs = [card_bm.verts.new(c + n * lift_c + ax * sx * R + ay * sy * R) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            f = card_bm.faces.new(vs)
            cell = rng.randrange(cols_n * cols_n)
            cx, cy = cell % cols_n, cell // cols_n
            for loop, (ux, uy) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
                loop[uv_lay].uv = ((cx + ux) / cols_n, (cy + uy) / cols_n)
            tones.append(d.get("tone") or dark)
        cme = bpy.data.meshes.new(rock.name + ".moss.edge")
        card_bm.to_mesh(cme)
        card_bm.free()
        attr = cme.attributes.new("col", "FLOAT_COLOR", "FACE")
        attr.data.foreach_set("color", [c for t in tones for c in (t[0], t[1], t[2], 1.0)])
        cob = cf.new_object(rock.name + ".moss.edge", cme)
        cob.pass_index = 2
        cob.visible_shadow = False          # a decal: it draws the silhouette and casts nothing
        cob.data.materials.append(mat_edge_cards())
        ob["edge_cards"] = cob.name
        print("[build] %s: %d edge cards" % (cob.name, len(cards)))
    import json
    json.dump([{"k": d["k"], "c": list(d["c"]), "r": d["r"]} for layer in all_layers for d in layer],
              open(os.path.join("out", "moss", "dabs_%s.json" % rock.name), "w"))
    return ob


# ---------------------------------------------------------------- edge cards
ATLAS_N = 8          # blob silhouettes per side of the atlas
ATLAS_PX = 64        # pixels per cell


def blob_atlas(seed=7):
    """An ATLAS_N x ATLAS_N sheet of rounded irregular blob silhouettes (the same polar
    harmonics as the painted dabs), white with the shape in the alpha, soft 1.5 px edge."""
    name = "MossBlobAtlas"
    if name in bpy.data.images:
        return bpy.data.images[name]
    import numpy as np
    rng = random.Random(seed)
    size = ATLAS_N * ATLAS_PX
    px = np.zeros((size, size, 4), dtype=np.float32)
    px[..., :3] = 1.0
    ys, xs = np.mgrid[0:ATLAS_PX, 0:ATLAS_PX]
    cx = cy = (ATLAS_PX - 1) / 2
    for cell in range(ATLAS_N * ATLAS_N):
        harm = ((rng.uniform(0.08, 0.3), rng.uniform(0, 2 * math.pi)),
                (rng.uniform(0.1, 0.35), rng.uniform(0, 2 * math.pi)),
                (rng.uniform(0.0, 0.18), rng.uniform(0, 2 * math.pi)))
        r0 = (ATLAS_PX / 2) / (1.1 * (1 + sum(a for a, _ in harm)))
        th = np.arctan2(ys - cy, xs - cx)
        rr = r0 * (1 + sum(a * np.cos((j + 1) * th - ph) for j, (a, ph) in enumerate(harm)))
        dist = np.hypot(xs - cx, ys - cy)
        alpha = np.clip((rr - dist) / 1.5 + 0.5, 0, 1)
        x0, y0 = (cell % ATLAS_N) * ATLAS_PX, (cell // ATLAS_N) * ATLAS_PX
        px[y0:y0 + ATLAS_PX, x0:x0 + ATLAS_PX, 3] = alpha
    img = bpy.data.images.new(name, size, size, alpha=True)
    img.pixels.foreach_set(px.ravel())
    img.pack()
    return img


def mat_edge_cards():
    name = "MossEdgeCards"
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    mat = bpy.data.materials.new(name)
    nt = cf._nodes(mat)
    N = nt.nodes.new
    L = nt.links.new
    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfDiffuse")
    bsdf.inputs["Roughness"].default_value = 1.0
    attr = N("ShaderNodeAttribute")
    attr.attribute_name = "col"
    L(attr.outputs["Color"], bsdf.inputs["Color"])
    tex = N("ShaderNodeTexImage")
    tex.image = blob_atlas()
    tex.interpolation = "Linear"
    trans = N("ShaderNodeBsdfTransparent")
    mix = N("ShaderNodeMixShader")
    L(tex.outputs["Alpha"], mix.inputs[0])
    L(trans.outputs[0], mix.inputs[1])
    L(bsdf.outputs[0], mix.inputs[2])
    # a card seen from behind (overhanging the rock's silhouette) is transparent, or its
    # unlit back shows as a black sliver against the world
    geo = N("ShaderNodeNewGeometry")
    back = N("ShaderNodeMixShader")
    L(geo.outputs["Backfacing"], back.inputs[0])
    L(mix.outputs[0], back.inputs[1])
    L(trans.outputs[0], back.inputs[2])
    L(back.outputs[0], out.inputs[0])
    mat.surface_render_method = "DITHERED"
    mat.use_backface_culling = False
    return mat


def bake_colour(low, fine, px=1024):
    """Bake the fine mesh's vertex colour onto a texture on the low-poly shell: a UV
    unwrap of the shell, then Cycles' selected-to-active diffuse bake (colour only)."""
    sc = bpy.context.scene
    for o in sc.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = low
    low.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.003)
    bpy.ops.object.mode_set(mode="OBJECT")
    img = bpy.data.images.new(low.name + ".col", px, px, alpha=False)
    mat = bpy.data.materials.new(low.name + ".baked")
    nt = cf._nodes(mat)
    N = nt.nodes.new
    L = nt.links.new
    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfDiffuse")
    bsdf.inputs["Roughness"].default_value = 1.0
    tex = N("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Closest"       # the dab edges stay crisp at the texel
    L(tex.outputs["Color"], bsdf.inputs["Color"])
    L(bsdf.outputs[0], out.inputs[0])
    nt.nodes.active = tex
    low.data.materials.clear()
    low.data.materials.append(mat)
    fine.select_set(True)
    keep = (sc.cycles.samples, sc.render.bake.use_selected_to_active, sc.render.bake.cage_extrusion)
    sc.cycles.samples = 4
    sc.render.bake.use_selected_to_active = True
    sc.render.bake.cage_extrusion = 0.03
    sc.render.bake.max_ray_distance = 0.08
    sc.render.bake.margin = 8
    sc.render.bake.use_pass_direct = False
    sc.render.bake.use_pass_indirect = False
    sc.render.bake.use_pass_color = True
    bpy.ops.object.bake(type="DIFFUSE")
    sc.cycles.samples, sc.render.bake.use_selected_to_active, sc.render.bake.cage_extrusion = keep
    img.pack()
    fme = fine.data
    bpy.data.objects.remove(fine)
    bpy.data.meshes.remove(fme)
    low.select_set(False)
    low["baked"] = True


def mat_vcol(name):
    """The baked colour under a pure diffuse: matte, nothing else."""
    mat = bpy.data.materials.new(name)
    nt = cf._nodes(mat)
    N = nt.nodes.new
    L = nt.links.new
    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfDiffuse")
    bsdf.inputs["Roughness"].default_value = 1.0
    attr = N("ShaderNodeAttribute")
    attr.attribute_name = "col"
    L(attr.outputs["Color"], bsdf.inputs["Color"])
    L(bsdf.outputs[0], out.inputs[0])
    return mat


# ---------------------------------------------------------------- surfaces
def _ramp(nt, stops, interp="EASE"):
    r = nt.nodes.new("ShaderNodeValToRGB")
    r.color_ramp.interpolation = interp
    els = r.color_ramp.elements
    while len(els) > 1:
        els.remove(els[-1])
    els[0].position = stops[0][0]
    els[0].color = moss_col(stops[0][1]) if stops[0][1] in MOSS else cf.srgb(stops[0][1])
    for pos, col in stops[1:]:
        e = els.new(pos)
        e.color = moss_col(col) if col in MOSS else cf.srgb(col)
    return r


def paint_colour(nt, N, L):
    """The painted moss colour: an up-facing ramp through the reference's three
    greens, with paint patches (posterised noise picking a tone) and soft dabs
    of value. Returns the colour socket."""
    geo = N("ShaderNodeNewGeometry")
    sepn = N("ShaderNodeSeparateXYZ")
    L(geo.outputs["Normal"], sepn.inputs[0])
    up = N("ShaderNodeMapRange")
    up.inputs["From Min"].default_value = -0.3
    up.inputs["From Max"].default_value = 1.0
    L(sepn.outputs["Z"], up.inputs["Value"])
    ramp = _ramp(nt, [(0.0, "shade"), (0.55, "mid"), (1.0, "lit")])
    L(up.outputs[0], ramp.inputs["Fac"])

    coord = N("ShaderNodeTexCoord")
    MOSS_TONES = MOSS

    def mult(a, b):
        m = N("ShaderNodeMix")
        m.data_type = "RGBA"
        m.blend_type = "MULTIPLY"
        m.inputs[0].default_value = 1.0
        L(a, m.inputs[6])
        L(b, m.inputs[7])
        return m.outputs[2]

    def grey_of(value_socket, lo, hi):
        mr = N("ShaderNodeMapRange")
        mr.inputs["To Min"].default_value = lo
        mr.inputs["To Max"].default_value = hi
        L(value_socket, mr.inputs["Value"])
        g = N("ShaderNodeCombineColor")
        for i in range(3):
            L(mr.outputs[0], g.inputs[i])
        return g.outputs[0]

    # 1. big soft blotches, 20-30 cm: value only
    big = N("ShaderNodeTexNoise")
    big.inputs["Scale"].default_value = 3.5
    big.inputs["Detail"].default_value = 1.5
    L(coord.outputs["Object"], big.inputs["Vector"])
    colour = mult(ramp.outputs["Color"], grey_of(big.outputs["Fac"], 0.80, 1.20))
    # 2. dabs, 5 cm, soft-edged cells: value
    dab = N("ShaderNodeTexVoronoi")
    dab.feature = "SMOOTH_F1"
    dab.inputs["Scale"].default_value = 22.0
    dab.inputs["Smoothness"].default_value = 0.25
    L(coord.outputs["Object"], dab.inputs["Vector"])
    sep = N("ShaderNodeSeparateColor")
    L(dab.outputs["Color"], sep.inputs[0])
    colour = mult(colour, grey_of(sep.outputs["Red"], 0.78, 1.22))
    # 3. a few hard-edged paint marks: the top of a noise toward the yellow,
    # the bottom toward the teal, only where the hull faces up (in the light)
    mark = N("ShaderNodeTexNoise")
    mark.inputs["Scale"].default_value = 12.0
    mark.inputs["Detail"].default_value = 2.0
    mark.inputs["Roughness"].default_value = 0.5
    L(coord.outputs["Object"], mark.inputs["Vector"])
    hi = N("ShaderNodeMapRange")
    hi.inputs["From Min"].default_value = 0.58
    hi.inputs["From Max"].default_value = 0.62
    L(mark.outputs["Fac"], hi.inputs["Value"])
    hi_up = N("ShaderNodeMath")
    hi_up.operation = "MULTIPLY"
    L(hi.outputs[0], hi_up.inputs[0])
    L(up.outputs[0], hi_up.inputs[1])
    hi_amt = N("ShaderNodeMath")
    hi_amt.operation = "MULTIPLY"
    hi_amt.inputs[1].default_value = 0.85
    L(hi_up.outputs[0], hi_amt.inputs[0])
    mixy = N("ShaderNodeMix")
    mixy.data_type = "RGBA"
    L(hi_amt.outputs[0], mixy.inputs[0])
    L(colour, mixy.inputs[6])
    mixy.inputs[7].default_value = moss_col("yellow")
    lo = N("ShaderNodeMapRange")
    lo.inputs["From Min"].default_value = 0.42
    lo.inputs["From Max"].default_value = 0.38
    L(mark.outputs["Fac"], lo.inputs["Value"])
    lo_amt = N("ShaderNodeMath")
    lo_amt.operation = "MULTIPLY"
    lo_amt.inputs[1].default_value = 0.5
    L(lo.outputs[0], lo_amt.inputs[0])
    mixt = N("ShaderNodeMix")
    mixt.data_type = "RGBA"
    L(lo_amt.outputs[0], mixt.inputs[0])
    L(mixy.outputs[2], mixt.inputs[6])
    mixt.inputs[7].default_value = moss_col("teal")
    final = mixt.outputs[2]
    return final, up.outputs[0]


def mat_paint(name, sss=False, toon=False):
    mat = bpy.data.materials.new(name)
    nt = cf._nodes(mat)
    N = nt.nodes.new
    L = nt.links.new
    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.0
    colour, up = paint_colour(nt, N, L)
    L(colour, bsdf.inputs["Base Color"])
    if sss:
        bsdf.subsurface_method = "RANDOM_WALK"
        bsdf.inputs["Subsurface Weight"].default_value = 0.3
        bsdf.inputs["Subsurface Radius"].default_value = (0.015, 0.025, 0.008)
        bsdf.inputs["Subsurface Scale"].default_value = 1.0
        bsdf.inputs["Sheen Weight"].default_value = 0.2
        bsdf.inputs["Sheen Roughness"].default_value = 0.6
    if toon:
        # the light gradient painted in: how much the hull faces the key,
        # ramped softly, as emission; a little diffuse keeps the cast shadows
        geo = N("ShaderNodeNewGeometry")
        key = Vector((-1.9, -2.4, 8.6)) - Vector((0, 0, 0.8))
        key.normalize()
        dot = N("ShaderNodeVectorMath")
        dot.operation = "DOT_PRODUCT"
        dot.inputs[1].default_value = key[:]
        L(geo.outputs["Normal"], dot.inputs[0])
        lit = N("ShaderNodeMapRange")
        lit.inputs["From Min"].default_value = -0.4
        lit.inputs["From Max"].default_value = 0.9
        lit.inputs["To Min"].default_value = 0.08
        lit.inputs["To Max"].default_value = 0.55
        L(dot.outputs["Value"], lit.inputs["Value"])
        L(colour, bsdf.inputs["Emission Color"])
        L(lit.outputs[0], bsdf.inputs["Emission Strength"])
    L(bsdf.outputs[0], out.inputs[0])
    return mat


def mat_dabs(name):
    """One flat tone per card from a colour attribute, matte."""
    mat = bpy.data.materials.new(name)
    nt = cf._nodes(mat)
    N = nt.nodes.new
    L = nt.links.new
    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.0
    attr = N("ShaderNodeAttribute")
    attr.attribute_name = "tone"
    L(attr.outputs["Color"], bsdf.inputs["Base Color"])
    L(bsdf.outputs[0], out.inputs[0])
    mat.use_backface_culling = False
    return mat


def mat_shell(name, k, n_shells):
    """Shell k of n: the paint colour, lightened toward the tip, cut by a noise
    threshold rising with k so the outer shells are sparser."""
    mat = bpy.data.materials.new(name)
    nt = cf._nodes(mat)
    N = nt.nodes.new
    L = nt.links.new
    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.0
    colour, up = paint_colour(nt, N, L)
    light = N("ShaderNodeMix")
    light.data_type = "RGBA"
    light.blend_type = "MIX"
    light.inputs[0].default_value = 0.35 * k / max(1, n_shells - 1)
    light.inputs[7].default_value = moss_col("yellow")
    L(colour, light.inputs[6])
    L(light.outputs[2], bsdf.inputs["Base Color"])
    coord = N("ShaderNodeTexCoord")
    nz = N("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 40.0
    nz.inputs["Detail"].default_value = 1.5
    L(coord.outputs["Object"], nz.inputs["Vector"])
    thr = N("ShaderNodeMath")
    thr.operation = "GREATER_THAN"
    thr.inputs[1].default_value = 0.42 + 0.09 * k
    L(nz.outputs["Fac"], thr.inputs[0])
    trans = N("ShaderNodeBsdfTransparent")
    mix = N("ShaderNodeMixShader")
    L(thr.outputs[0], mix.inputs[0])
    L(trans.outputs[0], mix.inputs[1])
    L(bsdf.outputs[0], mix.inputs[2])
    L(mix.outputs[0], out.inputs[0])
    return mat


# ---------------------------------------------------------------- dab cards
def build_dabs(carpet, rock, seed, density=2500, size=(0.02, 0.04), lift=0.0005):
    """Small flat ovals lying on the carpet (and, sparsely, on the rock just
    beyond its edge), each one palette tone chosen by how far up it faces."""
    rng = random.Random(seed)
    me = carpet.data
    M = carpet.matrix_world
    R = M.to_3x3()
    me.calc_loop_triangles()
    tris = me.loop_triangles
    verts = me.vertices
    areas = []
    for t in tris:
        a, b, c = (M @ verts[i].co for i in t.vertices)
        areas.append((b - a).cross(c - a).length / 2)
    total = sum(areas)
    count = int(total * density)
    cum = []
    s = 0.0
    for a in areas:
        s += a
        cum.append(s)
    import bisect

    def tone_for(nz):
        f = smoothstep(-0.3, 1.0, nz)
        f = min(1.0, max(0.0, f + rng.uniform(-0.25, 0.25)))
        if f < 0.5:
            c0, c1, t = moss_col("shade"), moss_col("mid"), f / 0.5
        else:
            c0, c1, t = moss_col("mid"), moss_col("lit"), (f - 0.5) / 0.5
        col = [c0[i] + (c1[i] - c0[i]) * t for i in range(3)]
        if rng.random() < 0.12:   # the odd yellow or teal dab
            extra = moss_col("yellow" if nz > 0.4 else "teal")
            col = [0.5 * (col[i] + extra[i]) for i in range(3)]
        v = rng.uniform(0.9, 1.1)
        return [c * v for c in col] + [1.0]

    bm = bmesh.new()
    tones = []
    SEG = 6

    def card(p, n, rad):
        # an oval of SEG sides, tangent to n, lifted a little
        t = n.cross(Vector((0.3, 0.7, 0.2))).normalized()
        b = n.cross(t)
        ang = rng.uniform(0, math.pi)
        ca, sa = math.cos(ang), math.sin(ang)
        t, b = t * ca + b * sa, b * ca - t * sa
        ex, ey = rad, rad * rng.uniform(0.6, 0.9)
        vs = []
        for i in range(SEG):
            a = 2 * math.pi * i / SEG
            vs.append(bm.verts.new(p + n * lift + t * (ex * math.cos(a)) + b * (ey * math.sin(a))))
        bm.faces.new(vs)
        tones.append(tone_for(n.z))

    for _ in range(count):
        i = bisect.bisect(cum, rng.random() * total)
        i = min(i, len(tris) - 1)
        t = tris[i]
        r1, r2 = rng.random(), rng.random()
        if r1 + r2 > 1:
            r1, r2 = 1 - r1, 1 - r2
        a, b, c = (M @ verts[j].co for j in t.vertices)
        p = a + (b - a) * r1 + (c - a) * r2
        n = (R @ t.normal).normalized()
        card(p, n, rng.uniform(*size))
    # specks on the rock just beyond the edge: boundary vertices, pushed outward along the surface
    bverts = [v for v in me.vertices]
    me.edges.data
    boundary = set()
    cnt = {}
    for e in me.edges:
        cnt[e.key] = 0
    for t in tris:
        for k in range(3):
            key = tuple(sorted((t.vertices[k], t.vertices[(k + 1) % 3])))
            cnt[key] = cnt.get(key, 0) + 1
    for key, c in cnt.items():
        if c == 1:
            boundary.update(key)
    boundary = list(boundary)
    rng.shuffle(boundary)
    rock_eval = rock
    for vi in boundary[: min(len(boundary), int(len(boundary) * 0.25))]:
        v = bverts[vi]
        p = M @ v.co
        n = (R @ v.normal).normalized()
        # a step away from the carpet along the rock
        away = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))).normalized()
        away = (away - n * away.dot(n)).normalized()
        q = p + away * rng.uniform(0.02, 0.09)
        ok, loc, nor, _ = rock_eval.closest_point_on_mesh(rock_eval.matrix_world.inverted() @ q)
        if not ok:
            continue
        loc = rock_eval.matrix_world @ loc
        nor = (rock_eval.matrix_world.to_3x3() @ nor).normalized()
        card(loc, nor, rng.uniform(0.012, 0.03))
    out = bpy.data.meshes.new(carpet.name + ".dabs")
    bm.to_mesh(out)
    bm.free()
    attr = out.attributes.new("tone", "FLOAT_COLOR", "FACE")
    flat = [c for tone in tones for c in tone]
    attr.data.foreach_set("color", flat)
    for p in out.polygons:
        p.use_smooth = True
    ob = cf.new_object(carpet.name + ".dabs", out)
    ob.pass_index = 2
    ob.visible_shadow = False
    return ob


def build_shells(carpet, n_shells=5, gap=0.008):
    outs = []
    for k in range(n_shells):
        me = carpet.data.copy()
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.normal_update()
        for v in bm.verts:
            v.co += v.normal * gap * (k + 1)
        bm.to_mesh(me)
        bm.free()
        ob = cf.new_object("%s.shell%d" % (carpet.name, k), me)
        ob.matrix_world = carpet.matrix_world.copy()
        ob.pass_index = 2
        me.materials.clear()
        me.materials.append(mat_shell("Shell%d" % k, k, n_shells))
        outs.append(ob)
    return outs


# ---------------------------------------------------------------- kuwahara post
def setup_kuwahara(sc, size=8):
    """Compositor: anisotropic Kuwahara over the pixels whose object index is 2 (the moss)."""
    vl = sc.view_layers[0]
    vl.use_pass_object_index = True
    ng = bpy.data.node_groups.new("Comp", "CompositorNodeTree")
    sc.compositing_node_group = ng
    N = ng.nodes.new
    L = ng.links.new
    rl = N("CompositorNodeRLayers")
    rl.scene = sc
    rl.layer = vl.name
    print("[kuwahara] render layer outputs", [o.name for o in rl.outputs])
    kw = N("CompositorNodeKuwahara")
    kw.inputs["Size"].default_value = size
    idm = N("CompositorNodeIDMask")
    idm.inputs["Index"].default_value = 2
    idm.inputs["Anti-Alias"].default_value = True
    mix = N("ShaderNodeMix")
    mix.data_type = "RGBA"
    L(rl.outputs["Image"], kw.inputs["Image"])
    L(rl.outputs["Object Index"], idm.inputs["ID value"])
    L(idm.outputs["Alpha"], mix.inputs[0])
    L(rl.outputs["Image"], mix.inputs[6])
    L(kw.outputs["Image"], mix.inputs[7])
    ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    gout = N("NodeGroupOutput")
    L(mix.outputs[2], gout.inputs[0])
    sc.render.use_compositing = True


# ---------------------------------------------------------------- lights
def light_rig(name, sc):
    """v6: the rock study's pick. soft: the same rig with the key a quarter as strong and
    twice as big and the world lifted, exposure up to match (the moss off AgX's shoulder).
    overcast: no key, a bright cool sky dome and a weak warm sun from above."""
    rs.light_v6(3600)
    bpy.data.objects["ground"].scale = (4, 4, 1)
    if name == "v6":
        return
    key = bpy.data.objects["key"]
    if name == "soft":
        key.data.energy = 900
        key.data.size = 6.0
        bpy.data.lights["fill"].energy = 60
        bpy.data.lights["rim"].energy = 40
        bpy.data.worlds[0].node_tree.nodes["Background"].inputs[0].default_value = (0.02, 0.03, 0.05, 1)
        sc.view_settings.exposure = 0.8
    elif name == "overcast":
        for n in ("key", "fill", "rim"):
            bpy.data.lights[n].energy = 0
        bpy.data.worlds[0].node_tree.nodes["Background"].inputs[0].default_value = (0.25, 0.32, 0.45, 1)
        sun_d = bpy.data.lights.new("sun", "SUN")
        sun_d.color = (1.0, 0.85, 0.6)
        sun_d.energy = 1.5
        sun_d.angle = math.radians(25)
        sun = cf.new_object("sun", sun_d)
        sun.rotation_euler = (Vector((0, 0, 0)) - Vector((-0.6, -0.8, 4.0))).to_track_quat("-Z", "Y").to_euler()
        sc.view_settings.exposure = 0.3
    else:
        raise SystemExit("unknown light " + name)


# ---------------------------------------------------------------- calibration
REF_BANDS = ((61, 81, 53), (104, 128, 68), (153, 169, 78))   # the second reference: darkest, mid, lightest


def calibrate(args, rocks, cam, gain, path):
    """Render the 3/4 view small, measure the moss's lightest band, scale the gain per channel
    by the linear ratio to the reference's lightest, `args.calibrate` times. AgX is not linear
    in albedo near its shoulder, so one pass is not enough and three usually are."""
    import json
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import numpy as np
    from moss_compare import bands_of
    sc = bpy.context.scene
    keep = (sc.cycles.samples, sc.render.resolution_x)
    sc.cycles.samples = 24
    sc.render.resolution_x = sc.render.resolution_y = 400
    gain = gain if isinstance(gain, dict) else {"dark": list(gain), "light": list(gain)}
    mat = mat_vcol("Calib")
    tmp = os.path.join(args.out, "calib_%s_%s.png" % (args.light, args.view))
    for k in range(args.calibrate):
        carpets = []
        for i, r in enumerate(rocks):
            c = grow_clumps(r, seed=100 + i, voxel=args.voxel, thick=args.thick, taper=args.taper, dab=args.clump,
                            fingers=args.fingers, light_reach=args.reach, flat=args.geom == "clumpflat", gain=gain, spread=args.spread)
            if c is not None:
                c.data.materials.append(mat)
                carpets.append(c)
        cf.aim_camera(cam, rocks, *{"3q": (-38, 22)}["3q"])
        cf.render(tmp)
        img = bpy.data.images.load(tmp)
        w, h = img.size
        a = np.array(img.pixels[:], dtype=float).reshape(h, w, 4)[::-1, :, :3]
        bpy.data.images.remove(img)
        bands = bands_of(a)
        for c in carpets:
            me = c.data
            bpy.data.objects.remove(c)
            bpy.data.meshes.remove(me)
        if bands is None:
            print("[calib] no moss pixels found")
            break
        # the light endpoint from the lightest band, the dark endpoint from the darkest
        # (a mid-only fit pushed the albedo past 1 and bleached the centre)
        for key, bi in (("dark", 0), ("light", 2)):
            ratio = [((t / 255) ** 2.2) / (max(m, 1) / 255) ** 2.2 for t, m in zip(REF_BANDS[bi], bands[bi])]
            ratio = [r ** 0.8 for r in ratio]   # damp: the shoulder exaggerates the needed step
            gain[key] = [min(2.5, g * r) for g, r in zip(gain[key], ratio)]
        print("[calib] pass %d: bands %s -> dark %s light %s" % (k + 1, bands, [round(g, 3) for g in gain["dark"]], [round(g, 3) for g in gain["light"]]))
    json.dump({"gain": gain, "bands_ref": REF_BANDS}, open(path, "w"))
    sc.cycles.samples, sc.render.resolution_x = keep
    sc.render.resolution_y = keep[1]
    return gain


# ---------------------------------------------------------------- main
def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--surface", default="paint")
    ap.add_argument("--geom", default="layers", choices=["cushion", "mound", "clump", "clumpflat", "layers"])
    ap.add_argument("--layers", type=int, default=5)
    ap.add_argument("--edge", type=float, default=0.010, help="layers: a dab's soft edge width, m")
    ap.add_argument("--cblur", type=int, default=0, help="layers: passes of colour averaging over the mesh")
    ap.add_argument("--levels", type=int, default=8, help="layers: tone steps from darkest to lightest")
    ap.add_argument("--light", default="v6", choices=["v6", "soft", "overcast"])
    ap.add_argument("--view", default="agx", choices=["agx", "neutral", "filmic", "standard"], help="view transform: AgX desaturates bright greens")
    ap.add_argument("--gain", type=float, default=None, help="clump carpet: albedo gain on the reference colours (default: out/moss/calib_<light>.json, else _CORR)")
    ap.add_argument("--calibrate", type=int, default=0, help="clump carpet: N passes of render-measure-correct on the mid band, saved per light")
    ap.add_argument("--taper", type=float, default=0.35)
    ap.add_argument("--clump", type=float, default=0.15, help="clump carpet: a dab's dome height as a fraction of its radius")
    ap.add_argument("--spread", type=float, default=0.2, help="clump carpet: a dab's own lightness draw (sigma)")
    ap.add_argument("--fingers", type=float, default=0.10, help="clump carpet: how far a finger of light pushes past the reach, m")
    ap.add_argument("--reach", type=float, default=0.5, help="clump carpet: lightness reaches full this fraction of the patch's depth in from its edge")
    ap.add_argument("--out", default="out/moss")
    ap.add_argument("--samples", type=int, default=64)
    ap.add_argument("--size", type=int, default=640)
    ap.add_argument("--views", default="3q,top")
    ap.add_argument("--thick", type=float, default=0.09)
    ap.add_argument("--voxel", type=float, default=0.006)
    ap.add_argument("--tag", default="")
    ap.add_argument("--save", action="store_true")
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    surfaces = ["sludge", "paint", "sss", "toon", "dabs", "shells", "kuwahara"] if args.surface == "all" else args.surface.split(",")
    if args.geom in ("clump", "clumpflat", "layers") and args.surface == "paint":
        surfaces = ["vcol"]

    import time
    sc = cf.reset_scene()
    sc.cycles.samples = args.samples
    sc.render.resolution_x = sc.render.resolution_y = args.size
    cam = cf.build_stage()
    light_rig(args.light, sc)
    if args.view != "agx":
        sc.view_settings.view_transform = {"neutral": "Khronos PBR Neutral", "filmic": "Filmic", "standard": "Standard"}[args.view]
        sc.view_settings.look = "Medium Contrast" if args.view == "filmic" else "None"
    t0 = time.time()
    rocks = rs.v_pillow(argparse.Namespace(**RECIPE_F))
    rock_mat = rs.mat_plain("Painted", 99, "v6", 0.1)
    for ob in rocks:
        ob.data.materials.append(rock_mat)
    print("[build] rock-b %.1f s" % (time.time() - t0))

    calib_path = os.path.join(args.out, "calib_%s_%s.json" % (args.light, args.view))
    gain = args.gain
    if gain is None and args.geom in ("clump", "clumpflat", "layers") and os.path.exists(calib_path) and not args.calibrate:
        import json
        gain = json.load(open(calib_path))["gain"]
        print("[calib] %s gain %s" % (args.light, gain))
    if args.calibrate and args.geom.startswith("clump"):
        gain = calibrate(args, rocks, cam, gain if gain is not None else _CORR, calib_path)

    t0 = time.time()
    carpets = []
    for i, r in enumerate(rocks):
        if args.geom == "layers":
            c = grow_layers(r, seed=100 + i, voxel=args.voxel, layers=args.layers, gain=gain, edge=args.edge, cblur=args.cblur, levels=args.levels)
        elif args.geom.startswith("clump"):
            c = grow_clumps(r, seed=100 + i, voxel=args.voxel, thick=args.thick, taper=args.taper, dab=args.clump,
                            fingers=args.fingers, light_reach=args.reach, flat=args.geom == "clumpflat", gain=gain, spread=args.spread)
        else:
            c = grow_carpet(r, seed=100 + i, geom=args.geom, voxel=args.voxel, thick=args.thick)
        if c is not None:
            carpets.append(c)
    tris = 0
    for c in carpets:
        c.data.calc_loop_triangles()
        tris += len(c.data.loop_triangles)
    print("[build] carpet %s: %d patches, %d tris, %.1f s" % (args.geom, len(carpets), tris, time.time() - t0))

    views = {"3q": (-38, 22), "front": (0, 10), "side": (90, 10), "top": (-15, 68), "high": (-38, 45), "close": (-30, 30)}
    for surface in surfaces:
        extras = []
        if surface == "sludge":
            mat = cf.mat_moss("Moss")
        elif surface == "vcol":
            mat = mat_vcol("MossVcol")
        elif surface == "paint" or surface == "kuwahara":
            mat = mat_paint("MossPaint")
        elif surface == "sss":
            mat = mat_paint("MossSSS", sss=True)
        elif surface == "toon":
            mat = mat_paint("MossToon", toon=True)
        elif surface == "dabs":
            mat = mat_paint("MossUnder")
            dm = mat_dabs("Dab")
            t1 = time.time()
            n = 0
            for c in carpets:
                rock = bpy.data.objects[c.name.replace(".moss", "")]
                d = build_dabs(c, rock, seed=hash(c.name) & 0xFFFF)
                d.data.materials.append(dm)
                n += len(d.data.polygons)
                extras.append(d)
            print("[build] dabs: %d cards, %.1f s" % (n, time.time() - t1))
        elif surface == "shells":
            mat = mat_paint("MossBase")
            for c in carpets:
                extras += build_shells(c)
        else:
            raise SystemExit("unknown surface " + surface)
        for c in carpets:
            if c.get("baked"):
                continue
            c.data.materials.clear()
            c.data.materials.append(mat)
        if surface == "kuwahara":
            setup_kuwahara(sc)
        else:
            sc.render.use_compositing = False
            if hasattr(sc, "compositing_node_group"):
                sc.compositing_node_group = None
        for name in args.views.split(","):
            az, el = views[name]
            pad = 0.78
            if name == "close":
                pad = 0.45
            cf.aim_camera(cam, rocks, az, el, pad=pad)
            t1 = time.time()
            cf.render(os.path.join(args.out, "%s%s_%s.png" % (surface, args.tag, name)))
            print("[render] %s %s %.1f s" % (surface, name, time.time() - t1))
        if args.save:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.out, surface + args.tag + ".blend"))
        for ob in extras:
            me = ob.data
            bpy.data.objects.remove(ob)
            bpy.data.meshes.remove(me)


if __name__ == "__main__":
    main()
