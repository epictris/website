"""The scene export's bake cache (docs/blender-scenes.md, "The bake cache").

Baking is most of an export (the river, 2026-10-04: Cycles 100 of 163 s), and
an edit usually touches one or two objects. So every baked object's final
maps (its "baked colour" and "baked normal" images, as the glTF gets them) are
kept under a key of everything that decides their pixels, and an object whose
key is unchanged loads them instead of baking:

- the bake code: this file, scene_export.py and formations/*.py (the detail
  high poly, the slate, the curved creases), and Blender's version;
- the scene's Cycles and bake settings;
- the object's prepared mesh as the bake sees it (modifiers applied, the
  creases rebuilt and still straight, every attribute, the bake unwrap), its
  world transform, its detail seed and its map size;
- every node tree of its materials, node groups and images included;
- every object within reach of its Ambient Occlusion nodes: the slate's 0.5 m
  occlusion darkens where another rock comes close, so moving a neighbour
  must re-bake it.

When in doubt the key takes more in, never less: a missed input ships a stale
map without a word, an extra one costs a bake. `--no-cache` on the export
bakes everything afresh.

An entry is a directory named by the key with each map as the PNG the export
packed (named as the image is, since the glTF exporter may name an image by
its file) and a meta.json; entries the latest export did not use are removed,
so the cache holds one export's maps per scene.
"""

import glob
import hashlib
import json
import os
import shutil

import bpy
import numpy as np
from mathutils import Vector

# Bumped when an entry's layout changes.
VERSION = 1
HERE = os.path.dirname(os.path.abspath(__file__))
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
    `facet` and `strip`, materials), selection and hiding left out."""
    _put(h, len(me.vertices), len(me.edges), len(me.loops), len(me.polygons))
    _array(h, me.polygons, "loop_start", 1, np.int32)
    _array(h, me.loops, "vertex_index", 1, np.int32)
    _array(h, me.edges, "vertices", 2, np.int32)
    for name in sorted(a.name for a in me.attributes):
        if name.startswith(EDITOR_ATTRIBUTE):
            continue
        attr = me.attributes[name]
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
    _put(h, [m.name if m else None for m in me.materials])


def image_digest(h, im):
    _put(h, "image", im.source, im.filepath, tuple(im.size), im.colorspace_settings.name, im.alpha_mode)
    if im.packed_file is not None:
        h.update(hashlib.sha256(im.packed_file.data).digest())
    elif im.source == "FILE":
        path = bpy.path.abspath(im.filepath, library=im.library)
        try:
            st = os.stat(path)
            _put(h, st.st_size, st.st_mtime_ns)
        except OSError:
            _put(h, "missing")
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
    A group is taken once however often it is used."""
    if nt.name in seen:
        _put(h, "tree", nt.name)
        return
    seen.add(nt.name)
    for node in sorted(nt.nodes, key=lambda n: n.name):
        _put(h, "node", node.bl_idname, node.name, node.mute)
        rna_digest(h, node, 2, seen)
        for sock in node.inputs:
            _put(h, "in", sock.identifier, sock.is_linked, sock.enabled)
            if not sock.is_linked and hasattr(sock, "default_value"):
                v = sock.default_value
                _put(h, tuple(v) if hasattr(v, "__len__") and not isinstance(v, str) else v)
    _put(h, sorted((l.from_node.name, l.from_socket.identifier, l.to_node.name, l.to_socket.identifier, l.is_muted)
                   for l in nt.links))
    for item in getattr(getattr(nt, "interface", None), "items_tree", ()):
        rna_digest(h, item, 0, seen)


def code_digest():
    h = hashlib.sha256()
    _put(h, VERSION, bpy.app.version_string)
    files = [os.path.join(HERE, "scene_export.py"), os.path.join(HERE, "bake_cache.py")]
    files += sorted(glob.glob(os.path.join(HERE, "formations", "*.py")))
    for path in files:
        _put(h, os.path.relpath(path, HERE))
        with open(path, "rb") as f:
            h.update(hashlib.sha256(f.read()).digest())
    return h.hexdigest()


def world_box(ob):
    corners = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    return (Vector([min(c[i] for c in corners) for i in range(3)]),
            Vector([max(c[i] for c in corners) for i in range(3)]))


def ao_reach(ob):
    """How far the object's Ambient Occlusion nodes look, metres: 0 without
    any, infinite where a distance is driven by a link."""
    reach, seen = 0.0, set()

    def walk(nt):
        nonlocal reach
        if nt.name in seen:
            return
        seen.add(nt.name)
        for node in nt.nodes:
            if node.type == "AMBIENT_OCCLUSION" and not node.only_local:
                d = node.inputs["Distance"]
                reach = max(reach, float("inf") if d.is_linked else d.default_value)
            if node.type == "GROUP" and node.node_tree:
                walk(node.node_tree)

    for mat in ob.data.materials:
        if mat and mat.node_tree:
            walk(mat.node_tree)
    return reach


class Cache:
    """One scene's bake cache under `root`."""

    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)
        self.used = set()
        self.code = code_digest()
        self._near = {}

    def _object_digest(self, ob, depsgraph):
        """An object as the bake's rays meet it: evaluated geometry, transform
        and render visibility."""
        if ob.name in self._near:
            return self._near[ob.name]
        h = hashlib.sha256()
        _put(h, ob.name, ob.type, ob.hide_render, [tuple(r) for r in ob.matrix_world])
        ev = ob.evaluated_get(depsgraph)
        try:
            me = ev.data if ev.type == "MESH" else ev.to_mesh()
            if me is not None:
                mesh_digest(h, me)
        except RuntimeError:
            _put(h, "unevaluated")
        finally:
            if ev.type != "MESH":
                ev.to_mesh_clear()
        self._near[ob.name] = h.digest()
        return self._near[ob.name]

    def key(self, ob, size, seed, scene, depsgraph):
        """The key of `ob`'s maps, baked at `size` with detail seed `seed`."""
        h = hashlib.sha256()
        _put(h, self.code, size, seed, [tuple(r) for r in ob.matrix_world])
        seen = set()
        rna_digest(h, scene.cycles, 0, seen)
        rna_digest(h, scene.render.bake, 0, seen)
        mesh_digest(h, ob.data)
        for mat in ob.data.materials:
            _put(h, "material", mat.name if mat else None)
            if mat and mat.node_tree:
                tree_digest(h, mat.node_tree, seen)
        reach = ao_reach(ob)
        if reach > 0:
            lo, hi = world_box(ob)
            near = []
            for other in scene.objects:
                if other is ob or other.type not in GEOMETRY:
                    continue
                olo, ohi = world_box(other)
                if all(olo[i] <= hi[i] + reach and ohi[i] >= lo[i] - reach for i in range(3)):
                    near.append(other)
            for other in sorted(near, key=lambda o: o.name):
                h.update(self._object_digest(other, depsgraph))
        return h.hexdigest()

    def get(self, key, names):
        """{image name: PNG path} for an entry holding every one of `names`,
        else None."""
        files = {n: os.path.join(self.root, key, f"{n}.png") for n in names}
        if not all(os.path.isfile(p) for p in files.values()):
            return None
        self.used.add(key)
        return files

    def put(self, key, images, label):
        """Keep `images` (packed) under `key`, written whole or not at all."""
        final = os.path.join(self.root, key)
        tmp = final + ".partial"
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        for im in images:
            with open(os.path.join(tmp, f"{im.name}.png"), "wb") as f:
                f.write(im.packed_file.data)
        with open(os.path.join(tmp, "meta.json"), "w") as f:
            json.dump({"object": label, "images": [im.name for im in images]}, f)
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


def load(path, name, colorspace):
    """A cached map as the image the bake would have made: named `name`,
    packed (the glTF exporter ships the packed PNG as it is)."""
    im = bpy.data.images.load(path, check_existing=False)
    im.name = name
    im.colorspace_settings.name = colorspace
    im["generated_by"] = "tools/blender/scene_export.py"
    im.pack()
    return im
