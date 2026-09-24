"""Painted slate, chipped pale edges, interrupted seams and restrained pitting."""
import bpy

def stone_material(name,color,variation,spec=None):
    mat=bpy.data.materials.new(name); mat.use_nodes=True
    mat.diffuse_color=(*color,1)
    n,l=mat.node_tree.nodes,mat.node_tree.links; n.clear()
    def node(kind,label,x,y):
        a=n.new(kind); a.label=label; a.location=(x,y); return a
    def ramp(label,source,stops,x,y,interp='LINEAR'):
        a=node('ShaderNodeValToRGB',label,x,y); a.color_ramp.interpolation=interp
        for i,(pos,rgb) in enumerate(stops):
            e=a.color_ramp.elements[i] if i<2 else a.color_ramp.elements.new(pos)
            e.position=pos; e.color=(*rgb,1)
        l.new(source,a.inputs[0]); return a.outputs[0]
    def noise(label,source,scale,detail,x,y):
        a=node('ShaderNodeTexNoise',label,x,y)
        a.inputs['Scale'].default_value=scale; a.inputs['Detail'].default_value=detail
        l.new(source,a.inputs['Vector']); return a
    def mix(label,a,b,factor,x,y,mode='MIX'):
        m=node('ShaderNodeMixRGB',label,x,y); m.blend_type=mode
        if isinstance(factor,(int,float)): m.inputs[0].default_value=factor
        else: l.new(factor,m.inputs[0])
        for v,socket in [(a,m.inputs[1]),(b,m.inputs[2])]:
            if isinstance(v,tuple): socket.default_value=(*v,1)
            else: l.new(v,socket)
        return m.outputs[0]
    out=node('ShaderNodeOutputMaterial','Surface',1650,100)
    bs=node('ShaderNodeBsdfPrincipled','Dry painted stone',1410,100)
    bs.inputs['Roughness'].default_value=.83; bs.inputs['Specular IOR Level'].default_value=.22
    l.new(bs.outputs[0],out.inputs[0])
    tex=node('ShaderNodeTexCoord','Local rock coordinates',-1600,200); coord=tex.outputs['Object']
    broad=noise('Large warm and cool mineral clouds',coord,1.35,2,-1390,570)
    palette=ramp('Slate blue / neutral ash / warm grey',broad.outputs['Fac'],[
        (.20,(.048,.067,.096)),(.40,(.085,.111,.145)),
        (.57,(.155,.166,.174)),(.77,(.24,.23,.205))],-1160,600,'EASE')
    geo=node('ShaderNodeNewGeometry','Plane orientation and wear',-1370,-640)
    sep=node('ShaderNodeSeparateXYZ','Face direction',-1150,-690)
    l.new(geo.outputs['Normal'],sep.inputs[0])
    facing=ramp('Upper faces and blue lower faces',sep.outputs['Z'],[
        (0,(.55,.61,.70)),(.85,(1.18,1.15,1.08))],-930,-620)
    base=mix('Directional face pigment',palette,facing,.58,-650,650,'MULTIPLY')
    base=mix('Individual chunk mineral tone',base,(variation,variation,variation),1,-650,850,'MULTIPLY')
    cells=node('ShaderNodeTexVoronoi','Angular mineral islands',-1390,210)
    cells.distance='CHEBYCHEV'; cells.inputs['Scale'].default_value=5.8
    l.new(coord,cells.inputs['Vector'])
    islands=ramp('Quiet broken mineral patches',cells.outputs['Distance'],[
        (.20,(.77,.79,.82)),(.31,(.90,.91,.92)),(.47,(1.02,1.02,1.02))],-1160,230,'CONSTANT')
    base=mix('Mineral mottling',base,islands,.48,-390,650,'MULTIPLY')
    # Only shade real concave joints in the mesh. A spatial crack pattern
    # cannot know which faces form separate blocks, so it is not used here.
    crease=ramp('Existing recessed joints only',geo.outputs['Pointiness'],[
        (.458,(.32,.38,.46)),(.488,(.76,.80,.85)),
        (.499,(1,1,1))],-460,0,'EASE')
    base=mix('Depth colour in sculpted seams',base,crease,.42,-100,490,'MULTIPLY')
    edge=ramp('Selective convex edge highlights',geo.outputs['Pointiness'],[
        (.505,(0,0,0)),(.548,(.68,.68,.68))],-390,-550)
    base=mix('Pale freshly chipped edges',base,(.30,.32,.33),edge,160,460)
    ao=node('ShaderNodeAmbientOcclusion','Shadow inside deep joints',180,90)
    ao.inputs['Distance'].default_value=.26
    base=mix('Crevice colour depth',base,ao.outputs['Color'],.65,420,460,'MULTIPLY')
    l.new(base,bs.inputs['Base Color'])
    chipb=node('ShaderNodeBump','Shallow mineral chips',720,-60)
    chipb.inputs['Strength'].default_value=.15; chipb.inputs['Distance'].default_value=.009
    l.new(islands,chipb.inputs['Height'])
    pits=noise('Sparse small surface pits',coord,32,1,180,-360)
    pit=ramp('Only occasional pits',pits.outputs['Fac'],[
        (.25,(.1,.1,.1)),(.34,(1,1,1))],430,-330)
    bump=node('ShaderNodeBump','Sparse pitting',1000,-90)
    bump.inputs['Strength'].default_value=.20; bump.inputs['Distance'].default_value=.009
    l.new(pit,bump.inputs['Height']); l.new(chipb.outputs['Normal'],bump.inputs['Normal'])
    l.new(bump.outputs['Normal'],bs.inputs['Normal'])
    return mat
