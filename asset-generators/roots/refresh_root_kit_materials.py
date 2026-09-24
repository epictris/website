"""Blender background: apply the current bark maps to existing wall-root GLBs."""
from pathlib import Path
import sys
import bpy

BASE=Path(__file__).resolve().parent
sys.path.insert(0,str(BASE))
from procedural_roots import make_material_blender

for path in sorted(BASE.glob('root_*_LOD*.glb')):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(path))
    material=make_material_blender()
    for obj in bpy.context.scene.objects:
        if obj.type=='MESH':
            obj.data.materials.clear()
            obj.data.materials.append(material)
    bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',
        export_extras=True,export_animations=False,export_cameras=False,export_lights=False,
        export_vertex_color='NONE')
    print('UPDATED',path.name,flush=True)
