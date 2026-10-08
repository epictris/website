"""A hanging vine: a stem that crawls over its rock from a root, follows the
surface downhill while it clings, lets go at an overhang or a steep side and
hangs, and carries painted leaves along its length.

A port of karin-lu's generateHangingVine (render3d/foliage/vine/hangingVine.ts
on the blender-background-editor branch, 2026-10-08), step for step and with
the same seeded hash, in Blender's z-up world. Lengths are metres."""

import math
from dataclasses import dataclass

from mathutils import Quaternion, Vector

from . import library
from .geometry import Builder, card_uv
from .surface import DOWN, NO_AVOID, UP, jround, rand, smoothstep, tangent_on


@dataclass
class VineParams:
    length: float = 0.85
    radius: float = 0.008
    cling: float = 0.40
    bend: float = 0.55
    leaf_spacing: float = 0.14
    leaf_size: float = 0.10
    leaf_angle: float = 58.0
    variation: float = 0.35
    seed: int = 1701
    natural: bool = True
    paint_tint: float = 0.6
    leaves: tuple = ()  # the pieces to pick from (library.Piece)
    shades: tuple = (True,) * 6


class VineError(ValueError):
    pass


class Obstacle:
    """Something a leaf must not pass through: a stem sphere, or a placed leaf
    (its bounding sphere and its card's frame, for a near enough "is this
    point inside that leaf's blade" test)."""

    __slots__ = ("centre", "radius", "card_centre", "axis", "width", "face", "half_length", "half_width", "points")

    def __init__(self, centre, radius, leaf=None):
        self.centre = centre
        self.radius = radius
        self.points = None
        if leaf is not None:
            self.card_centre, self.axis, self.width, self.face, self.half_length, self.half_width, self.points = leaf


def _inside_blade(pts, card, thickness):
    n = 0
    for p in pts:
        rel = p - card.card_centre
        x = rel.dot(card.width) / card.half_width
        y = rel.dot(card.axis) / card.half_length
        if x * x + y * y < 0.8 and abs(rel.dot(card.face)) < thickness:
            n += 1
    return n


def _leaf_obstacle(vertices, base, axis, width, face, size, piece):
    centre = base + axis * ((0.5 - piece.base_uv[1]) * size) + width * ((0.5 - piece.base_uv[0]) * size * piece.aspect)
    half_length, half_width = size / 2.0, size * piece.aspect / 2.0
    return Obstacle(centre, math.hypot(half_length, half_width) * 1.05,
                    (centre, axis.copy(), width.copy(), face.copy(), half_length, half_width, vertices))


def _collides(cand, other, size):
    if (cand.centre - other.centre).length > cand.radius + other.radius:
        return False
    if other.points is None:
        return any((p - other.centre).length < other.radius for p in cand.points)
    thick = max(size, other.half_length * 2.0) * 0.13
    return _inside_blade(cand.points, other, thick) >= 2 or _inside_blade(other.points, cand, thick) >= 2


def grow(surface, root, normal, direction, p, avoid=NO_AVOID):
    """Grow the vine from `root` (a world point on or near the surface), with
    the surface `normal` there and the crawl `direction`. Returns (builder,
    stats). Raises VineError when it cannot."""
    clearance = p.radius + 0.002
    step = min(0.035, max(0.012, p.radius * 2.0))
    anchor = surface.nearest(root)
    if anchor is None or anchor.distance > max(0.1, p.radius * 4.0):
        raise VineError("the root is off its host: move it back onto the surface")
    normal = normal.normalized()
    # The given normal settles an anchor exactly on an edge.
    if normal.dot(anchor.normal) < -0.1:
        normal = anchor.normal.copy()
    current = surface.project(anchor.point + normal * clearance, clearance)
    direction = tangent_on(direction.normalized(), normal)
    points, normals, supported = [current.copy()], [normal.copy()], [True]
    hanging, length, release = False, 0.0, -1
    phase = rand(p.seed, 0, 91) * math.pi * 2.0
    max_steps = math.ceil(p.length / step) * 5 + 100
    i = 0
    while length < p.length - 1e-7 and i < max_steps:
        i += 1
        ds = min(step, p.length - length)
        contact = False
        if not hanging:
            downhill = tangent_on(DOWN, normal)
            slope = math.sqrt(max(0.0, 1.0 - normal.z * normal.z))
            side = direction.cross(normal).normalized()
            wander = math.sin(length * 3.7 + phase) * 0.10 * p.variation
            direction = tangent_on(direction + downhill * (ds * slope * 1.4) + side * (ds * wander), normal)
        else:
            soft = 0.06 + p.bend * 0.24
            direction = direction.lerp(DOWN, min(0.35, ds / soft))
            direction.x += math.sin(length * 2.4 + phase) * ds * 0.07 * p.variation
            direction.y -= math.sin(length * 3.1 + phase * 0.7) * ds * 0.05 * p.variation
            direction.normalize()
        nxt = current + direction * ds
        hit = surface.nearest(nxt, clearance + ds * 1.5)
        if (not hanging and hit is not None and hit.normal.z >= -0.65 * p.cling
                and hit.normal.dot(normal) > -0.35 and hit.distance < clearance + ds * (0.5 + p.cling)):
            # Follow a local connected surface; a side or an undercut lets go at low cling.
            if hit.normal.z < 0.30 - p.cling * 0.75 and direction.z < -0.2:
                hanging = True
            else:
                normal = hit.normal.copy()
                nxt = hit.point + normal * clearance
                contact = True
        elif not hanging:
            hanging = True
        if hanging and release < 0:
            release = len(points)
        nxt = surface.project(nxt, clearance)
        # The projections also round a sharp lip. The whole segment is tested,
        # since its ends alone miss thin ledges and corners.
        for _ in range(5):
            mid = current.lerp(nxt, 0.5)
            projected = surface.project(mid, clearance)
            if (projected - mid).length_squared < 1e-12:
                break
            nxt = surface.project(nxt + (projected - mid) * 2.0, clearance)
        if not surface.clear(current, nxt, clearance * 0.95):
            # A difficult hollow: a smaller step forward, never a jump through
            # the rock or onto its other side.
            nxt = surface.project(current + direction * (ds * 0.25), clearance * 1.08)
            if not surface.clear(current, nxt, clearance * 0.9):
                raise VineError("the vine is trapped in a narrow crevice: move its root or turn it a little")
        advance = (current - nxt).length
        if advance < ds * 0.03:
            hanging = True
            direction = (direction + normal * 0.3).normalized()
            continue
        if advance > p.length - length:
            nxt = current.lerp(nxt, (p.length - length) / advance)
            advance = p.length - length
        actual = (nxt - current).normalized()
        direction = direction.lerp(actual, 0.65).normalized()
        near = surface.nearest(nxt, clearance * 1.5)
        if near is not None:
            normal = near.normal.copy()
            contact = contact or near.signed < clearance * 1.3
        else:
            # Carry the outward direction along without flipping it.
            normal = tangent_on(normal, direction)
        points.append(nxt.copy())
        normals.append(normal.copy())
        supported.append(contact)
        current = nxt
        length += advance
    if length < p.length - 0.001:
        raise VineError("the vine cannot reach its length on this surface")

    out = Builder()
    along = [0.0]
    for k in range(1, len(points)):
        along.append(along[-1] + (points[k] - points[k - 1]).length)
    if p.natural:
        # Woody brown at the root, ripening to green, fresh green at the tip.
        wood, green, fresh = (library.hex_linear(h) for h in ("#5b4a33", "#4b6a30", "#6f9440"))

        def stem_colour(f):
            if f < 0.45:
                return _mix(wood, green, f / 0.45)
            return _mix(green, fresh, (f - 0.45) / 0.55)
    else:
        flat = library.hex_linear("#506237")

        def stem_colour(_f):
            return flat
    out.tube(points, p.radius, stem_colour)
    obstacles = []
    # The stem as a chain of spheres (every ~6 cm), so leaves keep off it.
    last = -1
    for k in range(len(points)):
        if last >= 0 and along[k] - along[last] < 0.06:
            continue
        obstacles.append(Obstacle(points[k].copy(), p.radius * 1.8 + 0.01))
        last = k
    count = _leaves(out, points, normals, supported, along, surface, p, avoid, obstacles)
    return out, {"leaves": count, "length": length, "release": release, "points": len(points)}


def _mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


TINT_SCALE = 0.62  # tinted silhouettes, as the scene's lights and exposure want them
PAINT_SCALE = 0.6  # painted leaves, already shaded in their paint


def _leaves(out, points, normals, supported, along, surface, p, avoid, obstacles):
    total = along[-1]
    pool = list(p.leaves) or list(library.LEAVES)
    shades = library.shades(p.shades)
    ordered = library.by_light(shades)
    natural = p.natural
    cols, rows = (4, 5) if natural else (2, 4)
    stalk_colour = library.hex_linear("#5f8a3a")
    stalks = []
    placed = []
    state = {"segment": 1, "count": 0}

    def build_leaf(key, target, side_sign, size_mul):
        def r(salt):
            return rand(p.seed, key, salt)

        piece = pool[int(r(7) * len(pool)) % len(pool)]
        seg = state["segment"]
        while seg < len(along) - 1 and along[seg] < target:
            seg += 1
        state["segment"] = seg
        t = (target - along[seg - 1]) / (along[seg] - along[seg - 1])
        root = points[seg - 1].lerp(points[seg], t)
        tangent = (points[seg] - points[seg - 1]).normalized()
        outward = tangent_on(normals[seg - 1].lerp(normals[seg], t), tangent)
        side = tangent.cross(outward).normalized() * side_sign
        age = min(1.0, target / max(total, 1e-6))
        hanging = not supported[seg]
        angle = math.radians(p.leaf_angle + (r(1) - 0.5) * 28.0 * p.variation)
        size = size_mul * p.leaf_size * piece.scale * (0.80 + r(4) * 0.35 * p.variation) * (0.5 + 0.5 * min(1.0, (total - target) / 0.5))
        if natural:
            # Older leaves near the root are larger, young ones at the tip smaller.
            size *= 1.15 - 0.45 * age ** 1.2
            # Stalks leave the stem sideways and a little out, away from the rock.
            stalk_out = (side * math.sin(angle) + outward * (0.55 + 0.25 * r(2))).normalized()
            petiole = size * (0.25 + 0.30 * r(9) * (0.5 + p.variation))
            if hanging:
                # Gravity: the blade droops tip down, its face turned out to the light.
                droop = 0.62 + (r(10) - 0.5) * 0.35 * p.variation
                axis = stalk_out.lerp(DOWN, droop).normalized()
                face = tangent_on(outward + stalk_out * 0.4 + side * ((r(3) - 0.5) * 0.6 * p.variation), axis)
            else:
                # On the rock the blade lies close to it, leaning a little downhill.
                axis = tangent * math.cos(angle) + side * math.sin(angle)
                axis = (axis + tangent_on(DOWN, outward) * 0.25 + outward * 0.12).normalized()
                face = tangent_on(outward + side * ((r(3) - 0.5) * 0.4 * p.variation), axis)
        else:
            axis = tangent * math.cos(angle) + side * math.sin(angle)
            # Supported leaves lift clear of the surface; hanging ones turn about the stem.
            axis = (axis + outward * (0.55 if supported[seg] else 0.18 + (r(2) - 0.5) * p.variation)).normalized()
            face = outward + side * ((r(3) - 0.5) * 0.7 * p.variation)
            stalk_out = axis.copy()
            petiole = size * 0.16
        # The blade's curve: cupped across the midrib, arched along it, the tip curling back.
        cup = (0.10 + 0.08 * r(11) * p.variation) if natural else 0.0
        arch = (0.05 + 0.05 * r(12)) if natural else 0.0
        curl = (0.08 + 0.10 * r(13) * (0.5 + p.variation)) if natural else 0.0
        ok, cand = False, None
        base = ctrl = root
        width = Vector()
        vertices = []
        for attempt in range(8):
            face = tangent_on(face, axis)
            width = axis.cross(face).normalized()
            base = root + stalk_out * petiole + outward * p.radius
            # The stalk arches: up and out before the blade falls (hanging), or off the rock (crawling).
            lift_dir = (UP if hanging else outward) if natural else stalk_out
            ctrl = root + stalk_out * (petiole * 0.45) + lift_dir * (petiole * 0.35 if natural else 0.0)
            if natural and hanging:
                base = base + UP * (petiole * 0.15)
            vertices = []
            for row in range(rows + 1):
                v = row / rows
                for col in range(cols + 1):
                    u = col / cols
                    across = 2.0 * u - 1.0
                    if natural:
                        lift = cup * across * across + arch * math.sin(v * math.pi) - curl * (max(0.0, v - 0.55) / 0.45) ** 2
                    else:
                        lift = (0.045 if col == 1 else 0.0) * math.sin(v * math.pi)
                    vertices.append(base + axis * ((v - piece.base_uv[1]) * size)
                                    + width * ((u - piece.base_uv[0]) * size * piece.aspect) + face * (lift * size))
            rock_clear = all(_off_rock(surface, q, size) for q in vertices) and surface.clear(root, base, p.radius * 0.2)
            # Leaves keep out of this vine's other leaves and stem, and out of other plants.
            leaf_clear = True
            if natural and rock_clear:
                cand = _leaf_obstacle(vertices, base, axis, width, face, size, piece)
                leaf_clear = not any(_collides(cand, other, size) for other in placed) and not avoid.hits_any(vertices)
            if rock_clear and leaf_clear:
                ok = True
                break
            if not rock_clear:
                axis = (axis + outward * 0.55).normalized()
                size *= 0.86
            else:
                # Swing the leaf about the stem, alternating sides, a little smaller.
                sign = -1.0 if attempt % 2 else 1.0
                axis = (Quaternion(tangent, sign * 0.5 * (1.0 + attempt * 0.3)) @ axis).normalized()
                stalk_out = (Quaternion(tangent, sign * 0.35) @ stalk_out).normalized()
                size *= 0.92
        if not ok:
            return False
        if natural:
            # By age: dark mature greens at the root, fresh light ones at the tip, with some spread.
            spread = (r(8) - 0.5) * len(ordered) * 0.45 * (0.4 + p.variation)
            k = jround(age * (len(ordered) - 1) + spread)
            shade = ordered[min(len(ordered) - 1, max(0, k))]
        else:
            shade = shades[int(r(8) * len(shades)) % len(shades)]
        scale = TINT_SCALE
        if piece.keep_colour:
            # A painted leaf keeps its colours; Paint Tint shifts its average toward
            # the chosen green, keeping its painted light and dark.
            if p.paint_tint > 0.0:
                avg = piece.avg or library.hex_linear("#7aa744")
                ratio = tuple(s / max(a, 1e-3) for s, a in zip(shade, avg))
                shade = _mix((1.0, 1.0, 1.0), ratio, p.paint_tint)
            else:
                shade = (1.0, 1.0, 1.0)
            scale = PAINT_SCALE * (0.9 + 0.16 * age if natural else 1.0)
        tone = (0.92 + r(5) * 0.16 * (0.4 + p.variation)) * scale
        offset = len(out)
        for idx, q in enumerate(vertices):
            col, row = idx % (cols + 1), idx // (cols + 1)
            f = 1.0
            if natural:
                # Inside the leaf: darker at the base, a lighter midrib, a slightly darker rim.
                v, across = row / rows, abs(2.0 * col / cols - 1.0)
                f = (0.86 + 0.20 * smoothstep(v, 0.0, 0.6)) * (1.08 if col * 2 == cols else 1.0) * (1.0 - 0.07 * across * across)
            out.vertex(q, card_uv(piece, col / cols, row / rows), tuple(c * tone * f for c in shade))
        out.grid(offset, rows, cols)
        # The stalk: a short quadratic curve root -> ctrl -> base.
        stalks.append([root * ((1 - s) * (1 - s)) + ctrl * (2 * s * (1 - s)) + base * (s * s) for s in (k / 4 for k in range(5))])
        ob = cand if cand is not None else _leaf_obstacle(vertices, base, axis, width, face, size, piece)
        placed.append(ob)
        obstacles.append(ob)
        state["count"] += 1
        return True

    node, target = 0, p.leaf_spacing * 0.55
    while target < total - 0.045:
        def r(salt, node=node):
            return rand(p.seed, node, salt)

        side_sign = -1.0 if node % 2 else 1.0
        if natural:
            # An uneven rhythm: now and then a leaf missing, now and then a pair.
            if not r(20) < 0.08 + 0.08 * p.variation:
                build_leaf(node, target, side_sign, 1.0)
                if r(21) < 0.10 + 0.12 * p.variation:
                    build_leaf(node + 1_000_000, target, -side_sign, 0.78)
            gap = 1.7 if r(22) < 0.07 else 1.0
            target += p.leaf_spacing * gap * (1.0 + (r(6) - 0.5) * 0.9 * p.variation)
        else:
            build_leaf(node, target, side_sign, 1.0)
            target += p.leaf_spacing * (1.0 + (r(6) - 0.5) * 0.5 * p.variation)
        node += 1
    stalk_radius = p.radius * (0.32 if natural else 0.36)
    for path in stalks:
        out.tube(path, stalk_radius, lambda _f: stalk_colour)
    return state["count"]


def _off_rock(surface, q, size):
    hit = surface.nearest(q, size)
    return hit is None or hit.signed >= 0.002
