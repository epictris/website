"""blender -b --factory-startup --python-exit-code 1 --python tools/blender/test_bake_image_names.py"""
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(__file__))
from scene_export import bake_image

# A split-map worker first creates a stand-in for a later map, then comes
# back to bake that map. Both colour and normal names must remain canonical.
for kind, space in (("colour", "sRGB"), ("normal", "Non-Color")):
    name = f"test-rock map 2 baked {kind}"
    stand_in = bake_image(name, 1, space)
    mat = bpy.data.materials.new("test split-map references")
    mat.use_nodes = True
    node = mat.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = stand_in
    real = bake_image(name, 16, space)
    assert real.name == name, real.name
    assert tuple(real.size) == (16, 16)
    assert node.image == stand_in, "Renaming must preserve previous shader references"
    assert stand_in.name != name
    repeated = bake_image(name, 16, space)
    assert repeated.name == name, repeated.name
    for image in (stand_in, real, repeated):
        bpy.data.images.remove(image)
    bpy.data.materials.remove(mat)
print("PASS: repeated split-map tasks keep canonical image names and prior references")
