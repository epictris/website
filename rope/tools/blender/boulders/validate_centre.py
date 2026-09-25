"""Validate the actual mesh intersection with the central gameplay plane."""
from pathlib import Path
import sys,json
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'.deps'))
import numpy as np
import shapely
from shapely import Polygon,MultiLineString
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from validate import contact_sheet

def draw(ax,geometry,color,fill=False,lw=1.5):
    for p in ([geometry] if geometry.geom_type=='Polygon' else geometry.geoms):
        if p.geom_type!='Polygon': continue
        x,y=p.exterior.xy
        if fill: ax.fill(x,y,color=color,alpha=.23)
        ax.plot(x,y,color=color,lw=lw)
        for r in p.interiors:
            x,y=r.xy; ax.plot(x,y,color=color,lw=lw)

out=Path(sys.argv[1]).resolve(); results=[]; collisions=[]
first=json.loads(next((out/'evaluated').glob('*.json')).read_text())
perimeter=first['spec'].get('fit_mode')=='playable_perimeter'
report_dir=out/('centre_validation' if perimeter else 'validation')
report_dir.mkdir(exist_ok=True)
for f in sorted((out/'evaluated').glob('*.json')):
    data=json.loads(f.read_text()); spec=data['spec']
    verts=np.array(data['vertices'])@np.array(spec['camera_basis'])
    faces=np.array(data['triangles']); triangles=verts[faces]
    crossing=triangles[(triangles[:,:,2].min(axis=1)<0)&(triangles[:,:,2].max(axis=1)>0)]
    segments=[]
    for tri in crossing:
        points=[]
        for a,b in zip(tri,np.roll(tri,-1,axis=0)):
            if (a[2]<0)!=(b[2]<0):
                points.append(np.round((a+(b-a)*(-a[2]/(b[2]-a[2])))[:2],6))
        if len(points)==2 and not np.array_equal(points[0],points[1]): segments.append(points)
    section=shapely.build_area(shapely.union_all(MultiLineString(segments)))
    # A plane can graze a surface chip and produce microscopic satellite areas.
    # Report these explicitly; retain all components above a 0.1 mm scale.
    satellite_area=0.0
    if section.geom_type=='MultiPolygon':
        components=sorted(section.geoms,key=lambda p:p.area,reverse=True)
        cutoff=(spec['tolerance']*.01)**2
        satellite_area=sum(p.area for p in components[1:] if p.area<cutoff)
        section=shapely.union_all([components[0]]+[p for p in components[1:] if p.area>=cutoff])
    microscopic_hole_area=0.0
    if section.geom_type=='Polygon':
        retained=[]
        threshold=spec['tolerance']*.01
        for ring in section.interiors:
            hole=Polygon(ring); x0,y0,x1,y1=hole.bounds
            if hole.area<threshold**2 and max(x1-x0,y1-y0)<threshold:
                microscopic_hole_area+=hole.area
            else:
                retained.append(ring)
        section=Polygon(section.exterior,retained)
    expected=Polygon(spec['outer'],spec['holes'])
    error=expected.boundary.hausdorff_distance(section.boundary) if not section.is_empty else float('inf')
    silhouette=shapely.union_all([Polygon(t[:,:2]) for t in triangles if abs(np.linalg.det(np.stack([t[1,:2]-t[0,:2],t[2,:2]-t[0,:2]])))>1e-12])
    health=data['health']
    passed=bool(error<=spec['tolerance']+1e-5 and health['nonmanifold_edges']==0 and health['connected_components']==1 and health['volume']>0
                and section.geom_type=='Polygon' and len(section.interiors)==len(expected.interiors))
    result=dict(name=spec['name'],seed=spec['seed'],passed=passed,
                centre_section_error=float(error),microscopic_slice_satellite_area=satellite_area,microscopic_slice_hole_area=microscopic_hole_area,tolerance=spec['tolerance'],
                decorative_overhang_area=float(silhouette.difference(expected).area),**health)
    results.append(result)
    collisions.append(dict(name=spec['name'],outer=spec['outer'],holes=spec['holes'],
                           plane_origin=[0,0,0],plane_to_world=spec['camera_basis'],depth_coordinate=0))
    fig,axes=plt.subplots(1,2,figsize=(11,6),facecolor='#f1efe9')
    draw(axes[0],section,'#458478',True); draw(axes[0],expected,'#d26e37',False,1)
    draw(axes[1],silhouette,'#687a8e',True); draw(axes[1],expected,'#d26e37',False,1.3)
    axes[0].set_title(f'Central gameplay slice: {error*1000:.1f} mm fit error')
    axes[1].set_title('Visible perimeter also follows the polygon' if perimeter else 'Visible rock can extend beyond the orange polygon')
    for ax in axes:
        ax.set_aspect('equal'); ax.set_facecolor('#f1efe9'); ax.grid(alpha=.15)
    fig.suptitle(spec['name'].replace('_',' ')+' / central plane at depth 0')
    fig.tight_layout(); fig.savefig(report_dir/(spec['name']+'.png'),dpi=130); plt.close(fig)
    print(f"{spec['name']}: {'PASS' if passed else 'FAIL'} centre slice {error:.6f}; overhang {result['decorative_overhang_area']:.3f}",flush=True)
(out/('centre_validation.json' if perimeter else 'validation.json')).write_text(json.dumps(results,indent=2))
(out/'gameplay_collision.json').write_text(json.dumps(dict(units='metres',coordinates='2D gameplay polygon plus plane-to-world matrix; no scene layout translation',rocks=collisions),indent=2))
lines=['# Central gameplay-plane validation','',
       'The final mesh is intersected with depth = 0 in its camera/gameplay coordinate frame. Collision polygons are supplied separately in gameplay_collision.json. '+('The visible outline is independently constrained and validated in VALIDATION.md.' if perimeter else 'Only this slice is constrained; front and back may extend outside it.'),'',
       '| Rock | Result | Slice error (mm) | Tolerance (mm) | Decorative overhang (m²) |','|---|---|---:|---:|---:|']
for r in results: lines.append(f"| {r['name']} | {'PASS' if r['passed'] else 'FAIL'} | {r['centre_section_error']*1000:.3f} | {r['tolerance']*1000:.1f} | {r['decorative_overhang_area']:.3f} |")
lines+=['','Checks include central-section boundary distance, hole count, closed manifold edges, one connected component and positive volume. Plane-grazing satellite areas below (1% of fit tolerance) squared are excluded from section topology and reported in JSON. Microscopic holes are also reported and excluded only when both their area and bounding-box extent are below that resolution. No exhaustive triangle self-intersection check is performed.']
(out/('CENTRE_VALIDATION.md' if perimeter else 'VALIDATION.md')).write_text('\n'.join(lines),encoding='utf-8')
if not perimeter: contact_sheet(out,results)
if not all(r['passed'] for r in results): raise SystemExit('Central plane validation failed')
