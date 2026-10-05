"""Moving ivy data in and out of Blender datablocks: the stamps an ivy object
keeps, the generated mesh it shows, and the one material every ivy shares."""

import math
import os
import random

import bpy
import numpy as np

from .build import (
    ATLAS_CELLS,
    ATLAS_INSET,
    CLUMP_BASE,
    CLUMP_FILL_RECT,
    CLUMP_GRID,
    CLUMP_GUTTER,
    CLUMP_RECTS,
    FILL_CELL,
    LEAF_BASE,
    LEAF_CELLS,
    LEAF_SPAN,
    STRAND_RECTS,
)
from .stampbrush.stamps import (
    new_mesh as new_stamps_mesh,  # noqa: F401 - the stamps' storage is shared
)
from .stampbrush.stamps import read as read_stamps  # noqa: F401
from .stampbrush.stamps import write as write_stamps  # noqa: F401

COLOR = "Col"
UV = "UVMap"


# --------------------------------------------------------------------------
# The generated mesh: one mesh, ONE material, custom normals (the hull normal
# on every corner) and a per-vertex colour. One material on purpose: Blender
# 5.2's glTF exporter, given a second material slot that reads the same colour
# attribute, records it under the attribute's name where it later looks for
# the glTF name, decides that slot does not use the colour, and writes its
# COLOR_0 as white (io_scene_gltf2 primitive_extract.py, `materials_use_vc`).
# That is how the underlay shipped white. With one slot there is nothing to
# mismatch, and the ivy is one draw call.


def write_result(me, result):
    me.clear_geometry()
    v, t = result.vertices, result.triangles
    if len(t) == 0:
        return
    me.vertices.add(len(v))
    me.vertices.foreach_set("co", v.astype(np.float32).ravel())
    me.loops.add(len(t) * 3)
    me.loops.foreach_set("vertex_index", t.astype(np.int32).ravel())
    me.polygons.add(len(t))
    me.polygons.foreach_set("loop_start", np.arange(0, len(t) * 3, 3, dtype=np.int32))
    me.update(calc_edges=True)
    me.validate(clean_customdata=False)
    attr = me.color_attributes.get(COLOR) or me.color_attributes.new(COLOR, "FLOAT_COLOR", "POINT")
    if len(attr.data) == len(result.colors):
        attr.data.foreach_set("color", result.colors.astype(np.float32).ravel())
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find(COLOR)
    uv = me.uv_layers.get(UV) or me.uv_layers.new(name=UV)
    uv.data.foreach_set("uv", result.uvs.astype(np.float32).ravel())
    me.shade_smooth()
    if len(result.normals) == len(v):
        me.normals_split_custom_set_from_vertices(result.normals.astype(np.float32).tolist())
    mat = material(result.detail)
    if list(me.materials) != [mat]:
        me.materials.clear()
        me.materials.append(mat)
        _purge_old_materials()


# --------------------------------------------------------------------------
# The atlas: a 4 x 4 sheet of the owner's painted leaf stamps (below), base at
# the bottom of the card (build.LEAF_BASE) and tip at the top (build.LEAF_TIP)
# - the first fifteen stamps (mirrored ones fill in if there are fewer), for the carpet and the
# vines - and one faceted round the underlay and the stems sample the centre
# of. A stamp keeps its brushwork but not its colour (_neutral), so the vertex
# colour still owns the hue. Under the alpha the colour is bled outward from
# every leaf, because the background under it filters into every edge. Every
# shape sits
# inside its cell's inner (1 - 2 * ATLAS_INSET), the part a card's UV quad
# covers, so there is a transparent gutter either side of every cell border
# (see build.ATLAS_INSET). Drawn once into assets-src/scenes/textures and
# packed into the .blend, so a scene exports on any machine. Bump
# ATLAS_VERSION to redraw it: the file is named by version, so a stale sheet
# is never picked up.

MATERIAL_VERSION = 7  # 7: two-sided (2026-10-05)
ATLAS_VERSION = 7
ATLAS_NAME = f"ivy-cutout-atlas-v{ATLAS_VERSION}.png"
ATLAS_SIZE = 1024
REPO = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", ".."))
TEXTURE_DIR = os.path.join(REPO, "assets-src", "scenes", "textures")
ATLAS_CUTOFF = 0.35  # alpha below this is cut; below 0.5 so mipmaps do not eat the leaf edges at a distance

# The stamp sheet: the owner's painted leaves on a transparent 2048 px sheet
# (assets-src/scenes/textures/ivy-leaf-stamps.png, a published scene source),
# each a separate blob. STAMPS gives each one's box in the sheet's pixels and
# the way it points, base to tip, in degrees clockwise from straight up;
# base and tip are the leaf's own extremes along that line. Read once a
# session into square cutouts, base CUTOUT_BASE and tip CUTOUT_TIP of the
# square from the top, with room either side for a leaf wider than long.
STAMPS_NAME = "ivy-leaf-stamps.png"
STAMPS = (
    # The fifteen the leaf atlas holds: hearts and lobed leaves.
    (1327, 299, 1702, 691, 190),  # heart, tip down
    (1302, 1003, 1694, 1415, 0),  # round, notch at the bottom
    (857, 782, 1270, 1187, 185),  # heart, tip down
    (235, 1413, 564, 1711, 180),  # heart, tip down
    (673, 1115, 880, 1301, 200),  # small heart
    (1306, 786, 1484, 959, 195),  # small heart, notch top right
    (1622, 1665, 1871, 1954, 190),  # heart, tip down
    (475, 1759, 659, 1934, 160),  # heart, notch top right
    (875, 255, 1182, 593, 180),  # five-lobed, lobes hanging
    (1705, 501, 1984, 802, 170),  # lobed, lobes hanging
    (220, 207, 606, 564, 160),  # lobed, lobes along the bottom
    (1768, 891, 1994, 1127, 170),  # lobed, lobes hanging
    (1154, 515, 1362, 736, 180),  # lobed, lobes hanging
    (275, 1192, 436, 1384, 0),  # three-lobed, base at the bottom
    (1742, 70, 1918, 351, 355),  # pointed oval, tip up
    # The rest, for the clumps and strands: rounder leaves.
    (1558, 719, 1706, 884, 225),  # heart on its side
    (642, 904, 806, 1034, 315),  # bean, notch bottom right
    (1138, 81, 1411, 259, 180),  # bean, notch at the top
    (663, 297, 820, 494, 150),  # oval
    (1191, 1800, 1453, 2026, 50),  # oval, tilted
    (725, 58, 882, 229, 0),  # round
    (601, 532, 870, 824, 270),  # round, notch at the right
    (384, 960, 654, 1247, 30),  # round, notch at the left
    (166, 634, 458, 930, 165),  # heart, tip down and right; a thin stroke leaves a gap across it
    (895, 1206, 1216, 1552, 30),  # round, notch bottom left
    (1765, 1284, 1973, 1492, 330),  # lobed, notch bottom right
    (1266, 1463, 1520, 1729, 270),  # round, lobed on the right
    (644, 1478, 797, 1651, 30),  # round, notch bottom left
    (892, 1681, 1154, 1944, 30),  # round, notch bottom left
)
STAMP_MARGIN = 8  # pixels round a box that still belong to its leaf (the brush's ragged edge)
STAMP_SOFTEN = 2  # sheet pixels the stamp's alpha is blurred by before the cut (the brush's grain)
CUTOUT = 256
CUTOUT_TIP = 0.1
CUTOUT_BASE = 0.9
# What a stamp's average comes to, per channel, in linear light: everything up
# to the average scales by LEAF_MEAN and everything above rolls off toward
# white, so a stamp keeps its brushwork and the vertex colour keeps the hue.
LEAF_MEAN = 0.88


def _raster_polygon(poly, cs):
    """Point-in-polygon over a cs x cs grid; poly in cell units (x right, y down)."""
    yy, xx = np.mgrid[0:cs, 0:cs].astype(np.float32) / cs + 0.5 / cs
    inside = np.zeros((cs, cs), bool)
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        cond = (yy > min(y0, y1)) & (yy <= max(y0, y1)) & (abs(y1 - y0) > 1e-9)
        xs = x0 + (yy - y0) * (x1 - x0) / (y1 - y0 + 1e-12)
        inside ^= cond & (xx < xs)
    return inside


def _faceted(rnd):
    n = rnd.randint(6, 8)
    pts = []
    for i in range(n):
        a = (i + rnd.uniform(-0.2, 0.2)) / n * math.tau
        r = 0.42 * rnd.uniform(0.82, 1.0)
        pts.append((0.5 + r * math.cos(a), 0.5 + r * math.sin(a)))
    return pts


def _blur(mask, r):
    """The mask box-blurred three times by r pixels: 0.5 on its edge, 1 deep inside."""
    a = mask.astype(np.float32)
    k = np.ones(2 * r + 1, np.float32) / (2 * r + 1)
    for _ in range(3):
        a = np.apply_along_axis(lambda x: np.convolve(x, k, mode="same"), 0, a)
        a = np.apply_along_axis(lambda x: np.convolve(x, k, mode="same"), 1, a)
    return a


def _soften(mask, r):
    """Blur the mask and re-threshold it: every corner rounds by about r pixels."""
    return _blur(mask, r) > 0.5


# (A dark rim painted just inside every leaf's edge was tried on 2026-09-30
# for softer-looking edges and rejected the same hour: at game distance the
# mips turned it into a hard outline round every leaf.)


class _Cutout:
    """One painted leaf, base down: its RGBA as a mip pyramid (float, rows
    top first, level 0 CUTOUT pixels square) and its half-width as a share
    of its length, which is what a placement tests against its rect."""

    def __init__(self, rgba):
        self.levels = [rgba]
        while self.levels[-1].shape[0] > 8:
            a = self.levels[-1]
            self.levels.append((a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2]) / 4)
        size = rgba.shape[0]
        cols = np.nonzero((rgba[..., 3] > 0.5).any(0))[0]
        self.half = max(size / 2 - cols.min(), cols.max() + 1 - size / 2) / ((CUTOUT_BASE - CUTOUT_TIP) * size)

    def rect(self, base, tip):
        """The corners of the rect the leaf fills when drawn base to tip."""
        base, tip = np.asarray(base, float), np.asarray(tip, float)
        d = tip - base
        across = np.array((-d[1], d[0])) * self.half
        return [base - across, base + across, tip + across, tip - across]


_CUTOUTS = None


def _tone(d):
    """A stamp's colour as a share of its average (1 = average) to the colour
    the atlas stores: LEAF_MEAN * d up to the average, then a curve with the
    same slope there that never reaches 1."""
    head = 1.0 - LEAF_MEAN
    over = np.maximum(d - 1.0, 0.0)
    return np.where(d <= 1.0, LEAF_MEAN * d, LEAF_MEAN + head * (1.0 - np.exp(-over * LEAF_MEAN / head)))


def _neutral(rgba):
    """The stamp's colour divided by its own, per channel, so every stamp
    averages LEAF_MEAN grey (linear) and keeps only its brushwork. A channel's
    scale is solved through the curve, which pulls a channel with brighter
    strokes further down and would leave a cast."""
    inside = rgba[..., 3] > 0.5
    lin = np.clip(rgba[..., 0:3], 0.0, 1.0) ** 2.2
    scale = 1.0 / np.maximum(lin[inside].mean(0), 1e-4)
    for _ in range(20):
        scale *= LEAF_MEAN / _tone(lin[inside] * scale).mean(0)
    rgba[..., 0:3] = _tone(lin * scale) ** (1 / 2.2)
    return rgba


def _box_blur(a, r, passes=3):
    """`a` box-blurred `passes` times by r pixels each way (zero outside), by
    running sums: about a Gaussian of sigma r."""
    for _ in range(passes):
        for axis in (0, 1):
            p = np.pad(a, [(r + 1, r) if ax == axis else (0, 0) for ax in (0, 1)])
            c = np.cumsum(p, axis, dtype=np.float64)
            hi = c.take(range(2 * r + 1, c.shape[axis]), axis)
            lo = c.take(range(c.shape[axis] - 2 * r - 1), axis)
            a = ((hi - lo) / (2 * r + 1)).astype(np.float32)
    return a


def _blob(alpha, cell=4):
    """1 over the stamp's own blob in a box of the sheet, 0 over specks of
    paint beside it. Grown from the most solid cell of a coarse grid through
    every cell with paint in it, so the brush's ragged, holed edge stays one
    blob."""
    h, w = alpha.shape
    gh, gw = -(-h // cell), -(-w // cell)
    pad = np.zeros((gh * cell, gw * cell), np.float32)
    pad[:h, :w] = alpha
    coarse = pad.reshape(gh, cell, gw, cell).mean((1, 3))
    paint = coarse > 0.05
    grown = coarse == coarse.max()
    while True:
        more = grown.copy()
        more[1:] |= grown[:-1]
        more[:-1] |= grown[1:]
        more[:, 1:] |= grown[:, :-1]
        more[:, :-1] |= grown[:, 1:]
        more &= paint
        if (more == grown).all():
            break
        grown = more
    return np.repeat(np.repeat(grown, cell, 0), cell, 1)[:h, :w].astype(np.float32)


def _stamp_cutout(sheet, box, angle):
    """One stamp of the sheet turned base down and tip up in a CUTOUT square."""
    x0, y0, x1, y1 = box
    m = STAMP_MARGIN
    crop = sheet[max(y0 - m, 0):y1 + m, max(x0 - m, 0):x1 + m].copy()
    crop[..., 3] *= _blob(crop[..., 3])
    # A dry brush paints grainy alpha, which the cut turns into pinholes and,
    # where a stroke ran thin, a gap through the leaf (fluffy_leaves.png).
    # Blurred this little it is one leaf again with the same fuzzy outline.
    crop[..., 3] = _box_blur(crop[..., 3], STAMP_SOFTEN)
    # Premultiplied, so the transparent black round a stamp never filters into
    # its edge colour.
    pre = np.concatenate([crop[..., 0:3] * crop[..., 3:4], crop[..., 3:4]], -1)
    ys, xs = np.nonzero(crop[..., 3] > ATLAS_CUTOFF)
    pts = np.stack([xs, ys], 1) + 0.5
    a = math.radians(angle)
    along = np.array((math.sin(a), -math.cos(a)))  # base to tip, y down
    across = np.array((-along[1], along[0]))
    c = pts.mean(0)
    t = (pts - c) @ along
    base, length = c + along * t.min(), float(t.max() - t.min())
    # A leaf wider than the square has room for is drawn smaller in it, from
    # the same base, rather than cut off at the side.
    wide = 2.0 * float(np.abs((pts - c) @ across).max())
    yy, xx = np.mgrid[0:CUTOUT, 0:CUTOUT].astype(np.float64) + 0.5
    k = max(length / ((CUTOUT_BASE - CUTOUT_TIP) * CUTOUT), wide / (0.96 * CUTOUT))  # crop pixels per cutout pixel
    up = (CUTOUT_BASE * CUTOUT - yy) * k  # toward the tip
    side = (xx - CUTOUT / 2) * k
    src = base[None, None] + up[..., None] * along + side[..., None] * across
    s = _bilinear(pre, src[..., 0], src[..., 1])
    alpha = s[..., 3]
    rgba = np.dstack([s[..., 0:3] / np.maximum(alpha, 1e-4)[..., None], alpha]).astype(np.float32)
    return _bleed(_neutral(rgba))


def _cutouts():
    """The stamp sheet's leaves, read once a session."""
    global _CUTOUTS
    if _CUTOUTS is not None:
        return _CUTOUTS
    path = os.path.join(TEXTURE_DIR, STAMPS_NAME)
    if not os.path.exists(path):
        raise FileNotFoundError(f"{path} is missing: `bun run assets:fetch-sources` fetches it")
    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        px = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(px)
    finally:
        bpy.data.images.remove(img)
    sheet = px.reshape(h, w, 4)[::-1]
    _CUTOUTS = [_Cutout(_stamp_cutout(sheet, s[:4], s[4])) for s in STAMPS]
    return _CUTOUTS


def _bilinear(a, x, y):
    """`a` sampled at pixel coordinates (x, y) (pixel centres at +0.5), zero
    outside it."""
    h, w = a.shape[:2]
    x, y = x - 0.5, y - 0.5
    x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    out = 0
    for dy, wy in ((0, 1 - fy), (1, fy)):
        for dx, wx in ((0, 1 - fx), (1, fx)):
            xi, yi = x0 + dx, y0 + dy
            ok = ((xi >= 0) & (xi < w) & (yi >= 0) & (yi < h))[..., None]
            out = out + a[np.clip(yi, 0, h - 1), np.clip(xi, 0, w - 1)] * ok * wx * wy
    return out


def _put(dst, cut, base, tip, mirror=False, value=1.0):
    """Draw the leaf `cut` into dst (h x w x 4, rows top first) with its base
    at `base` and its tip at `tip`, in pixels; over what is there, its colour
    times `value`. Sampled from the pyramid level nearest the shrink, so a
    small leaf does not alias."""
    base, tip = np.asarray(base, float), np.asarray(tip, float)
    d = tip - base
    length = float(np.linalg.norm(d))
    along = d / length
    across = np.array((-along[1], along[0]))
    shrink = (CUTOUT_BASE - CUTOUT_TIP) * cut.levels[0].shape[0] / length
    lvl = int(np.clip(math.floor(math.log2(max(shrink, 1.0))), 0, len(cut.levels) - 1))
    src = cut.levels[lvl]
    size = src.shape[0]
    xs, ys = zip(*cut.rect(base - along * length * 0.04, tip + along * length * 0.04))
    h, w = dst.shape[:2]
    x0, x1 = max(int(min(xs)) - 1, 0), min(int(max(xs)) + 2, w)
    y0, y1 = max(int(min(ys)) - 1, 0), min(int(max(ys)) + 2, h)
    if x0 >= x1 or y0 >= y1:
        return
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float64) + 0.5
    rx, ry = xx - base[0], yy - base[1]
    t = rx * along[0] + ry * along[1]  # toward the tip
    s = rx * across[0] + ry * across[1]
    if mirror:
        s = -s
    k = (CUTOUT_BASE - CUTOUT_TIP) * size / length
    rgba = _bilinear(src, size / 2 + s * k, CUTOUT_BASE * size - t * k)
    a = rgba[..., 3]
    region = dst[y0:y1, x0:x1]
    below = region[..., 3]
    # Over an empty pixel the leaf's colour is taken whole, so an edge never
    # blends toward the sheet's background.
    wgt = np.where(below > 0.01, a, (a > 0.0).astype(np.float32))[..., None]
    region[..., 0:3] = region[..., 0:3] * (1 - wgt) + rgba[..., 0:3] * value * wgt
    region[..., 3] = a + below * (1 - a)


def _bleed(img, iters=12):
    """Every pixel no shape covers takes the colour of the nearest one that
    does, iters pixels out: filtering at an edge then blends leaf with leaf."""
    have = img[..., 3] > 0.01
    rgb = img[..., 0:3] * have[..., None]
    for _ in range(iters):
        acc = np.zeros_like(rgb)
        n = np.zeros(have.shape, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                acc += np.roll(rgb, (dy, dx), (0, 1))
                n += np.roll(have, (dy, dx), (0, 1))
        grow = ~have & (n > 0)
        rgb[grow] = acc[grow] / n[grow][:, None]
        have |= grow
    img[..., 0:3] = np.where(have[..., None], rgb, 1.0)
    return img


def _inset(poly):
    """A polygon in cell units drawn into the cell's inner square, the part a
    card's UV quad covers (build.ATLAS_INSET)."""
    k = 1.0 - 2.0 * ATLAS_INSET
    return [(0.5 + (x - 0.5) * k, 0.5 + (y - 0.5) * k) for x, y in poly]


def _draw_atlas(size=ATLAS_SIZE, cells=ATLAS_CELLS, seed=9):
    """The atlas as float RGBA (rows top first)."""
    rnd = random.Random(seed)
    img = np.zeros((size, size, 4), np.float32)
    img[..., 0:3] = 1.0
    cs = size // cells
    k = 1.0 - 2.0 * ATLAS_INSET
    inner = cs * k
    cuts = _cutouts()
    for i in LEAF_CELLS:
        cy, cx = divmod(i, cells)
        # Base LEAF_BASE of the inner square from its bottom, tip LEAF_SPAN on.
        x = cx * cs + cs / 2
        bottom = cy * cs + cs * ATLAS_INSET + inner
        # The stamps after the first len(cuts) are mirrored; a leaf wider
        # than the inner square allows is drawn shorter from the same base.
        cut = cuts[i % len(cuts)]
        span = min(LEAF_SPAN, 0.98 / (2 * cut.half)) * inner
        base = bottom - LEAF_BASE * inner
        _put(img, cut, (x, base), (x, base - span), mirror=i >= len(cuts))
    img = _bleed(img)
    cy, cx = divmod(FILL_CELL, cells)
    cell = img[cy * cs:(cy + 1) * cs, cx * cs:(cx + 1) * cs]
    cell[..., 0:3] = 1.0
    cell[..., 3] = _soften(_raster_polygon(_inset(_faceted(rnd)), cs), int(cs * k * 0.03))
    return img


# --------------------------------------------------------------------------
# The clump atlas (detail "CLUMPS"): a sheet of its own on build.CLUMP_GRID's
# grid - eight clumps of leaves fanned out from a base low in the card, seven
# strands hanging from their top, and a solid round for the underlay. The
# leaves are the painted stamps, every one of them, half of them mirrored.
# Unlike the leaf atlas a clump is not white all over: each of its leaves is
# a little darker or lighter than the next (CLUMP_VALUE), because a clump is
# one flat card and cannot shade its own leaves with real shadows the way the
# leaf carpet's sheets do; with no variation it reads as a green blob with a
# scalloped edge.

CLUMP_ATLAS_VERSION = 3
CLUMP_ATLAS_NAME = f"ivy-clump-atlas-v{CLUMP_ATLAS_VERSION}.png"
CLUMP_VALUE = 0.18  # how much darker than white a clump's darkest leaf may be


def _raster_px(poly, w, h):
    """Point-in-polygon over a w x h pixel grid; poly in pixels (x right, y down)."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32) + 0.5
    inside = np.zeros((h, w), bool)
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        cond = (yy > min(y0, y1)) & (yy <= max(y0, y1)) & (abs(y1 - y0) > 1e-9)
        xs = x0 + (yy - y0) * (x1 - x0) / (y1 - y0 + 1e-12)
        inside ^= cond & (xx < xs)
    return inside


def _fits(poly, lo_x, lo_y, hi_x, hi_y):
    xs, ys = zip(*poly)
    return min(xs) >= lo_x and max(xs) <= hi_x and min(ys) >= lo_y and max(ys) <= hi_y


def _leaf_at(rnd, cuts, base, angle, length, bounds):
    """A leaf from `base` pointing along `angle`, `length` long, if its rect
    fits inside bounds (lo_x, lo_y, hi_x, hi_y): (cutout, base, tip, mirrored),
    or None."""
    cut = rnd.choice(cuts)
    tip = (base[0] + length * math.cos(angle), base[1] + length * math.sin(angle))
    if not _fits(cut.rect(base, tip), *bounds):
        return None
    return cut, base, tip, rnd.random() < 0.5


def _clump(cs, rnd):
    """One clump in a cs-pixel square cell: leaves fanned up out of a base
    CLUMP_BASE above the bottom of the inner square, the far ones drawn first
    so the near ones lie over their bases, as the carpet's leaves do."""
    g = cs * CLUMP_GUTTER / 2  # the rect is two units square
    inner = cs - 2 * g
    bx, by = cs / 2, cs - g - CLUMP_BASE * inner
    reach = inner * 0.5
    tall = 1.3  # the dome is this much taller than wide, so the clump fills its card
    bounds = (g, g, cs - g, cs - g)
    cuts = _cutouts()
    leaves = []
    # Bases spread over a dome above the base point, thinning outward, each
    # leaf pointing away from it: one rounded mass whose rim is leaf tips.
    for _ in range(rnd.randint(40, 50)):
        r = reach * math.sqrt(rnd.random())
        a = -math.pi / 2 + rnd.uniform(-1.35, 1.35)
        length = inner * rnd.uniform(0.2, 0.28) * (1 - 0.25 * r / reach)
        point = a + rnd.uniform(-0.4, 0.4)
        for _try in range(8):
            leaf = _leaf_at(rnd, cuts, (bx + r * math.cos(a), by + r * tall * math.sin(a)), point, length, bounds)
            if leaf is not None:
                leaves.append((r, leaf))
                break
            r *= 0.8
            length *= 0.9
    leaves.sort(key=lambda x: -x[0])
    rgba = np.zeros((cs, cs, 4), np.float32)
    for _, (cut, base, tip, mirror) in leaves:
        _put(rgba, cut, base, tip, mirror, 1.0 - rnd.uniform(0, CLUMP_VALUE))
    return rgba


def _strand_cell(w, h, rnd):
    """One strand in a w x h pixel cell: a thin stem swaying down from the top
    of the inner rect, with leaves alternating sides, hanging tip-down and
    out, shrinking toward the tip, and a small knot of leaves at the top where
    it leaves the carpet."""
    g = w * CLUMP_GUTTER  # the rect is one unit wide
    lo, hi = g, h - g
    cx = w / 2
    amp, phase, waves = rnd.uniform(0.03, 0.08) * w, rnd.uniform(0, math.tau), rnd.uniform(1.0, 2.2)
    bounds = (g, g, w - g, h - g)
    cuts = _cutouts()

    def x_at(y):
        return cx + amp * math.sin(phase + (y - lo) / (hi - lo) * waves * math.tau)

    rgba = np.zeros((h, w, 4), np.float32)
    stem_w = max(1.5, w * 0.025)
    ys = np.linspace(lo, hi - (hi - lo) * 0.04, 40)
    stem = [(x_at(y) - stem_w / 2, y) for y in ys] + [(x_at(y) + stem_w / 2, y) for y in reversed(ys)]
    rgba[..., 0:3] = 1.0 - CLUMP_VALUE * 0.6
    rgba[..., 3] = _soften(_raster_px(stem, w, h), 1)
    room = w / 2 - g
    y, side = lo + room * 0.5, rnd.choice((-1, 1))
    while y < hi - room * 0.3:
        t = (y - lo) / (hi - lo)
        length = room * (1.05 - 0.6 * t) * rnd.uniform(0.9, 1.1)
        out = rnd.uniform(0.45, 0.85)
        for _try in range(8):
            leaf = _leaf_at(rnd, cuts, (x_at(y), y), math.pi / 2 - side * out, length, bounds)
            if leaf is not None:
                _put(rgba, *leaf, value=1.0 - rnd.uniform(0, CLUMP_VALUE))
                break
            length *= 0.88
        y += length * rnd.uniform(0.45, 0.6)
        side = -side
    # The knot at the top, over the stem's start.
    for _ in range(3):
        length = room * rnd.uniform(0.8, 1.0)
        for _try in range(8):
            leaf = _leaf_at(rnd, cuts, (cx + rnd.uniform(-0.2, 0.2) * room, lo + room * 0.15), math.pi / 2 + rnd.uniform(-1.2, 1.2), length, bounds)
            if leaf is not None:
                _put(rgba, *leaf, value=1.0 - rnd.uniform(0, CLUMP_VALUE))
                break
            length *= 0.85
    return rgba


def _draw_clump_atlas(size=ATLAS_SIZE, seed=11):
    """The clump atlas as float RGBA (rows top first)."""
    rnd = random.Random(seed)
    img = np.zeros((size, size, 4), np.float32)
    img[..., 0:3] = 1.0
    unit = size // CLUMP_GRID

    def put(rect, rgba):
        c, r, w, h = rect
        img[r * unit:(r + h) * unit, c * unit:(c + w) * unit] = rgba

    for rect in CLUMP_RECTS:
        put(rect, _clump(rect[2] * unit, rnd))
    for rect in STRAND_RECTS:
        put(rect, _strand_cell(rect[2] * unit, rect[3] * unit, rnd))
    img = _bleed(img)
    _, _, w, h = CLUMP_FILL_RECT
    cell = np.ones((h * unit, w * unit, 4), np.float32)
    k = 1.0 - 2.0 * CLUMP_GUTTER
    poly = [(0.5 + (x - 0.5) * k, 0.5 + (y - 0.5) * k) for x, y in _faceted(rnd)]
    cell[..., 3] = _soften(_raster_polygon(poly, w * unit), 2)
    put(CLUMP_FILL_RECT, cell)
    return img


def _load_atlas(name, version, draw):
    """The packed atlas image `name`, drawn by `draw` into the repo the first
    time (or when its version moves). Each atlas marks its image with its own
    property, so a stale sheet of one never takes the other with it."""
    mark = "ivy_atlas" if name == ATLAS_NAME else "ivy_clump_atlas"
    img = bpy.data.images.get(name)
    if img is not None and img.get(mark) == version:
        return img
    path = os.path.join(TEXTURE_DIR, name)
    # A sheet of another version, or a same-named image without the mark, goes.
    for stale in [i for i in bpy.data.images if i.name == name or i.get(mark) is not None]:
        bpy.data.images.remove(stale)
    if not os.path.exists(path):
        os.makedirs(TEXTURE_DIR, exist_ok=True)
        pixels = draw()
        tmp = bpy.data.images.new("ivy-atlas-draw", ATLAS_SIZE, ATLAS_SIZE, alpha=True)
        tmp.pixels.foreach_set(pixels[::-1].ravel())
        tmp.filepath_raw = path
        tmp.file_format = "PNG"
        tmp.save()
        bpy.data.images.remove(tmp)
    img = bpy.data.images.load(path)
    img.name = name
    img.alpha_mode = "STRAIGHT"
    img[mark] = version
    img.pack()
    return img


def atlas():
    """The leaf atlas, drawn the first time (or when ATLAS_VERSION moves)."""
    return _load_atlas(ATLAS_NAME, ATLAS_VERSION, _draw_atlas)


def clump_atlas():
    """The clump atlas, drawn the first time (or when CLUMP_ATLAS_VERSION moves)."""
    return _load_atlas(CLUMP_ATLAS_NAME, CLUMP_ATLAS_VERSION, _draw_clump_atlas)


# --------------------------------------------------------------------------
# The material. Every node is one the scene exporter carries to glTF:
# baseColorTexture x COLOR_0 with the alpha cut by a threshold (alphaMode
# MASK) and back faces culled. The underlay and the stems wear it too, on a
# solid cell of the atlas. It casts no shadow in the game
# (render3d/sceneDressing.ts turns casting off for a `.ivy` node); in Blender
# that is the object's `visible_shadow`, set by ops.create_ivy.

MATERIAL_NAME = "Ivy"
CLUMP_MATERIAL_NAME = "IvyClumps"
CLUMP_MATERIAL_VERSION = 2  # 2: two-sided (2026-10-05)
OLD_MATERIALS = ("MossBlobs", "MossUnder", "MossStem")  # the three slots before 2026-09-30, when the ivy was the moss add-on


def _fresh(name, version=MATERIAL_VERSION):
    mat = bpy.data.materials.get(name)
    if mat is not None and mat.get("ivy_material") == version:
        return mat, None
    if mat is None:
        mat = bpy.data.materials.new(name)
    if mat.node_tree is None:
        mat.use_nodes = True
    mat["ivy_material"] = version
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type not in {"BSDF_PRINCIPLED", "OUTPUT_MATERIAL"}:
            nt.nodes.remove(n)
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.9
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.15
    return mat, bsdf


def _tint_node(nt, bsdf):
    tint = nt.nodes.new("ShaderNodeVertexColor")
    tint.layer_name = COLOR
    tint.location = (bsdf.location.x - 600, bsdf.location.y - 200)
    return tint


def material(detail="LEAVES"):
    """The material an ivy of this detail wears, rebuilt when its version
    moves: `Ivy` on the leaf atlas, or `IvyClumps` on the clump atlas. Either
    way a mesh has the one slot (see write_result)."""
    clumps = detail == "CLUMPS"
    if clumps:
        mat, bsdf = _fresh(CLUMP_MATERIAL_NAME, CLUMP_MATERIAL_VERSION)
    else:
        mat, bsdf = _fresh(MATERIAL_NAME)
    if bsdf is None:
        # A material of this version still wears whatever sheet it was built
        # with: a moved ATLAS_VERSION reaches it here, or never.
        img = clump_atlas() if clumps else atlas()
        for n in mat.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image != img:
                n.image = img
    else:
        nt = mat.node_tree
        # Both sides, as the game draws them (render3d/ivyLeaves.ts): a card
        # no longer turns to face the camera, so its back is often the side seen.
        mat.use_backface_culling = False
        mat.diffuse_color = (0.3, 0.45, 0.1, 1.0)
        x, y = bsdf.location.x, bsdf.location.y
        tint = _tint_node(nt, bsdf)
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = clump_atlas() if clumps else atlas()
        tex.location = (x - 600, y + 150)
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.location = (x - 250, y)
        by_id = {i.identifier: i for i in mix.inputs}
        by_id["Factor_Float"].default_value = 1.0
        nt.links.new(tex.outputs["Color"], by_id["A_Color"])
        nt.links.new(tint.outputs["Color"], by_id["B_Color"])
        nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
        cut = nt.nodes.new("ShaderNodeMath")
        cut.operation = "GREATER_THAN"
        cut.inputs[1].default_value = ATLAS_CUTOFF
        cut.location = (x - 250, y - 300)
        nt.links.new(tex.outputs["Alpha"], cut.inputs[0])
        nt.links.new(cut.outputs[0], bsdf.inputs["Alpha"])
        try:  # the legacy setting the glTF exporter still reads on some versions
            mat.blend_method = "CLIP"
            mat.alpha_threshold = ATLAS_CUTOFF
        except Exception:
            pass
    return mat


# --------------------------------------------------------------------------
# The shadow decal: its own mesh and its own blended material, `IvyShadow`,
# white times the vertex colour with the vertex colour's alpha as the
# opacity - no texture, no second slot on the ivy mesh (see above for why a
# second slot is out). The exporter writes it as alphaMode BLEND with
# COLOR_0 carrying the alpha; three.js draws it transparent, depth-tested
# under the leaves, without writing depth.

SHADOW_MATERIAL_NAME = "IvyShadow"
SHADOW_MATERIAL_VERSION = 1


def write_shadow(me, shadow):
    me.clear_geometry()
    v, t = shadow.vertices, shadow.triangles
    if len(t) == 0:
        return
    me.vertices.add(len(v))
    me.vertices.foreach_set("co", v.astype(np.float32).ravel())
    me.loops.add(len(t) * 3)
    me.loops.foreach_set("vertex_index", t.astype(np.int32).ravel())
    me.polygons.add(len(t))
    me.polygons.foreach_set("loop_start", np.arange(0, len(t) * 3, 3, dtype=np.int32))
    me.update(calc_edges=True)
    me.validate(clean_customdata=False)
    attr = me.color_attributes.get(COLOR) or me.color_attributes.new(COLOR, "FLOAT_COLOR", "POINT")
    if len(attr.data) == len(shadow.colors):
        attr.data.foreach_set("color", shadow.colors.astype(np.float32).ravel())
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find(COLOR)
    me.shade_smooth()
    if len(shadow.normals) == len(v):
        me.normals_split_custom_set_from_vertices(shadow.normals.astype(np.float32).tolist())
    mat = shadow_material()
    if list(me.materials) != [mat]:
        me.materials.clear()
        me.materials.append(mat)


def shadow_material():
    mat = bpy.data.materials.get(SHADOW_MATERIAL_NAME)
    if mat is not None and mat.get("ivy_material") == SHADOW_MATERIAL_VERSION:
        return mat
    if mat is None:
        mat = bpy.data.materials.new(SHADOW_MATERIAL_NAME)
    if mat.node_tree is None:
        mat.use_nodes = True
    mat["ivy_material"] = SHADOW_MATERIAL_VERSION
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type not in {"BSDF_PRINCIPLED", "OUTPUT_MATERIAL"}:
            nt.nodes.remove(n)
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    bsdf.inputs["Roughness"].default_value = 1.0
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    tint = _tint_node(nt, bsdf)
    nt.links.new(tint.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tint.outputs["Alpha"], bsdf.inputs["Alpha"])
    mat.surface_render_method = "BLENDED"
    mat.use_backface_culling = True
    mat.show_transparent_back = False
    mat.diffuse_color = (0.02, 0.03, 0.06, 0.6)
    try:
        mat.blend_method = "BLEND"
    except Exception:
        pass
    return mat


def _purge_old_materials():
    """The three-slot materials of an older file, once nothing uses them."""
    for name in OLD_MATERIALS:
        old = bpy.data.materials.get(name)
        if old is not None and old.get("moss_material") is not None and old.users == 0:
            bpy.data.materials.remove(old)
