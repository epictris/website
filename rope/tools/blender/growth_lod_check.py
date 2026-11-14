"""Run with blender -b --factory-startup --python-exit-code 1 --python tools/blender/growth_lod_check.py."""
import sys, math
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy, numpy as np
from mathutils import Matrix
from ivy import build as ib, mesh_io as im
from moss import build as mb
from stampbrush import lod
from stampbrush.stamps import Stamps
s=Stamps(np.array([[0.,0.,0.]]), np.array([[0.,-1.,0.]]), np.array([1.]), np.ones(1))
m=Matrix.Identity(4)
assert lod.budget(m,s)==0
m.translation.y=2.5
assert lod.budget(m,s)==0
m.translation.y=-30
assert lod.budget(m,s)==0
m.translation.y=32.5
t=lod.budget(m,s)
assert math.isclose(t, .016*lod.DEFAULT_SLOPE*30/2)
assert lod.ivy_params(ib.Params(),0)==ib.Params()
assert lod.moss_params(mb.Params(),0)==mb.Params()
co=np.array([[-1,0,-1],[1,0,-1],[1,0,1],[-1,0,1]], dtype=float)
tri=np.array([[0,1,2],[0,2,3]])
counts=[]
for y in (0,32.5):
    m.translation.y=y
    p=lod.ivy_params(ib.Params(),lod.budget(m,s))
    r=ib.build(co+np.array([0,y,0]),tri,m,s,ib.Vines.empty(),None,p)
    counts.append(len(r.triangles))
    me=bpy.data.meshes.new('test')
    im.write_result(me,r)
    images=[n.image for n in me.materials[0].node_tree.nodes if n.type=='TEX_IMAGE']
    assert images[0].size[0]==p.atlas_size
    print('IVY',y,p.detail,p.atlas_size,len(r.triangles),flush=True)
assert counts[1]<counts[0]
p=lod.moss_params(mb.Params(),t)
assert p.texel>=t and p.resolution>=t and p.grass==0 and p.kind=="TEXTURE"
assert lod.moss_params(mb.Params(), 0.01).kind == "MOUND"
assert p.ref_depth==mb.Params().ref_depth
assert math.isclose(p.dab_min, 2*t)
assert math.isclose(p.dab_max/p.dab_min, mb.Params().dab_max/mb.Params().dab_min)
# Dab scaling is independent of mesh refinement: Terrace's foreground default
# must not alter the dab size selected for a distant bank.
from dataclasses import replace
assert lod.moss_params(replace(mb.Params(), resolution=.012), t).dab_min == p.dab_min
# Regression for east-low-bank: 70 mm lens, nearest paint at ~12.14 m.
bank = lod.moss_params(mb.Params(), .02822738)
assert bank.kind == 'TEXTURE'
assert math.isclose(bank.dab_min, .05645476)
assert mb.Params().resolution == .05 and mb.Params().mound_density == 400
assert mb.Params().floor == .001 and mb.Params().texel == .005 and mb.Params().max_texture == 4096
from moss import ops as mo
from ivy import ops as io
import moss, ivy
moss.register(); ivy.register()
bpy.ops.mesh.primitive_cube_add(size=2)
host=bpy.context.object
ob=mo.create_moss(host,bpy.context.scene)
from moss.stampbrush import stamps as ms
s.position[0, 1] = -1.0  # on the cube front, not its interior
ms.write(ob.moss.stamps,s)
bpy.context.view_layer.update()
a=mo._Inputs(ob,[host],bpy.context.evaluated_depsgraph_get())
host.location.y=32.5
bpy.context.view_layer.update()
b=mo._Inputs(ob,[host],bpy.context.evaluated_depsgraph_get())
assert a.key!=b.key and b.p.texel>a.p.texel
print('MOSS cache and detail',a.p.texel,b.p.texel,flush=True)
result = mo.rebuild(ob)
assert result is not None and ob.moss.texel_used >= b.p.texel * 0.99
print('MOSS generated', ob.moss.triangles, ob.moss.texture, ob.moss.texel_used, flush=True)
assert ob.moss.kind == "MOUND" and ob["moss_built_kind"] == "TEXTURE"
assert not ob.visible_shadow
assert next(n for n in ob.data.materials[0].node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Emission Strength'].default_value == 0
assert mo.export_plan(bpy.context.scene)[0][1] == "texture"
assert len(mo.texture_paints(bpy.context.scene)) == 1
mo._export.clear()
mo.prepare_texture_paints(bpy.context.scene, {host.name})
assert len(mo.texture_paints(bpy.context.scene)) == 1  # separate bake worker path
host.location.y = 0
bpy.context.view_layer.update()
assert mo.export_plan(bpy.context.scene)[0][1] == "grow"
assert not mo.texture_paints(bpy.context.scene)
assert mo._Inputs(ob, [host], bpy.context.evaluated_depsgraph_get()).p.kind == "MOUND"
print('LOD checks passed',flush=True)
