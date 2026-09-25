"""Overlapping natural faces on a continuous, chunked rock body."""
def build_hybrid(spec):
    from chunk_geometry import build_chunks
    from volume_geometry import build_volume
    from params import param
    body=build_chunks(spec)
    depth=spec['depth']
    # Keep the structural chunks around the centre and sides; let the natural
    # independent slabs form the foremost faces instead of a tiled front cap.
    flatten=param(spec,'chunkFlatten')
    for part in body['parts']:
        for v in part['vertices']:
            v[2]*=flatten
    natural=build_volume(spec)
    proud=param(spec,'slabProud')
    for part in natural['parts'][1:]:
        if spec.get('solid_chunk_edges') and part['name'].startswith('secondary_plate_'):
            continue
        centre=sum(v[2] for v in part['vertices'])/len(part['vertices'])
        side=1 if centre>=0 else -1
        for v in part['vertices']:
            v[2]+=side*depth*proud
        part['name']='overlapping_'+part['name']
        part['clip_to_outline']=True
        part['chunk_bevel']=.020
        body['parts'].append(part)
    # Broad, shallow deviations along polygon edges avoid a ruler-straight
    # clipping wall while keeping original corners and the gameplay fit budget.
    from shapely import Polygon
    from shapely.geometry.polygon import orient
    from rockgen import prism
    import numpy as np
    p=orient(Polygon(spec['outer'],spec['holes']),1)
    rng=np.random.default_rng(spec['seed']+520)
    rings=[]
    for ring in [p.exterior,*p.interiors]:
        points=[]
        for a,b in zip(list(ring.coords)[:-1],list(ring.coords)[1:]):
            a,b=np.array(a),np.array(b); delta=b-a
            normal=np.array([-delta[1],delta[0]])/np.linalg.norm(delta)
            points.append(a)
            for t in [.30,.68]:
                points.append(a+delta*t+normal*rng.uniform(-.45,.55)*spec['tolerance'])
        rings.append(points)
    varied=Polygon(rings[0],rings[1:])
    if varied.is_valid and varied.boundary.hausdorff_distance(p.boundary)<spec['tolerance']*.65:
        body['clip']=prism(varied,-depth*1.3,depth*1.3,'varied_polygon_envelope',0)
    return body


def taper_chunk(obj,spec,is_support=False,part_name=None):
    """Tilt individual chunk sides inward, retaining their broad planar faces."""
    import numpy as np
    import bmesh,hashlib
    from mathutils import Vector
    if not obj.data.vertices: return
    bm=bmesh.new(); bm.from_mesh(obj.data)
    # Splitting existing faces at zero keeps the contact plane exact while
    # allowing independent front and back slopes without opening a seam.
    bmesh.ops.bisect_plane(bm,geom=list(bm.verts)+list(bm.edges)+list(bm.faces),
        dist=1e-7,plane_co=Vector((0,0,0)),plane_no=Vector((0,0,1)),
        clear_inner=False,clear_outer=False)
    bm.to_mesh(obj.data); bm.free()
    coords=np.array([v.co[:] for v in obj.data.vertices]); depth=spec['depth']
    xy=coords[:,:2]; centre=xy.mean(axis=0)
    samples=xy if is_support else centre[None,:]
    edges=[]; distances=[]
    for ring in [spec['outer'],*spec['holes']]:
        ring=np.array(ring,dtype=float)
        for a,b in zip(ring,np.roll(ring,-1,axis=0)):
            delta=b-a; length=np.linalg.norm(delta)
            along=np.clip(((samples-a)@delta)/(length*length),0,1)
            distances.append(np.linalg.norm(samples-(a+along[:,None]*delta),axis=1))
            edges.append(np.array([-delta[1],delta[0]])/length)
    nearest=np.min(distances,axis=0)
    direction=np.zeros_like(samples); total=np.zeros(len(samples))
    for dist,normal in zip(distances,edges):
        weight=np.exp(-(dist-nearest)/(depth*(.03 if is_support else .10)))
        direction+=weight[:,None]*normal; total+=weight
    direction/=total[:,None]
    seed=int(hashlib.sha256((part_name or obj.name).encode()).hexdigest()[:8],16)+spec['seed']
    rng=np.random.default_rng(seed)
    from params import param
    front,back=rng.uniform(param(spec,'taperSlopeMin'),param(spec,'taperSlopeMax'),2)
    slopes=np.where(coords[:,2]>0,front,back)
    if is_support:
        slopes[:]=param(spec,'supportSlope')
        influence=1
    else:
        influence=np.exp(-nearest/(depth*param(spec,'taperReach')))
    travel=np.abs(coords[:,2])*slopes*influence
    coords[:,:2]+=travel[:,None]*direction
    obj.data.vertices.foreach_set('co',coords.ravel())
    obj.data.update()
