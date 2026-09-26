"""Run with Blender --background --python build_polygon_demo.py."""
from pathlib import Path
import json
import math
import sys

import bpy
from mathutils import Vector

BASE = Path(__file__).resolve().parent
sys.path.insert(0,str(BASE))
from polygon_roots import make_demo_blockout, build_asset
from blender_polygon_roots import (create_generated, export_asset, mesh_object,
                                    flat_material, register)

OUT = BASE/'polygon_output'
OUT.mkdir(exist_ok=True)
data = make_demo_blockout()
asset = build_asset(data)
scene = bpy.context.scene
# This script runs in a fresh Blender background process, not the user's scene.
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj,do_unlink=True)
collections = create_generated(asset)
export_asset(asset,collections,OUT)

source_coll = bpy.data.collections.new('ROOT_BLOCKOUT_EDIT_THESE')
scene.collection.children.link(source_coll)
block = flat_material('RootKit_Blockout',(.21,.26,.28))
mark = flat_material('RootKit_Grab_Debug',(.02,.65,.48))
sources = []
for root in data['roots']:
    obj = mesh_object(root['id'],root['vertices'],root['faces'],source_coll,block)
    obj['root_role'] = 'source'
    obj.data.materials.append(mark)
    attr = obj.data.attributes.new('grabbable','BOOLEAN','FACE')
    for face in obj.data.polygons:
        marked = face.index in root['grab_faces']
        attr.data[face.index].value = marked
        face.material_index = int(marked)
    sources.append(obj)

# A separate presentation collection is never exported.
stage = bpy.data.collections.new('PREVIEW_ONLY')
scene.collection.children.link(stage)
wall_mat = flat_material('Preview_Wall',(.32,.31,.28))
mesh_object('Mounting wall',[(-3,-.08,-.12),(2,-.08,-.12),(2,-.08,3.5),(-3,-.08,3.5)],
            [(0,1,2,3)],stage,wall_mat)
floor = flat_material('Preview_Floor',(.19,.18,.16))
mesh_object('Floor',[(-200,-200,-.14),(200,-200,-.14),(200,200,-.14),(-200,200,-.14)],
            [(0,1,2,3)],stage,floor)

def area(name, location, power, size, color):
    lamp = bpy.data.lights.new(name,'AREA')
    lamp.energy = power; lamp.shape = 'DISK'; lamp.size = size; lamp.color = color
    obj = bpy.data.objects.new(name,lamp); stage.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (Vector((-.4,.2,1.5))-obj.location).to_track_quat('-Z','Y').to_euler()

area('Key',(1,4,5),650,4,(1,.90,.75))
area('Fill',(-3,2,2.5),350,3,(.72,.85,1))
camera = bpy.data.cameras.new('Camera')
obj = bpy.data.objects.new('Camera',camera); stage.objects.link(obj)
obj.location = (2.7,7,3.3)
obj.rotation_euler = (Vector((-.50,.25,1.52))-obj.location).to_track_quat('-Z','Y').to_euler()
camera.type = 'ORTHO'; camera.ortho_scale = 3.6; scene.camera = obj
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'; scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.render.resolution_x = 1050; scene.render.resolution_y = 1150
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.26,.29,.34,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .4
scene.view_settings.view_transform = 'AgX'

# Polygon outlines for the authoring overlay, independent of final meshes.
edge_mat = flat_material('Preview_Edges',(.018,.025,.027))
edges = []
for root in data['roots']:
    seen = set()
    for face in root['faces']:
        for a,b in zip(face,face[1:]+face[:1]):
            edge = tuple(sorted((a,b)))
            if edge in seen:
                continue
            seen.add(edge)
            curve = bpy.data.curves.new('Polygon edge','CURVE')
            curve.dimensions = '3D'; curve.bevel_depth = .0025; curve.bevel_resolution = 1
            spline = curve.splines.new('POLY'); spline.points.add(1)
            for dst,vertex in zip(spline.points,[root['vertices'][a],root['vertices'][b]]):
                dst.co = (*vertex,1)
            edge_obj = bpy.data.objects.new('Polygon edge',curve); stage.objects.link(edge_obj)
            curve.materials.append(edge_mat); edges.append(edge_obj)

def render(name, original=False, overlay=False):
    for source in sources:
        source.hide_render = not original
    for root in collections['LOD0'].objects:
        root.hide_render = original
    for edge in edges:
        edge.hide_render = not (original or overlay)
    for grab in collections['GRAB_DEBUG'].objects:
        grab.hide_render = not overlay
        # Preview offset avoids z-fighting; export already contains exact polygons.
        if overlay:
            normal = grab.data.polygons[0].normal
            grab.location = normal*.004
    scene.render.filepath = str(OUT/name)
    bpy.ops.render.render(write_still=True)

render('01_authored_polygons.png',original=True)
render('02_generated_roots.png')
render('03_grab_alignment.png',overlay=True)
for edge in edges:
    edge.hide_render = True; edge.hide_set(True)
for grab in collections['GRAB_DEBUG'].objects:
    grab.location = (0,0,0); grab.hide_render = True; grab.hide_set(True)
for source in sources:
    source.hide_render = True; source.display_type = 'WIRE'
for root in collections['LOD0'].objects:
    root.hide_render = False
register()
bpy.ops.object.select_all(action='DESELECT')
for source in sources:
    source.select_set(True)
bpy.context.view_layer.objects.active = sources[0]
for screen in bpy.data.screens:
    for area_ui in screen.areas:
        if area_ui.type == 'VIEW_3D':
            area_ui.spaces.active.region_3d.view_perspective = 'CAMERA'
            area_ui.spaces.active.shading.type = 'MATERIAL'
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'polygon_roots_demo.blend'))
print('POLYGON_ROOTS_DEMO_COMPLETE',len(asset['decorations']))
