"""Grow a cave-plant patch on a surface picked in the level editor.

    blender -b --factory-startup --python editor_patch.py -- --spec patch.json --out DIR

`patch.json` holds the faces the editor selected, as a flat triangle soup in the
game's three.js frame relative to the patch origin (x right, y up, z toward the
camera, metres), plus the growth settings:

    {"positions": [x, y, z, ...], "seed": 0, "density": 1.5, "size": 1.0,
     "ivyLength": 1.2, "detail": 0.5, "slope": 75,
     "types": ["alocasia", "birdsnest", "fern", "creepers", "ivy"]}

The plants are the ones `cave_foliage.py` builds (rocks and mushrooms are not
grown here), placed by where the surface faces:

  * alocasia / birdsnest / fern stand on faces no steeper than `slope`, tilted
    halfway from vertical toward the surface normal, `density` per m2
  * creepers are small leaf patches lying flat on the same faces, `density` per m2
  * ivy hangs from the undersides (faces looking down), 4 x `density` per m2

Writes DIR/plants.glb in the same frame (the glTF exporter's +Y up undoes the
axis swap in `area_from_soup`), so the editor can place it at the patch origin
unchanged. Everything shares one vertex-colour material and carries the `_SWAY`
wind weight of `cave_foliage.py`.
"""
import argparse
import bisect
import json
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cave_foliage as cf  # noqa: E402

GROUND = {"alocasia": cf.build_alocasia, "birdsnest": cf.build_birds_nest, "fern": cf.build_fern}
TYPES = set(GROUND) | {"creepers", "ivy"}
MAX_INSTANCES = 800
UP = Vector((0, 0, 1))
FACE = Vector((0, -1, 0))   # ivy leaves face the camera (three.js +z is Blender -y)
HANG_MAX_UP = -0.5          # a face hangs ivy when its normal.z is at most this
TILT = 0.5                  # 0 = plants stand vertical, 1 = along the surface normal


def area_from_soup(positions):
    """three.js (x, y up, z out) -> Blender (x, -z, y up)."""
    me = bpy.data.meshes.new("PlantArea")
    bm = bmesh.new()
    for i in range(0, len(positions) - 8, 9):
        tri = []
        for k in range(3):
            x, y, z = positions[i + 3 * k: i + 3 * k + 3]
            tri.append(bm.verts.new((x, -z, y)))
        try:
            bm.faces.new(tri)
        except ValueError:
            pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("PlantArea", me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


class Sampler:
    """Uniform-by-area random points on a set of triangles."""

    def __init__(self, tris, rng):
        self.tris, self.rng = tris, rng
        self.cum, total = [], 0.0
        for t in tris:
            total += t["area"]
            self.cum.append(total)
        self.total = total

    def point(self):
        t = self.tris[min(bisect.bisect_left(self.cum, self.rng.random() * self.total), len(self.tris) - 1)]
        u, v = self.rng.random(), self.rng.random()
        if u + v > 1:
            u, v = 1 - u, 1 - v
        a, b, c = t["verts"]
        return a + (b - a) * u + (c - a) * v, t["normal"]


def rotation_to(axis, yaw):
    """A 3x3 turning +Z onto `axis` after spinning `yaw` about +Z."""
    return UP.rotation_difference(axis).to_matrix() @ Matrix.Rotation(yaw, 3, "Z")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    with open(args.spec, encoding="utf-8") as f:
        spec = json.load(f)

    seed = int(spec.get("seed", 0))
    density = float(spec.get("density", 1.5))
    size = float(spec.get("size", 1.0))
    ivy_len = float(spec.get("ivyLength", 1.2))
    slope = min(90.0, max(0.0, float(spec.get("slope", 75))))
    types = [t for t in spec.get("types", []) if t in TYPES]
    if not types:
        raise SystemExit("PLANTS: pick at least one plant type")
    ground_types = [t for t in types if t in GROUND]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    area = area_from_soup(spec["positions"])
    if not area.data.polygons:
        raise SystemExit("PLANTS: the selected surface has no faces")
    faces = [{"verts": [area.data.vertices[i].co.copy() for i in p.vertices],
              "normal": p.normal.copy(), "area": p.area} for p in area.data.polygons if p.area > 1e-9]

    cf.DETAIL, cf.GAME_MODE = float(spec.get("detail", 0.5)), True
    cf._GAME_MATS.clear()
    coll = cf.get_collection("CaveFoliage_Patch")
    mats = cf.make_materials()
    rng = random.Random(seed)
    placed, objs = [], []

    def add(ob, pos, rot, scale=1.0):
        ob.data.transform(Matrix.Translation(pos) @ rot.to_4x4() @ Matrix.Scale(scale, 4))
        ob.location = (0, 0, 0)
        objs.append(ob)

    min_up = math.cos(math.radians(slope))
    up_faces = [t for t in faces if t["normal"].z >= min_up - 1e-6 and t["normal"].z > -0.01]
    down_faces = [t for t in faces if t["normal"].z <= HANG_MAX_UP]

    def crowded(pos, radius):
        return any((pos - q).length < radius + r for q, r in placed)

    # ---- standing plants and creeper patches: what the surface faces up to
    if up_faces:
        ground = Sampler(up_faces, rng)
        wanted = []
        if ground_types:
            wanted += [rng.choice(ground_types) for _ in range(round(ground.total * density))]
        if "creepers" in types:
            wanted += ["creepers"] * round(ground.total * density)
        rng.shuffle(wanted)
        for n, kind in enumerate(wanted):
            if len(objs) >= MAX_INSTANCES:
                break
            s = size * rng.uniform(0.75, 1.25)
            radius = (0.3 if kind == "creepers" else 0.4) * s
            for _ in range(20):
                pos, nrm = ground.point()
                if not crowded(pos, radius):
                    break
            else:
                continue                        # no room left near here
            placed.append((pos, radius))
            yaw = rng.uniform(0, math.tau)
            if kind == "creepers":
                # a flat patch of ground for build_creepers to pick clusters on
                flat = [(Vector((rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), 0)), UP.copy(), 1.0)
                        for _ in range(12)]
                ob = cf.build_creepers(f"Creepers_{n}", Vector(), flat, seed * 7919 + n, coll, mats,
                                       rng.randint(5, 9))
                if ob:
                    add(ob, pos, rotation_to(nrm, yaw), s)
            else:
                ob = GROUND[kind](f"{kind}_{n}", Vector(), seed * 7919 + n, coll, mats, size=s)
                add(ob, pos, rotation_to(UP.lerp(nrm, TILT).normalized(), yaw))

    # ---- ivy hanging from the undersides
    if "ivy" in types and down_faces:
        ceiling = Sampler(down_faces, rng)
        for n in range(round(ceiling.total * density * 4)):
            if len(objs) >= MAX_INSTANCES:
                break
            pos, _ = ceiling.point()
            mb = cf.MeshBuilder()
            length = ivy_len * rng.uniform(0.4, 1.0)
            cf.add_ivy_vine(mb, Vector(), length, FACE, random.Random(seed * 104729 + n))
            ob = mb.build(f"IvyVine_{n}", [mats["ivy"], mats["stem"]], coll, Vector())
            add(ob, pos + UP * 0.02, Matrix.Identity(3))

    if not objs:
        raise SystemExit("PLANTS: nothing grew on this surface; raise the density, "
                         "pick more area, or raise max slope (ivy needs faces that look down)")

    ctx = bpy.context
    for o in ctx.view_layer.objects:
        o.select_set(False)
    with ctx.temp_override(active_object=objs[0], object=objs[0], selected_objects=objs,
                           selected_editable_objects=objs):
        bpy.ops.object.join()
    joined = objs[0]
    joined.name = "plants"
    joined.location = (0, 0, 0)
    tris = sum(len(p.vertices) - 2 for p in joined.data.polygons)
    out = os.path.join(args.out, "plants.glb")
    os.makedirs(args.out, exist_ok=True)
    cf._export_glb(out, [joined])
    print(f"PLANTS: {len(objs)} plants, {tris} triangles -> {out}")


if __name__ == "__main__":
    main()
