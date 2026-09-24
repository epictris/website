"""Run in a fresh Blender background process; exercises the actual UI operators."""
from pathlib import Path
import sys
import tempfile
import bpy

BASE=Path(__file__).resolve().parent
sys.path.insert(0,str(BASE))
from blender_polygon_roots import register, mesh_object, read_selected_blockout
from test_polygon_roots import box

register()
bpy.ops.object.select_all(action='DESELECT')
coll=bpy.data.collections.new('TestSource')
bpy.context.scene.collection.children.link(coll)
source=box()['roots'][0]
obj=mesh_object('test_source',source['vertices'],source['faces'],coll)
obj.select_set(True)
bpy.context.view_layer.objects.active=obj
bpy.context.tool_settings.mesh_select_mode=(False,False,True)
for vertex in obj.data.vertices:
    vertex.select=False
for edge in obj.data.edges:
    edge.select=False
for face in obj.data.polygons:
    face.select=face.index==4
bpy.ops.object.mode_set(mode='EDIT')
assert bpy.ops.rootkit.mark_grab(value=True)=={'FINISHED'}
bpy.ops.object.mode_set(mode='OBJECT')
data=read_selected_blockout(bpy.context)
assert data['roots'][0]['grab_faces']==[4], data['roots'][0]['grab_faces']
assert bpy.ops.rootkit.mark_grab(value=False)=={'FINISHED'}
assert read_selected_blockout(bpy.context)['roots'][0]['grab_faces']==[]
assert bpy.ops.rootkit.mark_grab(value=True)=={'FINISHED'}
with tempfile.TemporaryDirectory(prefix='polygon_roots_blender_') as folder:
    bpy.context.scene.rootkit_out=folder
    bpy.context.scene.rootkit_twigs=2
    assert bpy.ops.rootkit.generate()=={'FINISHED'}
    assert len(list(Path(folder).glob('*.glb')))==5
    assert obj.name in bpy.data.objects
    mesh_count=len(bpy.data.meshes)
    # Running again replaces generated collections but preserves the source.
    assert bpy.ops.rootkit.generate()=={'FINISHED'}
    assert len([c for c in bpy.data.collections if c.get('polygon_roots_generated')])==5
    assert obj.name in bpy.data.objects
    assert len(bpy.data.meshes)==mesh_count
print('BLENDER_AUTHORING_TESTS_PASSED')
