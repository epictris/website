"""A fern: a clump of fronds sprouting from one crown in a crack or on a ledge.

A port of karin-lu's generateFern (render3d/foliage/vine/fern.ts on the
blender-background-editor branch, 2026-10-08), step for step and with the
same seeded hash, in Blender's z-up world. Lengths are metres.

A clump is a rosette of fronds round an axis tilted toward the open side
(Lean). Each frond arches up out of the crown and droops toward its tip; outer
fronds are placed first, lowest, and younger ones find a layer above them, so
fronds settle into layers instead of slicing through each other, and every
frond bends, turns or shortens until it clears the rock. Croziers (coiled
young fronds) stand upright in the middle as two crossed cards. Normals lean
toward a dome round the crown, so the clump shades as one soft mass.

Three varieties share all of that:
- PAINTED: each frond one painted card from the fern sheet, folded down its midrib;
- LEAFLET: each frond a real compound leaf, a tapered stem (the rachis) with
  pairs of leaflet stems, each with pairs of tiny painted leaves and one at
  its tip; with Tiny Leaves at 0 the leaves sit straight on the rachis;
- SPRIG: painted sprigs set at an angle along one stem, like louvres: a bush."""

import math
from dataclasses import dataclass

from mathutils import Quaternion, Vector

from . import library
from .geometry import Builder, card_uv
from .surface import DOWN, NO_AVOID, UP, X_AXIS, clamp, jround, rand, sign, smoothstep, tangent_on


@dataclass
class FernParams:
    variety: str = "PAINTED"  # PAINTED, LEAFLET or SPRIG
    fronds: int = 18
    length: float = 0.45
    length_var: float = 0.3
    droop: float = 0.55
    spread: float = 50.0  # degrees
    lean: float = 0.55
    fold: float = 0.55
    twist: float = 0.3
    croziers: int = 2
    paint_tint: float = 0.6
    seed: int = 4242
    pinnae: int = 12
    leaflets: int = 0
    leaf_size: float = 0.8
    leaf_curve: float = 0.5
    leaf_form: str = "SMOOTH"  # SMOOTH or CREASED
    mirror_pairs: bool = True
    leaf_variation: float = 0.3
    pieces: tuple = ()  # the fronds to pick from (library.Piece); empty is all
    shades: tuple = (True,) * 6


# What each variety starts from: applied when a fern switches variety or is
# reset (karin's varietyDefaults). The leaflet ones follow the stylised
# references: fewer, longer fronds of single leaves.
VARIETY_DEFAULTS = {
    "PAINTED": dict(fronds=18, length=0.45, spread=50.0, droop=0.55, fold=0.55),
    "LEAFLET": dict(fronds=9, length=0.55, spread=52.0, droop=0.42, pinnae=16, leaflets=0, leaf_size=0.8,
                    leaf_curve=0.5, leaf_form="SMOOTH", mirror_pairs=True, leaf_variation=0.3, fold=0.55),
    "SPRIG": dict(fronds=10, length=0.55, spread=55.0, droop=0.45, pinnae=8, leaflets=0, leaf_size=1.0,
                  leaf_curve=0.4, mirror_pairs=True, leaf_variation=0.3, fold=0.5),
}


class FernError(ValueError):
    pass


GOLDEN = math.pi * (3.0 - math.sqrt(5.0))  # 137.5 degrees
PAINT_SCALE = 0.6
CROWN_SKIP = 0.35  # fronds may touch in their lower third, near the crown, as real ones do
SPRIG_ROLL = 0.55  # how far each sprig is turned about its axis (radians), like a louvre slat
# Tiny leaves: angle from their leaflet stem; a stalk (fraction of the leaf)
# that tucks the base a little into the stem so it reads as joined.
TINY_ANGLE = 60.0
TINY_STALK = -0.03
PINNA_LEN = 0.2  # longest leaflet stem, as a fraction of the frond
# Tried in order when a frond would pass through one already placed: a change
# of angle (degrees), of turn (radians) and of length.
NUDGES = [(de, da, ln) for ln in (1.0, 0.8) for de in (0.0, -10.0, 10.0, -20.0, 20.0, -32.0) for da in (0.0, 0.25, -0.25, 0.5, -0.5)]
CROZIER_TURNS = (0.0, 0.25, -0.25, 0.5, -0.5)
# Leaf pairs only lie higher, tilt or turn a little, and at most shrink to
# 85 %, so leaf sizes stay even; all turn about the leaf's base, so a leaf
# always stays joined to its stem. [tilt up (rad), turn (rad), size, raise (stem radii)]
PAIR_VARIANTS = ((0, 0, 1, 0), (0, 0, 1, 0.8), (0.1, 0, 1, 0.8), (0.1, 0, 1, 0), (0.2, 0, 1, 0.8), (-0.1, 0, 1, 0.8),
                 (0.3, 0, 1, 0.8), (0, 0.12, 1, 0.8), (0, -0.12, 1, 0.8), (0.15, 0.12, 1, 0.8), (0.15, -0.12, 1, 0.8),
                 (0.1, 0, 0.85, 0.8), (0.25, 0, 0.85, 0.8), (0.2, 0.2, 0.85, 0.8), (0.2, -0.2, 0.85, 0.8))
SAMPLE_A = (0.04, 0.15, 0.27, 0.39, 0.5, 0.61, 0.73, 0.85, 0.96)
SAMPLE_X = (-1.0, -0.67, -0.33, 0.0, 0.33, 0.67, 1.0)
ROCK_SAMPLES = ((0.95, 0), (0.5, 0), (0.25, 0), (0.5, -0.9), (0.5, 0.9), (0.75, -0.8), (0.75, 0.8), (0.3, -0.8), (0.3, 0.8))
STEM_BASE, STEM_MID, STEM_TIP = (library.hex_linear(h) for h in ("#4e4a30", "#616f3c", "#74863f"))  # from the painted twig
CROWN_COLOUR = library.hex_linear("#3e3324")


def _mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def _scale(c, k):
    return tuple(x * k for x in c)


def _tint(shade, avg, amount):
    """White moved toward the ratio that takes a piece's average paint to `shade`."""
    ratio = tuple(s / max(a, 1e-3) for s, a in zip(shade, avg))
    return _mix((1.0, 1.0, 1.0), ratio, amount)


def _rotate(v, axis, angle):
    return Quaternion(axis, angle) @ v


class Frame:
    __slots__ = ("p", "T", "W", "F")

    def __init__(self, p, T, W, F):
        self.p, self.T, self.W, self.F = p, T, W, F


class Shape:
    """How wide a frond is: `reach(v)` its leafy half-width at height v (0 the
    crown, 1 the tip), `half` the widest it can be (the fold grows toward it);
    `lift` set for fronds whose sides rise in a V instead of folding down."""

    __slots__ = ("half", "reach", "lift")

    def __init__(self, half, reach, lift=None):
        self.half, self.reach, self.lift = half, reach, lift


class Placed:
    __slots__ = ("frames", "shape", "fold", "centre", "radius")

    def __init__(self, frames, shape, fold, bound):
        self.frames, self.shape, self.fold = frames, shape, fold
        self.centre, self.radius = bound


class LeafCard:
    """A placed tiny leaf: its stalk point, its frame (along, across, face), its
    card size and visible length, and its curve."""

    __slots__ = ("base", "dir", "wv", "n0", "size", "width", "left", "right", "len", "cup", "curl", "bend",
                 "prof_l", "prof_r", "centre", "radius", "_samples")


def _fold_angle(fold, edge, v):
    """Down the midrib: each half tilts down from the centre line, curling a
    little more toward the edge, so a frond is a ridge, not a flat card."""
    return fold * 0.95 * (0.6 + 0.8 * edge * edge) * min(1.0, v * 6.0 + 0.3)


def _card_size(piece, length, width_scale=1.0):
    size = length / max(0.5, 1.0 - piece.base_uv[1])
    width = size * piece.aspect * width_scale
    return width, width * max(piece.base_uv[0], 1.0 - piece.base_uv[0])


def _profile_at(piece, v):
    prof = piece.width_profile
    if not prof:
        return math.sin(math.pi * min(1.0, v * 1.1)) ** 0.6
    x = v * (len(prof) - 1)
    i = min(len(prof) - 2, math.floor(x))
    return prof[i] + (prof[i + 1] - prof[i]) * (x - i)


def _across(shape, fold, d, v):
    """Where a point `d` across a frond (signed, metres) sits: (across, up) in its W/F frame."""
    if shape.lift is not None:
        return d * math.cos(shape.lift), abs(d) * math.sin(shape.lift)
    th = _fold_angle(fold, abs(d) / shape.half, v)
    return sign(d) * abs(d) * math.cos(th), -abs(d) * math.sin(th)


def _bound(frames, half):
    """A sphere round the leafy part of a frond (above the crown zone), as
    three's Sphere.setFromPoints makes it (the box's centre), grown by `half`."""
    pts = [f.p for f in frames[math.floor((len(frames) - 1) * CROWN_SKIP):]]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    c = (lo + hi) * 0.5
    return c, max((p - c).length for p in pts) + half


class _Fern:
    def __init__(self, surface, root, normal, open_dir, p, avoid, quick):
        self.s = p
        self.surface = surface
        self.avoid = avoid
        self.quick = quick
        self.normal = normal.normalized()
        anchor = surface.nearest(root)
        if anchor is None or anchor.distance > 0.15:
            raise FernError("the crown is off its host: move it back onto the surface")
        self.crown = anchor.point + self.normal * 0.008
        # Lean: the open side, flattened onto the rock's tangent plane.
        self.open_t = tangent_on(open_dir, self.normal)
        self.tan_a = tangent_on(UP if abs(self.normal.z) < 0.9 else X_AXIS, self.normal)
        self.tan_b = self.normal.cross(self.tan_a).normalized()
        # The rosette's axis tilts toward the open side, so fronds stay evenly
        # spread round it instead of bunching up on one side.
        self.axis = (self.normal + self.open_t * (p.lean * 0.9)).normalized()
        self.ax_a = tangent_on(self.tan_a, self.axis)
        self.ax_b = self.axis.cross(self.ax_a).normalized()
        self.frond_pool = list(p.pieces) or list(library.FRONDS)
        self.by_light = library.by_light(library.shades(p.shades))
        self.out = Builder()
        self.dome = self.crown - self.normal * (0.3 * p.length)  # the centre of the clump's shading dome
        self.placed = []
        self.fronds = 0
        self.leaves = 0
        self.sprig = p.variety == "SPRIG"
        self.creased = p.leaf_form == "CREASED"
        self.leaf_stem_r = 0.002  # radius of the stem the current leaves grow from
        self.leaf_cell = max(0.05, p.length * max(1.0, p.leaf_size) * (0.4 if self.sprig else 0.22 if jround(p.leaflets) == 0 else 0.16))
        self.grid = {}

    def r(self, i, salt):
        return rand(self.s.seed, i, salt)

    # ---- frames and fit ------------------------------------------------------

    def frames_of(self, line, roll_turns):
        """Width (W) and face (F) directions along a centre line, with `roll_turns` of twist toward the tip."""
        rows = len(line) - 1
        out, prev_w = [], None
        for row in range(rows + 1):
            T = (line[min(row + 1, rows)] - line[max(row - 1, 0)]).normalized()
            W = T.cross(UP)
            if W.length_squared < 0.02:
                # An upright stalk keeps the last width axis.
                W = prev_w - T * prev_w.dot(T) if prev_w is not None else T.cross(self.tan_a)
            W.normalize()
            if prev_w is not None and W.dot(prev_w) < 0:
                W.negate()
            W = _rotate(W, T, roll_turns * row / rows)
            F = W.cross(T).normalized()
            if F.z < 0 and prev_w is None:
                W.negate()
                F.negate()
            prev_w = W.copy()
            out.append(Frame(line[row], T, W, F))
        return out

    def frond_line(self, dir0, length, droop, steps):
        """The centre line of a frond: rises from the crown along `dir0`, then droops toward the tip."""
        ds = length / steps
        pts = [self.crown.copy()]
        d = dir0.copy()
        for i in range(1, steps + 1):
            t = i / steps
            d = (d + DOWN * (droop * 3.2 * ds / length * (0.35 + t))).normalized()
            pts.append(pts[-1] + d * ds)
        return pts

    def first_blocked(self, pts, pad):
        """The index of the first point in the rock or another plant, or -1."""
        for i, q in enumerate(pts):
            if i < 2:
                continue
            if self.surface.inside(q, pad) or self.avoid.hits(q, pad):
                return i
        return -1

    def fit_to_rock(self, elev0, h0, length0, droop):
        """Bend a frond out of the crack: a line clear of the rock and other plants, or None."""
        elev, length, droop_now, h = elev0, length0, droop, h0.copy()
        for attempt in range(8):
            d = (self.axis * math.cos(elev) + h * math.sin(elev)).normalized()
            pts = self.frond_line(d, length, droop_now, 12)
            hit = self.first_blocked(pts, 0.012)
            if hit < 0:
                return pts, length
            if hit >= 7 and attempt >= 3:
                length *= (hit - 1) / 12  # a tight spot: a shorter frond
                continue
            if attempt % 3 == 0:
                elev *= 0.72  # stand up more, out of the crack
            elif attempt % 3 == 1:
                h = h.lerp(self.open_t, 0.5).normalized()  # turn toward open air, droop less
                droop_now *= 0.6
            else:
                h = _rotate(h, self.normal, 0.6).normalized()  # turn and shorten
                length *= 0.85
        return None

    def card_hits_rock(self, frames, shape, fold, pad):
        """Whether the leafy part of a card dips into the rock: nine points across
        its leafy width (folded as it will be drawn) on every row."""
        rows = len(frames) - 1
        for i in range(1, rows + 1):
            v, fr = i / rows, frames[i]
            reach = shape.reach(v) * 0.95
            for k in range(-4, 5):
                x, y = _across(shape, fold, reach * k / 4, v)
                q = fr.p + fr.W * x + fr.F * y
                hit = self.surface.nearest(q, pad * 4)
                if hit is not None and hit.signed < pad:
                    return True
        return False

    def collides_with_clump(self, frames, shape, fold, gap):
        """Whether a card would pass through (or touch) a frond already placed:
        sampled along five lines, each sample tested against the nearest row of
        every placed frond, within its leafy width and `gap` of its folded
        surface, or crossing from one side of it to the other between rows.
        The stalks near the crown, where all fronds meet, are ignored."""
        rows = len(frames) - 1
        centre, radius = _bound(frames, shape.half)
        for other in self.placed:
            if (centre - other.centre).length > radius + other.radius:
                continue
            o_rows = len(other.frames) - 1
            o_step = (other.frames[1].p - other.frames[0].p).length
            for lateral in (-1.0, -0.5, 0.0, 0.5, 1.0):
                prev_h = None
                for i in range(math.ceil(rows * CROWN_SKIP), rows + 1):
                    v, fr = i / rows, frames[i]
                    x, y = _across(shape, fold, lateral * shape.reach(v) * 0.8, v)
                    q = fr.p + fr.W * x + fr.F * y
                    best, best_d = -1, math.inf
                    for j, of in enumerate(other.frames):
                        dd = (q - of.p).length_squared
                        if dd < best_d:
                            best, best_d = j, dd
                    ov, of = best / o_rows, other.frames[best]
                    rel = q - of.p
                    b = rel.dot(of.W)
                    if ov < CROWN_SKIP or abs(rel.dot(of.T)) > o_step * 0.75 or abs(b) > other.shape.reach(ov):
                        prev_h = None
                        continue
                    if other.shape.lift is not None:
                        surf = abs(b) * math.tan(other.shape.lift)
                    else:
                        surf = -abs(b) * math.sin(_fold_angle(other.fold, abs(b) / other.shape.half, ov))
                    hgt = rel.dot(of.F) - surf
                    if abs(hgt) < gap or (prev_h is not None and sign(hgt) != sign(prev_h)):
                        return True
                    prev_h = hgt
        return False

    # ---- painted cards -------------------------------------------------------

    def painted_shape(self, piece, length):
        _w, half = _card_size(piece, length)
        return Shape(half, lambda v: half * _profile_at(piece, v))

    def shade_index(self, key, age):
        spread = (self.r(key, 8) - 0.5) * len(self.by_light) * 0.4
        return min(len(self.by_light) - 1, max(0, jround((1.0 - age) * (len(self.by_light) - 1) + spread)))

    def add_card(self, piece, frames, length, age, key, fold):
        """One painted card along `frames`, folded down its midrib."""
        cols, rows = 8, len(frames) - 1
        width, _half = _card_size(piece, length)
        # The painted colour tinted toward a green picked by age (outer, older fronds darker).
        shade = self.by_light[self.shade_index(key, age)]
        tinted = _tint(shade, piece.avg, self.s.paint_tint)
        tone = PAINT_SCALE * (0.92 + self.r(key, 5) * 0.12)
        bu = piece.base_uv[0]
        offset = len(self.out)
        for row in range(rows + 1):
            v, fr = row / rows, frames[row]
            for col in range(cols + 1):
                u = col / cols
                du = u - bu
                edge = abs(du) / max(bu, 1.0 - bu)
                side, th = sign(du), _fold_angle(fold, edge, v)
                d = abs(du) * width
                q = fr.p + fr.W * (side * d * math.cos(th)) + fr.F * (-d * math.sin(th))
                # Each half its own tilted normal (so the fold reads), blended toward the
                # dome round the crown (so the clump shades as one), lifted a little to the sky.
                fn = fr.F * math.cos(th) + fr.W * (side * math.sin(th))
                n = (fn.lerp((q - self.dome).normalized(), 0.35).normalized() + UP * 0.3).normalized()
                f = (0.74 + 0.30 * smoothstep(v, 0.0, 0.7)) * (1.0 - 0.06 * edge)  # darker toward the crown
                self.out.vertex(q, card_uv(piece, u, v), _scale(tinted, tone * f), n)
        self.out.grid(offset, rows, cols)

    # ---- leaflet and sprig fronds -------------------------------------------

    def once(self):
        return self.sprig or jround(self.s.leaflets) == 0

    def pinna_angle(self, v):
        """Angle of leaves (or leaflet stems) from the rachis, pointing tipward."""
        if self.sprig:
            return math.radians(56.0 - 12.0 * v)
        return math.radians(58.0 - 10.0 * v if self.once() else 64.0 - 22.0 * v)

    def outline(self, v):
        if self.once():
            # Leaves about 60 % size at the base, largest a third of the way up, a quarter at the tip.
            if v < 0.06:
                return 0.0
            if v < 0.3:
                return 0.6 + 0.4 * smoothstep(v, 0.06, 0.3)
            return 1.0 - 0.75 * ((v - 0.3) / 0.67) ** 1.2
        # A twice-divided frond: bare stalk, widest a little above it, to a point.
        if v < 0.1:
            return 0.0
        if v < 0.2:
            return 0.8 + 0.2 * (v - 0.1) / 0.1
        return 1.0 - 0.8 * (v - 0.2) / 0.8

    def leaf_lift(self):
        """Leaves rise from their stem in a V, more with Fold."""
        return 0.6 * self.s.fold if self.once() else 0.3 + 0.45 * self.s.fold

    def pinna_lift(self):
        return 0.35 * self.s.fold

    def once_len(self):
        return 0.3 if self.sprig else 0.32

    def leaflet_shape(self, length):
        lp = length * (self.once_len() * self.s.leaf_size if self.once() else PINNA_LEN)
        half = lp * math.sin(self.pinna_angle(0.3)) * 1.1
        lift = self.leaf_lift() if self.once() else self.pinna_lift() + 0.4 * self.leaf_lift()
        return Shape(half, lambda v: lp * self.outline(v) * math.sin(self.pinna_angle(v)) * 1.1, lift)

    def stem_colour(self, f):
        c = _mix(STEM_BASE, STEM_MID, f / 0.4) if f < 0.4 else _mix(STEM_MID, STEM_TIP, (f - 0.4) / 0.6)
        return _scale(c, 0.6)

    def leaf_card(self, base, d, face, length, piece, toward=None):
        lc = self.s.leaf_curve
        c = LeafCard()
        c.size = length / max(0.5, 1.0 - piece.base_uv[1])
        c.width = c.size * piece.aspect
        wv = d.cross(face).normalized()
        n0 = wv.cross(d).normalized()
        if n0.dot(face) < 0:
            wv.negate()
            n0.negate()
        c.base, c.dir, c.wv, c.n0, c.len = base.copy(), d.copy(), wv, n0, length
        c.left, c.right = c.width * piece.base_uv[0], c.width * (1.0 - piece.base_uv[0])
        # A crease down the midrib (edges up), the tip curling down, and (single
        # leaves) a sideways sweep toward the frond tip, sickle-shaped.
        c.cup = 0.06 * lc if self.sprig else 0.25 * lc if self.creased else 0.02 + 0.16 * lc
        c.curl = 0.02 + 0.12 * lc if self.sprig else 0.28 * lc if self.creased else 0.03 + 0.2 * lc
        if toward is not None and self.once() and not self.sprig:
            c.bend = (0.2 * lc if self.creased else 0.03 + 0.14 * lc) * sign(toward.dot(wv))
        else:
            c.bend = 0.0
        c.prof_l, c.prof_r = piece.profile_left, piece.profile_right
        c.centre = base + d * (length * 0.5)
        c.radius = math.hypot(length * 0.5, c.width) + 0.002
        c._samples = None
        return c

    @staticmethod
    def half_w(c, a, x):
        """The leaf's half-width at `a` along it, on the side of `x`."""
        t = a / c.len
        if t <= 0 or t >= 1:
            return 0.0
        prof = c.prof_l if x < 0 else c.prof_r
        if not prof:
            return (c.left if x < 0 else c.right) * math.sqrt(4 * t * (1 - t))
        # The leaf's measured outline (and a 4 % margin): leaves are tested by their real shape.
        f = t * (len(prof) - 1)
        i = min(len(prof) - 2, math.floor(f))
        return (prof[i] + (prof[i + 1] - prof[i]) * (f - i)) * c.width * 1.04 + 0.0005

    @staticmethod
    def height(c, a, x):
        """The leaf's surface over its flat frame: cupped, edges up, the tip curling down."""
        return c.cup * abs(x) - max(0.0, a / c.size) ** 2 * c.size * c.curl

    @staticmethod
    def bend_at(c, a):
        return c.bend * c.len * (max(0.0, a) / c.len) ** 2 if c.bend else 0.0

    def point_on(self, c, a, x):
        return c.base + c.dir * a + c.wv * (x + self.bend_at(c, a)) + c.n0 * self.height(c, a, x)

    def samples(self, c):
        if c._samples is None:
            pts = []
            for af in SAMPLE_A:
                a = af * c.len
                for xf in SAMPLE_X:
                    x = xf * self.half_w(c, a, xf)
                    q = self.point_on(c, a, x)
                    pts.append((q.x, q.y, q.z))
            c._samples = pts
        return c._samples

    def leaf_clash(self, c, o, skip=0.0):
        """Whether leaf `c` touches or passes through leaf `o`: points across `c`
        measured against `o`'s surface; one within `gap` of it inside its
        outline, or two neighbours on opposite sides of it, is a clash."""
        gap = max(0.0012, min(0.0025, 0.03 * min(c.len, o.len)))  # a few millimetres
        rel = c.centre - o.base
        ch, ca, cw = rel.dot(o.n0), rel.dot(o.dir), rel.dot(o.wv)
        if ch > c.radius + o.cup * max(o.left, o.right) + gap or ch < -c.radius - o.curl * o.size - gap:
            return False
        reach = abs(o.bend) * o.len
        if ca < -c.radius or ca > o.len + c.radius or cw < -o.left - c.radius - reach or cw > o.right + c.radius + reach:
            return False
        pts = self.samples(c)
        bx, by, bz = o.base
        dx, dy, dz = o.dir
        wx, wy, wz = o.wv
        nx, ny, nz = o.n0
        nxs = len(SAMPLE_X)
        heights = [None] * len(pts)
        for k, (px, py, pz) in enumerate(pts):
            # Leaves that meet at the stem may touch over their first part, as real leaflets do.
            if skip and SAMPLE_A[k // nxs] < skip:
                continue
            qx, qy, qz = px - bx, py - by, pz - bz
            ao = qx * dx + qy * dy + qz * dz
            if ao <= skip * o.len or ao >= o.len:
                continue
            xo = qx * wx + qy * wy + qz * wz - self.bend_at(o, ao)
            if abs(xo) > self.half_w(o, ao, xo):
                continue
            g = qx * nx + qy * ny + qz * nz - self.height(o, ao, xo)
            if abs(g) < gap:
                return True
            heights[k] = g
        for i in range(len(SAMPLE_A)):
            for j in range(nxs):
                k = i * nxs + j
                h = heights[k]
                if h is None:
                    continue
                if j + 1 < nxs and heights[k + 1] is not None and sign(heights[k + 1]) != sign(h):
                    return True
                if i + 1 < len(SAMPLE_A) and heights[k + nxs] is not None and sign(heights[k + nxs]) != sign(h):
                    return True
        return False

    def cell(self, q):
        return (math.floor(q.x / self.leaf_cell), math.floor(q.y / self.leaf_cell), math.floor(q.z / self.leaf_cell))

    def leaves_near(self, q, reach):
        gx, gy, gz = self.cell(q)
        out = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for o in self.grid.get((gx + dx, gy + dy, gz + dz), ()):
                        if (o.centre - q).length <= o.radius + reach:
                            out.append(o)
        return out

    def clashes(self, c, near):
        for o in near:
            if (o.centre - c.centre).length > o.radius + c.radius:
                continue
            skip = 0.2 if (c.base - o.base).length < 0.3 * min(c.len, o.len) else 0.0
            if self.leaf_clash(c, o, skip) or self.leaf_clash(o, c, skip):
                return True
        return False

    def touches_rock(self, c):
        for af, xf in ROCK_SAMPLES:
            a = af * c.len
            if self.surface.inside(self.point_on(c, a, xf * self.half_w(c, a, xf)), 0.004):
                return True
        return False

    def add_leaf_group(self, group):
        """Place a pair of opposite leaves (or one tip leaf) together: both get the
        same change, so the two sides stay alike; if no change fits both, neither
        is added. Each ask: (base, dir, face, len, side, piece, colour, toward)."""
        near = self.leaves_near(group[0][0], max(g[3] for g in group) * 1.25 + 0.004)
        for up, turn, scale, lift in PAIR_VARIANTS:
            cards = []
            for base0, d0, face, length, side, piece, _colour, toward in group:
                d = d0.copy()
                if turn:
                    d = _rotate(d, face, turn * side)  # mirrored on the two sides
                if up:
                    fp = (face - d * face.dot(d)).normalized()
                    d = (d * math.cos(up) + fp * math.sin(up)).normalized()
                # The base sits on the stem, tucked in a little, raised at most a stem
                # radius, so no leaf floats; leaves make room only by turning about it.
                base = base0 + d * (TINY_STALK * length * scale)
                if lift:
                    base = base + face * (lift * self.leaf_stem_r)
                cards.append(self.leaf_card(base, d, face, length * scale, piece, toward))
            if any(self.touches_rock(c) for c in cards):
                continue
            if any(self.clashes(c, near) for c in cards):
                continue
            if len(cards) == 2 and (self.leaf_clash(cards[0], cards[1], 0.2) or self.leaf_clash(cards[1], cards[0], 0.2)):
                continue
            for c, g in zip(cards, group):
                self.write_leaf(c, g[5], g[6])
                self.grid.setdefault(self.cell(c.centre), []).append(c)
            return True
        return False

    def write_leaf(self, c, piece, colour):
        """A tiny leaf: columns at its edges and on its midrib (so a crease runs
        down the middle), more rows on a big single leaf for a smooth curve."""
        rows = 4 if self.once() else 3
        us = (0.0, piece.base_uv[0], 1.0)
        tilt = max(0.45 if self.once() else 0.15, c.cup * 1.5)
        offset = len(self.out)
        for row in range(rows + 1):
            for col in range(3):
                v, u = row / rows, us[col]
                dv, du = v - piece.base_uv[1], u - piece.base_uv[0]
                side = 0.0 if col == 1 else sign(du)
                q = self.point_on(c, dv * c.size, du * c.width)
                # Each half its own tilt, so a creased leaf shows a lighter and a darker half.
                n = (c.n0 * 0.96 + c.wv * (-side * tilt)).lerp((q - self.dome).normalized(), 0.3).normalized()
                n = (n + UP * 0.25).normalized()
                self.out.vertex(q, card_uv(piece, u, v), colour, n)
        self.out.grid(offset, rows, 2)
        self.leaves += 1

    def leaf_colour(self, piece, v, k2, shade_idx):
        """The frond's green (by age), tinted from the leaf's own paint, darker
        toward the crown; with Leaf Variation each leaf shifts to a neighbouring
        green and lighter or darker. A sprig steps from the darkest greens at its
        base to the lightest at its tip."""
        s, n = self.s, len(self.by_light)
        jitter = jround((self.r(k2, 11) - 0.5) * s.leaf_variation * n * 0.9)
        grad = jround((clamp(v, 0.0, 1.0) - 0.5) * (n - 1) * 1.4) if self.sprig else 0
        start = jround((n - 1) / 2) if self.sprig else shade_idx
        sh = self.by_light[min(n - 1, max(0, start + grad + jitter))]
        c = _tint(sh, piece.avg, s.paint_tint)
        tone = 0.6 + 0.62 * smoothstep(v, 0.0, 1.0) if self.sprig else 0.74 + 0.3 * smoothstep(v, 0.0, 0.7)
        return _scale(c, PAINT_SCALE * (0.9 + 0.16 * self.r(k2, 5)) * (1.0 + (self.r(k2, 12) - 0.5) * 0.5 * s.leaf_variation) * tone)

    def build_leaflet_frond(self, frames, length, age, key):
        """A compound frond along `frames`: rachis, leaflet stems, tiny leaves."""
        s = self.s
        rows = len(frames) - 1
        line = [f.p for f in frames]
        along = [0.0]
        for i in range(1, rows + 1):
            along.append(along[-1] + (line[i] - line[i - 1]).length)
        rachis_r = max(0.0016, length * 0.0045)  # thin, as in the references
        self.leaf_stem_r = rachis_r if self.once() else rachis_r * 0.3
        # Sprigs are kept apart only from sprigs on the same stem; fronds may cross.
        if self.sprig:
            self.grid.clear()
        self.out.tube(line, rachis_r, self.stem_colour, sides=6, tip=0.22)
        shade_idx = self.shade_index(key, age)

        def size_jitter(k2):
            return 1.0 + (self.r(k2, 13) - 0.5) * 0.5 * s.leaf_variation

        def frame_at(v):
            x = v * rows
            i0 = min(rows - 1, math.floor(x))
            f = x - i0
            a, b = frames[i0], frames[i0 + 1]
            return (a.p.lerp(b.p, f), a.T.lerp(b.T, f).normalized(), a.W.lerp(b.W, f).normalized(),
                    a.F.lerp(b.F, f).normalized(), along[i0] + (along[i0 + 1] - along[i0]) * f)

        mirror = s.mirror_pairs
        P = jround(s.pinnae)
        L = 0 if self.sprig else jround(s.leaflets)
        lp = length * PINNA_LEN
        leaf_base = lp * 0.45 * s.leaf_size  # the largest tiny leaf: 45 % of the longest leaflet stem
        # One leaf shape per frond for single leaves (both sides and every pair match).
        frond_piece = library.SPRIG if self.sprig else library.NARROW_LEAVES[math.floor(self.r(key, 17) * len(library.NARROW_LEAVES)) % len(library.NARROW_LEAVES)]
        for i in range(P):
            # Opposite pairs: both sides share one position, length, leaf shape and colour.
            v = min(0.95, 0.08 + 0.86 * i / max(1, P - 0.5)) if self.once() else min(0.97, 0.12 + 0.85 * i / P)
            k2 = key * 1000 + i
            pl = (length * self.once_len() * s.leaf_size if self.once() else lp) * self.outline(v) * (0.95 + 0.1 * self.r(k2, 1))
            if pl < length * 0.02:
                continue
            fp, fT, fW, fF, fd = frame_at(v)
            ang = self.pinna_angle(v)
            lift = self.leaf_lift() if self.once() else self.pinna_lift()
            piece = frond_piece if L == 0 else library.BROAD_LEAVES[math.floor(self.r(k2, 7) * len(library.BROAD_LEAVES)) % len(library.BROAD_LEAVES)]
            dirs = [((fW * (side * math.sin(ang)) + fT * math.cos(ang)) * math.cos(lift) + fF * math.sin(lift)).normalized() for side in (-1.0, 1.0)]
            if L == 0:
                # Once divided: one leaf a side, straight on the rachis. Mirrored pairs
                # share size and colour; otherwise each side varies on its own.
                # Sprigs are set like louvres, each turned about its axis toward the
                # frond tip, so neighbours lie over one another without crossing.
                face = (fF * math.cos(SPRIG_ROLL) + fT * math.sin(SPRIG_ROLL)).normalized() if self.sprig else fF
                group = []
                for n, side in enumerate((-1.0, 1.0)):
                    kk = k2 if mirror else k2 * 2 + n
                    pc = piece if (n or not mirror) else piece.mirror()
                    group.append((fp, dirs[n], face, pl * size_jitter(kk), side, pc, self.leaf_colour(piece, v, kk, shade_idx), fT))
                self.add_leaf_group(group)
                continue
            # The leaflet stems curl down a little and sweep toward the frond tip;
            # both stop where either would enter the rock, so the pair stays even.
            steps = 4
            stems = []
            for dir0 in dirs:
                pts, d = [fp.copy()], dir0.copy()
                for _j in range(steps):
                    d = (d + fF * -0.035 + fT * 0.05).normalized()
                    pts.append(pts[-1] + d * (pl / steps))
                stems.append(pts)
            keep = steps
            for pts in stems:
                for j in range(1, steps + 1):
                    if self.surface.inside(pts[j], 0.006):
                        keep = min(keep, j - 1)
                        break
            if keep < 2:
                continue
            stems = [pts[: keep + 1] for pts in stems]
            pl *= keep / steps
            stem_c = self.stem_colour(v * 0.6 + 0.3)
            at = []
            for pts in stems:
                self.out.tube(pts, rachis_r * 0.3 * (1.0 - 0.4 * v), lambda _f, c=stem_c: c, sides=4, tip=0.35)
                at.append(pts)

            def point_at(pts, u):
                x = u * (len(pts) - 1)
                j0 = min(len(pts) - 2, math.floor(x))
                f = x - j0
                return pts[j0].lerp(pts[j0 + 1], f), (pts[j0 + 1] - pts[j0]).normalized()

            la = math.radians(TINY_ANGLE)
            for n in (0, 1):
                # Opposite pairs of tiny leaves, alike on both sides: largest at the
                # leaflet's base, about half at its tip, smaller toward the frond tip.
                for j in range(L):
                    u = 0.16 + 0.78 * j / L
                    ap, at_t = point_at(at[n], u)
                    pw = fF.cross(at_t).normalized()
                    ll = leaf_base * self.outline(v) * (1.15 - 0.6 * u)
                    group = []
                    for side2 in (-1.0, 1.0):
                        ldir = (pw * (side2 * math.sin(la)) + at_t * math.cos(la)).normalized()
                        ldir = (ldir * math.cos(self.leaf_lift()) + fF * math.sin(self.leaf_lift())).normalized()  # rising in a V
                        kk = k2 * 64 + n * 16 + j if mirror else k2 * 64 + n * 16 + j * 2 + (1 if side2 > 0 else 0) + 5000
                        pc = piece if (side2 > 0 or not mirror) else piece.mirror()
                        group.append((ap, ldir, fF, ll * size_jitter(kk), side2 * (1.0 if n else -1.0), pc,
                                      self.leaf_colour(piece, v + 0.15 * u, kk, shade_idx), None))
                    self.add_leaf_group(group)
                tp, tt = point_at(at[n], 1.0)
                self.add_leaf_group([(tp, tt, fF, leaf_base * self.outline(v) * 0.55, 1.0, piece,
                                      self.leaf_colour(piece, v + 0.15, k2, shade_idx), None)])
        if L == 0:
            # One leaf on the very tip of the frond.
            end = frames[rows]
            self.add_leaf_group([(end.p, end.T, end.F, length * self.once_len() * s.leaf_size * 0.3, 1.0, frond_piece,
                                  self.leaf_colour(frond_piece, 1.0, key * 1000 + 999, shade_idx), None)])

    # ---- the clump -----------------------------------------------------------

    def grow(self):
        s = self.s
        n = jround(s.fronds)
        phase = self.r(0, 1) * math.pi * 2.0
        gap = 0.012 * max(0.5, s.length / 0.45)
        leafy = s.variety != "PAINTED"
        nudges = NUDGES[:15] if self.quick else NUDGES
        variants = ((1.0, 1.0), (0.4, 0.0)) if self.quick else ((1.0, 1.0), (0.55, 0.0), (0.2, 0.0))
        # Outer fronds first: they lie lowest and are the hardest to fit; younger
        # ones then find a layer above them. Last resorts are shorter fronds.
        for k in range(n - 1, -1, -1):
            t = k / (n - 1) if n > 1 else 0.5  # 0 a young inner frond, 1 an old outer one
            piece = self.frond_pool[math.floor(self.r(k, 7) * len(self.frond_pool)) % len(self.frond_pool)]
            length0 = s.length * (0.65 + 0.45 * t) * (1.0 + (self.r(k, 2) - 0.5) * 2.0 * s.length_var) * (1.0 if leafy else math.sqrt(piece.scale))

            def shape_of(length, piece=piece):
                return self.leaflet_shape(length) if leafy else self.painted_shape(piece, length)

            elev0 = s.spread * (0.35 + 1.0 * t) + (self.r(k, 3) - 0.5) * 12.0
            az = phase + k * GOLDEN
            droop = s.droop * (0.55 + 0.7 * t) * (0.85 + 0.3 * self.r(k, 4))
            roll = (self.r(k, 6) - 0.5) * 2.0 * s.twist * 1.2
            for d_elev, d_az, len_scale in nudges:
                h = self.ax_a * math.cos(az + d_az) + self.ax_b * math.sin(az + d_az)
                elev = math.radians(clamp(elev0 + d_elev, 3.0, 88.0))
                # Against the rock a frond can also droop less or untwist so its edges clear the stone.
                fit = frames = None
                for droop_scale, roll_scale in variants:
                    f = self.fit_to_rock(elev, h, length0 * len_scale, droop * droop_scale)
                    if f is None:
                        continue
                    fr = self.frames_of(f[0], roll * roll_scale)
                    test = shape_of(f[1])
                    if leafy:
                        # Leaflet fronds are see-through, and their leaves test the rock themselves.
                        test = Shape(test.half, lambda v, reach=test.reach: reach(v) * 0.7, test.lift)
                    if self.card_hits_rock(fr, test, s.fold, 0.008):
                        continue
                    fit, frames = f, fr
                    break
                if fit is None:
                    continue
                shape = shape_of(fit[1])
                if not self.sprig and self.collides_with_clump(frames, shape, s.fold, gap):
                    continue  # sprig fronds may cross each other
                if not self.quick:
                    if leafy:
                        self.build_leaflet_frond(frames, fit[1], t, k)
                    else:
                        self.add_card(piece, frames, fit[1], t, k, s.fold)
                self.placed.append(Placed(frames, shape, s.fold, _bound(frames, shape.half)))
                self.fronds += 1
                break
        # Croziers: young coiled fronds, upright in the middle, two crossed cards each.
        for c in range(jround(s.croziers)):
            key = 1000 + c
            piece = library.CROZIERS[math.floor(self.r(key, 7) * len(library.CROZIERS)) % len(library.CROZIERS)]
            length = s.length * (0.22 + 0.1 * self.r(key, 2)) * (0.6 if leafy else 1.0)  # small beside long leaflet fronds
            for d_az in CROZIER_TURNS:
                az = phase + 0.7 + c * 2.3 + d_az
                h = self.tan_a * math.cos(az) + self.tan_b * math.sin(az)
                d = (self.normal * 0.92 + h * 0.3 + UP * 0.4).normalized()
                line = self.frond_line(d, length, 0.05, 6)
                if self.first_blocked(line, 0.01) >= 0:
                    continue
                a = self.frames_of(line, 0.0)
                b = [Frame(f.p, f.T, f.F.copy(), -f.W) for f in self.frames_of(line, 0.0)]
                shape = self.painted_shape(piece, length)
                if self.card_hits_rock(a, shape, 0.0, 0.003) or self.card_hits_rock(b, shape, 0.0, 0.003):
                    continue
                if self.collides_with_clump(a, shape, 0.0, gap * 0.5) or self.collides_with_clump(b, shape, 0.0, gap * 0.5):
                    continue
                if self.quick:
                    break
                self.add_card(piece, a, length, 0.0, key, 0.0)
                self.add_card(piece, b, length, 0.0, key, 0.0)
                break
        if not self.quick:
            # A dark knot at the crown hides where the fronds meet the rock.
            self.out.knot(self.crown, self.normal, max(0.008, s.length * (0.03 if leafy else 0.055)), CROWN_COLOUR)


def grow(surface, root, normal, open_dir, p, avoid=NO_AVOID, quick=False):
    """Grow a fern clump with its crown at `root` (a world point on or near the
    surface), the surface `normal` there and the `open_dir` it leans toward.
    Returns (builder, stats); `quick` places the fronds without building them,
    to test a spot. Raises FernError when it cannot."""
    f = _Fern(surface, root, normal, open_dir, p, avoid, quick)
    f.grow()
    return f.out, {"fronds": f.fronds, "leaves": f.leaves}
