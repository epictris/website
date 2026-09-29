"""What grows on formations: moss beds, sprigs and hanging moss.

A pure function of each formation's mesh, placement, `formation_attachment`,
`formation_moisture` and `formation_id` (the seed): the same rock plants the
same growth, so replanting after a rebuild or a move is always safe. Every
piece is its own object under the formation's placement (so it rides a later
move), tagged `formation_growth_owner` with the formation's id, and lives in
the GROWTH collection; replanting a formation deletes exactly its own pieces
first.

1. SITES. The rock's front contour is sampled with rays from the camera side;
   on a floor formation a site needs a real upward shelf just behind the lip,
   and a moisture-scaled budget spaces them apart so bare stone shows between.
   Stored on the formation as `formation_growth_sites` (JSON) for inspection.
2. SURFACE MOSS (floor formations): a thin decal draped over the top faces
   inside irregular lobes around the sites, at a constant world texel scale.
3. SPRIGS (floor formations): a few small curved cards at each site's root.
4. HANGING MOSS (every formation): complete strands curving over the lip of a
   site that spills - over a ledge on a floor formation, from the underside of
   a ceiling one - pushed clear of the rock along their whole drop.

SIZES. Growth is sized to read at a constant size on SCREEN: a piece on a rock
`b` metres behind the gameplay plane is `(D + b) / D` times its size on the
plane, with D the game camera's distance to the plane
(`formations_view_distance` on the scene; see `view_distance`).

The materials are glTF-shaped, so what Blender shows is what the game draws: an
image times a constant tint (baseColorTexture x baseColorFactor), alpha
clipped by a Less Than/Subtract pair (alphaMode MASK at the cutoff), double
sided, fully rough, no emission.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import re
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from . import core

GROWTH = "Formation growth"

TEXTURES = core.ROPE / "assets-src" / "scenes" / "textures"
FOLIAGE_IMAGE = "foliage-components-v3.png"
SURFACE_MOSS_IMAGE = "soft-moss-v2.png"
HANGING_MOSS_IMAGE = "hanging-moss-soft-strands-v5.png"

# The distance the growth was sized against when a scene states none: the
# game camera at `viewportScale` 0.65 with a 70 mm lens (the river level's
# opening framing, and the Sunken Grotto's composition camera).
DEFAULT_VIEW_DISTANCE = 10.2375

ATTACHMENTS = (
    ("FLOOR", "Floor", "Rises from below: moss beds, sprigs and moss over its lips"),
    ("CEILING", "Ceiling", "Hangs from above: moss trails from its underside"),
    ("WALL", "Wall", "A side mass: moss over its lips only"),
)


def view_distance(scene):
    return float(scene.get("formations_view_distance", DEFAULT_VIEW_DISTANCE))


def seed_of(rock, salt=0):
    return int(hashlib.sha256(str(rock["formation_id"]).encode()).hexdigest()[:8], 16) + salt


def growth_hash(rock):
    """What the planting was fitted to: the mesh and where it stands."""
    h = hashlib.sha256(core.mesh_hash(rock.data).encode())
    for row in core.authored_world(rock):
        h.update(("%0.6g," * 4 % tuple(row)).encode())
    return h.hexdigest()


def stale(rock):
    return rock.get("formation_growth_hash") != growth_hash(rock)


# --- Images and materials ----------------------------------------------------

def image(name):
    """The image by name (Blender's `.001` suffixes ignored), else loaded from
    assets-src/scenes/textures and packed into the file."""
    found = [im for im in bpy.data.images if re.sub(r"\.\d{3}$", "", im.name) == name]
    if found:
        return max(found, key=lambda im: (im.users, im.name == name))
    path = TEXTURES / name
    if not path.is_file():
        raise ValueError(f"{name} is not in this file or in {TEXTURES} (`bun run assets:fetch-sources`)")
    im = bpy.data.images.load(str(path), check_existing=True)
    im.pack()
    return im


def card_material(name, im, tint, cutoff):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_backface_culling = False
    if hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "DITHERED"
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (600, 0)
    bs = nodes.new("ShaderNodeBsdfPrincipled")
    bs.location = (300, 0)
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = im
    tex.location = (-400, 0)
    mix = nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1
    mix.inputs["B"].default_value = tint
    mix.location = (0, 100)
    below = nodes.new("ShaderNodeMath")
    below.operation = "LESS_THAN"
    below.inputs[1].default_value = cutoff
    below.location = (-100, -200)
    keep = nodes.new("ShaderNodeMath")
    keep.operation = "SUBTRACT"
    keep.inputs[0].default_value = 1
    keep.location = (100, -200)
    links.new(tex.outputs["Color"], mix.inputs["A"])
    links.new(mix.outputs["Result"], bs.inputs["Base Color"])
    links.new(tex.outputs["Alpha"], below.inputs[0])
    links.new(below.outputs[0], keep.inputs[1])
    links.new(keep.outputs[0], bs.inputs["Alpha"])
    links.new(bs.outputs[0], out.inputs[0])
    bs.inputs["Roughness"].default_value = 1
    bs.inputs["Specular IOR Level"].default_value = 0
    return mat


def materials():
    return {
        "sprig": card_material("Formation sprigs", image(FOLIAGE_IMAGE), (.42, .54, .57, 1), .42),
        "surface": card_material("Formation surface moss", image(SURFACE_MOSS_IMAGE), (.25, .35, .37, 1), .42),
        "hanging": card_material("Formation hanging moss", image(HANGING_MOSS_IMAGE), (.20, .29, .32, 1), .38),
    }


def pixels_of(im):
    width, height = im.size
    return np.asarray(im.pixels[:], dtype=np.float32).reshape(height, width, 4)


def foliage_sprites(im):
    """The atlas's four quadrants: each component's alpha bounds and the column
    its stem roots at (so an asymmetric sprig is not rooted at its middle)."""
    width, height = im.size
    top = pixels_of(im)[::-1]
    bounds, roots = [], []
    for sprite, (qx, qy) in enumerate(((0, 0), (1, 0), (0, 1), (1, 1))):
        ox, oy = qx * (width // 2), qy * (height // 2)
        yy, xx = np.where(top[oy:oy + height // 2, ox:ox + width // 2, 3] > .15)
        x0, y0 = max(ox, int(xx.min() + ox) - 3), max(oy, int(yy.min() + oy) - 3)
        x1, y1 = min(ox + width // 2, int(xx.max() + ox) + 4), min(oy + height // 2, int(yy.max() + oy) + 4)
        bounds.append((x0, y0, x1, y1))
        rows = top[y0:y0 + 10, x0:x1, 3] if sprite == 2 else top[y1 - 10:y1, x0:x1, 3]
        _, rx = np.where(rows > .15)
        roots.append(float(np.median(rx) + x0))
    return bounds, roots


def strand_sprites(im):
    """The hanging-moss sheet's isolated strands, each whole crown to tip."""
    iw, ih = im.size
    pixels = pixels_of(im)[::-1]
    mask = pixels[:, :, 3] > .15
    edges = np.diff(np.r_[False, mask.any(axis=0), False].astype(int))
    sprites = []
    for left, right in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
        yy, _ = np.where(mask[:, left:right])
        x0, x1 = max(0, left - 3), min(iw, right + 3)
        y0, y1 = max(0, int(yy.min()) - 3), min(ih, int(yy.max()) + 4)
        sprites.append((x0 / iw, x1 / iw, y0 / ih, y1 / ih))
    if not sprites:
        raise ValueError(im.name + ": no strands found")
    return sprites


# --- Geometry helpers ----------------------------------------------------------

class Surface:
    """A formation's world-space triangles, for ray casts."""

    def __init__(self, rock):
        rock.data.calc_loop_triangles()
        self.points = [rock.matrix_world @ v.co for v in rock.data.vertices]
        self.bvh = BVHTree.FromPolygons(self.points, [tuple(t.vertices) for t in rock.data.loop_triangles],
                                        all_triangles=True)
        self.lo = Vector(tuple(min(p[i] for p in self.points) for i in range(3)))
        self.hi = Vector(tuple(max(p[i] for p in self.points) for i in range(3)))

    def front(self, x, z):
        """The first surface a ray from the camera side meets at (x, z)."""
        hit, normal, _, _ = self.bvh.ray_cast(Vector((x, self.lo.y - 2, z)), Vector((0, 1, 0)),
                                              self.hi.y - self.lo.y + 4)
        return hit, normal

    def down(self, x, y):
        hit, normal, _, _ = self.bvh.ray_cast(Vector((x, y, self.hi.z + 1)), Vector((0, 0, -1)))
        return hit, normal


def screen_scale(scene, depth):
    d = view_distance(scene)
    return (d + depth) / d


def growth_sites(rock, surface, scene):
    """Deterministic sites on the rock's visible contour."""
    lo, hi = surface.lo, surface.hi
    scale = screen_scale(scene, (lo.y + hi.y) / 2)
    rng = random.Random(seed_of(rock, 421))
    moisture = max(0., min(1., rock.formation_moisture))
    ceiling = rock.formation_attachment == "CEILING"
    candidates = []
    for i in range(64):
        x = lo.x + (hi.x - lo.x) * ((i + rng.random()) / 64)
        start, direction = (lo.z, 1) if ceiling else (hi.z, -1)
        for step in range(160):
            z = start + direction * (hi.z - lo.z) * step / 159
            hit, _ = surface.front(x, z)
            if hit is None:
                continue
            # On a floor formation, only an actual upward ledge just behind the lip.
            shelf, n = surface.down(x, hit.y + scale * .06)
            if ceiling or (shelf is not None and n.z > .48 and abs(shelf.z - hit.z) < scale * .30):
                candidates.append(hit)
            break
    rng.shuffle(candidates)
    budget = min(8, max(0, round((hi.x - lo.x) / scale * moisture * 1.40)))
    sites = []
    for hit in candidates:
        radius = scale * rng.uniform(.24, .42) * (.75 + moisture * .45)
        if any(abs(hit.x - p["root"][0]) < (radius + p["radius"]) * .85 for p in sites):
            continue
        if len(sites) >= budget:
            break
        sites.append({"root": list(hit), "radius": radius, "moisture": moisture, "ceiling": ceiling,
                      "phase": rng.uniform(0, math.tau), "style": rng.choice(("tuft", "sparse", "cascade")),
                      "spill": ceiling or rng.random() < .30 + moisture * .55})
    return sites


def patch_weight(x, y, sites):
    """Irregular lobes around the floor sites, with bare stone between them."""
    weight = 0.
    for site in sites:
        if site["ceiling"]:
            continue
        dx = (x - site["root"][0]) / site["radius"]
        dy = (y - site["root"][1]) / (site["radius"] * .80)
        angle = math.atan2(dy, dx)
        edge = 1 + .15 * math.sin(angle * 3 + site["phase"]) + .09 * math.sin(angle * 7 - site["phase"])
        weight = max(weight, edge - math.hypot(dx, dy))
    return weight


def adopt(ob, rock, kind):
    """File a new growth object under its formation."""
    core.collection(GROWTH, core.collection(core.FORMATIONS)).objects.link(ob)
    ob["formation_growth_owner"] = rock["formation_id"]
    ob["formation_growth"] = kind
    root = core.placement(rock)
    ob.parent = root
    ob.matrix_parent_inverse = root.matrix_world.inverted()


def mesh_object(name, verts, faces, uvs, mat):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    uv = mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[mesh.loops[li].vertex_index]
    mesh.materials.append(mat)
    ob = bpy.data.objects.new(name, mesh)
    ob.visible_shadow = False
    return ob


# --- The three kinds ---------------------------------------------------------

def surface_moss(rock, surface, sites, scene, mat):
    lo, hi = surface.lo, surface.hi
    scale = screen_scale(scene, core.placement(rock).location.y)
    cell = scale * .08125
    nx = math.ceil((hi.x - lo.x) / cell)
    ny = math.ceil((hi.y - lo.y) * .72 / cell)
    pv, puv, grid = [], [], {}
    for iy in range(ny + 1):
        for ix in range(nx + 1):
            x, y = lo.x + ix * cell, lo.y + iy * cell
            if patch_weight(x, y, sites) < .08:
                continue
            hit, n = surface.down(x, y)
            if hit is None or n.z < .24:
                continue
            grid[ix, iy] = len(pv)
            pv.append(tuple(hit + n * scale * .012))
            puv.append((ix / 8, iy / 8))
    faces = []
    for ix, iy in list(grid):
        keys = ((ix, iy), (ix + 1, iy), (ix + 1, iy + 1), (ix, iy + 1))
        if not all(k in grid for k in keys):
            continue
        face = tuple(grid[k] for k in keys)
        if max(pv[k][2] for k in face) - min(pv[k][2] for k in face) > scale * .35:
            continue
        faces.append(face)
    if not faces:
        return []
    name = rock.name + " / surface moss"
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(pv, [], faces)
    mesh.materials.append(mat)
    uv = mesh.uv_layers.new(name="UVMap")
    for face in mesh.polygons:
        # A seam at each tile boundary keeps the UVs in [0, 1] at a constant
        # world texel scale.
        base = tuple(math.floor(min(puv[k][axis] for k in face.vertices)) for axis in (0, 1))
        for loop in face.loop_indices:
            uv.data[loop].uv = tuple(puv[mesh.loops[loop].vertex_index][axis] - base[axis] for axis in (0, 1))
    ob = bpy.data.objects.new(name, mesh)
    ob.visible_shadow = False
    adopt(ob, rock, "surface moss")
    return [ob]


def sprigs(rock, sites, scene, mat, atlas):
    bounds, roots = atlas
    im = mat.node_tree.nodes["Image Texture"].image
    width, height = im.size
    pixels = pixels_of(im)
    depth = core.placement(rock).location.y
    scale = screen_scale(scene, depth)
    distance_size = max(.45, min(1., (36 / max(36, depth)) ** .65))
    index = seed_of(rock, 0) >> 4
    rng = random.Random(6100 + index)
    out = []

    def card(name, anchor, size, sprite, seed):
        crng = random.Random(seed)
        x0, y0, x1, y1 = bounds[sprite]
        aspect = (x1 - x0) / (y1 - y0)
        verts, faces, uvs = [], [], []
        bands = 5
        for band in range(bands):
            ya = round(y0 + (y1 - y0) * band / bands)
            yb = round(y0 + (y1 - y0) * (band + 1) / bands)
            occupied = np.where((pixels[height - yb:height - ya, x0:x1, 3] > .1).any(axis=0))[0]
            if len(occupied) == 0:
                continue
            xa, xb = max(x0, x0 + int(occupied[0]) - 3), min(x1, x0 + int(occupied[-1]) + 4)
            start = len(verts)
            for x, y in ((xa, yb), (xb, yb), (xb, ya), (xa, ya)):
                t = (y - y0) / (y1 - y0)
                z = (1 - t) * size if sprite != 2 else -t * size
                dx = ((x - roots[sprite]) / (x1 - x0)) * size * aspect
                # A drooping tip and a bow in depth keep a card from reading flat.
                f = t if sprite == 2 else 1 - t
                dx += math.sin(f * math.pi) * size * .12
                bend = math.sin(f * math.pi * .85) * size * .24
                z -= math.sin(f * math.pi * .5) ** 3 * size * .10 if sprite != 2 else 0
                verts.append((dx, bend, z))
                uvs.append((x / width, 1 - y / height))
            faces.append(tuple(range(start, start + 4)))
        ob = mesh_object(name, verts, faces, uvs, mat)
        ob.location = anchor
        ob.rotation_euler = (crng.uniform(-.45, .35), crng.uniform(-.65, .65), crng.uniform(-.8, .8))
        ob["formation_sprite"] = sprite
        adopt(ob, rock, "sprig")
        return ob

    # The draws marked "retired" fed rules this planting no longer has. They
    # stay so the stream - and so every accepted sprig - is the one the Sunken
    # Grotto was planted with; removing them re-rolls every scene's sprigs.
    moisture = rock.formation_moisture
    rng.choice((1, 2, 3, 4)) if moisture > .5 else rng.choice((0, 1))  # retired: cluster count
    if not sites:
        return out
    for _ in range(80):  # retired: top-face candidates
        rng.uniform(.15, .85)
        rng.uniform(.10, .55)
    for i, site in enumerate(s for s in sites if not s["ceiling"]):
        hit = Vector(site["root"])
        rng.randint(3, 6)  # retired: the older component count
        for j in range(rng.randint(2, 4)):
            rng.uniform(-.022, .022)  # retired: the older offset
            rng.uniform(-.12, -.045)
            offset = Vector((rng.uniform(-.10, .10) * scale, -.025 * scale, -.012 * scale))
            sprite = rng.choice((0, 1, 3))
            size = scale * distance_size * rng.uniform(.085, .180)
            out.append(card(rock.name + f" / sprig {i}-{j}", hit + offset, size, sprite, index * 100 + i * 10 + j))
    return out


def hanging_moss(rock, surface, sites, scene, mat, strands):
    lo, hi = surface.lo, surface.hi
    ceiling = rock.formation_attachment == "CEILING"
    scale = screen_scale(scene, (lo.y + hi.y) / 2)
    rng = random.Random(seed_of(rock, 9517))
    seed = seed_of(rock)
    iw = mat.node_tree.nodes["Image Texture"].image.size[0]
    ih = mat.node_tree.nodes["Image Texture"].image.size[1]
    out = []

    def contour(x):
        """The visible silhouette at x, refined to 1/4096 of the rock's height."""
        span = hi.z - lo.z
        direction = 1 if ceiling else -1
        start = lo.z if ceiling else hi.z
        for step in range(257):
            hit, _ = surface.front(x, start + direction * span * step / 256)
            if hit is None:
                continue
            low, high = max(0, step - 1) / 256, step / 256
            for _ in range(4):
                mid = (low + high) / 2
                probe, _ = surface.front(x, start + direction * span * mid)
                if probe is None:
                    low = mid
                else:
                    high = mid
            return surface.front(x, start + direction * span * (high + .0003))[0]
        return None

    for index, site in enumerate(sites):
        if not site["spill"]:
            continue
        center, width = site["root"][0], site["radius"] * 2
        length = width * .86
        roots = [contour(center + width * (i / 16 - .5)) for i in range(17)]
        if sum(p is not None for p in roots) < 14:
            continue
        for i, p in enumerate(roots):
            if p is None:
                nearest = min((j for j in range(17) if roots[j] is not None), key=lambda j: abs(j - i))
                roots[i] = roots[nearest].copy()
                roots[i].x = center + width * (i / 16 - .5)
        # A sheet across a cliff step stretches painted leaves; only coherent ledges.
        if max(p.z for p in roots) - min(p.z for p in roots) > width * .80:
            continue
        if any(abs(a.z - b.z) > length * .45 for a, b in zip(roots, roots[1:])):
            continue
        style = site["style"]
        count = {"tuft": 4, "sparse": 3, "cascade": 7}[style]
        specs = []
        for piece in range(count):
            sprite = rng.randrange(len(strands))
            size = rng.uniform(.34, .55) if style == "tuft" else rng.uniform(.48, .95)
            if style == "cascade" and piece == count // 2:
                size = 1.05
            specs.append((sprite, size, -.38 + .76 * (piece + rng.uniform(.1, .9)) / count, rng.uniform(.025, .045)))
        for group, (sprite, size_factor, x_offset, offset) in enumerate(specs):
            u0, u1, v0, v1 = strands[sprite]
            mid = (u0 + u1) / 2
            jitter = random.Random(seed + index * 61 + group).uniform(-.010, .010)
            root = contour(center + width * (x_offset + jitter))
            if root is None:
                continue
            world_per_texel = width / iw * size_factor
            full_width, full_height = iw * world_per_texel, ih * world_per_texel
            painted_height = full_height * (v1 - v0)
            # Root on the lip's depth, crown just above the edge so it shows.
            ledge_z = root.z
            attachment, _ = surface.front(root.x, root.z - painted_height * .06)
            if attachment is not None:
                root.y = attachment.y
            root.z = ledge_z + painted_height * (-.025 if ceiling else .010)
            bend = min(.12, (v1 - v0) * .24)
            crown_angle = math.radians(32)
            radius = full_height * bend / (math.pi / 2 - crown_angle)

            def drape(t):
                travel = t - v0
                if travel <= bend:
                    theta = crown_angle + (math.pi / 2 - crown_angle) * travel / bend
                    return radius * (1 - math.sin(theta)), radius * math.cos(theta)
                s = full_height * (travel - bend)
                r = full_height * ((v1 - v0) - bend) / math.radians(5)
                return -r * (1 - math.cos(s / r)), -r * math.sin(s / r)

            # The strand is rigid; the rock only decides how far forward it sits.
            clearance = scale * offset
            needed = []
            for u in (u0, mid, u1):
                for f in (0., .04, .08, .12, .18, .25, .35, .60, .85, .98, 1.):
                    y_rel, z_rel = drape(v0 + (v1 - v0) * f)
                    hit, _ = surface.front(root.x + full_width * (u - mid), root.z + z_rel)
                    if hit is not None:
                        needed.append(root.y + y_rel - hit.y + clearance)
            root.y -= max([clearance, *needed])
            rows = [v0 + bend * i / 6 for i in range(7)] + [v0 + (v1 - v0) * f for f in (.40, .70, 1.)]
            ts = sorted({v0, v1, *[t for t in rows if v0 < t < v1]})
            origin = rock.matrix_world.translation
            verts, uvs, faces = [], [], []
            for t in ts:
                y_rel, z_rel = drape(t)
                for u in (u0, u1):
                    verts.append(tuple(Vector((root.x + full_width * (u - mid), root.y + y_rel, root.z + z_rel)) - origin))
                    uvs.append((u, 1 - t))
            for iy in range(len(ts) - 1):
                a = iy * 2
                faces.append((a, a + 1, a + 3, a + 2))
            ob = mesh_object(rock.name + f" / hanging moss {index}-{group}", verts, faces, uvs, mat)
            ob.location = origin
            adopt(ob, rock, "hanging moss")
            out.append(ob)
    return out


# --- Entry points ------------------------------------------------------------

def clear(rock):
    rid = rock["formation_id"]
    for ob in list(bpy.data.objects):
        if ob.get("formation_growth_owner") == rid:
            mesh = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if mesh is not None and mesh.users == 0:
                bpy.data.meshes.remove(mesh)


def plant(rocks, scene=None):
    """Replant `rocks`. Returns {formation name: piece count}."""
    scene = scene or bpy.context.scene
    mats = materials()
    atlas = foliage_sprites(mats["sprig"].node_tree.nodes["Image Texture"].image)
    strands = strand_sprites(mats["hanging"].node_tree.nodes["Image Texture"].image)
    bpy.context.view_layer.update()
    report = {}
    for rock in sorted(rocks, key=lambda ob: ob.name):
        clear(rock)
        surface = Surface(rock)
        sites = growth_sites(rock, surface, scene)
        rock["formation_growth_sites"] = json.dumps(sites)
        pieces = []
        if rock.formation_attachment == "FLOOR":
            pieces += surface_moss(rock, surface, sites, scene, mats["surface"])
            pieces += sprigs(rock, sites, scene, mats["sprig"], atlas)
        pieces += hanging_moss(rock, surface, sites, scene, mats["hanging"], strands)
        rock["formation_growth_hash"] = growth_hash(rock)
        report[rock.name] = len(pieces)
    bpy.context.view_layer.update()
    return report
