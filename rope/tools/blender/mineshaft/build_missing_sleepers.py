"""Build one single-sleeper variant: intact rails, retained chairs, torn stubs.

blender -b -noaudio --factory-startup --python-exit-code 1 --python rope/tools/blender/mineshaft/build_missing_sleepers.py
Append -- b or -- c for the alternate splinter patterns.
"""
import random
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from edge_weathering import bake_object

ROOT = Path(__file__).resolve().parents[3]
VARIANT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv[:-1] else 'a'
assert VARIANT in ('a', 'b', 'c'), 'Variant must be a, b or c'
NAME = f'mine-rail-missing-sleepers-{VARIANT}'
MODELS = ROOT / 'assets-src/models'
PREVIEW = ROOT / 'assets-src/studies/mineshaft'
bpy.ops.wm.open_mainfile(filepath=str(MODELS / 'mine-rail-segment-bare.blend'))
scene = bpy.context.scene
kit = bpy.data.collections['mine-rail-segment-bare']
kit.name = NAME
kit.asset_data.description = f'1.3 m intact rails with one missing sleeper: original iron chairs, clips and nails holding jagged oak remnants. Variant {VARIANT.upper()}.'
kit['sleeper_spacing_m'] = 1.3
kit['snap_length_m'] = 1.3
kit['end_translation_m'] = [1.3, 0.0, 0.0]
for rail in kit.objects:
    if rail.name.startswith('Rail •'):
        for vertex in rail.data.vertices:
            vertex.co.x *= .5
        rail.data.update()
    elif rail.name.startswith('socket.end'):
        rail.location.x = 1.3
with bpy.data.libraries.load(str(MODELS / 'mine-sleeper-a.blend'), link=False) as (src, dst):
    dst.objects = [n for n in src.objects if 'wood and fasteners' in n]
fittings = dst.objects[0]
kit.objects.link(fittings)
# Delete the connected timber component, retaining original iron geometry,
# bevels, material assignments and packed UV paint.
bm = bmesh.new()
bm.from_mesh(fittings.data)
unvisited = set(bm.verts)
removed = 0
while unvisited:
    seed = unvisited.pop()
    component = {seed}
    pending = [seed]
    while pending:
        for edge in pending.pop().link_edges:
            for v in edge.verts:
                if v in unvisited:
                    unvisited.remove(v)
                    component.add(v)
                    pending.append(v)
    if max(v.co.y for v in component) - min(v.co.y for v in component) > 1:
        bmesh.ops.delete(bm, geom=list(component), context='VERTS')
        removed += 1
assert removed == 1, f'Expected one wooden sleeper, got {removed}'
bm.to_mesh(fittings.data)
bm.free()
fittings.name = 'Retained chairs clips and nails • station 1'
fittings.location.x = .65

wood = bpy.data.materials['Sleeper • broad painted oak']
edge = bpy.data.materials['Sleeper • worn golden bevel']
end = bpy.data.materials['Sleeper • split end timber']
rng = random.Random({'a': 271126, 'b': 271237, 'c': 271349}[VARIANT])
strip_count = {'a': 3, 'b': 3, 'c': 4}[VARIANT]
verts, faces, indices = [], [], []
# Independent narrow shards follow timber grain across Y. Random positions
# along travel (X) leave open gaps between roots, exposing each iron chair.
for station, x in enumerate((.65,)):
    # Four independent distributions: the two edges of each of the two rails.
    # Each shard ends under its chair instead of crossing to the other edge.
    for side, edge_side in ((s, e) for s in (-1, 1) for e in (-1, 1)):
        y = side * .57
        positions = []
        for attempt in range(2000):
            if attempt % 50 == 0:
                positions = []
            candidate = rng.uniform(-.112, .112)
            if all(abs(candidate - previous) > .052 for previous in positions):
                positions.append(candidate)
            if len(positions) == strip_count:
                break
        assert len(positions) == strip_count, 'Could not space individual shards'
        for strip in range(strip_count):
            cx = x + positions[strip]
            half = rng.uniform(.009, .018)
            reach = {'a': (.205, .20), 'b': (.15, .17), 'c': (.245, .225)}[VARIANT]
            tip = rng.uniform(.105, reach[0 if edge_side < 0 else 1])
            if VARIANT == 'b' and strip == (0 if side < 0 else 1):
                tip += .075
            if VARIANT == 'c' and strip == 2:
                tip = .11
            bottom = rng.uniform(.065, .10)
            top = .13
            # A buried root and one exposed broken tip. The opposite edge
            # gets its own independently scattered shards, not this root.
            sections = [(.025, half * .8, bottom, top),
                        (.065, half, bottom, top),
                        (.10, half, bottom + .004, top),
                        (tip, half * rng.uniform(.08, .70), bottom + rng.uniform(-.02, .01), bottom + .018)]
            offset = len(verts)
            for dy, width, low, high in sections:
                dy *= edge_side
                skew = rng.uniform(-.004, .004)
                verts.extend([(cx-width+skew, y+dy, low), (cx+width+skew, y+dy, low),
                              (cx+width+skew, y+dy, high), (cx-width+skew, y+dy, high)])
            faces.append(tuple(offset+j for j in (3, 2, 1, 0)))
            indices.append(2)
            for k in range(3):
                for j in range(4):
                    faces.append((offset+k*4+j, offset+k*4+(j+1)%4,
                                  offset+(k+1)*4+(j+1)%4, offset+(k+1)*4+j))
                    indices.append(1 if k != 1 and j == 2 else 0)
            faces.append(tuple(offset+12+j for j in range(4)))
            indices.append(2)
mesh = bpy.data.meshes.new('Split oak fibres along original sleeper grain')
mesh.from_pydata(verts, [], faces)
mesh.update()
for mat in (wood, edge, end):
    mesh.materials.append(mat)
for p, index in zip(mesh.polygons, indices):
    p.material_index = index
bm = bmesh.new()
bm.from_mesh(mesh)
bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
bm.to_mesh(mesh)
bm.free()
coords = mesh.attributes.new('paint_coords', 'FLOAT_VECTOR', 'POINT')
for v, a in zip(mesh.vertices, coords.data):
    a.vector = (v.co.y, v.co.x, v.co.z)
ob = bpy.data.objects.new('Splintered sleeper remnants • two fastening seats', mesh)
kit.objects.link(ob)
bake_object(ob, 1024)
assert len([o for o in kit.objects if o.name.startswith('Rail •')]) == 2
bpy.ops.wm.save_as_mainfile(filepath=str(MODELS / f'{NAME}.blend'), compress=True)

# Presentation is created after saving so it cannot enter the model export.
world = bpy.data.worlds.new('Review slate world')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (.12, .15, .23, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = .65
scene.world = world
for loc, power, size in [((1, -3, 5), 650, 4), ((0, 3, 3), 450, 3)]:
    bpy.ops.object.light_add(type='AREA', location=loc)
    light = bpy.context.object
    light.data.energy, light.data.shape, light.data.size = power, 'DISK', size
    light.rotation_euler = (Vector((.65, 0, .1))-light.location).to_track_quat('-Z', 'Y').to_euler()
bpy.ops.object.camera_add()
scene.camera = bpy.context.object
scene.camera.data.type = 'ORTHO'
scene.camera.data.ortho_scale = 2.3
scene.render.engine = 'CYCLES'
scene.cycles.samples = 40
scene.render.resolution_x, scene.render.resolution_y = 1400, 850
scene.render.resolution_percentage = 100
for suffix, loc in [('overview', (1.95, -3.8, 3.3)), ('low-angle', (.65, -4, 2))]:
    scene.camera.location = loc
    scene.camera.rotation_euler = (Vector((.65, 0, .12))-scene.camera.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = str(PREVIEW / f'{NAME}-{suffix}.png')
    bpy.ops.render.render(write_still=True)
print('BUILT', NAME, flush=True)
