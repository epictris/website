"""Growing a glow flora patch (glowflora.py) on its host, in Blender.

The patch is grown in its own frame, the web generator's: y up, its camera on
+z. That frame is the plant object's, turned so the patch's up is the object's
+Z and its camera side the object's -Y (the game's camera, Blender -y, when
the object is unturned, which is how a glow plant is planted). So the patch
stands on world up however the rock slopes under its root, R turns or tilts
the whole patch, and S sizes it.

The ground under every point of the patch is the host's surface, found by a
ray down the patch's up axis, memoised on a 1 cm grid (patch units) and read
bilinearly. Where a ray finds no ground facing up within reach (over an edge,
into a wall) there is none, and a plant standing there walks back toward the
root (glowflora's "edge" fix).

The mesh carries the attributes the game's glow flora shader reads
(render3d/glowFlora.ts): `Col` (COLOR_0, the body colour), and the generic
`_GLOW` (emission, linear RGB), `_GILL` (the radial direction and gill weight;
weight -1 marks a stem's inner glow), `_SWAY` (wind phase, amplitude in the
world's metres, height factor) and `_EXTRA` (gill line count, pulse phase).
Names starting with `_` are the ones Blender's glTF exporter writes as custom
attributes (scene_export.py turns `export_attributes` on); the optimiser keeps
them, unquantised. The game finds a glow plant by its `_glow` attribute, not
by its material's name, which the optimiser may merge or replace."""

import math
import json
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

from . import glowflora
from .stampbrush import lod

MATERIAL_NAME = "Glow Flora"
MATERIAL_VERSION = 2
EMISSION_STRENGTH = json.loads(Path(__file__).with_name("glow_look.json").read_text())["emissionStrength"]
GRID = 0.01  # the ground's memo grid, patch units
ABOVE = 0.6  # a ground ray starts this far above the root (patch units)...
BELOW = 1.5  # ...and finds ground at most this far below it
UPWARD = 0.2  # the least a ground face must face the patch's up
MAX_RISE = math.tan(math.radians(70.0))  # steeper than this between grid nodes is a ledge's edge


class GrowthError(Exception):
    pass


class HostGround:
    """The host's surface as the patch's ground: a height under (x, z), or None."""

    def __init__(self, surface, matrix):
        self.connected = {}
        self.bvh = surface.bvh
        self.m = matrix
        self.inv = matrix.inverted()
        self.down = (matrix.to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized()
        self.up = -self.down
        self.scale = (matrix.to_3x3() @ Vector((0.0, 0.0, 1.0))).length
        self.memo = {}

    def node(self, i, k):
        key = (i, k)
        if key in self.memo:
            return self.memo[key]
        x, z = i * GRID, k * GRID
        origin = self.m @ Vector((x, -z, ABOVE))
        loc, normal, _index, _dist = self.bvh.ray_cast(origin, self.down, (ABOVE + BELOW) * self.scale)
        y = None
        if loc is not None and normal.dot(self.up) > UPWARD:
            y = (self.inv @ loc).z
        self.memo[key] = y
        return y

    def ground(self, i, k):
        """A node's height if it is the root's ground: reached from the root
        node by grid steps toward it, none of them a drop or a climb steeper
        than MAX_RISE. A ray past a ledge finds the terrace below; that is
        another ground, and the patch does not spill down onto it."""
        chain = []
        while (i, k) not in self.connected:
            chain.append((i, k))
            n = max(abs(i), abs(k))
            if n == 0:
                break
            i, k = round(i * (n - 1) / n), round(k * (n - 1) / n)
        below = self.connected.get((i, k)) if (i, k) in self.connected else None
        for key in reversed(chain):
            y = self.node(*key)
            if key != (0, 0):
                if below is None or y is None:
                    y = None
                else:
                    pi, pk = (i, k)
                    step = GRID * math.hypot(key[0] - pi, key[1] - pk)
                    if abs(y - below) > MAX_RISE * step:
                        y = None
            self.connected[key] = y
            below = y
            i, k = key
        return self.connected[chain[0]] if chain else self.connected[(i, k)]

    def at(self, x, z):
        fi, fk = x / GRID, z / GRID
        i, k = math.floor(fi), math.floor(fk)
        u, v = fi - i, fk - k
        a, b, c, d = self.ground(i, k), self.ground(i + 1, k), self.ground(i, k + 1), self.ground(i + 1, k + 1)
        if a is None or b is None or c is None or d is None:
            return None
        return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v


def edits_of(s):
    if not s.glow_edits:
        return {}
    import json

    try:
        return {int(k): v for k, v in json.loads(s.glow_edits).items()}
    except (ValueError, AttributeError):
        return {}


def grow(ob, surface):
    """Grow the plant's patch on its host: (arrays in the object's frame,
    extra attributes, stats). Generated, edited and built in the patch frame."""
    s = ob.foliage
    ground = HostGround(surface, ob.matrix_world)
    if ground.at(0.0, 0.0) is None:
        raise GrowthError("No ground under the root: plant a glow patch on a surface that faces up")
    glowflora.GROUND = glowflora.Ground(ground.at)
    try:
        patch = glowflora.generate_with_overrides(s.glow_params(), edits_of(s), collisions=s.glow_collisions)
        slope = lod.scene_slope(bpy.context.scene)
        # Convert a world error to patch units using the largest scale. Edited
        # items and rotated/nonuniformly scaled patches use their actual bounds.
        matrix = np.asarray(ob.matrix_world, dtype=float)
        max_scale = float(np.linalg.svd(matrix[:3, :3], compute_uv=False).max())

        def tolerance(it):
            if "kind" in it:
                shape = glowflora.shape_of(it)
                lo, hi = shape.box.lo, shape.box.hi
                sway = shape.amp
            else:
                radius = it["radius"] * 1.5
                lo = (it["x"]-radius, -radius, it["z"]-radius)
                hi = (it["x"]+radius, radius, it["z"]+radius)
                sway = 0
            corners = np.array([(x, -z, y) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
            depth = float((corners @ matrix[:3, :3].T + matrix[:3, 3])[:, 1].min()) - sway * max_scale
            return lod.HIGH_BLUR * slope * max(0, depth - lod.FOCUS_BAND) / (2 * max(max_scale, 1e-9))

        b, _ranges = glowflora.build(patch, int(s.glow_detail), tolerance)
    finally:
        glowflora.GROUND = glowflora.Ground.flat()
    if not b.i:
        raise GrowthError("Nothing grew: the patch has no plants")
    # The patch frame (three's y up, camera +z) in the object's (z up, camera -y).
    p = np.array(b.p, dtype=np.float64).reshape(-1, 3)
    pos = np.stack([p[:, 0], -p[:, 2], p[:, 1]], axis=1)
    tri = np.array(b.i, dtype=np.int64).reshape(-1, 3)
    # three's computeVertexNormals: each vertex the sum of its faces' area-weighted normals.
    acc = np.zeros_like(pos)
    fn = np.cross(pos[tri[:, 2]] - pos[tri[:, 1]], pos[tri[:, 0]] - pos[tri[:, 1]])
    for k in range(3):
        np.add.at(acc, tri[:, k], fn)
    ln = np.linalg.norm(acc, axis=1, keepdims=True)
    nrm = np.where(ln > 1e-20, acc / np.maximum(ln, 1e-20), np.array([0.0, 0.0, 1.0]))
    uv = np.zeros((len(pos), 2))
    col = np.array(b.c, dtype=np.float64).reshape(-1, 3)
    gi = np.array(b.gi, dtype=np.float64).reshape(-1, 4)
    sw = np.array(b.s, dtype=np.float64).reshape(-1, 4)
    # The sway's amplitude in the world's metres: the shader moves the vertex in the world.
    world_scale = ground.scale
    extra = {
        "_GLOW": np.array(b.g, dtype=np.float64).reshape(-1, 3),
        "_GILL": gi[:, :3],
        "_SWAY": np.stack([sw[:, 0], sw[:, 1] * world_scale, sw[:, 2]], axis=1),
        "_EXTRA": np.stack([gi[:, 3], sw[:, 3]], axis=1),
    }
    solve = patch.get("solve") or {"remaining": 0}
    stats = {"parts": len(patch["items"]), "leaves": 0, "remaining": solve["remaining"], "dropped": solve.get("dropped", 0), "patch": patch}
    return (pos, nrm, uv, col, tri), extra, stats


def write_extra(me, extra):
    """The shader's per-vertex attributes, as generic point attributes."""
    for name, values in extra.items():
        kind = {2: "FLOAT2", 3: "FLOAT_VECTOR"}[values.shape[1]]
        attr = me.attributes.get(name)
        if attr is not None and (attr.data_type != kind or attr.domain != "POINT"):
            me.attributes.remove(attr)
            attr = None
        if attr is None:
            attr = me.attributes.new(name, kind, "POINT")
        attr.data.foreach_set("vector", values.astype(np.float32).ravel())


def material():
    """`Glow Flora`, shared by every glow plant: the body colour (`Col`) and an
    emission of `_GLOW`. It is Blender's view of the look only: the game swaps
    in its own shader (gill lines, rim, pulse, sway), and the glTF exporter
    carries the base colour as COLOR_0."""
    mat = bpy.data.materials.get(MATERIAL_NAME)
    if mat is not None and mat.get("glow_flora_material") == MATERIAL_VERSION:
        return mat
    if mat is None:
        mat = bpy.data.materials.new(MATERIAL_NAME)
    if mat.node_tree is None:
        mat.use_nodes = True
    mat["glow_flora_material"] = MATERIAL_VERSION
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type not in {"BSDF_PRINCIPLED", "OUTPUT_MATERIAL"}:
            nt.nodes.remove(n)
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.42
    bsdf.inputs["Emission Strength"].default_value = EMISSION_STRENGTH
    mat.use_backface_culling = True
    mat.diffuse_color = (0.8, 0.6, 0.95, 1.0)
    x, y = bsdf.location.x, bsdf.location.y
    tint = nt.nodes.new("ShaderNodeVertexColor")
    tint.layer_name = "Col"
    tint.location = (x - 300, y + 50)
    nt.links.new(tint.outputs["Color"], bsdf.inputs["Base Color"])
    glow = nt.nodes.new("ShaderNodeAttribute")
    glow.attribute_type = "GEOMETRY"
    glow.attribute_name = "_GLOW"
    glow.location = (x - 300, y - 250)
    nt.links.new(glow.outputs["Color"], bsdf.inputs["Emission Color"])
    return mat


IDENTITY = Matrix.Identity(4)
