"""Inspect the actual side and rear geometry, not just the beauty angle."""
from pathlib import Path
import sys,json
import bpy
from mathutils import Vector,Matrix
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
from blender_build import look_at
args=sys.argv[sys.argv.index('--')+1:]
out=Path(args[0]).resolve(); target=args[1] if len(args)>1 else '02_concave'
bpy.ops.wm.open_mainfile(filepath=str(out/'polygon_rocks_v5.blend'))
scene=bpy.context.scene; scene.cycles.samples=12
scene.cycles.denoising_use_gpu=False
scene.render.threads_mode='FIXED'; scene.render.threads=8
names=[f.stem for f in sorted((out/'evaluated').glob('*.json'))]
for name in names: bpy.data.objects[name].hide_render=True
for name in (names if target=='all' else [target]):
    obj=bpy.data.objects[name]; obj.location=(0,0,0); obj.hide_render=False
    bpy.context.view_layer.update()
    spec=json.loads((out/'evaluated'/(name+'.json')).read_text())['spec']
    points=[Vector(v) for v in obj.bound_box]
    lo=Vector(tuple(min(v[i] for v in points) for i in range(3)))
    hi=Vector(tuple(max(v[i] for v in points) for i in range(3)))
    centre=(hi+lo)/2; span=max(hi-lo)
    basis=Matrix(spec['camera_basis']); right,up,toward=(basis.col[i].to_3d() for i in range(3))
    bpy.data.objects['Studio ground'].location.z=lo.z-.018
    views=[('depth',right+toward*.32+up*.08)]
    if target!='all': views+=[('rear',-toward+right*.30+up*.08)]
    for label,direction in views:
        camera=scene.camera
        camera.location=centre+direction.normalized()*span*3
        camera.data.ortho_scale=span*1.3; look_at(camera,centre)
        scene.render.filepath=str(out/'renders'/(name+'_'+label+'.png'))
        bpy.ops.render.render(write_still=True)
    obj.hide_render=True
