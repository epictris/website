"""Glow flora: luminous mushrooms, lantern blooms, glow ferns and reed tufts,
grown as one patch at a plant's root. A port of the Glowshroom Generator's
`glowshrooms.js` (a three.js module, 2026-11-14; docs/blender-foliage.md,
"Glow flora"), step for step in its own y-up patch frame, with its seeded
generator (mulberry32) and its colour maths (three's sRGB <-> linear and HSL),
so a seed grows the patch the web generator grows, and a patch copied from it
as JSON grows here exactly as it was edited there.

Two things are generalised, both of which reduce to the original on flat
ground: the ground is the host's surface (a height under every point, from
`Ground`) instead of the plane y = 0, and the patch's up is the world's, not
the surface normal (mushrooms stand and bulbs hang). With `Ground.flat()` the
port is the original, which is how it is checked against it.

Every vertex carries, beside its colour, the original's three shader
attributes: a glow colour (emission, linear RGB), a gill vector (radial
direction, gill weight, line count; z = -1 marks a stem's inner glow) and a
sway vector (wind phase, amplitude, height factor, pulse phase). The game's
glow flora shader reads them (render3d/glowFlora.ts)."""

import json
import math
from functools import lru_cache

# ------------------------------------------------------------------ vectors
# A small double-precision vector with three's arithmetic (mathutils' floats
# are single precision, and the solver rounds to 1e-4 at every step, so a
# float32 port would drift from the original at the first knife edge).


class V3:
    __slots__ = ("x", "y", "z")

    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x = x
        self.y = y
        self.z = z

    def copy(self):
        return V3(self.x, self.y, self.z)

    def set(self, x, y, z):
        self.x, self.y, self.z = x, y, z
        return self

    def __add__(self, o):
        return V3(self.x + o.x, self.y + o.y, self.z + o.z)

    def __sub__(self, o):
        return V3(self.x - o.x, self.y - o.y, self.z - o.z)

    def __mul__(self, s):
        return V3(self.x * s, self.y * s, self.z * s)

    def __neg__(self):
        return V3(-self.x, -self.y, -self.z)

    def adds(self, v, s):
        """three's clone().addScaledVector(v, s)."""
        return V3(self.x + v.x * s, self.y + v.y * s, self.z + v.z * s)

    def dot(self, o):
        return self.x * o.x + self.y * o.y + self.z * o.z

    def cross(self, b):
        return V3(self.y * b.z - self.z * b.y, self.z * b.x - self.x * b.z, self.x * b.y - self.y * b.x)

    def length_sq(self):
        return self.x * self.x + self.y * self.y + self.z * self.z

    def length(self):
        return math.sqrt(self.x * self.x + self.y * self.y + self.z * self.z)

    def normalized(self):
        inv = 1.0 / (self.length() or 1.0)
        return V3(self.x * inv, self.y * inv, self.z * inv)

    def distance(self, o):
        dx, dy, dz = self.x - o.x, self.y - o.y, self.z - o.z
        return math.sqrt(dx * dx + dy * dy + dz * dz)

    def lerp(self, o, t):
        return V3(self.x + (o.x - self.x) * t, self.y + (o.y - self.y) * t, self.z + (o.z - self.z) * t)

    def quat(self, q):
        vx, vy, vz = self.x, self.y, self.z
        qx, qy, qz, qw = q
        tx = 2 * (qy * vz - qz * vy)
        ty = 2 * (qz * vx - qx * vz)
        tz = 2 * (qx * vy - qy * vx)
        return V3(vx + qw * tx + qy * tz - qz * ty, vy + qw * ty + qz * tx - qx * tz, vz + qw * tz + qx * ty - qy * tx)

    def axis_angle(self, axis, angle):
        half = angle / 2
        s = math.sin(half)
        return self.quat((axis.x * s, axis.y * s, axis.z * s, math.cos(half)))

    def __iter__(self):
        yield self.x
        yield self.y
        yield self.z

    def __repr__(self):
        return f"V3({self.x:.5f}, {self.y:.5f}, {self.z:.5f})"


def unit_quat(a, b):
    """three's Quaternion.setFromUnitVectors."""
    r = a.dot(b) + 1
    if r < 1e-8:
        r = 0.0
        q = (-a.y, a.x, 0.0, r) if abs(a.x) > abs(a.z) else (0.0, -a.z, a.y, r)
    else:
        q = (a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x, r)
    n = math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
    if n == 0:
        return (0.0, 0.0, 0.0, 1.0)
    n = 1 / n
    return (q[0] * n, q[1] * n, q[2] * n, q[3] * n)


UP = V3(0, 1, 0)
TAU = math.pi * 2


def bezier(p0, p1, p2, p3, t):
    """three's CubicBezierCurve3.getPoint."""
    k = 1 - t
    a, b, c, d = k * k * k, 3 * k * k * t, 3 * k * t * t, t * t * t
    return V3(a * p0.x + b * p1.x + c * p2.x + d * p3.x,
              a * p0.y + b * p1.y + c * p2.y + d * p3.y,
              a * p0.z + b * p1.z + c * p2.z + d * p3.z)


def basis_from(Y):
    ref = V3(1, 0, 0) if abs(Y.x) < 0.9 else V3(0, 0, 1)
    X = Y.cross(ref).normalized()
    Z = X.cross(Y).normalized()
    return X, Y, Z


# ------------------------------------------------------------------ small utilities

def rng(seed):
    """mulberry32, as the original's rng(seed)."""
    state = [(int(seed) & 0xFFFFFFFF) or 1]

    def imul(a, b):
        return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF

    def r():
        a = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        state[0] = a
        t = imul(a ^ (a >> 15), 1 | a)
        t = ((t + imul(t ^ (t >> 7), 61 | t)) & 0xFFFFFFFF) ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return r


def clamp(v, a, b):
    return min(b, max(a, v))


def lerp(a, b, t):
    return a + (b - a) * t


def smooth(a, b, x):
    t = clamp((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def jround(x):
    """JavaScript's Math.round."""
    return math.floor(x + 0.5)


def r4(v):
    return jround(v * 1e4) / 1e4


def srgb_to_linear(c):
    return c * 0.0773993808 if c < 0.04045 else math.pow(c * 0.9478672986 + 0.0521327014, 2.4)


def linear_to_srgb(c):
    return c * 12.92 if c < 0.0031308 else 1.055 * math.pow(c, 0.41666) - 0.055


def col(hexstr):
    """A '#rrggbb' as three's Color: linear RGB."""
    h = int(hexstr.lstrip("#"), 16)
    return (srgb_to_linear((h >> 16 & 255) / 255), srgb_to_linear((h >> 8 & 255) / 255), srgb_to_linear((h & 255) / 255))


def _hue2rgb(p, q, t):
    if t < 0:
        t += 1
    if t > 1:
        t -= 1
    if t < 1 / 6:
        return p + (q - p) * 6 * t
    if t < 1 / 2:
        return q
    if t < 2 / 3:
        return p + (q - p) * 6 * (2 / 3 - t)
    return p


def jitter_hex(hexstr, r, amount):
    lin = col(hexstr)
    rr, gg, bb = (linear_to_srgb(c) for c in lin)
    mx, mn = max(rr, gg, bb), min(rr, gg, bb)
    light = (mn + mx) / 2.0
    if mn == mx:
        hue = sat = 0.0
    else:
        delta = mx - mn
        sat = delta / (mx + mn) if light <= 0.5 else delta / (2 - mx - mn)
        if mx == rr:
            hue = (gg - bb) / delta + (6 if gg < bb else 0)
        elif mx == gg:
            hue = (bb - rr) / delta + 2
        else:
            hue = (rr - gg) / delta + 4
        hue /= 6
    h = (hue + (r() - 0.5) * amount + 1) % 1
    s = clamp(sat + (r() - 0.5) * amount, 0, 1)
    l = clamp(light + (r() - 0.5) * amount * 0.6, 0, 1)
    h = h % 1  # three's euclideanModulo
    if s == 0:
        out = (l, l, l)
    else:
        p = l * (1 + s) if l <= 0.5 else l + s - (l * s)
        q = (2 * l) - p
        out = (_hue2rgb(q, p, h + 1 / 3), _hue2rgb(q, p, h), _hue2rgb(q, p, h - 1 / 3))
    # setHSL lands in linear; getHexString takes it back to sRGB and rounds.
    out = (linear_to_srgb(srgb_to_linear(c)) for c in out)
    return "#" + "".join(f"{int(jround(clamp(c * 255, 0, 255))):02x}" for c in out)


def cmul(c, s):
    return (c[0] * s, c[1] * s, c[2] * s)


def cadd(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def clerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


WHITE = (1.0, 1.0, 1.0)

# ------------------------------------------------------------------ palettes, defaults, fields

PALETTES = {
    "pastel": {
        "caps": [["#f2a6e8", "#b591f6"], ["#f6ea8a", "#8ff2c8"], ["#c8a2ff", "#f5a2d8"], ["#a8f4e4", "#8ab6ff"],
                 ["#ffb2cf", "#d59eff"], ["#d9f78f", "#f6a5dc"], ["#e4b0ff", "#9fd8ff"]],
        "stem": "#cbc5f3", "glow": "#55f0ff", "spot": "#fdf6ff",
        "leaf": ["#7fe3c9", "#c9a6ff"], "bulb": [["#ffb2e6", "#8ff4ff"], ["#f6ea8a", "#ffa6d6"], ["#c8a2ff", "#8ff2e4"]],
        "stalk": "#9fd9c4", "reed": ["#a9d8f5", "#e7b8ff"],
    },
    "moonlight": {
        "caps": [["#a8ecff", "#5d86ff"], ["#c9f8ff", "#82d2ff"], ["#a9b7ff", "#7c68ff"], ["#9ff5ea", "#59a8ff"]],
        "stem": "#b7d5f6", "glow": "#6ef7ff", "spot": "#f2fbff",
        "leaf": ["#79c9f2", "#a7a3ff"], "bulb": [["#c9f8ff", "#7ccfff"], ["#b8c4ff", "#7fe8ff"]],
        "stalk": "#93b9e8", "reed": ["#a9c4f2", "#b9f2ff"],
    },
    "toxic": {
        "caps": [["#dcff6c", "#3fdb8b"], ["#b4ff5c", "#27c79f"], ["#f2ff8a", "#7ce86a"], ["#9cf7c4", "#5fd05a"]],
        "stem": "#d6f0c6", "glow": "#9dff57", "spot": "#fbfff2",
        "leaf": ["#5fd05a", "#d7ff6a"], "bulb": [["#eaff8a", "#3fdb8b"], ["#b4ff5c", "#7cf7d0"]],
        "stalk": "#8fd68a", "reed": ["#a7e39a", "#e9ff9a"],
    },
    "ember": {
        "caps": [["#ffb46b", "#ff5d7b"], ["#ffd37a", "#ff7a52"], ["#ff9fb0", "#ff6a3d"], ["#ffe39a", "#ff9a4d"]],
        "stem": "#f3d6c4", "glow": "#ffae42", "spot": "#fff6ec",
        "leaf": ["#e0794a", "#ffcf7a"], "bulb": [["#ffe39a", "#ff6a3d"], ["#ffb2a0", "#ffd37a"]],
        "stalk": "#c99a6c", "reed": ["#e6b48f", "#ffd9a0"],
    },
}

DEFAULTS = {
    "mushroom": dict(kind="mushroom", seed=7, count=14, spread=0.32, depth=0.6, size=0.55, sizeVariety=0.75,
                     heightVariety=0.35, lean=0.6, bend=0.5, dome=0.42, domeVariety=0.8, flare=0.1, flareVariety=0.7, capVariety=0.6,
                     separation=1.0, tilt=0.4, spots=0.7, spotSize=1.0, glow=1.0, palette="pastel", mound=0.5),
    "lantern": dict(kind="lantern", seed=7, count=5, spread=0.45, depth=0.6, size=0.7, sizeVariety=0.45, arch=0.6,
                    bulbSize=1.0, bulbLength=1.3, ribs=8, leaves=3, glow=1.0, palette="pastel"),
    "fern": dict(kind="fern", seed=7, count=2, spread=0.5, depth=0.6, size=0.5, sizeVariety=0.35, fronds=9,
                 tilt=0.55, droop=0.5, curl=0.3, leaflets=14, width=1.0, glow=1.0, palette="pastel"),
    "reed": dict(kind="reed", seed=7, count=3, spread=0.45, depth=0.6, size=0.7, sizeVariety=0.35, blades=11,
                 lean=0.35, width=1.0, orbs=0.4, orbSize=1.0, glow=1.0, palette="pastel"),
    "grove": dict(kind="grove", seed=7, mushrooms=12, lanterns=3, ferns=2, reeds=2, size=0.55, width=1.0, depth=0.6,
                  dome=0.42, flare=0.1, capVariety=0.6, tilt=0.4, spots=0.7, glow=1.0, palette="pastel", mound=0.5),
}

# [key, label, min, max, step] per patch kind, as the web generator's sliders.
PATCH_FIELDS = {
    "mushroom": [["count", "Count", 1, 40, 1], ["spread", "Spread", 0.04, 1, 0.01], ["depth", "Depth", 0.15, 1, 0.01],
                 ["size", "Size", 0.12, 1.6, 0.01], ["sizeVariety", "Size Variety", 0, 1, 0.01], ["heightVariety", "Height Variety", 0, 1, 0.01],
                 ["lean", "Lean", 0, 1.3, 0.01], ["bend", "Bend", 0, 1.5, 0.01], ["capVariety", "Cap Variety", 0, 1, 0.01],
                 ["dome", "Dome", 0, 1, 0.01], ["domeVariety", "Dome Variety", 0, 1, 0.01],
                 ["flare", "Flare", -1, 1, 0.01], ["flareVariety", "Flare Variety", 0, 1, 0.01], ["separation", "Fan Out", 0, 1.4, 0.01],
                 ["tilt", "Cap Tilt", 0, 1, 0.01], ["spots", "Spots", 0, 1.5, 0.01], ["spotSize", "Spot Size", 0.3, 2, 0.01],
                 ["glow", "Glow", 0, 2.5, 0.01], ["mound", "Mound", 0, 1.5, 0.01]],
    "lantern": [["count", "Count", 1, 16, 1], ["spread", "Spread", 0.05, 1.5, 0.01], ["depth", "Depth", 0.15, 1, 0.01],
                ["size", "Height", 0.2, 1.6, 0.01], ["sizeVariety", "Height Variety", 0, 1, 0.01], ["arch", "Arch", 0, 1.2, 0.01],
                ["bulbSize", "Bulb Size", 0.4, 2, 0.01], ["bulbLength", "Bulb Length", 0.6, 2.2, 0.01], ["ribs", "Ribs", 3, 16, 1],
                ["leaves", "Leaves", 0, 6, 1], ["glow", "Glow", 0, 2.5, 0.01]],
    "fern": [["count", "Count", 1, 8, 1], ["spread", "Spread", 0.05, 1.5, 0.01], ["depth", "Depth", 0.15, 1, 0.01],
             ["size", "Frond Length", 0.15, 1.2, 0.01], ["sizeVariety", "Size Variety", 0, 1, 0.01], ["fronds", "Fronds", 3, 16, 1],
             ["tilt", "Upright", 0, 1, 0.01], ["droop", "Droop", 0, 1.2, 0.01], ["curl", "Fiddleheads", 0, 1, 0.01],
             ["leaflets", "Leaflets", 4, 26, 1], ["width", "Leaflet Width", 0.3, 2, 0.01], ["glow", "Glow", 0, 2.5, 0.01]],
    "reed": [["count", "Count", 1, 10, 1], ["spread", "Spread", 0.05, 1.5, 0.01], ["depth", "Depth", 0.15, 1, 0.01],
             ["size", "Height", 0.15, 1.6, 0.01], ["sizeVariety", "Height Variety", 0, 1, 0.01], ["blades", "Blades", 3, 24, 1],
             ["lean", "Lean", 0, 1.2, 0.01], ["width", "Blade Width", 0.3, 2.5, 0.01], ["orbs", "Seed Pods", 0, 1, 0.01],
             ["orbSize", "Pod Size", 0.4, 2, 0.01], ["glow", "Glow", 0, 2.5, 0.01]],
    "grove": [["mushrooms", "Mushrooms", 0, 30, 1], ["lanterns", "Lantern Blooms", 0, 10, 1], ["ferns", "Ferns", 0, 6, 1],
              ["reeds", "Reeds", 0, 6, 1], ["size", "Size", 0.2, 1.4, 0.01], ["width", "Width", 0.3, 2.5, 0.01],
              ["depth", "Depth", 0.15, 1, 0.01], ["capVariety", "Cap Variety", 0, 1, 0.01], ["dome", "Cap Dome", 0, 1, 0.01],
              ["flare", "Cap Flare", -1, 1, 0.01], ["tilt", "Cap Tilt", 0, 1, 0.01], ["spots", "Spots", 0, 1.5, 0.01],
              ["glow", "Glow", 0, 2.5, 0.01], ["mound", "Mound", 0, 1.5, 0.01]],
}

# Fields that change shape: an edit to any of them locks the item in the solver.
SHAPE_KEYS = {"x", "z", "height", "stemRadius", "lean", "dir", "bend", "capRadius", "dome", "flare",
              "capTilt", "peak", "umbo", "wave", "waves", "spots", "spotSize", "arch", "stalkRadius", "bulbRadius", "bulbLength", "ribs", "leaves", "leafLength",
              "length", "fronds", "tilt", "droop", "curl", "leaflets", "width", "rot", "blades", "orbs", "orbSize"}


# ------------------------------------------------------------------ ground

class Ground:
    """The ground's height under a point of the patch (patch frame, y up).
    `at(x, z)` is the height, or None where there is no ground (off the
    rock's edge, over a drop). Flat ground is the original's y = 0."""

    def __init__(self, at=None):
        self._at = at

    @classmethod
    def flat(cls):
        return cls(None)

    def at(self, x, z):
        return 0.0 if self._at is None else self._at(x, z)

    def under(self, x, z, fallback):
        """The height, or `fallback` where there is none. A part of a plant
        out over a drop (a frond, a leaf, the mound's rim past a ledge) keeps
        its plant's footing, as it would on the original's endless plane;
        it never reaches for ground that is not there."""
        v = self.at(x, z)
        return fallback if v is None else v


GROUND = Ground.flat()


def foot(x, z):
    """The height a plant based at (x, z) stands on. A plant whose base is
    off the host (the solver's "edge" issue walks it back) stands at the
    root's height meanwhile, never far below."""
    v = GROUND.at(x, z)
    if v is None:
        v = GROUND.at(0.0, 0.0)
    return 0.0 if v is None else v


def under(x, z, base):
    return GROUND.under(x, z, base)


# ------------------------------------------------------------------ wind

def wind_phase(it):
    return it["x"] * 1.2 + it["z"] * 0.4


AMP = {"mushroom": 0.045, "lantern": 0.05, "fern": 0.05, "reed": 0.06}


def sway_amp(it):
    s = it["height"] if it["kind"] in ("mushroom", "lantern", "reed") else it["length"]
    return s * AMP[it["kind"]]


# ------------------------------------------------------------------ geometry builder

DETAIL = [
    dict(stemR=12, stemL=18, capSeg=40, top=10, under=6, spotSeg=8, spots=True, ribbon=1, tubeR=6, lathe=24),
    dict(stemR=9, stemL=11, capSeg=26, top=7, under=4, spotSeg=6, spots=True, ribbon=0.6, tubeR=5, lathe=16),
    dict(stemR=6, stemL=6, capSeg=14, top=4, under=2, spotSeg=0, spots=False, ribbon=0.35, tubeR=4, lathe=10),
]
NOGILL = (0.0, 0.0, 0.0, 0.0)
STEMGILL = (0.0, 0.0, -1.0, 0.0)


class GeoBuilder:
    def __init__(self):
        self.p = []
        self.c = []
        self.g = []
        self.gi = []
        self.s = []
        self.i = []

    def v(self, p, c, g, gi, s):
        self.p.append((p.x, p.y, p.z))
        self.c.append(c)
        self.g.append(g)
        self.gi.append(gi)
        self.s.append(s)
        return len(self.p) - 1

    def tri(self, a, b, c):
        self.i.append((a, b, c))

    def quad(self, a, b, c, d):
        self.i.append((a, b, c))
        self.i.append((a, c, d))

    def tube(self, pts, radii, nR, attr, cap_end=False):
        n = len(pts)
        tans = [(pts[min(n - 1, k + 1)] - pts[max(0, k - 1)]).normalized() for k in range(n)]
        N = basis_from(tans[0])[0]
        rings = []
        for k in range(n):
            if k > 0:
                N = N.quat(unit_quat(tans[k - 1], tans[k]))
            B = tans[k].cross(N).normalized()
            Nn = B.cross(tans[k]).normalized()
            ring = []
            for j in range(nR):
                a = (j / nR) * TAU
                pos = pts[k].adds(Nn, math.cos(a) * radii[k]).adds(B, math.sin(a) * radii[k])
                ring.append(self.v(pos, *attr(k, a)))
            rings.append(ring)
        for k in range(n - 1):
            for j in range(nR):
                j2 = (j + 1) % nR
                self.quad(rings[k][j], rings[k][j2], rings[k + 1][j2], rings[k + 1][j])
        if cap_end:
            tip = self.v(pts[n - 1].adds(tans[n - 1], radii[n - 1] * 0.8), *attr(n - 1, 0))
            for j in range(nR):
                self.tri(rings[n - 1][j], rings[n - 1][(j + 1) % nR], tip)

    def lathe(self, toW, prof, S, attr, pole_top=None, pole_bottom=None, r_mul=None, y_add=None):
        rings = []
        for i, pr in enumerate(prof):
            ring = []
            for j in range(S):
                a = (j / S) * TAU
                rr = pr["r"] * (r_mul(i, a) if r_mul else 1)
                ring.append(self.v(toW(rr * math.cos(a), pr["y"] + (y_add(i, a) if y_add else 0), rr * math.sin(a)), *attr(i, a)))
            rings.append(ring)
        if pole_top is not None:
            pole = self.v(toW(0, pole_top, 0), *attr(-1, 0))
            for j in range(S):
                self.tri(pole, rings[0][(j + 1) % S], rings[0][j])
        for k in range(len(rings) - 1):
            for j in range(S):
                j2 = (j + 1) % S
                self.quad(rings[k][j], rings[k][j2], rings[k + 1][j2], rings[k + 1][j])
        if pole_bottom is not None:
            pole = self.v(toW(0, pole_bottom, 0), *attr(len(prof), 0))
            last = rings[-1]
            for j in range(S):
                self.tri(last[j], last[(j + 1) % S], pole)

    def ribbon(self, C, S, W, attr):
        for side in range(2):
            rows = [[self.v(c.adds(S[k], j * W[k]), *attr(k, j)) for j in (-1, 0, 1)] for k, c in enumerate(C)]
            for k in range(len(C) - 1):
                for j in range(2):
                    a, b, c, d = rows[k][j], rows[k][j + 1], rows[k + 1][j + 1], rows[k + 1][j]
                    if side == 0:
                        self.quad(a, b, c, d)
                    else:
                        self.quad(a, d, c, b)


# ------------------------------------------------------------------ mushroom

def cap_profile(m):
    R = m["capRadius"]
    lip = R * (0.06 + 0.04 * m["dome"])
    yRim = R * m["flare"] * 0.38
    yTopC = max(R * (0.14 + 0.66 * m["dome"]), lip * 1.7, yRim + R * 0.05)
    k = 1 - 0.5 * m["dome"]
    peak, umbo = clamp(m.get("peak") or 0, 0, 1), clamp(m.get("umbo") or 0, 0, 1)
    coneTop = yTopC + peak * R * 0.5

    def top(u):
        rnd = yRim + (yTopC - yRim) * math.pow(max(0, 1 - u * u), k)
        cone = yRim + (coneTop - yRim) * math.pow(max(0, 1 - math.sqrt(u * u + 0.0025)) / 0.95, 1.15)
        return lerp(rnd, cone, peak) + umbo * R * 0.16 * math.exp(-math.pow(u / 0.2, 2))

    waveAmp = clamp(m.get("wave") or 0, 0, 1) * R * 0.11
    waves = max(3, jround(m.get("waves") or 6))
    phase = m.get("phase") or 0

    def wave_at(u, a):
        return waveAmp * math.pow(clamp(u, 0, 1), 3) * math.sin(waves * a + phase) if waveAmp else 0

    return dict(R=R, lip=lip, yRim=yRim, top=top, waveAmp=waveAmp, waveAt=wave_at)


CAP_STYLES = {
    "dome": dict(dome=[0.45, 0.85], flare=[-0.2, 0.15], peak=0, umbo=0, wave=0, scale=1.0),
    "parasol": dict(dome=[0.06, 0.2], flare=[0.0, 0.18], peak=0, umbo=[0, 0.35], wave=0, scale=1.2),
    "cone": dict(dome=[0.35, 0.65], flare=[-0.25, 0.05], peak=[0.55, 1], umbo=0, wave=0, scale=0.85),
    "funnel": dict(dome=[0.04, 0.18], flare=[0.55, 0.95], peak=0, umbo=0, wave=[0, 0.3], scale=1.0),
    "umbo": dict(dome=[0.12, 0.32], flare=[0.0, 0.25], peak=0, umbo=[0.6, 1.0], wave=0, scale=1.05),
    "wavy": dict(dome=[0.18, 0.42], flare=[0.05, 0.35], peak=0, umbo=0, wave=[0.45, 0.9], scale=1.05),
}
MAX_TIP = 0.95  # caps never tip further than ~54 degrees from upright


class MushroomFrame:
    """Everything about a mushroom's shape that geometry and collisions share."""

    def __init__(self, m):
        self.out = out = V3(math.cos(m["dir"]), 0, math.sin(m["dir"]))
        kAxis = UP.cross(out).normalized()
        D_top = UP.axis_angle(kAxis, clamp(m["lean"], 0, 1.45))
        self.f = f = 0.55 - 0.15 * m["bend"]
        chord = UP.axis_angle(kAxis, clamp(m["lean"] * f, 0, 1.4))
        self.P0 = P0 = V3(m["x"], foot(m["x"], m["z"]) - 0.02, m["z"])
        self.P3 = P3 = P0.adds(chord, m["height"])
        P1 = P0.adds(UP, m["height"] * 0.38 * (1 - 0.35 * m["bend"])).adds(out, -m["height"] * 0.04 * m["bend"])
        P2 = P3.adds(D_top, -m["height"] * (0.22 + 0.3 * m["bend"]))
        self.ctrl = (P0, P1, P2, P3)
        self.prof = prof = cap_profile(m)
        self.topR = topR = m["stemRadius"] * 0.62
        A = D_top.axis_angle(kAxis, m["capTilt"]).normalized()
        self.X, self.Y, self.Z = basis_from(A)
        self.T0 = P3.adds(A, -prof["lip"] * 0.3)
        self.rs = topR * 1.05
        self.yU0 = prof["yRim"] - prof["lip"]
        self.stemRadius = m["stemRadius"]

    def curve(self, t):
        return bezier(*self.ctrl, t)

    def radius_at(self, t):
        rad = self.stemRadius * (1 - 0.38 * t + 0.6 * math.exp(-math.pow(t / 0.07, 2)) + 0.1 * math.exp(-math.pow((t - 0.2) / 0.12, 2)))
        return lerp(rad, self.topR * 1.25, smooth(0.86, 1, t))

    def toW(self, lx, ly, lz):
        X, Y, Z, T = self.X, self.Y, self.Z, self.T0
        return V3(T.x + X.x * lx + Y.x * ly + Z.x * lz, T.y + X.y * lx + Y.y * ly + Z.y * lz, T.z + X.z * lx + Y.z * ly + Z.z * lz)


def under_y(F, r):
    R = F.prof["R"]
    if r >= R * 0.985:
        return F.yU0
    if r <= F.rs:
        return 0
    w = (R * 0.985 - r) / (R * 0.985 - F.rs)
    return F.yU0 * math.pow(1 - w, 0.75)


def gen_mushrooms(p, r, pal, n, offset=(0.0, 0.0)):
    sizes = sorted((1 - p["sizeVariety"] * 0.78 * math.pow(r(), 0.85) for _ in range(n)), reverse=True)
    bases = []
    items = []
    for i, sF in enumerate(sizes):
        height = p["size"] * (0.22 + 0.9 * math.pow(sF, 1.25)) * (1 + p["heightVariety"] * (r() * 2 - 1) * 0.5)
        capRadius = p["size"] * 0.36 * (0.38 + 0.62 * sF) * (0.85 + 0.3 * r())
        foot = capRadius * 0.17 * 1.65 + 0.004
        ang = dist = x = z = 0.0
        for tries in range(40):
            ang = r() * TAU
            dist = p["spread"] * math.sqrt(r()) * (0.15 if i == 0 else 0.3 + 0.7 * (1 - sF * 0.6)) * (1 + tries * 0.04)
            x = math.cos(ang) * dist + offset[0]
            z = math.sin(ang) * dist * p["depth"] + (0.5 - sF) * p["spread"] * p["depth"] * 0.9 + offset[1]
            if all(math.hypot(q[0] - x, q[1] - z) > q[2] + foot for q in bases):
                break
        bases.append((x, z, foot))
        outward = clamp(dist / p["spread"], 0, 1) if p["spread"] > 1e-4 else 0
        pair = pal["caps"][math.floor(r() * len(pal["caps"]))]
        flip = r() < 0.5
        v = clamp(p.get("capVariety", 0.6), 0, 1)
        names = list(CAP_STYLES)
        weights = [1 if nm == "dome" else v * 0.5 for nm in names]
        pick = r() * sum(weights)
        style = "dome"
        for q, nm in enumerate(names):
            pick -= weights[q]
            if pick <= 0:
                style = nm
                break
        st = CAP_STYLES[style]

        def val(x_):
            return lerp(x_[0], x_[1], r()) if isinstance(x_, list) else x_

        flare = clamp(val(st["flare"]) + (p["flare"] - 0.1) * 0.8 + (r() * 2 - 1) * p["flareVariety"] * 0.15, -1, 1)
        if flare < -0.4:
            flare = -0.4 + (flare + 0.4) * 0.35
        shape = {}
        shape["dome"] = r4(clamp(val(st["dome"]) + (p["dome"] - 0.42) * 0.8 + (r() * 2 - 1) * p["domeVariety"] * 0.12, 0.03, 1))
        shape["flare"] = r4(flare)
        shape["peak"] = r4(val(st["peak"]))
        shape["umbo"] = r4(val(st["umbo"]))
        shape["wave"] = r4(val(st["wave"]))
        shape["waves"] = jround(lerp(5, 9, r()))
        shape["style"] = style
        it = {"kind": "mushroom", "x": r4(x), "z": r4(z), "height": r4(height)}
        it["stemRadius"] = r4(capRadius * (0.11 + 0.06 * r()))
        it["lean"] = r4(clamp(p["lean"] * (0.2 + 0.95 * outward) * (0.6 + 0.8 * r()) + (1 - sF) * p["lean"] * 0.5, 0, 1.05))
        it["dir"] = r4(math.atan2(math.sin(ang) * p["depth"], math.cos(ang)) + (r() - 0.5) * 0.9)
        it["bend"] = r4(p["bend"] * (0.5 + r()))
        it["capRadius"] = r4(capRadius * st["scale"])
        it.update(shape)
        it["capTilt"] = r4(p["tilt"] * (0.25 + r() * 1.1))
        it["capColorA"] = jitter_hex(pair[1] if flip else pair[0], r, 0.05)
        it["capColorB"] = jitter_hex(pair[0] if flip else pair[1], r, 0.05)
        it["stemColor"] = jitter_hex(pal["stem"], r, 0.04)
        it["glowColor"] = jitter_hex(pal["glow"], r, 0.03)
        it["spotColor"] = pal["spot"]
        it["glow"] = r4(p["glow"] * (0.8 + 0.4 * r()))
        it["gills"] = jround(lerp(26, 46, r()))
        it["spots"] = r4(p["spots"] * (0.6 + 0.6 * r()))
        it["spotSize"] = r4(p["spotSize"])
        it["spotSeed"] = math.floor(r() * 1e9)
        it["phase"] = r4(r() * TAU)
        items.append(it)
    if p["separation"] > 0:
        separate_caps(items, p["separation"], 40, p["depth"])
    for m in items:
        # A sidescroller sees the patch from +z: caps do not flatten out toward the camera.
        fwd = max(0, math.sin(m["dir"]))
        m["lean"] = r4(min(m["lean"], 1.05 - 0.35 * fwd))
        m["capTilt"] = r4(m["capTilt"] * (1 - 0.65 * fwd))
        # The cap's whole tip (lean + tilt) stays within MAX_TIP of upright.
        m["capTilt"] = r4(clamp(m["capTilt"], -0.6 * m["lean"], MAX_TIP - m["lean"]))
    return items


def separate_caps(lst, strength=1.0, iterations=40, depth=1):
    caps = []
    for m in lst:
        F = MushroomFrame(m)
        caps.append({"m": m, "f": F.f, "base": F.P0.copy(), "p": F.P3.copy()})
    for i_ in range(iterations):
        moved = False
        for i in range(len(caps)):
            for j in range(i + 1, len(caps)):
                A, B = caps[i], caps[j]
                minD = (A["m"]["capRadius"] + B["m"]["capRadius"]) * strength
                d = A["p"] - B["p"]
                dv = V3(d.x, d.y * 1.6, d.z)
                ln = dv.length()
                if ln >= minD:
                    continue
                moved = True
                if ln < 1e-5:
                    dv.set(math.cos(i * 2.4), 0.3, math.sin(i * 2.4))
                dv = dv.normalized()
                dv.z *= depth
                push = (minD - ln) * 0.5
                wa = B["m"]["capRadius"] / (A["m"]["capRadius"] + B["m"]["capRadius"])
                A["p"] = A["p"].adds(dv, push * wa)
                B["p"] = B["p"].adds(dv, -push * (1 - wa))
        for c in caps:
            c["p"].y = max(c["p"].y, c["base"].y + 0.02 + c["m"]["capRadius"] * 0.9 + 0.02)
        if not moved:
            break
    for c in caps:
        set_mushroom_top(c["m"], c["p"])
    return lst


def set_mushroom_top(m, top):
    base = V3(m["x"], foot(m["x"], m["z"]) - 0.02, m["z"])
    v = top - base
    ln = max(v.length(), 0.03)
    ang = math.acos(clamp(v.y / ln, -1, 1))
    f = 0.55 - 0.15 * m["bend"]
    m["height"] = r4(ln)
    m["lean"] = r4(clamp(ang / f, 0, 1.1))
    if math.hypot(v.x, v.z) > 1e-4:
        m["dir"] = r4(math.atan2(v.z, v.x))
    if m["capTilt"] > MAX_TIP - m["lean"]:
        m["capTilt"] = r4(MAX_TIP - m["lean"])


def mushroom_geometry(m, D, b):
    F = MushroomFrame(m)
    glowC, stemC, capA, capB = col(m["glowColor"]), col(m["stemColor"]), col(m["capColorA"]), col(m["capColorB"])
    spotC = col(m.get("spotColor") or "#ffffff")
    amp, wp = sway_amp(m), wind_phase(m)
    glow, phase = m["glow"], m["phase"]

    def SW(hf):
        return (wp, amp, hf, phase)

    # stem
    nL = D["stemL"]
    pts, radii = [], []
    for k in range(nL + 1):
        t = k / nL
        pts.append(F.curve(t))
        radii.append(F.radius_at(t) * (1 + 0.05 * math.sin(t * 11 + phase * 3)))

    def stem_attr(k, a):
        t = k / nL
        stripe = 1 + 0.08 * math.sin(a * 7 + t * 4 + phase)
        cc = cmul(clerp(stemC, glowC, 0.18 * t * t), stripe * (0.9 + 0.1 * t))
        g = cadd(cmul(glowC, glow * (0.02 + 0.36 * math.pow(t, 2.2))), cmul(stemC, 0.1 * glow))
        return cc, g, STEMGILL, SW(t)

    b.tube(pts, radii, D["stemR"], stem_attr)
    # cap
    pr_ = F.prof
    R, lip, yRim, top = pr_["R"], pr_["lip"], pr_["yRim"], pr_["top"]
    profile = []
    for i in range(1, D["top"] + 1):
        u = math.pow(i / D["top"], 0.9)
        profile.append(dict(r=R * u, y=top(u), kind="top", w=u))
    profile.append(dict(r=R * 1.015, y=yRim - lip * 0.5, kind="lip", w=1))
    for i in range(D["under"] + 1):
        w = i / D["under"]
        profile.append(dict(r=lerp(R * 0.985, F.rs, w), y=F.yU0 * math.pow(1 - w, 0.75), kind="under", w=w))

    def cap_self(cc):
        return cmul(cc, 0.2 * glow)

    def cap_attr(i, a):
        if i < 0:
            return capA, cap_self(capA), NOGILL, SW(1)
        pr = profile[i]
        if pr["kind"] == "top":
            mott = 1 + 0.05 * math.sin(a * 5 + pr["w"] * 9 + phase) * math.sin(a * 3 - pr["w"] * 5)
            cc = cmul(clerp(capA, capB, smooth(0.05, 1, pr["w"])), mott)
            return cc, cadd(cap_self(cc), cmul(glowC, glow * 0.3 * math.pow(pr["w"], 7))), NOGILL, SW(1)
        if pr["kind"] == "lip":
            cc = clerp(capB, WHITE, 0.25)
            return cc, cadd(cap_self(cc), cmul(glowC, glow * 0.45)), NOGILL, SW(1)
        cc = clerp(clerp(glowC, WHITE, 0.55), capB, 0.2)
        return cc, cmul(glowC, glow * (0.22 + 0.42 * pr["w"])), (math.cos(a), math.sin(a), 0.05 + 0.95 * pr["w"], m["gills"]), SW(1)

    b.lathe(F.toW, profile, D["capSeg"], cap_attr, top(0), None, None, lambda i, a: pr_["waveAt"](profile[i]["r"] / R, a))
    # spots
    if D["spots"] and m["spots"] > 0:
        sr = rng(m.get("spotSeed") or 1)
        want = jround(m["spots"] * 26)
        placed = []
        uMin, uMax = 0.1, 0.9
        tries = 0
        while tries < want * 12 and len(placed) < want:
            tries += 1
            u = math.sqrt(sr() * (uMax * uMax - uMin * uMin) + uMin * uMin)
            a = sr() * TAU
            rS = R * lerp(0.035, 0.085, math.pow(sr(), 1.6)) * m["spotSize"] * (1.15 - 0.4 * u)
            px, pz = R * u * math.cos(a), R * u * math.sin(a)
            if any(math.hypot(q[0] - px, q[1] - pz) < (q[2] + rS) * 1.35 for q in placed):
                continue
            placed.append((px, pz, rS, u, a))
        seg = D["spotSeg"]
        ringC = clerp(spotC, glowC, 0.45)
        gS = cmul(spotC, 0.22 * glow)

        def S(u, a):
            return V3(R * u * math.cos(a), top(u) + pr_["waveAt"](u, a), R * u * math.sin(a))

        for (_px, _pz, s_r, s_u, s_a) in placed:
            du = da = 0.01
            dU = S(min(1, s_u + du), s_a) - S(max(0, s_u - du), s_a)
            dA = S(s_u, s_a + da) - S(s_u, s_a - da)
            nl = dA.cross(dU).normalized()
            if nl.y < 0:
                nl = -nl
            nW = (F.X * nl.x).adds(F.Y, nl.y).adds(F.Z, nl.z).normalized()
            sp0 = S(s_u, s_a)
            base = F.toW(sp0.x, sp0.y, sp0.z)
            fX, fY, fZ = basis_from(nW)
            h = s_r * 0.38

            def toW(lx, ly, lz, base=base, fX=fX, fY=fY, fZ=fZ):
                return base.adds(fX, lx).adds(fY, ly).adds(fZ, lz)

            b.lathe(toW, [dict(r=s_r * 0.62, y=h * 0.72), dict(r=s_r, y=-h * 0.25)], seg,
                    lambda i, a: (ringC, cmul(ringC, 0.25 * glow), NOGILL, SW(1)) if i == 1 else (spotC, gS, NOGILL, SW(1)), h)


def mushroom_shape(m):
    F = MushroomFrame(m)
    pr_ = F.prof
    R, lip, yRim, top = pr_["R"], pr_["lip"], pr_["yRim"], pr_["top"]
    topPad = 0.045 * R * m["spotSize"] if m["spots"] > 0 else 0
    waveAmp, waveAt = pr_["waveAmp"], pr_["waveAt"]

    def inside(p, pad):
        v = p - F.T0
        ly = v.dot(F.Y)
        r = math.hypot(v.dot(F.X), v.dot(F.Z))
        if r > R * 1.015 + pad:
            return False
        u = min(r / R, 1)
        wv = waveAmp * u * u * u
        yTop = top(u) + topPad + pad + wv
        yBot = (0 if r <= F.rs else under_y(F, r)) - pad - wv
        return yBot <= ly <= yTop

    cap = Solid("cap", F.toW(0, (top(0) + F.yU0) * 0.5, 0), inside)
    sp = max(0.11 * R, 0.005)
    pts = []
    u = 0.0
    while u <= 1.0001:
        uu = min(u, 1)
        rr = R * uu
        nA = max(1, math.ceil(TAU * rr / sp))
        for j in range(nA):
            a = j / nA * TAU
            pts.append(F.toW(rr * math.cos(a), top(uu) + topPad + waveAt(uu, a), rr * math.sin(a)))
        u += sp / R
    rr = R * 1.015
    nA = math.ceil(TAU * rr / sp)
    for j in range(nA):
        a = j / nA * TAU
        pts.append(F.toW(rr * math.cos(a), yRim - lip * 0.5 + waveAt(1, a), rr * math.sin(a)))
    span = R * 0.985 - F.rs
    w = 0.0
    while w <= 1.0001:
        ww = min(w, 1)
        rr = lerp(R * 0.985, F.rs, ww)
        nA = max(3, math.ceil(TAU * rr / sp))
        for j in range(nA):
            a = j / nA * TAU
            pts.append(F.toW(rr * math.cos(a), F.yU0 * math.pow(1 - ww, 0.75) + waveAt(rr / R, a), rr * math.sin(a)))
        w += sp / max(span, 1e-4)
    nT = clamp(math.ceil(m["height"] / 0.01), 8, 120)
    tp, tr, tt = [], [], []
    for k in range(nT + 1):
        t = k / nT
        tp.append(F.curve(t))
        tr.append(F.radius_at(t) * 1.06)
        tt.append(t)
    A = sway_amp(m)
    cap.w = A
    return Shape("mushroom", R, A, [cap], [Samples("cap", pts, sp * 0.75, A)],
                 [Tube("stem", tp, tr, tt, [A * t * t for t in tt], ignore_mound=True)])


# ------------------------------------------------------------------ lantern bloom

class LanternFrame:
    def __init__(self, it):
        self.out = out = V3(math.cos(it["dir"]), 0, math.sin(it["dir"]))
        base = foot(it["x"], it["z"])
        self.B = B = V3(it["x"], base - 0.02, it["z"])
        self.R = R = it["bulbRadius"]
        self.halfH = R * it["bulbLength"]
        self.neck = 0.15 * R
        self.drip = 0.25 * R
        self.reach = reach = max(it["arch"] * it["height"] * 0.5, R * 1.8 + 0.03)
        H = it["height"]
        P1 = B.adds(UP, H * 0.8)
        P2 = B.adds(out, reach).adds(UP, H * 1.0)
        self.tip = tip = B.adds(out, reach).adds(UP, H * 0.9)
        self.ctrl = (B, P1, P2, tip)
        self.bulbTop = tip.adds(UP, -self.neck)
        self.stalkRadius = it["stalkRadius"]
        L = max(0, jround(it["leaves"]))
        self.leaves = []
        for l in range(L):
            az = it["dir"] + math.pi / max(L, 1) + l * TAU / max(L, 1) + (it.get("rot") or 0)
            o = V3(math.cos(az), 0, math.sin(az))
            side = V3(-o.z, 0, o.x)
            r0 = it["stalkRadius"] * 1.3 + 0.006
            n = 9
            C, W = [], []
            for k in range(n + 1):
                s = k / n
                d = r0 + it["leafLength"] * 0.85 * s
                c = V3(it["x"], 0, it["z"]).adds(o, d)
                c.y = under(c.x, c.z, base) + max(0.012, it["leafLength"] * 0.42 * math.sin(math.pi * s * 0.85) * (1 - 0.3 * s) + 0.004)
                C.append(c)
                w = it["leafLength"] * 0.13 * math.pow(math.sin(math.pi * min(1, s * 1.02 + 0.02)), 0.7)
                if L >= 2:
                    w = min(w, d * math.sin(math.pi / L) * 0.85 - 0.002)
                W.append(max(0.0008, w))
            self.leaves.append((C, W, side))

    def curve(self, t):
        return bezier(*self.ctrl, t)

    def bulb_profile(self, v):
        return self.R * (0.18 + 0.82 * math.pow(math.sin(math.pi * math.pow(v, 0.85)), 0.9))

    def stalk_r(self, t):
        return self.stalkRadius * lerp(1.3, 0.75, t)


def fix_lantern_height(it):
    R = it["bulbRadius"]
    need = 0.045 + 0.25 * R + 2 * R * it["bulbLength"] + 0.15 * R
    if it["height"] * 0.9 < need:
        it["height"] = r4(need / 0.9 + 0.005)


def gen_lantern(p, r, pal, x, z, sF=1):
    pair = pal["bulb"][math.floor(r() * len(pal["bulb"]))]
    it = {"kind": "lantern", "x": r4(x), "z": r4(z)}
    it["height"] = r4(p["size"] * (1 - p["sizeVariety"] * 0.6 * r()) * sF)
    it["arch"] = r4(clamp(p["arch"] * (0.7 + 0.6 * r()), 0, 1.2))
    it["dir"] = r4(r() * TAU)
    it["stalkRadius"] = r4(0.007 * (p["size"] / 0.7) * (0.85 + 0.3 * r()))
    it["bulbRadius"] = r4(0.045 * p["bulbSize"] * (p["size"] / 0.7) * (0.8 + 0.4 * r()))
    it["bulbLength"] = r4(p["bulbLength"] * (0.85 + 0.3 * r()))
    it["ribs"] = jround(p["ribs"])
    it["leaves"] = jround(p["leaves"])
    it["leafLength"] = r4(p["size"] * 0.28 * (0.8 + 0.4 * r()))
    it["rot"] = 0
    it["stalkColor"] = jitter_hex(pal["stalk"], r, 0.04)
    it["bulbColorA"] = jitter_hex(pair[0], r, 0.04)
    it["bulbColorB"] = jitter_hex(pair[1], r, 0.04)
    it["glowColor"] = jitter_hex(pal["glow"], r, 0.03)
    it["glow"] = r4(p["glow"] * (0.85 + 0.3 * r()))
    it["phase"] = r4(r() * TAU)
    # Face the bulb sideways more than toward or away from the camera.
    it["dir"] = r4(math.atan2(math.sin(it["dir"]) * 0.45, math.cos(it["dir"])))
    fix_lantern_height(it)
    return it


def lantern_geometry(it, D, b):
    F = LanternFrame(it)
    glowC, stalkC, bA, bB = col(it["glowColor"]), col(it["stalkColor"]), col(it["bulbColorA"]), col(it["bulbColorB"])
    amp, wp = sway_amp(it), wind_phase(it)
    glow, phase = it["glow"], it["phase"]

    def SW(hf):
        return (wp, amp, hf, phase)

    n = jround(lerp(6, 22, D["ribbon"]))
    pts = [F.curve(k / n) for k in range(n + 1)]
    radii = [F.stalk_r(k / n) for k in range(n + 1)]
    b.tube(pts, radii, max(4, D["tubeR"]), lambda k, a: (
        cmul(stalkC, 0.75 + 0.25 * k / n), cadd(cmul(glowC, glow * 0.08 * (k / n) ** 2), cmul(stalkC, 0.06 * glow)), STEMGILL, SW(k / n)))
    # calyx: the little lobed cap the bulb hangs from
    cTop = F.tip.adds(UP, 0.004)
    b.lathe(lambda lx, ly, lz: V3(cTop.x + lx, cTop.y + ly, cTop.z + lz),
            [dict(r=F.R * 0.2, y=-F.neck * 0.3), dict(r=F.R * 0.38, y=-F.neck * 1.25)], max(6, D["lathe"] // 2),
            lambda i, a: (cmul(stalkC, 0.8), cmul(stalkC, 0.05), NOGILL, SW(1)), 0.002, None,
            lambda i, a: 1 + 0.25 * math.cos(a * 5) if i == 1 else 1)
    # bulb
    rings = jround(lerp(5, 13, D["ribbon"]))
    prof = [dict(r=F.bulb_profile(i / rings), y=-2 * F.halfH * i / rings, v=i / rings) for i in range(rings + 1)]
    bt = F.bulbTop

    def bulb_attr(i, a):
        v = 0 if i < 0 else 1 if i >= len(prof) else prof[i]["v"]
        cc = clerp(bA, bB, smooth(0, 1, v))
        g = cmul(clerp(cc, glowC, 0.45), glow * (0.45 + 0.4 * math.sin(math.pi * v)))
        return cc, g, (math.cos(a), math.sin(a), 0.9, it["ribs"]), SW(1)

    b.lathe(lambda lx, ly, lz: V3(bt.x + lx, bt.y + ly, bt.z + lz), prof, D["lathe"], bulb_attr, 0, -2 * F.halfH - F.drip,
            lambda i, a: 1 + 0.06 * math.cos(a * it["ribs"]))
    # leaves
    for C, W, side in F.leaves:
        lc = clerp(stalkC, bA, 0.15)

        def leaf_attr(k, j, C=C):
            s = k / (len(C) - 1)
            g = cmul(glowC, glow * (0.35 if j == 0 else 0.05) * (0.3 + 0.7 * s))
            return cmul(lc, 0.7 + 0.3 * s), g, NOGILL, SW(0.12 * s)

        b.ribbon(C, [side] * len(C), W, leaf_attr)


def lantern_shape(it):
    F = LanternFrame(it)
    nT = clamp(math.ceil(it["height"] * 1.6 / 0.01), 10, 160)
    tt = [k / nT for k in range(nT + 1)]
    tp = [F.curve(t) for t in tt]
    tr = [F.stalk_r(t) * 1.05 for t in tt]
    top, R, H2 = F.bulbTop, F.R, 2 * F.halfH

    def inside(p, pad):
        v = (top.y - p.y) / H2
        if v < -(pad + F.neck * 1.3) / H2 or v > 1 + (F.drip + pad) / H2:
            return False
        rr = math.hypot(p.x - top.x, p.z - top.z)
        prof = R * 0.4 if v < 0 else R * 0.2 if v > 1 else max(F.bulb_profile(v), R * 0.2)
        return rr <= prof * 1.07 + pad

    A = sway_amp(it)
    bulb = Solid("bulb", top.adds(UP, -F.halfH), inside, A)
    sp = max(0.15 * R, 0.004)
    pts = []
    v = 0.0
    while v <= 1.0001:
        rr = F.bulb_profile(min(v, 1)) * 1.06
        nA = max(3, math.ceil(TAU * rr / sp))
        for j in range(nA):
            a = j / nA * TAU
            pts.append(V3(top.x + rr * math.cos(a), top.y - H2 * min(v, 1), top.z + rr * math.sin(a)))
        v += sp / H2
    pts.append(V3(top.x, top.y - H2 - F.drip, top.z))
    tubes = [Tube("stalk", tp, tr, tt, [A * t * t for t in tt])]
    for li, (C, W, _side) in enumerate(F.leaves):
        n1 = len(C) - 1
        tubes.append(Tube(f"leaf{li}", [c.copy() for c in C], [w + 0.0015 for w in W], [k / n1 for k in range(len(C))],
                          [A * math.pow(0.12 * k / n1, 2) for k in range(len(C))], leaf=True))
    s = Shape("lantern", R * 2.2, A, [bulb], [Samples("bulb", pts, sp * 0.75, A)], tubes)
    s.bulb_bottom = top.y - H2 - F.drip
    s.bulb_x, s.bulb_z = top.x, top.z
    return s


# ------------------------------------------------------------------ fern

def fern_fronds(it, segs=24):
    r = rng(int(it.get("seed") or 1) & 0xFFFFFFFF)
    Fn = max(3, jround(it["fronds"]))
    D = TAU / Fn
    crown = 0.035 * it["length"] / 0.5 + 0.01
    C = V3(it["x"], foot(it["x"], it["z"]), it["z"])
    fronds = []
    for f in range(Fn):
        az = (it.get("rot") or 0) + f * D + (r() - 0.5) * D * 0.25
        young = r() < it["curl"]
        Lf = it["length"] * (0.55 if young else 0.8 + 0.25 * r())
        curlAmt = 1 if young else 0.25 * r()
        e0 = lerp(0.5, 1.4, it["tilt"]) + (r() - 0.5) * 0.25
        droop = it["droop"] * (0.8 + 0.4 * r())
        o = V3(math.cos(az), 0, math.sin(az))
        pts, sArr = [], []
        P = C.adds(o, crown * 0.7)
        P.y = under(P.x, P.z, C.y) + 0.015
        ds = Lf / segs
        for k in range(segs + 1):
            s = k / segs
            pts.append(P.copy())
            sArr.append(s)
            e = e0 - droop * 1.9 * s - curlAmt * 6.0 * math.pow(smooth(0.68, 1, s), 1.2)
            P = P.adds(o, math.cos(e) * ds).adds(UP, math.sin(e) * ds)
            floor = under(P.x, P.z, C.y) + 0.015
            if P.y < floor:
                P.y = floor
        halfWedge = D * 0.75 / 2

        def leaf_len(k, pts=pts, sArr=sArr, Lf=Lf, curlAmt=curlAmt, halfWedge=halfWedge):
            s = sArr[k]
            p = pts[k]
            hd = math.hypot(p.x - C.x, p.z - C.z)
            lmax = it["width"] * Lf * 0.2 * math.pow(math.sin(math.pi * clamp((s - 0.08) / 0.92, 0, 1)), 0.6) * (1 - 0.65 * curlAmt * smooth(0.6, 1, s))
            return max(0, min(lmax, hd * math.sin(halfWedge) * 0.85 - 0.004))

        fronds.append(dict(az=az, o=o, pts=pts, sArr=sArr, Lf=Lf, curlAmt=curlAmt, leafLen=leaf_len, young=young))
    return fronds, crown, C


def gen_fern(p, r, pal, x, z, sF=1):
    it = {"kind": "fern", "x": r4(x), "z": r4(z)}
    it["length"] = r4(p["size"] * (1 - p["sizeVariety"] * 0.5 * r()) * sF)
    it["fronds"] = jround(p["fronds"])
    it["tilt"] = r4(clamp(p["tilt"] + (r() - 0.5) * 0.15, 0, 1))
    it["droop"] = r4(p["droop"] * (0.85 + 0.3 * r()))
    it["curl"] = r4(p["curl"])
    it["leaflets"] = jround(p["leaflets"])
    it["width"] = r4(p["width"])
    it["rot"] = r4(r() * TAU)
    it["seed"] = math.floor(r() * 1e9)
    it["leafColorA"] = jitter_hex(pal["leaf"][0], r, 0.04)
    it["leafColorB"] = jitter_hex(pal["leaf"][1], r, 0.04)
    it["glowColor"] = jitter_hex(pal["glow"], r, 0.03)
    it["glow"] = r4(p["glow"] * (0.85 + 0.3 * r()))
    it["phase"] = r4(r() * TAU)
    return it


def fern_geometry(it, D, b):
    segs = jround(lerp(8, 24, D["ribbon"]))
    fronds, crown, C = fern_fronds(it, segs)
    glowC, lA, lB = col(it["glowColor"]), col(it["leafColorA"]), col(it["leafColorB"])
    amp, wp = sway_amp(it), wind_phase(it)
    glow, phase = it["glow"], it["phase"]

    def SW(hf):
        return (wp, amp, hf, phase)

    b.lathe(lambda lx, ly, lz: V3(C.x + lx, C.y + ly + crown * 0.15, C.z + lz),
            [dict(r=crown * 0.55, y=crown * 0.45), dict(r=crown, y=crown * 0.1), dict(r=crown * 0.9, y=-crown * 0.4)], max(6, D["lathe"] // 2),
            lambda i, a: (cmul(lA, 0.55), cmul(glowC, 0.12 * glow), STEMGILL, SW(0)), crown * 0.6, None,
            lambda i, a: 1 + 0.12 * math.cos(a * 3 + i))
    nLeaf = max(3, jround(it["leaflets"] * lerp(0.45, 1, D["ribbon"])))
    nq = 3 if D["ribbon"] > 0.8 else 2 if D["ribbon"] > 0.5 else 1
    for fr in fronds:
        fpts, sArr = fr["pts"], fr["sArr"]
        radii = [0.0035 * (it["length"] / 0.5) * lerp(1.2, 0.5, sArr[k]) for k in range(len(fpts))]
        b.tube(fpts, radii, max(3, D["tubeR"] - 2), lambda k, a, sArr=sArr: (
            cmul(clerp(lA, lB, sArr[k]), 0.8), cmul(glowC, glow * (0.3 + 0.4 * sArr[k])), STEMGILL, SW(sArr[k])), True)
        for q in range(nLeaf):
            sq = 0.12 + 0.86 * (q / max(1, nLeaf - 1))
            kf = sq * (len(fpts) - 1)
            k0 = math.floor(kf)
            k1 = min(len(fpts) - 1, k0 + 1)
            w = kf - k0
            P = fpts[k0].lerp(fpts[k1], w)
            l = lerp(fr["leafLen"](k0), fr["leafLen"](k1), w)
            if l < 0.004:
                continue
            T = (fpts[k1] - fpts[max(0, k0 - (1 if k1 == k0 else 0))]).normalized()
            if T.length_sq() < 0.5:
                continue
            side = T.cross(UP)
            if side.length_sq() < 1e-6:
                side = V3(-fr["o"].z, 0, fr["o"].x)
            side = side.normalized()
            spacing = fr["Lf"] * 0.86 / max(1, nLeaf - 1)
            for sgn in (-1, 1):
                d = (side * (sgn * math.cos(0.42))).adds(T, math.sin(0.42)).adds(UP, -0.12).normalized()
                Cl, Wl, Sl = [], [], []
                for i in range(nq + 1):
                    t = i / nq
                    pos = P.adds(d, l * t).adds(UP, -0.1 * l * t * t)
                    floor = under(pos.x, pos.z, C.y) + 0.008
                    if pos.y < floor:
                        pos.y = floor
                    Cl.append(pos)
                    Wl.append(min(l * 0.34, spacing * 0.45) * math.pow(math.sin(math.pi * (0.18 + 0.82 * t)), 0.8) + 0.0004)
                    Sl.append(T)

                def leaflet_attr(k, j, sq=sq):
                    t = k / nq
                    cc = clerp(lA, lB, sq * 0.8 + 0.2 * t)
                    g = cadd(cmul(glowC, glow * ((0.36 if j == 0 else 0.05) + 0.22 * t * t) * (0.5 + 0.5 * sq)), cmul(cc, 0.12 * glow))
                    return cc, g, NOGILL, SW(sq)

                b.ribbon(Cl, Sl, Wl, leaflet_attr)


def fern_shape(it):
    fronds, crown, C = fern_fronds(it, 28)
    A = sway_amp(it)
    tubes = []
    for fi, fr in enumerate(fronds):
        h = fr["Lf"] / 28
        tubes.append(Tube(f"frond{fi}", [p.copy() for p in fr["pts"]],
                          [0.0035 * (it["length"] / 0.5) * 1.2 + fr["leafLen"](k) * 1.1 + h * 0.6 for k in range(len(fr["pts"]))],
                          list(fr["sArr"]), [A * s * s for s in fr["sArr"]]))
    centre = V3(C.x, C.y + crown * 0.25, C.z)
    crownS = Solid("crown", centre, lambda p, pad: p.distance(centre) <= crown * 1.15 + pad, 0)
    return Shape("fern", it["length"], A, [crownS], [], tubes)


# ------------------------------------------------------------------ reed

def reed_blades(it, segs=16):
    r = rng(int(it.get("seed") or 1) & 0xFFFFFFFF)
    N = max(3, jround(it["blades"]))
    D = TAU / N
    C = V3(it["x"], foot(it["x"], it["z"]), it["z"])
    halfWedge = D * 0.7 / 2
    blades = []
    for k in range(N):
        az = (it.get("rot") or 0) + k * D + (r() - 0.5) * D * 0.3
        o = V3(math.cos(az), 0, math.sin(az))
        side = V3(-o.z, 0, o.x)
        hb = it["height"] * (0.55 + 0.45 * r())
        lb = it["lean"] * (0.4 + 0.9 * r())
        hasPod = r() < it["orbs"]
        pts, sArr, W = [], [], []
        P = C.adds(o, 0.012)
        P.y = C.y - 0.02
        ds = hb / segs
        wBase = it["width"] * 0.011 * math.sqrt(it["height"] / 0.7)
        for i in range(segs + 1):
            s = i / segs
            pts.append(P.copy())
            sArr.append(s)
            hd = math.hypot(P.x - C.x, P.z - C.z)
            w = wBase * (1 - 0.85 * math.pow(s, 1.4)) * (0.55 if hasPod else 1)
            w = min(w, hd * math.sin(halfWedge) * 0.85 - 0.0012)
            W.append(max(0.0006, w))
            a = lb * (0.25 + 1.1 * s * s)
            P = P.adds(o, math.sin(a) * ds).adds(UP, math.cos(a) * ds)
        pod = None
        if hasPod:
            sc = 0.76
            kf = sc * segs
            k0 = math.floor(kf)
            c = pts[k0].lerp(pts[k0 + 1], kf - k0)
            T = (pts[k0 + 1] - pts[k0]).normalized()
            lowEnd = c.adds(T, -0.06 * hb)
            hd = math.hypot(lowEnd.x - C.x, lowEnd.z - C.z)
            rp = max(0.004, min(it["orbSize"] * 0.02 * math.sqrt(it["height"] / 0.7), hd * math.sin(halfWedge) * 0.8 - 0.002))
            pod = dict(c=c, T=T, rp=rp, half=min(rp * 2.4, 0.055 * hb), s=sc)
        blades.append(dict(az=az, o=o, side=side, pts=pts, sArr=sArr, W=W, pod=pod, hb=hb))
    return blades, C


def gen_reed(p, r, pal, x, z, sF=1):
    it = {"kind": "reed", "x": r4(x), "z": r4(z)}
    it["height"] = r4(p["size"] * (1 - p["sizeVariety"] * 0.5 * r()) * sF)
    it["blades"] = jround(p["blades"])
    it["lean"] = r4(p["lean"] * (0.85 + 0.3 * r()))
    it["width"] = r4(p["width"])
    it["orbs"] = r4(p["orbs"])
    it["orbSize"] = r4(p["orbSize"])
    it["rot"] = r4(r() * TAU)
    it["seed"] = math.floor(r() * 1e9)
    it["bladeColorA"] = jitter_hex(pal["reed"][0], r, 0.04)
    it["bladeColorB"] = jitter_hex(pal["reed"][1], r, 0.04)
    it["glowColor"] = jitter_hex(pal["glow"], r, 0.03)
    it["glow"] = r4(p["glow"] * (0.85 + 0.3 * r()))
    it["phase"] = r4(r() * TAU)
    return it


def reed_geometry(it, D, b):
    segs = jround(lerp(5, 16, D["ribbon"]))
    blades, _C = reed_blades(it, segs)
    glowC, cA, cB = col(it["glowColor"]), col(it["bladeColorA"]), col(it["bladeColorB"])
    amp, wp = sway_amp(it), wind_phase(it)
    glow, phase = it["glow"], it["phase"]

    def SW(hf):
        return (wp, amp, hf, phase)

    for bl in blades:
        def blade_attr(k, j, bl=bl):
            s = bl["sArr"][k]
            cc = cmul(clerp(cA, cB, s), 0.7 + 0.3 * s)
            g = cmul(glowC, glow * ((0.1 if j == 0 else 0.22) * math.pow(s, 1.5) + 0.03))
            return cc, g, NOGILL, SW(s * bl["hb"] / it["height"])

        b.ribbon(bl["pts"], [bl["side"]] * len(bl["pts"]), bl["W"], blade_attr)
        pd = bl["pod"]
        if pd:
            X, Y, Z = basis_from(pd["T"])
            c = pd["c"]
            rings = jround(lerp(3, 8, D["ribbon"]))
            prof = [dict(r=pd["rp"] * math.sin(math.pi * i / rings), y=pd["half"] * math.cos(math.pi * i / rings)) for i in range(1, rings)]
            hf = pd["s"] * bl["hb"] / it["height"]
            cc = clerp(cB, glowC, 0.35)
            g = cmul(clerp(glowC, cB, 0.3), glow * 0.9)
            b.lathe(lambda lx, ly, lz, c=c, X=X, Y=Y, Z=Z: c.adds(X, lx).adds(Y, ly).adds(Z, lz), prof, max(6, jround(D["lathe"] * 0.5)),
                    lambda i, a, cc=cc, g=g, hf=hf: (cc, g, (math.cos(a), math.sin(a), 0.9, 10), SW(hf)), pd["half"], -pd["half"])


def reed_shape(it):
    blades, _C = reed_blades(it, 24)
    A = sway_amp(it)
    tubes = []
    for bi, bl in enumerate(blades):
        h = bl["hb"] / 24
        hs = bl["hb"] / it["height"]
        tubes.append(Tube(f"blade{bi}", [p.copy() for p in bl["pts"]], [w + 0.001 + h * 0.15 for w in bl["W"]], list(bl["sArr"]),
                          [A * (s * hs) ** 2 for s in bl["sArr"]]))
        pd = bl["pod"]
        if pd:
            wv = A * (pd["s"] * bl["hb"] / it["height"]) ** 2
            tubes.append(Tube(f"blade{bi}", [pd["c"].adds(pd["T"], -pd["half"]), pd["c"].copy(), pd["c"].adds(pd["T"], pd["half"])],
                              [pd["rp"] * 0.4, pd["rp"] * 1.05, pd["rp"] * 0.4], [pd["s"]] * 3, [wv] * 3))
    return Shape("reed", it["height"] * 0.5, A, [], [], tubes)


# ------------------------------------------------------------------ mound

class MoundFrame:
    def __init__(self, mound):
        r = rng(mound.get("seed") or 3)
        self.bumps = [(r() * TAU, 0.6 + r() * 0.8) for _ in range(5)]
        self.R = mound["radius"]
        self.Hh = mound["radius"] * 0.32
        self.depth = mound["depth"]
        self.cx = mound.get("x") or 0
        self.cz = mound.get("z") or 0


def mound_geometry(mound, D, b):
    M = MoundFrame(mound)
    S, rings = max(10, D["capSeg"]), max(3, D["top"] - 2)
    cc, glowC = col(mound["color"]), col(mound["glowColor"])
    zero = (0.0, 0.0, 0.0, 0.0)
    base = foot(M.cx, M.cz)
    pole = b.v(V3(M.cx, base + M.Hh, M.cz), cmul(cc, 0.9), cmul(glowC, 0.12), STEMGILL, zero)
    ring_idx = []
    for k in range(1, rings + 1):
        u = k / rings
        ring = []
        for j in range(S):
            a = (j / S) * TAU
            lump = 1
            for ba, bs in M.bumps:
                lump += 0.12 * bs * math.cos(a - ba) * math.cos(a * 2 - ba)
            rr = M.R * u * lump
            x, z = M.cx + math.cos(a) * rr, M.cz + math.sin(a) * rr * M.depth
            y = under(x, z, base) + M.Hh * math.pow(1 - u * u, 0.7) * lump - (0.03 if u > 0.98 else 0)
            ring.append(b.v(V3(x, y, z), cmul(cc, 0.7 + 0.3 * (1 - u)),
                            cadd(cmul(glowC, 0.05 + 0.2 * math.pow(1 - u, 2)), cmul(cc, 0.06)), STEMGILL, zero))
        ring_idx.append(ring)
    for j in range(S):
        b.tri(pole, ring_idx[0][(j + 1) % S], ring_idx[0][j])
    for k in range(len(ring_idx) - 1):
        for j in range(S):
            j2 = (j + 1) % S
            b.quad(ring_idx[k][j], ring_idx[k][j2], ring_idx[k + 1][j2], ring_idx[k + 1][j])


def mound_solid(mound):
    M = MoundFrame(mound)
    base = foot(M.cx, M.cz)

    def inside(p, pad):
        dx = (p.x - M.cx) / (M.R * 1.22 + pad)
        dz = (p.z - M.cz) / (M.R * M.depth * 1.22 + pad)
        dy = (p.y - under(p.x, p.z, base)) / (M.Hh * 1.25 + pad)
        return dy < 1.05 and dx * dx + dz * dz + max(0, dy) * max(0, dy) <= 1

    return Solid("mound", V3(M.cx, 0, M.cz), inside)


# ------------------------------------------------------------------ collision shapes

CHUNK = 8


class Box:
    __slots__ = ("lo", "hi")

    def __init__(self, lo=None, hi=None):
        self.lo = lo or [math.inf] * 3
        self.hi = hi or [-math.inf] * 3

    @classmethod
    def of(cls, pts):
        b = cls()
        for p in pts:
            b.add(p)
        return b

    def add(self, p):
        lo, hi = self.lo, self.hi
        if p.x < lo[0]:
            lo[0] = p.x
        if p.x > hi[0]:
            hi[0] = p.x
        if p.y < lo[1]:
            lo[1] = p.y
        if p.y > hi[1]:
            hi[1] = p.y
        if p.z < lo[2]:
            lo[2] = p.z
        if p.z > hi[2]:
            hi[2] = p.z

    def union(self, o):
        self.lo = [min(a, b) for a, b in zip(self.lo, o.lo)]
        self.hi = [max(a, b) for a, b in zip(self.hi, o.hi)]

    def grow(self, s):
        self.lo = [a - s for a in self.lo]
        self.hi = [a + s for a in self.hi]
        return self

    def empty(self):
        return self.lo[0] > self.hi[0]


def boxes_near(a, b, m):
    return not (a.hi[0] + m < b.lo[0] or b.hi[0] + m < a.lo[0] or a.hi[1] + m < b.lo[1] or b.hi[1] + m < a.lo[1]
                or a.hi[2] + m < b.lo[2] or b.hi[2] + m < a.lo[2])


def point_near_box(p, b, m):
    return b.lo[0] - m <= p.x <= b.hi[0] + m and b.lo[1] - m <= p.y <= b.hi[1] + m and b.lo[2] - m <= p.z <= b.hi[2] + m


class Solid:
    def __init__(self, part, center, inside, w=0.0):
        self.part = part
        self.center = center
        self.inside = inside
        self.w = w
        self.box = None


class Samples:
    def __init__(self, part, pts, d, w):
        self.part, self.pts, self.d, self.w = part, pts, d, w
        self.box = Box.of(pts).grow(d)


class Tube:
    def __init__(self, part, pts, r, t, w, ignore_mound=False, leaf=False):
        self.part, self.pts, self.r, self.t, self.w = part, pts, r, t, w
        self.ignore_mound = ignore_mound
        self.leaf = leaf
        self.box = Box()
        self.chunks = []
        for i0 in range(0, len(pts) - 1, CHUNK):
            i1 = min(len(pts) - 1, i0 + CHUNK)
            cb = Box.of(pts[i0:i1 + 1])
            rmax = max(r[i0:i1 + 1])
            wmax = max(w[i0:i1 + 1])
            cb.grow(rmax)
            self.chunks.append((i0, i1, cb, rmax, wmax))
            self.box.union(cb)
        self.h = max((pts[k].distance(pts[k - 1]) for k in range(1, len(pts))), default=0.0)


class Shape:
    def __init__(self, kind, bulk, amp, solids, samples, tubes):
        self.kind, self.bulk, self.amp = kind, bulk, amp
        self.solids, self.samples, self.tubes = solids, samples, tubes
        box = Box()
        for t in tubes:
            box.union(t.box)
        for g in samples:
            box.union(g.box)
        for so in solids:
            own = [g for g in samples if g.part == so.part]
            so.box = Box()
            if own:
                for g in own:
                    so.box.union(g.box)
            else:
                c = so.center
                so.box = Box([c.x - 0.075, c.y - 0.075, c.z - 0.075], [c.x + 0.075, c.y + 0.075, c.z + 0.075])
            box.union(so.box)
        self.box = box
        # three's Box3.getBoundingSphere: the box's centre and half its diagonal.
        self.center = V3(*((a + b) / 2 for a, b in zip(box.lo, box.hi)))
        self.radius = math.sqrt(sum((b - a) ** 2 for a, b in zip(box.lo, box.hi))) / 2


def seg_seg(p1, q1, p2, q2):
    """Closest points between segments p1q1 and p2q2 -> (dist, s, t)."""
    d1x, d1y, d1z = q1.x - p1.x, q1.y - p1.y, q1.z - p1.z
    d2x, d2y, d2z = q2.x - p2.x, q2.y - p2.y, q2.z - p2.z
    rx, ry, rz = p1.x - p2.x, p1.y - p2.y, p1.z - p2.z
    a = d1x * d1x + d1y * d1y + d1z * d1z
    e = d2x * d2x + d2y * d2y + d2z * d2z
    f = d2x * rx + d2y * ry + d2z * rz
    if a <= 1e-12 and e <= 1e-12:
        return p1.distance(p2), 0.0, 0.0
    if a <= 1e-12:
        s = 0.0
        t = clamp(f / e, 0, 1)
    else:
        c = d1x * rx + d1y * ry + d1z * rz
        if e <= 1e-12:
            t = 0.0
            s = clamp(-c / a, 0, 1)
        else:
            bb = d1x * d2x + d1y * d2y + d1z * d2z
            den = a * e - bb * bb
            s = clamp((bb * f - c * e) / den, 0, 1) if den > 1e-12 else 0.0
            t = (bb * s + f) / e
            if t < 0:
                t = 0.0
                s = clamp(-c / a, 0, 1)
            elif t > 1:
                t = 1.0
                s = clamp((bb - c) / a, 0, 1)
    dx = (p1.x + d1x * s) - (p2.x + d2x * t)
    dy = (p1.y + d1y * s) - (p2.y + d2y * t)
    dz = (p1.z + d1z * s) - (p2.z + d2z * t)
    return math.sqrt(dx * dx + dy * dy + dz * dz), s, t


def point_seg(p, a, b):
    abx, aby, abz = b.x - a.x, b.y - a.y, b.z - a.z
    l2 = abx * abx + aby * aby + abz * abz
    t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2, 0, 1) if l2 > 1e-12 else 0.0
    dx, dy, dz = a.x + abx * t - p.x, a.y + aby * t - p.y, a.z + abz * t - p.z
    return math.sqrt(dx * dx + dy * dy + dz * dz), t


def tube_point(tb, kf):
    k = min(math.floor(kf), len(tb.pts) - 2)
    return tb.pts[k].lerp(tb.pts[k + 1], kf - k)


def tube_t(tb, kf):
    k = min(math.floor(kf), len(tb.pts) - 2)
    return lerp(tb.t[k], tb.t[k + 1], kf - k)


SWAY_K = 1.17


def gap(wa, wb, ph):
    """Clearance between two swaying points: a base gap and their relative wind movement."""
    return 0.003 + SWAY_K * (abs(wa - wb) + min(wa, wb) * ph)


def collide(A, B, ph):
    """The first contact between two shapes, or None. ph bounds their wind phase difference."""
    mMax = gap(A.amp, B.amp, ph) + SWAY_K * max(A.amp, B.amp)
    if A.center.distance(B.center) > A.radius + B.radius + mMax:
        return None
    if not boxes_near(A.box, B.box, mMax):
        return None
    for ta in A.tubes:
        for tb in B.tubes:
            if not boxes_near(ta.box, tb.box, mMax):
                continue
            for (ai0, ai1, abox, _ar, awmax) in ta.chunks:
                for (bi0, bi1, bbox, _br, bwmax) in tb.chunks:
                    if not boxes_near(abox, bbox, gap(awmax, bwmax, ph) + SWAY_K * max(awmax, bwmax)):
                        continue
                    for i in range(ai0, ai1):
                        for j in range(bi0, bi1):
                            d, s, t = seg_seg(ta.pts[i], ta.pts[i + 1], tb.pts[j], tb.pts[j + 1])
                            m = gap(max(ta.w[i], ta.w[i + 1]), max(tb.w[j], tb.w[j + 1]), ph)
                            if d < max(ta.r[i], ta.r[i + 1]) + max(tb.r[j], tb.r[j + 1]) + m:
                                return ((tube_point(ta, i + s), ta.part, tube_t(ta, i + s)), (tube_point(tb, j + t), tb.part, tube_t(tb, j + t)))
    for X, Y, flip in ((A, B, False), (B, A, True)):
        def hit(px, py, flip=flip):
            return (py, px) if flip else (px, py)

        for t in X.tubes:
            for so in Y.solids:
                if not boxes_near(t.box, so.box, mMax):
                    continue
                for k in range(len(t.pts)):
                    m = gap(t.w[k], so.w, ph)
                    if not point_near_box(t.pts[k], so.box, t.r[k] + t.h + m):
                        continue
                    if so.inside(t.pts[k], t.r[k] + t.h * 0.5 + m):
                        return hit((t.pts[k].copy(), t.part, t.t[k]), (so.center.copy(), so.part, 1))
        for g in X.samples:
            for so in Y.solids:
                m = gap(g.w, so.w, ph)
                if not boxes_near(g.box, so.box, m):
                    continue
                for p in g.pts:
                    if point_near_box(p, so.box, g.d + m) and so.inside(p, g.d + m):
                        return hit((p.copy(), g.part, 1), (so.center.copy(), so.part, 1))
            for tb in Y.tubes:
                if not boxes_near(g.box, tb.box, mMax):
                    continue
                for (i0, i1, cbox, _r, wmax) in tb.chunks:
                    mc = gap(g.w, wmax, ph) + SWAY_K * wmax
                    if not boxes_near(g.box, cbox, mc):
                        continue
                    for p in g.pts:
                        if not point_near_box(p, cbox, g.d + mc):
                            continue
                        for k in range(i0, i1):
                            d, t = point_seg(p, tb.pts[k], tb.pts[k + 1])
                            m = gap(g.w, max(tb.w[k], tb.w[k + 1]), ph)
                            if d - lerp(tb.r[k], tb.r[k + 1], t) < g.d + m:
                                return hit((p.copy(), g.part, 1), (tube_point(tb, k + t), tb.part, tube_t(tb, k + t)))
    return None


def phase_bound(ia, ib):
    return min(1.5, math.hypot(ia["x"] - ib["x"], ia["z"] - ib["z"]) * 1.27)


def self_issue(it, S, mound):
    """What is wrong with an item on its own: off the ground, in the ground, in the mound, in itself."""
    if GROUND.at(it["x"], it["z"]) is None:
        return "edge"
    base = foot(it["x"], it["z"])
    if it["kind"] == "mushroom":
        for g in S.samples:
            for p in g.pts:
                if p.y - g.d - under(p.x, p.z, base) < 0.012:
                    return "ground"
        cap, stem = S.solids[0], S.tubes[0]
        for k in range(len(stem.pts)):
            if stem.t[k] > 0.8:
                break
            if cap.inside(stem.pts[k], stem.r[k] + stem.h * 0.5 + 0.002 + SWAY_K * (S.amp - stem.w[k])):
                return "self"
    if it["kind"] == "lantern":
        if S.bulb_bottom - under(S.bulb_x, S.bulb_z, base) < 0.04:
            return "ground"
        bulb, stalk = S.solids[0], S.tubes[0]
        for lf in S.tubes[1:]:
            for k in range(len(lf.pts)):
                if bulb.inside(lf.pts[k], lf.r[k] + 0.004 + SWAY_K * S.amp):
                    return "leaf"
            for i in range(len(stalk.pts) - 1):
                if stalk.t[i] < 0.12:
                    continue
                for j in range(len(lf.pts) - 1):
                    d = seg_seg(stalk.pts[i], stalk.pts[i + 1], lf.pts[j], lf.pts[j + 1])[0]
                    if d < stalk.r[i] + max(lf.r[j], lf.r[j + 1]) + 0.003 + SWAY_K * stalk.w[i + 1]:
                        return "leaf"
    if mound:
        ms = mound_solid(mound)
        mound_base = foot(mound.get("x") or 0, mound.get("z") or 0)
        for g in S.samples:
            for p in g.pts:
                if ms.inside(p, g.d + 0.004):
                    return "mound"
        for t in S.tubes:
            if t.ignore_mound:
                continue
            for p, r in zip(t.pts, t.r):
                if p.y - under(p.x, p.z, mound_base) > 0.002 and ms.inside(p, r + 0.004):
                    return "mound"
    return None


def fix_self(it, issue, attempt, mound):
    if issue == "edge":
        # Off the host's edge: walk back toward the patch's root, which is on it.
        d = V3(-it["x"], 0, -it["z"])
        if d.length_sq() < 1e-8:
            return
        d = d.normalized()
        it["x"] = r4(it["x"] + d.x * EDGE_STEP)
        it["z"] = r4(it["z"] + d.z * EDGE_STEP)
        return
    if issue == "mound":
        if it["kind"] == "mushroom" and attempt < 25:
            it["height"] = r4(it["height"] + 0.012)
            return
        c = V3(mound.get("x") or 0, 0, mound.get("z") or 0) if mound else V3()
        d = V3(it["x"] - c.x, 0, it["z"] - c.z)
        if d.length_sq() < 1e-8:
            d.set(math.cos(attempt), 0, math.sin(attempt))
        d = d.normalized()
        it["x"] = r4(it["x"] + d.x * 0.02)
        it["z"] = r4(it["z"] + d.z * 0.02)
        return
    if it["kind"] == "mushroom":
        if issue == "ground":
            if it["capTilt"] > 0.05:
                it["capTilt"] = r4(it["capTilt"] * 0.85)
            else:
                it["height"] = r4(it["height"] + 0.012)
        if issue == "self":
            if it["stemRadius"] > it["capRadius"] * 0.17:
                it["stemRadius"] = r4(it["capRadius"] * 0.17)
            elif abs(it["capTilt"]) > 0.03:
                it["capTilt"] = r4(it["capTilt"] * 0.8)
            else:
                it["flare"] = r4(min(1, it["flare"] + 0.15))
    elif it["kind"] == "lantern":
        if issue == "ground":
            fix_lantern_height(it)
        it["height"] = r4(it["height"] + 0.015)
        if issue == "leaf" and attempt % 4 == 3:
            it["rot"] = r4((it.get("rot") or 0) + 0.35)


def nudge(it, S, self_, other, attempt):
    d = self_[0] - other[0]
    if d.length_sq() < 1e-10:
        d = S.center - other[0]
    if d.length_sq() < 1e-10:
        d = V3(math.cos(attempt * 2.4), 0.2, math.sin(attempt * 2.4))
    d = d.normalized()
    dh = V3(d.x, 0, d.z)
    if dh.length_sq() < 1e-6:
        dh = V3(math.cos(attempt * 2.4), 0, math.sin(attempt * 2.4))
    dh = dh.normalized()
    out = V3(it["x"], 0, it["z"])
    if out.length_sq() < 1e-8:
        out = V3(math.cos(attempt * 2.4), 0, math.sin(attempt * 2.4))
    out = out.normalized()
    step = (0.045 * S.bulk + 0.004) * (1 + min(attempt, 60) * 0.03)
    blocked = [False]

    def move_base(v, f):
        x, z = r4(it["x"] + v.x * step * f), r4(it["z"] + v.z * step * f)
        if GROUND.at(x, z) is None:
            # Off the host's edge: separation alone, or nothing (on the
            # original's endless plane every move has ground).
            x, z = r4(it["x"] + dh.x * step * f), r4(it["z"] + dh.z * step * f)
            if GROUND.at(x, z) is None:
                blocked[0] = True
                return
        it["x"], it["z"] = x, z

    if attempt > 40:
        # Escape: it keeps colliding, so it walks out of the crowd (there is always room outside).
        move_base((dh * 0.5).adds(out, 1.5).normalized(), 1)
        if attempt > 160:
            if it["kind"] == "mushroom":
                it["capRadius"] = r4(max(0.02, it["capRadius"] * 0.96))
                it["stemRadius"] = r4(min(it["stemRadius"], it["capRadius"] * 0.17))
            if it["kind"] == "lantern":
                it["bulbRadius"] = r4(max(0.012, it["bulbRadius"] * 0.96))
                fix_lantern_height(it)
        return blocked[0]
    if it["kind"] == "mushroom":
        low_stem = self_[1] == "stem" and self_[2] < 0.3
        if low_stem:
            move_base((dh + out).normalized() if attempt > 8 else dh, 1)
        else:
            set_mushroom_top(it, MushroomFrame(it).P3.adds(d, step))
    elif it["kind"] == "lantern":
        high = self_[1] == "bulb" or (self_[1] == "stalk" and self_[2] > 0.45)
        if high and attempt < 20:
            o = V3(math.cos(it["dir"]), 0, math.sin(it["dir"]))
            sgn = o.x * dh.z - o.z * dh.x
            it["dir"] = r4(it["dir"] + (math.copysign(1, sgn) if sgn != 0 else 1) * 0.12)
            if d.y > 0.5:
                it["height"] = r4(it["height"] + step)
        else:
            move_base(dh, 1)
    else:
        move_base(dh, 1)
    return blocked[0]


STUCK = 8  # moves refused at the host's edge before a plant is dropped
EDGE_STEP = 0.02  # how far an "edge" fix walks a plant back toward the root


SHAPES = {"mushroom": mushroom_shape, "lantern": lantern_shape, "fern": fern_shape, "reed": reed_shape}
GEOMETRY = {"mushroom": mushroom_geometry, "lantern": lantern_geometry, "fern": fern_geometry, "reed": reed_geometry}


def shape_of(it):
    return SHAPES[it["kind"]](it)


def resolve_collisions(patch, locked=(), max_passes=600):
    """Move items until nothing intersects (pairs, ground, mound, self), with
    room for the sway. The smaller of a touching pair moves; a locked item
    (one edited by hand) moves only for another locked item."""
    items = patch["items"]
    lock = set(locked)
    shapes = [shape_of(it) for it in items]
    attempts = [0] * len(items)
    stuck = [0] * len(items)
    off_edge = [0] * len(items)
    edge_budget = [None] * len(items)
    dropped = set()
    moves = 0
    passes = 0
    for passes in range(max_passes):
        anything = False
        for i, it in enumerate(items):
            if i in dropped:
                continue
            issue = self_issue(it, shapes[i], patch.get("mound"))
            if not issue:
                continue
            anything = True
            moves += 1
            if issue == "edge":
                # The walk back to the root (EDGE_STEP a pass) reaches ground
                # within this many passes unless something keeps pushing the
                # plant out again (the mound, a neighbour): then there is no
                # room for it on this ground.
                if edge_budget[i] is None:
                    edge_budget[i] = math.ceil(math.hypot(it["x"], it["z"]) / EDGE_STEP) + STUCK
                off_edge[i] += 1
                if off_edge[i] > edge_budget[i]:
                    dropped.add(i)
                    continue
            fix_self(it, issue, attempts[i], patch.get("mound"))
            attempts[i] += 1
            shapes[i] = shape_of(it)
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                if i in dropped or j in dropped:
                    continue
                hit = collide(shapes[i], shapes[j], phase_bound(items[i], items[j]))
                if not hit:
                    continue
                anything = True
                moves += 1
                li, lj = i in lock, j in lock
                if li != lj:
                    mv = j if li else i
                else:
                    mv = i if shapes[i].bulk <= shapes[j].bulk else j
                self_, other = (hit[0], hit[1]) if mv == i else (hit[1], hit[0])
                if nudge(items[mv], shapes[mv], self_, other, attempts[mv]):
                    stuck[mv] += 1
                    if stuck[mv] >= STUCK:
                        # Hemmed in at the host's edge: the patch is bigger than its ground.
                        dropped.add(mv)
                attempts[mv] += 1
                shapes[mv] = shape_of(items[mv])
        if not anything:
            break
    else:
        passes = max_passes
    if dropped:
        keep = [i for i in range(len(items)) if i not in dropped]
        patch["items"] = [items[i] for i in keep]
        shapes = [shapes[i] for i in keep]
    return {"passes": passes, "moves": moves, "dropped": len(dropped), "remaining": count_collisions(patch, shapes)}


def list_collisions(patch):
    items = patch["items"]
    S = [shape_of(it) for it in items]
    out = []
    for i, it in enumerate(items):
        s = self_issue(it, S[i], patch.get("mound"))
        if s:
            out.append({"i": i, "issue": s})
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            h = collide(S[i], S[j], phase_bound(items[i], items[j]))
            if h:
                out.append({"i": i, "j": j, "a": f"{h[0][1]}@{h[0][2]:.2f}", "b": f"{h[1][1]}@{h[1][2]:.2f}"})
    return out


def count_collisions(patch, shapes=None):
    items = patch["items"]
    S = shapes or [shape_of(it) for it in items]
    n = sum(1 for i, it in enumerate(items) if self_issue(it, S[i], patch.get("mound")))
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if collide(S[i], S[j], phase_bound(items[i], items[j])):
                n += 1
    return n


# ------------------------------------------------------------------ generation

def make_mound(p, pal, r):
    return {"radius": r4(max(0.05, p["spread"] * 0.75 + p["size"] * 0.05) * p["mound"] + 0.02), "depth": p["depth"], "x": 0, "z": 0,
            "color": jitter_hex(pal["stem"], r, 0.02), "glowColor": pal["glow"], "seed": math.floor(r() * 1e9)}


def footprint(it):
    """A plant's ground footprint radius (mushrooms cluster on purpose: none)."""
    if it["kind"] == "lantern":
        return max(it["leafLength"] * 0.9 + 0.012, it["stalkRadius"] * 3)
    if it["kind"] == "fern":
        fronds, _crown, C = fern_fronds(it, 12)
        m = 0.05
        for fr in fronds:
            for k, p in enumerate(fr["pts"]):
                m = max(m, math.hypot(p.x - C.x, p.z - C.z) + fr["leafLen"](k) * 0.5)
        return m * 0.95
    if it["kind"] == "reed":
        blades, C = reed_blades(it, 10)
        m = 0.03
        for bl in blades:
            for q in bl["pts"]:
                m = max(m, math.hypot(q.x - C.x, q.z - C.z))
        return m * 0.75 + 0.01
    return 0


def spread_footprints(patch, locked=()):
    """Push plant footprints apart (and off the mound) so a crowded patch
    widens out before the fine solver runs. Locked items stay put."""
    lock = set(locked)
    P = [(it, i, f) for i, it in enumerate(patch["items"]) if (f := footprint(it)) > 0]
    fixed = []
    if patch.get("mound"):
        mo = patch["mound"]
        fixed.append((mo.get("x") or 0, mo.get("z") or 0, mo["radius"] * 1.15, None))
    for pas in range(120):
        moved = False
        for a, (Ait, Ai, Af) in enumerate(P):
            others = [(Bit["x"], Bit["z"], Bf, (Bit, Bi)) for (Bit, Bi, Bf) in P[a + 1:]]
            for ox, oz, of, ob in others + fixed:
                dx, dz = Ait["x"] - ox, Ait["z"] - oz
                d = math.hypot(dx, dz)
                need = Af + of
                if d >= need:
                    continue
                moved = True
                if d < 1e-6:
                    dx, dz, d = math.cos(a * 2.4 + pas), math.sin(a * 2.4 + pas), 1
                push = (need - d) + 0.002
                aFree = Ai not in lock
                bFree = ob is not None and ob[1] not in lock
                share = 0.5 if aFree and bFree else 1 if aFree else 0
                Ait["x"] = r4(Ait["x"] + dx / d * push * share)
                Ait["z"] = r4(Ait["z"] + dz / d * push * share)
                if ob is not None and bFree:
                    ob[0]["x"] = r4(ob[0]["x"] - dx / d * push * (1 - share))
                    ob[0]["z"] = r4(ob[0]["z"] - dz / d * push * (1 - share))
        if not moved:
            break
    return patch


def generate_patch(options, collisions=True):
    """A patch description {version, kind, params, mound, items}, as the
    original's generatePatch; any DEFAULTS[kind] field may be set."""
    kind = options.get("kind", "mushroom")
    p = {**DEFAULTS[kind], **options, "kind": kind}
    pal = PALETTES.get(p["palette"], PALETTES["pastel"])
    r = rng(p["seed"] * 9973 + 17 + len(kind) * 101)
    items = []
    mound = None
    if kind == "mushroom":
        items = gen_mushrooms(p, r, pal, max(1, jround(p["count"])))
        if p["mound"] > 0:
            mound = make_mound(p, pal, r)
    elif kind == "grove":
        mp = {**DEFAULTS["mushroom"], **p, "kind": "mushroom",
              "spread": 0.32 * p["size"] / 0.55 * clamp(math.sqrt(p["mushrooms"] / 12), 0.6, 1.6)}
        if p["mushrooms"] > 0:
            items = gen_mushrooms(mp, r, pal, jround(p["mushrooms"]))
            if p["mound"] > 0:
                mound = make_mound(mp, pal, r)
        S = p["size"] / 0.55
        W = p["width"] * S

        def place(n, fn, ringR, zBias, sizeF):
            for i in range(n):
                side = 1 if i % 2 == 0 else -1
                x = side * (ringR + (0.15 + 0.5 * r()) * W * 0.6) * (1 + math.floor(i / 2) * 0.55)
                z = (zBias + (r() - 0.5) * 0.3) * p["depth"] * S
                items.append(fn(x, z, sizeF * (0.85 + 0.3 * r())))

        core = mp["spread"] + 0.12 * S if p["mushrooms"] > 0 else 0.1 * S
        sub = {"glow": p["glow"], "palette": p["palette"]}
        place(jround(p["ferns"]), lambda x, z, f: gen_fern({**DEFAULTS["fern"], **sub, "size": 0.5 * S}, r, pal, x, z, f), core + 0.25 * S, -0.35, 1)
        place(jround(p["reeds"]), lambda x, z, f: gen_reed({**DEFAULTS["reed"], **sub, "size": 0.75 * S}, r, pal, x, z, f), core + 0.1 * S, -0.55, 1)
        place(jround(p["lanterns"]), lambda x, z, f: gen_lantern({**DEFAULTS["lantern"], **sub, "size": 0.7 * S}, r, pal, x, z, f), core + 0.05 * S, 0.25, 1)
    else:
        n = max(1, jround(p["count"]))
        gen = {"lantern": gen_lantern, "fern": gen_fern, "reed": gen_reed}[kind]
        for _ in range(n):
            ang = r() * TAU
            dist = p["spread"] * math.sqrt(r())
            items.append(gen(p, r, pal, math.cos(ang) * dist, math.sin(ang) * dist * p["depth"], 1))
    patch = {"version": 2, "kind": kind, "params": p, "mound": mound, "items": items}
    spread_footprints(patch)
    if collisions:
        patch["solve"] = resolve_collisions(patch)
    return patch


def generate_with_overrides(params, overrides, collisions=True):
    """Generate from `params`, then apply per-item edits (overrides[i] is a
    partial item); an item whose shape was edited stays put."""
    patch = generate_patch(params, collisions=False)
    locked = []
    for i, m in enumerate(patch["items"]):
        o = overrides.get(i) or overrides.get(str(i))
        if not o:
            continue
        if any(k in SHAPE_KEYS for k in o):
            locked.append(i)
        patch["items"][i] = {**m, **o}
    spread_footprints(patch, locked)
    if collisions:
        patch["solve"] = resolve_collisions(patch, locked)
    return patch


def from_json(text):
    """A patch copied out of the web generator ('Patch JSON'): its params
    and, as overrides, every item as it was there (edits included)."""
    p = json.loads(text)
    items = p.get("items") or p.get("mushrooms")
    if not isinstance(items, list):
        raise ValueError("no items in the patch")
    kind = p.get("kind") or "mushroom"
    params = {**DEFAULTS[kind], **(p.get("params") or {}), "kind": kind}
    if "count" in params and kind != "grove":
        params["count"] = len(items)
    overrides = {i: {**m, "kind": m.get("kind") or "mushroom"} for i, m in enumerate(items)}
    return params, overrides


def to_json(patch):
    params = {k: v for k, v in patch["params"].items() if k != "collisions"}
    return json.dumps({"version": patch["version"], "kind": patch["kind"], "params": params,
                       "mound": patch["mound"], "items": patch["items"]}, separators=(",", ":"))


@lru_cache(maxsize=128)
def averaged_gills(weight):
    """Angular mean of render3d/glowFlora.ts's line multiplier."""
    total = 0.0
    for j in range(512):
        a = (j + 0.5) * TAU / 512
        line = 1 - smooth(0, 0.42, abs(math.sin(a)))
        half = (1 - smooth(0, 0.3, abs(math.sin(2 * a)))) * smooth(0.75, 0.2, weight)
        total += 0.25 + 1.25 * max(line, half * 0.65)
    return total / 512


def lod_detail(authored, extent, tolerance):
    if tolerance <= 0:
        return authored
    # Radius-relative budgets select the existing presets; the authored
    # preset is always the finest permitted. Patches can mix near/far items.
    level = 2 if tolerance >= extent * 0.04 else 1 if tolerance >= extent * 0.015 else 0
    return {k: min(authored[k], DETAIL[level][k]) for k in authored}


def build(patch, detail=0, tolerance=None):
    """Geometry for the whole patch, in the patch frame: (GeoBuilder, item
    vertex ranges)."""
    D = DETAIL[clamp(int(detail), 0, 2)]
    b = GeoBuilder()
    ranges = []
    for it in patch["items"]:
        start = len(b.p)
        tol = tolerance(it) if tolerance is not None else 0.0
        extent = max(it.get("capRadius", 0), it.get("bulbRadius", 0), it.get("length", 0), it.get("height", 0) * 0.3, 0.01)
        chosen = lod_detail(D, extent, tol)
        GEOMETRY[it["kind"]](it, chosen, b)
        # Preserve average emitted light when individual radial lines blur
        # together. Negative line counts encode the mean; sway/pulse stay.
        averaged = False
        for i in range(start, len(b.p)):
            x, y, weight, count = b.gi[i]
            if tol > 0 and weight > 0 and count > 0 and TAU * extent / count < 2 * tol:
                b.gi[i] = (x, y, weight, -averaged_gills(round(weight, 4)))
                averaged = True
        if averaged:
            # Adjacent unlined cap/lip vertices represent multiplier 1, not
            # 0: interpolating toward count 0 would create a dark seam.
            for i in range(start, len(b.p)):
                x, y, weight, count = b.gi[i]
                if weight == 0 and count == 0:
                    b.gi[i] = (x, y, weight, -1.0)
        ranges.append((start, len(b.p)))
    if patch.get("mound"):
        mound = patch["mound"]
        tol = tolerance(mound) if tolerance is not None else 0.0
        mound_geometry(mound, lod_detail(D, mound["radius"], tol), b)
    return b, ranges
