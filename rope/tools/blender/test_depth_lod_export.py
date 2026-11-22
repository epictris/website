"""Full-detail CPU bake/cache regression through the production exporter."""
import json
from pathlib import Path
import sys
import tempfile
sys.path.insert(0,str(Path(__file__).parent))
import bpy
import numpy as np
from formations import slate, render, depth_lod, crease_cleanup
import scene_export as export
from mesh_chunks import split_surface_chunks

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene[render.CAMERA]=json.dumps({'distance':10.2375,'tanHalf':12/70})
bpy.ops.mesh.primitive_cube_add(size=2)
ob=bpy.context.object;ob.name='LOD cache smoke'
ob['formation_recipe']='{"generator":"solid","params":{"seed":31,"adaptiveDepth":true}}'
ob['export_map_max']=128;ob['export_texels']=8.
ob.scale=(.6,1,.6);ob.location=(0,10,0)
bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
# Retain the cube's unused authoring UVMap: this used to fail before baking
# with "the crease rebuild cannot carry CORNER attribute 'UVMap'".
assert 'UVMap' in ob.data.uv_layers
original_uvs = np.array([tuple(v.uv) for v in ob.data.uv_layers['UVMap'].data])
ob.data.materials.append(slate.painted_slate())
slate.tone_facets(ob,31)
original=ob.data.copy()
export.WORKERS=0;export.BAKE_SAMPLES=1
export.bake_device=lambda:'CPU'
bpy.context.scene.render.threads_mode='FIXED';bpy.context.scene.render.threads=2
repair_calls=[]
real_repair=crease_cleanup.repair
def tracked_repair(*args,**kwargs):
    repair_calls.append(1)
    return real_repair(*args,**kwargs)
crease_cleanup.repair=tracked_repair
with tempfile.TemporaryDirectory(prefix='depth-lod-cache-') as cache:
    export.bake_procedural_textures([ob],cache)
    assert len(repair_calls)==1
    assert 'UVMap' in original.uv_layers
    assert np.array_equal(original_uvs, [tuple(v.uv) for v in original.uv_layers['UVMap'].data])
    assert 'UVMap' not in ob.data.uv_layers and export.BAKE_UV in ob.data.uv_layers
    first=ob.data
    first_vertices=np.array([tuple(v.co) for v in first.vertices])
    assert depth_lod.FACE_BAND not in first.attributes
    assert len(first.materials)>=1
    assert all(np.isfinite(v.co).all() for v in first.vertices)
    entries=list(Path(cache).glob('*/meta.json'))
    assert len(entries)==1
    # Restore the authored inputs exactly, then prove a hit never prepares or
    # bakes the mesh a second time. Cache load must preserve final deformation.
    ob.data=original
    real_unwrap=export.unwrap
    def unexpected(*args,**kwargs):
        raise AssertionError('Unchanged second export missed its cache')
    export.unwrap=unexpected
    export.bake_procedural_textures([ob],cache)
    assert len(repair_calls)==1, 'Cached geometry was repaired again'
    export.unwrap=real_unwrap
    assert np.allclose(first_vertices,[tuple(v.co) for v in ob.data.vertices])
    assert depth_lod.FACE_BAND not in ob.data.attributes
    print('FULL_DETAIL_EXPORT_CACHE_OK',flush=True)
