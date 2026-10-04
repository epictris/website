"""Build a level's backdrop in its Blender scene from an Orthographic Studio
scene: every rock of it as a recipe F mass in the painted slate, standing
where the game camera, at the level's start, sees the studio's picture.

    bun scripts/ortho-solids.ts <scene id> solids.json
    blender -b assets-src/scenes/river.blend --python-exit-code 1 \\
        --python tools/blender/backdrop.py -- solids.json levels/ball.json [--only id,id] [--save]

docs/blender-backdrop.md is the record; in short:

- THE CAMERA. The level opens with the camera locked by the camera region
  the spawn stands in (`lockX`, `lockY`); the guide's `guide.camera` gives
  its distance from the gameplay plane and its lens.
- THE MAPPING. The studio's picture was drawn through a 40 degree lens, the
  game's is 19.5 degrees, so the solids cannot simply be scaled: every point
  keeps the angle it makes with the studio camera's axis, times `s` (the
  ratio of the two lenses' half-heights, so the picture fills the frame top
  to bottom), at `k` times its depth. That is a scale of `s k` across and up
  and `k` along the view, about the eye, and it is exactly the picture from
  the eye. `k` puts the studio's pool on the level's own water.
- THE ROCKS. formations/solidfit.py: recipe F rocks fitted to each solid as
  the camera sees it and fused with the solid as their core, scaled with
  depth so the backdrop is as finely worked on screen as a formation.
- THE POOL. A plane at the water's height under the whole backdrop, behind
  the level's own water (which reaches WATER_BACK behind the plane), so the
  backdrop's feet stand in water across the frame.

Idempotent: it replaces what it built before (by the `backdrop_recipe`
property), and saves only with --save. The rocks carry their recipe; the
solids stay in `Backdrop sources` (hidden) as the blockout they were fitted
to.
"""

import json
import math
import os
import sys
import time
import zlib

import bmesh
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "boulders"))
from formations import solidfit, slate  # noqa: E402

COLLECTION, SOURCES = "Backdrop", "Backdrop sources"
PIXELS_PER_METRE = 100  # the level format's
# The level's water slab reaches this far behind the plane (water.ts: depth
# centred on the plane, `waterDepth` 12 m); the pool starts there, a hair
# under its surface.
POOL_DROP = 0.02
POOL_COLOUR = "#1b4657"  # water.ts's deep stop
# How far under the water the solids' feet are sunk, screen metres (`sink`).
SINK = 0.4


def log(msg):
    print(f"[backdrop] {msg}", flush=True)


def args():
    argv = sys.argv[sys.argv.index("--") + 1:]
    opts = {"only": None, "save": False}
    pos = []
    it = iter(argv)
    for a in it:
        if a == "--only":
            opts["only"] = set(next(it).split(","))
        elif a == "--save":
            opts["save"] = True
        else:
            pos.append(a)
    if len(pos) != 2:
        raise SystemExit("usage: backdrop.py -- solids.json level.json [--only id,id] [--save]")
    return pos[0], pos[1], opts


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


def clear(col, only):
    for ob in list(col.objects):
        if only is None or ob.get("backdrop_id") in only:
            me = ob.data
            bpy.data.objects.remove(ob)
            if me is not None and me.users == 0:
                bpy.data.meshes.remove(me)


def pool(name, rocks, z, back, col):
    """A plane at the water's height from the level's water slab's back to
    behind the farthest rock, as wide as the backdrop."""
    xs = [v[0] for ob in rocks for v in ob.bound_box]
    ys = [v[1] for ob in rocks for v in ob.bound_box]
    x0, x1, y1 = min(xs), max(xs), max(ys) + 1.0
    ob = mesh_object(name, [(x0, back, z), (x1, back, z), (x1, y1, z), (x0, y1, z)], [(0, 1, 2, 3)], col)
    mat = bpy.data.materials.get("Backdrop pool") or bpy.data.materials.new("Backdrop pool")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = slate.srgb(POOL_COLOUR)
    bsdf.inputs["Roughness"].default_value = 0.35
    ob.data.materials.append(mat)
    ob["backdrop_id"] = "pool"
    return ob


def main():
    solids_path, level_path, opts = args()
    solids = json.load(open(solids_path))
    level = json.load(open(level_path))
    eye, distance, tan_half = start_camera(level)
    water_z, water_back = water_top(level, eye, distance * tan_half * 16 / 9)
    s, studio_height, place = mapping(solids, eye, tan_half)
    k = (eye[2] - water_z) / (studio_height * s)
    log(f"eye {tuple(round(c, 3) for c in eye)}, plane {distance:.3f} m away, water z {water_z:.3f}; "
        f"s {s:.4f}, k {k:.4f}: across x{s * k:.3f}, along x{k:.3f}")

    rocks_col, src_col = collection(COLLECTION, False), collection(SOURCES, True)
    clear(rocks_col, opts["only"])
    clear(src_col, opts["only"])
    pieces = [o for o in solids["objects"] if o["kind"] == "rock"]
    sources = {}
    for o in pieces:
        name = f"backdrop.{o['id']} / solid"
        ob = bpy.data.objects.get(name)
        if ob is None:
            ob = mesh_object(name, sink(place(o["verts"], k), water_z, eye, distance), o["tris"], src_col)
            ob["backdrop_id"] = o["id"]
        sources[o["id"]] = ob

    camera = solidfit.Camera(eye, distance)
    tmp = bpy.data.collections.new("Backdrop pieces")
    bpy.context.scene.collection.children.link(tmp)
    for o in pieces:
        if opts["only"] is not None and o["id"] not in opts["only"]:
            continue
        t0 = time.time()
        seed = zlib.crc32(o["id"].encode()) % 100000
        params = {"seed": seed, "core": os.environ.get("BACKDROP_CORE", "1") == "1"}
        rock, parts, scale, report = solidfit.build(sources[o["id"]], camera, params, tmp, water_z)
        for p in parts:
            me = p.data
            bpy.data.objects.remove(p)
            bpy.data.meshes.remove(me)
        bm = bmesh.new()
        bm.from_mesh(rock.data)
        bmesh.ops.dissolve_degenerate(bm, dist=1e-5, edges=list(bm.edges))
        bm.normal_update()
        bm.to_mesh(rock.data)
        bm.free()
        rock.name = rock.data.name = f"backdrop.{o['id']}"
        # Its own slate, its lengths scaled with the piece's depth, so the
        # viewport shows what the export bakes (scene_export.detail_scale).
        material = bpy.data.materials.new(slate.NAME)
        material[slate.SCALE_PROP] = scale
        slate.paint(material)
        rock.data.materials.clear()
        rock.data.materials.append(material)
        slate.tone_facets(rock, seed)
        rocks_col.objects.link(rock)
        rock["backdrop_id"] = o["id"]
        rock[slate.OBJECT_SCALE_PROP] = round(scale, 4)
        rock["backdrop_recipe"] = json.dumps({
            "source": solids.get("source"), "object": o["id"], "params": params,
            "camera": {"eye": eye, "distance": distance, "tanHalf": tan_half},
            "mapping": {"across": s * k, "along": k, "studioEye": solids["camera"]["position"]},
            "waterZ": water_z,
        })
        log(f"{o['id']}: {len(parts) - 1} stones, {len(rock.data.polygons)} faces, scale {scale:.2f}, "
            f"{report['merged']} slivers merged, {report['thickened open']} open edges thickened, {report['floating']} floating, {report['lost to folds']} stones lost to folds{f", {report['core sharp']} sharp core edges" if report['core sharp'] else ''}, "
            f"{time.time() - t0:.1f}s")
    bpy.data.collections.remove(tmp)
    if opts["only"] is None or "pool" in opts["only"]:
        built = [ob for ob in rocks_col.objects if ob.get("backdrop_id") != "pool"]
        pool("backdrop pool", built, water_z - POOL_DROP, water_back, rocks_col)
    if opts["save"]:
        bpy.ops.wm.save_mainfile()
        log(f"saved {bpy.data.filepath}")


main()
