"""The surfaces a painted growth grows on (the ivy and the moss add-ons).

Until 2026-10-09 a growth belonged to one rock and a rock had at most one. Now a
growth grows on every mesh its paint reaches, its HOSTS: the first is its frame
(the growth is parented to it, its stamps are in its local frame) and the rest
are joined by the brush as the paint reaches them. A rock may carry any number
of growths.

Several hosts are grown on as ONE surface, their exact boolean union (the
owner: "when I paint moss over the intersection of two pieces of geometry, I
want the moss to naturally generate on both surfaces, as one single moss
instance"). The union is cut along the line where the rocks meet and shares its
vertices there, so everything that walks the surface - the paint's falloff, the
moss's erosion field and drape, the ivy's leaves - crosses the seam as it would
cross a crease of one rock; and nothing grows on the faces of one rock buried in
another. An open host (a plane) counts as the half-space behind its faces, as
Blender's exact solver takes it. One host is grown on as it always was: its own
welded triangles, no union, so a one-rock growth builds bit for bit as before."""

import hashlib

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from .geometry import host_world

_UNION_CACHE = 8  # unions kept in memory, keyed by their input triangles
_unions = {}


def world_triangles(host, depsgraph):
    """The host's evaluated triangles in world space, welded (geometry.host_world)."""
    ev = host.evaluated_get(depsgraph)
    me = ev.to_mesh()
    try:
        return host_world(me, host.matrix_world)
    finally:
        ev.to_mesh_clear()


def surface(hosts, depsgraph):
    """(co, tri): what a growth over `hosts` grows on, in world space, welded:
    one host's own triangles, or the union of several."""
    parts = [world_triangles(h, depsgraph) for h in hosts]
    parts = [(co, tri) for co, tri in parts if len(tri)]
    if not parts:
        return np.zeros((0, 3)), np.zeros((0, 3), np.int64)
    if len(parts) == 1:
        return parts[0]
    h = hashlib.sha1(bpy.app.version_string.encode())
    for co, tri in parts:
        for a in (co, tri):
            a = np.ascontiguousarray(a)
            h.update(str((a.dtype, a.shape)).encode())
            h.update(a.tobytes())
    key = h.hexdigest()
    hit = _unions.pop(key, None)
    if hit is None:
        hit = _union(parts)
    _unions[key] = hit  # most recent last
    while len(_unions) > _UNION_CACHE:
        _unions.pop(next(iter(_unions)))
    return hit


def _closed(tri):
    """Is every edge shared by exactly two triangles?"""
    e = np.sort(np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]]), axis=1)
    _, counts = np.unique(e, axis=0, return_counts=True)
    return bool((counts == 2).all())


def _mesh(name, co, tri):
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(co))
    me.vertices.foreach_set("co", co.astype(np.float32).ravel())
    me.loops.add(len(tri) * 3)
    me.loops.foreach_set("vertex_index", tri.astype(np.int32).ravel())
    me.polygons.add(len(tri))
    me.polygons.foreach_set("loop_start", np.arange(0, len(tri) * 3, 3, dtype=np.int32))
    me.update()
    return me


def _union(parts):
    """The exact boolean union of world-space triangle sets, welded. Self
    intersection on: a formation's chips overlap its own body. Hole tolerant
    when a part is open, so a plane is taken as the half-space behind it."""
    scene = bpy.context.scene
    coll = bpy.data.collections.new("growth.union")
    scene.collection.children.link(coll)
    obs = []
    try:
        for i, (co, tri) in enumerate(parts):
            ob = bpy.data.objects.new(f"growth.union.{i}", _mesh(f"growth.union.{i}", co, tri))
            (scene.collection if i == 0 else coll).objects.link(ob)
            obs.append(ob)
        mod = obs[0].modifiers.new("union", "BOOLEAN")
        mod.operation = "UNION"
        mod.solver = "EXACT"
        mod.operand_type = "COLLECTION"
        mod.collection = coll
        mod.use_self = True
        mod.use_hole_tolerant = not all(_closed(tri) for _co, tri in parts)
        dg = bpy.context.evaluated_depsgraph_get()
        out = bpy.data.meshes.new_from_object(obs[0].evaluated_get(dg), depsgraph=dg)
        try:
            co, tri = host_world(out, np.eye(4))
        finally:
            bpy.data.meshes.remove(out)
    finally:
        for ob in obs:
            me = ob.data
            bpy.data.objects.remove(ob)
            bpy.data.meshes.remove(me)
        bpy.data.collections.remove(coll)
    if len(tri) == 0:
        # The solver gave nothing (it never has on a rock): grow on the parts
        # side by side rather than on nothing.
        print("[growth] the union of the hosts came out empty; growing on them unjoined")
        base = np.cumsum([0] + [len(co) for co, _t in parts[:-1]])
        return (np.concatenate([co for co, _t in parts]),
                np.concatenate([tri + b for (_co, tri), b in zip(parts, base)]))
    return co, tri


class Reach:
    """Which meshes a stamp reaches: every paintable mesh whose surface comes
    within the brush's radius of the stamp's centre. One per painting session;
    each mesh's tree is built the first time a stamp comes near its box."""

    def __init__(self, obs, depsgraph):
        self.obs = list(obs)
        self.depsgraph = depsgraph
        lo, hi = [], []
        for ob in self.obs:
            m = ob.matrix_world
            c = np.array([(m @ Vector(x))[:] for x in ob.bound_box])
            lo.append(c.min(0))
            hi.append(c.max(0))
        self.lo = np.array(lo).reshape(-1, 3)
        self.hi = np.array(hi).reshape(-1, 3)
        self.trees = {}

    def _tree(self, i):
        tree = self.trees.get(i)
        if tree is None:
            co, tri = world_triangles(self.obs[i], self.depsgraph)
            tree = self.trees[i] = BVHTree.FromPolygons(co.tolist(), tri.tolist()) if len(tri) else False
        return tree

    def near(self, point, radius):
        p = np.array(point[:])
        d = np.maximum(np.maximum(self.lo - p, p - self.hi), 0.0)
        out = []
        for i in np.nonzero((d * d).sum(1) < radius * radius)[0].tolist():
            tree = self._tree(i)
            if tree and tree.find_nearest(Vector(p), radius)[0] is not None:
                out.append(self.obs[i])
        return out
