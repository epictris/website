"""The painted pieces every plant is cut from, and the one atlas they share.

Four painted sheets, ported from karin-lu's foliage generators
(github.com/karin-lu/website, branch blender-background-editor, 2026-10-08),
are the sources: published scene sources under
assets-src/scenes/textures/foliage/ (`just sources` fetches them). Each comes
with a table of its pieces (pieces/*.json, the branch's own, unchanged): where
each piece sits in its sheet (`atlasRect`, u v w h with v up from the sheet's
bottom), where its stalk meets it (`baseUv`), its width over its length
(`geometryAspect`) and its average painted colour.

- leaves.json: 14 painted leaves (`paint-*`, they keep their own colours) and
  24 brush silhouettes (`leaf-*`, white, tinted a green) for the hanging vines;
- ferns.json: 10 painted fronds and 5 croziers (fiddleheads);
- leaflets.json: 66 small leaves the leaflet fern is dressed with;
- sprig.json: one painted sprig, the leaf sprig fern's "leaf".

The sheets are packed side by side into one atlas at half their size
(ATLAS_NAME), with a solid white cell the stems and the crown sample, so a
plant is one mesh with one material and one draw call (see mesh_io for why one
slot). The game gets it at up to 2k (scripts/encode-textures.mjs's foliage
rule), which is what the half size already is."""

import json
import os

import numpy as np

HERE = os.path.dirname(os.path.realpath(__file__))
REPO = os.path.realpath(os.path.join(HERE, "..", "..", ".."))
SOURCE_DIR = os.path.join(REPO, "assets-src", "scenes", "textures", "foliage")
TEXTURE_DIR = os.path.join(REPO, "assets-src", "scenes", "textures")

ATLAS_VERSION = 1
ATLAS_NAME = f"foliage-atlas-v{ATLAS_VERSION}.png"


def _load(name):
    with open(os.path.join(HERE, "pieces", name)) as f:
        return json.load(f)


# --------------------------------------------------------------------------
# Colour. Hex in the tables is sRGB; everything the generators compute with is
# linear, as three.js computed it (`new THREE.Color(hex)` linearises).


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_linear(h):
    h = h.lstrip("#")
    return tuple(srgb_to_linear(int(h[i : i + 2], 16) / 255.0) for i in (0, 2, 4))


# The greens leaves are tinted with (sRGB). Tuned darker than the flat art
# because the scene's lighting brightens them; "leaf" is close to the sheet's own.
SHADES = (
    ("forest", "Forest", "#2c4f25"),
    ("pine", "Pine", "#2e6142"),
    ("moss", "Moss", "#47752c"),
    ("leaf", "Leaf", "#64933a"),
    ("fresh", "Fresh", "#70993a"),
    ("lime", "Lime", "#839c3c"),
)


def shades(mask):
    """The chosen greens as linear colours (all of them when none is chosen)."""
    out = [hex_linear(h) for (_id, _n, h), on in zip(SHADES, mask) if on]
    return out or [hex_linear(SHADES[3][2])]


def by_light(colours):
    """Colours sorted dark to light by luminance, so "age" can walk along them."""
    return sorted(colours, key=lambda c: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])


# --------------------------------------------------------------------------
# The atlas layout, in pixels of the packed atlas with y up from its bottom
# (Blender's and the tables' convention). Each sheet is halved and placed at
# its offset; GUTTER keeps one sheet's pieces out of another's mip levels.

SCALE = 0.5
GUTTER = 16
SHEETS = {
    # name: (file, width, height) at full size
    "leaves": ("leaf-atlas.webp", 2048, 2387),
    "ferns": ("fern-atlas.webp", 2048, 1023),
    "leaflets": ("leaflet-atlas.webp", 2048, 1428),
    "sprig": ("sprig.webp", 419, 825),
}
ATLAS_W = 2048
ATLAS_H = 1728


def _layout():
    """Where each halved sheet goes: (x, y) of its bottom-left corner. Left
    column: the leaves over the ferns; right column: the leaflets over the
    sprig and the solid cell."""
    half = {k: (-(-w // 2), -(-h // 2)) for k, (_f, w, h) in SHEETS.items()}
    col = ATLAS_W // 2
    out = {}
    out["leaves"] = (0, ATLAS_H - half["leaves"][1])
    out["ferns"] = (0, out["leaves"][1] - GUTTER - half["ferns"][1])
    out["leaflets"] = (col, ATLAS_H - half["leaflets"][1])
    out["sprig"] = (col, out["leaflets"][1] - GUTTER - half["sprig"][1])
    assert out["ferns"][1] >= 0 and out["sprig"][1] >= 0, "the atlas is too short for its sheets"
    return out, half


LAYOUT, HALF = _layout()
# The solid white cell: right of the sprig, under the leaflets.
SOLID = (ATLAS_W // 2 + HALF["sprig"][0] + 2 * GUTTER, LAYOUT["leaflets"][1] - GUTTER - 64, 64, 64)
SOLID_UV = ((SOLID[0] + SOLID[2] / 2) / ATLAS_W, (SOLID[1] + SOLID[3] / 2) / ATLAS_H)


def _remap(sheet, rect):
    """A piece's rect in its sheet (fractions, v up) as a rect in the atlas."""
    x, y = LAYOUT[sheet]
    _f, w, h = SHEETS[sheet]
    w, h = w * SCALE, h * SCALE  # the sheet's own extent: an odd sheet's halved copy has a padding texel
    u, v, rw, rh = rect
    return ((x + u * w) / ATLAS_W, (y + v * h) / ATLAS_H, rw * w / ATLAS_W, rh * h / ATLAS_H)


class Piece:
    """One painted piece: its atlas rect and the measurements the generators use."""

    __slots__ = ("id", "kind", "aspect", "base_uv", "rect", "scale", "keep_colour", "avg", "width_profile",
                 "profile_left", "profile_right", "mirrored")

    def __init__(self, d, sheet, kind=None):
        self.id = d["id"]
        self.kind = kind or d.get("kind", "leaf")
        self.aspect = d["geometryAspect"]
        self.base_uv = tuple(d["baseUv"])
        self.rect = _remap(sheet, d["atlasRect"])
        self.scale = d.get("scale", 1.0)
        self.keep_colour = d.get("keepColour", False)
        self.avg = hex_linear(d["avgColour"]) if "avgColour" in d else None
        self.width_profile = d.get("widthProfile")
        self.profile_left = d.get("profileLeft")
        self.profile_right = d.get("profileRight")
        self.mirrored = False

    def mirror(self):
        """The same piece flipped left to right, for the other leaf of a pair."""
        m = Piece.__new__(Piece)
        for k in Piece.__slots__:
            setattr(m, k, getattr(self, k))
        m.base_uv = (1.0 - self.base_uv[0], self.base_uv[1])
        m.profile_left, m.profile_right = self.profile_right, self.profile_left
        m.mirrored = True
        return m


LEAVES = tuple(Piece(d, "leaves") for d in _load("leaves.json")["leaves"])
PAINTED_LEAVES = tuple(p for p in LEAVES if p.id.startswith("paint-"))
SILHOUETTE_LEAVES = tuple(p for p in LEAVES if p.id.startswith("leaf-"))
FERN_PIECES = tuple(Piece(d, "ferns") for d in _load("ferns.json")["pieces"])
FRONDS = tuple(p for p in FERN_PIECES if p.kind == "frond")
CROZIERS = tuple(p for p in FERN_PIECES if p.kind == "crozier")
LEAFLETS = tuple(Piece(d, "leaflets", "leaflet") for d in _load("leaflets.json")["pieces"])
SPRIG = Piece(_load("sprig.json")["pieces"][0], "sprig", "sprig")
# The rounder half of the leaflets dress leaflet stems; the narrower, pointed
# ones (width 0.3-0.47 of the length) are a once-divided frond's single leaves.
BROAD_LEAVES = tuple(p for p in LEAFLETS if p.aspect >= 0.47)
NARROW_LEAVES = tuple(p for p in LEAFLETS if 0.3 <= p.aspect < 0.47)


# --------------------------------------------------------------------------
# Drawing the atlas. Runs inside Blender (images are read and written through
# bpy, whose pixels are bottom row first, as the layout is).


def _box_half(a):
    """Halve an RGBA float image (premultiplied in, premultiplied out)."""
    h, w = a.shape[0] // 2 * 2, a.shape[1] // 2 * 2
    a = a[:h, :w]
    return 0.25 * (a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2])


def _read(path):
    import bpy

    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
    finally:
        bpy.data.images.remove(img)
    return px.reshape(h, w, 4)


def _bleed(img, levels=10):
    """Fill the colour under transparent texels from the leaves nearby (pull-
    push on the premultiplied colour), so filtering and mip levels blend a
    leaf's edge with leaf colour, never with the black or white behind it."""
    a = img[..., 3:4]
    pyramid = [np.concatenate([img[..., :3] * a, a], axis=-1)]
    for _ in range(levels):
        top = pyramid[-1]
        if min(top.shape[:2]) < 2:
            break
        pyramid.append(_box_half(top))
    filled = pyramid[-1]
    for lower in reversed(pyramid[:-1]):
        up = np.repeat(np.repeat(filled, 2, axis=0), 2, axis=1)
        up = np.pad(up, ((0, lower.shape[0] - up.shape[0]), (0, lower.shape[1] - up.shape[1]), (0, 0)), mode="edge")
        w = lower[..., 3:4]
        filled = lower + up * (1.0 - w)
    colour = filled[..., :3] / np.maximum(filled[..., 3:4], 1e-6)
    out = img.copy()
    out[..., :3] = np.where(a > 0.0, img[..., :3], colour)
    return out


def draw_atlas():
    """The packed atlas as an (ATLAS_H, ATLAS_W, 4) float array, bottom row first."""
    out = np.zeros((ATLAS_H, ATLAS_W, 4), dtype=np.float32)
    for name, (file, w, h) in SHEETS.items():
        path = os.path.join(SOURCE_DIR, file)
        if not os.path.exists(path):
            raise FileNotFoundError(f"{path} is missing: fetch the scene sources (`just sources`)")
        src = _read(path)
        if src.shape[:2] != (h, w):
            raise ValueError(f"{file} is {src.shape[1]} x {src.shape[0]}, the pieces table expects {w} x {h}")
        pm = src.copy()
        pm[..., :3] *= pm[..., 3:4]
        half = _box_half(np.pad(pm, ((0, h % 2), (0, w % 2), (0, 0))))
        half[..., :3] /= np.maximum(half[..., 3:4], 1e-6)
        x, y = LAYOUT[name]
        hw, hh = HALF[name]
        out[y : y + hh, x : x + hw] = half[:hh, :hw]
    x, y, w, h = SOLID
    out[y : y + h, x : x + w] = 1.0
    return _bleed(out)
