"""Give thin clipped wedges a solid backing before the final rock union."""
import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def reinforce_chunks(pieces, parts, spec):
    retained=[]
    removed=backed=0
    from params import param
    depth=spec['depth']
    minimum=depth*param(spec,'backingDepth')
    sliver_volume=param(spec,'sliverVolume'); sliver_thickness=param(spec,'sliverThickness')
    for obj,part in zip(pieces,parts):
        if part['name'].startswith('buried_'):
            retained.append(obj)
            continue
        bm=bmesh.new(); bm.from_mesh(obj.data); bm.normal_update()
        area=sum(f.calc_area() for f in bm.faces)
        volume=abs(bm.calc_volume(signed=True)) if bm.faces else 0
        # Discard shallow remnants, not the substantial overlapping masses.
        if not area or volume<depth**3*sliver_volume or 2*volume/area<depth*sliver_thickness:
            bm.free(); bpy.data.objects.remove(obj,do_unlink=True)
            removed+=1
            continue
        tree=BVHTree.FromBMesh(bm)
        points=[v.co.copy() for v in bm.verts]
        extra=[]
        for face in bm.faces:
            if face.calc_area()<depth**2*.00008:
                continue
            centre=face.calc_center_median()
            normal=face.normal.copy()
            hit=tree.ray_cast(centre-normal*.0001,-normal,depth*3)
            if hit[0] is not None and hit[3]<minimum*.80:
                # Back the whole face rather than rounding its knife edge.
                # This gives a shallow wedge a real shoulder and joins it more
                # deeply to the neighbouring mass during the later union.
                extra.extend(v.co-normal*minimum for v in face.verts)
        bm.free()
        if extra:
            hull=bmesh.new()
            for point in points+extra:
                hull.verts.new(point)
            bmesh.ops.remove_doubles(hull,verts=list(hull.verts),dist=1e-6)
            bmesh.ops.convex_hull(hull,input=list(hull.verts),use_existing_faces=False)
            unused=[v for v in hull.verts if not v.link_faces]
            if unused: bmesh.ops.delete(hull,geom=unused,context='VERTS')
            bmesh.ops.recalc_face_normals(hull,faces=list(hull.faces))
            for face in hull.faces: face.material_index=part['material']
            hull.to_mesh(obj.data); hull.free(); obj.data.update()
            backed+=1
        retained.append(obj)
    print(f"Solid chunks: removed {removed} slivers; backed {backed} shallow wedges",flush=True)
    return retained



def close_narrow_recesses(obj,spec):
    """Inflate/union/deflate the surface to fill thin slots continuously."""
    import numpy as np
    depth=spec['depth']; radius=depth*.045
    original=bmesh.new(); original.from_mesh(obj.data)
    original.normal_update(); surface=BVHTree.FromBMesh(original); original.free()
    bpy.context.view_layer.objects.active=obj
    for sign in [1,-1]:
        obj.data.update()
        count=len(obj.data.vertices)
        coords=np.empty(count*3,dtype=np.float32)
        normals=np.empty(count*3,dtype=np.float32)
        obj.data.vertices.foreach_get('co',coords)
        obj.data.vertices.foreach_get('normal',normals)
        coords=coords.reshape((-1,3)); normals=normals.reshape((-1,3))
        t=np.clip((np.abs(coords[:,2])-depth*.035)/(depth*.14),0,1)
        weight=t*t*(3-2*t)
        coords+=normals*(radius*sign*weight[:,None])
        obj.data.vertices.foreach_set('co',coords.ravel())
        obj.data.update()
        remesh=obj.modifiers.new('Fill shallow seams' if sign>0 else 'Restore broad rock faces','REMESH')
        remesh.mode='VOXEL'; remesh.voxel_size=.010
        remesh.adaptivity=.04
        bpy.ops.object.modifier_apply(modifier=remesh.name)
        smooth=obj.modifiers.new('Blend the filled rock shoulders','SMOOTH')
        smooth.factor=.7; smooth.iterations=3
        bpy.ops.object.modifier_apply(modifier=smooth.name)
    print('Filled narrow recesses with a continuous rock surface',flush=True)

    # Restore the existing broad faces wherever their normal agrees with the
    # filled surface. New shoulders across slots have a different normal and
    # stay filled rather than being projected back into the old recess.
    obj.data.update()
    count=len(obj.data.vertices)
    coords=np.empty(count*3,dtype=np.float32); normals=np.empty(count*3,dtype=np.float32)
    obj.data.vertices.foreach_get('co',coords); obj.data.vertices.foreach_get('normal',normals)
    coords=coords.reshape((-1,3)); normals=normals.reshape((-1,3))
    for i,(point,normal) in enumerate(zip(coords,normals)):
        hit=surface.find_nearest(Vector(point))
        if hit[0] is not None and hit[3]<radius*1.2:
            agreement=hit[1].dot(Vector(normal))
            if agreement>.75:
                blend=min(1,(agreement-.75)/.15)
                coords[i]=point*(1-blend)+np.array(hit[0])*blend
    obj.data.vertices.foreach_set('co',coords.ravel()); obj.data.update()
