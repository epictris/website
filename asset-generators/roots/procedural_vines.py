"""Seeded jungle vines for Blender 5.x.

In Blender: run this script to add editable vines. To export three variants at
three detail levels:
  blender --background --factory-startup --python procedural_vines.py -- --out vine_output
Units are metres. Attachments start at Z=0 and hang toward negative Z.
"""

import argparse
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector


VARIANTS = {
    "curtain": (1701, 7, 2.6, 2.8, .22, 1.0, .15),
    "cascade": (2718, 4, 1.7, 3.5, .43, 1.35, .35),
    "tangle": (3141, 6, 2.0, 2.5, .55, .85, 1.0),
}
LODS = {0: (8, 48, 1, True), 1: (6, 30, 2, True), 2: (4, 18, 3, False)}


def material(name, color, double_sided=False):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = .85
    mat.use_backface_culling = not double_sided
    return mat


class Geometry:
    def __init__(self):
        self.vertices = []
        self.faces = []
        self.materials = []

    def face(self, points, material_index):
        start = len(self.vertices)
        self.vertices.extend(tuple(p) for p in points)
        self.faces.append(tuple(start + i for i in range(len(points))))
        self.materials.append(material_index)

    def tube(self, points, radii, sides=6, material_index=0):
        base = len(self.vertices)
        for i, point in enumerate(points):
            tangent = Vector(points[min(i + 1, len(points) - 1)]) - Vector(points[max(i - 1, 0)])
            tangent.normalize()
            reference = Vector((0, 1, 0)) if abs(tangent.y) < .9 else Vector((1, 0, 0))
            u = tangent.cross(reference).normalized()
            v = tangent.cross(u).normalized()
            for j in range(sides):
                angle = math.tau * j / sides
                self.vertices.append(tuple(Vector(point) + radii[i] * (u * math.cos(angle) + v * math.sin(angle))))
        for i in range(len(points) - 1):
            for j in range(sides):
                a = base + i * sides + j
                b = base + i * sides + (j + 1) % sides
                self.faces.extend(((a, b, b + sides), (a, b + sides, a + sides)))
                self.materials.extend((material_index, material_index))

    def leaf(self, stem, direction, length, width, curl, mat):
        direction = Vector(direction).normalized()
        side = Vector((-direction.z, 0, direction.x)).normalized()
        p = Vector(stem)
        # A softly cupped blade with a continuous surface and a drooping tip.
        stations = ((0, .10), (.16, .60), (.35, .93), (.54, 1.0),
                    (.76, .70), (.91, .31), (1, .012))
        across_values = (1, .22, 0, -.22, -1)
        columns = len(across_values)
        start = len(self.vertices)
        for surface in range(2):
            for t, width_scale in stations:
                hook = max(0, (t - .65) / .35) ** 2
                spine = (p + direction * (length * t) +
                         Vector((0, curl * t * t + length * .07 * hook,
                                 length * (.08 * math.sin(math.pi * t) - .18 * hook))))
                bow = math.sin(math.pi * t)
                for across in across_values:
                    depth = (-.009 + .017 * across * across) * bow
                    if surface:
                        depth += .008
                    point = spine + side * (width * width_scale * across)
                    point += Vector((0, depth, 0))
                    self.vertices.append(tuple(point))
        rows = len(stations)
        for i in range(rows - 1):
            for j in range(columns - 1):
                a = start + i * columns + j
                b = start + (i + 1) * columns + j
                c = b + 1
                d = a + 1
                self.faces.extend(((a, b, c), (a, c, d)))
                self.materials.extend((mat, mat))
                back = start + rows * columns
                self.faces.extend(((back + c - start, back + b - start, back + a - start),
                                   (back + d - start, back + c - start, back + a - start)))
                self.materials.extend((mat, mat))
        rim = ([start + i * columns for i in range(rows)] +
               [start + (rows - 1) * columns + j for j in range(1, columns)] +
               [start + i * columns + columns - 1 for i in range(rows - 2, -1, -1)] +
               [start + j for j in range(columns - 2, 0, -1)])
        back = start + rows * columns
        for a, b in zip(rim, rim[1:] + rim[:1]):
            self.faces.append((a, b, back + b - start, back + a - start))
            self.materials.append(mat)


def mesh_object(name, geo, materials, collection):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(geo.vertices, [], geo.faces)
    mesh.update()
    for mat in materials:
        mesh.materials.append(mat)
    for polygon, index in zip(mesh.polygons, geo.materials):
        polygon.material_index = index
        polygon.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def build(variant="curtain", lod=0, seed=None):
    if variant not in VARIANTS or lod not in LODS:
        raise ValueError("Unknown variant or LOD")
    default_seed, strands, width, length, sway, leaf_density, loops = VARIANTS[variant]
    sides, steps, leaf_stride, tendrils = LODS[lod]
    rng = random.Random(default_seed if seed is None else seed)
    collection = bpy.data.collections.new(f"Vines_{variant}_LOD{lod}")
    bpy.context.scene.collection.children.link(collection)
    stems, leaves = Geometry(), Geometry()

    for strand in range(strands):
        x = (strand / max(1, strands - 1) - .5) * width + rng.uniform(-.12, .12)
        strand_length = length * rng.uniform(.67, 1.12)
        drift, bow, phase = rng.uniform(-.16, .16), rng.uniform(.3, .9) * sway, rng.uniform(0, math.tau)
        points = []
        for i in range(steps + 1):
            t = i / steps
            points.append(Vector((x + drift * t + bow * math.sin(t * math.pi * 1.7 + phase) * math.sin(math.pi * t / 2),
                                  .12 * math.sin(t * math.tau + phase) + .13 * t * math.cos(t * math.tau + phase),
                                  -strand_length * t)))
        # Three stems still interlace, but their pitch, separation, and girth
        # drift smoothly instead of repeating as a perfect rope helix.
        base_radius = rng.uniform(.025, .035)
        braid_phase = rng.uniform(0, math.tau)
        turns = strand_length * rng.uniform(2.0, 2.5)
        warp_phase_1 = rng.uniform(0, math.tau)
        warp_phase_2 = rng.uniform(0, math.tau)
        thread_phases = [(rng.uniform(0, math.tau), rng.uniform(0, math.tau),
                          rng.uniform(0, math.tau)) for _ in range(3)]
        for thread in range(3):
            braided = []
            radii = []
            phase_a, phase_b, phase_c = thread_phases[thread]
            for i, point in enumerate(points):
                t = i / steps
                tangent = (points[min(i + 1, steps)] - points[max(i - 1, 0)]).normalized()
                u = tangent.cross(Vector((0, 1, 0))).normalized()
                v = tangent.cross(u).normalized()
                pitch_drift = (.30 * math.sin(math.tau * 1.15 * t + warp_phase_1) +
                               .12 * math.sin(math.tau * 2.45 * t + warp_phase_2))
                thread_drift = .045 * math.sin(math.tau * 1.7 * t + phase_a)
                angle = braid_phase + math.tau * (turns * t + thread / 3 +
                                                  pitch_drift + thread_drift)
                taper = max(.27, (1 - t) ** .55)
                spread = (.86 + .18 * math.sin(math.tau * 1.3 * t + phase_b) +
                          .08 * math.sin(math.tau * 3.2 * t + phase_c))
                thickness = (1 + .13 * math.sin(math.tau * 1.55 * t + phase_c) +
                             .06 * math.sin(math.tau * 3.0 * t + phase_a))
                braided.append(point + (u * math.cos(angle) + v * math.sin(angle)) *
                               base_radius * spread * taper)
                radii.append(base_radius * .72 * thickness * taper)
            stems.tube(braided, radii, sides, thread)
        # Half the previous five-to-seven leaves per strand.
        count = max(2, round(strand_length * 1.05 * leaf_density))
        for number in range(count):
            if number % leaf_stride:
                continue
            t = (number + 1 + rng.uniform(-.15, .15)) / (count + 1)
            index = max(1, min(steps - 2, round(t * steps)))
            p = points[index]
            side = -1 if number % 2 else 1
            direction = Vector((side * rng.uniform(.34, .58), rng.uniform(-.06, .06),
                                -rng.uniform(.76, .98))).normalized()
            petiole = p + Vector((side * rng.uniform(.04, .07), 0, -.025))
            stems.tube((p, petiole), (.005, .003), max(3, sides // 2))
            blade = rng.uniform(.125, .176) * (1.12 if lod == 2 else 1)
            leaves.leaf(petiole, direction, blade, blade * rng.uniform(.26, .34),
                        rng.uniform(-.022, .022), rng.randrange(3))
        if tendrils:
            for _ in range(max(1, round(2 * loops))):
                index = rng.randrange(max(2, steps // 4), steps - 2)
                origin, direction = points[index], rng.choice((-1, 1))
                size = rng.uniform(.09, .19) * (1.5 if variant == "tangle" else 1)
                curl = []
                for j in range(13):
                    t = j / 12
                    a = t * math.pi * 2.7
                    curl.append(origin + Vector((direction * size * (t + .36 * math.cos(a) - .36),
                                                 .10 * math.sin(a) * t,
                                                 -.18 * t + size * .32 * math.sin(a))))
                stems.tube(curl, [.007 * (1 - .75 * j / 12) for j in range(13)], 4)

    stem_mats = [material("Vine stem deep", (.045, .085, .028)),
                 material("Vine stem dark", (.058, .105, .033)),
                 material("Vine stem highlight", (.075, .125, .039))]
    mesh_object("vine_stems", stems, stem_mats, collection)
    leaf_mats = [material("Vine leaf deep", (.075, .22, .055), True),
                 material("Vine leaf green", (.15, .36, .07), True),
                 material("Vine leaf light", (.28, .46, .11), True)]
    mesh_object("vine_leaves", leaves, leaf_mats, collection)
    return collection


def export(outdir, variants, seed=None):
    outdir = Path(outdir).resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    results = []
    for variant in variants:
        for lod in LODS:
            collection = build(variant, lod, seed)
            bpy.ops.object.select_all(action="DESELECT")
            for obj in collection.objects:
                obj.select_set(True)
            bpy.context.view_layer.objects.active = collection.objects[0]
            path = outdir / f"vine_{variant}_LOD{lod}.glb"
            bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=True)
            results.append(path)
            for obj in list(collection.objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.collections.remove(collection)
    return results


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--variant", choices=[*VARIANTS, "all"], default="all")
    parser.add_argument("--seed", type=int)
    options = parser.parse_args(args)
    variants = list(VARIANTS) if options.variant == "all" else [options.variant]
    if options.out:
        for path in export(options.out, variants, options.seed):
            print(path)
    else:
        for variant in variants:
            build(variant, 0, options.seed)


if __name__ == "__main__":
    main()
