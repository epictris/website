"""The short tiling track segment: two sleepers and half a spacing of rail beyond each.

Run from the repository root:
    blender -b -noaudio --factory-startup --python-exit-code 1 --python rope/tools/blender/mineshaft/build_rail_segment.py [-- broken|bare]
No variant builds `mine-rail-segment` from `mine-rail-straight.blend`; `broken`
builds `mine-rail-segment-broken` from `mine-rail-broken.blend`; `bare` builds
`mine-rail-segment-bare`, the rails alone, from `mine-rail-straight-bare.blend`.

Segments laid end to end keep the spacing across every join, so a run of track
is as long as the segments it is made of, LENGTH at a time (Tris, 2026-11-26:
"only 2 sleepers + half a stretch of rail on each end, so that I can more
precisely control how long the rail is").

The segment is the kit's own track, not a copy of it: it opens the kit file,
keeps its sleeper assembly (one baked sleeper repeated by the Repeat sleepers
modifier, set here to LENGTH and SPACING), and rebuilds the rails with the
kit's section (rail_profile.py) at LENGTH, their edge wear baked as build.py
bakes it (edge_weathering.py), from the authoring materials the kit file keeps
in its unused slots.
"""
import bpy, math, sys
from pathlib import Path
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rail_profile import rail_geometry
from edge_weathering import bake_object

ROOT = Path(__file__).resolve().parents[3]
MODELS = ROOT / 'assets-src/models'
# Centre to centre. Measured on Tris's reference picture of the spacing he
# wanted (2026-11-26): sleeper centres 1.16 rail gauges apart, about three
# sleeper widths; on the kit's 1.14 m gauge and 0.40 m sleepers, 1.3 m. The
# kit's own track has them 0.5 m apart.
SPACING = 1.3
# Two sleepers, SPACING/2 of rail beyond each.
LENGTH = 2 * SPACING
VARIANTS = {'': ('mine-rail-segment', 'mine-rail-straight', False),
            'broken': ('mine-rail-segment-broken', 'mine-rail-broken', True),
            # The rails alone, no sleepers: a stretch to lay over a gap or
            # patch in where the track is missing a piece (2026-11-26).
            'bare': ('mine-rail-segment-bare', 'mine-rail-straight-bare', False)}
VARIANT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv[:-1] else ''
if VARIANT not in VARIANTS:
    raise SystemExit(f'unknown variant {VARIANT!r}; one of {sorted(v for v in VARIANTS if v)}')
NAME, SOURCE, BROKEN = VARIANTS[VARIANT]
# The kit's straight track, its rails and its gaps where broken (build.py `rail_segment`).
KIT_LENGTH = 4
GAPS = {-1: [(0, .40), (.55, 1)], 1: [(0, .45), (.60, 1)]}

bpy.ops.wm.open_mainfile(filepath=str(MODELS / f'{SOURCE}.blend'))
scene = bpy.context.scene
kit = bpy.data.collections[SOURCE]
kit.name = NAME
sleepers = next((o for o in kit.objects if o.name.startswith('Sleepers +')), None)
kit.asset_data.description = (f'Original painterly fantasy mineshaft track segment, {LENGTH:g} m: '
                              + (f'two sleepers {SPACING:g} m apart, {SPACING / 2:g} m of rail beyond each, so segments tile '
                                 f'at an even spacing{"; both rails broken" if BROKEN else ""}' if sleepers
                                 else 'the rails alone, no sleepers, to lay over a gap or patch a missing piece')
                              + '. Metres, Z up, -Y front.')

# The sleeper assembly: the Repeat sleepers node group fits floor(length /
# spacing) sleepers along the track with equal end margins, its length a
# constant of the group. A bare track has none.
if sleepers is not None:
    mod = next(m for m in sleepers.modifiers if m.type == 'NODES')
    group = mod.node_group.copy()
    group.name = f'{NAME} • sleeper distribution'
    mod.node_group = group
    lengths = [s for node in group.nodes if node.type == 'MATH' for s in node.inputs[:2]
               if not s.is_linked and math.isclose(s.default_value, KIT_LENGTH)]
    if len(lengths) != 2:
        raise SystemExit(f'{SOURCE}: expected the track length in two nodes of the Repeat sleepers group, found {len(lengths)}')
    for s in lengths:
        s.default_value = LENGTH
    spacing = next(i for i in group.interface.items_tree if getattr(i, 'name', '') == 'Sleeper spacing')
    spacing.default_value = SPACING
    # Blender 5's modifier inputs (no longer ID properties of the modifier).
    getattr(mod.properties.inputs, spacing.identifier).value = SPACING

# The rails, rebuilt at LENGTH from the kit's authoring materials.
metal, top, edge = (bpy.data.materials[n] for n in ('Track • aged warm iron', 'Track • burnished olive steel', 'Track • worn lip'))
for o in [o for o in kit.objects if o.name.startswith('Rail •')]:
    bpy.data.objects.remove(o, do_unlink=True)
center = lambda t: Vector((t * LENGTH, 0, 0))  # noqa: E731
tangent = lambda t: Vector((1, 0, 0))  # noqa: E731
steps = round(32 * LENGTH / KIT_LENGTH)  # the kit's 0.125 m slices
rails = []
for side in (-1, 1):
    for lo, hi in (GAPS[side] if BROKEN else [(0, 1)]):
        # The head's wear at the kit's bites a metre.
        verts, faces = rail_geometry(center, tangent, side, lo, hi, BROKEN,
                                     steps=max(4, round(steps * (hi - lo))), bite_waves=9 * LENGTH / KIT_LENGTH)
        mesh = bpy.data.meshes.new('Continuous forged I rail')
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        o = bpy.data.objects.new('Rail • continuous I profile', mesh)
        kit.objects.link(o)
        for m in (metal, top, edge):
            mesh.materials.append(m)
        for p in mesh.polygons:
            p.material_index = 1 if p.normal.z > .6 else 0
        bevel = o.modifiers.new('Worn rail lips', 'BEVEL')
        bevel.width = .007
        bevel.segments = 1
        bevel.material = 2
        rails.append(o)
bpy.context.view_layer.update()
for o in rails:
    bake_object(o, 1024)

for o in kit.objects:
    # By prefix: a copied collection's sockets carry Blender's .001 suffixes.
    if o.name.startswith('socket.end'):
        o.location = (LENGTH, 0, 0)
kit['snap_length_m'] = LENGTH
kit['end_translation_m'] = [LENGTH, 0.0, 0.0]
kit['sleeper_spacing_m'] = SPACING

bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
bpy.ops.wm.save_as_mainfile(filepath=str(MODELS / f'{NAME}.blend'), compress=True)
print('BUILT', NAME, f'{LENGTH:g} m', 'rails', len(rails), flush=True)
