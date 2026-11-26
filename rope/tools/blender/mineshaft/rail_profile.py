"""The kit's forged rail: one continuous I-section extruded along a centre line.

Shared by build.py (the kit's 4 m straight, curve and broken track) and
build_rail_segment.py (the short tiling segment), so every rail in the kit is
the same section with the same wear.
"""
import math
from mathutils import Vector

# The section as (across, height) in metres, a rail's centre line at across 0
# and its foot on the sleeper's chair at height 0.158; the head is 0.242 up.
PROFILE = [(-.10, .158), (.10, .158), (.10, .180), (.035, .185), (.04, .201), (.095, .208), (.095, .242),
           (-.095, .242), (-.095, .208), (-.04, .201), (-.035, .185), (-.10, .180)]
# Rail centres sit this far either side of the track's centre line (1.14 m gauge).
HALF_GAUGE = .57


def rail_geometry(center, tangent, side, lo, hi, broken=False, steps=32, bite_waves=9):
    """(verts, faces) of one rail between fractions `lo` and `hi` of the track.

    `center(t)` and `tangent(t)` give the track's centre line at fraction t;
    `side` (-1 or 1) is which rail. `broken` roughens a cut end inside the
    track (a fracture). The head's worn bites run `bite_waves` half-waves over
    the whole track (t from 0 to 1), so a shorter track passes fewer to keep
    the same bites a metre."""
    verts = []
    for j in range(steps + 1):
        t = lo + (hi - lo) * j / steps
        p = center(t)
        n = Vector((-tangent(t).y, tangent(t).x, 0))
        for idx, (w, z) in enumerate(PROFILE):
            fracture = ((.035 * math.sin(idx * 2.7) + .025 * math.cos(idx * 1.3))
                        if broken and ((j == steps and hi < 1) or (j == 0 and lo > 0)) else 0)
            bite = (.011 * max(0, math.sin(t * math.pi * bite_waves + side * 1.8 + (1 if w > 0 else 3))) ** 14
                    if z > .20 and 0 < j < steps else 0)
            ww = w - math.copysign(bite, w) if abs(w) > .08 else w
            verts.append(p + n * (side * HALF_GAUGE + ww) + Vector((fracture, 0, z)))
    m = len(PROFILE)
    faces = [tuple(range(m - 1, -1, -1))]
    for j in range(steps):
        for k in range(m):
            faces.append((j * m + k, j * m + (k + 1) % m, (j + 1) * m + (k + 1) % m, (j + 1) * m + k))
    faces.append(tuple(steps * m + k for k in range(m)))
    return verts, faces
