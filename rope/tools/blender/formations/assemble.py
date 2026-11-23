"""The worker's Blender half: join the generator's slabs into one rock.

    blender -b --factory-startup --python-exit-code 1 --python assemble.py -- OUT_DIR

Reads OUT_DIR/geometry.json and recipe.json (written by worker.py), assembles
the rock with the boulder generator's own `assemble_rock` - or, for the
`fitted` generator, builds recipe F's rocks fitted to the outline and fuses
them (fitted.py), or for the `solid` generator cuts stones from the recipe's
guide mesh and works each as the boulder generator works its top (solidfit.py;
its Stones variant packs whole recipe F stones into the guide, stones.py) -
gives it the painted slate (slate.py), removes the
microscopic faces its bevel and remesh can leave, validates it exactly as the
Formations panel will before swapping it in, and saves OUT_DIR/rock.blend
holding `SceneryRock` alone: the pieces it was built from are dropped.
"""

import json
import sys
from pathlib import Path

import bmesh
import bpy

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "boulders"))
sys.path.insert(0, str(HERE.parent))
from blender_build import assemble_rock, mesh_health  # noqa: E402

from formations.core import validate_worker  # noqa: E402
from formations import fitted, render, slate as slate_module, solidfit  # noqa: E402
from formations.slate import painted_slate, tone_facets  # noqa: E402


def collapsible(edge):
    """Collapsing `edge` keeps the mesh a manifold: its ends share no
    neighbour but the far corners of its own two triangles (the link
    condition). bmesh's dissolve_degenerate does not ask, and on a large rock
    it pinched the mesh where it collapsed a few dozen edges (2026-10-16)."""
    a, b = edge.verts
    if len(edge.link_faces) != 2 or any(len(f.verts) != 3 for f in edge.link_faces):
        return False
    shared = {e.other_vert(a) for e in a.link_edges} & {e.other_vert(b) for e in b.link_edges}
    return shared == {v for f in edge.link_faces for v in f.verts if v not in edge.verts}


def drop_fins(bm):
    """Delete every fin: a face all of whose edges but one are its alone, the
    one left shared by more than two faces. The triangulate that finishes a
    rock makes them where a bevelled n-gon pinches to a sliver (Cube.005,
    2026-11-13: two triangles of 2e-9 and 2.5e-7 m2, each hanging off an edge
    of three faces); one gone, its edge has two faces again and its own lone
    edges and corners go with it, so the surface is closed. Returns how many
    were deleted."""
    dropped = 0
    while True:
        fins = [f for f in bm.faces
                if sum(len(e.link_faces) == 1 for e in f.edges) == len(f.edges) - 1
                and any(len(e.link_faces) > 2 for e in f.edges)]
        if not fins:
            return dropped
        bmesh.ops.delete(bm, geom=fins, context="FACES")
        dropped += len(fins)


def remove_degenerate(bm, dist):
    """Collapse every edge shorter than `dist` that can be collapsed, shortest
    first, then flip the longest edge of any triangle left with no area (a
    needle: its third corner lies on that edge). The faces around them are
    made triangles first (the fitted and solid rocks keep n-gons), never
    making an edge the mesh has (`solidfit.triangulate`). Fins (`drop_fins`)
    go first."""
    drop_fins(bm)
    around = {f for e in bm.edges if e.calc_length() < dist for f in e.link_faces}
    around |= {f for f in bm.faces if f.calc_area() <= 1e-12}
    around = [f for f in around if len(f.verts) > 3]
    if around:
        solidfit.triangulate(bm, around, quad_method="BEAUTY")
    # Collapsed in batches: a bmesh operator costs as much as the whole mesh
    # (210 one-edge collapses on Cube.005's 290k faces took 27 s), so every
    # edge whose ends' neighbours no earlier edge of the pass touches goes in
    # one call. Whether an edge can collapse, and what its collapse does,
    # depends only on its ends and their neighbours, so a batch is the same
    # as collapsing its edges one by one; an edge that must wait for an
    # earlier one holds back the edges near it too, so none is collapsed out
    # of the shortest-first order. An edge that cannot collapse changes
    # nothing and holds nothing back.
    for _ in range(100):
        short = sorted((e for e in bm.edges if e.calc_length() < dist), key=lambda e: e.calc_length())
        batch, touched = [], set()
        for edge in short:
            ring = {w for v in edge.verts for e in v.link_edges for w in e.verts}
            if ring & touched:
                touched |= ring
            elif collapsible(edge):
                batch.append(edge)
                touched |= ring
        if not batch:
            break
        bmesh.ops.collapse(bm, edges=batch, uvs=False)
    # A needle whose longest edge cannot turn (Blender's rotate refuses where
    # the new diagonal is an edge already, or where the edge is not shared by
    # two faces) has its shortest edge collapsed instead, which moves its
    # corners by no more than that edge's length: before, it was left, and
    # the rock failed "must have nonzero volume and faces".
    for _ in range(20):
        needles = [f for f in bm.faces if len(f.verts) == 3 and f.calc_area() <= 1e-12]
        if not needles:
            break
        changed = False
        for face in needles:
            if not face.is_valid or face.calc_area() > 1e-12:
                continue
            edge = max(face.edges, key=lambda e: e.calc_length())
            if edge.is_manifold and bmesh.ops.rotate_edges(bm, edges=[edge], use_ccw=False)["edges"]:
                changed = True
                continue
            shortest = min(face.edges, key=lambda e: e.calc_length())
            if collapsible(shortest):
                bmesh.ops.collapse(bm, edges=[shortest], uvs=False)
                changed = True
        if not changed:
            break


out = Path(sys.argv[sys.argv.index("--") + 1])
recipe = json.loads((out / "recipe.json").read_text())
bpy.ops.wm.read_factory_settings(use_empty=True)
dst = bpy.data.collections.new("RESULT")
bpy.context.scene.collection.children.link(dst)
# The generators build their pieces here; only the rock is kept.
src = bpy.data.collections.new("Pieces")
bpy.context.scene.collection.children.link(src)
slate = painted_slate()
generator = recipe.get("generator", "boulders")
if generator == "solid":
    from formations.worker import solid_parameters, solid_variant
    recipe['params'] = solid_parameters(recipe)
    recipe['variant'] = solid_variant(recipe['params'])
    obj, scale = solidfit.build_from_recipe(recipe, src)
    dst.objects.link(obj)
    # Its lengths times its depth over the gameplay plane's, so it is worked
    # as finely on screen as a rock on the plane (scene_export.detail_scale).
    slate[slate_module.SCALE_PROP] = 1.0
    slate[slate_module.WEATHERING_PROP] = bool(recipe['params'].get('jointed'))
    slate_module.paint(slate)
    obj[render.DEPTH_SCALE] = round(scale, 4)
elif generator == "fitted":
    # Recipe F's rocks and the core are the slabs; the rock is them fused.
    obj, _ = fitted.build(recipe["outline"], recipe["params"], src)
    dst.objects.link(obj)
else:
    # The generator tints its slabs from six slots (five stones and the worn
    # edge); a formation is one painted slate instead, its per-slab variety
    # carried by the shader's per-facet tone.
    obj = assemble_rock(json.loads((out / "geometry.json").read_text())["rocks"][0], dst, src, [slate] * 6)
obj.name = "SceneryRock"
obj["formation_recipe"] = (out / "recipe.json").read_text()
obj.data.polygons.foreach_set("material_index", [0] * len(obj.data.polygons))
obj.data.materials.clear()
obj.data.materials.append(slate)

def clean(obj):
    """Bevel and remesh can collapse a triangle to nothing; remove only
    microscopic geometry, so the silhouette and the slabs are untouched.
    Returns how many faces went."""
    before = len(obj.data.polygons)
    bm = bmesh.new()
    try:
        bm.from_mesh(obj.data)
        remove_degenerate(bm, 1e-5)
        bm.normal_update()
        bm.to_mesh(obj.data)
        obj.data.update()
    finally:
        bm.free()
    return before - len(obj.data.polygons)


clean(obj)
# A Stones rock (stones.py) is already faceted stone by stone, as the study
# faceted rock-b, and a Faceted one (faceted.py) is nothing but its facets; a
# second dissolve over the whole would only blur that.
if generator == 'solid' and not (recipe['params'].get('stones') or recipe['params'].get('faceted')):
    # The adaptive remesh supplies a sampling grid, not the painted facets.
    # Join shallow folds into the existing slate's broad planes before tone
    # assignment, so arbitrary remesh triangles do not become colour patches.
    obj.data.calc_loop_triangles()
    # Jointed faces intentionally meet at shallow cleavage angles. The
    # old 9-degree dissolve erased these into wide featureless panels.
    fitted._facets(obj, len(obj.data.loop_triangles),
                   angle=3. if (recipe['params'].get('jointed') or recipe['params'].get('wall')) else None,
                   preserve_topology=True)
tone_facets(obj, recipe["params"]["seed"])
if generator == 'solid' and recipe['params'].get('jointed'):
    from formations.jointed import finish
    finish(obj, recipe['params']['seed'], dst)
    # The straight fracture boundaries are intentional. Export must not
    # reintroduce the broad crease bows that melted their plane transitions.
    recipe['surfaceFinish'] = ['export_creases']
    obj['formation_recipe'] = json.dumps(recipe, separators=(',', ':'))
if generator == 'solid' and recipe['params'].get('faceted'):
    # A background rock is its broad planes: straight edges, no chips.
    recipe['surfaceFinish'] = ['export_creases', 'export_chips']
    obj['formation_recipe'] = json.dumps(recipe, separators=(',', ':'))

for piece in list(src.objects):
    data = piece.data
    bpy.data.objects.remove(piece, do_unlink=True)
    if data is not None and data.users == 0:
        bpy.data.batch_remove(ids=[data])
bpy.data.collections.remove(src)
if generator == 'solid':
    # The facet dissolve and the jointed finish come after the clean above
    # and can leave faces of no area of their own (backdrop.back-wall, a 48 m
    # wall built Cliff, 2026-11-22: the rock failed validation for it).
    gone = clean(obj)
    if gone:
        print(f"Solid finish: {gone} microscopic faces removed after the finish", flush=True)
validate_worker(obj)
(out / "health.json").write_text(json.dumps(mesh_health(obj), indent=2))
bpy.ops.wm.save_as_mainfile(filepath=str(out / "rock.blend"))
print("FORMATION_ROCK_READY", flush=True)
