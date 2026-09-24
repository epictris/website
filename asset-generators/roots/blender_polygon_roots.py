"""Blender panel + GLB export for polygon-authored climbing roots.

Run this file in Blender's Text Editor to add the Root Kit sidebar panel.
Keep it beside polygon_roots.py and procedural_roots.py.
"""
bl_info = {'name': 'Polygon Root Kit', 'blender': (4, 2, 0),
           'category': 'Object', 'version': (1, 0, 0)}

import json
from pathlib import Path
import sys

import bpy
from bpy.props import BoolProperty, FloatProperty, IntProperty, StringProperty

BASE = Path(__file__).resolve().parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))
from polygon_roots import (build_asset, decoration_mesh, grab_manifest,
                           validate_blockout)
from polygon_roots_2d import build_asset_2d, validate_shapes


def build_from_editor(data, **options):
    return (build_asset_2d if data.get('version') == 2 else build_asset)(data, **options)


def flat_material(name, color):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = .8
    return mat


def bark_material(name, roughness=.9):
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Base Color'].default_value = (.22,.12,.055,1)
    for filename, kind in [('bark_albedo.png','color'),('bark_normal.png','normal'),('bark_roughness.png','roughness')]:
        path = BASE/filename
        if not path.exists():
            continue
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = bpy.data.images.load(str(path), check_existing=True)
        if kind == 'color':
            nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
        elif kind == 'roughness':
            tex.image.colorspace_settings.name = 'Non-Color'
            nt.links.new(tex.outputs['Color'], bsdf.inputs['Roughness'])
        else:
            tex.image.colorspace_settings.name = 'Non-Color'
            normal = nt.nodes.new('ShaderNodeNormalMap')
            normal.inputs['Strength'].default_value = .8
            nt.links.new(tex.outputs['Color'], normal.inputs['Color'])
            nt.links.new(normal.outputs['Normal'], bsdf.inputs['Normal'])
    return mat


def mesh_object(name, vertices, faces, collection, material=None, uv=None):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in vertices], [], [list(f) for f in faces])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    if material:
        mesh.materials.append(material)
    if uv is not None:
        layer = mesh.uv_layers.new(name='UVMap')
        for loop in mesh.loops:
            layer.data[loop.index].uv = tuple(uv[loop.vertex_index])
    return obj


def flow_bark_material(part):
    """Bake NumPy branch-flow fields into portable glTF PBR textures."""
    import numpy as np
    from sideview_surface import bark_atlas
    albedo,normal,orm=bark_atlas(part)
    name='RootKit_FlowBark_'+part['id']
    mat=bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes=True;mat.node_tree.nodes.clear()
    nt=mat.node_tree;output=nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf=nt.nodes.new('ShaderNodeBsdfPrincipled');bsdf.inputs['Roughness'].default_value=.88
    nt.links.new(bsdf.outputs['BSDF'],output.inputs['Surface'])
    for suffix,pixels in [('Albedo',albedo),('Normal',normal),('Roughness',orm)]:
        image_name=name+'_'+suffix
        image=bpy.data.images.get(image_name)
        height,width=pixels.shape[:2]
        if image is None: image=bpy.data.images.new(image_name,width=width,height=height,alpha=False)
        elif tuple(image.size)!=(width,height): image.scale(width,height)
        image.colorspace_settings.name='sRGB' if suffix=='Albedo' else 'Non-Color'
        rgba=np.ones((height,width,4),dtype=np.float32);rgba[:,:,:3]=pixels
        image.pixels.foreach_set(rgba.ravel());image.update();image.pack()
        tex=nt.nodes.new('ShaderNodeTexImage');tex.image=image;tex.extension='EXTEND'
        if suffix=='Albedo': nt.links.new(tex.outputs['Color'],bsdf.inputs['Base Color'])
        elif suffix=='Roughness':
            separate=nt.nodes.new('ShaderNodeSeparateColor')
            nt.links.new(tex.outputs['Color'],separate.inputs['Color'])
            nt.links.new(separate.outputs['Green'],bsdf.inputs['Roughness'])
        else:
            normal_node=nt.nodes.new('ShaderNodeNormalMap');normal_node.inputs['Strength'].default_value=.85
            nt.links.new(tex.outputs['Color'],normal_node.inputs['Color'])
            nt.links.new(normal_node.outputs['Normal'],bsdf.inputs['Normal'])
    return mat


def read_selected_blockout(context):
    if abs(context.scene.unit_settings.scale_length-1.0) > 1e-6:
        raise ValueError('Use Scene Units scale 1.0: one Blender unit equals one metre.')
    if context.object and context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    roots = []
    shapes = []
    for obj in context.selected_objects:
        if obj.type != 'MESH' or obj.get('root_role') in ('visual','decoration','collision','grab','outline'):
            continue
        if obj.modifiers:
            raise ValueError(f'{obj.name}: apply modifiers before marking faces and generating.')
        attr = obj.data.attributes.get('grabbable')
        if attr is not None and (attr.domain != 'FACE' or attr.data_type != 'BOOLEAN'):
            raise ValueError(f'{obj.name}: grabbable must be a Boolean Face attribute.')
        vertices = [list(obj.matrix_world @ v.co) for v in obj.data.vertices]
        if len(obj.data.polygons) == 1:
            if any(abs(v[1]) > 1e-6 for v in vertices):
                raise ValueError(f'{obj.name}: flat editor shapes must lie in the XZ plane at Y=0.')
            order = list(obj.data.polygons[0].vertices)
            edge_attr = obj.data.attributes.get('grab_edge')
            if edge_attr and (edge_attr.domain != 'EDGE' or edge_attr.data_type != 'BOOLEAN'):
                raise ValueError('grab_edge must be a Boolean Edge attribute.')
            marked = {tuple(sorted(e.vertices)) for e in obj.data.edges
                      if edge_attr and edge_attr.data[e.index].value}
            shapes.append(dict(id=obj.name,polygon=[[vertices[i][0],vertices[i][2]] for i in order],
                grab_edges=[i for i,a in enumerate(order)
                            if tuple(sorted((a,order[(i+1)%len(order)]))) in marked],
                depth=float(obj.get('visual_depth',.38))))
            amount=float(getattr(obj,'rootkit_rounding',obj.get('rootkit_rounding',0)))
            if amount:shapes[-1]['corner_rounding']=amount
            ends=obj.data.attributes.get('broken_end')
            if ends:
                if ends.domain!='EDGE' or ends.data_type!='BOOLEAN':
                    raise ValueError('broken_end must be a Boolean Edge attribute.')
                end_pairs={tuple(sorted(e.vertices)) for e in obj.data.edges if ends.data[e.index].value}
                end_ids=[i for i,a in enumerate(order) if tuple(sorted((a,order[(i+1)%len(order)]))) in end_pairs]
                if end_ids:shapes[-1]['broken_edges']=end_ids
            continue
        # Negative scales reverse the winding in world space.
        faces = [list(p.vertices) for p in obj.data.polygons]
        if obj.matrix_world.determinant() < 0:
            faces = [list(reversed(f)) for f in faces]
        roots.append(dict(id=obj.name, vertices=vertices, faces=faces,
                          grab_faces=[i for i in range(len(faces)) if attr and attr.data[i].value]))
    if shapes:
        if roots:
            raise ValueError('Select flat 2D polygons together; do not mix them with legacy 3D cages.')
        return validate_shapes(dict(version=2,units='meters',up_axis='Y',gameplay='2D',roots=shapes))
    return validate_blockout(dict(version=1, units='meters', up_axis='Z', roots=roots))


def create_generated(asset):
    # Replace only this tool's generated collections; source meshes are never owned.
    for coll in list(bpy.context.scene.collection.children):
        if coll.get('polygon_roots_generated'):
            if coll.users > 1:
                raise ValueError('A generated root collection is shared. Unlink it from other scenes before regenerating.')
            for obj in list(coll.objects):
                mesh = obj.data if obj.type == 'MESH' else None
                bpy.data.objects.remove(obj, do_unlink=True)
                if mesh is not None and mesh.users == 0:
                    bpy.data.meshes.remove(mesh)
            bpy.data.collections.remove(coll)
    collections = {}
    for key in ('LOD0','LOD1','LOD2','COLLISION','GRAB_DEBUG'):
        coll = bpy.data.collections.new('ROOTS_'+key)
        coll['polygon_roots_generated'] = True
        bpy.context.scene.collection.children.link(coll)
        collections[key] = coll
    if 'resolved_source' in asset:
        coll=bpy.data.collections.new('ROOTS_OUTLINE_2D');coll['polygon_roots_generated']=True
        bpy.context.scene.collection.children.link(coll);collections['OUTLINE_2D']=coll
        for root in asset['resolved_source']['roots']:
            obj=mesh_object(root['id']+'__RESOLVED_OUTLINE',[(x,0,y) for x,y in root['polygon']],
                            [list(range(len(root['polygon'])))],coll)
            obj['root_role']='outline';obj.display_type='WIRE';obj.show_in_front=True
            obj.color=(.1,.8,.55,1);obj.hide_select=True;obj.hide_render=True;obj.hide_set(True)
    bark = bark_material('RootKit_Bark')
    grip = bark_material('RootKit_Grip_WornBark', .72)
    debug = flat_material('RootKit_Grab_Debug', (.03,.8,.65))
    solid = flat_material('RootKit_Collision_Debug', (.25,.35,.48))
    flow_materials={part['id']:flow_bark_material(part) for part in asset['structure'] if 'atlas_roots' in part}
    for li in range(3):
        coll = collections[f'LOD{li}']
        for part in asset['structure']:
            obj = mesh_object(f'{part["id"]}__STRUCTURE_LOD{li}', part['vertices'],
                              part['faces'], coll, flow_materials.get(part['id'],bark), part['uv'])
            obj['root_role'] = 'visual'
            obj['root_id'] = part['id']
            if 'source_root_ids' in part:
                obj['source_root_ids'] = part['source_root_ids']
                obj['surface_model'] = 'continuous_rounded_union'
            obj['grab_source'] = 'roots.gameplay2d.json' if 'gameplay2d' in asset else 'roots.grab.json'
            obj['gameplay'] = '2D' if 'gameplay2d' in asset else '3D'
            obj.data.materials.append(grip)
            marked = obj.data.attributes.new('grabbable', 'BOOLEAN', 'FACE')
            source = obj.data.attributes.new('source_face', 'INT', 'FACE')
            for i, face in enumerate(obj.data.polygons):
                face.use_smooth = part.get('smooth',False)
                face.material_index = int(part['materials'][i])
                marked.data[i].value = bool(part['materials'][i])
                source.data[i].value = int(part['source_faces'][i])
        if li < 2:
            for deco in asset['decorations']:
                v,f,uv,_ = decoration_mesh(deco['branch'], li)
                obj = mesh_object(f'{deco["id"]}__DECORATION_LOD{li}',v,f,coll,bark,uv)
                obj['root_role'] = 'decoration'
                obj['grabbable'] = False
                obj['root_id'] = deco['root_id']
                obj['source_face'] = deco['source_face']
                for p in obj.data.polygons:
                    p.use_smooth = True
        for obj in coll.objects:
            obj.hide_render = li != 0
            obj.hide_set(li != 0)
    for root in asset['source']['roots']:
        obj = mesh_object(root['id']+'__SOLID',root['vertices'],root['faces'],
                          collections['COLLISION'],solid)
        obj['root_role'] = 'collision'
        obj['root_id'] = root['id']
        obj['grabbable'] = False
        obj.hide_render = True
        obj.hide_set(True)
    for face in grab_manifest(asset)['faces']:
        obj = mesh_object(f'{face["root_id"]}__GRAB_{face["source_face"]}',face['polygon'],
                          [list(range(len(face['polygon'])))],collections['GRAB_DEBUG'],debug)
        obj['root_role'] = 'grab'
        obj['root_id'] = face['root_id']
        obj['source_face'] = face['source_face']
        obj['grabbable'] = True
        obj.hide_render = True
        obj.hide_set(True)
    return collections


def export_asset(asset, collections, outdir):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir/'blockout.json').write_text(json.dumps(asset.get('editor_source',asset['source']), indent=2), encoding='utf8')
    if 'gameplay2d' in asset:
        (outdir/'roots.gameplay2d.json').write_text(json.dumps(asset['gameplay2d'],indent=2),encoding='utf8')
    else:
        (outdir/'roots.grab.json').write_text(json.dumps(grab_manifest(asset), indent=2), encoding='utf8')
    original_selection = list(bpy.context.selected_objects)
    active = bpy.context.view_layer.objects.active
    try:
        for key, filename in [('LOD0','roots_LOD0.glb'),('LOD1','roots_LOD1.glb'),
                              ('LOD2','roots_LOD2.glb'),('COLLISION','roots_collision.glb'),
                              ('GRAB_DEBUG','roots_grab.glb')]:
            if 'gameplay2d' in asset and key in ('COLLISION','GRAB_DEBUG'):
                continue
            bpy.ops.object.select_all(action='DESELECT')
            states = [(o,o.hide_get()) for o in collections[key].objects]
            try:
                for obj,_ in states:
                    obj.hide_set(False)
                    obj.select_set(True)
                bpy.ops.export_scene.gltf(filepath=str(outdir/filename), export_format='GLB',
                    use_selection=True, export_extras=True, export_yup=True,
                    export_animations=False, export_cameras=False, export_lights=False)
            finally:
                for obj, hidden in states:
                    obj.select_set(False)
                    obj.hide_set(hidden)
    finally:
        for obj in original_selection:
            if obj.name in bpy.context.scene.objects:
                obj.select_set(True)
        bpy.context.view_layer.objects.active = active


class ROOTKIT_OT_mark(bpy.types.Operator):
    bl_idname = 'rootkit.mark_grab'
    bl_label = 'Mark Selected Grab Faces'
    bl_options = {'REGISTER','UNDO'}
    value: BoolProperty(default=True)

    @classmethod
    def poll(cls, context):
        return context.object is not None and context.object.type == 'MESH'

    def execute(self, context):
        obj = context.object
        editing = obj.mode == 'EDIT'
        if editing:
            bpy.ops.object.mode_set(mode='OBJECT')
        if len(obj.data.polygons) == 1:
            attr = obj.data.attributes.get('grab_edge')
            if attr is None:
                attr = obj.data.attributes.new('grab_edge','BOOLEAN','EDGE')
            if attr.domain != 'EDGE' or attr.data_type != 'BOOLEAN':
                self.report({'ERROR'},'grab_edge must be a Boolean Edge attribute.')
                if editing:
                    bpy.ops.object.mode_set(mode='EDIT')
                return {'CANCELLED'}
            for edge in obj.data.edges:
                if edge.select:
                    attr.data[edge.index].value = self.value
            if editing:
                bpy.ops.object.mode_set(mode='EDIT')
            return {'FINISHED'}
        attr = obj.data.attributes.get('grabbable')
        if attr is None:
            attr = obj.data.attributes.new('grabbable','BOOLEAN','FACE')
        if attr.domain != 'FACE' or attr.data_type != 'BOOLEAN':
            self.report({'ERROR'}, 'grabbable must be a Boolean Face attribute.')
            if editing:
                bpy.ops.object.mode_set(mode='EDIT')
            return {'CANCELLED'}
        marker = flat_material('RootKit_Grab_Debug', (.03,.8,.65))
        base = flat_material('RootKit_Blockout', (.18,.22,.25))
        for mat in (base,marker):
            if mat.name not in obj.data.materials:
                obj.data.materials.append(mat)
        for polygon in obj.data.polygons:
            if polygon.select:
                attr.data[polygon.index].value = self.value
                polygon.material_index = obj.data.materials.find(marker.name if self.value else base.name)
        if editing:
            bpy.ops.object.mode_set(mode='EDIT')
        return {'FINISHED'}


class ROOTKIT_OT_end(bpy.types.Operator):
    bl_idname='rootkit.mark_end'
    bl_label='Mark Selected Broken End Edges'
    bl_options={'REGISTER','UNDO'}
    value: BoolProperty(default=True)

    @classmethod
    def poll(cls,context):
        return context.object is not None and context.object.type=='MESH' and len(context.object.data.polygons)==1

    def execute(self,context):
        obj=context.object;editing=obj.mode=='EDIT'
        if editing:bpy.ops.object.mode_set(mode='OBJECT')
        attr=obj.data.attributes.get('broken_end')
        if attr is None:attr=obj.data.attributes.new('broken_end','BOOLEAN','EDGE')
        if attr.domain!='EDGE' or attr.data_type!='BOOLEAN':
            self.report({'ERROR'},'broken_end must be a Boolean Edge attribute.')
            if editing:bpy.ops.object.mode_set(mode='EDIT')
            return {'CANCELLED'}
        for edge in obj.data.edges:
            if edge.select:attr.data[edge.index].value=self.value
        if editing:bpy.ops.object.mode_set(mode='EDIT')
        return {'FINISHED'}


class ROOTKIT_OT_generate(bpy.types.Operator):
    bl_idname = 'rootkit.generate'
    bl_label = 'Generate and Export Roots'
    bl_options = {'REGISTER','UNDO'}

    def execute(self, context):
        try:
            data = read_selected_blockout(context)
            asset = build_from_editor(data, seed=context.scene.rootkit_seed,
                                hand_clearance=context.scene.rootkit_clearance,
                                decoration_count=context.scene.rootkit_twigs)
            source_names = {root['id'] for root in data['roots']}
            selected = [obj for obj in context.selected_objects if obj.name in source_names]
            collections = create_generated(asset)
            export_asset(asset, collections, bpy.path.abspath(context.scene.rootkit_out))
            for obj in selected:
                obj['root_role'] = 'source'
                obj.hide_render = True
                obj.display_type = 'WIRE'
            self.report({'INFO'}, f'Exported {len(data["roots"])} roots with {"2D edge gameplay" if data["version"] == 2 else "3D face gameplay"}.')
        except (ValueError, OSError, RuntimeError) as error:
            self.report({'ERROR'}, str(error))
            return {'CANCELLED'}
        return {'FINISHED'}


class ROOTKIT_OT_view(bpy.types.Operator):
    bl_idname = 'rootkit.sideview'
    bl_label = 'Switch 2D Editor / 3D Preview'
    preview: BoolProperty(default=False)

    def execute(self,context):
        from mathutils import Quaternion, Vector
        import math
        if context.object and context.object.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
        for obj in context.scene.objects:
            if obj.get('root_role') == 'source':
                obj.display_type = 'WIRE' if self.preview else 'SOLID'
                obj.hide_set(self.preview)
            elif obj.get('root_role') in ('visual','decoration'):
                obj.hide_set(not self.preview or not obj.name.endswith('LOD0'))
            elif obj.get('root_role')=='outline':obj.hide_set(self.preview)
        if context.area and context.area.type == 'VIEW_3D':
            view=context.space_data.region_3d
            view.view_rotation=Quaternion((1,0,0),math.pi/2)
            view.view_perspective='ORTHO'
            view.view_location=Vector((0,0,1.6)); view.view_distance=5
        return {'FINISHED'}


class ROOTKIT_PT_panel(bpy.types.Panel):
    bl_label = 'Polygon Roots'
    bl_idname = 'ROOTKIT_PT_panel'
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Root Kit'

    def draw(self, context):
        layout = self.layout
        layout.label(text='2D outlines -> 3D roots')
        row=layout.row(align=True)
        row.operator('rootkit.sideview',text='Edit 2D').preview=False
        row.operator('rootkit.sideview',text='Preview 3D').preview=True
        layout.label(text='1. Flat polygon in XZ (Y = 0)')
        layout.label(text='2. Select grab edges in Edit Mode')
        row = layout.row(align=True)
        row.operator('rootkit.mark_grab',text='Mark Grab').value = True
        row.operator('rootkit.mark_grab',text='Clear Grab').value = False
        layout.label(text='3. Select source polygons')
        if context.object and len(getattr(context.object.data,'polygons',[])) == 1:
            layout.prop(context.object,'rootkit_rounding',text='Corner rounding')
            if 'visual_depth' in context.object:
                layout.prop(context.object,'["visual_depth"]',text='Visual depth (m)')
            row=layout.row(align=True)
            row.operator('rootkit.mark_end',text='Broken End').value=True
            row.operator('rootkit.mark_end',text='Clear End').value=False
            layout.label(text='Rounding / chips update collision')
        layout.prop(context.scene,'rootkit_seed')
        layout.prop(context.scene,'rootkit_twigs')
        layout.prop(context.scene,'rootkit_clearance')
        layout.prop(context.scene,'rootkit_out')
        layout.operator('rootkit.generate')
        layout.label(text='Outline defines 2D physics')
        layout.label(text='Depth affects appearance only')


CLASSES = (ROOTKIT_OT_mark,ROOTKIT_OT_end,ROOTKIT_OT_generate,ROOTKIT_OT_view,ROOTKIT_PT_panel)


def register():
    for cls in CLASSES:
        old = getattr(bpy.types,cls.__name__,None)
        if old:
            bpy.utils.unregister_class(old)
        bpy.utils.register_class(cls)
    bpy.types.Object.rootkit_rounding=FloatProperty(name='Corner rounding',default=0,min=0,max=1,
        description='Round the outline for both generated visuals and 2D collision; Generate to refresh')
    bpy.types.Scene.rootkit_seed = IntProperty(name='Seed',default=1234,min=0)
    bpy.types.Scene.rootkit_twigs = IntProperty(name='Thin branches',default=14,min=0,max=200)
    bpy.types.Scene.rootkit_clearance = FloatProperty(name='Hand clearance (m)',default=.12,min=.02,max=.5)
    bpy.types.Scene.rootkit_out = StringProperty(name='Output folder',subtype='DIR_PATH',
                                               default=str(BASE/'sideview_output'))


def unregister():
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
    del bpy.types.Object.rootkit_rounding
    for name in ('rootkit_seed','rootkit_twigs','rootkit_clearance','rootkit_out'):
        delattr(bpy.types.Scene,name)


if __name__ == '__main__':
    if '--' in sys.argv:
        import argparse
        parser = argparse.ArgumentParser(description='Export polygon-authored roots from JSON.')
        parser.add_argument('--input',required=True,type=Path)
        parser.add_argument('--out',type=Path,default=BASE/'polygon_output')
        parser.add_argument('--seed',type=int,default=1234)
        args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
        asset = build_from_editor(json.loads(args.input.read_text(encoding='utf8')),seed=args.seed)
        collections = create_generated(asset)
        export_asset(asset,collections,args.out)
        print('Export complete:',args.out)
    else:
        register()
