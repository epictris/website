"""Seeded, stylised jungle vines v3 for Blender 5.x.

In Blender: run this script to add editable vines. To export three variants at
three detail levels:
  blender --background --factory-startup --python procedural_vines_v3.py -- --out vine_output_v3
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


def material(name, color, double_sided=False, roughness=.85):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
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

    def tube(self, points, radii, sides=6, material_index=0,
             shade=False, shade_phase=0.0, cap_ends=False):
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
                face_material = material_index
                if shade:
                    tone = (math.cos(math.tau * (j + .5) / sides + shade_phase) +
                            .20 * math.sin(i * .32 + shade_phase))
                    if tone > .84:
                        face_material += 3
                    elif tone < -.84:
                        face_material += 6
                self.materials.extend((face_material, face_material))
        if cap_ends:
            top_center = len(self.vertices)
            self.vertices.append(tuple(points[0]))
            bottom_center = len(self.vertices)
            self.vertices.append(tuple(points[-1]))
            last_ring = base + (len(points) - 1) * sides
            for j in range(sides):
                next_j = (j + 1) % sides
                self.faces.append((top_center, base + next_j, base + j))
                self.faces.append((bottom_center, last_ring + j,
                                   last_ring + next_j))
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
                    asymmetry = 1 + (.10 if curl >= 0 else -.10) * across
                    point = spine + side * (width * width_scale * across * asymmetry)
                    point += Vector((0, depth + curl * across * t * .35, 0))
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


def smooth_profile(values, t):
    """Smooth seeded variation with no repeating wave pattern."""
    x = max(0.0, min(1.0, t)) * (len(values) - 1)
    i = min(int(x), len(values) - 2)
    u = x - i
    p0 = values[max(0, i - 1)]
    p1 = values[i]
    p2 = values[i + 1]
    p3 = values[min(len(values) - 1, i + 2)]
    return .5 * ((2 * p1) + (-p0 + p2) * u +
                 (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u +
                 (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u)


def leaf_positions(rng, count):
    """Uneven attachment positions with one intentional open stretch."""
    gap_center = rng.uniform(.40, .65)
    gap_half = rng.uniform(.10, .16)
    ranges = ((.12, gap_center - gap_half),
              (gap_center + gap_half, .88))
    positions = []
    for n in range(count):
        for _ in range(32):
            lo, hi = ranges[(n + rng.randrange(2)) % 2]
            t = rng.uniform(lo, hi)
            if all(abs(t - existing) > .07 for existing in positions):
                positions.append(t)
                break
        else:
            positions.append(rng.uniform(.12, .88))
    return sorted(positions)


def build(variant="curtain", lod=0, seed=None):
    if variant not in VARIANTS or lod not in LODS:
        raise ValueError("Unknown variant or LOD")
    default_seed, strands, width, length, sway, leaf_density, loops = VARIANTS[variant]
    sides, steps, leaf_stride, tendrils = LODS[lod]
    rng = random.Random(default_seed if seed is None else seed)
    collection = bpy.data.collections.new(f"VinesV3_{variant}_LOD{lod}")
    bpy.context.scene.collection.children.link(collection)
    stems, leaves = Geometry(), Geometry()

    for strand in range(strands):
        secondary = strand % 3 == 1
        x = (strand / max(1, strands - 1) - .5) * width + rng.uniform(-.20, .20)
        strand_length = length * (rng.uniform(.58, .89) if secondary else
                                  rng.uniform(.88, 1.25))
        turns = strand_length * rng.uniform(1.45, 2.6)
        samples_per_turn = (7, 5, 4)[lod]
        segments = max(steps, math.ceil(turns * samples_per_turn))
        drift, bow, phase = rng.uniform(-.16, .16), rng.uniform(.3, .9) * sway, rng.uniform(0, math.tau)
        points = []
        for i in range(segments + 1):
            t = i / segments
            points.append(Vector((x + drift * t + bow * math.sin(t * math.pi * 1.7 + phase) * math.sin(math.pi * t / 2),
                                  .12 * math.sin(t * math.tau + phase) + .13 * t * math.cos(t * math.tau + phase),
                                  -strand_length * t)))
        # The same three stems stay braided throughout. Seeded smooth profiles
        # change pitch, separation, and girth without extra split geometry.
        base_radius = (rng.uniform(.018, .025) if secondary else
                       rng.uniform(.031, .044))
        braid_phase = rng.uniform(0, math.tau)
        pitch_profile = [0.0] + [rng.uniform(-.18, .18) for _ in range(5)] + [0.0]
        thread_profiles = [
            dict(phase=[rng.uniform(-.045, .045) for _ in range(6)],
                 spread=[rng.uniform(.62, 1.22) for _ in range(8)],
                 girth=[rng.uniform(.80, 1.20) for _ in range(8)],
                 shade=rng.uniform(0, math.tau))
            for _ in range(3)
        ]
        for thread in range(3):
            braided = []
            radii = []
            profiles = thread_profiles[thread]
            for i, point in enumerate(points):
                t = i / segments
                tangent = (points[min(i + 1, segments)] - points[max(i - 1, 0)]).normalized()
                u = tangent.cross(Vector((0, 1, 0))).normalized()
                v = tangent.cross(u).normalized()
                angle = braid_phase + math.tau * (turns * t + thread / 3 +
                                                  smooth_profile(pitch_profile, t) +
                                                  smooth_profile(profiles["phase"], t))
                entry = min(1.0, t / .12)
                entry = entry * entry * (3 - 2 * entry)
                exit_t = max(0.0, min(1.0, (t - .74) / .26))
                exit_t = exit_t * exit_t * (3 - 2 * exit_t)
                taper = (.68 + .32 * entry) * (1 - .70 * exit_t)
                spread = max(.55, smooth_profile(profiles["spread"], t))
                thickness = max(.72, smooth_profile(profiles["girth"], t))
                braided.append(point + (u * math.cos(angle) + v * math.sin(angle)) *
                               base_radius * spread * taper)
                radii.append(base_radius * .72 * thickness * taper)
            stems.tube(braided, radii, sides, thread, shade=True,
                       shade_phase=profiles["shade"], cap_ends=True)

        count = max(1, round(strand_length * 1.05 * leaf_density *
                             (.72 if secondary else 1)))
        for number, t in enumerate(leaf_positions(rng, count)):
            if number % leaf_stride:
                continue
            index = max(1, min(segments - 2, round(t * segments)))
            p = points[index]
            side = -1 if number % 2 else 1
            direction = Vector((side * rng.uniform(.34, .58), rng.uniform(-.06, .06),
                                -rng.uniform(.76, .98))).normalized()
            petiole = p + Vector((side * rng.uniform(.04, .07), 0, -.025))
            stems.tube((p, petiole), (.005, .003), max(3, sides // 2))
            blade = rng.uniform(.108, .19) * (1.12 if lod == 2 else 1)
            leaves.leaf(petiole, direction, blade, blade * rng.uniform(.25, .35),
                        rng.uniform(-.028, .028), rng.randrange(3))
        if tendrils:
            for _ in range(max(1, round(2 * loops))):
                index = rng.randrange(max(2, segments // 4), segments - 2)
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

    stem_mats = [
        material("V3 stem deep", (.045, .085, .028), roughness=.89),
        material("V3 stem dark", (.058, .105, .033), roughness=.86),
        material("V3 stem olive", (.075, .125, .039), roughness=.84),
        material("V3 stem deep light", (.055, .102, .034), roughness=.76),
        material("V3 stem dark light", (.071, .126, .040), roughness=.75),
        material("V3 stem olive light", (.088, .145, .047), roughness=.74),
        material("V3 stem deep recess", (.037, .070, .023), roughness=.95),
        material("V3 stem dark recess", (.048, .088, .028), roughness=.94),
        material("V3 stem olive recess", (.061, .104, .032), roughness=.92),
    ]
    mesh_object("vine_stems", stems, stem_mats, collection)
    leaf_mats = [material("V3 leaf deep", (.075, .22, .055), True),
                 material("V3 leaf green", (.15, .36, .07), True),
                 material("V3 leaf light", (.28, .46, .11), True)]
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
