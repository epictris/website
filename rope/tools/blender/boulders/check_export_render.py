"""Re-import an exported GLB to inspect its portable material."""
from pathlib import Path
import sys,json
import bpy
from mathutils import Matrix,Vector
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
from blender_build import make_stage,add_area,look_at
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
scene,camera,ground=make_stage(20)
bpy.ops.import_scene.gltf(filepath=str(ROOT/'assets/models/02_concave.glb'))
obj=next(o for o in bpy.context.selected_objects if o.type=='MESH')
spec=json.loads((ROOT/'assets/evaluated/02_concave.json').read_text())['spec']
points=[obj.matrix_world@Vector(c) for c in obj.bound_box]
lo=Vector(tuple(min(p[i] for p in points) for i in range(3)))
hi=Vector(tuple(max(p[i] for p in points) for i in range(3)))
center=(lo+hi)/2; span=max(hi-lo)
basis=Matrix(spec['camera_basis'])
camera.location=center+(basis.col[2]+basis.col[0]*.22+basis.col[1]*.08).normalized()*span*3
camera.data.ortho_scale=span*1.3; look_at(camera,center)
ground.location.z=lo.z-.018
add_area('Large soft key',(1,-4,7),1350,5,(1,.90,.79),(0,0,1))
add_area('Cool fill',(-5,-1,3),420,4,(.74,.84,1),(0,0,1))
add_area('Upper rim',(2,4,6),1900,3,(1,.97,.92),(0,0,1))
scene.render.filepath=str(ROOT/'assets/export_material_preview.png')
bpy.ops.render.render(write_still=True)
