"""Update the saved rocks' materials and exports without altering their meshes."""
from pathlib import Path
import sys,json
import bpy
from mathutils import Matrix,Vector
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
from stone_materials import stone_material
from blender_build import export_model,look_at
out=ROOT/'assets'
bpy.ops.wm.open_mainfile(filepath=str(out/'polygon_rocks.blend'))
scene=bpy.context.scene
scene.cycles.samples=20
camera=scene.camera
ground=bpy.data.objects['Studio ground']
rocks=[]
for f in sorted((out/'evaluated').glob('*.json')):
    spec=json.loads(f.read_text())['spec']
    obj=bpy.data.objects[spec['name']]
    rocks.append((obj,spec,obj.location.copy()))
    for i,old in enumerate(list(obj.data.materials)):
        mat=stone_material(spec['name']+f' / structure-aware stone {i}',spec['color'],.91+i*.045,spec)
        old.user_remap(mat)
    obj.hide_render=True
for obj,spec,layout in rocks:
    obj.location=(0,0,0)
    obj.hide_render=False
    print('Updating textures: '+obj.name,flush=True)
    export_model(obj,out/'models'/obj.name)
    obj.hide_render=False
    points=[Vector(c) for c in obj.bound_box]
    lo=Vector(tuple(min(p[i] for p in points) for i in range(3)))
    hi=Vector(tuple(max(p[i] for p in points) for i in range(3)))
    center=(lo+hi)/2; span=max(hi-lo)
    basis=Matrix(spec['camera_basis'])
    right,up,toward=(basis.col[i].to_3d() for i in range(3))
    ground.location.z=lo.z-.018
    camera.location=center+(toward+right*.22+up*.08).normalized()*span*3
    camera.data.ortho_scale=span*1.3; look_at(camera,center)
    scene.render.filepath=str(out/'renders'/(obj.name+'.png'))
    bpy.ops.render.render(write_still=True)
    projected=[basis.transposed()@v.co for v in obj.data.vertices]
    vmin=Vector(tuple(min(p[i] for p in projected) for i in range(3)))
    vmax=Vector(tuple(max(p[i] for p in projected) for i in range(3)))
    viewcenter=basis@((vmin+vmax)/2)
    camera.location=viewcenter+toward*span*3
    camera.data.ortho_scale=max(vmax.x-vmin.x,vmax.y-vmin.y)*1.16
    look_at(camera,viewcenter)
    ground.hide_render=True
    scene.render.filepath=str(out/'renders'/(obj.name+'_side.png'))
    bpy.ops.render.render(write_still=True)
    ground.hide_render=False
    obj.hide_render=True
    obj.location=layout
for obj,_,_ in rocks:
    obj.hide_render=False
ground.location.z=-.018
camera.location=(10,-17,15); camera.data.ortho_scale=16
look_at(camera,(0,1.8,1))
bpy.ops.wm.save_as_mainfile(filepath=str(out/'polygon_rocks.blend'))
print('MATERIAL_REFRESH_COMPLETE',flush=True)
