"""Real worker process, multi-asset library import, packing and source protection."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import bpy
from mathutils import Matrix
HERE=Path(__file__).parent.resolve()
sys.path.insert(0,str(HERE))
import formations
from formations import asset_export, core, assets

bpy.ops.wm.read_factory_settings(use_empty=True)
formations.register()
with tempfile.TemporaryDirectory(prefix='formation-export-file-') as folder:
    folder=Path(folder)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2)
    source=bpy.context.object;source.name='Wall master'
    source['formation_asset']=True
    source.formation_representation='SURFACE'
    source.formation_texture_resolution='128'
    mat=bpy.data.materials.new('Stone');mat.use_nodes=True
    source.data.materials.append(mat)
    source.location=(2,5,1)
    other=source.copy();other.data=source.data.copy();other.name='Other master'
    bpy.context.scene.collection.objects.link(other)
    other.formation_representation='FULL';other.location.x+=5
    hidden=bpy.data.collections.new('Library masters');bpy.context.scene.collection.children.link(hidden)
    hidden.hide_render=True
    unused=source.copy();hidden.objects.link(unused);unused.name='Hidden master'
    # The library contains several masters; importing one must not place the others.
    library=folder/'rocks.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(library))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.cursor.location=(4,12,3)
    assert bpy.ops.formations.choose_asset(filepath=str(library),object_name='Wall master')=={'FINISHED'}
    imported=bpy.context.object
    assert imported.location==bpy.context.scene.cursor.location
    assert len(bpy.context.scene.objects)==1 and imported.get('formation_asset')
    imported.formation_representation='SURFACE';imported.formation_texture_resolution='128'
    expected=imported.matrix_world.copy()
    master_hash=core.mesh_hash(imported.data)
    authoring=folder/'river.blend';output=folder/'river-export.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(authoring))
    source_sha=hashlib.sha256(authoring.read_bytes()).hexdigest()
    # Verify snapshot-copy semantics used by the UI, including unsaved edits.
    imported.location.x+=1
    snapshot=folder/'snapshot.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(snapshot),copy=True,relative_remap=True)
    assert bpy.data.filepath==str(authoring)
    assert hashlib.sha256(authoring.read_bytes()).hexdigest()==source_sha
    request=folder/'request.json'
    request.write_text(json.dumps(dict(output=str(output),cache=str(folder/'cache'),scene=bpy.context.scene.name,source=str(authoring))))
    command=[bpy.app.binary_path,'-b','--factory-startup','--disable-autoexec','-noaudio','-t','2',str(snapshot),
             '--python-exit-code','1','--python',str(HERE/'formations/asset_worker.py'),'--',str(request)]
    subprocess.run(command,check=True,timeout=90,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    assert hashlib.sha256(authoring.read_bytes()).hexdigest()==source_sha
    assert core.mesh_hash(imported.data)==master_hash
    bpy.ops.wm.open_mainfile(filepath=str(output))
    result=next(ob for ob in bpy.context.scene.objects if ob.get('formation_exported'))
    assert asset_export.triangles(result.data)==2
    assert result.location.x==5 and tuple(result.location[1:])==(12.,3.)
    assert bpy.context.scene.get('formation_export_build')
    assert all(im.packed_file for im in bpy.data.images if im.type=='IMAGE' and im.size[0]>0)
    # The production material classifier must pass these maps straight through;
    # a real glTF write must carry normals, colour, roughness and alpha.
    import scene_export
    material=result.data.materials[0]
    assert not scene_export.procedural_base_colors(material)
    assert not scene_export.procedural_normals(material)
    glb=folder/'wall.glb'
    bpy.ops.export_scene.gltf(filepath=str(glb),export_format='GLB',export_extras=True)
    raw=glb.read_bytes()
    size=int.from_bytes(raw[12:16],'little')
    document=json.loads(raw[20:20+size])
    shipped=document['materials'][0]
    assert 'normalTexture' in shipped
    assert 'baseColorTexture' in shipped['pbrMetallicRoughness']
    assert 'metallicRoughnessTexture' in shipped['pbrMetallicRoughness']
    assert shipped.get('alphaMode') in ('MASK','BLEND')
    # A failed rebuild must leave a previous output intact.
    output_sha=hashlib.sha256(output.read_bytes()).hexdigest()
    bpy.ops.wm.open_mainfile(filepath=str(snapshot))
    bpy.context.scene.objects[0]['formation_export_mode']='INVALID'
    bpy.ops.wm.save_as_mainfile(filepath=str(snapshot))
    failed=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=90)
    assert failed.returncode and hashlib.sha256(output.read_bytes()).hexdigest()==output_sha
print('FORMATION_EXPORT_FILE_OK',flush=True)
