"""Blender background: build flat editable outlines, GLBs and side-view previews."""
from pathlib import Path
import sys
import bpy
from mathutils import Vector

BASE=Path(__file__).resolve().parent
sys.path.insert(0,str(BASE))
from polygon_roots_2d import make_demo_shapes,build_asset_2d
from blender_polygon_roots import create_generated,export_asset,mesh_object,flat_material,register

register()

OUT=BASE/'sideview_output'; OUT.mkdir(exist_ok=True)
data=make_demo_shapes()
for root in data['roots']:
    root['corner_rounding']=.78
    root['broken_edges']={'main_root':[0,7],'left_limb':[0],'right_limb':[4]}[root['id']]
asset=build_asset_2d(data,decoration_count=10)
for obj in list(bpy.data.objects): bpy.data.objects.remove(obj,do_unlink=True)
scene=bpy.context.scene
collections=create_generated(asset); export_asset(asset,collections,OUT)
sources=bpy.data.collections.new('EDITOR_2D_OUTLINES'); scene.collection.children.link(sources)
stage=bpy.data.collections.new('PREVIEW_ONLY'); scene.collection.children.link(stage)
flat=flat_material('Editor_Flat',(.065,.19,.19))
nodes=flat.node_tree.nodes
emission=nodes.new('ShaderNodeEmission'); emission.inputs['Color'].default_value=(.065,.19,.19,1)
flat.node_tree.links.new(emission.outputs[0],nodes.get('Material Output').inputs['Surface'])
for root in data['roots']:
    obj=mesh_object(root['id'],[(x,0,y) for x,y in root['polygon']],
                    [list(range(len(root['polygon'])))],sources,flat)
    obj['root_role']='source'; obj['visual_depth']=root['depth']
    obj.rootkit_rounding=root['corner_rounding']
    attr=obj.data.attributes.new('grab_edge','BOOLEAN','EDGE')
    pairs={tuple(sorted((i,(i+1)%len(root['polygon'])))) for i in root['grab_edges']}
    for edge in obj.data.edges: attr.data[edge.index].value=tuple(sorted(edge.vertices)) in pairs
    attr=obj.data.attributes.new('broken_end','BOOLEAN','EDGE')
    pairs={tuple(sorted((i,(i+1)%len(root['polygon'])))) for i in root['broken_edges']}
    for edge in obj.data.edges:attr.data[edge.index].value=tuple(sorted(edge.vertices)) in pairs

flat_previews=[]
for root in asset['resolved_source']['roots']:
    obj=mesh_object(root['id']+'_flat_preview',[(x,0,y) for x,y in root['polygon']],
        [list(range(len(root['polygon'])))],stage,flat)
    obj.visible_shadow=False;flat_previews.append(obj)

wall=flat_material('Background_Stone',(.095,.13,.14))
mesh_object('Backdrop',[(-200,.85,-200),(200,.85,-200),(200,.85,200),(-200,.85,200)],[(0,1,2,3)],stage,wall)
def lamp(name,location,power,size,color):
    light=bpy.data.lights.new(name,'AREA'); light.energy=power; light.shape='DISK'; light.size=size; light.color=color
    obj=bpy.data.objects.new(name,light); stage.objects.link(obj); obj.location=location
    obj.rotation_euler=(Vector((0,0,1.7))-obj.location).to_track_quat('-Z','Y').to_euler()
lamp('Warm daylight',(-3,-4,6),750,3,(1,.85,.68))
lamp('Cool ambient',(3,-2,3),140,4,(.63,.77,1))
camera=bpy.data.cameras.new('Side_View_Camera'); cam=bpy.data.objects.new('Side_View_Camera',camera)
stage.objects.link(cam); cam.location=(-.08,-8,1.7)
cam.rotation_euler=(Vector((-.08,0,1.7))-cam.location).to_track_quat('-Z','Y').to_euler()
camera.type='ORTHO'; camera.ortho_scale=4.2; scene.camera=cam
scene.render.engine='CYCLES'; scene.cycles.samples=32; scene.cycles.use_denoising=True
scene.render.resolution_x=1200; scene.render.resolution_y=1100; scene.render.resolution_percentage=100
scene.world.use_nodes=True; scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.22,.28,.32,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value=.35
scene.view_settings.view_transform='AgX'

# Flat edge overlay uses exactly the authored 2D segments, in front of the preview.
edge_mat=flat_material('Editor_Edges',(.15,.95,.7))
bsdf=edge_mat.node_tree.nodes.get('Principled BSDF')
bsdf.inputs['Emission Color'].default_value=(.10,.7,.44,1); bsdf.inputs['Emission Strength'].default_value=.8
overlay=[]
for root in asset['resolved_source']['roots']:
    curve=bpy.data.curves.new(root['id']+'_outline','CURVE'); curve.dimensions='3D'; curve.bevel_depth=.006; curve.bevel_resolution=0
    spline=curve.splines.new('POLY'); spline.points.add(len(root['polygon'])-1); spline.use_cyclic_u=True
    for point,(x,y) in zip(spline.points,root['polygon']): point.co=(x,-.5,y,1)
    obj=bpy.data.objects.new(root['id']+'_outline',curve); stage.objects.link(obj); curve.materials.append(edge_mat); overlay.append(obj)

def render(filename,editor=False,edges=False):
    for obj in sources.objects:obj.hide_render=True
    for i,obj in enumerate(flat_previews):
        obj.hide_render=not editor
        # Presentation-only separation prevents coplanar overlap artifacts.
        # Every saved/exported authoring vertex stays at depth zero.
        obj.location.y=-i*.002 if editor else 0
        obj.visible_shadow=False
    for obj in collections['LOD0'].objects: obj.hide_render=editor
    for obj in overlay: obj.hide_render=not edges
    scene.render.filepath=str(OUT/filename); bpy.ops.render.render(write_still=True)

render('01_flat_editor.png',editor=True,edges=True)
render('02_3d_sideview.png')
render('03_collision_alignment.png',edges=True)
for obj in sources.objects: obj.hide_render=True; obj.display_type='WIRE'
for obj in flat_previews:obj.hide_render=True;obj.hide_set(True)
for obj in overlay: obj.hide_render=True; obj.hide_set(True)
for obj in collections['LOD0'].objects: obj.hide_render=False
scene.rootkit_out=str(OUT)
bpy.ops.object.select_all(action='DESELECT')
for obj in sources.objects: obj.select_set(True)
bpy.context.view_layer.objects.active=list(sources.objects)[0]
scene.tool_settings.mesh_select_mode=(False,True,False)
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            area.spaces.active.region_3d.view_perspective='CAMERA'
            area.spaces.active.shading.type='MATERIAL'
bpy.ops.file.pack_all(); bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'sideview_roots_demo.blend'))
print('SIDEVIEW_DEMO_COMPLETE',len(asset['decorations']))
