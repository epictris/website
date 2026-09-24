"""Only the central gameplay cross-section is constrained to the polygon."""
import math
import numpy as np
import shapely
from shapely import Polygon,Point
from shapely.geometry.polygon import orient

def build_centre(spec):
    from rockgen import Mesh,triangulate_cap
    from volume_geometry import camera_basis,make_block
    p=orient(Polygon(spec['outer'],spec['holes']),1)
    depth=spec['depth']; rng=np.random.default_rng(spec['seed']+2041)
    perimeter=spec.get('fit_mode')=='playable_perimeter'
    basis=camera_basis(spec)
    dense=shapely.segmentize(p,.48)
    rings=[np.array(r.coords[:-1]) for r in [dense.exterior,*dense.interiors]]
    normals=[]
    for ring in rings:
        tangent=np.roll(ring,-1,axis=0)-np.roll(ring,1,axis=0)
        normal=np.column_stack([tangent[:,1],-tangent[:,0]])
        normal/=np.linalg.norm(normal,axis=1)[:,None]
        normals.append(normal)
    # Independent front/back shapes. Sparse broad contour breaks, never a
    # dense sampled taper; only a narrow central collar retains the polygon.
    stacks=[]
    for side in [-1,1]:
        offsets=[rng.uniform(-.24,-.08,len(r))*depth if perimeter else rng.uniform(-.23,.12,len(r))*depth for r in rings]
        # Smooth once along the contour to form broad wedges, not saw teeth.
        offsets=[.6*a+.2*np.roll(a,1)+.2*np.roll(a,-1) for a in offsets]
        end=None
        for factor in [1,.65,.35,.15,0]:
            candidate=[r+n*a[:,None]*factor for r,n,a in zip(rings,normals,offsets)]
            shape=Polygon(candidate[0],candidate[1:])
            if shape.is_valid and shape.area>p.area*.4 and (not perimeter or shape.difference(p).area<1e-10):
                end=candidate; break
        stack=[]
        for t,blend in [(.045,0),(.25,.50),(.51,1)]:
            contours=[]
            for start,finish in zip(rings,end):
                coords=start+(finish-start)*blend
                contours.append([(*xy,side*depth*(t+blend*.045*math.sin(xy[0]*2.1+xy[1]*1.6+spec['seed']))) for xy in coords])
            stack.append(contours)
        stacks.append(stack)
    sections=list(reversed(stacks[0]))+stacks[1]
    def loft(sections,name,depth_scale=1):
        mesh=Mesh(name,0)
        for a,b in zip(sections[:-1],sections[1:]):
            for ra,rb in zip(a,b):
                for i in range(len(ra)):
                    j=(i+1)%len(ra)
                    mesh.face([ra[i],ra[j],rb[j]])
                    mesh.face([ra[i],rb[j],rb[i]])
        for contours,side in [(sections[0],-1),(sections[-1],1)]:
            shape=Polygon([[v[:2] for v in r] for r in contours][0],[[v[:2] for v in r] for r in contours][1:])
            triangulate_cap(mesh,shape,lambda x,y:side*depth*depth_scale*(.51+.045*math.sin(x*2.1+y*1.6+spec['seed'])),reverse=side<0)
        return mesh
    core=loft(sections,'asymmetric_centre_plane_core')
    clip=None
    if perimeter:
        # An irregular inward-tapering envelope, not a straight extrusion.
        # Expanding it in depth lets the outer slabs form strong sculpted relief,
        # while its central rim remains the outermost visible gameplay boundary.
        envelope=[[[[v[0],v[1],v[2]*1.60] for v in ring] for ring in section] for section in sections]
        clip=loft(envelope,'inward_tapered_perimeter_envelope',1.60).dump()
    parts=[core.dump()]
    count=spec['slabs']+6
    candidates=[]
    for _ in range(count*100):
        xy=rng.uniform(p.bounds[:2],p.bounds[2:])
        if p.contains(Point(xy)): candidates.append(xy)
        if len(candidates)>=count*15: break
    chosen=[candidates.pop(0)]
    while len(chosen)<count:
        best=max(range(len(candidates)),key=lambda i:min(np.linalg.norm(candidates[i]-v) for v in chosen))
        chosen.append(candidates.pop(best))
    width=p.bounds[2]-p.bounds[0]; height=p.bounds[3]-p.bounds[1]
    for i,xy in enumerate(chosen):
        side=-1 if i%3==0 else 1
        d=side*depth*rng.uniform(.39,.51)
        centre=np.array([*xy,d])@basis.T
        block=make_block(centre,width*rng.uniform(.22,.39),depth*rng.uniform(.36,.58),
                         height*rng.uniform(.20,.47),math.radians(rng.uniform(-40,40)),
                         rng,i,basis,Mesh,.50)
        # Surface masses may overhang freely, but cannot intrude into the
        # gameplay collar. Their overlap with the core joins them into a solid.
        for v in block['vertices']:
            v[2]=side*max(side*v[2],depth*.12)
        block['clip_to_outline']=perimeter
        parts.append(block)
    guide=Mesh('gameplay_section',0)
    triangulate_cap(guide,p,lambda x,y:0)
    result=dict(spec=dict(spec,construction='volume',camera_basis=basis.tolist()),parts=parts,cell_count=count,gameplay_section=guide.dump())
    if clip is not None: result['clip']=clip
    return result
