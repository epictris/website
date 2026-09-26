"""Resolve coarse editable outlines into shared render/physics contours."""
import copy
import numpy as np


def resolve_outlines(data):
    from polygon_roots_2d import validate_shapes, signed_area
    resolved=copy.deepcopy(data)
    for source,root in zip(data['roots'],resolved['roots']):
        p=np.asarray(source['polygon'],float);n=len(p)
        amount=source.get('corner_rounding',0);broken=set(source.get('broken_edges',[]))
        marked=set(source['grab_edges']);segments=[];profiles=[]
        trim=.42*amount
        entries=p+(np.roll(p,1,axis=0)-p)*trim
        exits=p+(np.roll(p,-1,axis=0)-p)*trim
        def segment(a,b,edge,grab):
            if np.linalg.norm(b-a)>1e-8:segments.append((a,b,edge,grab))
        for i in range(n):
            if amount:
                # Quadratic fillet; midpoint divides ownership between source edges.
                ts=np.linspace(0,1,5)
                curve=[(1-t)**2*entries[i]+2*(1-t)*t*p[i]+t*t*exits[i] for t in ts]
                for j,(a,b) in enumerate(zip(curve,curve[1:])):
                    segment(a,b,(i-1)%n if j<2 else i,i in marked and (i-1)%n in marked)
            a=exits[i];b=entries[(i+1)%n]
            if i in broken:
                tangent=b-a;length=np.linalg.norm(tangent)
                inward=np.array([-tangent[1],tangent[0]])/length*np.sign(signed_area(p))
                # Deterministic chipped outline: seeds never move gameplay geometry.
                ts=[0,.13,.22,.31,.44,.53,.64,.78,.89,1]
                chips=[0,.25,1,.08,.65,.12,.95,.15,.55,0]
                amplitude=min(.027,length*.12)
                points=[a+t*tangent+c*amplitude*inward for t,c in zip(ts,chips)]
                for u,v in zip(points,points[1:]):segment(u,v,i,i in marked)
                # The exposed cross-section spans the original end, including
                # its rounded shoulders; the chipped straight span is narrower.
                original_length=np.linalg.norm(p[(i+1)%n]-p[i])
                profiles.append(dict(a=p[i].tolist(),b=p[(i+1)%n].tolist(),inward=inward.tolist(),
                                     band=min(.16,max(.065,original_length*.38)),depth=source.get('depth',.38)))
            else:segment(a,b,i,i in marked)
        root['polygon']=[a.tolist() for a,_,__,___ in segments]
        root['grab_edges']=[i for i,s in enumerate(segments) if s[3]]
        root['source_edges']=[s[2] for s in segments]
        root['end_profiles']=profiles
        root['flow_polygon']=copy.deepcopy(source['polygon'])
        root.pop('corner_rounding',None);root.pop('broken_edges',None)
    try:validate_shapes(resolved)
    except ValueError as error:
        raise ValueError(f'Rounded/broken outline is invalid; reduce rounding or adjust the source: {error}') from error
    return resolved
