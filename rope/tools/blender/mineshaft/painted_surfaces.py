"""Packed, deliberately low-frequency painted surfaces for the rail reference."""
import bpy
import numpy as np

def flaking_red_paint(material):
    """Broad painted wear shapes, deliberately free of fine flake noise."""
    n=material.node_tree.nodes;l=material.node_tree.links;p=n.get('Principled BSDF')
    for node in list(n):
        if node not in [p,n.get('Material Output')]:n.remove(node)
    tc=n.new('ShaderNodeTexCoord')
    stretch=n.new('ShaderNodeVectorMath');stretch.operation='MULTIPLY';stretch.inputs[1].default_value=(1,1,1.6);l.new(tc.outputs['Object'],stretch.inputs[0])
    coarse=n.new('ShaderNodeTexNoise');coarse.inputs['Scale'].default_value=8;coarse.inputs['Detail'].default_value=1;coarse.inputs['Roughness'].default_value=.3
    l.new(stretch.outputs[0],coarse.inputs['Vector'])
    mask=n.new('ShaderNodeValToRGB');mask.name='Broad brushed paint losses';mask.color_ramp.interpolation='EASE';mask.color_ramp.elements[0].position=.59;mask.color_ramp.elements[1].position=.65
    chips=n.new('ShaderNodeTexVoronoi');chips.distance='MANHATTAN';chips.inputs['Scale'].default_value=13
    l.new(tc.outputs['Object'],chips.inputs['Vector'])
    mask.color_ramp.elements[0].position=.22;mask.color_ramp.elements[0].color=(1,1,1,1)
    mask.color_ramp.elements[1].position=.44;mask.color_ramp.elements[1].color=(0,0,0,1)
    l.new(chips.outputs['Distance'],mask.inputs[0])
    zone=n.new('ShaderNodeAttribute');zone.attribute_name='paint_wear_zone'
    loss=n.new('ShaderNodeMath');loss.operation='MULTIPLY';l.new(mask.outputs[0],loss.inputs[0]);l.new(zone.outputs['Fac'],loss.inputs[1])
    tint=n.new('ShaderNodeValToRGB');tint.color_ramp.elements[0].color=(.12,.016,.010,1);tint.color_ramp.elements[1].color=(.26,.036,.020,1)
    l.new(coarse.outputs['Fac'],tint.inputs[0])
    mix=n.new('ShaderNodeMixRGB');l.new(loss.outputs[0],mix.inputs[0]);l.new(tint.outputs[0],mix.inputs[1]);mix.inputs[2].default_value=(.10,.125,.14,1)
    l.new(mix.outputs[0],p.inputs['Base Color'])
    metal=n.new('ShaderNodeMapRange');metal.inputs['To Min'].default_value=0;metal.inputs['To Max'].default_value=.55;l.new(loss.outputs[0],metal.inputs['Value']);l.new(metal.outputs[0],p.inputs['Metallic'])
    p.inputs['Roughness'].default_value=.48
    if p.inputs['Roughness'].is_linked:l.remove(p.inputs['Roughness'].links[0])
    material.diffuse_color=(.23,.025,.012,1)

def amber_globe(material):
    """Stylised luminous glass with a small hot core and a soot-darkened crown."""
    n=material.node_tree.nodes;l=material.node_tree.links;n.clear()
    out=n.new('ShaderNodeOutputMaterial')
    def math(op,a,b=0):
        q=n.new('ShaderNodeMath');q.operation=op
        for i,v in enumerate([a,b]):
            if isinstance(v,(int,float)):q.inputs[i].default_value=v
            else:l.new(v,q.inputs[i])
        return q.outputs[0]
    tc=n.new('ShaderNodeTexCoord');sep=n.new('ShaderNodeSeparateXYZ');l.new(tc.outputs['Object'],sep.inputs[0])
    geo=n.new('ShaderNodeNewGeometry');dot=n.new('ShaderNodeVectorMath');dot.operation='DOT_PRODUCT';l.new(geo.outputs['Normal'],dot.inputs[0]);l.new(geo.outputs['Incoming'],dot.inputs[1])
    facing=math('ABSOLUTE',dot.outputs['Value'])
    # Project the viewing direction onto XY so the low core remains visible
    # from the elevated game camera instead of vanishing on the curved glass.
    radial=[]
    for source in [geo.outputs['Normal'],geo.outputs['Incoming']]:
        split=n.new('ShaderNodeSeparateXYZ');l.new(source,split.inputs[0])
        xy=n.new('ShaderNodeCombineXYZ');l.new(split.outputs['X'],xy.inputs['X']);l.new(split.outputs['Y'],xy.inputs['Y'])
        unit=n.new('ShaderNodeVectorMath');unit.operation='NORMALIZE';l.new(xy.outputs[0],unit.inputs[0]);radial.append(unit.outputs[0])
    radial_dot=n.new('ShaderNodeVectorMath');radial_dot.operation='DOT_PRODUCT';l.new(radial[0],radial_dot.inputs[0]);l.new(radial[1],radial_dot.inputs[1])
    height=math('DIVIDE',math('SUBTRACT',sep.outputs['Z'],.46),.055)
    core=math('MULTIPLY',math('POWER',math('ABSOLUTE',radial_dot.outputs['Value']),20),math('EXPONENT',math('MULTIPLY',math('MULTIPLY',height,height),-1)))
    colour=n.new('ShaderNodeMixRGB');l.new(facing,colour.inputs[0]);colour.inputs[1].default_value=(.28,.065,.006,1);colour.inputs[2].default_value=(1,.36,.045,1)
    hot=n.new('ShaderNodeMixRGB');l.new(core,hot.inputs[0]);l.new(colour.outputs[0],hot.inputs[1]);hot.inputs[2].default_value=(1,.72,.23,1)
    emission=n.new('ShaderNodeEmission');l.new(hot.outputs[0],emission.inputs['Color']);l.new(math('ADD',math('MULTIPLY',core,12),math('ADD',.6,math('MULTIPLY',facing,1.4))),emission.inputs['Strength'])
    soot=n.new('ShaderNodeBsdfPrincipled');soot.inputs['Base Color'].default_value=(.045,.018,.006,1);soot.inputs['Roughness'].default_value=1;soot.inputs['Specular IOR Level'].default_value=0
    fade=n.new('ShaderNodeMapRange');fade.clamp=True;fade.inputs['From Min'].default_value=.64;fade.inputs['From Max'].default_value=.735;fade.inputs['To Max'].default_value=.9;l.new(sep.outputs['Z'],fade.inputs['Value'])
    mix=n.new('ShaderNodeMixShader');l.new(fade.outputs[0],mix.inputs[0]);l.new(emission.outputs[0],mix.inputs[1]);l.new(soot.outputs[0],mix.inputs[2]);l.new(mix.outputs[0],out.inputs['Surface'])

def sleeper_endgrain(material,attribute='paint_coords'):
    """Cross-cut timber: off-centre annual arcs, narrow latewood and drying checks."""
    w,h=1024,512
    x,z=np.meshgrid(np.linspace(-.30,.30,w),np.linspace(-.075,.225,h))
    dx=x-.065;dz=(z+.095)*1.08
    angle=np.arctan2(dz,dx)
    radius=np.sqrt(dx*dx+dz*dz)
    # Unequal ring spacing and a gently wandering pith avoid concentric targets.
    warped=radius+.0028*np.sin(angle*5+radius*19)+.0014*np.sin(angle*11-radius*31)
    phase=warped*54+.12*np.sin(warped*57)+.06*np.sin(angle*3)
    ring=np.exp(-(np.sin(np.pi*phase)/.19)**2)
    shoulder=np.exp(-(np.sin(np.pi*(phase-.10))/.40)**2)
    wash=.007*np.sin(x*24+z*13)+.004*np.sin(x*73-z*41)
    rgb=np.zeros((h,w,3))+np.array([.175,.080,.020])
    rgb+=wash[:,:,None]*np.array([1,.55,.18])
    rgb-=ring[:,:,None]*np.array([.048,.027,.008])
    rgb+=shoulder[:,:,None]*np.array([.012,.007,.002])
    # Fine tapered radial checks; intentionally sparse and below the paint scale.
    for a,start,end in [(1.02,.20,.39),(2.04,.24,.42),(.57,.28,.40)]:
        path=a+.012*np.sin(radius*91)
        distance=np.abs(angle-path)*radius
        taper=np.clip((radius-start)/.045,0,1)*np.clip((end-radius)/.025,0,1)
        check=np.exp(-(distance/(.0008+.0007*taper))**2)*taper
        rgb-=check[:,:,None]*np.array([.063,.036,.010])
    pores=(np.sin(x*1367+np.sin(z*333))*np.sin(z*981+x*41))**12
    rgb-=pores[:,:,None]*np.array([.005,.003,.001])
    rgba=np.concatenate([np.clip(rgb,0,1),np.ones((h,w,1))],axis=2).astype(np.float32)
    im=bpy.data.images.new('Sleeper • crosscut growth rings and checks',width=w,height=h,alpha=True)
    im.colorspace_settings.name='Non-Color';im.pixels.foreach_set(rgba.ravel());im.pack()
    im['generated_by']='tools/blender/mineshaft/painted_surfaces.py'
    n=material.node_tree.nodes;l=material.node_tree.links;p=n.get('Principled BSDF')
    attr=n.new('ShaderNodeAttribute');attr.attribute_name=attribute
    sep=n.new('ShaderNodeSeparateXYZ');l.new(attr.outputs['Vector'],sep.inputs[0])
    u=n.new('ShaderNodeMath');u.operation='MULTIPLY_ADD';u.inputs[1].default_value=1/.6;u.inputs[2].default_value=.5;l.new(sep.outputs['Y'],u.inputs[0])
    v=n.new('ShaderNodeMath');v.operation='MULTIPLY_ADD';v.inputs[1].default_value=1/.3;v.inputs[2].default_value=.25;l.new(sep.outputs['Z'],v.inputs[0])
    phase=n.new('ShaderNodeMath');phase.operation='MULTIPLY_ADD';phase.inputs[1].default_value=.12;l.new(sep.outputs['X'],phase.inputs[0]);l.new(u.outputs[0],phase.inputs[2])
    coord=n.new('ShaderNodeCombineXYZ');l.new(phase.outputs[0],coord.inputs['X']);l.new(v.outputs[0],coord.inputs['Y'])
    tex=n.new('ShaderNodeTexImage');tex.image=im;tex.extension='EXTEND';l.new(coord.outputs[0],tex.inputs['Vector']);l.new(tex.outputs['Color'],p.inputs['Base Color'])

def sleeper_paint(material,timber=False):
    w,h=1024,256
    u,v=np.meshgrid(np.linspace(0,1,w),np.linspace(0,1,h))
    tau=2*np.pi
    # Colour variation follows fibres: no cross-axis sine waves or diagonal bands.
    wash=.012*np.sin(tau*v*1.3)+.006*np.sin(tau*u)*np.cos(tau*v*.7)
    light=.06*np.cos((v-.48)*np.pi)+wash
    rgb=np.zeros((h,w,3))+np.array([.145,.066,.014])
    rgb+=light[:,:,None]*np.array([1,.55,.16])
    # Broad undulating grain, soft pigment edges and an offset dry-brush ridge.
    for j,c in enumerate([.10,.29,.52,.76,.93]):
        centre=c+.014*np.sin(tau*u+j*1.7)+.004*np.sin(tau*u*2+j)
        width=.012+.01*(1+np.sin(tau*u*2+j))/2
        shadow=np.exp(-((v-centre)/width)**2)
        ridge=np.exp(-((v-centre-.032)/(.024+width))**2)
        rgb-=shadow[:,:,None]*np.array([.035,.019,.005])
        rgb+=ridge[:,:,None]*np.array([.025,.014,.004])
    # Uneven broad translucent brush passes, no hard ribbon edges.
    for j in range(7):
        x=(j*.173)%1;y=(j*.317+.12)%1
        mask=np.exp(-((u-x)/.13)**2-((v-y)/.11)**2)
        rgb+=mask[:,:,None]*np.array([.012,.006,.001])*(-1 if j%2 else 1)
    rgba=np.concatenate([np.clip(rgb,0,1),np.ones((h,w,1))],axis=2).astype(np.float32)
    im=bpy.data.images.new('Sleeper • painted ochre grain',width=w,height=h,alpha=True)
    im.colorspace_settings.name='Non-Color';im.pixels.foreach_set(rgba.ravel());im.pack()
    im['generated_by']='tools/blender/mineshaft/painted_surfaces.py'
    n=material.node_tree.nodes;l=material.node_tree.links;p=n.get('Principled BSDF')
    coord=n.new('ShaderNodeAttribute');coord.attribute_name='paint_coords'
    scale=n.new('ShaderNodeVectorMath');scale.operation='MULTIPLY';scale.inputs[1].default_value=(.52,2.85,2.85 if timber else 1)
    l.new(coord.outputs['Vector'],scale.inputs[0])
    seed=n.new('ShaderNodeAttribute');seed.attribute_name='sleeper_seed'
    mul=n.new('ShaderNodeMath');mul.operation='MULTIPLY';mul.inputs[1].default_value=.173;l.new(seed.outputs['Fac'],mul.inputs[0])
    offset=n.new('ShaderNodeCombineXYZ');l.new(mul.outputs[0],offset.inputs['X']);offset.inputs['Y'].default_value=.5
    add=n.new('ShaderNodeVectorMath');add.operation='ADD';l.new(scale.outputs[0],add.inputs[0]);l.new(offset.outputs[0],add.inputs[1])
    tex=n.new('ShaderNodeTexImage');tex.image=im;tex.extension='REPEAT';tex.interpolation='Linear';l.new(add.outputs[0],tex.inputs['Vector'])
    if timber:
        tex.projection='BOX';tex.projection_blend=.12;offset.inputs['Z'].default_value=.5
    tint=n.new('ShaderNodeMath');tint.operation='MULTIPLY_ADD';tint.inputs[1].default_value=.026;tint.inputs[2].default_value=.90;l.new(seed.outputs['Fac'],tint.inputs[0])
    mix=n.new('ShaderNodeMixRGB');mix.blend_type='MULTIPLY';mix.inputs[0].default_value=1;l.new(tex.outputs['Color'],mix.inputs[1]);l.new(tint.outputs[0],mix.inputs[2]);l.new(mix.outputs[0],p.inputs['Base Color'])

def rail_wear(mat,edge=False):
    n=mat.node_tree.nodes;l=mat.node_tree.links;p=n.get('Principled BSDF')
    tc=n.new('ShaderNodeTexCoord');stretch=n.new('ShaderNodeVectorMath');stretch.operation='MULTIPLY';stretch.inputs[1].default_value=(1.6,4,4)
    l.new(tc.outputs['Object'],stretch.inputs[0])
    noise=n.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=1;noise.inputs['Detail'].default_value=1.4;l.new(stretch.outputs[0],noise.inputs['Vector'])
    ramp=n.new('ShaderNodeValToRGB');ramp.color_ramp.interpolation='EASE'
    stops=[(.25,(.055,.052,.032)),(.75,(.13,.12,.075))] if edge else [(.27,(.037,.036,.022)),(.73,(.115,.105,.065))]
    for i,(pos,c) in enumerate(stops):
        e=ramp.color_ramp.elements[i];e.position=pos;e.color=(*c,1)
    l.new(noise.outputs['Fac'],ramp.inputs[0])
    mask=n.new('ShaderNodeMapRange');mask.inputs['From Min'].default_value=.61;mask.inputs['From Max'].default_value=.72;mask.inputs['To Max'].default_value=.78;mask.clamp=True
    l.new(noise.outputs['Fac'],mask.inputs['Value'])
    mix=n.new('ShaderNodeMixRGB');l.new(mask.outputs[0],mix.inputs[0]);l.new(ramp.outputs[0],mix.inputs[1]);mix.inputs[2].default_value=(.095,.032,.012,1)
    l.new(mix.outputs[0],p.inputs['Base Color'])
