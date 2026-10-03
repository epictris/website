"""Sample a slate_check.py render by luminance band over the rock's own pixels
(the alpha of its _mask twin), as the cave-sheet report judged its passes
(system python, PIL + numpy; not a Blender script).

    python3 slate_measure.py RENDER.png [RENDER.png ...]

Bands: lit = the 85th to 96th luminance percentile, mid = 40th to 60th,
shade = 10th to 30th, in sRGB, plus the share of rock pixels in each.
"""
import sys

import numpy as np
from PIL import Image

BANDS = (("lit", 85, 96), ("mid", 40, 60), ("shade", 10, 30))


def sample(path):
    rgb = np.asarray(Image.open(path).convert("RGB")).astype(float)
    alpha = np.asarray(Image.open(path.replace(".png", "_mask.png")).convert("RGBA"))[..., 3]
    px = rgb[alpha > 250]
    lum = px @ np.array([0.2126, 0.7152, 0.0722])
    out = {}
    for name, lo, hi in BANDS:
        p0, p1 = np.percentile(lum, lo), np.percentile(lum, hi)
        out[name] = tuple(int(v) for v in px[(lum >= p0) & (lum <= p1)].mean(0).round())
    return out, (alpha > 250).mean()


if __name__ == "__main__":
    for path in sys.argv[1:]:
        bands, cover = sample(path)
        print(f"[slate_measure] {path.split('/')[-1]}: rock {100 * cover:.0f}%, " + ", ".join(f"{k} {v}" for k, v in bands.items()))
