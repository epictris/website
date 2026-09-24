"""
Procedural wall/tunnel root assets.

Run inside Blender  -> builds editable mesh objects in the scene.
Run outside Blender -> exports GLB files (needs: pip install trimesh)

For polygon-authored, grabbable game-level roots, use polygon_roots.py and
the Blender panel in blender_polygon_roots.py. See POLYGON_ROOTS.md.

Convention: the wall is the XZ plane at Y=0. Roots grow toward +Y (out of the
wall) and sag toward -Z. Geometry starts slightly inside the wall (-Y) so there
is never a visible gap. Vertex color RED channel = wall-contact mask
(1.0 at the wall, fading to 0 along the root) for use by scatter tools/shaders.
"""

import math
import random
from pathlib import Path

import numpy as np

try:
    import bpy, bmesh  # noqa
    IN_BLENDER = True
except ImportError:
    IN_BLENDER = False


# ----------------------------------------------------------------------------
# skeleton
# ----------------------------------------------------------------------------

# bark sheet layout: 4 vertical bands of equal width
BANDS = 4
BAND_YOUNG, BAND_CRACKED, BAND_MOSSY, BAND_DRY = 0, 1, 2, 3
UV_SCALE = 0.27      # world units -> texture V. keeps texel density constant.


class Branch:
    def __init__(self, points, radii, depth, band=0, v_offset=0.0):
        self.points = points      # list of np.array(3)
        self.radii = radii        # list of float
        self.depth = depth
        self.band = band          # which vertical band of the bark sheet
        self.v_offset = v_offset  # slides the texture along the root


def _norm(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else np.array([0.0, 1.0, 0.0])


def grow_branch(rng, origin, direction, length, base_radius, depth, cfg):
    """Random walk with momentum + gravity droop. Returns (Branch, children)."""
    nodes = max(4, int(cfg["nodes"] * (0.65 ** depth)))
    step = length / nodes

    pts = [np.array(origin, dtype=float)]
    radii = [base_radius]
    d = _norm(np.array(direction, dtype=float))

    wander = cfg["wander"] * (1.0 + 0.4 * depth)
    gravity = cfg["gravity"]

    for i in range(nodes):
        t = (i + 1) / nodes
        jitter = np.array([rng.gauss(0, 1) for _ in range(3)]) * wander
        d = _norm(d + jitter + np.array([0, 0, -gravity]) * t)
        # roots hug the wall a little instead of shooting straight out
        d = _norm(d + np.array([0, -cfg["hug"] * t, 0]))
        pts.append(pts[-1] + d * step)

        taper = (1.0 - t) ** cfg["taper_pow"]
        r = base_radius * max(taper, 0.04)
        if depth == 0:  # trunk flare where it meets the rock
            r *= 1.0 + cfg["flare"] * math.exp(-t / cfg["flare_falloff"])
        r *= 1.0 + rng.uniform(-cfg["knobble"], cfg["knobble"])
        radii.append(r)

    # thick structural roots read as old bark; thin feeders as young or mossy
    if depth == 0:
        band = rng.choice([BAND_CRACKED, BAND_CRACKED, BAND_DRY])
    elif depth == 1:
        band = rng.choice([BAND_CRACKED, BAND_YOUNG, BAND_MOSSY])
    else:
        band = rng.choice([BAND_YOUNG, BAND_YOUNG, BAND_MOSSY])
    branch = Branch(pts, radii, depth, band, rng.uniform(0.0, 4.0))

    children = []
    if depth < cfg["max_depth"]:
        n_kids = cfg["children"][min(depth, len(cfg["children"]) - 1)]
        n_kids = max(0, int(round(rng.gauss(n_kids, 0.6))))
        for _ in range(n_kids):
            t = rng.uniform(0.2, 0.75)
            idx = max(1, min(len(pts) - 2, int(t * nodes)))
            parent_dir = _norm(pts[idx + 1] - pts[idx])
            # random axis perpendicular-ish to parent, then rotate off it
            side = _norm(np.cross(parent_dir, np.array([
                rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)])))
            angle = math.radians(rng.uniform(*cfg["split_angle"]))
            kid_dir = _norm(parent_dir * math.cos(angle) + side * math.sin(angle))
            kid_len = length * rng.uniform(0.35, 0.6)
            kid_rad = radii[idx] * rng.uniform(0.4, 0.65)
            children.append((pts[idx].copy(), kid_dir, kid_len, kid_rad, depth + 1))

    return branch, children


def build_skeleton(seed, cfg):
    rng = random.Random(seed)
    branches = []
    queue = []

    for k in range(cfg["trunks"]):
        spread = math.radians(rng.uniform(-cfg["trunk_spread"], cfg["trunk_spread"]))
        tilt = math.radians(rng.uniform(*cfg["trunk_tilt"]))
        d = np.array([math.sin(spread), math.cos(spread), math.sin(tilt)])
        start = np.array([rng.uniform(-0.06, 0.06), -0.05, rng.uniform(-0.06, 0.06)])
        queue.append((start, d, cfg["length"] * rng.uniform(0.8, 1.2),
                      cfg["radius"] * rng.uniform(0.8, 1.15), 0))

    while queue:
        origin, d, length, rad, depth = queue.pop(0)
        branch, kids = grow_branch(rng, origin, d, length, rad, depth, cfg)
        branches.append(branch)
        queue.extend(kids)

    return branches


# ----------------------------------------------------------------------------
# tube meshing (parallel transport frames)
# ----------------------------------------------------------------------------

def tube(branch, sides, uv_scale=UV_SCALE):
    pts, radii = branch.points, branch.radii
    n = len(pts)

    tangents = []
    for i in range(n):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        tangents.append(_norm(t))

    # initial frame
    up = np.array([0.0, 0.0, 1.0])
    if abs(np.dot(tangents[0], up)) > 0.95:
        up = np.array([1.0, 0.0, 0.0])
    normal = _norm(np.cross(tangents[0], up))

    verts, uvs, cols = [], [], []
    lengths = [0.0]
    for i in range(1, n):
        lengths.append(lengths[-1] + np.linalg.norm(pts[i] - pts[i - 1]))
    total = max(lengths[-1], 1e-6)

    for i in range(n):
        if i > 0:  # rotation-minimising transport
            axis = np.cross(tangents[i - 1], tangents[i])
            if np.linalg.norm(axis) > 1e-8:
                axis = _norm(axis)
                ang = math.acos(max(-1.0, min(1.0, np.dot(tangents[i - 1], tangents[i]))))
                c, s = math.cos(ang), math.sin(ang)
                normal = (normal * c + np.cross(axis, normal) * s +
                          axis * np.dot(axis, normal) * (1 - c))
                normal = _norm(normal - tangents[i] * np.dot(normal, tangents[i]))
        binormal = np.cross(tangents[i], normal)
        contact = max(0.0, 1.0 - lengths[i] / 0.35) ** 2 if branch.depth == 0 else 0.0

        for j in range(sides + 1):          # +1 duplicated column for the UV seam
            a = 2 * math.pi * (j % sides) / sides
            offset = normal * math.cos(a) + binormal * math.sin(a)
            verts.append(pts[i] + offset * radii[i])
            u = (branch.band + (j / sides)) / BANDS
            uvs.append((u, (lengths[i] + branch.v_offset) * uv_scale))
            cols.append((contact, 0.0, 0.0, 1.0))

    faces = []
    ring = sides + 1
    for i in range(n - 1):
        for j in range(sides):
            a = i * ring + j
            b = a + 1
            c = (i + 1) * ring + j + 1
            d = (i + 1) * ring + j
            faces.append((a, b, c))
            faces.append((a, c, d))

    return np.array(verts), np.array(faces), np.array(uvs), np.array(cols)


def dirt_skirt(rng, radius, sides=10):
    """Small rubble collar so the root reads as embedded, not glued on."""
    verts = [np.array([0.0, 0.05, 0.0])]
    uvs = [((BAND_DRY + 0.5) / BANDS, 0.5)]
    cols = [(1.0, 0.0, 0.0, 1.0)]
    for j in range(sides):
        a = 2 * math.pi * j / sides
        r = radius * rng.uniform(0.75, 1.35)
        verts.append(np.array([math.cos(a) * r, -0.02, math.sin(a) * r]))
        uvs.append(((BAND_DRY + 0.5 + math.cos(a) * 0.45) / BANDS,
                    0.5 + math.sin(a) * 0.45))
        cols.append((1.0, 0.0, 0.0, 1.0))
    faces = [(0, 1 + j, 1 + (j + 1) % sides) for j in range(sides)]
    return np.array(verts), np.array(faces), np.array(uvs), np.array(cols)


def assemble(branches, sides, skirt_seed=None, skirt_radius=0.0):
    V, F, UV, C = [], [], [], []
    off = 0
    for b in branches:
        v, f, uv, c = tube(b, sides)
        V.append(v); F.append(f + off); UV.append(uv); C.append(c)
        off += len(v)
    if skirt_radius > 0:
        v, f, uv, c = dirt_skirt(random.Random(skirt_seed), skirt_radius)
        V.append(v); F.append(f + off); UV.append(uv); C.append(c)
    return (np.concatenate(V), np.concatenate(F),
            np.concatenate(UV), np.concatenate(C))


# ----------------------------------------------------------------------------
# variants
# ----------------------------------------------------------------------------

BASE = dict(nodes=10, wander=0.22, gravity=0.28, hug=0.10, taper_pow=0.75,
            flare=1.1, flare_falloff=0.16, knobble=0.08, max_depth=2,
            children=[3, 2], split_angle=(25, 55), trunks=1,
            trunk_spread=25, trunk_tilt=(-25, 5), length=1.0, radius=0.17)


def variant(name):
    c = dict(BASE)
    if name == "fan":
        c.update(trunks=1, children=[5, 3], trunk_spread=10, split_angle=(35, 70),
                 length=1.05, radius=0.18, max_depth=2)
    elif name == "gnarl":
        c.update(trunks=1, children=[2, 2], wander=0.34, knobble=0.14,
                 length=1.25, radius=0.24, flare=1.4, max_depth=2)
    elif name == "cluster":
        c.update(trunks=3, children=[3, 2], trunk_spread=45, wander=0.28,
                 length=0.85, radius=0.13, max_depth=2)
    elif name == "stragglers":
        c.update(trunks=2, children=[1, 0], trunk_spread=50, gravity=0.40,
                 length=0.8, radius=0.07, flare=0.7, max_depth=1)
    elif name == "ceiling":
        c.update(trunks=1, children=[4, 3], gravity=0.75, hug=0.04,
                 trunk_tilt=(-55, -25), length=1.15, radius=0.17)
    return c


VARIANTS = ["fan", "gnarl", "cluster", "stragglers", "ceiling"]

# LOD0 / LOD1 / LOD2 — generated from the same skeleton, not decimated
LODS = [
    dict(sides=8, node_mult=1.0, depth_cap=9, skirt=True),
    dict(sides=5, node_mult=0.7, depth_cap=1, skirt=True),
    dict(sides=3, node_mult=0.45, depth_cap=0, skirt=False),
]


def make_asset(name, seed, lod):
    cfg = variant(name)
    cfg = dict(cfg)
    cfg["nodes"] = max(4, int(cfg["nodes"] * lod["node_mult"]))
    branches = build_skeleton(seed, cfg)
    branches = [b for b in branches if b.depth <= lod["depth_cap"]]
    skirt_r = cfg["radius"] * 1.25 if lod["skirt"] else 0.0
    return assemble(branches, lod["sides"], skirt_seed=seed, skirt_radius=skirt_r)


# ----------------------------------------------------------------------------
# outputs
# ----------------------------------------------------------------------------

def export_glb(outdir="."):
    import trimesh
    import os
    os.makedirs(outdir, exist_ok=True)
    made = []
    for name in VARIANTS:
        for li, lod in enumerate(LODS):
            V, F, UV, C = make_asset(name, seed=hash(name) % 10000, lod=lod)
            m = trimesh.Trimesh(vertices=V, faces=F, process=False)
            tex = None
            sheet = os.path.join(TEX_DIR, "bark_albedo.png")
            if os.path.exists(sheet):
                from PIL import Image
                tex = Image.open(sheet)
            orm = None
            rough_path = Path(TEX_DIR) / "bark_roughness.png"
            if tex is not None and rough_path.exists():
                rough = Image.open(rough_path).convert("L")
                orm = Image.merge("RGB", (Image.new("L", rough.size, 255),
                                         rough, Image.new("L", rough.size, 0)))
            mat = trimesh.visual.material.PBRMaterial(
                baseColorTexture=tex,
                normalTexture=Image.open(Path(TEX_DIR) / "bark_normal.png") if tex else None,
                metallicRoughnessTexture=orm,
                roughnessFactor=1.0 if orm is not None else 0.92, metallicFactor=0.0)
            m.visual = trimesh.visual.TextureVisuals(uv=UV, material=mat)
            m.visual.vertex_colors = (C * 255).astype(np.uint8)
            p = os.path.join(outdir, f"root_{name}_LOD{li}.glb")
            m.export(p)
            made.append((p, len(F)))
    return made


# Folder holding bark_albedo.png / bark_normal.png / bark_height.png.
# Defaults to this script's folder; override only for an external texture kit.
TEX_DIR = str(Path(__file__).resolve().parent)


def make_material_blender(name="RootBark"):
    """Principled setup wired to the bark sheet. Missing files are skipped."""
    import bpy, os

    if name in bpy.data.materials:
        return bpy.data.materials[name]

    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.92

    base = bpy.path.abspath(TEX_DIR)

    def load(fname, non_color=False, x=-700, y=0):
        path = os.path.join(base, fname)
        if not os.path.exists(path):
            print(f"[roots] missing texture: {path}")
            return None
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = bpy.data.images.load(path, check_existing=True)
        node.location = (x, y)
        node.interpolation = "Smart"
        if non_color:
            node.image.colorspace_settings.name = "Non-Color"
        return node

    alb = load("bark_albedo.png", False, -700, 250)
    if alb:
        nt.links.new(alb.outputs["Color"], bsdf.inputs["Base Color"])

    nrm = load("bark_normal.png", True, -700, -60)
    if nrm:
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nmap.location = (-400, -60)
        nmap.inputs["Strength"].default_value = 1.0
        nt.links.new(nrm.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    rough = load("bark_roughness.png", True, -700, -380)
    if rough:
        nt.links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])

    return mat


def build_in_blender():
    import bpy, bmesh
    coll = bpy.data.collections.new("RootKit")
    bpy.context.scene.collection.children.link(coll)
    mat = make_material_blender()

    for vi, name in enumerate(VARIANTS):
        for li, lod in enumerate(LODS):
            V, F, UV, C = make_asset(name, seed=hash(name) % 10000, lod=lod)
            mesh = bpy.data.meshes.new(f"root_{name}_LOD{li}")
            mesh.from_pydata([tuple(v) for v in V], [], [tuple(f) for f in F])
            mesh.update()

            uv_layer = mesh.uv_layers.new(name="UVMap")
            col_layer = mesh.color_attributes.new(
                name="contact", type="FLOAT_COLOR", domain="CORNER")
            for loop in mesh.loops:
                uv_layer.data[loop.index].uv = tuple(UV[loop.vertex_index])
                col_layer.data[loop.index].color = tuple(C[loop.vertex_index])

            for poly in mesh.polygons:
                poly.use_smooth = True

            obj = bpy.data.objects.new(mesh.name, mesh)
            obj.data.materials.append(mat)
            obj.location = (vi * 2.5, 0, -li * 2.0)
            coll.objects.link(obj)
    return True


if __name__ == "__main__":
    if IN_BLENDER:
        build_in_blender()
    else:
        for p, f in export_glb(str(Path(__file__).resolve().parent)):
            print(p, f, "tris")
