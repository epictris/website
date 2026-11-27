"""Build left/right quarter-circle tracks using the mineshaft kit's surfaces.

blender -b -noaudio --factory-startup --python-exit-code 1 --python rope/tools/blender/mineshaft/build_quarter_rails.py

The 2.5 m centre radius is 1.5 m at the track prefabs' 0.6 scale, matching
the cart's default exit radius. +X is entry travel; left bends toward +Y.
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from edge_weathering import bake_object
from rail_profile import HALF_GAUGE, rail_geometry

ROOT = Path(__file__).resolve().parents[3]
MODELS = ROOT / 'assets-src/models'
PREVIEW = ROOT / 'assets-src/studies/mineshaft'
RADIUS = 2.5
ANGLE = math.pi / 2
LENGTH = RADIUS * ANGLE
SPACING = 1.3


def build(hand, sign):
    name = f'mine-rail-curve-90-{hand}'
    bpy.ops.wm.open_mainfile(filepath=str(MODELS / 'mine-rail-segment-bare.blend'))
    scene = bpy.context.scene
    kit = bpy.data.collections['mine-rail-segment-bare']
    kit.name = name
    kit.asset_data.description = (
        f'90 degree {hand} minecart track; 2.5 m centre radius, 1.14 m gauge, '
        'three oak sleepers with chairs, clips and nails. Entry at origin along +X; '
        f'exit at (2.5, {sign * RADIUS:g}, 0), heading {sign * 90} degrees. '
        'Metres, Z up, -Y front. At scale 0.6 the radius is 1.5 m.')

    def center(t):
        a = t * ANGLE
        return Vector((RADIUS * math.sin(a), sign * RADIUS * (1 - math.cos(a)), 0))

    def tangent(t):
        a = t * ANGLE
        return Vector((math.cos(a), sign * math.sin(a), 0))

    materials = [bpy.data.materials[n] for n in (
        'Track • aged warm iron', 'Track • burnished olive steel', 'Track • worn lip')]
    for ob in list(kit.objects):
        if ob.type == 'MESH':
            bpy.data.objects.remove(ob, do_unlink=True)
    rails = []
    for side in (-1, 1):
        verts, faces = rail_geometry(center, tangent, side, 0, 1,
                                     steps=64, bite_waves=9 * LENGTH / 4)
        mesh = bpy.data.meshes.new(f'{name} • continuous I section')
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        ob = bpy.data.objects.new(f'Rail • {hand} • side {side:+d}', mesh)
        kit.objects.link(ob)
        for mat in materials:
            mesh.materials.append(mat)
        for face in mesh.polygons:
            face.material_index = 1 if face.normal.z > .6 else 0
        bevel = ob.modifiers.new('Worn rail lips', 'BEVEL')
        bevel.width, bevel.segments, bevel.material = .007, 1, 2
        rails.append(ob)
    bpy.context.view_layer.update()
    for ob in rails:
        bake_object(ob, 1024)

    count = math.floor(LENGTH / SPACING)
    margin = (LENGTH - (count - 1) * SPACING) / 2
    for i in range(count):
        variant = 'abc'[i % 3]
        with bpy.data.libraries.load(str(MODELS / f'mine-sleeper-{variant}.blend'), link=False) as (src, dst):
            dst.objects = [n for n in src.objects if 'wood and fasteners' in n]
        assert len(dst.objects) == 1
        sleeper = dst.objects[0]
        kit.objects.link(sleeper)
        t = (margin + i * SPACING) / LENGTH
        sleeper.location = center(t)
        sleeper.rotation_euler.z = sign * t * ANGLE
        sleeper.name = f'Sleeper {i + 1} • {variant} • wood and fasteners'

    for label, t in (('start', 0), ('end', 1)):
        socket = next(ob for ob in kit.objects if ob.name.startswith(f'socket.{label}'))
        socket.location = center(t)
        socket.rotation_euler.z = sign * t * ANGLE
    kit['snap_length_m'] = LENGTH
    kit['curve_radius_m'] = RADIUS
    kit['gauge_centres_m'] = HALF_GAUGE * 2
    kit['sleeper_spacing_m'] = SPACING
    kit['end_translation_m'] = list(center(1))
    kit['end_heading_degrees'] = sign * 90
    kit['turn'] = hand
    bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(MODELS / f'{name}.blend'), compress=True)
    print('BUILT', name, flush=True)

    # Presentation is added after saving, so no lights or ground enter the model.
    world = bpy.data.worlds.new('Review slate world')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (.12, .15, .23, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = .65
    scene.world = world
    target = Vector((1.3, sign * 1.2, .12))
    for offset, power, size in [((0, -3, 6), 1000, 5), ((-2, 4, 4), 700, 4)]:
        bpy.ops.object.light_add(type='AREA', location=target + Vector(offset))
        light = bpy.context.object
        light.data.energy, light.data.shape, light.data.size = power, 'DISK', size
        light.rotation_euler = (target - light.location).to_track_quat('-Z', 'Y').to_euler()
    bpy.ops.object.camera_add(location=target + Vector((0, -4.5, 7)))
    scene.camera = bpy.context.object
    scene.camera.rotation_euler = (target - scene.camera.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera.data.type = 'ORTHO'
    scene.camera.data.ortho_scale = 5.7
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 32
    scene.render.resolution_x, scene.render.resolution_y = 1200, 1000
    scene.render.resolution_percentage = 100
    scene.render.filepath = str(PREVIEW / f'{name}-overview.png')
    bpy.ops.render.render(write_still=True)


for hand, sign in (('left', 1), ('right', -1)):
    build(hand, sign)
