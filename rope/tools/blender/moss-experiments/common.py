"""Shared scene for the moss experiments: a faceted painterly rock, a brush-style
stamp mask (the one part of the existing tooling worth keeping), Eevee render,
glTF export, stats."""
import bpy, bmesh, math, random, os, sys, json, time
import numpy as np
from mathutils import Vector, Matrix, noise

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)

# ---------------------------------------------------------------- rock
def build_rock(seed=3, cuts=26):
    rnd = random.Random(seed)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=0.5)
    for v in bm.verts:
        v.co.x *= 1.25; v.co.y *= 0.95; v.co.z *= 0.85
        v.co += Vector(noise.noise_vector(v.co * 1.7)) * 0.08
    # chisel: random planes near the surface, keep the inside
    for i in range(cuts):
        d = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.6, 1))).normalized()
        # find extent along d
        ext = max(v.co.dot(d) for v in bm.verts)
        depth = rnd.uniform(0.03, 0.09)
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        r = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=d * (ext - depth), plane_no=d,
                                   clear_outer=True, use_snap_center=False)
        edges = [e for e in r["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        if edges:
            bmesh.ops.holes_fill(bm, edges=edges)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(4), verts=bm.verts[:], edges=bm.edges[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new("rock")
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new("rock", me)
    bpy.context.scene.collection.objects.link(ob)
    mat = bpy.data.materials.new("rock")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.10, 0.125, 0.16, 1)
    bsdf.inputs["Roughness"].default_value = 0.9
    me.materials.append(mat)
    for p in me.polygons: p.use_smooth = False
    return ob

def rock_arrays(ob):
    """numpy views of the rock: verts, tris, face normals, smooth vertex normals, hull normal."""
    me = ob.data
    V = np.array([v.co[:] for v in me.vertices])
    T = np.array([p.vertices[:] for p in me.polygons])
    FN = np.array([p.normal[:] for p in me.polygons])
    A = np.array([p.area for p in me.polygons])
    VN = np.zeros_like(V)
    for i, p in enumerate(me.polygons):
        for vi in p.vertices: VN[vi] += FN[i] * A[i]
    VN /= np.linalg.norm(VN, axis=1, keepdims=True)
    return V, T, FN, A, VN

def hull_normal(p, smooth_n, centre=np.zeros(3), radial=0.5):
    """the 'proxy volume' normal the cards are shaded with: the rock's smooth normal
    pulled toward the radial direction from the rock's centre, so a collar shades
    as one soft blob whatever facet it sits on."""
    r = p - centre; r /= np.linalg.norm(r, axis=-1, keepdims=True) + 1e-9
    n = (1 - radial) * smooth_n + radial * r
    return n / (np.linalg.norm(n, axis=-1, keepdims=True) + 1e-9)

# ---------------------------------------------------------------- stamps (the brush)
# (centre, normal, radius, strength) in rock space - what the brush records.
def default_stamps(V):
    top = V[:, 2].max()
    S = [((0.0, 0.0, top - 0.02), (0, 0, 1), 0.56, 1.0)]
    for k in range(16):                     # a ring round the shoulder (a continuous stroke)
        a = k / 16 * math.tau
        c = (0.56 * math.cos(a), 0.42 * math.sin(a), top - 0.15)
        n = Vector((math.cos(a), math.sin(a), 1.1)).normalized()
        S.append((c, n[:], 0.2, 1.0))
    S.append(((-0.5, -0.3, 0.02), (-0.6, -0.8, 0.2), 0.2, 0.9))   # a run down the front-left
    S.append(((-0.42, -0.42, -0.18), (-0.3, -0.9, 0.1), 0.14, 0.8))
    return S

def stamp_mask(P, N, stamps):
    """composite the stamps in painting order; w = radial falloff x facing."""
    m = np.zeros(len(P))
    for c, n, r, a in stamps:
        d = np.linalg.norm(P - np.array(c), axis=1) / r
        fall = 1 - smoothstep(0.35, 1.0, d)
        face = np.clip(N @ np.array(n), 0, 1)
        w = fall * face ** 0.5
        m += (1 - m) * a * w
    return m

def edge_noise(P, scale=0.18, amp=0.15):
    return np.array([noise.noise(Vector(p) / scale) for p in P]) * amp

def sample_surface(V, T, FN, A, VN, stamps, density, rnd, thresh=0.35):
    """points on the rock with density proportional to the mask, clipped at a lobed edge.
    returns P, face normal, smooth normal, mask value"""
    Vorig = V
    # refine first: a 40 cm facet whose centre is outside the paint still has painted corners
    V, T = refine(V, T, 0.06)
    FN = np.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]]); A = np.linalg.norm(FN, axis=1) / 2; FN /= (2 * A)[:, None] + 1e-12
    near = ((V[:, None, :] - Vorig[None, :, :]) ** 2).sum(-1).argmin(1); VN = VN[near]
    C = V[T].mean(axis=1)
    mc = stamp_mask(C, FN, stamps)
    expect = A * density * (mc > 0.02)
    P, N, S, M = [], [], [], []
    for f in range(len(T)):
        k = int(expect[f]) + (rnd.random() < expect[f] % 1)
        for _ in range(k):
            u, v = rnd.random(), rnd.random()
            if u + v > 1: u, v = 1 - u, 1 - v
            w = 1 - u - v
            p = V[T[f, 0]] * w + V[T[f, 1]] * u + V[T[f, 2]] * v
            s = VN[T[f, 0]] * w + VN[T[f, 1]] * u + VN[T[f, 2]] * v
            P.append(p); N.append(FN[f]); S.append(s / np.linalg.norm(s))
    P, N, S = np.array(P), np.array(N), np.array(S)
    M = stamp_mask(P, S, stamps)          # the smooth normal, the same facing the underlay uses
    keep = M > thresh + edge_noise(P)
    return P[keep], N[keep], S[keep], M[keep]

# ---------------------------------------------------------------- leaf atlas
def leaf_atlas(path, size=512, cells=2, seed=1):
    """a 2x2 atlas of leaf clumps: flat, rounded, painterly. value near 1 so the
    vertex tint owns the colour; alpha is the cutout."""
    if os.path.exists(path): return path
    rnd = random.Random(seed)
    img = np.zeros((size, size, 4), np.float32)
    cs = size // cells
    yy, xx = np.mgrid[0:cs, 0:cs].astype(np.float32) / cs
    for cy in range(cells):
        for cx in range(cells):
            cell = np.zeros((cs, cs, 4), np.float32)
            n = rnd.randint(3, 4)                       # a few big round leaves per clump
            for i in range(n):
                px, py = 0.5 + rnd.uniform(-0.16, 0.16), 0.5 + rnd.uniform(-0.16, 0.16)
                rx, ry = rnd.uniform(0.24, 0.32), rnd.uniform(0.2, 0.27)
                ang = rnd.uniform(0, math.pi)
                dx, dy = xx - px, yy - py
                u = dx * math.cos(ang) + dy * math.sin(ang)
                v = -dx * math.sin(ang) + dy * math.cos(ang)
                # a rounded leaf: ellipse, pinched a little toward one end
                d = (u / rx) ** 2 + (v / (ry * (1 - 0.25 * np.clip(u / rx, 0, 1)))) ** 2
                inside = d < 1
                val = rnd.uniform(0.8, 1.0)
                shade = val * (1 - 0.18 * np.clip(-v / ry, 0, 1))      # a touch darker at the lower half
                cell[inside, 0] = shade[inside]; cell[inside, 1] = shade[inside]; cell[inside, 2] = shade[inside]
                cell[inside, 3] = 1
            img[cy * cs:(cy + 1) * cs, cx * cs:(cx + 1) * cs] = cell
    im = bpy.data.images.new("leafAtlas", size, size, alpha=True)
    im.pixels.foreach_set(img[::-1].ravel())
    im.filepath_raw = path; im.file_format = "PNG"; im.save()
    return path

def leaf_material(atlas_path, name="mossLeaf"):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = bpy.data.images.load(atlas_path)
    tex.image.alpha_mode = "STRAIGHT"
    col = nt.nodes.new("ShaderNodeVertexColor"); col.layer_name = "Col"
    mul = nt.nodes.new("ShaderNodeMix"); mul.data_type = "RGBA"; mul.blend_type = "MULTIPLY"
    mul.inputs[0].default_value = 1.0
    nt.links.new(tex.outputs["Color"], mul.inputs[6]); nt.links.new(col.outputs["Color"], mul.inputs[7])
    nt.links.new(mul.outputs[2], bsdf.inputs["Base Color"])
    clip = nt.nodes.new("ShaderNodeMath"); clip.operation = "GREATER_THAN"; clip.inputs[1].default_value = 0.35
    nt.links.new(tex.outputs["Alpha"], clip.inputs[0])
    nt.links.new(clip.outputs[0], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.75
    bsdf.inputs["Specular IOR Level"].default_value = 0.2
    mat.use_backface_culling = True
    try: mat.blend_method = "CLIP"; mat.alpha_threshold = 0.35
    except Exception: pass
    return mat

# ---------------------------------------------------------------- palette
LIGHT = np.array([0.80, 0.84, 0.10])   # crown, sunward
DARK = np.array([0.14, 0.33, 0.16])    # under
SHADOW_BLUE = np.array([0.10, 0.36, 0.24])
# three moss tones that patch across the carpet: yellow-green, leaf green, blue-green
TONES = np.array([[0.62, 0.78, 0.06], [0.24, 0.60, 0.06], [0.12, 0.48, 0.20]])

def tone_at(P, scale=0.22):
    """which of the three tones a point leans to: two slow noises pick a soft mixture."""
    P = np.atleast_2d(P)
    a = np.array([noise.noise(Vector(p) / scale) for p in P]) * 0.5 + 0.5
    b = np.array([noise.noise(Vector(p) / scale + Vector((7.1, 3.3, 9.7))) for p in P]) * 0.5 + 0.5
    w = np.stack([a * a, (1 - a) * (1 - b) + 0.35, (1 - a) * b], 1)
    w /= w.sum(1, keepdims=True)
    return w @ TONES

def tint(hn, depth, rnd_v, base=None):
    """vertex colour: the local tone, lit toward LIGHT where the hull faces up and toward DARK
    where it faces down, darkened and cooled with depth into the carpet, then a small jitter."""
    if base is None: base = np.tile(TONES[1], (len(depth), 1))
    up = np.clip(hn[..., 2] * 0.5 + 0.5, 0, 1)
    c = base * (0.75 + 0.45 * up[..., None]) + (LIGHT - base) * (up[..., None] ** 2) * 0.25
    c = c * (1 - up[..., None]) * 0.0 + c   # (kept simple; DARK enters through depth and the light)
    c = c * (1 - depth[..., None] * 0.28) + SHADOW_BLUE * depth[..., None] * 0.18
    c *= (1 + rnd_v[..., None])
    return np.clip(c, 0, 1)

# ---------------------------------------------------------------- mesh writing
def mesh_from_quads(name, Q, QN, QC, QUV, mat):
    """Q (n,4,3) corners, QN (n,4,3) custom normals, QC (n,4,3) colours, QUV (n,4,2)."""
    n = len(Q)
    me = bpy.data.meshes.new(name)
    me.vertices.add(n * 4); me.vertices.foreach_set("co", Q.reshape(-1))
    me.loops.add(n * 4); me.loops.foreach_set("vertex_index", np.arange(n * 4))
    me.polygons.add(n); me.polygons.foreach_set("loop_start", np.arange(n) * 4)
    me.polygons.foreach_set("loop_total", np.full(n, 4))
    me.update(calc_edges=True)
    uv = me.uv_layers.new(name="UVMap"); uv.data.foreach_set("uv", QUV.reshape(-1))
    ca = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    cols = np.concatenate([QC.reshape(-1, 3), np.ones((n * 4, 1))], axis=1)
    ca.data.foreach_set("color", cols.reshape(-1))
    for p in me.polygons: p.use_smooth = True
    me.normals_split_custom_set(QN.reshape(-1, 3).tolist())
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob

def card(centre, normal, up_hint, w, h, rnd, spin=None):
    """one quad of size w x h whose face normal is `normal`, spun randomly."""
    n = normal / np.linalg.norm(normal)
    t = np.cross(n, up_hint); 
    if np.linalg.norm(t) < 1e-4: t = np.cross(n, [1, 0, 0])
    t /= np.linalg.norm(t); b = np.cross(n, t)
    a = rnd.uniform(0, math.tau) if spin is None else spin; ca, sa = math.cos(a), math.sin(a)
    x = t * ca + b * sa; y = -t * sa + b * ca
    return np.array([centre - x * w / 2 - y * h / 2, centre + x * w / 2 - y * h / 2,
                     centre + x * w / 2 + y * h / 2, centre - x * w / 2 + y * h / 2])

def uv_cell(rnd, cells=2):
    cx, cy = rnd.randrange(cells), rnd.randrange(cells)
    s = 1 / cells
    return np.array([[cx * s, cy * s], [(cx + 1) * s, cy * s], [(cx + 1) * s, (cy + 1) * s], [cx * s, (cy + 1) * s]])

# ---------------------------------------------------------------- scene, render, export
def setup_scene(bg=(0.045, 0.125, 0.19)):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x = 900; sc.render.resolution_y = 720
    sc.eevee.taa_render_samples = 48
    try: sc.eevee.use_shadows = True
    except Exception: pass
    sc.view_settings.view_transform = "Standard"; sc.view_settings.exposure = -0.7
    w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True
    bgn = w.node_tree.nodes["Background"]; bgn.inputs[0].default_value = (*bg, 1); bgn.inputs[1].default_value = 0.75
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.0; sun.data.angle = math.radians(28); sun.data.color = (1.0, 0.86, 0.66)   # warm sun, as the reference
    try: sun.data.use_shadow_jitter = True
    except Exception: pass
    sun.rotation_euler = (math.radians(48), math.radians(-18), math.radians(-35))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.lens = 68
    cam.location = (-1.9, -3.2, 0.9); cam.rotation_euler = (math.radians(76), 0, math.radians(-31))
    sc.collection.objects.link(cam); sc.camera = cam
    return sc

def render(name, view=None):
    sc = bpy.context.scene
    if view == "under":
        sc.camera.location = (-0.9, -3.0, -1.3); sc.camera.rotation_euler = (math.radians(108), 0, math.radians(-17))
    elif view == "close":
        sc.camera.location = (-1.0, -1.9, 0.55); sc.camera.rotation_euler = (math.radians(80), 0, math.radians(-28))
    sc.render.filepath = os.path.join(OUT, name + ".png")
    t = time.time(); bpy.ops.render.render(write_still=True)
    return time.time() - t

def stats(objs):
    tris = verts = 0
    for ob in objs:
        dg = bpy.context.evaluated_depsgraph_get()
        me = ob.evaluated_get(dg).to_mesh()
        me.calc_loop_triangles(); tris += len(me.loop_triangles); verts += len(me.vertices)
    return {"tris": tris, "verts": verts}

def export(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for ob in objs: ob.select_set(True)
    path = os.path.join(OUT, name + ".glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_apply=True, export_image_format="AUTO")
    return path, os.path.getsize(path)

def report(name, objs, extra=None):
    d = {"name": name, **stats(objs)}
    p, b = export(objs, name); d["glb_bytes"] = b
    d["render_s"] = round(render(name), 2)
    if extra: d.update(extra)
    print("STATS", json.dumps(d))
    with open(os.path.join(OUT, name + ".json"), "w") as f: json.dump(d, f, indent=1)
    return d

# ---------------------------------------------------------------- cushion (masked, offset, smoothed patch)
def refine(V, T, max_edge=0.045):
    """split the rock's triangles until no edge is longer than max_edge (midpoint subdivision)."""
    V = [tuple(v) for v in V]; T = [tuple(t) for t in T]
    cache = {}
    def mid(a, b):
        k = (min(a, b), max(a, b))
        if k not in cache:
            cache[k] = len(V); V.append(tuple((np.array(V[a]) + np.array(V[b])) / 2))
        return cache[k]
    for _ in range(6):
        out = []; split = False
        for a, b, c in T:
            A_, B_, C_ = map(np.array, (V[a], V[b], V[c]))
            if max(np.linalg.norm(A_ - B_), np.linalg.norm(B_ - C_), np.linalg.norm(C_ - A_)) > max_edge:
                ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
                out += [(a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)]; split = True
            else: out.append((a, b, c))
        T = out
        if not split: break
    return np.array(V), np.array(T)

def cushion_patch(V, T, FN, VN, stamps, thick, thresh=0.35, smooth=6, lobes=True):
    """the masked part of the (refined) rock lifted along a smoothed normal by thick*mask.
    returns verts, tris, per-vertex mask, per-vertex hull normal."""
    Vr, Tr = refine(V, T)
    # vertex normals of the refined mesh: inherit by nearest original vertex normal (smooth)
    d = ((Vr[:, None, :] - V[None, :, :]) ** 2).sum(-1); near = d.argmin(1)
    Nr = VN[near].copy()
    # mask per vertex uses the smooth normal (facing)
    M = stamp_mask(Vr, Nr, stamps)
    if lobes: M = M - edge_noise(Vr)
    keep_f = (M[Tr] > thresh).any(1)
    Tr = Tr[keep_f]
    used = np.unique(Tr); remap = -np.ones(len(Vr), int); remap[used] = np.arange(len(used))
    Vr, Nr, M, Tr = Vr[used].copy(), Nr[used], M[used], remap[Tr]
    # snap the outside vertices of boundary triangles onto the mask's iso-line, so the
    # outline is the painted lobe and not a staircase of the refinement
    nb = [set() for _ in Vr]
    for a, b, c in Tr: nb[a] |= {b, c}; nb[b] |= {a, c}; nb[c] |= {a, b}
    Vsnap = Vr.copy()
    for i in range(len(Vr)):
        if M[i] > thresh: continue
        ins = [j for j in nb[i] if M[j] > thresh]
        if not ins: continue
        j = max(ins, key=lambda j: M[j])
        t = (thresh - M[i]) / (M[j] - M[i] + 1e-9)
        Vsnap[i] = Vr[i] + (Vr[j] - Vr[i]) * t
    Vr = Vsnap
    W = smoothstep(thresh, thresh + 0.25, M)
    # laplacian smooth of the lift field so the cushion swells gently
    adj = [set() for _ in Vr]
    for a, b, c in Tr: adj[a] |= {b, c}; adj[b] |= {a, c}; adj[c] |= {a, b}
    lift = W.copy()
    for _ in range(smooth):
        lift = np.array([(lift[i] + lift[list(adj[i])].mean()) / 2 if adj[i] else lift[i] for i in range(len(Vr))])
    HN = hull_normal(Vr, Nr, radial=0.5)
    bump = np.array([noise.noise(Vector(p) / 0.16) for p in Vr]) * 0.25 + 1
    Vo = Vr + HN * (thick * lift * bump)[:, None]
    Vs = Vo.copy()
    for _ in range(smooth):
        Vs = np.array([(Vs[i] + Vs[list(adj[i])].mean(0)) / 2 if adj[i] else Vs[i] for i in range(len(Vs))])
        Vs = np.where((W > 0.05)[:, None], Vs, Vo)
    return Vs, Tr, W, HN, lift

def mesh_from_tris(name, V, T, N, cols, mat, uvs=None):
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(V)); me.vertices.foreach_set("co", V.reshape(-1))
    me.loops.add(len(T) * 3); me.loops.foreach_set("vertex_index", T.reshape(-1))
    me.polygons.add(len(T)); me.polygons.foreach_set("loop_start", np.arange(len(T)) * 3)
    me.polygons.foreach_set("loop_total", np.full(len(T), 3))
    me.update(calc_edges=True)
    if uvs is not None:
        uv = me.uv_layers.new(name="UVMap"); uv.data.foreach_set("uv", uvs[T].reshape(-1))
    ca = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    c4 = np.concatenate([cols, np.ones((len(cols), 1))], 1)
    ca.data.foreach_set("color", c4[T].reshape(-1))
    for p in me.polygons: p.use_smooth = True
    me.normals_split_custom_set_from_vertices(N.tolist())
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    return ob

def flat_moss_material(name="mossCushion", texture_noise=True):
    mat = bpy.data.materials.new(name); mat.use_nodes = True
    nt = mat.node_tree; bsdf = nt.nodes["Principled BSDF"]
    col = nt.nodes.new("ShaderNodeVertexColor"); col.layer_name = "Col"
    nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.9; bsdf.inputs["Specular IOR Level"].default_value = 0.15
    return mat

# ---------------------------------------------------------------- cutout atlas: nine distinct blob silhouettes, one per cell
LEAF_CELLS = (3, 7, 8)   # the teardrop cells of cutout_atlas

def cutout_atlas(path, size=768, cells=3, seed=5):
    if os.path.exists(path): return path
    rnd = random.Random(seed)
    img = np.zeros((size, size, 4), np.float32)
    cs = size // cells
    yy, xx = np.mgrid[0:cs, 0:cs].astype(np.float32) / cs
    dx, dy = xx - 0.5, yy - 0.5
    th = np.arctan2(dy, dx); rr = np.sqrt(dx * dx + dy * dy)
    kinds = ["round", "lobed", "clover", "leaf", "irregular", "round", "lobed", "leaf", "leaf"]
    img[..., 0:3] = 1.0                      # colour everywhere: the alpha alone is the shape
    for i, kind in enumerate(kinds):
        cy, cx = divmod(i, cells)
        base = 0.36
        ph = [rnd.uniform(0, 6.3) for _ in range(6)]
        if kind == "round":
            r = base * (1 + 0.06 * np.cos(2 * th + ph[0]) + 0.04 * np.cos(3 * th + ph[1]))
        elif kind == "lobed":
            r = base * (1 + 0.16 * np.cos(3 * th + ph[0]) + 0.05 * np.cos(5 * th + ph[1]))
        elif kind == "clover":
            r = base * (0.86 + 0.28 * np.abs(np.cos(1.5 * th + ph[0])) ** 1.5)
        elif kind == "leaf":                   # a teardrop, tip pointing down the cell (-y in the array = uv top... see LEAF_CELLS)
            ex, ey = rnd.uniform(0.62, 0.78), 1.0
            r = base * 0.95 / np.sqrt((np.cos(th) / ex) ** 2 + (np.sin(th) / ey) ** 2)
            r = r * (1 + 0.5 * np.clip(np.cos(th + math.pi / 2), 0, 1) ** 4) * (1 - 0.08 * np.clip(np.cos(th - math.pi / 2), 0, 1) ** 2)
        else:
            r = base * (1 + 0.12 * np.cos(2 * th + ph[0]) + 0.10 * np.cos(4 * th + ph[1]) + 0.06 * np.cos(7 * th + ph[2]))
        inside = rr < r
        cell = np.zeros((cs, cs, 4), np.float32)
        img[cy * cs:(cy + 1) * cs, cx * cs:(cx + 1) * cs, 3] = inside
    im = bpy.data.images.new("cutoutAtlas", size, size, alpha=True)
    im.pixels.foreach_set(img[::-1].ravel())
    im.filepath_raw = path; im.file_format = "PNG"; im.save()
    return path

def facing_card(centre, w, h, rnd, tilt_max=8.0, face=np.array([0, -1.0, 0]), spin=None):
    """a quad facing the game camera (Blender -y), spun at random, tilted a few degrees at most."""
    axis = np.cross(face, [rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1)]); axis /= np.linalg.norm(axis) + 1e-9
    ang = math.radians(rnd.uniform(0, tilt_max))
    n = face * math.cos(ang) + np.cross(axis, face) * math.sin(ang)
    return card(centre, n, np.array([0, 0, 1.0]), w, h, rnd, spin)

def uv_cell_index(idx, cells=3):
    cy, cx = divmod(idx, cells); cy = cells - 1 - cy; s = 1 / cells
    return np.array([[cx * s, cy * s], [(cx + 1) * s, cy * s], [(cx + 1) * s, (cy + 1) * s], [cx * s, (cy + 1) * s]])

def game_views(sc, view=None):
    """cameras like the game's: side-on, a little above; close; from below."""
    cam = sc.camera
    if view == "close":
        cam.location = (-0.25, -2.5, 0.6); cam.rotation_euler = (math.radians(78), 0, math.radians(-6))
    elif view == "under":
        cam.location = (-0.3, -3.0, -1.1); cam.rotation_euler = (math.radians(107), 0, math.radians(-6))
    else:
        cam.location = (-0.3, -3.5, 0.75); cam.rotation_euler = (math.radians(79), 0, math.radians(-5))

# ---------------------------------------------------------------- angular atlas: polygon silhouettes
def _raster_polygon(poly, cs):
    """point-in-polygon over a cs x cs grid; poly in cell units (x right, y = array row / cs)."""
    yy, xx = np.mgrid[0:cs, 0:cs].astype(np.float32) / cs + 0.5 / cs
    inside = np.zeros((cs, cs), bool)
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]; x1, y1 = poly[(i + 1) % n]
        cond = (yy > min(y0, y1)) & (yy <= max(y0, y1)) & (abs(y1 - y0) > 1e-9)
        xs = x0 + (yy - y0) * (x1 - x0) / (y1 - y0 + 1e-12)
        inside ^= cond & (xx < xs)
    return inside

def _spiky(rnd, n=None):
    n = n or rnd.randint(7, 10); pts = []
    for i in range(n):
        a = (i + rnd.uniform(-0.25, 0.25)) / n * math.tau
        r = 0.42 * (0.95 if i % 2 == 0 else rnd.uniform(0.72, 0.84))
        pts.append((0.5 + r * math.cos(a), 0.5 + r * math.sin(a)))
    return [pts]

def _faceted(rnd):
    n = rnd.randint(6, 8); pts = []
    for i in range(n):
        a = (i + rnd.uniform(-0.2, 0.2)) / n * math.tau; r = 0.42 * rnd.uniform(0.82, 1.0)
        pts.append((0.5 + r * math.cos(a), 0.5 + r * math.sin(a)))
    return [pts]

def _leaf_poly(cx, cy, length, width, angle, notch=0.06):
    """an ovate leaf pointing along `angle` (radians, in the array frame): pointed tip, widest at a third, a small base notch."""
    prof = [(0.0, 0.0), (0.05, 0.5), (0.18, 0.85), (0.38, 1.0), (0.6, 0.88), (0.8, 0.55), (0.92, 0.22), (1.0, 0.0), (0.92, -0.22), (0.8, -0.55), (0.6, -0.88), (0.38, -1.0), (0.18, -0.85), (0.05, -0.5), (notch, 0.0)]
    ca, sa = math.cos(angle), math.sin(angle); out = []
    for u, v in prof:
        x = u * length; y = v * width / 2
        out.append((cx + x * ca - y * sa, cy + x * sa + y * ca))
    return out

def _cluster(rnd):
    """three to five pointed leaves fanning from one base, tips outward."""
    k = rnd.randint(3, 5); base = rnd.uniform(0, math.tau); polys = []
    for i in range(k):
        a = base + (i - (k - 1) / 2) * rnd.uniform(0.55, 0.8)
        L = rnd.uniform(0.5, 0.56); w = rnd.uniform(0.34, 0.42)
        polys.append(_leaf_poly(0.5 - 0.1 * math.cos(a), 0.5 - 0.1 * math.sin(a), L, w, a, notch=0.0))
    return polys

def _soften(mask, r):
    a = mask.astype(np.float32)
    for _ in range(3):                      # three box blurs ~ a gaussian
        k = np.ones(2 * r + 1, np.float32) / (2 * r + 1)
        a = np.apply_along_axis(lambda v: np.convolve(v, k, mode="same"), 0, a)
        a = np.apply_along_axis(lambda v: np.convolve(v, k, mode="same"), 1, a)
    return a > 0.5

BLOB_CELLS = (0, 1, 2, 4, 5, 6)   # the moss mass never wears a vine leaf

def angular_atlas(path, size=768, cells=3, seed=9):
    if os.path.exists(path): return path
    rnd = random.Random(seed)
    img = np.zeros((size, size, 4), np.float32); img[..., 0:3] = 1.0
    cs = size // cells
    kinds = ["spiky", "cluster", "faceted", "leaf", "spiky", "cluster", "faceted", "leaf", "leaf"]
    for i, kind in enumerate(kinds):
        cy, cx = divmod(i, cells)
        if kind == "spiky": polys = _spiky(rnd)
        elif kind == "faceted": polys = _faceted(rnd)
        elif kind == "cluster": polys = _cluster(rnd)
        else:   # the vine leaf: tip toward array row 0 (= uv top = world up before the spin puts it down)
            polys = [_leaf_poly(0.5, 0.95, 0.9, rnd.uniform(0.74, 0.84), -math.pi / 2, notch=0.09)]
        inside = np.zeros((cs, cs), bool)
        for pl in polys: inside |= _raster_polygon(pl, cs)
        inside = _soften(inside, int(cs * (0.018 if kind == 'cluster' else 0.03)))
        img[cy * cs:(cy + 1) * cs, cx * cs:(cx + 1) * cs, 3] = inside
        if kind == "leaf":       # a faint midrib so the leaf reads as one
            yy, xx = np.mgrid[0:cs, 0:cs].astype(np.float32) / cs
            rib = inside & (abs(xx - 0.5) < 0.012) & (yy > 0.12) & (yy < 0.9)
            img[cy * cs:(cy + 1) * cs, cx * cs:(cx + 1) * cs, 0:3][rib] = 0.86
    im = bpy.data.images.new("angularAtlas", size, size, alpha=True)
    im.pixels.foreach_set(img[::-1].ravel())
    im.filepath_raw = path; im.file_format = "PNG"; im.save()
    return path
