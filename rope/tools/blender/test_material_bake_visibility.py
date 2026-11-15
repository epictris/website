"""blender -b --factory-startup --python-exit-code 1 --python tools/blender/test_material_bake_visibility.py"""
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from scene_export import material_bake_visibility
from bake_cache import rendered, rendered_collections

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 16
bpy.ops.mesh.primitive_plane_add(size=2)
rock = bpy.context.object
mat = bpy.data.materials.new("rock AO")
mat.use_nodes = True
rock.data.materials.append(mat)
nt = mat.node_tree
ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
ao.inputs["Distance"].default_value = 1
emission = nt.nodes.new("ShaderNodeEmission")
nt.links.new(ao.outputs["Color"], emission.inputs["Color"])
nt.links.new(emission.outputs[0], nt.nodes.get("Material Output").inputs["Surface"])
image = bpy.data.images.new("AO test", 32, 32, float_buffer=True)
target = nt.nodes.new("ShaderNodeTexImage")
target.image = image
nt.nodes.active = target
bpy.ops.mesh.primitive_plane_add(size=4, location=(0, 0, .1))
shelter = bpy.context.object
shelter.name = "guide.shelter.0"
guide = bpy.data.collections.new("guide.lights")
scene.collection.children.link(guide)
for coll in list(shelter.users_collection):
    coll.objects.unlink(shelter)
guide.objects.link(shelter)
# Match the preview shelter: transparent except to shadow rays. Cycles AO
# still sees its geometry, which is why shader transparency was insufficient.
shadow = bpy.data.materials.new("guide.shelter-shadow")
shadow.use_nodes = True
shelter.data.materials.append(shadow)
nodes, links = shadow.node_tree.nodes, shadow.node_tree.links
path = nodes.new("ShaderNodeLightPath")
clear_shader = nodes.new("ShaderNodeBsdfTransparent")
opaque = nodes.new("ShaderNodeBsdfDiffuse")
mix = nodes.new("ShaderNodeMixShader")
links.new(path.outputs["Is Shadow Ray"], mix.inputs[0])
links.new(clear_shader.outputs[0], mix.inputs[1])
links.new(opaque.outputs[0], mix.inputs[2])
links.new(mix.outputs[0], nodes.get("Material Output").inputs["Surface"])

def bake():
    bpy.ops.object.select_all(action="DESELECT")
    rock.select_set(True)
    bpy.context.view_layer.objects.active = rock
    bpy.ops.object.bake(type="EMIT")
    return np.asarray(image.pixels[:]).reshape(32, 32, 4)[8:24, 8:24, :3].mean()

blocked = bake()
with material_bake_visibility([rock]):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    shown = rendered_collections(depsgraph.view_layer)
    assert not any(rendered(i, shown) for i in depsgraph.object_instances
                   if i.object.original == shelter), "Guide must also leave the cache's occluders"
    clear = bake()
assert not shelter.hide_render, "Restore preview visibility"
with material_bake_visibility([rock, shelter]):
    neighbour = bake()
assert blocked < .5 and clear > .95 and neighbour < .5, (blocked, clear, neighbour)
try:
    with material_bake_visibility([rock]):
        raise ValueError("test cleanup")
except ValueError:
    pass
assert not shelter.hide_render
print(f"PASS: guide AO {blocked:.3f} -> {clear:.3f}; real neighbour AO {neighbour:.3f}; visibility restored")
