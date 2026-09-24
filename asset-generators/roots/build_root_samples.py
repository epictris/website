"""Blender background: render and export four editable side-view root samples.

Pass sample slugs after -- to build only selected samples.
"""
from pathlib import Path
import json
import sys
import bpy
import numpy as np
from mathutils import Vector

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))
from root_samples import samples
from polygon_roots_2d import build_asset_2d
from blender_polygon_roots import create_generated, export_asset, mesh_object, flat_material, register

register()
OUT = BASE / 'sideview_samples'
OUT.mkdir(exist_ok=True)
requested = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []


def build(sample):
    slug, data = sample['slug'], sample['data']
    out = OUT / slug
    out.mkdir(exist_ok=True)
    print('SAMPLE_START', slug, flush=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)
    bpy.data.orphans_purge(do_recursive=True)
    scene = bpy.context.scene
    asset = build_asset_2d(data, seed=sample['seed'], decoration_count=0)
    # Check the generated surfaces before producing any deliverables.
    for part in asset['structure']:
        vertices = np.asarray(part['vertices'])
        assert np.isfinite(vertices).all()
        assert np.ptp(vertices[:, 1]) > .05
        incidence = {}
        for face in part['faces']:
            ring = list(face)
            for a, b in zip(ring, ring[1:] + ring[:1]):
                edge = tuple(sorted((a, b)))
                incidence[edge] = incidence.get(edge, 0) + 1
        assert all(count == 2 for count in incidence.values()), 'Open or nonmanifold root'
    collections = create_generated(asset)
    export_asset(asset, collections, out)
    sources = bpy.data.collections.new('EDITOR_2D_OUTLINES')
    scene.collection.children.link(sources)
    for root in data['roots']:
        obj = mesh_object(root['id'], [(x,0,y) for x,y in root['polygon']],
                          [list(range(len(root['polygon'])))], sources)
        obj['root_role'] = 'source'
        obj['visual_depth'] = root['depth']
        obj.rootkit_rounding = root['corner_rounding']
        obj.hide_render = True
        obj.display_type = 'WIRE'
        for attribute, indices in [('grab_edge', root['grab_edges']), ('broken_end', root['broken_edges'])]:
            attr = obj.data.attributes.new(attribute, 'BOOLEAN', 'EDGE')
            pairs = {tuple(sorted((i,(i+1)%len(root['polygon'])))) for i in indices}
            for edge in obj.data.edges:
                attr.data[edge.index].value = tuple(sorted(edge.vertices)) in pairs
    stage = bpy.data.collections.new('PREVIEW_ONLY')
    scene.collection.children.link(stage)
    all_points = np.concatenate([np.asarray(r['polygon']) for r in data['roots']])
    lo, hi = all_points.min(axis=0), all_points.max(axis=0)
    cx, cy = (lo+hi)/2
    width, height = hi-lo
    wall = flat_material('Sample_Background', (.095,.13,.14))
    mesh_object('Backdrop', [(-200,.85,-200),(200,.85,-200),(200,.85,200),(-200,.85,200)],
                [(0,1,2,3)], stage, wall)
    def lamp(name, offset, power, size, color):
        light = bpy.data.lights.new(name, 'AREA')
        light.energy, light.shape, light.size, light.color = power, 'DISK', size, color
        obj = bpy.data.objects.new(name, light)
        stage.objects.link(obj)
        obj.location = (cx+offset[0], offset[1], cy+offset[2])
        obj.rotation_euler = (Vector((cx,0,cy))-obj.location).to_track_quat('-Z','Y').to_euler()
    lamp('Warm daylight', (-3,-4,4.3), 750, 3, (1,.85,.68))
    lamp('Cool ambient', (3,-2,1.3), 140, 4, (.63,.77,1))
    camera = bpy.data.cameras.new('Side_View_Camera')
    cam = bpy.data.objects.new('Side_View_Camera', camera)
    stage.objects.link(cam)
    cam.location = (cx,-8,cy)
    cam.rotation_euler = (Vector((cx,0,cy))-cam.location).to_track_quat('-Z','Y').to_euler()
    camera.type = 'ORTHO'
    # In a landscape frame ortho_scale controls horizontal coverage.
    camera.ortho_scale = max(width, height * 1000/900) * 1.20
    scene.camera = cam
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 1000, 900
    scene.render.resolution_percentage = 100
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.22,.28,.32,1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = .35
    scene.view_settings.view_transform = 'AgX'
    scene.render.filepath = str(out / 'preview.png')
    bpy.ops.render.render(write_still=True)
    scene.rootkit_out = str(out)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in sources.objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active=list(sources.objects)[0]
    scene.tool_settings.mesh_select_mode=(False,True,False)
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type=='VIEW_3D':
                area.spaces.active.region_3d.view_perspective='CAMERA'
                area.spaces.active.shading.type='MATERIAL'
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(out / (slug + '.blend')))
    (out / 'sample.json').write_text(json.dumps(dict(title=sample['title'], seed=sample['seed'],
        source_polygons=len(data['roots']), connected_surfaces=len(asset['structure']),
        preview='preview.png', authoring='blockout.json', gameplay='roots.gameplay2d.json'), indent=2))
    print('SAMPLE_COMPLETE', slug, flush=True)


for sample in samples():
    if not requested or sample['slug'] in requested:
        build(sample)
print('ROOT_SAMPLES_COMPLETE', flush=True)
