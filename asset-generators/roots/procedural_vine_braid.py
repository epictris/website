"""Fit one three-stem jungle vine braid to an authored cylindrical geometry object.

The cylinder's circular outline supplies the radius and its visual depth supplies
the length. Blender's local Z becomes the cylinder's local Y in the exported GLB;
both meshes are centred on the object's origin, so its authored transform applies
without an extra offset.
"""

import argparse
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from procedural_vines_v3 import Geometry, material, mesh_object, smooth_profile


def build(radius, length, seed):
    rng = random.Random(seed)
    collection = bpy.data.collections.new("VineBraid")
    bpy.context.scene.collection.children.link(collection)
    stems = Geometry()
    leaves = Geometry()

    # One centreline through the selected cylinder, with three persistent stems.
    # A braid turn is scaled to its diameter rather than to a preset curtain.
    turns = length / max(radius * 5, .18) * rng.uniform(.78, 1.22)
    segments = max(32, math.ceil(turns * 12))
    spread = radius * .43
    strand_radius = radius * .56
    phase = rng.uniform(0, math.tau)
    pitch = [0.0] + [rng.uniform(-.16, .16) for _ in range(7)] + [0.0]
    profiles = [
        (rng.uniform(0, math.tau),
         [rng.uniform(.72, 1.28) for _ in range(9)],
         [rng.uniform(.77, 1.23) for _ in range(9)])
        for _ in range(3)
    ]
    for thread, (shade, spread_profile, girth_profile) in enumerate(profiles):
        points = []
        radii = []
        for i in range(segments + 1):
            t = i / segments
            angle = phase + math.tau * (turns * t + thread / 3 + smooth_profile(pitch, t))
            # The source cylinder is centred on its local axis and has flat ends.
            z = (t - .5) * length
            # Blender builds from bottom to top here: t=0 is the hanging tip.
            # Smoothstep makes the taper join the body without a shoulder.
            tip = max(0.0, min(1.0, t / .16))
            tip = tip * tip * (3 - 2 * tip)
            end = min(1.0, (1 - t) * 15)
            spread_at_t = spread * smooth_profile(spread_profile, t) * (.08 + .92 * tip)
            points.append(Vector((math.cos(angle) * spread_at_t,
                                  math.sin(angle) * spread_at_t, z)))
            radii.append(strand_radius * smooth_profile(girth_profile, t) *
                         (.84 + .16 * end) * (.025 + .975 * tip))
        stems.tube(points, radii, 8, thread, shade=True,
                   shade_phase=shade, cap_ends=True)

    # Match v3's sparse 11-19 cm hanging blades and short petioles. Leaf size is
    # independent of cylinder radius so a thin authored braid still reads leafy.
    leaf_count = min(18, max(0, round(length * 1.05)))
    for i in range(leaf_count):
        t = (i + rng.uniform(.2, .8)) / leaf_count
        angle = phase + math.tau * turns * t
        outward = Vector((math.cos(angle), math.sin(angle), 0))
        root = outward * (radius * .8) + Vector((0, 0, (t - .5) * length))
        side = -1 if i % 2 else 1
        lateral = Vector((-outward.y, outward.x, 0)) * side
        petiole = root + lateral * rng.uniform(.04, .07) + Vector((0, 0, -.025))
        stems.tube((root, petiole), (.005, .003), 4)
        direction = (lateral * rng.uniform(.34, .58) + outward * .12 +
                     Vector((0, 0, -rng.uniform(.76, .98)))).normalized()
        blade = rng.uniform(.108, .19)
        leaves.leaf(petiole, direction, blade, blade * rng.uniform(.25, .35),
                    rng.uniform(-.028, .028), rng.randrange(3))

    stem_colors = ((.045, .085, .028), (.058, .105, .033), (.075, .125, .039))
    stem_mats = []
    for suffix, brightness, roughness in (("", 1, .87), (" light", 1.2, .76),
                                          (" recess", .8, .94)):
        for thread, color in enumerate(stem_colors):
            stem_mats.append(material(f"Braid stem {thread}{suffix}",
                                      tuple(c * brightness for c in color), roughness=roughness))
    mesh_object("vine_stems", stems, stem_mats, collection)
    if leaves.faces:
        leaf_mats = [material("Braid leaf deep", (.075, .22, .055), True),
                     material("Braid leaf green", (.15, .36, .07), True),
                     material("Braid leaf light", (.28, .46, .11), True)]
        mesh_object("vine_leaves", leaves, leaf_mats, collection)
    return collection


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--radius", required=True, type=float)
    parser.add_argument("--length", required=True, type=float)
    parser.add_argument("--seed", required=True, type=int)
    options = parser.parse_args(args)
    if not (.005 <= options.radius <= 1 and .1 <= options.length <= 30):
        parser.error("Cylinder dimensions are out of range")
    collection = build(options.radius, options.length, options.seed)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in collection.objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = collection.objects[0]
    options.out.mkdir(parents=True, exist_ok=True)
    path = options.out / "vine_braid.glb"
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=True)
    print(path)


if __name__ == "__main__":
    main()
