"""Small end-to-end master/variant/build tests; run in factory background Blender."""
import json
import math
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).parent))
import bpy
import numpy as np
from mathutils import Matrix
import formations
from formations import asset_export as export, assets, core, params, worker

bpy.ops.wm.read_factory_settings(use_empty=True)
formations.register()
assert 'adaptiveDepth' not in params.FIELDS['solid']
assert 'floor' not in params.FIELDS['solid']
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1)
master = bpy.context.object
master.name = 'Rock master'
master['formation_asset'] = True
mat = bpy.data.materials.new('Rock'); mat.use_nodes = True
mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (.2,.1,.05,1)
master.data.materials.append(mat)
original = core.mesh_hash(master.data)
world = Matrix.Translation((2,18,4)) @ Matrix.Diagonal((2,1,3,1))
master.matrix_world = world
master.formation_representation = 'REDUCED'
master.formation_keep_ratio = .2
master.formation_texture_resolution = '128'
config = export.settings(master)
assert config['mode'] == 'REDUCED' and math.isclose(config['ratio'],.2,abs_tol=1e-6)
with tempfile.TemporaryDirectory(prefix='formation-assets-test-') as folder:
    folder = Path(folder)
    collision = bpy.data.objects.new('FormationVariant', None)
    bpy.context.scene.collection.objects.link(collision)
    full, hit = export.derive(master.data, dict(config, mode='FULL'), folder/'full')
    assert collision.name == 'FormationVariant', 'Cache writing renamed an authoring object'
    assert not hit and core.mesh_hash(full) == original
    reduced, hit = export.derive(master.data, config, folder/'reduced')
    assert not hit and 0 < export.triangles(reduced) < export.triangles(master.data)*.3
    again, hit = export.derive(master.data, config, folder/'reduced')
    assert hit and core.mesh_hash(again) == core.mesh_hash(reduced)
    surface, hit = export.derive(master.data, dict(config, mode='SURFACE'), folder/'surface')
    assert export.triangles(surface) == 2
    assert all(p.normal.y < -.99 for p in surface.polygons)
    assert all((folder/'surface'/f'{name}.png').is_file() for name in ['base_color','normal','roughness','ao'])
    material = surface.materials[0]
    images = [n.image for n in material.node_tree.nodes if n.type == 'TEX_IMAGE']
    color = next(im for im in images if im.name.endswith(' base_color'))
    pixels = np.array(color.pixels[:]).reshape(-1,4)
    assert pixels[:,3].max() > .9 and pixels[:,3].min() < .1, 'Coverage alpha lost the silhouette'
    assert all(im.packed_file for im in images)
    normal = next(im for im in images if im.name.endswith(' normal'))
    normals = np.array(normal.pixels[:]).reshape(-1,4)
    assert np.ptp(normals[pixels[:,3]>.9,0]) > .2, 'Source surface relief missing from normal map'
    assert core.mesh_hash(master.data) == original and master.matrix_world == world
    assert master.data.materials[0] == mat
    key = export.fingerprint(master.data, config)
    mat.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = .25
    assert export.fingerprint(master.data, config) != key, 'Material edit did not invalidate cache'
    mat.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = .5
    assert export.fingerprint(master.data, dict(config, ratio=.5)) != key
    changed = master.data.copy(); changed.vertices[0].co.x += .1
    assert export.fingerprint(changed, config) != key
    bpy.data.meshes.remove(changed)
    # Separate authoring file and a second instance sharing the same master.
    duplicate = master.copy(); bpy.context.scene.collection.objects.link(duplicate)
    duplicate.location.x += 5
    source = folder/'authoring.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(source))
    report = export.build_scene(bpy.context.scene, folder/'cache')
    assert len(report) == 2 and report[1]['cached']
    assert master.data is duplicate.data
    assert master.matrix_world == world
    assert core.mesh_hash(master.data) != original
    assert master.get('formation_exported') and 'formation_asset' not in master
    bpy.ops.wm.open_mainfile(filepath=str(source))
    restored = bpy.data.objects['Rock master']
    assert core.mesh_hash(restored.data) == original and restored.matrix_world == world
    # A new solid recipe needs no camera/frame. Retired settings never leak in.
    request = dict(generator='solid',guide={'verts':[], 'faces':[]},params={'fixedScale':8,'floor':4,'adaptiveDepth':True})
    worker.prepare(request, folder)
    recipe = json.loads((folder/'recipe.json').read_text())
    assert 'camera' not in recipe and 'frame' not in recipe
    assert not {'fixedScale','floor','adaptiveDepth'} & recipe['params'].keys()
formations.unregister()
print('FORMATION_ASSETS_OK', flush=True)
