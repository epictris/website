"""Blender --background --factory-startup --python this_file."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import bpy
import numpy as np
from emission_strength import enable, clear, MARKER, GAIN
from emission_bake import target

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.device = 'CPU'
scene.world = bpy.data.worlds.new('dark')
scene.world.color = (0, 0, 0)
scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value = 0
bpy.ops.mesh.primitive_plane_add(size=2)
receiver = bpy.context.object
mat = bpy.data.materials.new('receiver')
receiver.data.materials.append(mat)
image = bpy.data.images.new('test receiver', 32, 32, float_buffer=True)
target(mat, image, receiver.data.uv_layers.active.name)
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 1), rotation=(3.14159265, 0, 0))
emitter = bpy.context.object
emission = bpy.data.materials.new('emitter')
emitter.data.materials.append(emission)
nt = emission.node_tree
bsdf = nt.nodes.get('Principled BSDF')
bsdf.inputs['Emission Color'].default_value = (.3, 1, .1, 1)
bsdf.inputs['Emission Strength'].default_value = .22

def irradiance():
    bpy.ops.object.select_all(action='DESELECT')
    receiver.select_set(True)
    bpy.context.view_layer.objects.active = receiver
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=0)
    pixels = np.empty(32 * 32 * 4, np.float32)
    image.pixels.foreach_get(pixels)
    return pixels.reshape(-1, 4)[:, :3].mean()

before = irradiance()
enable(scene)
first_count = len(nt.nodes)
enable(scene)
assert len(nt.nodes) == first_count
scaled = irradiance()
assert before > 0 and abs(scaled / before - GAIN) < .5, (before, scaled)
# The factor is one for camera rays, GAIN for rays lighting the receiver.
factor = next(n for n in nt.nodes if n.get(MARKER) == 'factor')
assert factor.inputs[1].default_value + factor.inputs[2].default_value == 1
clear()
assert not bsdf.inputs['Emission Strength'].is_linked
assert abs(bsdf.inputs['Emission Strength'].default_value - .22) < 1e-6
assert abs(irradiance() / before - 1) < .01
# Authored procedural strengths retain the exact source socket after toggles.
value = nt.nodes.new('ShaderNodeValue')
value.outputs[0].default_value = .22
nt.links.new(value.outputs[0], bsdf.inputs['Emission Strength'])
enable(scene)
clear()
assert bsdf.inputs['Emission Strength'].links[0].from_socket == value.outputs[0]
assert not any(n.get(MARKER) for n in nt.nodes)
print('EMISSION_PREVIEW_OK actual indirect illumination x50; camera gain one; toggles and authored links restored')
