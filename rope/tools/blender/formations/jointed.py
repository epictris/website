"""Hierarchical geological joints in a solid guide.

Long primary fractures partition the mass first. Short secondary breaks end
at those joints and cluster in narrow damaged bands; they do not tile the
entire face with equally sized, independently raised polygons.
"""
import math
import numpy as np

from . import solidfit as sf


class JointCells(sf.Cells):
    def __init__(self, solid, surface, camera, p, boulder, rng, report, *, guide=None):
        from mathutils.kdtree import KDTree
        from native import Bvh
        self.camera, self.p, self.boulder, self.rng = camera, p, boulder, rng
        source = guide if guide is not None else solid
        self.surface = sf._tree(source)
        polys = source.data.polygons
        self.face_n = np.array([q.normal for q in polys]) * np.array([q.area for q in polys])[:, None]
        self.faces = KDTree(len(polys))
        for i, q in enumerate(polys):
            self.faces.insert(q.center, i)
        self.faces.balance()
        co = np.array([v.co[:] for v in solid.data.vertices])
        solid.data.calc_loop_triangles()
        self.surface_cells = Bvh(co, [t.vertices[:] for t in solid.data.loop_triangles])
        self.lo, self.hi = co.min(0)-.05*p['stoneSize'], co.max(0)+.05*p['stoneSize']
        self.planes, self.tapers, self.f, self.random_keys = [], [], [], []
        k = p['stoneSize']
        target = k*np.array([1., 1.4, p['jointAspect']])
        primary = []
        # One geological frame for the whole asset; individual joints only
        # deviate a few degrees, rather than choosing unrelated directions.
        frame_rng = np.random.default_rng(np.random.SeedSequence([p['seed'], 291]))
        self.directions = np.array([[1., .12, -.12], [.08, 1., .06], [-.23, .08, 1.]])
        self.directions += frame_rng.uniform(-.035, .035, (3, 3))
        self.directions /= np.linalg.norm(self.directions, axis=1)[:, None]
        self.band_spacing = p['jointAspect']*.85
        self.band_phase = frame_rng.uniform(-.35, .35)*self.band_spacing
        projected = co@self.directions[2]/k
        position = projected.min()-self.band_spacing
        self.band_positions = []
        while position < projected.max()+self.band_spacing:
            self.band_positions.append(position)
            position += self.band_spacing*frame_rng.uniform(.7, 1.5)

        def bounds(planes):
            v = sf.halfspaces(planes, self.lo, self.hi, fast=True)
            if len(v) < 4:
                return None
            return v, v.min(0), v.max(0)

        def split(planes, axis, at, local_rng, gap=.001, tilt=.07):
            normal = self.directions[axis]+local_rng.uniform(-tilt, tilt, 3)
            normal /= np.linalg.norm(normal)
            d = float(normal @ at)
            if axis == 2:
                # Snap the major cross joints to the same dipping bands.
                offset = .28*math.sin(at[0]/k*.7+self.band_phase)
                snapped = (min(self.band_positions, key=lambda q: abs(q+offset-d/k))+offset)*k
                vertices = bounds(planes)[0]
                low, high = (vertices@normal).min(), (vertices@normal).max()
                if low+.2*(high-low) < snapped < high-.2*(high-low) and local_rng.random() < .65:
                    d = snapped
            return [planes+[(normal, d-gap*k)], planes+[(-normal, -d-gap*k)]]

        todo = [([], 1, 0)]
        while todo:
            planes, identity, depth = todo.pop()
            box = bounds(planes)
            if box is None:
                continue
            v, lo, hi = box
            if not self.surface_cells.cell_meets_surface(planes, lo, hi):
                continue
            local_rng = np.random.default_rng(np.random.SeedSequence([p['seed'], identity, 731]))
            ratios = (hi-lo)/target
            axis = int(np.argmax(ratios))
            if ratios[axis] > local_rng.uniform(1.1, 1.85) and depth < 24:
                at = (lo+hi)/2
                at[axis] = lo[axis]+(hi[axis]-lo[axis])*local_rng.uniform(.34, .66)
                children = split(planes, axis, at, local_rng)
                todo.extend((child, identity*2+i, depth+1) for i, child in enumerate(children))
            else:
                primary.append((planes, identity, lo, hi))

        for planes, identity, lo, hi in primary:
            rng = np.random.default_rng(np.random.SeedSequence([p['seed'], identity, 917]))
            centre = (lo+hi)/2
            parent_taper = self._joint_taper(centre, rng)
            leaves = [(planes, 1)]
            # A secondary joint follows the shared dipping bands. Split the
            # parent once: four narrow band fragments produced intersecting
            # slivers and cluttered ledges after relief and voxel union.
            normal = self.directions[2]
            vertices = bounds(planes)[0]
            low, high = (vertices@normal).min()/k, (vertices@normal).max()/k
            offset = .28*math.sin(centre[0]/k*.7+self.band_phase)
            bands = [q+offset for q in self.band_positions if low-.2 < q+offset < high+.2]
            if bands and rng.random() < .55 and high-low > .8:
                band = min(bands, key=lambda d: abs(d-(low+high)/2))
                # Keep both halves substantial; a cut grazing the end only
                # recreates the wafer we are trying to avoid.
                if low+.25 < band < high-.25:
                    at = band*k
                    leaves = [(planes+[(normal, at-.001*k)], 2),
                              (planes+[(-normal, -at-.001*k)], 3)]
            for part, branch in leaves:
                box = bounds(part)
                if box is None:
                    continue
                taper = dict(parent_taper)
                taper['damaged'] = branch >= 4
                taper['step'] += rng.uniform(-.045, .005) if branch >= 4 else rng.uniform(-.008, .008)
                self.planes.append(part)
                self.tapers.append(taper)
                self.f.append(1.)
                self.random_keys.append((identity*8+branch, 0))
        report['primary joints'] = len(primary)
        report['cells'] = len(self.planes)
        report['joints overlapped'] = 0

    def _joint_taper(self, point, rng):
        from mathutils import Vector
        hit = self.surface.find_nearest(Vector(point))
        k = self.p['stoneSize']
        n = self._normal(hit[0], sf.NORMAL_REACH*k)
        t = sf.along(n)
        across = np.cross(n, t)
        # Broad off-centre cleavage planes, rather than rectangular shelf
        # pockets stamped into otherwise featureless boards. A second,
        # oblique plane sometimes crosses the first at a different height.
        fold = rng.uniform(.28, .38)*rng.choice((-1., 1.))
        step = rng.uniform(-.065, .065)
        if rng.random() < .07:
            step -= .14
        # Cross the shared mass's rising shoulders obliquely. A nearly
        # parallel local crease left thin spear-shaped strips between them.
        fold_axis = across-t*rng.uniform(.35, .65)
        fold_axis /= np.linalg.norm(fold_axis)
        cross_axis = t+across*rng.uniform(.3, .6)
        cross_axis /= np.linalg.norm(cross_axis)
        cross_fold = 0.
        return {'jointed': True, 'n': n, 't': t, 'centre': np.asarray(hit[0]), 'k': k,
                'anchor': np.asarray(point),
                'phase': self.p['seed']*.61, 'step': step,
                'relief': self.p['surfaceRelief'], 'damaged': False,
                'cleavage': across*rng.uniform(-.17, .17)+t*rng.uniform(-.075, .075),
                'cross_axis': cross_axis, 'cross_at': rng.uniform(-.75, .75), 'cross_fold': cross_fold,
                'fold_axis': fold_axis,
                'fold_at': rng.uniform(-.25, .25), 'fold': fold, 'mean': .49}


def mass_height(points, phase):
    """Continuous angular shoulders, linear between shared fracture planes."""
    pos = np.atleast_2d(points)
    u = pos[:, 0]*.72+pos[:, 2]*.18+phase
    v = pos[:, 2]*.5+pos[:, 1]*.25+phase*1.3
    def linear(value, function):
        lo = np.floor(value)
        fraction = value-lo
        return function(lo)*(1.-fraction)+function(lo+1.)*fraction
    return (.28+linear(u, lambda q: .28*np.sin(q)+.25*np.tanh(3.*np.sin(q+1.2)))
            +linear(v, lambda q: .18*np.sin(q)))


def surface_profiles(taper, planes, points=None):
    """Work every exposed guide face of a corner stone, not just its cap.

    A single nearest-face normal moved outer stones sideways, leaving their
    front faces completely unworked: the long shaved strips at either end.
    """
    profiles = []
    old_n, old_t = taper['n'], taper['t']
    old_across = np.cross(old_n, old_t)
    for normal, distance in planes:
        normal = np.asarray(normal)
        t = sf.along(normal)
        rotation = (np.outer(normal, old_n)+np.outer(t, old_t)
                    +np.outer(np.cross(normal, t), old_across))
        anchor = taper['anchor']
        profile = dict(taper, n=normal, t=t, centre=anchor+normal*(distance-normal@anchor))
        profile['cleavage'] = rotation@taper['cleavage']
        profile['fold_axis'] = rotation@taper['fold_axis']
        profile['cross_axis'] = rotation@taper['cross_axis']
        profile['plane'] = distance
        if points is not None:
            # Cells clipped by the guide, and cells enlarged by merging a
            # sliver, can expose a face far from the original cell centre.
            # Place cleavage within that actual face, not beside its edge.
            gap = np.abs(np.asarray(points)@normal-distance)
            face = np.asarray(points)[gap <= gap.min()+.03*taper['k']]
            centre = face.mean(0)
            profile['centre'] = centre+normal*(distance-normal@centre)
            extent = (face-profile['centre'])@profile['fold_axis']/taper['k']
            low, high = float(extent.min()), float(extent.max())
            fraction = .5+.6*taper['fold_at']
            profile['fold_at'] = low+(high-low)*fraction
            # Keep broad facets readable without turning a wide cap into
            # an exaggerated projecting flap. Small faces need less relief.
            span = max(high-low, 1e-6)
            profile['fold'] *= min(1., 2.4/span)*min(1., span/.65)
        profiles.append(profile)
    return profiles or [taper]


def displace(profiles, points):
    points = np.asarray(points)
    offset = np.zeros_like(points)
    for profile in profiles:
        # Keep the interior in the original mass. Translating an entire
        # corner stone along its cap normal pulled its inner seam open and
        # detached thin fragments, which the union cleanup then discarded.
        depth = np.maximum(0., profile.get('plane', profile['n']@profile['centre'])-points@profile['n'])
        reach = profile.get('anchor_depth', .55*profile['k'])
        weight = np.maximum(0., 1.-depth/reach)
        offset -= profile['n']*(sink(profile, points)*weight)[:, None]
    return points+offset


def sink(taper, points):
    pos = np.atleast_2d(points)/taper['k']
    delta = pos-taper['centre']/taper['k']
    local = taper['step']+delta@taper['cleavage']
    local -= taper['fold']*np.maximum(delta@taper['fold_axis']-taper['fold_at'], 0.)
    local -= taper.get('cross_fold', 0.)*np.maximum(delta@taper['cross_axis']-taper['cross_at'], 0.)
    # Recenter and scale the field instead of saturating it: the former
    # [-.2, .8] clamp shaved every low/high region into a single flat panel.
    height = .45+.5*(mass_height(pos, taper['phase'])-.28)+.75*local
    return -taper['relief']*taper['k']*height


def wear(ob, taper, rng):
    """Asymmetric edge loss: a few broad corner breaks, not a uniform rim."""
    bmesh, _, _, Vector, _ = sf._bpy()
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    centre = sum((v.co for v in bm.verts), Vector())/len(bm.verts)
    candidates = [v.co.copy() for v in bm.verts
                  if np.dot(np.asarray(v.co)-taper['centre'], taper['n']) > -.06*taper['k']]
    rng.shuffle(candidates)
    for point in candidates[:int(rng.integers(1, 4) if taper['damaged'] else rng.integers(0, 3))]:
        normal = point-centre
        if normal.length < 1e-5:
            continue
        normal.normalize()
        depth = rng.uniform(.06, .16) if taper['damaged'] else rng.uniform(.035, .09)
        depth *= taper['k']
        sf.fitted._cut(bm, point-normal*depth, normal)
    bm.to_mesh(ob.data)
    bm.free()


def finish(ob, seed, collection):
    """Preserve angular fracture faces; the slate shader softens tiny edges."""
    from . import slate
    slate.tone_facets(ob, seed)
    print('JOINTED_FINISH: planar faces, no crease bow or second remesh', flush=True)
