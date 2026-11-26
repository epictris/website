"""The material layer test's library (scripts/test-formations.ts): one
material, `Const`, every channel a known constant, so its bake must come back
as exactly those values on every texel.

    blender -b --factory-startup --python-exit-code 1 \
        --python tools/blender/material_layer_fixture.py -- OUT.blend
"""

import sys

import bpy

# Linear; 0.2140411 is sRGB 0.5.
BASE = (0.2140411, 0.2140411, 0.2140411, 1.0)
ROUGHNESS, METALLIC, HEIGHT = 0.4, 1.0, 0.75

m = bpy.data.materials.new("Const")
nt = m.node_tree
nt.nodes.clear()
bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
bsdf.inputs["Base Color"].default_value = BASE
bsdf.inputs["Roughness"].default_value = ROUGHNESS
bsdf.inputs["Metallic"].default_value = METALLIC
out = nt.nodes.new("ShaderNodeOutputMaterial")
nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
# The height through a socket, as an authored one is.
value = nt.nodes.new("ShaderNodeValue")
value.outputs[0].default_value = HEIGHT
aov = nt.nodes.new("ShaderNodeOutputAOV")
aov.aov_name = "height"
nt.links.new(value.outputs[0], aov.inputs["Value"])
m.use_fake_user = True
bpy.ops.wm.save_as_mainfile(filepath=sys.argv[sys.argv.index("--") + 1])
