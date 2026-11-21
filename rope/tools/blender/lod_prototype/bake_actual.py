"""Small CPU-only surface bake of the actual cave rock's prepared depth chunks.

No scene export or geometry regeneration. Uses the production slate shader and
UV packer, with one worker, two CPU cores, 1 preview sample and a 2048 colour-map cap.
All chunks remain present as occluders while each is baked; no cut-face caps.
"""
import json
import math
import os
from pathlib import Path
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector, noise

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
sys.path.insert(0,str(HERE))
import scene_export as export
from formations import slate
from native import build as native_build
from uv_validation import overlapping_faces


def repair_final_uvs(obj, layout):
    """Validate the actual bake mesh, after the unwrap's welded-copy transfer.

    Lost corners on collapsed faces can land in unrelated charts during that
    transfer. Repair their final triangles, not only the temporary welded mesh.
    Geometry, normals and the original illumination UVs remain untouched.
    """
    import native
    mesh=obj.data
    bpy.context.view_layer.update()  # unwrap removed its temporary active object
    export.select_only([obj],obj)
    mesh.uv_layers.active=mesh.uv_layers[export.BAKE_UV]
    uv=np.empty(len(mesh.loops)*2,np.float32)
    mesh.uv_layers.active.data.foreach_get('uv',uv)
    uv=uv.reshape(-1,2).astype(np.float64)
    corners=np.empty(len(mesh.loops),np.int32)
    mesh.loops.foreach_get('vertex_index',corners)
    positions=np.empty(len(mesh.vertices)*3,np.float32)
    mesh.vertices.foreach_get('co',positions)
    positions=positions.reshape(-1,3)
    _,welded=np.unique(positions,axis=0,return_inverse=True)
    corner_vertices=welded[corners].astype(np.int64)
    triangles=np.arange(len(corners),dtype=np.int64).reshape(-1,3)
    pts=positions[corners].reshape(-1,3,3).astype(np.float64)
    area=np.linalg.norm(np.cross(pts[:,1]-pts[:,0],pts[:,2]-pts[:,0]),axis=1)/2
    tex=uv.reshape(-1,3,2)
    a,b=tex[:,1]-tex[:,0],tex[:,2]-tex[:,0]
    uv_area=np.abs(a[:,0]*b[:,1]-a[:,1]*b[:,0])/2
    ratio=uv_area/np.maximum(area,1e-30)
    typical=float(np.median(ratio[area>export.DEGENERATE_AREA]))
    density=math.sqrt(typical)
    # A transferred sliver may span most of the atlas and overlap thousands
    # of valid faces. Fix the disproportionate chart first, preserving those
    # neighbours instead of needlessly splitting all of them into tiny charts.
    distorted=np.flatnonzero(ratio>4*typical)
    settings=bpy.context.scene.tool_settings
    old_sync,old_select=settings.use_uv_select_sync,tuple(settings.mesh_select_mode)
    settings.use_uv_select_sync=True;settings.mesh_select_mode=(False,False,True)
    repaired=set()
    try:
        for attempt in range(5):
            if attempt==0 and len(distorted):
                affected=distorted
            else:
                # Edit-mode round trips can rotate polygon loops. Select on a
                # disposable copy so bake UV corners retain their exact order
                # relative to the original position/normal/lightmap buffers.
                check_mesh=mesh.copy()
                check=bpy.data.objects.new('Final UV overlap check',check_mesh)
                bpy.context.scene.collection.objects.link(check)
                export.select_only([check],check)
                bpy.ops.object.mode_set(mode='EDIT')
                bpy.ops.mesh.select_all(action='DESELECT')
                bpy.ops.uv.select_overlap()
                bpy.ops.object.mode_set(mode='OBJECT')
                overlap=np.empty(len(mesh.polygons),bool)
                check_mesh.polygons.foreach_get('select',overlap)
                bpy.data.objects.remove(check,do_unlink=True)
                bpy.data.meshes.remove(check_mesh)
                bpy.context.view_layer.update()
                export.select_only([obj],obj)
                final_uv=np.empty(len(mesh.loops)*2,np.float32)
                mesh.uv_layers.active.data.foreach_get('uv',final_uv)
                final_uv=final_uv.reshape(-1,3,2).astype(np.float64)
                u,v=final_uv[:,1]-final_uv[:,0],final_uv[:,2]-final_uv[:,0]
                # Collapsed point charts have no raster coverage. Blender can
                # select them when their point lies inside another chart.
                overlap &= (u[:,0]*v[:,1]-u[:,1]*v[:,0])!=0
                affected=np.flatnonzero(overlap)
                # Float32 storage can turn a shared edge into a microscopic
                # overlap. Require measurable coverage: 0.001 layout texel².
                affected=overlapping_faces(final_uv,affected,1e-3/layout**2)
            if not len(affected):
                print('FINAL_UV_VALIDATED',obj.name,'repaired',len(repaired),flush=True)
                return len(repaired)
            if attempt==4:
                raise RuntimeError(f'{obj.name}: {len(affected)} final UV overlaps remain; refusing to bake')
            print('REPAIR_FINAL_UV',obj.name,'pass',attempt,'faces',len(affected),flush=True)
            if attempt>=2:
                print('REPAIR_REMAINDER',[(int(f),float(area[f])) for f in affected[:12]],flush=True)
            repaired.update(affected.tolist())
            for f in affected:
                # A fresh planar chart also fixes distorted triangles assembled
                # from nearest corners belonging to several unrelated charts.
                edge=pts[f,1]-pts[f,0];length=np.linalg.norm(edge)
                rel=pts[f,2]-pts[f,0]
                along=float(rel@edge/max(length,1e-30))
                height=float(np.linalg.norm(np.cross(edge,rel))/max(length,1e-30))
                uv[triangles[f]]=np.array([[0,0],[max(length*density,1/layout),0],
                                           [along*density,max(height*density,1/layout)]])
                if area[f]<export.DEGENERATE_AREA:
                    uv[triangles[f]]=0
                corner_vertices[triangles[f]]=len(mesh.vertices)+triangles[f]
            grid=min(export.PACK_GRID,layout//2)
            gap=max(1,math.ceil(export.PACK_GAP_PX*grid/(layout//2)))
            uv,share=native.pack_islands(uv,corner_vertices,triangles,grid,gap)
            if share<0:
                raise RuntimeError(f'{obj.name}: repaired final UV charts do not fit')
            mesh.uv_layers.active.data.foreach_set('uv',np.asarray(uv,np.float32).ravel())
    finally:
        settings.use_uv_select_sync=old_sync;settings.mesh_select_mode=old_select


def main():
    started=time.perf_counter()
    generation=str(time.time_ns())
    output=Path(sys.argv[sys.argv.index('--')+1]).resolve()
    source=Path(sys.argv[sys.argv.index('--')+2]).resolve()
    if len(os.sched_getaffinity(0))>2:raise RuntimeError('Use run_bake.py to cap CPU use')
    if not native_build.library_path().exists():
        raise RuntimeError('Existing UV-packer library is missing; do not compile during the other export')
    src=json.loads(source.read_text())
    manifest=json.loads((output/'chunks.json').read_text())
    if 'surfaceBake' in manifest['report']:
        manifest=json.loads((output/'chunks-before-bake.json').read_text())
    if manifest['report']['source']!=src['name']:
        raise ValueError('Prepared chunks belong to a different source rock')
    (output/'chunks-before-bake.json').write_text(json.dumps(manifest,indent=2))
    world=np.array(src['world']).reshape(4,4).T
    for obj in list(bpy.data.objects):bpy.data.objects.remove(obj,do_unlink=True)
    scene=bpy.context.scene
    scene.render.engine='CYCLES'
    scene.cycles.device='CPU'
    scene.cycles.samples=1
    scene.render.threads_mode='FIXED';scene.render.threads=2
    scene.render.bake.use_clear=False
    scene.render.bake.margin=0
    prepared=[]
    for i,part in enumerate(manifest['chunks']):
        binary=(output/part['file']).read_bytes()
        arrays={name:np.frombuffer(binary,np.float32,count=a['count'],offset=a['offset']).reshape(-1,a['size']).copy()
                for name,a in part['attributes'].items()}
        desc=part['indices']
        indices=np.frombuffer(binary,np.uint32,count=desc['count'],offset=desc['offset']).reshape(-1,3).copy()
        game=arrays['position']@world[:3,:3].T+world[:3,3]
        positions=game[:,[0,2,1]].copy();positions[:,1]*=-1
        mesh=bpy.data.meshes.new(f'Actual cave chunk {i}')
        mesh.from_pydata(positions.tolist(),[],indices.tolist());mesh.update()
        mesh.shade_smooth()
        n=arrays['normal']@np.linalg.inv(world[:3,:3])
        n=n[:,[0,2,1]].copy();n[:,1]*=-1
        mesh.normals_split_custom_set(n[indices.ravel()].tolist())
        facet=mesh.attributes.new('facet','FLOAT','FACE')
        # Continuous orientation colour, shared across cuts; do not independently
        # rank-map the faces of each chunk (that would add shading seams).
        facet.data.foreach_set('value',[.5+.5*noise.noise(Vector(tuple(round(v,4) for v in p.normal))*1.5+Vector((17,29,43)))
                                       for p in mesh.polygons])
        obj=bpy.data.objects.new(mesh.name,mesh);scene.collection.objects.link(obj)
        material=slate.painted_slate(f'Prototype slate {i}')
        mesh.materials.append(material)
        # World coordinates are shared by all pieces, and shader feature sizes
        # remain fixed. Quality controls sampling density, not geological scale.
        area=sum(p.area for p in mesh.polygons)
        density=part['budget']['texels_per_metre']
        # This bounded visual study uses smaller caps for distant regions. The
        # full requested density remains recorded separately in the manifest.
        cap=max(256,2048//(2**max(0,part['budget']['level'])))
        side=min(cap,max(256,2**math.ceil(math.log2(max(1,math.sqrt(area)*density)))))
        # The exported mesh has many tiny UV islands. Plan their charts at a
        # minimum 1024 layout resolution, then sample the distant maps sparsely.
        # Production should eliminate this detail before creating those islands.
        layout=max(1024,side)
        export.unwrap(obj,np.ones(len(mesh.polygons),dtype=bool),[layout],[layout//2])
        part['finalUvRepairedFaces']=repair_final_uvs(obj,layout)
        prepared.append((obj,material,part,arrays,indices,side))
        print('PREPARED_UV',i,side,len(mesh.polygons),flush=True)
    timings=[]
    for i,(obj,material,part,arrays,indices,side) in enumerate(prepared):
        t=time.perf_counter()
        export.select_only([obj],obj)
        for kind,bake_type,size,space in [('colour','DIFFUSE',side,'sRGB'),('normal','NORMAL',side//2,'Non-Color')]:
            image=export.bake_image(f'Prototype {i} {kind}',size,space)
            node=material.node_tree.nodes.new('ShaderNodeTexImage');node.image=image
            material.node_tree.nodes.active=node
            options={'pass_filter':{'COLOR'}} if bake_type=='DIFFUSE' else {'normal_space':'TANGENT'}
            bpy.ops.object.bake(type=bake_type,target='IMAGE_TEXTURES',uv_layer=export.BAKE_UV,
                                margin=0,use_clear=False,**options)
            export.fill_baked(obj,image,kind)
            filename=f'surface-{generation}-{i}-{kind}.png'
            image.filepath_raw=str(output/filename);image.file_format='PNG';image.save()
            part['bakedColor' if kind=='colour' else 'bakedNormal']=filename
            material.node_tree.nodes.remove(node);bpy.data.images.remove(image)
        # New bake UVs have corner seams of their own. Expand only the saved
        # preview buffers; preserve old colour/lightmap UVs and all positions.
        loops=indices.ravel()
        uv=np.empty(len(obj.data.loops)*2,np.float32)
        obj.data.uv_layers[export.BAKE_UV].data.foreach_get('uv',uv)
        uv=uv.reshape(-1,2);uv[:,1]=1-uv[:,1]  # glTF image origin
        expanded={name:values[loops] for name,values in arrays.items()}
        expanded['uv2']=uv
        blob=bytearray();attrs={}
        for name,values in expanded.items():
            values=np.ascontiguousarray(values,dtype='<f4')
            attrs[name]={'size':values.shape[1],'count':values.size,'offset':len(blob)};blob.extend(values.tobytes())
        new_indices=np.arange(len(loops),dtype='<u4')
        index={'offset':len(blob),'count':len(new_indices)};blob.extend(new_indices.tobytes())
        filename=f'baked-chunk-{generation}-{i}.bin';(output/filename).write_bytes(blob)
        part.update(file=filename,attributes=attrs,indices=index,textureFactor=1,bakeSize=side)
        timings.append({'chunk':i,'colourSize':side,'normalSize':side//2,'seconds':time.perf_counter()-t})
        print('BAKED_CHUNK',i,timings[-1],flush=True)
    manifest['report']['surfaceBake']={'shader':'production painted slate, physical scale 1',
        'cpuCores':2,'samples':1,'maxColourSize':2048,'chunks':timings,'seconds':time.perf_counter()-started,
        'finalUvRepairedFaces':[p['finalUvRepairedFaces'] for p in manifest['chunks']],
        'finalUvOverlapCheck':'passed on every final bake mesh',
        'limits':'Preview caps 2048/2048/1024/512/256; one sample. No chip/crease geometry regeneration. Existing lightmap retained. Changes material scale as well as sampling; not a quality-equivalence test.'}
    # Publish only a complete experiment, never a mixture of old and new chunks.
    temporary=output/'chunks-next.json';temporary.write_text(json.dumps(manifest,indent=2));temporary.replace(output/'chunks.json')
    print('ACTUAL_SURFACE_BAKE_OK',time.perf_counter()-started,flush=True)


if __name__=='__main__':main()
