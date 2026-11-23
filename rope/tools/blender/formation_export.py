"""One generated formation rock into what the game and the editor read.

    blender -b OUT_DIR/rock.blend --factory-startup --python-exit-code 1 \
        --python tools/blender/formation_export.py -- OUT_DIR [--triangles N] [--map-max N]

Run by `scripts/formation-build.ts` after `formations/worker.py` has left
`OUT_DIR/rock.blend` (one mesh, `SceneryRock`, built in its body's frame:
rock-local X right, Z up, metres; the play plane is Blender y = 0). Writes

    OUT_DIR/geometry.gltf   the rock without a bake, for the editor's iteration
                            look: at most N triangles (Decimate, collapse), the
                            slate's per-face `facet` tone carried as the corner
                            attribute `_facet` (the glTF exporter keeps a custom
                            attribute only when its name starts with "_")
    OUT_DIR/section.json    where the rock meets the play plane, at full detail:
                            closed loops of [x, z] in metres, for "Fit collision
                            to geometry" (docs/formations.md)
    OUT_DIR/bake.blend      rock.blend with the map caps set, for the bake path
                            (`scene_export.py --all-seen`): colour at most
                            --map-max in one map, normal half of it
    OUT_DIR/stats.json      triangles before and after, the bounds, the area

Progress goes out as `[scene_step] {"step": ..., "note": ...}` lines, the
convention `scene_export.py` set, for the job runner's bar.
"""

import json
import math
import sys
import time
from pathlib import Path

import bmesh
import bpy
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def step(name, note=None):
    print(f"[scene_step] {json.dumps({'step': name, 'note': note})}", flush=True)


def log(msg):
    print(f"[formation_export] {msg}", flush=True)


def tessellate(bm, mesh):
    """Triangulate `bm`, just loaded from `mesh`, along `mesh`'s own loop
    triangles: the split Blender's tessellation makes, which the glTF exporter
    ships (the baked rock) and the growths grow on (stampbrush host_world).

    A solid rock's faces are planar dissolves, n-gons flattened afterwards
    (`fitted.flatten`) but not exactly planar, so two triangulations of one
    are two surfaces. bmesh's own
    (`bmesh.ops.triangulate`, BEAUTY) split 161 of a Faceted rock's 380
    triangles the other way, and the editor drew a rock that stood through the
    moss grown on it (2026-11-23: rock-coloured triangles cut out of a texture
    moss, its shell 3 mm over the tessellation and 6 cm under the drawn one).
    Each n-gon is cut along its loop triangles' diagonals (`face_split` keeps
    the face's attributes on both pieces)."""
    mesh.calc_loop_triangles()
    n = len(mesh.loop_triangles)
    corners = np.empty(3 * n, np.int32)
    mesh.loop_triangles.foreach_get("vertices", corners)
    owner = np.empty(n, np.int32)
    mesh.loop_triangles.foreach_get("polygon_index", owner)
    corners = corners.reshape(-1, 3)
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    faces = list(bm.faces)  # in the mesh's polygon order, as from_mesh loads them
    for pi in np.unique(owner):
        face = faces[pi]
        if len(face.verts) == 3:
            continue
        ring = [v.index for v in face.verts]
        rim = {frozenset(e) for e in zip(ring, ring[1:] + ring[:1])}
        cuts = {frozenset(e) for a, b, c in corners[owner == pi].tolist() for e in ((a, b), (b, c), (c, a))} - rim
        pieces = [face]
        for cut in cuts:
            va, vb = (bm.verts[i] for i in cut)
            inside = [f for f in pieces if va in f.verts and vb in f.verts]
            if len(inside) != 1:
                raise RuntimeError(f"face {pi}: its loop triangles' diagonal {sorted(cut)} lies in {len(inside)} of its pieces")
            new, _loop = bmesh.utils.face_split(inside[0], va, vb)
            pieces.append(new)
    if any(len(f.verts) != 3 for f in bm.faces):
        raise RuntimeError("tessellate left a face that is not a triangle")


def section_loops(mesh):
    """The closed loops where `mesh` (object space) crosses Blender y = 0, each
    a list of [x, z]. The rock is a closed manifold, so every crossing closes;
    an open chain (a face lying in the plane, a hole the generator left) is
    returned too, flagged, so the fit can say so rather than draw a wrong edge."""
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        tessellate(bm, mesh)
        cut = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-7,
                                     plane_co=(0, 0, 0), plane_no=(0, 1, 0))
        edges = [e for e in cut["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        # An edge is on the cut only when both its ends are; bisect hands back
        # the vertices it made and the edges between them.
        on = [e for e in edges if all(abs(v.co.y) <= 1e-6 for v in e.verts)]
        nbr = {}
        for e in on:
            a, b = e.verts
            nbr.setdefault(a.index, []).append(b.index)
            nbr.setdefault(b.index, []).append(a.index)
        bm.verts.ensure_lookup_table()
        seen, loops = set(), []
        for start in nbr:
            if start in seen:
                continue
            # Walk from an end if this chain has one, else anywhere.
            chain_start = start
            stack, comp = [start], set()
            while stack:
                v = stack.pop()
                if v in comp:
                    continue
                comp.add(v)
                stack.extend(nbr[v])
            ends = [v for v in comp if len(nbr[v]) == 1]
            if ends:
                chain_start = ends[0]
            path, prev, cur = [chain_start], None, chain_start
            seen.add(chain_start)
            while True:
                nxt = [w for w in nbr[cur] if w != prev and w not in seen]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]
                seen.add(cur)
                path.append(cur)
            seen |= comp
            closed = not ends and len(path) >= 3
            pts = [[round(bm.verts[i].co.x, 6), round(bm.verts[i].co.z, 6)] for i in path]
            loops.append({"closed": closed, "points": pts})
        return loops
    finally:
        bm.free()


def facet_to_corners(mesh):
    """Copy the per-face `facet` tone onto a corner attribute `_facet`, which
    the glTF exporter carries (it exports point and corner attributes)."""
    src = mesh.attributes.get("facet")
    if src is None or src.domain != "FACE":
        return False
    n = len(mesh.polygons)
    face = np.empty(n, np.float32)
    src.data.foreach_get("value", face)
    totals = np.empty(n, np.int32)
    mesh.polygons.foreach_get("loop_total", totals)
    loop_face = np.repeat(np.arange(n, dtype=np.int32), totals)
    dst = mesh.attributes.get("_facet") or mesh.attributes.new("_facet", "FLOAT", "CORNER")
    dst.data.foreach_set("value", face[loop_face])
    return True


def edge_attributes(mesh):
    """What the game's iteration slate (src/render3d/formationSlate.ts) draws
    the slate's edge line and crease shading from, which Blender makes with
    Cycles' Bevel and Ambient Occlusion nodes: per triangle corner,

    `_edge`   the corner's distance to each of its triangle's three edges
              (edge i is the one opposite corner i): 0 for the two edges it
              lies on, the triangle's height over the third. Interpolated
              across the triangle it is each point's exact distance to each
              edge, metres.
    `_crease` each edge's half dihedral angle, radians, positive where the
              rock turns convex there and negative where it is concave; the
              same at all three corners.

    The mesh is triangulated first, as Blender tessellates it (`tessellate`;
    a face attribute is copied to the pieces).
    Boundary edges, and the diagonals `tessellate` cuts inside one face, are
    0; an edge between two faces takes the faces' own normals.

    Each corner's normal is set to its face's (custom normals, which the
    glTF exporter writes and the slate shades with): the triangles of one
    face are shaded as one plane, as Blender shades an n-gon. A facet's
    corners are flattened but not exactly coplanar (formations/fitted.py
    `flatten`), and a sliver triangle a few millimetres out of its facet's
    plane turned tens of degrees; shaded by its own normal, with an edge line
    along its diagonal, it drew a thin bright strip across the facet
    (2026-11-23, Tris's body 106)."""
    from mathutils import Vector
    normals = np.empty(3 * len(mesh.polygons), np.float32)
    mesh.polygons.foreach_get("normal", normals)
    normals = normals.reshape(-1, 3)
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        source = bm.faces.layers.int.new("_source_face")
        for f in bm.faces:
            f[source] = f.index
        tessellate(bm, mesh)
        bm.normal_update()
        bm.faces.ensure_lookup_table()
        n = len(bm.faces)
        dist = np.zeros((n, 3, 3), np.float32)
        crease = np.zeros((n, 3), np.float32)
        centre = [f.calc_center_median() for f in bm.faces]
        owner = np.array([f[source] for f in bm.faces], np.int32)
        for fi, f in enumerate(bm.faces):
            loops = list(f.loops)
            vs = [l.vert.co for l in loops]
            nf = Vector(normals[owner[fi]])
            for i in range(3):
                # Edge i joins corners i+1 and i+2; corner i is its height away.
                a, b = vs[(i + 1) % 3], vs[(i + 2) % 3]
                ab = b - a
                length = ab.length
                h = (vs[i] - a).cross(ab).length / length if length > 0 else 0.0
                dist[fi, i, i] = h
                edge = loops[(i + 1) % 3].edge
                other = [g for g in edge.link_faces if g is not f]
                if len(other) != 1 or owner[other[0].index] == owner[fi]:
                    continue
                g = other[0]
                half = 0.5 * nf.angle(Vector(normals[owner[g.index]]), 0.0)
                convex = nf.dot(centre[g.index] - centre[fi]) < 0
                crease[fi, i] = half if convex else -half
        # The edges between faces sharp, the diagonals inside one smooth: a
        # custom normal is held per smooth fan about a vertex, so a fan
        # running on into the next face blended the two faces' normals (9%
        # of a Faceted rock's triangles).
        for e in bm.edges:
            faces = e.link_faces
            e.smooth = bool(len(faces) == 2 and owner[faces[0].index] == owner[faces[1].index])
        bm.faces.layers.int.remove(source)
        bm.to_mesh(mesh)
    finally:
        bm.free()
    # Each corner its source face's normal; flat-shaded faces would drop it.
    mesh.polygons.foreach_set("use_smooth", np.ones(len(mesh.polygons), bool))
    mesh.normals_split_custom_set([tuple(normals[owner[p.index]]) for p in mesh.polygons for _ in range(3)])
    # Corners in the mesh's own loop order: triangulated, face fi's loops are
    # loop_start .. loop_start + 2, in the bmesh face's loop order.
    starts = np.empty(len(mesh.polygons), np.int32)
    mesh.polygons.foreach_get("loop_start", starts)
    order = (starts[:, None] + np.arange(3)[None, :]).ravel()
    e = mesh.attributes.new("_edge", "FLOAT_VECTOR", "CORNER")
    c = mesh.attributes.new("_crease", "FLOAT_VECTOR", "CORNER")
    out = np.zeros((len(mesh.loops), 3), np.float32)
    out[order] = dist.reshape(-1, 3)
    e.data.foreach_set("vector", out.ravel())
    out[order] = np.repeat(crease, 3, axis=0)
    c.data.foreach_set("vector", out.ravel())
    return int((crease != 0).sum())


OPENING_RASTER = 256
# A rock that covers more than this share of an opening its guide has, seen
# from the front, has filled it: the Wall variant builds one continuous face
# over its guide and closes an arch (measured 2026-11-22).
OPENING_FILLED = 0.5


def _raster(tris_xz, lo, hi, n):
    """Which cells of an n x n grid over [lo, hi] (x, z) the triangles cover,
    tested at cell centres."""
    grid = np.zeros((n, n), bool)
    cell = (hi - lo) / n
    for a, b, c in tris_xz:
        mn = np.floor((np.minimum(np.minimum(a, b), c) - lo) / cell).astype(int).clip(0, n - 1)
        mx = np.ceil((np.maximum(np.maximum(a, b), c) - lo) / cell).astype(int).clip(0, n - 1)
        if mx[0] < mn[0] or mx[1] < mn[1]:
            continue
        xs = lo[0] + (np.arange(mn[0], mx[0] + 1) + .5) * cell[0]
        zs = lo[1] + (np.arange(mn[1], mx[1] + 1) + .5) * cell[1]
        px, pz = np.meshgrid(xs, zs, indexing="ij")
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-14:
            continue
        w0 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[1])) / d
        w1 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[1])) / d
        inside = (w0 >= 0) & (w1 >= 0) & (w0 + w1 <= 1)
        grid[mn[0]:mx[0] + 1, mn[1]:mx[1] + 1] |= inside
    return grid


def _hull(points):
    """The convex hull of 2D points, counterclockwise (monotone chain)."""
    pts = sorted(set(map(tuple, np.round(points, 9))))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def filled_openings(recipe, rock_mesh):
    """For a solid recipe: how much of what its guide leaves open, seen from
    the front (along Blender +y), the rock covers. What is left open is the
    part of the guide's silhouette's convex hull the silhouette does not cover:
    an arch's span, a tunnel's mouth, the inside of a hook. Returns (that share
    of the hull, the share of it the rock covers), or None when the guide
    leaves nothing open."""
    guide = recipe.get("guide")
    if recipe.get("generator") != "solid" or not guide:
        return None
    gv = np.asarray(guide["verts"], float)[:, [0, 2]]
    gtris = [(gv[f[0]], gv[f[i]], gv[f[i + 1]]) for f in guide["faces"] for i in range(1, len(f) - 1)]
    lo, hi = gv.min(0), gv.max(0)
    pad = (hi - lo) * .02
    lo, hi = lo - pad, hi + pad
    n = OPENING_RASTER
    covered = _raster(gtris, lo, hi, n)
    hull = [np.asarray(p) for p in _hull(gv)]
    if len(hull) < 3:
        return None
    inside = _raster([(hull[0], hull[i], hull[i + 1]) for i in range(1, len(hull) - 1)], lo, hi, n)
    # Shrunk by a cell, so the hull's own rim (where the guide's sloping sides
    # rasterise a cell short of it) is not counted as open.
    inside[1:-1, 1:-1] &= inside[:-2, 1:-1] & inside[2:, 1:-1] & inside[1:-1, :-2] & inside[1:-1, 2:]
    opening = inside & ~covered
    if opening.sum() < 0.02 * inside.sum():
        return None
    rock_mesh.calc_loop_triangles()
    co = np.empty(3 * len(rock_mesh.vertices))
    rock_mesh.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)[:, [0, 2]]
    idx = np.empty(3 * len(rock_mesh.loop_triangles), np.int32)
    rock_mesh.loop_triangles.foreach_get("vertices", idx)
    idx = idx.reshape(-1, 3)
    rock = _raster(((co[a], co[b], co[c]) for a, b, c in idx), lo, hi, n)
    return float(opening.sum() / max(1, inside.sum())), float((rock & opening).sum() / opening.sum())


def triangles(mesh):
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    out = Path(argv[0])
    budget = int(argv[argv.index("--triangles") + 1]) if "--triangles" in argv else 150_000
    map_max = int(argv[argv.index("--map-max") + 1]) if "--map-max" in argv else 2048
    t0 = time.time()
    ob = bpy.data.objects.get("SceneryRock")
    if ob is None or ob.type != "MESH":
        raise SystemExit("rock.blend holds no SceneryRock mesh")
    if ob.matrix_world != ob.matrix_world.Identity(4):
        # The worker builds in the body's frame at the identity; anything else
        # would put the section and the mesh somewhere the body is not.
        raise SystemExit("SceneryRock is not at the identity")
    # The shape the bake will ship: the export bows the rock's long straight
    # creases (scene_export.straight_creases, then curve.bend after its maps),
    # and the iteration mesh and the section must be that shape, or the editor
    # draws and fits to a rock the bake then moves. The rock itself is saved
    # straight below: the bake does this to its own copy.
    step("finish", "creases")
    finished = ob.data.copy()
    import scene_export
    from formations import curve, render
    if render.slate_rock(ob) and render.setting(ob, "export_creases"):
        bows = scene_export.straight_creases(ob, finished)
        log(curve.bend(finished, bows))
    full = triangles(finished)

    step("section")
    loops = section_loops(finished)
    (out / "section.json").write_text(json.dumps({"plane": "y=0", "units": "m", "frame": "rock x, z up",
                                                  "loops": loops}))
    log(f"section: {len(loops)} loops, {sum(len(l['points']) for l in loops)} points"
        + ("" if all(l["closed"] for l in loops) else ", SOME OPEN"))

    step("prepare-bake")
    # The bake's caps: one colour map at most `map_max` (the normal is half,
    # formations/render.py `map_size`), every face counted as seen (the
    # caller passes --all-seen). Set on the rock itself, so the export reads
    # them as the object's own (render.setting).
    ob["export_map_max"] = map_max
    ob["export_maps"] = 1
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "bake.blend"), copy=True)

    step("geometry", f"{full:,} triangles")
    # The iteration look's mesh: a copy, decimated to the budget.
    geo = ob.copy()
    geo.data = finished
    geo.name = "FormationGeometry"
    bpy.context.scene.collection.objects.link(geo)
    tris = full
    if full > budget:
        mod = geo.modifiers.new("budget", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = budget / full
        mod.use_collapse_triangulate = True
        dg = bpy.context.evaluated_depsgraph_get()
        mesh = bpy.data.meshes.new_from_object(geo.evaluated_get(dg))
        geo.modifiers.clear()
        old = geo.data
        geo.data = mesh
        bpy.data.meshes.remove(old)
        tris = triangles(geo.data)
    creases = edge_attributes(geo.data)
    tris = triangles(geo.data)
    has_facet = facet_to_corners(geo.data)
    geo.data.materials.clear()
    for o in bpy.context.scene.objects:
        o.select_set(o is geo)
    bpy.context.view_layer.objects.active = geo
    kwargs = dict(filepath=str(out / "geometry.gltf"), export_format="GLTF_SEPARATE", use_selection=True,
                  export_apply=True, export_yup=True, export_normals=True, export_texcoords=False,
                  export_tangents=False, export_materials="NONE", export_cameras=False, export_lights=False,
                  export_animations=False, export_skins=False, export_morph=False, export_extras=False,
                  export_attributes=True, export_draco_mesh_compression_enable=False)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    bpy.ops.export_scene.gltf(**{k: v for k, v in kwargs.items() if k in props})

    vs = np.empty(3 * len(geo.data.vertices), np.float64)
    geo.data.vertices.foreach_get("co", vs)
    vs = vs.reshape(-1, 3)
    area = sum(p.area for p in geo.data.polygons)
    warnings = []
    step("openings")
    recipe = json.loads((out / "recipe.json").read_text())
    # The drawn mesh (`finished` may have been decimated away into it).
    openings = filled_openings(recipe, geo.data)
    if openings and openings[1] > OPENING_FILLED:
        warnings.append(f"the rock fills {openings[1] * 100:.0f}% of the opening its guide has seen from the front "
                        f"(the {recipe.get('variant', '')} variant builds over it); try another variant")
    stats = {"warnings": warnings, "triangles": full, "geometryTriangles": tris, "facet": has_facet,
             # Blender's frame (x right, y away from the camera, z up).
             "bounds": {"min": vs.min(0).round(4).tolist(), "max": vs.max(0).round(4).tolist()},
             "area": round(area, 4), "seconds": round(time.time() - t0, 2)}
    (out / "stats.json").write_text(json.dumps(stats))
    log(f"geometry: {full:,} -> {tris:,} triangles, facet {'kept' if has_facet else 'MISSING'}, {creases:,} crease edges, "
        f"{time.time() - t0:.1f}s")
    print("FORMATION_EXPORT_OK", flush=True)


if __name__ == "__main__":
    main()
