"""Unused source UVs and consistent foreground finish on imported Wall masters."""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parent))
import bpy
from formations import crease_cleanup, render, slate
from scene_export import remove_unused_uvs, seed_for

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
ob = bpy.context.object
mesh = ob.data
mat = slate.painted_slate()
mesh.materials.append(mat)
copy = mesh.copy()
assert remove_unused_uvs(copy) == ['UVMap']
assert not copy.uv_layers and 'UVMap' in mesh.uv_layers

# Conservative retention of shader inputs: named UVs, default UVs, generic
# attributes, tangent-space normals, and references in nested node groups.
def check(kind, setup):
    copy = mesh.copy()
    copy.uv_layers.new(name='Unused')
    copy.uv_layers.active_index = 0
    copy.uv_layers[0].active_render = True
    node = mat.node_tree.nodes.new(kind)
    setup(node)
    removed = remove_unused_uvs(copy)
    assert 'UVMap' not in removed, (kind, removed)
    assert 'UVMap' in copy.uv_layers
    mat.node_tree.nodes.remove(node)
    bpy.data.meshes.remove(copy)

check('ShaderNodeUVMap', lambda n: setattr(n, 'uv_map', 'UVMap'))
check('ShaderNodeAttribute', lambda n: setattr(n, 'attribute_name', 'UVMap'))
check('ShaderNodeTexImage', lambda n: None)
check('ShaderNodeNormalMap', lambda n: setattr(n, 'uv_map', 'UVMap'))
check('ShaderNodeTangent', lambda n: (setattr(n, 'direction_type', 'UV_MAP'), setattr(n, 'uv_map', 'UVMap')))
group = bpy.data.node_groups.new('UV input group', 'ShaderNodeTree')
uv = group.nodes.new('ShaderNodeUVMap'); uv.uv_map = 'UVMap'
check('ShaderNodeGroup', lambda n: setattr(n, 'node_tree', group))

wall = dict(generator='solid', variant='wall', params=dict(seed=31, stoneSize=.5),
            surfaceFinish=['export_creases'])
for key in ('formation_recipe', 'formation_source_recipe'):
    rock = {key: json.dumps(wall)}
    assert all(render.setting(rock, name) == render.setting({}, name) for name in render.PASSES)
    assert seed_for(rock) == 31
    assert crease_cleanup.applies(rock) and crease_cleanup.stone_scale(rock) == .5
    rock['export_creases'] = False
    assert render.setting(rock, 'export_creases') is False
    # Cliff still owns its intentional straight-fracture finish.
    rock = {key: json.dumps(dict(wall, variant='cliff'))}
    assert render.setting(rock, 'export_creases') is False
print('EXPORT_SOURCE_UVS_OK: authoring data preserved, shader UV inputs retained, Wall uses foreground finish', flush=True)
