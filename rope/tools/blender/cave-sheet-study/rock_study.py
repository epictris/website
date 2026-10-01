"""Rock geometry study: build the rock-b mass several ways and render each
in the study's stage, flat grey, so only the geometry is judged.

    blender -b --python rock_study.py -- --variant chisel [--out out/rock]

Base forms (--variant):

  hull      the report's baseline: convex hulls of random points
  zaal      icosphere, cloud displace, collapse + planar decimate (Greg Zaal)
  pillow    stacked boxes: corner cuts -> bevel -> voxel remesh -> treatment
  fracture  one mass split into Voronoi cells, each treated (rejected: wedges)

The treatment (see `treat`) is the same for pillow and fracture and is all
flags: --corners (primary form), --bevel/--round (weathering), --cuts
(chisel planes), --big/--grit/--dome (relief), --target/--angle (facets).

Tris chose F on 2026-10-01 (G's crackle domes were "too complex"), with the
painted neutral stone (--material plain, after assets-src/studies/cave-sheets/texture/rock-texture-ref*.png:
the stone is dark slate blue, the warmth is a strong near-vertical sun from
behind, the shade is a blue sky dome, nothing has specular) and crisper
edges than F had (--bevel 0.08):

    blender -b --python rock_study.py -- --variant pillow --corners 14 \
        --bevel 0.08 --round 4 --big 0.05 --big-scale 1.5 --grit 0.004 \
        --cuts 80 --cut-depth 0.025 --cut-tilt 0.15 --target 1200 --angle 9 \
        --material plain --light warm --view standard --key 60000 --sky 3 \
        --views 3q,front,side,top

then `python3 rock_compare.py` for the review sheets (the reference sheets
come from `just sources`, see docs/cave-look.md).

Everything is deterministic (seeded random, no physics, no noise_vector).
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


# ---------------------------------------------------------------- layout
# rock-b: 2.68 x 1.84 x 1.56 m. A tall column at the back left, a mid tier in
# front of it, a long low boulder on the right, two loose stones at the foot.
# (name, centre, half-size, yaw)
LAYOUT = [
    ("column", (-0.60, 0.35, 0.86), (0.58, 0.60, 0.86), 0.10),
    ("tier", (-0.05, 0.00, 0.55), (0.74, 0.64, 0.55), -0.18),
    ("boulder", (0.68, -0.22, 0.38), (0.68, 0.58, 0.38), 0.35),
    ("front", (-0.30, -0.68, 0.24), (0.50, 0.34, 0.24), -0.4),
    ("foot", (-1.02, -0.18, 0.22), (0.34, 0.32, 0.22), 0.9),
]
# loose stones that are never part of the fractured mass
LOOSE = [
    ("pebble", (1.25, -0.80, 0.10), (0.16, 0.13, 0.10), 0.2),
]


def smoothstep(e0, e1, x):
    return cf.smoothstep(e0, e1, x)


def unit_vector(rng):
    """A seeded random direction (the noise module's own is global state)."""
    while True:
        v = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        if 1e-3 < v.length <= 1.0:
            return v.normalized()


# ---------------------------------------------------------------- helpers
def mesh_to_object(name, bm, matrix=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = cf.new_object(name, me)
    if matrix is not None:
        ob.matrix_world = matrix
    return ob


def apply_modifiers(ob):
    final = cf.evaluated_mesh(ob)
    ob.modifiers.clear()
    old = ob.data
    ob.data = final
    bpy.data.meshes.remove(old)
    return ob


def flat_shade(ob):
    for p in ob.data.polygons:
        p.use_smooth = False


def box(name, centre, half, yaw):
    """An axis-aligned cube of the given half-size, placed and yawed."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * half[0], v.co.y * half[1], v.co.z * half[2]))
    M = Matrix.Translation(Vector(centre)) @ Matrix.Rotation(yaw, 4, "Z")
    return mesh_to_object(name, bm, M)


def pillow(ob, voxel=0.03, iters=12, factor=1.0, bevel=0.0):
    """Bevel every edge by `bevel` metres (the weathered-block rounding),
    voxel remesh, then a little smoothing to take the bevel's own creases out."""
    if bevel > 0:
        bv = ob.modifiers.new("bevel", "BEVEL")
        bv.width = bevel
        bv.segments = 6
        bv.limit_method = "ANGLE"
        bv.angle_limit = math.radians(30)
    rm = ob.modifiers.new("remesh", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = voxel
    sm = ob.modifiers.new("smooth", "SMOOTH")
    sm.factor = factor
    sm.iterations = iters
    return apply_modifiers(ob)


def facet(ob, target=800, angle=14.0):
    """Greg Zaal's two decimates: collapse until the topology is random
    triangles (to about `target` of them), then planar dissolve so
    near-coplanar runs merge into facets."""
    ob.data.calc_loop_triangles()
    n = len(ob.data.loop_triangles)
    ratio = min(1.0, target / max(n, 1))
    if ratio < 1.0:
        d1 = ob.modifiers.new("collapse", "DECIMATE")
        d1.decimate_type = "COLLAPSE"
        d1.ratio = ratio
        d1.use_collapse_triangulate = True
    d2 = ob.modifiers.new("planar", "DECIMATE")
    d2.decimate_type = "DISSOLVE"
    d2.angle_limit = math.radians(angle)
    d2.use_dissolve_boundaries = True
    apply_modifiers(ob)
    flat_shade(ob)
    # a random value per facet for the painted shader's per-facet tone
    me = ob.data
    attr = me.attributes.new("facet", "FLOAT", "FACE")
    rng = random.Random(ob.name)
    attr.data.foreach_set("value", [rng.random() for _ in range(len(me.polygons))])
    return ob


def mat_plain(name, debug=99, albedo="slate", spec=0.0):
    """Painted stone after the texture references (docs/cave-look.md): matte, no pattern, a slow
    warm/cool drift across the block, a slightly different tone per facet,
    faint grain, crevices darkened, a soft light line on the facet edges."""
    mat = bpy.data.materials.new(name)
    nt = cf._nodes(mat)
    N = nt.nodes.new
    L = nt.links.new
    out = N("ShaderNodeOutputMaterial")
    bsdf = N("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Specular IOR Level"].default_value = spec  # painted: no gloss (v6 had 0.1)
    L(bsdf.outputs[0], out.inputs[0])

    coord = N("ShaderNodeTexCoord")
    drift = N("ShaderNodeTexNoise")
    drift.inputs["Scale"].default_value = 0.9
    drift.inputs["Detail"].default_value = 2.0
    L(coord.outputs["Object"], drift.inputs["Vector"])
    base = N("ShaderNodeMix")
    base.data_type = "RGBA"
    cool, warm, line = {"slate": ("#262c3c", "#30343f", "#5c6070"),
                        "v6": ("#2f3546", "#3b3e4a", "#5c6070")}[albedo]
    base.inputs[6].default_value = cf.srgb(cool)  # dark slate blue
    base.inputs[7].default_value = cf.srgb(warm)  # dark slate, a hair less blue
    L(drift.outputs["Fac"], base.inputs[0])

    def scalar_mul(a, b):
        m = N("ShaderNodeMath")
        m.operation = "MULTIPLY"
        L(a, m.inputs[0])
        L(b, m.inputs[1])
        return m.outputs[0]

    facet = N("ShaderNodeAttribute")
    facet.attribute_name = "facet"
    ftone = N("ShaderNodeMapRange")
    ftone.inputs["To Min"].default_value = 0.92
    ftone.inputs["To Max"].default_value = 1.08
    L(facet.outputs["Fac"], ftone.inputs["Value"])

    grain = N("ShaderNodeTexNoise")
    grain.inputs["Scale"].default_value = 35.0
    grain.inputs["Detail"].default_value = 3.0
    L(coord.outputs["Object"], grain.inputs["Vector"])
    gtone = N("ShaderNodeMapRange")
    gtone.inputs["To Min"].default_value = 0.96
    gtone.inputs["To Max"].default_value = 1.04
    L(grain.outputs["Fac"], gtone.inputs["Value"])

    stretch = N("ShaderNodeMapping")
    stretch.inputs["Scale"].default_value = (3.0, 3.0, 0.7)
    L(coord.outputs["Object"], stretch.inputs["Vector"])
    stain = N("ShaderNodeTexNoise")
    stain.inputs["Scale"].default_value = 1.0
    stain.inputs["Detail"].default_value = 2.0
    L(stretch.outputs[0], stain.inputs["Vector"])
    stone = N("ShaderNodeMapRange")
    stone.inputs["From Min"].default_value = 0.35
    stone.inputs["From Max"].default_value = 0.65
    stone.inputs["To Min"].default_value = 0.75
    stone.inputs["To Max"].default_value = 1.0
    L(stain.outputs["Fac"], stone.inputs["Value"])

    ao = N("ShaderNodeAmbientOcclusion")
    ao.inputs["Distance"].default_value = 0.5
    ao.samples = 8
    atone = N("ShaderNodeMapRange")
    atone.inputs["To Min"].default_value = 0.55
    atone.inputs["To Max"].default_value = 1.0
    L(ao.outputs["AO"], atone.inputs["Value"])

    tone = scalar_mul(scalar_mul(scalar_mul(ftone.outputs[0], gtone.outputs[0]), atone.outputs[0]), stone.outputs[0])
    tone_rgb = N("ShaderNodeCombineColor")
    for i in range(3):
        L(tone, tone_rgb.inputs[i])
    toned = N("ShaderNodeMix")
    toned.data_type = "RGBA"
    toned.blend_type = "MULTIPLY"
    toned.inputs[0].default_value = 1.0
    L(base.outputs[2], toned.inputs[6])
    L(tone_rgb.outputs[0], toned.inputs[7])

    bev = N("ShaderNodeBevel")
    bev.samples = 8
    bev.inputs["Radius"].default_value = 0.03
    geo = N("ShaderNodeNewGeometry")
    dot = N("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    L(bev.outputs["Normal"], dot.inputs[0])
    L(geo.outputs["Normal"], dot.inputs[1])
    edge = N("ShaderNodeMapRange")
    edge.inputs["From Min"].default_value = 0.995
    edge.inputs["From Max"].default_value = 0.92
    edge.inputs["To Min"].default_value = 0.0
    edge.inputs["To Max"].default_value = 0.35
    L(dot.outputs["Value"], edge.inputs["Value"])
    edged = N("ShaderNodeMix")
    edged.data_type = "RGBA"
    edged.inputs[7].default_value = cf.srgb(line)
    L(toned.outputs[2], edged.inputs[6])
    L(edge.outputs[0], edged.inputs[0])
    stages = [base.outputs[2], toned.outputs[2], edged.outputs[2]]
    L(stages[min(debug, 2)], bsdf.inputs["Base Color"])
    if debug >= 3:
        L(bev.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def displace(ob, fn):
    """Move every vertex by fn(world_point, world_normal, local_vert) -> Vector (world)."""
    me = ob.data
    M = ob.matrix_world
    R = M.to_3x3()
    Ri = R.inverted()
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    for v in bm.verts:
        p = M @ v.co
        n = (R @ v.normal).normalized()
        d = fn(p, n, v)
        v.co += Ri @ d
    bm.to_mesh(me)
    bm.free()


def noise3(p):
    """Three independent noises as a vector in [-0.5, 0.5]^3. (noise.noise_vector
    is seeded per process and so not reproducible; noise.noise is.)"""
    return Vector((noise.noise(p) - 0.5, noise.noise(p + Vector((31.7, 0, 0))) - 0.5, noise.noise(p + Vector((0, 57.3, 0))) - 0.5))


def crackle(p, cell, warp=0.25):
    """Voronoi F2-F1 of a warped lattice: 0 on cell borders, ~cell/2 in the
    middle of a cell. The warp bends the straight borders."""
    q = p / cell
    if warp:
        q = q + noise3(q * 0.7) * warp
    d = noise.voronoi(q)[0]
    return (d[1] - d[0]), d[0]


def chisel_field(cell=0.26, dome=0.045, seed=0, big=0.10, big_scale=0.9, grit=0.006):
    """The 'chiselled cobble' relief: each Voronoi cell domes outward and the
    borders stay as creases; a slow large noise bends the block's planes; a
    little grit breaks the planar decimate's regularity."""
    rng = random.Random(seed)
    off = Vector((rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100)))
    off2 = Vector((rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100)))

    def fn(p, n, v):
        c, _ = crackle(p + off, cell)
        h = smoothstep(0.0, 0.9, c / (0.5))  # 0 at borders -> 1 at cell middles
        h = h ** 0.6                          # flat tops, sharp creases
        low = noise.noise((p + off2) * big_scale)
        g = noise.noise((p + off) * 25.0)
        return n * (dome * (h - 0.5) + big * low + grit * g)
    return fn


# ---------------------------------------------------------------- variants
def v_hull(a):
    """The report's baseline, for the side-by-side: random hulls (cave_features)."""
    return cf.build_cluster()


def v_zaal(a):
    """Icosphere -> cloud displace (vector) -> normal displace -> collapse ->
    planar 25 (blog.gregzaal.com, 2013)."""
    out = []
    for i, (name, c, h, yaw) in enumerate(LAYOUT + LOOSE):
        rng = random.Random(20 + i)
        off = Vector((rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100)))
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=5, radius=1.0)
        for v in bm.verts:
            v.co = Vector((v.co.x * h[0], v.co.y * h[1], v.co.z * h[2]))
        M = Matrix.Translation(Vector(c)) @ Matrix.Rotation(yaw, 4, "Z")
        ob = mesh_to_object(name, bm, M)
        s = min(h)

        def fn(p, n, v, off=off, s=s):
            big = noise3((p + off) * 0.9) * (0.7 * s)
            rough = noise.turbulence((p + off) * 3.0, 3, True) * (0.08 * s)
            return big + n * rough
        displace(ob, fn)
        for v in ob.data.vertices:
            v.co.z = max(v.co.z, -h[2] * 0.85)
        facet(ob, target=a.target * max(h) / 0.8, angle=25)
        out.append(ob)
    return out


def treat(ob, i, a, size):
    """The shared surface treatment, on a pillowed shell: plane cuts, a
    remesh + light smooth that softens the cut edges, the relief field,
    then the two decimates. `size` scales the cut count and depth."""
    if a.cuts:
        plane_cuts(ob, int(a.cuts * size), (a.cut_depth * 0.4, a.cut_depth), seed=50 + i, tilt=a.cut_tilt)
        rm = ob.modifiers.new("remesh", "REMESH")
        rm.mode = "VOXEL"
        rm.voxel_size = 0.02
        sm = ob.modifiers.new("smooth", "SMOOTH")
        sm.factor = 1.0
        sm.iterations = a.cut_soft
        apply_modifiers(ob)
    if a.dome or a.big or a.grit:
        displace(ob, chisel_field(cell=a.cell, dome=a.dome, seed=60 + i, big=a.big, big_scale=a.big_scale, grit=a.grit))
    facet(ob, target=a.target * size / 0.8, angle=a.angle)
    return ob


def v_pillow(a):
    """Stacked pillow blocks (cube -> remesh -> smooth), each treated."""
    out = []
    for i, (name, c, h, yaw) in enumerate(LAYOUT + LOOSE):
        ob = box(name, c, h, yaw)
        if a.corners:
            corner_cuts(ob, a.corners, (a.corner_depth * 0.4, a.corner_depth), seed=70 + i, tilt=a.corner_tilt)
        pillow(ob, voxel=0.025, iters=a.round, bevel=a.bevel * min(h))
        treat(ob, i, a, max(h))
        out.append(ob)
    return out


def voronoi_cells(mass, seeds):
    """Split a closed mesh into the Voronoi cells of the seeds, by bisecting
    each copy with every perpendicular bisector plane and capping the cuts."""
    cells = []
    for i, si in enumerate(seeds):
        bm = bmesh.new()
        bm.from_mesh(mass.data)
        bm.transform(mass.matrix_world)
        for j, sj in enumerate(seeds):
            if i == j:
                continue
            mid = (si + sj) / 2
            nrm = (sj - si).normalized()
            geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
            res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=mid, plane_no=nrm,
                                         clear_outer=True, clear_inner=False)
            cut_edges = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
            if cut_edges:
                bmesh.ops.holes_fill(bm, edges=cut_edges, sides=0)
                bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        if len(bm.faces) == 0:
            bm.free()
            continue
        cells.append(mesh_to_object("cell%d" % i, bm))
    return cells


def v_fracture(a):
    """One pillowed mass -> Voronoi cells (tight seams, like a mass that
    cracked) -> each cell pillowed again (rounds the seams into fissures)
    -> treated."""
    parts = [box(n, c, h, yaw) for n, c, h, yaw in LAYOUT]
    bm = bmesh.new()
    for p in parts:
        p.data.transform(p.matrix_world)
        bm.from_mesh(p.data)  # from_mesh appends, so the parts pile into one shell
    for p in parts:
        bpy.data.objects.remove(p)
    mass = mesh_to_object("mass", bm)
    pillow(mass, voxel=0.03, iters=10)
    rng = random.Random(31)
    seeds = []
    for n, c, h, yaw in LAYOUT:
        seeds.append(Vector(c) + Vector((rng.uniform(-0.1, 0.1), rng.uniform(-0.1, 0.1), rng.uniform(-0.1, 0.1))))
        if max(h) > 0.6 and a.split:
            seeds.append(Vector(c) + Vector((rng.uniform(-0.5, 0.5) * h[0], rng.uniform(-0.5, 0.5) * h[1], rng.uniform(0.2, 0.9) * h[2])))
    cells = voronoi_cells(mass, seeds)
    bpy.data.objects.remove(mass)
    out = []
    for i, ob in enumerate(cells):
        if a.corners:
            corner_cuts(ob, a.corners, (a.corner_depth * 0.4, a.corner_depth), seed=70 + i, tilt=a.corner_tilt)
        pillow(ob, voxel=0.025, iters=a.round, bevel=a.bevel * min(ob.dimensions) / 2)
        d = ob.dimensions
        treat(ob, i, a, max(d) / 2)
        out.append(ob)
    for i, (n, c, h, yaw) in enumerate(LOOSE):
        ob = box(n, c, h, yaw)
        pillow(ob, voxel=0.02, iters=a.round, bevel=a.bevel * min(h))
        treat(ob, 90 + i, a, max(h))
        out.append(ob)
    return out


def plane_cuts(ob, count, depth, seed, side_bias=0.6, tilt=0.3):
    """Chisel: slice a shallow cap off the surface at random points, the cut
    plane tilted off the surface normal, and cap the hole flat."""
    rng = random.Random(seed)
    me = ob.data
    M = ob.matrix_world
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.transform(M)
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    done = 0
    while done < count and len(bm.faces):
        f = rng.choice(bm.faces)
        n = f.normal.copy()
        if n.z > 0.85 and rng.random() < side_bias:
            continue  # spare most of the top so it stays a shelf
        n = (n + unit_vector(rng) * rng.uniform(0.3, 1.0) * tilt).normalized()
        d = rng.uniform(depth[0], depth[1])
        co = f.calc_center_median() - n * d
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=n, clear_outer=True)
        cut = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        if cut:
            bmesh.ops.holes_fill(bm, edges=cut, sides=0)
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bm.normal_update()
        bm.faces.ensure_lookup_table()
        done += 1
    bm.transform(M.inverted())
    bm.to_mesh(me)
    bm.free()


def corner_cuts(ob, count, depth, seed, tilt=0.5, keep_base=True):
    """Primary form: knock corners off. Each cut picks a vertex, cuts a plane
    `depth` in from it facing away from the centroid (tilted), caps the hole.
    depth is (lo, hi) as a fraction of the smallest half-size."""
    rng = random.Random(seed)
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    half = min(ob.dimensions) / 2
    done = 0
    tries = 0
    while done < count and tries < count * 6:
        tries += 1
        bm.verts.ensure_lookup_table()
        c = sum((v.co for v in bm.verts), Vector()) / len(bm.verts)
        v = rng.choice(bm.verts)
        n = (v.co - c)
        if keep_base and n.z < -0.4 * n.length:
            continue  # leave the underside flat so it sits
        n = (n.normalized() + unit_vector(rng) * rng.uniform(0.3, 1.0) * tilt).normalized()
        d = rng.uniform(depth[0], depth[1]) * half
        co = v.co - n * d
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=n, clear_outer=True)
        cut = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        if cut:
            bmesh.ops.holes_fill(bm, edges=cut, sides=0)
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        done += 1
    bm.to_mesh(me)
    bm.free()


VARIANTS = {
    "hull": v_hull,
    "zaal": v_zaal,
    "pillow": v_pillow,
    "fracture": v_fracture,
}


# ---------------------------------------------------------------- main
def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", required=True, choices=sorted(VARIANTS))
    ap.add_argument("--out", default="out/rock")
    ap.add_argument("--samples", type=int, default=64)
    ap.add_argument("--size", type=int, default=640)
    ap.add_argument("--views", default="3q,front")
    ap.add_argument("--material", default="grey", choices=["grey", "stone", "plain"])
    ap.add_argument("--plain-debug", type=int, default=99, help="painted shader stages: 0 base, 1 +tones, 2 +edge, 3 +bevel normal")
    ap.add_argument("--view", default="agx", choices=["agx", "standard"], help="view transform in warm light mode")
    ap.add_argument("--sky", type=float, default=1.0, help="warm light: sky dome strength multiplier")
    ap.add_argument("--key", type=float, default=1400, help="warm light: key energy, W")
    ap.add_argument("--albedo", default="slate", choices=["slate", "v6"], help="painted shader: albedo pair")
    ap.add_argument("--spec", type=float, default=0.0, help="painted shader: specular level (v6 was 0.1)")
    ap.add_argument("--light", default="study", choices=["study", "warm", "v6"], help="warm: a warmer key and bluer fill, as the texture reference")
    ap.add_argument("--save", action="store_true")
    ap.add_argument("--tag", default="", help="suffix for the output file names")
    # surface treatment knobs (see treat)
    ap.add_argument("--round", type=int, default=12, help="pillow smoothing iterations")
    ap.add_argument("--cuts", type=float, default=0, help="plane cuts per metre of block size")
    ap.add_argument("--cut-depth", type=float, default=0.08)
    ap.add_argument("--cut-soft", type=int, default=2, help="smooth iterations after the cuts")
    ap.add_argument("--cut-tilt", type=float, default=0.3, help="how far a cut plane tilts off the surface normal")
    ap.add_argument("--corners", type=int, default=0, help="primary form: corner cuts per block")
    ap.add_argument("--corner-depth", type=float, default=0.6, help="deepest corner cut, fraction of the smallest half-size")
    ap.add_argument("--corner-tilt", type=float, default=0.5)
    ap.add_argument("--bevel", type=float, default=0.0, help="edge rounding as a fraction of the block's smallest half-size")
    ap.add_argument("--cell", type=float, default=0.5, help="crackle cell size, m")
    ap.add_argument("--dome", type=float, default=0.0, help="crackle dome height, m")
    ap.add_argument("--big", type=float, default=0.0, help="large noise amplitude, m")
    ap.add_argument("--big-scale", type=float, default=0.9)
    ap.add_argument("--grit", type=float, default=0.0)
    ap.add_argument("--target", type=int, default=800, help="tris per 0.8 m block before the planar dissolve")
    ap.add_argument("--angle", type=float, default=14.0, help="planar dissolve angle, degrees")
    ap.add_argument("--split", action="store_true", help="fracture: extra seed in the big blocks")
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)

    sc = cf.reset_scene()
    sc.cycles.samples = args.samples
    sc.render.resolution_x = sc.render.resolution_y = args.size
    cam = cf.build_stage()

    import time
    t0 = time.time()
    rocks = VARIANTS[args.variant](args)
    for ob in rocks:
        ob.data.calc_loop_triangles()
    tris = sum(len(ob.data.loop_triangles) for ob in rocks)
    faces = sum(len(ob.data.polygons) for ob in rocks)
    print("[build] %s: %d objects, %d faces, %d tris, %.1f s" % (args.variant, len(rocks), faces, tris, time.time() - t0))

    mat = {"grey": lambda: cf.mat_flat("Grey", cf.PAL["rock"], rough=0.95),
           "stone": lambda: cf.mat_rock("Stone"),
           "plain": lambda: mat_plain("Painted", args.plain_debug, args.albedo, args.spec)}[args.material]()
    if args.light == "v6":
        # the 2026-10-01 v6 look Tris picked: warm area key high front-left,
        # dim blue fill and rim, dark blue world, dark ground, AgX
        key = bpy.data.objects["key"]
        key.location = (-1.9, -2.4, 8.6)
        key.rotation_euler = (Vector((0, 0, 0.8)) - Vector(key.location)).to_track_quat("-Z", "Y").to_euler()
        key.data.color = (1.0, 0.74, 0.45)
        key.data.energy = args.key
        bpy.data.lights["fill"].color = (0.45, 0.6, 1.0)
        bpy.data.lights["fill"].energy = 150
        bpy.data.lights["rim"].color = (0.6, 0.75, 1.0)
        bpy.data.lights["rim"].energy = 90
        bpy.data.worlds[0].node_tree.nodes["Background"].inputs[0].default_value = (0.008, 0.014, 0.03, 1)
        bpy.data.objects["ground"].data.materials[0].node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = cf.srgb("#141a21")
    if args.light == "warm":
        # the texture references read as sun + sky: a narrow warm sun from
        # nearly overhead (tops warm, sides untouched) and a blue sky dome
        # lighting everything else, with the AO in the shader for depth.
        # The study's area lights are switched off; the stone stays neutral.
        for name in ("key", "fill", "rim"):
            bpy.data.lights[name].energy = 0
        sun_d = bpy.data.lights.new("sun", "SUN")
        sun_d.color = (1.0, 0.66, 0.22)
        sun_d.energy = args.key / 1000.0
        sun_d.angle = math.radians(4)
        sun = cf.new_object("sun", sun_d)
        # from high behind-left: the faces the camera sees get sky only
        sun.rotation_euler = (Vector((0, 0, 0)) - Vector((0.3, 1.5, 9.5))).to_track_quat("-Z", "Y").to_euler()
        bpy.data.worlds[0].node_tree.nodes["Background"].inputs[0].default_value = tuple(args.sky * c for c in (0.05, 0.09, 0.22)) + (1,)
        print("[light] sun", tuple(round(x, 2) for x in sun.rotation_euler), "energy", sun_d.energy, "sky", args.sky)
        gnd = bpy.data.objects["ground"].data.materials[0].node_tree.nodes["Principled BSDF"]
        gnd.inputs["Base Color"].default_value = cf.srgb("#07090c")
        gnd.inputs["Specular IOR Level"].default_value = 0.0  # its gloss bounced the sun onto the fronts
        if args.view == "standard":
            sc.view_settings.view_transform = "Standard"
            sc.view_settings.look = "None"
    for ob in rocks:
        ob.data.materials.append(mat)

    views = {"3q": (-38, 22), "front": (0, 10), "side": (90, 10), "top": (-15, 68),
             "left3q": (38, 22), "back3q": (-142, 22), "low": (-38, 6), "high": (-38, 45)}
    for name in args.views.split(","):
        az, el = views[name]
        cf.aim_camera(cam, rocks, az, el)
        cf.render(os.path.join(args.out, "%s%s_%s.png" % (args.variant, args.tag, name)))
    if args.save:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.out, args.variant + args.tag + ".blend"))


if __name__ == "__main__":
    main()
