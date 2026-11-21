"""Native linked collection assets are realized only in the export copy."""
from pathlib import Path
import sys
import tempfile
sys.path.insert(0,str(Path(__file__).parent))
import bpy
from mathutils import Matrix
from formations import asset_export, core

bpy.ops.wm.read_factory_settings(use_empty=True)
with tempfile.TemporaryDirectory(prefix='formation-instance-test-') as folder:
    folder=Path(folder)
    collection=bpy.data.collections.new('Rock kit')
    bpy.context.scene.collection.children.link(collection)
    bpy.ops.mesh.primitive_cube_add(size=2)
    master=bpy.context.object;master.name='Library rock';master['formation_asset']=True
    bpy.context.scene.collection.objects.unlink(master);collection.objects.link(master)
    master.location=(.5,0,0)
    original=core.mesh_hash(master.data)
    library=folder/'kit.blend'
    bpy.data.libraries.write(str(library),{collection},fake_user=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with bpy.data.libraries.load(str(library),link=True) as (_,target):
        target.collections=['Rock kit']
    linked=target.collections[0]
    root=bpy.data.objects.new('Placed kit',None)
    bpy.context.scene.collection.objects.link(root)
    root.instance_type='COLLECTION';root.instance_collection=linked
    root.matrix_world=Matrix.Translation((3,12,5)) @ Matrix.Diagonal((2,1,3,1))
    bpy.context.view_layer.update()
    expected=root.matrix_world @ linked.objects[0].matrix_local
    # A full-detail master library hidden in the authoring scene is not built.
    hidden=bpy.data.collections.new('Unused masters');hidden.hide_render=True
    bpy.context.scene.collection.children.link(hidden)
    ignored=bpy.data.objects.new('Hidden master',linked.objects[0].data.copy());hidden.objects.link(ignored)
    ignored['formation_asset']=True;ignored['formation_export_mode']='INVALID'
    report=asset_export.build_scene(bpy.context.scene,folder/'cache')
    assert len(report)==1 and report[0]['mode']=='FULL'
    result=next(ob for ob in bpy.context.scene.objects if ob.get('formation_exported'))
    bpy.context.view_layer.update()
    assert result.matrix_world==expected
    assert core.mesh_hash(result.data)==original
    assert root.instance_type=='NONE' and result.parent==root
    assert linked.objects[0].library and core.mesh_hash(linked.objects[0].data)==original
    assert ignored.get('formation_asset')
print('FORMATION_INSTANCES_OK',flush=True)
