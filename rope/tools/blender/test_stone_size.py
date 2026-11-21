"""Stone spacing responds to size; fast cells match the exhaustive geometry."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent / 'boulders'))
import numpy as np
import bpy
import bmesh
from formations import cell_sampling, solidfit

rng = np.random.default_rng(913)
# Compare the native solver with the existing exhaustive solver, including
# translated cells, parallel/redundant planes, and an empty intersection.
for i in range(30):
    centre = rng.uniform(-100, 100, 3)
    normals = rng.normal(size=(24, 3)); normals /= np.linalg.norm(normals, axis=1)[:, None]
    planes = [(n, float(n @ centre + r)) for n, r in zip(normals, rng.uniform(.1, 2, len(normals)))]
    if i % 3 == 0: planes += planes[:3]
    if i == 29: planes += [(np.array([1., 0, 0]), centre[0]-3)]
    slow = solidfit.halfspaces(planes, centre-2, centre+2)
    fast = solidfit.halfspaces(planes, centre-2, centre+2, fast=True)
    assert len(slow) == len(fast), (i, len(slow), len(fast))
    assert np.allclose(slow, fast, atol=1e-7, rtol=1e-9), i

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=8)
ob = bpy.context.object
tree = solidfit._tree(ob)
from native import Bvh
ob.data.calc_loop_triangles()
co = np.array([v.co[:] for v in ob.data.vertices])
triangles = np.array([t.vertices[:] for t in ob.data.loop_triangles])
native_surface = Bvh(co, triangles)
def brute_meets_surface(planes):
    # Independent barycentric feasibility test: each source triangle becomes
    # 2D linear inequalities; enumerate pairs of their boundary lines.
    normals = np.array([n for n, _ in planes]); offsets = np.array([d for _, d in planes])+1e-4
    for a, b, c in co[triangles]:
        matrix = np.vstack((normals @ np.column_stack((b-a, c-a)), [-1., 0.], [0., -1.], [1., 1.]))
        rhs = np.r_[offsets-normals@a, 0., 0., 1.]
        for j in range(len(rhs)):
            for k in range(j):
                pair = matrix[[j, k]]
                if abs(np.linalg.det(pair)) < 1e-12: continue
                point = np.linalg.solve(pair, rhs[[j, k]])
                if np.all(matrix@point <= rhs+1e-9): return True
    return False
for centre in [np.zeros(3), np.array([8., 0, 0]), np.array([4., 0, 0]),
               *rng.uniform(-5, 5, (25, 3))]:
    width = .4
    planes = [(sign*np.eye(3)[axis], sign*centre[axis]+width)
              for axis in range(3) for sign in (-1., 1.)]
    n = rng.normal(size=3); n /= np.linalg.norm(n)
    planes.append((n, float(n@centre+.1)))
    assert native_surface.cell_meets_surface(planes, centre-width, centre+width) == brute_meets_surface(planes)
lo, hi = np.array([-4., -4., -4.]), np.array([4., 4., 4.])
counts = []
for size in (2., 1., .5, .25):
    points, candidates = cell_sampling.surface_seeds(tree, lo, hi, lambda _: 1., size,
        solidfit.CELLS_PER_M3, solidfit.CELL_METRIC, np.random.default_rng(31), solidfit._inside)
    counts.append(len(points))
    assert np.all(points > lo) and np.all(points < hi)
    assert len(points) <= candidates
assert all(b > 2*a for a, b in zip(counts, counts[1:])), counts
assert counts[-1] > 2000, 'A fixed candidate-count cap returned'

# Compare local cell completion with checking every seed, including distant
# seeds that may bound a cell at the edge of the cloud.
import mathutils.kdtree
real_tree = mathutils.kdtree.KDTree
class AllNeighbours:
    def __init__(self, count):
        self.tree, self.points = real_tree(count), []
    def insert(self, point, index):
        self.points.append((point.copy(), index)); self.tree.insert(point, index)
    def balance(self): self.tree.balance()
    def find_n(self, *args): return self.tree.find_n(*args)
    def find_range(self, point, radius):
        return [(p, i, float(np.linalg.norm(p-point))) for p, i in self.points]
calls = 0
def all_seed_tree(count):
    global calls
    calls += 1
    return real_tree(count) if calls == 1 else AllNeighbours(count)
camera = solidfit.Camera((0, -10, 0), 10)
params = solidfit.resolved({'stoneSize': 2.})
boulder = solidfit._boulders()[0]
local = solidfit.Cells(ob, tree, camera, params, boulder, np.random.default_rng(31), {})
try:
    mathutils.kdtree.KDTree = all_seed_tree
    exhaustive = solidfit.Cells(ob, tree, camera, params, boulder, np.random.default_rng(31), {})
finally:
    mathutils.kdtree.KDTree = real_tree
assert len(local.planes) == len(exhaustive.planes)
for actual, expected in zip(local.planes, exhaustive.planes):
    actual = np.array([(*n, b) for n, b in actual])
    expected = np.array([(*n, b) for n, b in expected])
    assert actual.shape == expected.shape
    assert np.allclose(actual, expected, atol=1e-8, rtol=1e-9)

# Curvature splitting follows the requested stone size without corrupting
# the depth factor subsequently used for finishing each child stone.
cells = solidfit.Cells.__new__(solidfit.Cells)
cells.camera = solidfit.Camera((0, -10, 0), 10)
cells.p = solidfit.resolved({'stoneSize': 2.})
cells.planes, cells.tapers, cells.f = [[]], [{}], [1.]
cells.box = lambda _: (np.zeros(3), np.array([.3, 0., .2]))
assert cells.split(0) is None
cells.p['stoneSize'] = .25
assert len(cells.split(0)) == 2
assert cells.f == [1., 1., 1.]

# Completed pieces can stay outside the scene while a modifier evaluates
# just its active host. Boolean operands must still be evaluated correctly.
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(); host = bpy.context.object
bpy.ops.mesh.primitive_cube_add(location=(1, 0, 0)); operand = bpy.context.object
for part in (host, operand):
    for collection in list(part.users_collection): collection.objects.unlink(part)
solidfit._boolean(host, operand, 'UNION')
bm = bmesh.new(); bm.from_mesh(host.data)
assert all(e.is_manifold for e in bm.edges)
assert abs(bm.calc_volume()-12.) < 1e-6
bm.free()
assert not host.users_collection and not operand.users_collection
print('STONE_SIZE_OK', counts, 'native/exhaustive cells agree; curvature scales correctly', flush=True)
