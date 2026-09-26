"""Build a volumetric rock assembly in a fixed camera's coordinate system.

The silhouette supplies an envelope. Independent vertical 3D slabs overlap a
rounded solid core; they are not tiles of a 2D partition or a rear panel.
"""
import math
import numpy as np
import shapely
from shapely import Polygon, Point, MultiPoint
from shapely.geometry.polygon import orient
from shapely.ops import nearest_points


def camera_basis(spec):
    yaw = math.radians(spec.get("camera_yaw", 25))
    pitch = math.radians(spec.get("camera_pitch", 12))
    right = [math.cos(yaw), math.sin(yaw), 0]
    up = [-math.sin(yaw)*math.sin(pitch), math.cos(yaw)*math.sin(pitch), math.cos(pitch)]
    toward = [math.sin(yaw)*math.cos(pitch), -math.cos(yaw)*math.cos(pitch), math.sin(pitch)]
    return np.array([right, up, toward]).T


def core_depth(p, xy, depth, spec=None):
    from params import param
    width = min(p.bounds[2]-p.bounds[0], p.bounds[3]-p.bounds[1])
    distance = p.boundary.distance(Point(xy))
    if distance < 1e-8:
        return 0.0
    return depth * param(spec, "coreDepth") * min(1, distance / max(width*0.30, 1e-9))**0.36


def natural_outline(p, spec):
    """Coherent shallow chips between pinned polygon corners, including holes."""
    budget = spec["tolerance"]*.42*spec.get("edge_variation",1)
    rings = []
    rng = np.random.default_rng(int(spec["seed"])+1907)
    for ring in [p.exterior,*p.interiors]:
        result = []
        for a,b in zip(list(ring.coords)[:-1],list(ring.coords)[1:]):
            a,b = np.array(a),np.array(b)
            delta = b-a
            length = np.linalg.norm(delta)
            normal = np.array([-delta[1],delta[0]])/length
            count = max(2,math.ceil(length/.11))
            frequency,phase = rng.uniform(1.5,3.5),rng.uniform(0,2*math.pi)
            for i in range(count):
                t = i/count
                chip = budget*math.sin(math.pi*t)**2*(.35+.65*math.sin(t*frequency*math.pi+phase)**2)
                result.append(a+delta*t+normal*chip)
        rings.append(result)
    for factor in [1,.5,.25,0]:
        adjusted=[]
        for ring in rings:
            coords=[]
            for xy in ring:
                near=nearest_points(p.boundary,Point(xy))[0]
                coords.append(np.array(near.coords[0])+(xy-np.array(near.coords[0]))*factor)
            adjusted.append(coords)
        candidate=Polygon(adjusted[0],adjusted[1:])
        if candidate.is_valid and candidate.boundary.hausdorff_distance(p.boundary) <= spec["tolerance"]*.55:
            return orient(candidate,1)
    return p


def ridge_depth(xy,spec):
    from params import param
    phase=spec["seed"]*.31
    return spec["depth"]*(param(spec,"ridgeAmplitude")*math.sin(xy[0]*2.4+xy[1]*1.8+phase)
                          +param(spec,"ridgeFine")*math.sin(xy[0]*5.1-xy[1]*2.1+phase*.7))


def rounded_core(p, spec, Mesh, envelope=False):
    # A ruled polygon extrusion gives clean side walls. The previous sampled
    # distance-field taper pinched every boundary triangle into a little ridge.
    from rockgen import prism
    half = spec['depth'] * (.90 if envelope else .29)
    return prism(p, -half, half,
                 'clean_outline_envelope' if envelope else 'clean_planar_core', 0)

def make_block(center, width, thickness, length, yaw, rng, index, basis, Mesh, weathering=.7):
    """An independently oriented vertical slab with oblique, broken end caps."""
    # An eight-sided cross section avoids rectangular slab corners. The long
    # front planes remain broad, with small irregular chamfers at their sides.
    cross = np.array([[-.5,-.36],[-.38,-.5],[.37,-.5],[.5,-.32],
                      [.5,.36],[.36,.5],[-.4,.5],[-.5,.34]])
    cross *= [width, thickness]
    cross *= rng.uniform(.86,1.10,(8,1))
    rotation = np.array([[math.cos(yaw),-math.sin(yaw)],[math.sin(yaw),math.cos(yaw)]])
    cross = cross @ rotation.T
    lean = rng.uniform(-.16,.16,2)*length
    top_tilt = rng.uniform(-.48,.48,2)
    bottom_tilt = rng.uniform(-.30,.30,2)
    # A localized break interrupts the vertical edge without rounding the
    # entire slab. Nearby rings form a small fractured shoulder, not a bulge.
    # Shared cross-joint plane, with local deviations and occasional termination.
    joint = float(np.clip((round(center[2]/.65)*.65-center[2])/length+.5,.22,.78))
    levels = [0,.13,rng.uniform(.42,.64),.86,1]
    has_joint=False
    if has_joint:
        levels += [joint-.025,joint+.025]
    levels=sorted(set(levels))
    scales = rng.uniform(.96,1.025,len(levels))
    scales[0], scales[-1] = rng.uniform(.74,.87,2)
    corner_bias = rng.uniform(-.045,.045,8)*weathering
    chipped_corner = int(rng.integers(8))
    # A few continuous edge deviations make irregular masses, not repeated slats.
    drift=rng.uniform(-.075,.075,(3,8))*weathering
    ring_jitter=np.array([[(1-t)*drift[0,j]+t*drift[2,j]+math.sin(math.pi*t)*drift[1,j]
                           for j in range(8)] for t in levels])
    mesh = Mesh(f"volume_slab_{index:03d}", int(rng.integers(0,5)))
    rings = []
    for level_index, (t, scale) in enumerate(zip(levels,scales)):
        ring = []
        for corner, xy in enumerate(cross):
            radial = scale + corner_bias[corner] + ring_jitter[level_index,corner]
            if has_joint and abs(t-(joint-.025)) < 1e-8:
                radial -= weathering*(.22 if corner in [chipped_corner,(chipped_corner+1)%8] else .035)
            pos = np.array([*(xy*radial+lean*(t-.5)), (t-.5)*length])
            pos[2] += np.dot(xy, bottom_tilt*(1-t)+top_tilt*t)
            world = pos + center
            local = world @ basis
            ring.append(tuple(local))
        rings.append(ring)
    for a,b in zip(rings[:-1],rings[1:]):
        for i in range(8):
            j = (i+1)%8
            mesh.face([a[i],a[j],b[j]])
            mesh.face([a[i],b[j],b[i]])
    for ring, reverse in [(rings[0],True),(rings[-1],False)]:
        middle = np.mean(ring,axis=0)
        for i in range(8):
            triangle = [ring[i],ring[(i+1)%8],middle]
            mesh.face(triangle[::-1] if reverse else triangle)
    result = mesh.dump()
    result["clip_to_outline"] = True
    return result


def build_volume(spec):
    from rockgen import Mesh
    p = orient(Polygon(spec["outer"], spec["holes"]), 1)
    rng = np.random.default_rng(int(spec["seed"]))
    basis = camera_basis(spec)
    width, height = p.bounds[2]-p.bounds[0], p.bounds[3]-p.bounds[1]
    core_polygon = natural_outline(p,spec)
    core = rounded_core(core_polygon, spec, Mesh)
    parts = [core]
    node_points=[]
    count = int(spec["slabs"])
    # Stratified positions in the view prevent all slabs landing in one corner.
    candidates = []
    for _ in range(count * 1000):
        xy = rng.uniform(p.bounds[:2], p.bounds[2:])
        if core_polygon.contains(Point(xy)):
            candidates.append(xy)
            if len(candidates) == count * 12:
                break
    if not candidates:
        raise ValueError("Unable to place 3D slabs inside the silhouette")
    chosen = [candidates.pop(int(rng.integers(len(candidates))))]
    while len(chosen) < count:
        # Farthest-point sampling gives even coverage; low jitter keeps it from
        # becoming a regular grid. All placements remain seed-reproducible.
        distances = [min(np.linalg.norm((q-v)*[1,.65]) for v in chosen) for q in candidates]
        best = int(np.argmax(np.array(distances)*rng.uniform(.85,1.15,len(distances))))
        chosen.append(candidates.pop(best))
    from params import param
    back_every = int(param(spec, "backSlabEvery"))
    width_share = param(spec, "slabWidthMin"), param(spec, "slabWidthMax")
    thickness_share = param(spec, "slabThicknessMin"), param(spec, "slabThicknessMax")
    length_share = param(spec, "slabLengthMin"), param(spec, "slabLengthMax")
    max_yaw = param(spec, "slabYaw")
    for index, xy in enumerate(chosen):
        half = core_depth(core_polygon, xy, spec["depth"], spec)
        # Some slabs live on the back, others on either side/front. Their
        # centres are inside the rounded core, ensuring overlap/connectivity.
        side = 1 if index % back_every else -1
        plate_width = width * rng.uniform(*width_share)
        plate_thickness = spec["depth"] * rng.uniform(*thickness_share)
        plate_length = height * rng.uniform(*length_share)
        # Let the slab stand proud of the core. Its inward half still overlaps
        # the mass; burying its centre deep inside would hide the side faces.
        projected_half = plate_thickness / (2 * max(abs(basis[1,2]), .4))
        d = ridge_depth(xy,spec)+side * (half * .96 + projected_half * rng.uniform(.25,.5))
        center = np.array([*xy,d]) @ basis.T
        yaw = math.radians(rng.uniform(-max_yaw,max_yaw) + spec.get("fracture_angle",0))
        weathering = spec.get("weathering",.7)
        parts.append(make_block(center,plate_width,plate_thickness,plate_length,yaw,rng,index,basis,Mesh,weathering))
        node_points.append(dict(position=center.tolist(),scale=[plate_width,plate_thickness,plate_length],
                                rotation=[float(rng.uniform(-.07,.07)),float(rng.uniform(-.09,.09)),yaw]))
        # Thin secondary plates grow out of a parent slab. They intersect its
        # outer face, creating stepped ledges and recesses at a second scale.
        if rng.random() < spec.get("secondary_slabs",.65):
            facing = np.array([math.sin(yaw),-math.cos(yaw),0])*side
            along = np.array([math.cos(yaw),math.sin(yaw),0])
            flake_thickness = plate_thickness*rng.uniform(.28,.48)
            flake_center = (center + facing*(plate_thickness*.43+flake_thickness*.12)
                            + along*plate_width*rng.uniform(-.22,.22)
                            + np.array([0,0,plate_length*rng.uniform(-.22,.22)]))
            flake = make_block(flake_center,plate_width*rng.uniform(.32,.65),
                               flake_thickness,plate_length*rng.uniform(.40,.76),
                               yaw+math.radians(rng.uniform(-5,5)),rng,count+index,basis,Mesh,weathering)
            flake["name"] = f"secondary_plate_{index:03d}"
            parts.append(flake)
    clip = rounded_core(core_polygon,spec,Mesh,envelope=True)
    return {"spec": dict(spec, construction="volume", camera_basis=basis.tolist()),
            "parts": parts, "clip": clip, "node_points":node_points,"cell_count": count}
