"""Original stylized minecart. Run from repo root with blender -b --python this_file [-- VARIANT].
Metres, Z up, X travel; ground pivot; 1.14 m wheel tread gauge.
Variants: none builds `minecart`; `no-left-wheels` builds `minecart-no-left-wheels`,
the same cart with both wheels on its left (-X, seen from the side) gone, bare axle stubs left.
"""
import bpy, bmesh, math, sys
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[3]
# The hopper floor ends at X=+-1.08; each axle bearing (0.24 m long) sits
# flush with that edge, so the axles are as far out as the base allows.
AXLE_X=1.08-.12
VARIANTS={'':(),'no-left-wheels':(-AXLE_X,)}
VARIANT=sys.argv[sys.argv.index('--')+1] if '--' in sys.argv[:-1] else ''
if VARIANT not in VARIANTS:raise SystemExit(f'unknown variant {VARIANT!r}; one of {sorted(v for v in VARIANTS if v)}')
MISSING_WHEEL_X=VARIANTS[VARIANT]
NAME='minecart'+('-'+VARIANT if VARIANT else '')
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.save_version=0
scene=bpy.context.scene
kit=bpy.data.collections.new(NAME);scene.collection.children.link(kit)
kit.asset_mark();kit.asset_data.description='Painterly iron minecart with two push handles; 1.14 m gauge, ground pivot, X travel.'+(' Left wheels missing.' if MISSING_WHEEL_X else '')

def mat(name,dark,light,metal=.45,rough=.72,scale=(3,3,3)):
    m=bpy.data.materials.new(name);m.use_nodes=True;m.diffuse_color=(*light,1)
    n=m.node_tree.nodes;l=m.node_tree.links;p=n.get('Principled BSDF')
    p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
    tc=n.new('ShaderNodeTexCoord');v=n.new('ShaderNodeVectorMath');v.operation='MULTIPLY';v.inputs[1].default_value=scale;l.new(tc.outputs['Object'],v.inputs[0])
    noise=n.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=1;noise.inputs['Detail'].default_value=1.5;l.new(v.outputs[0],noise.inputs['Vector'])
    ramp=n.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].position=.23;ramp.color_ramp.elements[0].color=(*dark,1);ramp.color_ramp.elements[1].position=.78;ramp.color_ramp.elements[1].color=(*light,1)
    l.new(noise.outputs['Fac'],ramp.inputs[0]);l.new(ramp.outputs[0],p.inputs['Base Color'])
    return m
# Painterly iron: low-contrast oxide washes with gently broken boundaries.
# Warmth stays close to the iron value; no bright orange stippling.
def oxidized(m,coverage=.53):
    n=m.node_tree.nodes;l=m.node_tree.links;p=n.get('Principled BSDF')
    base=p.inputs['Base Color'].links[0].from_socket
    tc=n.new('ShaderNodeTexCoord')
    def noise(scale,detail):
        q=n.new('ShaderNodeTexNoise');q.inputs['Scale'].default_value=scale;q.inputs['Detail'].default_value=detail
        q.inputs['Roughness'].default_value=.72;l.new(tc.outputs['Object'],q.inputs['Vector']);return q.outputs['Fac']
    coarse=noise(6,2);chips=noise(38,1.5)
    mix=n.new('ShaderNodeMixRGB');mix.inputs[0].default_value=.18
    l.new(coarse,mix.inputs[1]);l.new(chips,mix.inputs[2])
    mask=n.new('ShaderNodeValToRGB');mask.name='Oxide mask';mask.color_ramp.elements[0].position=coverage;mask.color_ramp.elements[1].position=coverage+.16;strength=.48 if coverage<=.52 else .7;mask.color_ramp.elements[1].color=(strength,strength,strength,1)
    l.new(mix.outputs[0],mask.inputs[0])
    oxide=n.new('ShaderNodeValToRGB');oxide.color_ramp.elements[0].position=.24;oxide.color_ramp.elements[0].color=(.075,.053,.039,1)
    oxide.color_ramp.elements[1].position=.77;oxide.color_ramp.elements[1].color=(.125,.080,.054,1)
    l.new(chips,oxide.inputs[0])
    paint=n.new('ShaderNodeMixRGB');l.new(mask.outputs[0],paint.inputs[0]);l.new(base,paint.inputs[1]);l.new(oxide.outputs[0],paint.inputs[2]);l.new(paint.outputs[0],p.inputs['Base Color'])
    # Shallow hammered grain. No large-scale bump or dents in the plate.
    bump=n.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.06;bump.inputs['Distance'].default_value=.0003
    l.new(chips,bump.inputs['Height']);l.new(bump.outputs[0],p.inputs['Normal'])
    return m
panel=oxidized(mat('Cart • oxidized iron plate',(.065,.069,.063),(.079,.083,.076),.62,.70,(48,48,1.8)),.50)
inside=oxidized(mat('Cart • worn iron interior',(.052,.049,.043),(.067,.062,.055),.58,.75,(40,40,2.4)),.51)
iron=oxidized(mat('Cart • forged iron frame',(.043,.043,.040),(.055,.054,.049),.70,.62,(32,32,2)),.59)
edge=oxidized(mat('Cart • rubbed iron bevels',(.100,.101,.092),(.135,.133,.118),.72,.57,(28,28,3)),.63)
rust=mat('Cart • quiet rust seams',(.065,.052,.039),(.095,.074,.052),.35,.77,(25,25,25))
grip=oxidized(mat('Cart • worn steel grips',(.092,.097,.091),(.115,.121,.114),.8,.52,(64,2,64)),.63)

def put(o,name,m):
    o.name=name
    for c in list(o.users_collection):c.objects.unlink(o)
    kit.objects.link(o);o.data.materials.append(m)
    return o

def bevel(o,width=.018):
    o.data.materials.append(edge)
    b=o.modifiers.new('Soft worn edges','BEVEL');b.width=width;b.segments=2;b.material=len(o.data.materials)-1
    bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=b.name)
    w=o.modifiers.new('Weighted corner normals','WEIGHTED_NORMAL');bpy.ops.object.modifier_apply(modifier=w.name)
    return o

def box(name,loc,size,m,bev=.018):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=put(bpy.context.object,name,m);o.dimensions=size;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    return bevel(o,bev) if bev else o

def beam(name,a,b,width,depth,m):
    a,b=Vector(a),Vector(b);o=box(name,(a+b)/2,(width,depth,(b-a).length),m,.012);o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler();return o

def cylinder(name,loc,radius,depth,m,vertices=16,axis='Y'):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=radius,depth=depth,location=loc)
    o=put(bpy.context.object,name,m)
    if axis=='Y':o.rotation_euler[0]=math.pi/2
    elif axis=='X':o.rotation_euler[1]=math.pi/2
    return bevel(o,.009)

def mesh(name,verts,faces,m):
    d=bpy.data.meshes.new(name);d.from_pydata(verts,[],faces);d.update();o=bpy.data.objects.new(name,d);kit.objects.link(o);d.materials.append(m);return o

def ring(name,x,y,z,outer,inner,width,m):
    verts=[];N=32
    for yy,rr in [(y-width/2,outer),(y+width/2,outer),(y-width/2,inner),(y+width/2,inner)]:
        verts += [(x+rr*math.cos(i*math.tau/N),yy,z+rr*math.sin(i*math.tau/N)) for i in range(N)]
    faces=[]
    for i in range(N):
        j=(i+1)%N
        faces += [(i,j,N+j,N+i),(2*N+j,2*N+i,3*N+i,3*N+j),(j,i,2*N+i,2*N+j),(N+i,N+j,3*N+j,3*N+i)]
    # Outward winding on the tread, bore and both annular faces.
    return bevel(mesh(name,verts,[tuple(reversed(f)) for f in faces],m),.009)

# Axle bearing block: full width from the hopper floor (Z=.67, sunk 1 cm into
# it) down to a half-round about the axle (centre Z=.405), 0.24 m along X and
# 0.18 m across. One closed mesh so the round end meets the flat sides without a seam.
def axle_box(name,x,y,m,half=.12,top=.68-.405,depth=.18,N=16):
    prof=[(-half,top),(half,top)]+[(half*math.cos(-i*math.pi/N),half*math.sin(-i*math.pi/N)) for i in range(N+1)]
    n=len(prof);verts=[(x+px,y+yy,.405+pz) for yy in (-depth/2,depth/2) for px,pz in prof]
    faces=[tuple(range(n)),tuple(range(2*n-1,n-1,-1))]+[(i,(i+1)%n,n+(i+1)%n,n+i) for i in range(n)]
    o=mesh(name,verts,faces,m)
    bm=bmesh.new();bm.from_mesh(o.data);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(o.data);bm.free()
    return bevel(o)

def join_since(before,name):
    obs=[o for o in kit.objects if o not in before];bpy.ops.object.select_all(action='DESELECT')
    for o in obs:o.select_set(True)
    bpy.context.view_layer.objects.active=obs[0];bpy.ops.object.join();o=bpy.context.object;o.name=name
    return o

# Hollow shell with a fully modelled interior and substantial folded rim.
before=set(kit.objects)
verts=[]
for a,b,z in [(1.08,.49,.67),(1.43,.69,1.77),(1.35,.61,1.77),(1.01,.42,.75)]:
    verts += [(-a,-b,z),(a,-b,z),(a,b,z),(-a,b,z)]
faces=[]
for i in range(4):
    j=(i+1)%4;faces += [(i,j,4+j,4+i),(4+i,4+j,8+j,8+i),(8+i,8+j,12+j,12+i)]
faces += [(12,13,14,15),(3,2,1,0)]
o=mesh('Tapered open hopper',verts,faces,panel);o.data.materials.append(inside)
for i,p in enumerate(o.data.polygons):
    if i%3==2 or i==12:p.material_index=1
bevel(o,.017)
for y in [-1,1]:
    box('Thick folded side lip',(0,y*.69,1.78),(2.92,.10,.105),iron)
    box('Lower side sill',(0,y*.50,.70),(2.25,.10,.12),iron)
    for x in [-1.0,-.43,.43,1.0]:
        top=x*1.30
        beam('Forged vertical strap',(x,y*.526,.73),(top,y*.714,1.73),.072,.048,iron)
        for t in [.08,.89]:
            xx=x+(top-x)*t;zz=.73+t;yy=y*(.526+.188*t+.031)
            cylinder('Hex rivet',(xx,yy,zz),.027,.022,edge,6)
for x in [-1,1]:
    box('End lip',(x*1.43,0,1.78),(.10,1.38,.105),iron)
    for y in [-.39,.39]:
        beam('End brace',(x*1.105,y,.72),(x*1.45,y,1.73),.065,.075,iron)
# Open underneath: no chassis, so the axles show from the side. Each axle
# bearing hangs straight from the hopper floor on a web and a bolted plate.
for x in [-AXLE_X,AXLE_X]:
    cylinder('Axle',(x,0,.405),.068,1.38,iron)
    for y in [-.40,.40]:
        axle_box('Axle bearing',x,y,iron)
join_since(before,'Hopper and chassis')
# Four five-spoke railway wheels, with inside flanges. Treads rest at Z=0.
for x in [-AXLE_X,AXLE_X]:
    if x in MISSING_WHEEL_X:continue
    for y in [-.57,.57]:
        before=set(kit.objects);sgn=1 if y>0 else -1
        ring('Wheel tread',x,y,.405,.405,.305,.23,iron)
        ring('Inside rail flange',x,y-sgn*.132,.405,.435,.31,.035,iron)
        ring('Rubbed outer rim',x,y+sgn*.118,.405,.392,.353,.022,edge)
        for i in range(5):
            a=i*math.tau/5+.16
            beam('Broad wheel spoke',(x+.08*math.cos(a),y,.405+.08*math.sin(a)),(x+.33*math.cos(a+.13),y,.405+.33*math.sin(a+.13)),.095,.09,iron)
        cylinder('Wheel hub',(x,y,.405),.13,.28,iron)
        cylinder('Hub cap',(x,y+sgn*.155,.405),.096,.045,rust,12)
        cylinder('Axle bolt',(x,y+sgn*.183,.405),.040,.024,edge,6)
        wheel=join_since(before,('Front' if y<0 else 'Back')+(' left wheel' if x<0 else ' right wheel'))
        bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
        scene.cursor.location=(x,y,.405)
        bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
        wheel['rotation_axis']='Local Y, centred on axle'
# Shopping-cart handles project from both short ends; clear knuckle space.
for sign in [-1,1]:
    before=set(kit.objects)
    for y in [-.44,.44]:
        box('Handle mounting plate',(sign*1.413,y,1.61),(.085,.16,.22),iron)
        beam('Rising handle arm',(sign*1.42,y,1.58),(sign*1.72,y,1.91),.065,.065,iron)
        cylinder('Handle grip collar',(sign*1.72,y,1.91),.065,.09,edge)
    cylinder('Push bar',(sign*1.72,0,1.91),.043,.96,iron)
    cylinder('Steel handgrip',(sign*1.72,0,1.91),.063,.73,grip,12)
    join_since(before,('Left' if sign<0 else 'Right')+' push handle')

scene.cursor.location=(0,0,0)
kit['rail_gauge_m']=1.14;kit['pivot']='Ground at tread height; rail head goes at Z=0. Flanges extend 0.03m below.'
# Bake only metal/roughness response to a dedicated UV set. The game exporter
# bakes colour/normal itself, but cannot carry procedural metal/roughness nodes.
def bake_surface_response(ob):
    bpy.ops.object.select_all(action='DESELECT');ob.select_set(True);bpy.context.view_layer.objects.active=ob
    if not ob.data.uv_layers.get('CartFinishUV'):ob.data.uv_layers.new(name='CartFinishUV')
    ob.data.uv_layers.active=ob.data.uv_layers['CartFinishUV']
    ob.data.uv_layers['CartFinishUV'].active_render=True
    bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.uv.smart_project(angle_limit=1.15,island_margin=.025);bpy.ops.object.mode_set(mode='OBJECT')
    size=1024 if ob.name=='Hopper and chassis' else 512
    im=bpy.data.images.new(ob.name+' oxide response',width=size,height=size,alpha=False)
    im.colorspace_settings.name='Non-Color';im['generated_by']='tools/blender/mineshaft/build_minecart.py'
    copies={};temporary=[]
    for slot in ob.material_slots:
        old=slot.material
        if old.name in copies:slot.material=copies[old.name];continue
        m=old.copy();copies[old.name]=m;slot.material=m
        n=m.node_tree.nodes;l=m.node_tree.links;p=n.get('Principled BSDF');out=n.get('Material Output');original=out.inputs['Surface'].links[0].from_socket
        combine=n.new('ShaderNodeCombineColor');combine.inputs[0].default_value=1
        mask=n.get('Oxide mask')
        for channel,socket,target in [(1,'Roughness',.9),(2,'Metallic',.05)]:
            value=p.inputs[socket].default_value
            if mask:
                remap=n.new('ShaderNodeMapRange');remap.inputs['To Min'].default_value=value;remap.inputs['To Max'].default_value=target;l.new(mask.outputs[0],remap.inputs['Value']);l.new(remap.outputs[0],combine.inputs[channel])
            else:combine.inputs[channel].default_value=value
        emit=n.new('ShaderNodeEmission');l.new(combine.outputs[0],emit.inputs[0]);l.new(emit.outputs[0],out.inputs['Surface'])
        tex=n.new('ShaderNodeTexImage');tex.image=im;n.active=tex
        temporary.append((m,original,emit,tex))
    bpy.ops.object.bake(type='EMIT')
    im.pack()
    for m,original,emit,tex in temporary:
        n=m.node_tree.nodes;l=m.node_tree.links;p=n.get('Principled BSDF');l.new(original,n.get('Material Output').inputs['Surface']);n.remove(emit)
        uv=n.new('ShaderNodeUVMap');uv.uv_map='CartFinishUV';l.new(uv.outputs[0],tex.inputs['Vector'])
        separate=n.new('ShaderNodeSeparateColor');l.new(tex.outputs[0],separate.inputs[0]);l.new(separate.outputs[1],p.inputs['Roughness']);l.new(separate.outputs[2],p.inputs['Metallic'])
    print('OXIDE_RESPONSE_BAKED',ob.name,flush=True)

# Preserve editable meshes and portable procedural finishes.
scene.world=bpy.data.worlds.new('Minecart world');scene.world.color=(.18,.18,.18)
scene.render.engine='CYCLES';scene.cycles.samples=32
scene.render.threads_mode='FIXED';scene.render.threads=12
scene.view_settings.view_transform='AgX'
scene.render.bake.margin=12;scene.cycles.samples=1
for ob in list(kit.objects):bake_surface_response(ob)
scene.cycles.samples=32
source=ROOT/f'assets-src/models/{NAME}.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(source))
# Presentation only; deliberately added after saving the reusable asset.
guide=bpy.data.collections.new('guide.presentation');scene.collection.children.link(guide)
def guide_move(o):
    for c in list(o.users_collection):c.objects.unlink(o)
    guide.objects.link(o)
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.036));floor=bpy.context.object;guide_move(floor)
floormat=mat('Preview slate',(.055,.085,.095),(.055,.085,.095),0,.9);floor.data.materials.append(floormat)
for name,loc,power,size in [('Key',(-3,-4,7),950,5),('Fill',(4,-1,4),650,4),('Rim',(0,4,5),1100,3)]:
    d=bpy.data.lights.new(name,'AREA');d.energy=power;d.shape='DISK';d.size=size;o=bpy.data.objects.new(name,d);guide.objects.link(o);o.location=loc;o.rotation_euler=(Vector((0,0,1))-o.location).to_track_quat('-Z','Y').to_euler()
d=bpy.data.cameras.new('Camera');cam=bpy.data.objects.new('Camera',d);guide.objects.link(cam);scene.camera=cam;d.type='ORTHO';d.ortho_scale=4.6
out=ROOT/'assets-src/studies/mineshaft';out.mkdir(parents=True,exist_ok=True)
scene.render.resolution_x=1400;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
for name,loc in [(NAME,(4,-6,3.8)),(NAME+'-side',(0,-7,2.5))]:
    cam.location=loc;cam.rotation_euler=(Vector((0,0,.98))-cam.location).to_track_quat('-Z','Y').to_euler();scene.render.filepath=str(out/(name+'.png'));bpy.ops.render.render(write_still=True)
# Inspect the actual rail fit. Shift rails down so their heads meet the cart pivot.
rail_source=ROOT/'assets-src/models/mine-rail-straight.blend'
with bpy.data.libraries.load(str(rail_source),link=False) as (src,dst):
    dst.collections=['mine-rail-straight']
rails=dst.collections[0];scene.collection.children.link(rails)
for ob in rails.objects:
    if ob.parent is None:ob.location+=Vector((-2,0,-.242))
floor.location.z=-.25
cam.location=(4,-6,3.8);cam.rotation_euler=(Vector((0,0,.9))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=5.1
scene.render.filepath=str(out/(NAME+'-on-rails.png'));bpy.ops.render.render(write_still=True)
print('MINECART_COMPLETE',source,flush=True)
