"""Minimal regression: an eight-vertex box must not reshuffle the stone RNG."""
import sys
from pathlib import Path
sys.path[:0] = [str(Path(__file__).parent), str(Path(__file__).parent/'boulders')]
import numpy as np
import bpy
from mathutils.bvhtree import BVHTree
from formations import solidfit, cell_sampling

# A thin rotated box at the cave's world coordinates. Previously the two
# diagonalisations classified `point` True/False: a ray hit one face twice.
vertices = np.array([
    [54.99449802131764,3.5720545565275414,-11.911715607489803],
    [65.730866614862,9.298389446613164,-1.522323028992136],
    [54.4161622513509,-1.3853920112605635,-8.581662865459592],
    [65.15253084489525,4.340942878825059,1.807729713038074],
    [54.84746915510475,3.6590571211749405,-11.807729713038075],
    [65.5838377486491,9.385392011260564,-1.4183371345404074],
    [54.269133385138005,-1.2983894466131645,-8.477676971007863],
    [65.00550197868236,4.427945443472458,1.9117156074898025],
])
faces = [(0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)]
point = np.array([64.33106552069685,7.956822484578677,-2.1789806592851706])
rng = np.random.default_rng(31)
axes = np.array([vertices[4]-vertices[0],vertices[2]-vertices[0],vertices[1]-vertices[0]])/2
centre = vertices.mean(0)
inside = np.concatenate([[point],centre+rng.uniform(-.9,.9,(100,3))@axes])
outside = centre+np.array([(sign*1.2,0,0) for sign in (-1,1)]+[(0,sign*1.2,0) for sign in (-1,1)]+[(0,0,sign*1.2) for sign in (-1,1)])@axes
for translation in (np.zeros(3),np.array([-60.,0,0]),np.array([940.,0,0])):
    for variant in range(8):
        triangles = []
        for i,(a,b,c,d) in enumerate(faces):
            triangles += [(a,b,c),(a,c,d)] if (variant+i)%2 else [(a,b,d),(b,c,d)]
        rng.shuffle(triangles)
        tree = BVHTree.FromPolygons((vertices+translation).tolist(),triangles,all_triangles=True)
        assert solidfit._inside(tree,inside+translation).all(), (translation,variant)
        assert not solidfit._inside(tree,outside+translation).any(), (translation,variant)

# Concavity/cavities: the first exit works even when another shell lies beyond it.
corners = np.array([(x,y,z) for x in (-1,1) for y in (-1,1) for z in (-1,1)])
shell = BVHTree.FromPolygons(np.concatenate([corners*2,corners]).tolist(),
    faces+[tuple(8+i for i in reversed(f)) for f in faces])
assert solidfit._inside(shell,[[1.5,0,0],[0,-1.5,0]]).all()
assert not solidfit._inside(shell,[[0,0,0],[3,0,0]]).any()

# Filtering a different set of candidates cannot renumber surviving stones.
tree = BVHTree.FromPolygons((corners*2).tolist(),faces)
def seeds(classifier):
    return cell_sampling.surface_seeds(tree,np.full(3,-2.),np.full(3,2.),lambda _:1.,1.,
        solidfit.CELLS_PER_M3,solidfit.CELL_METRIC,np.random.default_rng(31),classifier,with_ids=True)
a, count_a, ids_a = seeds(solidfit._inside)
b, count_b, ids_b = seeds(lambda tree,points: solidfit._inside(tree,points)&(points[:,0]<0))
assert 0<len(b)<len(a) and count_a==count_b
lookup = dict(zip(ids_a,a))
full = {int(i):cell_sampling.stone_rng(31,i,stream=0).random(2) for i in ids_a}
for identity,position in zip(ids_b,b):
    assert np.array_equal(position,lookup[identity])
    assert np.array_equal(cell_sampling.stone_rng(31,identity,stream=0).random(2),full[int(identity)])

# Bevel draws on surviving/split stones cannot consume another stone's randomness.
cells = solidfit.Cells.__new__(solidfit.Cells)
cells.p = solidfit.resolved({'seed':31})
cells.random_keys = [(12,0),(19,0),(12,1),(12,2)]
expected = cells.stone_rng(1,1).random(4)
cells.stone_rng(0,1).random(1000)
assert np.array_equal(expected,cells.stone_rng(1,1).random(4))
assert not np.array_equal(cells.stone_rng(2,1).random(4),cells.stone_rng(3,1).random(4))
assert not np.array_equal(cells.stone_rng(0,0).random(4),cells.stone_rng(0,1).random(4))

# Orientation comes from the authored guide, not a boolean's varying faces.
def object_from(name, polygons):
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices.tolist(),[],polygons);mesh.update()
    return bpy.data.objects.new(name,mesh)
guide=object_from('Stable guide',faces)
versions=[]
for variant in range(2):
    triangles=[]
    for a,b,c,d in faces:
        triangles += [(a,b,c),(a,c,d)] if variant else [(a,b,d),(b,c,d)]
    solid=object_from('Boolean surface',triangles)
    built=solidfit.Cells(solid,solidfit._tree(solid),solidfit.Camera((60,-10,-5),10),
        solidfit.resolved({'seed':31}),solidfit._boulders()[0],np.random.default_rng(31),{},guide=guide)
    versions.append(built)
assert versions[0].random_keys==versions[1].random_keys
for a,b in zip(versions[0].tapers,versions[1].tapers):
    for field in a:assert np.array_equal(a[field],b[field]),field
print('STONE_REPEATABILITY_OK: triangulation, translation, cavity, seed filtering, split RNG and guide orientation',flush=True)
