"""A worker must not accumulate one orphan mesh per atlas it bakes."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import bpy
import scene_export as export
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
ob = bpy.context.object
source = bpy.data.materials.new('source retained for next atlas')
export.PRISTINE[ob.name] = [source]
for index in range(20):
    ob.data = ob.data.copy()
    unused = bpy.data.materials.new(f'unused {index}')
    im = bpy.data.images.new(f'unused bake {index}', 4, 4)
    im['generated_by'] = 'tools/blender/scene_export.py'
    export.release_worker_data()
    assert len(bpy.data.meshes) == 1
    assert source.name in bpy.data.materials
    assert len(bpy.data.materials) == 1
    assert not any(i.get('generated_by') for i in bpy.data.images)
assert len(ob.data.polygons) == 6
print('WORKER_CLEANUP_OK 20 atlas replacements retain one mesh and preserve source materials', flush=True)
