"""Allocate preview texels to its fixed camera views; keep all occluding geometry.

This is deliberately separate from production's visibility over every possible
camera pan. Samples include corners and an occlusion margin, followed by two
neighbour rings. Unseen faces retain the ordinary hidden texture density.
"""
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

# The four roof views in viewer.ts; Blender world axes. The viewer's fixed zoom
# places its camera 10.2375 m in front of the gameplay plane.
VIEWS = ((10.85,-10.2375,-3.5),(15.,-10.2375,-3.5),
         (4.,-10.2375,-6.),(19.,-10.2375,-3.5))


def seen_faces(mesh, matrix):
    co=np.empty((len(mesh.vertices),3));mesh.vertices.foreach_get('co',co.ravel())
    m=np.asarray(matrix);co=co@m[:3,:3].T+m[:3,3]
    mesh.calc_loop_triangles()
    tris=np.empty((len(mesh.loop_triangles),3),np.int32)
    parent=np.empty(len(tris),np.int32)
    mesh.loop_triangles.foreach_get('vertices',tris.ravel())
    mesh.loop_triangles.foreach_get('polygon_index',parent)
    tree=BVHTree.FromPolygons(co.tolist(),tris.tolist(),all_triangles=True)
    points=co[tris];centres=points.mean(1)
    visible=np.zeros(len(mesh.polygons),bool)
    for pose in VIEWS:
        eye=Vector(pose);depth=points[:,:,1]-pose[1]
        half=depth*12/70+.3;wide=half*16/9
        outside=((points[:,:,0]<pose[0]-wide).all(1)|(points[:,:,0]>pose[0]+wide).all(1)
                 |(points[:,:,2]<pose[2]-half).all(1)|(points[:,:,2]>pose[2]+half).all(1))
        for i in np.flatnonzero(~outside & ~visible[parent]):
            samples=[centres[i],*(points[i]*.95+centres[i]*.05)]
            for point in samples:
                ray=Vector(point)-eye;length=ray.length
                hit=tree.ray_cast(eye,ray,length+.01)
                # Preserve texture quality just behind an occluding edge:
                # production crease bows can move that edge by up to 20 cm.
                if hit[3] is None or hit[3]>=length-.25:
                    visible[parent[i]]=True
                    break
    starts=np.empty(len(mesh.polygons),np.int32)
    counts=np.empty(len(mesh.polygons),np.int32)
    corners=np.empty(len(mesh.loops),np.int32)
    mesh.polygons.foreach_get('loop_start',starts)
    mesh.polygons.foreach_get('loop_total',counts)
    mesh.loops.foreach_get('vertex_index',corners)
    for _ in range(2):
        hot=np.zeros(len(co),bool);hot[corners[np.repeat(visible,counts)]]=True
        visible=np.logical_or.reduceat(hot[corners],starts)
    print('PREVIEW_VISIBLE_FACES',int(visible.sum()),'of',len(visible),flush=True)
    return visible
