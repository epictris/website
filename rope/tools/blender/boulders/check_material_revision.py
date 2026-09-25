"""Confirm a material-only revision preserved the validated geometry."""
from pathlib import Path
import json,struct
import bpy
root=Path(__file__).resolve().parent/'assets'
bpy.ops.wm.open_mainfile(filepath=str(root/'polygon_rocks.blend'))
report=[]
for f in sorted((root/'evaluated').glob('*.json')):
    data=json.loads(f.read_text()); name=data['spec']['name']
    obj=bpy.data.objects[name]
    assert [list(v.co) for v in obj.data.vertices]==data['vertices'],name
    assert [list(p.vertices) for p in obj.data.polygons]==data['triangles'],name
    for mat in obj.data.materials:
        assert not any(n.type=='TEX_VORONOI' and n.feature=='DISTANCE_TO_EDGE' for n in mat.node_tree.nodes)
    raw=(root/'models'/(name+'.glb')).read_bytes()
    length=struct.unpack_from('<I',raw,12)[0]
    doc=json.loads(raw[20:20+length])
    assert len(doc['images'])==2
    assert all('normalTexture' in m and 'baseColorTexture' in m['pbrMetallicRoughness'] for m in doc['materials'])
    report.append(dict(name=name,validated_geometry_unchanged=True,random_crack_network_removed=True,embedded_color_and_normal_maps=True))
(root/'material_revision_check.json').write_text(json.dumps(report,indent=2))
print('All six: geometry unchanged, random crack network absent, colour and normal maps embedded.')
