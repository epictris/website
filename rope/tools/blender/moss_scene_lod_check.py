"""Read-only scene regression:
blender -b --factory-startup assets-src/scenes/river.blend --python-exit-code 1 --python tools/blender/moss_scene_lod_check.py
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np
import moss
from moss import ops
moss.register()
scene = bpy.context.scene
reference = bpy.data.objects['Terrace.003.moss']
bank = bpy.data.objects['backdrop.east-low-bank.moss']
new = ops.create_moss(ops.resolve_hosts(reference)[0], scene)
a, b = new.moss.params(), reference.moss.params()
for key in a.__dataclass_fields__:
    if key == 'seed':
        continue
    x, y = getattr(a, key), getattr(b, key)
    assert x == y if isinstance(x, str) else np.allclose(x, y), (key, x, y)
assert new.moss.detail == reference.moss.detail
inputs = ops._Inputs(bank, ops.resolve_hosts(bank), bpy.context.evaluated_depsgraph_get())
assert inputs.p.kind == 'TEXTURE'
result = ops.rebuild(bank)
assert result is not None, bank.moss.status
assert bank['moss_built_kind'] == 'TEXTURE' and not bank.visible_shadow
assert bank.data.materials[0].get('moss_kind') == 'decal'
print('Terrace defaults match. East-low-bank:', {
    'mode': inputs.p.kind, 'dab_radii': (inputs.p.dab_min, inputs.p.dab_max),
    'texel': bank.moss.texel_used, 'texture': bank.moss.texture,
    'dabs': bank.moss.dabs, 'build_ms': bank.moss.build_ms,
}, flush=True)
