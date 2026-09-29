"""B. shell texturing: N offset copies of the masked patch, each keeping the texels whose
noise value is above the shell's height. Needs a custom shader in the game."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C, bpy, numpy as np
SHELLS = int(os.environ.get("SHELLS", 12)); THICK = 0.10
C.clear(); sc = C.setup_scene(); rock = C.build_rock()
V, T, FN, A, VN = C.rock_arrays(rock)
Vs, Tr, W, HN, lift = C.cushion_patch(V, T, FN, VN, C.default_stamps(V), thick=0.0, smooth=3, lobes=True)
# material: alpha = noise(p) > shell height (in Col alpha... here the R of a second attribute)
mat = bpy.data.materials.new("mossShell"); mat.use_nodes = True; nt = mat.node_tree; bsdf = nt.nodes["Principled BSDF"]
col = nt.nodes.new("ShaderNodeVertexColor"); col.layer_name = "Col"; nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
h = nt.nodes.new("ShaderNodeAttribute"); h.attribute_name = "shellH"
tex = nt.nodes.new("ShaderNodeTexNoise"); tex.inputs["Scale"].default_value = 90; tex.inputs["Detail"].default_value = 3; tex.inputs["Roughness"].default_value = 0.6
geo = nt.nodes.new("ShaderNodeNewGeometry"); nt.links.new(geo.outputs["Position"], tex.inputs["Vector"])
# remap noise so shell 0 is solid and the top shell is sparse
rng = nt.nodes.new("ShaderNodeMapRange"); rng.inputs[1].default_value = 0.42; rng.inputs[2].default_value = 0.62
nt.links.new(tex.outputs["Fac"], rng.inputs[0])
gt = nt.nodes.new("ShaderNodeMath"); gt.operation = "GREATER_THAN"
nt.links.new(rng.outputs[0], gt.inputs[0]); nt.links.new(h.outputs["Fac"], gt.inputs[1])
nt.links.new(gt.outputs[0], bsdf.inputs["Alpha"])
bsdf.inputs["Roughness"].default_value = 0.9
try: mat.blend_method = "CLIP"
except Exception: pass
objs = [rock]
for i in range(SHELLS):
    hh = i / (SHELLS - 1)
    Vi = Vs + HN * (0.005 + THICK * hh * (0.5 + 0.5 * W))[:, None]
    cols = C.tint(HN, np.full(len(Vi), 1 - hh), np.zeros(len(Vi)))
    ob = C.mesh_from_tris(f"shell{i:02d}", Vi, Tr, HN, cols, mat)
    at = ob.data.attributes.new("shellH", "FLOAT", "POINT"); at.data.foreach_set("value", np.full(len(Vi), hh))
    objs.append(ob)
C.report("b_shells", objs, {"shells": SHELLS})
