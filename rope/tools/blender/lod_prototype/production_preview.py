"""Bounded visual check using the production detail, atlas and bake path.

Use the existing exported rock so original illumination UVs remain available.
Existing exported geometry keeps its original surface controls. A constructed
rock runs the full production finish, including crease smoothing and chips.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import time
import bpy
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from formations import render, slate, depth_lod
import scene_export as export

args=sys.argv[sys.argv.index('--')+1:]
gpu='--gpu' in args
unrestricted='--unrestricted' in args
contact='--contact' in args
args=[a for a in args if a not in ('--gpu','--unrestricted','--contact')]
contact_views={'opening':(65.5,1.2,2/.65),'wall':(67.,1.2,2/.65),
               'left':(63.,1.,2/.65),'right':(69.,1.2,2/.65),
               'reported':(61.7,0.,2/.65)}
source, destination=map(Path,args[:2])
constructed=Path(args[2]) if len(args)>2 else None
if not unrestricted and len(os.sched_getaffinity(0))>2:
    raise RuntimeError('This check is limited to two CPU cores')
src=json.loads(source.read_text())
if contact and (not constructed or src['name']!='Cube.005'):
    raise ValueError('--contact needs a constructed Cube.005')
if len(src['indices'])>750000:
    raise ValueError('Preview limit is 250k source triangles')
destination.mkdir(parents=True,exist_ok=True)
shutil.copyfile(Path(__file__).resolve().parents[3]/'public/generated/lod-prototype/level.json',destination/'level.json')
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene
scene[render.CAMERA]=json.dumps({'distance':10.2375,'tanHalf':12/70})
positions=np.array(src['positions'],np.float32)
indices=np.array(src['indices'],np.int32).reshape(-1,3)
attrs=np.array(src['attributes'],np.float32)
world=np.array(src['world']).reshape(4,4).T
inverse=np.array(src['inverseWorld']).reshape(4,4).T
normals=attrs[:,:3]@np.linalg.inv(world[:3,:3])
normals=normals[:,[0,2,1]];normals[:,1]*=-1
mesh=bpy.data.meshes.new('Production depth preview')
mesh.from_pydata(positions.tolist(),[],indices.tolist());mesh.update();mesh.shade_smooth()
mesh.normals_split_custom_set(normals[indices.ravel()].tolist())
if constructed:
    # A construction check has genuinely new geometry. Project ONLY the old
    # illumination/reference UVs; adaptive colour/normals are freshly baked.
    # This is an approximate lighting preview, not a replacement emission bake.
    from mathutils import Matrix, Vector
    from mathutils.bvhtree import BVHTree
    from mathutils.geometry import barycentric_transform
    with bpy.data.libraries.load(str(constructed.resolve()),link=False) as (_,dst):
        dst.objects=['SceneryRock']
    built=dst.objects[0]
    recipe=json.loads(built['formation_recipe'])
    bpy.data.meshes.remove(mesh)
    mesh=built.data.copy();mesh.transform(Matrix(recipe['frame']));mesh.update()
    bpy.data.objects.remove(built)
    while mesh.uv_layers:mesh.uv_layers.remove(mesh.uv_layers[0])
    mesh.materials.clear()
    scene[render.CAMERA]=json.dumps(recipe['camera'])
if not constructed:
    for name,values in [('ReferenceColour',attrs[:,3:5]),('ReferenceLight',attrs[:,5:7])]:
        uv=mesh.uv_layers.new(name=name)
        uv.data.foreach_set('uv',values[indices.ravel()].ravel())
ob=bpy.data.objects.new('Production depth preview',mesh);scene.collection.objects.link(ob)
ob['formation_recipe']=json.dumps(recipe) if constructed else '{"params":{"seed":31}}'
if not constructed:ob['export_creases']=False
ob['export_texels']=render.TEXELS_PER_METRE if constructed else 128.
ob['export_map_max']=2048
mesh.materials.append(slate.painted_slate())
# Preserve the actual worker's facet treatment on regenerated geometry.
if not constructed:
    from mathutils import Vector,noise
    facet=mesh.attributes.get('facet') or mesh.attributes.new('facet','FLOAT','FACE')
    facet.data.foreach_set('value',[.5+.5*noise.noise(Vector(tuple(round(v,4) for v in p.normal))*1.5+Vector((17,29,43)))
                                   for p in mesh.polygons])
export.WORKERS=0
if not constructed:export.BAKE_SAMPLES=1
if not gpu:export.bake_device=lambda:'CPU'
if constructed:
    # Only the preview's fixed views need full-density maps. The complete
    # mesh remains in Cycles and the game, including all occluding surfaces.
    sys.path.insert(0,str(Path(__file__).resolve().parent))
    import view_sampling
    if src['name']=='Cube.005':
        view_sampling.VIEWS=((61.7,-10.2375,0.),(64.,-10.2375,0.),
                             (63.,-10.2375,1.5),(65.5,-10.2375,0.))
        if contact:
            view_sampling.VIEWS=tuple((x,-10.2375,-y) for x,y,_ in contact_views.values())
    export.seen_faces=view_sampling.seen_faces
scene.render.threads_mode='AUTO' if unrestricted else 'FIXED'
if not unrestricted:scene.render.threads=2
# Keep long CPU checks observable even when Blender buffers its bake reports.
original_bake_pass=export.bake_pass
def logged_bake_pass(targets, images, kind, **kw):
    stage=time.perf_counter()
    print('PREVIEW_BAKE_START',kind,flush=True)
    if not gpu:
        result=original_bake_pass(targets,images,kind,**kw)
    else:
        # One atlas per burst, as production's split-map workers do. Keep
        # every occluding face, but the other bake targets are 1-pixel images.
        # Reuse nodes instead of accumulating orphan shader graphs per batch.
        image_nodes=export.image_nodes
        result=image_nodes(targets,images)
        sources=[(ob,slot,node,node.image) for ob in targets for slot,mat in enumerate(ob.data.materials)
                 for node in mat.node_tree.nodes if node.type=='TEX_IMAGE' and node!=result[mat] and node.image]
        inactive=bpy.data.images.new('Preview inactive source',width=1,height=1,alpha=True,float_buffer=True)
        inactive.colorspace_settings.name='Non-Color'
        inactive.pixels[:]=(.5,.5,1.,1.)
        blanks={ob:[] for ob in targets}
        for ob in targets:
            for im in images[ob]:
                tiny=bpy.data.images.new('Preview inactive atlas',width=1,height=1,alpha=True,float_buffer=True)
                tiny.colorspace_settings.name=im.colorspace_settings.name
                tiny['stand_in']=True;blanks[ob].append(tiny)
        try:
            export.image_nodes=lambda *_:result
            for index in range(max(map(len,images.values()))):
                batch={ob:[im if i==index else blanks[ob][i] for i,im in enumerate(images[ob])] for ob in targets}
                for ob in targets:
                    for slot,mat in enumerate(ob.data.materials):
                        result[mat].image=batch[ob][export.map_of(ob,slot,len(batch[ob]))]
                # A normal bake otherwise uploads ALL completed colour and
                # detail maps, even though only one atlas receives samples.
                # Production's split workers also use 1-pixel source maps for
                # inactive slots; geometry still supplies bevel/AO occlusion.
                for ob,slot,node,im in sources:
                    node.image=im if export.map_of(ob,slot,len(images[ob]))==index else inactive
                print('PREVIEW_ATLAS',kind,index+1,'of',max(map(len,images.values())),flush=True)
                original_bake_pass(targets,batch,kind,**kw)
                if not unrestricted:time.sleep(1.5)
        finally:
            export.image_nodes=image_nodes
            for _,_,node,im in sources:node.image=im
            for ob in targets:
                for slot,mat in enumerate(ob.data.materials):
                    result[mat].image=images[ob][export.map_of(ob,slot,len(images[ob]))]
                for im in blanks[ob]:bpy.data.images.remove(im)
            bpy.data.images.remove(inactive)
    print('PREVIEW_BAKE_DONE',kind,time.perf_counter()-stage,flush=True)
    return result
export.bake_pass=logged_bake_pass
started=time.perf_counter()
export.bake_procedural_textures([ob])
elapsed=time.perf_counter()-started
mesh=ob.data
if constructed:
    # Reference UVs are a viewer-only comparison aid. Add them AFTER the real
    # crease rebuild/bake/bend so they cannot change its attribute handling.
    tree=BVHTree.FromPolygons(positions.tolist(),indices.tolist(),all_triangles=True)
    projected=np.empty((len(mesh.loops),4),np.float32)
    basis=[Vector((1,0,0)),Vector((0,1,0)),Vector((0,0,1))]
    for poly in mesh.polygons:
        nearest=tree.find_nearest(poly.center)[2]
        tri=indices[nearest]
        corners=[Vector(p) for p in positions[tri]]
        for li in poly.loop_indices:
            point=mesh.vertices[mesh.loops[li].vertex_index].co
            weights=np.clip(barycentric_transform(point,*corners,*basis),0.,1.)
            if weights.sum()<1e-12:weights=np.array([1.,0.,0.])
            projected[li]=weights@attrs[tri,3:7]/weights.sum()
    for name,values in [('ReferenceColour',projected[:,:2]),('ReferenceLight',projected[:,2:4])]:
        uv=mesh.uv_layers.new(name=name)
        uv.data.foreach_set('uv',values.ravel())
mesh.calc_loop_triangles()
count=len(mesh.materials)
parts=[]
for slot in range(count):
    loop_ids=np.array([list(t.loops) for t in mesh.loop_triangles if t.material_index==slot],np.int32).ravel()
    if not len(loop_ids):
        raise RuntimeError('Production allocated an empty atlas')
    vertex=np.array([mesh.loops[int(i)].vertex_index for i in loop_ids])
    co=np.array([tuple(mesh.vertices[int(i)].co) for i in vertex])
    co=co[:,[0,2,1]];co[:,2]*=-1
    co=co@inverse[:3,:3].T+inverse[:3,3]
    normal=np.array([tuple(mesh.corner_normals[int(i)].vector) for i in loop_ids])
    normal=normal[:,[0,2,1]];normal[:,2]*=-1
    normal=normal@world[:3,:3]
    lengths=np.linalg.norm(normal,axis=1)
    # Degenerate source triangles can carry a zero split normal. Keep these
    # invisible faces finite rather than sending NaNs into the game renderer.
    normal[lengths<1e-12]=(0,1,0)
    normal/=np.linalg.norm(normal,axis=1)[:,None]
    arrays={'position':co,'normal':normal}
    for name,uv_name in [('uv','ReferenceColour'),('uv1','ReferenceLight'),('uv2',export.BAKE_UV)]:
        values=np.array([tuple(mesh.uv_layers[uv_name].data[int(i)].uv) for i in loop_ids])
        if name=='uv2':values[:,1]=1-values[:,1]
        arrays[name]=values
    blob=bytearray();layout={}
    for name,values in arrays.items():
        values=np.asarray(values,dtype='<f4')
        layout[name]={'size':values.shape[1],'count':values.size,'offset':len(blob)}
        blob.extend(values.tobytes())
    at=len(blob);blob.extend(np.arange(len(loop_ids),dtype='<u4').tobytes())
    filename=f'production-{slot}.bin';(destination/filename).write_bytes(blob)
    part={'file':filename,'attributes':layout,'indices':{'offset':at,'count':len(loop_ids)},'textureFactor':1}
    for kind,key in [('baked colour','bakedColor'),('baked normal','bakedNormal')]:
        im=bpy.data.images[export.image_name(ob,kind,slot,count)]
        filename=f'production-{slot}-{key}.png';im.filepath_raw=str((destination/filename).resolve())
        im.file_format='PNG';im.save();part[key]=filename
        if key=='bakedColor':part['bakeSize']=im.size[0]
    band=mesh.attributes[depth_lod.FACE_BAND]
    bands={band.data[t.polygon_index].value for t in mesh.loop_triangles if t.material_index==slot}
    assert len(bands)==1,bands
    part['band']=bands.pop();parts.append(part)
report={'source':src['name'],'sourceTriangles':len(indices),'adaptiveTriangles':len(mesh.loop_triangles),
        'bakeDevice':'GPU (one atlas per burst)' if gpu else 'CPU',
        'productionBakeSeconds':elapsed,'cpuCores':len(os.sched_getaffinity(0)) if unrestricted else 2,
        'samples':export.BAKE_SAMPLES,'previewTexels':ob['export_texels'],
        'scope':'Production depth partition, atlas allocation, chip/subfacet generation and surface bake. '
                'Crease deformation disabled only for this lighting-preserving visual check; tested by the export/cache regression.',
        'maps':[{'level':p['band'],'side':p['bakeSize']} for p in parts]}
if constructed:
    report['scope']='Fully regenerated formation with automatic construction budgets, then production depth partition and surface bake. '
    report['scope']+='Original illumination is projected approximately onto the new geometry; final lighting needs a scene export. The full production crease, smoothing, strip and chip passes are enabled, with production sampling and 2048-pixel atlas caps.'
    report['constructed']=True
    report['scope']+=' Texture visibility is scoped to the preview cameras; unseen surfaces keep reduced-density maps.'
if contact:report['views']=contact_views
(destination/'chunks.json').write_text(json.dumps({'chunks':parts,'report':report},indent=2))
print('PRODUCTION_DEPTH_PREVIEW_OK',json.dumps(report),flush=True)
