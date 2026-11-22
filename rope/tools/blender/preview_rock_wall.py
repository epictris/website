"""Repeatable front, detail and oblique renders of the rock-wall study.

blender -b --factory-startup assets-src/scenes/rock-wall.blend -t 8 \
  --python tools/blender/preview_rock_wall.py -- --output /tmp/wall

Only --save writes a .blend; otherwise the lighting/cameras are temporary.
"""
import argparse
from pathlib import Path
import sys

import bpy
from mathutils import Vector


def aim(ob, target):
    ob.rotation_euler = (Vector(target) - ob.location).to_track_quat('-Z', 'Y').to_euler()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--save', type=Path)
    parser.add_argument('--samples', type=int, default=48)
    parser.add_argument('--exposure', type=float, default=-.7)
    parser.add_argument('--river-lighting', action='store_true',
                        help='Use the ball level sun, sky, ambient fill and tone mapping')
    parser.add_argument('--views', nargs='+', choices=['front', 'detail', 'oblique'],
                        default=['front', 'detail', 'oblique'])
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    args.output.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    if getattr(scene, 'game_lighting', False):
        scene.game_lighting = False
    rock = next(o for o in scene.objects if 'formation_recipe' in o and not o.get('formation_backup'))
    guide = bpy.data.objects[rock['formation_outline']]
    bpy.context.view_layer.update()
    corners = [guide.matrix_world @ Vector(p) for p in guide.bound_box]
    centre = sum(corners, Vector()) / 8
    width = max(p.x for p in corners) - min(p.x for p in corners)
    unit = width / 54.
    rock_corners = [rock.matrix_world @ Vector(p) for p in rock.bound_box]
    rock_width = max(p.x for p in rock_corners) - min(p.x for p in rock_corners)
    rock_height = max(p.z for p in rock_corners) - min(p.z for p in rock_corners)
    full_scale = max(66*unit, rock_width*1.1, rock_height*(1400/800)*1.1)

    old = bpy.data.collections.get('Rock wall study rig')
    if old:
        for ob in list(old.objects):
            data = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if data is not None and data.users == 0:
                bpy.data.batch_remove(ids=[data])
        bpy.data.collections.remove(old)
    rig = bpy.data.collections.new('Rock wall study rig')
    scene.collection.children.link(rig)
    for ob in scene.objects:
        if ob.type == 'LIGHT':
            ob.hide_render = True
    for name, pos, energy, size, color in [
        ('Key', (-22, -28, 34), 65000, 18, (1., .91, .82)),
        ('Fill', (25, -20, 4), 18000, 22, (.66, .78, 1.)),
    ]:
        data = bpy.data.lights.new('Wall ' + name, 'AREA')
        data.energy, data.shape, data.size, data.color = energy*unit**2, 'DISK', size*unit, color
        ob = bpy.data.objects.new('Wall ' + name, data)
        rig.objects.link(ob)
        ob.location = centre + Vector(pos)*unit
        aim(ob, centre)
    cameras = {}
    for name, pos, target, scale in [
        ('front', (0, -65, 2), (0, 0, 0), 66),
        ('detail', (-2, -50, 1), (-2, 0, 1), 18),
        ('oblique', (30, -60, 15), (0, 0, 0), 66),
    ]:
        data = bpy.data.cameras.new('Wall ' + name)
        data.type, data.ortho_scale = 'ORTHO', scale*unit
        if name != 'detail':
            data.ortho_scale = full_scale
        ob = bpy.data.objects.new('Wall ' + name, data)
        rig.objects.link(ob)
        ob.location = centre + Vector(pos)*unit
        aim(ob, centre + Vector(target)*unit)
        cameras[name] = ob
    scene.world = bpy.data.worlds.new('Rock wall studio')
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get('Background')
    background.inputs[0].default_value = (.16, .19, .25, 1)
    background.inputs[1].default_value = .45
    scene.render.engine = 'CYCLES'
    scene.cycles.samples, scene.cycles.use_denoising = args.samples, True
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform, scene.view_settings.exposure = 'AgX', args.exposure
    if args.river_lighting:
        import addon_utils
        sys.path.insert(0, str(Path(__file__).parent))
        addon_utils.enable('formations', default_set=True)
        addon_utils.enable('game', default_set=True)
        from game import model_preview
        model_preview.activate(bpy.context)
        scene.cycles.samples = args.samples
    scene.render.image_settings.file_format = 'PNG'
    scene.camera = cameras['front']
    scene.render.resolution_x, scene.render.resolution_y = 1400, 800
    scene.render.filepath = str(args.output / 'front.png')
    if args.save:
        for ob in bpy.context.selected_objects:
            ob.select_set(False)
        rock.hide_set(False)
        rock.select_set(True)
        bpy.context.view_layer.objects.active = rock
        for screen in bpy.data.screens:
            for area in screen.areas:
                if area.type == 'VIEW_3D':
                    space = area.spaces.active
                    space.region_3d.view_perspective = 'CAMERA'
                    space.overlay.show_overlays = False
                    space.shading.type = 'RENDERED' if args.river_lighting else 'MATERIAL'
                    space.shading.use_scene_world = args.river_lighting
                    space.shading.use_scene_lights = args.river_lighting
        bpy.ops.wm.save_as_mainfile(filepath=str(args.save.resolve()))
    for view in args.views:
        scene.camera = cameras[view]
        scene.render.resolution_x, scene.render.resolution_y = (1200, 900) if view == 'detail' else (1400, 800)
        scene.render.filepath = str(args.output / (view + '.png'))
        bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    main()
