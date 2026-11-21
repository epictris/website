"""Derive export representations from evaluated masters, never from guides.

Runs in the background copy of an authoring file. All baking uses isolated
local-space copies; the author's geometry, materials and transforms stay intact.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import uuid

import bpy
import numpy as np
from mathutils import Matrix, Vector

VERSION = 1
MODES = [('FULL', 'Full geometry', 'Keep the evaluated master mesh'),
         ('REDUCED', 'Reduced geometry', 'Simplify the master and bake its colour and surface normals'),
         ('SURFACE', 'Baked wall surface', 'Project the master onto a two-triangle wall with baked textures')]
AXES = [('NEG_Y', 'Front (-Y)', ''), ('POS_Y', 'Back (+Y)', ''),
        ('NEG_X', 'Left (-X)', ''), ('POS_X', 'Right (+X)', ''),
        ('POS_Z', 'Top (+Z)', ''), ('NEG_Z', 'Bottom (-Z)', '')]
KEYS = ('formation_export_mode', 'formation_export_ratio', 'formation_export_resolution', 'formation_export_axis')


def settings(ob):
    result = dict(mode=ob.get(KEYS[0], 'FULL'), ratio=float(ob.get(KEYS[1], .25)),
                  resolution=int(ob.get(KEYS[2], 1024)), axis=ob.get(KEYS[3], 'NEG_Y'))
    if result['mode'] not in dict((a, b) for a, b, _ in MODES):
        raise ValueError(f"{ob.name}: unknown export representation")
    if not math.isfinite(result['ratio']) or not .001 <= result['ratio'] <= 1:
        raise ValueError(f"{ob.name}: detail ratio must be between 0.001 and 1")
    if result['resolution'] not in (128, 256, 512, 1024, 2048, 4096):
        raise ValueError(f"{ob.name}: unsupported texture resolution")
    if result['axis'] not in dict((a, b) for a, b, _ in AXES):
        raise ValueError(f"{ob.name}: unknown wall projection direction")
    return result


def eligible(ob):
    return ob.type == 'MESH' and not ob.get('formation_backup') and (
        'formation_recipe' in ob or ob.get('formation_asset') or KEYS[0] in ob)


def triangles(mesh):
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def validate(mesh):
    if not mesh.vertices or not mesh.polygons:
        raise ValueError('Cannot export an empty master')
    if any(not math.isfinite(x) for v in mesh.vertices for x in v.co):
        raise ValueError('Master contains non-finite coordinates')


def _values(value):
    if isinstance(value, bpy.types.ID):
        return [value.bl_rna.identifier, value.name_full]
    try:
        return list(value)
    except TypeError:
        return value


def fingerprint(mesh, config):
    """Geometry, corner attributes, shader graphs and pixels, independent of placement.

    Unsupported context-dependent shading must not produce a stale cached bake.
    Such shaders get a fresh key; within a build repeated mesh instances still share.
    """
    h = hashlib.sha256(json.dumps([VERSION, bpy.app.version_string, config], sort_keys=True).encode())
    def add(value):
        h.update(json.dumps(value, sort_keys=True, default=str).encode())
    def array(data, prop, width=1, dtype=np.float32):
        values = np.empty(len(data)*width, dtype=dtype)
        data.foreach_get(prop, values)
        h.update(values.tobytes())
    formats = {'FLOAT': ('value', 1, np.float32), 'INT': ('value', 1, np.int32),
               'BOOLEAN': ('value', 1, np.bool_), 'FLOAT_VECTOR': ('vector', 3, np.float32),
               'FLOAT2': ('vector', 2, np.float32), 'FLOAT_COLOR': ('color', 4, np.float32),
               'BYTE_COLOR': ('color', 4, np.float32)}
    for attr in mesh.attributes:
        add((attr.name, attr.data_type, attr.domain))
        if attr.data_type in formats:
            array(attr.data, *formats[attr.data_type])
    array(mesh.loops, 'vertex_index', dtype=np.int32)
    array(mesh.polygons, 'loop_total', dtype=np.int32)
    array(mesh.polygons, 'material_index', dtype=np.int32)
    array(mesh.polygons, 'use_smooth', dtype=np.bool_)
    array(mesh.corner_normals, 'vector', 3)
    seen = set()
    def tree(nt):
        if nt is None or nt in seen:
            return
        seen.add(nt)
        if nt.animation_data:
            add(str(uuid.uuid4()))
        for node in nt.nodes:
            add((node.name, node.bl_idname))
            for prop in node.bl_rna.properties:
                if prop.identifier in {'rna_type', 'location', 'dimensions', 'select'} or prop.type in {'COLLECTION', 'POINTER'}:
                    continue
                try:
                    add((prop.identifier, _values(getattr(node, prop.identifier))))
                except (AttributeError, TypeError):
                    pass
            for socket in node.inputs:
                if hasattr(socket, 'default_value'):
                    add((socket.identifier, _values(socket.default_value)))
            if node.type in {'OBJECT_INFO', 'TEX_COORD'} and getattr(node, 'object', None):
                add(str(uuid.uuid4()))
            image = getattr(node, 'image', None)
            if image:
                add((image.name, image.colorspace_settings.name, list(image.size)))
                pixels = np.empty(len(image.pixels), dtype=np.float32)
                image.pixels.foreach_get(pixels)
                h.update(pixels.tobytes())
            tree(getattr(node, 'node_tree', None))
        add([(l.from_node.name, l.from_socket.identifier, l.to_node.name, l.to_socket.identifier) for l in nt.links])
    for mat in mesh.materials:
        if mat is None:
            add(None)
            continue
        add((list(mat.diffuse_color), mat.roughness, mat.metallic, mat.use_nodes))
        tree(mat.node_tree)
    return h.hexdigest()


def plane(mesh, axis):
    basis = {'NEG_Y': ((1,0,0), (0,0,1)), 'POS_Y': ((-1,0,0), (0,0,1)),
             'NEG_X': ((0,-1,0), (0,0,1)), 'POS_X': ((0,1,0), (0,0,1)),
             'POS_Z': ((1,0,0), (0,1,0)), 'NEG_Z': ((1,0,0), (0,-1,0))}
    u, v = map(Vector, basis[axis]); n = u.cross(v)
    co = [p.co for p in mesh.vertices]
    xmin, xmax = min(p.dot(u) for p in co), max(p.dot(u) for p in co)
    ymin, ymax = min(p.dot(v) for p in co), max(p.dot(v) for p in co)
    depths = [p.dot(n) for p in co]
    if min(xmax-xmin, ymax-ymin) < 1e-6:
        raise ValueError('The master has no surface area in this projection direction')
    # Keep the source's front extent. Ray origins are just outside it.
    d = max(depths)
    out = bpy.data.meshes.new('Baked wall surface')
    out.from_pydata([u*x+v*y+n*d for x,y in [(xmin,ymin),(xmax,ymin),(xmax,ymax),(xmin,ymax)]], [], [(0,1,2),(0,2,3)])
    uv = out.uv_layers.new(name='UVMap')
    corners = [(0,0), (1,0), (1,1), (0,1)]
    for loop in out.loops:
        uv.data[loop.index].uv = corners[loop.vertex_index]
    return out, max(depths)-min(depths)+.01


def activate(ob, scene):
    for item in scene.objects:
        item.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob


def bake(source, target, scene, config, directory, ray_distance):
    """Selected-to-active maps contain source geometry and shader relief."""
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 16
    scene.render.bake.use_selected_to_active = True
    scene.render.bake.cage_extrusion = .002 if config['mode'] == 'SURFACE' else ray_distance
    scene.render.bake.max_ray_distance = ray_distance * 2
    scene.render.bake.margin = max(2, config['resolution']//128)
    material = bpy.data.materials.new('Formation baked surface')
    material.use_nodes = True
    target.data.materials.clear()
    target.data.materials.append(material)
    for p in target.data.polygons:
        p.material_index = 0
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value = 1.
    shader.inputs['Specular IOR Level'].default_value = .1
    maps = {}
    for channel, kind, color_space in [('base_color','DIFFUSE','sRGB'), ('normal','NORMAL','Non-Color'),
                                        ('roughness','ROUGHNESS','Non-Color'), ('ao','AO','Non-Color')]:
        im = bpy.data.images.new(f'{directory.name} {channel}', width=config['resolution'], height=config['resolution'], alpha=True)
        im.colorspace_settings.name = color_space
        node = nodes.new('ShaderNodeTexImage'); node.image = im
        nodes.active = node
        activate(target, scene); source.select_set(True)
        kwargs = dict(type=kind)
        if kind == 'DIFFUSE': kwargs['pass_filter'] = {'COLOR'}
        if kind == 'NORMAL': kwargs['normal_space'] = 'TANGENT'
        bpy.ops.object.bake(**kwargs)
        maps[channel] = (im, node)
    if config['mode'] == 'SURFACE':
        # Bake coverage separately; a rock with holes must not become an opaque rectangle.
        maskmat = bpy.data.materials.new('Formation coverage'); maskmat.use_nodes = True
        maskmat.node_tree.nodes.clear()
        emit = maskmat.node_tree.nodes.new('ShaderNodeEmission')
        output = maskmat.node_tree.nodes.new('ShaderNodeOutputMaterial')
        maskmat.node_tree.links.new(emit.outputs[0], output.inputs['Surface'])
        source.data.materials.clear(); source.data.materials.append(maskmat)
        for p in source.data.polygons: p.material_index = 0
        mask = bpy.data.images.new('Formation coverage', width=config['resolution'], height=config['resolution'], alpha=False)
        mask.colorspace_settings.name = 'Non-Color'
        node = nodes.new('ShaderNodeTexImage'); node.image = mask; nodes.active = node
        activate(target, scene); source.select_set(True)
        # Padding cannot expand the actual silhouette/holes.
        margin = scene.render.bake.margin; scene.render.bake.margin = 0
        bpy.ops.object.bake(type='EMIT')
        scene.render.bake.margin = margin
        color = np.array(maps['base_color'][0].pixels[:], dtype=np.float32).reshape(-1,4)
        color[:,3] = np.array(mask.pixels[:], dtype=np.float32).reshape(-1,4)[:,0]
        maps['base_color'][0].pixels.foreach_set(color.ravel())
        nodes.remove(node); bpy.data.images.remove(mask)
        links.new(maps['base_color'][1].outputs['Alpha'], shader.inputs['Alpha'])
        if hasattr(material, 'surface_render_method'):
            material.surface_render_method = 'DITHERED'
        else:
            material.blend_method = 'CLIP'
    links.new(maps['base_color'][1].outputs['Color'], shader.inputs['Base Color'])
    links.new(maps['roughness'][1].outputs['Color'], shader.inputs['Roughness'])
    normal = nodes.new('ShaderNodeNormalMap')
    normal.uv_map = target.data.uv_layers.active.name
    links.new(maps['normal'][1].outputs['Color'], normal.inputs['Color'])
    links.new(normal.outputs['Normal'], shader.inputs['Normal'])
    # AO is supplied as a separate reusable file; the slate colour already includes its own AO.
    for channel, (im, _) in maps.items():
        im.filepath_raw = str(directory / f'{channel}.png')
        im.file_format = 'PNG'
        im.save(); im.pack()
    material['formation_baked'] = True
    return material


def derive(mesh, config, directory):
    """Produce a cached mesh in isolation, retaining the source coordinate frame."""
    validate(mesh)
    directory.mkdir(parents=True, exist_ok=True)
    cache = directory/'variant.blend'
    if cache.is_file():
        try:
            with bpy.data.libraries.load(str(cache), link=False) as (src, dst):
                if 'FormationVariant' not in src.objects:
                    raise ValueError('Incomplete variant cache')
                dst.objects = ['FormationVariant']
            ob = dst.objects[0]
            validate(ob.data)
            data = ob.data
            bpy.data.objects.remove(ob)
            return data, True
        except (OSError, RuntimeError, ValueError):
            pass  # A damaged cache can always be rebuilt from the master.
    previous = bpy.context.window.scene
    scene = bpy.data.scenes.new('Formation bake')
    bpy.context.window.scene = scene
    source = bpy.data.objects.new('Master', mesh.copy()); scene.collection.objects.link(source)
    source.matrix_world = Matrix.Identity(4)
    try:
        if config['mode'] == 'SURFACE':
            result, reach = plane(mesh, config['axis'])
        else:
            result = mesh.copy()
            co = np.array([v.co[:] for v in mesh.vertices])
            reach = max(.02, float(np.linalg.norm(co.max(0)-co.min(0)))*.15)
        target = bpy.data.objects.new('FormationVariant', result); scene.collection.objects.link(target)
        activate(target, scene)
        if config['mode'] == 'REDUCED':
            mod = target.modifiers.new('Master simplification', 'DECIMATE')
            mod.ratio = config['ratio']; mod.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=mod.name)
            validate(target.data)
            bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=.02)
            bpy.ops.object.mode_set(mode='OBJECT')
        if config['mode'] != 'FULL':
            bake(source, target, scene, config, directory, reach)
        validate(target.data)
        # Use a stable library object name, even when an author used the same name.
        name = target.name
        conflict = bpy.data.objects.get('FormationVariant')
        if conflict is not target:
            conflict.name = 'FormationVariant (authoring)'
            target.name = 'FormationVariant'
        tmp = directory / f'{uuid.uuid4().hex}.blend'
        try:
            bpy.data.libraries.write(str(tmp), {target}, path_remap='ABSOLUTE', fake_user=True, compress=True)
            os.replace(tmp, cache)
        finally:
            target.name = name
            if conflict is not target:
                conflict.name = 'FormationVariant'
        data = target.data
        # Keep the result while deleting only this temporary scene's objects.
        data.use_fake_user = True
        return data, False
    finally:
        if bpy.context.object and bpy.context.object.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
        bpy.context.window.scene = previous
        for ob in list(scene.objects):
            mesh = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if mesh is not None and mesh.users == 0:
                bpy.data.meshes.remove(mesh)
        bpy.data.scenes.remove(scene)


def renderable(scene):
    result = set()
    def visit(collection):
        if collection.hide_render: return
        result.update(ob for ob in collection.objects if not ob.hide_render)
        for child in collection.children: visit(child)
    visit(scene.collection)
    return result


def build_scene(scene, cache_dir):
    """Replace only the export copy's meshes. Masters never enter this function."""
    bpy.context.window.scene = scene
    # Native collection assets are instanced empties. Realize them in the copy
    # so local transforms and source-object export settings are retained.
    for root in list(renderable(scene)):
        if root.instance_type == 'COLLECTION' and root.instance_collection and not root.hide_render:
            activate(root, scene)
            bpy.ops.object.duplicates_make_real(use_base_parent=True, use_hierarchy=True)
            root.instance_type = 'NONE'; root.instance_collection = None
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    report, variants = [], {}
    visible = renderable(scene)
    targets = [ob for ob in scene.objects if eligible(ob) and ob in visible]
    for ob in targets:
        config = settings(ob)
        print(f"FORMATION_EXPORT {ob.name}: {config['mode']}", flush=True)
        master = bpy.data.meshes.new_from_object(ob.evaluated_get(depsgraph), preserve_all_data_layers=True, depsgraph=depsgraph)
        # Object-linked material slots override the mesh's materials.
        master.materials.clear()
        for slot in ob.material_slots: master.materials.append(slot.material)
        validate(master)
        before = triangles(master)
        key = fingerprint(master, config)
        if key in variants:
            result, cached = variants[key], True
        else:
            result, cached = derive(master, config, Path(cache_dir)/key)
            variants[key] = result
        # Appended/linked assets are made local in the generated file only.
        if ob.library: ob = ob.make_local()
        old_mesh = ob.data
        ob.modifiers.clear(); ob.data = result
        if old_mesh.users == 0:
            bpy.data.meshes.remove(old_mesh)
        # An output mesh is ordinary geometry, no longer a reusable master asset.
        if ob.asset_data:
            ob.asset_clear()
        for slot in ob.material_slots: slot.link = 'DATA'
        for keyname in list(ob.keys()):
            if keyname.startswith('formation_'):
                del ob[keyname]
        ob['formation_exported'] = True
        ob['formation_source_triangles'] = before
        ob['formation_representation'] = config['mode']
        # A derived mesh is already finished; exporting must not regenerate
        # chips, bend its edges, or budget detail from a scene camera again.
        for keyname in ('export_depth_lod', 'export_strips', 'export_creases', 'export_chips'):
            ob[keyname] = False
        ob['detail_scale'] = 1.
        report.append(dict(name=ob.name, source_triangles=before, triangles=triangles(result),
                           mode=config['mode'], cached=cached))
        bpy.data.meshes.remove(master)
    return report
