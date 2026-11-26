"""Standalone river lighting, refresh/reload/restore, and linked-guide fallback.

Run in factory background Blender. Reads ball.json; never changes the level.
"""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

import addon_utils
import bpy

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
bpy.ops.wm.read_factory_settings(use_empty=True)
addon_utils.enable('formations', default_set=True)
addon_utils.enable('game', default_set=True)
from game import camera, emission_preview, look, model_preview, ui

scene = bpy.context.scene
world = bpy.data.worlds.new('Authored world')
scene.world = world
scene.render.engine = 'BLENDER_EEVEE'
scene.view_settings.view_transform = 'Standard'
scene.view_settings.exposure = -.3
scene.view_settings.gamma = 1.1
scene.cycles.preview_samples = 17
scene.cycles.sample_clamp_indirect = 2
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_depth = '16'
bpy.ops.mesh.primitive_cube_add()
rock = bpy.context.object
rock.name = 'Test rock'
mat = bpy.data.materials.new('Authored material')
rock.data.materials.append(mat)
mat.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = .2
lamp = bpy.data.objects.new('Authored lamp', bpy.data.lights.new('Authored lamp', 'POINT'))
scene.collection.objects.link(lamp)
hidden = bpy.data.objects.new('Hidden lamp', bpy.data.lights.new('Hidden lamp', 'POINT'))
scene.collection.objects.link(hidden)
hidden.hide_viewport = hidden.hide_render = True
original_vertices = [v.co[:] for v in rock.data.vertices]
def links(material):
    return sorted((l.from_node.name, l.from_socket.identifier, l.to_node.name, l.to_socket.identifier)
                  for l in material.node_tree.links)
original_links = links(mat)
original_view = (scene.view_settings.view_transform, scene.view_settings.look,
                 scene.view_settings.exposure, scene.view_settings.gamma)
original_shading = [(s, i, {k: getattr(sh, k) for k in look.SHADING_FIELDS}) for s, i, sh in look.viewports(scene)]
assert camera.game_camera(scene) is None and scene.camera is None
class Panel:
    def __init__(self): self.buttons = []
    def box(self): return self
    def label(self, **kwargs): pass
    def operator(self, name, **kwargs): self.buttons.append(name)
panel = Panel()
ui.GAME_PT_main.draw(SimpleNamespace(layout=panel), bpy.context)
assert 'game.preview_river_lighting' in panel.buttons and 'game.look' not in panel.buttons
job = model_preview.read_river()
assert bpy.ops.game.preview_river_lighting() == {'FINISHED'}
assert not scene.get(look.ERROR), scene.get(look.ERROR)
assert scene.camera is None and scene.render.engine == 'CYCLES'
assert scene.render.image_settings.file_format == 'PNG' and scene.render.image_settings.color_depth == '16'
assert lamp.hide_render and lamp.hide_viewport and hidden.hide_render and hidden.hide_viewport
assert rock.select_get() and bpy.context.view_layer.objects.active == rock
assert [v.co[:] for v in rock.data.vertices] == original_vertices
source, rig = model_preview.lighting(scene)
assert all(ob.type == 'LIGHT' and ob.data.type == 'SUN' for ob in rig.objects)
if job['sun']:
    sun = next(iter(rig.objects))
    assert abs(sun.data.energy - job['sun']['intensity']) < 1e-6
assert abs(source['game_tone_exposure'] - scene.view_settings.exposure) < 1e-6
assert all(n.image.packed_file for n in source.node_tree.nodes if n.type == 'TEX_IMAGE')
assert look.SAVED_LIGHTING in scene
lamp.name = 'Renamed while previewing'
assert bpy.ops.game.restore_scene_lighting() == {'FINISHED'}
assert not lamp.hide_viewport and not lamp.hide_render
lamp.name = 'Authored lamp'
model_preview.activate(bpy.context, job)
counts = (len(bpy.data.worlds), len(bpy.data.lights), len(bpy.data.images), len(mat.node_tree.nodes))
model_preview.activate(bpy.context, job)
assert counts == (len(bpy.data.worlds), len(bpy.data.lights), len(bpy.data.images), len(mat.node_tree.nodes)), counts

def restored():
    scene = bpy.context.scene
    assert scene.world.name == 'Authored world'
    assert scene.render.engine == 'BLENDER_EEVEE'
    assert scene.cycles.preview_samples == 17 and scene.cycles.sample_clamp_indirect == 2
    assert (scene.view_settings.view_transform, scene.view_settings.look,
            scene.view_settings.exposure, scene.view_settings.gamma) == original_view
    assert not bpy.data.objects['Authored lamp'].hide_render and not bpy.data.objects['Authored lamp'].hide_viewport
    assert bpy.data.objects['Hidden lamp'].hide_render and bpy.data.objects['Hidden lamp'].hide_viewport
    assert links(bpy.data.materials['Authored material']) == original_links
    assert [(s, i, {k: getattr(sh, k) for k in look.SHADING_FIELDS}) for s, i, sh in look.viewports(scene)] == original_shading
    assert look.SAVED_LIGHTING not in scene

with tempfile.TemporaryDirectory() as directory:
    file = Path(directory) / 'standalone.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(file))
    # Reload must use the packed snapshot, not invoke Bun or need a guide.
    read = model_preview.read_river
    def unavailable():
        raise ValueError('Test: runtime unavailable')
    model_preview.read_river = unavailable
    try:
        bpy.ops.wm.open_mainfile(filepath=str(file))
        scene = bpy.context.scene
        assert scene.game_lighting and scene.camera is None
        assert not scene.get(look.ERROR), scene.get(look.ERROR)
        assert bpy.ops.game.restore_scene_lighting() == {'FINISHED'}
        restored()
        # A failed refresh leaves the restored scene untouched.
        try:
            model_preview.activate(bpy.context)
        except ValueError:
            pass
        else:
            raise AssertionError('Missing runtime should be reported')
        restored()
    finally:
        model_preview.read_river = read

    # Exercise the existing linked-guide lighting path with a tiny library.
    builder = emission_preview.module('game_lighting')
    guide_world, guide_lights = builder.build_lighting(job)
    cam = bpy.data.objects.new('guide.camera', bpy.data.cameras.new('guide.camera'))
    cam['game_fps'], cam['game_frames'] = 60, 1
    library = Path(directory) / 'guide.blend'
    bpy.data.libraries.write(str(library), {cam, guide_world, guide_lights})
    bpy.data.objects.remove(cam)
    scene.collection.children.unlink(guide_lights)
    model_preview.discard(guide_world, guide_lights)
    with bpy.data.libraries.load(str(library), link=True) as (_, loaded):
        loaded.objects = ['guide.camera']
    scene.collection.objects.link(loaded.objects[0])
    scene.game_lighting = True
    assert not scene.get(look.ERROR), scene.get(look.ERROR)
    assert scene.get(look.ACTIVE_LIGHTS).library is not None
    # Switching from a guide to River must not leave the guide's sun enabled.
    guide_rig = scene[look.ACTIVE_LIGHTS]
    model_preview.activate(bpy.context, job)
    assert guide_rig.name not in scene.collection.children
    assert bpy.ops.game.restore_scene_lighting() == {'FINISHED'}
    restored()
    scene.game_lighting = True
    assert scene.get(look.ACTIVE_LIGHTS).library is not None
    scene.game_lighting = False
    restored()

# A new empty scene may have no world, no camera and an environment with no
# sun. Restoring must retain the absence of a world, rather than invent one.
for ob in list(scene.objects):
    if ob.type == 'CAMERA':
        bpy.data.objects.remove(ob, do_unlink=True)
assert camera.game_camera(scene) is None
scene.world = None
model_preview.activate(bpy.context, dict(job, sun=None))
assert len(scene[model_preview.LIGHTS].objects) == 0
assert bpy.ops.game.restore_scene_lighting() == {'FINISHED'}
assert scene.world is None

print('MODEL_LIGHTING_PREVIEW_OK: current river settings, no camera, refresh, packed reload, exact restoration and guide fallback', flush=True)
