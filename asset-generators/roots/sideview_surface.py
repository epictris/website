"""Continuous, silhouette-constrained root surfaces. NumPy only, including FEM.

The union is tessellated as vertical strips split at every segment intersection.
A uniform-grid Poisson solve for squared depth produces rounded limbs and continuous forks.
Neither this mesh nor its material fields are used by gameplay.
"""
import math
import numpy as np


def cross(a,b):
    return a[0]*b[1]-a[1]*b[0]


def inside(points,polygon):
    points=np.atleast_2d(points); result=np.zeros(len(points),dtype=bool)
    for a,b in zip(polygon,np.roll(polygon,-1,axis=0)):
        if abs(b[1]-a[1])<1e-12: continue
        result^=((a[1]>points[:,1])!=(b[1]>points[:,1])) & (
            points[:,0]<(b[0]-a[0])*(points[:,1]-a[1])/(b[1]-a[1])+a[0])
    return result


def boundary_distance(points,polygon):
    points=np.atleast_2d(points); result=np.full(len(points),np.inf)
    for a,b in zip(polygon,np.roll(polygon,-1,axis=0)):
        e=b-a; delta=points-a
        t=np.clip((delta[:,0]*e[0]+delta[:,1]*e[1])/np.dot(e,e),0,1)
        result=np.minimum(result,np.linalg.norm(points-a-t[:,None]*e,axis=1))
    return result


def crossing(a,b,c,d):
    e=b-a; f=d-c; det=cross(e,f)
    if abs(det)<1e-12: return None
    t=cross(c-a,f)/det; u=cross(c-a,e)/det
    if -1e-9<=t<=1+1e-9 and -1e-9<=u<=1+1e-9:
        return a+t*e
    return None


def connected_groups(roots):
    """Only positive-area overlaps weld; point/edge contacts remain separate."""
    polygons=[np.asarray(r['polygon'],float) for r in roots]
    neighbors=[set() for _ in roots]
    for i,p in enumerate(polygons):
        for j in range(i):
            q=polygons[j]
            candidates=list(p)+list(q)
            candidates += [hit for a,b in zip(p,np.roll(p,-1,axis=0))
                           for c,d in zip(q,np.roll(q,-1,axis=0))
                           if (hit:=crossing(a,b,c,d)) is not None]
            candidates=np.asarray(candidates)
            candidates=np.concatenate([candidates,candidates.mean(axis=0)[None]])
            # Small probes distinguish tangency from an actual area overlap.
            probes=np.concatenate([candidates+offset for offset in
                                   ([0,0],[1e-6,1e-6],[-1e-6,1e-6],[1e-6,-1e-6],[-1e-6,-1e-6])])
            if np.any(inside(probes,p)&inside(probes,q)):
                neighbors[i].add(j); neighbors[j].add(i)
    groups=[]; unseen=set(range(len(roots)))
    while unseen:
        pending=[min(unseen)]; component=[]
        while pending:
            i=pending.pop()
            if i not in unseen: continue
            unseen.remove(i); component.append(i); pending.extend(neighbors[i]&unseen)
        groups.append([roots[i] for i in sorted(component)])
    return groups


def union_tessellation(roots,spacing=.028):
    def unique_coordinates(values):
        # Intersections of shared endpoints can differ by sub-nanometres.
        # Keeping both makes near-zero-width strips and ill-conditioned ridges.
        result=[]
        for value in sorted(float(v) for v in values):
            if not result or value-result[-1]>1e-8:result.append(value)
        return result
    polygons=[np.asarray(r['polygon'],float) for r in roots]
    segments=[(a,b) for p in polygons for a,b in zip(p,np.roll(p,-1,axis=0))]
    all_points=np.concatenate(polygons); lo=all_points.min(axis=0); hi=all_points.max(axis=0)
    breaks=list(all_points[:,0])
    for i,(a,b) in enumerate(segments):
        for c,d in segments[:i]:
            hit=crossing(a,b,c,d)
            if hit is not None: breaks.append(hit[0])
    breaks=unique_coordinates(breaks)
    xs=[breaks[0]]
    for a,b in zip(breaks,breaks[1:]):
        xs.extend(np.linspace(a,b,max(1,math.ceil((b-a)/spacing))+1)[1:])
    xs=np.asarray(xs)
    def at(edge,x):
        a,b=edge
        return float(a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]))
    cells=[]
    for i,(x0,x1) in enumerate(zip(xs,xs[1:])):
        xm=(x0+x1)/2; intervals=[]
        for p in polygons:
            hits=sorted([(at((a,b),xm),(a,b)) for a,b in zip(p,np.roll(p,-1,axis=0))
                         if min(a[0],b[0])<xm<max(a[0],b[0])],key=lambda pair:pair[0])
            intervals.extend([(hits[k][0],hits[k+1][0],hits[k][1],hits[k+1][1]) for k in range(0,len(hits),2)])
        intervals.sort(key=lambda item:item[0]); merged=[]
        for low,high,lower,upper in intervals:
            if merged and low<=merged[-1][1]+1e-10:
                if high>merged[-1][1]: merged[-1]=(merged[-1][0],high,merged[-1][2],upper)
            else: merged.append((low,high,lower,upper))
        for _,__,lower,upper in merged:
            cells.append((i,at(lower,x0),at(upper,x0),at(lower,x1),at(upper,x1)))
    # Shared rails include all cell endpoints so forks and holes have no T-junctions.
    rails=[list(np.arange(lo[1],hi[1]+spacing,spacing)) for _ in xs]
    for i,l0,h0,l1,h1 in cells:
        rails[i].extend([l0,h0]);rails[i+1].extend([l1,h1])
    rails=[np.asarray(unique_coordinates(rail)) for rail in rails]
    vertices=[];faces=[];lookup={}
    def vertex(x,y):
        key=(round(float(x),10),round(float(y),10))
        if key not in lookup: lookup[key]=len(vertices);vertices.append(key)
        return lookup[key]
    for i,l0,h0,l1,h1 in cells:
        left=rails[i][(rails[i]>=l0-1e-8)&(rails[i]<=h0+1e-8)]
        right=rails[i+1][(rails[i+1]>=l1-1e-8)&(rails[i+1]<=h1+1e-8)]
        li=[vertex(xs[i],y) for y in left]; ri=[vertex(xs[i+1],y) for y in right]
        a=b=0
        while a<len(li)-1 or b<len(ri)-1:
            lt=(left[a+1]-l0)/max(h0-l0,1e-12) if a+1<len(li) else np.inf
            rt=(right[b+1]-l1)/max(h1-l1,1e-12) if b+1<len(ri) else np.inf
            if lt<rt: faces.append([li[a],ri[b],li[a+1]]);a+=1
            else: faces.append([li[a],ri[b],ri[b+1]]);b+=1
    p=np.asarray(vertices); f=np.asarray(faces,dtype=int)
    # Surface normals must face -Y in Blender's XZ plane.
    area=np.array([cross(p[b]-p[a],p[c]-p[a]) for a,b,c in f])
    f=f[np.abs(area)>1e-13]; area=area[np.abs(area)>1e-13]
    f[area<0]=f[area<0,::-1]
    # Interior edges joining boundary points need a nonzero-depth midpoint.
    # Splitting every triangle at its center and every edge at its midpoint
    # ensures no front/back triangle or internal chord collapses at narrow tips.
    edges=np.sort(np.concatenate([f[:,[0,1]],f[:,[1,2]],f[:,[2,0]]]),axis=1)
    unique,counts=np.unique(edges,axis=0,return_counts=True)
    boundary={tuple(e) for e in unique[counts==1]}
    midpoint={}; points=list(p); new=[]
    for a,b in unique:
        midpoint[a,b]=len(points);points.append((p[a]+p[b])/2)
    for a,b,c in f:
        center=len(points);points.append((p[a]+p[b]+p[c])/3)
        ring=[a,midpoint[tuple(sorted((a,b)))],b,midpoint[tuple(sorted((b,c)))],c,midpoint[tuple(sorted((c,a)))]]
        new.extend([[u,v,center] for u,v in zip(ring,ring[1:]+ring[:1])])
    boundary_ids=set(int(v) for e in boundary for v in e)
    boundary_ids.update(midpoint[e] for e in boundary)
    return np.asarray(points),np.asarray(new),np.asarray(sorted(boundary_ids))


def branch_frame(root):
    """Infer a gently curving spine from polygon cross-sections, no new inputs."""
    p=np.asarray(root.get('flow_polygon',root['polygon']),float); center=p.mean(axis=0)
    _,vectors=np.linalg.eigh((p-center).T@(p-center)); axis=vectors[:,-1]
    if axis[1]<0: axis=-axis
    across=np.array([axis[1],-axis[0]])
    s=p@axis; t=p@across; span=np.ptp(s)
    stations=np.linspace(s.min()+span*1e-5,s.max()-span*1e-5,65)
    centers=[];widths=[]
    for value in stations:
        hits=[]
        for i in range(len(p)):
            j=(i+1)%len(p)
            if min(s[i],s[j])<=value<max(s[i],s[j]):
                hits.append(t[i]+(t[j]-t[i])*(value-s[i])/(s[j]-s[i]))
        centers.append((min(hits)+max(hits))/2);widths.append((max(hits)-min(hits))/2)
    centers=np.asarray(centers)
    for _ in range(4): centers[1:-1]=(centers[:-2]+2*centers[1:-1]+centers[2:])/4
    curve=stations[:,None]*axis+centers[:,None]*across
    length=np.r_[0,np.cumsum(np.linalg.norm(np.diff(curve,axis=0),axis=1))]
    return dict(axis=axis,across=across,stations=stations,centers=centers,
                width=max(float(np.median(widths)),.025),widths=np.asarray(widths),length=length,
                depth=root.get('depth',.38),id=root['id'])


def branch_coordinates(points,frame):
    s=points[:,0]*frame['axis'][0]+points[:,1]*frame['axis'][1]
    offset=np.interp(s,frame['stations'],frame['centers'])
    u=points[:,0]*frame['across'][0]+points[:,1]*frame['across'][1]-offset
    v=np.interp(s,frame['stations'],frame['length'])
    return u,v


def noise(x,y,seed=0):
    ix=np.floor(x);iy=np.floor(y);fx=x-ix;fy=y-iy
    fx=fx*fx*(3-2*fx);fy=fy*fy*(3-2*fy)
    def hashed(a,b):
        n=np.sin(a*127.1+b*311.7+seed*41.3)*43758.5453
        return (n-np.floor(n))*2-1
    return ((1-fx)*hashed(ix,iy)+fx*hashed(ix+1,iy))*(1-fy)+(
        (1-fx)*hashed(ix,iy+1)+fx*hashed(ix+1,iy+1))*fy


def smoothstep(a,b,x):
    t=np.clip((x-a)/(b-a),0,1)
    return t*t*(3-2*t)


def flow_setup(roots):
    frames=[branch_frame(r) for r in roots]
    parent=max(range(len(roots)),key=lambda i:frames[i]['width']*frames[i]['length'][-1])
    trunk=frames[parent];joins=[]
    for i,frame in enumerate(frames):
        endpoints=frame['stations'][[0,-1],None]*frame['axis']+frame['centers'][[0,-1],None]*frame['across']
        poly=np.asarray(roots[parent].get('flow_polygon',roots[parent]['polygon']))
        distance=boundary_distance(endpoints,poly)
        signed=np.where(inside(endpoints,poly),distance,-distance)
        k=int(np.argmax(signed));anchor=endpoints[k:k+1]
        pu,pv=branch_coordinates(anchor,trunk);cu,cv=branch_coordinates(anchor,frame)
        joins.append(dict(anchor=anchor[0],v=float(cv[0]),u_offset=float(pu[0]-cu[0]),
                          v_offset=float(pv[0]-cv[0]),active=i!=parent and signed[k]>-.05))
    return frames,parent,joins


def flow_coordinates(points,roots,setup=None):
    """Align child coordinates with their parent before synthesizing grain.

    Blending coordinates (not finished textures) avoids blurred double-grain
    patterns; fibres bend and split through the shared junction field.
    """
    frames,parent,joins=setup or flow_setup(roots)
    pu,pv=branch_coordinates(points,frames[parent]);total=np.zeros(len(points))
    uu=np.zeros(len(points));vv=np.zeros(len(points));shoulders=np.zeros(len(points))
    for root,frame,join in zip(roots,frames,joins):
        u,v=branch_coordinates(points,frame)
        if join['active']:
            distance=np.abs(v-join['v'])
            blend=1-smoothstep(.03,.42,distance)
            u=(u+join['u_offset'])*(1-blend)+pu*blend
            v=(v+join['v_offset'])*(1-blend)+pv*blend
            shoulders=np.maximum(shoulders,np.exp(-np.sum((points-join['anchor'])**2,axis=1)/.075))
        poly=np.asarray(root.get('flow_polygon',root['polygon']))
        distance=boundary_distance(points,poly)
        weight=np.exp(np.clip(np.where(inside(points,poly),distance,-distance)/.045,-30,20))
        uu+=u*weight;vv+=v*weight;total+=weight
    return uu/total,vv/total,shoulders


def plate_field(u,v,seed):
    """Anisotropic, jittered bark plates separated by irregular deep seams."""
    x=u*25+.3*noise(u*10,v*4,seed);y=v*8
    ix=np.floor(x);iy=np.floor(y)
    first=np.full(len(u),np.inf);second=first.copy()
    for dx in (-1,0,1):
        for dy in (-1,0,1):
            px=ix+dx+.5+.38*noise(ix+dx,iy+dy,seed+2)
            py=iy+dy+.5+.38*noise(ix+dx,iy+dy,seed+3)
            distance=np.sqrt((x-px)**2+(y-py)**2)
            second=np.minimum(second,np.maximum(first,distance));first=np.minimum(first,distance)
    gap=second-first
    return 1-np.exp(-gap/.11),np.exp(-(gap/.032)**2)


def end_fields(points,roots,seed):
    mask=np.zeros(len(points));color=np.zeros((len(points),3));relief=np.zeros(len(points))
    distance_field=np.full(len(points),np.inf);bands=np.ones(len(points))
    for root in roots:
        for cap in root.get('end_profiles',[]):
            a,b,inward=np.asarray(cap['a']),np.asarray(cap['b']),np.asarray(cap['inward'])
            e=b-a;t=((points[:,0]-a[0])*e[0]+(points[:,1]-a[1])*e[1])/np.dot(e,e)
            d=(points[:,0]-a[0])*inward[0]+(points[:,1]-a[1])*inward[1];band=cap['band'];q=d/band
            fuzz=.055*noise(t*18,q*7,seed+42)
            weight=(1-smoothstep(.68,1,q+fuzz))*smoothstep(-.04,.025,t)*(1-smoothstep(.975,1.04,t))*(q>-.1)
            radius=np.sqrt(((t-.47)*1.7)**2+((q-.1)*.6)**2)
            ring=.5+.5*np.sin(radius*85+noise(t*13,q*9,seed+41)*1.2)
            angle=np.arctan2(q-.1,(t-.47)*2)
            split=np.clip((np.sin(angle*9+noise(t*7,q*3,seed+44))-.90)*10,0,1)*smoothstep(.18,.5,radius)
            fibre=noise(t*110,q*8,seed+45)
            tone=.62+.10*ring+.055*fibre-.40*split
            c=np.array([.30,.19,.095])+tone[:,None]*np.array([.32,.30,.23])
            h=.0006*ring+.0012*fibre-.004*split
            take=weight>mask
            mask[take]=weight[take];color[take]=c[take];relief[take]=h[take]
            distance_field[take]=np.maximum(d[take],0);bands[take]=band
    return mask,color,relief,distance_field,bands


def solve_squared_depth(p,f,boundary,roots):
    """Uniform-grid Poisson depth, sampled onto the exact contour mesh.

    The solve is independent of irregular triangulation and near-coincident
    control coordinates. Only volume is sampled; silhouette vertices stay exact.
    """
    extent=np.ptp(p,axis=0);step=max(.009,float(max(extent))/240)
    lo=p.min(axis=0)-2*step;hi=p.max(axis=0)+2*step
    nx=int(np.ceil((hi[0]-lo[0])/step))+1;ny=int(np.ceil((hi[1]-lo[1])/step))+1
    xx,yy=np.meshgrid(lo[0]+np.arange(nx)*step,lo[1]+np.arange(ny)*step)
    points=np.column_stack([xx.ravel(),yy.ravel()])
    forcing=np.zeros(len(points));weight=np.zeros(len(points));distance=np.zeros(len(p))
    for root in roots:
        polygon=np.asarray(root['polygon']);frame=branch_frame(root)
        mask=inside(points,polygon)
        w=mask*(boundary_distance(points,polygon)+.01)
        forcing+=w*2*(frame['depth']/(2*frame['width']))**2;weight+=w
        d=boundary_distance(p,polygon)
        distance=np.maximum(distance,np.where(inside(p,polygon),d,0))
    free=(weight>0).reshape(ny,nx)
    rhs=(forcing/np.maximum(weight,1e-12)*step*step).reshape(ny,nx)
    def multiply(x):
        result=4*x-np.roll(x,1,0)-np.roll(x,-1,0)-np.roll(x,1,1)-np.roll(x,-1,1)
        result[~free]=0
        return result
    solution=np.zeros_like(rhs);r=rhs.copy();direction=r.copy();rr=float(np.sum(r*r))
    target=max(rr*1e-14,1e-24)
    for _ in range(1200):
        if rr<=target:break
        ad=multiply(direction);alpha=rr/max(float(np.sum(direction*ad)),1e-30)
        solution+=alpha*direction;r-=alpha*ad
        new_rr=float(np.sum(r*r));direction=r+(new_rr/max(rr,1e-30))*direction;rr=new_rr
    else:raise ValueError('Root thickness solve did not converge.')
    grid=(p-lo)/step;ij=np.floor(grid).astype(int);fraction=grid-ij
    ix,iy=ij.T;fx,fy=fraction.T
    potential=(solution[iy,ix]*(1-fx)*(1-fy)+solution[iy,ix+1]*fx*(1-fy)+
               solution[iy+1,ix]*(1-fx)*fy+solution[iy+1,ix+1]*fx*fy)
    height=np.sqrt(np.maximum(potential,0))*np.sqrt(np.clip(distance/step,0,1))
    # Sub-grid tapered tips still get positive volume; they never enlarge XY.
    height=np.maximum(height,distance*.01)
    height[boundary]=0
    return height


def surface_bark_uv(vertices, faces, roots):
    """Project each triangle onto its best-facing plane in a padded atlas.

    Dominant-normal projection bounds the local surface/UV area ratio by
    sqrt(3), including forks that have no single well-defined branch axis.
    Geometry remains welded; only UV loops are split at chart borders.
    """
    triangle=vertices[faces]
    normal=np.cross(triangle[:,1]-triangle[:,0],triangle[:,2]-triangle[:,0])
    dominant=np.argmax(np.abs(normal),axis=1)
    charts=np.where(normal[:,1]>=0,0,1)
    charts[dominant==2]=np.where(normal[dominant==2,2]>=0,2,3)
    charts[dominant==0]=np.where(normal[dominant==0,0]>=0,4,5)
    axes=((0,2),(0,2),(0,1),(0,1),(1,2),(1,2))
    # Separate disconnected patches before packing. Prongs can have the same
    # projection but different positions along the omitted axis.
    parent=np.arange(len(faces))
    def root(i):
        while parent[i]!=i:
            parent[i]=parent[parent[i]];i=parent[i]
        return i
    edges={}
    for i,(a,b,c) in enumerate(faces):
        for x,y in ((a,b),(b,c),(c,a)):
            edge=(min(x,y),max(x,y))
            other=edges.get(edge)
            if other is None:edges[edge]=i
            elif charts[i]==charts[other]:
                parent[root(i)]=root(other)
    groups={}
    for i in range(len(faces)):
        groups.setdefault(root(i),[]).append(i)
    patches=[]
    gutter=.03
    for indices in groups.values():
        indices=np.asarray(indices)
        ax=axes[charts[indices[0]]]
        projected=triangle[indices][:,:,ax]
        lo=projected.reshape(-1,2).min(axis=0)
        hi=projected.reshape(-1,2).max(axis=0)
        patches.append((indices,projected,lo,hi,hi-lo+gutter))
    total_area=sum(float(s[0]*s[1]) for *_,s in patches)
    target=max(max(float(s[0]) for *_,s in patches),
               1.5*math.sqrt(total_area))
    uv=np.empty((len(faces),3,2),float)
    x=y=row_height=0.
    for indices,projected,lo,hi,patch_size in sorted(patches,key=lambda item:-item[-1][1]):
        w,h=patch_size
        if x+w>target+1e-9:
            x=0;y+=row_height;row_height=0
        uv[indices]=projected-lo+np.array([x,y])+gutter/2
        x+=w;row_height=max(row_height,h)
    size=np.array([target,y+row_height])
    return uv,size,charts


def build_surfaces(roots,seed):
    from polygon_roots import stable_seed
    result=[]
    for group in connected_groups(roots):
        p,f,boundary=union_tessellation(group)
        height=solve_squared_depth(p,f,boundary,group)
        u,v,shoulders=flow_coordinates(p,group)
        phase=(stable_seed(f'{seed}:{group[0]["id"]}')%1000)/71
        plates,_=plate_field(u,v,phase)
        fade=smoothstep(0,.045,height)
        # Off-center growth, shoulder swelling and twisting depth; XY stays fixed.
        front_height=height*(1+.16*shoulders+.09*np.sin(v*4+phase)+.09*np.tanh(u*6))
        back_height=height*(.92+.05*np.sin(v*3-phase)-.07*np.tanh(u*5))
        front_height+=fade*.007*(plates-.35)
        back_height+=fade*.004*(plates-.35)
        cap,_,fibres,distance,bands=end_fields(p,group,phase)
        # Steep sloping break facets expose end grain to the side camera.
        bevel=np.sqrt(np.clip(distance/bands,0,1))
        front_height*=1-cap*(1-bevel)
        front_height+=fade*cap*fibres*1.4
        front_height=np.maximum(front_height,height*.12)
        back_height=np.maximum(back_height,height*.12)
        # The depth control is the total occupied thickness, including relief.
        requested_depth=max(float(root.get('depth',.38)) for root in group)
        fit=min(1,requested_depth/max(float(front_height.max()+back_height.max()),1e-12))
        front_height*=fit;back_height*=fit
        front_height[boundary]=0;back_height[boundary]=0
        vertices=[];front=[];back=[];boundary_set=set(boundary)
        for i,(x,y) in enumerate(p):
            front.append(len(vertices));vertices.append((x,-front_height[i],y))
            if i in boundary_set: back.append(front[-1])
            else: back.append(len(vertices));vertices.append((x,back_height[i],y))
        front=np.asarray(front);back=np.asarray(back)
        faces=np.concatenate([front[f],back[f[:,::-1]]])
        vertices=np.asarray(vertices)
        surface_uv,atlas_size,charts=surface_bark_uv(vertices,faces,group)
        uv=(surface_uv+.015)/(atlas_size+.03)
        result.append(dict(id=group[0]['id'] if len(group)==1 else group[0]['id']+'__fused',
            source_root_ids=[r['id'] for r in group],vertices=vertices,faces=faces,uv=uv,
            materials=np.zeros(len(faces),int),source_faces=np.full(len(faces),-1),smooth=True,
            atlas_size=atlas_size,atlas_roots=group,seed=seed,
            surface_uv=surface_uv,atlas_charts=charts))
    return result


def bark_atlas(part,size=1536):
    """Bake the continuous world-space bark field into surface UV charts."""
    from polygon_roots import stable_seed
    extent=np.asarray(part['atlas_size'])+.03
    width=max(64,round(size*extent[0]/max(extent)))
    height=max(64,round(size*extent[1]/max(extent)))
    world=np.zeros((height*width,3),np.float32)
    shaded_normal=np.zeros((height*width,3),np.float32)
    covered=np.zeros(height*width,bool)
    triangle=part['vertices'][part['faces']]
    face_normal=np.cross(triangle[:,1]-triangle[:,0],triangle[:,2]-triangle[:,0])
    vertex_normal=np.zeros_like(part['vertices'])
    for corner in range(3):np.add.at(vertex_normal,part['faces'][:,corner],face_normal)
    vertex_normal/=np.maximum(np.linalg.norm(vertex_normal,axis=1,keepdims=True),1e-12)
    for face,triangle in zip(part['faces'],part['surface_uv']):
        pixel=(triangle+.015)*np.array([width/extent[0],height/extent[1]])-.5
        x0=max(0,int(np.floor(pixel[:,0].min())));x1=min(width,int(np.ceil(pixel[:,0].max()))+1)
        y0=max(0,int(np.floor(pixel[:,1].min())));y1=min(height,int(np.ceil(pixel[:,1].max()))+1)
        if x0>=x1 or y0>=y1:continue
        a,b,c=triangle
        determinant=cross(b-a,c-a)
        if abs(determinant)<1e-12:continue
        gx,gy=np.meshgrid(np.arange(x0,x1),np.arange(y0,y1))
        sample=np.column_stack([(gx.ravel()+.5)/width*extent[0]-.015,
                                (gy.ravel()+.5)/height*extent[1]-.015])
        delta=sample-a
        beta=(delta[:,0]*(c-a)[1]-delta[:,1]*(c-a)[0])/determinant
        gamma=((b-a)[0]*delta[:,1]-(b-a)[1]*delta[:,0])/determinant
        inside_uv=(beta>=-1e-8)&(gamma>=-1e-8)&(beta+gamma<=1+1e-8)
        if not np.any(inside_uv):continue
        alpha=1-beta[inside_uv]-gamma[inside_uv]
        projected=part['vertices'][face]
        normals=vertex_normal[face]
        index=gy.ravel()[inside_uv]*width+gx.ravel()[inside_uv]
        world[index]=(alpha[:,None]*projected[0]+
                      beta[inside_uv,None]*projected[1]+
                      gamma[inside_uv,None]*projected[2])
        shaded_normal[index]=(alpha[:,None]*normals[0]+
                              beta[inside_uv,None]*normals[1]+
                              gamma[inside_uv,None]*normals[2])
        covered[index]=True
    field=np.zeros(height*width,np.float32)
    albedo=np.zeros((height*width,3),np.float32)
    roughness=np.full(height*width,.88,np.float32)
    roots=part['atlas_roots']
    phase=(stable_seed(f'{part["seed"]}:{roots[0]["id"]}')%1000)/71
    setup=flow_setup(roots)
    active=np.flatnonzero(covered)
    for start in range(0,len(active),65536):
        index=active[start:start+65536];position=world[index]
        q=position[:,[0,2]]
        u,v,_=flow_coordinates(q,roots,setup)
        from stylised_bark import bark_field
        side=bark_field(u,v,phase)
        top=bark_field(position[:,1],position[:,0],phase+3.7)
        end=bark_field(position[:,1],position[:,2],phase+7.3)
        normal=shaded_normal[index]
        weight=np.abs(normal)**4
        weight/=np.maximum(weight.sum(axis=1,keepdims=True),1e-12)
        color=side[0]*weight[:,1,None]+top[0]*weight[:,2,None]+end[0]*weight[:,0,None]
        relief=side[1]*weight[:,1]+top[1]*weight[:,2]+end[1]*weight[:,0]
        painted_roughness=side[2]*weight[:,1]+top[2]*weight[:,2]+end[2]*weight[:,0]
        cap,cut_color,fibres,_,_=end_fields(q,roots,phase)
        albedo[index]=color*(1-cap[:,None])+cut_color*cap[:,None]
        field[index]=relief*(1-cap)+fibres*cap
        roughness[index]=painted_roughness*(1-cap)+.78*cap
    # Extend chart colours through a few empty texels for bilinear sampling.
    filled=covered.reshape(height,width)
    albedo=albedo.reshape(height,width,3)
    field=field.reshape(height,width)
    roughness=roughness.reshape(height,width)
    for _ in range(3):
        changed=False
        for dy,dx in ((-1,0),(1,0),(0,-1),(0,1)):
            source=np.roll(filled,(dy,dx),(0,1))
            if dy<0:source[-1,:]=False
            if dy>0:source[0,:]=False
            if dx<0:source[:,-1]=False
            if dx>0:source[:,0]=False
            take=(~filled)&source
            if np.any(take):
                albedo[take]=np.roll(albedo,(dy,dx),(0,1))[take]
                field[take]=np.roll(field,(dy,dx),(0,1))[take]
                roughness[take]=np.roll(roughness,(dy,dx),(0,1))[take]
                filled[take]=True;changed=True
        if not changed:break
    # The surface charts rotate at their borders; a flat tangent-space normal
    # leaves the smooth welded geometry normal intact across those borders.
    normal=np.zeros((height,width,3),np.float32)
    normal[:,:,0:2]=.5;normal[:,:,2]=1
    orm=np.ones((height,width,3),np.float32)
    orm[:,:,1]=np.clip(roughness,.5,1);orm[:,:,2]=0
    # Blender marks the image sRGB; encode the linear bark colours before they
    # are interpreted by the shader and exported to glTF.
    albedo=np.clip(albedo,0,1)
    albedo=np.where(albedo<=.0031308,12.92*albedo,1.055*albedo**(1/2.4)-.055)
    return albedo.astype(np.float32),normal,orm
