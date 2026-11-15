"""Build hand-painted bounce mushrooms in Blender's game frame (-Y forward).
Cap origin and stem-foot heights match mushroomVariants.json; collision is separate.
"""
import bpy
import math
import random
import json
import numpy as np
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

def material(name, color, glow):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = 1
    p.inputs['Specular IOR Level'].default_value = .12
    p.inputs['Emission Color'].default_value = (*color, 1)
    p.inputs['Emission Strength'].default_value = glow
    return m

def mesh_object(name, verts, faces, materials):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    ob = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(ob)
    for m in materials: mesh.materials.append(m)
    for p in mesh.polygons: p.use_smooth = True
    return ob

specs = json.loads((ROOT/'src/level/mushroomVariants.json').read_text())
for index, spec in enumerate(specs):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for old in list(bpy.data.images):
        if old.name.startswith('Mushroom painted cap'): bpy.data.images.remove(old)
    rng = random.Random(spec['seed'])
    size = 512
    yy, xx = np.mgrid[0:size, 0:size] / (size-1)
    x, y = (xx-.5)*2, (yy-.5)*2
    radius = np.sqrt(x*x+y*y)
    # Soft overlapping washes, not repeated sine stripes or glossy highlights.
    palettes = [((.67,.62,.86),(.90,.65,.79),(.57,.81,.86)),
                ((.70,.65,.88),(.87,.69,.85),(.61,.84,.85)),
                ((.68,.78,.85),(.85,.69,.80),(.74,.84,.65)),
                ((.75,.65,.86),(.91,.69,.79),(.64,.80,.91))]
    base, pink, edge = [np.array(c) for c in palettes[index]]
    wash = np.exp(-((x+.22)**2/ .65+(y-.10)**2/.85))[:,:,None]
    rgb = np.broadcast_to(base,(size,size,3)).copy()*(1-wash*.85)+pink*wash*.85
    rim = np.clip((radius-.5)/.55,0,1)[:,:,None]*.65
    rgb=rgb*(1-rim)+edge*rim
    # Sparse, softly irregular tiny cream freckles of unequal size.
    for _ in range(26):
        angle=rng.uniform(0,math.tau); rad=math.sqrt(rng.uniform(.02,.83))
        sx,sy=rad*math.cos(angle),rad*math.sin(angle)
        r=rng.uniform(.012,.035)
        dx,dy=x-sx,y-sy
        theta=np.arctan2(dy,dx)
        dist=np.sqrt(dx*dx+(dy*rng.uniform(.85,1.2))**2)
        border=r*(1+.12*np.sin(theta*3+rng.random()*6)+.07*np.cos(theta*5))
        weight=np.clip((border-dist)/.005,0,1)[:,:,None]*.9
        rgb=rgb*(1-weight)+np.array((.92,.94,.88))*weight
    rgba=np.concatenate((rgb,np.ones((size,size,1))),axis=2).astype(np.float32)
    img=bpy.data.images.new('Mushroom painted cap',width=size,height=size)
    img.pixels.foreach_set(rgba.ravel());img.pack()
    capmat=material('Pastel painted cap',base,.35)
    p=capmat.node_tree.nodes.get('Principled BSDF')
    tex=capmat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=img
    capmat.node_tree.links.new(tex.outputs['Color'],p.inputs['Base Color'])
    capmat.node_tree.links.new(tex.outputs['Color'],p.inputs['Emission Color'])
    under=material('Soft aqua underside',(.48,.76,.79),.65)
    stemmat=material('Pale lavender stem',(.70,.72,.84),.18)

    n=64; steps=16; width=spec['width']; height=spec['capHeight']
    # A dome with a thin rolled edge and a shallow concave underside. Not an
    # ellipsoid: the silhouette must not acquire a second mirrored dome below.
    profile=[(j/steps,height*max(0,1-(j/steps)**2)**.72) for j in range(steps+1)]
    profile += [(1-.012,-.025),(.94,-.043),(.78,-.055),(.55,-.075),(.25,-.105),(0,-.11)]
    verts=[];faces=[]
    wave=[.018,.045,.012,.03][index]
    tilt=[.22,-.12,.12,.16][index]
    for r,z in profile:
        for i in range(n):
            a=math.tau*i/n
            irregular=1+.035*math.sin(3*a+index)+.02*math.cos(5*a+.7)
            px=width*.5*r*math.cos(a)*irregular
            py=width*.5*r*math.sin(a)*(.94+.04*index)*irregular
            pz=z+wave*r*r*math.sin(3*a+index)+tilt*py
            verts.append((px,py,pz))
    for j in range(len(profile)-1):
        for i in range(n):
            faces.append((j*n+i,(j+1)*n+i,(j+1)*n+(i+1)%n,j*n+(i+1)%n))
    cap=mesh_object('Painted organic cap',verts,faces,[capmat,under])
    uv=cap.data.uv_layers.new()
    for poly in cap.data.polygons:
        poly.material_index=0 if poly.index//n <= steps else 1
        for li in poly.loop_indices:
            co=cap.data.vertices[cap.data.loops[li].vertex_index].co
            uv.data[li].uv=(co.x/width+.5,co.y/width+.5)
    # A slender curved stem, widening gently into the underside and at its foot.
    verts=[];faces=[];rings=16;sides=24;foot=spec['stemHeight']
    for j in range(rings+1):
        t=j/rings
        z=-foot+(foot-.085)*t
        cx=width*.065*math.sin(math.pi*t)*(1 if index%2==0 else -1)
        cy=width*.03*math.sin(math.pi*t)
        radius=width*(.032+.016*(1-t)**5+.025*t**6)
        for i in range(sides):
            a=math.tau*i/sides
            verts.append((cx+radius*math.cos(a),cy+radius*math.sin(a),z))
    for j in range(rings):
        for i in range(sides):
            faces.append((j*sides+i,j*sides+(i+1)%sides,(j+1)*sides+(i+1)%sides,(j+1)*sides+i))
    faces.append(tuple(reversed(range(sides))))
    faces.append(tuple(rings*sides+i for i in range(sides)))
    mesh_object('Curved pale stem',verts,faces,[stemmat])
    path=ROOT/('assets-src/models/'+spec['model']+'.blend')
    path.parent.mkdir(parents=True,exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(path))
    print('Saved',path)
