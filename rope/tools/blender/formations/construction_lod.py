"""Depth-adaptive construction without separate remesh slabs or seam stitching.

Temporarily put a connected mesh in a projective coordinate system, run the
existing voxel finish there, then invert it. Projective maps preserve planes
and straight edges exactly, including large unsplit guide polygons. The voxel
grid becomes progressively coarser in world space toward the back of the rock.
No extra surface tessellation or per-band copies are needed before remeshing.

The inverse Jacobian bounds the largest world-space voxel at every depth.
Planning includes the whole transverse extent (not just the centre ray), and
falls back to a uniform near-quality grid when compression would cost more.
This bounds sampling resolution, not the total error of smoothing/decimation.
"""
from dataclasses import dataclass
import numpy as np

# Tested against the original .06 finish on the same real roof. Remove flat
# voxel faces before the expensive decimator, while retaining curved regions.
FINISH_ADAPTIVITY = .15


def resolution(camera, y, voxel, power=1.):
    """Existing foreground sampling, relaxed only by projection or High DOF."""
    y = np.asarray(y, dtype=float)
    scales = (y-camera.eye[1])/camera.distance
    if np.any(scales <= 0):
        raise ValueError('Construction geometry must be in front of the gameplay camera')
    depth = y-camera.eye[1]-camera.distance
    b = camera.budget
    blur = 4*b.max_blur*b.tan_half*np.maximum(0.,depth-b.focus_band)
    return np.maximum(voxel*scales**power, blur/b.blur_samples)


@dataclass
class Warp:
    origin: np.ndarray
    slope: float
    voxel: float
    radius: float

    def forward(self, points):
        p = np.asarray(points, dtype=float)-self.origin
        w = 1+self.slope*p[:,1]
        if np.any(w <= 0):
            raise ValueError('Construction warp crosses its projective horizon')
        return p/w[:,None]

    def inverse(self, points):
        p = np.asarray(points, dtype=float)
        w = 1-self.slope*p[:,1]
        if np.any(w <= 0):
            raise ValueError('Remesh crossed the construction warp horizon')
        return p/w[:,None]+self.origin

    def stretch(self, y):
        """Largest inverse singular value anywhere in the transverse bounds."""
        w = 1+self.slope*(np.asarray(y)-self.origin[1])
        # Radial/depth block [[w, slope*r*w], [0, w*w]]. The third
        # singular value is w and never exceeds this block's largest one.
        a, b, d = w*w, self.slope*self.radius*w*w, (self.slope*self.radius*w)**2+w**4
        return np.sqrt((a+d+np.sqrt((a-d)**2+4*b*b))/2)

    @classmethod
    def plan(cls, points, camera, voxel, power=1.):
        co = np.asarray(points,dtype=float)
        if not len(co) or not np.isfinite(co).all():
            raise ValueError('Construction budget needs nonempty finite geometry')
        # Remesh/smoothing can move a surface slightly outside its old box.
        pad = 4*float(resolution(camera,co[:,1].max(),voxel,power))
        lo, hi = co.min(0)-pad, co.max(0)+pad
        near = float(co[:,1].min())
        lo[1] = near-min(4*float(resolution(camera,near,voxel,power)), .25*(near-camera.eye[1]))
        origin = (lo+hi)/2; origin[1]=lo[1]
        radius = float(np.linalg.norm((hi-lo)[[0,2]]/2))
        depths = np.linspace(lo[1],hi[1],257)
        allowed = resolution(camera,depths,voxel,power)
        corners = np.array([[x,y,z] for x in (lo[0],hi[0]) for y in (lo[1],hi[1]) for z in (lo[2],hi[2])])
        best, cost = None, float('inf')
        for slope in np.linspace(0.,3./max(hi[1]-lo[1],1e-6),25):
            trial = cls(origin,float(slope),0.,radius)
            # Both functions are monotone. The allowed size at an interval's
            # near end divided by stretch at its far end bounds ALL points in
            # that interval, rather than trusting point samples alone.
            trial.voxel = float(np.min(allowed[:-1]/trial.stretch(depths[1:])))
            extent = np.ptp(trial.forward(corners),axis=0)
            # A narrow-band voxel remesh follows surface area, not volume.
            work = (extent[0]*extent[1]+extent[0]*extent[2]+extent[1]*extent[2])/trial.voxel**2
            if work < cost:
                best, cost = trial, work
        return best


def coordinates(mesh):
    co = np.empty((len(mesh.vertices),3),dtype=np.float64)
    mesh.vertices.foreach_get('co',co.ravel())
    return co


def finish(ob, camera, voxel, *, iterations=0, smooth=.5, adaptivity=0., density=None, power=1.):
    """One connected, locally budgeted remesh/smooth/decimate operation."""
    from .solidfit import _modifier
    if not ob.data.vertices:
        return None
    warp = Warp.plan(coordinates(ob.data),camera,voxel,power)
    ob.data.vertices.foreach_set('co',warp.forward(coordinates(ob.data)).ravel())
    ob.data.update()
    try:
        _modifier(ob,'REMESH',mode='VOXEL',voxel_size=warp.voxel,adaptivity=adaptivity)
        if iterations:
            _modifier(ob,'SMOOTH',factor=smooth,iterations=iterations)
        if density is not None and ob.data.polygons:
            area = sum(p.area for p in ob.data.polygons)
            budget = density*area/(warp.voxel/voxel)**2
            _modifier(ob,'DECIMATE',ratio=min(1.,budget/len(ob.data.polygons)))
    finally:
        ob.data.vertices.foreach_set('co',warp.inverse(coordinates(ob.data)).ravel())
        ob.data.update()
    return {'slope':warp.slope,'gridVoxel':warp.voxel,'faces':len(ob.data.polygons)}
