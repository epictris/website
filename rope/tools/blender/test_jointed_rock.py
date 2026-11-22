"""Joint hierarchy, reproducibility, physical scale, and export finish ownership."""
import json
import sys
from pathlib import Path
import bpy
import numpy as np

sys.path[:0] = [str(Path(__file__).parent), str(Path(__file__).parent/'boulders')]
from formations import solidfit, jointed, render, slate

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
guide = bpy.context.object
for v in guide.data.vertices:
    v.co.x *= 4
    v.co.z *= 3
guide.data.update()

def partition(size=1., seed=31):
    p = solidfit.resolved({'seed': seed, 'stoneSize': size, 'jointed': True, 'jointAspect': 3.2})
    report = {}
    cells = jointed.JointCells(guide, solidfit._tree(guide), None, p,
                              solidfit._boulders()[0], np.random.default_rng(seed), report, guide=guide)
    return cells, report

first, report = partition()
second, _ = partition()
assert report['cells'] > report['primary joints'] > 10, report
assert first.random_keys == second.random_keys
assert len(set(first.random_keys)) == len(first.random_keys)
# Every fracture belongs to one of the asset's three shared joint sets,
# including the small breaks in its dipping damage bands.
for planes in first.planes:
    for normal, _ in planes:
        assert np.max(np.abs(first.directions @ normal)) > np.cos(np.deg2rad(10))
assert all(abs(t['fold']) >= .15 for t in first.tapers)
# The large relief is a common spatial field, not a new central ridge or
# independently chosen height for each stone.
samples = np.array([[x, -1., z] for x in (-2., 0., 2.) for z in (-2., 0., 2.)])
shared = [jointed.sink(dict(t, step=0., cleavage=np.zeros(3), fold=0., cross_fold=0.), samples)
          for t in first.tapers]
assert np.allclose(shared, shared[0])
assert np.ptp(shared[0]) > .1
# Broad mass shoulders are planar within each shared interval, not smooth
# sine/tanh lobes that become melted-looking surfaces up close.
line = np.array([[.2, 0., .1], [.25, 0., .1], [.3, 0., .1]])
heights = jointed.mass_height(line, 0.)
assert abs(heights[0]-2*heights[1]+heights[2]) < 1e-10
# These two points in the study wall used to hit the low height clamp and
# become one shaved plateau despite the underlying change of slope.
low_points = np.array([[4., -1., 0.], [4.5, -1., 0.]])
low_taper = dict(first.tapers[0], k=.75, centre=np.zeros(3), step=0.,
                 cleavage=np.zeros(3), fold=0., cross_fold=0.)
assert np.all(jointed.mass_height(low_points/.75, 31*.61) < -.2)
assert np.ptp(jointed.sink(low_taper, low_points)) > .001
# A corner's nearest cap must not leave its front face unworked. Exercise
# both signs of the wall's ends, with a cap-oriented source profile.
for sign in (-1., 1.):
    profile = first._joint_taper(np.array([sign*3.99, -.45, .2]), np.random.default_rng(18))
    assert abs(profile['n'][0]) > .99
    planes = [(np.array([sign, 0., 0.]), 4.), (np.array([0., -1., 0.]), 1.)]
    surfaces = jointed.surface_profiles(profile, planes)
    points = np.array([[sign*x, -1., z] for x in (3.5, 3.7, 3.95) for z in (-.5, 0., .5)])
    moved = jointed.displace(surfaces, points)-points
    assert np.ptp(moved[:, 1]) > .03, moved
    assert np.max(abs(moved[:, 0])) > .03, moved
    # The retargeted surface frame stays tangent and centered on its face.
    for surface in surfaces:
        assert abs(surface['n']@surface['t']) < 1e-6
        assert abs(surface['n']@surface['centre']-surface['plane']) < 1e-6
        # The worked skin must not translate its interior attachment. A
        # cap-wide translation used to detach corner fragments from the core.
        surface = dict(surface, anchor_depth=.3)
        root = surface['centre']-surface['n']*.4
        assert np.allclose(jointed.displace([surface], np.array([root])), [root])
        skin = surface['centre']
        assert np.linalg.norm(jointed.displace([surface], np.array([skin]))-[skin]) > .01
# A guide-clipped/merged face may sit away from its original cell centre.
# Its visible cleavage must cross the face's interior, not shave an edge.
footprint = np.array([[x, -1., z] for x in (1.5, 3.) for z in (-1., 1.)])
face_profile = jointed.surface_profiles(profile, [(np.array([0., -1., 0.]), 1.)], footprint)[0]
axis = face_profile['fold_axis']
projected = footprint@axis
cut = face_profile['centre']@axis+face_profile['fold_at']*face_profile['k']
fraction = (cut-projected.min())/np.ptp(projected)
assert .35 <= fraction <= .65, fraction
# A broad cleavage changes slope once, with planar stretches on both
# sides, instead of repeating a right-angle bounded shelf on every face.
taper = first.tapers[0]
axis, at = taper['fold_axis'], taper['fold_at']
positions = np.array([-.4, -.2, 0., .2, .4])+at
probe = taper['centre']+positions[:, None]*axis*taper['k']
base = dict(taper, fold=0., cross_fold=0., step=0., cleavage=np.zeros(3))
folded = dict(base, fold=taper['fold'])
effect = jointed.sink(folded, probe)-jointed.sink(base, probe)
assert np.allclose(effect[:3], 0.)
assert abs(effect[2]-2*effect[3]+effect[4]) < 1e-7
assert abs(effect[-1]) > .025*taper['k']
for a, b in zip(first.planes, second.planes):
    assert len(a) == len(b)
    for (n, d), (nn, dd) in zip(a, b):
        assert np.array_equal(n, nn) and d == dd
# Broad front faces inherit long, predominantly vertical fracture cells.
extents = np.array([first.box(i)[1]*2 for i in first.ids()])
assert np.percentile(extents[:, 2]/extents[:, 0], 75) > 1.5, extents
for taper in first.tapers:
    p = taper['centre'] + np.array([[0.,0.,0.], [.3,0,.2], [-.4,0,-.3]])
    scaled = dict(taper, centre=taper['centre']*2, k=taper['k']*2)
    assert np.allclose(jointed.sink(scaled, p*2), 2*jointed.sink(taper, p))
    assert np.isfinite(jointed.sink(taper, p)).all()
for v in guide.data.vertices:
    v.co *= 2
guide.data.update()
scaled, scaled_report = partition(2.)
assert scaled_report == report
assert scaled.random_keys == first.random_keys
for i in first.ids():
    assert np.allclose(scaled.box(i), np.array(first.box(i))*2, atol=1e-4)
# A finished master keeps its straight fractures during export, including an
# old explicit True setting. Fine chips and strip colouring still export.
ob = {'formation_recipe': json.dumps({'surfaceFinish': ['export_creases']}), 'export_creases': True}
assert render.setting(ob, 'export_creases') is False
assert render.setting(ob, 'export_chips') is True
assert render.setting(ob, 'export_strips') is True
assert render.setting({}, 'export_creases') is True
# Finishing must not reintroduce broad normal interpolation or move the
# fracture planes. The shader alone supplies the small edge bevel.
positions_before = np.array([v.co[:] for v in guide.data.vertices])
polygons_before = len(guide.data.polygons)
guide.data.shade_smooth()
jointed.finish(guide, 31, bpy.context.scene.collection)
assert np.array_equal(positions_before, np.array([v.co[:] for v in guide.data.vertices]))
assert polygons_before == len(guide.data.polygons)
assert not any(p.use_smooth for p in guide.data.polygons)
# Repainting preserves opt-in weathering, and export detail normals still
# feed through both the existing edge bevel and the fine surface bump.
material = slate.painted_slate('Jointed test slate')
assert 'Slate fine weathering' not in material.node_tree.nodes
material[slate.WEATHERING_PROP] = True
slate.paint(material)
nodes = material.node_tree.nodes
texture = nodes.new('ShaderNodeTexImage')
normal_map = slate.add_detail(material, texture.outputs['Color'], 'UVMap')
assert nodes[slate.SHADING_BEVEL].inputs['Normal'].links[0].from_node == normal_map
bump = nodes['Slate fine weathering']
assert bump.inputs['Normal'].links[0].from_node == nodes[slate.SHADING_BEVEL]
bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
assert bsdf.inputs['Normal'].links[0].from_node == bump
assert bsdf.inputs['Roughness'].is_linked
print('JOINTED_ROCK_OK: shared fractures/relief, scale, closed-finish ownership and weathering bake chain', flush=True)
