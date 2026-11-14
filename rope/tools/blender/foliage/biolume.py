"""Solid cave plants, in world metres. One mesh/material per cluster.

UV.x is a baked emission weight, sampled through a tiny packed ramp image;
unlike a shader-only vertex attribute, this survives glTF without a bake.
Body colours are COLOR_0. Nothing here adds lights or gameplay vine objects.
"""

import math

import bpy
import numpy as np
from mathutils import Vector

from .geometry import Builder
from .stampbrush.lod import circle_segments
from .surface import DOWN, UP, rand, tangent_on

KINDS = {"MUSHROOM", "ORBS"}
GENERATED_BY = "tools/blender/foliage/biolume.py"


class GrowthError(Exception):
    pass


def uv(weight):
    return ((0.5 + 63 * max(0.0, min(1.0, weight))) / 64, 0.5)


def tube(b, path, radius, colour, glow=0.0, sides=6, tip=0.3):
    start = len(b)
    b.tube(path, radius, lambda _t: colour, sides=sides, tip=tip)
    b.uv[start:] = [uv(glow)] * (len(b) - start)


def append(dst, src):
    offset = len(dst)
    dst.pos.extend(src.pos)
    dst.nrm.extend(src.nrm)
    dst.col.extend(src.col)
    dst.uv.extend(src.uv)
    dst.tri.extend(tuple(offset + i for i in t) for t in src.tri)


def cap(b, centre, axis, aim, radius, dome, colour, shelf=False, seed=0, detail=0.7, variation=0.7):
    """Two radial skins and a luminous rolled rim. Shelves are 160-degree fans."""
    forward = tangent_on(aim, axis)
    side = forward.cross(axis).normalized()
    tolerance = b.tolerance
    segments = circle_segments(radius, tolerance / 2, 48, 8, math.pi * 0.88 if shelf else math.tau)
    rings = circle_segments(max(radius, dome), tolerance / 2, 10, 3, math.pi / 2)
    # Fine raised gills/flecks collapse into the broad skin appearance.
    gills_visible = tolerance < radius * 0.009
    flecks_visible = tolerance < radius * 0.032
    fine = max(0.0, 1 - tolerance / max(radius * 0.018, 1e-9))
    # Projected gill strips occupy this share of the underside. Folding their
    # mean emission into the skin avoids losing the glow with the geometry.
    gill_coverage = min(1.0, 25 * (2 * 0.009) * 0.88 / (math.pi * (0.44 if shelf else 1)))
    gill_mean = sum(0.25 + 0.35 * rand(seed, j, 6) for j in range(25)) / 25
    underside_glow = 0.08 if gills_visible else 0.08 + gill_coverage * (gill_mean - 0.08)
    colour_detail = max(0.0, 1 - tolerance / max(radius * 0.1, 1e-9))
    phase = rand(seed, 0, 5) * math.tau
    oval = 1 - variation * rand(seed, 2, 5) * 0.22
    profile = 0.55 + rand(seed, 3, 5) * variation * 1.2
    angles = [(-0.44 * math.pi + 0.88 * math.pi * j / segments) if shelf
              else 2 * math.pi * j / segments for j in range(segments + 1)]

    def point(r, a, underside=False):
        h = dome * max(0, 1 - r * r) ** profile
        # Interior folds fade out completely before the continuous smooth rim.
        h += radius * detail * fine * 0.018 * math.sin(a * 24 + phase) * r * (1 - r) ** 2
        if underside and shelf:
            # A fleshy bracket: the rounded top rises above a shallow belly,
            # rather than both skins following the same thin sheet.
            h = h * 0.18 - radius * (0.075 + 0.07 * math.sin(math.pi * r))
        elif underside:
            h -= radius * (0.045 + 0.055 * (1 - r))
        return centre + (forward * math.cos(a) + side * math.sin(a) * oval) * radius * r + axis * h

    cap_start = len(b)
    for underside in (False, True):
        offset = len(b)
        for k in range(rings + 1):
            r = max(0.008, k / rings)
            for a in angles:
                bands = math.sin(r * (30 if shelf else 16) + phase + math.sin(a * 3) * 0.6)
                mottle = math.sin(a * 11 + r * 22 + phase) * math.sin(a * 7 - r * 15)
                tone = 0.65 + 0.65 * r + detail * colour_detail * (0.23 * bands + 0.2 * mottle)
                c = tuple(min(1.0, v * tone * (0.65 if underside else 1)) for v in colour)
                b.vertex(point(r, a, underside), uv(underside_glow if underside else 0.0), c)
        before = len(b.tri)
        # Closed skins and rim must share every boundary vertex. Counts were
        # chosen before generation; do not independently simplify this grid.
        b.tolerance = 0.0
        b.grid(offset, rings, segments)
        b.tolerance = tolerance
        if underside:
            b.tri[before:] = [tuple(reversed(t)) for t in b.tri[before:]]
    if shelf:
        # Close the entire perimeter, including both rear edges and the tiny
        # inner arc. A shelf is a solid bracket, not an open pair of skins.
        stride = segments + 1
        skin = (rings + 1) * stride
        boundary = [rings * stride + j for j in range(stride)]
        boundary += [k * stride + segments for k in range(rings - 1, -1, -1)]
        boundary += list(range(segments - 1, -1, -1))
        boundary += [k * stride for k in range(1, rings)]
        for a, c in zip(boundary, boundary[1:] + boundary[:1]):
            a, c = cap_start + a, cap_start + c
            b.tri.extend(((a, a + skin, c), (c, a + skin, c + skin)))
    rim = [point(1, a) - axis * radius * 0.015 for a in angles]
    tube(b, rim, radius * 0.019, (0.7, 0.85, 0.55), 1.0, tip=1.0)
    # Raised radial gills live below the cap, not painted onto its top.
    for j, a in enumerate(angles[::2] if gills_visible else []):
        path = [point(r, a, True) - axis * radius * 0.006 for r in (0.1, 0.3, 0.55, 0.8, 0.98)]
        tube(b, path, radius * 0.009, colour, 0.25 + 0.35 * rand(seed, j, 6))
    # Small raised cap flecks; the larger silhouette and bands remain legible
    # at gameplay scale, the flecks reward a closer view.
    for j in range(int(32 * detail) if flecks_visible else 0):
        r = 0.2 + 0.7 * math.sqrt(rand(seed, j, 8))
        a = angles[0] + (angles[-1] - angles[0]) * rand(seed, j, 9)
        p = point(r, a) + axis * radius * 0.012
        size = radius * (0.012 + 0.02 * rand(seed, j, 10))
        offset = len(b)
        tint = tuple(min(1, v * 2.5 + 0.04) for v in colour)
        for k in range(6):
            t = math.tau * k / 6
            b.vertex(p + (forward * math.cos(t) + side * math.sin(t)) * size,
                     uv(0.15 + 0.25 * rand(seed, j, 11)), tint)
        for k in range(1, 5):
            b.tri.append((offset, offset + k + 1, offset + k))


def bulb(b, centre, axis, radius, colour, root, root_normal, bend, detail=0.7, stretch=1.15):
    """A single neck-to-bulb skin. A curved cubic neck matches the shoulder's
    position and tangent, so neither geometry nor shading has an attached-ball seam.
    """
    x = tangent_on(Vector((1, 0, 0)), axis)
    y = axis.cross(x).normalized()
    segments = circle_segments(radius * 1.08, b.tolerance / 2, 40, 8)
    neck_rings = circle_segments(max(radius, (centre-root).length), b.tolerance / 2, 12, 4, math.pi / 2)
    body_rings = circle_segments(radius * stretch, b.tolerance / 2, 22, 6, math.pi)
    rib_detail = max(0.0, 1 - b.tolerance / max(radius * (0.025 + detail * 0.045), 1e-9))
    stride = segments + 1
    ribs = 6
    pear = 0.025
    join = 0.43  # blend into the upper shoulder, retaining more of the round bulb

    def body_radius(t):
        return radius * max(0, math.sin(t)) ** 0.9 * (1 - pear * math.cos(t))

    shoulder = centre + axis * (radius * stretch * math.cos(join))
    span = (shoulder - root).length
    # End derivative follows the sphere's meridian exactly; the root starts
    # along the attachment normal, keeping its first ring flush with the rock.
    speed = 0.75
    end_delta = -axis * radius * stretch * math.sin(join) * speed
    dr = (body_radius(join + 0.0001) - body_radius(join - 0.0001)) / 0.0002 * speed
    controls = (root, root + root_normal * span * 0.4 + bend,
                shoulder - end_delta / 3, shoulder)
    radii = (radius * 0.23, radius * 0.11, body_radius(join) - dr / 3, body_radius(join))

    def cubic(values, u):
        return values[0] * (1-u)**3 + values[1] * (3*u*(1-u)**2) + values[2] * (3*u*u*(1-u)) + values[3] * u**3

    def frame_at(u):
        if u <= 1:
            p = cubic(controls, u)
            rr = cubic(radii, u)
            # Fade from the host tangent plane into the bulb's cross-section.
            up = (-root_normal).lerp(axis, u * u * (3 - 2*u)).normalized()
            xx = tangent_on(x, up)
            yy = up.cross(xx).normalized()
            return p, rr, xx, yy
        t = join + (u - 1) * speed
        return centre + axis * radius * stretch * math.cos(t), body_radius(t), x, y

    def surface(u, a):
        p, rr, xx, yy = frame_at(u)
        blend = min(1, max(0, u))
        blend = blend * blend * (3 - 2 * blend)
        rib = 1 + blend * rib_detail * (0.025 + detail * 0.045) * math.cos(ribs * a)
        return p + (xx * math.cos(a) + yy * math.sin(a)) * rr * rib

    top = b.vertex(root, uv(0.0), colour, -root_normal)
    start = len(b)
    samples = [k / neck_rings for k in range(neck_rings + 1)]
    samples += [1 + ((math.pi - join) * k / body_rings) / speed for k in range(1, body_rings)]
    for u in samples:
        t = join + (u - 1) * speed if u > 1 else join * u ** 3
        for j in range(stride):
            a = 2 * math.pi * j / segments
            du = surface(u + 0.0001, a) - surface(u - 0.0001, a)
            da = surface(u, a + 0.0001) - surface(u, a - 0.0001)
            b.vertex(surface(u, a), (0.1 + 0.8 * j / segments, 0.1 + 0.8 * t / math.pi),
                     colour, du.cross(da).normalized())
    bottom = b.vertex(centre - axis * radius * stretch, uv(0.05), colour)
    for j in range(segments):
        nj = j + 1
        b.tri.append((top, start + j, start + nj))
        for k in range(len(samples) - 1):
            a, c = start + k * stride + j, start + k * stride + nj
            b.tri.extend(((a, a + stride, c), (c, a + stride, c + stride)))
        end = start + (len(samples) - 1) * stride
        b.tri.append((end + j, bottom, end + nj))


def grow(surface, root, normal, direction, s, scale, avoid, tolerance=0.0):
    hit = surface.nearest(root, 0.15 * max(scale, 0.1))
    if hit is None:
        raise GrowthError("Root is off its host; use Snap to Surface")
    # Surface.nearest's separating vector is useful for clearance, but tiny
    # tangential float errors at a point ON a face are not an attachment normal.
    hit_normal = surface.bvh.find_nearest(hit.point)[1]
    if s.kind == "ORBS" and hit_normal.z > 0.2:
        raise GrowthError("Place pendant orbs on an underside or an overhang")
    root = hit.point
    normal = normal.normalized()
    aim = tangent_on(direction, normal)
    side = aim.cross(normal).normalized()
    out = Builder(tolerance)
    accepted = []
    count = 0
    colour = tuple(s.body_color)
    # A bounded number of placement attempts. A crowded patch grows fewer parts.
    for i in range(s.cluster_count * 12):
        if count >= s.cluster_count:
            break
        a = rand(s.seed, i, 1) * math.tau
        d = math.sqrt(rand(s.seed, i, 2)) * s.cluster_radius * scale
        q = root + (aim * math.cos(a) + side * math.sin(a)) * d
        h = surface.nearest(q, max(0.05 * scale, s.cluster_radius * scale * 0.75))
        if h is None:
            continue
        n = surface.bvh.find_nearest(h.point)[1]
        if n.dot(hit_normal) < 0.5:
            continue
        p = h.point + n * (0.004 * scale)
        f = 1 + s.bio_variation * (2 * rand(s.seed, i, 3) - 1)
        r = s.bio_size * scale * f
        height = s.bio_height * scale * (1 + s.bio_variation * (2 * rand(s.seed, i, 14) - 1))
        member_seed = int(rand(s.seed, i, 20) * 2147483647)
        shape = s.shape_variation
        tint = 1 + shape * (rand(s.seed, i, 21) - 0.5) * 0.6
        member_colour = tuple(min(1, v * tint) for v in colour)
        if any((p - old).length < r + old_r for old, old_r in accepted):
            continue
        b = Builder(tolerance)
        if s.kind == "ORBS":
            if n.z > 0.2:
                continue
            axis = (DOWN * 0.7 + n * 0.3 + side * (rand(s.seed, i, 22) - 0.5) * shape * 0.25).normalized()
            stalk = 2 * r * s.orb_stalk * (1 - shape * rand(s.seed, i, 23) * 0.65)
            stretch = 1.02 + shape * (rand(s.seed, i, 24) - 0.5) * 0.12
            neck = p + n * (r * 0.3) + axis * stalk
            bulb(b, neck + axis * (r * stretch), -axis, r, member_colour,
                 h.point, n, aim * r * shape * 0.25, s.surface_detail, stretch)
        elif s.kind == "MUSHROOM":
            if s.mushroom_form == "SHELF":
                # Horizontal shelf projecting from the attachment's outward normal.
                axis = UP if abs(n.z) < 0.85 else n
                outward = tangent_on(n if abs(n.z) < 0.85 else aim, axis)
                centre = p + n * r * 0.06
                dome = r * s.cap_dome * (0.9 + shape * (rand(s.seed, i, 27) - 0.5) * 0.5)
                cap(b, centre, axis, outward, r, dome, member_colour, shelf=True,
                    seed=member_seed, detail=s.surface_detail, variation=shape)
            else:
                axis = (UP * 0.7 + n * 0.3).normalized()
                centre = p + n * r * 0.4 + axis * height
                bend = (aim * math.cos(a) + side * math.sin(a)) * r * shape * 0.8
                centre += bend * 0.7
                stem = [p, p + n * r * 0.15]
                stem += [p.lerp(centre, t) + bend * math.sin(t * math.pi) for t in (0.2, 0.4, 0.6, 0.8, 1)]
                tube(b, stem, r * (0.10 + 0.04 * rand(s.seed, i, 25)), member_colour, tip=0.5, sides=8)
                cap_axis = (axis + bend.normalized() * shape * (rand(s.seed, i, 26) - 0.5) * 0.6).normalized()
                dome = r * s.cap_dome * (1 + shape * (rand(s.seed, i, 27) * 2 - 0.6))
                cap(b, centre, cap_axis, aim, r, dome, member_colour,
                    seed=member_seed, detail=s.surface_detail, variation=shape)
        # Check the actual geometry, not just the anchor; avoid burying caps/bulbs.
        if avoid.hits_any(b.pos):
            continue
        if any((contact := surface.nearest(v)) is not None and contact.signed < -0.002 * scale for v in b.pos):
            continue
        append(out, b)
        accepted.append((p, r * 1.1))
        count += 1
    if not count:
        raise GrowthError("No room to grow here; reduce Size or move the attachment")
    return out, {"parts": count, "leaves": 0}


def orb_paint():
    """Broad softly shaded lobes and a luminous centre, matching the approved
    lantern-pod reference. No mottled spots or hard dark rib lines. The atlas
    margins are reserved for the short non-emissive necks.
    """
    h, w = 128, 256
    yy, xx = np.mgrid[0:h, 0:w]
    u = ((xx + 0.5) / w - 0.1) / 0.8
    v = ((yy + 0.5) / h - 0.1) / 0.8
    lobes = 0.5 + 0.5 * np.cos(u * math.tau * 6)
    field = 0.20 + 0.40 * lobes ** 0.7
    silhouette = np.sin(np.clip(v, 0, 1) * math.pi) ** 0.8
    region = (u >= -0.025) & (u <= 1.025) & (v >= -0.025) & (v <= 1.025)
    # A painted inner glow under a darker saturated membrane. This is a
    # stylized translucency cue, not alpha blending or screen-space transmission.
    core = np.abs(np.sin(u * math.tau)) ** 0.8 * silhouette ** 1.5 * region
    weight = (0.015 + field * 0.65 * silhouette + 0.28 * core) * region
    base = np.ones((h, w, 3), dtype=np.float64)
    base[region] = np.repeat((0.72 + 0.28 * lobes)[..., None], 3, axis=2)[region]
    return np.clip(base, 0, 1), weight, core


def packed_image(name, rgb):
    h, w = rgb.shape[:2]
    img = bpy.data.images.get(name)
    if img is None:
        img = bpy.data.images.new(name, w, h, alpha=False)
    elif tuple(img.size) != (w, h):
        img.scale(w, h)
    pixels = np.ones((h, w, 4), np.float32)
    pixels[..., :3] = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * rgb ** (1 / 2.4) - 0.055)
    img.pixels.foreach_set(pixels.ravel())
    img["generated_by"] = GENERATED_BY
    img.pack()
    return img


def material(ob, tolerance=0.0, scale=1.0):
    """Per-plant editable material; reuse its datablocks on every live rebuild."""
    name = f"Cave Foliage · {ob.name}"
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.8
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.0 if ob.foliage.kind == "ORBS" else 0.15
    bsdf.inputs["Emission Strength"].default_value = ob.foliage.glow_strength
    mat.use_backface_culling = False
    tint = nt.nodes.get("body colour")
    if tint is None:
        tint = nt.nodes.new("ShaderNodeVertexColor")
        tint.name = "body colour"
        tint.layer_name = "Col"
        nt.links.new(tint.outputs["Color"], bsdf.inputs["Base Color"])
    if ob.foliage.kind == "ORBS":
        base, weight, core = orb_paint()
        factor = 1
        # Largest possible bulb: retain its circumference at the DOF budget.
        pitch = math.tau * ob.foliage.bio_size * scale * (1 + ob.foliage.bio_variation) / (256 * 0.8)
        while factor < 8 and pitch * factor * 2 <= tolerance:
            factor *= 2
        if factor > 1:
            def reduce(a):
                h, w = a.shape[:2]
                return a.reshape(h // factor, factor, w // factor, factor, *a.shape[2:]).mean(axis=(1, 3))
            base = reduce(base)
            # Average the final coloured emission below, not just its factors.
        else:
            reduce = lambda a: a
        paint = nt.nodes.get("orb paint")
        if paint is None:
            paint = nt.nodes.new("ShaderNodeTexImage")
            paint.name = "orb paint"
            mix = nt.nodes.new("ShaderNodeMix")
            mix.name = "paint tint"
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            inputs = {i.identifier: i for i in mix.inputs}
            inputs["Factor_Float"].default_value = 1.0
            nt.links.new(paint.outputs["Color"], inputs["A_Color"])
            nt.links.new(tint.outputs["Color"], inputs["B_Color"])
            nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
        paint.image = packed_image(name + ".paint", base)
    else:
        weight = np.broadcast_to(np.linspace(0, 1, 64)[None, :], (4, 64))
        core = np.zeros_like(weight)
    tint_rgb = np.array(ob.foliage.glow_color)
    tint_rgb = tint_rgb + (1 - tint_rgb) * core[..., None] ** 2 * 0.28
    rgb = weight[..., None] * tint_rgb
    if ob.foliage.kind == "ORBS":
        rgb = reduce(rgb)
    img = packed_image(name + ".emission", rgb)
    tex = nt.nodes.get("emission")
    if tex is None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.name = "emission"
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    tex.image = img
    tex.extension = "EXTEND"
    return mat
