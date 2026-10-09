"""The scene export's bake cache (docs/blender-scenes.md, "The bake cache").

Baking is most of an export (the river, 2026-10-04: Cycles 100 of 163 s), and
an edit usually touches one or two objects. So every baked object's final
maps (its "baked colour" and "baked normal" images, as the glTF gets them) are
kept under a key of everything that decides their pixels, and an object whose
key is unchanged loads them instead of baking:

- the bake code: the part of scene_export.py the bake reaches and the
  formations modules it imports (the detail high poly, the slate, the curved
  creases), as code - comments, docstrings and layout left out - and
  Blender's version;
- the scene's Cycles settings that a bake reads (not the viewport's, nor
  denoising, which a bake never runs) and its bake settings;
- the object's prepared mesh as the bake sees it (modifiers applied, the
  creases rebuilt and still straight, every attribute, the bake unwrap), its
  world transform, its detail seed and its map size;
- every node tree of its materials, slot by slot, node groups and images
  (by their pixels) included;
- every triangle of the rest of the scene within reach of its Ambient
  Occlusion nodes: the slate's 0.5 m occlusion darkens where another rock
  comes close, so a neighbour's edit within that reach must re-bake it.
  Only what the render shows counts: an object hidden in render (the guides)
  never meets the bake's rays.

Everything is taken by content, never by name or by place in the file: the
export copies each object's materials, and Blender numbers a copy after
every material in the file (`Painted slate.058`), so a key that held those
names re-baked every rock whenever a rebuild anywhere added a material
(2026-10-07). Likewise a neighbour counts only by its triangles near the
object, not as a whole, so a far edit to a long Terrace leaves its other
neighbours' maps alone.

What decides a pixel is in the key, and nothing else: a missed input ships a
stale map without a word, an extra one costs a bake. `--no-cache` on the
export bakes everything afresh.

`--stale-occlusion` on the export trades the last of those for time: the key
is in two parts, the object's own and its neighbours', and an object whose
own part is unchanged loads its last bake whatever its neighbours did, its
colour map darkened by where they stood then. It ships stale maps on
purpose, so the export names every object it loaded that way, and the entry
keeps its old key: the next export without the flag re-bakes it.

An entry is a directory named by the key with each map as the PNG the export
packed (named as the image is, since the glTF exporter may name an image by
its file) and a meta.json; entries the latest export did not use are removed,
so the cache holds one export's maps per scene.
"""

import ast
import hashlib
import json
import os
import shutil

import bpy
import numpy as np
from mathutils.bvhtree import BVHTree

# Bumped when an entry's layout changes.
VERSION = 2
HERE = os.path.dirname(os.path.abspath(__file__))
# An entry's prepared mesh, a .blend holding only it.
MESH_FILE = "mesh.blend"
# Where the bake's code starts in scene_export.py: the definitions it reaches
# from here are the bake's.
BAKE_ROOT = "bake_procedural_textures"
# Calls that only report (scene_export's log line and progress step), and the
# functions a report may call and still change nothing: an edit to what an
# export says re-bakes nothing.
REPORTS = {"log", "step", "print"}
PURE = {
    "len", "sum", "min", "max", "round", "abs", "str", "repr", "int", "float", "bool", "sorted", "list",
    "tuple", "set", "dict", "any", "all", "enumerate", "range", "zip", "isinstance", "join", "format",
    "time", "perf_counter", "items", "keys", "values", "dumps",
}
# Cycles settings a bake never reads: the viewport's, and denoising, which
# Cycles does not run on a bake.
VIEWPORT_CYCLES = ("preview_", "use_preview_", "volume_preview_", "denoising_", "debug_")
VIEWPORT_CYCLES_NAMES = {"use_denoising", "denoiser", "texture_resolution", "texture_limit", "ao_bounces"}
# A neighbour's triangle counts at this precision, metres, so a transform
# recomputed to the same place does not read as an edit.
NEAR_QUANTUM = 1e-5
# Node and socket properties that change how a tree looks in the editor, never
# what it computes.
SKIP = {
    "rna_type", "name", "label", "location", "location_absolute", "width", "height", "dimensions",
    "select", "show_options", "show_preview", "show_texture", "show_expanded", "hide", "parent",
    "color", "use_custom_color", "color_tag", "warning_propagation", "inputs", "outputs",
    "internal_links", "bl_idname", "bl_label", "bl_description", "bl_icon", "bl_static_type",
    "bl_width_default", "bl_width_min", "bl_width_max", "bl_height_default", "bl_height_min",
    "bl_height_max", "id_data", "users", "is_runtime_data", "tag", "is_evaluated", "original",
    "session_uid", "is_missing", "is_embedded_data", "is_editmode", "use_fake_user", "use_extra_user",
    "preview", "library", "library_weak_reference", "override_library", "asset_data",
}
# Mesh attributes that are only selection and visibility in the editor.
EDITOR_ATTRIBUTE = (".select", ".hide")
# How a mesh attribute's values are read, by data type: (field, width).
ATTRIBUTE_FIELD = {
    "FLOAT": ("value", 1), "INT": ("value", 1), "BOOLEAN": ("value", 1), "INT8": ("value", 1),
    "FLOAT_VECTOR": ("vector", 3), "FLOAT2": ("vector", 2), "INT32_2D": ("value", 2),
    "FLOAT_COLOR": ("color", 4), "BYTE_COLOR": ("color", 4), "QUATERNION": ("value", 4),
    "FLOAT4X4": ("value", 16),
}
GEOMETRY = {"MESH", "CURVE", "SURFACE", "FONT", "META"}
# What Cycles draws without triangles to read: near an object, each counts
# whole (its data and transform), by its bounding box.
WHOLE = {"CURVES", "POINTCLOUD", "VOLUME"}


def _put(h, *parts):
    for p in parts:
        h.update(repr(p).encode())
        h.update(b"\0")


def _array(h, data, field, n, dtype):
    a = np.empty(len(data) * n, dtype=dtype)
    data.foreach_get(field, a)
    h.update(a.tobytes())


def mesh_digest(h, me):
    """Topology and every attribute (positions, UVs, normals, the slate's
    `facet` and `strip`, which slot each face takes), selection and hiding
    left out. The slots' materials are the key's, by content."""
    _put(h, len(me.vertices), len(me.edges), len(me.loops), len(me.polygons))
    _array(h, me.polygons, "loop_start", 1, np.int32)
    _array(h, me.loops, "vertex_index", 1, np.int32)
    _array(h, me.edges, "vertices", 2, np.int32)
    attributes_digest(h, me.attributes)
    _put(h, len(me.materials))


def attributes_digest(h, attributes):
    """Every attribute of a mesh, curves or point cloud, selection and
    hiding left out."""
    for name in sorted(a.name for a in attributes):
        if name.startswith(EDITOR_ATTRIBUTE):
            continue
        attr = attributes[name]
        _put(h, name, attr.domain, attr.data_type)
        field, n = ATTRIBUTE_FIELD.get(attr.data_type, (None, 0))
        try:
            if attr.data_type in ("BOOLEAN",):
                _array(h, attr.data, field, n, bool)
            elif attr.data_type in ("INT", "INT8", "INT32_2D"):
                _array(h, attr.data, field, n, np.int32)
            elif field:
                _array(h, attr.data, field, n, np.float32)
            else:
                raise TypeError(attr.data_type)
        except (TypeError, RuntimeError):
            _put(h, [repr(getattr(d, "value", d)) for d in attr.data])


_file_digests = {}


def file_digest(path):
    """A file's content hash, read once per export."""
    if path not in _file_digests:
        try:
            with open(path, "rb") as f:
                _file_digests[path] = hashlib.file_digest(f, "sha256").digest()
        except OSError:
            _file_digests[path] = b"missing"
    return _file_digests[path]


def image_digest(h, im):
    """An image by its pixels' source: the packed or on-disk file's content
    (not its name, path or date), or a generated image's settings."""
    _put(h, "image", im.source, tuple(im.size), im.colorspace_settings.name, im.alpha_mode)
    if im.packed_file is not None:
        h.update(hashlib.sha256(im.packed_file.data).digest())
    elif im.source in ("FILE", "SEQUENCE", "TILED"):
        _put(h, im.filepath if im.source != "FILE" else None)
        h.update(file_digest(os.path.realpath(bpy.path.abspath(im.filepath, library=im.library))))
    elif im.source == "GENERATED":
        _put(h, im.generated_type, tuple(im.generated_color), im.generated_width, im.generated_height)


def rna_digest(h, s, depth, seen):
    """Every value property of `s`, pointers followed `depth` deep: images and
    node trees by content, other datablocks by name."""
    for p in s.bl_rna.properties:
        k = p.identifier
        if k in SKIP:
            continue
        try:
            v = getattr(s, k)
        except (AttributeError, RuntimeError):
            continue
        if p.type in {"BOOLEAN", "INT", "FLOAT", "STRING", "ENUM"}:
            if isinstance(v, set):
                v = sorted(v)
            elif hasattr(v, "__len__") and not isinstance(v, str):
                v = tuple(v)
            _put(h, k, v)
        elif p.type == "POINTER":
            if v is None:
                _put(h, k, None)
            elif isinstance(v, bpy.types.Image):
                _put(h, k)
                image_digest(h, v)
            elif isinstance(v, bpy.types.NodeTree):
                _put(h, k)
                tree_digest(h, v, seen)
            elif isinstance(v, bpy.types.ID):
                _put(h, k, type(v).__name__, v.name)
            elif depth > 0:
                _put(h, k)
                rna_digest(h, v, depth - 1, seen)
        elif p.type == "COLLECTION" and depth > 0:
            _put(h, k, len(v))
            for item in v:
                rna_digest(h, item, depth - 1, seen)


def tree_digest(h, nt, seen):
    """A node tree: every node's settings and unlinked inputs, and the links.
    A tree is hashed once however often it is used, `seen` holding its
    digest by identity: by name, every material's own tree is "Shader
    Nodetree", and a second slot's was taken for the first's, never hashed."""
    ptr = nt.as_pointer()
    if ptr not in seen:
        seen[ptr] = b"cycle"
        t = hashlib.sha256()
        for node in sorted(nt.nodes, key=lambda n: n.name):
            _put(t, "node", node.bl_idname, node.name, node.mute)
            rna_digest(t, node, 2, seen)
            for sock in node.inputs:
                _put(t, "in", sock.identifier, sock.is_linked, sock.enabled)
                if not sock.is_linked and hasattr(sock, "default_value"):
                    v = sock.default_value
                    _put(t, tuple(v) if hasattr(v, "__len__") and not isinstance(v, str) else v)
        _put(t, sorted((l.from_node.name, l.from_socket.identifier, l.to_node.name, l.to_socket.identifier, l.is_muted)
                       for l in nt.links))
        for item in getattr(getattr(nt, "interface", None), "items_tree", ()):
            rna_digest(t, item, 0, seen)
        seen[ptr] = t.digest()
    h.update(seen[ptr])


def _says_only(stmt):
    """Whether `stmt` is a report and nothing else: a call of one of
    REPORTS whose arguments call only PURE functions, so dropping it changes
    nothing the export does."""
    if not (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call)
            and isinstance(stmt.value.func, ast.Name) and stmt.value.func.id in REPORTS):
        return False
    for node in ast.walk(stmt.value):
        if node is stmt.value or not isinstance(node, ast.Call):
            continue
        f = node.func
        name = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else None
        if name not in PURE:
            return False
    return True


def _parse(path):
    """A module as Python runs it: its syntax tree, docstrings and reports
    (`_says_only`) dropped; comments and layout never reach the tree."""
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read())
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
                    and isinstance(body[0].value.value, str):
                body = body[1:]
            node.body = body or [ast.Pass()]
        for field in ("body", "orelse", "finalbody"):
            stmts = getattr(node, field, None)
            if isinstance(stmts, list) and stmts and isinstance(stmts[0], ast.stmt):
                kept = [s for s in stmts if not _says_only(s)]
                setattr(node, field, kept or [ast.Pass()])
    return tree


def _defines(stmt):
    """The names a module-level statement binds (inside a block, an `if` or
    a `try`, too)."""
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return {stmt.name}
    if isinstance(stmt, (ast.Import, ast.ImportFrom)):
        return {(a.asname or a.name).split(".")[0] for a in stmt.names}
    out = set()
    for n in ast.walk(stmt):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
            out.add(n.id)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(n.name)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            out |= {(a.asname or a.name).split(".")[0] for a in n.names}
    return out


def _formations_imports(tree, inside):
    """The formations modules `tree` imports (`inside` the package, its
    relative imports too)."""
    out = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom):
            if n.module == "formations" or (inside and n.level == 1 and n.module is None):
                out |= {a.name for a in n.names}
            elif n.module and n.module.startswith("formations."):
                out.add(n.module.split(".")[1])
            elif inside and n.level == 1:
                out.add(n.module.split(".")[0])
        elif isinstance(n, ast.Import):
            for a in n.names:
                parts = a.name.split(".")
                if parts[0] == "formations":
                    out.add(parts[1] if len(parts) > 1 else "__init__")
    return {m for m in out if os.path.isfile(os.path.join(HERE, "formations", f"{m}.py"))}


def code_digest():
    """The bake's code: the module-level definitions of scene_export.py that
    BAKE_ROOT reaches by name, and every formations module they import, and
    those import, whole. Each as its syntax tree, so a comment, a docstring
    or a reflow re-bakes nothing; nor does an edit to the export's other
    steps (the glTF, the growth, the progress lines). This file is not in it:
    it decides which maps are used, never their pixels."""
    h = hashlib.sha256()
    _put(h, VERSION, bpy.app.version_string)
    tree = _parse(os.path.join(HERE, "scene_export.py"))
    defs = {}
    for stmt in tree.body:
        for name in _defines(stmt):
            defs.setdefault(name, []).append(stmt)
    reached, names, todo = set(), set(), [BAKE_ROOT]
    while todo:
        name = todo.pop()
        if name in names:
            continue
        names.add(name)
        for stmt in defs.get(name, ()):
            if id(stmt) not in reached:
                reached.add(id(stmt))
                todo.extend(n.id for n in ast.walk(stmt) if isinstance(n, ast.Name))
    if BAKE_ROOT not in defs:
        raise RuntimeError(f"scene_export.py has no {BAKE_ROOT}: bake_cache.BAKE_ROOT names where the bake starts")
    code = [stmt for stmt in tree.body if id(stmt) in reached]
    _put(h, "scene_export.py", [ast.dump(stmt) for stmt in code])
    modules = set().union(*(_formations_imports(stmt, False) for stmt in code))
    done = set()
    while modules - done:
        name = min(modules - done)
        done.add(name)
        module = _parse(os.path.join(HERE, "formations", f"{name}.py"))
        _put(h, f"formations/{name}.py", ast.dump(module))
        modules |= _formations_imports(module, True)
    return h.hexdigest()


def rendered_collections(view_layer):
    """The collections whose objects a render shows: reached from the scene's
    through collections neither hidden in render nor excluded from
    `view_layer`. A collection reached on several paths shows if any does."""
    out = set()

    def walk(layer_coll):
        coll = layer_coll.collection
        if layer_coll.exclude or coll.hide_render or coll in out:
            return
        out.add(coll)
        for child in layer_coll.children:
            walk(child)

    walk(view_layer.layer_collection)
    return out


def rendered(inst, shown):
    """Whether the bake's rays can meet `inst` at all. Cycles leaves out what
    is hidden in render, so a hidden object (a level's guides: its plane, its
    collision outlines) never darkens a map, and counting its triangles near
    a rock only re-bakes the rock whenever the guide is edited (2026-10-08).
    An instance shows when what it instances is not hidden and its instancer
    is shown; anything else, when it is not hidden, sits in a shown
    collection and, if it instances, draws itself in render."""
    ob = inst.object.original
    if ob.hide_render:
        return False
    if inst.is_instance:
        return rendered_object(inst.parent.original, shown)
    return rendered_object(ob, shown) and (not ob.is_instancer or ob.show_instancer_for_render)


def rendered_object(ob, shown):
    return not ob.hide_render and any(c in shown for c in ob.users_collection)


def ao_reach(materials):
    """How far the Ambient Occlusion nodes of `materials` look, metres: 0
    without any, infinite where a distance is driven by a link."""
    reach, seen = 0.0, set()

    def walk(nt):
        nonlocal reach
        if nt.as_pointer() in seen:
            return
        seen.add(nt.as_pointer())
        for node in nt.nodes:
            if node.type == "AMBIENT_OCCLUSION" and not node.only_local:
                d = node.inputs["Distance"]
                reach = max(reach, float("inf") if d.is_linked else d.default_value)
            if node.type == "GROUP" and node.node_tree:
                walk(node.node_tree)

    for mat in materials:
        if mat and mat.node_tree:
            walk(mat.node_tree)
    return reach


class Cache:
    """One scene's bake cache under `root`, keyed on the scene as `depsgraph`
    evaluates it before the export prepares anything. `prep` holds, for
    every object the export bakes, what besides its mesh decides how it is
    prepared (scene_export.preparation: its seed and render settings).

    With `stale_occlusion`, an object whose neighbours alone changed loads
    the entry of its last bake, the occlusion of its old neighbours in its
    colour map, instead of being baked (`get`)."""

    def __init__(self, root, depsgraph, prep, stale_occlusion=False):
        self.root = root
        os.makedirs(root, exist_ok=True)
        self.used = set()
        self.code = code_digest()
        self.depsgraph = depsgraph
        self.prep = {ob.name: p for ob, p in prep.items()}
        self.stale_occlusion = stale_occlusion
        # Each key's own part: the key of everything but the neighbours.
        self.own = {}
        self._scene = None
        self._entries_by_own = None

    def _triangles(self):
        """Every triangle in the depsgraph, world space, as [(original
        object, is an instance, how the bake's rays see it, (n, 3, 3)
        triangles, their lows, their highs)], read once per export. A WHOLE
        object comes as its digest in place of triangles, with its world box
        as one low and one high.

        This is the scene before the export prepares it, not as the bake
        meets it: a baked object's preparation (its creases rebuilt) is a
        function of its mesh, the code and its `prep`, which its part of the
        key carries."""
        if self._scene is not None:
            return self._scene
        self._scene = []
        shown = rendered_collections(self.depsgraph.view_layer)
        for inst in self.depsgraph.object_instances:
            ev = inst.object
            if ev.type not in GEOMETRY | WHOLE:
                continue
            orig = ev.original
            if not rendered(inst, shown):
                continue
            m = np.array(inst.matrix_world, dtype=np.float64)
            seen_by = (orig.visible_camera, orig.visible_diffuse, orig.visible_glossy,
                       orig.visible_transmission, orig.visible_volume_scatter, orig.visible_shadow,
                       self.prep.get(orig.name))
            if ev.type in WHOLE:
                d = hashlib.sha256()
                _put(d, ev.type, m.tolist())
                if ev.type == "VOLUME":
                    _put(d, ev.data.filepath)
                    d.update(file_digest(os.path.realpath(bpy.path.abspath(ev.data.filepath, library=ev.data.library))))
                else:
                    attributes_digest(d, ev.data.attributes)
                corners = np.array([tuple(c) for c in ev.bound_box], dtype=np.float64) @ m[:3, :3].T + m[:3, 3]
                self._scene.append((orig, inst.is_instance, seen_by, d.digest(),
                                    corners.min(axis=0)[None], corners.max(axis=0)[None]))
                continue
            try:
                me = ev.to_mesh()
            except RuntimeError:
                continue
            try:
                if me is None:
                    continue
                me.calc_loop_triangles()
                n = len(me.loop_triangles)
                if not n:
                    continue
                verts = np.empty(n * 3, np.int32)
                me.loop_triangles.foreach_get("vertices", verts)
                co = np.empty(len(me.vertices) * 3, np.float32)
                me.vertices.foreach_get("co", co)
            finally:
                ev.to_mesh_clear()
            world = co.reshape(-1, 3).astype(np.float64) @ m[:3, :3].T + m[:3, 3]
            tris = world[verts].reshape(n, 3, 3)
            self._scene.append((orig, inst.is_instance, seen_by, tris, tris.min(axis=1), tris.max(axis=1)))
        return self._scene

    def _surroundings(self, h, ob, reach):
        """Every triangle of the scene but `ob`'s own within `reach` of its
        surface, by where it stands and how the bake's rays see it - not by
        which object it is part of, nor anything else of that object. The
        test is conservative: a triangle counts when its bounding sphere comes
        within `reach` of the surface; a WHOLE object, when its box comes
        within `reach` of `ob`'s."""
        scene = self._triangles()
        own = next((e[3] for e in scene if e[0] == ob and not e[1]), None)
        if own is None:
            raise RuntimeError(f"{ob.name}: not in the bake's depsgraph")
        lo, hi = own.min(axis=(0, 1)) - reach, own.max(axis=(0, 1)) + reach
        bvh = None if reach == float("inf") else \
            BVHTree.FromPolygons(own.reshape(-1, 3).tolist(), np.arange(len(own) * 3).reshape(-1, 3).tolist())
        parts = []
        for orig, instance, seen_by, tris, tlo, thi in scene:
            if orig == ob and not instance:
                continue
            near = np.flatnonzero(np.all(thi >= lo, axis=1) & np.all(tlo <= hi, axis=1))
            if isinstance(tris, bytes):
                if len(near):
                    parts.append(hashlib.sha256(repr(seen_by).encode() + tris).digest())
                continue
            if bvh is not None and len(near):
                centre = tris[near].mean(axis=1)
                radius = np.linalg.norm(tris[near] - centre[:, None, :], axis=2).max(axis=1)
                near = [i for i, c, r in zip(near.tolist(), centre.tolist(), radius.tolist())
                        if bvh.find_nearest(c, reach + r)[0] is not None]
            if not len(near):
                continue
            rows = np.round(tris[near].reshape(-1, 9) / NEAR_QUANTUM).astype(np.int64)
            rows = rows[np.lexsort(rows.T[::-1])]
            p = hashlib.sha256()
            _put(p, seen_by)
            p.update(rows.tobytes())
            parts.append(p.digest())
        # By content, so the order objects stand in the file does not count.
        for part in sorted(parts):
            h.update(part)

    def key(self, ob, scene, materials, extra=()):
        """The key of `ob`'s prepared mesh and maps, from the scene before
        any preparation, with the export's own copies of its `materials`, slot
        by slot (as the bake will read them: a backdrop rock's slate is
        repainted to its depth, its occlusion reach too), and `extra` (the
        keys of the mosses painted into its colour map).

        The key is in two parts: its own (everything above but the
        neighbours, kept in `own` and in the entry's meta.json), and the
        neighbours within its occlusion reach, hashed on top of it."""
        h = hashlib.sha256()
        _put(h, self.code, self.prep[ob.name], [tuple(r) for r in ob.matrix_world], list(extra))
        seen = {}
        for p in scene.cycles.bl_rna.properties:
            if p.identifier.startswith(VIEWPORT_CYCLES) or p.identifier in VIEWPORT_CYCLES_NAMES:
                continue
            if p.identifier not in SKIP and p.type in {"BOOLEAN", "INT", "FLOAT", "STRING", "ENUM"}:
                v = getattr(scene.cycles, p.identifier)
                _put(h, p.identifier, sorted(v) if isinstance(v, set) else v)
        rna_digest(h, scene.render.bake, 0, seen)
        mesh_digest(h, ob.evaluated_get(self.depsgraph).data)
        for i, mat in enumerate(materials):
            _put(h, "slot", i, mat is not None)
            if mat:
                _put(h, mat.displacement_method)
                if mat.node_tree:
                    tree_digest(h, mat.node_tree, seen)
        own = h.hexdigest()
        full = hashlib.sha256(own.encode())
        reach = ao_reach(materials)
        if reach > 0:
            self._surroundings(full, ob, reach)
        key = full.hexdigest()
        self.own[key] = own
        return key

    def _by_own(self):
        """{own part: [entry, newest first]} of every entry on disk, read
        once. An entry written before the key had parts has no own part and
        is never found by it."""
        if self._entries_by_own is None:
            self._entries_by_own = {}
            for name in os.listdir(self.root):
                meta = os.path.join(self.root, name, "meta.json")
                try:
                    with open(meta) as f:
                        own = json.load(f).get("own")
                    when = os.path.getmtime(meta)
                except (OSError, ValueError):
                    continue
                if own:
                    self._entries_by_own.setdefault(own, []).append((when, name))
            for own, entries in self._entries_by_own.items():
                self._entries_by_own[own] = [name for _, name in sorted(entries, reverse=True)]
        return self._entries_by_own

    def _complete(self, entry, names):
        """The files of `entry` holding all of `names` and its mesh, else None."""
        files = {n: os.path.join(self.root, entry, map_file(n)) for n in names}
        mesh = os.path.join(self.root, entry, MESH_FILE)
        meta = os.path.join(self.root, entry, "meta.json")
        if not all(os.path.isfile(p) for p in [*files.values(), mesh, meta]):
            return None
        return files, mesh, meta

    def get(self, key, names):
        """(the {image name: PNG path} of `names`, the prepared mesh's .blend,
        the export's `data`, the entry's key) for an entry holding all of
        them, else None. The entry is `key`'s; failing that, with
        `stale_occlusion`, the newest whose own part is `key`'s, its key then
        not `key`. Such an entry stays under its own key, never `key`'s, so
        an export without the flag bakes it afresh."""
        entry, found = key, self._complete(key, names)
        if found is None and self.stale_occlusion:
            for entry in self._by_own().get(self.own[key], ()):
                found = self._complete(entry, names)
                if found:
                    break
        if found is None:
            return None
        files, mesh, meta = found
        with open(meta) as f:
            data = json.load(f).get("data")
        self.used.add(entry)
        return files, mesh, data, entry

    def put(self, key, images, mesh, label, data=None):
        """Keep `images` (packed), the prepared `mesh` and the export's `data`
        (JSON) under `key`, written whole or not at all. The mesh goes without
        its materials (its slots emptied, which keeps every face's slot;
        clearing them would not): the export copies them afresh from the
        file's, as for a bake."""
        final = os.path.join(self.root, key)
        tmp = final + ".partial"
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        for im in images:
            with open(os.path.join(tmp, map_file(im.name)), "wb") as f:
                f.write(im.packed_file.data)
        bare = mesh.copy()
        try:
            for i in range(len(bare.materials)):
                bare.materials[i] = None
            bpy.data.libraries.write(os.path.join(tmp, MESH_FILE), {bare}, compress=True)
        finally:
            bpy.data.meshes.remove(bare)
        with open(os.path.join(tmp, "meta.json"), "w") as f:
            json.dump({"object": label, "own": self.own[key], "images": [im.name for im in images], "data": data}, f)
        shutil.rmtree(final, ignore_errors=True)
        os.replace(tmp, final)
        self.used.add(key)

    def prune(self):
        """Remove every entry the latest export did not use. Returns how many."""
        gone = 0
        for name in os.listdir(self.root):
            if name not in self.used:
                shutil.rmtree(os.path.join(self.root, name), ignore_errors=True)
                gone += 1
        return gone


def map_file(name):
    """The file in an entry holding the map named `name`. A map is named after
    its object, and an object's name may hold a slash ("Cube / guide-004",
    2026-10-09, whose put failed on a directory that was not there), so the
    slash is escaped, and the escape's own "%" with it; any other name is its
    file as it always was, so no entry already on disk goes missing."""
    return name.replace("%", "%25").replace("/", "%2F") + ".png"


def load(path, name, colorspace):
    """A cached map as the image the bake would have made: named `name`,
    packed (the glTF exporter ships the packed PNG as it is)."""
    im = bpy.data.images.load(path, check_existing=False)
    im.name = name
    im.colorspace_settings.name = colorspace
    im["generated_by"] = "tools/blender/scene_export.py"
    im.pack()
    return im


def load_mesh(path, materials):
    """A cached prepared mesh, its emptied slots filled with `materials`."""
    with bpy.data.libraries.load(path) as (src, dst):
        dst.meshes = list(src.meshes)
    if len(dst.meshes) != 1 or dst.meshes[0] is None:
        raise RuntimeError(f"{path}: not one mesh")
    mesh = dst.meshes[0]
    if len(mesh.materials) != len(materials):
        raise RuntimeError(f"{path}: {len(mesh.materials)} slots for {len(materials)} materials")
    for i, mat in enumerate(materials):
        mesh.materials[i] = mat
    return mesh
