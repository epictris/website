"""Formations: rock masses generated from an outline, and what grows on them.

A FORMATION is a mesh object carrying `formation_recipe` - the outline (a
closed polygon in the rock's local X/Z plane) and the generator's parameters
that built it - under a PLACEMENT empty that positions, tilts and scales it in
the scene. The recipe is the source: the mesh is the generator's answer to it,
so an outline or parameter edit (`params.py`: the parameters are fields on the
rock) is a rebuild, and a mesh edited by hand is protected from being rebuilt
over (`formation_mesh_hash` seals the generated mesh; `formation_mode` MANUAL
keeps an edited one).

A SOLID formation (generator `solid`, a backdrop rock: docs/blender-backdrop.md)
has a GUIDE instead of an outline: a closed mesh, parented to the rock, that
recipe F stones are cut from (solidfit.py). It takes the outline's place
(`formation_outline` names it), so backups, copies and removal carry it the
same way; its recipe holds the guide's geometry, the game's start camera
(`scene[CAMERA]`, written by tools/blender/backdrop.py from the level) and the
rock's world frame, because a stone's size goes with its depth from that eye.

An outline formation's outline is its GUIDE too, and the guide is its only
source. A FREE GUIDE is a local closed curve no rock owns yet (in GUIDES when
the Game add-on copied it from a collision outline); New Formation from one
makes it the rock's own (`adopt_guide`). Nothing linked from another file is
ever a guide (`is_reference`): the level's collision outlines, linked from
`<scene>-guide.blend`, are a visual reference only, and nothing here reads or
writes one.

This add-on knows nothing of the game or the level editor: the Game add-on
(tools/blender/game) edits guides through the game camera and copies guides
from the collision outlines, through the functions here.

Construction helpers never ship and never render: every formation's guide
curve and the generator's source slabs live under RECIPES, and the mesh a
rebuild replaced is kept under BACKUPS. Both collections are hidden in render,
which the scene exporter honours. A backup's own outline and slabs go with it
to BACKUPS (`stow_helpers`): RECIPES is what Show guides draws, and an outline
there that no rock in the scene is built from reads as a guide that should
have gone.

Nothing here saves the file: every operation is an ordinary undoable edit of
the open scene.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

import bmesh
import bpy
from bpy.app.handlers import persistent
from mathutils import Matrix, Vector

from . import params, render

HERE = Path(__file__).resolve().parent
ROPE = HERE.parents[2]

FORMATIONS = "Formations"
RECIPES = "Formation recipes"
BACKUPS = "Formation backups"
# Free guides: copies of collision outlines no rock has been built from yet.
GUIDES = "Formation guides"
# An object that is never a guide, though it may look like one: something
# drawn to show where a guide is (the Game add-on's projection handles).
REFERENCE = "formation_reference"
# The scene properties a running Rebuild Changed sets: that it runs, and on what.
BUSY = "formations_busy"
PROGRESS = "formations_progress"
# Callables taking the scene, run before a rebuild or replant reads any guide:
# whatever holds guide edits outside the guides writes them in (the Game
# add-on's Edit Guides applies its handles and ends).
BEFORE_BUILD = []
# The scene property holding the game's start camera and water for solid
# formations: {"eye", "distance", "tanHalf", "waterZ"}.
CAMERA = "backdrop_camera"
# Guide colours: saturated, far from the slate's blue-grey, one per guide.
GUIDE_COLOURS = [(1.0, .25, .1), (.1, .9, .2), (1.0, .85, .05), (.95, .15, .85), (.1, .85, 1.0),
                 (1.0, .55, 0.0), (.6, .2, 1.0), (.55, 1.0, .1)]
# The diameter a guide curve draws at, in metres.
GUIDE_CURVE_WIDTH = .03


def collection(name, parent=None):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(c)
    return c


def helper_collection(name):
    """A never-rendered collection for construction data, hidden in the
    viewport when it is made (Show Guides shows it, and a rebuild leaves it
    as it was)."""
    new = bpy.data.collections.get(name) is None
    c = collection(name)
    c.hide_render = True
    if new:
        c.hide_viewport = True
    return c


def guides_collection():
    """GUIDES: free guides, shown in the viewport whatever Show guides says
    (it shows and hides RECIPES), and never rendered."""
    c = collection(GUIDES)
    c.hide_render = True
    return c


def move(ob, col):
    for old in list(ob.users_collection):
        old.objects.unlink(ob)
    col.objects.link(ob)


def is_formation(ob):
    return (ob is not None and ob.type == "MESH" and "formation_recipe" in ob
            and not ob.get("formation_backup"))


def formation_of(ob):
    """The formation `ob` belongs to: itself, the rock under its placement,
    the rock its outline or growth belongs to, or the rock one of its source
    slabs is (so the slabs' tools stay at hand while they are edited)."""
    if ob is None or is_formation(ob):
        return ob
    if is_formation(ob.parent) and any(c.name == ob.parent.get("formation_sources") for c in ob.users_collection):
        return ob.parent
    rid =ob.get("formation_root") or ob.get("formation_outline_owner") or ob.get("formation_growth_owner")
    if not rid:
        return None
    # A duplicate shares its original's id until Make Unique: try the
    # parent and children first, so the placement or outline clicked decides.
    near = [c for c in ob.children if is_formation(c)] + ([ob.parent] if is_formation(ob.parent) else [])
    return next((r for r in near + formations() if r["formation_id"] == rid), None)


def formations(scene=None):
    scene = scene or bpy.context.scene
    return sorted((ob for ob in scene.objects if is_formation(ob)), key=lambda ob: ob.name)


def mesh_hash(mesh):
    h = hashlib.sha256()
    for v in mesh.vertices:
        h.update(("%0.9g,%0.9g,%0.9g;" % tuple(v.co)).encode())
    for p in mesh.polygons:
        h.update(str(tuple(p.vertices)).encode())
    return h.hexdigest()


def seal(ob):
    ob["formation_mesh_hash"] = mesh_hash(ob.data)


def authored_world(ob):
    """World matrix from the authored transforms. A hidden collection's objects
    get no evaluated `matrix_world`, and the helpers all live in one."""
    local = ob.matrix_basis.copy()
    if ob.parent:
        return authored_world(ob.parent) @ ob.matrix_parent_inverse @ local
    return local


def set_authored_world(ob, matrix):
    if ob.parent:
        ob.matrix_basis = ob.matrix_parent_inverse.inverted() @ authored_world(ob.parent).inverted() @ matrix
    else:
        ob.matrix_basis = matrix


def placement(ob):
    return ob.parent or ob


def datablocks():
    return {item for prop in bpy.data.bl_rna.properties if prop.type == "COLLECTION"
            for item in getattr(bpy.data, prop.identifier) if isinstance(item, bpy.types.ID)}


def validate_polygon(points):
    """A simple polygon: at least three finite points, no zero-length edge, no
    zero area, no edge crossing or touching another."""
    if len(points) < 3 or any(not math.isfinite(n) for p in points for n in p):
        raise ValueError("A polygon needs at least three finite points")
    edges = list(zip(points, points[1:] + points[:1]))
    if any(math.dist(a, b) < 1e-6 for a, b in edges):
        raise ValueError("Remove duplicate neighbouring points")
    if abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in edges)) < 1e-8:
        raise ValueError("Polygon has zero area")

    def cross(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    def on_segment(a, b, p):
        return (abs(cross(a, b, p)) < 1e-8
                and min(a[0], b[0]) - 1e-8 <= p[0] <= max(a[0], b[0]) + 1e-8
                and min(a[1], b[1]) - 1e-8 <= p[1] <= max(a[1], b[1]) + 1e-8)

    for i, (a, b) in enumerate(edges):
        for j, (c, d) in enumerate(edges):
            if j <= i + 1 or (i == 0 and j == len(edges) - 1):
                continue
            if ((cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0)
                    or on_segment(a, b, c) or on_segment(a, b, d)
                    or on_segment(c, d, a) or on_segment(c, d, b)):
                raise ValueError("Polygon crosses or touches itself")


def validate_worker(ob, slabs):
    """What a generator run has to have produced before it may replace
    anything: a finite, watertight, non-degenerate mesh, its recipe, and the
    source slabs it was assembled from."""
    if not ob or ob.type != "MESH" or not slabs:
        raise ValueError("Worker file has no complete rock")
    mesh = ob.data
    if not mesh.vertices or not mesh.polygons or any(not math.isfinite(n) for v in mesh.vertices for n in v.co):
        raise ValueError("Worker rock mesh must have finite vertices and faces")
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        volume = abs(bm.calc_volume(signed=True))
        if any(not e.is_manifold for e in bm.edges) or any(not v.link_faces for v in bm.verts):
            raise ValueError("Worker rock mesh must be watertight")
        if not math.isfinite(volume) or volume <= 1e-12 or any(f.calc_area() <= 1e-12 for f in bm.faces):
            raise ValueError("Worker rock mesh must have nonzero volume and faces")
    finally:
        bm.free()
    try:
        recipe = json.loads(ob["formation_recipe"])
        if recipe.get("generator") == "solid":
            guide = recipe["guide"]
            if not guide["verts"] or not guide["faces"] or not isinstance(recipe["params"], dict):
                raise ValueError()
            if not any(s.type == "MESH" and len(s.data.polygons) for s in slabs.objects):
                raise ValueError()
            return recipe
        outline, params = recipe["outline"], recipe["params"]
        if not isinstance(outline, list) or not isinstance(params, dict) or not isinstance(recipe["preset"], str):
            raise ValueError()
        validate_polygon(outline)
        depth = params["depth"]
        if not isinstance(depth, (int, float)) or not math.isfinite(depth) or depth <= 0:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise ValueError("Worker file has no valid rock recipe") from None
    if not any(s.type == "MESH" and len(s.data.polygons) for s in slabs.objects):
        raise ValueError("Worker file has no source slabs")
    return recipe


def outline_object(outline, name, owner):
    """An outline formation's guide: a closed poly curve in the rock's local
    X/Z plane, parented to the rock so it moves with it."""
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    line = curve.splines.new("POLY")
    line.points.add(len(outline) - 1)
    for pt, (x, z) in zip(line.points, outline):
        pt.co = (x, 0, z, 1)
    line.use_cyclic_u = True
    ob = bpy.data.objects.new(name, curve)
    helper_collection(RECIPES).objects.link(ob)
    ob.parent = owner
    ob.matrix_parent_inverse = Matrix.Identity(4)
    ob["formation_outline_owner"] = owner["formation_id"]
    style_guide_curve(ob)
    return ob


def is_reference(ob):
    """Whether `ob` only shows something and is never a guide: linked from
    another file (the level's collision outlines are, and a file's own guide
    is its own), or marked REFERENCE."""
    return (ob.library is not None or ob.override_library is not None or bool(ob.get(REFERENCE))
            or any(c.library is not None for c in ob.users_collection))


def is_free_guide(ob):
    """A guide curve no formation owns yet: a copy of a collision outline, or
    any local closed curve the artist drew."""
    return (ob is not None and ob.type == "CURVE" and not is_reference(ob)
            and not ob.get("formation_outline_owner"))


def before_build(scene):
    """Bring every guide edit held elsewhere into the guides (BEFORE_BUILD)."""
    for hook in BEFORE_BUILD:
        hook(scene)


def style_guide_curve(ob):
    """How a guide curve is drawn: a thin tube in its guide colour, in front
    of everything, never rendered. A bare curve is a hairline in the theme's
    wire colour, which a dark scene swallows. The tube is only how it shows:
    the guide is its points."""
    ob.hide_render = True
    ob.display_type = "TEXTURED"
    ob.show_in_front = True
    ob.data.bevel_depth = GUIDE_CURVE_WIDTH / 2
    ob.data.bevel_resolution = 0
    colour_guide(ob)


def guide_styled(ob):
    return (ob.data.bevel_depth == GUIDE_CURVE_WIDTH / 2 and ob.display_type == "TEXTURED"
            and len(ob.data.materials) == 1)


def style_guides():
    """Style every curve guide in the file that is not yet: one saved before
    guide curves drew as tubes (2026-10-08) still draws as a hairline."""
    for name in (RECIPES, GUIDES):
        c = bpy.data.collections.get(name)
        if c is None or c.library is not None:
            continue
        for ob in c.objects:
            if ob.type == "CURVE" and not guide_styled(ob):
                style_guide_curve(ob)


def free_guide(ob, world=None):
    """Make a guide no formation is built from any more (its rock deleted by
    hand) a free guide: out of RECIPES, which Show guides hides, into GUIDES,
    where it always shows, standing at `world` (where it last stood: Blender
    drops a deleted parent's transform from its children)."""
    world = (world or ob.matrix_world).copy()
    ob.pop("formation_outline_owner", None)
    move(ob, guides_collection())
    ob.parent = None
    ob.matrix_world = world
    ob.hide_set(False)
    if ob.type == "CURVE":
        style_guide_curve(ob)
    else:
        colour_guide(ob)


# Every guide's world matrix as last seen while it had its rock, for
# `free_guide` once the rock is deleted.
guide_worlds = {}


@persistent
def free_orphaned_guides(_scene, _depsgraph):
    """Free the guide of a rock deleted by hand as soon as it goes. Runs on
    every depsgraph update, so it touches only RECIPES' own few guides, and
    reads the rest of the file only when one has lost its parent."""
    recipes = bpy.data.collections.get(RECIPES)
    if recipes is None or recipes.library is not None:
        return
    orphans = []
    for ob in recipes.objects:
        if ob.parent is not None:
            guide_worlds[ob.name] = ob.matrix_world.copy()
        else:
            orphans.append(ob)
    if not orphans:
        return
    ids = {ob.get("formation_id") for ob in bpy.data.objects if ob.get("formation_id")}
    for ob in orphans:
        if ob.get("formation_outline_owner") not in ids:
            free_guide(ob, guide_worlds.pop(ob.name, None))


def flatten_guide(ob):
    """Bring a free guide curve to a formation's convention in place: a 3D
    curve whose polygon lies in its local X/Z plane. A flat (2D) curve's X/Y
    becomes X/Z and the object turns a quarter about X, so no point moves in
    the world. Returns its points in that plane."""
    if ob.type != "CURVE" or len(ob.data.splines) != 1:
        raise ValueError("Select a guide: a curve with a single closed polygon")
    sp = ob.data.splines[0]
    if sp.type != "POLY" or not sp.use_cyclic_u:
        raise ValueError("A guide must be a closed POLY curve")
    if ob.data.dimensions == "2D":
        world = authored_world(ob) @ Matrix.Rotation(-math.pi / 2, 4, "X")
        flat = [(p.co.x, p.co.y) for p in sp.points]
        ob.data.dimensions = "3D"
        for pt, (x, z) in zip(sp.points, flat):
            pt.co = (x, 0, z, 1)
        set_authored_world(ob, world)
    if any(abs(p.co.y) > .001 for p in sp.points):
        raise ValueError("Use a flat curve, or a 3D curve in its local X/Z plane")
    return [[p.co.x, p.co.z] for p in sp.points]


def adopt_guide(rock, guide):
    """Make free guide `guide` formation `rock`'s own, in place of the one its
    build made: the rock's placement goes where the guide stands, so nothing
    moves, and an edit made to the guide while the rock built shows as pending."""
    flatten_guide(guide)
    built = bpy.data.objects.get(rock.get("formation_outline", ""))
    root = placement(rock)
    set_authored_world(root, authored_world(guide) @ (authored_world(rock).inverted() @ authored_world(root)))
    move(guide, helper_collection(RECIPES))
    guide.parent = rock
    guide.matrix_parent_inverse = Matrix.Identity(4)
    guide.matrix_basis = Matrix.Identity(4)
    guide["formation_outline_owner"] = rock["formation_id"]
    if built is not None and built != guide:
        data = built.data
        bpy.data.objects.remove(built, do_unlink=True)
        if data.users == 0:
            bpy.data.curves.remove(data)
    guide.name = rock.name + " / guide"
    rock["formation_outline"] = guide.name
    style_guide_curve(guide)
    free = bpy.data.collections.get(GUIDES)
    if free is not None and not free.objects and not free.children:
        bpy.data.collections.remove(free)


def is_solid(ob):
    """Whether formation `ob` is cut from a guide mesh (generator `solid`)."""
    return json.loads(ob["formation_recipe"]).get("generator") == "solid"


def guide_object(guide, name, owner):
    """A solid formation's editable guide: a closed mesh in the rock's frame,
    parented to it, drawn in a colour of its own (`show_guides`)."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in guide["verts"]], [], [tuple(f) for f in guide["faces"]])
    me.validate()
    ob = bpy.data.objects.new(name, me)
    helper_collection(RECIPES).objects.link(ob)
    ob.parent = owner
    ob.matrix_parent_inverse = Matrix.Identity(4)
    ob["formation_outline_owner"] = owner["formation_id"]
    ob.hide_render = True
    colour_guide(ob)
    return ob


def colour_guide(ob):
    """Give a guide its high-visibility colour: a viewport-only material,
    which Solid shading shows (it never renders: guides are hidden in render)."""
    owner = ob.get("formation_outline_owner", ob.name)
    colour = GUIDE_COLOURS[int(hashlib.sha256(owner.encode()).hexdigest(), 16) % len(GUIDE_COLOURS)]
    name = "Formation guide %.2f %.2f %.2f" % colour
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.diffuse_color = (*colour, 1.0)
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    ob.color = (*colour, 1.0)


def show_guides(scene, on):
    """Show every formation's guide (and outline) in the viewport, in its
    colour, or hide them again. Their collection stays hidden in render,
    which the export honours."""
    helper_collection(RECIPES).hide_viewport = not on
    if on:
        for ob in formations(scene):
            guide = bpy.data.objects.get(ob.get("formation_outline", ""))
            if guide is None:
                continue
            if guide.type == "CURVE":
                style_guide_curve(guide)
            else:
                colour_guide(guide)
            guide.hide_set(False)


def rocks_wire(scene, on):
    """Draw the solid formations as wireframe, so their guides show through."""
    for ob in formations(scene):
        if is_solid(ob):
            ob.display_type = "WIRE" if on else "TEXTURED"


def guide_geometry(ob):
    """The guide as it now stands, in the rock's frame: `verts`, `faces`."""
    guide = bpy.data.objects.get(ob.get("formation_outline", ""))
    if guide is None:
        return json.loads(ob["formation_recipe"])["guide"]
    if guide.type != "MESH":
        raise ValueError(ob.name + ": its guide must be a mesh")
    mat = (guide.matrix_parent_inverse @ guide.matrix_basis if guide.parent == ob
           else authored_world(ob).inverted() @ authored_world(guide))
    return {"verts": [[round(c, 6) for c in mat @ v.co] for v in guide.data.vertices],
            "faces": [list(p.vertices) for p in guide.data.polygons]}


def scene_camera(scene=None):
    """The game's start camera and water for solid formations (CAMERA)."""
    scene = scene or bpy.context.scene
    if CAMERA not in scene:
        raise ValueError("No start camera for solid formations: run tools/blender/backdrop.py on this scene once")
    return json.loads(scene[CAMERA])


def append_rock(file, name):
    """Bring a worker's rock into the scene as a new formation under its own
    placement, at the world origin."""
    before = datablocks()
    try:
        with bpy.data.libraries.load(str(file), link=False) as (_, dst):
            dst.objects = ["SceneryRock"]
            dst.collections = ["SOURCE_SLABS"]
        ob, slabs = dst.objects[0], dst.collections[0]
        recipe = validate_worker(ob, slabs)
        col = collection(FORMATIONS)
        col.objects.link(ob)
        root = bpy.data.objects.new(name + " / placement", None)
        col.objects.link(root)
        root.empty_display_type = "PLAIN_AXES"
        root.empty_display_size = .2
        ob.parent = root
        ob.matrix_parent_inverse = Matrix.Identity(4)
        ob.name = name
        rid = str(uuid.uuid4())
        ob["formation_id"] = rid
        ob["formation_mode"] = "PROCEDURAL"
        root["formation_root"] = rid
        slabs.name = "Sources / " + name + " / " + rid[:8]
        helper_collection(RECIPES).children.link(slabs)
        slabs.hide_render = True
        slabs.hide_viewport = True
        for s in slabs.objects:
            s.parent = ob
            s.matrix_parent_inverse = Matrix.Identity(4)
        ob["formation_sources"] = slabs.name
        if recipe.get("generator") == "solid":
            ob["formation_outline"] = guide_object(recipe["guide"], name + " / guide", ob).name
        else:
            ob["formation_outline"] = outline_object(recipe["outline"], name + " / guide", ob).name
        params.load(ob)
        seal(ob)
        return ob
    except Exception:
        imported = datablocks() - before
        if imported:
            bpy.data.batch_remove(ids=imported)
        raise


def copy_recipe_helpers(source, target):
    """Copy the outline and source slabs into `target`'s frame, including any
    edits made to them."""
    relative = authored_world(source).inverted()

    def local_for(helper):
        # A moved linked duplicate still refers to the original rock's helpers.
        if helper.parent and "formation_recipe" in helper.parent:
            return helper.matrix_parent_inverse @ helper.matrix_basis
        return relative @ authored_world(helper)

    src = bpy.data.collections.get(source.get("formation_sources", ""))
    if src:
        copies = bpy.data.collections.new("Sources / " + target.name + " / " + target["formation_id"][:8])
        helper_collection(RECIPES).children.link(copies)
        copies.hide_viewport = True
        copies.hide_render = True
        for s in src.objects:
            local = local_for(s)
            n = s.copy()
            n.data = s.data.copy()
            copies.objects.link(n)
            n.parent = target
            n.matrix_parent_inverse = Matrix.Identity(4)
            n.matrix_basis = local
        target["formation_sources"] = copies.name
    guide = bpy.data.objects.get(source.get("formation_outline", ""))
    if guide:
        local = local_for(guide)
        n = guide.copy()
        n.data = guide.data.copy()
        helper_collection(RECIPES).objects.link(n)
        n.parent = target
        n.matrix_parent_inverse = Matrix.Identity(4)
        n.matrix_basis = local
        n["formation_outline_owner"] = target["formation_id"]
        target["formation_outline"] = n.name


def make_unique(ob):
    """Give a duplicated formation its own mesh, id, outline and slabs."""
    if not is_formation(ob):
        raise ValueError("Select a formation")
    edited = mesh_hash(ob.data) != ob.get("formation_mesh_hash")
    ob.data = ob.data.copy()
    ob["formation_id"] = str(uuid.uuid4())
    if ob.parent is not None:
        ob.parent["formation_root"] = ob["formation_id"]
    copy_recipe_helpers(ob, ob)
    # Making data unique is not a reason to treat a hand-edited mesh as generated.
    if edited:
        ob["formation_mode"] = "MANUAL"
    seal(ob)


def outline_points(ob):
    """The outline as it now stands, in the rock's X/Z plane."""
    guide = bpy.data.objects.get(ob.get("formation_outline", ""))
    if guide is None:
        return json.loads(ob["formation_recipe"])["outline"]
    if guide.type != "CURVE" or len(guide.data.splines) != 1:
        raise ValueError(ob.name + ": its guide must be one closed polygon")
    spline = guide.data.splines[0]
    if spline.type != "POLY" or not spline.use_cyclic_u:
        raise ValueError(ob.name + ": its guide must be a closed poly curve")
    mat = (guide.matrix_parent_inverse @ guide.matrix_basis if guide.parent == ob
           else authored_world(ob).inverted() @ authored_world(guide))
    coords = [mat @ Vector(p.co[:3]) for p in spline.points]
    if max(abs(p.y) for p in coords) > .001:
        raise ValueError(ob.name + ": keep its guide in the rock's X/Z plane")
    return [[p.x, p.z] for p in coords]


def recipe_for(ob):
    """The recipe a rebuild would run: the built one with the current outline
    and parameters."""
    recipe = json.loads(ob["formation_recipe"])
    if recipe.get("generator") == "solid":
        recipe["guide"] = guide_geometry(ob)
        recipe["camera"] = scene_camera()
        recipe["frame"] = [list(r) for r in authored_world(ob)]
        recipe.pop("generatorHash", None)
    else:
        recipe["outline"] = outline_points(ob)
    recipe["generator"], recipe["params"] = params.current(ob)
    return recipe


def write_outline(ob, outline):
    """Replace a formation's outline with `outline` (rock-local X/Z)."""
    validate_polygon(outline)
    guide = bpy.data.objects.get(ob.get("formation_outline", ""))
    if guide is None:
        ob["formation_outline"] = outline_object(outline, ob.name + " / guide", ob).name
        return
    guide.parent = ob
    guide.matrix_parent_inverse.identity()
    guide.matrix_basis.identity()
    guide.data.splines.clear()
    spline = guide.data.splines.new("POLY")
    spline.points.add(len(outline) - 1)
    for pt, (x, z) in zip(spline.points, outline):
        pt.co = (x, 0, z, 1)
    spline.use_cyclic_u = True


def pending(ob):
    """Whether the outline (or guide, camera and frame) or the parameters
    differ from the ones the mesh was built from."""
    if is_solid(ob):
        built = json.loads(ob["formation_recipe"])
        now = recipe_for(ob)
        same = (now["guide"] == built["guide"] and now["camera"] == built["camera"]
                and all(math.isclose(a, b, abs_tol=1e-5) for ra, rb in zip(now["frame"], built["frame"])
                        for a, b in zip(ra, rb)))
        return bool(ob.get("formation_new")) or not same or params.changed(ob)
    current = outline_points(ob)
    built = json.loads(ob["formation_recipe"])["outline"]
    return bool(ob.get("formation_new")) or len(current) != len(built) or any(
        math.dist(a, b) > 1e-5 for a, b in zip(current, built)) or params.changed(ob)


def assert_rebuildable(ob):
    if not is_formation(ob):
        raise ValueError("Select a formation")
    if ob.get("formation_mode") == "MANUAL":
        raise ValueError(ob.name + ": manual mesh protected; rebuild as a new variant")
    if mesh_hash(ob.data) != ob.get("formation_mesh_hash"):
        raise ValueError(ob.name + ": mesh has hand edits; keep it as manual or rebuild as a new variant")
    if ob.data.shape_keys or ob.vertex_groups or any(
            m.type in {"MULTIRES", "HOOK", "SURFACE_DEFORM", "MESH_DEFORM"} for m in ob.modifiers):
        raise ValueError(ob.name + ": topology-dependent edits; rebuild as a new variant")


def backup(ob):
    old = ob.copy()
    old.data = ob.data.copy()
    old.name = ob.name + " / previous"
    helper_collection(BACKUPS).objects.link(old)
    old["formation_id"] = str(uuid.uuid4())
    old["formation_backup"] = True
    copy_recipe_helpers(ob, old)
    stow_helpers()
    return old


def stow_helpers():
    """Move every helper in RECIPES that no formation in the scene uses - a
    backup's outline and slabs, or the slabs of a rock deleted by hand - into
    BACKUPS, hidden. Kept rather than removed, as the backup itself is. The
    guide of a rock deleted by hand belongs to nothing, so it is freed
    instead (`free_guide`), as `free_orphaned_guides` does the moment the
    rock goes. Idempotent, and run on every file load to tidy files saved
    before it."""
    recipes = bpy.data.collections.get(RECIPES)
    if recipes is None or recipes.library is not None:
        return 0
    live = [ob for ob in bpy.data.objects if is_formation(ob)]
    outlines = {ob.get("formation_outline") for ob in live}
    sources = {ob.get("formation_sources") for ob in live}
    ids = {ob.get("formation_id") for ob in bpy.data.objects if ob.get("formation_id")}
    stale = [ob for ob in recipes.objects if ob.name not in outlines]
    orphans = [ob for ob in stale if ob.get("formation_outline_owner") not in ids]
    for ob in orphans:
        free_guide(ob)
    stale = [ob for ob in stale if ob not in orphans]
    slabs = [c for c in recipes.children if c.name.startswith("Sources /") and c.name not in sources]
    if not stale and not slabs:
        return len(orphans)
    backups = helper_collection(BACKUPS)
    for ob in stale:
        recipes.objects.unlink(ob)
        if ob.name not in backups.objects:
            backups.objects.link(ob)
    for c in slabs:
        recipes.children.unlink(c)
        if c.name not in backups.children:
            backups.children.link(c)
    return len(orphans) + len(stale) + len(slabs)


def remove_unused_helpers(sources_name, guide_name):
    if not any(o.get("formation_sources") == sources_name for o in bpy.data.objects):
        sources = bpy.data.collections.get(sources_name)
        if sources:
            for item in list(sources.objects):
                data = item.data
                bpy.data.objects.remove(item, do_unlink=True)
                if data and data.users == 0:
                    bpy.data.batch_remove(ids=[data])
            bpy.data.collections.remove(sources)
    if not any(o.get("formation_outline") == guide_name for o in bpy.data.objects):
        guide = bpy.data.objects.get(guide_name)
        if guide:
            data = guide.data
            bpy.data.objects.remove(guide, do_unlink=True)
            if data and data.users == 0:
                bpy.data.batch_remove(ids=[data])


def remove_formation(ob):
    """Delete a formation, its placement (if nothing else hangs from it), its
    helpers and the growth that belongs to it."""
    root = ob.parent
    rid = ob.get("formation_id")
    for other in list(bpy.data.objects):
        if rid and other.get("formation_growth_owner") == rid:
            bpy.data.objects.remove(other, do_unlink=True)
    guide, sources, data = ob.get("formation_outline", ""), ob.get("formation_sources", ""), ob.data
    bpy.data.objects.remove(ob, do_unlink=True)
    if root is not None and not root.children:
        bpy.data.objects.remove(root, do_unlink=True)
    if data.users == 0:
        bpy.data.meshes.remove(data)
    remove_unused_helpers(sources, guide)


def replace_from_worker(ob, file, variant=False):
    """Swap a worker's mesh into `ob` (its materials, placement, name and id
    kept), backing the old mesh up; or, as a variant, add it beside `ob`."""
    if not variant:
        assert_rebuildable(ob)
    fresh = append_rock(file, ob.name + " / new")
    if variant:
        fresh.parent.matrix_world = authored_world(placement(ob)).copy()
        fresh.matrix_basis = ob.matrix_basis.copy() if ob.parent else Matrix.Identity(4)
        for i, mat in enumerate(ob.data.materials):
            if i < len(fresh.data.materials):
                fresh.data.materials[i] = mat
        return fresh
    backup(ob)
    previous_sources, previous_guide = ob.get("formation_sources", ""), ob.get("formation_outline", "")
    old_mesh = ob.data
    ob.data = fresh.data
    ob["formation_recipe"] = fresh["formation_recipe"]
    ob["formation_mode"] = "PROCEDURAL"
    ob.pop("formation_new", None)
    # Keep the artist's materials slot for slot; a solid rock's slate is
    # scaled to its depth, which the rebuild may have changed, so it keeps
    # the fresh one (and its scale).
    if is_solid(ob):
        ob[render.DEPTH_SCALE] = fresh.get(render.DEPTH_SCALE, 1.0)
        # A detail scale set by hand outlives the rebuild.
        render.repaint_scale(ob)
    else:
        for i, mat in enumerate(old_mesh.materials):
            if i < len(ob.data.materials):
                ob.data.materials[i] = mat
    sources = bpy.data.collections[fresh["formation_sources"]]
    for s in sources.objects:
        s.parent = ob
        s.matrix_parent_inverse = Matrix.Identity(4)
    ob["formation_sources"] = sources.name
    guide = bpy.data.objects[fresh["formation_outline"]]
    guide.parent = ob
    guide.matrix_parent_inverse = Matrix.Identity(4)
    guide["formation_outline_owner"] = ob["formation_id"]
    ob["formation_outline"] = guide.name
    root = fresh.parent
    bpy.data.objects.remove(fresh, do_unlink=True)
    bpy.data.objects.remove(root, do_unlink=True)
    remove_unused_helpers(previous_sources, previous_guide)
    # The fresh one was named for "<name> / new"; the old one has gone.
    guide.name = ob.name + " / guide"
    ob["formation_outline"] = guide.name
    seal(ob)
    return ob


def assemble_sources(ob):
    """Join the (hand-edited) source slabs into the formation's mesh, without
    rerunning the generator. The result is a manual mesh."""
    src = bpy.data.collections.get(ob.get("formation_sources", ""))
    if not src:
        raise ValueError("No source slabs found")
    scratch = collection("Formation scratch")
    copies = []
    active = bpy.context.view_layer.objects.active
    try:
        for s in src.objects:
            if s.type != "MESH":
                continue
            n = s.copy()
            n.data = s.data.copy()
            scratch.objects.link(n)
            n.parent = None
            n.matrix_world = authored_world(ob).inverted() @ authored_world(s)
            copies.append(n)
        if not copies:
            raise ValueError("Source collection is empty")
        base = copies[0]
        bpy.context.view_layer.update()
        bpy.context.view_layer.objects.active = base
        for n in copies[1:]:
            mod = base.modifiers.new("Assemble edited slab", "BOOLEAN")
            mod.operation = "UNION"
            mod.solver = "EXACT"
            mod.object = n
            bpy.ops.object.modifier_apply(modifier=mod.name)
        if not len(base.data.polygons):
            raise ValueError("Assembly produced no faces")
        backup(ob)
        ob.data = base.data.copy()
        ob.data.transform(authored_world(base))
        ob["formation_mode"] = "MANUAL"
        seal(ob)
    finally:
        for n in copies:
            bpy.data.objects.remove(n, do_unlink=True)
        bpy.data.collections.remove(scratch)
        bpy.context.view_layer.objects.active = active


# --- The generator, in its own processes -------------------------------------

def python_path():
    """Ordinary Python with the generator's packages (`bun run
    generators:setup` installs them into rope/.venv)."""
    preferred = os.environ.get("FORMATIONS_PYTHON")
    if preferred and Path(preferred).is_file():
        return preferred
    for candidate in (ROPE / ".venv/bin/python", ROPE / ".venv/Scripts/python.exe"):
        if candidate.is_file():
            return str(candidate)
    found = shutil.which("python3") or shutil.which("python")
    if found:
        return found
    raise ValueError("No Python with numpy, scipy and shapely: run `bun run generators:setup` in rope/")


def launch_worker(recipe):
    """Start one rock build. Returns the process, its output directory and the
    open log; the rock lands in `<out>/rock.blend`."""
    out = Path(tempfile.mkdtemp(prefix="formation-"))
    (out / "input.json").write_text(json.dumps(recipe))
    log = open(out / "worker.log", "w", encoding="utf-8")
    command = [python_path(), str(HERE / "worker.py"), str(out / "input.json"), str(out),
               "--blender", bpy.app.binary_path]
    proc = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    return proc, out, log


def worker_failure(output):
    path = Path(output) / "worker.log"
    details = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
    if "MemoryError" in details or "out of memory" in details.lower():
        return "Rock generation ran out of memory; existing meshes kept."
    return "Generation failed; meshes kept. See " + str(path)
