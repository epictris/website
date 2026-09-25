"""Irregular 3D fracture cells wrap continuously across the centre and sides."""
import numpy as np
from scipy.spatial import HalfspaceIntersection,ConvexHull
from shapely import Polygon,Point
from shapely.geometry.polygon import orient

def build_chunks(spec):
    from rockgen import Mesh,prism,triangulate_cap
    from volume_geometry import camera_basis
    from params import param
    p=orient(Polygon(spec['outer'],spec['holes']),1)
    depth=spec['depth']; rng=np.random.default_rng(spec['seed']+882)
    # The support fills only the bottoms of narrow seams. It is a thick solid,
    # not a collar or a division between front and back halves.
    inset=spec['tolerance']*(.50 if spec.get('join_undercuts') else .60)
    support=p.buffer(-inset,join_style='mitre',mitre_limit=2)
    from rockgen import polygons
    support_half=param(spec,'supportDepth')
    coreparts=[prism(q,-depth*support_half,depth*support_half,'buried_seam_support_'+str(i),0) for i,q in enumerate(polygons(support))]
    # Keep an inset small enough to preserve acute input corners.
    while p.boundary.hausdorff_distance(support.boundary)>spec['tolerance']*.90:
        inset*=.5; support=p.buffer(-inset,join_style='mitre',mitre_limit=2)
        coreparts=[prism(q,-depth*support_half,depth*support_half,'buried_seam_support_'+str(i),0) for i,q in enumerate(polygons(support))]
    chunk_half=param(spec,'chunkDepth')
    bounds=np.array([[p.bounds[0],p.bounds[1],-depth*chunk_half],[p.bounds[2],p.bounds[3],depth*chunk_half]])
    broad=spec.get('broad_side_chunks',False)
    # Keep the original chunk geometry; only sample fewer, broader cells for
    # the balanced hybrid recipe.
    count=(max(2,int(spec['slabs']*param(spec,'chunkShare'))) if spec.get('game_low_poly') else
           max(2,int(spec['slabs']*.90)) if spec.get('balanced_hybrid') else
           (max(16,int(spec['slabs']*.90)) if broad else max(42,int(spec['slabs']*3.0))))
    candidates=[]
    for _ in range(count*200):
        v=rng.uniform(bounds[0]+1e-4,bounds[1]-1e-4)
        if p.contains(Point(v[:2])): candidates.append(v)
        if len(candidates)>=count*25: break
    candidates=np.array(candidates)
    # A 3D distribution, with no front/back split or aligned centre seam.
    chosen=[candidates[0]]; distance=np.full(len(candidates),1e20)
    metric=np.array([1,.80,.65] if broad else [1,.83,1.12])
    for _ in range(count-1):
        distance=np.minimum(distance,np.linalg.norm((candidates-chosen[-1])*metric,axis=1))
        chosen.append(candidates[np.argmax(distance*rng.uniform(.85,1.15,len(distance)))])
    seeds=np.array(chosen)
    parts=list(coreparts)
    # Slight anisotropy produces broad oblique chunks instead of regular cubes.
    transform=np.array([[1,.11,.10],[0,.80,-.08],[0,0,.65 if broad else 1.10]])
    transformed=seeds@transform.T
    shrink_min,shrink_max=param(spec,'chunkShrinkMin'),param(spec,'chunkShrinkMax')
    scale_min,scale_max=param(spec,'chunkDepthScaleMin'),param(spec,'chunkDepthScaleMax')
    shift,tilt=param(spec,'chunkDepthShift'),param(spec,'chunkTilt')
    bevel_min,bevel_max=param(spec,'chunkBevelMin'),param(spec,'chunkBevelMax')
    for i,(seed,s) in enumerate(zip(seeds,transformed)):
        planes=[]
        for j,other in enumerate(transformed):
            if i==j: continue
            delta=other-s
            normal=delta@transform
            planes.append([*normal,-(np.dot(other,other)-np.dot(s,s))/2])
        for axis in range(3):
            n=np.zeros(3); n[axis]=1
            planes.append([*n,-bounds[1,axis]])
            planes.append([*(-n),bounds[0,axis]])
        vertices=HalfspaceIntersection(np.array(planes),seed).intersections
        # Small unequal joint gaps; all sides belong to the same 3D chunks.
        centre=vertices.mean(axis=0)
        vertices=centre+(vertices-centre)*np.array([rng.uniform(shrink_min,shrink_max),rng.uniform(shrink_min,shrink_max),rng.uniform(.93,.965)])
        # Vary the front/back chunk faces; XY remains inside the clipping prism.
        vertices[:,2]=centre[2]+(vertices[:,2]-centre[2])*(rng.uniform(scale_min,scale_max) if broad else rng.uniform(.80,1.30))+rng.uniform(-shift,shift)*depth
        vertices[:,2]+=(vertices[:,:2]-centre[:2])@rng.uniform(-tilt if broad else -.32,tilt if broad else .32,2)
        hull=ConvexHull(vertices)
        mesh=Mesh('fracture_chunk_'+str(i),int(rng.integers(0,5)))
        for tri in hull.simplices: mesh.face(vertices[tri])
        part=mesh.dump(); part['clip_to_outline']=True
        part['chunk_bevel']=float(rng.uniform(bevel_min,bevel_max))
        parts.append(part)
    clip=prism(p,-depth*1.3,depth*1.3,'polygon_envelope',0)
    guide=Mesh('gameplay_section',0); triangulate_cap(guide,p,lambda x,y:0)
    return dict(spec=dict(spec,construction='volume',camera_basis=camera_basis(spec).tolist()),
                parts=parts,clip=clip,cell_count=count,gameplay_section=guide.dump(),
                chunk_seeds=seeds.tolist(),chunk_materials=[v['material'] for v in parts[len(coreparts):]],chunk_transform=transform.tolist())
