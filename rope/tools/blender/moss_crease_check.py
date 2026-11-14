"""blender -b --factory-startup [assets-src/scenes/river.blend] --python-exit-code 1 --python tools/blender/moss_crease_check.py

Checks the local crease mask, and Terrace.015.moss when river.blend is loaded.
Does not save the scene. Optional -- --render writes /tmp/moss-crease-fixed.png.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
import moss
from moss import build, ops, mesh_io

# A right-angled crease down the middle of a regularly triangulated sheet.
v = np.array([(x*.05, y*.05, max(0, y)*.05) for y in range(-8,9) for x in range(9)], float)
t = []
for y in range(16):
    for x in range(8):
        a = y*9+x
        t.extend(((a,a+1,a+9),(a+1,a+10,a+9)))
t = np.array(t)
keep = build._crease_vertices(v,t)
assert keep[8*9:9*9].all()
assert not keep[:6*9].any() and not keep[11*9:].any()
flat = v.copy(); flat[:,2] = 0
assert not build._crease_vertices(flat,t).any()
assert not build._crease_vertices(v,np.zeros((0,3),int)).any()
assert np.array_equal(keep,build._crease_vertices(v*3+10,t))
print('Local crease mask checks passed',flush=True)

ob = bpy.data.objects.get('Terrace.015.moss')
if ob is not None:
    moss.register()
    inputs = ops._Inputs(ob,ops.resolve_hosts(ob),bpy.context.evaluated_depsgraph_get())
    grown = build.grow(inputs.co,inputs.tri,inputs.matrix,inputs.stamps,inputs.p)
    # Inspect the skin passed to the printer, before grass is appended.
    original_print = build._print
    skin = []
    def capture(v,t,*args,**kwargs):
        skin.append((v.copy(),t.copy()))
        return original_print(v,t,*args,**kwargs)
    build._print = capture
    try:
        result = build.finish(grown,inputs.p,mesh_io.decimate)
    finally:
        build._print = original_print
    v,t = skin[0]
    reference = BVHTree.FromPolygons(grown.vertices.tolist(),grown.triangles.tolist())
    deviation = np.array([reference.find_nearest(Vector(p))[3] for p in v[t].mean(axis=1)])
    # The broken simplifier departed by 27.5 mm, producing long textured fans.
    assert deviation.max() < .015, float(deviation.max())
    assert result.in_rock == 0
    assert len(t) < len(grown.triangles)  # smooth regions are still simplified
    mesh_io.write_result(ob,result)
    print('Terrace.015:',len(grown.triangles),'->',len(t),'skin triangles;',
          'maximum deviation',float(deviation.max()),'m; no rock penetration',flush=True)
    if '--render' in sys.argv:
        scene=bpy.context.scene
        for o in scene.objects:
            o.hide_render = o not in [ob,*ops.resolve_hosts(ob)]
        cd=bpy.data.cameras.new('diagnostic.camera')
        cam=bpy.data.objects.new('diagnostic.camera',cd);scene.collection.objects.link(cam)
        cam.location=(48.3,-4,-5.4)
        cam.rotation_euler=(Vector((48.1,0,-7.4))-cam.location).to_track_quat('-Z','Y').to_euler()
        cd.type='ORTHO';cd.ortho_scale=2.8;scene.camera=cam
        ld=bpy.data.lights.new('diagnostic.sun','SUN');ld.energy=3
        light=bpy.data.objects.new('diagnostic.sun',ld);scene.collection.objects.link(light)
        light.rotation_euler=(.5,-.4,-.4)
        scene.world=bpy.data.worlds.new('diagnostic.world');scene.world.use_nodes=True
        scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.25,.25,.25,1)
        scene.render.engine='CYCLES';scene.cycles.samples=16;scene.cycles.device='CPU'
        scene.render.resolution_x=640;scene.render.resolution_y=640;scene.render.resolution_percentage=100
        scene.render.filepath='/tmp/moss-crease-fixed.png'
        bpy.ops.render.render(write_still=True)
