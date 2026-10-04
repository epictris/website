"""A level's backdrop: SOLID formations (formations/core.py, generator `solid`),
recipe F stones cut from closed guide meshes, sized by their depth from where
the level opens. This is their headless front end, for a script or an LLM; the
Formations panel does the same in Blender (docs/blender-backdrop.md).

    blender -b assets-src/scenes/river.blend --python-exit-code 1 \\
        --python tools/blender/backdrop.py -- levels/ball.json [COMMANDS] [--save]

Every run writes the level's start camera and water onto the scene
(`backdrop_camera`, which the panel's builds read), then, in this order:

    --adopt                 turn the meshes in `Backdrop sources` (the backdrop
                            before 2026-10-05) into solid formations, replacing
                            the rocks built from them
    --import solids.json    seed guides from an Orthographic Studio export
                            (scripts/ortho-solids.ts) for the pieces the scene
                            does not have yet, or those --only names, and build
    --set NAME key=value,.. a formation's parameters (solidfit.PARAMS: seed,
                            stoneSize, facets, chisel, knub, curveTurn, floor,
                            fixedScale, facetFalloff)
    --render NAME key=value,..  its render settings (formations/render.py:
                            detail_scale, export_strips, export_creases,
                            export_chips, export_map_max, export_texels;
                            `auto` forgets one)
    --rebuild changed|all|NAME,NAME   regenerate solid formations
    --list                  print every solid formation: guide, parameters,
                            render settings, whether it is pending
    --only id,id            limits --import (and --adopt) to those pieces

NAME is a formation's object name (`backdrop.roof`) or its piece id (`roof`).
Building runs the Formations worker (formations/worker.py), one headless
Blender per rock, exactly as the panel's Regenerate does; then the pool under
the backdrop is rebuilt. Saves only with --save.
"""

import json
import math
import os
import sys
import time
import zlib

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "boulders"))
import formations  # noqa: E402
from formations import core, fitted, render, slate, worker  # noqa: E402
from formations import params as params_module  # noqa: E402

COLLECTION, SOURCES = "Backdrop", "Backdrop sources"
PREFIX = "backdrop."
PIXELS_PER_METRE = 100  # the level format's
# The level's water slab reaches this far behind the plane (water.ts: depth
# centred on the plane, `waterDepth` 12 m); the pool starts there, a hair
# under its surface.
POOL_DROP = 0.02
POOL_COLOUR = "#1b4657"  # water.ts's deep stop
# How far under the water the solids' feet are sunk, screen metres (`sink`).
SINK = 0.4
# Pieces whose ceiling runs forward to the foreground, and the world y it
# runs to: the formations' back (the Terraces and dark rocks stand 0.5 either
# side of the plane). `extend`.
EXTEND = {"roof": 0.5}
# The extension stands this far (screen metres) above the start frame's top.
EXTEND_CLEAR = 0.1
# On an extended piece's solid: the least scale its stones are cut at, the
# piece's own before the sweep (its vertices' median depth over the plane's).
FLOOR_PROP = "backdrop_floor"
# Sections tried along the view for the one the extension is swept from.
EXTEND_SECTIONS = 40


def log(msg):
    print(f"[backdrop] {msg}", flush=True)


def args():
    argv = sys.argv[sys.argv.index("--") + 1:]
    opts = {"only": None, "save": False, "import": None, "adopt": False, "rebuild": None, "list": False,
            "set": [], "render": []}
    pos = []
    it = iter(argv)
    for a in it:
        if a == "--only":
            opts["only"] = set(next(it).split(","))
        elif a in ("--import", "--rebuild"):
            opts[a[2:]] = next(it)
        elif a in ("--set", "--render"):
            opts[a[2:]].append((next(it), next(it)))
        elif a in ("--save", "--adopt", "--list"):
            opts[a[2:]] = True
        else:
            pos.append(a)
    if len(pos) != 1:
        raise SystemExit("usage: backdrop.py -- level.json [--adopt] [--import solids.json] [--set NAME k=v,..] "
                         "[--render NAME k=v,..] [--rebuild changed|all|NAME,..] [--list] [--only id,..] [--save]")
    return pos[0], opts


def start_camera(level):
    """The eye the level opens with, in Blender metres, its distance from
    the gameplay plane, and the tangent of its vertical half-angle."""
    spawn = level["player"]
    for r in level.get("cameraRegions", []):
        w, h = r["shape"]["w"], r["shape"]["h"]
        if abs(spawn["x"] - r["x"]) <= w / 2 and abs(spawn["y"] - r["y"]) <= h / 2 and "lockX" in r:
            x, y = r["lockX"], r["lockY"]
            break
    else:
        raise SystemExit("no camera region locks the spawn: the start view is not fixed")
    cam = bpy.data.objects.get("guide.camera")
    if cam is None:
        raise SystemExit("no guide.camera: run `just scene-guide <level>` first")
    if cam.data.sensor_fit != "VERTICAL":
        raise SystemExit("guide.camera is not fitted vertically")
    distance = -cam.matrix_world.translation.y
    return (x / PIXELS_PER_METRE, -distance, -y / PIXELS_PER_METRE), distance, cam.data.sensor_height / 2 / cam.data.lens


def water_top(level, eye, half_width):
    """The highest water surface under the eye across the start frame, as a
    Blender z, and how far behind the plane its slab reaches."""
    best = None
    for b in level["bodies"]:
        if b.get("kind") != "water" or b.get("rot", 0):
            continue
        for o in b.get("objects", []):
            if o.get("type") != "collision" or o["shape"]["kind"] != "rect":
                continue
            cx = (b["x"] + o.get("x", 0)) / PIXELS_PER_METRE
            w = o["shape"]["w"] / PIXELS_PER_METRE
            top = -(b["y"] + o.get("y", 0) - o["shape"]["h"] / 2) / PIXELS_PER_METRE
            if abs(cx - eye[0]) > w / 2 + half_width or top > eye[2]:
                continue
            back = (b.get("waterZ", 0) + b.get("waterDepth", 120) / 2) / PIXELS_PER_METRE
            if best is None or top > best[0]:
                best = (top, back)
    if best is None:
        raise SystemExit("no water under the start frame to stand the pool on")
    return best


def mapping(solids, eye, tan_half):
    """The studio's frame onto the game's: `place(points)`, and its numbers."""
    cam = solids["camera"]
    studio_eye = cam["position"]
    studio_tan = math.tan(math.radians(cam["fov"]) / 2)
    water = next(o for o in solids["objects"] if o["kind"] == "water")
    studio_water = max(v[2] for v in water["verts"])
    s = tan_half / studio_tan

    def place(points, k):
        return [(eye[0] + s * k * (p[0] - studio_eye[0]), eye[1] + k * (p[1] - studio_eye[1]),
                 eye[2] + s * k * (p[2] - studio_eye[2])) for p in points]

    return s, studio_eye[2] - studio_water, place


def sink(points, water_z, eye, distance):
    """Drop every point under the water to SINK (screen metres, times its
    depth over the plane's) under it. The studio's solids stop a few
    centimetres under their pool, and the weathering rounds a stone's foot
    up by more than that, so the boulders hung above the water (Tris,
    2026-10-04: "there should be no floating rocks"); sunk, every stone that
    reaches the water runs on under it."""
    return [(x, y, water_z - SINK * (y - eye[1]) / distance) if z < water_z else (x, y, z) for x, y, z in points]


def _section(bm, y):
    """The solid's section at depth `y`, filled, as its own bmesh."""
    c = bm.copy()
    cut = bmesh.ops.bisect_plane(c, geom=c.verts[:] + c.edges[:] + c.faces[:],
                                 plane_co=(0, y, 0), plane_no=(0, 1, 0))
    edges = [e for e in cut["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
    out = bmesh.new()
    verts = {}
    for e in edges:
        for v in e.verts:
            if v not in verts:
                verts[v] = out.verts.new((v.co.x, y, v.co.z))
    out_edges = [out.edges.new((verts[a], verts[b])) for a, b in (e.verts for e in edges) if verts[a] is not verts[b]]
    c.free()
    bmesh.ops.triangle_fill(out, use_beauty=True, use_dissolve=False, edges=out_edges, normal=(0, 1, 0))
    return out


def _volume(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    v = bm.calc_volume()
    bm.free()
    return v


def _boolean(ob, other, operation):
    mod = ob.modifiers.new(operation.lower(), "BOOLEAN")
    mod.operation = operation
    mod.object = other
    mod.solver = "MANIFOLD"
    fitted._apply_modifiers(ob)


def extend(ob, to_y, eye, distance, tan_half):
    """Run the piece's ceiling forward to `to_y` (Tris, 2026-10-04: the roof
    arch should "extend out all the way to the foreground geometry"). The
    studio's roof is a slab 25 m back with only its stem and right wall
    reaching forward, so from the side the sky showed between it and the
    level. Its largest section along the view is swept forward to `to_y`
    and cut off under the start frame's top edge (a plane through the eye),
    EXTEND_CLEAR above it: from the start camera nothing of the sweep shows
    and the opening shot is the studio's as before; from anywhere else the
    ceiling runs on overhead to the level's own rock."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    ys = [v.co.y for v in bm.verts]
    lo, hi = min(ys), max(ys)
    best = None
    for i in range(1, EXTEND_SECTIONS):
        sec = _section(bm, lo + (hi - lo) * i / EXTEND_SECTIONS)
        area = sum(f.calc_area() for f in sec.faces)
        if best is None or area > best[0]:
            if best is not None:
                best[1].free()
            best = (area, sec, lo + (hi - lo) * i / EXTEND_SECTIONS)
        else:
            sec.free()
    bm.free()
    _, sweep, y_sec = best
    grown = bmesh.ops.extrude_face_region(sweep, geom=sweep.faces[:])
    bmesh.ops.translate(sweep, vec=(0, to_y - y_sec, 0),
                        verts=[g for g in grown["geom"] if isinstance(g, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(sweep, faces=sweep.faces)
    if sweep.calc_volume(signed=True) < 0:
        bmesh.ops.reverse_faces(sweep, faces=sweep.faces)
    me = bpy.data.meshes.new("extension")
    sweep.to_mesh(me)
    sweep.free()
    ext = bpy.data.objects.new("extension", me)
    bpy.context.scene.collection.objects.link(ext)
    # Above the start frame's top: a box standing on the plane through the
    # eye, tilted up by EXTEND_CLEAR at the gameplay plane.
    tilt = math.atan(tan_half + EXTEND_CLEAR / distance)
    size = 200.0
    box = bmesh.new()
    bmesh.ops.create_cube(box, size=1.0)
    frame = Matrix.Translation(eye) @ Matrix.Rotation(tilt, 4, "X")
    bmesh.ops.transform(box, verts=box.verts,
                        matrix=frame @ Matrix.Translation((0, 0, size / 2)) @ Matrix.Diagonal((size, size, size, 1)))
    bme = bpy.data.meshes.new("above")
    box.to_mesh(bme)
    box.free()
    above = bpy.data.objects.new("above", bme)
    bpy.context.scene.collection.objects.link(above)
    _boolean(ext, above, "INTERSECT")
    # The union is made on the sweep and handed to the solid: the solid's
    # collection is hidden, and the depsgraph does not evaluate a hidden
    # object's modifiers (the union added nothing).
    before = _volume(ob)
    _boolean(ext, ob, "UNION")
    ob.data, ext.data = ext.data, ob.data
    if _volume(ob) <= before:
        raise SystemExit(f"{ob.name}: the ceiling's sweep added nothing")
    for o in (ext, above):
        me = o.data
        bpy.data.objects.remove(o)
        bpy.data.meshes.remove(me)
    log(f"{ob.get('backdrop_id')}: ceiling swept forward from y {y_sec:.2f} to {to_y:.2f}")


def mesh_object(name, verts, faces, collection):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # recalc_face_normals left the studio's solids wound inside out (signed
    # volume -2.98 m3 on rock-a), and every step after works along normals.
    if bm.calc_volume(signed=True) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    collection.objects.link(ob)
    return ob


def collection(name, hidden):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(col)
    col.hide_render = hidden
    col.hide_viewport = hidden
    return col


def pool(name, rocks, z, back, col):
    """A plane at the water's height from the level's water slab's back to
    behind the farthest rock, as wide as the backdrop."""
    xs = [v[0] for ob in rocks for v in ob.bound_box]
    ys = [v[1] for ob in rocks for v in ob.bound_box]
    x0, x1, y1 = min(xs), max(xs), max(ys) + 1.0
    ob = mesh_object(name, [(x0, back, z), (x1, back, z), (x1, y1, z), (x0, y1, z)], [(0, 1, 2, 3)], col)
    mat = bpy.data.materials.get("Backdrop pool") or bpy.data.materials.new("Backdrop pool")
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = slate.srgb(POOL_COLOUR)
    bsdf.inputs["Roughness"].default_value = 0.35
    ob.data.materials.append(mat)
    ob["backdrop_id"] = "pool"
    return ob


def piece_id(name):
    return name[len(PREFIX):] if name.startswith(PREFIX) else name


def solid_formations():
    return [ob for ob in core.formations() if core.is_solid(ob)]


def find(name):
    """The solid formation called `name`, or `backdrop.<name>`."""
    for ob in solid_formations():
        if ob.name in (name, PREFIX + name):
            return ob
    raise SystemExit(f"no solid formation {name!r}: --list shows them")


def parse(pairs):
    out = {}
    for pair in pairs.split(","):
        key, _, value = pair.partition("=")
        if not value:
            raise SystemExit(f"{pair!r}: want key=value")
        out[key.strip()] = value.strip()
    return out


def number(value):
    if value.lower() in ("true", "false"):
        return value.lower() == "true"
    return float(value) if any(c in value for c in ".e") else int(value)


def run_worker(recipe):
    """Build one rock in the Formations worker; the rock.blend it wrote."""
    proc, out, log_file = core.launch_worker(recipe)
    code = proc.wait()
    log_file.close()
    text = (out / "worker.log").read_text(errors="replace")
    for line in text.splitlines():
        if line.startswith("SOLID_REPORT"):
            log(f"  {line[len('SOLID_REPORT '):]}")
    if code:
        print(text[-3000:])
        raise SystemExit(core.worker_failure(out))
    return out / "rock.blend"


def create(name, guide_ob, params):
    """A new solid formation `name` from the mesh `guide_ob` (world space),
    built now. The mesh itself is left as it was."""
    world = core.authored_world(guide_ob)
    settings = {**worker.GENERATORS["solid"], **params}
    recipe = {"generator": "solid", "params": settings, "camera": core.scene_camera(),
              "frame": [list(r) for r in Matrix.Identity(4)],
              "guide": {"verts": [[round(c, 6) for c in world @ v.co] for v in guide_ob.data.vertices],
                        "faces": [list(p.vertices) for p in guide_ob.data.polygons]}}
    t0 = time.time()
    ob = core.append_rock(run_worker(recipe), name)
    log(f"{name}: built, {len(ob.data.polygons)} faces, {time.time() - t0:.1f}s")
    return ob


def replace(name):
    """Remove an old-style backdrop rock (`backdrop_id`, no recipe) or a solid
    formation of that name, so a new one takes the name."""
    old = bpy.data.objects.get(name)
    if old is None:
        return
    if core.is_formation(old):
        core.remove_formation(old)
    else:
        me = old.data
        bpy.data.objects.remove(old)
        if me is not None and me.users == 0:
            bpy.data.meshes.remove(me)


def adopt(opts):
    """The backdrop as it was built before 2026-10-05 (a mesh per piece in
    `Backdrop sources`, its rock in `Backdrop`) as solid formations, with the
    seed and depth floor it was built with."""
    src = bpy.data.collections.get(SOURCES)
    if src is None:
        log("adopt: no Backdrop sources")
        return
    for ob in sorted(src.objects, key=lambda o: o.name):
        id = ob.get("backdrop_id") or ob.name
        if opts["only"] is not None and id not in opts["only"]:
            continue
        params = {"seed": zlib.crc32(id.encode()) % 100000, "floor": float(ob.get(FLOOR_PROP, 0.0))}
        replace(PREFIX + id)
        create(PREFIX + id, ob, params)
        me = ob.data
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)
    if not src.objects:
        bpy.data.collections.remove(src)


def seed_from_studio(solids_path, opts, eye, distance, tan_half, water_z):
    """New guides from the studio's solids (docstring), built."""
    solids = json.load(open(solids_path))
    s, studio_height, place = mapping(solids, eye, tan_half)
    k = (eye[2] - water_z) / (studio_height * s)
    log(f"import {solids.get('source')}: s {s:.4f}, k {k:.4f}: across x{s * k:.3f}, along x{k:.3f}")
    have = {piece_id(ob.name) for ob in solid_formations()}
    tmp = bpy.data.collections.new("Backdrop import")
    bpy.context.scene.collection.children.link(tmp)
    try:
        for o in solids["objects"]:
            if o["kind"] != "rock":
                continue
            named = opts["only"] is not None and o["id"] in opts["only"]
            if opts["only"] is not None and not named:
                continue
            if o["id"] in have and not named:
                log(f"{o['id']}: kept the scene's formation")
                continue
            guide = mesh_object("guide", sink(place(o["verts"], k), water_z, eye, distance), o["tris"], tmp)
            params = {"seed": zlib.crc32(o["id"].encode()) % 100000}
            if o["id"] in EXTEND:
                # The sweep is cut as the piece was before it (solidfit.cells).
                ys = sorted(v.co.y for v in guide.data.vertices)
                params["floor"] = round((ys[len(ys) // 2] - eye[1]) / distance, 4)
                extend(guide, EXTEND[o["id"]], eye, distance, tan_half)
            replace(PREFIX + o["id"])
            ob = create(PREFIX + o["id"], guide, params)
            ob["formation_import"] = json.dumps({"source": solids.get("source"), "object": o["id"],
                                                 "mapping": {"across": s * k, "along": k}})
    finally:
        for ob in list(tmp.objects):
            me = ob.data
            bpy.data.objects.remove(ob)
            bpy.data.meshes.remove(me)
        bpy.data.collections.remove(tmp)


def set_params(name, pairs):
    ob = find(name)
    if not params_module.editable(ob):
        params_module.load(ob)
    settings = ob.formation_params
    for key, value in parse(pairs).items():
        field = params_module.FIELDS["solid"].get(key)
        if field is None:
            raise SystemExit(f"{key!r} is not a solid parameter: {', '.join(params_module.FIELDS['solid'])}")
        setattr(settings, field, number(value))
    log(f"{ob.name}: {params_module.from_settings(settings)[1]}{' (pending)' if core.pending(ob) else ''}")


def set_render(name, pairs):
    ob = find(name)
    for key, value in parse(pairs).items():
        if key not in render.SETTINGS:
            raise SystemExit(f"{key!r} is not a render setting: {', '.join(render.SETTINGS)}")
        if value == "auto":
            ob.pop(key, None)
        else:
            setattr(ob, render.FIELDS[key], number(value))
    log(f"{ob.name}: {describe_render(ob)}")


def describe_render(ob):
    return ", ".join(f"{n} {render.setting(ob, n)}{'' if n in ob else ' (auto)'}" for n in render.SETTINGS)


def rebuild(which):
    obs = solid_formations()
    if which == "changed":
        targets = [ob for ob in obs if core.pending(ob)]
    elif which == "all":
        targets = obs
    else:
        targets = [find(n) for n in which.split(",")]
    for ob in targets:
        t0 = time.time()
        core.replace_from_worker(ob, run_worker(core.recipe_for(ob)))
        log(f"{ob.name}: rebuilt, {len(ob.data.polygons)} faces, {time.time() - t0:.1f}s")
    return targets


def list_all():
    for ob in solid_formations():
        guide = bpy.data.objects.get(ob.get("formation_outline", ""))
        recipe = json.loads(ob["formation_recipe"])
        log(f"{ob.name}: guide {guide.name if guide else '-'} ({len(guide.data.polygons) if guide else 0} faces), "
            f"{len(ob.data.polygons)} faces{', PENDING' if core.pending(ob) else ''}")
        log(f"  built with {recipe['params']}")
        if params_module.editable(ob) and params_module.changed(ob):
            log(f"  next build {params_module.current(ob)[1]}")
        log(f"  render: {describe_render(ob)}")


def main():
    level_path, opts = args()
    # The add-on's properties: registered already when Blender loaded the
    # installed extension (no --factory-startup), else registered here.
    if not hasattr(bpy.types.Object, "formation_params"):
        formations.register()
    level = json.load(open(level_path))
    eye, distance, tan_half = start_camera(level)
    water_z, water_back = water_top(level, eye, distance * tan_half * 16 / 9)
    log(f"eye {tuple(round(c, 3) for c in eye)}, plane {distance:.3f} m away, water z {water_z:.3f}")
    bpy.context.scene[core.CAMERA] = json.dumps({"eye": list(eye), "distance": distance, "tanHalf": tan_half,
                                                 "waterZ": water_z})
    for ob in solid_formations():
        if not params_module.editable(ob):
            params_module.load(ob)
    built = False
    if opts["adopt"]:
        adopt(opts)
        built = True
    if opts["import"]:
        seed_from_studio(opts["import"], opts, eye, distance, tan_half, water_z)
        built = True
    for name, pairs in opts["set"]:
        set_params(name, pairs)
    for name, pairs in opts["render"]:
        set_render(name, pairs)
    if opts["rebuild"]:
        built = bool(rebuild(opts["rebuild"])) or built
    if opts["list"]:
        list_all()
    if built:
        col = collection(COLLECTION, False)
        for ob in [o for o in col.objects if o.get("backdrop_id") == "pool"]:
            me = ob.data
            bpy.data.objects.remove(ob)
            bpy.data.meshes.remove(me)
        rocks = solid_formations()
        if rocks:
            pool("backdrop pool", rocks, water_z - POOL_DROP, water_back, col)
    if opts["save"]:
        bpy.ops.wm.save_mainfile()
        log(f"saved {bpy.data.filepath}")


if __name__ == "__main__":
    main()
