"""Rock-style convex edge weathering, baked so Material Preview shows the result.
Adapted from formations/slate.py's Bevel-dot-normal + short AO gate. Scales and
colours are specific to these smaller timber/iron assets; rock code is untouched.
"""
import bpy

def weather(mat,color,radius,strip=False,metal=False):
    n=mat.node_tree.nodes;l=mat.node_tree.links;p=n.get('Principled BSDF')
    source=p.inputs['Base Color'].links[0].from_socket
    def math(op,a,b):
        q=n.new('ShaderNodeMath');q.operation=op
        for i,v in enumerate([a,b]):
            if isinstance(v,(float,int)):q.inputs[i].default_value=v
            else:l.new(v,q.inputs[i])
        return q.outputs[0]
    def remap(src,lo,hi,outlo,outhi):
        q=n.new('ShaderNodeMapRange');q.clamp=True
        for key,v in [('From Min',lo),('From Max',hi),('To Min',outlo),('To Max',outhi)]:q.inputs[key].default_value=v
        l.new(src,q.inputs['Value']);return q.outputs[0]
    bevel=n.new('ShaderNodeBevel');bevel.name='Rock-style edge detection';bevel.samples=8;bevel.inputs['Radius'].default_value=radius
    geo=n.new('ShaderNodeNewGeometry');dot=n.new('ShaderNodeVectorMath');dot.operation='DOT_PRODUCT'
    l.new(bevel.outputs[0],dot.inputs[0]);l.new(geo.outputs['Normal'],dot.inputs[1])
    mask=remap(dot.outputs['Value'],.995,.92,0,.72)
    if strip:mask=math('MAXIMUM',mask,.45)
    ao=n.new('ShaderNodeAmbientOcclusion');ao.samples=8;ao.only_local=True;ao.inputs['Distance'].default_value=.045
    gate=remap(ao.outputs['AO'],.80,.97,0,1)
    tc=n.new('ShaderNodeTexCoord');noise=n.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=18;noise.inputs['Detail'].default_value=2
    l.new(tc.outputs['Object'],noise.inputs['Vector'])
    mask=math('MULTIPLY',math('MULTIPLY',mask,gate),remap(noise.outputs['Fac'],.2,.8,.55,1))
    if metal:
        broad=n.new('ShaderNodeTexNoise');broad.inputs['Scale'].default_value=3.5;broad.inputs['Detail'].default_value=1
        l.new(tc.outputs['Object'],broad.inputs['Vector'])
        mask=math('MULTIPLY',mask,remap(broad.outputs['Fac'],.30,.68,.08,1))
    dark=n.new('ShaderNodeMixRGB');dark.blend_type='MULTIPLY';dark.inputs[0].default_value=1;l.new(source,dark.inputs[1]);l.new(remap(ao.outputs['AO'],.35,1,.7,1),dark.inputs[2])
    mix=n.new('ShaderNodeMixRGB');mix.inputs[2].default_value=(*color,1);l.new(mask,mix.inputs[0]);l.new(dark.outputs[0],mix.inputs[1]);l.new(mix.outputs[0],p.inputs['Base Color'])
    shade=n.new('ShaderNodeBevel');shade.samples=4;shade.inputs['Radius'].default_value=radius*.35
    if p.inputs['Normal'].is_linked:l.new(p.inputs['Normal'].links[0].from_socket,shade.inputs['Normal'])
    l.new(shade.outputs[0],p.inputs['Normal'])

def bake_object(ob,size=1024):
    """Bake colour only, preserving original materials in unused editable slots."""
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=24
    scene.render.threads_mode='FIXED';scene.render.threads=12
    disabled=[]
    for m in list(ob.modifiers):
        if m.type=='NODES':disabled.append((m,m.show_viewport,m.show_render));m.show_viewport=False;m.show_render=False
        else:
            bpy.context.view_layer.objects.active=ob;bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.ops.object.select_all(action='DESELECT');ob.select_set(True);bpy.context.view_layer.objects.active=ob
    bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.uv.smart_project(angle_limit=1.15,island_margin=.025);bpy.ops.object.mode_set(mode='OBJECT')
    image=bpy.data.images.new(ob.name+' • baked edge paint',width=size,height=size,alpha=False)
    image['generated_by']='tools/blender/mineshaft/edge_weathering.py'
    sources=list(ob.data.materials);temp=[]
    for mat in sources:
        n=mat.node_tree.nodes;l=mat.node_tree.links;p=n.get('Principled BSDF');out=n.get('Material Output')
        original=out.inputs['Surface'].links[0].from_socket
        emission=n.new('ShaderNodeEmission');l.new(p.inputs['Base Color'].links[0].from_socket,emission.inputs[0]);l.new(emission.outputs[0],out.inputs['Surface'])
        target=n.new('ShaderNodeTexImage');target.image=image;n.active=target
        temp.append((mat,original,emission,target))
    scene.render.bake.margin=12;scene.render.bake.use_clear=True
    bpy.ops.object.bake(type='EMIT')
    image.pack()
    for mat,original,emission,target in temp:
        mat.node_tree.links.new(original,mat.node_tree.nodes.get('Material Output').inputs['Surface']);mat.node_tree.nodes.remove(emission);mat.node_tree.nodes.remove(target)
    offset=len(sources)
    for old in sources:
        mat=bpy.data.materials.new(old.name+' • baked');mat.use_nodes=True;p=mat.node_tree.nodes.get('Principled BSDF');op=old.node_tree.nodes.get('Principled BSDF')
        tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=image;mat.node_tree.links.new(tex.outputs['Color'],p.inputs['Base Color'])
        p.inputs['Metallic'].default_value=op.inputs['Metallic'].default_value;p.inputs['Roughness'].default_value=op.inputs['Roughness'].default_value
        mat.diffuse_color=old.diffuse_color;ob.data.materials.append(mat)
    for f in ob.data.polygons:f.material_index+=offset
    for m,v,r in disabled:m.show_viewport=v;m.show_render=r
    ob['edge_weathering']='Packed colour bake of rock-style convex Bevel/normal mask, chamfer paint and AO gate. Original authoring materials retained in unused slots.'
    print('BAKED_EDGE_PAINT',ob.name,flush=True)
