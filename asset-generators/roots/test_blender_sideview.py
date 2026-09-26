"""Run inside Blender to verify flat authoring, marking and real exports."""
import sys,json,tempfile
from pathlib import Path
import bpy
BASE=Path(__file__).resolve().parent;sys.path.insert(0,str(BASE))
from blender_polygon_roots import register,mesh_object,read_selected_blockout

register();bpy.ops.object.select_all(action='DESELECT')
coll=bpy.data.collections.new('FlatTest');bpy.context.scene.collection.children.link(coll)
obj=mesh_object('flat_source',[(0,0,0),(2,0,0),(2,0,2),(0,0,2)],[[0,1,2,3]],coll)
obj['root_role']='source';obj['visual_depth']=.4
obj.select_set(True);bpy.context.view_layer.objects.active=obj
bpy.context.tool_settings.mesh_select_mode=(False,True,False)
for p in obj.data.polygons:p.select=False
for v in obj.data.vertices:v.select=False
for e in obj.data.edges:e.select=set(e.vertices)=={2,3}
bpy.ops.object.mode_set(mode='EDIT');assert bpy.ops.rootkit.mark_grab(value=True)=={'FINISHED'}
bpy.ops.object.mode_set(mode='OBJECT')
data=read_selected_blockout(bpy.context)
assert data['version']==2 and data['roots'][0]['grab_edges']==[2],data
assert data['roots'][0]['polygon']==[[0,0],[2,0],[2,2],[0,2]]
with tempfile.TemporaryDirectory(prefix='sideview_roots_') as folder:
    bpy.context.scene.rootkit_out=folder;bpy.context.scene.rootkit_twigs=0
    for _ in range(2):
        assert bpy.ops.rootkit.generate()=={'FINISHED'}
        assert len(list(Path(folder).glob('*.glb')))==3
        assert json.loads((Path(folder)/'blockout.json').read_text())==data
        manifest=json.loads((Path(folder)/'roots.gameplay2d.json').read_text())
        assert manifest['roots'][0]['grab_edges']==[2]
        for mesh in bpy.data.meshes:
            if '__STRUCTURE_' in mesh.name:
                assert not mesh.validate(),mesh.name
        assert len(obj.data.polygons)==1 and all(v.co.y==0 for v in obj.data.vertices)
    obj.rootkit_rounding=.65
    assert bpy.ops.rootkit.mark_end(value=True)=={'FINISHED'}
    curved=read_selected_blockout(bpy.context)
    assert abs(curved['roots'][0]['corner_rounding']-.65)<1e-6
    assert curved['roots'][0]['broken_edges']==[2]
    assert bpy.ops.rootkit.generate()=={'FINISHED'}
    manifest=json.loads((Path(folder)/'roots.gameplay2d.json').read_text())
    shape=manifest['roots'][0]
    assert len(shape['polygon'])>4 and len(shape['source_edges'])==len(shape['polygon'])
    assert all(shape['source_edges'][i]==2 for i in shape['grab_edges'])
    assert len(obj.data.vertices)==4,'Generating must not replace editable control vertices.'
    assert bpy.ops.rootkit.sideview(preview=False)=={'FINISHED'}
    assert not obj.hide_get()
    assert bpy.ops.rootkit.sideview(preview=True)=={'FINISHED'}
    assert obj.hide_get()
print('BLENDER_SIDEVIEW_TESTS_PASSED')
