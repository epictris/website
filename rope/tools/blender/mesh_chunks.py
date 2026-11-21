"""Export-only mesh sections. Keep the authored node as their binding parent."""
import bpy


def split_surface_chunks(objects, log=print):
    # Surface baking has already assigned a separate material/texture set to
    # each spatial atlas. Split only these prepared meshes, after deformation
    # and growth attachment, so seams and procedural coordinates stay intact.
    from scene_export import BAKE_UV, select_only
    for ob in list(objects):
        if ob.type != 'MESH' or BAKE_UV not in ob.data.uv_layers:
            continue
        slots = sorted({p.material_index for p in ob.data.polygons})
        if len(slots) < 2:
            continue
        name = ob.name
        materials = list(ob.data.materials)
        sizes = ob.get('game_lightmap_chunk_sizes')
        if sizes is not None:
            sizes = list(sizes)
        if sizes is not None and len(sizes) != len(ob.material_slots):
            raise ValueError(f'{name}: lightmap chunk sizes must match surface materials')
        # Freeze smooth boundary normals before separating their neighbours.
        normals = [tuple(n.vector) for n in ob.data.corner_normals]
        ob.data.normals_split_custom_set(normals)
        root = bpy.data.objects.new(name + ' chunks', None)
        for collection in ob.users_collection:
            collection.objects.link(root)
        root.parent = ob.parent
        root.matrix_world = ob.matrix_world.copy()
        for key in ob.keys():
            root[key] = ob[key]
        for child in list(ob.children):
            world = child.matrix_world.copy()
            child.parent = root
            child.matrix_world = world
        select_only([ob], ob)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.separate(type='MATERIAL')
        bpy.ops.object.mode_set(mode='OBJECT')
        parts = sorted(bpy.context.selected_objects,
                       key=lambda part: materials.index(part.data.materials[part.data.polygons[0].material_index]))
        ob.name = name + ' chunk'
        root.name = name
        for index, part in enumerate(parts):
            slot = materials.index(part.data.materials[part.data.polygons[0].material_index])
            part.name = f'{name} chunk {index + 1:03d}'
            world = part.matrix_world.copy()
            part.parent = root
            part.matrix_world = world
            if sizes is not None:
                part['game_lightmap_size'] = int(sizes[slot])
            elif 'game_lightmap_section_size' in part:
                part['game_lightmap_size'] = part['game_lightmap_section_size']
            for key in ('game_lightmap_chunk_sizes', 'game_lightmap_section_size'):
                if key in part:
                    del part[key]
            select_only([part], part)
            bpy.ops.object.material_slot_remove_unused()
            if part != ob:
                objects.append(part)
        objects.append(root)
        log(f'chunk {name}: {len(parts)} meshes with independent texture sets')
