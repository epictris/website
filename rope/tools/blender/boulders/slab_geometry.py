"""Shared independent slab primitive for outline rocks and solid Wall formations."""
import math
import numpy as np


class Mesh:
    def __init__(self, name, material=0):
        self.name, self.material = name, material
        self.vertices, self.faces = [], []
        self.lookup = {}

    def vertex(self, p):
        key = tuple(round(float(x), 9) for x in p)
        if key not in self.lookup:
            self.lookup[key] = len(self.vertices)
            self.vertices.append(list(key))
        return self.lookup[key]

    def face(self, points):
        indices = [self.vertex(p) for p in points]
        if len(set(indices)) >= 3:
            self.faces.append(indices)

    def dump(self):
        return dict(name=self.name, material=self.material, vertices=self.vertices, faces=self.faces)


def make_block(center, width, thickness, length, yaw, rng, index, basis, Mesh, weathering=.7,
               min_end_separation=None):
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
    if min_end_separation is not None:
        if not 0 < min_end_separation <= length:
            raise ValueError('Minimum slab end separation must be positive and no greater than length')
        # Broad, short slabs can otherwise turn inside out at a corner:
        # the end-plane difference exceeds their entire longitudinal span.
        # Keep every corner's ring sequence ordered before any fitting,
        # Boolean union or remeshing. The default outline slabs are unchanged.
        excursion = float(np.max(np.abs(cross @ (top_tilt-bottom_tilt))))
        factor = min(1., (length-min_end_separation)/max(excursion, 1e-12))
        top_tilt *= factor
        bottom_tilt *= factor
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

