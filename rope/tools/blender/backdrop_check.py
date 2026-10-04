"""Check a scene's backdrop (docs/blender-backdrop.md) against its rules.

    blender -b assets-src/scenes/river.blend --python tools/blender/backdrop_check.py

Per backdrop rock, from the start camera its recipe names:

- GAPS: over the solid's silhouette (above the water), the share of rays
  whose first backdrop hit is the core (a fissure) and the share that meet
  no backdrop rock near the solid's surface (a hole the scenery behind shows
  through). Tris, 2026-10-04: "pack tightly together ... to avoid gaps".
- SHARP: convex edges whose inside angle is under 80 degrees, and edges with
  a face on one side only. Tris, 2026-10-04: "avoid geometry with convex
  angles smaller than 80 degrees".
- PARTS: the loose parts and the smallest, against the scraps the build
  removes (formations/solidfit.py, SCRAP_SIZE).

Exits 1 when a rock has a sharp or open edge or a part smaller than
SCRAP_SIZE; gaps are reported, not judged (the right share is a look).
"""

import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from formations import solidfit  # noqa: E402

GRID = (480, 270)  # rays across and up the 16:9 frame
# A hit this much (screen metres, times depth) behind the solid's surface
# is the scenery behind, not the rock.
BEHIND = 0.6


def tree(obs):
    bm = bmesh.new()
    for o in obs:
        me = o.data.copy()
        me.transform(o.matrix_world)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    t = BVHTree.FromBMesh(bm)
    bm.free()
    return t


def edges(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bm.normal_update()
    sharp = open_ = 0
    for e in bm.edges:
        if e.is_boundary or e.is_wire:
            open_ += 1
        elif e.is_manifold and e.calc_face_angle_signed(0) > math.pi - solidfit.MIN_ANGLE:
            sharp += 1
    bm.free()
    return sharp, open_


def parts(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    seen, sizes = set(), []
    for f in bm.faces:
        if f in seen:
            continue
        stack, co = [f], []
        seen.add(f)
        while stack:
            g = stack.pop()
            co += [v.co.copy() for v in g.verts]
            for e in g.edges:
                for h in e.link_faces:
                    if h not in seen:
                        seen.add(h)
                        stack.append(h)
        sizes.append(float(np.linalg.norm(np.ptp(np.array(co), axis=0))))
    bm.free()
    return sizes


def main():
    rocks = sorted((o for o in bpy.data.objects if o.get("backdrop_recipe") and o.type == "MESH"),
                   key=lambda o: o.name)
    if not rocks:
        raise SystemExit("no backdrop rocks in this file")
    recipe = json.loads(rocks[0]["backdrop_recipe"])
    eye = Vector(recipe["camera"]["eye"])
    distance, tan_half, water_z = recipe["camera"]["distance"], recipe["camera"]["tanHalf"], recipe["waterZ"]
    solids = {o.name: bpy.data.objects.get(f"{o.name} / solid") for o in rocks}
    solid_trees = {n: tree([s]) for n, s in solids.items() if s is not None}
    built = {}
    for o in rocks:
        marks = [0] * len(o.data.polygons)
        attr = o.data.attributes.get(solidfit.CORE_ATTRIBUTE)
        if attr is not None:
            attr.data.foreach_get("value", marks)
        built[o.name] = (tree([o]), marks)
    stats = {n: [0, 0, 0] for n in solid_trees}  # silhouette rays, core seen, holes
    w, h = GRID
    for j in range(h):
        for i in range(w):
            d = Vector(((((i + .5) / w) * 2 - 1) * tan_half * 16 / 9, 1, (1 - ((j + .5) / h) * 2) * tan_half))
            d.normalize()
            nearest = None
            for n, t in solid_trees.items():
                hit = t.ray_cast(eye, d)
                if hit[0] is not None and (nearest is None or hit[3] < nearest[1]):
                    nearest = (n, hit[3])
            if nearest is None or eye.z + d.z * nearest[1] < water_z:
                continue
            n, depth = nearest
            stats[n][0] += 1
            first = None
            for m, (t, _) in built.items():
                hit = t.ray_cast(eye, d)
                if hit[0] is not None and (first is None or hit[3] < first[2]):
                    first = (m, hit[2], hit[3])
            if first is None or first[2] > depth + BEHIND * depth / distance:
                stats[n][2] += 1
            elif built[first[0]][1][first[1]]:
                stats[n][1] += 1
    failed = False
    for o in rocks:
        rays, core, holes = stats.get(o.name, (0, 0, 0))
        sharp, open_ = edges(o)
        sizes = parts(o)
        least = solidfit.SCRAP_SIZE * float(o.get("detail_scale", 1.0))
        bad = sharp or open_ or (sizes and min(sizes) < least)
        failed |= bool(bad)
        gaps = f"core {100 * core / rays:4.1f}% holes {100 * holes / rays:4.1f}%" if rays else "not in view"
        print(f"{'FAIL' if bad else 'ok  '} {o.name:28s} {gaps}  sharp {sharp} open {open_}  "
              f"parts {len(sizes)}, smallest {min(sizes):.2f} m (scrap {least:.2f})")
    total = [sum(v[k] for v in stats.values()) for k in range(3)]
    print(f"all: core {100 * total[1] / total[0]:.1f}% holes {100 * total[2] / total[0]:.1f}% of {total[0]} rays")
    if failed:
        sys.exit(1)


main()
