"""Thumbnails of the painted pieces for the panel's pickers, cut from the
atlas on disk. Built from a timer (a panel's draw may not touch bpy.data);
until the atlas exists (it is drawn when the first plant grows) the pickers
show names only."""

import os

import bpy
import bpy.utils.previews
import numpy as np

from . import library

SIZE = 64
_previews = None
_built = False


def icon(piece_id):
    """The icon id of a piece's thumbnail, or 0 while there is none."""
    if _previews is None or piece_id not in _previews:
        return 0
    return _previews[piece_id].icon_id


def _thumb(atlas, piece):
    h, w = atlas.shape[:2]
    u, v, rw, rh = piece.rect
    x0, y0 = u * w, v * h
    pw, ph = rw * w, rh * h
    s = max(pw, ph) / (SIZE - 4)
    out = np.zeros((SIZE, SIZE, 4), dtype=np.float32)
    ys, xs = np.mgrid[0:SIZE, 0:SIZE]
    # Centred in the square, base down, sampled at each texel's centre.
    sx = x0 + (xs + 0.5 - SIZE / 2) * s + pw / 2
    sy = y0 + (ys + 0.5 - SIZE / 2) * s + ph / 2
    inside = (sx >= x0) & (sx < x0 + pw) & (sy >= y0) & (sy < y0 + ph)
    ix = np.clip(sx.astype(np.int64), 0, w - 1)
    iy = np.clip(sy.astype(np.int64), 0, h - 1)
    out[inside] = atlas[iy[inside], ix[inside]]
    # A preview is drawn premultiplied: the colour bled under the transparent
    # texels would otherwise show as a box round every leaf.
    out[..., :3] *= out[..., 3:4]
    return out


def build():
    """Cut every piece's thumbnail from the atlas on disk, once a session."""
    global _built
    if _built or _previews is None:
        return None
    path = os.path.join(library.TEXTURE_DIR, library.ATLAS_NAME)
    if not os.path.exists(path):
        return None
    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
    finally:
        bpy.data.images.remove(img)
    atlas = px.reshape(h, w, 4)
    for piece in (*library.LEAVES, *library.FRONDS):
        p = _previews.get(piece.id) or _previews.new(piece.id)
        p.image_size = (SIZE, SIZE)
        p.image_pixels_float = _thumb(atlas, piece).ravel()
    _built = True
    return None


def register():
    global _previews
    _previews = bpy.utils.previews.new()
    if not bpy.app.background:
        bpy.app.timers.register(build, first_interval=0.5)


def unregister():
    global _previews, _built
    if _previews is not None:
        bpy.utils.previews.remove(_previews)
    _previews = None
    _built = False
