"""Build the original painterly mineshaft kit. Run with Blender --background --python.
All source models use metres, Z up, -Y front; rails run along X.
"""
import bpy, math, random, json
from pathlib import Path
from mathutils import Vector
R = random.Random(741)
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'assets-src/studies/mineshaft'
MODELS = ROOT / 'assets-src/models'
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.save_version=0

def material(name, color, wood=False, metal=False, emission=0):
    m = bpy.data.materials.new(name); m.diffuse_color=(*color,1); m.use_nodes=True
    n=m.node_tree.nodes; l=m.node_tree.links; p=n.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(*color,1)
    p.inputs['Roughness'].default_value=.83 if not metal else .57
    p.inputs['Metallic'].default_value=.65 if metal else 0
    p.inputs['Specular IOR Level'].default_value=.28 if metal else .12
    if emission:
        p.inputs['Emission Color'].default_value=(*color,1); p.inputs['Emission Strength'].default_value=emission
    else:
        tc=n.new('ShaderNodeTexCoord')
        def noise(vector,scale,detail=2):
            node=n.new('ShaderNodeTexNoise');node.inputs['Scale'].default_value=scale;node.inputs['Detail'].default_value=detail
            l.new(vector,node.inputs['Vector']);return node
        def ramp(source,stops):
            node=n.new('ShaderNodeValToRGB');node.color_ramp.interpolation='EASE'
            for i,(pos,rgb) in enumerate(stops):
                el=node.color_ramp.elements[i] if i<2 else node.color_ramp.elements.new(pos)
                el.position=pos;el.color=(*rgb,1)
            l.new(source,node.inputs[0]);return node.outputs['Color']
        if wood:
            # Stored beam-local coordinates survive joining and Geometry Nodes.
            coord=n.new('ShaderNodeAttribute');coord.attribute_name='paint_coords'
            v=n.new('ShaderNodeVectorMath');v.operation='MULTIPLY';v.inputs[1].default_value=(1.6,28,28)
            l.new(coord.outputs['Vector'],v.inputs[0])
            fibers=noise(v.outputs[0],1,2.2)
            base=ramp(fibers.outputs['Fac'],[(.20,tuple(c*.60 for c in color)),(.43,tuple(c*.92 for c in color)),(.64,tuple(c*1.18 for c in color)),(.82,tuple(c*1.28 for c in color))])
            wash=noise(coord.outputs['Vector'],2.3,1)
            mix=n.new('ShaderNodeMixRGB');mix.blend_type='MULTIPLY';mix.inputs[0].default_value=.32
            l.new(base,mix.inputs[1]);l.new(ramp(wash.outputs['Fac'],[(.2,(.48,.54,.56)),(.8,(1,.95,.83))]),mix.inputs[2])
            l.new(mix.outputs[0],p.inputs['Base Color'])
            bump=n.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.17;bump.inputs['Distance'].default_value=.0017
            l.new(fibers.outputs['Fac'],bump.inputs['Height']);l.new(bump.outputs[0],p.inputs['Normal'])
            l.new(ramp(fibers.outputs['Fac'],[(.2,(.9,.9,.9)),(.8,(.72,.72,.72))]),p.inputs['Roughness'])
        elif metal:
            # Tight, quiet forged grain instead of the former large cloudy blobs.
            broad=noise(tc.outputs['Object'],6,1)
            base=ramp(broad.outputs['Fac'],[(.15,tuple(c*.83 for c in color)),(.85,tuple(c*1.14 for c in color))])
            stipple=noise(tc.outputs['Object'],125,2)
            brush=n.new('ShaderNodeVectorMath');brush.operation='MULTIPLY';brush.inputs[1].default_value=(2,65,65)
            l.new(tc.outputs['Object'],brush.inputs[0]);scuffs=noise(brush.outputs[0],1,1.4)
            mix=n.new('ShaderNodeMixRGB');mix.blend_type='MULTIPLY';mix.inputs[0].default_value=.16
            l.new(base,mix.inputs[1]);l.new(ramp(scuffs.outputs['Fac'],[(.25,(.55,.6,.62)),(.8,(1.2,1.2,1.2))]),mix.inputs[2])
            l.new(mix.outputs[0],p.inputs['Base Color'])
            bump=n.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.20;bump.inputs['Distance'].default_value=.0006
            l.new(stipple.outputs['Fac'],bump.inputs['Height']);l.new(bump.outputs[0],p.inputs['Normal'])
            rough=.42 if 'rubbed' in name else .59
            l.new(ramp(scuffs.outputs['Fac'],[(.18,(rough+.12,)*3),(.82,(rough-.10,)*3)]),p.inputs['Roughness'])
            p.inputs['Metallic'].default_value=.82
        else:
            soft=noise(tc.outputs['Object'],7,1)
            l.new(ramp(soft.outputs['Fac'],[(.15,tuple(c*.92 for c in color)),(.85,tuple(c*1.08 for c in color))]),p.inputs['Base Color'])

    return m
wood=[material('Timber • smoked ochre '+str(i),(.145+i*.018,.071+i*.010,.033+i*.006),True) for i in range(5)]
edge=material('Timber • scraped honey edges',(.28,.163,.075),True)
grain=material('Timber • broad ink grain',(.11,.057,.029))
lightgrain=material('Timber • dry brush',(.26,.14,.061))
iron=material('Iron • blue charcoal',(.036,.052,.061),metal=True)
wear=material('Iron • rubbed slate',(.14,.19,.205),metal=True)
rust=material('Iron • quiet rust',(.19,.095,.048))
brass=material('Lantern • aged brass',(.31,.20,.071),metal=True)
glow=material('Lantern • honey glass',(.95,.40,.065),emission=1.7)
flame=material('Lantern • flame', (1,.72,.23),emission=5)
rope=material('Rope • flax',(.36,.29,.16))
endgrain=material('Timber • cut end rings',(.18,.09,.038),True)
en=endgrain.node_tree.nodes;el=endgrain.node_tree.links
coord=next(n for n in en if n.bl_idname=='ShaderNodeAttribute')
wave=en.new('ShaderNodeTexWave');wave.wave_type='RINGS';wave.rings_direction='X'
wave.inputs['Scale'].default_value=18;wave.inputs['Distortion'].default_value=4;wave.inputs['Detail Scale'].default_value=1.5
el.new(coord.outputs['Vector'],wave.inputs['Vector'])
ramp=en.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].position=.18;ramp.color_ramp.elements[0].color=(.115,.052,.022,1)
ramp.color_ramp.elements[1].position=.72;ramp.color_ramp.elements[1].color=(.23,.127,.059,1)
el.new(wave.outputs['Color'],ramp.inputs[0]);el.new(ramp.outputs[0],en.get('Principled BSDF').inputs['Base Color'])
# Reference-led finishes: broad ochre timber, quiet olive iron and bare forged steel.
def painted_surface(name,dark,light,scale,metallic,roughness,grain_depth=0):
    m=bpy.data.materials.new(name);m.use_nodes=True;m.diffuse_color=(*light,1)
    n=m.node_tree.nodes;l=m.node_tree.links;p=n.get('Principled BSDF')
    tc=n.new('ShaderNodeTexCoord')
    v=n.new('ShaderNodeVectorMath');v.operation='MULTIPLY';v.inputs[1].default_value=scale
    if 'Sleeper' in name:
        a=n.new('ShaderNodeAttribute');a.attribute_name='paint_coords';l.new(a.outputs['Vector'],v.inputs[0])
    else:l.new(tc.outputs['Object'],v.inputs[0])
    noise=n.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=1;noise.inputs['Detail'].default_value=1.3
    l.new(v.outputs[0],noise.inputs['Vector'])
    ramp=n.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].position=.22;ramp.color_ramp.elements[0].color=(*dark,1)
    ramp.color_ramp.elements[1].position=.78;ramp.color_ramp.elements[1].color=(*light,1)
    l.new(noise.outputs['Fac'],ramp.inputs[0]);l.new(ramp.outputs[0],p.inputs['Base Color'])
    p.inputs['Metallic'].default_value=metallic;p.inputs['Roughness'].default_value=roughness;p.inputs['Specular IOR Level'].default_value=.25
    fine=n.new('ShaderNodeTexNoise');fine.inputs['Scale'].default_value=95 if metallic else 3;fine.inputs['Detail'].default_value=2
    l.new(tc.outputs['Object'] if metallic else v.outputs[0],fine.inputs['Vector'])
    remap=n.new('ShaderNodeMapRange');remap.inputs['To Min'].default_value=roughness-.08;remap.inputs['To Max'].default_value=min(.95,roughness+.10)
    l.new(fine.outputs['Fac'],remap.inputs['Value']);l.new(remap.outputs[0],p.inputs['Roughness'])
    if grain_depth:
        bump=n.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.22;bump.inputs['Distance'].default_value=grain_depth
        l.new(fine.outputs['Fac'],bump.inputs['Height']);l.new(bump.outputs[0],p.inputs['Normal'])
    return m
sleepwood=painted_surface('Sleeper • broad painted oak',(.10,.041,.009),(.22,.108,.025),(.45,5,4),0,.85,.001)
sleepedge=painted_surface('Sleeper • worn golden bevel',(.19,.085,.017),(.30,.16,.048),(.6,4,4),0,.83)
sleepend=painted_surface('Sleeper • split end timber',(.12,.050,.012),(.20,.098,.024),(.8,8,8),0,.90)
sleepstroke=painted_surface('Sleeper • soft grain shadow',(.11,.05,.012),(.14,.063,.014),(1,2,2),0,.90)
sleepglaze=painted_surface('Sleeper • broad ochre brush',(.19,.09,.017),(.23,.12,.027),(1,2,2),0,.86)
trackmetal=painted_surface('Track • aged warm iron',(.040,.037,.025),(.080,.074,.045),(2,5,4),.48,.79,.0005)
tracktop=painted_surface('Track • burnished olive steel',(.060,.057,.035),(.115,.108,.065),(1,6,5),.45,.78,.00025)
trackedge=painted_surface('Track • worn lip',(.16,.15,.10),(.23,.22,.15),(2,5,5),.55,.65)
lampmetal=painted_surface('Lantern • flaking red enamel over steel',(.065,.072,.071),(.115,.126,.12),(9,9,9),.78,.64,.0012)
lampedgemetal=painted_surface('Lantern • dark cool iron fittings',(.025,.035,.043),(.065,.085,.10),(3,3,3),.72,.45)
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from painted_surfaces import sleeper_paint, sleeper_endgrain, rail_wear, flaking_red_paint, amber_globe
flaking_red_paint(lampmetal)
sleeper_paint(sleepwood)
sleeper_endgrain(sleepend)
rail_wear(tracktop)
rail_wear(trackedge,edge=True)
from edge_weathering import weather, bake_object
from rail_profile import rail_geometry
for mat in wood:
    sleeper_paint(mat,timber=True)
    weather(mat,(.34,.19,.055),.012)
sleeper_paint(edge,timber=True)
weather(edge,(.34,.19,.055),.012,strip=True)
sleeper_endgrain(endgrain,attribute='end_coords')
weather(endgrain,(.34,.19,.055),.012)
for mat in [sleepwood,sleepedge,sleepend]:
    weather(mat,(.34,.19,.055),.022,mat==sleepedge)
for mat in [trackmetal,tracktop,trackedge]:
    weather(mat,(.23,.21,.14),.012,mat==trackedge,metal=True)
assets={}; current=None

def asset(name):
    global current
    current=bpy.data.collections.new(name); bpy.context.scene.collection.children.link(current); assets[name]=current
    if not name.startswith('guide.'):
        current.asset_mark(); current.asset_data.description='Original painterly fantasy mineshaft prop; metres, Z up, -Y front.'
    return current

def put(o,name,mat):
    o.name=name
    for c in list(o.users_collection): c.objects.unlink(o)
    current.objects.link(o)
    if mat: o.data.materials.append(mat)
    return o

def box(name,loc,dims,mat,bevel=.025):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc); o=put(bpy.context.object,name,mat)
    o.dimensions=dims; bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if mat in wood:
        for v in o.data.vertices:
            v.co.x += (.009 if v.co.z>0 else -.009) + (.006 if v.co.y>0 else -.006)
    if mat in wood:
        coords=o.data.attributes.new('paint_coords','FLOAT_VECTOR','POINT')
        for vert,value in zip(o.data.vertices,coords.data):value.vector=(vert.co.x,vert.co.y*.35/dims[1],vert.co.z*.35/dims[2])
        ends=o.data.attributes.new('end_coords','FLOAT_VECTOR','POINT')
        for vert,value in zip(o.data.vertices,ends.data):value.vector=(vert.co.x,vert.co.y*.35/dims[1],(vert.co.z/dims[2]+.5)*.13)
        seed=o.data.attributes.new('sleeper_seed','FLOAT','POINT')
        variation=R.uniform(0,4)
        for value in seed.data:value.value=variation
    if bevel:
        b=o.modifiers.new('Hand softened corners','BEVEL'); b.width=bevel; b.segments=1
        b.affect='EDGES'; b.profile=.5
        o.data.materials.append(edge if mat in wood else mat); b.material=1
        bpy.context.view_layer.objects.active=o; bpy.ops.object.modifier_apply(modifier=b.name)
        o.modifiers.new('Weighted face normals','WEIGHTED_NORMAL')
    if mat in wood:
        o.data.materials.append(endgrain)
        for face in o.data.polygons:
            if abs(face.normal.x)>.95:face.material_index=len(o.data.materials)-1
    return o

def stroke(name,points,radius,mat):
    c=bpy.data.curves.new(name,'CURVE'); c.dimensions='3D'; c.resolution_u=1
    s=c.splines.new('POLY'); s.points.add(len(points)-1)
    for p,co in zip(s.points,points): p.co=(*co,1)
    c.bevel_depth=radius; c.bevel_resolution=0; c.resolution_u=1
    o=bpy.data.objects.new(name,c); current.objects.link(o); c.materials.append(mat); return o

def beam(name,a,b,width,depth=None,marks=True):
    marks=False # Grain is painted into the material, without hard overlay ribbons.
    a,b=Vector(a),Vector(b); length=(b-a).length; d=depth or width
    o=box(name,(a+b)/2,(length,width,d),R.choice(wood),min(width*.13,.035))
    q=(b-a).to_track_quat('X','Z'); o.rotation_mode='QUATERNION'; o.rotation_quaternion=q
    # Flat, tapered paint ribbons; no raised wire-like grain.
    if marks:
        for side in [0,1]:
            for j in range(3):
                start=R.uniform(-.46,-.23)*length; end=R.uniform(.16,.46)*length
                off=(j-1)*(width if side==0 else d)*.24
                verts=[]
                for k in range(9):
                    x=start+(end-start)*k/8; wav=math.sin(k*.8+j)*.009
                    taper=math.sin(math.pi*k/8)**.6
                    half=(.005 if j%2==0 else .012)*taper
                    for sign in [-1,1]:
                        p=Vector((x,off+wav+sign*half,d/2+.0007)) if side==0 else Vector((x,-width/2-.0007,off+wav+sign*half))
                        verts.append(o.location+q@p)
                faces=[(k*2+2,k*2+3,k*2+1,k*2) for k in range(8)]
                mesh=bpy.data.meshes.new('Flat brush stroke'); mesh.from_pydata(verts,[],faces); mesh.update()
                mark=bpy.data.objects.new(name+' / brushed grain',mesh); current.objects.link(mark)
                mesh.materials.append(grain if j%2==0 else lightgrain)
        if length>.7 and R.random()<.48:
            # A quiet elongated knot, laid flat on the broad front face.
            cx=R.uniform(-.28,.28)*length; verts=[]
            for i in range(21):
                a=2*math.pi*i/20
                for r in [1,.73]:
                    p=Vector((cx+math.cos(a)*min(.10,length*.08)*r,-width/2-.001,math.sin(a)*d*.22*r))
                    verts.append(o.location+q@p)
            mesh=bpy.data.meshes.new('Painted knot'); mesh.from_pydata(verts,[],[(i*2+2,i*2+3,i*2+1,i*2) for i in range(20)]); mesh.update()
            mark=bpy.data.objects.new(name+' / knot',mesh); current.objects.link(mark); mesh.materials.append(grain)

    return o

def bolt(loc,r=.033,axis='Z'):
    bpy.ops.mesh.primitive_cylinder_add(vertices=6,radius=r,depth=.024,location=loc)
    o=put(bpy.context.object,'Forged square-cut nail',wear)
    if axis=='Y': o.rotation_euler[0]=math.pi/2
    return o

def cylinder(name,loc,r,depth,mat,verts=12,r2=None):
    bpy.ops.mesh.primitive_cone_add(vertices=verts,radius1=r,radius2=r if r2 is None else r2,depth=depth,location=loc)
    return put(bpy.context.object,name,mat)

def sleeper_array(curved,track_length,radius,repeat=True):
    # The editable base mesh is exactly ONE sleeper + both attachment sets.
    # Rails stay separate mesh objects; only this assembly is repeated.
    bpy.context.view_layer.update(); dg=bpy.context.evaluated_depsgraph_get()
    verts=[];faces=[];indices=[];mats=[];paintcoords=[]
    originals=list(current.objects)
    for o in originals:
        if o.type not in {'MESH','CURVE'}: continue
        ev=o.evaluated_get(dg);m=bpy.data.meshes.new_from_object(ev);offset=len(verts)
        verts.extend(o.matrix_world@v.co for v in m.vertices)
        attr=m.attributes.get('paint_coords')
        paintcoords.extend([v.vector.copy() for v in attr.data] if attr else [v.co.copy() for v in m.vertices])
        slots=[]
        for mat in m.materials:
            if mat is None:
                slots.append(0);continue
            if mat not in mats: mats.append(mat)
            slots.append(mats.index(mat))
        for f in m.polygons:
            faces.append(tuple(offset+i for i in f.vertices));indices.append(slots[f.material_index])
        bpy.data.meshes.remove(m)
    mesh=bpy.data.meshes.new('One wooden sleeper with chairs clips and nails');mesh.from_pydata(verts,[],faces);mesh.update()
    attr=mesh.attributes.new('paint_coords','FLOAT_VECTOR','POINT')
    for dst,co in zip(attr.data,paintcoords):dst.vector=co
    for mat in mats:mesh.materials.append(mat)
    for face,i in zip(mesh.polygons,indices):face.material_index=i
    for o in originals:bpy.data.objects.remove(o,do_unlink=True)
    ob=bpy.data.objects.new('Sleepers + attachments • adjust spacing in modifier',mesh);current.objects.link(ob)
    if not repeat:
        ob.name=current.name+' • wood and fasteners';ob['instructions']='One independent sleeper. Place freely; +X follows rail direction, long timber across Y, bottom at Z=0.'
        return ob
    ob['instructions']='Edit Sleeper spacing in the Repeat sleepers modifier. Tab edits ONE slat and its attachment points. Rail meshes are independent.'
    ng=bpy.data.node_groups.new(current.name+' • sleeper distribution','GeometryNodeTree')
    ng.interface.new_socket(name='Geometry',in_out='INPUT',socket_type='NodeSocketGeometry')
    spacing=ng.interface.new_socket(name='Sleeper spacing',in_out='INPUT',socket_type='NodeSocketFloat')
    spacing.default_value=track_length/8;spacing.min_value=.49 if curved else .45;spacing.max_value=2;spacing.description='Centre-to-centre spacing in metres. Count updates automatically; end margins remain equal.'
    ng.interface.new_socket(name='Geometry',in_out='OUTPUT',socket_type='NodeSocketGeometry')
    n=ng.nodes;l=ng.links
    inp=n.new('NodeGroupInput');out=n.new('NodeGroupOutput')
    def mathnode(op,a,b=None):
        node=n.new('ShaderNodeMath');node.operation=op
        for i,value in enumerate([a,b] if b is not None else [a]):
            if isinstance(value,(float,int)):node.inputs[i].default_value=value
            else:l.new(value,node.inputs[i])
        return node.outputs[0]
    def xyz(x,y=0,z=0):
        node=n.new('ShaderNodeCombineXYZ')
        for i,value in enumerate([x,y,z]):
            if isinstance(value,(float,int)):node.inputs[i].default_value=value
            else:l.new(value,node.inputs[i])
        return node.outputs[0]
    pitch=mathnode('MAXIMUM',inp.outputs['Sleeper spacing'],.49 if curved else .45)
    count=mathnode('MAXIMUM',mathnode('FLOOR',mathnode('DIVIDE',track_length,pitch)),1)
    margin=mathnode('MULTIPLY',mathnode('SUBTRACT',track_length,mathnode('MULTIPLY',mathnode('SUBTRACT',count,1),pitch)),.5)
    line=n.new('GeometryNodeMeshLine');line.mode='OFFSET';l.new(count,line.inputs['Count'])
    l.new(xyz(margin),line.inputs['Start Location']);l.new(xyz(pitch),line.inputs['Offset'])
    points=line.outputs['Mesh'];rotation=None
    if curved:
        position=n.new('GeometryNodeInputPosition');sep=n.new('ShaderNodeSeparateXYZ');l.new(position.outputs[0],sep.inputs[0])
        angle=mathnode('DIVIDE',sep.outputs['X'],radius)
        x=mathnode('MULTIPLY',mathnode('SINE',angle),radius)
        y=mathnode('MULTIPLY',mathnode('SUBTRACT',1,mathnode('COSINE',angle)),radius)
        setpos=n.new('GeometryNodeSetPosition');l.new(points,setpos.inputs['Geometry']);l.new(xyz(x,y),setpos.inputs['Position'])
        points=setpos.outputs[0];rotation=xyz(0,0,mathnode('ARCTAN2',sep.outputs['X'],mathnode('SUBTRACT',radius,sep.outputs['Y'])))
    seedstore=n.new('GeometryNodeStoreNamedAttribute');seedstore.data_type='FLOAT';seedstore.domain='POINT';seedstore.inputs['Name'].default_value='sleeper_seed'
    idx=n.new('GeometryNodeInputIndex');l.new(idx.outputs[0],seedstore.inputs['Value']);l.new(points,seedstore.inputs['Geometry']);points=seedstore.outputs['Geometry']
    instance=n.new('GeometryNodeInstanceOnPoints');l.new(points,instance.inputs['Points']);l.new(inp.outputs['Geometry'],instance.inputs['Instance'])
    if rotation:l.new(rotation,instance.inputs['Rotation'])
    realize=n.new('GeometryNodeRealizeInstances');l.new(instance.outputs[0],realize.inputs[0]);l.new(realize.outputs[0],out.inputs['Geometry'])
    mod=ob.modifiers.new('Repeat sleepers • spacing in metres','NODES');mod.node_group=ng
    return ob

def painted_sleeper(span,variant=0):
    # Broad, thin hand-hewn plank; the end cuts and chamfer bites differ by variant.
    rr=random.Random(204+variant*113)
    ys=[-span,-span+.07,-span+.18,-.57,-.18,.26,.57,span-.17,span-.06,span]
    verts=[];coords=[]
    for k,y in enumerate(ys):
        w=.19+rr.uniform(-.015,.015)
        bevel=.016+rr.uniform(0,.018)
        if k in [(variant+1)%3,7+(variant%2)]:bevel+=.035
        skew=([- .075,.045,.085][variant%3] * (1 if k<5 else -.65)) if k in [0,1,8,9] else rr.uniform(-.008,.008)
        profile=[(-w+.015,0),(w-.015,0),(w,.02),(w,.13-bevel),(w-bevel,.13),(-w+bevel,.13),(-w,.13-bevel),(-w,.02)]
        for x,z in profile:
            verts.append((x,y+skew*x/w,z));coords.append((y+variant*.17,x,z))
    sections=ys
    faces=[tuple(range(7,-1,-1))]
    for i in range(len(sections)-1):
        for j in range(8):faces.append((i*8+j,i*8+(j+1)%8,(i+1)*8+(j+1)%8,(i+1)*8+j))
    faces.append(tuple((len(sections)-1)*8+j for j in range(8)))
    # Cross-section winding above is CCW in XZ, extrusion is +Y: reverse faces.
    faces=[tuple(reversed(f)) for f in faces]
    mesh=bpy.data.meshes.new('Hand hewn sleeper');mesh.from_pydata(verts,[],faces);mesh.update()
    o=bpy.data.objects.new('Wooden sleeper • carved bevels',mesh);current.objects.link(o)
    for m in [sleepwood,sleepedge,sleepend]:mesh.materials.append(m)
    for f in mesh.polygons:
        f.material_index=2 if abs(f.normal.y)>.8 else (1 if .1<abs(f.normal.z)<.95 else 0)
    attr=mesh.attributes.new('paint_coords','FLOAT_VECTOR','POINT')
    for v,c in zip(attr.data,coords):v.vector=c
    # Open-ended, through-thickness splits and missing corners: each end differs.
    cuts=[[(-1,-.045,.013,.11),(1,.175,.085,.13)],
          [(-1,-.17,.10,.16)],
          [(-1,.16,.075,.20),(1,-.07,.018,.15)]][variant%3]
    for end,cx,half,depth in cuts:
        outside=end*(span+.13);inside=end*(span-depth)
        if half>.06:
            sign=1 if cx>0 else -1
            tri=[(sign*.30,outside),(sign*(abs(cx)-half),outside),(sign*.30,inside)]
        else:
            tri=[(cx-half,outside),(cx+half,outside),(cx+(.008 if end<0 else -.008),inside)]
        vs=[(x,y,z) for z in [-.08,.23] for x,y in tri]
        me=bpy.data.meshes.new('End split cutter');me.from_pydata(vs,[],[(0,2,1),(3,4,5),(0,1,4,3),(1,2,5,4),(2,0,3,5)]);me.update()
        cutter=bpy.data.objects.new('End cut tool',me);current.objects.link(cutter)
        # Normalize cutter winding so both end directions produce closed positive solids.
        import bmesh
        bm=bmesh.new();bm.from_mesh(me);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(me);bm.free()
        mod=o.modifiers.new('Split or missing end corner','BOOLEAN');mod.operation='DIFFERENCE';mod.object=cutter
        bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=mod.name);bpy.data.objects.remove(cutter,do_unlink=True)
    attr=o.data.attributes.get('paint_coords')
    for v,c in zip(o.data.vertices,attr.data):c.vector=(v.co.y+variant*.17,v.co.x,v.co.z)
    for f in o.data.polygons:
        if abs(f.normal.y)>.65:f.material_index=2
        elif o.data.materials[f.material_index] is None:f.material_index=0

def sleeper_parts(span,variant):
    painted_sleeper(span,variant)
    for side in [-1,1]:
        foot=Vector((0,side*.57,.145))
        box('Rail chair',foot,(.25,.25,.030),trackmetal,.007)
        for across in [-.115,.115]:
            seat=foot+Vector((0,across,.034))
            nail=bolt(seat,.023);nail.data.materials[0]=trackmetal
            box('Forged rail clip',seat-Vector((0,math.copysign(.024,across),-.010)),(.08,.06,.025),trackmetal,.005)

def rail_segment(curved=False,broken=False):
    length=4; radius=5; angle=math.pi/4
    def center(t):
        if curved: return Vector((radius*math.sin(t*angle),radius*(1-math.cos(t*angle)),0))
        return Vector((t*length,0,0))
    def tangent(t): return Vector((math.cos(t*angle),math.sin(t*angle),0)) if curved else Vector((1,0,0))
    sleeper_parts(.95,0)
    sleeper_array(curved,radius*angle if curved else length,radius)
    for s in [-1,1]:
        # True continuous I-section profile, no gaps between rail slices (rail_profile.py).
        intervals=([(0,.40),(.55,1)] if s<0 else [(0,.45),(.60,1)]) if broken else [(0,1)]
        for lo,hi in intervals:
            verts,faces=rail_geometry(center,tangent,s,lo,hi,broken)
            mesh=bpy.data.meshes.new('Continuous forged I rail'); mesh.from_pydata(verts,[],faces); mesh.update()
            o=bpy.data.objects.new('Rail • continuous I profile',mesh); current.objects.link(o); mesh.materials.append(trackmetal); mesh.materials.append(tracktop); mesh.materials.append(trackedge)
            for p in mesh.polygons: p.material_index=1 if p.normal.z>.6 else 0
            bevel=o.modifiers.new('Worn rail lips','BEVEL'); bevel.width=.007; bevel.segments=1; bevel.material=2
    current['snap_length_m']=4 if not curved else radius*angle; current['gauge_centres_m']=1.14
    for label,t in [('start',0),('end',1)]:
        socket=bpy.data.objects.new('socket.'+label,None); current.objects.link(socket)
        socket.location=center(t); socket.rotation_euler.z=t*angle if curved else 0; socket.empty_display_type='ARROWS'; socket.empty_display_size=.22
    current['end_translation_m']=list(center(1)); current['end_heading_degrees']=45 if curved else 0

asset('mine-rail-straight'); rail_segment()
asset('mine-rail-curve'); rail_segment(True)
asset('mine-rail-broken'); rail_segment(False,True)

asset('mine-ladder')
for x in [-.39,.39]: beam('Ladder upright',(x,0,.08),(x+.025,.10,3.25),.14,.16)
for i in range(9):
    z=.28+i*.33; y=.1*z/3.25
    beam('Worn rung',(-.43,y-.045,z),(.45,y-.045,z+.012),.12,.115)
    for x in [-.39,.415]: bolt((x,y-.115,z),.026,'Y')
    if i in [0,7]:
        for x in [-.39,.415]:
            for k in range(3):
                stroke('Rung lashing',[(x-.085,y-.105,z-.04+k*.027),(x-.085,y+.10,z-.04+k*.027),(x+.085,y+.10,z-.04+k*.027),(x+.085,y-.105,z-.04+k*.027),(x-.085,y-.105,z-.04+k*.027)],.013,rope)

def crate(name,w,d,h):
    asset(name)
    for y in [-d/2,d/2]:
        for i in range(5):
            x=-w/2+(i+.5)*w/5
            beam('Face board',(x,y,-h/2+.035),(x,y,h/2-.035),.075,w/5-.012)
    for x in [-w/2,w/2]:
        for i in range(4):
            y=-d/2+(i+.5)*d/4
            beam('Side board',(x,y,-h/2+.03),(x,y,h/2-.03),d/4-.012,.075)
    for i in range(5):
        y=-d/2+(i+.5)*d/5
        beam('Lid board',(-w/2,y,h/2),(w/2,y,h/2),d/5-.01,.075)
        beam('Base board',(-w/2,y,-h/2),(w/2,y,-h/2),d/5-.01,.075,False)
    for y in [-d/2-.06,d/2+.06]:
        for z in [-h/2+.10,h/2-.10]: beam('Crate cross batten',(-w/2-.04,y,z),(w/2+.04,y,z),.115,.17)
        beam('Diagonal brace',(-w/2+.08,y-.018,-h/2+.19),(w/2-.08,y-.018,h/2-.19),.10,.12)
        for x in [-w/2+.065,w/2-.065]:
            for z in [-h/2+.10,h/2-.10]: bolt((x,y+math.copysign(.065,y),z),.028,'Y')
    for x in [-w/2-.035,w/2+.035]:
        for y in [-d/2+.065,d/2-.065]: beam('Corner post',(x,y,-h/2),(x,y,h/2),.12,.12)
crate('mine-crate',1.15,.9,1.05)
crate('mine-crate-long',1.65,.78,.68)
asset('mine-planks')
for i in range(4):
    a=Vector((-1.2+R.uniform(-.15,.15),i*.04-.06,.07+i*.10)); b=a+Vector((2.3+R.uniform(-.15,.15),R.uniform(-.12,.12),0))
    beam('Loose split plank',a,b,.22,.10)
asset('mine-support')
for x in [-1.55,1.55]:
    beam('Heavy mine post',(x,0,.05),(x+.025,0,3.45),.29,.34)
    for z in [.25,2.9]: box('Iron post strap',(x,-.005,z),(.325,.37,.13),iron,.018)
beam('Header',(-1.95,0,3.45),(1.95,0,3.45),.36,.38)
for s in [-1,1]:
    beam('Angled knee brace',(s*1.55,-.015,2.55),(s*.83,-.015,3.38),.22,.24)
    for x,z in [(s*1.55,2.62),(s*.90,3.32)]: bolt((x,-.15,z),.045,'Y')

asset('mine-oil-lantern')
# Hurricane lantern: turned tank, clear chimney, vented hood, crossed guards,
# small crown loop and side arms joining the tank shoulders above a flat stepped foot.
def turned(name,profile,mat,segments=24):
    verts=[(r*math.cos(2*math.pi*j/segments),r*math.sin(2*math.pi*j/segments),z) for r,z in profile for j in range(segments)]
    faces=[]
    for i in range(len(profile)-1):
        for j in range(segments): faces.append((i*segments+j,i*segments+(j+1)%segments,(i+1)*segments+(j+1)%segments,(i+1)*segments+j))
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
    ob=bpy.data.objects.new(name,mesh);current.objects.link(ob);mesh.materials.append(mat)
    for f in mesh.polygons: f.use_smooth=True
    mesh.set_sharp_from_angle(angle=.55)
    return ob

def curved_tube(name,anchors,radius,mat):
    points=[]; v=[Vector(p) for p in anchors]
    for i in range(len(v)-1):
        p0=v[max(0,i-1)];p1=v[i];p2=v[i+1];p3=v[min(len(v)-1,i+2)]
        for k in range(6):
            t=k/6
            points.append(.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t))
    points.append(v[-1]);o=stroke(name,points,radius,mat);o.data.bevel_resolution=1 if name.startswith('Side arm') else 2;o.data.use_fill_caps=True
    if name.startswith('Side arm'):
        bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o;bpy.ops.object.convert(target='MESH');o=bpy.context.object
        for face in o.data.polygons:face.use_smooth=True
        o.data.set_sharp_from_angle(angle=.6)
    return o

# Folded sheet-metal edges and a broad, faceted tank shoulder.
turned('Fuel tank • broad stepped foot',[(0,.07),(.292,.07),(.30,.078),(.30,.115),(.293,.122),(.255,.122),(.255,.22),(.248,.23),(.22,.25),(.11,.29),(.105,.34),(0,.34)],lampmetal,32)
turned('Foot • rolled iron seam',[(.296,.075),(.302,.078),(.302,.086),(.296,.089)],lampedgemetal,32)
turned('Burner seat',[(0,.325),(.16,.325),(.182,.34),(.182,.357),(.14,.365),(0,.365)],lampmetal,32)
# Angled filler cap on the front shoulder and a small adjustment spindle.
cap=cylinder('Filler cap neck',(.075,-.185,.255),.038,.035,lampmetal,16);cap.rotation_euler.x=.35
cap=cylinder('Filler cap',(.075,-.193,.277),.048,.025,lampedgemetal,16);cap.rotation_euler.x=.35
axle=cylinder('Wick adjust spindle',(.17,0,.305),.011,.15,lampedgemetal,12);axle.rotation_euler.y=math.pi/2
wheel=cylinder('Wick adjust wheel',(.245,0,.305),.027,.019,lampedgemetal,16);wheel.rotation_euler.y=math.pi/2
cylinder('Wick cup',(0,0,.376),.058,.028,lampedgemetal)
cylinder('Charred wick',(0,0,.399),.012,.025,grain,8)
glass=bpy.data.materials.new('Lantern • warm emissive globe');glass.use_nodes=True
amber_globe(glass);glass.diffuse_color=(1,.36,.045,1)
profile=[(.135,.358),(.182,.385),(.214,.445),(.221,.535),(.207,.62),(.17,.702),(.145,.737)]
turned('Glass • rounded blown globe',profile+[(r-.004,z) for r,z in reversed(profile)]+[profile[0]],glass,40)
turned('Flame • amber outer teardrop',[(0,.405),(.027,.42),(.032,.455),(.019,.50),(0,.56)],glow,12)
turned('Flame • golden heart',[(0,.41),(.015,.43),(.018,.46),(0,.50)],flame,12)
# Actual round ventilation holes in both collars.
lampsoot=bpy.data.materials.new('Lantern • matte soot interior');lampsoot.use_nodes=True
sp=lampsoot.node_tree.nodes.get('Principled BSDF');sp.inputs['Base Color'].default_value=(.009,.006,.004,1);sp.inputs['Roughness'].default_value=1;sp.inputs['Specular IOR Level'].default_value=0
def vent_band(name,z,r,height,count=8):
    band=turned(name,[(r-.012,z),(r,z),(r,z+height),(r-.012,z+height),(r-.012,z)],lampmetal,48)
    for i in range(count):
        a=2*math.pi*i/count
        bpy.ops.mesh.primitive_cylinder_add(vertices=16,radius=height*.27,depth=.10,location=(r*math.cos(a),r*math.sin(a),z+height*.5))
        cutter=bpy.context.object;cutter.rotation_euler=Vector((math.cos(a),math.sin(a),0)).to_track_quat('Z','Y').to_euler()
        mod=band.modifiers.new('Open round vent','BOOLEAN');mod.operation='DIFFERENCE';mod.object=cutter
        bpy.context.view_layer.objects.active=band;bpy.ops.object.modifier_apply(modifier=mod.name);bpy.data.objects.remove(cutter,do_unlink=True)
    turned(name+' • dark interior sleeve',[(r-.022,z+.004),(r-.022,z+height-.004)],lampsoot,32)
    return band
turned('Glass top rim',[(.137,.733),(.173,.733),(.176,.737),(.176,.747),(.172,.751),(.137,.751)],lampmetal)
vent_band('Lower perforated collar',.75,.147,.075)
turned('Hood • lower flange and barrel',[(0,.82),(.215,.82),(.22,.824),(.22,.834),(.215,.838),(.16,.838),(.16,.96),(.15,.983),(0,.983)],lampmetal,32)
turned('Hood • shallow raised seam',[(.159,.91),(.164,.912),(.164,.919),(.159,.921)],lampmetal,32)
vent_band('Upper perforated collar',.98,.132,.065)
turned('Crown • shallow flat rain cap',[(0,1.042),(.192,1.042),(.197,1.046),(.197,1.055),(.192,1.059),(.16,1.066),(0,1.078)],lampmetal,32)
curved_tube('Small crown loop',[(-.052,0,1.08),(-.06,0,1.16),(-.042,0,1.205),(0,0,1.22),(.042,0,1.205),(.06,0,1.16),(.052,0,1.08)],.009,lampedgemetal)
# Reference side arms terminate in the tank shoulders; the foot stays flat.
for side in [-1,1]:
    curved_tube('Side arm • tank shoulder to hood',[(side*.205,0,.245),(side*.277,0,.30),(side*.325,0,.40),(side*.34,0,.67),(side*.315,0,.85),(side*.26,0,.925),(side*.14,0,.94)],.047,lampmetal)
# Thin X guards match the reference rather than thick cage ribs.
for side in [-1,1]:
    for direction in [-1,1]:
        curved_tube('Thin crossed globe guard',[(direction*-.135,side*.10,.36),(direction*-.125,side*.165,.42),(0,side*.227,.54),(direction*.125,side*.155,.66),(direction*.145,side*.035,.737)],.0095,lampedgemetal)
for x in [-.29,.29]:
    hinge=cylinder('Carry bail hinge',(x,0,.89),.021,.105,lampedgemetal,12);hinge.rotation_euler.x=math.pi/2
for o in current.objects:
    if o.type=='MESH' and lampmetal in list(o.data.materials):
        # Paint loss follows exposed outer rims, not arbitrary spots on the body.
        radius=max(math.hypot(v.co.x,v.co.y) for v in o.data.vertices)
        wearzone=o.data.attributes.new('paint_wear_zone','FLOAT','POINT')
        for v,value in zip(o.data.vertices,wearzone.data):
            value.value=max(0,min(1,(math.hypot(v.co.x,v.co.y)/max(radius,.001)-.88)/.08))
            if o.name.startswith('Side arm'):
                value.value=max(0,1-abs(v.co.z-.89)/.055)
    # Preserve the existing library pivot so placed lanterns do not move.
    o.location.z-=1.534

asset('mine-pickaxe')
beam('Ash handle',(0,0,.08),(.12,0,1.3),.095,.105)
pts=[(-.62,0,1.09),(-.40,0,1.27),(-.13,0,1.34),(.15,0,1.34),(.4,0,1.27),(.62,0,1.06)]
verts=[]
for i,p in enumerate(pts):
    radius=[.003,.042,.075,.075,.042,.003][i]
    for j in range(4):
        a=math.pi/4+j*math.pi/2; verts.append((p[0],p[1]+math.cos(a)*radius,p[2]+math.sin(a)*radius))
faces=[(0,3,2,1),(20,21,22,23)]+[(i*4+j,i*4+(j+1)%4,(i+1)*4+(j+1)%4,(i+1)*4+j) for i in range(5) for j in range(4)]
mesh=bpy.data.meshes.new('Tapered forged pick'); mesh.from_pydata(verts,[],faces); mesh.update()
o=bpy.data.objects.new('Faceted pointed pick head',mesh); current.objects.link(o); mesh.materials.append(iron); mesh.materials.append(wear)
for p in mesh.polygons: p.material_index=int(p.normal.z>.5)
box('Socket',(.10,0,1.30),(.19,.17,.20),iron)
for k in range(6): cylinder('Leather grip',(0.025,0,.23+k*.032),.058,.022,rope,8)

# Ground-pivot props sit exactly on Z=0. Centre/hanging pivots are intentional.
bpy.context.view_layer.update()
for name in ['mine-ladder','mine-planks','mine-support','mine-pickaxe']:
    col=assets[name]
    floor=min((o.matrix_world @ Vector(v)).z for o in col.objects if o.type=='MESH' for v in o.bound_box)
    for o in col.objects: o.location.z-=floor
# Independent sleeper assets and matching rail-only collections.
for i,name in enumerate(['mine-sleeper-a','mine-sleeper-b','mine-sleeper-c']):
    asset(name);sleeper_parts([.95,.90,1.0][i],i);sleeper_array(False,4,5,repeat=False)
# Only the current rail asset participates in each bake. Shader AO is local.
for name,col in list(assets.items()):
    track=name.startswith('mine-rail-') or name.startswith('mine-sleeper-')
    timber=any(o.type=='MESH' and any(m in wood for m in o.data.materials) for o in col.objects)
    if not (track or timber):continue
    for c in list(bpy.context.scene.collection.children):bpy.context.scene.collection.children.unlink(c)
    bpy.context.scene.collection.children.link(col)
    bpy.context.view_layer.update()
    for o in list(col.objects):
        if o.type=='MESH' and (track or any(m in wood for m in o.data.materials)):
            bake_object(o,1024 if track else 256)
for base_name in ['mine-rail-straight','mine-rail-curve','mine-rail-broken']:
    asset(base_name+'-bare')
    for src in assets[base_name].objects:
        if src.name.startswith('Sleepers +'):continue
        ob=src.copy();current.objects.link(ob)
    for key in assets[base_name].keys():current[key]=assets[base_name][key]
# Save clean individual library files; no set dressing or preview lights in them.
scene=bpy.context.scene
scene.unit_settings.system='METRIC'
for name,col in assets.items():
    for c in list(scene.collection.children): scene.collection.children.unlink(c)
    scene.collection.children.link(col)
    scene['asset_notes']='Metres. Z up, -Y front. Rails run +X from start. Crates centre pivot; lantern hanging pivot; other props ground pivot.'
    bpy.data.libraries.write(str(MODELS/(name+'.blend')), {scene}, fake_user=False, compress=True)
for c in list(scene.collection.children): scene.collection.children.unlink(c)
for c in assets.values():
    c.asset_clear()
    if not c.name.startswith('mine-sleeper-') and not c.name.endswith('-bare'):scene.collection.children.link(c)
for name in ['mine-rail-straight','mine-rail-curve','mine-rail-broken']:
    col=assets[name]
    for o in list(col.objects):
        if o.name.startswith('Sleepers +'):col.objects.unlink(o)
    for i in range(8):
        src=list(assets[['mine-sleeper-a','mine-sleeper-b','mine-sleeper-c'][i%3]].objects)[0]
        o=src.copy();col.objects.link(o)
        distance=(i+.5)*((5*math.pi/4)/8 if name=='mine-rail-curve' else .5)
        a=distance/5 if name=='mine-rail-curve' else 0
        o.location=(5*math.sin(a),5*(1-math.cos(a)),0) if name=='mine-rail-curve' else (distance,0,0)
        o.rotation_euler.z=a+(math.pi if i%2 else 0)
bpy.context.view_layer.update()
# A composed inspection scene, all source pieces remain individually editable.
placements={
'mine-rail-straight':((-3.6,-1.4,0),0),
'mine-rail-curve':((.8,-1.4,0),0),
'mine-rail-broken':((-3.5,-4,0),0),
'mine-support':((-2.5,1.2,0),0),
'mine-ladder':((.35,1.65,0),-.13),
'mine-crate':((2.15,1.3,.57),-.12),
'mine-crate-long':((3.7,2.2,.38),.10),
'mine-planks':((2.55,3.4,0),-.2),
'mine-oil-lantern':((-2.45,1.0,3.2),0),
'mine-pickaxe':((1.3,1.15,0),-.3),
}
for name,(loc,angle) in placements.items():
    from mathutils import Matrix
    mat=Matrix.Translation(Vector(loc))@Matrix.Rotation(angle,4,'Z')
    for o in assets[name].objects: o.matrix_world=mat@o.matrix_world
    if name in ['mine-crate','mine-crate-long']:
        bpy.context.view_layer.update()
        bottom=min((o.matrix_world@Vector(v)).z for o in assets[name].objects if o.type=='MESH' for v in o.bound_box)
        for o in assets[name].objects: o.location.z-=bottom
asset('guide.presentation')
stroke('Header lantern hook',[(-2.45,1,3.30),(-2.45,1,3.23),(-2.45,1,3.14),(-2.42,1,3.12),(-2.39,1,3.17)],.018,iron)
base=material('Stage • cave slate',(.047,.075,.085))
box('Display ground',(0,0,-.12),(12,11,.24),base,.15)
# Duplicate standing lantern for close viewing beside boxes.
standing_lantern=[]
for src in list(assets['mine-oil-lantern'].objects):
    o=src.copy(); o.data=src.data.copy(); current.objects.link(o); o.location+=Vector((5.9,.1,-2.08)); standing_lantern.append(o)
bpy.context.view_layer.update()
bottom=min((o.matrix_world@Vector(v)).z for o in standing_lantern if o.type in {'MESH','CURVE'} for v in o.bound_box)
for o in standing_lantern: o.location.z-=bottom
world=bpy.data.worlds.new('Cool cave fill'); scene.world=world; world.use_nodes=True
world.node_tree.nodes['Background'].inputs[0].default_value=(.14,.21,.28,1)
world.node_tree.nodes['Background'].inputs[1].default_value=.4

def area(name,loc,power,color,size):
    bpy.ops.object.light_add(type='AREA',location=loc); o=put(bpy.context.object,name,None); o.data.energy=power; o.data.color=color; o.data.shape='DISK'; o.data.size=size; o.rotation_euler=(Vector((0,0,1))-o.location).to_track_quat('-Z','Y').to_euler()
area('Warm broad key',(-3,-4,9),1500,(1,.82,.61),7)
area('Cool cave rim',(3,5,7),1800,(.43,.76,1),6)
area('Soft front fill',(1,-6,4),450,(.68,.82,1),5)
bpy.ops.object.camera_add(location=(10,-17,12)); cam=put(bpy.context.object,'Kit overview',None)
cam.rotation_euler=(Vector((0,0,1))-cam.location).to_track_quat('-Z','Y').to_euler(); cam.data.type='ORTHO'; cam.data.ortho_scale=13.7; scene.camera=cam
scene.render.engine='CYCLES'; scene.cycles.samples=48; scene.render.threads_mode='FIXED'; scene.render.threads=12; scene.cycles.use_denoising=True
scene.render.resolution_x=1800; scene.render.resolution_y=1350; scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
for screen in bpy.data.screens:
    for ar in screen.areas:
        if ar.type=='VIEW_3D':
            ar.spaces.active.region_3d.view_perspective='CAMERA'; ar.spaces.active.shading.type='MATERIAL'
bpy.ops.object.select_all(action='DESELECT')
scene.render.filepath=str(OUT/'mineshaft-kit.png')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'mineshaft-kit.blend'))
bpy.ops.render.render(write_still=True)
report={name:{'objects':len(c.objects),'mesh_vertices':sum(len(o.data.vertices) for o in c.objects if o.type=='MESH')} for name,c in assets.items()}
(OUT/'inventory.json').write_text(json.dumps(report,indent=2))
print('MINESHAFT KIT COMPLETE',json.dumps(report))
