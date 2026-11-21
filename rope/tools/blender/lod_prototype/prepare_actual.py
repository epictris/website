"""Partition the actual exported rock for visual comparison, on one CPU core.

This is an appearance experiment using an existing export, not a generation-time
benchmark. Source UV seams limit simplification until integration before baking.
"""
from dataclasses import asdict
import argparse
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import time

from budget import Budget, high_dof
from surface import Corner, Face, area, boundary_edges, partition, pack, unpack


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    parser.add_argument('output',type=Path)
    args=parser.parse_args()
    os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
    os.nice(10)
    started=time.perf_counter()
    src=json.loads(args.source.read_text())
    if len(src['indices'])//3>250000:
        raise ValueError('Small experiment limit: 250k triangles')
    # glTF duplicates vertices at normal and UV seams. Weld position identity
    # for clipping, while retaining original independent corner attributes.
    points,lookup,remap=[],{},[]
    for value in src['positions']:
        key=tuple(value)
        if key not in lookup:
            lookup[key]=len(points);points.append(key)
        remap.append(lookup[key])
    attrs=src['attributes'];indices=src['indices']
    faces=[Face(tuple(Corner(remap[i],tuple(attrs[i])) for i in indices[j:j+3]))
           for j in range(0,len(indices),3)]
    # Actual game view: 70 mm lens, zoom=BALL_ZOOM/viewportScale (2/.65).
    # Budget quality uses 2160 drawing lines so the same offline asset is safe
    # for the game's high-resolution setting as well as these 1080p captures.
    tan_half=12/70
    distance=(1080/((2/.65)*100))/2/tan_half
    policy=Budget(distance,tan_half,*high_dof())
    bands=policy.bands(min(p[1] for p in points),max(p[1] for p in points))
    t=time.perf_counter();points,chunks=partition(points,faces,bands)
    partition_seconds=time.perf_counter()-t
    if not math.isclose(sum(area(points,c.faces) for c in chunks),area(points,faces),rel_tol=1e-9):
        raise ValueError('Partition changed the source surface area')
    packed=[pack(points,c) for c in chunks]
    with tempfile.TemporaryDirectory(prefix='actual-lod-') as work:
        inp,out=Path(work)/'in.json',Path(work)/'out.json'
        inp.write_text(json.dumps(packed))
        subprocess.run(['bun',str(Path(__file__).with_name('simplify.mjs')),str(inp),str(out)],check=True,timeout=60)
        reduced=json.loads(out.read_text())
    result=[unpack(p,r['indices'],c.band) for p,r,c in zip(packed,reduced,chunks)]
    boundary_fallbacks=[]
    for i,(before,after) in enumerate(zip(chunks,result)):
        if boundary_edges(before.faces)!=boundary_edges(after.faces):
            # Quantised production exports can contain collapsed/nonmanifold
            # faces. Never trade a changed cut boundary for a triangle saving.
            result[i]=before
            boundary_fallbacks.append(i)
    # Estimate actual source texel density from its occupied colour-UV area,
    # not from atlas dimensions alone. Never reduce a map already below target.
    source_uv_area=0
    for f in faces:
        a,b,c=[v.attributes[3:5] for v in f.corners]
        source_uv_area+=abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2
    density=math.sqrt(source_uv_area*math.prod(src['textureSize'])/area(points,faces))
    matrix=src['inverseWorld']
    def local(p):
        x,y,z=p[0],p[2],-p[1]
        return tuple(matrix[r]*x+matrix[4+r]*y+matrix[8+r]*z+matrix[12+r] for r in range(3))
    args.output.mkdir(parents=True,exist_ok=True)
    descriptors=[]
    for i,(before,after) in enumerate(zip(chunks,result)):
        if not after.faces:continue
        packet=pack(points,after)
        vertices=packet['vertices']
        blob=bytearray();layouts={}
        def add_attribute(name,size,values):
            layouts[name]={'size':size,'offset':len(blob),'count':len(values)}
            blob.extend(struct.pack(f'<{len(values)}f',*values))
        add_attribute('position',3,[x for v in vertices for x in local(v['position'])])
        offset=0
        for a in src['attributeLayout']:
            add_attribute(a['name'],a['size'],[x for v in vertices for x in v['attributes'][offset:offset+a['size']]])
            offset+=a['size']
        index_info={'offset':len(blob),'count':len(packet['indices'])}
        blob.extend(struct.pack(f'<{len(packet["indices"])}I',*packet['indices']))
        filename=f'chunk-{i}.bin';(args.output/filename).write_bytes(blob)
        factor=2**max(0,math.floor(math.log2(density/before.band.texels_per_metre)))
        descriptors.append({'file':filename,'attributes':layouts,'indices':index_info,'textureFactor':factor,
                            'budget':asdict(before.band),'sourceTriangles':len(before.faces),'triangles':len(after.faces)})
    report={'source':src['name'],'sourceTriangles':len(faces),'splitTriangles':sum(len(c.faces) for c in chunks),
            'adaptiveTriangles':sum(len(c.faces) for c in result),'sourceTextureSize':src['textureSize'],
            'estimatedSourceTexelsPerMetre':density,'policy':asdict(policy),
            'partitionSeconds':partition_seconds,'prepareSeconds':time.perf_counter()-started,
            'boundaryFallbackChunks':boundary_fallbacks,
            'scope':'Existing real geometry and baked textures; no regeneration or rebake. UV seams are protected.'}
    (args.output/'chunks.json').write_text(json.dumps({'chunks':descriptors,'report':report},indent=2))
    print('ACTUAL_ROCK_PREPARED',json.dumps(report),flush=True)


if __name__=='__main__':main()
