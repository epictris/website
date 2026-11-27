"""Build three 1.3 m intact rail spans, each with one original kit sleeper.

blender -b -noaudio --factory-startup --python-exit-code 1 --python rope/tools/blender/mineshaft/build_single_sleeper.py
"""
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[3]
MODELS = ROOT / 'assets-src/models'
PREVIEW = ROOT / 'assets-src/studies/mineshaft'

for variant in ('a', 'b', 'c'):
    name = f'mine-rail-single-sleeper-{variant}'
    bpy.ops.wm.open_mainfile(filepath=str(MODELS / 'mine-rail-segment-bare.blend'))
    scene = bpy.context.scene
    kit = bpy.data.collections['mine-rail-segment-bare']
    kit.name = name
    kit.asset_data.description = f'1.3 m intact rail span with one complete oak sleeper and original chairs, clips and nails. Variant {variant.upper()}. Metres, Z up, -Y front.'
    kit['sleeper_spacing_m'] = 1.3
    kit['snap_length_m'] = 1.3
    kit['end_translation_m'] = [1.3, 0.0, 0.0]
    for rail in kit.objects:
        if rail.name.startswith('Rail •'):
            for vertex in rail.data.vertices:
                vertex.co.x *= .5
            rail.data.update()
        elif rail.name.startswith('socket.end'):
            rail.location.x = 1.3
    with bpy.data.libraries.load(str(MODELS / f'mine-sleeper-{variant}.blend'), link=False) as (src, dst):
        dst.objects = [n for n in src.objects if 'wood and fasteners' in n]
    assert len(dst.objects) == 1
    sleeper = dst.objects[0]
    kit.objects.link(sleeper)
    sleeper.location.x = .65
    assert len([o for o in kit.objects if o.type == 'MESH']) == 3
    bpy.ops.wm.save_as_mainfile(filepath=str(MODELS / f'{name}.blend'), compress=True)

    # Presentation added after saving: never exported as model geometry.
    world = bpy.data.worlds.new('Review slate world')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (.12, .15, .23, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = .65
    scene.world = world
    target = Vector((.65, 0, .12))
    for loc, power, size in [((1, -3, 5), 650, 4), ((0, 3, 3), 450, 3)]:
        bpy.ops.object.light_add(type='AREA', location=loc)
        light = bpy.context.object
        light.data.energy, light.data.shape, light.data.size = power, 'DISK', size
        light.rotation_euler = (target-light.location).to_track_quat('-Z', 'Y').to_euler()
    bpy.ops.object.camera_add(location=(1.95, -3.8, 3.3))
    scene.camera = bpy.context.object
    scene.camera.rotation_euler = (target-scene.camera.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera.data.type = 'ORTHO'
    scene.camera.data.ortho_scale = 2.8
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 40
    scene.render.resolution_x, scene.render.resolution_y = 1400, 1000
    scene.render.resolution_percentage = 100
    scene.render.filepath = str(PREVIEW / f'{name}-overview.png')
    bpy.ops.render.render(write_still=True)
    print('BUILT', name, flush=True)
