"""Exact scene-wide emission cache: indirect light can travel between receivers.

Store only light images, receiver UVs and probes, never colour/normal atlases.
A miss retains the normal bake path; --no-cache bypasses reads and writes.
"""
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
from zipfile import BadZipFile

import bpy
import numpy as np
import bake_cache as bc
from native.build import source_hash as native_source_hash


def properties(owner):
    def value(item):
        if hasattr(item, 'to_dict'):
            item = item.to_dict()
        if hasattr(item, 'to_list'):
            item = item.to_list()
        if isinstance(item, dict):
            return {k: value(v) for k, v in item.items()}
        if isinstance(item, (list, tuple)):
            return [value(v) for v in item]
        if isinstance(item, bpy.types.ID):
            return (item.bl_rna.identifier, item.name)
        return item
    return json.dumps({k: value(owner[k]) for k in owner.keys()}, sort_keys=True)


def fingerprint(objects, dynamic_names):
    h = hashlib.sha256()
    bc._put(h, 1, bpy.app.version_string, sorted(dynamic_names))
    # Source/linked files cover animation, collection visibility, drivers,
    # procedural dependencies and camera-route changes conservatively.
    paths = [bpy.data.filepath, *(bpy.path.abspath(lib.filepath) for lib in bpy.data.libraries)]
    for path in sorted(set(p for p in paths if p)):
        h.update(bc.file_digest(path))
    root = Path(__file__).parent
    for path in sorted(root.rglob('*.py')):
        bc._put(h, str(path.relative_to(root)), ast.dump(bc._parse(path)))
    for path in sorted((root / 'native').rglob('*.so')):
        h.update(bc.file_digest(str(path)))
    bc._put(h, native_source_hash())
    scene = bpy.context.scene
    bc.rna_digest(h, scene.cycles, 0, {})
    bc.rna_digest(h, scene.render.bake, 0, {})
    bc._put(h, scene.frame_current, scene.unit_settings.scale_length,
            properties(scene))
    trees = {}
    for ob in sorted(objects, key=lambda o: o.name):
        bc._put(h, ob.name, ob.type, tuple(v for row in ob.matrix_world for v in row),
                ob.hide_render, properties(ob))
        if ob.type == 'MESH':
            bc.mesh_digest(h, ob.data)
            bc._array(h, ob.data.corner_normals, 'vector', 3, np.float32)
        for slot in ob.material_slots:
            mat = slot.material
            if mat:
                bc.rna_digest(h, mat, 0, trees)
                if mat.node_tree:
                    bc.tree_digest(h, mat.node_tree, trees)
    # Generated images can be painted without changing their creation settings.
    for im in sorted(bpy.data.images, key=lambda i: i.name):
        if im.source == 'GENERATED' and im.packed_file is None and im.has_data:
            values = np.empty(len(im.pixels), np.float32)
            im.pixels.foreach_get(values)
            h.update(values.tobytes())
        elif im.source in {'FILE', 'TILED', 'SEQUENCE'}:
            bc.image_digest(h, im)
    return h.hexdigest()


def save(directory, key, objects, maps, field):
    from emission_bake import UV
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.pending-', dir=directory))
    try:
        entries, arrays, images = [], {}, set()
        for ob in objects:
            slots = []
            for i, slot in enumerate(ob.material_slots):
                mat = slot.material
                if mat is None or mat.name not in maps:
                    continue
                bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
                image = bsdf.inputs['Emission Color'].links[0].from_node.image
                images.add(image)
                slots.append({'slot': i, 'image': image.name, 'lighting': maps[mat.name]})
            if not slots:
                continue
            uv = np.empty(len(ob.data.loops) * 2, np.float32)
            ob.data.uv_layers[UV].data.foreach_get('uv', uv)
            name = str(len(entries))
            arrays[name] = uv
            entries.append({'object': ob.name, 'uv': name, 'slots': slots})
        if images:
            bpy.data.libraries.write(str(stage / 'images.blend'), images, fake_user=True)
        np.savez(stage / 'uv.npz', **arrays)
        meta = {'key': key, 'receivers': entries, 'field': field,
                'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in stage.iterdir()}}
        (stage / 'meta.json').write_text(json.dumps(meta))
        destination = directory / key
        if destination.exists():
            shutil.rmtree(destination)
        os.replace(stage, destination)
        # Bound disk usage to the most recently completed scene bake.
        for old in directory.iterdir():
            if old.is_dir() and len(old.name) == 64 and old != destination:
                shutil.rmtree(old)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def restore(directory, key, objects):
    from emission_bake import UV, target
    folder = Path(directory) / key
    if not (folder / 'meta.json').is_file():
        return None
    meta = json.loads((folder / 'meta.json').read_text())
    if meta['key'] != key:
        raise ValueError('lighting cache key mismatch')
    for name, digest in meta['files'].items():
        if hashlib.sha256((folder / name).read_bytes()).hexdigest() != digest:
            raise ValueError('lighting cache file damaged: ' + name)
    by_name = {ob.name: ob for ob in objects}
    with np.load(folder / 'uv.npz', allow_pickle=False) as archive:
        arrays = {name: archive[name] for name in archive.files}
    for entry in meta['receivers']:
        ob = by_name[entry['object']]
        uv = arrays[entry['uv']]
        if uv.size != len(ob.data.loops) * 2 or not np.isfinite(uv).all():
            raise ValueError('lighting cache UV mismatch')
        for slot in entry['slots']:
            mat = ob.material_slots[slot['slot']].material
            if not mat or not any(n.type == 'BSDF_PRINCIPLED' for n in mat.node_tree.nodes):
                raise ValueError('lighting cache material mismatch')
    images = {}
    if meta['receivers']:
        with bpy.data.libraries.load(str(folder / 'images.blend')) as (source, dest):
            names = list(source.images)
            dest.images = names[:]
        images = dict(zip(names, dest.images))
        if any(images.get(slot['image']) is None for entry in meta['receivers'] for slot in entry['slots']):
            raise ValueError('lighting cache image missing')
    maps = {}
    for entry in meta['receivers']:
        ob = by_name[entry['object']]
        ob.data = ob.data.copy()
        active = ob.data.uv_layers.active.name if ob.data.uv_layers.active else None
        render = next((uv.name for uv in ob.data.uv_layers if uv.active_render), None)
        uv = ob.data.uv_layers.get(UV) or ob.data.uv_layers.new(name=UV)
        uv.data.foreach_set('uv', arrays[entry['uv']])
        if active:
            ob.data.uv_layers.active = ob.data.uv_layers[active]
        if render:
            ob.data.uv_layers[render].active_render = True
        for item in entry['slots']:
            slot = ob.material_slots[item['slot']]
            slot.material = mat = slot.material.copy()
            node = target(mat, images[item['image']])
            for bsdf in (n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'):
                mat.node_tree.links.new(node.outputs['Color'], bsdf.inputs['Emission Color'])
                bsdf.inputs['Emission Strength'].default_value = 1
            maps[mat.name] = item['lighting']
    return maps, meta['field']


def bake(objects, dynamic_names, directory, log=print):
    from emission_bake import bake as run
    started = time.monotonic()
    key = fingerprint(objects, dynamic_names)
    try:
        result = restore(directory, key, objects)
    except (OSError, ValueError, KeyError, RuntimeError, IndexError) as error:
        log(f'emission cache: discarded unreadable entry: {error}')
        result = None
    if result is not None:
        log(f'emission cache: reused {len(result[0])} material lightmaps and probes in {time.monotonic()-started:.1f}s')
        return result
    log(f'emission cache: miss (input check {time.monotonic()-started:.1f}s)')
    result = run(objects, dynamic_names, log, prepare_receiver=ReceiverUVCache(directory))
    try:
        save(directory, key, objects, *result)
    except (OSError, RuntimeError) as error:
        log(f'emission cache: could not save: {error}')
    return result


class ReceiverUVCache:
    """Keep UV preparation when a light/material changes but receivers do not."""
    def __init__(self, directory):
        self.directory = Path(directory) / 'uv'
        self.directory.mkdir(parents=True, exist_ok=True)
        h = hashlib.sha256()
        root = Path(__file__).parent
        for name in ('emission_bake.py', 'scene_export.py', 'native/__init__.py'):
            bc._put(h, ast.dump(bc._parse(root / name)))
        for path in sorted((root / 'native').rglob('*.so')):
            h.update(bc.file_digest(str(path)))
        bc._put(h, native_source_hash())
        bc._put(h, bpy.app.version_string)
        self.code = h.digest()

    def __call__(self, ob, scene, log):
        from emission_bake import UV, receiver_targets
        h = hashlib.sha256(self.code)
        bc.mesh_digest(h, ob.data)
        bc._put(h, tuple(v for row in ob.matrix_world for v in row),
                scene.get('game_lightmap_size'),
                json.dumps({k: ob[k].to_list() if hasattr(ob[k], 'to_list') else ob[k]
                            for k in ('game_lightmap_size', 'game_lightmap_section_size', 'game_lightmap_chunk_sizes')
                            if k in ob}, sort_keys=True))
        key = h.hexdigest()
        file = self.directory / (hashlib.sha256(ob.name.encode()).hexdigest() + '.npz')
        if file.is_file():
            try:
                with np.load(file, allow_pickle=False) as entry:
                    if str(entry['key']) == key:
                        values = entry['uv']
                        sections = json.loads(str(entry['sections']))
                        if values.size != len(ob.data.loops)*2 or not np.isfinite(values).all():
                            raise ValueError('invalid cached UVs')
                        active = ob.data.uv_layers.active.name if ob.data.uv_layers.active else None
                        render = next((uv.name for uv in ob.data.uv_layers if uv.active_render), None)
                        uv = ob.data.uv_layers.get(UV) or ob.data.uv_layers.new(name=UV)
                        uv.data.foreach_set('uv', values)
                        if active:
                            ob.data.uv_layers.active = ob.data.uv_layers[active]
                        if render:
                            ob.data.uv_layers[render].active_render = True
                        log(f'emission UV cache: {ob.name}: reused {len(sections)} sections')
                        return [(size, slots) for size, slots in sections]
            except (OSError, ValueError, KeyError, EOFError, BadZipFile):
                log(f'emission UV cache: {ob.name}: rebuilding unreadable entry')
        sections = receiver_targets(ob, scene, log)
        values = np.empty(len(ob.data.loops)*2, np.float32)
        ob.data.uv_layers[UV].data.foreach_get('uv', values)
        with tempfile.NamedTemporaryFile(dir=self.directory, suffix='.npz', delete=False) as temporary:
            temp_path = Path(temporary.name)
        try:
            np.savez(temp_path, key=key, uv=values, sections=json.dumps(sections))
            os.replace(temp_path, file)
        finally:
            temp_path.unlink(missing_ok=True)
        return sections
